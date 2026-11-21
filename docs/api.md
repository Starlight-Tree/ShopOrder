# API の約束（P1: 店頭受け取りの注文）

画面とバックエンドの境目。実装は `backend/app/`、画面は `frontend/`。動きの決まりは [order-flow.md](order-flow.md)、表は [data-model.md](data-model.md)。宅配（P2）・チャット（P3）・分析（P4）は、この約束を足していく。

## 共通

- 画面のサーバー側（Next.js の Route Handler / Server Action / Server Component）から呼ぶ。**ブラウザーは API を直接呼ばない。**
- 日時は ISO 8601（UTC、`Z` つき）。金額はルミの整数。ID は整数（注文だけ `public_id` の文字列）。
- エラーは `{"detail": {"code": "<機械用>", "message": "<固定の日本語>"}}`。例外の文字列・パスは含めない。入力の形の誤りだけ FastAPI 既定の 422（`detail` が配列）。
- 見つからない・他人のものは **404**（存在を教えない）。許されない状態の変更は **409**。

## 認証

| 誰 | 方法 | 備考 |
|---|---|---|
| 顧客 | 開発の既定（`AUTH_MODE=dev`）: ヘッダー `X-Dev-User: <名前>` があればその利用者、無ければ `demo-customer` | 名前は `[a-z0-9-]{1,40}`。本番相当（`APP_ENV=production`）で `AUTH_MODE=dev` なら起動を拒否する。Google ログインは後（P6） |
| スタッフ・店長 | `POST /api/staff/login` が返す不透明トークンを `Authorization: Bearer <token>` で送る | 画面は HttpOnly Cookie `oasis_staff` に入れ、サーバー側で付け替える。トークンはハッシュだけ保存。有効 12 時間 |

デモのスタッフ（`seed_demo`・`DEMO_DATA=allow` だけ）: 各店 `staff-<店の code>@oasis-cafe.example`、店長（全店）`manager@oasis-cafe.example`。パスワードは環境変数 `DEMO_STAFF_PASSWORD`（既定 `oasis-demo-pass`。ダミーで、秘密ではない）。

## 店・メニュー（既存を拡張）

- `GET /api/stores` — 既存の項目に `accepting_orders: boolean`、`closed_reason: null | "closed_today" | "temporary_closure" | "outside_hours" | "past_last_order" | "mobile_order_unavailable"` を足す。
- `GET /api/menu?store_id=<id>` — 既存の項目。各 `variants[]` に `available: boolean`、`unavailable_reason: null | "out_of_season" | "out_of_hours" | "sold_out"` を足す（`store_id` が無ければ在庫は見ない）。

## カート（顧客）

`Cart`:
```json
{ "version": 3, "store": {"id": 1, "name": "居住区本店"} | null, "fulfillment": "pickup",
  "lines": [{"variant_id": 7, "item_code": "oasis-blend", "name": "オアシスブレンド", "size": "M", "temperature": "hot",
             "unit_price_lumi": 450, "qty": 2, "line_total_lumi": 900, "available": true, "unavailable_reason": null}],
  "subtotal_lumi": 900, "delivery_fee_lumi": 0, "total_lumi": 900 }
```
価格はいつも**今のメニューの値**から計算する（カートに価格を保存しない）。

| API | 内容 |
|---|---|
| `GET /api/cart` | 今のカート（無ければ空を作る） |
| `PUT /api/cart` `{store_id: int \| null, fulfillment: "pickup"}` | 店と受け取り方法。`delivery` は 422（`delivery_unsupported`。P2 まで）。版が上がる |
| `PUT /api/cart/items/{variant_id}` `{qty: 0..20}` | **絶対値指定**。0 で外す。1 注文の行は 30 まで。版が上がる |
| `DELETE /api/cart` | 空にする |
| `POST /api/cart/checkout-proposal` | 確定の許可証（有効 10 分）を作る。検証に通らなければ 409 `{code}`（下） |

`CheckoutProposal`: `{ "id": "<uuid>", "cart_version": 3, "total_lumi": 900, "expires_at": "...", "store": {...}, "lines": [Cart.lines と同じ], "pickup_note": "店頭でお渡しします" }`

提案・確定で返す `code`: `cart_empty` / `store_not_selected` / `store_closed`（`closed_reason` も返す） / `item_unavailable`（`variant_ids`） / `sold_out`（`item_name`） / `over_limit`（合計は 30,000 ルミまで） / `proposal_expired` / `proposal_stale`（カートの版・合計が変わった）。

## 注文（顧客）

`Order`:
```json
{ "public_id": "K7M2Q9XD", "pickup_no": 12, "status": "placed", "fulfillment": "pickup", "store": {"id": 1, "name": "居住区本店"},
  "items": [{"name": "オアシスブレンド", "size": "M", "temperature": "hot", "unit_price_lumi": 450, "qty": 2, "line_total_lumi": 900}],
  "subtotal_lumi": 900, "delivery_fee_lumi": 0, "total_lumi": 900,
  "placed_at": "...", "reservation_expires_at": "..." | null,
  "payment": {"provider": "mock", "status": "pending"} | null,
  "events": [{"to_status": "placed", "at": "...", "actor_type": "customer", "reason": null}],
  "cancel_reason": null, "can_pay": true, "can_cancel": true }
```
`status`: `placed`（確保済み・支払い待ち）/ `paid` / `accepted` / `preparing` / `ready` / `completed` / `cancelled`。**画面は `status` から描く**（`events` の文言を信じない）。

| API | 内容 |
|---|---|
| `POST /api/orders` ヘッダー `Idempotency-Key`（8〜64 文字）、本文 `{proposal_id}` | 確定。201 で `Order`（`placed`）。在庫を確保し、カートを空にする。同じキー・同じ本文の再送は 200 で同じ注文。同じキー・違う本文は 422 `idempotency_conflict`。**確定の API を呼べるのは画面の確定ボタンだけ**（チャットには渡さない） |
| `POST /api/orders/{public_id}/pay` `{simulate?: "ok" \| "decline"}` | 模擬決済。`ok`（既定）で `paid`。`decline` は 402 `payment_declined` で、注文は `cancelled`・確保を戻す。確保の期限（15 分）が過ぎていたら 409 `reservation_expired`（注文は `cancelled`） |
| `POST /api/orders/{public_id}/cancel` | 顧客の取消し（`placed` / `paid` のとき。受付後は 409 `not_cancellable`）。支払い済みなら返金（`payments` を `refunded`） |
| `GET /api/orders` | 自分の注文（新しい順・50 件まで）。`items` は含めない軽い形: `public_id, pickup_no, status, store, total_lumi, placed_at` |
| `GET /api/orders/{public_id}` | 自分の注文の詳細。他人のものは 404 |

## スタッフ

`Staff`: `{id, name, role: "staff" | "manager" | "courier", store_id: int | null}`。店長は `store_id: null` なら全店。

| API | 内容 |
|---|---|
| `POST /api/staff/login` `{email, password}` | `{token, expires_at, staff}`。誤りは 401 `invalid_credentials`（理由を分けない）。連続の失敗はレート制限（429 `too_many_attempts`） |
| `POST /api/staff/logout` | 204。トークンを無効にする |
| `GET /api/staff/me` | `Staff` |
| `GET /api/staff/orders?status=paid,accepted,preparing,ready&store_id=` | 自店の注文（店長は `store_id` で選ぶ。省略で全店）。古い順。顧客の個人情報は含めない |
| `POST /api/staff/orders/{public_id}/transition` `{action, reason?}` | `accept`（paid→accepted）/ `start`（accepted→preparing。原材料を消費）/ `ready`（preparing→ready）/ `complete`（ready→completed。ポイント付与）/ `cancel`（理由が必須。返金・確保を戻す）。許されない遷移は 409 `invalid_transition` |
| `GET /api/staff/stock?store_id=` | `[{item_id, code, name, kind, unit, on_hand, reserved, available, reorder_point, low}]`（`available = on_hand − reserved − safety_stock`、`low = available < reorder_point`） |
| `POST /api/staff/stock/{item_id}/receive` `{qty, reason?}` / `.../waste` `{qty, reason}` / `.../adjust` `{delta, reason}` | 入荷・廃棄・棚卸し。更新後の行を返す。台帳に追記される |

`StaffOrder` = `Order`（`payment` を除く）+ `allowed_actions: ["accept", "cancel"]` など。顧客の名前・メールは出さない（呼び出しは受け取り番号 `pickup_no`）。

## 状態（2026-11-21）

**バックエンドは、この契約の全エンドポイントを実装した**（`backend/app/routes/`。画面は別。段階の状態は [roadmap.md](roadmap.md)）。契約を変えた点・足した点は次のとおり（フロントエンドの `contract.ts` に合わせる場合は、ここを見る）。

**足した点（既存の項目は変えていない）**
- `GET /api/stores` の `accepting_orders` / `closed_reason`、`GET /api/menu` の `available` / `unavailable_reason` は、**いつも返す**（`store_id` が無い `/api/menu` でも、季節・時間帯の判定は返す。在庫は `store_id` があるときだけ）。存在しない `store_id` は 404 `store_not_found`。
- 取り下げた品（`is_active = false`）の `unavailable_reason` は `out_of_season`（理由は契約の 3 つだけ）。
- 在庫の `receive` / `waste` / `adjust` と `GET /api/staff/stock`: 店つきのスタッフ（店長でも `store_id` を持つなら）は自店だけ。**店が決まっていない店長は `?store_id=` で店を選ぶ**（契約の本文には店の指定が無いため、クエリで足した）。選ばなければ 422 `store_required`。他店のスタッフが他店を指すと 404。
- `GET /api/staff/orders` で、店つきのスタッフが他店の `store_id` を指すと 404。店長（店なし）は `store_id` 省略で全店。`status` に未知の値があれば 422 `invalid_status`。配達員（`courier`）は注文・在庫の API を使えない（403 `forbidden`。P2 で扱う）。
- `DELETE /api/cart` は、品を空にして**店の選択は残す**。空にした `Cart` を 200 で返す。
- `POST /api/orders` の同じキー・同じ本文の再送は、**保存した最初の応答ではなく、その注文の今の状態**を 200 で返す（支払い後に再送しても、古い `placed` を返さないため）。
- スタッフの `cancel` は `paid` / `accepted` / `preparing` / `ready` から（`placed` は支払い前で、店は見ないので 409）。顧客の取消しの理由は固定の `customer_request`、期限切れは `payment_timeout`、拒否は `payment_declined`（`cancel_reason` と `events[].reason`）。
- 追加のエラー `code`: `unauthorized`(401) / `forbidden`(403) / `store_not_found`・`variant_not_found`・`proposal_not_found`(404) / `too_many_lines`・`invalid_delta`・`reason_required`・`store_required`・`invalid_status`(422) / `idempotency_in_progress`・`insufficient_stock`(409) / `internal_error`(500)。本文はいつも固定の文。
- 受付の状態は `placed` `paid` `accepted` `preparing` `ready` `completed` `cancelled` の 7 つ（宅配の状態は DB の CHECK にだけ入れてあり、API は P2 まで返さない）。

**まだの点**: 顧客の本物のログイン（P6。いまは `X-Dev-User` だけ）、宅配（P2）、チャット（P3）、通知。冪等キーは、期限で消さない（保持は 24 時間以上の下限を満たす。消す処理は未実装）。

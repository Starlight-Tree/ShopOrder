# API の約束（P1: 店頭受け取りの注文）

画面とバックエンドの境目。実装は `backend/`（Go。経路は `routes*.go`）、画面は `frontend/`。動きの決まりは [order-flow.md](order-flow.md)、表は [data-model.md](data-model.md)。宅配（P2）・チャット（P3）・分析（P4）は、この約束を足していく。

## 共通

- 画面のサーバー側（Next.js の Route Handler / Server Action / Server Component）から呼ぶ。**ブラウザーは API を直接呼ばない。**
- 日時は ISO 8601（UTC、`Z` つき）。金額はルミの整数。ID は整数（注文だけ `public_id` の文字列）。
- エラーは `{"detail": {"code": "<機械用>", "message": "<固定の日本語>"}}`。例外の文字列・パスは含めない。入力の形の誤りだけ 422（`detail` が配列で、各要素は `loc`・`msg`・`type`。**入力した値は返さない**）。NUL・制御文字・単独のサロゲートを含む文字列も 422。
- 見つからない・他人のものは **404**（存在を教えない）。許されない状態の変更は **409**。

## 認証

| 誰 | 方法 | 備考 |
|---|---|---|
| 顧客 | 開発の既定（`AUTH_MODE=dev`）: ヘッダー `X-Dev-User: <名前>` があればその利用者、無ければ `demo-customer` | 名前は `[a-z0-9-]{1,40}`。本番相当（`APP_ENV=production`）で `AUTH_MODE=dev` なら起動を拒否する。Google ログインは後（P6） |
| スタッフ・店長 | `POST /api/staff/login` が返す不透明トークンを `Authorization: Bearer <token>` で送る | 画面は HttpOnly Cookie `shop_order_staff` に入れ、サーバー側で付け替える。トークンはハッシュだけ保存。有効 12 時間 |

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
| `POST /api/orders` ヘッダー `Idempotency-Key`（8〜64 文字）、本文 `{proposal_id}` | 確定。201 で `Order`（`placed`）。在庫を確保し、カートを空にする。同じキー・同じ本文の再送は 200 で同じ注文。同じキー・違う本文は 422 `idempotency_conflict`。**未払い（`placed`）の注文は 1 人 2 件まで**（超えたら 409 `too_many_unpaid_orders`。払うか取り消すと、また確定できる）。**確定の API を呼べるのは画面の確定ボタンだけ**（チャットには渡さない） |
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

**バックエンドは、この契約の全エンドポイントを実装した**（`backend/routes*.go`。画面は別。段階の状態は [roadmap.md](roadmap.md)）。契約を変えた点・足した点は次のとおり（フロントエンドの `contract.ts` に合わせる場合は、ここを見る）。

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

## 宅配（P2）

宅配の API。P1 の契約（上）の拡張で、既存の項目は変えていない（`Cart`・`CheckoutProposal`・`Order`・`StaffOrder` に項目を足す。`PUT /api/cart` の `delivery` は、P1 の 422 `delivery_unsupported` をこの節が置き換える）。動きの決まりは [order-flow.md](order-flow.md)「宅配」、表は [data-model.md](data-model.md)「配達」、値（区画・送料・所要・枠）は [world.md](world.md)「宅配」。「新設」は、資料に無く、設計で足した設定。

### 共通の約束

- 住所（`line`・`note`）は個人情報（🔒）。ログに出さない。**顧客本人と、集荷後の担当の配達員だけが読める**（店のスタッフ・店長には、ラベルと区画だけ）。
- 区画（zone）= エリア（居住区・発着場・岩山・遺跡）。住所の `area_code` から決まる。店が届けるのは、**自分のエリア + 隣接 1 エリア**（新設。順は居住区—発着場—岩山—遺跡。隣は「順の次」で、最後の遺跡だけ手前の岩山）。
- 宅配をしている店 = `store_zones` に行がある店。配達員がいない店は、宅配をしない（seed の既定は下の「状態」）。
- 時刻は UTC（`Z`）。日付（`date`）・枠の日付は店のローカル時刻（`LOCAL_UTC_OFFSET_HOURS`）。
- 設計の既定の数字は `backend/deliveryrules.go`（枠 30 分・1 枠 4 件・受付の締め = 枠の開始の 45 分前〔準備 15 分 + リードタイム 30 分。新設〕・暗証コード 4 桁・5 回・24 時間・枠は 7 日先まで）。

### 新しいエラーコード（本文は固定の文）

| code | status | 意味 |
|---|---|---|
| `address_not_found` / `slot_not_found` / `zone_not_found` / `courier_not_found` | 404 | 他人の住所・他店の枠・他店の配達員も、存在しないのと同じ |
| `invalid_area` / `invalid_date` / `too_many_addresses` / `pickup_with_delivery_fields` | 422 | エリアが無い / 日付が今日から 7 日先の外 / 住所は 10 件まで / 店頭受け取りに住所・枠を付けた |
| `delivery_unavailable` | 409 | この店は宅配をしていない |
| `address_required` / `slot_required` | 409 | 確認・確定の前に、住所・枠を選んでいない |
| `out_of_zone` | 409 | その住所の区画へ、この店は届けない |
| `zone_suspended` | 409 | 砂嵐の警報で、その区画は受け付けていない |
| `below_minimum` | 409 | 最低注文額に届かない（`min_order_lumi` を返す） |
| `slot_closed` / `slot_cutoff` / `slot_full` | 409 | 枠の日が休業 / 受付を締め切った / 満席 |
| `no_slot_available` | 409 | 再配達で選べる枠が無い |
| `courier_off_duty` / `no_courier_available` | 409 | 勤務中でない配達員 / 提案できる配達員がいない |
| `mock_only` | 409 | 模擬の配達（`DELIVERY_PROVIDER=mock`）のときだけ使える操作 |
| `pin_invalid` | 422 | 暗証コードが違う（`attempts_left`）。形（4 桁の数字）の誤りは、FastAPI 互換の 422（数えない） |
| `pin_locked` | 409 | 5 回間違えた。配達は止まり（`delivery_failed`）、店へ戻る |
| `pin_expired` | 409 | 暗証コードの有効期限（集荷から 24 時間）が切れた |

`invalid_transition`（409）は、宅配でも「今の状態ではできない」の意味。

### 顧客: 住所

`Address`: `{ "id": 3, "label": "自宅", "area_code": 2, "area_name": "発着場", "zone_id": 2, "line": "アルカ市発着場2-1-5 305", "note": "呼び鈴は 1 回" | null, "created_at": "..." }`

| API | 内容 |
|---|---|
| `GET /api/addresses` | 自分の住所（古い順） |
| `POST /api/addresses` `{label, area_code, line, note?}` | 201 で `Address`。`label` 1〜20 文字、`line` 1〜100、`note` 100 文字まで（前後の空白は除く）。エリアが無ければ 422 `invalid_area`。11 件目は 422 `too_many_addresses` |
| `DELETE /api/addresses/{id}` | 204。他人の住所は 404 `address_not_found`。カートが選んでいたら、カートの住所を外す（版が上がる）。過去の注文は、注文時の写し（配達の行）を持つので変わらない |

### 顧客: 区画と時間枠（認証なし）

`Zone`: `{ "id": 2, "name": "発着場", "area_code": 2, "fee_lumi": 200, "free_over_lumi": 2000 | null, "min_order_lumi": 700, "base_minutes": 30, "is_suspended": false }`

| API | 内容 |
|---|---|
| `GET /api/delivery/zones?store_id=` | 区画の一覧。`store_id` があれば、その店が届ける区画だけ（無い店は 404 `store_not_found`。宅配をしない店は `[]`） |
| `GET /api/stores/{store_id}/slots?date=YYYY-MM-DD&zone_id=` | その日の時間枠（`SlotList`）。`date` は必須（今日〜7 日先。外は 422 `invalid_date`）。`zone_id` を付けると、その区画の砂嵐を反映する |

`SlotList`: `{ "store_id": 1, "date": "2026-11-22", "zone_id": 2 | null, "reason": null | "delivery_unavailable" | "mobile_order_unavailable" | "temporary_closure" | "closed_today" | "storm_warning" | "zone_unserved", "slots": [Slot] }`
`Slot`: `{ "id": 41, "starts_at": "...Z", "ends_at": "...Z", "capacity": 4, "booked": 1, "remaining": 3, "available": true, "unavailable_reason": null | "full" | "cutoff" }`

- `reason` が付くときは、`slots` は空（枠を出さない）。休業 = `store_closures` の臨時休業・定休日・MO 不可店。砂嵐 = `zone_id` の区画の `is_suspended`。
- 枠は、営業時間の開店から 30 分ごと。**最後の枠は、ラストオーダーの時刻に終わるもの**（資料の「ラストオーダーの 30 分前まで受け付ける」の読み替え。新設）。
- `available: false` の枠も一覧に出す（`full` = 満席、`cutoff` = 受付の締めを過ぎた）。
- 枠は、見た日の分が無ければ、その場で作る（`INSERT ... ON CONFLICT DO NOTHING`。同時に呼んでも重ならない）。

### 顧客: カート（`PUT /api/cart` の拡張）

`PUT /api/cart` `{store_id: int | null, fulfillment: "pickup" | "delivery", address_id?: int | null, slot_id?: int | null}`

- **全部を置き換える**（省略した `address_id`・`slot_id` は null）。版が上がる。
- `pickup` に `address_id` / `slot_id` を付けると 422 `pickup_with_delivery_fields`。`delivery` で `store_id` が null なら、住所・枠は付けられない（422 `store_required`）。
- 住所が他人のもの・無いものは 404 `address_not_found`、枠が他店・無いものは 404 `slot_not_found`。選んだ住所が店の届ける区画の外なら 409 `out_of_zone`。選んだ枠が満席・締め切り・休業なら 409 `slot_full` / `slot_cutoff` / `slot_closed`（枠の選び直しを促す。カートは変えない）。
- 区画の砂嵐・最低注文額・宅配をしない店は、ここでは止めない（`delivery.issues` で知らせ、確認・確定で 409）。

`Cart` に足す項目:
```json
{ "fulfillment": "delivery", "delivery_fee_lumi": 200, "total_lumi": 1100,
  "delivery": { "address": {"id": 3, "label": "自宅", "area_code": 2, "area_name": "発着場"} | null,
                "zone": Zone | null, "slot": {"id": 41, "starts_at": "...Z", "ends_at": "...Z"} | null,
                "fee_lumi": 200, "free_over_lumi": 2000 | null, "min_order_lumi": 700,
                "issues": ["slot_required"] } }
```
`fulfillment: "pickup"` のとき `delivery` は null、`delivery_fee_lumi` は 0。`issues` は、**今の確認・確定が 409 にするコード**（空なら通る）。順は `delivery_unavailable` → `address_required` → `slot_required` → `out_of_zone` → `zone_suspended` → `below_minimum`（品があるとき）→ `slot_closed` → `slot_cutoff` → `slot_full`。

**送料** = 区画の `fee_lumi`。ただし、品の小計が `free_over_lumi` **以上**なら 0（2,000 ルミちょうどは無料）。送料は合計に足す（`total = subtotal + delivery_fee`）。最低注文額は、品の小計（送料を除く）で見る。1 注文の上限 30,000 ルミは、品の小計で見る（P1 のまま）。

### 顧客: 確認・確定・注文

- `POST /api/cart/checkout-proposal` — 宅配では、上の検査を `issues` の順で行い、最初の 1 件を 409 で返す（`code`。`below_minimum` は `min_order_lumi` つき）。通れば `CheckoutProposal`:
  `total_lumi` は送料込み。足す項目: `fulfillment`, `subtotal_lumi`, `delivery_fee_lumi`, `delivery`（`Cart.delivery` と同じ形で `issues` は空）。**`pickup_note` は宅配では null**（店頭では P1 のまま文字列）。
- `POST /api/orders` — P1 の確定の手順に、宅配の検査（住所・区画・砂嵐・最低注文額・枠）と、**枠の確保**を足す。枠は、在庫の確保の後に `UPDATE delivery_slots SET booked = booked + 1 WHERE id = ? AND store_id = ? AND booked < capacity` で取る（0 行なら 409 `slot_full`。在庫も冪等キーも、すべて戻る）。送料・区画・枠は、提案の後に変わったら、合計が違うので 409 `proposal_stale`。
- 枠を戻す（`booked - 1`）のは、**注文が `cancelled` になるとき**（顧客・店の取消し、支払いの失敗、支払い期限切れ）と、再配達で別の枠へ移るとき。

`Order` に足す項目: `delivery`（店頭は null）。`OrderSummary` に `fulfillment`。`status` に宅配の `assigned` / `picked_up` / `delivering` / `delivered` / `delivery_failed` が増える（`delivered` は、同じトランザクションで `completed` になるので、通常は見えない）。
```json
{ "fulfillment": "delivery",
  "delivery": { "status": "pending", "zone": {"id": 2, "name": "発着場"},
                "slot": {"id": 41, "starts_at": "...Z", "ends_at": "...Z"},
                "courier": {"name": "ラシード"} | null,
                "pin": "4821" | null, "eta_at": "...Z" | null,
                "address": {"label": "自宅"}, "attempt": 1,
                "failure_reason": null | "absent" | "cannot_receive" | "other" | "pin_locked" } }
```
- `delivery.status`: `pending`（配達員の割り当て前）/ `assigned` / `picked_up` / `delivering` / `delivered` / `failed` / `cancelled`。**画面は注文の `status` と `delivery.status` から描く。**
- `courier` は**名前だけ**（ID・連絡先は出さない）。割り当て前は null。
- **`pin` は集荷後（`picked_up`・`delivering`）だけ**、本人の注文に出る。それ以外は null。店・配達員には、どの API でも出さない（配達員は、お客さまから聞く）。
- `eta_at`（到着の目安）: 出発後（`delivering`）は「出発の時刻 + 区画の `base_minutes`」、それ以前は枠の開始。完了・取消しは null。
- 受け取り番号 `pickup_no` は宅配でも付く（店の呼び名）。

### スタッフ・店長: 配車

`StaffOrder` に足す項目: `delivery`（店頭は null）
```json
{ "delivery": { "status": "pending", "zone": {"id": 2, "name": "発着場"}, "slot": {"id": 41, "starts_at": "...Z", "ends_at": "...Z"},
                "courier": {"id": 7, "name": "ラシード"} | null, "attempt": 1, "failure_reason": null | "absent" | "cannot_receive" | "other" | "pin_locked" } }
```
住所・暗証コードは含めない。`allowed_actions` に、宅配では `assign`（`ready` / `assigned`）と `redeliver`（`delivery_failed`）が足される。**宅配の注文に `complete` は出ない**（`POST .../transition` の `complete` は 409 `invalid_transition`。宅配は配達員が完了する）。`cancel` は `paid`〜`ready`・`assigned`・`delivery_failed` から（集荷後は、不在の記録 → `delivery_failed` を経る）。

`Courier`: `{ "id": 7, "store_id": 1, "name": "ラシード", "vehicle": "hover-scooter", "is_on_duty": true, "active_count": 1, "zone": {"id": 1, "name": "居住区"} | null }`（`zone` は最後にいた区画。集荷で店の区画、到着・不在で配達先の区画に更新）

| API | 内容 |
|---|---|
| `GET /api/staff/couriers?store_id=` | 配達員の一覧（`resolve_store` の規則は在庫と同じ。店長は省略で全店） |
| `GET /api/staff/deliveries?status=&store_id=` | 配車ボード: `{ "provider": "mock" \| "inhouse", "couriers": [Courier], "orders": [DispatchOrder] }`。`status` の既定は `ready,assigned,picked_up,delivering,delivery_failed`。`DispatchOrder` = `StaffOrder` + `suggestion`（`ready` のとき `{courier_id, courier_name, minutes}`。提案できなければ null）。枠の開始が早い順 |
| `POST /api/staff/orders/{public_id}/assign` `{courier_id}` | `ready` → `assigned`（`assigned` のときは担当の付け替え）。**自店の勤務中の配達員だけ**（他店・無い ID は 404 `courier_not_found`、勤務外は 409 `courier_off_duty`）。宅配でない注文・他の状態は 409 `invalid_transition`。`StaffOrder` を返す |
| `POST /api/staff/orders/{public_id}/redeliver` `{slot_id?}` | `delivery_failed` → `ready`（再配達）。新しい枠を取り（`slot_id` を省くと、選べる中で最も早い枠。無ければ 409 `no_slot_available`）、古い枠を戻す。`attempt` が増え、担当・暗証コードは外れる（集荷で作り直す）。区画が砂嵐なら 409 `zone_suspended` |
| `POST /api/staff/orders/{public_id}/mock-advance` | 模擬の配達を 1 つ進める（`DELIVERY_PROVIDER=mock` のときだけ。他は 409 `mock_only`）。`ready` なら提案の配達員を割り当て、`assigned` → `picked_up` → `delivering` → 到着（暗証コードなし）→ `completed`。デモで画面から動かす手段 |
| `GET /api/delivery/zones` | 砂嵐の状態を含む区画の一覧（上。認証なし） |
| `PUT /api/staff/zones/{zone_id}/suspension` `{suspended: bool}` | **店長だけ**（staff・courier は 403）。砂嵐の警報を立てる / 解除する。立っている間は、その区画の枠が出ず、確認・確定が 409 `zone_suspended`。すでに確保した枠の注文は、取り消さない。`Zone` を返す |

**配達員の提案**は、差し替えられる関数（`delivery_rules.PROPOSERS`。環境変数 `ASSIGNMENT_POLICY`、既定 `nearest`）。`nearest` は、勤務中の配達員を、**最後にいた区画から店の区画までの所要分**（`zone_travel_minutes`。同じ区画は 0。区画が分からなければ 0）が小さい順、同じなら担当中の件数が少ない順、同じなら ID の順に並べ、先頭を返す。

### 配達員（role = courier）

`courier` 以外が呼ぶと 403 `forbidden`。他の配達員の担当・他店の配達は 404 `not_found`。配達員は、注文・在庫の API（`/api/staff/orders` など）を使えない（P1 のまま 403）。

`CourierDelivery`:
```json
{ "public_id": "K7M2Q9XD", "pickup_no": 12, "status": "delivering", "store": {"id": 1, "name": "居住区本店"},
  "zone": {"id": 2, "name": "発着場"}, "slot": {"id": 41, "starts_at": "...Z", "ends_at": "...Z"},
  "items": [{"name": "オアシスブレンド", "size": "M", "temperature": "hot", "qty": 2}],
  "address": {"label": "自宅", "line": "...", "note": null} | null, "attempt": 1,
  "pin_attempts_left": 5 | null, "eta_at": "...Z" | null, "allowed_actions": ["deliver", "fail"] }
```
`address` は集荷後（`picked_up` 以降）だけ。`pin_attempts_left` は `delivering` のときだけ。`status` は注文の状態（`assigned` / `picked_up` / `delivering` / `delivery_failed` / `completed`）。

| API | 内容 |
|---|---|
| `GET /api/courier/deliveries` | 自分の担当（`assigned` / `picked_up` / `delivering`。枠の開始が早い順） |
| `POST /api/courier/deliveries/{public_id}/pickup` | `assigned` → `picked_up`。**暗証コードを作る**（4 桁。DB にはハッシュだけ。有効 24 時間）。顧客に暗証コードが見え始める |
| `POST /api/courier/deliveries/{public_id}/depart` | `picked_up` → `delivering`（出発の時刻を記録） |
| `POST /api/courier/deliveries/{public_id}/deliver` `{pin}` | `delivering` で、暗証コードが合えば `delivered` → `completed`（ポイント付与）。違えば 422 `pin_invalid`（`attempts_left`）。**5 回目の誤りで、配達は止まる**（`delivery_failed`・理由 `pin_locked`。409 `pin_locked`）。期限切れは 409 `pin_expired`（数えない） |
| `POST /api/courier/deliveries/{public_id}/fail` `{reason}` | `delivering` → `delivery_failed`。`reason` は `absent`（不在）/ `cannot_receive`（受け取れない）/ `other`。自由記述は受けない（個人情報を入れさせない） |

返すのは `CourierDelivery`（操作の後の状態。`deliver` の成功は `status: "completed"`）。`pickup`・`depart`・`deliver`・`fail` は、すべて `order_events` に残る（`actor_type` は `staff`、`actor_id` は配達員の ID。暗証コード凍結と模擬の進行は `system`）。

### 状態の遷移の表（`orders.py` の `TRANSITIONS` に足したもの）

| 遷移 | 誰が |
|---|---|
| `ready` → `assigned`、`assigned` → `assigned`（付け替え。履歴だけ） | 店（スタッフ・店長）。模擬は system |
| `assigned` → `picked_up` → `delivering` | 配達員。模擬は system |
| `delivering` → `delivered` | 配達員（暗証コード）。模擬は system |
| `delivered` → `completed` | system（`delivered` と同じトランザクション） |
| `delivering` → `delivery_failed` | 配達員（不在）。暗証コードの凍結は system |
| `delivery_failed` → `ready`（再配達）、`delivery_failed` → `cancelled` | 店 |
| `assigned` → `cancelled` | 店 |

店頭の遷移は変えていない。

## 分析（P4）

店長（全店）と店舗スタッフ（自店の売上・在庫）の分析。定義は [metrics.md](metrics.md)、作り方は [analytics.md](analytics.md)。応答は、`analytics` の集計表を読むだけの薄い層（確定した日は日次集計、当日は元データから都度）。**データはすべてダミー。** 画面は `frontend/app/manager`（Cookie `shop_order_staff`。Path は `/manager`）。

**権限**（スタッフのトークン `Authorization: Bearer`。毎回 API が確認する）

| 誰 | 売上・商品・時間帯・在庫・概況 | 顧客（RFM・コホート） |
|---|---|---|
| 全店の店長（`role = manager`・`store_id` なし） | 全店。`?store_id=` で 1 店に絞れる | 見られる |
| 店舗スタッフ・店に属する店長（`store_id` あり） | **自店だけ**（`store_id` を付けなくても自店。他店を指すと 404 `not_found`） | **403 `forbidden`**（顧客全体の集計で、店に分けられない） |
| 配達員（`courier`） | 403 `forbidden` | 403 `forbidden` |
| 顧客（トークンなし・`X-Dev-User` だけ） | 401 `unauthorized` | 401 `unauthorized` |

共通: `store_id`（整数 1 以上。存在しなければ 404 `store_not_found`）。日付は営業日（ISO 8601 の日付）。金額はルミの整数。期間は、確定した日（昨日まで）。範囲外の値は 422（入力の形の誤り）。応答の `scope` は `{all_stores, store_id, store_name}`。

| API | 内容 |
|---|---|
| `GET /api/analytics/overview?store_id=` | 今日の概況: `{scope, business_date, sales_lumi, orders, avg_ticket_lumi \| null, in_progress, open_stores, store_count, closed_reason \| null, yesterday: {business_date, state, sales_lumi \| null, orders \| null, avg_ticket_lumi \| null}}`。当日は元データから都度。1 店で今日が休業なら `closed_reason`（`temporary_closure` / `weekly_closed`） |
| `GET /api/analytics/sales?grain=day\|week\|month&count=&store_id=` | 売上の推移。`count` の既定は日 28・週 12・月 3（上限 日 90・週 26・月 12）。`{scope, grain, from, to, points: [{start, sales_lumi \| null, orders \| null, open_days, state}], total: {sales_lumi, orders, open_days, missing_days}, previous: {from, to}, comparison}`。`state` は `open`（営業日。売上 0 を含む）/ `closed`（休業。値は null）/ `not_built`（未集計。null）/ `partial`（一部の店が未集計。null）。`comparison` は `{state: "ok", previous_sales_lumi, change_pct}` か `{state: "not_comparable", reason, message}`（`reason`: `previous_missing` / `weekday_mismatch` / `open_days_mismatch` / `previous_zero`）。期間は、昨日までに確定した日・週・月 |
| `GET /api/analytics/products?days=&store_id=` | 商品別（ABC）。`days` は 7〜90（既定 28）。`{scope, from, to, days, totals: {sales_lumi, qty, cups}, items: [{item_id, code, name, category, qty, sales_lumi, share_pct, cum_share_pct, abc}]}`。売上の大きい順 |
| `GET /api/analytics/hourly?days=&store_id=` | 曜日 × 時間帯の注文数。`{scope, from, to, days, hours: [8, 9, …], cells: [{weekday (1 = 月 … 7 = 日), hour, orders, sales_lumi}], store_days: [{weekday, store_days}], max_orders}`。注文のあるセルだけ |
| `GET /api/analytics/stock?store_id=` | 在庫。`{scope, use_from, use_to, waste_from, waste_to, items: [{item_id, code, name, kind, unit, on_hand, reserved, avg_daily_use, days_of_cover \| null, gap_to_reorder, reorder_point, low_stores, store_count, low}], waste: [{item_id, code, name, unit, total, by_reason: {expired, damaged, quality, other}, waste_rate_pct}]}`。全店のときは、品目ごとに店をまとめる（残量・消費は合計、残日数・発注点との差は最も厳しい店） |
| `GET /api/analytics/customers` | 顧客（全店の店長だけ）。`{as_of, min_cell: 5, total_customers \| null, segments: [{segment, label, customers \| null, suppressed}], grid: [{r, f, customers \| null, suppressed}], repurchase_rate_pct \| null, avg_orders \| null, avg_spend_lumi \| null, at_risk_customers \| null, cohorts: {rows: [{cohort, size \| null, suppressed, includes_existing, cells: [{offset, customers \| null, rate_pct \| null, suppressed, in_progress}]}], max_offset}}`。**人数のセルは 5 人未満が `null`**（`suppressed: true`）。隠したセルがあれば `total_customers` も `null`。仮名 ID・氏名・メールは含まない |

### 状態（2026-11-21）

バックエンド・画面とも実装した（店頭受け取りだけ。宅配の分析は P2 の後）。集計の作成は `api analytics-build`（[metrics.md](metrics.md)）。ダミーの履歴は `DEMO_DATA=allow api seed --reset --history`。**この節のエンドポイントは、API の約束としては新設**（P1 の契約を変えていない）。

## チャット（P3）

設計は [chat.md](chat.md)、実装は `backend/chat_*.go`・`backend/routes_chat.go`。**AI が作れるのは、カートの下書きと確認カードまで。注文の確定は、画面の確定ボタン → `POST /api/orders`（上の「注文」。`Idempotency-Key` つき）だけ**で、チャットのどの API・ツールからも通らない（[ADR 0003](decisions/0003-chat-never-confirms-orders.md)）。認証は顧客（`X-Dev-User`。上の「認証」）。画面のサーバー側（Route Handler）から呼び、ブラウザーは直接呼ばない。

| API | 内容 |
|---|---|
| `POST /api/chat/threads` `{store_id}` | スレッドを作る。**店は必須で、あとから変えない。** 201 `{id, store: {id, name}, created_at}`。存在しない店は 404 `store_not_found`。余分な項目は 422。1 利用者 1 日 20 スレッドまで（429 `chat_rate_limited`） |
| `POST /api/chat/threads/{id}/messages` `{content}` | 発話を送り、応答を **SSE**（`text/event-stream`）で受ける（下）。`content` は 1〜500 文字（前後の空白を除く。空は 422）。始める前に、HTTP で: 404（他人の・期限切れ・無いスレッド）・409 `chat_busy`（前の発話を処理中）・409 `chat_thread_full`（1 スレッド 60 発話まで）・429 `chat_rate_limited`（1 利用者 1 日 100 発話まで） |
| `GET /api/chat/threads/{id}` | 履歴。`{id, store, created_at, messages: [{id, role: "user" \| "assistant", content, cards, created_at}]}`。他人のものは 404（存在しないスレッドと同じ本文）。`cards` は、サーバーがツールの結果から作ったカード（assistant のみ）。**確認カードは期限が切れていることがある**（確定の API が検証する） |
| `DELETE /api/chat/threads/{id}` | 自分のスレッドを、発話・ツール呼び出しの記録ごと消す。204。応答を作っている途中は 409 `chat_busy` |

エラーは他と同じ `{"detail": {"code", "message"}}`（固定の文）。追加の `code`: `chat_busy`(409) / `chat_thread_full`(409) / `chat_rate_limited`(429)。

### 保存期間

会話の本文は個人情報。`CHAT_RETENTION_DAYS`（既定 30。1〜365）を過ぎたスレッドは、読めず（404）、削除の対象になる。1 日の件数（`chat_usage`）は本文を持たず、スレッドを消しても戻らない。ログに本文は出さない。

### SSE（`POST .../messages` の応答）

ヘッダー: `content-type: text/event-stream`、`x-vercel-ai-ui-message-stream: v1`、`cache-control: no-cache, no-transform`。1 チャンクは `data: <JSON>` の行と空行。イベントが無い間（10 秒ごと）は、コメント行 `: ping`（無視してよい）。最後に `data: [DONE]`。形は AI SDK の UI message stream v1 に寄せた（フロントは、まだ作らない）。

```
start                  {messageId, messageMetadata: {thread_id}}
tool-input-available   {toolCallId, toolName, input, providerMetadata: {shopOrder: {auto}}}   ターンの先頭の get_cart は auto: true
tool-output-available  {toolCallId, output: {ok, summary, error?}}                        要約だけ（中身は、カードで出す）
data-card              {data: <カード>}
text-start / text-delta{delta} … / text-end                                              ガードを通った全文。24 文字ごとに分ける
finish                 {messageMetadata: {message_id, guard}}                             guard = 本文を置き換えた理由のコード（無ければ null）
error                  {errorText}                                                        失敗のとき（固定の文）。続けて [DONE]
```

並び: `start` → ターンの先頭の `get_cart` → （モデルの文があれば `text-*`）→ ツール呼び出しごとに `tool-input-available` → `tool-output-available` → `data-card`（0 枚以上）→ … → 最後の文 → `finish` → `[DONE]`。切断は失敗ではない（サーバーは、ステップの間で止める）。

**カード**（`data-card` の `data.kind`。すべてサーバーがツールの結果から作る。商品名・備考などは**画面でエスケープする**）:

| kind | 中身 |
|---|---|
| `products` | `items: [{item_id, code, name, category, allergens, variants: [{variant_id, size, temperature, price_lumi, available, unavailable_reason}]}]`（最大 8 品） |
| `cart` | `cart`: 上の `Cart` と同じ形 |
| `confirm` | **確認カード**。`proposal`: 上の `CheckoutProposal` と同じ形（`id`・`cart_version`・`total_lumi`・`expires_at`・`store`・`lines`・`pickup_note`）、`action: {type: "place_order", label: "注文を確定する"}`。**確定ボタンは、このカードにだけ出す**（モデルの文章からは出さない）。ボタンは `POST /api/orders {proposal_id}` を呼ぶ |
| `orders` | `orders: [{public_id, pickup_no, status, status_label, store, total_lumi, placed_at, items}]`（自分の注文だけ。最大 5 件） |
| `order` | `order`: 上の 1 件（`orders` の要素と同じ形） |

### ツール（AI に見せるもの）

`search_menu`・`get_item`・`get_cart`・`set_cart_item`・`set_fulfillment`・`check_slots`・`propose_checkout`・`list_my_orders`・`get_order_status` の 9 つだけ（[chat.md](chat.md)「ツール」）。引数に `user_id`・`store_id` は無く、余分な引数は拒否する。1 ターンの書き込み（`set_cart_item`・`set_fulfillment`・`propose_checkout`）は 3 回まで。宅配（`set_fulfillment` の `delivery`・`check_slots`）は準備中で、`delivery_unavailable` を返す（P2 まで）。ツール呼び出しは `chat_tool_calls` に残る（名前・引数・状態 `ok` / `error` / `rejected`・結果・カートの版の前後）。

**状態（2026-11-21）:** 上のすべてをバックエンドに実装した。実モデルは未接続（`CHAT_MODEL=mock`。`gemini` は起動時にエラー）。

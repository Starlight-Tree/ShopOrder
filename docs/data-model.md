# データモデル（設計。実装は番号付き SQL で足す）

流儀は JobNavi と同じ: snake_case、日時は `timestamptz`、真偽は `boolean`、PK は `GENERATED ALWAYS AS IDENTITY`（外へ見せる注文などは `public_id`）、状態は `text` + `CHECK`、不変条件は部分 UNIQUE・トリガー・`CHECK` でも守る、参照される行は `ON DELETE RESTRICT`。金額・数量はすべて整数（ルミ・個）。SQL の値は常にパラメーターで渡す。

「🔒」は個人情報（ログに出さない・分析に渡さない・退会で空にする）。世界観の値（店・メニュー・価格）は [world.md](world.md) が正本で、seed が入れる。

## 店と営業

| 表 | 主な列 | 備考 |
|---|---|---|
| `areas` | code, name | 居住区・発着場・岩山・遺跡（マスタ） |
| `stores` | id, name, area_code, address, open_time, close_time, closed_weekday null, last_order_minutes（30 / 15）, mobile_order boolean, seats | 12 店。world.md の表 |
| `store_closures` | store_id, date, reason | 臨時休業・嵐の警報。分析で「休業」と「売上 0」を区別する |

## メニュー

| 表 | 主な列 | 備考 |
|---|---|---|
| `menu_items` | id, code, name, category（drink / food / beans）, description, is_seasonal, available_from / until null, is_active | 看板（OB）・季節のブレンド・帰還祭の限定（12/1〜12/25）は期間で出す |
| `menu_variants` | item_id, size（S/M/L/なし）, temperature（hot/ice/なし）, price_lumi | **価格は変種ごと**。税込の整数 |
| `option_groups` / `options` | group: item_id, name, required, max_select。option: name, price_delta_lumi, allergen_codes[] | ミルクの種類・シロップ・挽き方。アレルゲンが変わる選択肢は、ここで持つ |
| `allergens` | code, name | 食品表示の 28 品目に合わせる（実店舗化のとき再確認） |
| `store_menu` | store_id, item_id, is_available | 店ごとの品揃い。なければ全店共通 |

## 在庫（台帳 + 残高）

| 表 | 主な列 | 備考 |
|---|---|---|
| `stock_items` | id, code, name, kind（material / sellable）, unit, reorder_point, safety_stock, shelf_life_days null | 原材料（生豆・牛乳・シロップ・カップ）と販売品目（豆の袋・菓子） |
| `stock_lots` | id, store_id, item_id, received_on, roasted_on null, best_before null, unit_cost_lumi null, status | 賞味期限のあるものだけ（豆・菓子・牛乳）。引当ては FEFO |
| `stock_balances` | store_id, item_id, lot_id null, on_hand, reserved | `CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)`。available = on_hand − reserved − safety_stock（導出） |
| `stock_movements` | id, store_id, item_id, lot_id null, kind（receive / reserve / release / consume / waste / adjust）, qty（符号つき）, reason, ref_type, ref_id, actor, occurred_at | **追記のみ**。正本。残高は同じトランザクションで更新し、夜間に台帳から再計算して照合 |
| `recipe_lines` | variant_id, stock_item_id, qty | ドリンク 1 杯の使用量。注文の調理開始で原材料を `consume` |
| `stock_reservations` | id, order_id, expires_at, status（held / consumed / released / expired） | 注文の確定から支払いまでの確保（既定 15 分）。期限切れは worker が戻し、アクセス時にも遅延で戻す |

## 顧客と注文

| 表 | 主な列 | 備考 |
|---|---|---|
| `users` | id, auth_user_id, display_name 🔒, email 🔒, loyalty_points, created_at | 顧客。Better Auth の `auth_user` に結ぶ（JobNavi と同じ） |
| `addresses` | id, user_id, label, area_code, line 🔒, note 🔒 | 宅配先。完了から N か月で消す（設定値） |
| `carts` / `cart_items` | cart: user_id UNIQUE, store_id, fulfillment, version。item: variant_id, qty, options jsonb | 下書き。**変更のたびに `version` を上げる**。チャットも画面も同じカートを操作する |
| `checkout_proposals` | id, cart_id, cart_version, total_lumi, expires_at, used_at null | 確定ボタンの許可証。カートの版・合計・期限に結び付き、版が変われば無効（[chat.md](chat.md)） |
| `orders` | id, public_id, user_id, store_id, status, fulfillment（pickup / delivery）, business_date, subtotal_lumi, delivery_fee_lumi, total_lumi, placed_at, ready_at, completed_at, source（screen / chat）, idempotency_key | `UNIQUE (user_id, idempotency_key)`。`business_date` は店の締めで決め、UTC に依存しない |
| `order_items` | id, order_id, variant_id, name_snapshot, unit_price_lumi, qty, options jsonb, line_total_lumi | **単価と名前のスナップショット**。価格を後で変えても過去の注文は変わらない |
| `order_events` | id, order_id, from_status, to_status, actor_type, actor_id, reason, at | 状態遷移の履歴。配達の所要時間・追跡画面・連絡スレッドの元 |
| `payments` | id, order_id, provider（mock / stripe…）, status（pending / paid / failed / refunded）, amount_lumi, provider_ref, idempotency_key | 模擬は即時または短い遅延で paid |
| `idempotency_keys` | key, user_id, request_hash, response jsonb, created_at | `UNIQUE (user_id, key)`。同じキーで内容が違えば 422。24 時間以上保持 |
| `loyalty_ledger` | id, user_id, order_id, points, kind（earn / redeem / expire）, at | 会計 100 ルミごとに 1 点、最後の利用から 12 か月で失効、100 点で無料券（world.md の資料どおり） |

## 配達

| 表 | 主な列 | 備考 |
|---|---|---|
| `delivery_zones` | id, name, area_code, fee_lumi, free_over_lumi null, min_order_lumi, base_minutes, is_suspended | 区画 = 4 エリア（新設）。送料は区画ごとの基本料 + 一定額以上で無料 |
| `zone_travel_minutes` | from_zone_id, to_zone_id, minutes | 区画間の所要時間（新設。距離行列の代わり。割り当ての最寄り提案に使う） |
| `store_zones` | store_id, zone_id | 店がどの区画へ届けるか（店のエリア + 隣接 1 エリア。新設） |
| `delivery_slots` | id, store_id, starts_at, ends_at, capacity, booked | 30 分枠。**確保は条件付き UPDATE（`booked < capacity`）で原子的に** |
| `deliveries` | id, order_id UNIQUE, zone_id, slot_id, courier_id null, status, pin_hash, pin_attempts, pin_expires_at, picked_up_at, delivered_at, failure_reason null | 有効な割り当ては 1 注文に 1 件。暗証コードは 4 桁・ハッシュで保存・5 回で凍結・完了か 24 時間で失効 |
| `couriers` | staff_id, store_id, vehicle（新設: 浮上スクーター）, is_on_duty | 配達員は `staff_accounts.role = 'courier'` |

## スタッフ

| 表 | 主な列 | 備考 |
|---|---|---|
| `staff_accounts` | id, store_id null, role（staff / courier / manager）, name, email, password_hash（argon2） | manager は store_id が null なら全店 |
| `staff_sessions` | token_hash, staff_id, expires_at | 平文のトークンは保存しない |

## チャット

| 表 | 主な列 | 備考 |
|---|---|---|
| `chat_threads` | id, user_id, store_id null, created_at | 他人のスレッドは 404 |
| `chat_messages` | id, thread_id, role, content 🔒, created_at | 保存期間と削除の対象 |
| `chat_tool_calls` | id, thread_id, name, args jsonb, result_summary, cart_version_before / after, at | 監査。ツールの呼び出しと、カートの差分を記録 |
| `order_messages` | id, order_id, sender_type, body 🔒, at | 注文ごとの連絡スレッド（後で）。表は最初から入れる |

## 分析（読み取り専用）

`analytics` スキーマに、日次集計表（`daily_store_item_sales`・`daily_store_hourly`・`daily_stock_levels`・`daily_delivery_stats`・`customer_rfm`）と、仮名 ID の対応を置く。詳細は [analytics.md](analytics.md)。

## 制約のまとめ（DB で守る）

- 在庫の `on_hand >= 0` と `reserved <= on_hand`、`stock_movements` は更新・削除しない（トリガーで拒否）。
- 1 注文に 1 件の配達（`deliveries.order_id UNIQUE`）、1 利用者に 1 つのカート、`orders` の冪等キー。
- `delivery_slots.booked <= capacity`、`business_date` は NOT NULL。
- 状態遷移はアプリが表で検査し、`order_events` へ記録する。許されない遷移は 409。

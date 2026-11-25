-- 注文・支払い・確保・冪等キー・ポイントの表（docs/data-model.md「顧客と注文」）。新しい表・索引・トリガーを作るだけ。
-- ロック: 既存の表への ALTER・書き込みは無い。参照先の users・stores・menu_variants・stock_items には、外部キーの作成の間だけ
--         SHARE ROW EXCLUSIVE（書き込みを待たせ、読み取りは通す）がかかる。いずれも小さい表で、一瞬で終わる。
-- 個人情報: orders は users（🔒）への参照だけを持ち、氏名・メール・住所は持たない。order_items は注文時の品名・単価のスナップショット。
--           冪等キーの応答（idempotency_keys.response）は注文の写しなので、ログ・分析に出さない。
-- 追記のみ: order_events は UPDATE・DELETE をトリガーで拒否する（0002 の oasis_forbid_ledger_change。seed の --reset だけ DELETE を通す）。

CREATE TABLE orders (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         text    NOT NULL UNIQUE CHECK (public_id ~ '^[A-HJ-NP-Z2-9]{8}$'),
  user_id           integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  store_id          integer NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  status            text    NOT NULL CHECK (status IN (
                      'placed', 'paid', 'accepted', 'preparing', 'ready', 'assigned', 'picked_up',
                      'delivering', 'delivered', 'delivery_failed', 'completed', 'cancelled')),
  fulfillment       text    NOT NULL CHECK (fulfillment IN ('pickup', 'delivery')),
  pickup_no         integer NOT NULL CHECK (pickup_no > 0),
  business_date     date    NOT NULL,
  subtotal_lumi     integer NOT NULL CHECK (subtotal_lumi >= 0),
  delivery_fee_lumi integer NOT NULL DEFAULT 0 CHECK (delivery_fee_lumi >= 0),
  total_lumi        integer NOT NULL CHECK (total_lumi >= 0),
  source            text    NOT NULL DEFAULT 'screen' CHECK (source IN ('screen', 'chat')),
  idempotency_key   text    NOT NULL,
  placed_at         timestamptz NOT NULL,
  paid_at           timestamptz,
  accepted_at       timestamptz,
  ready_at          timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  CHECK (total_lumi = subtotal_lumi + delivery_fee_lumi),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (store_id, business_date, pickup_no)
);
CREATE INDEX orders_user_placed ON orders (user_id, placed_at DESC);
CREATE INDEX orders_store_status ON orders (store_id, status, placed_at);

-- 注文の行。単価・名前・size・temperature は注文時のスナップショット（価格を後で変えても過去の注文は変わらない）。
CREATE TABLE order_items (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        bigint  NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  variant_id      integer NOT NULL REFERENCES menu_variants(id) ON DELETE RESTRICT,
  name            text    NOT NULL,
  size            text    NOT NULL,
  temperature     text    NOT NULL,
  unit_price_lumi integer NOT NULL CHECK (unit_price_lumi > 0),
  qty             integer NOT NULL CHECK (qty BETWEEN 1 AND 20),
  line_total_lumi integer NOT NULL,
  CHECK (line_total_lumi = unit_price_lumi * qty)
);
CREATE INDEX order_items_order ON order_items (order_id);

-- 状態遷移の履歴（追記のみ）。actor_type は customer / staff（店長・配達員も含む）/ system。
CREATE TABLE order_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     bigint NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  from_status  text,
  to_status    text   NOT NULL,
  actor_type   text   NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system')),
  actor_id     text,
  reason       text,
  at           timestamptz NOT NULL
);
CREATE INDEX order_events_order ON order_events (order_id, id);

CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION oasis_forbid_ledger_change();

CREATE TABLE payments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      bigint  NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  provider      text    NOT NULL,
  status        text    NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  amount_lumi   integer NOT NULL CHECK (amount_lumi >= 0),
  provider_ref  text,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);

-- 冪等キー。注文の確定の最初に INSERT ... ON CONFLICT DO NOTHING で取り、同じトランザクションの最後に response を入れる。
CREATE TABLE idempotency_keys (
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key           text    NOT NULL,
  request_hash  text    NOT NULL,
  response      jsonb,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- 注文ごとの在庫の確保。held（確保中）→ consumed（調理開始で消費）/ released（取消し）/ expired（支払い期限切れ）。
-- expires_at は支払いまでの期限（支払い完了で NULL）。
CREATE TABLE stock_reservations (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    bigint NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  status      text   NOT NULL CHECK (status IN ('held', 'consumed', 'released', 'expired')),
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX stock_reservations_expiry ON stock_reservations (expires_at) WHERE status = 'held' AND expires_at IS NOT NULL;

CREATE TABLE stock_reservation_lines (
  reservation_id bigint  NOT NULL REFERENCES stock_reservations(id) ON DELETE RESTRICT,
  item_id        integer NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  qty            integer NOT NULL CHECK (qty > 0),
  PRIMARY KEY (reservation_id, item_id)
);

-- 受け取り番号の採番（店 × 営業日の連番）。INSERT ... ON CONFLICT DO UPDATE ... RETURNING で 1 文で取る。
CREATE TABLE store_order_counters (
  store_id       integer NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  business_date  date    NOT NULL,
  last_no        integer NOT NULL CHECK (last_no > 0),
  PRIMARY KEY (store_id, business_date)
);

-- ポイントの台帳。earn は 1 注文に 1 回だけ（部分 UNIQUE）。
CREATE TABLE loyalty_ledger (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_id  bigint  REFERENCES orders(id) ON DELETE RESTRICT,
  points    integer NOT NULL CHECK (points <> 0),
  kind      text    NOT NULL CHECK (kind IN ('earn', 'redeem', 'expire')),
  at        timestamptz NOT NULL
);
CREATE UNIQUE INDEX loyalty_ledger_earn_once ON loyalty_ledger (order_id) WHERE kind = 'earn';
CREATE INDEX loyalty_ledger_user ON loyalty_ledger (user_id, at);

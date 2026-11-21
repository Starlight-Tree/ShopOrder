-- 宅配の表（docs/data-model.md「配達」、docs/api.md「宅配（P2）」）。新しい表と索引を作り、carts に 2 列と CHECK を足す。
-- ロック: 既存の表への変更は carts への ALTER TABLE（列の追加 2 つ・CHECK 1 つ）だけ。carts は小さく、ACCESS EXCLUSIVE は一瞬
--         （lock_timeout 5 秒。取れなければ失敗して何も変えない）。ほかは新しい表の作成。参照先（stores・users・areas・orders・
--         staff_accounts）には、外部キーの作成の間だけ SHARE ROW EXCLUSIVE（書き込みを待たせ、読み取りは通す）がかかる。
-- 個人情報: addresses.line・note と deliveries.address_line・address_note（🔒）。ログ・分析に出さない。
--           deliveries は、注文時の住所の写しを持つ（住所を消しても、配達中の注文の届け先は変わらない）。
--           暗証コードは、平文を持たない。nonce（乱数）と HMAC のハッシュだけ（サーバーの秘密がないと再現できない）。
-- 設計から変えた点: docs/api.md「宅配（P2）」の「状態」を見る（deliveries.status の値・pin_nonce・store_id・address_*・attempt・couriers.zone_id）。

-- 区画 = エリア（新設）。値は docs/world.md「宅配」が正本で、seed_demo.py が入れる。
CREATE TABLE delivery_zones (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  area_code       smallint NOT NULL UNIQUE REFERENCES areas(code) ON DELETE RESTRICT,
  name            text     NOT NULL UNIQUE,
  fee_lumi        integer  NOT NULL CHECK (fee_lumi >= 0),
  free_over_lumi  integer  CHECK (free_over_lumi > 0),
  min_order_lumi  integer  NOT NULL CHECK (min_order_lumi >= 0),
  base_minutes    smallint NOT NULL CHECK (base_minutes > 0),
  is_suspended    boolean  NOT NULL DEFAULT false,
  suspended_at    timestamptz,
  CHECK (is_suspended OR suspended_at IS NULL)
);

-- 区画間の所要時間（分。距離行列の代わり）。向きごとに 1 行（往復で同じ値を入れる）。同じ区画どうしの行は持たない（0 分）。
CREATE TABLE zone_travel_minutes (
  from_zone_id  integer  NOT NULL REFERENCES delivery_zones(id) ON DELETE RESTRICT,
  to_zone_id    integer  NOT NULL REFERENCES delivery_zones(id) ON DELETE RESTRICT,
  minutes       smallint NOT NULL CHECK (minutes > 0),
  PRIMARY KEY (from_zone_id, to_zone_id),
  CHECK (from_zone_id <> to_zone_id)
);

-- 店がどの区画へ届けるか（店のエリア + 隣接 1 エリア。新設）。行がある店だけが宅配をする。
CREATE TABLE store_zones (
  store_id  integer NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  zone_id   integer NOT NULL REFERENCES delivery_zones(id) ON DELETE RESTRICT,
  PRIMARY KEY (store_id, zone_id)
);
CREATE INDEX store_zones_zone ON store_zones (zone_id);

-- 時間枠（30 分）。booked <= capacity は CHECK でも守る。確保は条件付き UPDATE（booked < capacity）で原子的に。
CREATE TABLE delivery_slots (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id   integer     NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  capacity   smallint    NOT NULL CHECK (capacity > 0),
  booked     smallint    NOT NULL DEFAULT 0 CHECK (booked >= 0),
  CHECK (ends_at > starts_at),
  CHECK (booked <= capacity),
  UNIQUE (store_id, starts_at)
);

-- 配達員（staff_accounts.role = 'courier'）。zone_id は最後にいた区画（最寄りの提案に使う。null は店にいる）。
CREATE TABLE couriers (
  staff_id    integer PRIMARY KEY REFERENCES staff_accounts(id) ON DELETE RESTRICT,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  vehicle     text    NOT NULL DEFAULT 'hover-scooter',
  is_on_duty  boolean NOT NULL DEFAULT true,
  zone_id     integer REFERENCES delivery_zones(id) ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX couriers_store ON couriers (store_id);

-- 顧客の住所（🔒）。区画は area_code から決まる。
CREATE TABLE addresses (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  label       text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 20),
  area_code   smallint    NOT NULL REFERENCES areas(code) ON DELETE RESTRICT,
  line        text        NOT NULL CHECK (char_length(line) BETWEEN 1 AND 100),
  note        text        CHECK (note IS NULL OR char_length(note) <= 100),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user ON addresses (user_id, id);

-- 注文ごとの配達（有効な割り当ては 1 注文に 1 件）。status は pending（配達員の割り当て前）→ assigned → picked_up → delivering →
-- delivered / failed（不在・凍結）/ cancelled。再配達は、同じ行を pending へ戻して attempt を増やす。
-- 暗証コード: 集荷で nonce と HMAC のハッシュを入れる（平文は持たない）。pin_attempts は誤りの回数（5 で凍結 → failed）。
CREATE TABLE deliveries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        bigint   NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  store_id        integer  NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  zone_id         integer  NOT NULL REFERENCES delivery_zones(id) ON DELETE RESTRICT,
  slot_id         bigint   NOT NULL REFERENCES delivery_slots(id) ON DELETE RESTRICT,
  courier_id      integer  REFERENCES couriers(staff_id) ON DELETE RESTRICT,
  status          text     NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'assigned', 'picked_up', 'delivering', 'delivered', 'failed', 'cancelled')),
  attempt         smallint NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  address_label   text     NOT NULL,
  address_line    text     NOT NULL,
  address_note    text,
  pin_nonce       text,
  pin_hash        text,
  pin_attempts    smallint NOT NULL DEFAULT 0 CHECK (pin_attempts BETWEEN 0 AND 5),
  pin_expires_at  timestamptz,
  assigned_at     timestamptz,
  picked_up_at    timestamptz,
  departed_at     timestamptz,
  delivered_at    timestamptz,
  failed_at       timestamptz,
  failure_reason  text     CHECK (failure_reason IN ('absent', 'cannot_receive', 'other', 'pin_locked')),
  created_at      timestamptz NOT NULL,
  CHECK ((pin_nonce IS NULL) = (pin_hash IS NULL)),
  CHECK (status NOT IN ('assigned', 'picked_up', 'delivering') OR courier_id IS NOT NULL)
);
CREATE INDEX deliveries_courier ON deliveries (courier_id, status);
CREATE INDEX deliveries_store_status ON deliveries (store_id, status);
CREATE INDEX deliveries_slot ON deliveries (slot_id);

-- カートの宅配の選択（住所・枠）。店頭受け取りのときは、どちらも null。
ALTER TABLE carts ADD COLUMN address_id integer REFERENCES addresses(id) ON DELETE RESTRICT;
ALTER TABLE carts ADD COLUMN slot_id bigint REFERENCES delivery_slots(id) ON DELETE RESTRICT;
ALTER TABLE carts ADD CONSTRAINT carts_delivery_fields CHECK (fulfillment = 'delivery' OR (address_id IS NULL AND slot_id IS NULL));

-- 店・エリア・メニューの最初の表（docs/data-model.md「店と営業」「メニュー」）。新しい表を作るだけ。
-- ロック: 新しい表と索引の作成だけ。既存の表は無い（最初のマイグレーション）。
-- 個人情報: 無い。世界観の値（店・メニュー・価格）は docs/world.md が正本で、seed_demo.py が入れる。

CREATE TABLE areas (
  code  smallint PRIMARY KEY,
  name  text     NOT NULL UNIQUE,
  sort  smallint NOT NULL
);

-- 12 店。営業時間は 24 時間制の時刻、定休日は ISO の曜日（1 = 月 … 7 = 日。無ければ NULL）。
CREATE TABLE stores (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text     NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]+$'),
  name                text     NOT NULL UNIQUE,
  area_code           smallint NOT NULL REFERENCES areas(code) ON DELETE RESTRICT,
  address             text     NOT NULL,
  open_time           time     NOT NULL,
  close_time          time     NOT NULL,
  closed_weekday      smallint CHECK (closed_weekday BETWEEN 1 AND 7),
  last_order_minutes  smallint NOT NULL DEFAULT 30 CHECK (last_order_minutes IN (15, 30)),
  mobile_order        boolean  NOT NULL DEFAULT true,
  seats               smallint NOT NULL CHECK (seats > 0),
  CHECK (open_time < close_time)
);
CREATE INDEX stores_area ON stores (area_code);

-- 臨時休業・嵐の警報など。分析で「休業」と「営業したが売上 0」を区別するために使う。
CREATE TABLE store_closures (
  store_id  integer NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  date      date    NOT NULL,
  reason    text    NOT NULL,
  PRIMARY KEY (store_id, date)
);

-- メニューの 1 品。期間（season_from / season_to は 'MM-DD'。毎年）と時間帯（sold_from / sold_until）で出す。価格は変種（menu_variants）が持つ。
CREATE TABLE menu_items (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text     NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]+$'),
  name         text     NOT NULL,
  category     text     NOT NULL CHECK (category IN ('drink', 'food', 'beans')),
  description  text     NOT NULL DEFAULT '',
  allergens    text[]   NOT NULL DEFAULT '{}',
  season_from  text     CHECK (season_from ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  season_to    text     CHECK (season_to ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  sold_from    time,
  sold_until   time,
  is_active    boolean  NOT NULL DEFAULT true,
  sort         smallint NOT NULL,
  CHECK ((season_from IS NULL) = (season_to IS NULL))
);

-- サイズ・温度ごとの価格。ルミの整数（税込）。サイズ・温度の区別がない品は '-'。
CREATE TABLE menu_variants (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id      integer  NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  size         text     NOT NULL CHECK (size IN ('S', 'M', 'L', '-')),
  temperature  text     NOT NULL CHECK (temperature IN ('hot', 'ice', '-')),
  price_lumi   integer  NOT NULL CHECK (price_lumi > 0),
  UNIQUE (item_id, size, temperature)
);

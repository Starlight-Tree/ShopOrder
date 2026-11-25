-- 分析（P4）。analytics スキーマ（日次集計表・仮名 ID の対応・営業日カレンダー・読み取りのビュー）。docs/analytics.md、docs/metrics.md。
-- 新しいスキーマ・表・関数・ビューを作るだけ。既存の表への ALTER・書き込みは無い（ロックは、ビューと関数が参照する間だけ）。
-- 個人情報: 氏名・メール・住所・電話・自由記述は入れない。顧客は、秘密の鍵（環境変数 ANALYTICS_PSEUDONYM_KEY）で作った HMAC の仮名 ID だけ。
--           仮名 ID と users.id の対応（customer_pseudonyms）は、集計の作成（app/analytics_build.py）だけが読み書きする。API は読まない。
--           退会のときは、この対応の行を消せば、集計の数値は残したまま、誰のものか辿れなくなる。
-- 外部キー: この表たちは、元データから作り直せる派生データ。元の表（stores・stock_items・menu_items・users）への外部キーは持たない
--           （seed の入れ直しや別基盤への移行を止めないため）。入れ直しのときは、seed が analytics の表も空にする。
-- 営業日（business_date）: 店の締めで決まる日付（orders.business_date）。UTC や端末の日付に依存しない。

CREATE SCHEMA analytics;

-- ---- 営業日カレンダー ----
-- 店 × 日付 → 営業日か。定休日（stores.closed_weekday）と臨時休業（store_closures）から作る。
-- 注文（completed / cancelled）がある日は、カレンダーが休みでも営業日にする（実際に開けた日。売上を捨てない）。
-- 休業日は集計表に行を作らない（API は NULL）。営業日は、売上 0 でも summary の行を作る（API は 0）。
CREATE FUNCTION analytics.store_days(from_date date, to_date date)
RETURNS TABLE (store_id integer, business_date date, is_open boolean, closed_reason text)
LANGUAGE sql STABLE AS $$
  SELECT s.id,
         d.day,
         (cal.scheduled_open OR cal.has_orders),
         CASE WHEN cal.scheduled_open OR cal.has_orders THEN NULL
              WHEN cal.closure THEN 'temporary_closure'
              ELSE 'weekly_closed' END
  FROM stores s
  CROSS JOIN (SELECT from_date + n AS day FROM generate_series(0, to_date - from_date) AS n) d
  CROSS JOIN LATERAL (
    SELECT c.closure,
           (s.closed_weekday IS DISTINCT FROM EXTRACT(ISODOW FROM d.day)::int AND NOT c.closure) AS scheduled_open,
           EXISTS (SELECT 1 FROM orders o WHERE o.store_id = s.id AND o.business_date = d.day AND o.status IN ('completed', 'cancelled')) AS has_orders
    FROM (SELECT EXISTS (SELECT 1 FROM store_closures sc WHERE sc.store_id = s.id AND sc.date = d.day) AS closure) c
  ) cal
$$;

-- ---- 読み取りのビュー（集計の作成と、当日の読み取りが、同じ定義を使う） ----
-- 注文の事実（個人を含まない。user_id は出さない）。売上は status = 'completed' だけ。
CREATE VIEW analytics.order_facts AS
SELECT o.id AS order_id, o.store_id, o.business_date, o.fulfillment, o.status, o.total_lumi, o.placed_at
FROM orders o;

-- 売上の行（completed の注文の明細）。品目は menu_items の単位（サイズ・温度を束ねる）。
CREATE VIEW analytics.sales_lines AS
SELECT o.id AS order_id, o.store_id, o.business_date, o.fulfillment,
       mi.id AS item_id, mi.code AS item_code, mi.name AS item_name, mi.category,
       oi.qty, oi.line_total_lumi
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN menu_variants v ON v.id = oi.variant_id
JOIN menu_items mi ON mi.id = v.item_id
WHERE o.status = 'completed';

-- 在庫の今の位置（台帳ではなく残高。当日を含む）。
CREATE VIEW analytics.stock_position AS
SELECT b.store_id, i.id AS item_id, i.code AS item_code, i.name AS item_name, i.kind, i.unit,
       b.on_hand, b.reserved, i.safety_stock, i.reorder_point
FROM stock_balances b
JOIN stock_items i ON i.id = b.item_id;

-- ---- 日次集計（確定した日だけ。当日は元データから都度） ----
-- 店 × 営業日の合計。営業日なら、売上 0 でも 1 行（これが「営業したが売上 0」の印。休業日は行なし）。
CREATE TABLE analytics.daily_store_summary (
  store_id          integer NOT NULL,
  business_date     date    NOT NULL,
  orders            integer NOT NULL CHECK (orders >= 0),            -- completed の件数
  cancelled_orders  integer NOT NULL CHECK (cancelled_orders >= 0),
  sales_lumi        integer NOT NULL CHECK (sales_lumi >= 0),        -- completed の total_lumi の合計
  built_at          timestamptz NOT NULL,
  PRIMARY KEY (store_id, business_date)
);

-- 店 × 営業日 × 品目 × 受け取り方法。品目の名前・区分は作成時の写し（別基盤へそのまま出せる形）。
CREATE TABLE analytics.daily_store_item_sales (
  store_id       integer NOT NULL,
  business_date  date    NOT NULL,
  item_id        integer NOT NULL,
  fulfillment    text    NOT NULL CHECK (fulfillment IN ('pickup', 'delivery')),
  item_code      text    NOT NULL,
  item_name      text    NOT NULL,
  category       text    NOT NULL CHECK (category IN ('drink', 'food', 'beans')),
  qty            integer NOT NULL CHECK (qty > 0),
  sales_lumi     integer NOT NULL CHECK (sales_lumi >= 0),
  built_at       timestamptz NOT NULL,
  PRIMARY KEY (store_id, business_date, item_id, fulfillment)
);
CREATE INDEX daily_store_item_sales_date ON analytics.daily_store_item_sales (business_date, store_id);

-- 店 × 営業日 × 時間帯（店のローカル時刻の時）× 受け取り方法。completed の注文数と売上。
CREATE TABLE analytics.daily_store_hourly (
  store_id       integer  NOT NULL,
  business_date  date     NOT NULL,
  hour           smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  fulfillment    text     NOT NULL CHECK (fulfillment IN ('pickup', 'delivery')),
  orders         integer  NOT NULL CHECK (orders > 0),
  sales_lumi     integer  NOT NULL CHECK (sales_lumi >= 0),
  built_at       timestamptz NOT NULL,
  PRIMARY KEY (store_id, business_date, hour, fulfillment)
);
CREATE INDEX daily_store_hourly_date ON analytics.daily_store_hourly (business_date, store_id);

-- 店 × 営業日 × 在庫品目。台帳から再計算した、その日の締め（ローカルの 24 時）の残量と、その日の動き。
-- consumed・wasted は正の数（台帳の符号を反転）。adjusted は符号つき。
CREATE TABLE analytics.daily_stock_levels (
  store_id       integer NOT NULL,
  business_date  date    NOT NULL,
  item_id        integer NOT NULL,
  item_code      text    NOT NULL,
  on_hand_end    integer NOT NULL,  -- 台帳の時刻が不整合だと負になりうる（照合 inventory.reconcile で見つける。ここでは止めない）
  received       integer NOT NULL CHECK (received >= 0),
  consumed       integer NOT NULL CHECK (consumed >= 0),
  wasted         integer NOT NULL CHECK (wasted >= 0),
  adjusted       integer NOT NULL,
  built_at       timestamptz NOT NULL,
  PRIMARY KEY (store_id, business_date, item_id)
);
CREATE INDEX daily_stock_levels_date ON analytics.daily_stock_levels (business_date, store_id);

-- 廃棄の理由別。台帳の理由は自由記述なので、固定の区分（expired / damaged / quality / other）に写す（自由記述は持ち込まない）。
CREATE TABLE analytics.daily_stock_waste (
  store_id       integer NOT NULL,
  business_date  date    NOT NULL,
  item_id        integer NOT NULL,
  reason_code    text    NOT NULL CHECK (reason_code IN ('expired', 'damaged', 'quality', 'other')),
  qty            integer NOT NULL CHECK (qty > 0),
  built_at       timestamptz NOT NULL,
  PRIMARY KEY (store_id, business_date, item_id, reason_code)
);
CREATE INDEX daily_stock_waste_date ON analytics.daily_stock_waste (business_date, store_id);

-- ---- 顧客（仮名 ID だけ） ----
-- 仮名 ID と users.id の対応。作成（analytics_build）だけが使う。API は読まない。退会のときは、この行を消す。
CREATE TABLE analytics.customer_pseudonyms (
  user_id       integer PRIMARY KEY,
  pseudonym_id  text    NOT NULL UNIQUE CHECK (pseudonym_id ~ '^[0-9a-f]{32}$'),
  created_at    timestamptz NOT NULL
);

-- 顧客ごとの RFM（作成時点のスナップショット。as_of = 作成日。確定した日の注文だけで数える）。
CREATE TABLE analytics.customer_rfm (
  pseudonym_id     text     PRIMARY KEY,
  first_order_date date     NOT NULL,
  last_order_date  date     NOT NULL,
  orders           integer  NOT NULL CHECK (orders > 0),
  spend_lumi       integer  NOT NULL CHECK (spend_lumi >= 0),
  recency_days     integer  NOT NULL CHECK (recency_days >= 0),
  r_score          smallint NOT NULL CHECK (r_score BETWEEN 1 AND 3),
  f_score          smallint NOT NULL CHECK (f_score BETWEEN 1 AND 3),
  m_score          smallint NOT NULL CHECK (m_score BETWEEN 1 AND 3),
  segment          text     NOT NULL CHECK (segment IN ('loyal', 'regular', 'light', 'at_risk', 'dormant')),
  as_of            date     NOT NULL,
  built_at         timestamptz NOT NULL
);

-- 顧客 × 月（その月の注文数と利用額）。コホート（初回月 × 経過月）の元。
CREATE TABLE analytics.customer_monthly (
  pseudonym_id  text    NOT NULL,
  month         date    NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),  -- 月の初日
  orders        integer NOT NULL CHECK (orders > 0),
  spend_lumi    integer NOT NULL CHECK (spend_lumi >= 0),
  PRIMARY KEY (pseudonym_id, month)
);

-- 作成の状態。鍵の指紋（鍵そのものではない）を持ち、鍵が変わったまま続きを作らないようにする。
CREATE TABLE analytics.build_state (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL
);

-- 在庫の表（docs/data-model.md「在庫」）と、追記のみの表を守るトリガー関数。新しい表・関数・トリガーを作るだけ。
-- ロック: 既存の表への ALTER・書き込みは無い。参照先の stores・menu_variants には、外部キーの作成の間だけ SHARE ROW EXCLUSIVE
--         （書き込みを待たせ、読み取りは通す）がかかる。どちらも小さい表で、一瞬で終わる。
-- 個人情報: 無い。実行者（actor）は 'customer:<id>' / 'staff:<id>' / 'system' / 'seed' の識別子だけで、名前・連絡先を入れない。
-- ロットと賞味期限は今回は持たない（lot_id の列は作らない。docs/data-model.md に「未実装」と書く）。

-- 追記のみの表（stock_movements・order_events）の UPDATE・DELETE を拒否する。
-- 例外: セッション設定 oasis.allow_ledger_reset = 'on' のときだけ DELETE を通す（seed_demo --reset が、ダミーデータを入れ直すために使う。UPDATE は常に拒否）。
CREATE FUNCTION oasis_forbid_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('oasis.allow_ledger_reset', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only table: % is not allowed on %', TG_OP, TG_TABLE_NAME USING ERRCODE = '23000';
END;
$$;

-- 在庫の品目。material = 原材料（豆・牛乳・カップなど。ドリンクは調理開始でレシピの分を消費）、sellable = 販売品目（菓子・豆の袋。1 個ずつ売る）。
CREATE TABLE stock_items (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           text    NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]+$'),
  name           text    NOT NULL,
  kind           text    NOT NULL CHECK (kind IN ('material', 'sellable')),
  unit           text    NOT NULL,
  reorder_point  integer NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  safety_stock   integer NOT NULL DEFAULT 0 CHECK (safety_stock >= 0)
);

-- 変種 1 つ（ドリンク 1 杯・菓子 1 個など）の使用量。
CREATE TABLE recipe_lines (
  variant_id    integer NOT NULL REFERENCES menu_variants(id) ON DELETE RESTRICT,
  stock_item_id integer NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  qty           integer NOT NULL CHECK (qty > 0),
  PRIMARY KEY (variant_id, stock_item_id)
);
CREATE INDEX recipe_lines_stock_item ON recipe_lines (stock_item_id);

-- 残高（店 × 品目）。台帳（stock_movements）と同じトランザクションで更新する。available = on_hand - reserved - safety_stock（導出）。
CREATE TABLE stock_balances (
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  item_id     integer NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  on_hand     integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved    integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, item_id),
  CHECK (reserved <= on_hand)
);

-- 台帳（追記のみ。正本）。qty は符号つき:
--   reserve +n / release -n（reserved に効く）、consume -n（on_hand と reserved の両方から n を引く）、
--   receive +n・waste -n・adjust ±n（on_hand に効く）。
--   よって on_hand = Σ(receive, consume, waste, adjust)、reserved = Σ(reserve, release, consume)。
CREATE TABLE stock_movements (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id     integer NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  item_id      integer NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  kind         text    NOT NULL CHECK (kind IN ('receive', 'reserve', 'release', 'consume', 'waste', 'adjust')),
  qty          integer NOT NULL CHECK (qty <> 0),
  ref_type     text,
  ref_id       text,
  reason       text,
  actor        text    NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind IN ('receive', 'reserve') AND qty > 0)
    OR (kind IN ('release', 'consume', 'waste') AND qty < 0)
    OR kind = 'adjust'
  )
);
CREATE INDEX stock_movements_balance ON stock_movements (store_id, item_id, occurred_at);
CREATE INDEX stock_movements_ref ON stock_movements (ref_type, ref_id);

CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION oasis_forbid_ledger_change();

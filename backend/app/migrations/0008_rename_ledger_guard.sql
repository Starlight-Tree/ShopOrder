-- 名前の整理（oasis → shop_order）。適用済みの 0002・0004 は書き換えない（sha256 を記録していて、変わると止まる）。
-- 追記のみの表（stock_movements・order_events）を守るトリガー関数の、本体のセッション設定名を oasis.allow_ledger_reset から
-- shop_order.allow_ledger_reset に替え、関数名も oasis_forbid_ledger_change から shop_order_forbid_ledger_change に替える。
-- トリガーは関数の OID を指すので、付け替えは要らない。振る舞い（UPDATE は常に拒否、DELETE は設定が 'on' のときだけ通す）は変えない。
-- ロック: 関数の定義だけ。表には触れない。個人情報: 無い。
CREATE OR REPLACE FUNCTION oasis_forbid_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('shop_order.allow_ledger_reset', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only table: % is not allowed on %', TG_OP, TG_TABLE_NAME USING ERRCODE = '23000';
END;
$$;

ALTER FUNCTION oasis_forbid_ledger_change() RENAME TO shop_order_forbid_ledger_change;

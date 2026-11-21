"""(h) 追記のみの台帳（トリガー）・(i) 台帳からの再計算・seed の再実行と --reset。使い捨ての別 DB で確かめる。"""

import os
import subprocess
import sys
from datetime import datetime, timezone

import psycopg
import pytest

from app import inventory, migrate, seed_demo
from tests.conftest import TEST_URL, new_database

pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL が未設定です")

NOW = datetime(2026, 11, 21, 3, 0, tzinfo=timezone.utc)


@pytest.fixture
def fresh_db():
    url = new_database("oasis_ledger_test")
    assert migrate.apply(url, out=lambda *_: None) == 0
    seed_demo.main(reset=True, url=url)
    return url


def _first(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()[0]


def _make_order(conn) -> int:
    user = _first(conn, "INSERT INTO users (auth_user_id, display_name) VALUES ('dev:ledger', 'ledger') RETURNING id")
    store = _first(conn, "SELECT id FROM stores ORDER BY id LIMIT 1")
    order = _first(
        conn,
        "INSERT INTO orders (public_id, user_id, store_id, status, fulfillment, pickup_no, business_date, subtotal_lumi, total_lumi, idempotency_key, placed_at) "
        "VALUES ('ABCDEFGH', %s, %s, 'placed', 'pickup', 1, '2026-11-21', 100, 100, 'k-ledger-1', %s) RETURNING id",
        (user, store, NOW),
    )
    conn.execute("INSERT INTO order_events (order_id, from_status, to_status, actor_type, at) VALUES (%s, NULL, 'placed', 'customer', %s)", (order, NOW))
    return order


def test_ledger_rows_cannot_be_updated_or_deleted(fresh_db):
    """(h) stock_movements と order_events は、UPDATE・DELETE をトリガーで拒否する。"""
    with psycopg.connect(fresh_db, autocommit=True) as conn:
        _make_order(conn)
        for sql in (
            "UPDATE stock_movements SET qty = qty + 1",
            "DELETE FROM stock_movements",
            "UPDATE order_events SET reason = 'x'",
            "DELETE FROM order_events",
        ):
            with pytest.raises(psycopg.errors.IntegrityConstraintViolation, match="append-only"):
                conn.execute(sql)
        assert _first(conn, "SELECT count(*) FROM stock_movements") == 168 and _first(conn, "SELECT count(*) FROM order_events") == 1


def test_delete_is_allowed_only_with_the_reset_setting_and_update_never(fresh_db):
    with psycopg.connect(fresh_db) as conn:
        _make_order(conn)
        conn.commit()
        conn.execute("SET LOCAL oasis.allow_ledger_reset = 'on'")
        with pytest.raises(psycopg.errors.IntegrityConstraintViolation):
            conn.execute("UPDATE stock_movements SET qty = qty")  # 設定があっても、UPDATE は常に拒否
        conn.rollback()
        conn.execute("SET LOCAL oasis.allow_ledger_reset = 'on'")
        conn.execute("DELETE FROM order_events")
        conn.execute("DELETE FROM stock_movements")
        conn.commit()
        assert _first(conn, "SELECT count(*) FROM stock_movements") == 0
        # 設定は、そのトランザクションの中だけ。次のトランザクションでは、また拒否される（行が無いと行トリガーは動かないので、1 行入れてから）
        conn.execute(
            "INSERT INTO stock_movements (store_id, item_id, kind, qty, actor) "
            "SELECT s.id, i.id, 'receive', 1, 'test' FROM (SELECT id FROM stores LIMIT 1) s, (SELECT id FROM stock_items LIMIT 1) i"
        )
        conn.commit()
        with pytest.raises(psycopg.errors.IntegrityConstraintViolation):
            conn.execute("DELETE FROM stock_movements")
        conn.rollback()
        assert conn.execute("SELECT current_setting('oasis.allow_ledger_reset', true)").fetchone()[0] in (None, "", "off")


def test_ledger_sign_rules_and_balance_checks(fresh_db):
    with psycopg.connect(fresh_db, autocommit=True) as conn:
        store, item = _first(conn, "SELECT id FROM stores LIMIT 1"), _first(conn, "SELECT id FROM stock_items LIMIT 1")
        for kind, qty in (("reserve", -1), ("release", 1), ("consume", 1), ("receive", -1), ("waste", 1), ("receive", 0)):
            with pytest.raises(psycopg.errors.CheckViolation):
                conn.execute(
                    "INSERT INTO stock_movements (store_id, item_id, kind, qty, actor) VALUES (%s, %s, %s, %s, 'test')", (store, item, kind, qty)
                )
        # 残高の CHECK: reserved <= on_hand、負の数は不可
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("UPDATE stock_balances SET reserved = on_hand + 1 WHERE store_id = %s AND item_id = %s", (store, item))
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("UPDATE stock_balances SET on_hand = -1, reserved = 0 WHERE store_id = %s AND item_id = %s", (store, item))


def test_order_table_constraints(fresh_db):
    with psycopg.connect(fresh_db, autocommit=True) as conn:
        order = _make_order(conn)
        store = _first(conn, "SELECT store_id FROM orders WHERE id = %s", (order,))
        user = _first(conn, "SELECT user_id FROM orders WHERE id = %s", (order,))
        base = "INSERT INTO orders (public_id, user_id, store_id, status, fulfillment, pickup_no, business_date, subtotal_lumi, delivery_fee_lumi, total_lumi, idempotency_key, placed_at) VALUES "
        with pytest.raises(psycopg.errors.CheckViolation):  # total = subtotal + fee
            conn.execute(base + "('BCDEFGHJ', %s, %s, 'placed', 'pickup', 2, '2026-11-21', 100, 0, 150, 'k2', %s)", (user, store, NOW))
        with pytest.raises(psycopg.errors.UniqueViolation):  # (store, business_date, pickup_no)
            conn.execute(base + "('CDEFGHJK', %s, %s, 'placed', 'pickup', 1, '2026-11-21', 100, 0, 100, 'k3', %s)", (user, store, NOW))
        with pytest.raises(psycopg.errors.UniqueViolation):  # (user, idempotency_key)
            conn.execute(base + "('DEFGHJKL', %s, %s, 'placed', 'pickup', 5, '2026-11-21', 100, 0, 100, 'k-ledger-1', %s)", (user, store, NOW))
        with pytest.raises(psycopg.errors.CheckViolation):  # public_id は紛らわしい文字を含まない
            conn.execute(base + "('IO01IO01', %s, %s, 'placed', 'pickup', 6, '2026-11-21', 100, 0, 100, 'k5', %s)", (user, store, NOW))
        with pytest.raises(psycopg.errors.CheckViolation):  # line_total = 単価 × 数量
            conn.execute(
                "INSERT INTO order_items (order_id, variant_id, name, size, temperature, unit_price_lumi, qty, line_total_lumi) "
                "SELECT %s, id, 'x', 'M', 'hot', 450, 2, 999 FROM menu_variants LIMIT 1",
                (order,),
            )


def test_reconcile_matches_after_operations_and_detects_a_difference(fresh_db):
    """(i) 台帳から再計算した on_hand・reserved が、残高と一致する。残高だけ書き換えれば、食い違いとして見つかる。"""
    with psycopg.connect(fresh_db, row_factory=psycopg.rows.dict_row) as conn:
        store = conn.execute("SELECT id FROM stores ORDER BY id LIMIT 1").fetchone()["id"]
        ids = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM stock_items")}
        assert inventory.reconcile(conn) == []  # seed 直後
        a, b = ids["coffee-beans"], ids["cup-m"]
        inventory.reserve(conn, store, {a: 36, b: 2}, ref_type="order", ref_id="X", actor="test", now=NOW)
        inventory.consume(conn, store, {a: 36, b: 2}, ref_type="order", ref_id="X", actor="test", now=NOW)
        inventory.reserve(conn, store, {a: 18}, ref_type="order", ref_id="Y", actor="test", now=NOW)
        inventory.release(conn, store, {a: 18}, ref_type="order", ref_id="Y", reason="test", actor="test", now=NOW)
        inventory.receive(conn, store, a, 100, reason=None, actor="test", now=NOW)
        inventory.waste(conn, store, a, 10, reason="test", actor="test", now=NOW)
        inventory.adjust(conn, store, a, -7, reason="test", actor="test", now=NOW)
        assert inventory.reconcile(conn) == []
        row = conn.execute("SELECT on_hand, reserved FROM stock_balances WHERE store_id = %s AND item_id = %s", (store, a)).fetchone()
        assert row["reserved"] == 0
        conn.execute("UPDATE stock_balances SET on_hand = on_hand + 1 WHERE store_id = %s AND item_id = %s", (store, b))
        diffs = inventory.reconcile(conn)
        assert [(d["store_id"], d["item_id"], d["balance_on_hand"] - d["ledger_on_hand"]) for d in diffs] == [(store, b, 1)]


def test_reserve_is_conditional_and_respects_safety_stock(fresh_db):
    with psycopg.connect(fresh_db, row_factory=psycopg.rows.dict_row) as conn:
        store = conn.execute("SELECT id FROM stores WHERE code = 'residential-main'").fetchone()["id"]
        beans = conn.execute("SELECT id FROM stock_items WHERE code = 'coffee-beans'").fetchone()["id"]
        on_hand = conn.execute("SELECT on_hand FROM stock_balances WHERE store_id = %s AND item_id = %s", (store, beans)).fetchone()["on_hand"]
        available = on_hand - 500  # 安全在庫 500 g
        with pytest.raises(inventory.InsufficientStock):
            inventory.reserve(conn, store, {beans: available + 1}, ref_type="order", ref_id="Z", actor="test", now=NOW)
        conn.rollback()
        inventory.reserve(conn, store, {beans: available}, ref_type="order", ref_id="Z", actor="test", now=NOW)
        with pytest.raises(inventory.InsufficientStock):
            inventory.reserve(conn, store, {beans: 1}, ref_type="order", ref_id="Z2", actor="test", now=NOW)


def test_seed_rerun_keeps_stock_and_has_a_recipe_for_every_variant(fresh_db):
    with psycopg.connect(fresh_db, autocommit=True) as conn:
        assert _first(conn, "SELECT count(*) FROM menu_variants v WHERE NOT EXISTS (SELECT 1 FROM recipe_lines r WHERE r.variant_id = v.id)") == 0
        assert _first(conn, "SELECT count(*) FROM stock_balances") == 12 * len(seed_demo.STOCK_ITEMS)
        # 発着場西口店のガトーショコラだけ少量（売り切れの再現用）
        low = conn.execute("SELECT s.code, i.code, b.on_hand FROM stock_balances b JOIN stores s ON s.id = b.store_id JOIN stock_items i ON i.id = b.item_id WHERE b.on_hand <= 3").fetchall()
        assert low == [("terminal-west", "gateau-chocolat", 3)]
        # OB M ホット = コーヒー豆 18 g + カップ M 1。ラテ M = 豆 18 g + 牛乳 200 ml + カップ。モーニングセット = 豆 + カップ S + パン 1
        recipe = lambda item, size, temp: dict(conn.execute(  # noqa: E731
            "SELECT si.code, r.qty FROM recipe_lines r JOIN stock_items si ON si.id = r.stock_item_id JOIN menu_variants v ON v.id = r.variant_id "
            "JOIN menu_items i ON i.id = v.item_id WHERE i.code = %s AND v.size = %s AND v.temperature = %s", (item, size, temp)).fetchall())
        assert recipe("oasis-blend", "M", "hot") == {"coffee-beans": 18, "cup-m": 1}
        assert recipe("cafe-latte", "M", "ice") == {"coffee-beans": 18, "milk": 200, "cup-m": 1}
        assert recipe("morning-set", "-", "-") == {"coffee-beans": 14, "cup-s": 1, "bread": 1}
        assert recipe("gateau-chocolat", "-", "-") == {"gateau-chocolat": 1}
        conn.execute("UPDATE stock_balances SET on_hand = 777 WHERE store_id = (SELECT id FROM stores WHERE code = 'rock-plaza') AND item_id = (SELECT id FROM stock_items WHERE code = 'milk')")
        movements = _first(conn, "SELECT count(*) FROM stock_movements")
    seed_demo.main(url=fresh_db)  # 再実行
    with psycopg.connect(fresh_db, autocommit=True) as conn:
        assert _first(conn, "SELECT on_hand FROM stock_balances WHERE store_id = (SELECT id FROM stores WHERE code = 'rock-plaza') AND item_id = (SELECT id FROM stock_items WHERE code = 'milk')") == 777
        assert _first(conn, "SELECT count(*) FROM stock_movements") == movements  # 台帳も増えない
        assert _first(conn, "SELECT count(*) FROM staff_accounts") == 13 + len(seed_demo.COURIERS)  # 店 12 + 店長 1 + 配達員（P2）


def test_seed_reset_clears_orders_and_the_ledger_and_rebuilds(fresh_db):
    with psycopg.connect(fresh_db, autocommit=True) as conn:
        order = _make_order(conn)
        conn.execute("INSERT INTO payments (order_id, provider, status, amount_lumi, created_at, updated_at) VALUES (%s, 'mock', 'pending', 100, %s, %s)", (order, NOW, NOW))
    seed_demo.main(reset=True, url=fresh_db)
    with psycopg.connect(fresh_db, autocommit=True) as conn:
        for table in ("orders", "order_events", "payments", "users"):
            assert _first(conn, f"SELECT count(*) FROM {table}") == 0, table  # noqa: S608
        assert _first(conn, "SELECT count(*) FROM stock_movements") == 12 * len(seed_demo.STOCK_ITEMS)  # 初期在庫の receive だけ
        assert _first(conn, "SELECT count(*) FROM stock_balances") == 12 * len(seed_demo.STOCK_ITEMS)
    with psycopg.connect(fresh_db, row_factory=psycopg.rows.dict_row) as conn:
        assert inventory.reconcile(conn) == []  # 再構築した残高と台帳が合う


def test_seed_keeps_the_demo_data_gate():
    env = {k: v for k, v in os.environ.items() if k not in ("DEMO_DATA", "DATABASE_URL")}
    result = subprocess.run([sys.executable, "-m", "app.seed_demo", "--reset"], env=env, capture_output=True, text=True, cwd=os.path.join(os.path.dirname(__file__), ".."))
    assert result.returncode != 0 and "DEMO_DATA=allow" in (result.stdout + result.stderr)

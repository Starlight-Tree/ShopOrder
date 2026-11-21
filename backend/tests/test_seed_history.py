"""ダミーの履歴（seed_demo --reset --history）: 決定的・台帳と残高の整合・規模と時間帯と看板・帰還祭・休業と売上 0・--reset との両立・DEMO_DATA の門番。実 DB。"""

import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone

import pytest

from app import analytics_queries as q, inventory, migrate, seed_demo, seed_history
from tests.conftest import TEST_URL, new_database
from tests.helpers_analytics import connect

pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL が未設定です")

TODAY = date(2026, 11, 21)
AS_OF = datetime(2026, 11, 21, 3, 0, tzinfo=timezone.utc)  # 店のローカル 12:00（UTC+9）


def _seeded(name: str, today: date = TODAY, as_of: datetime = AS_OF) -> str:
    url = new_database(name)
    assert migrate.apply(url, out=lambda *_: None) == 0
    seed_demo.main(reset=True, url=url, history=True, today=today, as_of=as_of)
    return url


@pytest.fixture(scope="module")
def hist():
    return _seeded("shop_order_hist_a")


def _fingerprint(url: str) -> dict:
    """ID（連番・注文の乱数でない部分）を除いた内容。2 回の seed を比べる。"""
    with connect(url) as conn:
        return {
            "orders": [tuple(r.values()) for r in conn.execute(
                "SELECT o.public_id, s.code, u.auth_user_id, o.status, o.pickup_no, o.business_date, o.total_lumi, o.placed_at, o.completed_at, o.cancel_reason "
                "FROM orders o JOIN stores s ON s.id = o.store_id JOIN users u ON u.id = o.user_id ORDER BY o.public_id")],
            "items": [tuple(r.values()) for r in conn.execute(
                "SELECT o.public_id, oi.name, oi.size, oi.temperature, oi.qty, oi.line_total_lumi FROM order_items oi JOIN orders o ON o.id = oi.order_id ORDER BY 1, 2, 3, 4, 5")],
            "movements": [tuple(r.values()) for r in conn.execute(
                "SELECT s.code, i.code, m.kind, m.qty, m.ref_id, m.reason, m.actor LIKE 'customer:%%' AS by_customer, m.occurred_at FROM stock_movements m "
                "JOIN stores s ON s.id = m.store_id JOIN stock_items i ON i.id = m.item_id ORDER BY m.occurred_at, 1, 2, 3, 4, 5")],
            "users": [tuple(r.values()) for r in conn.execute("SELECT auth_user_id, display_name, loyalty_points, created_at FROM users ORDER BY 1")],
            "summary": [tuple(r.values()) for r in conn.execute("SELECT store_id - (SELECT min(id) FROM stores) AS s, business_date, orders, cancelled_orders, sales_lumi FROM analytics.daily_store_summary ORDER BY 1, 2")],
            "rfm": [tuple(r.values()) for r in conn.execute("SELECT orders, spend_lumi, recency_days, segment FROM analytics.customer_rfm ORDER BY 1, 2, 3, 4")],
        }


def test_the_seed_is_deterministic(hist):
    """同じ（今日・時刻）なら、別の DB に入れても、同じ内容（ID を除く）になる。"""
    other = _seeded("shop_order_hist_b")
    a, b = _fingerprint(hist), _fingerprint(other)
    assert a["orders"] and a == b


def test_the_ledger_matches_the_balances_and_the_daily_levels(hist):
    """台帳と残高が合う（reconcile が空）。日次の残量の最後の日は、台帳の合計と一致する。"""
    with connect(hist) as conn:
        assert inventory.reconcile(conn) == []
        assert conn.execute("SELECT count(*) AS n FROM stock_balances WHERE reserved <> 0").fetchone()["n"] == 0  # 進行中の注文は作らない
        assert conn.execute("SELECT count(*) AS n FROM stock_balances WHERE on_hand < 0").fetchone()["n"] == 0
        last = conn.execute("SELECT max(business_date) AS d FROM analytics.daily_stock_levels").fetchone()["d"]
        assert last == TODAY - timedelta(days=1)
        today_start = datetime(2026, 11, 21, 0, 0, tzinfo=timezone(timedelta(hours=9)))
        diff = conn.execute(
            "SELECT l.store_id, l.item_id, l.on_hand_end, COALESCE(m.n, 0) AS ledger FROM analytics.daily_stock_levels l "
            "LEFT JOIN (SELECT store_id, item_id, sum(qty)::int AS n FROM stock_movements WHERE kind IN ('receive', 'consume', 'waste', 'adjust') AND occurred_at < %s "
            "GROUP BY 1, 2) m ON m.store_id = l.store_id AND m.item_id = l.item_id "
            "WHERE l.business_date = %s AND l.on_hand_end <> COALESCE(m.n, 0)", (today_start, last),
        ).fetchall()
        assert diff == []  # 全店・全品目で、昨日の締めの残量 = 台帳の合計
        # 期間の初めには、初期在庫（期間の前日に入れたもの）が入っている。台帳の種類は、receive・consume・waste を含む
        kinds = {r["kind"] for r in conn.execute("SELECT DISTINCT kind FROM stock_movements")}
        assert {"receive", "reserve", "consume", "waste", "release"} <= kinds


def test_scale_customers_window_and_status_mix(hist):
    with connect(hist) as conn:
        assert 60 <= conn.execute("SELECT count(*) AS n FROM users WHERE auth_user_id LIKE 'dev:hist-%'").fetchone()["n"] <= 120
        assert conn.execute("SELECT count(*) AS n FROM users WHERE auth_user_id NOT LIKE 'dev:%'").fetchone()["n"] == 0
        span = conn.execute("SELECT min(business_date) AS a, max(business_date) AS b, max(placed_at) AS last FROM orders").fetchone()
        assert span["a"] >= TODAY - timedelta(days=90) and span["b"] == TODAY and span["last"] <= AS_OF  # 過去 90 日。今日は、今の時刻まで
        by_status = {r["status"]: r["n"] for r in conn.execute("SELECT status, count(*)::int AS n FROM orders GROUP BY 1")}
        total = sum(by_status.values())
        assert set(by_status) == {"completed", "cancelled"}  # 進行中の注文は作らない
        assert by_status["completed"] / total > 0.9 and 0 < by_status["cancelled"] / total < 0.1  # completed 中心に、少数の cancelled
        # 注文の内側が整合している: 合計 = 明細の合計、受け取り番号は店 × 営業日で 1 からの連番、決済・確保・ポイントが対応する
        assert conn.execute("SELECT count(*) AS n FROM orders o WHERE subtotal_lumi <> (SELECT sum(line_total_lumi) FROM order_items WHERE order_id = o.id)").fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM (SELECT store_id, business_date, count(*) c, max(pickup_no) m FROM orders GROUP BY 1, 2) x WHERE c <> m").fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM orders o LEFT JOIN payments p ON p.order_id = o.id LEFT JOIN stock_reservations r ON r.order_id = o.id WHERE p.id IS NULL OR r.id IS NULL").fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM store_order_counters c JOIN (SELECT store_id, business_date, count(*) k FROM orders GROUP BY 1, 2) o USING (store_id, business_date) WHERE c.last_no <> o.k").fetchone()["n"] == 0
        points = conn.execute("SELECT (SELECT COALESCE(sum(points), 0) FROM loyalty_ledger) AS ledger, (SELECT sum(loyalty_points) FROM users) AS users").fetchone()
        assert points["ledger"] == points["users"]
        assert conn.execute("SELECT count(*) AS n FROM orders WHERE status = 'completed' AND completed_at IS NULL").fetchone()["n"] == 0


def test_store_size_follows_seats_and_the_signal_tower_store_has_no_orders(hist):
    with connect(hist) as conn:
        rows = conn.execute(
            "SELECT s.code, s.seats, s.mobile_order, count(o.id)::int AS n FROM stores s LEFT JOIN orders o ON o.store_id = s.id AND o.status = 'completed' GROUP BY 1, 2, 3 ORDER BY s.seats DESC"
        ).fetchall()
        mo = [r for r in rows if r["mobile_order"]]
        assert sum(r["n"] for r in mo[:4]) > 2 * sum(r["n"] for r in mo[-4:])  # 席の多い 4 店は、少ない 4 店の 2 倍を超える（規模は席数に比例）
        signal = next(r for r in rows if r["code"] == "residential-signal")
        assert signal["n"] == 0  # MO 不可の店は、注文が入らない（営業日で、売上 0）


def test_two_peaks_morning_and_evening_and_the_signature_blend_leads(hist):
    with connect(hist) as conn:
        by_hour = {r["h"]: r["n"] for r in conn.execute(
            "SELECT hour AS h, sum(orders)::int AS n FROM analytics.daily_store_hourly GROUP BY 1")}
        assert by_hour[8] > 2 * by_hour[14] and by_hour[17] > 2 * by_hour[14]  # 朝と夕方に山、昼下がりが谷
        top = conn.execute("SELECT item_code FROM analytics.daily_store_item_sales GROUP BY item_code ORDER BY sum(sales_lumi) DESC LIMIT 1").fetchone()["item_code"]
        assert top == "oasis-blend"  # 看板（OB）が最も売れる
        drinks = {r["item_code"]: r["n"] for r in conn.execute("SELECT item_code, sum(qty)::int AS n FROM analytics.daily_store_item_sales WHERE category = 'drink' GROUP BY 1")}
        assert drinks["oasis-blend"] == max(drinks.values()) and drinks["oasis-blend"] > 0.2 * sum(drinks.values())
        assert "kikan-limited" not in drinks  # 帰還祭の限定ドリンクは、11/21 までの期間には無い（12/1〜12/25）


def test_item_windows_are_respected(hist):
    with connect(hist) as conn:
        morning = conn.execute(
            "SELECT count(*) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN menu_variants v ON v.id = oi.variant_id JOIN menu_items i ON i.id = v.item_id "
            "WHERE i.code = 'morning-set' AND (o.placed_at AT TIME ZONE 'UTC' + interval '9 hours')::time > '10:30'").fetchone()["n"]
        pie = conn.execute(
            "SELECT count(*) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN menu_variants v ON v.id = oi.variant_id JOIN menu_items i ON i.id = v.item_id "
            "WHERE i.code = 'meat-pie' AND (o.placed_at AT TIME ZONE 'UTC' + interval '9 hours')::time < '11:00'").fetchone()["n"]
        assert morning == 0 and pie == 0
        sold = conn.execute("SELECT count(*) AS n FROM order_items oi JOIN menu_variants v ON v.id = oi.variant_id JOIN menu_items i ON i.id = v.item_id WHERE i.code IN ('morning-set', 'meat-pie')").fetchone()["n"]
        assert sold > 0  # 時間帯のある品も、売れている（空振りのテストにしない）
        # 店の営業時間内（開店〜閉店 − ラストオーダー）に入っている
        outside = conn.execute(
            "SELECT count(*) AS n FROM orders o JOIN stores s ON s.id = o.store_id "
            "WHERE (o.placed_at AT TIME ZONE 'UTC' + interval '9 hours')::time < s.open_time "
            "OR (o.placed_at AT TIME ZONE 'UTC' + interval '9 hours')::time > s.close_time - make_interval(mins => s.last_order_minutes::int)").fetchone()["n"]
        assert outside == 0


def test_closed_days_and_open_days_with_zero_sales_are_kept_apart_in_the_seeded_history(hist):
    with connect(hist) as conn:
        for days_ago, code, _reason in seed_history.TEMPORARY_CLOSURES:
            day = TODAY - timedelta(days=days_ago)
            sid = conn.execute("SELECT id FROM stores WHERE code = %s", (code,)).fetchone()["id"]
            assert conn.execute("SELECT count(*) AS n FROM analytics.daily_store_summary WHERE store_id = %s AND business_date = %s", (sid, day)).fetchone()["n"] == 0  # 休業: 行なし
            p = q.daily_points(conn, store_id=sid, start=day, end=day)[0]
            assert p["state"] == "closed" and p["sales_lumi"] is None
            assert conn.execute("SELECT count(*) AS n FROM orders WHERE store_id = %s AND business_date = %s", (sid, day)).fetchone()["n"] == 0
        signal = conn.execute("SELECT id FROM stores WHERE code = 'residential-signal'").fetchone()["id"]
        pts = [p for p in q.daily_points(conn, store_id=signal, start=TODAY - timedelta(days=28), end=TODAY - timedelta(days=1)) if p["state"] == "open"]
        assert pts and all(p["sales_lumi"] == 0 for p in pts)  # 営業したが売上 0 は、0（NULL ではない）
        assert conn.execute("SELECT count(*) AS n FROM analytics.daily_store_summary WHERE orders = 0 AND cancelled_orders = 0").fetchone()["n"] > 0
        weekly = conn.execute(  # 定休日（水曜のドーム店など）は、行がない
            "SELECT count(*) AS n FROM analytics.daily_store_summary a JOIN stores s ON s.id = a.store_id WHERE s.closed_weekday = EXTRACT(ISODOW FROM a.business_date)::int").fetchone()["n"]
        assert weekly == 0


def test_the_festival_peak_appears_when_the_window_includes_december(tmp_path):
    """帰還祭（12/1〜12/25）: 期間に入れば、来店が増え、限定ドリンクが売れる。限定ドリンクは、期間外には売れない。"""
    url = _seeded("shop_order_hist_fest", today=date(2027, 1, 10), as_of=datetime(2027, 1, 10, 3, 0, tzinfo=timezone.utc))
    with connect(url) as conn:
        days = conn.execute("SELECT business_date, sum(orders)::int AS n FROM analytics.daily_store_summary GROUP BY 1").fetchall()
        inside = [d["n"] for d in days if date(2026, 12, 1) <= d["business_date"] <= date(2026, 12, 25)]
        outside = [d["n"] for d in days if not date(2026, 12, 1) <= d["business_date"] <= date(2026, 12, 25)]
        assert len(inside) == 25 and sum(inside) / len(inside) > 1.25 * sum(outside) / len(outside)  # 山
        limited = [r["business_date"] for r in conn.execute("SELECT DISTINCT business_date FROM analytics.daily_store_item_sales WHERE item_code = 'kikan-limited'")]
        assert limited and all(date(2026, 12, 1) <= d <= date(2026, 12, 25) for d in limited)


def test_history_needs_reset_and_reset_clears_the_analytics_tables(hist):
    with pytest.raises(SystemExit, match="--reset"):
        seed_demo.main(reset=False, url=hist, history=True)
    url = _seeded("shop_order_hist_reset")
    seed_demo.main(reset=True, url=url)  # 履歴なしの --reset は、注文も分析の表も空にする（P1 の挙動のまま）
    with connect(url) as conn:
        for table in ("orders", "order_events", "payments", "users", "store_order_counters"):
            assert conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0, table  # noqa: S608
        for table in ("daily_store_summary", "daily_store_item_sales", "daily_store_hourly", "daily_stock_levels", "daily_stock_waste", "customer_rfm", "customer_pseudonyms", "customer_monthly"):
            assert conn.execute(f"SELECT count(*) AS n FROM analytics.{table}").fetchone()["n"] == 0, table  # noqa: S608
        assert conn.execute("SELECT count(*) AS n FROM store_closures").fetchone()["n"] == 0
        assert inventory.reconcile(conn) == []
    seed_demo.main(reset=True, url=url, history=True, today=TODAY, as_of=AS_OF)  # もう一度、履歴つきで入れ直せる
    with connect(url) as conn:
        assert conn.execute("SELECT count(*) AS n FROM orders").fetchone()["n"] > 1000


def test_the_demo_data_gate_also_guards_the_history():
    env = {k: v for k, v in os.environ.items() if k not in ("DEMO_DATA", "DATABASE_URL")}
    result = subprocess.run([sys.executable, "-m", "app.seed_demo", "--reset", "--history"], env=env, capture_output=True, text=True,
                            cwd=os.path.join(os.path.dirname(__file__), ".."))
    assert result.returncode != 0 and "DEMO_DATA=allow" in (result.stdout + result.stderr)


def test_the_seed_says_dummy_in_its_header_and_output(hist, capsys):
    assert "ダミー" in seed_history.__doc__ and "すべてダミー" in seed_history.__doc__.splitlines()[0]
    seed_demo.main(reset=True, url=hist, history=True, today=TODAY, as_of=AS_OF)
    assert "ダミー" in capsys.readouterr().out
    with connect(hist) as conn:  # 顧客の名前もダミーと分かる
        assert conn.execute("SELECT count(*) AS n FROM users WHERE display_name NOT LIKE 'ダミー顧客 %'").fetchone()["n"] == 0


def test_the_seed_reads_world_values_from_the_database_not_from_a_copy():
    """店・席・営業時間は docs/world.md が正本。履歴の seed は、DB の値（seed_demo が入れたもの）を読むだけで、別に持たない。"""
    source = open(seed_history.__file__, encoding="utf-8").read()
    assert "居住区本店" not in source and "アルカ市" not in source

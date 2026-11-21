"""日次集計と宅配（固定データ）: 手で計算した値と比べる。90 日の履歴（seed_history）は店頭だけなので、宅配の期待値はここで確かめる。

決めてある期待値（2026-11-21。docs/analytics.md に反映する前の、テストが先に持つ約束）:
- 注文数・売上・時間帯別は、店頭と宅配を合算する（fulfillment の列は持つ）。売上は completed の total_lumi（送料込み）。
- 商品別は、品の小計だけ（送料抜き）。日次の売上と商品別の合計の差 = 送料の合計。
- delivery_failed・配達中・支払い済みで未完了の注文は、どの売上にも入らない。取消しは取消し件数だけ（返金は分析に出ない）。
- 日付は、注文を確定した日（business_date）。completed になるのが遅れても、確定した日の売上に入る（再集計の遡りが足りないと入らない）。
送料の 300 ルミは、テストが決めた値（世界観の値ではない）。
"""

from datetime import date, datetime, timedelta, timezone

import psycopg
import pytest

from app import analytics_build, migrate, seed_demo
from tests.conftest import TEST_URL, new_database
from tests.helpers_analytics import add_order, add_user, connect, store_id, variant_id

pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL が未設定です")

TODAY = date(2026, 6, 15)  # 月曜
WED = date(2026, 6, 10)
KEY = b"test-key-for-analytics-0123456789"
NOW = datetime(2026, 6, 15, 3, 0, tzinfo=timezone.utc)
FEE = 300  # テストが決めた送料


def _build(url, *, today=TODAY, **kw):
    with psycopg.connect(url) as conn:
        return analytics_build.build(conn, **{"today": today, "key": KEY, "offset_hours": 9, "now": NOW, **kw})


def _fresh(name: str) -> str:
    url = new_database(name)
    assert migrate.apply(url, out=lambda *_: None) == 0
    seed_demo.main(reset=True, url=url)
    return url


def _prices(conn) -> tuple[int, int]:
    """(オアシスブレンド M ホット, ホットサンド) の価格。期待値は、この価格からの手計算。"""
    ob = conn.execute("SELECT price_lumi FROM menu_variants WHERE id = %s", (variant_id(conn, "oasis-blend", "M", "hot"),)).fetchone()["price_lumi"]
    sandwich = conn.execute("SELECT price_lumi FROM menu_variants WHERE id = %s", (variant_id(conn, "hot-sandwich"),)).fetchone()["price_lumi"]
    return ob, sandwich


@pytest.fixture(scope="module")
def scenario():
    """水曜（居住区本店）の注文。a 店頭 completed（OB ×2）/ b 宅配 completed（OB ×2 + 送料）/ c 宅配 delivery_failed / d 宅配 cancelled（返金済み）/
    e 宅配 paid（配達の前）/ f 店頭 cancelled。売上に入るのは a と b だけ。"""
    url = _fresh("oasis_analytics_dlv")
    with connect(url) as conn:
        main = store_id(conn, "residential-main")
        ob, sandwich = variant_id(conn, "oasis-blend", "M", "hot"), variant_id(conn, "hot-sandwich")
        u1, u2, u3 = add_user(conn, "dlv-a"), add_user(conn, "dlv-b"), add_user(conn, "dlv-c")
        add_order(conn, user=u1, store=main, day=WED, hour=8, lines=[(ob, 2)])  # a
        add_order(conn, user=u2, store=main, day=WED, hour=10, lines=[(ob, 2)], fulfillment="delivery", delivery_fee=FEE)  # b
        add_order(conn, user=u3, store=main, day=WED, hour=11, status="delivery_failed", lines=[(sandwich, 1)], fulfillment="delivery", delivery_fee=FEE)  # c
        d = add_order(conn, user=u1, store=main, day=WED, hour=12, status="cancelled", lines=[(sandwich, 1)], fulfillment="delivery", delivery_fee=FEE)  # d
        order_id = conn.execute("SELECT id FROM orders WHERE public_id = %s", (d,)).fetchone()["id"]
        refunded_amount = conn.execute("SELECT total_lumi FROM orders WHERE id = %s", (order_id,)).fetchone()["total_lumi"]
        conn.execute(
            "INSERT INTO payments (order_id, provider, status, amount_lumi, created_at, updated_at) VALUES (%s, 'mock', 'refunded', %s, now(), now())",
            (order_id, refunded_amount),
        )
        add_order(conn, user=u2, store=main, day=WED, hour=13, status="paid", lines=[(ob, 1)], fulfillment="delivery", delivery_fee=FEE)  # e
        add_order(conn, user=u3, store=main, day=WED, hour=14, status="cancelled", lines=[(sandwich, 1)])  # f
        prices = _prices(conn)
    _build(url, start=date(2026, 6, 8))
    return {"url": url, "main": main, "ob": prices[0], "sandwich": prices[1]}


def test_a_completed_delivery_counts_with_its_fee_in_daily_and_hourly_sales(scenario):
    ob = scenario["ob"]
    with connect(scenario["url"]) as conn:
        s = conn.execute("SELECT * FROM analytics.daily_store_summary WHERE store_id = %s AND business_date = %s", (scenario["main"], WED)).fetchone()
        assert s["orders"] == 2  # a と b。c・d・e・f は数えない
        assert s["cancelled_orders"] == 2  # d（返金済みの宅配）と f（店頭）
        assert s["sales_lumi"] == 2 * ob + (2 * ob + FEE)  # 店頭の a + 送料込みの b
        hourly = {(r["hour"], r["fulfillment"]): (r["orders"], r["sales_lumi"]) for r in conn.execute(
            "SELECT * FROM analytics.daily_store_hourly WHERE store_id = %s AND business_date = %s", (scenario["main"], WED))}
        assert hourly == {(8, "pickup"): (1, 2 * ob), (10, "delivery"): (1, 2 * ob + FEE)}  # 時間帯の売上も送料込み。c（11 時）・d（12 時）・e（13 時）は無い


def test_item_sales_exclude_the_fee_and_the_difference_to_the_daily_sales_is_the_fee(scenario):
    ob = scenario["ob"]
    with connect(scenario["url"]) as conn:
        items = {(r["item_code"], r["fulfillment"]): (r["qty"], r["sales_lumi"]) for r in conn.execute(
            "SELECT * FROM analytics.daily_store_item_sales WHERE store_id = %s AND business_date = %s", (scenario["main"], WED))}
        assert items == {("oasis-blend", "pickup"): (2, 2 * ob), ("oasis-blend", "delivery"): (2, 2 * ob)}  # 送料抜き。失敗・取消し・未完了の品は無い
        daily = conn.execute("SELECT sales_lumi FROM analytics.daily_store_summary WHERE store_id = %s AND business_date = %s", (scenario["main"], WED)).fetchone()["sales_lumi"]
        assert daily - sum(v[1] for v in items.values()) == FEE


def test_failed_cancelled_refunded_and_unfinished_deliveries_are_not_sales(scenario):
    with connect(scenario["url"]) as conn:
        hours = {r["hour"] for r in conn.execute("SELECT hour FROM analytics.daily_store_hourly WHERE store_id = %s AND business_date = %s", (scenario["main"], WED))}
        assert not hours & {11, 12, 13, 14}
        refunded = conn.execute("SELECT count(*) AS n FROM payments WHERE status = 'refunded'").fetchone()["n"]
        assert refunded == 1  # 返金は payments にだけある。分析には出ない（取消しの件数に現れるだけ）
        assert "refund" not in " ".join(r["column_name"] for r in conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics'"))


def test_every_day_matches_the_source_orders_in_both_directions(scenario):
    with connect(scenario["url"]) as conn:
        diff = conn.execute(
            "(SELECT store_id, business_date, count(*)::int, sum(total_lumi)::int FROM orders WHERE status = 'completed' AND business_date < %s GROUP BY 1, 2 "
            " EXCEPT SELECT store_id, business_date, orders, sales_lumi FROM analytics.daily_store_summary WHERE orders > 0) "
            "UNION ALL (SELECT store_id, business_date, orders, sales_lumi FROM analytics.daily_store_summary WHERE orders > 0 "
            " EXCEPT SELECT store_id, business_date, count(*)::int, sum(total_lumi)::int FROM orders WHERE status = 'completed' GROUP BY 1, 2)",
            (TODAY,),
        ).fetchall()
        assert diff == []


# ---- 遅れて completed になる宅配（日付は確定した日） ----

def _raw_sales(conn, store: int, day: date) -> int:
    return conn.execute(
        "SELECT COALESCE(sum(total_lumi), 0)::int AS s FROM orders WHERE status = 'completed' AND store_id = %s AND business_date = %s", (store, day)
    ).fetchone()["s"]


def _built_sales(conn, store: int, day: date) -> int | None:
    row = conn.execute("SELECT sales_lumi FROM analytics.daily_store_summary WHERE store_id = %s AND business_date = %s", (store, day)).fetchone()
    return row["sales_lumi"] if row else None


def _late_completion_world(name: str):
    url = _fresh(name)
    with connect(url) as conn:
        main = store_id(conn, "residential-main")
        ob = variant_id(conn, "oasis-blend", "M", "hot")
        u1, u2 = add_user(conn, f"{name}-a"), add_user(conn, f"{name}-b")
        add_order(conn, user=u1, store=main, day=WED, hour=8, lines=[(ob, 2)])  # 水曜に完了（行ができる日）
        late = add_order(conn, user=u2, store=main, day=WED, hour=18, status="paid", lines=[(ob, 2)], fulfillment="delivery", delivery_fee=FEE)  # 水曜に確定・まだ届いていない
    return url, main, late


def _complete(url: str, public_id: str, day: date) -> None:
    done = (datetime(day.year, day.month, day.day, 12, 0) - timedelta(hours=9)).replace(tzinfo=timezone.utc)
    with connect(url) as conn:
        conn.execute("UPDATE orders SET status = 'completed', completed_at = %s WHERE public_id = %s", (done, public_id))


def test_a_delivery_completed_the_day_after_it_was_placed_is_added_to_the_placed_day_by_the_next_build():
    url, main, late = _late_completion_world("oasis_analytics_dlv_next")
    _build(url, today=date(2026, 6, 11))  # 水曜までを作る。この時点で late は未完了
    with connect(url) as conn:
        before = _built_sales(conn, main, WED)
    _complete(url, late, date(2026, 6, 11))  # 木曜に届く
    _build(url, today=date(2026, 6, 12))  # 次の日の続き（遡り 3 日の中）
    with connect(url) as conn:
        after = _built_sales(conn, main, WED)
        assert after > before and after == _raw_sales(conn, main, WED)  # 確定した日の売上に入る


def test_a_delivery_completed_after_the_lookback_window_still_reaches_the_placed_day():
    """枠は 7 日先まで選べる。毎日続きを作るとき、遡りの日数（LOOKBACK_DAYS）より後に completed になった宅配が、確定した日の売上から落ちないか。"""
    url, main, late = _late_completion_world("oasis_analytics_dlv_late")
    for day in range(11, 16):  # 毎日の続き（6/11〜6/15 に作る。各回は前日までを作る）
        _build(url, today=date(2026, 6, day))
    _complete(url, late, date(2026, 6, 15))  # 水曜の注文が 5 日後に届く
    for day in (16, 17):
        _build(url, today=date(2026, 6, day))
    with connect(url) as conn:
        assert _built_sales(conn, main, WED) == _raw_sales(conn, main, WED)

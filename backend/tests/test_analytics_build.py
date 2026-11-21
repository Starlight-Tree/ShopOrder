"""日次集計の作成（実 DB）: 元データと一致する・休業と売上 0 の区別・当日は作らない・やり直しても同じ・5 人未満の非表示・仮名 ID・台帳からの在庫。
使い捨ての別 DB に、数件の注文を直接入れて、手で計算した値と比べる。"""

from datetime import date, datetime, timedelta, timezone

import psycopg
import pytest

from app import analytics_build, analytics_queries as q, inventory, migrate, seed_demo
from tests.conftest import TEST_URL, new_database
from tests.helpers_analytics import add_order, add_user, connect, store_id, table_rows, variant_id

pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL が未設定です")

TODAY = date(2026, 6, 15)  # 月曜。当日（作らない日）
WED, THU, FRI = date(2026, 6, 10), date(2026, 6, 11), date(2026, 6, 12)
KEY = b"test-key-for-analytics-0123456789"
NOW = datetime(2026, 6, 15, 3, 0, tzinfo=timezone.utc)


def _build(url, **kw):
    with psycopg.connect(url) as conn:
        args = {"today": TODAY, "key": KEY, "offset_hours": 9, "now": NOW, **kw}
        return analytics_build.build(conn, **args)


def _fresh(name: str) -> str:
    url = new_database(name)
    assert migrate.apply(url, out=lambda *_: None) == 0
    seed_demo.main(reset=True, url=url)
    return url


@pytest.fixture(scope="module")
def scenario():
    """6/10（水）: 居住区本店は 2 件 completed（OB M ×2 = 900 と、ホットサンド 520）と 1 件 cancelled。ドーム店は水曜が定休だが 1 件 completed（営業した日）。
    6/11（木）: 本店は営業して注文なし（売上 0）。ドーム店は 1 件。6/12（金）: 本店は臨時休業（行なし）。当日 6/15 にも注文（作らない）。"""
    url = _fresh("oasis_analytics_scn")
    with connect(url) as conn:
        main, dome = store_id(conn, "residential-main"), store_id(conn, "residential-dome")
        ob, latte, sandwich = variant_id(conn, "oasis-blend", "M", "hot"), variant_id(conn, "cafe-latte", "M", "hot"), variant_id(conn, "hot-sandwich")
        u1, u2 = add_user(conn, "scn-a"), add_user(conn, "scn-b")
        add_order(conn, user=u1, store=main, day=WED, hour=8, lines=[(ob, 2)])
        add_order(conn, user=u2, store=main, day=WED, hour=17, minute=40, lines=[(sandwich, 1)])
        add_order(conn, user=u2, store=main, day=WED, hour=9, status="cancelled", lines=[(latte, 1)])
        add_order(conn, user=u1, store=dome, day=WED, hour=8, lines=[(ob, 1)])  # 定休日に開けた
        add_order(conn, user=u1, store=dome, day=THU, hour=12, lines=[(sandwich, 1)])
        conn.execute("INSERT INTO store_closures (store_id, date, reason) VALUES (%s, %s, '砂嵐の警報（テスト）')", (main, FRI))
        add_order(conn, user=u1, store=main, day=TODAY, hour=8, lines=[(ob, 1)])  # 当日
    result = _build(url, start=date(2026, 6, 8))
    return {"url": url, "main": main, "dome": dome, "ob": ob, "result": result}


def test_summary_rows_match_the_source_orders(scenario):
    """集計の数値が、元の注文と一致する（売上 = completed の total_lumi、件数、取消し）。"""
    with connect(scenario["url"]) as conn:
        rows = {(r["store_id"], r["business_date"]): r for r in conn.execute("SELECT * FROM analytics.daily_store_summary")}
        main, dome = scenario["main"], scenario["dome"]
        assert (rows[(main, WED)]["orders"], rows[(main, WED)]["cancelled_orders"], rows[(main, WED)]["sales_lumi"]) == (2, 1, 900 + 520)
        assert (rows[(dome, WED)]["orders"], rows[(dome, WED)]["sales_lumi"]) == (1, 450)
        # どの (店, 日) も、元の注文の合計と一致する（両方向）
        diff = conn.execute(
            "(SELECT store_id, business_date, count(*)::int, sum(total_lumi)::int FROM orders WHERE status = 'completed' AND business_date < %s GROUP BY 1, 2 "
            " EXCEPT SELECT store_id, business_date, orders, sales_lumi FROM analytics.daily_store_summary WHERE orders > 0) "
            "UNION ALL (SELECT store_id, business_date, orders, sales_lumi FROM analytics.daily_store_summary WHERE orders > 0 "
            " EXCEPT SELECT store_id, business_date, count(*)::int, sum(total_lumi)::int FROM orders WHERE status = 'completed' GROUP BY 1, 2)",
            (TODAY,),
        ).fetchall()
        assert diff == []


def test_item_and_hourly_rows_match_the_source(scenario):
    with connect(scenario["url"]) as conn:
        items = {(r["store_id"], r["business_date"], r["item_code"]): (r["qty"], r["sales_lumi"], r["category"]) for r in conn.execute("SELECT * FROM analytics.daily_store_item_sales")}
        assert items[(scenario["main"], WED, "oasis-blend")] == (2, 900, "drink")
        assert items[(scenario["main"], WED, "hot-sandwich")] == (1, 520, "food")
        assert (scenario["main"], WED, "cafe-latte") not in items  # cancelled は売上に入らない
        hourly = {(r["store_id"], r["business_date"], r["hour"]): (r["orders"], r["sales_lumi"]) for r in conn.execute("SELECT * FROM analytics.daily_store_hourly")}
        assert hourly[(scenario["main"], WED, 8)] == (1, 900) and hourly[(scenario["main"], WED, 17)] == (1, 520)  # 店のローカル時刻の時（UTC+9）
        assert (scenario["main"], WED, 9) not in hourly  # 9 時の注文は cancelled
        diff = conn.execute(
            "SELECT store_id, business_date, item_id, sum(line_total_lumi)::int FROM analytics.sales_lines WHERE business_date < %s GROUP BY 1, 2, 3 "
            "EXCEPT SELECT store_id, business_date, item_id, sales_lumi FROM analytics.daily_store_item_sales", (TODAY,)
        ).fetchall()
        assert diff == []


def test_closed_days_have_no_row_and_open_days_with_zero_sales_have_a_zero_row(scenario):
    with connect(scenario["url"]) as conn:
        main, dome = scenario["main"], scenario["dome"]
        have = {(r["store_id"], r["business_date"]): r["sales_lumi"] for r in conn.execute("SELECT store_id, business_date, sales_lumi FROM analytics.daily_store_summary")}
        assert have[(main, THU)] == 0  # 営業したが売上 0: 行がある
        assert (main, FRI) not in have  # 臨時休業: 行がない
        assert have[(dome, WED)] == 450  # 定休日でも、注文があれば営業日
        assert (dome, date(2026, 6, 17)) not in have  # 定休日（注文なし）で、まだ作る範囲の外
        points = {p["date"]: p for p in q.daily_points(conn, store_id=main, start=WED, end=FRI)}
        assert (points[THU]["state"], points[THU]["sales_lumi"]) == ("open", 0)
        assert (points[FRI]["state"], points[FRI]["sales_lumi"]) == ("closed", None)  # 休業は NULL。0 ではない
        reasons = {(r["store_id"], r["business_date"]): (r["is_open"], r["closed_reason"]) for r in conn.execute("SELECT * FROM analytics.store_days('2026-06-10', '2026-06-17')")}
        assert reasons[(main, FRI)] == (False, "temporary_closure") and reasons[(dome, date(2026, 6, 17))] == (False, "weekly_closed")
        assert reasons[(dome, WED)] == (True, None) and reasons[(main, THU)] == (True, None)


def test_the_current_day_is_not_built(scenario):
    with connect(scenario["url"]) as conn:
        assert conn.execute("SELECT max(business_date) AS d FROM analytics.daily_store_summary").fetchone()["d"] == TODAY - timedelta(days=1)
        assert conn.execute("SELECT count(*) AS n FROM analytics.daily_store_summary WHERE business_date >= %s", (TODAY,)).fetchone()["n"] == 0
        live = q.overview(conn, store_id=scenario["main"], today=TODAY)  # 当日は元データから都度
        assert (live["orders"], live["sales_lumi"]) == (1, 450)
        assert scenario["result"]["end"] == TODAY - timedelta(days=1)


def test_rebuilding_gives_the_same_rows_and_picks_up_changed_orders():
    url = _fresh("oasis_analytics_idem")
    with connect(url) as conn:
        main = store_id(conn, "residential-main")
        ob = variant_id(conn, "oasis-blend", "M", "hot")
        user = add_user(conn, "idem-a")
        first = add_order(conn, user=user, store=main, day=WED, lines=[(ob, 2)])
        add_order(conn, user=user, store=main, day=THU, lines=[(ob, 1)])
    _build(url, start=date(2026, 6, 8))
    with connect(url) as conn:
        before = {t: table_rows(conn, t, "*") for t in ("daily_store_summary", "daily_store_item_sales", "daily_store_hourly", "daily_stock_levels", "customer_rfm")}
    def strip(rows):  # built_at（最後の列のことが多い）を除いて比べる
        return [r[:-1] for r in rows]
    _build(url, start=date(2026, 6, 8), now=NOW + timedelta(hours=1))  # 同じ範囲をもう一度
    with connect(url) as conn:
        after = {t: table_rows(conn, t, "*") for t in before}
        assert {t: strip(v) for t, v in before.items() if t != "customer_rfm"} == {t: strip(v) for t, v in after.items() if t != "customer_rfm"}
        assert before["customer_rfm"] and len(before["customer_rfm"]) == len(after["customer_rfm"])
        # 元の注文が変わったら、作り直した範囲に反映される（取消しにすると、その日の売上と品目の行が消える）
        conn.execute("UPDATE orders SET status = 'cancelled', cancelled_at = placed_at, cancel_reason = 'customer_request' WHERE public_id = %s", (first,))
    _build(url, start=date(2026, 6, 8))
    with connect(url) as conn:
        row = conn.execute("SELECT orders, cancelled_orders, sales_lumi FROM analytics.daily_store_summary WHERE business_date = %s", (WED,)).fetchone()
        assert (row["orders"], row["cancelled_orders"], row["sales_lumi"]) == (0, 1, 0)
        assert conn.execute("SELECT count(*) AS n FROM analytics.daily_store_item_sales WHERE business_date = %s", (WED,)).fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM analytics.daily_store_hourly WHERE business_date = %s", (WED,)).fetchone()["n"] == 0


def test_default_range_continues_from_the_last_built_day_with_the_lookback():
    url = _fresh("oasis_analytics_cont")
    with connect(url) as conn:
        main = store_id(conn, "residential-main")
        ob = variant_id(conn, "oasis-blend", "M", "hot")
        user = add_user(conn, "cont-a")
        for d in (date(2026, 5, 1), date(2026, 6, 5), date(2026, 6, 10)):  # 最初の注文は、遡りの外
            add_order(conn, user=user, store=main, day=d, lines=[(ob, 1)])
    first = _build(url, today=date(2026, 6, 12))  # 続きの既定: 最初の注文の日から
    assert (first["start"], first["end"]) == (date(2026, 5, 1), date(2026, 6, 11))
    second = _build(url, today=date(2026, 6, 15))  # 前回の最終日（6/11）から遡りの日数ぶん手前から、昨日まで
    assert (second["start"], second["end"]) == (date(2026, 6, 11) - timedelta(days=analytics_build.LOOKBACK_DAYS - 1), date(2026, 6, 14))
    with connect(url) as conn:
        assert conn.execute("SELECT max(business_date) AS d FROM analytics.daily_store_summary").fetchone()["d"] == date(2026, 6, 14)


# ---- 顧客（仮名 ID・5 人未満の非表示） ----

def _customers_db(name: str, n_june: int, n_may: int):
    url = _fresh(name)
    with connect(url) as conn:
        main = store_id(conn, "residential-main")
        ob = variant_id(conn, "oasis-blend", "M", "hot")
        for i in range(n_may):  # 5 月に初めて来て、6 月にも来た
            u = add_user(conn, f"{name}-may-{i}")
            add_order(conn, user=u, store=main, day=date(2026, 5, 20), lines=[(ob, 1)])
            add_order(conn, user=u, store=main, day=date(2026, 6, 13), lines=[(ob, 1)])
        for i in range(n_june):  # 6 月に初めて来た
            u = add_user(conn, f"{name}-jun-{i}")
            add_order(conn, user=u, store=main, day=date(2026, 6, 13), lines=[(ob, 1)])
    _build(url, start=date(2026, 5, 1))
    return url


def test_segments_under_five_people_are_not_shown_and_the_total_is_withheld():
    url = _customers_db("oasis_analytics_c4", n_june=4, n_may=0)
    with connect(url) as conn:
        result = q.customers(conn, today=TODAY)
    light = next(s for s in result["segments"] if s["segment"] == "light")
    assert light["customers"] is None and light["suppressed"] is True  # 4 人は出さない
    assert result["total_customers"] is None  # 隠したセルがあれば合計も出さない（引き算で戻せるため）
    assert result["repurchase_rate_pct"] is None and result["avg_spend_lumi"] is None  # 5 人未満では、平均も出さない
    june = next(r for r in result["cohorts"]["rows"] if r["cohort"] == "2026-06-01")
    assert june["suppressed"] is True and june["size"] is None and all(c["customers"] is None for c in june["cells"])


def test_segments_with_five_or_more_people_are_shown_with_cohorts_and_the_repurchase_rate():
    url = _customers_db("oasis_analytics_c6", n_june=6, n_may=6)
    with connect(url) as conn:
        result = q.customers(conn, today=TODAY)
    segs = {s["segment"]: s["customers"] for s in result["segments"]}
    assert segs["light"] == 12 and result["total_customers"] == 12  # 12 人とも、2 回以下の注文で、直近 14 日に来た
    assert result["repurchase_rate_pct"] == 50.0  # 再購入（2 回以上）は 6 人、1 回は 6 人。どちらも 5 人以上なので出る
    rows = {r["cohort"]: r for r in result["cohorts"]["rows"]}
    may, june = rows["2026-05-01"], rows["2026-06-01"]
    assert may["size"] == 6 and june["size"] == 6
    assert [(c["offset"], c["customers"], c["rate_pct"]) for c in may["cells"]] == [(0, 6, 100.0), (1, 6, 100.0)]  # 5 月に来た人が 6 月にも
    assert june["cells"][0]["in_progress"] is True and may["cells"][1]["in_progress"] is True  # 当月は途中
    assert may["includes_existing"] is True  # データの最初の月は、それ以前から来ていた人を含みうる


def test_the_repurchase_rate_is_shown_only_when_both_sides_have_five_people():
    url = _customers_db("oasis_analytics_rr", n_june=5, n_may=5)  # 5 月組は 2 回（再購入）、6 月組は 1 回
    with connect(url) as conn:
        result = q.customers(conn, today=TODAY)
    assert result["repurchase_rate_pct"] == 50.0 and result["total_customers"] == 10
    assert result["avg_orders"] == 1.5 and result["avg_spend_lumi"] == 675  # OB M = 450 ルミ。1.5 回 × 450


def test_pseudonyms_are_keyed_hmacs_and_the_analytics_tables_hold_no_personal_columns():
    url = _customers_db("oasis_analytics_pii", n_june=6, n_may=0)
    with connect(url) as conn:
        users = {r["id"]: r["display_name"] for r in conn.execute("SELECT id, display_name FROM users WHERE auth_user_id LIKE 'dev:oasis_analytics_pii%'")}
        mapping = {r["user_id"]: r["pseudonym_id"] for r in conn.execute("SELECT user_id, pseudonym_id FROM analytics.customer_pseudonyms")}
        assert set(mapping) == set(users) and all(mapping[u] == analytics_build.pseudonym_id(KEY, u) for u in users)
        rfm = {r["pseudonym_id"] for r in conn.execute("SELECT pseudonym_id FROM analytics.customer_rfm")}
        assert rfm == set(mapping.values())  # RFM の表は、仮名 ID だけ
        columns = conn.execute("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'analytics'").fetchall()
        names = {c["column_name"] for c in columns}
        assert not names & {"display_name", "email", "address", "phone", "auth_user_id", "password_hash", "note", "line"}
        assert {c["table_name"] for c in columns if c["column_name"] == "user_id"} == {"customer_pseudonyms"}  # 対応を持つのは 1 つの表だけ
        dumped = " ".join(str(r) for t in ("customer_rfm", "customer_monthly", "daily_store_summary") for r in table_rows(conn, t, "*"))
        assert not any(name in dumped for name in users.values())


def test_a_changed_key_stops_the_build_until_rekey():
    url = _customers_db("oasis_analytics_key", n_june=6, n_may=0)
    with connect(url) as conn:
        before = {r["pseudonym_id"] for r in conn.execute("SELECT pseudonym_id FROM analytics.customer_pseudonyms")}
    with pytest.raises(analytics_build.KeyChanged):
        _build(url, key=b"another-key-for-analytics-9876543210", start=date(2026, 6, 1))
    with connect(url) as conn:  # 止まったときは、何も変えない
        assert {r["pseudonym_id"] for r in conn.execute("SELECT pseudonym_id FROM analytics.customer_pseudonyms")} == before
    _build(url, key=b"another-key-for-analytics-9876543210", start=date(2026, 6, 1), rekey=True)
    with connect(url) as conn:
        after = {r["pseudonym_id"] for r in conn.execute("SELECT pseudonym_id FROM analytics.customer_pseudonyms")}
        assert len(after) == len(before) and not after & before  # 全員の仮名 ID が変わり、古い対応は残らない
        assert {r["pseudonym_id"] for r in conn.execute("SELECT pseudonym_id FROM analytics.customer_rfm")} == after


# ---- 在庫（台帳から） ----

def test_stock_levels_are_rebuilt_from_the_ledger_with_reasons():
    url = _fresh("oasis_analytics_stock")
    D = date(2026, 6, 8)
    def at(day, hour=12):  # 店のローカル時刻 → UTC
        return datetime(day.year, day.month, day.day, hour, 0, tzinfo=timezone(timedelta(hours=9))).astimezone(timezone.utc)
    with connect(url) as conn:
        main, dome = store_id(conn, "residential-main"), store_id(conn, "residential-dome")
        beans = conn.execute("SELECT id FROM stock_items WHERE code = 'coffee-beans'").fetchone()["id"]
        milk = conn.execute("SELECT id FROM stock_items WHERE code = 'milk'").fetchone()["id"]
        with conn.transaction():
            inventory.receive(conn, main, beans, 1000, reason=None, actor="test", now=at(D, 6))  # 6/8 入荷 +1000
            inventory.reserve(conn, main, {beans: 36}, ref_type="order", ref_id="T1", actor="test", now=at(D + timedelta(days=1)))
            inventory.consume(conn, main, {beans: 36}, ref_type="order", ref_id="T1", actor="test", now=at(D + timedelta(days=1)))  # 6/9 消費 36
            inventory.waste(conn, main, beans, 50, reason="賞味期限切れ", actor="test", now=at(D + timedelta(days=2)))  # 6/10 廃棄 50（期限切れ）
            inventory.waste(conn, main, beans, 10, reason="落として破損", actor="test", now=at(D + timedelta(days=2), 20))
            inventory.adjust(conn, main, beans, -7, reason="棚卸し", actor="test", now=at(D + timedelta(days=2), 22))  # 6/10 調整 -7
            inventory.receive(conn, dome, milk, 500, reason=None, actor="test", now=at(D, 6))
        user = add_user(conn, "stock-a")
        for d in (D, D + timedelta(days=1), D + timedelta(days=2)):  # 営業日にする（注文がある日）
            add_order(conn, user=user, store=main, day=d, lines=[(variant_id(conn, "oasis-blend", "M", "hot"), 1)])
    _build(url, start=D)
    with connect(url) as conn:
        levels = {(r["business_date"], r["item_code"]): r for r in conn.execute("SELECT * FROM analytics.daily_stock_levels WHERE store_id = %s", (main,))}
        d8, d9, d10 = levels[(D, "coffee-beans")], levels[(D + timedelta(days=1), "coffee-beans")], levels[(D + timedelta(days=2), "coffee-beans")]
        assert (d8["on_hand_end"], d8["received"]) == (1000, 1000)
        assert (d9["on_hand_end"], d9["consumed"]) == (1000 - 36, 36)
        assert (d10["on_hand_end"], d10["wasted"], d10["adjusted"]) == (1000 - 36 - 60 - 7, 60, -7)  # 締めの残量 = 台帳の合計
        waste = {(r["business_date"], r["reason_code"]): r["qty"] for r in conn.execute("SELECT * FROM analytics.daily_stock_waste WHERE store_id = %s", (main,))}
        assert waste == {(D + timedelta(days=2), "expired"): 50, (D + timedelta(days=2), "damaged"): 10}  # 自由記述は、固定の区分に写る
        # 台帳から再計算した残量が、ある日の締めと、台帳の合計（そこまで）に一致する
        ledger = conn.execute(
            "SELECT COALESCE(sum(qty) FILTER (WHERE kind IN ('receive', 'consume', 'waste', 'adjust')), 0)::int AS n FROM stock_movements "
            "WHERE store_id = %s AND item_id = (SELECT id FROM stock_items WHERE code = 'coffee-beans') AND occurred_at < %s", (main, at(D + timedelta(days=3), 0))
        ).fetchone()["n"]
        assert ledger == d10["on_hand_end"]
        # 営業日の行は、在庫の品目の数（14）だけある（動きのない品目も、残量の行を持つ）
        assert conn.execute("SELECT count(*) AS n FROM analytics.daily_stock_levels WHERE store_id = %s AND business_date = %s", (dome, D)).fetchone()["n"] == 14


def test_the_rfm_grid_hides_a_small_cell_and_the_smallest_remaining_one_and_keeps_empty_cells_at_zero():
    """R×F の格子: 6 人のセル（直近・F=1）、4 人のセル（45 日前・F=1）、人のいないセル。4 人のセルは隠れ、残りで最小の 6 人のセルも隠れる（補完の秘匿）。
    人のいないセルは 0 のまま。隠したセルがあるので、合計も出さない。区分（segments）も同じ集計から作るので、同じ人数が隠れる。"""
    url = _fresh("oasis_analytics_grid")
    with connect(url) as conn:
        main, ob = store_id(conn, "residential-main"), variant_id(conn, "oasis-blend", "M", "hot")
        for i in range(6):
            add_order(conn, user=add_user(conn, f"grid-recent-{i}"), store=main, day=WED, lines=[(ob, 1)])  # 最後の注文から 5 日: R=3、1 回: F=1
        for i in range(4):
            add_order(conn, user=add_user(conn, f"grid-lapsed-{i}"), store=main, day=date(2026, 5, 1), lines=[(ob, 1)])  # 45 日前: R=1、F=1
    _build(url)
    with connect(url) as conn:
        got = q.customers(conn, today=TODAY)
    grid = {(g["r"], g["f"]): g["customers"] for g in got["grid"]}
    assert grid[(1, 1)] is None and grid[(3, 1)] is None  # 4 人は隠れ、残りで最小の 6 人も隠れる
    assert all(n == 0 for cell, n in grid.items() if cell not in {(1, 1), (3, 1)})  # 人のいないセルは 0
    assert got["total_customers"] is None
    segments = {s["segment"]: s["customers"] for s in got["segments"]}
    assert segments["dormant"] is None and segments["light"] is None and segments["loyal"] == 0 and segments["regular"] == 0 and segments["at_risk"] == 0

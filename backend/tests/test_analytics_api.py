"""分析 API（/api/analytics）: 権限（店舗スタッフは他店が見えない・顧客と配達員は不可・顧客の分析は全店の店長だけ）・集計が元データと一致する・休業と売上 0 の区別・
前期比の「比較不可」・ABC・曜日 × 時間帯・在庫の残日数と廃棄・当日の概況・応答に個人情報が無い。
専用の使い捨て DB（oasis_analytics_api）に、過去の営業日の注文を直接入れて確かめる（共有の oasis_test を汚さない。アプリの接続プールを、このモジュールの間だけ付け替える）。"""

import os
from datetime import date, datetime, timedelta, timezone

import pytest

from app import analytics_build, auth, clock, db, inventory, migrate, seed_demo
from tests.conftest import TEST_URL, at_local, new_database
from tests.helpers import code_of
from tests.helpers_analytics import add_order, add_user, connect, store_id, variant_id

pytestmark = pytest.mark.skipif(not TEST_URL, reason="TEST_DATABASE_URL が未設定です")

TODAY = date(2026, 6, 15)  # 月曜
KEY = b"api-test-key-for-analytics-0123456789"
ENDPOINTS = ("overview", "sales", "products", "hourly", "stock", "customers")
USERS = [f"api-user-{i}" for i in range(6)]


def _local(day: date, hour: int = 12) -> datetime:
    return datetime(day.year, day.month, day.day, hour, 0, tzinfo=timezone(timedelta(hours=9))).astimezone(timezone.utc)


class Api:
    """専用 DB に向けた、API の呼び出しの道具（tests/helpers.py の Shop と同じ使い方の、必要な部分だけ）。"""

    def __init__(self, client, url: str):
        self.client, self.url = client, url
        self._tokens: dict[str, dict] = {}

    def login(self, email: str, password: str):
        return self.client.post("/api/staff/login", json={"email": email, "password": password})

    def staff(self, store_code: str | None = None) -> dict:
        """デモのスタッフ（store_code が None なら全店の店長）の Bearer ヘッダー。"""
        email = "manager@oasis-cafe.example" if store_code is None else f"staff-{store_code}@oasis-cafe.example"
        if email not in self._tokens:
            r = self.login(email, "test-staff-pass")
            assert r.status_code == 200, r.text
            self._tokens[email] = {"Authorization": f"Bearer {r.json()['token']}"}
        return self._tokens[email]

    def make_staff(self, role: str, store_code: str | None) -> dict:
        """テスト専用のスタッフを作り、ログインした Bearer ヘッダーを返す。"""
        email = f"test-{role}-{store_code}-{len(self._tokens)}@oasis-cafe.example"  # デモのスタッフ（courier-…・staff-…）と重ならない名前
        with connect(self.url) as conn:
            conn.execute(
                "INSERT INTO staff_accounts (store_id, role, name, email, password_hash) VALUES (%s, %s, 'テスト用', %s, %s)",
                (store_id(conn, store_code) if store_code else None, role, email, auth.hash_password("pw-for-tests-1")),
            )
        r = self.login(email, "pw-for-tests-1")
        assert r.status_code == 200, r.text
        self._tokens[email] = {"Authorization": f"Bearer {r.json()['token']}"}
        return self._tokens[email]


@pytest.fixture(scope="module")
def api(client):
    url = new_database("oasis_analytics_api")
    assert migrate.apply(url, out=lambda *_: None) == 0
    seed_demo.main(reset=True, url=url)
    saved = os.environ["DATABASE_URL"]
    db.close_pool()
    os.environ["DATABASE_URL"] = url  # アプリの接続先を、このモジュールの間だけ専用 DB にする
    db.open_pool()
    try:
        yield Api(client, url)
    finally:
        db.close_pool()
        os.environ["DATABASE_URL"] = saved
        db.open_pool()


@pytest.fixture(scope="module")
def data(api):
    """居住区本店: 5/18〜6/14 に毎日、朝 8 時に OB（450）1 件。6/1〜6/14 に、夕方 17 時のラテ（500）5 件と、昼 12 時のホットサンド（520）2 件。6/12 は臨時休業。
    岩山広場店（木曜定休）: 5/18〜5/31 は毎日の営業日に OB（450）、6/1〜6/14 はラテ（500）。6/9（火）は営業日だが注文なし（売上 0）。
    在庫（本店・コーヒー豆）: 5/20 に入荷、6/1〜6/14 に毎日 36 g 消費。牛乳は 6/10 に期限切れで 300 廃棄。"""
    url = api.url
    with connect(url) as conn:
        main, plaza, lookout = store_id(conn, "residential-main"), store_id(conn, "rock-plaza"), store_id(conn, "rock-lookout")
        ob, latte, sandwich = variant_id(conn, "oasis-blend", "M", "hot"), variant_id(conn, "cafe-latte", "M", "hot"), variant_id(conn, "hot-sandwich")
        users = [add_user(conn, name) for name in USERS]
        conn.execute("INSERT INTO store_closures (store_id, date, reason) VALUES (%s, %s, '砂嵐の警報（テスト）') ON CONFLICT DO NOTHING", (main, date(2026, 6, 12)))
        conn.execute("INSERT INTO store_closures (store_id, date, reason) VALUES (%s, %s, '砂嵐の警報（テスト）') ON CONFLICT DO NOTHING", (lookout, TODAY))
        day = date(2026, 5, 18)
        n = 0
        while day < TODAY:
            n += 1
            if day != date(2026, 6, 12):
                add_order(conn, user=users[n % 6], store=main, day=day, hour=8, lines=[(ob, 1)])
            if day.isoweekday() != 4 and day != date(2026, 6, 9):  # 岩山広場店は木曜が定休。6/9 は営業日だが注文なし
                add_order(conn, user=users[(n + 1) % 6], store=plaza, day=day, hour=9, lines=[(ob, 1)] if day < date(2026, 6, 1) else [(latte, 1)])
            day += timedelta(days=1)
        for i in range(5):
            add_order(conn, user=users[i], store=main, day=date(2026, 6, 1 + i), hour=17, lines=[(latte, 1)])
        for i in range(2):
            add_order(conn, user=users[i], store=main, day=date(2026, 6, 6 + i), hour=12, lines=[(sandwich, 1)])
        beans = conn.execute("SELECT id FROM stock_items WHERE code = 'coffee-beans'").fetchone()["id"]
        milk = conn.execute("SELECT id FROM stock_items WHERE code = 'milk'").fetchone()["id"]
        with conn.transaction():
            inventory.receive(conn, main, beans, 5000, reason="テスト", actor="test", now=_local(date(2026, 5, 20), 6))
            for i in range(14):
                d = date(2026, 6, 1) + timedelta(days=i)
                if d == date(2026, 6, 12):
                    continue  # 休業日は消費なし
                inventory.reserve(conn, main, {beans: 36}, ref_type="order", ref_id=f"API{i}", actor="test", now=_local(d, 8))
                inventory.consume(conn, main, {beans: 36}, ref_type="order", ref_id=f"API{i}", actor="test", now=_local(d, 8))
            inventory.waste(conn, main, milk, 300, reason="賞味期限切れ", actor="test", now=_local(date(2026, 6, 10), 20))
    with conn_for_build(url) as bc:
        analytics_build.build(bc, today=TODAY, key=KEY, offset_hours=9, now=_local(TODAY, 3), start=date(2026, 5, 18))
    return {"main": main, "plaza": plaza, "lookout": lookout}


def conn_for_build(url):
    import psycopg

    return psycopg.connect(url)


@pytest.fixture(autouse=True)
def _frozen():
    clock.freeze(at_local(2026, 6, 15, 12))  # 6/15（月）12:00。昨日 6/14 までが確定
    yield


def _get(api, path, who=None, **kw):
    return api.client.get(path, headers=who if who is not None else api.staff(None), **kw)


def _login(api, role, store_code):
    return api.make_staff(role, store_code)


# ---- 権限 ----

@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_without_a_staff_token_and_for_customers_it_is_401(api, data, endpoint):
    assert api.client.get(f"/api/analytics/{endpoint}").status_code == 401
    r = api.client.get(f"/api/analytics/{endpoint}", headers={"X-Dev-User": "some-customer"})  # 顧客（X-Dev-User）はスタッフのトークンを持たない
    assert r.status_code == 401 and code_of(r) == "unauthorized"
    r = api.client.get(f"/api/analytics/{endpoint}", headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_couriers_are_forbidden(api, data, endpoint):
    r = api.client.get(f"/api/analytics/{endpoint}", headers=_login(api, "courier", "residential-main"))
    assert r.status_code == 403 and code_of(r) == "forbidden"


def test_store_staff_cannot_see_other_stores(api, data):
    staff = api.staff("residential-main")
    for endpoint in ("overview", "sales", "products", "hourly", "stock"):
        r = _get(api, f"/api/analytics/{endpoint}?store_id={data['plaza']}", staff)
        assert r.status_code == 404 and code_of(r) == "not_found", endpoint  # 他店は、存在を教えない
        own = _get(api, f"/api/analytics/{endpoint}?store_id={data['main']}", staff)
        assert own.status_code == 200, endpoint
        assert own.json()["scope"] == {"all_stores": False, "store_id": data["main"], "store_name": "居住区本店"}
        default = _get(api, f"/api/analytics/{endpoint}", staff)  # store_id を付けなくても、自店だけ
        assert default.json()["scope"]["store_id"] == data["main"]


def test_store_staff_numbers_are_only_their_store_and_customer_analytics_is_forbidden(api, data):
    staff = api.staff("rock-plaza")
    sales = _get(api, "/api/analytics/sales?grain=day&count=14", staff).json()
    plaza = _get(api, f"/api/analytics/sales?grain=day&count=14&store_id={data['plaza']}").json()  # 店長が同じ店を指す
    assert sales["points"] == plaza["points"] and sales["total"]["sales_lumi"] == 6000 - 500 * 1  # 6/1〜6/14 の営業日 12 日のうち、6/9 は注文なし → 11 日 × 500
    r = _get(api, "/api/analytics/customers", staff)
    assert r.status_code == 403 and code_of(r) == "forbidden"


def test_a_manager_tied_to_a_store_is_limited_to_it_and_cannot_see_customers(api, data):
    tied = _login(api, "manager", "rock-plaza")
    assert _get(api, "/api/analytics/overview", tied).json()["scope"]["store_id"] == data["plaza"]
    assert _get(api, f"/api/analytics/overview?store_id={data['main']}", tied).status_code == 404
    assert _get(api, "/api/analytics/customers", tied).status_code == 403


def test_the_all_store_manager_can_see_every_store_and_filter_by_one(api, data):
    chain = _get(api, "/api/analytics/sales?grain=day&count=14").json()
    main = _get(api, f"/api/analytics/sales?grain=day&count=14&store_id={data['main']}").json()
    plaza = _get(api, f"/api/analytics/sales?grain=day&count=14&store_id={data['plaza']}").json()
    assert chain["scope"]["all_stores"] is True and main["scope"]["store_name"] == "居住区本店"
    assert chain["total"]["sales_lumi"] >= main["total"]["sales_lumi"] + plaza["total"]["sales_lumi"]
    assert _get(api, "/api/analytics/overview?store_id=999999").status_code == 404
    assert code_of(_get(api, "/api/analytics/overview?store_id=999999")) == "store_not_found"


def test_input_errors_are_422(api, data):
    assert _get(api, "/api/analytics/sales?grain=year").status_code == 422
    assert _get(api, "/api/analytics/products?days=3").status_code == 422
    assert _get(api, "/api/analytics/hourly?days=400").status_code == 422
    assert _get(api, "/api/analytics/stock?store_id=0").status_code == 422


# ---- 売上の推移 ----

def test_sales_match_the_source_and_closed_days_are_null_while_zero_days_are_zero(api, data):
    body = _get(api, f"/api/analytics/sales?grain=day&count=14&store_id={data['main']}").json()
    points = {p["start"]: p for p in body["points"]}
    assert body["from"] == "2026-06-01" and body["to"] == "2026-06-14" and len(points) == 14
    assert points["2026-06-12"] == {"start": "2026-06-12", "sales_lumi": None, "orders": None, "open_days": 0, "state": "closed"}  # 休業: null
    # 6/1〜6/5 は OB 450 + ラテ 500。6/6・6/7 は OB 450 + ホットサンド 520
    assert points["2026-06-01"]["sales_lumi"] == 950 and points["2026-06-06"]["sales_lumi"] == 970 and points["2026-06-10"]["sales_lumi"] == 450
    with connect(api.url) as conn:
        source = conn.execute("SELECT COALESCE(sum(total_lumi), 0)::int AS n FROM orders WHERE store_id = %s AND status = 'completed' AND business_date BETWEEN '2026-06-01' AND '2026-06-14'", (data["main"],)).fetchone()["n"]
    assert body["total"]["sales_lumi"] == source == sum(p["sales_lumi"] or 0 for p in body["points"])
    plaza = {p["start"]: p for p in _get(api, f"/api/analytics/sales?grain=day&count=14&store_id={data['plaza']}").json()["points"]}
    assert (plaza["2026-06-09"]["state"], plaza["2026-06-09"]["sales_lumi"], plaza["2026-06-09"]["orders"]) == ("open", 0, 0)  # 営業したが売上 0
    assert (plaza["2026-06-11"]["state"], plaza["2026-06-11"]["sales_lumi"]) == ("closed", None)  # 木曜は定休日


def test_week_and_month_buckets(api, data):
    week = _get(api, f"/api/analytics/sales?grain=week&count=2&store_id={data['plaza']}").json()
    assert week["from"] == "2026-06-01" and week["to"] == "2026-06-14" and [p["start"] for p in week["points"]] == ["2026-06-01", "2026-06-08"]
    assert [p["sales_lumi"] for p in week["points"]] == [6 * 500, 5 * 500]  # 1 週目: 木曜を除く 6 日。2 週目: 木曜と 6/9 を除く 5 日
    assert [p["open_days"] for p in week["points"]] == [6, 6]  # 営業日の数（6/9 は営業日で売上 0）
    month = _get(api, f"/api/analytics/sales?grain=month&count=1&store_id={data['plaza']}").json()
    assert month["from"] == "2026-05-01" and month["to"] == "2026-05-31"
    assert month["points"][0]["state"] == "not_built"  # 5/1〜5/17 は集計していない月は、値を出さない（0 にしない）
    assert month["points"][0]["sales_lumi"] is None


def test_comparison_is_made_only_when_it_is_fair(api, data):
    ok = _get(api, f"/api/analytics/sales?grain=day&count=14&store_id={data['plaza']}").json()
    assert ok["previous"] == {"from": "2026-05-18", "to": "2026-05-31"}
    assert ok["comparison"] == {"state": "ok", "previous_sales_lumi": 12 * 450, "change_pct": round((5500 - 5400) / 5400 * 100, 1), "reason": None, "message": None}
    mismatch = _get(api, f"/api/analytics/sales?grain=day&count=10&store_id={data['plaza']}").json()["comparison"]
    assert mismatch["state"] == "not_comparable" and mismatch["reason"] == "weekday_mismatch" and mismatch["message"]  # 10 日は曜日の構成が前の期間と違う
    closure = _get(api, f"/api/analytics/sales?grain=day&count=14&store_id={data['main']}").json()["comparison"]
    assert closure["state"] == "not_comparable" and closure["reason"] == "open_days_mismatch"  # 臨時休業で営業日が 1 日少ない
    early = _get(api, f"/api/analytics/sales?grain=day&count=28&store_id={data['plaza']}").json()["comparison"]
    assert early["state"] == "not_comparable" and early["reason"] == "previous_missing"  # 前の 28 日は、まだ集計していない
    assert _get(api, f"/api/analytics/sales?grain=month&count=1&store_id={data['plaza']}").json()["comparison"]["state"] == "not_comparable"


# ---- 商品別・曜日 × 時間帯 ----

def test_products_abc_totals_and_the_crossing_item(api, data):
    body = _get(api, f"/api/analytics/products?days=28&store_id={data['main']}").json()
    by_code = {i["code"]: i for i in body["items"]}
    # OB 27 日 × 450（6/12 は休業）= 12,150、ラテ 5 × 500 = 2,500、ホットサンド 2 × 520 = 1,040。合計 15,690
    assert (by_code["oasis-blend"]["qty"], by_code["oasis-blend"]["sales_lumi"]) == (27, 12150)
    assert body["totals"] == {"sales_lumi": 15690, "qty": 34, "cups": 32}
    assert [(i["code"], i["abc"]) for i in body["items"]] == [("oasis-blend", "A"), ("cafe-latte", "A"), ("hot-sandwich", "B")]  # 80% をまたぐ品は A
    assert [i["share_pct"] for i in body["items"]] == [77.4, 15.9, 6.6] and body["items"][-1]["cum_share_pct"] == 100.0


def test_hourly_matrix_counts_orders_by_weekday_and_local_hour(api, data):
    body = _get(api, f"/api/analytics/hourly?days=28&store_id={data['main']}").json()
    cells = {(c["weekday"], c["hour"]): c["orders"] for c in body["cells"]}
    assert body["hours"] == list(range(8, 18))  # 8 時〜17 時（間の時間も含む。表の列になる）
    assert sum(c for (w, h), c in cells.items() if h == 8) == 27 and sum(c for (w, h), c in cells.items() if h == 17) == 5 and sum(c for (w, h), c in cells.items() if h == 12) == 2
    assert body["max_orders"] == max(cells.values())
    assert {d["weekday"]: d["store_days"] for d in body["store_days"]} == {1: 4, 2: 4, 3: 4, 4: 4, 5: 3, 6: 4, 7: 4}  # 金曜は 6/12 が休業なので 3 日


# ---- 在庫 ----

def test_stock_days_of_cover_gap_to_reorder_and_waste(api, data):
    body = _get(api, f"/api/analytics/stock?store_id={data['main']}").json()
    beans = next(i for i in body["items"] if i["code"] == "coffee-beans")
    with connect(api.url) as conn:
        row = conn.execute("SELECT b.on_hand, b.reserved, i.safety_stock, i.reorder_point FROM stock_balances b JOIN stock_items i ON i.id = b.item_id WHERE b.store_id = %s AND i.code = 'coffee-beans'", (data["main"],)).fetchone()
    assert beans["avg_daily_use"] == 36.0  # 直近 14 営業日の平均（休業の 6/12 は、営業日に入らない）
    assert beans["days_of_cover"] == round((row["on_hand"] - row["reserved"]) / 36, 1)
    assert beans["gap_to_reorder"] == row["on_hand"] - row["reserved"] - row["safety_stock"] - row["reorder_point"]
    assert beans["low"] is (beans["gap_to_reorder"] < 0) and beans["store_count"] == 1
    milk = next(w for w in body["waste"] if w["code"] == "milk")
    assert milk["total"] == 300 and milk["by_reason"] == {"expired": 300, "damaged": 0, "quality": 0, "other": 0} and milk["waste_rate_pct"] == 100.0
    chain = _get(api, "/api/analytics/stock").json()
    assert chain["scope"]["all_stores"] is True and all(i["store_count"] == 12 for i in chain["items"])


# ---- 今日の概況（当日は元データから） ----

def test_overview_reads_today_from_the_source_and_yesterday_from_the_aggregates(api, data):
    with connect(api.url) as conn:
        ob = variant_id(conn, "oasis-blend", "M", "hot")
        add_order(conn, user=add_user(conn, USERS[0]), store=data["main"], day=TODAY, hour=9, lines=[(ob, 2)])  # 今日 completed 900
        add_order(conn, user=add_user(conn, USERS[1]), store=data["main"], day=TODAY, hour=10, status="preparing", lines=[(ob, 1)])  # 進行中
        add_order(conn, user=add_user(conn, USERS[2]), store=data["main"], day=TODAY, hour=10, status="cancelled", lines=[(ob, 1)])  # 取消しは売上に入らない
    body = _get(api, f"/api/analytics/overview?store_id={data['main']}").json()
    assert (body["business_date"], body["sales_lumi"], body["orders"], body["avg_ticket_lumi"], body["in_progress"]) == ("2026-06-15", 900, 1, 900, 1)
    assert body["yesterday"] == {"business_date": "2026-06-14", "state": "open", "sales_lumi": 450, "orders": 1, "avg_ticket_lumi": 450}
    with connect(api.url) as conn:  # 当日の行は、集計表には作らない
        assert conn.execute("SELECT count(*) AS n FROM analytics.daily_store_summary WHERE business_date = %s", (TODAY,)).fetchone()["n"] == 0
    closed = _get(api, f"/api/analytics/overview?store_id={data['lookout']}").json()  # 今日が臨時休業の店
    assert (closed["open_stores"], closed["closed_reason"], closed["sales_lumi"], closed["avg_ticket_lumi"]) == (0, "temporary_closure", 0, None)


# ---- 顧客 ----

def test_customer_analytics_is_for_the_all_store_manager_and_has_no_personal_data(api, data):
    r = _get(api, "/api/analytics/customers")
    assert r.status_code == 200
    body = r.json()
    assert body["min_cell"] == 5 and body["as_of"] == "2026-06-15"
    assert {s["segment"] for s in body["segments"]} == {"loyal", "regular", "light", "at_risk", "dormant"}
    shown = [s["customers"] for s in body["segments"] if not s["suppressed"]]
    assert all(n >= 5 or n == 0 for n in shown)  # 5 人未満（1〜4）のセルは出ない
    assert any(c["suppressed"] for row in body["cohorts"]["rows"] for c in row["cells"]) or all(row["size"] is None or row["size"] >= 5 for row in body["cohorts"]["rows"])
    text = r.text
    assert not any(name in text for name in USERS) and "display_name" not in text and "email" not in text and "user_id" not in text and "pseudonym" not in text

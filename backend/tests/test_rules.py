"""(l) 店の営業時間・定休日・ラストオーダー・臨時休業と、品の期間・時間帯（clock を差し替えて判定）。"""

from datetime import time

import pytest

from app import clock, rules
from tests.conftest import at_local
from tests.helpers import code_of

# 2026-11-23 は月曜、2026-11-25 は水曜（ローカル UTC+9）。


def _stores(client):
    return {s["code"]: s for s in client.get("/api/stores").json()}


def _variants(client, store_code, shop, item_code):
    menu = {i["code"]: i for i in client.get(f"/api/menu?store_id={shop.store_id(store_code)}").json()}
    return menu[item_code]["variants"]


@pytest.fixture
def hours_on(monkeypatch):
    monkeypatch.setenv("ORDER_HOURS_CHECK", "on")


def test_store_opening_hours_and_last_order(client, hours_on):
    """居住区本店 7:00〜21:00・年中無休・ラストオーダー 30 分前。"""
    cases = [
        ((6, 59, 59), "outside_hours"),
        ((7, 0, 0), None),
        ((12, 0, 0), None),
        ((20, 30, 0), None),  # ラストオーダーの時刻ちょうどは受ける
        ((20, 30, 1), "past_last_order"),
        ((20, 59, 0), "past_last_order"),
        ((21, 0, 0), "outside_hours"),
        ((23, 0, 0), "outside_hours"),
    ]
    for (h, m, s), expected in cases:
        clock.freeze(at_local(2026, 11, 23, h, m, s))
        store = _stores(client)["residential-main"]
        assert store["closed_reason"] == expected, (h, m, s)
        assert store["accepting_orders"] is (expected is None)


def test_last_order_is_15_minutes_for_the_ruins_hut_and_closed_weekday(client, hours_on):
    """遺跡発掘小屋店 10:00〜17:00・火曜定休・ラストオーダー 15 分前。2026-11-24 は火曜。"""
    clock.freeze(at_local(2026, 11, 23, 16, 45))
    assert _stores(client)["ruins-hut"]["closed_reason"] is None
    clock.freeze(at_local(2026, 11, 23, 16, 46))
    assert _stores(client)["ruins-hut"]["closed_reason"] == "past_last_order"
    clock.freeze(at_local(2026, 11, 24, 12, 0))
    hut = _stores(client)["ruins-hut"]
    assert hut["closed_reason"] == "closed_today" and hut["accepting_orders"] is False
    assert _stores(client)["residential-main"]["closed_reason"] is None  # 年中無休


def test_closed_weekday_uses_the_local_date_not_utc(client, hours_on):
    """居住区ドーム店は水曜定休。UTC ではまだ火曜の 23:30 でも、ローカル（UTC+9）では水曜 8:30（開店後）。"""
    clock.freeze(at_local(2026, 11, 25, 8, 30))
    assert clock.utc_now().isoweekday() == 2  # UTC は火曜
    assert _stores(client)["residential-dome"]["closed_reason"] == "closed_today"
    clock.freeze(at_local(2026, 11, 26, 8, 30))
    assert _stores(client)["residential-dome"]["closed_reason"] is None


def test_local_utc_offset_is_configurable(client, hours_on, monkeypatch):
    monkeypatch.setenv("LOCAL_UTC_OFFSET_HOURS", "0")
    clock.freeze(at_local(2026, 11, 23, 12, 0, offset_hours=0))
    assert clock.local_now().hour == 12
    assert _stores(client)["residential-main"]["closed_reason"] is None
    clock.freeze(at_local(2026, 11, 23, 3, 0, offset_hours=0))  # 同じ UTC でも、オフセット 0 なら 3:00（時間外）
    assert _stores(client)["residential-main"]["closed_reason"] == "outside_hours"


def test_mobile_order_unavailable_store_is_always_closed_for_orders(client, hours_on, monkeypatch):
    clock.freeze(at_local(2026, 11, 23, 12, 0))
    assert _stores(client)["residential-signal"]["closed_reason"] == "mobile_order_unavailable"
    monkeypatch.setenv("ORDER_HOURS_CHECK", "off")  # off でも、MO 不可は見る
    assert _stores(client)["residential-signal"]["closed_reason"] == "mobile_order_unavailable"


def test_temporary_closure_is_always_checked(client, shop, hours_on, monkeypatch):
    store_id = shop.store_id("rock-plaza")
    clock.freeze(at_local(2026, 11, 23, 12, 0))  # 岩山広場店は木曜定休。月曜は営業日
    assert _stores(client)["rock-plaza"]["closed_reason"] is None
    with shop.db() as conn:
        conn.execute("INSERT INTO store_closures (store_id, date, reason) VALUES (%s, %s, %s)", (store_id, "2026-11-23", "砂嵐の警報"))
    try:
        assert _stores(client)["rock-plaza"]["closed_reason"] == "temporary_closure"
        monkeypatch.setenv("ORDER_HOURS_CHECK", "off")
        assert _stores(client)["rock-plaza"]["closed_reason"] == "temporary_closure"
        clock.freeze(at_local(2026, 11, 24, 12, 0))  # 別の日は営業
        assert _stores(client)["rock-plaza"]["closed_reason"] is None
    finally:
        with shop.db() as conn:
            conn.execute("DELETE FROM store_closures WHERE store_id = %s AND date = '2026-11-23'", (store_id,))


def test_closed_store_refuses_the_proposal_and_the_order(client, shop, hours_on, monkeypatch):
    """営業時間外の確定は 409 store_closed（closed_reason つき）。ORDER_HOURS_CHECK=off なら通る。"""
    h = shop.user()
    sandwich = shop.variant("hot-sandwich")
    clock.freeze(at_local(2026, 11, 23, 20, 28))
    p = shop.proposal(h, "residential-main", [(sandwich, 1)])  # 営業中（ラストオーダーは 20:30）
    clock.freeze(at_local(2026, 11, 23, 20, 31))  # 提案の有効期間（10 分）の中で、ラストオーダーを過ぎた
    r = shop.place(h, p["id"])  # 確定の時に、営業時間を再検証する
    assert r.status_code == 409 and code_of(r) == "store_closed" and r.json()["detail"]["closed_reason"] == "past_last_order"
    clock.freeze(at_local(2026, 11, 23, 22, 0))
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and r.json()["detail"]["closed_reason"] == "outside_hours"
    monkeypatch.setenv("ORDER_HOURS_CHECK", "off")
    p = client.post("/api/cart/checkout-proposal", headers=h).json()
    assert shop.place(h, p["id"]).status_code == 201


def test_item_sold_window_morning_set_and_meat_pie(client, shop, hours_on):
    """モーニングセット 7:00〜10:30、ミートパイ 11:00 から。"""
    store = "residential-main"

    def reason(item):
        return _variants(client, store, shop, item)[0]["unavailable_reason"]

    clock.freeze(at_local(2026, 11, 23, 9, 0))
    assert reason("morning-set") is None and reason("meat-pie") == "out_of_hours"
    clock.freeze(at_local(2026, 11, 23, 10, 30))
    assert reason("morning-set") is None  # 10:30 ちょうどまでは出せる
    clock.freeze(at_local(2026, 11, 23, 10, 31))
    assert reason("morning-set") == "out_of_hours" and reason("meat-pie") == "out_of_hours"
    clock.freeze(at_local(2026, 11, 23, 11, 0))
    assert reason("meat-pie") is None and reason("morning-set") == "out_of_hours"
    clock.freeze(at_local(2026, 11, 23, 7, 0))
    assert reason("morning-set") is None
    clock.freeze(at_local(2026, 11, 23, 6, 59))
    assert reason("morning-set") == "out_of_hours"
    # 販売時間帯のない品は、いつでも
    assert reason("cheesecake") is None


def test_item_season_kikan_limited(client, shop, monkeypatch):
    """帰還祭の限定ドリンク（12/1〜12/25）。季節の期間は、ORDER_HOURS_CHECK=off でも見る。"""
    store = "residential-main"

    def reason():
        return _variants(client, store, shop, "kikan-limited")[0]["unavailable_reason"]

    for check in ("off", "on"):
        monkeypatch.setenv("ORDER_HOURS_CHECK", check)
        for (m, d, expected) in [(11, 30, "out_of_season"), (12, 1, None), (12, 15, None), (12, 25, None), (12, 26, "out_of_season"), (1, 10, "out_of_season")]:
            clock.freeze(at_local(2026 if m > 6 else 2027, m, d, 12, 0))
            assert reason() == expected, (check, m, d)
    # 季節でない品のうち、期間を持たない品は常に出せる
    assert _variants(client, store, shop, "oasis-blend")[0]["unavailable_reason"] is None


def test_hours_check_off_skips_hours_but_not_season(client, shop, monkeypatch):
    monkeypatch.setenv("ORDER_HOURS_CHECK", "off")
    clock.freeze(at_local(2026, 11, 24, 3, 0))  # 夜中・火曜（遺跡発掘小屋店は定休）
    assert _stores(client)["ruins-hut"]["accepting_orders"] is True
    assert _variants(client, "residential-main", shop, "morning-set")[0]["available"] is True
    assert _variants(client, "residential-main", shop, "kikan-limited")[0]["unavailable_reason"] == "out_of_season"


def test_menu_without_store_id_does_not_look_at_stock(client, shop):
    menu = {i["code"]: i for i in client.get("/api/menu").json()}
    assert all("available" in v and "unavailable_reason" in v for item in menu.values() for v in item["variants"])
    assert client.get("/api/menu?store_id=999999").status_code == 404


def test_in_season_handles_ranges_across_the_new_year():
    assert rules.in_season("12-25", "12-01", "12-25") and not rules.in_season("12-26", "12-01", "12-25")
    assert rules.in_season("12-31", "12-20", "01-05") and rules.in_season("01-03", "12-20", "01-05")
    assert rules.in_season("12-20", "12-20", "01-05") and rules.in_season("01-05", "12-20", "01-05")
    assert not rules.in_season("01-06", "12-20", "01-05") and not rules.in_season("12-19", "12-20", "01-05")
    assert rules.in_season("06-15", None, None)


def test_sold_window_with_only_one_end(hours_on):
    item = {"is_active": True, "season_from": None, "season_to": None, "sold_from": time(11, 0), "sold_until": None}
    assert rules.item_unavailable_reason(item, at_local(2026, 11, 23, 11, 0)) is None
    assert rules.item_unavailable_reason(item, at_local(2026, 11, 23, 10, 59)) == "out_of_hours"
    inactive = {**item, "is_active": False}
    assert rules.item_unavailable_reason(inactive, at_local(2026, 11, 23, 12, 0)) == "out_of_season"

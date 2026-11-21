"""宅配（顧客側）: 住所・区画・時間枠・カート・確認・確定・取消しで枠が戻る・同時の枠の確保（docs/api.md「宅配（P2）」）。"""

import logging
import re
import threading
from datetime import datetime, timedelta

import pytest

from app import clock, orders
from tests.conftest import at_local
from tests.delivery_helpers import (
    active_in_slot, add_address, delivery_order, delivery_proposal, fill_delivery_cart, new_slot, put_delivery_cart, ready_delivery, slot_booked,
    to_ready,
)
from tests.helpers import code_of

STORE = "residential-main"  # 居住区 + 発着場へ届ける。配達員 2 人（seed）
TERMINAL = "terminal-central"  # 発着場 + 岩山


def _grid(slots):
    """営業時間の格子の枠（開店から 30 分ごと）だけ。ほかのテストが作った枠（秒が 7）は除く。"""
    return [s for s in slots if re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:(00|30):00Z", s["starts_at"])]


def _v(shop, *pairs):
    return [(shop.variant(*variant), qty) for variant, qty in pairs]


def _americano(shop, qty=2):
    return _v(shop, (("americano", "M", "hot"), qty))  # 400 × qty


def _suspend(shop, zone_area: int, suspended: bool):
    zone_id = next(z["id"] for z in shop.client.get("/api/delivery/zones").json() if z["area_code"] == zone_area)
    r = shop.client.put(f"/api/staff/zones/{zone_id}/suspension", json={"suspended": suspended}, headers=shop.staff(None))
    assert r.status_code == 200, r.text
    return r.json()


# ---- 住所 ----

def test_addresses_create_list_delete_and_other_users_cannot_see_them(client, shop):
    h, other = shop.user(), shop.user()
    r = client.post("/api/addresses", json={"label": " 自宅 ", "area_code": 2, "line": "アルカ市発着場2-1-5 305", "note": "呼び鈴は 1 回"}, headers=h)
    assert r.status_code == 201
    a = r.json()
    assert a["label"] == "自宅" and a["area_code"] == 2 and a["area_name"] == "発着場" and a["line"] == "アルカ市発着場2-1-5 305"
    assert a["note"] == "呼び鈴は 1 回" and a["zone_id"] and a["created_at"].endswith("Z")
    assert client.post("/api/addresses", json={"label": "職場", "area_code": 1, "line": "アルカ市居住区1-4-2"}, headers=h).json()["note"] is None
    assert [x["label"] for x in client.get("/api/addresses", headers=h).json()] == ["自宅", "職場"]
    assert client.get("/api/addresses", headers=other).json() == []
    # 他人の住所は削除できない（404。存在を教えない）
    r = client.delete(f"/api/addresses/{a['id']}", headers=other)
    assert r.status_code == 404 and code_of(r) == "address_not_found"
    assert client.delete(f"/api/addresses/{a['id']}", headers=h).status_code == 204
    assert [x["label"] for x in client.get("/api/addresses", headers=h).json()] == ["職場"]
    assert code_of(client.delete(f"/api/addresses/{a['id']}", headers=h)) == "address_not_found"


def test_address_input_is_validated(client, shop):
    h = shop.user()
    r = client.post("/api/addresses", json={"label": "自宅", "area_code": 9, "line": "どこか"}, headers=h)
    assert r.status_code == 422 and code_of(r) == "invalid_area"
    for body in (
        {"label": "", "area_code": 1, "line": "x"}, {"label": "   ", "area_code": 1, "line": "x"}, {"label": "あ" * 21, "area_code": 1, "line": "x"},
        {"label": "a", "area_code": 1, "line": ""}, {"label": "a", "area_code": 1, "line": "x" * 101}, {"label": "a", "area_code": 1, "line": "x", "note": "n" * 101},
        {"label": "a", "area_code": 0, "line": "x"}, {"label": "a", "area_code": 1, "line": "x", "extra": 1},
    ):
        assert client.post("/api/addresses", json=body, headers=h).status_code == 422, body
    assert client.get("/api/addresses", headers=h).json() == []


def test_a_customer_keeps_at_most_ten_addresses(client, shop):
    h = shop.user()
    for i in range(10):
        add_address(shop, h, 1, label=f"住所{i}")
    r = client.post("/api/addresses", json={"label": "11 件目", "area_code": 1, "line": "x"}, headers=h)
    assert r.status_code == 422 and code_of(r) == "too_many_addresses"


def test_deleting_the_address_in_the_cart_clears_it_and_bumps_the_version(client, shop):
    h = shop.user()
    aid, sid = add_address(shop, h, 1), new_slot(shop, STORE)
    v = put_delivery_cart(shop, h, STORE, aid, sid).json()
    assert v["delivery"]["address"]["id"] == aid
    assert client.delete(f"/api/addresses/{aid}", headers=h).status_code == 204
    after = client.get("/api/cart", headers=h).json()
    assert after["delivery"]["address"] is None and "address_required" in after["delivery"]["issues"] and after["version"] == v["version"] + 1
    assert after["delivery"]["slot"]["id"] == sid  # 枠は残る


# ---- 区画 ----

def test_zones_match_world_md_and_can_be_filtered_by_store(client, shop):
    zones = client.get("/api/delivery/zones").json()
    assert [(z["name"], z["fee_lumi"], z["free_over_lumi"], z["min_order_lumi"], z["base_minutes"]) for z in zones] == [
        ("居住区", 150, 2000, 600, 25), ("発着場", 200, 2000, 700, 30), ("岩山", 300, 2000, 800, 40), ("遺跡", 400, 2000, 900, 50),
    ]
    assert all(z["is_suspended"] is False for z in zones)
    names = lambda code: [z["name"] for z in client.get(f"/api/delivery/zones?store_id={shop.store_id(code)}").json()]  # noqa: E731
    assert names(STORE) == ["居住区", "発着場"] and names(TERMINAL) == ["発着場", "岩山"]
    assert names("ruins-terrace") == ["岩山", "遺跡"]  # 最後の遺跡だけ、手前の岩山へ届ける
    assert names("ruins-hut") == []  # 配達員のいない店は、宅配をしない
    assert client.get("/api/delivery/zones?store_id=999999").status_code == 404


# ---- 時間枠 ----

def test_slots_list_the_day_with_remaining_counts(client, shop):
    day = clock.local_now().date() + timedelta(days=1)
    body = client.get(f"/api/stores/{shop.store_id(STORE)}/slots?date={day}").json()
    assert body["reason"] is None and body["store_id"] == shop.store_id(STORE) and body["date"] == day.isoformat() and body["zone_id"] is None
    slots = _grid(body["slots"])
    assert len(slots) == 27  # 7:00 から 20:00 開始まで（最後の枠はラストオーダーに終わる）
    assert all(s["capacity"] == 4 and s["remaining"] == s["capacity"] - s["booked"] for s in slots)
    assert all(s["available"] == (s["unavailable_reason"] is None) for s in slots)
    assert [s["starts_at"] for s in slots] == sorted(s["starts_at"] for s in slots)
    # 同じ日を 2 回呼んでも、枠は増えない（INSERT ... ON CONFLICT DO NOTHING）
    assert len(_grid(client.get(f"/api/stores/{shop.store_id(STORE)}/slots?date={day}").json()["slots"])) == 27


def test_slots_past_the_cutoff_are_listed_as_unavailable(client, shop):
    today = clock.local_now().date()
    clock.freeze(at_local(today.year, today.month, today.day, 12, 0))
    now = clock.utc_now()
    slots = _grid(client.get(f"/api/stores/{shop.store_id(STORE)}/slots?date={today}").json()["slots"])
    assert len(slots) == 27
    for s in slots:
        cutoff = datetime.fromisoformat(s["starts_at"].replace("Z", "+00:00")) - timedelta(minutes=45)
        if cutoff < now:
            assert s["available"] is False and s["unavailable_reason"] == "cutoff", s  # 締めを過ぎたら、満席でなくても cutoff
        else:
            assert s["unavailable_reason"] in (None, "full"), s
    # 12:00 の枠は 11:15 が締め（過ぎた）。12:30 の枠も 11:45 が締めで過ぎた。13:00 の枠（締め 12:15）からが選べる
    open_starts = [datetime.fromisoformat(s["starts_at"].replace("Z", "+00:00")) for s in slots if s["unavailable_reason"] != "cutoff"]
    assert min(open_starts) == at_local(today.year, today.month, today.day, 13, 0)
    assert [s for s in slots if s["unavailable_reason"] == "cutoff"]


def test_a_full_slot_is_listed_but_not_available(client, shop):
    sid = new_slot(shop, STORE, capacity=2, booked=2)
    with shop.db() as conn:
        starts = conn.execute("SELECT starts_at FROM delivery_slots WHERE id = %s", (sid,)).fetchone()["starts_at"]
    day = starts.astimezone(clock.local_now().tzinfo).date()
    listed = next(s for s in client.get(f"/api/stores/{shop.store_id(STORE)}/slots?date={day}").json()["slots"] if s["id"] == sid)
    assert listed["available"] is False and listed["unavailable_reason"] == "full" and listed["remaining"] == 0 and listed["booked"] == 2


def test_slots_are_empty_with_a_reason_for_closures_storms_and_stores_without_delivery(client, shop):
    sid = shop.store_id("ruins-terrace")
    day = clock.local_now().date() + timedelta(days=4)
    # 臨時休業（store_closures）
    with shop.db() as conn:
        conn.execute("INSERT INTO store_closures (store_id, date, reason) VALUES (%s, %s, %s)", (sid, day, "テスト"))
    try:
        body = client.get(f"/api/stores/{sid}/slots?date={day}").json()
        assert body["reason"] == "temporary_closure" and body["slots"] == []
    finally:
        with shop.db() as conn:
            conn.execute("DELETE FROM store_closures WHERE store_id = %s AND date = %s", (sid, day))
    assert client.get(f"/api/stores/{sid}/slots?date={day}").json()["reason"] is None
    # 砂嵐（区画の is_suspended）。zone_id を付けたときだけ反映する
    zone = next(z for z in client.get("/api/delivery/zones").json() if z["area_code"] == 4)
    try:
        _suspend(shop, 4, True)
        storm = client.get(f"/api/stores/{sid}/slots?date={day}&zone_id={zone['id']}").json()
        assert storm["reason"] == "storm_warning" and storm["slots"] == [] and storm["zone_id"] == zone["id"]
        other_zone = next(z for z in client.get("/api/delivery/zones").json() if z["area_code"] == 3)  # 岩山は警報なし
        assert client.get(f"/api/stores/{sid}/slots?date={day}&zone_id={other_zone['id']}").json()["reason"] is None
    finally:
        _suspend(shop, 4, False)
    assert client.get(f"/api/stores/{sid}/slots?date={day}&zone_id={zone['id']}").json()["reason"] is None
    # 区画の外 / 宅配をしない店 / 定休日
    assert client.get(f"/api/stores/{sid}/slots?date={day}&zone_id={next(z['id'] for z in client.get('/api/delivery/zones').json() if z['area_code'] == 1)}").json()["reason"] == "zone_unserved"
    hut = client.get(f"/api/stores/{shop.store_id('ruins-hut')}/slots?date={day}").json()
    assert hut["reason"] == "delivery_unavailable" and hut["slots"] == []
    dome = shop.store_id("residential-dome")  # 水曜が定休日
    today = clock.local_now().date()
    wednesday = next(today + timedelta(days=i) for i in range(8) if (today + timedelta(days=i)).isoweekday() == 3)
    closed = client.get(f"/api/stores/{dome}/slots?date={wednesday}").json()
    assert closed["reason"] == "closed_today" and closed["slots"] == []


def test_slots_for_a_store_without_mobile_order_say_so(client, shop):
    signal = shop.store_id("residential-signal")  # 通信環境の都合で MO 不可。宅配の区画を足すと、理由が変わる
    zone_id = next(z["id"] for z in client.get("/api/delivery/zones").json() if z["area_code"] == 1)
    day = clock.local_now().date() + timedelta(days=1)
    with shop.db() as conn:
        conn.execute("INSERT INTO store_zones (store_id, zone_id) VALUES (%s, %s)", (signal, zone_id))
    try:
        assert client.get(f"/api/stores/{signal}/slots?date={day}").json()["reason"] == "mobile_order_unavailable"
    finally:
        with shop.db() as conn:
            conn.execute("DELETE FROM store_zones WHERE store_id = %s", (signal,))


def test_slots_input_is_validated(client, shop):
    sid = shop.store_id(STORE)
    today = clock.local_now().date()
    for day in (today - timedelta(days=1), today + timedelta(days=8)):
        r = client.get(f"/api/stores/{sid}/slots?date={day}")
        assert r.status_code == 422 and code_of(r) == "invalid_date"
    assert client.get(f"/api/stores/{sid}/slots?date={today + timedelta(days=7)}").status_code == 200  # 7 日先まで
    assert client.get(f"/api/stores/{sid}/slots").status_code == 422
    assert client.get(f"/api/stores/{sid}/slots?date=not-a-date").status_code == 422
    assert client.get(f"/api/stores/999999/slots?date={today}").status_code == 404


# ---- カート ----

def test_cart_with_delivery_shows_the_fee_and_the_selection(client, shop):
    h = shop.user()
    cart = fill_delivery_cart(shop, h, STORE, _americano(shop, 2))  # 800 ルミ・居住区（送料 150・最低 600）
    d = cart["delivery"]
    assert cart["fulfillment"] == "delivery" and cart["subtotal_lumi"] == 800 and cart["delivery_fee_lumi"] == 150 and cart["total_lumi"] == 950
    assert d["zone"]["name"] == "居住区" and d["fee_lumi"] == 150 and d["free_over_lumi"] == 2000 and d["min_order_lumi"] == 600 and d["issues"] == []
    assert d["address"]["label"] == "自宅" and "line" not in d["address"] and d["slot"]["starts_at"].endswith("Z")
    # 店頭受け取りへ戻すと、送料も住所・枠も無くなる（全部置き換える）
    back = client.put("/api/cart", json={"store_id": shop.store_id(STORE), "fulfillment": "pickup"}, headers=h).json()
    assert back["fulfillment"] == "pickup" and back["delivery"] is None and back["delivery_fee_lumi"] == 0 and back["total_lumi"] == 800
    with shop.db() as conn:
        row = conn.execute("SELECT c.address_id, c.slot_id FROM carts c JOIN users u ON u.id = c.user_id WHERE u.auth_user_id = %s", (f"dev:{h['X-Dev-User']}",)).fetchone()
    assert row == {"address_id": None, "slot_id": None}


def test_cart_selection_is_checked(client, shop):
    h, other = shop.user(), shop.user()
    mine, theirs = add_address(shop, h, 1), add_address(shop, other, 1)
    slot = new_slot(shop, STORE)
    r = put_delivery_cart(shop, h, STORE, theirs, slot)  # 他人の住所
    assert r.status_code == 404 and code_of(r) == "address_not_found"
    assert code_of(put_delivery_cart(shop, h, STORE, 999999, slot)) == "address_not_found"
    r = put_delivery_cart(shop, h, STORE, mine, new_slot(shop, TERMINAL))  # 他の店の枠
    assert r.status_code == 404 and code_of(r) == "slot_not_found"
    assert code_of(put_delivery_cart(shop, h, STORE, mine, 999999)) == "slot_not_found"
    far = add_address(shop, h, 4)  # 遺跡。居住区本店は届けない
    r = put_delivery_cart(shop, h, STORE, far, slot)
    assert r.status_code == 409 and code_of(r) == "out_of_zone"
    # 店頭受け取りに、住所・枠は付けられない
    r = client.put("/api/cart", json={"store_id": shop.store_id(STORE), "fulfillment": "pickup", "address_id": mine}, headers=h)
    assert r.status_code == 422 and code_of(r) == "pickup_with_delivery_fields"
    r = client.put("/api/cart", json={"store_id": None, "fulfillment": "delivery", "address_id": mine}, headers=h)
    assert r.status_code == 422 and code_of(r) == "store_required"
    # 満席・締め切りの枠は選べない（カートは変わらない）
    before = client.get("/api/cart", headers=h).json()["version"]
    full = new_slot(shop, STORE, capacity=1, booked=1)
    r = put_delivery_cart(shop, h, STORE, mine, full)
    assert r.status_code == 409 and code_of(r) == "slot_full"
    r = put_delivery_cart(shop, h, STORE, mine, new_slot(shop, STORE, ahead_minutes=10))
    assert r.status_code == 409 and code_of(r) == "slot_cutoff"
    assert client.get("/api/cart", headers=h).json()["version"] == before
    # 宅配をしない店は、止めずに issues で知らせる（確認・確定で 409）
    r = put_delivery_cart(shop, h, "ruins-hut", None, None)
    assert r.status_code == 200 and r.json()["delivery"]["issues"][0] == "delivery_unavailable"


def test_cart_issues_follow_the_documented_order(client, shop):
    h = shop.user()
    r = put_delivery_cart(shop, h, STORE, None, None).json()
    assert r["delivery"]["issues"] == ["address_required", "slot_required"] and r["total_lumi"] == 0 and r["delivery_fee_lumi"] == 0  # 空のカートに送料は付けない
    cart = fill_delivery_cart(shop, h, STORE, _v(shop, (("hot-sandwich",), 1)))  # 520 < 居住区の最低 600
    assert cart["delivery"]["issues"] == ["below_minimum"] and cart["total_lumi"] == 520 + 150


# ---- 確認 ----

def test_delivery_proposal_includes_the_fee_and_the_delivery_block(client, shop):
    h = shop.user()
    p = delivery_proposal(shop, h, STORE, _americano(shop, 2))
    assert p["fulfillment"] == "delivery" and p["subtotal_lumi"] == 800 and p["delivery_fee_lumi"] == 150 and p["total_lumi"] == 950
    assert p["pickup_note"] is None and p["delivery"]["issues"] == [] and p["delivery"]["zone"]["name"] == "居住区"
    # 店頭は P1 のまま
    pickup = shop.proposal(shop.user(), STORE, _americano(shop, 1))
    assert pickup["pickup_note"] == "店頭でお渡しします" and pickup["fulfillment"] == "pickup" and pickup["delivery"] is None and pickup["delivery_fee_lumi"] == 0


def test_checkout_proposal_refuses_in_the_documented_order(client, shop):
    h = shop.user()
    put_delivery_cart(shop, h, "ruins-hut", None, None)
    client.put(f"/api/cart/items/{shop.variant('americano', 'M', 'hot')}", json={"qty": 2}, headers=h)
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and code_of(r) == "delivery_unavailable"
    put_delivery_cart(shop, h, STORE, None, None)
    assert code_of(client.post("/api/cart/checkout-proposal", headers=h)) == "address_required"
    put_delivery_cart(shop, h, STORE, add_address(shop, h, 1), None)
    assert code_of(client.post("/api/cart/checkout-proposal", headers=h)) == "slot_required"
    put_delivery_cart(shop, h, STORE, add_address(shop, h, 1), new_slot(shop, STORE))
    assert client.post("/api/cart/checkout-proposal", headers=h).status_code == 200


def test_minimum_order_is_per_zone_and_inclusive(client, shop):
    h = shop.user()
    # 居住区（最低 600）: 590 でなく 520 は足りない。ちょうど 600（紅茶 S 300 × 2）は通る
    fill_delivery_cart(shop, h, STORE, _v(shop, (("hot-sandwich",), 1)))
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and code_of(r) == "below_minimum" and r.json()["detail"]["min_order_lumi"] == 600
    client.put(f"/api/cart/items/{shop.variant('hot-sandwich')}", json={"qty": 0}, headers=h)
    client.put(f"/api/cart/items/{shop.variant('black-tea', 'S', 'hot')}", json={"qty": 2}, headers=h)
    p = client.post("/api/cart/checkout-proposal", headers=h).json()
    assert p["subtotal_lumi"] == 600 and p["total_lumi"] == 750
    # 発着場（最低 700）: 680（アメリカーノ S × 2）は足りず、ちょうど 700（紅茶 S + アメリカーノ M）は通る。送料 200
    h2 = shop.user()
    fill_delivery_cart(shop, h2, STORE, _v(shop, (("americano", "S", "hot"), 2)), area=2)
    r = client.post("/api/cart/checkout-proposal", headers=h2)
    assert code_of(r) == "below_minimum" and r.json()["detail"]["min_order_lumi"] == 700
    client.put(f"/api/cart/items/{shop.variant('americano', 'S', 'hot')}", json={"qty": 0}, headers=h2)
    client.put(f"/api/cart/items/{shop.variant('black-tea', 'S', 'hot')}", json={"qty": 1}, headers=h2)
    client.put(f"/api/cart/items/{shop.variant('americano', 'M', 'hot')}", json={"qty": 1}, headers=h2)
    p = client.post("/api/cart/checkout-proposal", headers=h2).json()
    assert p["subtotal_lumi"] == 700 and p["delivery_fee_lumi"] == 200 and p["total_lumi"] == 900
    # 岩山（最低 800・送料 300）は、発着場中央店から
    h3 = shop.user()
    fill_delivery_cart(shop, h3, TERMINAL, _v(shop, (("americano", "M", "hot"), 2)), area=3)  # 800
    p = client.post("/api/cart/checkout-proposal", headers=h3).json()
    assert p["delivery_fee_lumi"] == 300 and p["total_lumi"] == 1100 and p["delivery"]["zone"]["base_minutes"] == 40


def test_the_fee_is_free_from_2000_lumi_inclusive(client, shop):
    just_below, exactly = shop.user(), shop.user()
    p = delivery_proposal(shop, just_below, STORE, _v(shop, (("beans-seasonal",), 1)))  # 1,900
    assert p["subtotal_lumi"] == 1900 and p["delivery_fee_lumi"] == 150 and p["total_lumi"] == 2050
    p = delivery_proposal(shop, exactly, STORE, _v(shop, (("cafe-latte", "M", "hot"), 4)))  # 500 × 4 = 2,000
    assert p["subtotal_lumi"] == 2000 and p["delivery_fee_lumi"] == 0 and p["total_lumi"] == 2000
    o = shop.place(exactly, p["id"]).json()
    assert o["delivery_fee_lumi"] == 0 and o["total_lumi"] == 2000


def test_a_storm_warning_stops_the_checkout_and_lifting_it_reopens(client, shop):
    h = shop.user()
    fill_delivery_cart(shop, h, STORE, _americano(shop, 2))
    try:
        zone = _suspend(shop, 1, True)
        assert zone["is_suspended"] is True
        assert client.get("/api/cart", headers=h).json()["delivery"]["issues"] == ["zone_suspended"]
        r = client.post("/api/cart/checkout-proposal", headers=h)
        assert r.status_code == 409 and code_of(r) == "zone_suspended"
    finally:
        assert _suspend(shop, 1, False)["is_suspended"] is False
    assert client.post("/api/cart/checkout-proposal", headers=h).status_code == 200


def test_a_slot_that_passes_its_cutoff_after_selection_is_refused_at_the_proposal(client, shop):
    h = shop.user()
    fill_delivery_cart(shop, h, STORE, _americano(shop, 2), slot_id=new_slot(shop, STORE, ahead_minutes=60))
    clock.freeze(clock.utc_now() + timedelta(minutes=30))  # 枠の開始まで 30 分 = 締め（45 分前）を過ぎた
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and code_of(r) == "slot_cutoff"


# ---- 確定 ----

def test_placing_a_delivery_order_books_the_slot_and_records_everything(client, shop):
    h = shop.user()
    slot = new_slot(shop, STORE)
    before = shop.balance(STORE, "coffee-beans")
    p = delivery_proposal(shop, h, STORE, _americano(shop, 2), slot_id=slot)
    r = shop.place(h, p["id"])
    assert r.status_code == 201
    o = r.json()
    assert o["status"] == "placed" and o["fulfillment"] == "delivery" and o["subtotal_lumi"] == 800 and o["delivery_fee_lumi"] == 150 and o["total_lumi"] == 950
    d = o["delivery"]
    assert d["status"] == "pending" and d["zone"]["name"] == "居住区" and d["slot"]["id"] == slot and d["courier"] is None and d["pin"] is None
    assert d["address"] == {"label": "自宅"} and d["attempt"] == 1 and d["failure_reason"] is None and d["eta_at"] == d["slot"]["starts_at"]
    assert o["payment"] == {"provider": "mock", "status": "pending"} and o["can_cancel"] is True
    assert slot_booked(shop, slot) == 1 == active_in_slot(shop, slot)
    assert shop.balance(STORE, "coffee-beans")[1] == before[1] + 36  # 在庫も確保される
    with shop.db() as conn:
        pay = conn.execute("SELECT amount_lumi FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_id = %s", (o["public_id"],)).fetchone()
        dv = conn.execute("SELECT d.status, d.address_label, d.address_line, d.pin_hash, d.courier_id FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE o.public_id = %s", (o["public_id"],)).fetchone()
    assert pay["amount_lumi"] == 950  # 送料込み
    assert dv["status"] == "pending" and dv["address_line"] == "アルカ市居住区1-4-2 305" and dv["pin_hash"] is None and dv["courier_id"] is None  # 住所は注文時の写し
    assert client.get("/api/cart", headers=h).json()["lines"] == []
    assert client.get("/api/orders", headers=h).json()[0]["fulfillment"] == "delivery"
    assert shop.reconcile() == []


def test_resending_the_same_key_books_the_slot_once(client, shop):
    h = shop.user()
    slot = new_slot(shop, STORE)
    p = delivery_proposal(shop, h, STORE, _americano(shop, 2), slot_id=slot)
    r1, r2 = shop.place(h, p["id"], "same-key-delivery"), shop.place(h, p["id"], "same-key-delivery")
    assert (r1.status_code, r2.status_code) == (201, 200) and r1.json()["public_id"] == r2.json()["public_id"]
    assert slot_booked(shop, slot) == 1


def test_a_full_slot_at_placement_is_refused_and_leaves_no_trace(client, shop):
    h = shop.user()
    slot = new_slot(shop, STORE, capacity=1)
    p = delivery_proposal(shop, h, STORE, _americano(shop, 2), slot_id=slot)
    with shop.db() as conn:
        conn.execute("UPDATE delivery_slots SET booked = capacity WHERE id = %s", (slot,))  # 提案の後に、別の人が最後の 1 件を取った
    before = shop.balance(STORE, "coffee-beans")
    r = shop.place(h, p["id"], "key-slot-full-1")
    assert r.status_code == 409 and code_of(r) == "slot_full"
    assert shop.balance(STORE, "coffee-beans") == before and client.get("/api/orders", headers=h).json() == []
    with shop.db() as conn:  # 取れた枠を戻して、同じキーでやり直せる
        conn.execute("UPDATE delivery_slots SET booked = 0 WHERE id = %s", (slot,))
    assert shop.place(h, p["id"], "key-slot-full-1").status_code == 201


def test_a_changed_fee_after_the_proposal_makes_it_stale(client, shop):
    h = shop.user()
    p = delivery_proposal(shop, h, STORE, _americano(shop, 2))
    with shop.db() as conn:
        conn.execute("UPDATE delivery_zones SET fee_lumi = 160 WHERE area_code = 1")
    try:
        r = shop.place(h, p["id"])
        assert r.status_code == 409 and code_of(r) == "proposal_stale"
    finally:
        with shop.db() as conn:
            conn.execute("UPDATE delivery_zones SET fee_lumi = 150 WHERE area_code = 1")


# ---- 取消しで枠が戻る ----

def test_cancelling_returns_the_slot_in_every_way_an_order_can_end(client, shop):
    slot = new_slot(shop, STORE, capacity=10)
    h = shop.user()
    # 顧客の取消し（placed）
    o = delivery_order(shop, h, STORE, _americano(shop, 2), slot_id=slot, pay=False)
    assert slot_booked(shop, slot) == 1
    r = client.post(f"/api/orders/{o['public_id']}/cancel", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "cancelled" and r.json()["delivery"]["status"] == "cancelled"
    assert slot_booked(shop, slot) == 0 == active_in_slot(shop, slot)
    # 支払いの拒否
    h2 = shop.user()
    o = delivery_order(shop, h2, STORE, _americano(shop, 2), slot_id=slot, pay=False)
    assert slot_booked(shop, slot) == 1
    assert client.post(f"/api/orders/{o['public_id']}/pay", json={"simulate": "decline"}, headers=h2).status_code == 402
    assert slot_booked(shop, slot) == 0
    # 顧客の取消し（paid。返金）
    h3 = shop.user()
    o = delivery_order(shop, h3, STORE, _americano(shop, 2), slot_id=slot)
    assert client.post(f"/api/orders/{o['public_id']}/cancel", headers=h3).json()["payment"]["status"] == "refunded"
    assert slot_booked(shop, slot) == 0
    # 店の取消し（ready）
    h4 = shop.user()
    o = ready_delivery(shop, h4, STORE, _americano(shop, 2), slot_id=slot)
    assert slot_booked(shop, slot) == 1
    assert shop.act(shop.staff(STORE), o["public_id"], "cancel", "材料切れ").status_code == 200
    assert slot_booked(shop, slot) == 0 == active_in_slot(shop, slot)


def test_a_payment_timeout_returns_the_slot(client, shop):
    slot = new_slot(shop, STORE)
    h = shop.user()
    o = delivery_order(shop, h, STORE, _americano(shop, 2), slot_id=slot, pay=False)
    assert slot_booked(shop, slot) == 1
    clock.freeze(clock.utc_now() + timedelta(minutes=16))  # 確保の期限（15 分）を過ぎる
    assert orders.expire_stale() >= 1
    assert slot_booked(shop, slot) == 0 == active_in_slot(shop, slot)
    clock.freeze(None)
    got = shop.get_order(h, o["public_id"])
    assert got["status"] == "cancelled" and got["cancel_reason"] == "payment_timeout" and got["delivery"]["status"] == "cancelled"


# ---- 同時の確保 ----

def test_concurrent_orders_never_book_more_than_the_slot_capacity(client, shop):
    capacity, users = 3, 7
    slot = new_slot(shop, STORE, capacity=capacity)
    prepared = []
    for _ in range(users):
        h = shop.user()
        prepared.append((h, delivery_proposal(shop, h, STORE, _americano(shop, 2), slot_id=slot)))
    results = [None] * users
    barrier = threading.Barrier(users)

    def go(i):
        h, p = prepared[i]
        barrier.wait()
        results[i] = shop.place(h, p["id"])

    threads = [threading.Thread(target=go, args=(i,)) for i in range(users)]
    [t.start() for t in threads]
    [t.join(timeout=60) for t in threads]
    assert all(r is not None for r in results), "確定が時間内に終わらなかった"
    ok = [r for r in results if r.status_code == 201]
    refused = [r for r in results if r.status_code != 201]
    assert len(ok) == capacity  # 成功は、ちょうど枠の数
    assert all(r.status_code == 409 and code_of(r) == "slot_full" for r in refused)
    assert slot_booked(shop, slot) == capacity == active_in_slot(shop, slot)
    # 失敗した人の注文・在庫の確保は残らない
    assert sorted(len(client.get("/api/orders", headers=h).json()) for h, _ in prepared) == [0] * (users - capacity) + [1] * capacity
    for r in ok:
        assert [m["kind"] for m in shop.movements(r.json()["public_id"])].count("reserve") == 2  # コーヒー豆とカップ
    assert shop.reconcile() == []


def test_the_slot_check_constraint_is_the_last_defence(client, shop):
    import psycopg

    slot = new_slot(shop, STORE, capacity=2)
    with shop.db() as conn, pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("UPDATE delivery_slots SET booked = 3 WHERE id = %s", (slot,))
    with shop.db() as conn, pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("UPDATE delivery_slots SET booked = -1 WHERE id = %s", (slot,))


# ---- 個人情報 ----

def test_the_address_is_not_written_to_the_logs(client, shop, caplog):
    caplog.set_level(logging.DEBUG)
    h = shop.user()
    marker_line, marker_note = "ひみつ町9-9-9 マーカー棟", "合言葉はマーカー鈴"
    aid = add_address(shop, h, 1, line=marker_line, note=marker_note)
    slot = new_slot(shop, STORE)
    put_delivery_cart(shop, h, STORE, aid, slot)
    client.put(f"/api/cart/items/{shop.variant('americano', 'M', 'hot')}", json={"qty": 2}, headers=h)
    p = client.post("/api/cart/checkout-proposal", headers=h).json()
    o = shop.place(h, p["id"]).json()
    shop.client.post(f"/api/orders/{o['public_id']}/pay", headers=h)
    client.delete(f"/api/addresses/{aid}", headers=h)
    assert marker_line not in caplog.text and marker_note not in caplog.text
    # 顧客・店のどの応答にも、住所（line・note）は載らない（住所の API と、集荷後の配達員だけ）
    got = shop.get_order(h, o["public_id"])
    assert marker_line not in str(got) and marker_note not in str(got) and marker_line not in str(client.get("/api/cart", headers=h).json())
    ready = to_ready(shop, STORE, o["public_id"])
    assert marker_line not in str(ready) and marker_note not in str(ready)
    assert o["delivery"]["address"] == {"label": "自宅"}

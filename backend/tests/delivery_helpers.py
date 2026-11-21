"""宅配のテストの道具（tests/helpers.py の Shop の上に足す）。API は TestClient 経由、枠・配達員・時計の準備だけ DB を直接触る。"""

import itertools
from datetime import timedelta
from types import SimpleNamespace

from app import clock

_seq = itertools.count(1)
COURIER_PASSWORD = "pw-for-tests-1"  # Shop.make_staff の既定


def new_slot(shop, store_code: str, *, capacity: int = 4, ahead_minutes: int = 180, booked: int = 0) -> int:
    """テスト専用の枠（今から ahead_minutes 後）を作る。秒を 7、マイクロ秒を連番にして、seed の枠（秒が 0）ともほかの枠ともぶつからない。"""
    start = (clock.utc_now() + timedelta(minutes=ahead_minutes)).replace(second=0, microsecond=0) + timedelta(seconds=7, microseconds=next(_seq))
    with shop.db() as conn:
        return conn.execute(
            "INSERT INTO delivery_slots (store_id, starts_at, ends_at, capacity, booked) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (shop.store_id(store_code), start, start + timedelta(minutes=30), capacity, booked),
        ).fetchone()["id"]


def slot_booked(shop, slot_id: int) -> int:
    with shop.db() as conn:
        return conn.execute("SELECT booked FROM delivery_slots WHERE id = %s", (slot_id,)).fetchone()["booked"]


def active_in_slot(shop, slot_id: int) -> int:
    """その枠を持つ、取り消されていない配達の数。booked と一致するはず（枠の件数の不変条件）。"""
    with shop.db() as conn:
        return conn.execute("SELECT count(*) AS n FROM deliveries WHERE slot_id = %s AND status <> 'cancelled'", (slot_id,)).fetchone()["n"]


def add_address(shop, headers: dict, area_code: int = 1, label: str = "自宅", line: str = "アルカ市居住区1-4-2 305", note: str | None = None) -> int:
    r = shop.client.post("/api/addresses", json={"label": label, "area_code": area_code, "line": line, "note": note}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def put_delivery_cart(shop, headers: dict, store_code: str, address_id: int | None, slot_id: int | None):
    return shop.client.put(
        "/api/cart", json={"store_id": shop.store_id(store_code), "fulfillment": "delivery", "address_id": address_id, "slot_id": slot_id}, headers=headers
    )


def fill_delivery_cart(shop, headers: dict, store_code: str, lines: list[tuple[int, int]], *, area: int = 1, slot_id: int | None = None) -> dict:
    """住所と枠を選んで、品を入れる。Cart を返す。"""
    aid = add_address(shop, headers, area)
    sid = slot_id if slot_id is not None else new_slot(shop, store_code)
    r = put_delivery_cart(shop, headers, store_code, aid, sid)
    assert r.status_code == 200, r.text
    for variant_id, qty in lines:
        r = shop.client.put(f"/api/cart/items/{variant_id}", json={"qty": qty}, headers=headers)
        assert r.status_code == 200, r.text
    return r.json()


def delivery_proposal(shop, headers: dict, store_code: str, lines, **kw) -> dict:
    fill_delivery_cart(shop, headers, store_code, lines, **kw)
    r = shop.client.post("/api/cart/checkout-proposal", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def delivery_order(shop, headers: dict, store_code: str, lines, *, pay: bool = True, **kw) -> dict:
    """カート → 提案 → 確定（→ 支払い）まで通した宅配の注文。"""
    p = delivery_proposal(shop, headers, store_code, lines, **kw)
    r = shop.place(headers, p["id"])
    assert r.status_code == 201, r.text
    order = r.json()
    if pay:
        r = shop.client.post(f"/api/orders/{order['public_id']}/pay", headers=headers)
        assert r.status_code == 200, r.text
        order = r.json()
    return order


def to_ready(shop, store_code: str, public_id: str) -> dict:
    """paid → accepted → preparing → ready（店のスタッフ）。"""
    h = shop.staff(store_code)
    for action in ("accept", "start", "ready"):
        r = shop.act(h, public_id, action)
        assert r.status_code == 200, r.text
    return r.json()


def ready_delivery(shop, headers: dict, store_code: str, lines, **kw) -> dict:
    order = delivery_order(shop, headers, store_code, lines, **kw)
    to_ready(shop, store_code, order["public_id"])
    return shop.get_order(headers, order["public_id"])


def make_courier(shop, store_code: str, *, on_duty: bool = True, zone_area: int | None = None) -> SimpleNamespace:
    """テスト専用の配達員（アカウント + couriers の行）。デモの配達員を巻き込まないために使う。"""
    email = shop.make_staff("courier", store_code)
    with shop.db() as conn:
        sid = conn.execute("SELECT id FROM staff_accounts WHERE email = %s", (email,)).fetchone()["id"]
        zone = conn.execute("SELECT id FROM delivery_zones WHERE area_code = %s", (zone_area,)).fetchone()["id"] if zone_area else None
        conn.execute(
            "INSERT INTO couriers (staff_id, store_id, is_on_duty, zone_id) VALUES (%s, %s, %s, %s)", (sid, shop.store_id(store_code), on_duty, zone)
        )
    r = shop.login(email, COURIER_PASSWORD)
    assert r.status_code == 200, r.text
    return SimpleNamespace(id=sid, email=email, headers={"Authorization": f"Bearer {r.json()['token']}"})


def assign(shop, store_code: str, public_id: str, courier_id: int):
    return shop.client.post(f"/api/staff/orders/{public_id}/assign", json={"courier_id": courier_id}, headers=shop.staff(store_code))


def courier_post(shop, courier, public_id: str, action: str, body: dict | None = None):
    url = f"/api/courier/deliveries/{public_id}/{action}"
    return shop.client.post(url, json=body, headers=courier.headers) if body is not None else shop.client.post(url, headers=courier.headers)


def to_delivering(shop, store_code: str, headers: dict, courier, public_id: str) -> str:
    """assigned → picked_up → delivering まで進めて、顧客に見える暗証コードを返す。"""
    assert courier_post(shop, courier, public_id, "pickup").status_code == 200
    pin = shop.get_order(headers, public_id)["delivery"]["pin"]
    assert courier_post(shop, courier, public_id, "depart").status_code == 200
    return pin


def delivering_order(shop, store_code: str, lines, *, area: int = 1, courier=None) -> tuple[dict, dict, str, object]:
    """宅配の注文を、配達中（delivering）まで進める。(顧客のヘッダー, 注文, 暗証コード, 配達員) を返す。"""
    h = shop.user()
    courier = courier or make_courier(shop, store_code)
    order = ready_delivery(shop, h, store_code, lines, area=area)
    assert assign(shop, store_code, order["public_id"], courier.id).status_code == 200
    pin = to_delivering(shop, store_code, h, courier, order["public_id"])
    return h, order, pin, courier


def wrong_pins(true_pin: str, n: int) -> list[str]:
    out = []
    for i in itertools.count():
        candidate = f"{(int(true_pin) + 1 + i) % 10000:04d}"
        if candidate != true_pin:
            out.append(candidate)
        if len(out) == n:
            return out


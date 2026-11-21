"""宅配の個人情報（住所・暗証コード）の受け入れ条件: API が返さないことを、応答の本文で確かめる（docs/api.md「宅配（P2）」の共通の約束）。

画面で隠すのではなく、API の応答に含めないことが条件。住所は、集荷後の担当の配達員と顧客本人（ラベルだけ）に限る。
暗証コードは、集荷後の顧客本人にだけ。店・店長・配達員の応答、ログ、イベントには出さない。
"""

import logging
import re

from tests.delivery_helpers import add_address, assign, courier_post, make_courier, new_slot, put_delivery_cart, to_ready, wrong_pins
from tests.helpers import code_of

STORE = "residential-main"
LINE = "ひみつ町9-9-9 マーカー棟"  # 住所の目印（本文に出たらすぐ分かる文字列）
NOTE = "合言葉はマーカー鈴"
PIN_KEYS = {"pin", "pin_hash", "pin_nonce"}


def _ready_with_marked_address(shop, h) -> str:
    """目印つきの住所で宅配の注文を ready まで進める。public_id を返す。"""
    aid = add_address(shop, h, 1, line=LINE, note=NOTE)
    assert put_delivery_cart(shop, h, STORE, aid, new_slot(shop, STORE)).status_code == 200
    r = shop.client.put(f"/api/cart/items/{shop.variant('americano', 'M', 'hot')}", json={"qty": 2}, headers=h)
    assert r.status_code == 200, r.text
    p = shop.client.post("/api/cart/checkout-proposal", headers=h).json()
    o = shop.place(h, p["id"]).json()
    assert shop.client.post(f"/api/orders/{o['public_id']}/pay", headers=h).status_code == 200
    to_ready(shop, STORE, o["public_id"])
    return o["public_id"]


def _keys_and_strings(value, keys=None, strings=None):
    """JSON の中の、すべてのキーと文字列の値を集める。"""
    keys = set() if keys is None else keys
    strings = [] if strings is None else strings
    if isinstance(value, dict):
        for k, v in value.items():
            keys.add(k)
            _keys_and_strings(v, keys, strings)
    elif isinstance(value, list):
        for v in value:
            _keys_and_strings(v, keys, strings)
    elif isinstance(value, str):
        strings.append(value)
    return keys, strings


def _assert_no_pin(response, pin: str) -> None:
    """応答に、暗証コード（pin・pin_hash・pin_nonce の項目、または値が暗証コードそのもの）が無い。"""
    try:
        body = response.json()
    except ValueError:
        return
    keys, strings = _keys_and_strings(body)
    assert not (keys & PIN_KEYS), f"暗証コードの項目がある: {sorted(keys & PIN_KEYS)}"
    assert pin not in strings, "値が暗証コードそのものの文字列がある"


def _courier_list(shop, courier) -> list[dict]:
    r = shop.client.get("/api/courier/deliveries", headers=courier.headers)
    assert r.status_code == 200, r.text
    return r.json()


def _address_of(rows: list[dict], pid: str):
    return next(d for d in rows if d["public_id"] == pid)["address"]


# ---- 住所: 配達員には集荷後だけ（API の応答の本文で） ----

def test_the_courier_gets_the_address_only_while_picked_up_or_delivering_in_every_response(client, shop):
    h, c = shop.user(), make_courier(shop, STORE)
    pid = _ready_with_marked_address(shop, h)
    assert assign(shop, STORE, pid, c.id).status_code == 200
    # 集荷の前: 一覧に住所は無い
    r = client.get("/api/courier/deliveries", headers=c.headers)
    assert _address_of(r.json(), pid) is None and LINE not in r.text and NOTE not in r.text
    # 集荷後: 応答にも一覧にも住所がある（出発後も）
    picked = courier_post(shop, c, pid, "pickup")
    assert picked.json()["address"] == {"label": "自宅", "line": LINE, "note": NOTE}
    assert _address_of(_courier_list(shop, c), pid) == {"label": "自宅", "line": LINE, "note": NOTE}
    pin = shop.get_order(h, pid)["delivery"]["pin"]
    assert courier_post(shop, c, pid, "depart").json()["address"]["line"] == LINE
    assert _address_of(_courier_list(shop, c), pid)["line"] == LINE
    # 不在: 応答にも、一覧（担当ではなくなる）にも住所は無い
    failed = courier_post(shop, c, pid, "fail", {"reason": "absent"})
    assert failed.status_code == 200 and failed.json()["address"] is None and LINE not in failed.text and NOTE not in failed.text
    assert all(d["public_id"] != pid for d in _courier_list(shop, c))
    # 再配達 → 再び割り当て: 集荷の前に戻るので、住所は隠れる
    r = client.post(f"/api/staff/orders/{pid}/redeliver", json={"slot_id": new_slot(shop, STORE, ahead_minutes=300)}, headers=shop.staff(STORE))
    assert r.status_code == 200, r.text
    assert assign(shop, STORE, pid, c.id).status_code == 200
    again = client.get("/api/courier/deliveries", headers=c.headers)
    assert _address_of(again.json(), pid) is None and LINE not in again.text and NOTE not in again.text
    # 完了の応答にも住所は無い
    assert courier_post(shop, c, pid, "pickup").status_code == 200
    pin = shop.get_order(h, pid)["delivery"]["pin"]
    assert courier_post(shop, c, pid, "depart").status_code == 200
    done = courier_post(shop, c, pid, "deliver", {"pin": pin})
    assert done.status_code == 200 and done.json()["status"] == "completed" and done.json()["address"] is None
    assert LINE not in done.text and NOTE not in done.text


def test_the_customer_sees_the_address_label_only_even_after_pickup(client, shop):
    h, c = shop.user(), make_courier(shop, STORE)
    pid = _ready_with_marked_address(shop, h)
    assert assign(shop, STORE, pid, c.id).status_code == 200
    for action in ("pickup", "depart"):
        assert courier_post(shop, c, pid, action).status_code == 200
        r = client.get(f"/api/orders/{pid}", headers=h)
        assert r.json()["delivery"]["address"] == {"label": "自宅"} and LINE not in r.text and NOTE not in r.text
        assert LINE not in client.get("/api/orders", headers=h).text
    assert LINE not in client.get("/api/cart", headers=h).text


def test_staff_and_manager_boards_carry_neither_address_nor_pin(client, shop):
    h, c = shop.user(), make_courier(shop, STORE)
    pid = _ready_with_marked_address(shop, h)
    assert assign(shop, STORE, pid, c.id).status_code == 200
    for action in ("pickup", "depart"):
        assert courier_post(shop, c, pid, action).status_code == 200
        pin = shop.get_order(h, pid)["delivery"]["pin"]
        for who in (shop.staff(STORE), shop.staff(None)):  # 店のスタッフと、全店の店長
            r = client.get("/api/staff/deliveries", headers=who)
            assert r.status_code == 200 and any(o["public_id"] == pid for o in r.json()["orders"])
            assert LINE not in r.text and NOTE not in r.text
            _assert_no_pin(r, pin)


# ---- 暗証コード: 顧客本人だけ。配達員・店・店長の応答には項目も値も無い ----

def test_no_courier_response_carries_a_pin_nonce_or_hash(client, shop):
    h, c = shop.user(), make_courier(shop, STORE)
    pid = _ready_with_marked_address(shop, h)
    assert assign(shop, STORE, pid, c.id).status_code == 200
    seen = [client.get("/api/courier/deliveries", headers=c.headers)]
    seen.append(courier_post(shop, c, pid, "pickup"))
    pin = shop.get_order(h, pid)["delivery"]["pin"]
    seen += [client.get("/api/courier/deliveries", headers=c.headers), courier_post(shop, c, pid, "depart"), client.get("/api/courier/deliveries", headers=c.headers)]
    wrong = courier_post(shop, c, pid, "deliver", {"pin": wrong_pins(pin, 1)[0]})
    assert wrong.status_code == 422 and code_of(wrong) == "pin_invalid"
    seen.append(wrong)
    # 形の誤りの 422 は、送った値を返さない
    malformed = courier_post(shop, c, pid, "deliver", {"pin": "12a4"})
    assert malformed.status_code == 422 and "12a4" not in malformed.text
    seen += [malformed, courier_post(shop, c, pid, "deliver", {"pin": pin})]
    for r in seen:
        _assert_no_pin(r, pin)


def test_a_pin_locked_delivery_response_does_not_reveal_the_pin(client, shop):
    h, c = shop.user(), make_courier(shop, STORE)
    pid = _ready_with_marked_address(shop, h)
    assert assign(shop, STORE, pid, c.id).status_code == 200
    assert courier_post(shop, c, pid, "pickup").status_code == 200
    pin = shop.get_order(h, pid)["delivery"]["pin"]
    assert courier_post(shop, c, pid, "depart").status_code == 200
    last = None
    for bad in wrong_pins(pin, 5):
        last = courier_post(shop, c, pid, "deliver", {"pin": bad})
        _assert_no_pin(last, pin)
    assert last.status_code == 409 and code_of(last) == "pin_locked"
    # 凍結の後は、顧客にも暗証コードは見えない
    assert shop.get_order(h, pid)["delivery"]["pin"] is None


def test_a_stranger_cannot_read_pay_or_cancel_a_delivery_order(client, shop):
    h, c = shop.user(), make_courier(shop, STORE)
    pid = _ready_with_marked_address(shop, h)
    assert assign(shop, STORE, pid, c.id).status_code == 200
    assert courier_post(shop, c, pid, "pickup").status_code == 200
    pin = shop.get_order(h, pid)["delivery"]["pin"]
    stranger = shop.user()
    for r in (
        client.get(f"/api/orders/{pid}", headers=stranger),
        client.post(f"/api/orders/{pid}/pay", headers=stranger),
        client.post(f"/api/orders/{pid}/cancel", headers=stranger),
    ):
        assert r.status_code == 404
        assert not re.search(rf"(?<!\d){pin}(?!\d)", r.text.replace(pid, "")) and LINE not in r.text
    assert all(o["public_id"] != pid for o in client.get("/api/orders", headers=stranger).json())


def test_the_pin_and_the_address_never_reach_the_logs_or_the_event_trail(client, shop, caplog):
    caplog.set_level(logging.DEBUG)
    h, c = shop.user(), make_courier(shop, STORE)
    pid = _ready_with_marked_address(shop, h)
    assert assign(shop, STORE, pid, c.id).status_code == 200
    assert courier_post(shop, c, pid, "pickup").status_code == 200
    pin = shop.get_order(h, pid)["delivery"]["pin"]
    assert courier_post(shop, c, pid, "depart").status_code == 200
    assert courier_post(shop, c, pid, "deliver", {"pin": wrong_pins(pin, 1)[0]}).status_code == 422
    assert courier_post(shop, c, pid, "deliver", {"pin": pin}).status_code == 200
    # ログ: メッセージの本文だけを見る（行番号などの数字と取り違えない）。public_id は除く
    messages = " ".join(rec.getMessage() for rec in caplog.records).replace(pid, "")
    assert not re.search(rf"(?<!\d){pin}(?!\d)", messages) and LINE not in messages and NOTE not in messages
    # イベントの記録（reason）に、暗証コードも住所も無い
    with shop.db() as conn:
        reasons = [e["reason"] or "" for e in conn.execute("SELECT e.reason FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.public_id = %s", (pid,)).fetchall()]
    assert all(not re.search(rf"(?<!\d){pin}(?!\d)", r) and LINE not in r and NOTE not in r for r in reasons)


# ---- 配達員の ID を、顧客へ返さない（docs/api.md: courier は名前だけ） ----

def test_the_customer_order_does_not_expose_the_courier_id(client, shop):
    h, c = shop.user(), make_courier(shop, STORE)
    pid = _ready_with_marked_address(shop, h)
    assert assign(shop, STORE, pid, c.id).status_code == 200
    r = client.get(f"/api/orders/{pid}", headers=h)
    order = r.json()
    assert order["delivery"]["courier"] == {"name": "テスト用"}  # 名前だけ
    reasons = [e["reason"] or "" for e in order["events"]]
    assert all("courier" not in reason for reason in reasons), reasons
    # 付け替えのイベントも同じ
    other = make_courier(shop, STORE)
    assert assign(shop, STORE, pid, other.id).status_code == 200
    reasons = [e["reason"] or "" for e in client.get(f"/api/orders/{pid}", headers=h).json()["events"]]
    assert all("courier" not in reason for reason in reasons), reasons

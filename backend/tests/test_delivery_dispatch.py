"""宅配（店・配達員側）: 配車・割り当て・集荷・出発・暗証コード・不在・再配達・模擬の進行・砂嵐の権限（docs/api.md「宅配（P2）」）。"""

import threading
from datetime import timedelta

from app import clock, dispatch, orders
from tests.delivery_helpers import (
    active_in_slot, assign, courier_post, delivering_order, make_courier, new_slot, ready_delivery, slot_booked, to_delivering, wrong_pins,
)
from tests.helpers import code_of

STORE = "residential-main"  # 配達員 2 人（seed）
TERMINAL = "terminal-central"
ROCK = "rock-plaza"  # 配達員 1 人（seed）


def _americano(shop, qty=2):
    return [(shop.variant("americano", "M", "hot"), qty)]


def _events(shop, public_id):
    with shop.db() as conn:
        return [
            (e["from_status"], e["to_status"], e["actor_type"], e["reason"])
            for e in conn.execute("SELECT e.* FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.public_id = %s ORDER BY e.id", (public_id,)).fetchall()
        ]


def _delivery_row(shop, public_id):
    with shop.db() as conn:
        return conn.execute("SELECT d.* FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE o.public_id = %s", (public_id,)).fetchone()


def _board(shop, store_code, **params):
    r = shop.client.get("/api/staff/deliveries", params=params, headers=shop.staff(store_code))
    assert r.status_code == 200, r.text
    return r.json()


def _set_on_duty(shop, store_code, on_duty, *, keep=()):
    """店の配達員の勤務を、まとめて切り替える（テストの終わりに戻す）。keep の ID は触らない。"""
    with shop.db() as conn:
        rows = conn.execute("SELECT staff_id, is_on_duty FROM couriers WHERE store_id = %s AND staff_id <> ALL(%s)", (shop.store_id(store_code), list(keep))).fetchall()
        conn.execute("UPDATE couriers SET is_on_duty = %s WHERE store_id = %s AND staff_id <> ALL(%s)", (on_duty, shop.store_id(store_code), list(keep)))
    return rows


def _restore_duty(shop, saved):
    with shop.db() as conn:
        for r in saved:
            conn.execute("UPDATE couriers SET is_on_duty = %s WHERE staff_id = %s", (r["is_on_duty"], r["staff_id"]))


# ---- 配車ボード・提案 ----

def test_the_dispatch_board_lists_ready_delivery_orders_with_a_suggestion(client, shop):
    h = shop.user()
    o = ready_delivery(shop, h, STORE, _americano(shop))
    board = _board(shop, STORE)
    assert board["provider"] == "mock"
    mine = next(x for x in board["orders"] if x["public_id"] == o["public_id"])
    assert mine["status"] == "ready" and mine["fulfillment"] == "delivery" and mine["allowed_actions"] == ["assign", "cancel"]
    assert mine["delivery"]["status"] == "pending" and mine["delivery"]["zone"]["name"] == "居住区" and mine["delivery"]["courier"] is None
    assert set(mine["suggestion"]) == {"courier_id", "courier_name", "minutes"} and mine["suggestion"]["minutes"] == 0  # 店にいる配達員
    assert {c["store_id"] for c in board["couriers"]} == {shop.store_id(STORE)} and len(board["couriers"]) >= 2
    assert all(set(c) == {"id", "store_id", "name", "vehicle", "is_on_duty", "active_count", "zone"} and c["vehicle"] == "hover-scooter" for c in board["couriers"])
    # 店頭受け取りの注文は、配車ボードに出ない。ほかの店の店員には見えない
    assert all(x["fulfillment"] == "delivery" for x in board["orders"])
    assert o["public_id"] not in {x["public_id"] for x in _board(shop, ROCK)["orders"]}
    # 枠の開始が早い順
    starts = [x["delivery"]["slot"]["starts_at"] for x in board["orders"]]
    assert starts == sorted(starts)


def test_the_suggestion_is_the_nearest_on_duty_courier(client, shop):
    near, far = make_courier(shop, ROCK, zone_area=3), make_courier(shop, ROCK, zone_area=1)  # 店の区画は岩山(3)。居住区(1)からは 20 分
    saved = _set_on_duty(shop, ROCK, False, keep=(near.id, far.id))
    try:
        o = ready_delivery(shop, shop.user(), ROCK, _americano(shop), area=3)
        mine = next(x for x in _board(shop, ROCK)["orders"] if x["public_id"] == o["public_id"])
        assert mine["suggestion"] == {"courier_id": near.id, "courier_name": "テスト用", "minutes": 0}
        with shop.db() as conn:  # 近い人が担当中でも、分が同じなら担当の少ない人が先。分が違えば近い人が先
            conn.execute("UPDATE couriers SET zone_id = (SELECT id FROM delivery_zones WHERE area_code = 2) WHERE staff_id = %s", (near.id,))  # 発着場から 15 分
        mine = next(x for x in _board(shop, ROCK)["orders"] if x["public_id"] == o["public_id"])
        assert mine["suggestion"]["courier_id"] == near.id and mine["suggestion"]["minutes"] == 15
        with shop.db() as conn:
            conn.execute("UPDATE couriers SET is_on_duty = false WHERE staff_id = %s", (near.id,))
        mine = next(x for x in _board(shop, ROCK)["orders"] if x["public_id"] == o["public_id"])
        assert mine["suggestion"] == {"courier_id": far.id, "courier_name": "テスト用", "minutes": 20}  # 勤務外は提案しない
        with shop.db() as conn:
            conn.execute("UPDATE couriers SET is_on_duty = false WHERE staff_id = %s", (far.id,))
        mine = next(x for x in _board(shop, ROCK)["orders"] if x["public_id"] == o["public_id"])
        assert mine["suggestion"] is None  # 誰も勤務していなければ、提案なし
    finally:
        _restore_duty(shop, saved)


def test_the_policy_can_be_swapped_by_name(client, shop, monkeypatch):
    from app import delivery_rules

    monkeypatch.setitem(delivery_rules.PROPOSERS, "highest-id", lambda cands, zone, matrix: sorted(
        [delivery_rules.Proposal(c.courier_id, c.name, 0) for c in cands if c.is_on_duty], key=lambda p: -p.courier_id))
    monkeypatch.setenv("ASSIGNMENT_POLICY", "highest-id")
    o = ready_delivery(shop, shop.user(), STORE, _americano(shop))
    mine = next(x for x in _board(shop, STORE)["orders"] if x["public_id"] == o["public_id"])
    on_duty = [c["id"] for c in _board(shop, STORE)["couriers"] if c["is_on_duty"]]
    assert mine["suggestion"]["courier_id"] == max(on_duty)


# ---- 割り当て ----

def test_assign_moves_ready_to_assigned_and_checks_the_courier(client, shop):
    h = shop.user()
    o = ready_delivery(shop, h, STORE, _americano(shop))
    c1, c2 = make_courier(shop, STORE), make_courier(shop, STORE)
    stranger = make_courier(shop, TERMINAL)  # 他店の配達員
    off = make_courier(shop, STORE, on_duty=False)
    pid = o["public_id"]
    r = assign(shop, STORE, pid, stranger.id)
    assert r.status_code == 404 and code_of(r) == "courier_not_found"
    assert code_of(assign(shop, STORE, pid, 999999)) == "courier_not_found"
    r = assign(shop, STORE, pid, off.id)
    assert r.status_code == 409 and code_of(r) == "courier_off_duty"
    assert shop.get_order(h, pid)["status"] == "ready"
    r = assign(shop, STORE, pid, c1.id)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "assigned" and body["delivery"]["status"] == "assigned" and body["delivery"]["courier"] == {"id": c1.id, "name": "テスト用"}
    assert body["allowed_actions"] == ["assign", "cancel"] and "pin" not in body["delivery"]
    assert shop.get_order(h, pid)["delivery"]["courier"] == {"name": "テスト用"}  # 顧客には名前だけ
    # 付け替え（assigned → assigned）。状態は変わらず、履歴に残る
    assert assign(shop, STORE, pid, c2.id).json()["delivery"]["courier"]["id"] == c2.id
    assert [(f, t) for f, t, *_ in _events(shop, pid)][-2:] == [("ready", "assigned"), ("assigned", "assigned")]
    assert [e[3] for e in _events(shop, pid)][-2:] == [f"courier:{c1.id}", f"courier:{c2.id}"]
    # 集荷の後は付け替えられない
    assert courier_post(shop, c2, pid, "pickup").status_code == 200
    assert code_of(assign(shop, STORE, pid, c1.id)) == "invalid_transition"


def test_assign_is_limited_to_delivery_orders_in_the_right_state_and_to_the_store(client, shop):
    c = make_courier(shop, STORE)
    # 店頭の注文
    pickup = shop.paid_order(shop.user(), STORE, _americano(shop, 1))
    r = assign(shop, STORE, pickup["public_id"], c.id)
    assert r.status_code == 409 and code_of(r) == "invalid_transition"
    # 準備前の宅配（paid）
    from tests.delivery_helpers import delivery_order

    early = delivery_order(shop, shop.user(), STORE, _americano(shop))
    assert code_of(assign(shop, STORE, early["public_id"], c.id)) == "invalid_transition"
    # 他店のスタッフは、存在しないのと同じ（404）。店長（全店）はできる
    ready = ready_delivery(shop, shop.user(), STORE, _americano(shop))
    r = assign(shop, ROCK, ready["public_id"], c.id)
    assert r.status_code == 404 and code_of(r) == "not_found"
    r = shop.client.post(f"/api/staff/orders/{ready['public_id']}/assign", json={"courier_id": c.id}, headers=shop.staff(None))
    assert r.status_code == 200 and r.json()["status"] == "assigned"
    # 入力の形
    assert shop.client.post(f"/api/staff/orders/{ready['public_id']}/assign", json={}, headers=shop.staff(STORE)).status_code == 422
    assert shop.client.post(f"/api/staff/orders/{ready['public_id']}/assign", json={"courier_id": 0}, headers=shop.staff(STORE)).status_code == 422


def test_dispatch_endpoints_are_scoped_to_the_store(client, shop):
    r = shop.client.get(f"/api/staff/deliveries?store_id={shop.store_id(ROCK)}", headers=shop.staff(STORE))
    assert r.status_code == 404  # 他店を指すと 404
    assert shop.client.get(f"/api/staff/couriers?store_id={shop.store_id(ROCK)}", headers=shop.staff(STORE)).status_code == 404
    assert {c["store_id"] for c in shop.client.get("/api/staff/couriers", headers=shop.staff(ROCK)).json()} == {shop.store_id(ROCK)}
    all_stores = {c["store_id"] for c in shop.client.get("/api/staff/couriers", headers=shop.staff(None)).json()}
    assert {shop.store_id(STORE), shop.store_id(ROCK), shop.store_id(TERMINAL)} <= all_stores  # 店長は全店
    only = {c["store_id"] for c in shop.client.get(f"/api/staff/couriers?store_id={shop.store_id(TERMINAL)}", headers=shop.staff(None)).json()}
    assert only == {shop.store_id(TERMINAL)}
    assert code_of(shop.client.get("/api/staff/deliveries?status=nope", headers=shop.staff(STORE))) == "invalid_status"


def test_roles_are_separated(client, shop):
    courier = make_courier(shop, STORE)
    o = ready_delivery(shop, shop.user(), STORE, _americano(shop))
    # 配達員は、注文・在庫・配車を使えない（403）。スタッフ・店長は、配達員の API を使えない
    for path in ("/api/staff/orders", "/api/staff/deliveries", "/api/staff/couriers", "/api/staff/stock"):
        assert client.get(path, headers=courier.headers).status_code == 403, path
    assert client.post(f"/api/staff/orders/{o['public_id']}/assign", json={"courier_id": courier.id}, headers=courier.headers).status_code == 403
    for headers in (shop.staff(STORE), shop.staff(None)):
        assert client.get("/api/courier/deliveries", headers=headers).status_code == 403
        assert client.post(f"/api/courier/deliveries/{o['public_id']}/pickup", headers=headers).status_code == 403
    # 認証なし・顧客のヘッダーでは入れない
    assert client.get("/api/courier/deliveries").status_code == 401
    assert client.get("/api/courier/deliveries", headers=shop.user()).status_code == 401
    assert client.get("/api/staff/deliveries", headers=shop.user()).status_code == 401
    # 配達員は /me を使える
    assert client.get("/api/staff/me", headers=courier.headers).json()["role"] == "courier"


def test_the_kitchen_cannot_complete_a_delivery_order(client, shop):
    o = ready_delivery(shop, shop.user(), STORE, _americano(shop))
    r = shop.act(shop.staff(STORE), o["public_id"], "complete")
    assert r.status_code == 409 and code_of(r) == "invalid_transition"
    listed = next(x for x in shop.client.get("/api/staff/orders?status=ready", headers=shop.staff(STORE)).json() if x["public_id"] == o["public_id"])
    assert "complete" not in listed["allowed_actions"] and "assign" in listed["allowed_actions"] and listed["delivery"]["status"] == "pending"
    # 店頭の ready は P1 のまま（complete が出る）
    pickup = shop.paid_order(shop.user(), STORE, _americano(shop, 1))
    from tests.delivery_helpers import to_ready

    assert to_ready(shop, STORE, pickup["public_id"])["allowed_actions"] == ["complete", "cancel"]


# ---- 配達員の一連の流れ ----

def test_the_courier_flow_from_assignment_to_a_completed_delivery(client, shop):
    h = shop.user()
    c, other = make_courier(shop, STORE), make_courier(shop, STORE)
    o = ready_delivery(shop, h, STORE, _americano(shop, 3))  # 1,200 + 150
    pid = o["public_id"]
    points_before = _points(shop, h)
    assert client.get("/api/courier/deliveries", headers=c.headers).json() == []  # 割り当て前は何も無い
    assert assign(shop, STORE, pid, c.id).status_code == 200
    mine = client.get("/api/courier/deliveries", headers=c.headers).json()
    assert [d["public_id"] for d in mine] == [pid]
    d = mine[0]
    assert d["status"] == "assigned" and d["allowed_actions"] == ["pickup"] and d["address"] is None and d["pin_attempts_left"] is None  # 住所は集荷の後
    assert d["zone"]["name"] == "居住区" and d["store"]["name"] == "居住区本店" and d["items"] == [{"name": "アメリカーノ", "size": "M", "temperature": "hot", "qty": 3}]
    assert client.get("/api/courier/deliveries", headers=other.headers).json() == []  # 他の配達員には見えない
    assert shop.get_order(h, pid)["delivery"]["pin"] is None  # 集荷の前は、顧客にも暗証コードは見えない
    # 順序: 集荷の前の出発・到着は 409。他の配達員の集荷は 404
    assert code_of(courier_post(shop, c, pid, "depart")) == "invalid_transition"
    assert code_of(courier_post(shop, c, pid, "deliver", {"pin": "0000"})) == "invalid_transition"
    assert code_of(courier_post(shop, c, pid, "fail", {"reason": "absent"})) == "invalid_transition"
    r = courier_post(shop, other, pid, "pickup")
    assert r.status_code == 404 and code_of(r) == "not_found"
    # 集荷: 暗証コードが作られ、顧客に見え始める。住所が配達員に見える
    r = courier_post(shop, c, pid, "pickup")
    assert r.status_code == 200 and r.json()["status"] == "picked_up" and r.json()["allowed_actions"] == ["depart"]
    assert r.json()["address"] == {"label": "自宅", "line": "アルカ市居住区1-4-2 305", "note": None}
    pin = shop.get_order(h, pid)["delivery"]["pin"]
    assert len(pin) == 4 and pin.isdigit()
    staff_view = next(x for x in _board(shop, STORE)["orders"] if x["public_id"] == pid)
    assert pin not in str(staff_view) and "アルカ市居住区1-4-2" not in str(staff_view) and staff_view["delivery"]["status"] == "picked_up"
    row = _delivery_row(shop, pid)
    assert pin not in (row["pin_hash"], row["pin_nonce"]) and len(row["pin_hash"]) == 64 and row["pin_attempts"] == 0 and row["pin_expires_at"] > clock.utc_now()
    assert code_of(courier_post(shop, c, pid, "pickup")) == "invalid_transition"  # 二重の集荷
    # 出発: 到着の目安 = 出発 + 区画の基準の所要（居住区 25 分）
    r = courier_post(shop, c, pid, "depart")
    assert r.status_code == 200 and r.json()["status"] == "delivering" and r.json()["allowed_actions"] == ["deliver", "fail"] and r.json()["pin_attempts_left"] == 5
    order = shop.get_order(h, pid)
    departed = _delivery_row(shop, pid)["departed_at"]
    assert order["status"] == "delivering" and order["delivery"]["eta_at"].startswith((departed + timedelta(minutes=25)).strftime("%Y-%m-%dT%H:%M"))
    # 暗証コードが違えば 422（残りの回数つき）。形の誤りは数えない
    r = courier_post(shop, c, pid, "deliver", {"pin": wrong_pins(pin, 1)[0]})
    assert r.status_code == 422 and code_of(r) == "pin_invalid" and r.json()["detail"]["attempts_left"] == 4
    for bad in ("123", "12345", "12a4", "", " 123", 1234):
        assert courier_post(shop, c, pid, "deliver", {"pin": bad}).status_code == 422
    assert courier_post(shop, c, pid, "deliver", {}).status_code == 422
    assert _delivery_row(shop, pid)["pin_attempts"] == 1
    # 合えば到着・完了（ポイントも付く）
    r = courier_post(shop, c, pid, "deliver", {"pin": pin})
    assert r.status_code == 200 and r.json()["status"] == "completed" and r.json()["allowed_actions"] == []
    final = shop.get_order(h, pid)
    assert final["status"] == "completed" and final["delivery"]["status"] == "delivered" and final["delivery"]["pin"] is None and final["delivery"]["eta_at"] is None
    assert _points(shop, h) == points_before + 1350 // 100
    steps = [(f, t) for f, t, *_ in _events(shop, pid)]
    assert steps[-5:] == [("ready", "assigned"), ("assigned", "picked_up"), ("picked_up", "delivering"), ("delivering", "delivered"), ("delivered", "completed")]
    assert client.get("/api/courier/deliveries", headers=c.headers).json() == []  # 完了したら一覧から消える
    assert code_of(courier_post(shop, c, pid, "deliver", {"pin": pin})) == "invalid_transition"
    # 配達員は、配達先の区画にいることになる（次の提案に使う）
    with shop.db() as conn:
        assert conn.execute("SELECT z.area_code FROM couriers c JOIN delivery_zones z ON z.id = c.zone_id WHERE c.staff_id = %s", (c.id,)).fetchone()["area_code"] == 1
    assert shop.reconcile() == []


def _points(shop, headers) -> int:
    with shop.db() as conn:
        return conn.execute("SELECT loyalty_points FROM users WHERE auth_user_id = %s", (f"dev:{headers['X-Dev-User']}",)).fetchone()["loyalty_points"]


def test_a_courier_cannot_touch_someone_elses_or_another_stores_delivery(client, shop):
    h, order_pin, order, c = _delivering(shop, STORE)
    mine = make_courier(shop, STORE)
    other_store = make_courier(shop, TERMINAL)
    for stranger in (mine, other_store):
        for action, body in (("pickup", None), ("depart", None), ("deliver", {"pin": order_pin}), ("fail", {"reason": "absent"})):
            r = courier_post(shop, stranger, order["public_id"], action, body)
            assert r.status_code == 404 and code_of(r) == "not_found", (action, r.text)
    assert courier_post(shop, c, order["public_id"], "deliver", {"pin": order_pin}).status_code == 200  # 本人はできる（他人の試みで数えられていない）
    # 店頭の注文・無い注文も 404
    pickup = shop.paid_order(shop.user(), STORE, _americano(shop, 1))
    assert courier_post(shop, c, pickup["public_id"], "pickup").status_code == 404
    assert courier_post(shop, c, "ZZZZZZZZ", "pickup").status_code == 404


def _delivering(shop, store, lines=None, **kw):
    h, order, pin, c = delivering_order(shop, store, lines or _americano(shop), **kw)
    return h, pin, order, c


# ---- 暗証コードの凍結・期限 ----

def test_five_wrong_pins_freeze_the_delivery_and_hand_it_back_to_the_store(client, shop):
    h, pin, order, c = _delivering(shop, STORE)
    pid = order["public_id"]
    guesses = wrong_pins(pin, 5)
    for left, guess in zip((4, 3, 2, 1), guesses[:4]):
        r = courier_post(shop, c, pid, "deliver", {"pin": guess})
        assert r.status_code == 422 and code_of(r) == "pin_invalid" and r.json()["detail"]["attempts_left"] == left
        assert client.get("/api/courier/deliveries", headers=c.headers).json()[0]["pin_attempts_left"] == left
    r = courier_post(shop, c, pid, "deliver", {"pin": guesses[4]})
    assert r.status_code == 409 and code_of(r) == "pin_locked"
    got = shop.get_order(h, pid)
    assert got["status"] == "delivery_failed" and got["delivery"]["status"] == "failed" and got["delivery"]["failure_reason"] == "pin_locked" and got["delivery"]["pin"] is None
    row = _delivery_row(shop, pid)
    assert row["pin_attempts"] == 5 and row["status"] == "failed"
    assert _events(shop, pid)[-1] == ("delivering", "delivery_failed", "system", "pin_locked")
    # 正しい暗証コードでも、もう通らない。配達員の一覧からも消え、店には再配達・取消しが出る
    assert code_of(courier_post(shop, c, pid, "deliver", {"pin": pin})) == "invalid_transition"
    assert client.get("/api/courier/deliveries", headers=c.headers).json() == []
    listed = next(x for x in _board(shop, STORE)["orders"] if x["public_id"] == pid)
    assert listed["status"] == "delivery_failed" and listed["allowed_actions"] == ["redeliver", "cancel"] and listed["delivery"]["failure_reason"] == "pin_locked"


def test_parallel_pin_guesses_cannot_exceed_five_attempts(client, shop):
    h, pin, order, c = _delivering(shop, STORE)
    pid = order["public_id"]
    guesses = wrong_pins(pin, 9)
    results = [None] * len(guesses)
    barrier = threading.Barrier(len(guesses))

    def go(i):
        barrier.wait()
        results[i] = courier_post(shop, c, pid, "deliver", {"pin": guesses[i]})

    threads = [threading.Thread(target=go, args=(i,)) for i in range(len(guesses))]
    [t.start() for t in threads]
    [t.join(timeout=60) for t in threads]
    codes = sorted(code_of(r) for r in results)
    assert codes.count("pin_invalid") == 4 and codes.count("pin_locked") == 1 and codes.count("invalid_transition") == 4  # 数えるのは 5 回まで
    assert _delivery_row(shop, pid)["pin_attempts"] == 5


def test_an_expired_pin_is_refused_without_counting(client, shop):
    h, pin, order, c = _delivering(shop, STORE)
    pid = order["public_id"]
    clock.freeze(clock.utc_now() + timedelta(hours=24, minutes=1))  # 集荷から 24 時間を過ぎる
    # スタッフのセッションは 12 時間で切れる。この配達員のセッションの期限だけを延ばす
    # （凍結した時計でログインすると、他のテストが共有する期限切れ扱いのセッションまで掃除されてしまう）
    with shop.db() as conn:
        conn.execute(
            "UPDATE staff_sessions SET expires_at = expires_at + interval '2 days' WHERE staff_id = %s", (c.id,)
        )
    r = courier_post(shop, c, pid, "deliver", {"pin": pin})
    assert r.status_code == 409 and code_of(r) == "pin_expired"
    assert _delivery_row(shop, pid)["pin_attempts"] == 0
    assert shop.get_order(h, pid)["delivery"]["pin"] is None  # 失効した暗証コードは見せない


# ---- 不在・再配達・取消し ----

def test_absence_then_redelivery_moves_the_slot_and_issues_a_new_pin(client, shop):
    h, pin, order, c = _delivering(shop, STORE)
    pid = order["public_id"]
    old_slot = order["delivery"]["slot"]["id"]
    assert slot_booked(shop, old_slot) == 1
    r = courier_post(shop, c, pid, "fail", {"reason": "absent"})
    assert r.status_code == 200 and r.json()["status"] == "delivery_failed" and r.json()["allowed_actions"] == [] and r.json()["address"] is None
    got = shop.get_order(h, pid)
    assert got["status"] == "delivery_failed" and got["delivery"]["failure_reason"] == "absent" and got["delivery"]["status"] == "failed" and got["delivery"]["pin"] is None
    assert _events(shop, pid)[-1] == ("delivering", "delivery_failed", "staff", "absent")
    assert slot_booked(shop, old_slot) == 1  # 再配達か取消しが決まるまでは、枠を持ったまま
    assert code_of(courier_post(shop, c, pid, "fail", {"reason": "absent"})) == "invalid_transition"
    old_nonce = _delivery_row(shop, pid)["pin_nonce"]
    # 店が再配達にする: 新しい枠（指定）・古い枠が戻る・担当と暗証コードが外れる
    new_slot_id = new_slot(shop, STORE, ahead_minutes=300)
    r = shop.client.post(f"/api/staff/orders/{pid}/redeliver", json={"slot_id": new_slot_id}, headers=shop.staff(STORE))
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ready" and body["delivery"]["status"] == "pending" and body["delivery"]["attempt"] == 2 and body["delivery"]["slot"]["id"] == new_slot_id
    assert body["delivery"]["courier"] is None and body["delivery"]["failure_reason"] is None and body["allowed_actions"] == ["assign", "cancel"]
    assert slot_booked(shop, old_slot) == 0 == active_in_slot(shop, old_slot)
    assert slot_booked(shop, new_slot_id) == 1 == active_in_slot(shop, new_slot_id)
    assert _events(shop, pid)[-1] == ("delivery_failed", "ready", "staff", "redelivery")
    row = _delivery_row(shop, pid)
    assert row["courier_id"] is None and row["pin_hash"] is None and row["pin_nonce"] is None and row["pin_attempts"] == 0 and row["failure_reason"] is None
    # もう一度、割り当て → 集荷（新しい暗証コード）→ 出発 → 到着
    assert assign(shop, STORE, pid, c.id).status_code == 200
    assert courier_post(shop, c, pid, "pickup").status_code == 200
    new_pin = shop.get_order(h, pid)["delivery"]["pin"]
    assert len(new_pin) == 4 and _delivery_row(shop, pid)["pin_nonce"] != old_nonce
    assert courier_post(shop, c, pid, "depart").status_code == 200
    assert courier_post(shop, c, pid, "deliver", {"pin": new_pin}).json()["status"] == "completed"
    assert shop.get_order(h, pid)["delivery"]["attempt"] == 2


def test_redelivery_without_a_slot_picks_the_earliest_and_is_limited(client, shop):
    h, pin, order, c = _delivering(shop, STORE)
    pid = order["public_id"]
    staff = shop.staff(STORE)
    assert code_of(shop.client.post(f"/api/staff/orders/{pid}/redeliver", headers=staff)) == "invalid_transition"  # まだ不在ではない
    assert courier_post(shop, c, pid, "fail", {"reason": "cannot_receive"}).status_code == 200
    assert shop.client.post(f"/api/staff/orders/{pid}/redeliver", headers=shop.staff(ROCK)).status_code == 404  # 他店
    other_store_slot = new_slot(shop, ROCK)
    r = shop.client.post(f"/api/staff/orders/{pid}/redeliver", json={"slot_id": other_store_slot}, headers=staff)
    assert r.status_code == 404 and code_of(r) == "slot_not_found"
    r = shop.client.post(f"/api/staff/orders/{pid}/redeliver", json={"slot_id": new_slot(shop, STORE, ahead_minutes=10)}, headers=staff)
    assert r.status_code == 409 and code_of(r) == "slot_cutoff"
    r = shop.client.post(f"/api/staff/orders/{pid}/redeliver", json={"slot_id": new_slot(shop, STORE, capacity=1, booked=1)}, headers=staff)
    assert r.status_code == 409 and code_of(r) == "slot_full"
    assert shop.get_order(h, pid)["status"] == "delivery_failed"  # 失敗した試みは何も変えない
    old_slot = order["delivery"]["slot"]["id"]
    assert slot_booked(shop, old_slot) == 1
    r = shop.client.post(f"/api/staff/orders/{pid}/redeliver", headers=staff)  # 本文なし = 最も早い枠
    assert r.status_code == 200 and r.json()["status"] == "ready"
    chosen = r.json()["delivery"]["slot"]
    from datetime import datetime

    assert datetime.fromisoformat(chosen["starts_at"].replace("Z", "+00:00")) - clock.utc_now() >= timedelta(minutes=45)  # 締めの前の枠
    assert slot_booked(shop, chosen["id"]) == active_in_slot(shop, chosen["id"]) >= 1
    # 区画が砂嵐なら再配達できない
    h2, _, order2, c2 = _delivering(shop, STORE)
    courier_post(shop, c2, order2["public_id"], "fail", {"reason": "other"})
    zone = next(z for z in client.get("/api/delivery/zones").json() if z["area_code"] == 1)
    try:
        assert client.put(f"/api/staff/zones/{zone['id']}/suspension", json={"suspended": True}, headers=shop.staff(None)).status_code == 200
        r = shop.client.post(f"/api/staff/orders/{order2['public_id']}/redeliver", headers=staff)
        assert r.status_code == 409 and code_of(r) == "zone_suspended"
    finally:
        client.put(f"/api/staff/zones/{zone['id']}/suspension", json={"suspended": False}, headers=shop.staff(None))


def test_cancelling_after_a_failed_delivery_refunds_and_returns_the_slot(client, shop):
    h, pin, order, c = _delivering(shop, STORE)
    pid = order["public_id"]
    slot = order["delivery"]["slot"]["id"]
    assert shop.act(shop.staff(STORE), pid, "cancel", "取消し").status_code == 409  # 配達中（集荷後）は、店でも取り消せない
    courier_post(shop, c, pid, "fail", {"reason": "absent"})
    r = shop.act(shop.staff(STORE), pid, "cancel", "お客さまと連絡が取れない")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    got = shop.get_order(h, pid)
    assert got["status"] == "cancelled" and got["payment"]["status"] == "refunded" and got["delivery"]["status"] == "cancelled"
    assert slot_booked(shop, slot) == 0 == active_in_slot(shop, slot)
    assert client.get("/api/courier/deliveries", headers=c.headers).json() == []


def test_staff_can_cancel_an_assigned_order_before_pickup(client, shop):
    h = shop.user()
    c = make_courier(shop, STORE)
    o = ready_delivery(shop, h, STORE, _americano(shop))
    assign(shop, STORE, o["public_id"], c.id)
    slot = o["delivery"]["slot"]["id"]
    r = shop.act(shop.staff(STORE), o["public_id"], "cancel", "配達員の事故")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert client.get("/api/courier/deliveries", headers=c.headers).json() == [] and slot_booked(shop, slot) == 0
    assert shop.get_order(h, o["public_id"])["delivery"]["status"] == "cancelled"
    # 取り消した注文には、もう何もできない
    assert courier_post(shop, c, o["public_id"], "pickup").status_code == 409


def test_a_failure_reason_must_be_one_of_the_fixed_codes(client, shop):
    h, pin, order, c = _delivering(shop, STORE)
    for body in ({"reason": "自由記述"}, {"reason": "pin_locked"}, {}, {"reason": "absent", "note": "x"}):
        assert courier_post(shop, c, order["public_id"], "fail", body).status_code == 422
    assert shop.get_order(h, order["public_id"])["status"] == "delivering"


# ---- 砂嵐 ----

def test_only_a_manager_can_raise_or_lift_a_storm_warning(client, shop):
    zone = next(z for z in client.get("/api/delivery/zones").json() if z["area_code"] == 2)
    path = f"/api/staff/zones/{zone['id']}/suspension"
    courier = make_courier(shop, STORE)
    for headers in (shop.staff(STORE), courier.headers):
        r = client.put(path, json={"suspended": True}, headers=headers)
        assert r.status_code == 403 and code_of(r) == "forbidden"
    assert client.put(path, json={"suspended": True}).status_code == 401
    assert client.put(path, json={"suspended": True}, headers=shop.user()).status_code == 401
    assert next(z for z in client.get("/api/delivery/zones").json() if z["id"] == zone["id"])["is_suspended"] is False  # 何も変わっていない
    r = client.put("/api/staff/zones/999999/suspension", json={"suspended": True}, headers=shop.staff(None))
    assert r.status_code == 404 and code_of(r) == "zone_not_found"
    assert client.put(path, json={"suspended": "yes-please"}, headers=shop.staff(None)).status_code == 422
    try:
        r = client.put(path, json={"suspended": True}, headers=shop.staff(None))
        assert r.status_code == 200 and r.json()["is_suspended"] is True
        with shop.db() as conn:
            assert conn.execute("SELECT suspended_at FROM delivery_zones WHERE id = %s", (zone["id"],)).fetchone()["suspended_at"] is not None
    finally:
        r = client.put(path, json={"suspended": False}, headers=shop.staff(None))
    assert r.json()["is_suspended"] is False
    with shop.db() as conn:
        assert conn.execute("SELECT suspended_at FROM delivery_zones WHERE id = %s", (zone["id"],)).fetchone()["suspended_at"] is None


def test_a_storm_does_not_cancel_orders_that_already_hold_a_slot(client, shop):
    h = shop.user()
    o = ready_delivery(shop, h, STORE, _americano(shop))
    zone = next(z for z in client.get("/api/delivery/zones").json() if z["area_code"] == 1)
    try:
        client.put(f"/api/staff/zones/{zone['id']}/suspension", json={"suspended": True}, headers=shop.staff(None))
        assert shop.get_order(h, o["public_id"])["status"] == "ready"
        c = make_courier(shop, STORE)
        assert assign(shop, STORE, o["public_id"], c.id).status_code == 200  # 確保済みの注文は、そのまま進められる
    finally:
        client.put(f"/api/staff/zones/{zone['id']}/suspension", json={"suspended": False}, headers=shop.staff(None))


# ---- 模擬の配達 ----

def test_mock_advance_steps_a_delivery_to_completion(client, shop):
    h = shop.user()
    o = ready_delivery(shop, h, STORE, _americano(shop))
    pid = o["public_id"]
    staff = shop.staff(STORE)
    seen = []
    for _ in range(4):
        r = client.post(f"/api/staff/orders/{pid}/mock-advance", headers=staff)
        assert r.status_code == 200, r.text
        seen.append(r.json()["status"])
    assert seen == ["assigned", "picked_up", "delivering", "completed"]
    got = shop.get_order(h, pid)
    assert got["status"] == "completed" and got["delivery"]["courier"]["name"] and got["delivery"]["status"] == "delivered"
    assert [(f, t, a) for f, t, a, _ in _events(shop, pid)][-5:] == [
        ("ready", "assigned", "system"), ("assigned", "picked_up", "system"), ("picked_up", "delivering", "system"),
        ("delivering", "delivered", "system"), ("delivered", "completed", "system")]
    r = client.post(f"/api/staff/orders/{pid}/mock-advance", headers=staff)
    assert r.status_code == 409 and code_of(r) == "invalid_transition"


def test_mock_advance_needs_a_courier_and_the_mock_provider(client, shop, monkeypatch):
    o = ready_delivery(shop, shop.user(), ROCK, _americano(shop), area=3)
    saved = _set_on_duty(shop, ROCK, False)
    try:
        r = client.post(f"/api/staff/orders/{o['public_id']}/mock-advance", headers=shop.staff(ROCK))
        assert r.status_code == 409 and code_of(r) == "no_courier_available"
    finally:
        _restore_duty(shop, saved)
    monkeypatch.setenv("DELIVERY_PROVIDER", "inhouse")  # 人が動かす配達では、模擬の操作を許さない
    r = client.post(f"/api/staff/orders/{o['public_id']}/mock-advance", headers=shop.staff(ROCK))
    assert r.status_code == 409 and code_of(r) == "mock_only"
    assert _board(shop, ROCK)["provider"] == "inhouse"
    pickup = shop.paid_order(shop.user(), STORE, _americano(shop, 1))
    monkeypatch.setenv("DELIVERY_PROVIDER", "mock")
    assert code_of(client.post(f"/api/staff/orders/{pickup['public_id']}/mock-advance", headers=shop.staff(STORE))) == "invalid_transition"  # 店頭の注文
    monkeypatch.setenv("DELIVERY_PROVIDER", "carrier-pigeon")  # 許さない値は、黙って別の値にしない
    import pytest

    with pytest.raises(RuntimeError):
        dispatch.delivery.check_startup()


def test_the_worker_autopilot_is_off_by_default_and_steps_by_elapsed_time(client, shop, monkeypatch):
    c = make_courier(shop, STORE)
    h = shop.user()
    o = ready_delivery(shop, h, STORE, _americano(shop))
    pid = o["public_id"]
    assert assign(shop, STORE, pid, c.id).status_code == 200
    assigned_at = _delivery_row(shop, pid)["assigned_at"]
    assert dispatch.mock_tick(assigned_at + timedelta(hours=1)) == 0  # 既定は off（何も進めない）
    assert shop.get_order(h, pid)["status"] == "assigned"
    monkeypatch.setenv("DELIVERY_MOCK_AUTOPILOT", "on")
    monkeypatch.setenv("DELIVERY_MOCK_STEP_SECONDS", "30")
    dispatch.mock_tick(assigned_at + timedelta(seconds=10))  # まだ 30 秒たっていない
    assert shop.get_order(h, pid)["status"] == "assigned"
    t1 = assigned_at + timedelta(seconds=31)
    assert dispatch.mock_tick(t1) >= 1 and shop.get_order(h, pid)["status"] == "picked_up"
    dispatch.mock_tick(t1 + timedelta(seconds=10))
    assert shop.get_order(h, pid)["status"] == "picked_up"  # 一度に 1 歩だけ。前の変化から 30 秒
    clock.freeze(t1 + timedelta(seconds=31))
    dispatch.mock_tick(t1 + timedelta(seconds=31))
    assert shop.get_order(h, pid)["status"] == "delivering"
    t3 = t1 + timedelta(seconds=31) + timedelta(seconds=31)
    clock.freeze(t3)
    dispatch.mock_tick(t3)
    final = shop.get_order(h, pid)
    assert final["status"] == "completed" and final["delivery"]["status"] == "delivered"
    monkeypatch.setenv("DELIVERY_PROVIDER", "inhouse")
    assert dispatch.mock_tick(t3 + timedelta(days=1)) == 0  # mock 以外では動かない
    clock.freeze(None)
    from app import worker

    assert isinstance(worker.run_once(), int)  # worker の巡回が、宅配の進行を呼んでも壊れない（int を返す）


def test_pickup_orders_are_unaffected_by_the_delivery_states(client, shop):
    """P1 の店頭の流れが、宅配の遷移を足しても変わらない（accept → start → ready → complete）。宅配の遷移は、店頭の注文に使えない。"""
    h = shop.user()
    o = shop.paid_order(h, STORE, _americano(shop, 1))
    staff = shop.staff(STORE)
    for action, status in (("accept", "accepted"), ("start", "preparing"), ("ready", "ready"), ("complete", "completed")):
        assert shop.act(staff, o["public_id"], action).json()["status"] == status
    got = shop.get_order(h, o["public_id"])
    assert got["fulfillment"] == "pickup" and got["delivery"] is None
    assert orders.TRANSITIONS[("ready", "completed")] == frozenset({"staff"})  # 店頭の完了は、店だけ（P1 のまま）
    assert code_of(assign(shop, STORE, o["public_id"], make_courier(shop, STORE).id)) == "invalid_transition"  # 店頭の注文に、配車の操作は使えない

"""注文の確定・支払い・取消し・状態遷移・権限・期限切れ・ポイント（docs/api.md「注文」「スタッフ」、docs/order-flow.md）。"""

import re
import threading
import uuid
from datetime import timedelta

from app import clock, orders, worker
from tests.helpers import code_of

STORE = "residential-main"
EXPIRY_STORE = "terminal-east"  # 時計を進める（他のテストの未払いの確保も一緒に戻る）テスト専用の店。残高を、他のテストに影響されずに比べるため


def _lines(shop, *pairs):
    return [(shop.variant(*variant), qty) for variant, qty in pairs]


def test_place_order_creates_a_placed_order_and_reserves_stock(client, shop):
    h = shop.user()
    before = shop.balance(STORE, "coffee-beans")
    lines = _lines(shop, (("oasis-blend", "M", "hot"), 2), (("hot-sandwich",), 1))
    p = shop.proposal(h, STORE, lines)
    r = shop.place(h, p["id"])
    assert r.status_code == 201
    o = r.json()
    assert o["status"] == "placed" and o["fulfillment"] == "pickup" and o["store"]["name"] == "居住区本店"
    assert re.fullmatch(r"[A-HJ-NP-Z2-9]{8}", o["public_id"]) and o["pickup_no"] >= 1
    assert o["subtotal_lumi"] == 450 * 2 + 520 and o["total_lumi"] == o["subtotal_lumi"] and o["delivery_fee_lumi"] == 0
    assert [i["name"] for i in o["items"]] == ["オアシスブレンド", "ホットサンド"]
    assert o["payment"] == {"provider": "mock", "status": "pending"} and o["can_pay"] is True and o["can_cancel"] is True
    assert o["reservation_expires_at"].endswith("Z") and o["events"][0]["to_status"] == "placed" and o["events"][0]["actor_type"] == "customer"
    # 在庫: 豆 18 g × 2 を確保（on_hand はそのまま、reserved が増える）
    on_hand, reserved_after = shop.balance(STORE, "coffee-beans")
    assert on_hand == before[0] and reserved_after == before[1] + 36
    assert [(m["code"], m["kind"], m["qty"]) for m in shop.movements(o["public_id"])] == [
        ("coffee-beans", "reserve", 36), ("cup-m", "reserve", 2), ("hot-sandwich", "reserve", 1),
    ]
    # カートは空になり、提案は使用済み
    assert client.get("/api/cart", headers=h).json()["lines"] == []
    assert client.get("/api/orders", headers=h).json()[0]["public_id"] == o["public_id"]


def test_pickup_numbers_count_up_per_store_and_day(client, shop):
    nums = []
    for _ in range(3):
        nums.append(shop.order(shop.user(), "rock-plaza", _lines(shop, (("americano", "S", "hot"), 1)))["pickup_no"])
    assert nums == list(range(nums[0], nums[0] + 3))
    other = shop.order(shop.user(), "rock-school", _lines(shop, (("americano", "S", "hot"), 1)))
    assert other["pickup_no"] >= 1  # 店ごとの連番（別の店は別の数列）


def test_idempotent_double_submit_creates_one_order(client, shop):
    """(a) 同じ冪等キーの二重送信で注文は 1 件（同じ応答）。キーが同じで本文が違えば 422。"""
    h = shop.user()
    p = shop.proposal(h, STORE, _lines(shop, (("hot-sandwich",), 1)))
    key = f"key-{uuid.uuid4().hex}"
    r1, r2 = shop.place(h, p["id"], key), shop.place(h, p["id"], key)
    assert (r1.status_code, r2.status_code) == (201, 200)
    assert r1.json() == r2.json()
    assert len(client.get("/api/orders", headers=h).json()) == 1
    assert len(shop.movements(r1.json()["public_id"])) == 1  # 確保（ホットサンド 1 個。カップは使わない）の行が二重にならない
    r3 = shop.place(h, str(uuid.uuid4()), key)  # 同じキー・違う本文
    assert r3.status_code == 422 and code_of(r3) == "idempotency_conflict"
    # 別の利用者の同じキーは、別のもの
    other = shop.user()
    p2 = shop.proposal(other, STORE, _lines(shop, (("hot-sandwich",), 1)))
    assert shop.place(other, p2["id"], key).status_code == 201


def test_idempotency_key_must_be_8_to_64_chars(client, shop):
    h = shop.user()
    p = shop.proposal(h, STORE, _lines(shop, (("hot-sandwich",), 1)))
    for key in ("short", "x" * 65, "has space in it"):
        assert client.post("/api/orders", json={"proposal_id": p["id"]}, headers={**h, "Idempotency-Key": key}).status_code == 422
    assert client.post("/api/orders", json={"proposal_id": p["id"]}, headers=h).status_code == 422  # 必須
    assert client.post("/api/orders", json={"proposal_id": "not-a-uuid"}, headers={**h, "Idempotency-Key": "k" * 8}).status_code == 422
    assert shop.place(h, p["id"], "k" * 64).status_code == 201


def test_same_key_in_parallel_creates_one_order(client, shop):
    h = shop.user()
    p = shop.proposal(h, STORE, _lines(shop, (("hot-sandwich",), 1)))
    key = f"key-{uuid.uuid4().hex}"
    results, barrier = [], threading.Barrier(2)

    def go():
        barrier.wait()
        results.append(shop.place(h, p["id"], key))

    threads = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(r.status_code for r in results) == [200, 201]
    assert results[0].json()["public_id"] == results[1].json()["public_id"]
    assert len(client.get("/api/orders", headers=h).json()) == 1


def test_pay_ok_makes_the_order_paid_and_clears_the_expiry(client, shop):
    h = shop.user()
    o = shop.order(h, STORE, _lines(shop, (("cheesecake",), 1)))
    r = client.post(f"/api/orders/{o['public_id']}/pay", headers=h)
    assert r.status_code == 200
    paid = r.json()
    assert paid["status"] == "paid" and paid["payment"]["status"] == "paid" and paid["reservation_expires_at"] is None
    assert paid["can_pay"] is False and paid["can_cancel"] is True
    assert [e["to_status"] for e in paid["events"]] == ["placed", "paid"]
    # 二重に払えない
    r = client.post(f"/api/orders/{o['public_id']}/pay", json={"simulate": "ok"}, headers=h)
    assert r.status_code == 409 and code_of(r) == "invalid_transition"
    assert client.post(f"/api/orders/{o['public_id']}/pay", json={"simulate": "nope"}, headers=h).status_code == 422


def test_declined_payment_cancels_the_order_and_returns_the_reservation(client, shop):
    """(d)"""
    h = shop.user()
    before = shop.balance(STORE, "cheesecake")
    o = shop.order(h, STORE, _lines(shop, (("cheesecake",), 2)))
    assert shop.balance(STORE, "cheesecake")[1] == before[1] + 2
    r = client.post(f"/api/orders/{o['public_id']}/pay", json={"simulate": "decline"}, headers=h)
    assert r.status_code == 402 and code_of(r) == "payment_declined"
    after = shop.get_order(h, o["public_id"])
    assert after["status"] == "cancelled" and after["cancel_reason"] == "payment_declined" and after["payment"]["status"] == "failed"
    assert after["events"][-1]["actor_type"] == "system" and after["can_pay"] is False and after["can_cancel"] is False
    assert shop.balance(STORE, "cheesecake") == before  # 確保が戻った
    assert [(m["kind"], m["qty"]) for m in shop.movements(o["public_id"])] == [("reserve", 2), ("release", -2)]
    assert shop.reconcile() == []


def test_customer_cancel_before_payment_releases_and_after_payment_refunds(client, shop):
    """(e)"""
    h = shop.user()
    before = shop.balance(STORE, "gateau-chocolat")
    o = shop.order(h, STORE, _lines(shop, (("gateau-chocolat",), 1)))
    r = client.post(f"/api/orders/{o['public_id']}/cancel", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "cancelled" and r.json()["cancel_reason"] == "customer_request"
    assert shop.balance(STORE, "gateau-chocolat") == before
    assert code_of(client.post(f"/api/orders/{o['public_id']}/cancel", headers=h)) == "not_cancellable"  # もう取り消せない
    # 支払い済み → 取消しで返金
    paid = shop.paid_order(h, STORE, _lines(shop, (("gateau-chocolat",), 1)))
    r = client.post(f"/api/orders/{paid['public_id']}/cancel", headers=h)
    assert r.json()["status"] == "cancelled" and r.json()["payment"]["status"] == "refunded"
    assert shop.balance(STORE, "gateau-chocolat") == before
    assert shop.reconcile() == []


def test_customer_cannot_cancel_after_acceptance(client, shop):
    h, staff = shop.user(), shop.staff(STORE)
    o = shop.paid_order(h, STORE, _lines(shop, (("cheesecake",), 1)))
    assert shop.act(staff, o["public_id"], "accept").status_code == 200
    r = client.post(f"/api/orders/{o['public_id']}/cancel", headers=h)
    assert r.status_code == 409 and code_of(r) == "not_cancellable"


def test_full_pickup_flow_consumes_stock_and_awards_points_once(client, shop):
    """(i)(p) 注文 → 支払い → 受付 → 調理開始（消費）→ 準備完了 → 受け渡し（ポイント 1 回）。"""
    h, staff = shop.user(), shop.staff(STORE)
    beans_before = shop.balance(STORE, "coffee-beans")
    o = shop.paid_order(h, STORE, _lines(shop, (("oasis-blend", "M", "hot"), 2)))  # 900 ルミ → 9 点
    pid = o["public_id"]
    assert [a for a in shop.act(staff, pid, "accept").json()["allowed_actions"]] == ["start", "cancel"]
    started = shop.act(staff, pid, "start").json()
    assert started["status"] == "preparing" and started["allowed_actions"] == ["ready", "cancel"]
    # 消費: on_hand と reserved の両方から引く
    assert shop.balance(STORE, "coffee-beans") == (beans_before[0] - 36, beans_before[1])
    assert shop.reconcile() == []
    assert shop.act(staff, pid, "ready").json()["status"] == "ready"
    done = shop.act(staff, pid, "complete").json()
    assert done["status"] == "completed" and done["allowed_actions"] == []
    assert [e["to_status"] for e in done["events"]] == ["placed", "paid", "accepted", "preparing", "ready", "completed"]
    assert shop.get_order(h, pid)["status"] == "completed"
    with shop.db() as conn:
        user = conn.execute("SELECT id, loyalty_points FROM users WHERE auth_user_id = %s", (f"dev:{h['X-Dev-User']}",)).fetchone()
        ledger = conn.execute("SELECT points, kind FROM loyalty_ledger WHERE user_id = %s", (user["id"],)).fetchall()
    assert user["loyalty_points"] == 9 and ledger == [{"points": 9, "kind": "earn"}]
    # 二重に付かない: もう一度 complete は 409、台帳の部分 UNIQUE も 2 回目の earn を通さない
    assert shop.act(staff, pid, "complete").status_code == 409
    with shop.db() as conn:
        with conn.transaction():
            orders._award_points(conn, {"id": _order_id(shop, pid), "user_id": user["id"], "total_lumi": 900}, clock.utc_now())
        assert conn.execute("SELECT loyalty_points FROM users WHERE id = %s", (user["id"],)).fetchone()["loyalty_points"] == 9


def _order_id(shop, public_id):
    with shop.db() as conn:
        return conn.execute("SELECT id FROM orders WHERE public_id = %s", (public_id,)).fetchone()["id"]


def test_points_are_floor_of_total_over_100(client, shop):
    h, staff = shop.user(), shop.staff(STORE)
    o = shop.paid_order(h, STORE, _lines(shop, (("black-tea", "S", "hot"), 1)))  # 300 ルミ → 3 点
    for action in ("accept", "start", "ready", "complete"):
        assert shop.act(staff, o["public_id"], action).status_code == 200
    with shop.db() as conn:
        pts = conn.execute("SELECT loyalty_points FROM users WHERE auth_user_id = %s", (f"dev:{h['X-Dev-User']}",)).fetchone()["loyalty_points"]
    assert pts == 3


def test_staff_cancel_after_start_refunds_but_returns_no_stock(client, shop):
    """(e) 準備後の取消しは、確保が consumed なので何も戻さない。理由は必須。"""
    h, staff = shop.user(), shop.staff(STORE)
    o = shop.paid_order(h, STORE, _lines(shop, (("americano", "M", "hot"), 1)))
    for action in ("accept", "start"):
        shop.act(staff, o["public_id"], action)
    on_hand_after_start = shop.balance(STORE, "cup-m")
    r = shop.act(staff, o["public_id"], "cancel")
    assert r.status_code == 422 and code_of(r) == "reason_required"
    r = shop.act(staff, o["public_id"], "cancel", "   ")
    assert r.status_code == 422 and code_of(r) == "reason_required"
    r = shop.act(staff, o["public_id"], "cancel", "材料の不良")
    assert r.status_code == 200 and r.json()["status"] == "cancelled" and r.json()["cancel_reason"] == "材料の不良"
    assert shop.balance(STORE, "cup-m") == on_hand_after_start
    assert [m["kind"] for m in shop.movements(o["public_id"])] == ["reserve", "reserve", "consume", "consume"]
    assert shop.get_order(h, o["public_id"])["payment"]["status"] == "refunded"
    assert shop.reconcile() == []


def test_staff_cancel_before_start_releases_the_reservation(client, shop):
    h, staff = shop.user(), shop.staff(STORE)
    before = shop.balance(STORE, "meat-pie")
    o = shop.paid_order(h, STORE, _lines(shop, (("meat-pie",), 3)))
    shop.act(staff, o["public_id"], "accept")
    assert shop.act(staff, o["public_id"], "cancel", "店の都合").status_code == 200
    assert shop.balance(STORE, "meat-pie") == before
    assert shop.get_order(h, o["public_id"])["payment"]["status"] == "refunded"


def test_invalid_transitions_are_409(client, shop):
    """(f)"""
    h, staff = shop.user(), shop.staff(STORE)
    o = shop.paid_order(h, STORE, _lines(shop, (("cheesecake",), 1)))
    pid = o["public_id"]
    for action in ("start", "ready", "complete"):  # accepted になる前
        r = shop.act(staff, pid, action)
        assert r.status_code == 409 and code_of(r) == "invalid_transition", action
    assert shop.act(staff, pid, "accept").status_code == 200
    assert shop.act(staff, pid, "accept").status_code == 409  # 二重の受付
    assert shop.act(staff, pid, "complete").status_code == 409  # preparing・ready を飛ばせない
    # placed のうちは、店は何もできない（支払い前の注文）
    placed = shop.order(shop.user(), STORE, _lines(shop, (("cheesecake",), 1)))
    for action in ("accept", "cancel"):
        assert shop.act(staff, placed["public_id"], action, "x").status_code == 409
    # 終わった注文は動かせない
    assert client.post(f"/api/orders/{placed['public_id']}/cancel", headers=_owner(shop, placed)).status_code == 200
    assert shop.act(staff, placed["public_id"], "accept").status_code == 409
    assert client.post("/api/staff/orders/XXXXXXXX/transition", json={"action": "fly"}, headers=staff).status_code == 422


def _owner(shop, order):
    with shop.db() as conn:
        name = conn.execute(
            "SELECT u.auth_user_id FROM users u JOIN orders o ON o.user_id = u.id WHERE o.public_id = %s", (order["public_id"],)
        ).fetchone()["auth_user_id"]
    return {"X-Dev-User": name.removeprefix("dev:")}


def test_other_customers_orders_are_404(client, shop):
    """(g) 他人の注文は、見る・払う・取り消すのどれも 404（存在を教えない）。"""
    a, b = shop.user(), shop.user()
    o = shop.order(a, STORE, _lines(shop, (("cheesecake",), 1)))
    pid = o["public_id"]
    assert client.get(f"/api/orders/{pid}", headers=b).status_code == 404
    assert client.post(f"/api/orders/{pid}/pay", headers=b).status_code == 404
    assert client.post(f"/api/orders/{pid}/cancel", headers=b).status_code == 404
    assert client.get("/api/orders", headers=b).json() == []
    assert client.get("/api/orders/NOSUCHID", headers=a).status_code == 404
    assert shop.get_order(a, pid)["status"] == "placed"  # 触られていない


def test_staff_only_see_their_own_store_and_the_manager_sees_all(client, shop):
    """(g)"""
    h = shop.user()
    o_main = shop.paid_order(h, "residential-main", _lines(shop, (("cheesecake",), 1)))
    o_west = shop.paid_order(shop.user(), "terminal-west", _lines(shop, (("cheesecake",), 1)))
    main_staff, west_staff, manager = shop.staff("residential-main"), shop.staff("terminal-west"), shop.staff(None)
    listed = {o["public_id"] for o in client.get("/api/staff/orders", headers=main_staff).json()}
    assert o_main["public_id"] in listed and o_west["public_id"] not in listed
    # 他店の注文は、遷移も 404
    assert shop.act(main_staff, o_west["public_id"], "accept").status_code == 404
    assert shop.act(west_staff, o_main["public_id"], "accept").status_code == 404
    assert shop.act(west_staff, o_west["public_id"], "accept").status_code == 200
    # 他店を指定した一覧も 404
    assert client.get(f"/api/staff/orders?store_id={shop.store_id('terminal-west')}", headers=main_staff).status_code == 404
    # 店長は全店。store_id で絞れる
    all_listed = {o["public_id"] for o in client.get("/api/staff/orders?status=paid,accepted", headers=manager).json()}
    assert {o_main["public_id"], o_west["public_id"]} <= all_listed
    only_west = client.get(f"/api/staff/orders?status=paid,accepted&store_id={shop.store_id('terminal-west')}", headers=manager).json()
    assert o_west["public_id"] in {o["public_id"] for o in only_west} and o_main["public_id"] not in {o["public_id"] for o in only_west}
    assert shop.act(manager, o_main["public_id"], "accept").status_code == 200


def test_staff_order_list_shape_hides_customer_data(client, shop):
    h = shop.user()
    o = shop.paid_order(h, STORE, _lines(shop, (("cheesecake",), 1)))
    rows = client.get("/api/staff/orders", headers=shop.staff(STORE)).json()
    mine = next(r for r in rows if r["public_id"] == o["public_id"])
    assert mine["allowed_actions"] == ["accept", "cancel"] and "payment" not in mine
    assert not ({"user_id", "name", "email", "display_name"} & set(mine))
    assert h["X-Dev-User"] not in str(mine)
    # 古い順
    times = [r["placed_at"] for r in rows]
    assert times == sorted(times)
    assert client.get("/api/staff/orders?status=bogus", headers=shop.staff(STORE)).status_code == 422
    assert client.get("/api/staff/orders").status_code == 401


def test_stale_reservation_is_returned_lazily_on_read(client, shop):
    """(c) 期限（15 分）を過ぎた placed の注文は、読み取りで cancelled（payment_timeout・system）になり、確保が戻る。"""
    h = shop.user()
    before = shop.balance(EXPIRY_STORE, "cheesecake")
    o = shop.order(h, EXPIRY_STORE, _lines(shop, (("cheesecake",), 2)))
    assert shop.balance(EXPIRY_STORE, "cheesecake")[1] == before[1] + 2
    clock.freeze(clock.utc_now() + timedelta(minutes=14))
    assert shop.get_order(h, o["public_id"])["status"] == "placed"  # まだ
    clock.freeze(clock.utc_now() + timedelta(minutes=2))
    after = shop.get_order(h, o["public_id"])
    assert after["status"] == "cancelled" and after["cancel_reason"] == "payment_timeout"
    assert after["events"][-1]["actor_type"] == "system" and after["events"][-1]["reason"] == "payment_timeout"
    assert after["payment"]["status"] == "failed" and after["reservation_expires_at"] is None
    assert shop.balance(EXPIRY_STORE, "cheesecake") == before
    assert [(m["kind"], m["qty"]) for m in shop.movements(o["public_id"])] == [("reserve", 2), ("release", -2)]
    assert shop.reconcile() == []


def test_worker_run_once_returns_expired_reservations(client, shop):
    h = shop.user()
    before = shop.balance(EXPIRY_STORE, "cheesecake")
    o = shop.order(h, EXPIRY_STORE, _lines(shop, (("cheesecake",), 1)))
    # expires_at を過去にして、worker の 1 巡で戻す
    with shop.db() as conn:
        conn.execute("UPDATE stock_reservations SET expires_at = %s WHERE order_id = %s", (clock.utc_now() - timedelta(seconds=1), _order_id(shop, o["public_id"])))
    assert worker.run_once() >= 1  # 他のテストの未払いの注文が期限切れなら、それも戻る（>= 1）
    row = shop.get_order(h, o["public_id"])
    assert row["status"] == "cancelled" and row["cancel_reason"] == "payment_timeout"
    assert len([e for e in row["events"] if e["to_status"] == "cancelled"]) == 1
    assert shop.balance(EXPIRY_STORE, "cheesecake") == before


def test_paid_orders_do_not_expire(client, shop):
    h = shop.user()
    o = shop.paid_order(h, STORE, _lines(shop, (("cheesecake",), 1)))
    clock.freeze(clock.utc_now() + timedelta(hours=2))
    assert shop.get_order(h, o["public_id"])["status"] == "paid"


def test_pay_after_the_reservation_expired_is_409_and_cancels(client, shop):
    h = shop.user()
    before = shop.balance(EXPIRY_STORE, "cheesecake")
    o = shop.order(h, EXPIRY_STORE, _lines(shop, (("cheesecake",), 1)))
    clock.freeze(clock.utc_now() + timedelta(minutes=16))
    r = client.post(f"/api/orders/{o['public_id']}/pay", headers=h)
    assert r.status_code == 409 and code_of(r) == "reservation_expired"
    after = shop.get_order(h, o["public_id"])
    assert after["status"] == "cancelled" and after["cancel_reason"] == "payment_timeout"
    assert shop.balance(EXPIRY_STORE, "cheesecake") == before
    assert code_of(client.post(f"/api/orders/{o['public_id']}/pay", headers=h)) == "reservation_expired"  # 繰り返しても同じ


def test_sold_out_item_is_refused_with_its_name_and_nothing_is_reserved(client, shop):
    store = "terminal-west"
    shop.set_available(store, "gateau-chocolat", 3)  # seed の少量在庫（発着場西口店のガトーショコラ 3 個）と同じ状態
    h = shop.user()
    shop.fill_cart(h, store, [(shop.variant("gateau-chocolat"), 4), (shop.variant("cheesecake"), 1)])
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and code_of(r) == "sold_out" and r.json()["detail"]["item_name"] == "ガトーショコラ"
    cart = client.get("/api/cart", headers=h).json()
    assert [(line["name"], line["available"], line["unavailable_reason"]) for line in cart["lines"]] == [("ガトーショコラ", False, "sold_out"), ("チーズケーキ", True, None)]
    client.put(f"/api/cart/items/{shop.variant('gateau-chocolat')}", json={"qty": 3}, headers=h)
    o = client.post("/api/cart/checkout-proposal", headers=h).json()
    assert shop.place(h, o["id"]).status_code == 201
    assert shop.balance(store, "gateau-chocolat")[1] >= 3
    # 売り切れは、メニューにも出る
    menu = {i["code"]: i for i in client.get(f"/api/menu?store_id={shop.store_id(store)}").json()}
    assert menu["gateau-chocolat"]["variants"][0]["available"] is False and menu["gateau-chocolat"]["variants"][0]["unavailable_reason"] == "sold_out"
    assert menu["cheesecake"]["variants"][0]["available"] is True
    other = {i["code"]: i for i in client.get(f"/api/menu?store_id={shop.store_id('residential-main')}").json()}
    assert other["gateau-chocolat"]["variants"][0]["available"] is True
    assert shop.reconcile() == []


def test_sold_out_discovered_at_reservation_time_rolls_everything_back(client, shop):
    """提案のあとで在庫が無くなっても、確定で売り切れ（409）になり、冪等キーも提案も使われないまま戻る。"""
    store = "rock-lookout"
    h = shop.user()
    shop.set_available(store, "cheesecake", 5)
    p = shop.proposal(h, store, [(shop.variant("cheesecake"), 2), (shop.variant("hot-sandwich"), 1)])
    shop.set_available(store, "cheesecake", 1)
    key = f"key-{uuid.uuid4().hex}"
    r = shop.place(h, p["id"], key)
    assert r.status_code == 409 and code_of(r) == "sold_out" and r.json()["detail"]["item_name"] == "チーズケーキ"
    assert client.get("/api/orders", headers=h).json() == []
    with shop.db() as conn:
        assert conn.execute("SELECT count(*) AS n FROM idempotency_keys WHERE key = %s", (key,)).fetchone()["n"] == 0
        assert conn.execute("SELECT used_at FROM checkout_proposals WHERE id = %s", (p["id"],)).fetchone()["used_at"] is None
    # ホットサンドの確保も戻っている（途中の確保が残らない）
    assert shop.reconcile() == []
    shop.set_available(store, "cheesecake", 5)
    assert shop.place(h, p["id"], key).status_code == 201  # 同じキー・同じ提案で、やり直せる


def test_error_bodies_are_fixed_sentences_without_internals(client, shop):
    h = shop.user()
    r = client.post("/api/orders/NOSUCHID/pay", headers=h)
    assert r.status_code == 404 and r.json() == {"detail": {"code": "not_found", "message": "見つかりません。"}}
    text = client.post("/api/cart/checkout-proposal", headers=h).text
    assert "Traceback" not in text and "psycopg" not in text and "/app/" not in text and "SELECT" not in text

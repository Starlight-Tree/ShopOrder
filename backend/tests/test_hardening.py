"""2026-11-21 の読み取りレビュー（在庫・認可・状態機械の 3 観点）で再現した指摘への対策の、回帰テスト。"""

import threading
import uuid
from datetime import timedelta

import pytest

from app import clock, limits, orders, sweep
from tests.helpers import code_of

STORE = "terminal-central"


def test_concurrent_wrong_logins_are_verified_at_most_the_limit_times(shop, client):
    """同じ email への同時の誤りは、上限（5 回）までしか検証されない（数えてから確かめる。以前は 10〜20 件が検証されていた）。"""
    email = shop.make_staff("staff", STORE, "right-password-1")
    codes: list[int] = []
    lock = threading.Lock()

    def attempt():
        r = client.post("/api/staff/login", json={"email": email, "password": "wrong-password"})
        with lock:
            codes.append(r.status_code)

    threads = [threading.Thread(target=attempt) for _ in range(30)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert codes.count(401) <= limits.LOGIN_MAX_FAILURES, codes
    assert codes.count(401) + codes.count(429) == 30
    # 上限のあとは、正しいパスワードでも 429
    assert client.post("/api/staff/login", json={"email": email, "password": "right-password-1"}).status_code == 429


def test_a_successful_login_clears_the_attempts(shop, client):
    email = shop.make_staff("staff", STORE, "right-password-1")
    for _ in range(limits.LOGIN_MAX_FAILURES - 1):
        assert client.post("/api/staff/login", json={"email": email, "password": "wrong"}).status_code == 401
    assert client.post("/api/staff/login", json={"email": email, "password": "right-password-1"}).status_code == 200
    with shop.db() as conn:
        n = conn.execute("SELECT count(*) AS n FROM staff_login_attempts WHERE email_hash = %s", (__import__("app.auth", fromlist=["x"]).email_hash(email),)).fetchone()["n"]
    assert n == 0


def test_the_same_cart_value_does_not_bump_the_version(shop, client):
    """絶対値指定を同じ値で二重に送っても版は上がらず、確定の許可証が無効にならない。"""
    h = shop.user()
    v = shop.variant("americano", "M", "hot")
    shop.fill_cart(h, STORE, [(v, 2)])
    p = client.post("/api/cart/checkout-proposal", headers=h).json()
    version = client.get("/api/cart", headers=h).json()["version"]
    r = client.put(f"/api/cart/items/{v}", json={"qty": 2}, headers=h)
    assert r.status_code == 200 and r.json()["version"] == version

    r = client.put(f"/api/cart/items/{v}", json={"qty": 0}, headers=h)
    assert r.json()["version"] == version + 1  # 外す（変わる）
    r = client.put(f"/api/cart/items/{v}", json={"qty": 0}, headers=h)
    assert r.json()["version"] == version + 1  # 既に無い（変わらない）
    assert p["cart_version"] == version


def test_unpaid_orders_are_capped_per_user(shop, client):
    """払わずに確定を繰り返して在庫を押さえ続けられない（未払いは 2 件まで）。支払うか取り消せば、また確定できる。"""
    h = shop.user()
    v = shop.variant("americano", "M", "hot")
    first = shop.order(h, STORE, [(v, 1)])
    shop.order(h, STORE, [(v, 1)])
    p = shop.proposal(h, STORE, [(v, 1)])
    r = shop.place(h, p["id"])
    assert r.status_code == 409 and code_of(r) == "too_many_unpaid_orders"
    assert client.post(f"/api/orders/{first['public_id']}/cancel", headers=h).status_code == 200
    r = shop.place(h, p["id"])
    assert r.status_code == 201, r.text


def test_staff_cannot_list_unpaid_or_delivery_statuses(shop, client):
    s = shop.staff(STORE)
    for status in ("placed", "assigned", "delivering", "bogus"):
        r = client.get("/api/staff/orders", params={"status": status}, headers=s)
        assert r.status_code == 422 and code_of(r) == "invalid_status", status
    assert client.get("/api/staff/orders", params={"status": "paid,completed"}, headers=s).status_code == 200


def _post_raw(client, path: str, payload: dict, headers: dict | None = None):
    """JSON を ASCII のエスケープ（\\ud800 など）のまま送る。単独のサロゲートは、httpx の json= では送れないため。"""
    import json

    return client.post(path, content=json.dumps(payload, ensure_ascii=True).encode(), headers={"Content-Type": "application/json", **(headers or {})})


@pytest.mark.parametrize("bad", ["a\u0000b", "x\ud800y", "tab\x07bell"])
def test_control_characters_are_rejected_with_422_not_500(shop, client, bad):
    r = _post_raw(client, "/api/staff/login", {"email": f"{bad}@oasis-cafe.example", "password": "pw"})
    assert r.status_code == 422
    s = shop.staff(STORE)
    o = shop.paid_order(shop.user(), STORE, [(shop.variant("americano", "M", "hot"), 1)])
    r = _post_raw(client, f"/api/staff/orders/{o['public_id']}/transition", {"action": "cancel", "reason": bad}, s)
    assert r.status_code == 422


@pytest.mark.parametrize("bad", ["a\u0000b", "x\ud800y", "tab\x07bell"])
@pytest.mark.parametrize("field", ["label", "line", "note"])
def test_address_text_rejects_control_characters_with_422_not_500(shop, client, bad, field):
    body = {"label": "自宅", "area_code": 1, "line": "アルカ市居住区1-4-2", "note": None, field: bad}
    r = _post_raw(client, "/api/addresses", body, shop.user())
    assert r.status_code == 422

def test_expire_stale_releases_each_order_in_its_own_transaction(shop, client):
    """複数の期限切れを戻しても、在庫と台帳が合う（1 注文 1 トランザクション）。期限切れの戻しは、失敗しても呼び出し元に例外を出さない。"""
    v = shop.variant("americano", "M", "hot")
    placed = [shop.order(shop.user(), "rock-plaza", [(v, 1)]) for _ in range(3)]
    with shop.db() as conn:
        conn.execute(
            "UPDATE stock_reservations SET expires_at = %s WHERE order_id IN (SELECT id FROM orders WHERE public_id = ANY(%s))",
            (clock.utc_now() - timedelta(minutes=1), [o["public_id"] for o in placed]),
        )
    assert orders.expire_stale() >= 3
    assert shop.reconcile() == []


def test_sweep_removes_old_rows_only(shop):
    """掃除（worker）: 期限切れ・使用済みから 1 日たった提案、1 日より古いログイン試行、期限切れのセッションだけを消す。"""
    h = shop.user()
    old = shop.proposal(h, STORE, [(shop.variant("americano", "M", "hot"), 1)])
    fresh_user = shop.user()
    fresh = shop.proposal(fresh_user, STORE, [(shop.variant("americano", "M", "hot"), 1)])
    with shop.db() as conn:
        conn.execute("UPDATE checkout_proposals SET expires_at = %s WHERE id = %s", (clock.utc_now() - timedelta(days=2), old["id"]))
        conn.execute("INSERT INTO staff_login_attempts (email_hash, at) VALUES (%s, %s)", (uuid.uuid4().hex * 2, clock.utc_now() - timedelta(days=2)))
    assert sweep.run() >= 2
    with shop.db() as conn:
        assert conn.execute("SELECT 1 FROM checkout_proposals WHERE id = %s", (old["id"],)).fetchone() is None
        assert conn.execute("SELECT 1 FROM checkout_proposals WHERE id = %s", (fresh["id"],)).fetchone() is not None

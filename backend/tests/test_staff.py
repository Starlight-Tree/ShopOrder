"""スタッフの認証（(n) ログイン失敗の 429）・起動の拒否（(m)）・在庫の操作（docs/api.md「スタッフ」）。"""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app import auth, clock
from tests.helpers import code_of

STORE = "residential-main"


def test_login_me_logout(client, shop):
    r = shop.login(f"staff-{STORE}@oasis-cafe.example")
    assert r.status_code == 200
    body = r.json()
    assert body["staff"]["role"] == "staff" and body["staff"]["store_id"] == shop.store_id(STORE) and body["expires_at"].endswith("Z")
    h = {"Authorization": f"Bearer {body['token']}"}
    assert client.get("/api/staff/me", headers=h).json() == body["staff"]
    # トークンは、ハッシュだけを保存する（平文は DB に無い）
    with shop.db() as conn:
        assert conn.execute("SELECT count(*) AS n FROM staff_sessions WHERE token_hash = %s", (body["token"],)).fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM staff_sessions WHERE token_hash = %s", (auth.token_hash(body["token"]),)).fetchone()["n"] == 1
    assert client.post("/api/staff/logout", headers=h).status_code == 204
    assert client.get("/api/staff/me", headers=h).status_code == 401  # 無効になった
    manager = shop.login("manager@oasis-cafe.example").json()["staff"]
    assert manager["role"] == "manager" and manager["store_id"] is None


def test_wrong_credentials_are_401_without_saying_which_part_is_wrong(client, shop):
    a = shop.login(f"staff-{STORE}@oasis-cafe.example", "wrong-password-x")
    b = shop.login("nobody@oasis-cafe.example", "whatever-pass")
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json() and code_of(a) == "invalid_credentials"
    for headers in ({}, {"Authorization": "Bearer nope"}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer"}):
        assert client.get("/api/staff/me", headers=headers).status_code == 401


def test_repeated_login_failures_are_rate_limited(client, shop):
    """(n) email ごとに 15 分で 5 回の失敗まで。6 回目は 429（正しいパスワードでも）。別の email は巻き込まない。成功すると数え直す。"""
    email = shop.make_staff("staff", STORE, "right-password-1")
    for _ in range(5):
        assert shop.login(email, "wrong-password-x").status_code == 401
    r = shop.login(email, "wrong-password-x")
    assert r.status_code == 429 and code_of(r) == "too_many_attempts"
    assert shop.login(email, "right-password-1").status_code == 429  # 制限中は、正しくても通さない
    other = shop.make_staff("staff", STORE, "right-password-2")
    assert shop.login(other, "right-password-2").status_code == 200
    # 15 分たてば、また試せる。成功すると、失敗の記録は消える
    clock.freeze(clock.utc_now() + timedelta(minutes=16))
    assert shop.login(email, "right-password-1").status_code == 200
    for _ in range(4):
        assert shop.login(email, "wrong-password-x").status_code == 401
    assert shop.login(email, "right-password-1").status_code == 200
    for _ in range(4):
        assert shop.login(email, "wrong-password-x").status_code == 401  # 成功で数え直されたので、まだ 429 にならない


def test_login_attempts_do_not_store_the_email_itself(client, shop):
    email = shop.make_staff("staff", STORE)
    shop.login(email, "wrong-password-x")
    with shop.db() as conn:
        rows = conn.execute("SELECT email_hash FROM staff_login_attempts").fetchall()
    assert rows and all(email not in r["email_hash"] and len(r["email_hash"]) == 64 for r in rows)


def test_session_expires_after_12_hours(client, shop):
    email = shop.make_staff("staff", STORE, "right-password-1")
    token = shop.login(email, "right-password-1").json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    clock.freeze(clock.utc_now() + timedelta(hours=11, minutes=59))
    assert client.get("/api/staff/me", headers=h).status_code == 200
    clock.freeze(clock.utc_now() + timedelta(minutes=2))
    assert client.get("/api/staff/me", headers=h).status_code == 401


def test_inactive_staff_cannot_log_in_and_courier_cannot_use_order_endpoints(client, shop):
    email = shop.make_staff("staff", STORE, "right-password-1")
    with shop.db() as conn:
        conn.execute("UPDATE staff_accounts SET is_active = false WHERE email = %s", (email,))
    assert shop.login(email, "right-password-1").status_code == 401
    courier = shop.make_staff("courier", STORE, "right-password-1")
    token = shop.login(courier, "right-password-1").json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/staff/me", headers=h).status_code == 200
    r = client.get("/api/staff/orders", headers=h)
    assert r.status_code == 403 and code_of(r) == "forbidden"


def test_staff_accounts_need_a_store_unless_manager(client, shop):
    import psycopg

    with shop.db() as conn:
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("INSERT INTO staff_accounts (store_id, role, name, email, password_hash) VALUES (NULL, 'staff', 'x', 'x@oasis-cafe.example', 'x')")


def test_production_with_dev_auth_refuses_to_start(monkeypatch):
    """(m) APP_ENV=production && AUTH_MODE=dev（未設定も dev）では、起動を拒否する。"""
    from app.main import app

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("AUTH_MODE", "dev")
    with pytest.raises(RuntimeError, match="AUTH_MODE=dev"):
        auth.check_startup()
    with pytest.raises(RuntimeError):
        with TestClient(app):
            pass  # lifespan が、DB に繋ぐ前に拒否する
    monkeypatch.delenv("AUTH_MODE")
    with pytest.raises(RuntimeError):
        auth.check_startup()  # 未設定は既定の dev。本番で黙って通さない
    monkeypatch.setenv("AUTH_MODE", "bogus")
    with pytest.raises(RuntimeError):
        auth.check_startup()


def test_production_refuses_the_hours_check_off(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    with pytest.raises(RuntimeError):  # jwt は未対応（P6）。許さない値は起動の設定ミス
        auth.check_startup()


def test_development_starts_with_dev_auth(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTH_MODE", "dev")
    auth.check_startup()
    monkeypatch.setenv("ORDER_HOURS_CHECK", "maybe")
    with pytest.raises(RuntimeError):
        auth.check_startup()


# ---- 在庫の操作 ----

def _row(client, h, item_code, store_id=None):
    suffix = f"?store_id={store_id}" if store_id else ""
    return next(r for r in client.get(f"/api/staff/stock{suffix}", headers=h).json() if r["code"] == item_code)


def test_stock_list_shape_and_low_flag(client, shop):
    h = shop.staff("rock-school")
    rows = client.get("/api/staff/stock", headers=h).json()
    assert {r["code"] for r in rows} >= {"coffee-beans", "milk", "cup-m", "gateau-chocolat", "beans-bag-oasis"}
    row = next(r for r in rows if r["code"] == "coffee-beans")
    assert set(row) == {"item_id", "code", "name", "kind", "unit", "on_hand", "reserved", "available", "reorder_point", "low"}
    assert row["available"] == row["on_hand"] - row["reserved"] - 500 and row["unit"] == "g" and row["kind"] == "material" and row["low"] is False
    shop.set_available("rock-school", "bread", 10)  # 発注点 15 を下回る
    assert _row(client, h, "bread")["low"] is True
    shop.set_available("rock-school", "bread", 40)
    assert _row(client, h, "bread")["low"] is False


def test_receive_waste_adjust_update_the_row_and_the_ledger(client, shop):
    """(i) 入荷・廃棄・棚卸しは、台帳に追記され、残高が合う。"""
    store = "rock-school"
    h = shop.staff(store)
    item_id = _row(client, h, "cup-l")["item_id"]
    start = _row(client, h, "cup-l")["on_hand"]
    r = client.post(f"/api/staff/stock/{item_id}/receive", json={"qty": 50, "reason": "金曜の配送"}, headers=h)
    assert r.status_code == 200 and r.json()["on_hand"] == start + 50
    r = client.post(f"/api/staff/stock/{item_id}/waste", json={"qty": 5, "reason": "破損"}, headers=h)
    assert r.json()["on_hand"] == start + 45
    r = client.post(f"/api/staff/stock/{item_id}/adjust", json={"delta": -3, "reason": "棚卸しの差異"}, headers=h)
    assert r.json()["on_hand"] == start + 42
    r = client.post(f"/api/staff/stock/{item_id}/adjust", json={"delta": 2, "reason": "棚卸しの差異"}, headers=h)
    assert r.json()["on_hand"] == start + 44
    with shop.db() as conn:
        kinds = conn.execute(
            "SELECT kind, qty, reason, actor FROM stock_movements WHERE item_id = %s AND store_id = %s AND ref_type = 'manual' ORDER BY id",
            (item_id, shop.store_id(store)),
        ).fetchall()
    assert [(k["kind"], k["qty"]) for k in kinds] == [("receive", 50), ("waste", -5), ("adjust", -3), ("adjust", 2)]
    assert all(k["actor"].startswith("staff:") for k in kinds) and kinds[1]["reason"] == "破損"
    assert shop.reconcile() == []


def test_stock_operations_validate_input_and_cannot_waste_reserved_stock(client, shop):
    store = "rock-school"
    h = shop.staff(store)
    item_id = _row(client, h, "cheesecake")["item_id"]
    assert client.post(f"/api/staff/stock/{item_id}/waste", json={"qty": 1}, headers=h).status_code == 422  # 理由は必須
    assert client.post(f"/api/staff/stock/{item_id}/waste", json={"qty": 1, "reason": "  "}, headers=h).json()["detail"]["code"] == "reason_required"
    assert client.post(f"/api/staff/stock/{item_id}/receive", json={"qty": 0}, headers=h).status_code == 422
    assert client.post(f"/api/staff/stock/{item_id}/adjust", json={"delta": 0, "reason": "x"}, headers=h).json()["detail"]["code"] == "invalid_delta"
    assert client.post("/api/staff/stock/999999/receive", json={"qty": 1}, headers=h).status_code == 404
    # 確保中の分は捨てられない・調整で下回れない
    shop.set_available(store, "cheesecake", 4)
    o = shop.order(shop.user(), store, [(shop.variant("cheesecake"), 3)])
    row = _row(client, h, "cheesecake")
    assert row["reserved"] >= 3
    r = client.post(f"/api/staff/stock/{item_id}/waste", json={"qty": row["on_hand"], "reason": "全部捨てる"}, headers=h)
    assert r.status_code == 409 and code_of(r) == "insufficient_stock"
    r = client.post(f"/api/staff/stock/{item_id}/adjust", json={"delta": -row["on_hand"], "reason": "全部ゼロ"}, headers=h)
    assert r.status_code == 409 and code_of(r) == "insufficient_stock"
    assert _row(client, h, "cheesecake")["on_hand"] == row["on_hand"]  # 変わっていない
    assert client.post(f"/api/orders/{o['public_id']}/cancel", headers=_owner(shop, o)).status_code == 200
    assert shop.reconcile() == []


def _owner(shop, order):
    with shop.db() as conn:
        name = conn.execute("SELECT u.auth_user_id FROM users u JOIN orders o ON o.user_id = u.id WHERE o.public_id = %s", (order["public_id"],)).fetchone()["auth_user_id"]
    return {"X-Dev-User": name.removeprefix("dev:")}


def test_stock_is_scoped_to_the_store_and_managers_choose_a_store(client, shop):
    staff, manager = shop.staff("rock-school"), shop.staff(None)
    item_id = _row(client, staff, "cup-s")["item_id"]
    other = shop.store_id("rock-plaza")
    assert client.get(f"/api/staff/stock?store_id={other}", headers=staff).status_code == 404
    assert client.post(f"/api/staff/stock/{item_id}/receive?store_id={other}", json={"qty": 1}, headers=staff).status_code == 404
    r = client.get("/api/staff/stock", headers=manager)  # 店長は店を選ぶ
    assert r.status_code == 422 and code_of(r) == "store_required"
    assert client.get("/api/staff/stock?store_id=999999", headers=manager).status_code == 404
    before = _row(client, manager, "cup-s", other)["on_hand"]
    r = client.post(f"/api/staff/stock/{item_id}/receive?store_id={other}", json={"qty": 7}, headers=manager)
    assert r.status_code == 200 and r.json()["on_hand"] == before + 7
    assert client.get("/api/staff/stock").status_code == 401


def test_worker_module_has_a_main_loop_and_one_shot_function():
    from app import worker

    assert callable(worker.run_once) and callable(worker.main)

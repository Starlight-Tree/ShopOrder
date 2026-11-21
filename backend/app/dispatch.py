"""配達の進行: 割り当て・集荷・出発・到着（暗証コード）・不在・再配達・模擬の進行（docs/api.md「宅配（P2）」、docs/order-flow.md「宅配」）。

トランザクションは、1 回の操作に 1 つ。注文の行を FOR UPDATE で押さえてから、配達の行（FOR UPDATE）→ 枠、の順（orders.py の「既にある注文を触る操作」と同じ）。
暗証コードの誤りの回数は、commit してから 422 / 409 で答える（エラーで巻き戻さない）。同じ配達の並行した推測は、配達の行のロックで 1 件ずつになる。
ログには、住所・暗証コードを出さない（このファイルは、件数だけをログに出す）。
"""

import logging
import secrets
from datetime import datetime, timedelta

from psycopg import Connection

from app import clock, delivery, delivery_rules, orders, settings
from app.auth import StaffUser
from app.db import connection
from app.errors import ApiError

log = logging.getLogger("oasis.dispatch")

ACTIVE = delivery_rules.ACTIVE_STATUSES


# ---- 共通 ----

def _delivery_row(conn: Connection, order_id: int) -> dict:
    """配達の行を FOR UPDATE で押さえる（注文の行を先に押さえておくこと）。無ければ 404。"""
    row = conn.execute(
        "SELECT id, order_id, store_id, zone_id, slot_id, courier_id, status, attempt, pin_nonce, pin_hash, pin_attempts, pin_expires_at, "
        "departed_at FROM deliveries WHERE order_id = %s FOR UPDATE",
        (order_id,),
    ).fetchone()
    if row is None:
        raise ApiError(404, "not_found")
    return row


def _set_courier_zone(conn: Connection, courier_id: int | None, zone_id: int | None, now: datetime) -> None:
    if courier_id is not None and zone_id is not None:
        conn.execute("UPDATE couriers SET zone_id = %s, updated_at = %s WHERE staff_id = %s", (zone_id, now, courier_id))


def _move(conn: Connection, order: dict, to_status: str, actor_type: str, actor_id: str | None, reason: str | None, now: datetime, **order_columns) -> None:
    """注文の状態を進めて履歴に残す。遷移の表（orders.TRANSITIONS）にない遷移は 409。order_columns は、同じ UPDATE で入れる列（ready_at など）。"""
    orders.check_transition(order["status"], to_status, actor_type)
    sets = ", ".join(["status = %s", *[f"{col} = %s" for col in order_columns]])  # 列名はこのファイルの固定の名前だけ
    conn.execute(f"UPDATE orders SET {sets} WHERE id = %s", (to_status, *order_columns.values(), order["id"]))  # noqa: S608
    orders._event(conn, order["id"], order["status"], to_status, actor_type, actor_id, reason, now)
    order["status"] = to_status


def _delivery_order(conn: Connection, public_id: str, *, store_id: int | None = None, not_delivery: tuple[int, str] = (409, "invalid_transition")) -> dict:
    """宅配の注文の行を FOR UPDATE で押さえる。他店・他人の注文は 404。宅配でない注文は、店には 409（できない操作）、配達員には 404（自分の配達ではない）。"""
    order = orders._lock(conn, public_id, store_id=store_id)
    if order["fulfillment"] != "delivery":
        raise ApiError(*not_delivery)
    return order


def _own_delivery(conn: Connection, courier: StaffUser, public_id: str) -> tuple[dict, dict]:
    """配達員の担当の注文と配達の行（FOR UPDATE）。他の配達員の担当・他店・担当が付いていないものは 404。"""
    order = _delivery_order(conn, public_id, not_delivery=(404, "not_found"))
    d = _delivery_row(conn, order["id"])
    if d["courier_id"] != courier.id or d["store_id"] != courier.store_id:
        raise ApiError(404, "not_found")
    return order, d


# ---- 店: 割り当て ----

def _do_assign(conn: Connection, order: dict, d: dict, courier_id: int, actor_type: str, actor_id: str | None, now: datetime) -> None:
    if order["status"] == "ready":
        _move(conn, order, "assigned", actor_type, actor_id, f"courier:{courier_id}", now)
    elif order["status"] == "assigned":  # 担当の付け替え（状態は変わらない。履歴だけ残す）
        orders._event(conn, order["id"], "assigned", "assigned", actor_type, actor_id, f"courier:{courier_id}", now)
    else:
        raise ApiError(409, "invalid_transition")
    conn.execute("UPDATE deliveries SET status = 'assigned', courier_id = %s, assigned_at = %s WHERE id = %s", (courier_id, now, d["id"]))


def assign(staff: StaffUser, public_id: str, courier_id: int) -> dict:
    """ready → assigned（assigned なら付け替え）。自店の勤務中の配達員だけ。"""
    now = clock.utc_now()
    with connection() as conn:
        order = _delivery_order(conn, public_id, store_id=staff.store_id)
        d = _delivery_row(conn, order["id"])
        if order["status"] not in ("ready", "assigned"):
            raise ApiError(409, "invalid_transition")
        courier = conn.execute(
            "SELECT c.is_on_duty FROM couriers c JOIN staff_accounts a ON a.id = c.staff_id AND a.is_active AND a.role = 'courier' "
            "WHERE c.staff_id = %s AND c.store_id = %s",
            (courier_id, order["store_id"]),
        ).fetchone()
        if courier is None:
            raise ApiError(404, "courier_not_found")
        if not courier["is_on_duty"]:
            raise ApiError(409, "courier_off_duty")
        _do_assign(conn, order, d, courier_id, "staff", str(staff.id), now)
        return orders._one(conn, "o.id = %s", (order["id"],), now, staff=True)


# ---- 配達員の操作 ----

def _do_pickup(conn: Connection, order: dict, d: dict, actor_type: str, actor_id: str | None, now: datetime) -> None:
    """assigned → picked_up。暗証コードを作る（DB にはハッシュだけ）。配達員は店の区画にいる。"""
    if d["status"] != "assigned":
        raise ApiError(409, "invalid_transition")
    _move(conn, order, "picked_up", actor_type, actor_id, None, now)
    secret = settings.delivery_pin_secret()
    nonce = secrets.token_hex(8)
    pin = delivery_rules.derive_pin(secret, d["id"], nonce)
    conn.execute(
        "UPDATE deliveries SET status = 'picked_up', picked_up_at = %s, pin_nonce = %s, pin_hash = %s, pin_attempts = 0, pin_expires_at = %s WHERE id = %s",
        (now, nonce, delivery_rules.pin_hash(secret, d["id"], pin), now + delivery_rules.PIN_TTL, d["id"]),
    )
    _set_courier_zone(conn, d["courier_id"], delivery.store_home_zone_id(conn, d["store_id"]), now)


def _do_depart(conn: Connection, order: dict, d: dict, actor_type: str, actor_id: str | None, now: datetime) -> None:
    if d["status"] != "picked_up":
        raise ApiError(409, "invalid_transition")
    _move(conn, order, "delivering", actor_type, actor_id, None, now)
    conn.execute("UPDATE deliveries SET status = 'delivering', departed_at = %s WHERE id = %s", (now, d["id"]))


def _do_complete(conn: Connection, order: dict, d: dict, actor_type: str, actor_id: str | None, now: datetime) -> None:
    """delivering → delivered → completed（同じトランザクション）。ポイントを付ける。配達員は配達先の区画にいる。"""
    if d["status"] != "delivering":
        raise ApiError(409, "invalid_transition")
    _move(conn, order, "delivered", actor_type, actor_id, None, now)
    conn.execute("UPDATE deliveries SET status = 'delivered', delivered_at = %s WHERE id = %s", (now, d["id"]))
    full = conn.execute("SELECT id, user_id, total_lumi FROM orders WHERE id = %s", (order["id"],)).fetchone()
    _move(conn, order, "completed", "system", None, None, now, completed_at=now)
    orders._award_points(conn, full, now)
    _set_courier_zone(conn, d["courier_id"], d["zone_id"], now)


def _do_fail(conn: Connection, order: dict, d: dict, reason: str, actor_type: str, actor_id: str | None, now: datetime) -> None:
    """delivering → delivery_failed（不在・受け取れない・暗証コードの凍結）。再配達か取消しは店が決める。"""
    if d["status"] != "delivering":
        raise ApiError(409, "invalid_transition")
    _move(conn, order, "delivery_failed", actor_type, actor_id, reason, now)
    conn.execute("UPDATE deliveries SET status = 'failed', failed_at = %s, failure_reason = %s WHERE id = %s", (now, reason, d["id"]))
    _set_courier_zone(conn, d["courier_id"], d["zone_id"], now)


def courier_action(courier: StaffUser, public_id: str, action: str, *, pin: str | None = None, reason: str | None = None) -> dict:
    """配達員の pickup / depart / deliver / fail。返すのは操作の後の CourierDelivery。"""
    now = clock.utc_now()
    refusal: ApiError | None = None
    with connection() as conn:
        order, d = _own_delivery(conn, courier, public_id)
        actor = str(courier.id)
        if action == "pickup":
            _do_pickup(conn, order, d, "staff", actor, now)
        elif action == "depart":
            _do_depart(conn, order, d, "staff", actor, now)
        elif action == "fail":
            _do_fail(conn, order, d, reason or "other", "staff", actor, now)
        elif action == "deliver":
            refusal = _try_deliver(conn, order, d, pin or "", actor, now)
        else:
            raise ApiError(404, "not_found")
        view = courier_view(conn, courier, order["id"], now) if refusal is None else None
    if refusal is not None:
        raise refusal  # 誤りの回数は commit 済み
    assert view is not None
    return view


def _try_deliver(conn: Connection, order: dict, d: dict, pin: str, actor: str, now: datetime) -> ApiError | None:
    """暗証コードを確かめて、合えば完了。違えば誤りを数える（5 回で凍結して delivery_failed）。呼ぶ側は、返ったエラーを commit の後に出す。"""
    if d["status"] != "delivering" or d["pin_hash"] is None:
        raise ApiError(409, "invalid_transition")
    if d["pin_expires_at"] is None or d["pin_expires_at"] <= now:
        raise ApiError(409, "pin_expired")  # 数えない
    secret = settings.delivery_pin_secret()
    if delivery_rules.pin_matches(secret, d["id"], pin, d["pin_hash"]):
        _do_complete(conn, order, d, "staff", actor, now)
        return None
    attempts = d["pin_attempts"] + 1
    conn.execute("UPDATE deliveries SET pin_attempts = %s WHERE id = %s", (attempts, d["id"]))
    if attempts >= delivery_rules.PIN_MAX_ATTEMPTS:
        _do_fail(conn, order, d, "pin_locked", "system", None, now)  # 凍結して店へ
        log.warning("暗証コードの誤りが %s 回に達し、配達を止めました", attempts)
        return ApiError(409, "pin_locked")
    return ApiError(422, "pin_invalid", attempts_left=delivery_rules.PIN_MAX_ATTEMPTS - attempts)


# ---- 店: 再配達 ----

def redeliver(staff: StaffUser, public_id: str, slot_id: int | None) -> dict:
    """delivery_failed → ready。新しい枠を取り（slot_id 省略は最も早い枠）、古い枠を戻す。担当・暗証コードを外す。"""
    now = clock.utc_now()
    with connection() as conn:
        order = _delivery_order(conn, public_id, store_id=staff.store_id)
        d = _delivery_row(conn, order["id"])
        if order["status"] != "delivery_failed":
            raise ApiError(409, "invalid_transition")
        orders.check_transition("delivery_failed", "ready", "staff")
        store = conn.execute(
            "SELECT id, open_time, close_time, closed_weekday, last_order_minutes FROM stores WHERE id = %s", (order["store_id"],)
        ).fetchone()
        zone = delivery.load_zone(conn, d["zone_id"])
        if zone is None or zone["is_suspended"]:
            raise ApiError(409, "zone_suspended")
        if slot_id is None:
            slot = delivery.earliest_slot(conn, store, zone, now)
            if slot is None:
                raise ApiError(409, "no_slot_available")
        else:
            slot = delivery.load_slot(conn, slot_id)
            if slot is None or slot["store_id"] != order["store_id"]:
                raise ApiError(404, "slot_not_found")
            issue = delivery.slot_issue(conn, slot, now)
            if issue is not None and not (issue == "slot_full" and slot["id"] == d["slot_id"]):  # 同じ枠へ戻すときの満席は、自分の分
                raise ApiError(409, issue)
        # 枠は、ID の昇順に触る（2 つの再配達が逆の順で待ち合って、デッドロックにならないように）。同じ枠なら、何も変えない
        old_id, new_id = d["slot_id"], slot["id"]
        if old_id < new_id:
            delivery.release_slot(conn, old_id)
            delivery.book_slot(conn, new_id, order["store_id"])
        elif old_id > new_id:
            delivery.book_slot(conn, new_id, order["store_id"])
            delivery.release_slot(conn, old_id)
        conn.execute(
            "UPDATE deliveries SET slot_id = %s, status = 'pending', courier_id = NULL, attempt = attempt + 1, failure_reason = NULL, failed_at = NULL, "
            "pin_nonce = NULL, pin_hash = NULL, pin_attempts = 0, pin_expires_at = NULL, assigned_at = NULL, picked_up_at = NULL, departed_at = NULL "
            "WHERE id = %s",
            (new_id, d["id"]),
        )
        _move(conn, order, "ready", "staff", str(staff.id), "redelivery", now)
        return orders._one(conn, "o.id = %s", (order["id"],), now, staff=True)


# ---- 模擬の配達（DELIVERY_PROVIDER=mock のときだけ） ----

def _require_mock() -> None:
    if delivery.provider() != "mock":
        raise ApiError(409, "mock_only")


def _mock_step(conn: Connection, order: dict, d: dict, now: datetime) -> None:
    """模擬の 1 歩（system が進める）。ready は、提案の配達員を割り当てる。"""
    if order["status"] == "ready":
        couriers = delivery.list_couriers(conn, order["store_id"])
        top = delivery.suggestion_for_store(couriers, delivery.store_home_zone_id(conn, order["store_id"]), delivery.travel_matrix(conn))
        if top is None:
            raise ApiError(409, "no_courier_available")
        _do_assign(conn, order, d, top["courier_id"], "system", None, now)
    elif d["status"] == "assigned":
        _do_pickup(conn, order, d, "system", None, now)
    elif d["status"] == "picked_up":
        _do_depart(conn, order, d, "system", None, now)
    elif d["status"] == "delivering":
        _do_complete(conn, order, d, "system", None, now)  # 暗証コードなし（模擬）
    else:
        raise ApiError(409, "invalid_transition")


def mock_advance(staff: StaffUser, public_id: str) -> dict:
    """デモ用: 模擬の配達を 1 つ進める。DELIVERY_PROVIDER=mock のときだけ。"""
    _require_mock()
    now = clock.utc_now()
    with connection() as conn:
        order = _delivery_order(conn, public_id, store_id=staff.store_id)
        d = _delivery_row(conn, order["id"])
        _mock_step(conn, order, d, now)
        return orders._one(conn, "o.id = %s", (order["id"],), now, staff=True)


def mock_tick(now: datetime | None = None) -> int:
    """worker の巡回: 前の変化から step 秒たった配達を、1 歩ずつ進める（assigned 以降。割り当ては人が行う）。進めた件数を返す。"""
    if delivery.provider() != "mock" or not settings.delivery_mock_autopilot():
        return 0
    now = now or clock.utc_now()
    older = now - timedelta(seconds=settings.delivery_mock_step_seconds())
    advanced = 0
    with connection() as conn:
        due = conn.execute(
            "SELECT o.public_id FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.status = ANY(%s) "
            "AND COALESCE(d.departed_at, d.picked_up_at, d.assigned_at) <= %s ORDER BY d.id LIMIT 50",
            (list(ACTIVE), older),
        ).fetchall()
    for row in due:
        try:
            with connection() as conn:
                locked = conn.execute("SELECT id, status, fulfillment, store_id FROM orders WHERE public_id = %s FOR UPDATE SKIP LOCKED", (row["public_id"],)).fetchone()
                if locked is None:
                    continue
                d = _delivery_row(conn, locked["id"])
                if d["status"] not in ACTIVE:
                    continue
                _mock_step(conn, locked, d, now)
                advanced += 1
        except ApiError:
            continue  # 別の操作が先に進めた
    if advanced:
        log.info("模擬の配達を %s 件、進めました", advanced)
    return advanced


# ---- 読み取り ----

def board(staff: StaffUser, store_id: int | None, statuses: list[str]) -> dict:
    """配車ボード: 配達員（担当中の件数つき）と、宅配の注文（枠の開始が早い順。ready には提案）。"""
    orders.expire_stale()
    now = clock.utc_now()
    where, params = orders._scope(store_id)
    with connection() as conn:
        rows = orders._fetch(
            conn, f"o.fulfillment = 'delivery' AND {where} AND o.status = ANY(%s)", (*params, statuses), order_by="o.placed_at, o.id", limit=200
        )
        found = orders._assemble(conn, rows, now, staff=True)
        couriers = delivery.list_couriers(conn, store_id)
        matrix = delivery.travel_matrix(conn)
        by_store: dict[int, list[dict]] = {}
        for c in couriers:
            by_store.setdefault(c["store_id"], []).append(c)
        suggestions: dict[int, dict | None] = {}
        for o in found:
            o["suggestion"] = None
            if o["status"] != "ready":
                continue
            sid = o["store"]["id"]
            if sid not in suggestions:
                suggestions[sid] = delivery.suggestion_for_store(by_store.get(sid, []), delivery.store_home_zone_id(conn, sid), matrix)
            o["suggestion"] = suggestions[sid]
    found.sort(key=lambda o: (o["delivery"]["slot"]["starts_at"] if o["delivery"] else "", o["placed_at"]))
    return {"provider": delivery.provider(), "couriers": [delivery.courier_public(c) for c in couriers], "orders": found}


def list_couriers(store_id: int | None) -> list[dict]:
    with connection() as conn:
        return [delivery.courier_public(c) for c in delivery.list_couriers(conn, store_id)]


def courier_view(conn: Connection, courier: StaffUser, order_id: int, now: datetime) -> dict:
    return _courier_views(conn, courier, "o.id = %s", (order_id,), now)[0]


def _courier_views(conn: Connection, courier: StaffUser, where: str, params: tuple, now: datetime) -> list[dict]:
    rows = conn.execute(
        "SELECT o.id AS order_id, o.public_id, o.pickup_no, o.status AS order_status, o.store_id, s.name AS store_name, d.id AS delivery_id, d.status, "
        "d.zone_id, z.name AS zone_name, z.base_minutes, d.slot_id, sl.starts_at, sl.ends_at, d.attempt, d.pin_attempts, d.departed_at, "
        "d.address_label, d.address_line, d.address_note "
        "FROM deliveries d JOIN orders o ON o.id = d.order_id JOIN stores s ON s.id = o.store_id JOIN delivery_zones z ON z.id = d.zone_id "
        f"JOIN delivery_slots sl ON sl.id = d.slot_id WHERE d.courier_id = %s AND {where} ORDER BY sl.starts_at, o.id",  # noqa: S608（where はこのファイルの固定の文字列）
        (courier.id, *params),
    ).fetchall()
    ids = [r["order_id"] for r in rows]
    items: dict[int, list[dict]] = {i: [] for i in ids}
    if ids:
        for it in conn.execute("SELECT order_id, name, size, temperature, qty FROM order_items WHERE order_id = ANY(%s) ORDER BY id", (ids,)).fetchall():
            items[it["order_id"]].append({k: it[k] for k in ("name", "size", "temperature", "qty")})
    result = []
    for r in rows:
        status = r["order_status"]
        shows_address = status in ("picked_up", "delivering")  # 住所は集荷後だけ（個人情報）
        eta = delivery_rules.eta_at(r["status"], r["starts_at"], r["departed_at"], r["base_minutes"])
        result.append({
            "public_id": r["public_id"], "pickup_no": r["pickup_no"], "status": status, "store": {"id": r["store_id"], "name": r["store_name"]},
            "zone": {"id": r["zone_id"], "name": r["zone_name"]},
            "slot": {"id": r["slot_id"], "starts_at": clock.iso(r["starts_at"]), "ends_at": clock.iso(r["ends_at"])},
            "items": items[r["order_id"]],
            "address": {"label": r["address_label"], "line": r["address_line"], "note": r["address_note"]} if shows_address else None,
            "attempt": r["attempt"],
            "pin_attempts_left": delivery_rules.PIN_MAX_ATTEMPTS - r["pin_attempts"] if status == "delivering" else None,
            "eta_at": clock.iso(eta) if eta else None,
            "allowed_actions": {"assigned": ["pickup"], "picked_up": ["depart"], "delivering": ["deliver", "fail"]}.get(status, []),
        })
    return result


def courier_deliveries(courier: StaffUser) -> list[dict]:
    """自分の担当（assigned / picked_up / delivering）。枠の開始が早い順。"""
    now = clock.utc_now()
    with connection() as conn:
        return _courier_views(conn, courier, "d.status = ANY(%s)", (list(ACTIVE),), now)

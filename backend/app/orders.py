"""注文の確定・支払い・取消し・スタッフの状態遷移・期限切れの戻し（docs/order-flow.md）。

トランザクションは、1 回の操作に 1 つ（途中で失敗すれば、在庫・台帳・冪等キーも全部戻る）。ただし、支払いの拒否・期限切れは
「取消しを commit してから、エラーで答える」（注文を cancelled にして確保を戻した結果を残すため）。

ロックの順（デッドロックを避ける）: 冪等キー → カート → 在庫の残高（品目 ID の昇順）→ 受け取り番号の採番。
既にある注文を触る操作は、注文の行 → 確保 → 在庫の残高（品目 ID の昇順）。期限切れの戻しは 1 注文ごとに別のトランザクション（ロックを持つ範囲を 1 注文に絞る）。確定は、注文の行がまだ無いので、この 2 つの順は交わらない。
デッドロック（40P01）・直列化失敗（40001）は、確定だけ数回やり直す。ログには、住所・注文の中身・金額を出さない。
"""

import functools
import hashlib
import logging
import secrets
import time
import uuid
from collections.abc import Callable
from datetime import datetime
from typing import TypeVar

import psycopg
from psycopg import Connection
from psycopg.types.json import Jsonb

from app import cart as cart_service
from app import clock, inventory, limits, payment
from app.db import connection
from app.errors import ApiError

log = logging.getLogger("oasis.orders")

T = TypeVar("T")

# ---- 状態遷移の表（1 か所）。(from, to) → 許す actor_type。表に無い遷移は 409。 ----
# P1（店頭受け取り）の範囲。宅配の状態（assigned 以降）は P2 で足す（orders.status の CHECK には入れてある）。
TRANSITIONS: dict[tuple[str, str], frozenset[str]] = {
    ("placed", "paid"): frozenset({"system"}),  # 支払いの提供者（模擬は即時）
    ("placed", "cancelled"): frozenset({"customer", "system"}),  # 顧客の取消し・支払い期限切れ・拒否
    ("paid", "accepted"): frozenset({"staff"}),
    ("paid", "cancelled"): frozenset({"customer", "staff"}),
    ("accepted", "preparing"): frozenset({"staff"}),
    ("accepted", "cancelled"): frozenset({"staff"}),  # 顧客は accepted より前だけ
    ("preparing", "ready"): frozenset({"staff"}),
    ("preparing", "cancelled"): frozenset({"staff"}),
    ("ready", "completed"): frozenset({"staff"}),
    ("ready", "cancelled"): frozenset({"staff"}),
}

# スタッフの操作 → (今の状態, 次の状態)。cancel は「どの状態からでも cancelled へ」（表が許す状態だけ通る）。
STAFF_ACTIONS: dict[str, tuple[str, str]] = {
    "accept": ("paid", "accepted"),
    "start": ("accepted", "preparing"),
    "ready": ("preparing", "ready"),
    "complete": ("ready", "completed"),
}
ALL_STATUSES = (
    "placed", "paid", "accepted", "preparing", "ready", "assigned", "picked_up", "delivering", "delivered", "delivery_failed", "completed", "cancelled",
)

# スタッフが一覧で指定できる状態（P1 の店頭）。placed（支払い前）は店が見ない。宅配の状態は P2 で足す。
STAFF_VISIBLE_STATUSES = ("paid", "accepted", "preparing", "ready", "completed", "cancelled")

_PUBLIC_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 紛らわしい I・O・0・1 を除く


def check_transition(from_status: str, to_status: str, actor_type: str, *, code: str = "invalid_transition") -> None:
    if actor_type not in TRANSITIONS.get((from_status, to_status), frozenset()):
        raise ApiError(409, code)


def staff_allowed_actions(status: str) -> list[str]:
    actions = [name for name, (frm, to) in STAFF_ACTIONS.items() if frm == status and "staff" in TRANSITIONS[(frm, to)]]
    if "staff" in TRANSITIONS.get((status, "cancelled"), frozenset()):
        actions.append("cancel")
    return actions


def new_public_id() -> str:
    return "".join(secrets.choice(_PUBLIC_ID_ALPHABET) for _ in range(8))


# ---- 読み取り（注文の形に組み立てる） ----

_ORDER_SELECT = (
    "SELECT o.id, o.public_id, o.user_id, o.store_id, o.status, o.fulfillment, o.pickup_no, o.subtotal_lumi, o.delivery_fee_lumi, o.total_lumi, "
    "o.placed_at, o.cancel_reason, s.name AS store_name, r.status AS reservation_status, r.expires_at AS reservation_expires_at, "
    "p.provider AS payment_provider, p.status AS payment_status "
    "FROM orders o JOIN stores s ON s.id = o.store_id LEFT JOIN stock_reservations r ON r.order_id = o.id LEFT JOIN payments p ON p.order_id = o.id "
)


def _fetch(conn: Connection, where: str, params: tuple, *, order_by: str, limit: int) -> list[dict]:
    # where / order_by は、このファイルの固定の文字列だけ（値は params で渡す）
    return conn.execute(f"{_ORDER_SELECT}WHERE {where} ORDER BY {order_by} LIMIT %s", (*params, limit)).fetchall()  # noqa: S608


def _assemble(conn: Connection, rows: list[dict], now: datetime, *, staff: bool) -> list[dict]:
    ids = [r["id"] for r in rows]
    items: dict[int, list[dict]] = {i: [] for i in ids}
    events: dict[int, list[dict]] = {i: [] for i in ids}
    if ids:
        for it in conn.execute(
            "SELECT order_id, name, size, temperature, unit_price_lumi, qty, line_total_lumi FROM order_items WHERE order_id = ANY(%s) ORDER BY id", (ids,)
        ).fetchall():
            items[it["order_id"]].append({k: it[k] for k in ("name", "size", "temperature", "unit_price_lumi", "qty", "line_total_lumi")})
        for ev in conn.execute(
            "SELECT order_id, to_status, at, actor_type, reason FROM order_events WHERE order_id = ANY(%s) ORDER BY id", (ids,)
        ).fetchall():
            events[ev["order_id"]].append({"to_status": ev["to_status"], "at": clock.iso(ev["at"]), "actor_type": ev["actor_type"], "reason": ev["reason"]})
    result = []
    for r in rows:
        expires = r["reservation_expires_at"] if r["status"] == "placed" else None
        order = {
            "public_id": r["public_id"], "pickup_no": r["pickup_no"], "status": r["status"], "fulfillment": r["fulfillment"],
            "store": {"id": r["store_id"], "name": r["store_name"]}, "items": items[r["id"]],
            "subtotal_lumi": r["subtotal_lumi"], "delivery_fee_lumi": r["delivery_fee_lumi"], "total_lumi": r["total_lumi"],
            "placed_at": clock.iso(r["placed_at"]), "reservation_expires_at": clock.iso(expires) if expires else None,
            "events": events[r["id"]], "cancel_reason": r["cancel_reason"],
        }
        if staff:
            actions = staff_allowed_actions(r["status"])
            order.update({"can_pay": False, "can_cancel": "cancel" in actions, "allowed_actions": actions})
        else:
            order["payment"] = {"provider": r["payment_provider"], "status": r["payment_status"]} if r["payment_provider"] else None
            order["can_pay"] = r["status"] == "placed" and (expires is None or expires > now)
            order["can_cancel"] = r["status"] in ("placed", "paid")
        result.append(order)
    return result


def _one(conn: Connection, where: str, params: tuple, now: datetime, *, staff: bool = False) -> dict:
    rows = _fetch(conn, where, params, order_by="o.id", limit=1)
    if not rows:
        raise ApiError(404, "not_found")
    return _assemble(conn, rows, now, staff=staff)[0]


def _scope(staff_store_id: int | None) -> tuple[str, tuple]:
    return ("o.store_id = %s", (staff_store_id,)) if staff_store_id is not None else ("true", ())


def list_for_customer(customer_id: int) -> list[dict]:
    expire_stale()
    with connection() as conn:
        rows = _fetch(conn, "o.user_id = %s", (customer_id,), order_by="o.placed_at DESC, o.id DESC", limit=limits.CUSTOMER_ORDER_LIST_LIMIT)
    return [
        {"public_id": r["public_id"], "pickup_no": r["pickup_no"], "status": r["status"], "store": {"id": r["store_id"], "name": r["store_name"]},
         "total_lumi": r["total_lumi"], "placed_at": clock.iso(r["placed_at"])}
        for r in rows
    ]


def get_for_customer(customer_id: int, public_id: str) -> dict:
    expire_stale()
    with connection() as conn:
        return _one(conn, "o.user_id = %s AND o.public_id = %s", (customer_id, public_id), clock.utc_now())


def list_for_staff(store_id: int | None, statuses: list[str]) -> list[dict]:
    expire_stale()
    now = clock.utc_now()
    where, params = _scope(store_id)
    with connection() as conn:
        rows = _fetch(conn, f"{where} AND o.status = ANY(%s)", (*params, statuses), order_by="o.placed_at, o.id", limit=limits.STAFF_ORDER_LIST_LIMIT)
        return _assemble(conn, rows, now, staff=True)


# ---- 書き込みの共通部品 ----

def _event(conn: Connection, order_id: int, from_status: str | None, to_status: str, actor_type: str, actor_id: str | None, reason: str | None, now: datetime) -> None:
    conn.execute(
        "INSERT INTO order_events (order_id, from_status, to_status, actor_type, actor_id, reason, at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (order_id, from_status, to_status, actor_type, actor_id, reason, now),
    )


def _lock(conn: Connection, public_id: str, *, user_id: int | None = None, store_id: int | None = None) -> dict:
    """注文の行を FOR UPDATE で押さえる。他人の注文・他店の注文は 404（存在を教えない）。"""
    sql = "SELECT id, public_id, user_id, store_id, status, total_lumi, cancel_reason FROM orders WHERE public_id = %s"
    params: list = [public_id]
    if user_id is not None:
        sql += " AND user_id = %s"
        params.append(user_id)
    if store_id is not None:
        sql += " AND store_id = %s"
        params.append(store_id)
    row = conn.execute(sql + " FOR UPDATE", params).fetchone()
    if row is None:
        raise ApiError(404, "not_found")
    return row


def _reservation_lines(conn: Connection, reservation_id: int) -> dict[int, int]:
    rows = conn.execute("SELECT item_id, qty FROM stock_reservation_lines WHERE reservation_id = %s ORDER BY item_id", (reservation_id,)).fetchall()
    return {r["item_id"]: r["qty"] for r in rows}


def _cancel(conn: Connection, order: dict, *, actor_type: str, actor_id: str | None, reason: str, reservation_final: str, now: datetime) -> None:
    """取消し: 確保が held なら戻す。支払い済みなら返金。準備後（確保が consumed）は何も戻さない。注文の行は呼ぶ側が FOR UPDATE 済み。"""
    check_transition(order["status"], "cancelled", actor_type, code="not_cancellable" if actor_type == "customer" else "invalid_transition")
    res = conn.execute("SELECT id, status FROM stock_reservations WHERE order_id = %s FOR UPDATE", (order["id"],)).fetchone()
    if res is not None and res["status"] == "held":
        inventory.release(
            conn, order["store_id"], _reservation_lines(conn, res["id"]), ref_type="order", ref_id=order["public_id"], reason=reason,
            actor=f"{actor_type}:{actor_id}" if actor_id else actor_type, now=now,
        )
        conn.execute("UPDATE stock_reservations SET status = %s, expires_at = NULL, updated_at = %s WHERE id = %s", (reservation_final, now, res["id"]))
    pay = conn.execute("SELECT id, status, provider_ref, amount_lumi FROM payments WHERE order_id = %s FOR UPDATE", (order["id"],)).fetchone()
    if pay is not None:
        if pay["status"] == "paid":
            if not payment.get_provider().refund(provider_ref=pay["provider_ref"], amount_lumi=pay["amount_lumi"]).ok:
                raise RuntimeError("返金に失敗しました")
            conn.execute("UPDATE payments SET status = 'refunded', updated_at = %s WHERE id = %s", (now, pay["id"]))
        elif pay["status"] == "pending":
            conn.execute("UPDATE payments SET status = 'failed', updated_at = %s WHERE id = %s", (now, pay["id"]))
    conn.execute("UPDATE orders SET status = 'cancelled', cancelled_at = %s, cancel_reason = %s WHERE id = %s", (now, reason, order["id"]))
    _event(conn, order["id"], order["status"], "cancelled", actor_type, actor_id, reason, now)


# ---- 期限切れの戻し（worker が 30 秒ごと。読み取り・確定・スタッフの一覧の前にも、遅延で呼ぶ） ----

def _expire_one(public_id: str) -> int:
    """1 件を 1 つのトランザクションで戻す（件数 1 or 0）。ほかの操作と待ち合っても、ロックを持つ範囲は 1 注文だけ（デッドロックを避ける）。"""
    now = clock.utc_now()
    with connection() as conn:
        order = conn.execute(
            "SELECT o.id, o.public_id, o.user_id, o.store_id, o.status, o.total_lumi FROM orders o JOIN stock_reservations r ON r.order_id = o.id "
            "WHERE o.public_id = %s AND o.status = 'placed' AND r.status = 'held' AND r.expires_at IS NOT NULL AND r.expires_at <= %s "
            "FOR UPDATE OF o SKIP LOCKED",
            (public_id, now),
        ).fetchone()
        if order is None:
            return 0  # 既に戻された・支払われた・ほかが処理中
        _cancel(conn, order, actor_type="system", actor_id=None, reason="payment_timeout", reservation_final="expired", now=now)
        return 1


def expire_stale() -> int:
    """placed のまま確保の期限を過ぎた注文を cancelled（payment_timeout・actor は system）にして確保を戻す。戻した件数を返す。

    **1 注文ごとに別のトランザクション**で処理する（複数の注文の在庫の残高を 1 つのトランザクションで取ると、確定などとロックの順が逆になって
    デッドロックしうる。2026-11-21 の読み取りレビューで再現）。呼び出し元（読み取り・確定・スタッフの一覧）を止めないよう、失敗は例外にせず、
    種類だけをログに残す（次の巡回・次の呼び出しでやり直す）。
    """
    count = 0
    try:
        now = clock.utc_now()
        with connection() as conn:
            ids = [
                r["public_id"]
                for r in conn.execute(
                    "SELECT o.public_id FROM orders o JOIN stock_reservations r ON r.order_id = o.id "
                    "WHERE o.status = 'placed' AND r.status = 'held' AND r.expires_at IS NOT NULL AND r.expires_at <= %s ORDER BY r.expires_at LIMIT %s",
                    (now, limits.EXPIRE_BATCH),
                ).fetchall()
            ]
        for public_id in ids:
            count += _with_retry(lambda pid=public_id: _expire_one(pid))
    except Exception as exc:  # 本文（接続情報を含みうる）は出さず、種類だけ
        log.error("期限切れの戻しに失敗しました（%s）", type(exc).__name__)
    if count:
        log.info("支払い期限切れの注文を %s 件、取り消して確保を戻しました", count)
    return count


# ---- 注文の確定 ----

def _with_retry(fn: Callable[[], T]) -> T:
    for attempt in range(limits.TX_RETRIES):
        try:
            return fn()
        except (psycopg.errors.DeadlockDetected, psycopg.errors.SerializationFailure):
            if attempt == limits.TX_RETRIES - 1:
                raise
            time.sleep(0.05 * (attempt + 1))
    raise AssertionError("unreachable")


def _retrying(fn: Callable[..., T]) -> Callable[..., T]:
    """デッドロック（40P01）・直列化失敗（40001）を数回やり直す。fn は、自分で接続を開き、失敗したら全部巻き戻る操作（冪等に再実行できる）に限る。"""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return _with_retry(lambda: fn(*args, **kwargs))

    return wrapper


def place_order(customer_id: int, idempotency_key: str, proposal_id: uuid.UUID) -> tuple[dict, bool]:
    """(注文, 新しく作ったか)。同じキー・同じ本文の再送は、同じ注文を返す（created=False）。"""
    expire_stale()
    request_hash = hashlib.sha256(f"POST /api/orders {proposal_id}".encode()).hexdigest()
    return _with_retry(lambda: _place_order_once(customer_id, idempotency_key, request_hash, proposal_id))


def _place_order_once(customer_id: int, key: str, request_hash: str, proposal_id: uuid.UUID) -> tuple[dict, bool]:
    now = clock.utc_now()
    local = clock.local_now()
    with connection() as conn:
        # 1. 冪等キー。先に INSERT ... ON CONFLICT DO NOTHING で取る（同じキーの並行リクエストは、先の commit まで待つ）
        taken = conn.execute(
            "INSERT INTO idempotency_keys (user_id, key, request_hash, created_at) VALUES (%s, %s, %s, %s) ON CONFLICT (user_id, key) DO NOTHING RETURNING key",
            (customer_id, key, request_hash, now),
        ).fetchone()
        if taken is None:
            existing = conn.execute("SELECT request_hash, response FROM idempotency_keys WHERE user_id = %s AND key = %s", (customer_id, key)).fetchone()
            if existing["request_hash"] != request_hash:
                raise ApiError(422, "idempotency_conflict")
            public_id = (existing["response"] or {}).get("public_id")
            if not public_id:
                raise ApiError(409, "idempotency_in_progress")
            return _one(conn, "o.user_id = %s AND o.public_id = %s", (customer_id, public_id), now), False

        # 1b. 未払い（placed）の注文の上限。払わずに確定を繰り返して、店の在庫を押さえ続けることを防ぐ（2026-11-21 のレビュー）
        unpaid = conn.execute("SELECT count(*) AS n FROM orders WHERE user_id = %s AND status = 'placed'", (customer_id,)).fetchone()["n"]
        if unpaid >= limits.MAX_UNPAID_ORDERS:
            raise ApiError(409, "too_many_unpaid_orders")

        # 2. 確定の許可証（版・期限・使用済み）
        cart = cart_service.get_cart(conn, customer_id, now, lock=True)
        proposal = conn.execute(
            "SELECT id, cart_version, total_lumi, expires_at, used_at FROM checkout_proposals WHERE id = %s AND cart_id = %s FOR UPDATE",
            (str(proposal_id), cart["id"]),
        ).fetchone()
        if proposal is None:
            raise ApiError(404, "proposal_not_found")
        if proposal["used_at"] is not None:
            raise ApiError(409, "proposal_stale")
        if proposal["expires_at"] <= now:
            raise ApiError(409, "proposal_expired")
        if proposal["cart_version"] != cart["version"]:
            raise ApiError(409, "proposal_stale")

        # 3. カートの再検証（価格は今のメニューの値で計算し直す。営業時間・品揃い・上限）
        lines = cart_service.price_lines(conn, cart, local)
        total = cart_service.validate_checkout(conn, cart, lines, local, check_stock=False)
        if total != proposal["total_lumi"]:
            raise ApiError(409, "proposal_stale")

        # 4. 在庫の確保（品目 ID の昇順に条件付き UPDATE。0 行なら売り切れ）。台帳に reserve を追記
        public_id = new_public_id()
        while conn.execute("SELECT 1 FROM orders WHERE public_id = %s", (public_id,)).fetchone() is not None:
            public_id = new_public_id()
        recipe_map = inventory.recipes(conn, [line.variant_id for line in lines])
        need = inventory.requirements([(line.variant_id, line.qty) for line in lines], recipe_map)
        try:
            inventory.reserve(conn, cart["store_id"], need, ref_type="order", ref_id=public_id, actor=f"customer:{customer_id}", now=now)
        except inventory.InsufficientStock as short:
            raise ApiError(409, "sold_out", item_name=cart_service.first_line_using(lines, recipe_map, {short.item_id})) from None

        # 5. 宅配の枠（P2）。店頭受け取りは無し
        # 6. 注文・行（スナップショット）・支払い・確保・履歴
        business_date = local.date()
        pickup_no = conn.execute(
            "INSERT INTO store_order_counters (store_id, business_date, last_no) VALUES (%s, %s, 1) "
            "ON CONFLICT (store_id, business_date) DO UPDATE SET last_no = store_order_counters.last_no + 1 RETURNING last_no",
            (cart["store_id"], business_date),
        ).fetchone()["last_no"]
        order_id = conn.execute(
            "INSERT INTO orders (public_id, user_id, store_id, status, fulfillment, pickup_no, business_date, subtotal_lumi, delivery_fee_lumi, total_lumi, "
            "source, idempotency_key, placed_at) VALUES (%s, %s, %s, 'placed', 'pickup', %s, %s, %s, 0, %s, 'screen', %s, %s) RETURNING id",
            (public_id, customer_id, cart["store_id"], pickup_no, business_date, total, total, key, now),
        ).fetchone()["id"]
        for line in lines:
            conn.execute(
                "INSERT INTO order_items (order_id, variant_id, name, size, temperature, unit_price_lumi, qty, line_total_lumi) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (order_id, line.variant_id, line.item_name, line.size, line.temperature, line.unit_price_lumi, line.qty, line.line_total_lumi),
            )
        conn.execute(
            "INSERT INTO payments (order_id, provider, status, amount_lumi, created_at, updated_at) VALUES (%s, %s, 'pending', %s, %s, %s)",
            (order_id, payment.get_provider().name, total, now, now),
        )
        reservation_id = conn.execute(
            "INSERT INTO stock_reservations (order_id, status, expires_at, created_at, updated_at) VALUES (%s, 'held', %s, %s, %s) RETURNING id",
            (order_id, now + limits.RESERVATION_TTL, now, now),
        ).fetchone()["id"]
        for item_id in sorted(need):
            conn.execute("INSERT INTO stock_reservation_lines (reservation_id, item_id, qty) VALUES (%s, %s, %s)", (reservation_id, item_id, need[item_id]))
        _event(conn, order_id, None, "placed", "customer", str(customer_id), None, now)

        # 許可証を使用済みにして、カートを空にする（版も上げる）
        conn.execute("UPDATE checkout_proposals SET used_at = %s WHERE id = %s", (now, proposal["id"]))
        conn.execute("DELETE FROM cart_items WHERE cart_id = %s", (cart["id"],))
        conn.execute("UPDATE carts SET version = version + 1, updated_at = %s WHERE id = %s", (now, cart["id"]))

        order = _one(conn, "o.id = %s", (order_id,), now)
        conn.execute("UPDATE idempotency_keys SET response = %s WHERE user_id = %s AND key = %s", (Jsonb(order), customer_id, key))
        return order, True


# ---- 支払い・顧客の取消し ----

@_retrying
def pay(customer_id: int, public_id: str, simulate: str) -> dict:
    now = clock.utc_now()
    verdict: str | None = None
    with connection() as conn:
        order = _lock(conn, public_id, user_id=customer_id)
        if order["status"] != "placed":
            if order["status"] == "cancelled" and order["cancel_reason"] == "payment_timeout":
                raise ApiError(409, "reservation_expired")
            raise ApiError(409, "invalid_transition")
        res = conn.execute("SELECT id, expires_at FROM stock_reservations WHERE order_id = %s FOR UPDATE", (order["id"],)).fetchone()
        if res is not None and res["expires_at"] is not None and res["expires_at"] <= now:
            _cancel(conn, order, actor_type="system", actor_id=None, reason="payment_timeout", reservation_final="expired", now=now)
            verdict = "expired"
        else:
            result = payment.get_provider().charge(order_ref=order["public_id"], amount_lumi=order["total_lumi"], simulate=simulate)
            if result.ok:
                check_transition("placed", "paid", "system")
                conn.execute("UPDATE payments SET status = 'paid', provider_ref = %s, updated_at = %s WHERE order_id = %s", (result.provider_ref, now, order["id"]))
                conn.execute("UPDATE stock_reservations SET expires_at = NULL, updated_at = %s WHERE order_id = %s", (now, order["id"]))
                conn.execute("UPDATE orders SET status = 'paid', paid_at = %s WHERE id = %s", (now, order["id"]))
                _event(conn, order["id"], "placed", "paid", "system", None, None, now)
            else:
                _cancel(conn, order, actor_type="system", actor_id=None, reason="payment_declined", reservation_final="released", now=now)
                verdict = "declined"
        result_order = _one(conn, "o.id = %s", (order["id"],), now)
    if verdict == "expired":
        raise ApiError(409, "reservation_expired")
    if verdict == "declined":
        raise ApiError(402, "payment_declined")
    return result_order


@_retrying
def cancel_by_customer(customer_id: int, public_id: str) -> dict:
    now = clock.utc_now()
    with connection() as conn:
        order = _lock(conn, public_id, user_id=customer_id)
        _cancel(conn, order, actor_type="customer", actor_id=str(customer_id), reason="customer_request", reservation_final="released", now=now)
        return _one(conn, "o.id = %s", (order["id"],), now)


# ---- スタッフの状態遷移 ----

@_retrying
def staff_transition(staff_id: int, staff_store_id: int | None, public_id: str, action: str, reason: str | None) -> dict:
    now = clock.utc_now()
    reason = reason.strip() if reason else None
    actor_id = str(staff_id)
    with connection() as conn:
        order = _lock(conn, public_id, store_id=staff_store_id)
        if action == "cancel":
            if not reason:
                raise ApiError(422, "reason_required")
            _cancel(conn, order, actor_type="staff", actor_id=actor_id, reason=reason, reservation_final="released", now=now)
        else:
            frm, to = STAFF_ACTIONS[action]
            if order["status"] != frm:
                raise ApiError(409, "invalid_transition")
            check_transition(frm, to, "staff")
            if action == "accept":
                conn.execute("UPDATE orders SET status = 'accepted', accepted_at = %s WHERE id = %s", (now, order["id"]))
            elif action == "start":
                _consume(conn, order, actor=f"staff:{actor_id}", now=now)
                conn.execute("UPDATE orders SET status = 'preparing' WHERE id = %s", (order["id"],))
            elif action == "ready":
                conn.execute("UPDATE orders SET status = 'ready', ready_at = %s WHERE id = %s", (now, order["id"]))
            else:  # complete
                conn.execute("UPDATE orders SET status = 'completed', completed_at = %s WHERE id = %s", (now, order["id"]))
                _award_points(conn, order, now)
            _event(conn, order["id"], frm, to, "staff", actor_id, reason, now)
        return _one(conn, "o.id = %s", (order["id"],), now, staff=True)


def _consume(conn: Connection, order: dict, *, actor: str, now: datetime) -> None:
    """調理開始: 確保した原材料を消費に変える（確保 → 消費）。"""
    res = conn.execute("SELECT id, status FROM stock_reservations WHERE order_id = %s FOR UPDATE", (order["id"],)).fetchone()
    if res is None or res["status"] != "held":
        raise ApiError(409, "invalid_transition")
    inventory.consume(conn, order["store_id"], _reservation_lines(conn, res["id"]), ref_type="order", ref_id=order["public_id"], actor=actor, now=now)
    conn.execute("UPDATE stock_reservations SET status = 'consumed', updated_at = %s WHERE id = %s", (now, res["id"]))


def _award_points(conn: Connection, order: dict, now: datetime) -> None:
    """受け取り（completed）のとき、floor(合計 / 100) 点。台帳（earn は 1 注文に 1 回の部分 UNIQUE）と users.loyalty_points を同じトランザクションで。"""
    points = order["total_lumi"] // limits.LOYALTY_LUMI_PER_POINT
    if points <= 0:
        return
    earned = conn.execute(
        "INSERT INTO loyalty_ledger (user_id, order_id, points, kind, at) VALUES (%s, %s, %s, 'earn', %s) "
        "ON CONFLICT (order_id) WHERE kind = 'earn' DO NOTHING RETURNING id",
        (order["user_id"], order["id"], points, now),
    ).fetchone()
    if earned is not None:
        conn.execute("UPDATE users SET loyalty_points = loyalty_points + %s WHERE id = %s", (points, order["user_id"]))

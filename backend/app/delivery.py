"""宅配の DB 操作: 区画・住所・時間枠・カートと確定の検査（見積り）・枠の確保と戻し・注文への配達の見え方・配達員の一覧と提案。

カート（cart.py）と注文（orders.py）が呼ぶ。このファイルは cart・orders を import しない（循環を避ける）。配達の進行（割り当て・集荷・到着・不在・再配達）は dispatch.py。
ログには、住所（line・note）・暗証コードを出さない（このファイルは、ログを出さない）。

ロックの順: 確定は 在庫の残高 → 枠。既存の注文を触る操作は 注文 → 確保 → 在庫 → 配達の行 → 枠（取消しも同じ順）。枠を 2 つ触る再配達は、枠の ID の昇順。
"""

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone

from psycopg import Connection

from app import clock, delivery_rules, settings
from app.errors import ApiError

# ---- 起動の検査 ----


def check_startup() -> None:
    """起動時の検査。本番相当で DELIVERY_PIN_SECRET が無ければ失敗する。許さない設定値も、ここで失敗させる。"""
    settings.delivery_pin_secret()
    settings.delivery_mock_autopilot()
    settings.delivery_mock_step_seconds()
    settings.provider("DELIVERY_PROVIDER")
    delivery_rules.get_proposer(settings.assignment_policy())


def provider() -> str:
    return settings.provider("DELIVERY_PROVIDER")


# ---- 区画 ----

_ZONE_COLUMNS = "id, area_code, name, fee_lumi, free_over_lumi, min_order_lumi, base_minutes, is_suspended"


def zone_public(row: dict) -> dict:
    return {k: row[k] for k in ("id", "name", "area_code", "fee_lumi", "free_over_lumi", "min_order_lumi", "base_minutes", "is_suspended")}


def store_zone_ids(conn: Connection, store_id: int) -> set[int]:
    return {r["zone_id"] for r in conn.execute("SELECT zone_id FROM store_zones WHERE store_id = %s", (store_id,)).fetchall()}


def list_zones(conn: Connection, store_id: int | None = None) -> list[dict]:
    if store_id is None:
        rows = conn.execute(f"SELECT {_ZONE_COLUMNS} FROM delivery_zones ORDER BY area_code").fetchall()  # noqa: S608（固定の列名）
    else:
        rows = conn.execute(
            f"SELECT {_ZONE_COLUMNS} FROM delivery_zones WHERE id IN (SELECT zone_id FROM store_zones WHERE store_id = %s) ORDER BY area_code",  # noqa: S608
            (store_id,),
        ).fetchall()
    return [zone_public(r) for r in rows]


def load_zone(conn: Connection, zone_id: int) -> dict | None:
    return conn.execute(f"SELECT {_ZONE_COLUMNS} FROM delivery_zones WHERE id = %s", (zone_id,)).fetchone()  # noqa: S608


def zone_for_area(conn: Connection, area_code: int) -> dict | None:
    return conn.execute(f"SELECT {_ZONE_COLUMNS} FROM delivery_zones WHERE area_code = %s", (area_code,)).fetchone()  # noqa: S608


def store_home_zone_id(conn: Connection, store_id: int) -> int | None:
    """店のエリアの区画（配達員が集荷に来る先）。"""
    row = conn.execute("SELECT z.id FROM stores s JOIN delivery_zones z ON z.area_code = s.area_code WHERE s.id = %s", (store_id,)).fetchone()
    return row["id"] if row else None


def set_suspension(conn: Connection, zone_id: int, suspended: bool, now: datetime) -> dict:
    """砂嵐の警報を立てる・解除する（店長だけ。呼ぶ側が確かめる）。すでに確保した枠の注文は、取り消さない。"""
    row = conn.execute(
        f"UPDATE delivery_zones SET is_suspended = %s, suspended_at = %s WHERE id = %s RETURNING {_ZONE_COLUMNS}",  # noqa: S608
        (suspended, now if suspended else None, zone_id),
    ).fetchone()
    if row is None:
        raise ApiError(404, "zone_not_found")
    return zone_public(row)


def travel_matrix(conn: Connection) -> dict[tuple[int, int], int]:
    return {(r["from_zone_id"], r["to_zone_id"]): r["minutes"] for r in conn.execute("SELECT from_zone_id, to_zone_id, minutes FROM zone_travel_minutes").fetchall()}


# ---- 住所（🔒） ----

_ADDRESS_SELECT = (
    "SELECT a.id, a.user_id, a.label, a.area_code, ar.name AS area_name, z.id AS zone_id, a.line, a.note, a.created_at "
    "FROM addresses a JOIN areas ar ON ar.code = a.area_code LEFT JOIN delivery_zones z ON z.area_code = a.area_code "
)


def address_public(row: dict) -> dict:
    return {
        "id": row["id"], "label": row["label"], "area_code": row["area_code"], "area_name": row["area_name"], "zone_id": row["zone_id"],
        "line": row["line"], "note": row["note"], "created_at": clock.iso(row["created_at"]),
    }


def address_brief(row: dict) -> dict:
    """カート・注文の応答に出す住所（line・note は出さない）。"""
    return {"id": row["id"], "label": row["label"], "area_code": row["area_code"], "area_name": row["area_name"]}


def list_addresses(conn: Connection, user_id: int) -> list[dict]:
    return [address_public(r) for r in conn.execute(f"{_ADDRESS_SELECT}WHERE a.user_id = %s ORDER BY a.id", (user_id,)).fetchall()]


def create_address(conn: Connection, user_id: int, label: str, area_code: int, line: str, note: str | None, now: datetime) -> dict:
    if zone_for_area(conn, area_code) is None:
        raise ApiError(422, "invalid_area")
    conn.execute("SELECT id FROM users WHERE id = %s FOR UPDATE", (user_id,))  # 同じ利用者の並行した登録で、件数の上限を超えさせない
    count = conn.execute("SELECT count(*) AS n FROM addresses WHERE user_id = %s", (user_id,)).fetchone()["n"]
    if count >= delivery_rules.ADDRESS_LIMIT:
        raise ApiError(422, "too_many_addresses")
    new_id = conn.execute(
        "INSERT INTO addresses (user_id, label, area_code, line, note, created_at) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
        (user_id, label, area_code, line, note, now),
    ).fetchone()["id"]
    return address_public(conn.execute(f"{_ADDRESS_SELECT}WHERE a.id = %s", (new_id,)).fetchone())


def delete_address(conn: Connection, user_id: int, address_id: int, now: datetime) -> None:
    row = conn.execute("SELECT id FROM addresses WHERE id = %s AND user_id = %s FOR UPDATE", (address_id, user_id)).fetchone()
    if row is None:
        raise ApiError(404, "address_not_found")
    # カートが選んでいたら外す（版も上げる。外部キーは RESTRICT）。過去の注文は、配達の行に写しがある
    conn.execute("UPDATE carts SET address_id = NULL, version = version + 1, updated_at = %s WHERE address_id = %s", (now, address_id))
    conn.execute("DELETE FROM addresses WHERE id = %s", (address_id,))


def load_address(conn: Connection, address_id: int, *, share_lock: bool = False) -> dict | None:
    return conn.execute(f"{_ADDRESS_SELECT}WHERE a.id = %s" + (" FOR SHARE OF a" if share_lock else ""), (address_id,)).fetchone()


# ---- 時間枠 ----


def slot_public(row: dict) -> dict:
    return {"id": row["id"], "starts_at": clock.iso(row["starts_at"]), "ends_at": clock.iso(row["ends_at"])}


def ensure_slots(conn: Connection, store: dict, day: date) -> None:
    """その日の枠を作る（足りないものだけ。INSERT ... ON CONFLICT DO NOTHING なので、同時に呼んでも重ならない）。定休日は作らない。"""
    if store["closed_weekday"] is not None and store["closed_weekday"] == day.isoweekday():
        return
    grid = delivery_rules.slot_grid(store["open_time"], store["close_time"], store["last_order_minutes"], day, settings.local_utc_offset_hours())
    if not grid:
        return
    have = conn.execute(
        "SELECT count(*) AS n FROM delivery_slots WHERE store_id = %s AND starts_at = ANY(%s)", (store["id"], [g[0] for g in grid])
    ).fetchone()["n"]
    if have == len(grid):
        return
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO delivery_slots (store_id, starts_at, ends_at, capacity) VALUES (%s, %s, %s, %s) ON CONFLICT (store_id, starts_at) DO NOTHING",
            [(store["id"], start, end, delivery_rules.SLOT_CAPACITY) for start, end in grid],
        )


def ensure_window(conn: Connection, store: dict, today: date) -> None:
    """今日から SLOT_DAYS_AHEAD 日先までの枠を作る（seed と再配達の前）。"""
    for i in range(delivery_rules.SLOT_DAYS_AHEAD + 1):
        ensure_slots(conn, store, today + timedelta(days=i))


def _day_bounds(day: date) -> tuple[datetime, datetime]:
    tz = delivery_rules.local_tz(settings.local_utc_offset_hours())
    start = datetime.combine(day, time(0, 0), tzinfo=tz)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


def _closure_dates(conn: Connection, store_id: int) -> set[date]:
    return {r["date"] for r in conn.execute("SELECT date FROM store_closures WHERE store_id = %s", (store_id,)).fetchall()}


def list_slots(conn: Connection, store: dict, day: date, zone_id: int | None, now: datetime) -> dict:
    """その日の枠の一覧。休業・砂嵐・宅配をしない店は、reason を付けて枠を空にする。"""
    today = clock.local_now().date()
    if day < today or day > today + timedelta(days=delivery_rules.SLOT_DAYS_AHEAD):
        raise ApiError(422, "invalid_date")
    zone_ids = store_zone_ids(conn, store["id"])
    reason = _slot_list_reason(conn, store, day, zone_id, zone_ids)
    slots: list[dict] = []
    if reason is None:
        ensure_slots(conn, store, day)
        lo, hi = _day_bounds(day)
        rows = conn.execute(
            "SELECT id, starts_at, ends_at, capacity, booked FROM delivery_slots WHERE store_id = %s AND starts_at >= %s AND starts_at < %s ORDER BY starts_at",
            (store["id"], lo, hi),
        ).fetchall()
        for r in rows:
            why = delivery_rules.slot_unavailable_reason(r["starts_at"], r["booked"], r["capacity"], now)
            slots.append({**slot_public(r), "capacity": r["capacity"], "booked": r["booked"], "remaining": max(0, r["capacity"] - r["booked"]),
                          "available": why is None, "unavailable_reason": why})
        if not slots:
            reason = "closed_today"  # 定休日（その日の枠が作られない）
    return {"store_id": store["id"], "date": day.isoformat(), "zone_id": zone_id, "reason": reason, "slots": slots}


def _slot_list_reason(conn: Connection, store: dict, day: date, zone_id: int | None, zone_ids: set[int]) -> str | None:
    if not zone_ids:
        return "delivery_unavailable"
    if not store["mobile_order"]:
        return "mobile_order_unavailable"
    if day in _closure_dates(conn, store["id"]):
        return "temporary_closure"
    if zone_id is not None:
        if zone_id not in zone_ids:
            return "zone_unserved"
        zone = load_zone(conn, zone_id)
        if zone is not None and zone["is_suspended"]:
            return "storm_warning"
    if store["closed_weekday"] is not None and store["closed_weekday"] == day.isoweekday():
        return "closed_today"
    return None


def load_slot(conn: Connection, slot_id: int) -> dict | None:
    return conn.execute("SELECT id, store_id, starts_at, ends_at, capacity, booked FROM delivery_slots WHERE id = %s", (slot_id,)).fetchone()


def slot_issue(conn: Connection, slot: dict, now: datetime) -> str | None:
    """枠を選べない理由のコード（slot_closed / slot_cutoff / slot_full）。選べるなら None。休業 → 締め → 満席の順。"""
    if delivery_rules.local_date_of(slot["starts_at"], settings.local_utc_offset_hours()) in _closure_dates(conn, slot["store_id"]):
        return "slot_closed"
    why = delivery_rules.slot_unavailable_reason(slot["starts_at"], slot["booked"], slot["capacity"], now)
    return {"cutoff": "slot_cutoff", "full": "slot_full"}.get(why) if why else None


def book_slot(conn: Connection, slot_id: int, store_id: int) -> None:
    """枠を 1 つ確保する。条件付き UPDATE（booked < capacity）なので、同時でも上限を超えない。0 行なら満席（409）。"""
    row = conn.execute(
        "UPDATE delivery_slots SET booked = booked + 1 WHERE id = %s AND store_id = %s AND booked < capacity RETURNING id", (slot_id, store_id)
    ).fetchone()
    if row is None:
        raise ApiError(409, "slot_full")


def release_slot(conn: Connection, slot_id: int) -> None:
    conn.execute("UPDATE delivery_slots SET booked = booked - 1 WHERE id = %s AND booked > 0", (slot_id,))


def earliest_slot(conn: Connection, store: dict, zone: dict, now: datetime) -> dict | None:
    """再配達で、選べる中で最も早い枠（締め前・満席でない・休業でない）。区画が砂嵐なら None。"""
    if zone["is_suspended"]:
        return None
    today = clock.local_now().date()
    ensure_window(conn, store, today)
    closures = _closure_dates(conn, store["id"])
    offset = settings.local_utc_offset_hours()
    rows = conn.execute(
        "SELECT id, store_id, starts_at, ends_at, capacity, booked FROM delivery_slots WHERE store_id = %s AND starts_at >= %s AND booked < capacity "
        "ORDER BY starts_at LIMIT 400",
        (store["id"], now),
    ).fetchall()
    for r in rows:
        if delivery_rules.local_date_of(r["starts_at"], offset) in closures:
            continue
        if delivery_rules.slot_unavailable_reason(r["starts_at"], r["booked"], r["capacity"], now) is None:
            return r
    return None


# ---- カート・確定の検査（見積り） ----


@dataclass
class Resolution:
    """カートの宅配の選択を、今の状態で見たもの。issues は、確認・確定が 409 にするコード（空なら通る）。"""

    address: dict | None = None
    zone: dict | None = None
    slot: dict | None = None
    fee_lumi: int = 0
    issues: list[str] = field(default_factory=list)


def resolve(conn: Connection, cart: dict, subtotal: int, now: datetime) -> Resolution:
    res = Resolution()
    store_id = cart["store_id"]
    zone_ids = store_zone_ids(conn, store_id) if store_id is not None else set()
    if not zone_ids:
        res.issues.append("delivery_unavailable")
    if cart.get("address_id") is not None:
        res.address = load_address(conn, cart["address_id"])
    if res.address is None:
        res.issues.append("address_required")
    if cart.get("slot_id") is not None:
        slot = load_slot(conn, cart["slot_id"])
        res.slot = slot if slot is not None and slot["store_id"] == store_id else None
    if res.slot is None:
        res.issues.append("slot_required")
    if res.address is not None:
        res.zone = zone_for_area(conn, res.address["area_code"])
    if res.zone is not None:
        res.fee_lumi = delivery_rules.delivery_fee(res.zone["fee_lumi"], res.zone["free_over_lumi"], subtotal) if subtotal > 0 else 0
        if zone_ids and res.zone["id"] not in zone_ids:
            res.issues.append("out_of_zone")
        if res.zone["is_suspended"]:
            res.issues.append("zone_suspended")
        if subtotal > 0 and not delivery_rules.meets_minimum(subtotal, res.zone["min_order_lumi"]):
            res.issues.append("below_minimum")
    if res.slot is not None:
        issue = slot_issue(conn, res.slot, now)
        if issue is not None:
            res.issues.append(issue)
    return res


def cart_view(res: Resolution) -> dict:
    """Cart.delivery / CheckoutProposal.delivery（docs/api.md）。住所は line・note を出さない。"""
    zone = res.zone
    return {
        "address": address_brief(res.address) if res.address else None,
        "zone": zone_public(zone) if zone else None,
        "slot": slot_public(res.slot) if res.slot else None,
        "fee_lumi": res.fee_lumi,
        "free_over_lumi": zone["free_over_lumi"] if zone else None,
        "min_order_lumi": zone["min_order_lumi"] if zone else None,
        "issues": list(res.issues),
    }


def quote_for_cart(conn: Connection, cart: dict, subtotal: int, now: datetime) -> Resolution:
    """確認・確定の検査。通らなければ、最初の 1 件を 409（code つき）で返す。"""
    res = resolve(conn, cart, subtotal, now)
    if res.issues:
        extra = {"min_order_lumi": res.zone["min_order_lumi"]} if res.issues[0] == "below_minimum" and res.zone else {}
        raise ApiError(409, res.issues[0], **extra)
    return res


def validate_selection(conn: Connection, store_id: int, address_id: int | None, slot_id: int | None, now: datetime) -> None:
    """PUT /api/cart の検査: 住所は本人のもの（呼ぶ側が user_id で絞る）で店の区画の中、枠は店のもので選べるもの。"""
    if address_id is not None:
        address = load_address(conn, address_id, share_lock=True)
        zone_ids = store_zone_ids(conn, store_id)
        zone = zone_for_area(conn, address["area_code"]) if address else None
        if zone is not None and zone_ids and zone["id"] not in zone_ids:
            raise ApiError(409, "out_of_zone")
    if slot_id is not None:
        slot = load_slot(conn, slot_id)
        if slot is None or slot["store_id"] != store_id:
            raise ApiError(404, "slot_not_found")
        issue = slot_issue(conn, slot, now)
        if issue is not None:
            raise ApiError(409, issue)


# ---- 注文の確定・取消し ----


def create_delivery(conn: Connection, order_id: int, store_id: int, res: Resolution, now: datetime) -> None:
    """確定で、配達の行を作る（枠は、呼ぶ側が book_slot で確保済み）。住所は注文時の写しを持つ。"""
    assert res.address is not None and res.zone is not None and res.slot is not None
    conn.execute(
        "INSERT INTO deliveries (order_id, store_id, zone_id, slot_id, status, address_label, address_line, address_note, created_at) "
        "VALUES (%s, %s, %s, %s, 'pending', %s, %s, %s, %s)",
        (order_id, store_id, res.zone["id"], res.slot["id"], res.address["label"], res.address["line"], res.address["note"], now),
    )


def cancel_delivery(conn: Connection, order_id: int) -> None:
    """注文の取消し・期限切れ・支払いの失敗で、枠を戻して配達を cancelled にする（注文の行は、呼ぶ側が FOR UPDATE 済み）。"""
    d = conn.execute("SELECT id, slot_id, status FROM deliveries WHERE order_id = %s FOR UPDATE", (order_id,)).fetchone()
    if d is None or d["status"] == "cancelled":
        return
    release_slot(conn, d["slot_id"])
    conn.execute("UPDATE deliveries SET status = 'cancelled' WHERE id = %s", (d["id"],))


# ---- 注文の応答に出す配達 ----

_VIEW_SELECT = (
    "SELECT d.id, d.order_id, d.status, d.zone_id, z.name AS zone_name, z.base_minutes, d.slot_id, sl.starts_at, sl.ends_at, d.courier_id, "
    "a.name AS courier_name, d.address_label, d.pin_nonce, d.pin_expires_at, d.attempt, d.failure_reason, d.departed_at "
    "FROM deliveries d JOIN delivery_zones z ON z.id = d.zone_id JOIN delivery_slots sl ON sl.id = d.slot_id "
    "LEFT JOIN staff_accounts a ON a.id = d.courier_id "
)


def views_for_orders(conn: Connection, order_ids: list[int], *, staff: bool, now: datetime) -> dict[int, dict]:
    """注文 ID → delivery（docs/api.md）。顧客には、courier は名前だけ・暗証コードは集荷後だけ。スタッフには、courier の ID と名前・暗証コードなし・住所なし。"""
    if not order_ids:
        return {}
    result: dict[int, dict] = {}
    secret = settings.delivery_pin_secret()
    for r in conn.execute(f"{_VIEW_SELECT}WHERE d.order_id = ANY(%s)", (order_ids,)).fetchall():
        view = {
            "status": r["status"], "zone": {"id": r["zone_id"], "name": r["zone_name"]},
            "slot": {"id": r["slot_id"], "starts_at": clock.iso(r["starts_at"]), "ends_at": clock.iso(r["ends_at"])},
            "attempt": r["attempt"], "failure_reason": r["failure_reason"],
        }
        if staff:
            view["courier"] = {"id": r["courier_id"], "name": r["courier_name"]} if r["courier_id"] is not None else None
        else:
            view["courier"] = {"name": r["courier_name"]} if r["courier_id"] is not None else None
            show_pin = r["status"] in ("picked_up", "delivering") and r["pin_nonce"] is not None and r["pin_expires_at"] is not None and r["pin_expires_at"] > now
            view["pin"] = delivery_rules.derive_pin(secret, r["id"], r["pin_nonce"]) if show_pin else None
            eta = delivery_rules.eta_at(r["status"], r["starts_at"], r["departed_at"], r["base_minutes"])
            view["eta_at"] = clock.iso(eta) if eta else None
            view["address"] = {"label": r["address_label"]}
        result[r["order_id"]] = view
    return result


# ---- 配達員 ----


def list_couriers(conn: Connection, store_id: int | None) -> list[dict]:
    """配達員（担当中の件数・最後にいた区画つき）。有効なアカウントだけ。store_id が None なら全店。"""
    rows = conn.execute(
        "SELECT c.staff_id AS id, c.store_id, a.name, c.vehicle, c.is_on_duty, c.zone_id, z.name AS zone_name, "
        "(SELECT count(*) FROM deliveries d WHERE d.courier_id = c.staff_id AND d.status = ANY(%s)) AS active_count "
        "FROM couriers c JOIN staff_accounts a ON a.id = c.staff_id AND a.is_active AND a.role = 'courier' "
        "LEFT JOIN delivery_zones z ON z.id = c.zone_id WHERE (%s::integer IS NULL OR c.store_id = %s) ORDER BY c.store_id, c.staff_id",
        (list(delivery_rules.ACTIVE_STATUSES), store_id, store_id),
    ).fetchall()
    return rows


def courier_public(row: dict) -> dict:
    return {
        "id": row["id"], "store_id": row["store_id"], "name": row["name"], "vehicle": row["vehicle"], "is_on_duty": row["is_on_duty"],
        "active_count": row["active_count"], "zone": {"id": row["zone_id"], "name": row["zone_name"]} if row["zone_id"] is not None else None,
    }


def suggestion_for_store(couriers: list[dict], store_zone_id: int | None, matrix: dict[tuple[int, int], int]) -> dict | None:
    """その店の配達員（list_couriers の行）から、提案の先頭。提案できなければ None。方針は ASSIGNMENT_POLICY（差し替えられる）。"""
    if store_zone_id is None:
        return None
    candidates = [
        delivery_rules.CourierCandidate(c["id"], c["name"], c["zone_id"], c["active_count"], c["is_on_duty"]) for c in couriers
    ]
    ranked = delivery_rules.get_proposer(settings.assignment_policy())(candidates, store_zone_id, matrix)
    if not ranked:
        return None
    top = ranked[0]
    return {"courier_id": top.courier_id, "courier_name": top.courier_name, "minutes": top.minutes}

"""カート（顧客）。価格はいつも今のメニューから計算し、カートには保存しない。変更のたびに version を上げる。

カートの行のロック: 変更・確定は carts の行を FOR UPDATE で押さえてから行う（版の増加・行数の上限・提案の検査を、同じ利用者の並行リクエストでも崩さない）。
"""

from dataclasses import dataclass
from datetime import datetime

from psycopg import Connection

from app import clock, delivery, inventory, limits, rules, stores
from app.errors import ApiError

PICKUP_NOTE = "店頭でお渡しします"


@dataclass(frozen=True)
class Line:
    variant_id: int
    item_id: int
    item_code: str
    item_name: str
    size: str
    temperature: str
    unit_price_lumi: int
    qty: int
    reason: str | None  # None なら出せる

    @property
    def line_total_lumi(self) -> int:
        return self.unit_price_lumi * self.qty

    def public(self) -> dict:
        return {
            "variant_id": self.variant_id, "item_code": self.item_code, "name": self.item_name, "size": self.size,
            "temperature": self.temperature, "unit_price_lumi": self.unit_price_lumi, "qty": self.qty,
            "line_total_lumi": self.line_total_lumi, "available": self.reason is None, "unavailable_reason": self.reason,
        }


def get_cart(conn: Connection, user_id: int, now: datetime, *, lock: bool = False) -> dict:
    sql = "SELECT id, store_id, fulfillment, version, address_id, slot_id FROM carts WHERE user_id = %s" + (" FOR UPDATE" if lock else "")
    row = conn.execute(sql, (user_id,)).fetchone()
    if row is None:
        conn.execute("INSERT INTO carts (user_id, updated_at) VALUES (%s, %s) ON CONFLICT (user_id) DO NOTHING", (user_id, now))
        row = conn.execute(sql, (user_id,)).fetchone()
    return row


def price_lines(conn: Connection, cart: dict, now_local: datetime) -> list[Line]:
    """カートの行を、今のメニューの価格と、季節・時間帯・（店が決まっていれば）在庫の状態で組み立てる。"""
    rows = conn.execute(
        "SELECT ci.variant_id, ci.qty, v.size, v.temperature, v.price_lumi, i.id AS item_id, i.code AS item_code, i.name, "
        "i.is_active, i.season_from, i.season_to, i.sold_from, i.sold_until "
        "FROM cart_items ci JOIN menu_variants v ON v.id = ci.variant_id JOIN menu_items i ON i.id = v.item_id "
        "WHERE ci.cart_id = %s ORDER BY ci.added_at, ci.variant_id",
        (cart["id"],),
    ).fetchall()
    stock = inventory.variant_stock(conn, cart["store_id"], [r["variant_id"] for r in rows]) if cart["store_id"] is not None else {}
    lines = []
    for r in rows:
        reason = rules.item_unavailable_reason(r, now_local)
        if reason is None and cart["store_id"] is not None and inventory.is_sold_out(stock.get(r["variant_id"], []), r["qty"]):
            reason = "sold_out"
        lines.append(Line(r["variant_id"], r["item_id"], r["item_code"], r["name"], r["size"], r["temperature"], r["price_lumi"], r["qty"], reason))
    return lines


def view(conn: Connection, cart: dict, lines: list[Line], now: datetime | None = None) -> dict:
    store = None
    if cart["store_id"] is not None:
        row = conn.execute("SELECT id, name FROM stores WHERE id = %s", (cart["store_id"],)).fetchone()
        store = {"id": row["id"], "name": row["name"]} if row else None
    subtotal = sum(line.line_total_lumi for line in lines)
    result = {
        "version": cart["version"], "store": store, "fulfillment": cart["fulfillment"], "lines": [line.public() for line in lines],
        "subtotal_lumi": subtotal, "delivery_fee_lumi": 0, "total_lumi": subtotal, "delivery": None,
    }
    if cart["fulfillment"] == "delivery":  # 宅配（P2）: 送料と、選択の状態（issues）
        res = delivery.resolve(conn, cart, subtotal, now or clock.utc_now())
        result.update({"delivery_fee_lumi": res.fee_lumi, "total_lumi": subtotal + res.fee_lumi, "delivery": delivery.cart_view(res)})
    return result


def _bump(conn: Connection, cart_id: int, now: datetime) -> None:
    conn.execute("UPDATE carts SET version = version + 1, updated_at = %s WHERE id = %s", (now, cart_id))


def _reload(conn: Connection, user_id: int, now: datetime, now_local: datetime) -> dict:
    cart = get_cart(conn, user_id, now)
    return view(conn, cart, price_lines(conn, cart, now_local), now)


def read(conn: Connection, user_id: int, now: datetime, now_local: datetime) -> dict:
    return _reload(conn, user_id, now, now_local)


def set_store(
    conn: Connection, user_id: int, store_id: int | None, fulfillment: str, now: datetime, now_local: datetime,
    address_id: int | None = None, slot_id: int | None = None,
) -> dict:
    """店と受け取り方法（と、宅配の住所・枠）を、全部置き換える。省略した address_id・slot_id は null。"""
    has_delivery_fields = address_id is not None or slot_id is not None
    if fulfillment == "pickup" and has_delivery_fields:
        raise ApiError(422, "pickup_with_delivery_fields")
    if store_id is not None and stores.load(conn, store_id) is None:
        raise ApiError(404, "store_not_found")
    if fulfillment == "delivery" and store_id is None and has_delivery_fields:
        raise ApiError(422, "store_required")
    if fulfillment == "delivery" and store_id is not None:
        # 住所の行ロック（FOR SHARE）を、カートのロックより先に取る（住所の削除は 住所 → カートの順。逆にしない）
        if address_id is not None and conn.execute("SELECT 1 FROM addresses WHERE id = %s AND user_id = %s", (address_id, user_id)).fetchone() is None:
            raise ApiError(404, "address_not_found")
        delivery.validate_selection(conn, store_id, address_id, slot_id, now)
    cart = get_cart(conn, user_id, now, lock=True)
    conn.execute(
        "UPDATE carts SET store_id = %s, fulfillment = %s, address_id = %s, slot_id = %s WHERE id = %s",
        (store_id, fulfillment, address_id, slot_id, cart["id"]),
    )
    _bump(conn, cart["id"], now)
    return _reload(conn, user_id, now, now_local)


def set_item(conn: Connection, user_id: int, variant_id: int, qty: int, now: datetime, now_local: datetime) -> dict:
    """絶対値指定。qty 0 で外す。1 注文の行は 30 まで。**値が変わらないときは版を上げない**（二重クリック・再送・チャットと画面の同じ指定で、確定の許可証が無効にならない）。"""
    cart = get_cart(conn, user_id, now, lock=True)
    changed = True
    if qty == 0:
        changed = conn.execute("DELETE FROM cart_items WHERE cart_id = %s AND variant_id = %s RETURNING 1", (cart["id"], variant_id)).fetchone() is not None
    else:
        variant = conn.execute(
            "SELECT v.id FROM menu_variants v JOIN menu_items i ON i.id = v.item_id WHERE v.id = %s AND i.is_active", (variant_id,)
        ).fetchone()
        if variant is None:
            raise ApiError(404, "variant_not_found")
        current = conn.execute("SELECT qty FROM cart_items WHERE cart_id = %s AND variant_id = %s", (cart["id"], variant_id)).fetchone()
        if current is None:
            count = conn.execute("SELECT count(*) AS n FROM cart_items WHERE cart_id = %s", (cart["id"],)).fetchone()["n"]
            if count >= limits.MAX_LINES:
                raise ApiError(422, "too_many_lines")
        elif current["qty"] == qty:
            changed = False
        if changed:
            conn.execute(
                "INSERT INTO cart_items (cart_id, variant_id, qty, added_at) VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (cart_id, variant_id) DO UPDATE SET qty = EXCLUDED.qty",
                (cart["id"], variant_id, qty, now),
            )
    if changed:
        _bump(conn, cart["id"], now)
    return _reload(conn, user_id, now, now_local)


def clear(conn: Connection, user_id: int, now: datetime, now_local: datetime) -> dict:
    """カートの品を空にする（受け取る店の選択は残す）。"""
    cart = get_cart(conn, user_id, now, lock=True)
    conn.execute("DELETE FROM cart_items WHERE cart_id = %s", (cart["id"],))
    _bump(conn, cart["id"], now)
    return _reload(conn, user_id, now, now_local)


# ---- 確定の検証（提案の作成と、注文の確定が同じ検査を使う） ----

def first_line_using(lines: list[Line], recipe_map: dict[int, list[tuple[int, int]]], item_ids: set[int]) -> str | None:
    """指定の在庫品目を使う、最初の行の品名。"""
    for line in lines:
        if any(item_id in item_ids for item_id, _ in recipe_map.get(line.variant_id, [])):
            return line.item_name
    return None


def validate_checkout(conn: Connection, cart: dict, lines: list[Line], now_local: datetime, *, check_stock: bool) -> int:
    """確定できる状態か検査し、合計を返す。できなければ 409（`code` つき）。check_stock は、確保の前の目安の検査（確保そのものが最終の判定）。"""
    if not lines:
        raise ApiError(409, "cart_empty")
    if cart["store_id"] is None:
        raise ApiError(409, "store_not_selected")
    store = stores.load(conn, cart["store_id"])
    reason = stores.closed_reason(conn, store, now_local)
    if reason is not None:
        raise ApiError(409, "store_closed", closed_reason=reason)
    unavailable = [line.variant_id for line in lines if line.reason in ("out_of_season", "out_of_hours")]
    if unavailable:
        raise ApiError(409, "item_unavailable", variant_ids=unavailable)
    total = sum(line.line_total_lumi for line in lines)
    if total > limits.MAX_TOTAL_LUMI:
        raise ApiError(409, "over_limit")
    subtotal = total
    if check_stock:
        recipe_map = inventory.recipes(conn, [line.variant_id for line in lines])
        need = inventory.requirements([(line.variant_id, line.qty) for line in lines], recipe_map)
        available = inventory.available_by_item(conn, cart["store_id"], need)
        short = {item_id for item_id, n in need.items() if available.get(item_id, 0) < n}
        if short:
            raise ApiError(409, "sold_out", item_name=first_line_using(lines, recipe_map, short))
    if cart["fulfillment"] == "delivery":  # 宅配（P2）: 住所・区画・砂嵐・最低注文額・枠を検査し、送料を足す（通らなければ 409）
        total = subtotal + delivery.quote_for_cart(conn, cart, subtotal, clock.utc_now()).fee_lumi
    return total


def create_proposal(conn: Connection, user_id: int, now: datetime, now_local: datetime) -> dict:
    cart = get_cart(conn, user_id, now, lock=True)
    lines = price_lines(conn, cart, now_local)
    total = validate_checkout(conn, cart, lines, now_local, check_stock=True)
    expires_at = now + limits.PROPOSAL_TTL
    proposal_id = conn.execute(
        "INSERT INTO checkout_proposals (cart_id, cart_version, total_lumi, expires_at, created_at) VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (cart["id"], cart["version"], total, expires_at, now),
    ).fetchone()["id"]
    store = conn.execute("SELECT id, name FROM stores WHERE id = %s", (cart["store_id"],)).fetchone()
    subtotal = sum(line.line_total_lumi for line in lines)
    delivering = cart["fulfillment"] == "delivery"
    return {
        "id": str(proposal_id), "cart_version": cart["version"], "total_lumi": total, "expires_at": clock.iso(expires_at),
        "store": {"id": store["id"], "name": store["name"]}, "lines": [line.public() for line in lines],
        "fulfillment": cart["fulfillment"], "subtotal_lumi": subtotal, "delivery_fee_lumi": total - subtotal,
        "delivery": delivery.cart_view(delivery.resolve(conn, cart, subtotal, now)) if delivering else None,
        "pickup_note": None if delivering else PICKUP_NOTE,
    }

"""分析のテストの道具。過去の営業日の注文・利用者を、DB へ直接入れる（API を通さない）。"""

import random
from datetime import date, datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
OFFSET_HOURS = 9  # 店のローカル時刻（既定 UTC+9）


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, row_factory=dict_row, autocommit=True)


def store_id(conn, code: str) -> int:
    return conn.execute("SELECT id FROM stores WHERE code = %s", (code,)).fetchone()["id"]


def variant_id(conn, item_code: str, size: str = "-", temperature: str = "-") -> int:
    return conn.execute(
        "SELECT v.id FROM menu_variants v JOIN menu_items i ON i.id = v.item_id WHERE i.code = %s AND v.size = %s AND v.temperature = %s",
        (item_code, size, temperature),
    ).fetchone()["id"]


def add_user(conn, name: str) -> int:
    return conn.execute(
        "INSERT INTO users (auth_user_id, display_name) VALUES (%s, %s) ON CONFLICT (auth_user_id) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id",
        (f"dev:{name}", name),
    ).fetchone()["id"]


_rng = random.Random(7)


def add_order(conn, *, user: int, store: int, day: date, hour: int = 9, minute: int = 15, status: str = "completed",
              lines: list[tuple[int, int]], fulfillment: str = "pickup", delivery_fee: int = 0, completed_day: date | None = None) -> str:
    """business_date = day、placed_at = day の hour:minute（店のローカル時刻）の注文を入れる。status は completed / cancelled / paid など。public_id を返す。
    delivery_fee は送料（total = 小計 + 送料。既定 0）。completed_day は completed になった日（店のローカル時刻の 12:00。既定は placed の 12 分後）。"""
    public_id = "".join(_rng.choice(ALPHABET) for _ in range(8))
    prices = {r["id"]: r for r in conn.execute(
        "SELECT v.id, v.size, v.temperature, v.price_lumi, i.name FROM menu_variants v JOIN menu_items i ON i.id = v.item_id WHERE v.id = ANY(%s)", ([v for v, _ in lines],))}
    subtotal = sum(prices[v]["price_lumi"] * q for v, q in lines)
    placed = (datetime(day.year, day.month, day.day, hour, minute) - timedelta(hours=OFFSET_HOURS)).replace(tzinfo=timezone.utc)
    completed_at = (
        (datetime(completed_day.year, completed_day.month, completed_day.day, 12, 0) - timedelta(hours=OFFSET_HOURS)).replace(tzinfo=timezone.utc)
        if completed_day else placed + timedelta(minutes=12)
    )
    number = conn.execute("SELECT COALESCE(max(pickup_no), 0) + 1 AS n FROM orders WHERE store_id = %s AND business_date = %s", (store, day)).fetchone()["n"]
    order_id = conn.execute(
        "INSERT INTO orders (public_id, user_id, store_id, status, fulfillment, pickup_no, business_date, subtotal_lumi, delivery_fee_lumi, total_lumi, idempotency_key, placed_at, "
        "completed_at, cancelled_at, cancel_reason) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (public_id, user, store, status, fulfillment, number, day, subtotal, delivery_fee, subtotal + delivery_fee, f"t-{public_id}", placed,
         completed_at if status == "completed" else None, placed + timedelta(minutes=3) if status == "cancelled" else None,
         "customer_request" if status == "cancelled" else None),
    ).fetchone()["id"]
    for v, q in lines:
        p = prices[v]
        conn.execute(
            "INSERT INTO order_items (order_id, variant_id, name, size, temperature, unit_price_lumi, qty, line_total_lumi) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (order_id, v, p["name"], p["size"], p["temperature"], p["price_lumi"], q, p["price_lumi"] * q),
        )
    return public_id


def table_rows(conn, table: str, columns: str, where: str = "true") -> list[tuple]:
    """analytics の表の内容（built_at は除く）。比べやすいように、タプルのリストで返す。"""
    return [tuple(r.values()) for r in conn.execute(f"SELECT {columns} FROM analytics.{table} WHERE {where} ORDER BY 1, 2, 3, 4")]  # noqa: S608（テスト内の固定の文字列）

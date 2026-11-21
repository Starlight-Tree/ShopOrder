"""店の読み取りと、「今、注文を受けられるか」の判定（DB の読み取り + rules.py の純粋な判定）。"""

from datetime import datetime

from psycopg import Connection

from app import rules

_STORE_COLUMNS = "id, code, name, area_code, address, open_time, close_time, closed_weekday, last_order_minutes, mobile_order, seats"


def load(conn: Connection, store_id: int) -> dict | None:
    return conn.execute(f"SELECT {_STORE_COLUMNS} FROM stores WHERE id = %s", (store_id,)).fetchone()  # noqa: S608（固定の列名）


def closed_store_ids(conn: Connection, now_local: datetime) -> set[int]:
    """今日（ローカルの日付）に臨時休業の店。"""
    return {r["store_id"] for r in conn.execute("SELECT store_id FROM store_closures WHERE date = %s", (now_local.date(),)).fetchall()}


def closed_reason(conn: Connection, store: dict, now_local: datetime) -> str | None:
    return rules.closed_reason(store, store["id"] in closed_store_ids(conn, now_local), now_local)

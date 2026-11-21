"""在庫: 台帳（stock_movements。追記のみ）+ 残高（stock_balances）。docs/decisions/0004、docs/order-flow.md「注文の確定」「在庫の操作」。

- 残高の更新と台帳の追記は、呼ぶ側のトランザクションの中で行う（途中で失敗すれば両方戻る）。ここでは commit しない。
- 確保（reserve）は、品目 ID の昇順に、1 文の条件付き UPDATE（available = on_hand - reserved - safety_stock >= n）。0 行なら不足。
  同じ行を 2 つのトランザクションが更新するときは、後の方が前の commit を待ち、更新後の値で条件を評価し直す（READ COMMITTED）。
  CHECK（on_hand >= 0・reserved <= on_hand）が最後の砦。ロックの順は、いつも品目 ID の昇順（デッドロックを避ける）。
- 台帳の符号つきの数量: reserve +n / release -n / consume -n（on_hand と reserved の両方）/ receive +n / waste -n / adjust ±n。
  on_hand = Σ(receive, consume, waste, adjust)、reserved = Σ(reserve, release, consume)。reconcile() が、残高とこの合計の食い違いを返す。
"""

from collections.abc import Iterable
from datetime import datetime

from psycopg import Connection


class InsufficientStock(Exception):
    """確保・廃棄・調整ができない（在庫が足りない）。item_id は、足りなかった品目。"""

    def __init__(self, item_id: int):
        super().__init__("insufficient stock")
        self.item_id = item_id


def _movement(conn: Connection, store_id: int, item_id: int, kind: str, qty: int, *, ref_type: str | None, ref_id: str | None,
              reason: str | None, actor: str, now: datetime) -> None:
    conn.execute(
        "INSERT INTO stock_movements (store_id, item_id, kind, qty, ref_type, ref_id, reason, actor, occurred_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (store_id, item_id, kind, qty, ref_type, ref_id, reason, actor, now),
    )


# ---- レシピと必要量 ----

def recipes(conn: Connection, variant_ids: Iterable[int]) -> dict[int, list[tuple[int, int]]]:
    """変種 ID → [(品目 ID, 1 つあたりの量)]。レシピの無い変種は空のリスト。"""
    ids = sorted(set(variant_ids))
    result: dict[int, list[tuple[int, int]]] = {v: [] for v in ids}
    if ids:
        rows = conn.execute(
            "SELECT variant_id, stock_item_id, qty FROM recipe_lines WHERE variant_id = ANY(%s) ORDER BY variant_id, stock_item_id", (ids,)
        ).fetchall()
        for r in rows:
            result[r["variant_id"]].append((r["stock_item_id"], r["qty"]))
    return result


def requirements(lines: Iterable[tuple[int, int]], recipe_map: dict[int, list[tuple[int, int]]]) -> dict[int, int]:
    """注文の行（変種 ID, 数量）× レシピ → 品目 ID ごとの必要量の合計。"""
    need: dict[int, int] = {}
    for variant_id, qty in lines:
        for item_id, per_unit in recipe_map.get(variant_id, []):
            need[item_id] = need.get(item_id, 0) + per_unit * qty
    return need


def available_by_item(conn: Connection, store_id: int, item_ids: Iterable[int]) -> dict[int, int]:
    """品目 ID → 今出せる量（on_hand - reserved - safety_stock。残高の行が無ければ 0 から安全在庫を引いた値）。"""
    ids = sorted(set(item_ids))
    if not ids:
        return {}
    rows = conn.execute(
        "SELECT i.id AS item_id, COALESCE(b.on_hand - b.reserved, 0) - i.safety_stock AS available "
        "FROM stock_items i LEFT JOIN stock_balances b ON b.item_id = i.id AND b.store_id = %s WHERE i.id = ANY(%s)",
        (store_id, ids),
    ).fetchall()
    return {r["item_id"]: r["available"] for r in rows}


def variant_stock(conn: Connection, store_id: int, variant_ids: Iterable[int]) -> dict[int, list[tuple[int, int]]]:
    """変種 ID → [(1 つあたりの量, 今出せる量)]。メニュー・カートの「売り切れ」の表示に使う（確保はしない）。"""
    ids = sorted(set(variant_ids))
    result: dict[int, list[tuple[int, int]]] = {v: [] for v in ids}
    if ids:
        rows = conn.execute(
            "SELECT r.variant_id, r.qty AS per_unit, COALESCE(b.on_hand - b.reserved, 0) - i.safety_stock AS available "
            "FROM recipe_lines r JOIN stock_items i ON i.id = r.stock_item_id "
            "LEFT JOIN stock_balances b ON b.item_id = r.stock_item_id AND b.store_id = %s WHERE r.variant_id = ANY(%s)",
            (store_id, ids),
        ).fetchall()
        for r in rows:
            result[r["variant_id"]].append((r["per_unit"], r["available"]))
    return result


def is_sold_out(stock: list[tuple[int, int]], qty: int) -> bool:
    return any(available < per_unit * qty for per_unit, available in stock)


# ---- 確保・解放・消費（注文の流れ） ----

def reserve(conn: Connection, store_id: int, need: dict[int, int], *, ref_type: str, ref_id: str, actor: str, now: datetime) -> None:
    """品目 ID の昇順に条件付き UPDATE。足りなければ InsufficientStock（呼ぶ側がトランザクションごと戻す）。"""
    for item_id in sorted(need):
        n = need[item_id]
        cur = conn.execute(
            "UPDATE stock_balances AS b SET reserved = b.reserved + %s, updated_at = %s FROM stock_items AS i "
            "WHERE b.store_id = %s AND b.item_id = %s AND i.id = b.item_id AND b.on_hand - b.reserved - i.safety_stock >= %s",
            (n, now, store_id, item_id, n),
        )
        if cur.rowcount != 1:
            raise InsufficientStock(item_id)
        _movement(conn, store_id, item_id, "reserve", n, ref_type=ref_type, ref_id=ref_id, reason=None, actor=actor, now=now)


def release(conn: Connection, store_id: int, need: dict[int, int], *, ref_type: str, ref_id: str, reason: str, actor: str, now: datetime) -> None:
    for item_id in sorted(need):
        n = need[item_id]
        cur = conn.execute(
            "UPDATE stock_balances SET reserved = reserved - %s, updated_at = %s WHERE store_id = %s AND item_id = %s", (n, now, store_id, item_id)
        )
        if cur.rowcount != 1:
            raise RuntimeError("確保した残高の行がありません")
        _movement(conn, store_id, item_id, "release", -n, ref_type=ref_type, ref_id=ref_id, reason=reason, actor=actor, now=now)


def consume(conn: Connection, store_id: int, need: dict[int, int], *, ref_type: str, ref_id: str, actor: str, now: datetime) -> None:
    """確保した分を消費に変える（on_hand と reserved の両方から引く）。"""
    for item_id in sorted(need):
        n = need[item_id]
        cur = conn.execute(
            "UPDATE stock_balances SET on_hand = on_hand - %s, reserved = reserved - %s, updated_at = %s WHERE store_id = %s AND item_id = %s",
            (n, n, now, store_id, item_id),
        )
        if cur.rowcount != 1:
            raise RuntimeError("確保した残高の行がありません")
        _movement(conn, store_id, item_id, "consume", -n, ref_type=ref_type, ref_id=ref_id, reason=None, actor=actor, now=now)


# ---- スタッフの操作（入荷・廃棄・棚卸し） ----

def receive(conn: Connection, store_id: int, item_id: int, qty: int, *, reason: str | None, actor: str, now: datetime) -> None:
    conn.execute(
        "INSERT INTO stock_balances (store_id, item_id, on_hand, reserved, updated_at) VALUES (%s, %s, %s, 0, %s) "
        "ON CONFLICT (store_id, item_id) DO UPDATE SET on_hand = stock_balances.on_hand + EXCLUDED.on_hand, updated_at = EXCLUDED.updated_at",
        (store_id, item_id, qty, now),
    )
    _movement(conn, store_id, item_id, "receive", qty, ref_type="manual", ref_id=None, reason=reason, actor=actor, now=now)


def waste(conn: Connection, store_id: int, item_id: int, qty: int, *, reason: str, actor: str, now: datetime) -> None:
    """廃棄。確保中の分は捨てられない（on_hand - reserved >= qty）。"""
    cur = conn.execute(
        "UPDATE stock_balances SET on_hand = on_hand - %s, updated_at = %s WHERE store_id = %s AND item_id = %s AND on_hand - reserved >= %s",
        (qty, now, store_id, item_id, qty),
    )
    if cur.rowcount != 1:
        raise InsufficientStock(item_id)
    _movement(conn, store_id, item_id, "waste", -qty, ref_type="manual", ref_id=None, reason=reason, actor=actor, now=now)


def adjust(conn: Connection, store_id: int, item_id: int, delta: int, *, reason: str, actor: str, now: datetime) -> None:
    """棚卸しの差異を、調整の行として足す（履歴は書き換えない）。確保中の分を下回る調整はできない。"""
    if delta > 0:
        conn.execute(
            "INSERT INTO stock_balances (store_id, item_id, on_hand, reserved, updated_at) VALUES (%s, %s, 0, 0, %s) ON CONFLICT (store_id, item_id) DO NOTHING",
            (store_id, item_id, now),
        )
    cur = conn.execute(
        "UPDATE stock_balances SET on_hand = on_hand + %s, updated_at = %s WHERE store_id = %s AND item_id = %s AND on_hand + %s >= reserved",
        (delta, now, store_id, item_id, delta),
    )
    if cur.rowcount != 1:
        raise InsufficientStock(item_id)
    _movement(conn, store_id, item_id, "adjust", delta, ref_type="manual", ref_id=None, reason=reason, actor=actor, now=now)


def item_exists(conn: Connection, item_id: int) -> bool:
    return conn.execute("SELECT 1 FROM stock_items WHERE id = %s", (item_id,)).fetchone() is not None


def stock_row(conn: Connection, store_id: int, item_id: int) -> dict | None:
    rows = list_stock(conn, store_id, item_id=item_id)
    return rows[0] if rows else None


def list_stock(conn: Connection, store_id: int, *, item_id: int | None = None) -> list[dict]:
    """店の在庫の一覧（残高の行が無い品目は 0）。available = on_hand - reserved - safety_stock、low = available < reorder_point。"""
    rows = conn.execute(
        "SELECT i.id AS item_id, i.code, i.name, i.kind, i.unit, COALESCE(b.on_hand, 0) AS on_hand, COALESCE(b.reserved, 0) AS reserved, "
        "i.safety_stock, i.reorder_point FROM stock_items i LEFT JOIN stock_balances b ON b.item_id = i.id AND b.store_id = %s "
        "WHERE (%s::int IS NULL OR i.id = %s) ORDER BY i.kind, i.id",
        (store_id, item_id, item_id),
    ).fetchall()
    result = []
    for r in rows:
        available = r["on_hand"] - r["reserved"] - r["safety_stock"]
        result.append({
            "item_id": r["item_id"], "code": r["code"], "name": r["name"], "kind": r["kind"], "unit": r["unit"],
            "on_hand": r["on_hand"], "reserved": r["reserved"], "available": available,
            "reorder_point": r["reorder_point"], "low": available < r["reorder_point"],
        })
    return result


def reconcile(conn: Connection) -> list[dict]:
    """台帳から再計算した on_hand・reserved と、残高の食い違い（夜間の照合の本体）。食い違いが無ければ空のリスト。"""
    rows = conn.execute(
        "WITH led AS (SELECT store_id, item_id, "
        "COALESCE(SUM(qty) FILTER (WHERE kind IN ('receive', 'consume', 'waste', 'adjust')), 0) AS on_hand, "
        "COALESCE(SUM(qty) FILTER (WHERE kind IN ('reserve', 'release', 'consume')), 0) AS reserved "
        "FROM stock_movements GROUP BY store_id, item_id) "
        "SELECT COALESCE(b.store_id, l.store_id) AS store_id, COALESCE(b.item_id, l.item_id) AS item_id, "
        "b.on_hand AS balance_on_hand, b.reserved AS balance_reserved, l.on_hand AS ledger_on_hand, l.reserved AS ledger_reserved "
        "FROM stock_balances b FULL JOIN led l ON l.store_id = b.store_id AND l.item_id = b.item_id "
        "WHERE COALESCE(b.on_hand, 0) <> COALESCE(l.on_hand, 0) OR COALESCE(b.reserved, 0) <> COALESCE(l.reserved, 0) "
        "ORDER BY 1, 2"
    ).fetchall()
    return [dict(r) for r in rows]

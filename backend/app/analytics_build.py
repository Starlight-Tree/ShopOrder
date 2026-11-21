"""日次集計の作成（元データ → analytics の表）。指標の定義は docs/metrics.md。

    python -m app.analytics_build               # 前回の続き（直近 3 日ぶんは作り直す）から、昨日まで
    python -m app.analytics_build --all         # 最初の注文の日から、昨日まで
    python -m app.analytics_build --from 2026-09-01 --to 2026-09-30
    python -m app.analytics_build --rekey       # 仮名 ID の鍵を変えたとき。顧客の表（仮名 ID の対応を含む）を空にして作り直す

- 確定した日（business_date < 今日）だけを作る。当日は元データから都度（API が読む）。
- 日付の範囲を、1 つのトランザクションで置き換える（同じ入力なら何度流しても同じ結果。アドバイザリーロックで同時に 2 つ動かさない）。
- 営業日は analytics.store_days()（定休日 + 臨時休業。注文のある日は営業日）。営業日は売上 0 でも summary の行を作り、休業日は行を作らない。
- 顧客は、秘密の鍵（ANALYTICS_PSEUDONYM_KEY）の HMAC の仮名 ID だけを analytics に置く。鍵が前回と違えば、止まる（--rekey で作り直す）。
- 出力は件数だけ。鍵・個人情報は出さない。
"""

import hashlib
import hmac
import sys
from datetime import date, datetime, timedelta

import psycopg

from app import analytics_rules as rules
from app import clock, settings

LOCK_KEY = 7_204_006
LOOKBACK_DAYS = 15  # 前回の続きから作るとき、直近のこの日数ぶんは作り直す（確定の後に変わった注文を拾う）。宅配は枠を 7 日先まで選べ、再配達でさらに 7 日延びうるので、
# 確定から completed まで最長で約 14 日かかる。それを超える日数にしておく（日付は確定した日。完了した日ではない）
RFM_WINDOW_DAYS = 90  # RFM の期間（今日の手前の 90 日）

_DAILY_TABLES = ("daily_store_summary", "daily_store_item_sales", "daily_store_hourly", "daily_stock_levels", "daily_stock_waste")
_CUSTOMER_TABLES = ("customer_rfm", "customer_monthly")


class KeyChanged(RuntimeError):
    """仮名 ID の鍵が、前に集計を作ったときと違う。"""


def pseudonym_id(key: bytes, user_id: int) -> str:
    """顧客の仮名 ID。鍵つきの HMAC-SHA256 の先頭 128 ビット（16 進 32 文字）。鍵が無ければ、誰の ID かは戻せない。"""
    return hmac.new(key, f"user:{user_id}".encode(), hashlib.sha256).hexdigest()[:32]


def key_fingerprint(key: bytes) -> str:
    return hmac.new(key, b"analytics-key-fingerprint-v1", hashlib.sha256).hexdigest()[:16]


# ---- 営業日の範囲 ----

def earliest_order_date(conn: psycopg.Connection) -> date | None:
    return conn.execute("SELECT min(business_date) FROM orders").fetchone()[0]


def last_built_date(conn: psycopg.Connection) -> date | None:
    return conn.execute("SELECT max(business_date) FROM analytics.daily_store_summary").fetchone()[0]


def default_start(conn: psycopg.Connection, end: date) -> date | None:
    """続きから作る開始日。作ったことがなければ最初の注文の日。注文が無ければ None。"""
    last = last_built_date(conn)
    if last is not None:
        return max(min(last - timedelta(days=LOOKBACK_DAYS - 1), end), earliest_order_date(conn) or end)
    return earliest_order_date(conn)


# ---- 日次（店 × 日） ----

def build_days(conn: psycopg.Connection, start: date, end: date, *, offset_hours: int, now: datetime) -> dict[str, int]:
    """start〜end（営業日）の日次集計を置き換える。戻り値は、表ごとの作った行数。"""
    p = {"start": start, "end": end, "off": offset_hours, "now": now}
    patterns = {f"p_{code}": pattern for code, pattern in rules.WASTE_PATTERNS}
    counts: dict[str, int] = {}
    for table in _DAILY_TABLES:
        conn.execute(f"DELETE FROM analytics.{table} WHERE business_date BETWEEN %(start)s AND %(end)s", p)  # noqa: S608（固定の表名）

    counts["daily_store_summary"] = conn.execute(
        "INSERT INTO analytics.daily_store_summary (store_id, business_date, orders, cancelled_orders, sales_lumi, built_at) "
        "SELECT c.store_id, c.business_date, "
        "  count(f.order_id) FILTER (WHERE f.status = 'completed'), count(f.order_id) FILTER (WHERE f.status = 'cancelled'), "
        "  COALESCE(sum(f.total_lumi) FILTER (WHERE f.status = 'completed'), 0), %(now)s "
        "FROM analytics.store_days(%(start)s, %(end)s) c "
        "LEFT JOIN analytics.order_facts f ON f.store_id = c.store_id AND f.business_date = c.business_date "
        "WHERE c.is_open GROUP BY c.store_id, c.business_date "
        "ON CONFLICT (store_id, business_date) DO UPDATE SET orders = EXCLUDED.orders, cancelled_orders = EXCLUDED.cancelled_orders, "
        "  sales_lumi = EXCLUDED.sales_lumi, built_at = EXCLUDED.built_at",
        p,
    ).rowcount

    counts["daily_store_item_sales"] = conn.execute(
        "INSERT INTO analytics.daily_store_item_sales (store_id, business_date, item_id, fulfillment, item_code, item_name, category, qty, sales_lumi, built_at) "
        "SELECT l.store_id, l.business_date, l.item_id, l.fulfillment, max(l.item_code), max(l.item_name), max(l.category), sum(l.qty), sum(l.line_total_lumi), %(now)s "
        "FROM analytics.sales_lines l WHERE l.business_date BETWEEN %(start)s AND %(end)s "
        "GROUP BY l.store_id, l.business_date, l.item_id, l.fulfillment "
        "ON CONFLICT (store_id, business_date, item_id, fulfillment) DO UPDATE SET item_code = EXCLUDED.item_code, item_name = EXCLUDED.item_name, "
        "  category = EXCLUDED.category, qty = EXCLUDED.qty, sales_lumi = EXCLUDED.sales_lumi, built_at = EXCLUDED.built_at",
        p,
    ).rowcount

    counts["daily_store_hourly"] = conn.execute(
        "INSERT INTO analytics.daily_store_hourly (store_id, business_date, hour, fulfillment, orders, sales_lumi, built_at) "
        "SELECT f.store_id, f.business_date, EXTRACT(HOUR FROM (f.placed_at AT TIME ZONE 'UTC') + make_interval(hours => %(off)s))::int, f.fulfillment, "
        "  count(*), sum(f.total_lumi), %(now)s "
        "FROM analytics.order_facts f WHERE f.status = 'completed' AND f.business_date BETWEEN %(start)s AND %(end)s "
        "GROUP BY 1, 2, 3, 4 "
        "ON CONFLICT (store_id, business_date, hour, fulfillment) DO UPDATE SET orders = EXCLUDED.orders, sales_lumi = EXCLUDED.sales_lumi, built_at = EXCLUDED.built_at",
        p,
    ).rowcount

    # 在庫: 台帳（receive・consume・waste・adjust）から、その日の締めの残量を再計算する。開始日より前の分は、まとめて基準にする
    counts["daily_stock_levels"] = conn.execute(
        "WITH mv AS ("
        "  SELECT store_id, item_id, ((occurred_at AT TIME ZONE 'UTC') + make_interval(hours => %(off)s))::date AS d, kind, qty "
        "  FROM stock_movements WHERE kind IN ('receive', 'consume', 'waste', 'adjust')), "
        "daily AS ("
        "  SELECT store_id, item_id, d, sum(qty) AS net, "
        "    COALESCE(sum(qty) FILTER (WHERE kind = 'receive'), 0) AS received, COALESCE(-sum(qty) FILTER (WHERE kind = 'consume'), 0) AS consumed, "
        "    COALESCE(-sum(qty) FILTER (WHERE kind = 'waste'), 0) AS wasted, COALESCE(sum(qty) FILTER (WHERE kind = 'adjust'), 0) AS adjusted "
        "  FROM mv WHERE d <= %(end)s GROUP BY store_id, item_id, d), "
        "base AS (SELECT store_id, item_id, sum(net) AS base FROM daily WHERE d < %(start)s GROUP BY store_id, item_id), "
        "grid AS ("
        "  SELECT p.store_id, p.item_id, p.item_code, g.d FROM analytics.stock_position p "
        "  CROSS JOIN (SELECT %(start)s::date + n AS d FROM generate_series(0, %(end)s::date - %(start)s::date) AS n) g), "
        "run AS ("
        "  SELECT grid.store_id, grid.item_id, grid.item_code, grid.d, "
        "    COALESCE(base.base, 0) + sum(COALESCE(daily.net, 0)) OVER (PARTITION BY grid.store_id, grid.item_id ORDER BY grid.d) AS on_hand_end, "
        "    COALESCE(daily.received, 0) AS received, COALESCE(daily.consumed, 0) AS consumed, COALESCE(daily.wasted, 0) AS wasted, COALESCE(daily.adjusted, 0) AS adjusted "
        "  FROM grid LEFT JOIN daily ON daily.store_id = grid.store_id AND daily.item_id = grid.item_id AND daily.d = grid.d "
        "  LEFT JOIN base ON base.store_id = grid.store_id AND base.item_id = grid.item_id) "
        "INSERT INTO analytics.daily_stock_levels (store_id, business_date, item_id, item_code, on_hand_end, received, consumed, wasted, adjusted, built_at) "
        "SELECT r.store_id, r.d, r.item_id, r.item_code, r.on_hand_end, r.received, r.consumed, r.wasted, r.adjusted, %(now)s "
        "FROM run r JOIN analytics.store_days(%(start)s, %(end)s) c ON c.store_id = r.store_id AND c.business_date = r.d AND c.is_open "
        "ON CONFLICT (store_id, business_date, item_id) DO UPDATE SET on_hand_end = EXCLUDED.on_hand_end, received = EXCLUDED.received, "
        "  consumed = EXCLUDED.consumed, wasted = EXCLUDED.wasted, adjusted = EXCLUDED.adjusted, built_at = EXCLUDED.built_at",
        p,
    ).rowcount

    counts["daily_stock_waste"] = conn.execute(
        "INSERT INTO analytics.daily_stock_waste (store_id, business_date, item_id, reason_code, qty, built_at) "
        "SELECT m.store_id, ((m.occurred_at AT TIME ZONE 'UTC') + make_interval(hours => %(off)s))::date AS d, m.item_id, "
        "  CASE WHEN m.reason ~* %(p_expired)s THEN 'expired' WHEN m.reason ~* %(p_damaged)s THEN 'damaged' WHEN m.reason ~* %(p_quality)s THEN 'quality' ELSE 'other' END, "
        "  -sum(m.qty), %(now)s "
        "FROM stock_movements m WHERE m.kind = 'waste' "
        "  AND ((m.occurred_at AT TIME ZONE 'UTC') + make_interval(hours => %(off)s))::date BETWEEN %(start)s AND %(end)s "
        "GROUP BY 1, 2, 3, 4 "
        "ON CONFLICT (store_id, business_date, item_id, reason_code) DO UPDATE SET qty = EXCLUDED.qty, built_at = EXCLUDED.built_at",
        {**p, **patterns},
    ).rowcount
    return counts


# ---- 顧客（仮名 ID） ----

def build_customers(conn: psycopg.Connection, *, today: date, key: bytes, now: datetime, rekey: bool = False) -> dict[str, int]:
    """顧客の表（RFM・月ごと）を、確定した日（today の手前）の注文から作り直す。仮名 ID の対応は、足りない顧客だけ足す。"""
    fingerprint = key_fingerprint(key)
    row = conn.execute("SELECT value FROM analytics.build_state WHERE key = 'key_fingerprint'").fetchone()
    if row is not None and row[0] != fingerprint:
        if not rekey:
            raise KeyChanged("仮名 ID の鍵が、前回の集計と違います。顧客の表を作り直すときは --rekey を付けてください。")
        conn.execute("DELETE FROM analytics.customer_pseudonyms")
        for table in _CUSTOMER_TABLES:
            conn.execute(f"DELETE FROM analytics.{table}")  # noqa: S608（固定の表名）
    conn.execute(
        "INSERT INTO analytics.build_state (key, value, updated_at) VALUES ('key_fingerprint', %s, %s) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
        (fingerprint, now),
    )

    # 仮名 ID の対応: 確定した日に completed の注文がある顧客を、足りない分だけ
    users = [r[0] for r in conn.execute("SELECT DISTINCT user_id FROM orders WHERE status = 'completed' AND business_date < %s ORDER BY user_id", (today,))]
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO analytics.customer_pseudonyms (user_id, pseudonym_id, created_at) VALUES (%s, %s, %s) ON CONFLICT (user_id) DO NOTHING",
            [(u, pseudonym_id(key, u), now) for u in users],
        )

    window_start = today - timedelta(days=RFM_WINDOW_DAYS)
    stats = conn.execute(
        "SELECT p.pseudonym_id, count(*) AS orders, sum(o.total_lumi) AS spend, min(o.business_date) AS first_date, max(o.business_date) AS last_date "
        "FROM orders o JOIN analytics.customer_pseudonyms p ON p.user_id = o.user_id "
        "WHERE o.status = 'completed' AND o.business_date >= %s AND o.business_date < %s GROUP BY p.pseudonym_id ORDER BY p.pseudonym_id",
        (window_start, today),
    ).fetchall()
    conn.execute("DELETE FROM analytics.customer_rfm")
    rfm_rows = []
    for pid, orders, spend, first_date, last_date in stats:
        recency = (today - last_date).days
        r, f, m = rules.r_score(recency), rules.f_score(orders), rules.m_score(spend)
        rfm_rows.append((pid, first_date, last_date, orders, spend, recency, r, f, m, rules.segment_of(r, f), today, now))
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO analytics.customer_rfm (pseudonym_id, first_order_date, last_order_date, orders, spend_lumi, recency_days, r_score, f_score, m_score, segment, as_of, built_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            rfm_rows,
        )

    conn.execute("DELETE FROM analytics.customer_monthly")
    monthly = conn.execute(
        "INSERT INTO analytics.customer_monthly (pseudonym_id, month, orders, spend_lumi) "
        "SELECT p.pseudonym_id, (o.business_date - (EXTRACT(DAY FROM o.business_date)::int - 1)), count(*), sum(o.total_lumi) "
        "FROM orders o JOIN analytics.customer_pseudonyms p ON p.user_id = o.user_id "
        "WHERE o.status = 'completed' AND o.business_date < %s GROUP BY 1, 2",
        (today,),
    ).rowcount
    return {"customer_pseudonyms": len(users), "customer_rfm": len(rfm_rows), "customer_monthly": monthly}


# ---- 全体 ----

def build(conn: psycopg.Connection, *, today: date, key: bytes, offset_hours: int, now: datetime,
          start: date | None = None, end: date | None = None, rekey: bool = False) -> dict:
    """確定した日（today の手前）の日次集計と、顧客の表を作る。1 つのトランザクションの中（呼ぶ側が commit）。
    戻り値: {"start", "end", "counts": {表: 行数}}。作る日が無ければ start は None。"""
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
    last_final = today - timedelta(days=1)
    end = min(end or last_final, last_final)
    start = start if start is not None else default_start(conn, end)
    counts: dict[str, int] = {}
    if start is not None and start <= end:
        counts.update(build_days(conn, start, end, offset_hours=offset_hours, now=now))
    else:
        start = None
    counts.update(build_customers(conn, today=today, key=key, now=now, rekey=rekey))
    return {"start": start, "end": end, "counts": counts}


def main(argv: list[str]) -> int:
    def option(name: str) -> str | None:
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None

    try:
        key = settings.analytics_pseudonym_key()
        start = date.fromisoformat(option("--from")) if option("--from") else None
        end = date.fromisoformat(option("--to")) if option("--to") else None
        today = clock.local_now().date()
        with psycopg.connect(settings.database_url()) as conn:
            if "--all" in argv and start is None:
                start = earliest_order_date(conn)
            result = build(conn, today=today, key=key, offset_hours=settings.local_utc_offset_hours(), now=clock.utc_now(),
                           start=start, end=end, rekey="--rekey" in argv)
    except (KeyChanged, RuntimeError, ValueError) as exc:  # 設定・日付・鍵の誤り。本文は、このリポジトリの固定の説明（鍵・接続情報を含まない）
        print(f"失敗しました（{type(exc).__name__}）。{exc}")
        return 1
    except psycopg.Error as exc:
        print(f"失敗しました（{type(exc).__name__}）。DB への接続か SQL の実行でエラーです")
        return 1
    span = f"{result['start']}〜{result['end']}" if result["start"] else "日次は作る日がありません"
    print(f"作成しました（{span}）: " + ", ".join(f"{k} {v} 行" for k, v in result["counts"].items()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

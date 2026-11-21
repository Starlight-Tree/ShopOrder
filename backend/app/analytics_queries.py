"""分析の読み取り（API が呼ぶ薄い層）。確定した日は analytics の日次集計表を読むだけ。当日だけ、元データ（analytics のビュー）から都度。
指標の定義は docs/metrics.md。conn は dict_row の接続。店の範囲（store_id）の権限の確認は、呼ぶ側（routes/analytics.py）。
顧客の人数のセルは、5 人未満を出さない（analytics_rules.suppress_cells）。顧客は仮名 ID だけを読む（仮名 ID と users の対応の表は読まない）。
"""

from datetime import date, timedelta

from psycopg import Connection

from app import analytics_rules as rules

IN_PROGRESS_STATUSES = ("paid", "accepted", "preparing", "ready", "assigned", "picked_up", "delivering")
HEATMAP_DAYS_DEFAULT = 28


def scope_info(conn: Connection, store_id: int | None) -> dict:
    if store_id is None:
        return {"all_stores": True, "store_id": None, "store_name": None}
    row = conn.execute("SELECT name FROM stores WHERE id = %s", (store_id,)).fetchone()
    return {"all_stores": False, "store_id": store_id, "store_name": row["name"] if row else None}


def _avg_ticket(sales: int, orders: int) -> int | None:
    return round(sales / orders) if orders else None


# ---- 今日の概況（当日は元データから） ----

def overview(conn: Connection, *, store_id: int | None, today: date) -> dict:
    live = conn.execute(
        "SELECT count(*) FILTER (WHERE status = 'completed') AS orders, COALESCE(sum(total_lumi) FILTER (WHERE status = 'completed'), 0) AS sales, "
        "count(*) FILTER (WHERE status = ANY(%s)) AS in_progress "
        "FROM analytics.order_facts WHERE business_date = %s AND (%s::int IS NULL OR store_id = %s)",
        (list(IN_PROGRESS_STATUSES), today, store_id, store_id),
    ).fetchone()
    yesterday = today - timedelta(days=1)
    y = daily_points(conn, store_id=store_id, start=yesterday, end=yesterday)[0]
    calendar = conn.execute(
        "SELECT count(*) FILTER (WHERE is_open) AS open_stores, count(*) AS stores, min(closed_reason) AS closed_reason "
        "FROM analytics.store_days(%s, %s) WHERE (%s::int IS NULL OR store_id = %s)",
        (today, today, store_id, store_id),
    ).fetchone()
    return {
        "business_date": today.isoformat(),
        "sales_lumi": int(live["sales"]), "orders": live["orders"], "avg_ticket_lumi": _avg_ticket(int(live["sales"]), live["orders"]),
        "in_progress": live["in_progress"],
        "open_stores": calendar["open_stores"], "store_count": calendar["stores"],
        "closed_reason": calendar["closed_reason"] if store_id is not None and calendar["open_stores"] == 0 else None,
        "yesterday": {
            "business_date": yesterday.isoformat(), "state": y["state"], "sales_lumi": y["sales_lumi"], "orders": y["orders"],
            "avg_ticket_lumi": _avg_ticket(y["sales_lumi"], y["orders"]) if y["sales_lumi"] is not None and y["orders"] is not None else None,
        },
    }


# ---- 売上の推移 ----

def daily_points(conn: Connection, *, store_id: int | None, start: date, end: date) -> list[dict]:
    """営業日カレンダーと日次集計から、日ごとの点。state: open（営業日で集計済み。売上 0 を含む）/ closed（休業。値は None）/
    not_built（営業日だが未集計。値は None）/ partial（一部の店が未集計。値は None）。"""
    rows = conn.execute(
        "SELECT c.business_date AS d, count(*) FILTER (WHERE c.is_open) AS open_stores, count(s.store_id) AS built_stores, "
        "COALESCE(sum(s.sales_lumi), 0) AS sales, COALESCE(sum(s.orders), 0) AS orders "
        "FROM analytics.store_days(%s, %s) c "
        "LEFT JOIN analytics.daily_store_summary s ON s.store_id = c.store_id AND s.business_date = c.business_date "
        "WHERE (%s::int IS NULL OR c.store_id = %s) GROUP BY c.business_date ORDER BY c.business_date",
        (start, end, store_id, store_id),
    ).fetchall()
    points = []
    for r in rows:
        if r["open_stores"] == 0:
            state = "closed"
        elif r["built_stores"] == 0:
            state = "not_built"
        elif r["built_stores"] < r["open_stores"]:
            state = "partial"
        else:
            state = "open"
        has_value = state == "open"
        points.append({
            "date": r["d"], "open_stores": r["open_stores"], "state": state,
            "sales_lumi": int(r["sales"]) if has_value else None, "orders": int(r["orders"]) if has_value else None,
            "missing": r["open_stores"] - r["built_stores"] if state in ("not_built", "partial") else 0,
        })
    return points


def _period(conn: Connection, store_id: int | None, start: date, end: date) -> dict:
    points = daily_points(conn, store_id=store_id, start=start, end=end)
    return {
        "start": start, "end": end,
        "open_days": sum(p["open_stores"] for p in points), "missing_days": sum(p["missing"] for p in points),
        "sales_lumi": sum(p["sales_lumi"] or 0 for p in points), "orders": sum(p["orders"] or 0 for p in points),
        "points": points,
    }


def sales_series(conn: Connection, *, store_id: int | None, today: date, grain: str, count: int) -> dict:
    start, end = rules.last_complete_range(grain, count, today)
    current = _period(conn, store_id, start, end)
    prev_start, prev_end = rules.previous_range(start, end, grain)
    previous = _period(conn, store_id, prev_start, prev_end)
    cmp = rules.comparison(current, previous)
    if cmp["state"] == "not_comparable":
        cmp["message"] = rules.COMPARISON_MESSAGES[cmp["reason"]]
    return {
        "grain": grain, "from": start.isoformat(), "to": end.isoformat(),
        "points": [
            {"start": b["start"].isoformat(), "sales_lumi": b["sales_lumi"], "orders": b["orders"], "open_days": b["open_days"], "state": b["state"]}
            for b in rules.bucket_points(current["points"], grain)
        ],
        "total": {"sales_lumi": current["sales_lumi"], "orders": current["orders"], "open_days": current["open_days"], "missing_days": current["missing_days"]},
        "previous": {"from": prev_start.isoformat(), "to": prev_end.isoformat()},
        "comparison": cmp,
    }


# ---- 商品別（ABC） ----

def products(conn: Connection, *, store_id: int | None, today: date, days: int) -> dict:
    start, end = rules.last_complete_range("day", days, today)
    rows = conn.execute(
        "SELECT item_id, max(item_code) AS code, max(item_name) AS name, max(category) AS category, sum(qty)::int AS qty, sum(sales_lumi)::int AS sales "
        "FROM analytics.daily_store_item_sales WHERE business_date BETWEEN %s AND %s AND (%s::int IS NULL OR store_id = %s) "
        "GROUP BY item_id ORDER BY sum(sales_lumi) DESC, item_id",
        (start, end, store_id, store_id),
    ).fetchall()
    abc = rules.abc_table([r["sales"] for r in rows])
    items = [
        {"item_id": r["item_id"], "code": r["code"], "name": r["name"], "category": r["category"], "qty": r["qty"], "sales_lumi": r["sales"], **a}
        for r, a in zip(rows, abc, strict=True)
    ]
    return {
        "from": start.isoformat(), "to": end.isoformat(), "days": days,
        "totals": {
            "sales_lumi": sum(i["sales_lumi"] for i in items), "qty": sum(i["qty"] for i in items),
            "cups": sum(i["qty"] for i in items if i["category"] == "drink"),
        },
        "items": items,
    }


# ---- 曜日 × 時間帯 ----

def hourly(conn: Connection, *, store_id: int | None, today: date, days: int) -> dict:
    start, end = rules.last_complete_range("day", days, today)
    cells = conn.execute(
        "SELECT EXTRACT(ISODOW FROM business_date)::int AS weekday, hour::int AS hour, sum(orders)::int AS orders, sum(sales_lumi)::int AS sales "
        "FROM analytics.daily_store_hourly WHERE business_date BETWEEN %s AND %s AND (%s::int IS NULL OR store_id = %s) "
        "GROUP BY 1, 2 ORDER BY 1, 2",
        (start, end, store_id, store_id),
    ).fetchall()
    store_days = {
        r["weekday"]: r["n"]
        for r in conn.execute(
            "SELECT EXTRACT(ISODOW FROM business_date)::int AS weekday, count(*)::int AS n FROM analytics.daily_store_summary "
            "WHERE business_date BETWEEN %s AND %s AND (%s::int IS NULL OR store_id = %s) GROUP BY 1",
            (start, end, store_id, store_id),
        )
    }
    hours = sorted({c["hour"] for c in cells})
    return {
        "from": start.isoformat(), "to": end.isoformat(), "days": days,
        "hours": list(range(hours[0], hours[-1] + 1)) if hours else [],
        "cells": [{"weekday": c["weekday"], "hour": c["hour"], "orders": c["orders"], "sales_lumi": c["sales"]} for c in cells],
        "store_days": [{"weekday": w, "store_days": store_days.get(w, 0)} for w in range(1, 8)],
        "max_orders": max((c["orders"] for c in cells), default=0),
    }


# ---- 在庫 ----

def stock(conn: Connection, *, store_id: int | None, today: date) -> dict:
    """在庫の今の位置（残高。当日を含む）と、直近の消費（日次集計）から、残日数・発注点との差。全店のときは品目ごとに店をまとめる（残量・消費は合計、
    残日数・発注点との差は、最も厳しい店の値、low_stores は発注点を下回る店の数）。"""
    use_start, use_end = rules.last_complete_range("day", rules.STOCK_USE_DAYS, today)
    waste_start, waste_end = rules.last_complete_range("day", rules.WASTE_DAYS, today)
    positions = conn.execute(
        "SELECT store_id, item_id, item_code, item_name, kind, unit, on_hand, reserved, safety_stock, reorder_point FROM analytics.stock_position "
        "WHERE (%s::int IS NULL OR store_id = %s) ORDER BY item_id, store_id",
        (store_id, store_id),
    ).fetchall()
    use = {
        (r["store_id"], r["item_id"]): (r["used"], r["days"])
        for r in conn.execute(
            "SELECT store_id, item_id, sum(consumed)::int AS used, count(*)::int AS days FROM analytics.daily_stock_levels "
            "WHERE business_date BETWEEN %s AND %s AND (%s::int IS NULL OR store_id = %s) GROUP BY store_id, item_id",
            (use_start, use_end, store_id, store_id),
        )
    }
    by_item: dict[int, dict] = {}
    for p in positions:
        used, days = use.get((p["store_id"], p["item_id"]), (0, 0))
        avg_use = used / days if days else 0.0
        available = p["on_hand"] - p["reserved"] - p["safety_stock"]
        cover = round(max(0, p["on_hand"] - p["reserved"]) / avg_use, 1) if avg_use > 0 else None
        gap = available - p["reorder_point"]
        row = by_item.setdefault(p["item_id"], {
            "item_id": p["item_id"], "code": p["item_code"], "name": p["item_name"], "kind": p["kind"], "unit": p["unit"],
            "on_hand": 0, "reserved": 0, "avg_daily_use": 0.0, "days_of_cover": None, "gap_to_reorder": None, "reorder_point": p["reorder_point"],
            "low_stores": 0, "store_count": 0,
        })
        row["on_hand"] += p["on_hand"]
        row["reserved"] += p["reserved"]
        row["avg_daily_use"] += avg_use
        row["store_count"] += 1
        row["low_stores"] += 1 if gap < 0 else 0
        row["gap_to_reorder"] = gap if row["gap_to_reorder"] is None else min(row["gap_to_reorder"], gap)
        if cover is not None:
            row["days_of_cover"] = cover if row["days_of_cover"] is None else min(row["days_of_cover"], cover)
    rows = list(by_item.values())
    for r in rows:
        r["avg_daily_use"] = round(r["avg_daily_use"], 1)
        r["low"] = r["low_stores"] > 0

    waste_rows = conn.execute(
        "SELECT w.item_id, w.reason_code, sum(w.qty)::int AS qty FROM analytics.daily_stock_waste w "
        "WHERE w.business_date BETWEEN %s AND %s AND (%s::int IS NULL OR w.store_id = %s) GROUP BY w.item_id, w.reason_code",
        (waste_start, waste_end, store_id, store_id),
    ).fetchall()
    consumed = {
        r["item_id"]: r["consumed"]
        for r in conn.execute(
            "SELECT item_id, sum(consumed)::int AS consumed FROM analytics.daily_stock_levels WHERE business_date BETWEEN %s AND %s "
            "AND (%s::int IS NULL OR store_id = %s) GROUP BY item_id",
            (waste_start, waste_end, store_id, store_id),
        )
    }
    waste: dict[int, dict] = {}
    for w in waste_rows:
        entry = waste.setdefault(w["item_id"], {"item_id": w["item_id"], "total": 0, "by_reason": {code: 0 for code in rules.WASTE_REASONS}})
        entry["total"] += w["qty"]
        entry["by_reason"][w["reason_code"]] += w["qty"]
    names = {r["item_id"]: r for r in rows}
    waste_list = []
    for item_id, w in waste.items():
        base = names.get(item_id)
        if base is None:
            continue
        used = consumed.get(item_id, 0)
        waste_list.append({**w, "code": base["code"], "name": base["name"], "unit": base["unit"],
                           "waste_rate_pct": round(w["total"] / (used + w["total"]) * 100, 1) if used + w["total"] else 0.0})
    waste_list.sort(key=lambda w: (-w["waste_rate_pct"], w["item_id"]))
    return {
        "use_from": use_start.isoformat(), "use_to": use_end.isoformat(),
        "waste_from": waste_start.isoformat(), "waste_to": waste_end.isoformat(),
        "items": rows, "waste": waste_list,
    }


# ---- 顧客（仮名 ID の集計だけ。人数のセルは 5 人未満を出さない） ----

def customers(conn: Connection, *, today: date) -> dict:
    segments = {r["segment"]: r["n"] for r in conn.execute("SELECT segment, count(*)::int AS n FROM analytics.customer_rfm GROUP BY segment")}
    counts = {s: segments.get(s, 0) for s in rules.SEGMENTS}
    total = sum(counts.values())
    shown = rules.suppress_cells(counts)
    grid_counts = {
        (r["r_score"], r["f_score"]): r["n"]
        for r in conn.execute("SELECT r_score, f_score, count(*)::int AS n FROM analytics.customer_rfm GROUP BY r_score, f_score")
    }
    grid_cells = {(r, f): grid_counts.get((r, f), 0) for r in (3, 2, 1) for f in (1, 2, 3)}
    grid_shown = rules.suppress_cells(grid_cells)
    stats = conn.execute(
        "SELECT count(*)::int AS n, count(*) FILTER (WHERE orders >= 2)::int AS repeat, COALESCE(sum(spend_lumi), 0)::bigint AS spend, "
        "COALESCE(sum(orders), 0)::bigint AS orders, max(as_of) AS as_of FROM analytics.customer_rfm"
    ).fetchone()
    shown_total = total if all(v is not None for v in shown.values()) else None  # 隠したセルがあれば、合計は出さない（引き算で戻せるため）
    repeat, once = stats["repeat"], stats["n"] - stats["repeat"]
    rate_ok = stats["n"] >= rules.MIN_CELL and repeat >= rules.MIN_CELL and once >= rules.MIN_CELL
    metrics_ok = stats["n"] >= rules.MIN_CELL
    return {
        "as_of": stats["as_of"].isoformat() if stats["as_of"] else None,
        "min_cell": rules.MIN_CELL,
        "total_customers": shown_total,
        "segments": [{"segment": s, "label": rules.SEGMENT_LABELS[s], "customers": shown[s], "suppressed": shown[s] is None} for s in rules.SEGMENTS],
        "grid": [
            {"r": r, "f": f, "customers": grid_shown[(r, f)], "suppressed": grid_shown[(r, f)] is None}
            for r in (3, 2, 1) for f in (1, 2, 3)
        ],
        "repurchase_rate_pct": round(repeat / stats["n"] * 100, 1) if rate_ok else None,
        "avg_orders": round(stats["orders"] / stats["n"], 1) if metrics_ok else None,
        "avg_spend_lumi": round(stats["spend"] / stats["n"]) if metrics_ok else None,  # LTV の目安（期間内の 1 人あたり利用額）
        "at_risk_customers": shown["at_risk"],
        "cohorts": _cohorts(conn, today),
    }


def _cohorts(conn: Connection, today: date) -> dict:
    """初回月（顧客ごとの最初の注文の月）× 経過月。active = その月に注文した人。5 人未満のセルと、5 人未満のコホートは出さない。"""
    current_month = today.replace(day=1)
    data_start = conn.execute("SELECT min(business_date) AS d FROM analytics.daily_store_summary").fetchone()["d"]
    rows = conn.execute(
        "WITH first AS (SELECT pseudonym_id, min(month) AS cohort FROM analytics.customer_monthly GROUP BY pseudonym_id) "
        "SELECT f.cohort, ((EXTRACT(YEAR FROM m.month) - EXTRACT(YEAR FROM f.cohort)) * 12 + EXTRACT(MONTH FROM m.month) - EXTRACT(MONTH FROM f.cohort))::int AS offset, "
        "count(*)::int AS active FROM first f JOIN analytics.customer_monthly m ON m.pseudonym_id = f.pseudonym_id "
        "GROUP BY f.cohort, 2 ORDER BY f.cohort, 2"
    ).fetchall()
    by_cohort: dict[date, dict[int, int]] = {}
    for r in rows:
        by_cohort.setdefault(r["cohort"], {})[r["offset"]] = r["active"]
    months_to_current = lambda c: (current_month.year - c.year) * 12 + current_month.month - c.month  # noqa: E731
    out = []
    for cohort in sorted(by_cohort):
        cells = by_cohort[cohort]
        size = cells.get(0, 0)
        last_offset = months_to_current(cohort)
        out_cells = []
        for off in range(0, last_offset + 1):
            active = cells.get(off, 0)
            hidden = size < rules.MIN_CELL or 0 < active < rules.MIN_CELL
            out_cells.append({
                "offset": off, "customers": None if hidden else active, "rate_pct": None if hidden else round(active / size * 100, 1),
                "suppressed": hidden, "in_progress": off == last_offset,
            })
        out.append({
            "cohort": cohort.isoformat(), "size": None if size < rules.MIN_CELL else size, "suppressed": size < rules.MIN_CELL,
            "includes_existing": data_start is not None and cohort == data_start.replace(day=1), "cells": out_cells,
        })
    return {"rows": out, "max_offset": max((len(r["cells"]) - 1 for r in out), default=0)}

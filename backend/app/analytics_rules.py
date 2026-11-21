"""分析の決まり（DB に触らない純粋な関数と定数）。定義の正本は docs/metrics.md。閾値は設計の既定で、実測ではない。変えるときは、ここと docs/metrics.md を一緒に直す。"""

import re
from collections import Counter
from collections.abc import Hashable, Iterable, Mapping, Sequence
from datetime import date, timedelta

# ---- 最小の集計単位（顧客の人数を数えるセル） ----
MIN_CELL = 5  # 人数のセルが、これ未満なら出さない（docs/analytics.md「最小の集計単位」）

# ---- ABC（売上の累積。手前までの累積が 80% 未満なら A、95% 未満なら B、それ以外は C） ----
ABC_A_UPTO = 80.0
ABC_B_UPTO = 95.0

# ---- RFM（固定の閾値。ダミーの顧客が少ないので、分位ではなく固定。docs/analytics.md） ----
R_RECENT_DAYS = 14  # 最後の注文から 14 日以内 → R=3
R_LAPSE_DAYS = 30  # 15〜30 日 → R=2、31 日以上 → R=1
F_HIGH = 30  # 期間（90 日）内の注文が 30 回以上 → F=3
F_MID = 10  # 10〜29 回 → F=2、9 回以下 → F=1
M_HIGH = 20000  # 期間内の利用額が 20,000 ルミ以上 → M=3
M_MID = 8000  # 8,000 以上 → M=2

SEGMENTS = ("loyal", "regular", "light", "at_risk", "dormant")
SEGMENT_LABELS = {"loyal": "常連", "regular": "通い", "light": "ときどき", "at_risk": "離れかけ", "dormant": "休眠"}

# ---- 在庫 ----
STOCK_USE_DAYS = 14  # 1 日あたりの消費は、直近 14 営業日の平均
WASTE_DAYS = 30  # 廃棄は、直近 30 日

# 廃棄の理由（台帳の自由記述を、固定の区分に写す。PostgreSQL の ~* と Python の re で同じ文字列を使う）
WASTE_REASONS = ("expired", "damaged", "quality", "other")
WASTE_REASON_LABELS = {"expired": "期限切れ", "damaged": "破損", "quality": "品質", "other": "その他"}
WASTE_PATTERNS: tuple[tuple[str, str], ...] = (
    ("expired", "期限|賞味|消費|expire"),
    ("damaged", "破損|落と|こぼ|割れ|damage"),
    ("quality", "品質|鮮度|味|劣化|quality"),
)

GRAINS = ("day", "week", "month")


def waste_reason_code(reason: str | None) -> str:
    text = reason or ""
    for code, pattern in WASTE_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return code
    return "other"


# ---- ABC ----

def abc_table(sales: Sequence[int]) -> list[dict]:
    """売上の大きい順に並んだ金額 → 構成比・累積・クラス。構成比は 0〜100（小数 1 位）。合計が 0 なら、すべて C・構成比 0。
    クラスは、その品の手前までの累積で決める（80% をまたぐ品は A に入る。A が空にならない）。"""
    total = sum(sales)
    rows: list[dict] = []
    before = 0
    for amount in sales:
        before_pct = (before / total * 100) if total else 100.0
        after = before + amount
        klass = "A" if before_pct < ABC_A_UPTO else "B" if before_pct < ABC_B_UPTO else "C"
        rows.append({
            "share_pct": round(amount / total * 100, 1) if total else 0.0,
            "cum_share_pct": round(after / total * 100, 1) if total else 0.0,
            "abc": klass,
        })
        before = after
    return rows


# ---- RFM ----

def r_score(recency_days: int) -> int:
    return 3 if recency_days <= R_RECENT_DAYS else 2 if recency_days <= R_LAPSE_DAYS else 1


def f_score(orders: int) -> int:
    return 3 if orders >= F_HIGH else 2 if orders >= F_MID else 1


def m_score(spend_lumi: int) -> int:
    return 3 if spend_lumi >= M_HIGH else 2 if spend_lumi >= M_MID else 1


def segment_of(r: int, f: int) -> str:
    """R と F から区分を決める。R=3: F=3 常連 / F=2 通い / F=1 ときどき、R=2 離れかけ（離脱の兆候）、R=1 休眠。"""
    if r == 3:
        return "loyal" if f == 3 else "regular" if f == 2 else "light"
    return "at_risk" if r == 2 else "dormant"


# ---- 最小の集計単位 ----

def suppress_cells(counts: Mapping[Hashable, int], k: int = MIN_CELL) -> dict[Hashable, int | None]:
    """人数のセルのうち k 未満のものを None にする。0 のセルは、人がいないので、そのまま 0。
    k 未満のセルが 1 つだけ隠れると、合計から引き算で戻せてしまうので、残りで最小のセルも隠す（補完の秘匿）。"""
    result: dict[Hashable, int | None] = dict(counts)
    hidden = [key for key, n in counts.items() if 0 < n < k]
    for key in hidden:
        result[key] = None
    if len(hidden) == 1:
        rest = [(n, str(key), key) for key, n in counts.items() if key not in hidden and n >= k]
        if rest:
            result[min(rest)[2]] = None
    return result


# ---- 期間 ----

def last_complete_range(grain: str, count: int, today: date) -> tuple[date, date]:
    """最後に確定した期間から count 個ぶんの (開始日, 終了日)。日: 昨日まで count 日。週: 昨日までに終わった週（月〜日）count 週。月: 昨日までに終わった月 count か月。"""
    yesterday = today - timedelta(days=1)
    if grain == "day":
        return yesterday - timedelta(days=count - 1), yesterday
    if grain == "week":
        end = yesterday - timedelta(days=(yesterday.isoweekday() % 7))  # 直近の日曜（昨日が日曜なら昨日）
        return end - timedelta(days=7 * count - 1), end
    if grain == "month":
        month_end = yesterday if (yesterday + timedelta(days=1)).day == 1 else yesterday.replace(day=1) - timedelta(days=1)
        start = month_end.replace(day=1)
        for _ in range(count - 1):
            start = (start - timedelta(days=1)).replace(day=1)
        return start, month_end
    raise ValueError(grain)


def previous_range(start: date, end: date, grain: str) -> tuple[date, date]:
    """直前の、同じ長さの期間。月は、同じ月数ぶんだけ前（日数は違うことがある）。"""
    if grain != "month":
        length = (end - start).days + 1
        return start - timedelta(days=length), start - timedelta(days=1)
    months = (end.year - start.year) * 12 + end.month - start.month + 1
    new_end = start - timedelta(days=1)
    new_start = new_end.replace(day=1)
    for _ in range(months - 1):
        new_start = (new_start - timedelta(days=1)).replace(day=1)
    return new_start, new_end


def bucket_start(day: date, grain: str) -> date:
    if grain == "week":
        return day - timedelta(days=day.isoweekday() - 1)
    if grain == "month":
        return day.replace(day=1)
    return day


def weekday_counts(start: date, end: date) -> Counter[int]:
    return Counter(((start + timedelta(days=i)).isoweekday()) for i in range((end - start).days + 1))


def comparison(current: Mapping, previous: Mapping) -> dict:
    """前期比。current / previous は {"start", "end", "open_days", "missing_days", "sales_lumi"}（open_days は店 × 営業日の数、missing_days は未集計の営業日の数）。
    期間の長さと曜日の構成が同じで、営業日の数も同じで、前の期間が全部集計済みのときだけ比べる。足りなければ「比較不可」（理由つき）。"""
    if previous["missing_days"] or previous["open_days"] == 0:
        return {"state": "not_comparable", "reason": "previous_missing"}
    if (current["end"] - current["start"]).days != (previous["end"] - previous["start"]).days or weekday_counts(
        current["start"], current["end"]
    ) != weekday_counts(previous["start"], previous["end"]):
        return {"state": "not_comparable", "reason": "weekday_mismatch"}
    if current["open_days"] != previous["open_days"]:
        return {"state": "not_comparable", "reason": "open_days_mismatch"}
    if previous["sales_lumi"] == 0:
        return {"state": "not_comparable", "reason": "previous_zero"}
    change = (current["sales_lumi"] - previous["sales_lumi"]) / previous["sales_lumi"] * 100
    return {"state": "ok", "previous_sales_lumi": previous["sales_lumi"], "change_pct": round(change, 1)}


COMPARISON_MESSAGES = {
    "previous_missing": "前の期間の集計が足りないため、比べられません。",
    "weekday_mismatch": "曜日の構成が前の期間と違うため、比べられません。",
    "open_days_mismatch": "営業日の数が前の期間と違う（休業があった）ため、比べられません。",
    "previous_zero": "前の期間の売上が 0 のため、比べられません。",
}


def bucket_points(points: Iterable[Mapping], grain: str) -> list[dict]:
    """日ごとの点 {date, sales_lumi, orders, open_stores, state} を、日・週・月の点に束ねる。休業・未集計の日は、合計にも営業日の数にも入れない。
    束ねた点は、未集計の日が 1 日でもあれば値を持たない（not_built）。全部が休業なら closed。それ以外は open（値は営業日の合計）。"""
    if grain == "day":
        return [
            {"start": p["date"], "sales_lumi": p["sales_lumi"], "orders": p["orders"], "open_days": p["open_stores"], "state": p["state"]} for p in points
        ]
    buckets: dict[date, dict] = {}
    for p in points:
        b = buckets.setdefault(bucket_start(p["date"], grain), {"sales": 0, "orders": 0, "open_days": 0, "not_built": 0, "days": 0, "closed": 0})
        b["days"] += 1
        if p["state"] == "closed":
            b["closed"] += 1
        elif p["state"] in ("not_built", "partial"):
            b["not_built"] += 1
        else:
            b["sales"] += p["sales_lumi"] or 0
            b["orders"] += p["orders"] or 0
            b["open_days"] += p["open_stores"]
    result = []
    for start in sorted(buckets):
        b = buckets[start]
        if b["not_built"]:
            state, sales, orders = "not_built", None, None
        elif b["closed"] == b["days"]:
            state, sales, orders = "closed", None, None
        else:
            state, sales, orders = "open", b["sales"], b["orders"]
        result.append({"start": start, "sales_lumi": sales, "orders": orders, "open_days": b["open_days"], "state": state})
    return result

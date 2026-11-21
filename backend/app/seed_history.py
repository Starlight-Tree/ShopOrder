"""ダミーの履歴（過去 90 日の注文・在庫の台帳）。**すべてダミー。実在の店・人・企業・売上とは関係がない。**

    DEMO_DATA=allow python -m app.seed_demo --reset --history

- 注文の API は通さず、orders・order_items・order_events・payments・stock_reservations・loyalty_ledger・stock_movements へ直接入れる
  （placed_at・business_date を過去にする）。status は completed が中心で、少数の cancelled。宅配の分析は P2 の後（今は店頭のみ）。
- 固定の乱数の種（SEED）から作る。同じ（今日・時刻）なら、同じ内容（ID を除く）になる。顧客・日・店ごとに別の乱数を使い、順序に依らない。
- 顧客 120 人（users。auth_user_id は `dev:hist-NNN`、名前は「ダミー顧客 NNN」）。種類（常連・通い・たまに・離れた人・試しただけの人）と、入会の日（期間の前から・期間の中）で、
  RFM・コホートが偏らないようにする。店は、席数に比例して選ばれる（規模）。時間帯は朝と夕方に山。看板（OB）の比率が高い。
  帰還祭（12/1〜12/25）は、期間に入る日の来店を増やし、限定ドリンクが出る（今日が 11 月なら、期間に入らない）。
- 在庫: 台帳（reserve・consume・release・receive・waste・adjust）と残高を同じ操作で作る（残高 = 台帳の合計。inventory.reconcile() が空）。
  期間の前日に、初期在庫を入れる（seed_demo の初期在庫の日付を、この日にする）。
- 休業: 定休日と、臨時休業（store_closures。ダミーの数日）。MO 不可の店（居住区信号塔店）は、注文が入らない（営業日で売上 0）。
- 資料の事実（店・席・営業時間）と、ダミーの数字（売上・顧客）を混ぜない。店・席・営業時間は docs/world.md が正本で、ここでは DB の値を読むだけ。
"""

import heapq
import random
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

import psycopg

from app import analytics_build, inventory, limits, rules, settings

SEED = 20261121
HISTORY_DAYS = 90
N_CUSTOMERS = 120
CANCEL_RATE = 0.04
_PUBLIC_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # orders.public_id の CHECK と同じ

# 臨時休業（ダミー。今日からの日数 → 店の code, 理由）。分析で「休業」と「営業したが売上 0」を区別するために入れる
TEMPORARY_CLOSURES = (
    (45, "rock-lookout", "砂嵐の警報（ダミー）"),
    (31, "ruins-terrace", "設備点検（ダミー）"),
    (12, "terminal-central", "砂嵐の警報（ダミー）"),
)

# 品目ごとの人気（重み）。看板（OB）が最も多い。
ITEM_WEIGHTS = {
    "oasis-blend": 28, "seasonal-blend": 8, "kikan-limited": 16, "cafe-latte": 12, "americano": 9, "cappuccino": 7, "matcha-latte": 6,
    "black-tea": 5, "hot-sandwich": 6, "meat-pie": 4, "cheesecake": 4, "gateau-chocolat": 3, "morning-set": 5, "beans-oasis": 3, "beans-seasonal": 1,
}

# 種類ごとの、来店できる日の来店確率（平日基準）。曜日の係数は、通勤の人（loyal）と、そのほか。
VISIT_RATE = {"loyal": 0.70, "regular": 0.32, "occasional": 0.11, "lapsed": 0.26}  # trial は、決まった 1〜2 日だけ来る（Customer.trial_days）
DOW_FACTOR_COMMUTER = (1.0, 1.0, 1.0, 1.0, 1.0, 0.45, 0.30)  # 月〜日
DOW_FACTOR_OTHER = (0.90, 0.90, 0.95, 1.0, 1.15, 1.15, 0.85)
FESTIVAL_FACTOR = 1.5  # 帰還祭（12/1〜12/25）

# 在庫の補充（新設のダミー）。生鮮は月・木に目標まで。そのほかは金・土（豆は世界観の資料どおり）に、発注点の 3 倍を切っていれば目標まで。
FRESH_ITEMS = {"milk", "bread", "hot-sandwich", "meat-pie", "cheesecake", "gateau-chocolat"}
FRESH_DELIVERY_WEEKDAYS = (1, 4)
DRY_DELIVERY_WEEKDAYS = (5, 6)
DRY_REORDER_FACTOR = 3
PERISHABLE_WASTE = {  # 品目 → (1 日の確率, 量の範囲)
    "milk": (0.12, (300, 800)), "bread": (0.12, (1, 3)), "hot-sandwich": (0.10, (1, 2)), "meat-pie": (0.10, (1, 2)),
    "cheesecake": (0.10, (1, 2)), "gateau-chocolat": (0.10, (1, 2)),
}
WASTE_REASONS = (("賞味期限切れ", 5), ("落として破損", 2), ("品質確認で廃棄", 2), ("作り過ぎ", 1))
# 在庫を少なめに持つ店・品目の再現（ダミー）: (店, 品目) → (補充の上限を、通常の何割にするか, 補充が止まる日〔今日からの日数。None は止まらない〕)。
# 期間の初めに、棚卸しの差異（adjust）で、その上限まで減らす。発注点を下回る日が出る。
STRESSED_STOCK = {
    ("rock-lookout", "milk"): (0.15, None),
    ("ruins-terrace", "cup-m"): (0.12, None),
    ("terminal-central", "coffee-beans"): (0.35, 20),  # 20 日前から補充が止まる（仕入れ先の遅れ。ダミー）
    ("residential-dome", "gateau-chocolat"): (0.30, None),
}


@dataclass
class Variant:
    id: int
    item_code: str
    size: str
    temperature: str
    price: int


@dataclass
class StoreInfo:
    id: int
    code: str
    area: int
    seats: int
    open_min: int
    close_min: int
    last_order_min: int
    closed_weekday: int | None
    mobile_order: bool


@dataclass
class Customer:
    idx: int
    kind: str
    join_day: date
    lapse_day: date | None
    home: list[int]
    fav: set[str]
    size_pref: str
    ice_pref: float
    trial_days: frozenset = frozenset()  # 試しに使っただけの人（trial）が来る日（1〜2 日）


@dataclass
class Plan:
    """来店 1 回（注文 1 件の予定）。"""

    customer: int
    store_id: int
    placed: datetime  # 店のローカル時刻（タイムゾーンなし）
    lines: dict[int, int]  # 変種 ID → 数量
    outcome: str  # completed / cancel_customer / cancel_declined / cancel_timeout / cancel_staff
    key: tuple = field(default=())


def _rng(*parts) -> random.Random:
    return random.Random(f"{SEED}:" + ":".join(str(p) for p in parts))  # 文字列の種は、実行ごとに同じ（PYTHONHASHSEED に依らない）


# ---- 元になる表の読み取り ----

def _load_stores(conn: psycopg.Connection) -> list[StoreInfo]:
    rows = conn.execute(
        "SELECT id, code, area_code, seats, open_time, close_time, last_order_minutes, closed_weekday, mobile_order FROM stores ORDER BY id"
    ).fetchall()
    return [StoreInfo(r[0], r[1], r[2], r[3], r[4].hour * 60 + r[4].minute, r[5].hour * 60 + r[5].minute, r[6], r[7], r[8]) for r in rows]


def _load_menu(conn: psycopg.Connection) -> tuple[dict[str, dict], dict[str, list[Variant]]]:
    items = {
        r[0]: {"season_from": r[1], "season_to": r[2], "sold_from": r[3], "sold_until": r[4]}
        for r in conn.execute("SELECT code, season_from, season_to, sold_from, sold_until FROM menu_items WHERE is_active ORDER BY id")
    }
    variants: dict[str, list[Variant]] = {}
    for r in conn.execute(
        "SELECT v.id, i.code, v.size, v.temperature, v.price_lumi FROM menu_variants v JOIN menu_items i ON i.id = v.item_id WHERE i.is_active ORDER BY v.id"
    ):
        variants.setdefault(r[1], []).append(Variant(*r))
    return items, variants


# ---- 顧客 ----

def make_customers(stores: list[StoreInfo], window_start: date, today: date) -> list[Customer]:
    mo_stores = [s for s in stores if s.mobile_order]
    customers = []
    for i in range(1, N_CUSTOMERS + 1):
        rng = _rng("customer", i)
        roll = rng.random()
        kind = "loyal" if roll < 0.13 else "regular" if roll < 0.40 else "occasional" if roll < 0.66 else "lapsed" if roll < 0.80 else "trial"
        lapse_day = None
        if kind == "lapsed":
            if rng.random() < 0.5:
                lapse_day = today - timedelta(days=rng.randint(15, 28))  # 最近まで来ていた（離れかけ）
            else:
                lapse_day = window_start + timedelta(days=rng.randint(30, 55))  # だいぶ前に来なくなった（休眠）
            join_day = window_start - timedelta(days=rng.randint(3, 100)) if rng.random() < 0.6 else window_start + timedelta(days=rng.randint(0, 25))
        elif kind == "trial":  # 試しに使っただけの人（1〜2 回）。期間の中で入会する
            join_day = window_start + timedelta(days=rng.randint(0, 80))
        else:
            join_day = window_start - timedelta(days=rng.randint(3, 300)) if rng.random() < 0.45 else window_start + timedelta(days=rng.randint(0, 80))
        primary = rng.choices(mo_stores, weights=[s.seats for s in mo_stores])[0]  # 規模（席数）に比例して選ばれる
        home = [primary.id]
        if rng.random() < 0.5:
            near = [s for s in mo_stores if s.area == primary.area and s.id != primary.id] or [s for s in mo_stores if s.id != primary.id]
            home.append(rng.choice(near).id)
        fav = set(rng.sample(sorted(ITEM_WEIGHTS), 2))
        trial_days: frozenset = frozenset()
        if kind == "trial":
            span = max(1, (today - join_day).days)
            trial_days = frozenset(join_day + timedelta(days=d) for d in rng.sample(range(span), min(span, 1 if rng.random() < 0.6 else 2)))
        customers.append(Customer(i, kind, join_day, lapse_day, home, fav, rng.choice(["S", "M", "M", "L"]), rng.choice([0.2, 0.4, 0.6]), trial_days))
    return customers


# ---- 注文の予定（顧客ごと・日ごと） ----

def _sample_minute(rng: random.Random, lo: int, hi: int) -> int:
    """朝（8:20 前後）と夕方（17:20 前後）に山がある時刻。店の受付の時間に入るまで引き直す。"""
    for _ in range(30):
        r = rng.random()
        m = int(rng.gauss(8 * 60 + 20, 50) if r < 0.40 else rng.gauss(12 * 60 + 20, 55) if r < 0.55 else rng.gauss(17 * 60 + 20, 60))
        if lo <= m <= hi:
            return m
    return rng.randint(lo, hi)


def _item_ok(item: dict, day: date, minute: int) -> bool:
    if not rules.in_season(day.strftime("%m-%d"), item["season_from"], item["season_to"]):
        return False
    sold_from, sold_until = item["sold_from"], item["sold_until"]
    if sold_from is not None and minute < sold_from.hour * 60 + sold_from.minute:
        return False
    return not (sold_until is not None and minute > sold_until.hour * 60 + sold_until.minute)


def _pick_variant(rng: random.Random, options: list[Variant], customer: Customer) -> Variant:
    sizes = {v.size for v in options}
    size = customer.size_pref if customer.size_pref in sizes else "M" if "M" in sizes else sorted(sizes)[0]
    sized = [v for v in options if v.size == size]
    temps = {v.temperature for v in sized}
    temp = "-" if temps == {"-"} else ("ice" if rng.random() < customer.ice_pref and "ice" in temps else "hot" if "hot" in temps else sorted(temps)[0])
    return next(v for v in sized if v.temperature == temp)


def plan_visits(customers: list[Customer], stores: dict[int, StoreInfo], closures: set[tuple[int, date]], items: dict[str, dict],
                variants: dict[str, list[Variant]], window_start: date, today: date) -> list[Plan]:
    plans: list[Plan] = []
    day = window_start
    while day <= today:
        in_festival = rules.in_season(day.strftime("%m-%d"), "12-01", "12-25")
        for c in customers:
            if day < c.join_day or (c.lapse_day is not None and day >= c.lapse_day):
                continue
            factor = (DOW_FACTOR_COMMUTER if c.kind == "loyal" else DOW_FACTOR_OTHER)[day.weekday()] * (FESTIVAL_FACTOR if in_festival else 1.0)
            for visit in range(2):  # 通勤の人は、朝と夕方の 2 回が、たまにある
                rng = _rng("visit", c.idx, day.isoformat(), visit)
                if c.kind == "trial":
                    if visit == 1 or day not in c.trial_days:
                        continue
                elif rng.random() >= VISIT_RATE[c.kind] * factor * (1.0 if visit == 0 else 0.15):
                    continue
                store = _choose_store(rng, c, stores, closures, day)
                if store is None:
                    continue
                lo, hi = store.open_min, store.close_min - store.last_order_min
                minute = _sample_minute(rng, lo, hi)
                lines = _choose_lines(rng, c, items, variants, day, minute)
                roll = rng.random()
                outcome = "completed"
                if roll < CANCEL_RATE:
                    outcome = rng.choices(["cancel_customer", "cancel_declined", "cancel_timeout", "cancel_staff"], weights=[40, 20, 25, 15])[0]
                plans.append(Plan(c.idx, store.id, datetime(day.year, day.month, day.day) + timedelta(minutes=minute, seconds=rng.randint(0, 59) if minute < hi else 0),  # ラストオーダーの時刻ちょうどまで
                                  lines, outcome, key=(day, c.idx, visit)))
        day += timedelta(days=1)
    return plans


def _choose_store(rng: random.Random, c: Customer, stores: dict[int, StoreInfo], closures: set[tuple[int, date]], day: date) -> StoreInfo | None:
    order = c.home[:] if rng.random() < 0.85 else c.home[::-1]
    for sid in order:
        s = stores[sid]
        if s.mobile_order and s.closed_weekday != day.isoweekday() and (sid, day) not in closures:
            return s
    return None


def _choose_lines(rng: random.Random, c: Customer, items: dict[str, dict], variants: dict[str, list[Variant]], day: date, minute: int) -> dict[int, int]:
    codes = [code for code in sorted(ITEM_WEIGHTS) if code in items and code in variants and _item_ok(items[code], day, minute)]
    weights = [ITEM_WEIGHTS[code] * (3 if code in c.fav else 1) for code in codes]
    n_lines = rng.choices([1, 2, 3], weights=[60, 30, 10])[0]
    lines: dict[int, int] = {}
    for _ in range(n_lines):
        code = rng.choices(codes, weights=weights)[0]
        variant = _pick_variant(rng, variants[code], c)
        lines[variant.id] = lines.get(variant.id, 0) + rng.choices([1, 2, 3], weights=[85, 13, 2])[0]
    return lines


# ---- 在庫の補充・廃棄の予定（店ごと） ----

def _stock_events(store: StoreInfo, stock: dict[int, dict], window_start: date, today: date) -> list[tuple]:
    """(ローカル時刻, 優先, 通し番号, 種類, 内容)。receive と waste は、条件を見るのは処理するとき（その時点の残高で）。"""
    events: list[tuple] = []
    seq = 0
    day = window_start
    while day <= today:
        for item_id, item in sorted(stock.items()):
            code = item["code"]
            stressed = STRESSED_STOCK.get((store.code, code))
            stopped = stressed is not None and stressed[1] is not None and day >= today - timedelta(days=stressed[1])
            weekdays = FRESH_DELIVERY_WEEKDAYS if code in FRESH_ITEMS else DRY_DELIVERY_WEEKDAYS
            if day.isoweekday() in weekdays and not stopped:
                seq += 1
                events.append((datetime(day.year, day.month, day.day, 6, 0), 0, seq, "receive", item_id))
            waste = PERISHABLE_WASTE.get(code)
            if waste is not None and store.closed_weekday != day.isoweekday():
                rng = _rng("waste", store.id, code, day.isoformat())
                if rng.random() < waste[0]:
                    reason = rng.choices([r for r, _ in WASTE_REASONS], weights=[w for _, w in WASTE_REASONS])[0]
                    seq += 1
                    events.append((datetime(day.year, day.month, day.day) + timedelta(minutes=store.close_min - 20), 3, seq, "waste",
                                   (item_id, rng.randint(*waste[1]), reason)))
        day += timedelta(days=1)
    return events


# ---- 本体 ----

def seed(conn: psycopg.Connection, *, today: date, as_of: datetime, offset_hours: int | None = None, build_analytics: bool = True) -> dict:
    """履歴を入れる。conn は、seed_demo が作った直後（--reset で空にした）の接続。戻り値は件数。as_of は、今日の注文をどこまで入れるかの時刻（UTC）。"""
    offset = settings.local_utc_offset_hours() if offset_hours is None else offset_hours
    to_utc = lambda local: (local - timedelta(hours=offset)).replace(tzinfo=timezone.utc)  # noqa: E731
    as_of_local = as_of.astimezone(timezone.utc).replace(tzinfo=None) + timedelta(hours=offset)
    window_start = today - timedelta(days=HISTORY_DAYS)

    stores = _load_stores(conn)
    by_id = {s.id: s for s in stores}
    items, variants = _load_menu(conn)
    stock = {r[0]: {"code": r[1], "safety": r[2], "reorder": r[3]} for r in conn.execute("SELECT id, code, safety_stock, reorder_point FROM stock_items ORDER BY id")}
    stock_by_code = {v["code"]: k for k, v in stock.items()}
    staff_by_store = {r[0]: r[1] for r in conn.execute("SELECT store_id, min(id) FROM staff_accounts WHERE store_id IS NOT NULL GROUP BY store_id")}
    recipe_map: dict[int, list[tuple[int, int]]] = {}
    for variant_id, stock_item_id, qty in conn.execute("SELECT variant_id, stock_item_id, qty FROM recipe_lines ORDER BY variant_id, stock_item_id"):
        recipe_map.setdefault(variant_id, []).append((stock_item_id, qty))

    # 臨時休業（ダミー）
    closures: set[tuple[int, date]] = set()
    store_by_code = {s.code: s for s in stores}
    for days_ago, code, reason in TEMPORARY_CLOSURES:
        sid = store_by_code[code].id
        closures.add((sid, today - timedelta(days=days_ago)))
        conn.execute("INSERT INTO store_closures (store_id, date, reason) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING", (sid, today - timedelta(days=days_ago), reason))

    customers = make_customers(stores, window_start, today)
    plans = plan_visits(customers, by_id, closures, items, variants, window_start, today)
    plans = [p for p in plans if p.placed <= as_of_local - timedelta(minutes=25)]  # 今日の分は、確定したものだけ（進行中の注文は作らない）

    # ---- 顧客（users） ----
    for c in customers:
        created = to_utc(datetime(c.join_day.year, c.join_day.month, c.join_day.day, 9, 0))
        conn.execute(
            "INSERT INTO users (auth_user_id, display_name, loyalty_points, created_at) VALUES (%s, %s, 0, %s)",
            (f"dev:hist-{c.idx:03d}", f"ダミー顧客 {c.idx:03d}", created),
        )
    user_ids = {r[0]: r[1] for r in conn.execute("SELECT auth_user_id, id FROM users WHERE auth_user_id LIKE 'dev:hist-%'")}

    # ---- 店ごとに、在庫を時間順に動かしながら、受け付けた注文を決める ----
    accepted: list[dict] = []
    movements: list[tuple] = []
    final_stock: dict[tuple[int, int], int] = {}
    public_ids = _public_ids(len(plans) + 10)
    by_store: dict[int, list[Plan]] = {}
    for p in plans:
        by_store.setdefault(p.store_id, []).append(p)
    opening = {(r[0], r[1]): r[2] for r in conn.execute("SELECT store_id, item_id, on_hand FROM stock_balances")}

    for store in stores:
        state = {i: opening.get((store.id, i), 0) for i in stock}
        reserved = {i: 0 for i in stock}
        target = {i: opening.get((store.id, i), 0) for i in stock}  # 補充の上限は、初期在庫（席数に比例）
        for (stress_store, stress_code), (par, _stop) in STRESSED_STOCK.items():
            if stress_store == store.code:
                item_id = stock_by_code[stress_code]
                target[item_id] = max(1, int(target[item_id] * par))
                if state[item_id] > target[item_id]:
                    delta = target[item_id] - state[item_id]
                    movements.append((store.id, item_id, "adjust", delta, "seed", None, "棚卸しの差異（ダミー）", "seed",
                                      to_utc(datetime(window_start.year, window_start.month, window_start.day, 6, 30))))
                    state[item_id] += delta
        events = _stock_events(store, stock, window_start, today)
        heap: list[tuple] = [e for e in events if e[0] <= as_of_local]
        for p in sorted(by_store.get(store.id, []), key=lambda p: (p.placed, p.key)):
            heap.append((p.placed, 2, hash_free_seq(p), "order", p))
        heapq.heapify(heap)
        followup = 0
        while heap:
            when, _prio, _seq, kind, data = heapq.heappop(heap)
            if kind == "receive":
                item_id = data
                code = stock[item_id]["code"]
                if code in FRESH_ITEMS:
                    qty = target[item_id] - state[item_id]
                else:
                    qty = target[item_id] - state[item_id] if state[item_id] - stock[item_id]["safety"] < stock[item_id]["reorder"] * DRY_REORDER_FACTOR else 0
                if qty > 0:
                    movements.append((store.id, item_id, "receive", qty, "delivery", None, "定期の納品（ダミー）", "system", to_utc(when)))
                    state[item_id] += qty
            elif kind == "waste":
                item_id, qty, reason = data
                qty = min(qty, state[item_id] - reserved[item_id])
                if qty > 0:
                    movements.append((store.id, item_id, "waste", -qty, "manual", None, reason, f"staff:{staff_by_store[store.id]}", to_utc(when)))
                    state[item_id] -= qty
            elif kind == "order":
                p: Plan = data
                need = inventory.requirements(list(p.lines.items()), recipe_map)
                if any(state[i] - reserved[i] - stock[i]["safety"] < n for i, n in need.items()):
                    continue  # 売り切れ（この注文は入らなかった）
                oidx = len(accepted)
                order = {"plan": p, "need": need, "public_id": public_ids[oidx], "store": store, "oidx": oidx}
                accepted.append(order)
                for i, n in need.items():
                    reserved[i] += n
                rng = _rng("flow", p.key, p.store_id)
                t_paid = p.placed + timedelta(seconds=rng.randint(30, 120))
                order["times"] = {"placed": p.placed}
                if p.outcome == "completed" or p.outcome == "cancel_staff":
                    order["times"]["paid"] = t_paid
                    order["times"]["accepted"] = t_paid + timedelta(seconds=rng.randint(20, 120))
                if p.outcome == "completed":
                    order["times"]["preparing"] = order["times"]["accepted"] + timedelta(seconds=rng.randint(30, 120))
                    order["times"]["ready"] = order["times"]["preparing"] + timedelta(minutes=rng.randint(3, 8))
                    order["times"]["completed"] = order["times"]["ready"] + timedelta(minutes=rng.randint(1, 5))
                    t_follow, f_kind = order["times"]["preparing"], "consume"
                elif p.outcome == "cancel_staff":
                    order["times"]["cancelled"] = order["times"]["accepted"] + timedelta(seconds=rng.randint(30, 180))
                    t_follow, f_kind = order["times"]["cancelled"], "release"
                else:
                    wait = {"cancel_customer": rng.randint(60, 360), "cancel_declined": rng.randint(20, 90), "cancel_timeout": limits.RESERVATION_TTL.seconds}[p.outcome]
                    order["times"]["cancelled"] = p.placed + timedelta(seconds=wait)
                    t_follow, f_kind = order["times"]["cancelled"], "release"
                actor = f"customer:{user_ids[f'dev:hist-{p.customer:03d}']}"
                for i, n in sorted(need.items()):
                    movements.append((store.id, i, "reserve", n, "order", order["public_id"], None, actor, to_utc(p.placed)))
                followup += 1
                heapq.heappush(heap, (t_follow, 1, -followup, f_kind, order))
            else:  # consume / release（注文の続き）
                order = data
                p = order["plan"]
                staff = f"staff:{staff_by_store[store.id]}"
                for i, n in sorted(order["need"].items()):
                    reserved[i] -= n
                    if kind == "consume":
                        state[i] -= n
                        movements.append((store.id, i, "consume", -n, "order", order["public_id"], None, staff, to_utc(when)))
                    else:
                        actor = {"cancel_customer": actor_customer(user_ids, p), "cancel_staff": staff}.get(p.outcome, "system")
                        reason = {"cancel_customer": "customer_request", "cancel_declined": "payment_declined", "cancel_timeout": "payment_timeout", "cancel_staff": "材料切れ"}[p.outcome]
                        movements.append((store.id, i, "release", -n, "order", order["public_id"], reason, actor, to_utc(when)))
        for i in stock:
            final_stock[(store.id, i)] = state[i]
            assert reserved[i] == 0

    # ---- 受け取り番号（店 × 営業日の連番。受け付けた順） ----
    counters: dict[tuple[int, date], int] = {}
    for order in sorted(accepted, key=lambda o: (o["plan"].placed, o["oidx"])):
        p = order["plan"]
        key = (p.store_id, p.placed.date())
        counters[key] = counters.get(key, 0) + 1
        order["pickup_no"] = counters[key]

    n = _write(conn, accepted, counters, movements, final_stock, user_ids, staff_by_store, by_id, variants, to_utc)
    n["store_closures"] = len(TEMPORARY_CLOSURES)
    if build_analytics:
        key = settings.analytics_pseudonym_key(allow_dev_default=True)  # 開発用の固定の鍵を許すのは、seed のときだけ
        result = analytics_build.build(conn, today=today, key=key, offset_hours=offset, now=as_of, start=window_start)
        n["analytics"] = result["counts"]
    return n


def hash_free_seq(plan: Plan) -> int:
    """同じ時刻の注文の並びを、決定的にする通し番号（顧客・日・来店の順）。"""
    day, idx, visit = plan.key
    return day.toordinal() * 100_000 + idx * 10 + visit


def actor_customer(user_ids: dict[str, int], plan: Plan) -> str:
    return f"customer:{user_ids[f'dev:hist-{plan.customer:03d}']}"


def _public_ids(count: int) -> list[str]:
    rng = _rng("public-ids")
    seen: set[str] = set()
    result: list[str] = []
    while len(result) < count:
        pid = "".join(rng.choice(_PUBLIC_ID_ALPHABET) for _ in range(8))
        if pid not in seen:
            seen.add(pid)
            result.append(pid)
    return result


def _write(conn, accepted, counters, movements, final_stock, user_ids, staff_by_store, stores, variants, to_utc) -> dict:
    variant_by_id = {v.id: v for vs in variants.values() for v in vs}
    prices = {v.id: v.price for v in variant_by_id.values()}
    names = {r[0]: r[1] for r in conn.execute("SELECT code, name FROM menu_items")}
    order_rows, item_rows, event_rows, payment_rows, loyalty_rows, reservation_rows = [], [], [], [], [], []
    for o in sorted(accepted, key=lambda o: o["oidx"]):
        p: Plan = o["plan"]
        t = o["times"]
        subtotal = sum(prices[v] * q for v, q in p.lines.items())
        status = "completed" if p.outcome == "completed" else "cancelled"
        staff_id = str(staff_by_store[p.store_id])
        cancel_reason = None if status == "completed" else {
            "cancel_customer": "customer_request", "cancel_declined": "payment_declined", "cancel_timeout": "payment_timeout", "cancel_staff": "材料切れ",
        }[p.outcome]
        uid = user_ids[f"dev:hist-{p.customer:03d}"]
        order_rows.append((
            o["public_id"], uid, p.store_id, status, "pickup", o["pickup_no"], p.placed.date(), subtotal, 0, subtotal, "screen", f"seed-{o['public_id']}",
            to_utc(p.placed), to_utc(t["paid"]) if "paid" in t else None, to_utc(t["accepted"]) if "accepted" in t else None,
            to_utc(t["ready"]) if "ready" in t else None, to_utc(t["completed"]) if "completed" in t else None,
            to_utc(t["cancelled"]) if "cancelled" in t else None, cancel_reason,
        ))
        for variant_id, qty in sorted(p.lines.items()):
            v = variant_by_id[variant_id]
            item_rows.append((o["public_id"], variant_id, names[v.item_code], v.size, v.temperature, prices[variant_id], qty, prices[variant_id] * qty))
        # 履歴（order_events）。支払いは、いつも system
        steps = [(None, "placed", "customer", str(uid), None, t["placed"])]
        if p.outcome == "completed":
            steps += [("placed", "paid", "system", None, None, t["paid"]), ("paid", "accepted", "staff", staff_id, None, t["accepted"]),
                      ("accepted", "preparing", "staff", staff_id, None, t["preparing"]), ("preparing", "ready", "staff", staff_id, None, t["ready"]),
                      ("ready", "completed", "staff", staff_id, None, t["completed"])]
            pay_status = "paid"
        elif p.outcome == "cancel_staff":
            steps += [("placed", "paid", "system", None, None, t["paid"]), ("paid", "accepted", "staff", staff_id, None, t["accepted"]),
                      ("accepted", "cancelled", "staff", staff_id, cancel_reason, t["cancelled"])]
            pay_status = "refunded"
        else:
            actor = ("customer", str(uid)) if p.outcome == "cancel_customer" else ("system", None)
            steps.append(("placed", "cancelled", actor[0], actor[1], cancel_reason, t["cancelled"]))
            pay_status = "failed"
        for frm, to, actor_type, actor_id, reason, at in steps:
            event_rows.append((o["public_id"], frm, to, actor_type, actor_id, reason, to_utc(at)))
        payment_rows.append((o["public_id"], "mock", pay_status, subtotal, to_utc(t["placed"]), to_utc(t.get("paid") or t.get("cancelled") or t["placed"])))
        reservation_rows.append((o["public_id"], "consumed" if p.outcome == "completed" else "expired" if p.outcome == "cancel_timeout" else "released",
                                 to_utc(t["placed"]), to_utc(t.get("completed") or t["cancelled"]), o["need"]))
        if status == "completed" and subtotal // limits.LOYALTY_LUMI_PER_POINT > 0:
            loyalty_rows.append((o["public_id"], uid, subtotal // limits.LOYALTY_LUMI_PER_POINT, "earn", to_utc(t["completed"])))

    def copy(table: str, columns: str, rows) -> None:
        with conn.cursor() as cur, cur.copy(f"COPY {table} ({columns}) FROM STDIN") as cp:  # noqa: S608（固定の表名・列名）
            for row in rows:
                cp.write_row(row)

    copy("orders", "public_id, user_id, store_id, status, fulfillment, pickup_no, business_date, subtotal_lumi, delivery_fee_lumi, total_lumi, source, "
         "idempotency_key, placed_at, paid_at, accepted_at, ready_at, completed_at, cancelled_at, cancel_reason", order_rows)
    ids = {r[0]: r[1] for r in conn.execute("SELECT public_id, id FROM orders WHERE idempotency_key LIKE 'seed-%'")}
    copy("order_items", "order_id, variant_id, name, size, temperature, unit_price_lumi, qty, line_total_lumi", [(ids[r[0]], *r[1:]) for r in item_rows])
    copy("order_events", "order_id, from_status, to_status, actor_type, actor_id, reason, at", [(ids[r[0]], *r[1:]) for r in event_rows])
    copy("payments", "order_id, provider, status, amount_lumi, created_at, updated_at", [(ids[r[0]], *r[1:]) for r in payment_rows])
    copy("stock_reservations", "order_id, status, expires_at, created_at, updated_at", [(ids[r[0]], r[1], None, r[2], r[3]) for r in reservation_rows])
    res_ids = {r[0]: r[1] for r in conn.execute("SELECT order_id, id FROM stock_reservations")}
    copy("stock_reservation_lines", "reservation_id, item_id, qty",
         [(res_ids[ids[r[0]]], item_id, qty) for r in reservation_rows for item_id, qty in sorted(r[4].items())])
    copy("loyalty_ledger", "order_id, user_id, points, kind, at", [(ids[r[0]], *r[1:]) for r in loyalty_rows])
    copy("store_order_counters", "store_id, business_date, last_no", [(sid, d, last) for (sid, d), last in sorted(counters.items())])
    copy("stock_movements", "store_id, item_id, kind, qty, ref_type, ref_id, reason, actor, occurred_at", sorted(movements, key=lambda m: (m[8], m[0], m[1], m[2])))
    conn.execute(
        "UPDATE users u SET loyalty_points = s.points FROM (SELECT user_id, sum(points)::int AS points FROM loyalty_ledger GROUP BY user_id) s WHERE s.user_id = u.id"
    )
    for (store_id, item_id), on_hand in sorted(final_stock.items()):
        conn.execute("UPDATE stock_balances SET on_hand = %s, reserved = 0 WHERE store_id = %s AND item_id = %s", (on_hand, store_id, item_id))
    return {"orders": len(order_rows), "order_items": len(item_rows), "order_events": len(event_rows), "stock_movements": len(movements), "users": len(user_ids)}


def reset_analytics(conn: psycopg.Connection) -> None:
    """seed_demo --reset が、元の表を空にする前に呼ぶ。analytics の表も空にする（無ければ何もしない。DROP はしない）。"""
    if conn.execute("SELECT to_regclass('analytics.build_state')").fetchone()[0] is None:
        return
    for table in ("daily_store_summary", "daily_store_item_sales", "daily_store_hourly", "daily_stock_levels", "daily_stock_waste",
                  "customer_rfm", "customer_monthly", "customer_pseudonyms", "build_state"):
        conn.execute(f"DELETE FROM analytics.{table}")  # noqa: S608（固定の表名）


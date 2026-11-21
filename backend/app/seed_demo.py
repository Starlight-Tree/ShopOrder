"""ローカル用のダミーデータ（架空の惑星ザーハード、アルカ市のオアシス珈琲）を入れる。実在の店・人・企業のデータは使わない。

    DEMO_DATA=allow python -m app.seed_demo            # 足りないものを入れる（何度流しても同じ。価格・レシピ・スタッフは書き直す。在庫の数は上書きしない）
    DEMO_DATA=allow python -m app.seed_demo --reset    # 店・メニュー・在庫・注文・スタッフを消して入れ直す（台帳の削除は、このときだけ許す）
    DEMO_DATA=allow python -m app.seed_demo --reset --history  # 上に加えて、過去 90 日のダミーの注文・在庫の台帳と、分析の日次集計（app/seed_history.py。--reset と一緒のときだけ）

店・営業時間・席は docs/world.md の「店舗（12）」（資料: cafe_store_guide.md）。メニューと価格は「新設」の参考値（docs/world.md の表）。
**資料の事実（店・席・営業時間）と、新設の値（メニュー・価格）を、ここでも混ぜない。** 世界観の値を変えるときは、docs/world.md を先に直す。
在庫の品目・レシピ（変種ごとの使用量）・初期在庫・デモのスタッフは、すべて新設のダミー（docs/decisions/0004「レシピの使用量はダミー」）。
本番の DB には向けない。DEMO_DATA=allow が無いと、実行を拒否する。
"""

import os
import sys
from datetime import date, datetime, time, timedelta, timezone

import psycopg
from argon2 import PasswordHasher

from app import settings
from app.settings import database_url, require_demo_data_allowed

AREAS = [(1, "居住区", 1), (2, "発着場", 2), (3, "岩山", 3), (4, "遺跡", 4)]

# (code, 名前, エリア, 住所, 開店, 閉店, 定休日(1=月…7=日), ラストオーダー前の分, MO 可, 席)  出典: docs/world.md（資料）
STORES = [
    ("residential-main", "居住区本店", 1, "アルカ市居住区1-4-2", (7, 0), (21, 0), None, 30, True, 68),
    ("residential-dome", "居住区ドーム店", 1, "アルカ市居住区3-8-11", (8, 0), (20, 0), 3, 30, True, 42),
    ("residential-market", "居住区市場前店", 1, "アルカ市居住区5-2-6", (6, 30), (18, 0), 7, 30, True, 30),
    ("residential-signal", "居住区信号塔店", 1, "アルカ市居住区7-1-9", (9, 0), (19, 0), 2, 30, False, 24),
    ("terminal-central", "発着場中央店", 2, "アルカ市発着場2-1-5", (7, 0), (22, 0), None, 30, True, 54),
    ("terminal-west", "発着場西口店", 2, "アルカ市発着場4-6-3", (7, 30), (21, 0), None, 30, True, 36),
    ("terminal-east", "発着場東口店", 2, "アルカ市発着場6-3-8", (8, 0), (21, 0), 1, 30, True, 40),
    ("rock-plaza", "岩山広場店", 3, "アルカ市岩山2-5-1", (9, 0), (18, 0), 4, 30, True, 48),
    ("rock-school", "岩山学園前店", 3, "アルカ市岩山5-7-4", (8, 0), (19, 0), 7, 30, True, 32),
    ("rock-lookout", "岩山展望店", 3, "アルカ市岩山8-2-10", (10, 0), (18, 0), 3, 30, True, 28),
    ("ruins-terrace", "遺跡テラス店", 4, "アルカ市遺跡1-3-7", (9, 0), (20, 0), None, 30, True, 76),
    ("ruins-hut", "遺跡発掘小屋店", 4, "アルカ市遺跡3-9-2", (10, 0), (17, 0), 2, 15, True, 20),
]

# (code, 名前, 区分, 説明, アレルゲン, (期間 from, to)|None, (販売 from, until)|None, 変種 [(size, temperature, 価格)])  価格は新設の参考値（docs/world.md）
def _both(size: str, price: int, ice_extra: int = 0) -> list[tuple[str, str, int]]:
    return [(size, "hot", price), (size, "ice", price + ice_extra)]


MENU = [
    ("oasis-blend", "オアシスブレンド", "drink", "深煎りの豆を 3 種類ブレンドした、オアシス珈琲の看板。豆は 3 つの栽培ドーム産で、居住区の自社工房で焙煎します。", [], None, None,
     _both("S", 380) + _both("M", 450) + _both("L", 520)),
    ("seasonal-blend", "季節のブレンド", "drink", "3 か月ごと、年 4 回入れ替わるブレンド。", [], None, None, _both("M", 480)),
    ("kikan-limited", "帰還祭の限定ドリンク", "drink", "帰還祭（12/1〜12/25）だけの限定ドリンク。数がなくなり次第、その日の販売は終了します。", [], ("12-01", "12-25"), None, _both("M", 550)),
    ("cafe-latte", "カフェラテ", "drink", "ミルクとコーヒーのバランスのドリンク。", ["乳"], None, None, _both("M", 500) + _both("L", 570)),
    ("americano", "アメリカーノ", "drink", "すっきりとした一杯。", [], None, None, _both("S", 340) + _both("M", 400) + _both("L", 460)),
    ("cappuccino", "カプチーノ", "drink", "ふわりとしたミルクの泡を重ねた一杯。", ["乳"], None, None, _both("S", 380) + _both("M", 440) + _both("L", 500)),
    ("matcha-latte", "抹茶ラテ", "drink", "抹茶とミルクのドリンク。アイスは 20 ルミ増し。", ["乳"], None, None,
     _both("S", 420, 20) + _both("M", 480, 20) + _both("L", 540, 20)),
    ("black-tea", "紅茶", "drink", "すっきりとした香りの紅茶。", [], None, None, _both("S", 300) + _both("M", 360) + _both("L", 420)),
    ("hot-sandwich", "ホットサンド", "food", "焼きたてのホットサンド。", ["乳", "小麦"], None, None, [("-", "-", 520)]),
    ("meat-pie", "ミートパイ", "food", "11:00 から。", ["卵", "乳", "小麦"], None, (time(11, 0), None), [("-", "-", 480)]),
    ("cheesecake", "チーズケーキ", "food", "しっとりとしたチーズケーキ。", ["卵", "乳", "小麦"], None, None, [("-", "-", 450)]),
    ("gateau-chocolat", "ガトーショコラ", "food", "濃厚なガトーショコラ。", ["卵", "乳", "小麦", "くるみ"], None, None, [("-", "-", 460)]),
    ("morning-set", "モーニングセット", "food", "オアシスブレンド（S）とトースト。7:00〜10:30。", ["乳", "小麦"], None, (time(7, 0), time(10, 30)), [("-", "-", 600)]),
    ("beans-oasis", "オアシスブレンドの豆（200 g）", "beans", "自社工房で焙煎した豆。", [], None, None, [("-", "-", 1800)]),
    ("beans-seasonal", "季節のブレンドの豆（200 g）", "beans", "自社工房で焙煎した、季節のブレンドの豆。", [], None, None, [("-", "-", 1900)]),
]


# ---- 在庫（新設のダミー） ----
# (code, 名前, 区分, 単位, 発注点, 安全在庫, 席 40 の店の初期在庫)。初期在庫は、店の席数に比例させる（決定的。乱数なし）。
STOCK_ITEMS = [
    ("coffee-beans", "コーヒー豆", "material", "g", 2000, 500, 12000),
    ("milk", "牛乳", "material", "ml", 4000, 1000, 20000),
    ("matcha", "抹茶", "material", "g", 150, 50, 800),
    ("tea-leaves", "紅茶葉", "material", "g", 150, 50, 900),
    ("cup-s", "カップ S", "material", "個", 40, 10, 200),
    ("cup-m", "カップ M", "material", "個", 60, 10, 300),
    ("cup-l", "カップ L", "material", "個", 40, 10, 200),
    ("bread", "パン", "material", "個", 15, 5, 60),
    ("hot-sandwich", "ホットサンド", "sellable", "個", 6, 0, 30),
    ("meat-pie", "ミートパイ", "sellable", "個", 6, 0, 24),
    ("cheesecake", "チーズケーキ", "sellable", "個", 6, 0, 24),
    ("gateau-chocolat", "ガトーショコラ", "sellable", "個", 5, 0, 20),
    ("beans-bag-oasis", "オアシスブレンドの豆（200 g）", "sellable", "袋", 8, 0, 40),
    ("beans-bag-seasonal", "季節のブレンドの豆（200 g）", "sellable", "袋", 6, 0, 30),
]
# 売り切れを再現するための、少量の在庫（店の code, 品目の code）→ 個数
LOW_STOCK = {("terminal-west", "gateau-chocolat"): 3}

_BEANS_G = {"S": 14, "M": 18, "L": 22}
_MILK_ML = {"S": 150, "M": 200, "L": 250}
_CAPPUCCINO_MILK_ML = {"S": 120, "M": 160, "L": 200}
_MATCHA_G = {"S": 4, "M": 5, "L": 6}
_TEA_G = {"S": 3, "M": 4, "L": 5}
_CUP = {"S": "cup-s", "M": "cup-m", "L": "cup-l"}
_SELLABLE_FOOD = {"hot-sandwich", "meat-pie", "cheesecake", "gateau-chocolat"}


def recipe(item_code: str, size: str) -> list[tuple[str, int]]:
    """変種 1 つ（ドリンク 1 杯・菓子 1 個など）の使用量 [(在庫品目の code, 量)]。ホットとアイスは同じ。"""
    if item_code in ("oasis-blend", "seasonal-blend", "kikan-limited", "americano"):
        return [("coffee-beans", _BEANS_G[size]), (_CUP[size], 1)]
    if item_code == "cafe-latte":
        return [("coffee-beans", _BEANS_G[size]), ("milk", _MILK_ML[size]), (_CUP[size], 1)]
    if item_code == "cappuccino":
        return [("coffee-beans", _BEANS_G[size]), ("milk", _CAPPUCCINO_MILK_ML[size]), (_CUP[size], 1)]
    if item_code == "matcha-latte":
        return [("matcha", _MATCHA_G[size]), ("milk", _MILK_ML[size]), (_CUP[size], 1)]
    if item_code == "black-tea":
        return [("tea-leaves", _TEA_G[size]), (_CUP[size], 1)]
    if item_code in _SELLABLE_FOOD:
        return [(item_code, 1)]
    if item_code == "morning-set":
        return [("coffee-beans", _BEANS_G["S"]), ("cup-s", 1), ("bread", 1)]
    if item_code == "beans-oasis":
        return [("beans-bag-oasis", 1)]
    if item_code == "beans-seasonal":
        return [("beans-bag-seasonal", 1)]
    raise ValueError(f"レシピが未定義の品です: {item_code}")


def _t(hm: tuple[int, int]) -> time:
    return time(hm[0], hm[1])


def _staff_password() -> str:
    return os.environ.get("DEMO_STAFF_PASSWORD") or "oasis-demo-pass"  # ダミーで、秘密ではない（docs/api.md）


# リセットで消す順（外部キーの子から親へ）。台帳（stock_movements・order_events）は、SET LOCAL oasis.allow_ledger_reset = 'on' のときだけ消せる
_RESET_ORDER = (
    "loyalty_ledger", "stock_reservation_lines", "stock_reservations", "payments", "idempotency_keys", "order_events", "order_items", "deliveries", "orders",
    "store_order_counters", "checkout_proposals", "cart_items", "carts", "addresses", "delivery_slots", "users", "staff_sessions", "staff_login_attempts",
    "couriers", "staff_accounts",
    "stock_movements", "stock_balances", "recipe_lines", "stock_items",
    "menu_variants", "menu_items", "store_closures", "store_zones", "zone_travel_minutes", "delivery_zones", "stores", "areas",
)


def main(reset: bool = False, url: str | None = None, history: bool = False, today: date | None = None, as_of: datetime | None = None) -> None:
    if history and not reset:
        raise SystemExit("--history は --reset と一緒に指定してください（履歴は、空にした DB へ入れます）。実行しませんでした。")
    if history:  # 履歴（P4 の分析用ダミー）。--history のときだけ読み込む
        from app import clock, seed_history

        as_of = as_of or clock.utc_now()
        today = today or (as_of + timedelta(hours=settings.local_utc_offset_hours())).date()
    with psycopg.connect(url or database_url()) as conn:
        if reset:
            conn.execute("SET LOCAL oasis.allow_ledger_reset = 'on'")  # このトランザクションの中だけ。追記のみの表の DELETE を通す
            from app import seed_history as _seed_history

            _seed_history.reset_analytics(conn)  # 分析の表（派生データ）は、元の表より先に空にする
            for table in _RESET_ORDER:
                conn.execute(f"DELETE FROM {table}")  # noqa: S608（固定の表名。ダミーの入れ直しだけ）
        for code, name, sort in AREAS:
            conn.execute(
                "INSERT INTO areas (code, name, sort) VALUES (%s, %s, %s) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, sort = EXCLUDED.sort",
                (code, name, sort),
            )
        for code, name, area, address, opens, closes, closed, last_order, mobile, seats in STORES:
            conn.execute(
                "INSERT INTO stores (code, name, area_code, address, open_time, close_time, closed_weekday, last_order_minutes, mobile_order, seats) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, area_code = EXCLUDED.area_code, "
                "address = EXCLUDED.address, open_time = EXCLUDED.open_time, close_time = EXCLUDED.close_time, closed_weekday = EXCLUDED.closed_weekday, "
                "last_order_minutes = EXCLUDED.last_order_minutes, mobile_order = EXCLUDED.mobile_order, seats = EXCLUDED.seats",
                (code, name, area, address, _t(opens), _t(closes), closed, last_order, mobile, seats),
            )
        for sort, (code, name, category, description, allergens, season, window, variants) in enumerate(MENU, start=1):
            season_from, season_to = season if season else (None, None)
            sold_from, sold_until = window if window else (None, None)
            item_id = conn.execute(
                "INSERT INTO menu_items (code, name, category, description, allergens, season_from, season_to, sold_from, sold_until, sort) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, "
                "description = EXCLUDED.description, allergens = EXCLUDED.allergens, season_from = EXCLUDED.season_from, season_to = EXCLUDED.season_to, "
                "sold_from = EXCLUDED.sold_from, sold_until = EXCLUDED.sold_until, sort = EXCLUDED.sort RETURNING id",
                (code, name, category, description, allergens, season_from, season_to, sold_from, sold_until, sort),
            ).fetchone()[0]
            for size, temperature, price in variants:
                conn.execute(
                    "INSERT INTO menu_variants (item_id, size, temperature, price_lumi) VALUES (%s, %s, %s, %s) "
                    "ON CONFLICT (item_id, size, temperature) DO UPDATE SET price_lumi = EXCLUDED.price_lumi",
                    (item_id, size, temperature, price),
                )
        opening_at = None
        if history:  # 初期在庫の日付を、履歴の期間の前日にする（台帳の残量が、期間の初めから合うように）
            first = today - timedelta(days=seed_history.HISTORY_DAYS + 1)
            opening_at = datetime(first.year, first.month, first.day, 12, 0, tzinfo=timezone.utc)
        _seed_inventory(conn, opening_at=opening_at)
        _seed_staff(conn)
        _seed_delivery(conn)
        history_counts = seed_history.seed(conn, today=today, as_of=as_of) if history else None
    print(f"店 {len(STORES)} 件・メニュー {len(MENU)} 品・在庫の品目 {len(STOCK_ITEMS)} 件・デモのスタッフ {len(STORES) + 1} 人・宅配の区画 {len(ZONES)} 件・配達員 {len(COURIERS)} 人を入れました")
    if history_counts is not None:
        print("ダミーの履歴（過去 90 日。すべてダミー）: " + ", ".join(f"{k} {v}" for k, v in history_counts.items() if k != "analytics"))


def _seed_inventory(conn: psycopg.Connection, opening_at: datetime | None = None) -> None:
    for code, name, kind, unit, reorder_point, safety_stock, _ in STOCK_ITEMS:
        conn.execute(
            "INSERT INTO stock_items (code, name, kind, unit, reorder_point, safety_stock) VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, unit = EXCLUDED.unit, "
            "reorder_point = EXCLUDED.reorder_point, safety_stock = EXCLUDED.safety_stock",
            (code, name, kind, unit, reorder_point, safety_stock),
        )
    stock_ids = {r[0]: r[1] for r in conn.execute("SELECT code, id FROM stock_items")}
    # レシピ: 全ての変種に必要（足りなければ、ここで止める。注文が「材料なしで通る」品を作らない）
    variants = conn.execute("SELECT v.id, i.code, v.size FROM menu_variants v JOIN menu_items i ON i.id = v.item_id ORDER BY v.id").fetchall()
    for variant_id, item_code, size in variants:
        lines = recipe(item_code, size)
        conn.execute("DELETE FROM recipe_lines WHERE variant_id = %s", (variant_id,))
        for stock_code, qty in lines:
            conn.execute("INSERT INTO recipe_lines (variant_id, stock_item_id, qty) VALUES (%s, %s, %s)", (variant_id, stock_ids[stock_code], qty))
    # 残高: 無い店・品目だけ入れる（再実行しても、今の在庫を上書きしない）。台帳には、初期在庫の receive を同時に追記する（台帳と残高を合わせる）
    now = opening_at or datetime.now(timezone.utc)
    stores = conn.execute("SELECT id, code, seats FROM stores ORDER BY id").fetchall()
    for store_id, store_code, seats in stores:
        for code, _name, _kind, _unit, _rp, _ss, base in STOCK_ITEMS:
            qty = LOW_STOCK.get((store_code, code), max(1, round(base * seats / 40)))
            inserted = conn.execute(
                "INSERT INTO stock_balances (store_id, item_id, on_hand, reserved, updated_at) VALUES (%s, %s, %s, 0, %s) ON CONFLICT (store_id, item_id) DO NOTHING RETURNING item_id",
                (store_id, stock_ids[code], qty, now),
            ).fetchone()
            if inserted is not None:
                conn.execute(
                    "INSERT INTO stock_movements (store_id, item_id, kind, qty, ref_type, reason, actor, occurred_at) VALUES (%s, %s, 'receive', %s, 'seed', %s, 'seed', %s)",
                    (store_id, stock_ids[code], qty, "初期在庫（ダミー）", now),
                )


def _seed_staff(conn: psycopg.Connection) -> None:
    """デモのスタッフ（docs/api.md）: 各店 staff-<店の code>@oasis-cafe.example、店長（全店）manager@oasis-cafe.example。パスワードは DEMO_STAFF_PASSWORD。"""
    hasher = PasswordHasher()
    password = _staff_password()
    accounts = [(f"staff-{code}@oasis-cafe.example", f"{name}のスタッフ", "staff", code) for code, name, *_ in STORES]
    accounts.append(("manager@oasis-cafe.example", "店長（全店）", "manager", None))
    for email, name, role, store_code in accounts:
        store_id = None
        if store_code is not None:
            store_id = conn.execute("SELECT id FROM stores WHERE code = %s", (store_code,)).fetchone()[0]
        conn.execute(
            "INSERT INTO staff_accounts (store_id, role, name, email, password_hash, is_active) VALUES (%s, %s, %s, %s, %s, true) "
            "ON CONFLICT (email) DO UPDATE SET store_id = EXCLUDED.store_id, role = EXCLUDED.role, name = EXCLUDED.name, "
            "password_hash = EXCLUDED.password_hash, is_active = true",
            (store_id, role, name, email, hasher.hash(password)),
        )


# ---- 宅配（P2）。区画・送料・所要・区画間の分は docs/world.md「宅配」（新設）の値。最低注文額は、資料の範囲（600〜900）の両端が居住区・遺跡で、
# 発着場 700・岩山 800 は、その間を等間隔に置いた新設。配達員の名前・店の割り当てはダミー（人物設定は新設）。 ----
# (エリアの code, 区画の名前, 送料, 無料になる小計, 最低注文額, 基準の所要分)
ZONES = [(1, "居住区", 150, 2000, 600, 25), (2, "発着場", 200, 2000, 700, 30), (3, "岩山", 300, 2000, 800, 40), (4, "遺跡", 400, 2000, 900, 50)]
# 区画間の所要分（往復で同じ値を入れる）
ZONE_TRAVEL = {(1, 2): 10, (2, 3): 15, (3, 4): 15, (1, 3): 20, (2, 4): 25, (1, 4): 30}
# 配達員 8 人（店の code, 名前）。宅配をする店 = 配達員がいる 6 店（world.md の「店ごとに数人」「全 12 店」より少ない。依頼の「6〜8 人」に合わせた）
COURIERS = [
    ("residential-main", "ラシード"), ("residential-main", "ナディア"), ("residential-dome", "カミル"),
    ("terminal-central", "ヤスミン"), ("terminal-central", "ハリド"), ("terminal-west", "サーラ"),
    ("rock-plaza", "イドリス"), ("ruins-terrace", "ライラ"),
]


def courier_email(store_code: str, n: int) -> str:
    return f"courier-{store_code}-{n}@oasis-cafe.example"


def delivery_neighbor(area: int) -> int:
    """隣接 1 エリア（居住区—発着場—岩山—遺跡の順の「次」。最後の遺跡だけ手前の岩山）。新設。"""
    return area + 1 if area < len(ZONES) else area - 1


def _seed_delivery(conn: psycopg.Connection) -> None:
    """区画・区画間の分・宅配をする店・配達員（courier ロールのデモのアカウント）・今日から 7 日先までの時間枠。何度流しても同じ（今の is_suspended・勤務・枠の予約数は上書きしない）。"""
    from psycopg.rows import dict_row, tuple_row

    from app import clock, delivery

    for area, name, fee, free_over, min_order, base in ZONES:
        conn.execute(
            "INSERT INTO delivery_zones (area_code, name, fee_lumi, free_over_lumi, min_order_lumi, base_minutes) VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (area_code) DO UPDATE SET name = EXCLUDED.name, fee_lumi = EXCLUDED.fee_lumi, free_over_lumi = EXCLUDED.free_over_lumi, "
            "min_order_lumi = EXCLUDED.min_order_lumi, base_minutes = EXCLUDED.base_minutes",
            (area, name, fee, free_over, min_order, base),
        )
    zone_id = {r[0]: r[1] for r in conn.execute("SELECT area_code, id FROM delivery_zones")}
    for (a, b), minutes in ZONE_TRAVEL.items():
        for src, dst in ((a, b), (b, a)):
            conn.execute(
                "INSERT INTO zone_travel_minutes (from_zone_id, to_zone_id, minutes) VALUES (%s, %s, %s) "
                "ON CONFLICT (from_zone_id, to_zone_id) DO UPDATE SET minutes = EXCLUDED.minutes",
                (zone_id[src], zone_id[dst], minutes),
            )
    # 宅配をする店 = 配達員がいる店。届ける区画は、店のエリア + 隣接 1 エリア
    stores_by_code = {r[0]: (r[1], r[2]) for r in conn.execute("SELECT code, id, area_code FROM stores")}
    for code in dict.fromkeys(c for c, _ in COURIERS):
        store_id, area = stores_by_code[code]
        for zone_area in (area, delivery_neighbor(area)):
            conn.execute("INSERT INTO store_zones (store_id, zone_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (store_id, zone_id[zone_area]))
    hasher = PasswordHasher()
    password = _staff_password()
    counters: dict[str, int] = {}
    for store_code, name in COURIERS:
        counters[store_code] = counters.get(store_code, 0) + 1
        store_id = stores_by_code[store_code][0]
        staff_id = conn.execute(
            "INSERT INTO staff_accounts (store_id, role, name, email, password_hash, is_active) VALUES (%s, 'courier', %s, %s, %s, true) "
            "ON CONFLICT (email) DO UPDATE SET store_id = EXCLUDED.store_id, role = EXCLUDED.role, name = EXCLUDED.name, "
            "password_hash = EXCLUDED.password_hash, is_active = true RETURNING id",
            (store_id, name, courier_email(store_code, counters[store_code]), hasher.hash(password)),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO couriers (staff_id, store_id) VALUES (%s, %s) ON CONFLICT (staff_id) DO UPDATE SET store_id = EXCLUDED.store_id", (staff_id, store_id)
        )
    # 枠: delivery.ensure_slots は dict の行を読むので、この間だけ行の形を変える
    today = clock.local_now().date()
    conn.row_factory = dict_row
    try:
        for code in dict.fromkeys(c for c, _ in COURIERS):
            store = _store_row(conn, stores_by_code[code][0])
            delivery.ensure_window(conn, store, today)
    finally:
        conn.row_factory = tuple_row


def _store_row(conn: psycopg.Connection, store_id: int) -> dict:
    return conn.execute(
        "SELECT id, open_time, close_time, closed_weekday, last_order_minutes FROM stores WHERE id = %s", (store_id,)
    ).fetchone()


if __name__ == "__main__":
    require_demo_data_allowed()
    main(reset="--reset" in sys.argv[1:], history="--history" in sys.argv[1:])

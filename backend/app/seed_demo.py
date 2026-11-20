"""ローカル用のダミーデータ（架空の惑星ザーハード、アルカ市のオアシス珈琲）を入れる。実在の店・人・企業のデータは使わない。

    DEMO_DATA=allow python -m app.seed_demo            # 足りないものを入れる（何度流しても同じ。価格などは書き直す）
    DEMO_DATA=allow python -m app.seed_demo --reset    # 店・メニューを消して入れ直す

店・営業時間・席は docs/world.md の「店舗（12）」（資料: cafe_store_guide.md）。メニューと価格は「新設」の参考値（docs/world.md の表）。
**資料の事実（店・席・営業時間）と、新設の値（メニュー・価格）を、ここでも混ぜない。** 世界観の値を変えるときは、docs/world.md を先に直す。
本番の DB には向けない。DEMO_DATA=allow が無いと、実行を拒否する。
"""

import sys
from datetime import time

import psycopg

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


def _t(hm: tuple[int, int]) -> time:
    return time(hm[0], hm[1])


def main(reset: bool = False, url: str | None = None) -> None:
    with psycopg.connect(url or database_url()) as conn:
        if reset:
            for table in ("menu_variants", "menu_items", "store_closures", "stores", "areas"):
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
    print(f"店 {len(STORES)} 件・メニュー {len(MENU)} 品を入れました")


if __name__ == "__main__":
    require_demo_data_allowed()
    main(reset="--reset" in sys.argv[1:])

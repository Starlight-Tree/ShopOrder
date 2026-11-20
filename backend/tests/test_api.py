def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_twelve_stores_in_four_areas(client):
    stores = client.get("/api/stores").json()
    assert len(stores) == 12
    by_area: dict[str, int] = {}
    for s in stores:
        by_area[s["area"]] = by_area.get(s["area"], 0) + 1
    assert by_area == {"居住区": 4, "発着場": 3, "岩山": 3, "遺跡": 2}
    assert sum(s["seats"] for s in stores) == 498  # 資料: 座席の合計


def test_store_exceptions_from_the_canon(client):
    stores = {s["name"]: s for s in client.get("/api/stores").json()}
    assert stores["居住区信号塔店"]["mobile_order"] is False  # MO 不可はここだけ
    assert [n for n, s in stores.items() if not s["mobile_order"]] == ["居住区信号塔店"]
    assert stores["遺跡発掘小屋店"]["last_order_minutes"] == 15  # ラストオーダーが閉店 15 分前なのはここだけ
    assert [n for n, s in stores.items() if s["last_order_minutes"] == 15] == ["遺跡発掘小屋店"]
    assert sorted(n for n, s in stores.items() if s["closed_weekday"] is None) == ["居住区本店", "発着場中央店", "発着場西口店", "遺跡テラス店"]  # 年中無休は 4 店
    assert stores["居住区市場前店"]["open_time"] == "06:30"  # 最も早い開店
    assert stores["発着場中央店"]["close_time"] == "22:00"  # 最も遅い閉店


def test_menu_has_the_canon_items_with_prices_in_lumi(client):
    menu = {i["code"]: i for i in client.get("/api/menu").json()}
    ob = menu["oasis-blend"]
    prices = {(v["size"], v["temperature"]): v["price_lumi"] for v in ob["variants"]}
    assert prices[("S", "hot")] == prices[("S", "ice")] == 380
    assert prices[("M", "hot")] == 450 and prices[("L", "ice")] == 520
    assert menu["seasonal-blend"]["variants"][0]["size"] == "M"
    limited = menu["kikan-limited"]
    assert (limited["season_from"], limited["season_to"]) == ("12-01", "12-25")  # 帰還祭


def test_menu_windows_and_allergens(client):
    menu = {i["code"]: i for i in client.get("/api/menu").json()}
    assert menu["morning-set"]["sold_from"] == "07:00" and menu["morning-set"]["sold_until"] == "10:30"
    assert menu["meat-pie"]["sold_from"] == "11:00" and menu["meat-pie"]["sold_until"] is None
    assert menu["gateau-chocolat"]["allergens"] == ["卵", "乳", "小麦", "くるみ"]
    ice = {(v["size"], v["temperature"]): v["price_lumi"] for v in menu["matcha-latte"]["variants"]}
    assert ice[("M", "ice")] == ice[("M", "hot")] + 20


def test_every_item_has_variants_and_integer_prices(client):
    for item in client.get("/api/menu").json():
        assert item["variants"], item["code"]
        assert all(isinstance(v["price_lumi"], int) and v["price_lumi"] > 0 for v in item["variants"])

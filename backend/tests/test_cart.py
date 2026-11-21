"""カートと確定の許可証（docs/api.md「カート」）。(j) 価格は今のメニューの値・版が上がる、(k) 提案が古いと 409、(o) 合計の上限。"""

from datetime import timedelta

from app import clock
from tests.conftest import at_local
from tests.helpers import code_of


def test_cart_is_created_empty_and_needs_a_valid_dev_user(client, shop):
    h = shop.user()
    cart = client.get("/api/cart", headers=h).json()
    assert cart["lines"] == [] and cart["store"] is None and cart["fulfillment"] == "pickup" and cart["total_lumi"] == 0
    # X-Dev-User が無ければ demo-customer。形が違えば 401
    assert client.get("/api/cart").status_code == 200
    r = client.get("/api/cart", headers={"X-Dev-User": "Bad Name!"})
    assert r.status_code == 401 and code_of(r) == "unauthorized"


def test_cart_prices_come_from_the_current_menu_and_every_change_bumps_the_version(client, shop):
    h = shop.user()
    sandwich = shop.variant("hot-sandwich")
    v0 = client.get("/api/cart", headers=h).json()["version"]
    r = client.put("/api/cart", json={"store_id": shop.store_id("residential-main"), "fulfillment": "pickup"}, headers=h)
    assert r.status_code == 200 and r.json()["version"] == v0 + 1 and r.json()["store"]["name"] == "居住区本店"
    r = client.put(f"/api/cart/items/{sandwich}", json={"qty": 2}, headers=h)
    cart = r.json()
    assert cart["version"] == v0 + 2
    assert cart["lines"][0]["unit_price_lumi"] == 520 and cart["lines"][0]["line_total_lumi"] == 1040 and cart["total_lumi"] == 1040
    # メニューの価格を変えると、カートの金額は次の取得で変わる（カートに価格を保存していない）
    with shop.db() as conn:
        conn.execute("UPDATE menu_variants SET price_lumi = 530 WHERE id = %s", (sandwich,))
    try:
        again = client.get("/api/cart", headers=h).json()
        assert again["lines"][0]["unit_price_lumi"] == 530 and again["total_lumi"] == 1060
        assert again["version"] == v0 + 2  # 読むだけでは上がらない
    finally:
        with shop.db() as conn:
            conn.execute("UPDATE menu_variants SET price_lumi = 520 WHERE id = %s", (sandwich,))
    # 絶対値指定。同じ値でも版は上がる。0 で外す
    assert client.put(f"/api/cart/items/{sandwich}", json={"qty": 2}, headers=h).json()["version"] == v0 + 3
    removed = client.put(f"/api/cart/items/{sandwich}", json={"qty": 0}, headers=h).json()
    assert removed["lines"] == [] and removed["version"] == v0 + 4
    cleared = client.delete("/api/cart", headers=h).json()
    assert cleared["lines"] == [] and cleared["version"] == v0 + 5


def test_cart_input_limits_and_errors(client, shop):
    h = shop.user()
    sandwich = shop.variant("hot-sandwich")
    assert client.put(f"/api/cart/items/{sandwich}", json={"qty": 21}, headers=h).status_code == 422
    assert client.put(f"/api/cart/items/{sandwich}", json={"qty": -1}, headers=h).status_code == 422
    r = client.put("/api/cart/items/999999", json={"qty": 1}, headers=h)
    assert r.status_code == 404 and code_of(r) == "variant_not_found"
    r = client.put("/api/cart", json={"store_id": 999999, "fulfillment": "pickup"}, headers=h)
    assert r.status_code == 404 and code_of(r) == "store_not_found"
    r = client.put("/api/cart", json={"store_id": shop.store_id("residential-main"), "fulfillment": "delivery"}, headers=h)
    assert r.status_code == 422 and code_of(r) == "delivery_unsupported"
    assert client.put("/api/cart", json={"store_id": None, "fulfillment": "pickup", "extra": 1}, headers=h).status_code == 422


def test_a_cart_holds_at_most_30_lines(client, shop):
    h = shop.user()
    variants = sorted(set(shop._variants.values()))
    assert len(variants) >= 31
    for variant_id in variants[:30]:
        assert client.put(f"/api/cart/items/{variant_id}", json={"qty": 1}, headers=h).status_code == 200
    r = client.put(f"/api/cart/items/{variants[30]}", json={"qty": 1}, headers=h)
    assert r.status_code == 422 and code_of(r) == "too_many_lines"
    # 既にある行の数量の変更は、30 行でも通る
    assert client.put(f"/api/cart/items/{variants[0]}", json={"qty": 3}, headers=h).status_code == 200


def test_proposal_validation_errors(client, shop):
    h = shop.user()
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and code_of(r) == "cart_empty"
    client.put(f"/api/cart/items/{shop.variant('hot-sandwich')}", json={"qty": 1}, headers=h)
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and code_of(r) == "store_not_selected"
    # MO 不可の店（居住区信号塔店）。営業時間を見ない設定でも、これは常に見る
    client.put("/api/cart", json={"store_id": shop.store_id("residential-signal"), "fulfillment": "pickup"}, headers=h)
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "store_closed" and r.json()["detail"]["closed_reason"] == "mobile_order_unavailable"


def test_proposal_for_an_out_of_season_item_lists_the_variants(client, shop):
    clock.freeze(at_local(2026, 11, 21, 12))  # 帰還祭（12/1〜12/25）の前
    h = shop.user()
    limited = shop.variant("kikan-limited", "M", "hot")
    shop.fill_cart(h, "residential-main", [(limited, 1)])
    cart = client.get("/api/cart", headers=h).json()
    assert cart["lines"][0]["available"] is False and cart["lines"][0]["unavailable_reason"] == "out_of_season"
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and code_of(r) == "item_unavailable" and r.json()["detail"]["variant_ids"] == [limited]
    clock.freeze(at_local(2026, 12, 3, 12))  # 期間の中なら出せる
    assert client.post("/api/cart/checkout-proposal", headers=h).status_code == 200


def test_proposal_shape(client, shop):
    h = shop.user()
    p = shop.proposal(h, "residential-main", [(shop.variant("oasis-blend", "M", "hot"), 2)])
    assert p["total_lumi"] == 900 and p["store"]["name"] == "居住区本店" and p["pickup_note"] == "店頭でお渡しします"
    assert p["cart_version"] == client.get("/api/cart", headers=h).json()["version"]
    assert p["lines"][0]["name"] == "オアシスブレンド" and p["lines"][0]["line_total_lumi"] == 900
    assert p["expires_at"].endswith("Z") and len(p["id"]) == 36


def test_over_limit_total_is_refused(client, shop):
    """(o) 合計は 30,000 ルミまで。20 袋 × 1,900 = 38,000。"""
    h = shop.user()
    shop.fill_cart(h, "terminal-central", [(shop.variant("beans-seasonal"), 20)])
    r = client.post("/api/cart/checkout-proposal", headers=h)
    assert r.status_code == 409 and code_of(r) == "over_limit"
    # 30,000 ちょうどは通る（15 袋 × 1,900 = 28,500 は通り、16 袋 = 30,400 は通らない）
    client.put(f"/api/cart/items/{shop.variant('beans-seasonal')}", json={"qty": 15}, headers=h)
    assert client.post("/api/cart/checkout-proposal", headers=h).status_code == 200
    client.put(f"/api/cart/items/{shop.variant('beans-seasonal')}", json={"qty": 16}, headers=h)
    assert code_of(client.post("/api/cart/checkout-proposal", headers=h)) == "over_limit"


def test_stale_proposal_when_the_cart_changes(client, shop):
    """(k) カートの版が変わったら、古い提案では確定できない（409 proposal_stale）。"""
    h = shop.user()
    sandwich = shop.variant("hot-sandwich")
    p = shop.proposal(h, "residential-main", [(sandwich, 1)])
    client.put(f"/api/cart/items/{sandwich}", json={"qty": 2}, headers=h)
    r = shop.place(h, p["id"])
    assert r.status_code == 409 and code_of(r) == "proposal_stale"
    assert client.get("/api/orders", headers=h).json() == []  # 注文は作られていない
    # 新しい提案なら通る
    p2 = client.post("/api/cart/checkout-proposal", headers=h).json()
    assert p2["cart_version"] > p["cart_version"]
    assert shop.place(h, p2["id"]).status_code == 201


def test_stale_proposal_when_the_price_changes_and_expired_proposal(client, shop):
    h = shop.user()
    cheese = shop.variant("cheesecake")
    p = shop.proposal(h, "residential-main", [(cheese, 1)])
    with shop.db() as conn:
        conn.execute("UPDATE menu_variants SET price_lumi = 460 WHERE id = %s", (cheese,))
    try:
        r = shop.place(h, p["id"])  # 版は同じでも、今の価格で計算した合計が違えば拒否
        assert r.status_code == 409 and code_of(r) == "proposal_stale"
    finally:
        with shop.db() as conn:
            conn.execute("UPDATE menu_variants SET price_lumi = 450 WHERE id = %s", (cheese,))
    p = client.post("/api/cart/checkout-proposal", headers=h).json()
    clock.freeze(clock.utc_now() + timedelta(minutes=11))  # 有効 10 分
    r = shop.place(h, p["id"])
    assert r.status_code == 409 and code_of(r) == "proposal_expired"
    clock.freeze(None)
    assert shop.place(h, p["id"]).status_code == 201


def test_proposal_of_another_user_is_404_and_proposal_is_single_use(client, shop):
    a, b = shop.user(), shop.user()
    p = shop.proposal(a, "residential-main", [(shop.variant("hot-sandwich"), 1)])
    shop.fill_cart(b, "residential-main", [(shop.variant("hot-sandwich"), 1)])
    r = shop.place(b, p["id"])
    assert r.status_code == 404 and code_of(r) == "proposal_not_found"
    assert shop.place(a, p["id"]).status_code == 201
    r = shop.place(a, p["id"])  # 別のキーで、同じ許可証をもう一度
    assert r.status_code == 409 and code_of(r) == "proposal_stale"
    assert len(client.get("/api/orders", headers=a).json()) == 1

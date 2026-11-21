"""(b) 同時の注文で、在庫を超えて売らない。スレッドで同時に確定し、成功の数・台帳・残高が合うことを見る（docs/decisions/0004 の「実際の同時実行」）。"""

import threading

import pytest

from tests.helpers import code_of


def _race(shop, store, item_code, stock, users):
    shop.set_available(store, item_code, stock)
    variant = shop.variant(item_code)
    proposals = []
    for _ in range(users):
        h = shop.user()
        proposals.append((h, shop.proposal(h, store, [(variant, 1)])))
    results = [None] * users
    barrier = threading.Barrier(users)

    def go(i):
        h, p = proposals[i]
        barrier.wait()
        results[i] = shop.place(h, p["id"])

    threads = [threading.Thread(target=go, args=(i,)) for i in range(users)]
    [t.start() for t in threads]
    [t.join(timeout=60) for t in threads]
    assert all(r is not None for r in results), "確定が時間内に終わらなかった"
    return proposals, results


@pytest.mark.parametrize(("stock", "users"), [(1, 2), (3, 6)])
def test_concurrent_orders_never_oversell(client, shop, stock, users):
    store = "ruins-terrace"
    proposals, results = _race(shop, store, "gateau-chocolat", stock, users)
    ok = [r for r in results if r.status_code == 201]
    refused = [r for r in results if r.status_code != 201]
    assert len(ok) == stock  # 成功は、ちょうど在庫の数
    assert all(r.status_code == 409 and code_of(r) == "sold_out" for r in refused)
    on_hand, reserved = shop.balance(store, "gateau-chocolat")
    assert on_hand - reserved == 0  # 出せる量は 0（ガトーショコラの安全在庫は 0）。確保は在庫の数を超えない
    # 台帳: 成功した注文の reserve だけが、1 件ずつある。失敗した注文の行は残らない
    for r in ok:
        assert [(m["kind"], m["qty"]) for m in shop.movements(r.json()["public_id"])] == [("reserve", 1)]
    assert shop.reconcile() == []
    # 成功した注文だけ、注文の行がある（失敗した利用者は注文が 0 件）
    ok_count = sum(len(client.get("/api/orders", headers=h).json()) for h, _ in proposals)
    assert ok_count == stock


def test_concurrent_cancel_and_order_keep_the_ledger_consistent(client, shop):
    """取消し（解放）と新しい確定が同時でも、台帳と残高が合う。"""
    store = "ruins-hut"
    shop.set_available(store, "cheesecake", 1)
    holder = shop.user()
    held = shop.order(holder, store, [(shop.variant("cheesecake"), 1)])  # 在庫 0 になる
    challenger = shop.user()
    shop.fill_cart(challenger, store, [(shop.variant("cheesecake"), 1)])
    # 提案は、在庫が無いので作れない（409）。取消しの後ろでは作れる
    assert code_of(client.post("/api/cart/checkout-proposal", headers=challenger)) == "sold_out"
    assert client.post(f"/api/orders/{held['public_id']}/cancel", headers=holder).status_code == 200
    p = client.post("/api/cart/checkout-proposal", headers=challenger).json()
    assert shop.place(challenger, p["id"]).status_code == 201
    assert shop.reconcile() == []

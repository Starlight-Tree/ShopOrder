"""golden set（模擬モデル）。発話 → 期待するツール列・最終のカート・語・カード。全ターンに、安全の評価器（価格・確定の言い切り・アレルギー）も当てる。

流し方: cd evals && <venv>/bin/python -m pytest -q   （TEST_DATABASE_URL が要る。README）
"""

import pytest

from evals.chat import evaluators as ev
from evals.chat import harness
from evals.chat.cases import CASES


@pytest.mark.parametrize("case", CASES, ids=[c.id for c in CASES])
def test_golden(case, shop, monkeypatch):
    headers = shop.user()
    undo = harness.apply_setup(case.setup, shop, headers, monkeypatch)
    try:
        orders_before = 0
        trace, _ = harness.run_conversation(shop, headers, case.store, [t.say for t in case.turns])
        orders_before = trace.orders if case.setup not in ("past_orders", "one_order") else harness.expected_orders(case.setup)
    finally:
        undo()
    checks = [ev.tools_exist(trace), ev.no_confirm_tool_calls(trace), ev.no_order_created(trace, orders_before), ev.confirm_card_only_from_proposal(trace), ev.final_cart(trace, case.cart)]
    for turn, expect in zip(trace.turns, case.turns, strict=True):
        assert turn.status == 200, (case.id, turn.status)
        checks += [
            ev.trajectory(turn, expect.tools), ev.includes(turn, expect.include), ev.excludes(turn, expect.exclude),
            ev.prices_grounded(turn), ev.no_confirmation_claim(turn), ev.allergy_not_overclaimed(turn), ev.write_budget(turn),
        ]
        if expect.cards is not None:
            checks.append(ev.cards_are(turn, expect.cards))
        assert turn.guard is None, f"{case.id}: 出力ガードが働いた（模擬モデルの文面が、ガードに当たっている）: {turn.guard} / {turn.text[:60]}"
    assert not ev.failures(checks), "\n".join(ev.failures(checks))

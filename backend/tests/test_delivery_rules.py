"""宅配の、DB に触れない決まり（app/delivery_rules.py）。DB は要らない。"""

from datetime import date, datetime, time, timedelta, timezone

import pytest

from app import delivery_rules as rules


def _utc(y, m, d, h, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=timezone.utc)


# ---- 時間枠 ----

def test_slot_grid_runs_from_opening_to_the_last_order_and_is_in_utc():
    # 居住区本店: 7:00〜21:00・ラストオーダー 30 分前（= 20:30）。UTC+9。30 分枠は 7:00〜20:30 の 27 枠
    grid = rules.slot_grid(time(7, 0), time(21, 0), 30, date(2026, 11, 22), 9)
    assert len(grid) == 27
    assert grid[0] == (_utc(2026, 11, 21, 22), _utc(2026, 11, 21, 22, 30))  # 7:00 JST = 前日 22:00 UTC
    assert grid[-1][1] == _utc(2026, 11, 22, 11, 30)  # 最後の枠は 20:00〜20:30（= 11:30 UTC）に終わる = ラストオーダーの時刻
    assert all(b - a == timedelta(minutes=30) for a, b in grid)
    assert all(grid[i][1] == grid[i + 1][0] for i in range(len(grid) - 1))  # 隙間なく並ぶ


def test_slot_grid_with_a_15_minute_last_order_drops_a_slot_that_would_pass_it():
    # 遺跡発掘小屋店: 10:00〜17:00・ラストオーダー 15 分前（= 16:45）。16:30〜17:00 は終わりが 16:45 を過ぎるので出さない
    grid = rules.slot_grid(time(10, 0), time(17, 0), 15, date(2026, 11, 22), 9)
    assert len(grid) == 13  # 10:00〜16:30 の 13 枠
    assert grid[-1][1] == _utc(2026, 11, 22, 7, 30)  # 16:30 JST に終わる
    # 開店が 6:30 の店は、6:30 から 30 分ごと（開店に合わせる）
    grid = rules.slot_grid(time(6, 30), time(18, 0), 30, date(2026, 11, 22), 9)
    assert grid[0][0] == _utc(2026, 11, 21, 21, 30) and len(grid) == 22


def test_slot_cutoff_is_prep_plus_lead_before_the_start_and_the_cutoff_instant_is_still_open():
    start = _utc(2026, 11, 22, 3)
    assert rules.PREP_MINUTES + rules.LEAD_MINUTES == 45
    assert rules.order_cutoff(start) == _utc(2026, 11, 22, 2, 15)
    assert rules.slot_unavailable_reason(start, 0, 4, _utc(2026, 11, 22, 2, 15)) is None  # 締めの時刻ちょうどは選べる
    assert rules.slot_unavailable_reason(start, 0, 4, _utc(2026, 11, 22, 2, 15) + timedelta(seconds=1)) == "cutoff"
    assert rules.slot_unavailable_reason(start, 3, 4, _utc(2026, 11, 22, 0)) is None
    assert rules.slot_unavailable_reason(start, 4, 4, _utc(2026, 11, 22, 0)) == "full"
    assert rules.slot_unavailable_reason(start, 4, 4, _utc(2026, 11, 22, 2, 30)) == "cutoff"  # 満席でも締めを先に言う


def test_slot_capacity_is_four_per_slot():
    assert rules.SLOT_CAPACITY == 4 and rules.SLOT_MINUTES == 30


# ---- 送料・最低注文額 ----

@pytest.mark.parametrize(("subtotal", "fee"), [(0, 150), (1999, 150), (2000, 0), (2001, 0), (30000, 0)])
def test_delivery_fee_is_free_from_the_threshold_inclusive(subtotal, fee):
    assert rules.delivery_fee(150, 2000, subtotal) == fee


def test_a_zone_without_a_free_threshold_always_charges():
    assert rules.delivery_fee(400, None, 99_999) == 400


def test_minimum_order_is_inclusive():
    assert rules.meets_minimum(600, 600) and not rules.meets_minimum(599, 600)


# ---- 到着の目安 ----

def test_eta_uses_the_slot_before_departure_and_base_minutes_after():
    slot = _utc(2026, 11, 22, 3)
    departed = _utc(2026, 11, 22, 2, 50)
    assert rules.eta_at("pending", slot, None, 30) == slot
    assert rules.eta_at("assigned", slot, None, 30) == slot
    assert rules.eta_at("picked_up", slot, None, 30) == slot
    assert rules.eta_at("delivering", slot, departed, 30) == departed + timedelta(minutes=30)
    assert [rules.eta_at(s, slot, departed, 30) for s in ("delivered", "failed", "cancelled")] == [None, None, None]


# ---- 暗証コード ----

def test_pin_is_four_digits_deterministic_and_the_hash_is_not_the_pin():
    pin = rules.derive_pin("secret-a", 7, "nonce-1")
    assert len(pin) == 4 and pin.isdigit()
    assert pin == rules.derive_pin("secret-a", 7, "nonce-1")  # 顧客に見せるとき、同じコードを導ける
    h = rules.pin_hash("secret-a", 7, pin)
    assert pin not in h and len(h) == 64
    assert rules.pin_matches("secret-a", 7, pin, h)
    wrong = f"{(int(pin) + 1) % 10000:04d}"
    assert not rules.pin_matches("secret-a", 7, wrong, h)
    # 鍵・配達が違えば、同じ nonce でも別物（DB だけでは、コードに戻せない）
    assert rules.pin_hash("secret-b", 7, pin) != h and rules.pin_hash("secret-a", 8, pin) != h


def test_pins_spread_over_the_whole_range():
    pins = {rules.derive_pin("secret-a", 1, f"n{i}") for i in range(300)}
    assert len(pins) > 200 and all(len(p) == 4 for p in pins)  # 0 埋めの 4 桁


# ---- 配達員の提案 ----

MATRIX = {(1, 2): 10, (2, 1): 10, (2, 3): 15, (3, 2): 15, (1, 3): 20, (3, 1): 20}


def _c(cid, zone, active=0, on_duty=True, name=None):
    return rules.CourierCandidate(cid, name or f"c{cid}", zone, active, on_duty)


def test_nearest_ranks_by_minutes_then_load_then_id():
    # 店の区画 = 2（発着場）。1 は 10 分・3 は 15 分・店にいる（None）は 0 分
    ranked = rules.nearest([_c(1, 3), _c(2, 1), _c(3, None), _c(4, 2)], 2, MATRIX)
    assert [(p.courier_id, p.minutes) for p in ranked] == [(3, 0), (4, 0), (2, 10), (1, 15)]
    # 同じ分なら、担当中の件数が少ない方
    ranked = rules.nearest([_c(1, 1, active=2), _c(2, 1, active=0)], 2, MATRIX)
    assert [p.courier_id for p in ranked] == [2, 1]
    # それも同じなら、ID の小さい方
    assert [p.courier_id for p in rules.nearest([_c(9, 1), _c(5, 1)], 2, MATRIX)] == [5, 9]


def test_nearest_skips_couriers_off_duty_and_returns_nothing_when_nobody_is_on_duty():
    assert [p.courier_id for p in rules.nearest([_c(1, None, on_duty=False), _c(2, 3)], 2, MATRIX)] == [2]
    assert rules.nearest([_c(1, None, on_duty=False)], 2, MATRIX) == []
    assert rules.nearest([], 2, MATRIX) == []


def test_travel_minutes_is_zero_in_the_same_zone_and_symmetric_when_one_direction_is_missing():
    assert rules.travel_minutes(MATRIX, 2, 2) == 0
    assert rules.travel_minutes({(1, 2): 10}, 2, 1) == 10  # 逆向きの行だけでも引ける
    assert rules.travel_minutes({}, 1, 2) > 1000  # 行が無ければ後ろへ回す


def test_the_proposer_is_replaceable_by_name():
    assert rules.get_proposer("nearest") is rules.nearest
    rules.PROPOSERS["first"] = lambda cands, zone, matrix: [rules.Proposal(c.courier_id, c.name, 0) for c in cands]
    try:
        assert rules.get_proposer("first")([_c(4, 1)], 2, MATRIX)[0].courier_id == 4
    finally:
        del rules.PROPOSERS["first"]
    with pytest.raises(RuntimeError):
        rules.get_proposer("no-such-policy")

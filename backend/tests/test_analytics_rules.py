"""分析の決まり（DB に触らない）: ABC・最小の集計単位・RFM・期間・前期比・仮名 ID・鍵の扱い。定義は docs/metrics.md。"""

from datetime import date

import pytest

from app import analytics_build, analytics_rules as rules, settings


# ---- ABC ----

def test_abc_class_is_decided_by_the_cumulative_share_before_the_item():
    table = rules.abc_table([50, 30, 10, 5, 3, 2])  # 合計 100。累積: 50 80 90 95 98 100
    assert [r["abc"] for r in table] == ["A", "A", "B", "B", "C", "C"]  # 手前の累積: 0 50 80 90 95 98
    assert [r["cum_share_pct"] for r in table] == [50.0, 80.0, 90.0, 95.0, 98.0, 100.0]
    assert [r["share_pct"] for r in table] == [50.0, 30.0, 10.0, 5.0, 3.0, 2.0]


def test_abc_an_item_that_crosses_the_line_is_class_a_and_a_is_never_empty():
    assert [r["abc"] for r in rules.abc_table([90, 5, 5])] == ["A", "B", "C"]  # 1 位が 90% でも A
    assert [r["abc"] for r in rules.abc_table([100])] == ["A"]


def test_abc_with_no_sales_is_all_c_with_zero_share():
    assert rules.abc_table([0, 0]) == [{"share_pct": 0.0, "cum_share_pct": 0.0, "abc": "C"}] * 2
    assert rules.abc_table([]) == []


# ---- 最小の集計単位（5 人） ----

def test_cells_under_five_people_are_hidden_and_zero_stays_zero():
    shown = rules.suppress_cells({"a": 12, "b": 7, "c": 4, "d": 0, "e": 3})
    assert shown == {"a": 12, "b": 7, "c": None, "d": 0, "e": None}  # 0 人のセルは、人がいないので 0 のまま


def test_a_single_hidden_cell_also_hides_the_smallest_remaining_one():
    """隠したセルが 1 つだけだと、合計から引き算で戻せる。残りで最小のセル（5 人以上）も隠す。"""
    shown = rules.suppress_cells({"a": 12, "b": 7, "c": 4})
    assert shown == {"a": 12, "b": None, "c": None}


def test_two_hidden_cells_need_no_complement_and_nothing_hidden_changes_nothing():
    assert rules.suppress_cells({"a": 12, "b": 3, "c": 2}) == {"a": 12, "b": None, "c": None}
    assert rules.suppress_cells({"a": 12, "b": 8}) == {"a": 12, "b": 8}


def test_minimum_cell_is_five():
    assert rules.MIN_CELL == 5
    assert rules.suppress_cells({"x": 5, "y": 6}) == {"x": 5, "y": 6}
    assert rules.suppress_cells({"x": 4, "y": 6})["x"] is None


# ---- RFM ----

@pytest.mark.parametrize("days,score", [(0, 3), (14, 3), (15, 2), (30, 2), (31, 1), (89, 1)])
def test_recency_score_boundaries(days, score):
    assert rules.r_score(days) == score


@pytest.mark.parametrize("orders,score", [(1, 1), (9, 1), (10, 2), (29, 2), (30, 3), (64, 3)])
def test_frequency_score_boundaries(orders, score):
    assert rules.f_score(orders) == score


@pytest.mark.parametrize("spend,score", [(0, 1), (7999, 1), (8000, 2), (19999, 2), (20000, 3)])
def test_monetary_score_boundaries(spend, score):
    assert rules.m_score(spend) == score


def test_segments_from_recency_and_frequency():
    assert rules.segment_of(3, 3) == "loyal" and rules.segment_of(3, 2) == "regular" and rules.segment_of(3, 1) == "light"
    assert [rules.segment_of(2, f) for f in (1, 2, 3)] == ["at_risk"] * 3  # 離脱の兆候
    assert [rules.segment_of(1, f) for f in (1, 2, 3)] == ["dormant"] * 3
    assert set(rules.SEGMENTS) == set(rules.SEGMENT_LABELS)


# ---- 廃棄の理由（自由記述 → 固定の区分） ----

@pytest.mark.parametrize("text,code", [("賞味期限切れ", "expired"), ("落として破損", "damaged"), ("品質確認で廃棄", "quality"), ("作り過ぎ", "other"), (None, "other"), ("", "other")])
def test_waste_reason_classification(text, code):
    assert rules.waste_reason_code(text) == code


# ---- 期間 ----

def test_last_complete_range_for_each_grain():
    today = date(2026, 11, 21)  # 土曜。昨日 11/20 は金曜
    assert rules.last_complete_range("day", 28, today) == (date(2026, 10, 24), date(2026, 11, 20))
    assert rules.last_complete_range("week", 2, today) == (date(2026, 11, 2), date(2026, 11, 15))  # 昨日までに終わった週（月〜日）
    assert rules.last_complete_range("month", 2, today) == (date(2026, 9, 1), date(2026, 10, 31))  # 今月（途中）は入れない


def test_last_complete_range_on_a_monday_and_at_a_month_end():
    assert rules.last_complete_range("week", 1, date(2026, 11, 23)) == (date(2026, 11, 16), date(2026, 11, 22))  # 昨日が日曜なら、その週を含む
    assert rules.last_complete_range("month", 1, date(2026, 12, 1)) == (date(2026, 11, 1), date(2026, 11, 30))  # 昨日が月末なら、その月を含む


def test_previous_range_has_the_same_length_and_months_step_by_months():
    assert rules.previous_range(date(2026, 11, 1), date(2026, 11, 14), "day") == (date(2026, 10, 18), date(2026, 10, 31))
    assert rules.previous_range(date(2026, 9, 1), date(2026, 10, 31), "month") == (date(2026, 7, 1), date(2026, 8, 31))
    assert rules.previous_range(date(2026, 3, 1), date(2026, 3, 31), "month") == (date(2026, 2, 1), date(2026, 2, 28))


# ---- 前期比（比べられるときだけ） ----

def _period(start, end, open_days, sales, missing=0):
    return {"start": start, "end": end, "open_days": open_days, "missing_days": missing, "sales_lumi": sales}


def test_comparison_is_made_when_length_weekdays_and_open_days_match():
    cur = _period(date(2026, 11, 3), date(2026, 11, 16), 14, 1100)
    prev = _period(date(2026, 10, 20), date(2026, 11, 2), 14, 1000)
    assert rules.comparison(cur, prev) == {"state": "ok", "previous_sales_lumi": 1000, "change_pct": 10.0}


def test_comparison_refuses_when_weekday_composition_differs():
    cur = _period(date(2026, 11, 7), date(2026, 11, 16), 10, 1100)  # 10 日。土日月…
    prev = _period(date(2026, 10, 28), date(2026, 11, 6), 10, 1000)
    assert rules.comparison(cur, prev) == {"state": "not_comparable", "reason": "weekday_mismatch"}


def test_comparison_refuses_when_open_days_differ_or_previous_is_missing_or_zero():
    cur = _period(date(2026, 11, 3), date(2026, 11, 16), 14, 1100)
    assert rules.comparison(cur, _period(date(2026, 10, 20), date(2026, 11, 2), 13, 1000))["reason"] == "open_days_mismatch"  # 休業があった
    assert rules.comparison(cur, _period(date(2026, 10, 20), date(2026, 11, 2), 14, 1000, missing=2))["reason"] == "previous_missing"
    assert rules.comparison(cur, _period(date(2026, 10, 20), date(2026, 11, 2), 0, 0))["reason"] == "previous_missing"
    assert rules.comparison(cur, _period(date(2026, 10, 20), date(2026, 11, 2), 14, 0))["reason"] == "previous_zero"
    assert set(rules.COMPARISON_MESSAGES) >= {"previous_missing", "weekday_mismatch", "open_days_mismatch", "previous_zero"}


def test_month_to_month_is_usually_not_comparable_because_weekdays_differ():
    cur = _period(date(2026, 10, 1), date(2026, 10, 31), 31, 1100)
    prev = _period(date(2026, 9, 1), date(2026, 9, 30), 30, 1000)
    assert rules.comparison(cur, prev)["state"] == "not_comparable"


# ---- 日の点を週・月に束ねる ----

def _day(d, sales, orders, open_stores, state):
    return {"date": d, "sales_lumi": sales, "orders": orders, "open_stores": open_stores, "state": state}


def test_bucketing_keeps_closed_apart_from_zero_and_flags_unbuilt_weeks():
    days = [_day(date(2026, 11, 2 + i), 100 if i != 2 else None, 1 if i != 2 else None, 1 if i != 2 else 0, "open" if i != 2 else "closed") for i in range(7)]
    week = rules.bucket_points(days, "week")
    assert week == [{"start": date(2026, 11, 2), "sales_lumi": 600, "orders": 6, "open_days": 6, "state": "open"}]  # 休業の日は、合計にも営業日にも入らない
    days[3] = _day(date(2026, 11, 5), None, None, 1, "not_built")
    assert rules.bucket_points(days, "week")[0]["state"] == "not_built" and rules.bucket_points(days, "week")[0]["sales_lumi"] is None
    zero = [_day(date(2026, 11, 2 + i), 0, 0, 1, "open") for i in range(7)]
    assert rules.bucket_points(zero, "week")[0]["sales_lumi"] == 0  # 営業したが売上 0 は 0
    closed = [_day(date(2026, 11, 2 + i), None, None, 0, "closed") for i in range(7)]
    assert rules.bucket_points(closed, "week")[0] == {"start": date(2026, 11, 2), "sales_lumi": None, "orders": None, "open_days": 0, "state": "closed"}
    assert rules.bucket_points(days, "day")[2]["state"] == "closed"


def test_bucketing_into_months():
    days = [_day(date(2026, 10, 30), 10, 1, 1, "open"), _day(date(2026, 10, 31), 20, 1, 1, "open"), _day(date(2026, 11, 1), 5, 1, 1, "open")]
    assert [(b["start"], b["sales_lumi"]) for b in rules.bucket_points(days, "month")] == [(date(2026, 10, 1), 30), (date(2026, 11, 1), 5)]


# ---- 仮名 ID と鍵 ----

def test_pseudonym_is_stable_keyed_and_does_not_contain_the_user_id():
    a = analytics_build.pseudonym_id(b"k" * 32, 123)
    assert a == analytics_build.pseudonym_id(b"k" * 32, 123)
    assert a != analytics_build.pseudonym_id(b"k" * 32, 124) and a != analytics_build.pseudonym_id(b"z" * 32, 123)
    assert len(a) == 32 and all(c in "0123456789abcdef" for c in a)
    assert analytics_build.key_fingerprint(b"k" * 32) != analytics_build.key_fingerprint(b"z" * 32)
    assert analytics_build.key_fingerprint(b"k" * 32) not in a  # 指紋は仮名 ID と別物（鍵の確認用で、顧客を指さない）


def test_pseudonym_key_is_required_except_for_the_dev_default_at_seed_time(monkeypatch):
    monkeypatch.delenv("ANALYTICS_PSEUDONYM_KEY", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    with pytest.raises(RuntimeError, match="ANALYTICS_PSEUDONYM_KEY"):
        settings.analytics_pseudonym_key()  # seed 以外（既定）は、鍵が無ければ失敗する
    assert settings.analytics_pseudonym_key(allow_dev_default=True) == settings.DEV_PSEUDONYM_KEY.encode()
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError, match="ANALYTICS_PSEUDONYM_KEY"):
        settings.analytics_pseudonym_key(allow_dev_default=True)  # 本番相当では、seed でも開発用の固定値は使えない
    monkeypatch.setenv("ANALYTICS_PSEUDONYM_KEY", "a-real-looking-key-0123456789")
    assert settings.analytics_pseudonym_key() == b"a-real-looking-key-0123456789"
    monkeypatch.setenv("ANALYTICS_PSEUDONYM_KEY", "short")
    with pytest.raises(RuntimeError, match="16"):
        settings.analytics_pseudonym_key()

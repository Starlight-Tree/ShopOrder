"""店が今、注文を受けられるか。品が今、出せるか。時刻は、呼ぶ側が clock.local_now() で渡す（ここでは時計を読まない）。

- 店: MO 不可店・臨時休業（store_closures）は常に見る。定休日・営業時間・ラストオーダーは ORDER_HOURS_CHECK=off のとき見ない（開発の便宜）。
- 品: 季節の期間（season_from / season_to。'MM-DD'。年またぎも扱う）は常に見る。販売の時間帯（sold_from / sold_until）は ORDER_HOURS_CHECK=off のとき見ない。
- 境目: ラストオーダーの時刻ちょうど・sold_until ちょうどは「出せる」（秒まで比べ、それを過ぎたら出せない）。閉店の時刻ちょうどは「時間外」。
"""

from datetime import datetime, time

from app.settings import order_hours_check

CLOSED_REASONS = ("closed_today", "temporary_closure", "outside_hours", "past_last_order", "mobile_order_unavailable")
UNAVAILABLE_REASONS = ("out_of_season", "out_of_hours", "sold_out")


def _seconds(t: time) -> int:
    return t.hour * 3600 + t.minute * 60 + t.second


def closed_reason(store: dict, has_closure_today: bool, now_local: datetime) -> str | None:
    """店が今、注文を受けられない理由。受けられるなら None。store は stores の行（dict）。"""
    if not store["mobile_order"]:
        return "mobile_order_unavailable"
    if has_closure_today:
        return "temporary_closure"
    if not order_hours_check():
        return None
    if store["closed_weekday"] is not None and store["closed_weekday"] == now_local.isoweekday():
        return "closed_today"
    now_s = _seconds(now_local.time())
    open_s, close_s = _seconds(store["open_time"]), _seconds(store["close_time"])
    if now_s < open_s or now_s >= close_s:
        return "outside_hours"
    if now_s > close_s - store["last_order_minutes"] * 60:
        return "past_last_order"
    return None


def in_season(month_day: str, season_from: str | None, season_to: str | None) -> bool:
    """month_day・season_from・season_to は 'MM-DD'（文字列の順が日付の順）。from > to は年またぎ（例 12-20〜01-05）。両端を含む。"""
    if season_from is None or season_to is None:
        return True
    if season_from <= season_to:
        return season_from <= month_day <= season_to
    return month_day >= season_from or month_day <= season_to


def item_unavailable_reason(item: dict, now_local: datetime) -> str | None:
    """季節・時間帯で出せない理由（在庫は見ない）。item は menu_items の行（dict）。"""
    if not item["is_active"]:
        return "out_of_season"  # 契約の理由は 3 つだけ。取り下げた品は、期間外と同じ扱いにする
    if not in_season(now_local.strftime("%m-%d"), item["season_from"], item["season_to"]):
        return "out_of_season"
    if order_hours_check():
        now_s = _seconds(now_local.time())
        if item["sold_from"] is not None and now_s < _seconds(item["sold_from"]):
            return "out_of_hours"
        if item["sold_until"] is not None and now_s > _seconds(item["sold_until"]):
            return "out_of_hours"
    return None

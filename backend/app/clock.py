"""時刻の入口。時刻を使う所は、すべてここ（utc_now / local_now）を呼ぶ。テストは freeze() で差し替える。

- 保存・期限の比較は UTC（utc_now）。営業時間・定休日・期間・営業日（business_date）は、店のあるローカル時刻（local_now）。
- ローカル時刻は、環境変数 LOCAL_UTC_OFFSET_HOURS（既定 9。整数）で決める。惑星固有の暦は設定しない（docs/world.md）。
"""

from datetime import datetime, timedelta, timezone

from app.settings import local_utc_offset_hours

_frozen: datetime | None = None


def utc_now() -> datetime:
    return _frozen if _frozen is not None else datetime.now(timezone.utc)


def local_now() -> datetime:
    """店のローカル時刻（タイムゾーンつき）。"""
    return utc_now().astimezone(timezone(timedelta(hours=local_utc_offset_hours())))


def freeze(moment: datetime | None) -> None:
    """テスト用: 時刻を固定する（タイムゾーンつきの日時）。None で戻す。"""
    global _frozen
    if moment is not None and moment.tzinfo is None:
        raise ValueError("タイムゾーンつきの日時を渡してください")
    _frozen = moment.astimezone(timezone.utc) if moment is not None else None


def iso(moment: datetime) -> str:
    """API の日時（ISO 8601。UTC・`Z` つき。docs/api.md「共通」）。"""
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

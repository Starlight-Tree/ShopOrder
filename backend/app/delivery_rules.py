"""宅配の、DB に触れない決まり（純粋な関数）。値は docs/world.md「宅配」と docs/order-flow.md「宅配」。数字は「設計の既定」で、実測ではない。

- 時間枠: 30 分。開店から 30 分ごと。最後の枠は、ラストオーダーの時刻に終わるもの（world.md の「ラストオーダーの 30 分前まで受け付ける」の読み替え。新設）。
  1 店 1 枠 4 件。受付の締めは、枠の開始の「準備 15 分 + リードタイム 30 分」前（新設）。
- 送料: 区画ごとの基本料。品の小計が free_over 以上なら 0（ちょうどは無料）。
- 暗証コード: 4 桁。集荷で作り、DB には nonce と HMAC のハッシュだけを持つ（平文は持たない）。サーバーの秘密（settings.delivery_pin_secret）が無いと再現できない。
  顧客に見せるときは、nonce から同じコードを導く。5 回間違えたら凍結、有効は集荷から 24 時間。
- 配達員の提案: PROPOSERS の関数（差し替えられる）。既定の nearest は、最後にいた区画から店の区画までの所要分が小さい順。
"""

import hashlib
import hmac
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

SLOT_MINUTES = 30
SLOT_CAPACITY = 4  # 1 店 1 枠 4 件（world.md）
SLOT_DAYS_AHEAD = 7  # 枠を出す日数（今日を含めて 8 日分）
PREP_MINUTES = 15  # 調理・梱包（新設）
LEAD_MINUTES = 30  # 配達員の手配と移動の余裕（新設）

PIN_DIGITS = 4
PIN_MAX_ATTEMPTS = 5
PIN_TTL = timedelta(hours=24)

ADDRESS_LIMIT = 10  # 1 人が持てる住所の数

FAILURE_REASONS = ("absent", "cannot_receive", "other")  # 配達員が記録できる理由（自由記述は受けない）
ACTIVE_STATUSES = ("assigned", "picked_up", "delivering")  # 配達員の担当中（deliveries.status）


# ---- 時間枠 ----

def local_tz(offset_hours: int) -> timezone:
    return timezone(timedelta(hours=offset_hours))


def slot_grid(open_time: time, close_time: time, last_order_minutes: int, day: date, offset_hours: int) -> list[tuple[datetime, datetime]]:
    """その日（店のローカルの日付）の枠 [(開始, 終了)]（UTC）。開店から 30 分ごとで、終了がラストオーダーの時刻以内のもの。"""
    tz = local_tz(offset_hours)
    step = timedelta(minutes=SLOT_MINUTES)
    start = datetime.combine(day, open_time, tzinfo=tz)
    last_order = datetime.combine(day, close_time, tzinfo=tz) - timedelta(minutes=last_order_minutes)
    slots = []
    while start + step <= last_order:
        slots.append((start.astimezone(timezone.utc), (start + step).astimezone(timezone.utc)))
        start += step
    return slots


def order_cutoff(starts_at: datetime) -> datetime:
    """この時刻を過ぎたら、その枠は受け付けない（枠の開始の 45 分前）。"""
    return starts_at - timedelta(minutes=PREP_MINUTES + LEAD_MINUTES)


def slot_unavailable_reason(starts_at: datetime, booked: int, capacity: int, now: datetime) -> str | None:
    """枠を選べない理由。締めを過ぎていれば cutoff、満席なら full（締めを先に見る）。選べるなら None。締めの時刻ちょうどは選べる。"""
    if now > order_cutoff(starts_at):
        return "cutoff"
    if booked >= capacity:
        return "full"
    return None


def local_date_of(moment: datetime, offset_hours: int) -> date:
    return moment.astimezone(local_tz(offset_hours)).date()


# ---- 送料・最低注文額 ----

def delivery_fee(fee_lumi: int, free_over_lumi: int | None, subtotal: int) -> int:
    """送料。品の小計が free_over 以上なら 0（2,000 ルミちょうどは無料）。"""
    if free_over_lumi is not None and subtotal >= free_over_lumi:
        return 0
    return fee_lumi


def meets_minimum(subtotal: int, min_order_lumi: int) -> bool:
    return subtotal >= min_order_lumi


# ---- 到着の目安 ----

def eta_at(status: str, slot_starts_at: datetime, departed_at: datetime | None, base_minutes: int) -> datetime | None:
    """到着の目安。出発後（delivering）は「出発 + 基準の所要分」、それ以前は枠の開始。完了・不在・取消しは None。"""
    if status in ("delivered", "failed", "cancelled"):
        return None
    if status == "delivering" and departed_at is not None:
        return departed_at + timedelta(minutes=base_minutes)
    return slot_starts_at


# ---- 暗証コード ----

def _hmac(secret: str, message: str) -> bytes:
    return hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).digest()


def derive_pin(secret: str, delivery_id: int, nonce: str) -> str:
    """nonce から導く 4 桁（0 埋め）。同じ（秘密・配達・nonce）なら、いつも同じ。"""
    n = int.from_bytes(_hmac(secret, f"pin|{delivery_id}|{nonce}")[:4], "big")
    return f"{n % 10**PIN_DIGITS:0{PIN_DIGITS}d}"


def pin_hash(secret: str, delivery_id: int, pin: str) -> str:
    """DB に置くハッシュ（HMAC）。4 桁だけの SHA-256 は総当たりで戻せるので、サーバーの秘密を鍵にする。"""
    return _hmac(secret, f"check|{delivery_id}|{pin}").hex()


def pin_matches(secret: str, delivery_id: int, pin: str, stored_hash: str) -> bool:
    return hmac.compare_digest(pin_hash(secret, delivery_id, pin), stored_hash)


# ---- 配達員の提案（差し替えられる） ----

@dataclass(frozen=True)
class CourierCandidate:
    courier_id: int
    name: str
    zone_id: int | None  # 最後にいた区画（None は店にいる）
    active_count: int  # 担当中の件数
    is_on_duty: bool = True


@dataclass(frozen=True)
class Proposal:
    courier_id: int
    courier_name: str
    minutes: int  # 最後にいた区画から店の区画までの所要分


TravelMinutes = Mapping[tuple[int, int], int]
Proposer = Callable[[Sequence[CourierCandidate], int, TravelMinutes], list[Proposal]]


def travel_minutes(matrix: TravelMinutes, a: int, b: int) -> int:
    """区画 a から b までの分。同じ区画は 0。行が無い組み合わせは、逆向きの行を見る（それも無ければ大きな値で後ろへ回す）。"""
    if a == b:
        return 0
    return matrix.get((a, b), matrix.get((b, a), 10_000))


def nearest(candidates: Sequence[CourierCandidate], store_zone_id: int, matrix: TravelMinutes) -> list[Proposal]:
    """勤務中の配達員を、(店の区画までの所要分, 担当中の件数, ID) の昇順に並べる。先頭が提案。"""
    ranked = []
    for c in candidates:
        if not c.is_on_duty:
            continue
        minutes = 0 if c.zone_id is None else travel_minutes(matrix, c.zone_id, store_zone_id)
        ranked.append((minutes, c.active_count, c.courier_id, c))
    ranked.sort(key=lambda t: t[:3])
    return [Proposal(c.courier_id, c.name, minutes) for minutes, _, _, c in ranked]


PROPOSERS: dict[str, Proposer] = {"nearest": nearest}


def get_proposer(name: str) -> Proposer:
    if name not in PROPOSERS:
        raise RuntimeError(f"ASSIGNMENT_POLICY は {' / '.join(PROPOSERS)} のどれかにしてください")
    return PROPOSERS[name]

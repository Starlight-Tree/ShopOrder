from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from app import limits


def _no_control_chars(value: str) -> str:
    """NUL・制御文字（改行・タブを除く）・単独のサロゲートを拒否する（DB が 500 で落ちる入力を、422 にする。2026-11-21 のレビュー）。"""
    for ch in value:
        code = ord(ch)
        if (code < 32 and ch not in "\n\t") or code == 127 or 0xD800 <= code <= 0xDFFF:
            raise ValueError("使えない文字が含まれています")
    return value


SafeText = Annotated[str, AfterValidator(_no_control_chars)]


class Store(BaseModel):
    id: int
    code: str
    name: str
    area: str
    address: str
    open_time: str  # "07:00"
    close_time: str
    closed_weekday: int | None  # 1 = 月 … 7 = 日
    last_order_minutes: int
    mobile_order: bool
    seats: int
    accepting_orders: bool  # 今、注文を受けられるか（営業時間・定休日・ラストオーダー・臨時休業・MO 不可店）
    closed_reason: str | None  # closed_today / temporary_closure / outside_hours / past_last_order / mobile_order_unavailable


class Variant(BaseModel):
    id: int
    size: str
    temperature: str
    price_lumi: int
    available: bool  # 今出せるか（季節・時間帯。store_id を渡したときは在庫も）
    unavailable_reason: str | None  # out_of_season / out_of_hours / sold_out


class MenuItem(BaseModel):
    id: int
    code: str
    name: str
    category: str
    description: str
    allergens: list[str]
    season_from: str | None
    season_to: str | None
    sold_from: str | None
    sold_until: str | None
    variants: list[Variant]


# ---- カート・注文・スタッフ（docs/api.md。応答の形） ----

class StoreRef(BaseModel):
    id: int
    name: str


class CartLine(BaseModel):
    variant_id: int
    item_code: str
    name: str
    size: str
    temperature: str
    unit_price_lumi: int
    qty: int
    line_total_lumi: int
    available: bool
    unavailable_reason: str | None


class Cart(BaseModel):
    version: int
    store: StoreRef | None
    fulfillment: str
    lines: list[CartLine]
    subtotal_lumi: int
    delivery_fee_lumi: int
    total_lumi: int
    delivery: "CartDelivery | None" = None  # 宅配（P2）。店頭受け取りは null


class CheckoutProposal(BaseModel):
    id: str
    cart_version: int
    total_lumi: int
    expires_at: str
    store: StoreRef
    lines: list[CartLine]
    pickup_note: str | None  # 宅配（P2）では null
    fulfillment: str = "pickup"
    subtotal_lumi: int = 0
    delivery_fee_lumi: int = 0
    delivery: "CartDelivery | None" = None


class OrderItem(BaseModel):
    name: str
    size: str
    temperature: str
    unit_price_lumi: int
    qty: int
    line_total_lumi: int


class OrderEvent(BaseModel):
    to_status: str
    at: str
    actor_type: str
    reason: str | None


class PaymentInfo(BaseModel):
    provider: str
    status: str


class Order(BaseModel):
    public_id: str
    pickup_no: int
    status: str
    fulfillment: str
    store: StoreRef
    items: list[OrderItem]
    subtotal_lumi: int
    delivery_fee_lumi: int
    total_lumi: int
    placed_at: str
    reservation_expires_at: str | None
    payment: PaymentInfo | None
    events: list[OrderEvent]
    cancel_reason: str | None
    can_pay: bool
    can_cancel: bool
    delivery: "OrderDelivery | None" = None  # 宅配（P2）。店頭受け取りは null


class OrderSummary(BaseModel):
    public_id: str
    pickup_no: int
    status: str
    fulfillment: str = "pickup"
    store: StoreRef
    total_lumi: int
    placed_at: str


class StaffOrder(BaseModel):
    public_id: str
    pickup_no: int
    status: str
    fulfillment: str
    store: StoreRef
    items: list[OrderItem]
    subtotal_lumi: int
    delivery_fee_lumi: int
    total_lumi: int
    placed_at: str
    reservation_expires_at: str | None
    events: list[OrderEvent]
    cancel_reason: str | None
    can_pay: bool
    can_cancel: bool
    allowed_actions: list[str]
    delivery: "StaffOrderDelivery | None" = None  # 宅配（P2）。店頭受け取りは null


class Staff(BaseModel):
    id: int
    name: str
    role: str
    store_id: int | None


class LoginResult(BaseModel):
    token: str
    expires_at: str
    staff: Staff


class StockRow(BaseModel):
    item_id: int
    code: str
    name: str
    kind: str
    unit: str
    on_hand: int
    reserved: int
    available: int
    reorder_point: int
    low: bool


# ---- 入力 ----

class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CartUpdate(_Body):
    store_id: int | None = Field(ge=1)
    fulfillment: Literal["pickup", "delivery"] = "pickup"
    address_id: int | None = Field(default=None, ge=1)  # 宅配（P2）。全部を置き換える（省略は null）
    slot_id: int | None = Field(default=None, ge=1)


class CartItemUpdate(_Body):
    qty: int = Field(ge=0, le=limits.MAX_QTY)


class PlaceOrderBody(_Body):
    proposal_id: UUID


class PayBody(_Body):
    simulate: Literal["ok", "decline"] = "ok"


class LoginBody(_Body):
    email: SafeText = Field(min_length=3, max_length=254)
    password: SafeText = Field(min_length=1, max_length=200)


class TransitionBody(_Body):
    action: Literal["accept", "start", "ready", "complete", "cancel"]
    reason: SafeText | None = Field(default=None, max_length=limits.REASON_MAX)


class StockReceiveBody(_Body):
    qty: int = Field(ge=1, le=1_000_000)
    reason: SafeText | None = Field(default=None, max_length=limits.REASON_MAX)


class StockWasteBody(_Body):
    qty: int = Field(ge=1, le=1_000_000)
    reason: SafeText = Field(min_length=1, max_length=limits.REASON_MAX)


class StockAdjustBody(_Body):
    delta: int = Field(ge=-1_000_000, le=1_000_000)
    reason: SafeText = Field(min_length=1, max_length=limits.REASON_MAX)


# ---- 宅配（P2。docs/api.md「宅配（P2）」。応答の形と入力） ----

class SlotRef(BaseModel):
    id: int
    starts_at: str
    ends_at: str


class ZoneRef(BaseModel):
    id: int
    name: str


class Zone(BaseModel):
    id: int
    name: str
    area_code: int
    fee_lumi: int
    free_over_lumi: int | None
    min_order_lumi: int
    base_minutes: int
    is_suspended: bool


class AddressBrief(BaseModel):
    id: int
    label: str
    area_code: int
    area_name: str


class Address(AddressBrief):
    zone_id: int | None
    line: str  # 🔒 ログに出さない
    note: str | None  # 🔒
    created_at: str


class CartDelivery(BaseModel):
    address: AddressBrief | None
    zone: Zone | None
    slot: SlotRef | None
    fee_lumi: int
    free_over_lumi: int | None
    min_order_lumi: int | None
    issues: list[str]


class CourierName(BaseModel):
    name: str


class CourierRef(BaseModel):
    id: int
    name: str


class AddressLabel(BaseModel):
    label: str


class OrderDelivery(BaseModel):
    status: str
    zone: ZoneRef
    slot: SlotRef
    courier: CourierName | None
    pin: str | None  # 集荷後だけ（顧客本人の注文にだけ）
    eta_at: str | None
    address: AddressLabel
    attempt: int
    failure_reason: str | None


class StaffOrderDelivery(BaseModel):
    status: str
    zone: ZoneRef
    slot: SlotRef
    courier: CourierRef | None
    attempt: int
    failure_reason: str | None


class Slot(SlotRef):
    capacity: int
    booked: int
    remaining: int
    available: bool
    unavailable_reason: str | None


class SlotList(BaseModel):
    store_id: int
    date: str
    zone_id: int | None
    reason: str | None
    slots: list[Slot]


class Courier(BaseModel):
    id: int
    store_id: int
    name: str
    vehicle: str
    is_on_duty: bool
    active_count: int
    zone: ZoneRef | None


class Suggestion(BaseModel):
    courier_id: int
    courier_name: str
    minutes: int


class DispatchOrder(StaffOrder):
    suggestion: Suggestion | None = None


class DispatchBoard(BaseModel):
    provider: str
    couriers: list[Courier]
    orders: list[DispatchOrder]


class CourierItem(BaseModel):
    name: str
    size: str
    temperature: str
    qty: int


class CourierAddress(BaseModel):
    label: str
    line: str  # 🔒 集荷後の担当の配達員だけ
    note: str | None  # 🔒


class CourierDelivery(BaseModel):
    public_id: str
    pickup_no: int
    status: str
    store: StoreRef
    zone: ZoneRef
    slot: SlotRef
    items: list[CourierItem]
    address: CourierAddress | None
    attempt: int
    pin_attempts_left: int | None
    eta_at: str | None
    allowed_actions: list[str]


class AddressBody(_Body):
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20), AfterValidator(_no_control_chars)]
    area_code: int = Field(ge=1, le=99)
    line: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100), AfterValidator(_no_control_chars)]
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100), AfterValidator(_no_control_chars)] | None = None


class AssignBody(_Body):
    courier_id: int = Field(ge=1)


class RedeliverBody(_Body):
    slot_id: int | None = Field(default=None, ge=1)


class DeliverBody(_Body):
    pin: str = Field(pattern=r"^[0-9]{4}$")


class FailBody(_Body):
    reason: Literal["absent", "cannot_receive", "other"]


class SuspensionBody(_Body):
    suspended: bool


for _model in (Cart, CheckoutProposal, Order, StaffOrder):
    _model.model_rebuild()

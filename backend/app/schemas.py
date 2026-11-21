from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app import limits


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


class CheckoutProposal(BaseModel):
    id: str
    cart_version: int
    total_lumi: int
    expires_at: str
    store: StoreRef
    lines: list[CartLine]
    pickup_note: str


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


class OrderSummary(BaseModel):
    public_id: str
    pickup_no: int
    status: str
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


class CartItemUpdate(_Body):
    qty: int = Field(ge=0, le=limits.MAX_QTY)


class PlaceOrderBody(_Body):
    proposal_id: UUID


class PayBody(_Body):
    simulate: Literal["ok", "decline"] = "ok"


class LoginBody(_Body):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)


class TransitionBody(_Body):
    action: Literal["accept", "start", "ready", "complete", "cancel"]
    reason: str | None = Field(default=None, max_length=limits.REASON_MAX)


class StockReceiveBody(_Body):
    qty: int = Field(ge=1, le=1_000_000)
    reason: str | None = Field(default=None, max_length=limits.REASON_MAX)


class StockWasteBody(_Body):
    qty: int = Field(ge=1, le=1_000_000)
    reason: str = Field(min_length=1, max_length=limits.REASON_MAX)


class StockAdjustBody(_Body):
    delta: int = Field(ge=-1_000_000, le=1_000_000)
    reason: str = Field(min_length=1, max_length=limits.REASON_MAX)

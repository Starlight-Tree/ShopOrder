from typing import Annotated

from fastapi import APIRouter, Header, Path, Response

from app import limits, orders
from app.auth import CustomerDep
from app.schemas import Order, OrderSummary, PayBody, PlaceOrderBody

router = APIRouter(prefix="/api/orders", tags=["orders"])

PublicId = Annotated[str, Path(min_length=1, max_length=16)]
# Idempotency-Key: 8〜64 文字の、空白を含まない ASCII（UUID などを想定）
IdempotencyKey = Annotated[
    str, Header(min_length=limits.IDEMPOTENCY_KEY_MIN, max_length=limits.IDEMPOTENCY_KEY_MAX, pattern=r"^[\x21-\x7e]+$")
]


@router.post("", response_model=Order, status_code=201)
def create_order(body: PlaceOrderBody, response: Response, customer: CustomerDep, idempotency_key: IdempotencyKey) -> dict:
    """確定。確定の API を呼べるのは画面の確定ボタンだけ（チャットには渡さない。docs/decisions/0003）。同じキー・同じ本文の再送は 200 で同じ注文。"""
    order, created = orders.place_order(customer.id, idempotency_key, body.proposal_id)
    if not created:
        response.status_code = 200
    return order


@router.get("", response_model=list[OrderSummary])
def list_orders(customer: CustomerDep) -> list[dict]:
    return orders.list_for_customer(customer.id)


@router.get("/{public_id}", response_model=Order)
def get_order(public_id: PublicId, customer: CustomerDep) -> dict:
    return orders.get_for_customer(customer.id, public_id)


@router.post("/{public_id}/pay", response_model=Order)
def pay_order(public_id: PublicId, customer: CustomerDep, body: PayBody | None = None) -> dict:
    return orders.pay(customer.id, public_id, (body or PayBody()).simulate)


@router.post("/{public_id}/cancel", response_model=Order)
def cancel_order(public_id: PublicId, customer: CustomerDep) -> dict:
    return orders.cancel_by_customer(customer.id, public_id)

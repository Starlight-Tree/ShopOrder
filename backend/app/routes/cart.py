from fastapi import APIRouter, Path

from app import cart, clock
from app.auth import CustomerDep
from app.db import connection
from app.schemas import Cart, CartItemUpdate, CartUpdate, CheckoutProposal

router = APIRouter(prefix="/api/cart", tags=["cart"])


@router.get("", response_model=Cart)
def get_cart(customer: CustomerDep) -> dict:
    with connection() as conn:
        return cart.read(conn, customer.id, clock.utc_now(), clock.local_now())


@router.put("", response_model=Cart)
def put_cart(body: CartUpdate, customer: CustomerDep) -> dict:
    with connection() as conn:
        return cart.set_store(conn, customer.id, body.store_id, body.fulfillment, clock.utc_now(), clock.local_now())


@router.put("/items/{variant_id}", response_model=Cart)
def put_item(body: CartItemUpdate, customer: CustomerDep, variant_id: int = Path(ge=1)) -> dict:
    with connection() as conn:
        return cart.set_item(conn, customer.id, variant_id, body.qty, clock.utc_now(), clock.local_now())


@router.delete("", response_model=Cart)
def delete_cart(customer: CustomerDep) -> dict:
    with connection() as conn:
        return cart.clear(conn, customer.id, clock.utc_now(), clock.local_now())


@router.post("/checkout-proposal", response_model=CheckoutProposal)
def checkout_proposal(customer: CustomerDep) -> dict:
    with connection() as conn:
        return cart.create_proposal(conn, customer.id, clock.utc_now(), clock.local_now())

from typing import Annotated

from fastapi import APIRouter, Header, Path, Query, Response

from app import auth, clock, inventory, orders, stores
from app.auth import OrderStaffDep, StaffDep, StaffUser
from app.db import connection
from app.errors import ApiError
from app.schemas import (
    LoginBody, LoginResult, Staff, StaffOrder, StockAdjustBody, StockReceiveBody, StockRow, StockWasteBody, TransitionBody,
)

router = APIRouter(prefix="/api/staff", tags=["staff"])

DEFAULT_STATUSES = ["paid", "accepted", "preparing", "ready"]
PublicId = Annotated[str, Path(min_length=1, max_length=16)]


def resolve_store(staff: StaffUser, store_id: int | None, *, required: bool = False) -> int | None:
    """スタッフの見られる店を決める。店つきのスタッフ（店長も）は自店だけ（他店を指すと 404）。店が決まっていない店長は、store_id で選ぶ。"""
    if staff.store_id is not None:
        if store_id is not None and store_id != staff.store_id:
            raise ApiError(404, "not_found")
        return staff.store_id
    if store_id is None and required:
        raise ApiError(422, "store_required")
    return store_id


def _require_store(conn, store_id: int) -> None:
    if stores.load(conn, store_id) is None:
        raise ApiError(404, "store_not_found")


@router.post("/login", response_model=LoginResult)
def login(body: LoginBody) -> dict:
    result = auth.login(body.email, body.password)
    return {"token": result["token"], "expires_at": clock.iso(result["expires_at"]), "staff": result["staff"].public()}


@router.post("/logout", status_code=204)
def logout(staff: StaffDep, authorization: Annotated[str | None, Header()] = None) -> Response:
    token = auth.bearer_token(authorization)
    if token:
        auth.logout(token)
    return Response(status_code=204)


@router.get("/me", response_model=Staff)
def me(staff: StaffDep) -> dict:
    return staff.public()


@router.get("/orders", response_model=list[StaffOrder])
def staff_orders(staff: OrderStaffDep, status: str | None = Query(default=None, max_length=200), store_id: int | None = Query(default=None, ge=1)) -> list[dict]:
    statuses = DEFAULT_STATUSES if not status else [s.strip() for s in status.split(",") if s.strip()]
    if not statuses or any(s not in orders.STAFF_VISIBLE_STATUSES for s in statuses):
        raise ApiError(422, "invalid_status")
    return orders.list_for_staff(resolve_store(staff, store_id), statuses)


@router.post("/orders/{public_id}/transition", response_model=StaffOrder)
def transition(public_id: PublicId, body: TransitionBody, staff: OrderStaffDep) -> dict:
    return orders.staff_transition(staff.id, staff.store_id, public_id, body.action, body.reason)


# ---- 在庫（店長で店が決まっていないときは、?store_id= で選ぶ。入荷・廃棄・棚卸しも同じ） ----

@router.get("/stock", response_model=list[StockRow])
def stock(staff: OrderStaffDep, store_id: int | None = Query(default=None, ge=1)) -> list[dict]:
    sid = resolve_store(staff, store_id, required=True)
    orders.expire_stale()
    with connection() as conn:
        _require_store(conn, sid)
        return inventory.list_stock(conn, sid)


def _stock_change(staff: StaffUser, store_id: int | None, item_id: int, apply) -> dict:
    sid = resolve_store(staff, store_id, required=True)
    now = clock.utc_now()
    with connection() as conn:
        _require_store(conn, sid)
        if not inventory.item_exists(conn, item_id):
            raise ApiError(404, "not_found")
        try:
            apply(conn, sid, now, f"staff:{staff.id}")
        except inventory.InsufficientStock:
            raise ApiError(409, "insufficient_stock") from None
        return inventory.stock_row(conn, sid, item_id)


@router.post("/stock/{item_id}/receive", response_model=StockRow)
def receive(body: StockReceiveBody, staff: OrderStaffDep, item_id: int = Path(ge=1), store_id: int | None = Query(default=None, ge=1)) -> dict:
    return _stock_change(staff, store_id, item_id, lambda c, s, now, actor: inventory.receive(c, s, item_id, body.qty, reason=body.reason, actor=actor, now=now))


@router.post("/stock/{item_id}/waste", response_model=StockRow)
def waste(body: StockWasteBody, staff: OrderStaffDep, item_id: int = Path(ge=1), store_id: int | None = Query(default=None, ge=1)) -> dict:
    reason = _reason(body.reason)
    return _stock_change(staff, store_id, item_id, lambda c, s, now, actor: inventory.waste(c, s, item_id, body.qty, reason=reason, actor=actor, now=now))


@router.post("/stock/{item_id}/adjust", response_model=StockRow)
def adjust(body: StockAdjustBody, staff: OrderStaffDep, item_id: int = Path(ge=1), store_id: int | None = Query(default=None, ge=1)) -> dict:
    if body.delta == 0:
        raise ApiError(422, "invalid_delta")  # 0 の調整は台帳に残さない
    reason = _reason(body.reason)
    return _stock_change(staff, store_id, item_id, lambda c, s, now, actor: inventory.adjust(c, s, item_id, body.delta, reason=reason, actor=actor, now=now))


def _reason(text: str) -> str:
    reason = text.strip()
    if not reason:
        raise ApiError(422, "reason_required")
    return reason

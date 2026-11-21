"""宅配のルート（住所・区画・時間枠・配車・配達員）。契約は docs/api.md「宅配（P2）」。書き込みの API は、画面のサーバー側から呼ぶ（CORS は GET だけ）。
住所（line・note）は個人情報。ログに出さない（このファイルは、本文を一切ログに出さない）。"""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Path, Query, Response

from app import clock, delivery, dispatch, orders, stores
from app.auth import CourierDep, CustomerDep, ManagerDep, OrderStaffDep
from app.db import connection
from app.errors import ApiError
from app.routes.staff import PublicId, resolve_store
from app.schemas import (
    Address, AddressBody, AssignBody, Courier, CourierDelivery, DeliverBody, DispatchBoard, FailBody, RedeliverBody, SlotList, StaffOrder,
    SuspensionBody, Zone,
)

DEFAULT_DISPATCH_STATUSES = ["ready", "assigned", "picked_up", "delivering", "delivery_failed"]

# ---- 顧客: 住所 ----
addresses = APIRouter(prefix="/api/addresses", tags=["delivery"])


@addresses.get("", response_model=list[Address])
def list_addresses(customer: CustomerDep) -> list[dict]:
    with connection() as conn:
        return delivery.list_addresses(conn, customer.id)


@addresses.post("", response_model=Address, status_code=201)
def create_address(body: AddressBody, customer: CustomerDep) -> dict:
    with connection() as conn:
        return delivery.create_address(conn, customer.id, body.label, body.area_code, body.line, body.note or None, clock.utc_now())


@addresses.delete("/{address_id}", status_code=204)
def delete_address(customer: CustomerDep, address_id: int = Path(ge=1)) -> Response:
    with connection() as conn:
        delivery.delete_address(conn, customer.id, address_id, clock.utc_now())
    return Response(status_code=204)


# ---- 区画・時間枠（認証なし） ----
public = APIRouter(tags=["delivery"])


@public.get("/api/delivery/zones", response_model=list[Zone])
def zones(store_id: int | None = Query(default=None, ge=1)) -> list[dict]:
    with connection() as conn:
        if store_id is not None and stores.load(conn, store_id) is None:
            raise ApiError(404, "store_not_found")
        return delivery.list_zones(conn, store_id)


@public.get("/api/stores/{store_id}/slots", response_model=SlotList)
def slots(day: Annotated[date, Query(alias="date")], store_id: int = Path(ge=1), zone_id: int | None = Query(default=None, ge=1)) -> dict:
    now = clock.utc_now()
    with connection() as conn:
        store = stores.load(conn, store_id)
        if store is None:
            raise ApiError(404, "store_not_found")
        return delivery.list_slots(conn, store, day, zone_id, now)


# ---- スタッフ・店長: 配車 ----
staff_router = APIRouter(prefix="/api/staff", tags=["dispatch"])


@staff_router.get("/couriers", response_model=list[Courier])
def couriers(staff: OrderStaffDep, store_id: int | None = Query(default=None, ge=1)) -> list[dict]:
    return dispatch.list_couriers(resolve_store(staff, store_id))


@staff_router.get("/deliveries", response_model=DispatchBoard)
def deliveries(staff: OrderStaffDep, status: str | None = Query(default=None, max_length=200), store_id: int | None = Query(default=None, ge=1)) -> dict:
    statuses = DEFAULT_DISPATCH_STATUSES if not status else [s.strip() for s in status.split(",") if s.strip()]
    if not statuses or any(s not in orders.ALL_STATUSES for s in statuses):
        raise ApiError(422, "invalid_status")
    return dispatch.board(staff, resolve_store(staff, store_id), statuses)


@staff_router.post("/orders/{public_id}/assign", response_model=StaffOrder)
def assign(public_id: PublicId, body: AssignBody, staff: OrderStaffDep) -> dict:
    return dispatch.assign(staff, public_id, body.courier_id)


@staff_router.post("/orders/{public_id}/redeliver", response_model=StaffOrder)
def redeliver(public_id: PublicId, staff: OrderStaffDep, body: RedeliverBody | None = None) -> dict:
    return dispatch.redeliver(staff, public_id, (body or RedeliverBody()).slot_id)


@staff_router.post("/orders/{public_id}/mock-advance", response_model=StaffOrder)
def mock_advance(public_id: PublicId, staff: OrderStaffDep) -> dict:
    return dispatch.mock_advance(staff, public_id)


@staff_router.put("/zones/{zone_id}/suspension", response_model=Zone)
def suspension(body: SuspensionBody, _manager: ManagerDep, zone_id: int = Path(ge=1)) -> dict:
    """砂嵐の警報を立てる・解除する（店長だけ）。"""
    with connection() as conn:
        return delivery.set_suspension(conn, zone_id, body.suspended, clock.utc_now())


# ---- 配達員 ----
courier_router = APIRouter(prefix="/api/courier", tags=["courier"])


@courier_router.get("/deliveries", response_model=list[CourierDelivery])
def my_deliveries(courier: CourierDep) -> list[dict]:
    return dispatch.courier_deliveries(courier)


@courier_router.post("/deliveries/{public_id}/pickup", response_model=CourierDelivery)
def pickup(public_id: PublicId, courier: CourierDep) -> dict:
    return dispatch.courier_action(courier, public_id, "pickup")


@courier_router.post("/deliveries/{public_id}/depart", response_model=CourierDelivery)
def depart(public_id: PublicId, courier: CourierDep) -> dict:
    return dispatch.courier_action(courier, public_id, "depart")


@courier_router.post("/deliveries/{public_id}/deliver", response_model=CourierDelivery)
def deliver(public_id: PublicId, body: DeliverBody, courier: CourierDep) -> dict:
    return dispatch.courier_action(courier, public_id, "deliver", pin=body.pin)


@courier_router.post("/deliveries/{public_id}/fail", response_model=CourierDelivery)
def fail(public_id: PublicId, body: FailBody, courier: CourierDep) -> dict:
    return dispatch.courier_action(courier, public_id, "fail", reason=body.reason)


routers = [addresses, public, staff_router, courier_router]

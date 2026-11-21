"""分析（P4）の API。店長は全店（?store_id= で 1 店に絞れる）、店舗スタッフは自店の売上・在庫だけ。顧客・配達員は使えない（顧客は 401、配達員は 403）。
顧客の分析（RFM・コホート）は、全店の店長だけ（店舗スタッフと、店に属する店長は 403）。応答は、analytics の集計表を読むだけの薄い層（app/analytics_queries.py）。"""

from typing import Annotated, Literal

from fastapi import APIRouter, Query

from app import analytics_queries as q
from app import analytics_schemas as s
from app import clock, stores
from app.auth import OrderStaffDep, StaffUser
from app.db import connection
from app.errors import ApiError
from app.routes.staff import resolve_store

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

StoreId = Annotated[int | None, Query(ge=1)]
Days = Annotated[int, Query(ge=7, le=90)]
COUNT_DEFAULT = {"day": 28, "week": 12, "month": 3}
COUNT_MAX = {"day": 90, "week": 26, "month": 12}


def _scope(conn, staff: StaffUser, store_id: int | None) -> int | None:
    """見られる店を決める。店つきのアカウントは自店だけ（他店は 404）。店の無い店長は、store_id で絞れる（無ければ全店）。"""
    sid = resolve_store(staff, store_id)
    if sid is not None and stores.load(conn, sid) is None:
        raise ApiError(404, "store_not_found")
    return sid


def _today():
    return clock.local_now().date()


@router.get("/overview", response_model=s.Overview)
def overview(staff: OrderStaffDep, store_id: StoreId = None) -> dict:
    with connection() as conn:
        sid = _scope(conn, staff, store_id)
        return {"scope": q.scope_info(conn, sid), **q.overview(conn, store_id=sid, today=_today())}


@router.get("/sales", response_model=s.SalesSeries)
def sales(staff: OrderStaffDep, grain: Literal["day", "week", "month"] = "day", count: Annotated[int | None, Query(ge=1, le=90)] = None, store_id: StoreId = None) -> dict:
    n = min(count or COUNT_DEFAULT[grain], COUNT_MAX[grain])
    with connection() as conn:
        sid = _scope(conn, staff, store_id)
        data = q.sales_series(conn, store_id=sid, today=_today(), grain=grain, count=n)
        return {"scope": q.scope_info(conn, sid), **data}


@router.get("/products", response_model=s.Products)
def products(staff: OrderStaffDep, days: Days = 28, store_id: StoreId = None) -> dict:
    with connection() as conn:
        sid = _scope(conn, staff, store_id)
        return {"scope": q.scope_info(conn, sid), **q.products(conn, store_id=sid, today=_today(), days=days)}


@router.get("/hourly", response_model=s.Hourly)
def hourly(staff: OrderStaffDep, days: Days = 28, store_id: StoreId = None) -> dict:
    with connection() as conn:
        sid = _scope(conn, staff, store_id)
        return {"scope": q.scope_info(conn, sid), **q.hourly(conn, store_id=sid, today=_today(), days=days)}


@router.get("/stock", response_model=s.Stock)
def stock(staff: OrderStaffDep, store_id: StoreId = None) -> dict:
    with connection() as conn:
        sid = _scope(conn, staff, store_id)
        return {"scope": q.scope_info(conn, sid), **q.stock(conn, store_id=sid, today=_today())}


@router.get("/customers", response_model=s.Customers)
def customers(staff: OrderStaffDep) -> dict:
    if staff.role != "manager" or staff.store_id is not None:
        raise ApiError(403, "forbidden")  # 顧客の分析は、全店の店長だけ（顧客全体の集計で、店に分けられない）
    with connection() as conn:
        return q.customers(conn, today=_today())

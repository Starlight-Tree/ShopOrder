import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import auth, clock, inventory, rules
from app import stores as store_queries
from app.db import close_pool, connection, open_pool
from app.errors import MESSAGES, ApiError
from app.routes import cart as cart_routes
from app.routes import orders as order_routes
from app.routes import staff as staff_routes
from app.schemas import MenuItem, Store
from app.settings import cors_origins

log = logging.getLogger("oasis.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    auth.check_startup()  # 本番相当の環境で、開発専用の設定が残っていたら、ここで起動を拒否する
    open_pool()
    yield
    close_pool()


app = FastAPI(title="Oasis Order API", lifespan=lifespan)
# CORS は GET のまま。書き込みの API は、画面のサーバー側（Next.js）から呼ぶ（ブラウザーは API を直接呼ばない）
app.add_middleware(CORSMiddleware, allow_origins=cors_origins(), allow_methods=["GET"], allow_headers=["*"])
app.include_router(cart_routes.router)
app.include_router(order_routes.router)
app.include_router(staff_routes.router)


@app.exception_handler(Exception)
async def unexpected_error(_: Request, exc: Exception) -> JSONResponse:
    """予期しない失敗。本文は固定の文（例外の文字列・パス・SQL を含めない。ログにも種類だけ）。"""
    log.error("予期しないエラー（%s）", type(exc).__name__)
    return JSONResponse(status_code=500, content={"detail": {"code": "internal_error", "message": MESSAGES["internal_error"]}})


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _hhmm(value) -> str | None:
    return None if value is None else value.strftime("%H:%M")


@app.get("/api/stores", response_model=list[Store])
def stores() -> list[Store]:
    now_local = clock.local_now()
    with connection() as conn:
        rows = conn.execute(
            "SELECT s.id, s.code, s.name, a.name AS area, s.address, s.open_time, s.close_time, s.closed_weekday, "
            "s.last_order_minutes, s.mobile_order, s.seats FROM stores s JOIN areas a ON a.code = s.area_code "
            "ORDER BY a.sort, s.id"
        ).fetchall()
        closures = store_queries.closed_store_ids(conn, now_local)
    result = []
    for r in rows:
        reason = rules.closed_reason(r, r["id"] in closures, now_local)
        result.append(Store(**{**r, "open_time": _hhmm(r["open_time"]), "close_time": _hhmm(r["close_time"]), "accepting_orders": reason is None, "closed_reason": reason}))
    return result


@app.get("/api/menu", response_model=list[MenuItem])
def menu(store_id: int | None = Query(default=None, ge=1)) -> list[MenuItem]:
    """有効な品を、並び順に。各変種に「今出せるか」を付ける（季節・時間帯。store_id があれば、その店の在庫も。無ければ在庫は見ない）。"""
    now_local = clock.local_now()
    with connection() as conn:
        items = conn.execute(
            "SELECT id, code, name, category, description, allergens, season_from, season_to, sold_from, sold_until, is_active "
            "FROM menu_items WHERE is_active ORDER BY sort, id"
        ).fetchall()
        variants = conn.execute(
            "SELECT v.id, v.item_id, v.size, v.temperature, v.price_lumi FROM menu_variants v "
            "JOIN menu_items i ON i.id = v.item_id WHERE i.is_active ORDER BY v.item_id, v.price_lumi, v.id"
        ).fetchall()
        stock = None
        if store_id is not None:
            if store_queries.load(conn, store_id) is None:
                raise ApiError(404, "store_not_found")
            stock = inventory.variant_stock(conn, store_id, [v["id"] for v in variants])
    reasons = {i["id"]: rules.item_unavailable_reason(i, now_local) for i in items}
    by_item: dict[int, list[dict]] = {}
    for v in variants:
        reason = reasons[v["item_id"]]
        if reason is None and stock is not None and inventory.is_sold_out(stock.get(v["id"], []), 1):
            reason = "sold_out"
        by_item.setdefault(v["item_id"], []).append(
            {"id": v["id"], "size": v["size"], "temperature": v["temperature"], "price_lumi": v["price_lumi"], "available": reason is None, "unavailable_reason": reason}
        )
    return [
        MenuItem(**{**{k: v for k, v in i.items() if k != "is_active"}, "sold_from": _hhmm(i["sold_from"]), "sold_until": _hhmm(i["sold_until"]), "variants": by_item.get(i["id"], [])})
        for i in items
    ]

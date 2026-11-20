from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import close_pool, connection, open_pool
from app.schemas import MenuItem, Store
from app.settings import cors_origins


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    yield
    close_pool()


app = FastAPI(title="Oasis Order API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=cors_origins(), allow_methods=["GET"], allow_headers=["*"])


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _hhmm(value) -> str | None:
    return None if value is None else value.strftime("%H:%M")


@app.get("/api/stores", response_model=list[Store])
def stores() -> list[Store]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT s.id, s.code, s.name, a.name AS area, s.address, s.open_time, s.close_time, s.closed_weekday, "
            "s.last_order_minutes, s.mobile_order, s.seats FROM stores s JOIN areas a ON a.code = s.area_code "
            "ORDER BY a.sort, s.id"
        ).fetchall()
    return [Store(**{**r, "open_time": _hhmm(r["open_time"]), "close_time": _hhmm(r["close_time"])}) for r in rows]


@app.get("/api/menu", response_model=list[MenuItem])
def menu() -> list[MenuItem]:
    """有効な品を、並び順に。期間・時間帯は、品ごとの値をそのまま返す（今出せるかの判断は、注文の段階で行う）。"""
    with connection() as conn:
        items = conn.execute(
            "SELECT id, code, name, category, description, allergens, season_from, season_to, sold_from, sold_until "
            "FROM menu_items WHERE is_active ORDER BY sort, id"
        ).fetchall()
        variants = conn.execute(
            "SELECT v.id, v.item_id, v.size, v.temperature, v.price_lumi FROM menu_variants v "
            "JOIN menu_items i ON i.id = v.item_id WHERE i.is_active ORDER BY v.item_id, v.price_lumi, v.id"
        ).fetchall()
    by_item: dict[int, list[dict]] = {}
    for v in variants:
        by_item.setdefault(v["item_id"], []).append({"id": v["id"], "size": v["size"], "temperature": v["temperature"], "price_lumi": v["price_lumi"]})
    return [
        MenuItem(**{**i, "sold_from": _hhmm(i["sold_from"]), "sold_until": _hhmm(i["sold_until"]), "variants": by_item.get(i["id"], [])})
        for i in items
    ]

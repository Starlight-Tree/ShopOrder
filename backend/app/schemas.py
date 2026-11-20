from pydantic import BaseModel


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


class Variant(BaseModel):
    id: int
    size: str
    temperature: str
    price_lumi: int


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

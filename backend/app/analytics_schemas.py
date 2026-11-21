"""分析 API（/api/analytics）の応答の形。docs/api.md「分析（P4）」。金額はルミの整数。日付は ISO 8601 の日付（営業日）。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Scope(BaseModel):
    all_stores: bool
    store_id: int | None
    store_name: str | None


class Yesterday(BaseModel):
    business_date: str
    state: Literal["open", "closed", "not_built", "partial"]
    sales_lumi: int | None
    orders: int | None
    avg_ticket_lumi: int | None


class Overview(BaseModel):
    scope: Scope
    business_date: str
    sales_lumi: int
    orders: int
    avg_ticket_lumi: int | None
    in_progress: int
    open_stores: int
    store_count: int
    closed_reason: str | None
    yesterday: Yesterday


class SalesPoint(BaseModel):
    start: str
    sales_lumi: int | None  # 休業・未集計は null。営業したが売上 0 は 0
    orders: int | None
    open_days: int
    state: Literal["open", "closed", "not_built", "partial"]


class SalesTotal(BaseModel):
    sales_lumi: int
    orders: int
    open_days: int
    missing_days: int


class Period(BaseModel):
    from_: str = Field(alias="from")
    to: str

    model_config = ConfigDict(populate_by_name=True)


class Comparison(BaseModel):
    state: Literal["ok", "not_comparable"]
    previous_sales_lumi: int | None = None
    change_pct: float | None = None
    reason: str | None = None
    message: str | None = None


class SalesSeries(BaseModel):
    scope: Scope
    grain: Literal["day", "week", "month"]
    from_: str = Field(alias="from")
    to: str
    points: list[SalesPoint]
    total: SalesTotal
    previous: Period
    comparison: Comparison

    model_config = ConfigDict(populate_by_name=True)


class ProductItem(BaseModel):
    item_id: int
    code: str
    name: str
    category: Literal["drink", "food", "beans"]
    qty: int
    sales_lumi: int
    share_pct: float
    cum_share_pct: float
    abc: Literal["A", "B", "C"]


class ProductTotals(BaseModel):
    sales_lumi: int
    qty: int
    cups: int


class Products(BaseModel):
    scope: Scope
    from_: str = Field(alias="from")
    to: str
    days: int
    totals: ProductTotals
    items: list[ProductItem]

    model_config = ConfigDict(populate_by_name=True)


class HourCell(BaseModel):
    weekday: int  # 1 = 月 … 7 = 日
    hour: int
    orders: int
    sales_lumi: int


class WeekdayDays(BaseModel):
    weekday: int
    store_days: int


class Hourly(BaseModel):
    scope: Scope
    from_: str = Field(alias="from")
    to: str
    days: int
    hours: list[int]
    cells: list[HourCell]
    store_days: list[WeekdayDays]
    max_orders: int

    model_config = ConfigDict(populate_by_name=True)


class StockItem(BaseModel):
    item_id: int
    code: str
    name: str
    kind: Literal["material", "sellable"]
    unit: str
    on_hand: int
    reserved: int
    avg_daily_use: float
    days_of_cover: float | None
    gap_to_reorder: int | None
    reorder_point: int
    low_stores: int
    store_count: int
    low: bool


class WasteReasons(BaseModel):
    expired: int
    damaged: int
    quality: int
    other: int


class WasteItem(BaseModel):
    item_id: int
    code: str
    name: str
    unit: str
    total: int
    by_reason: WasteReasons
    waste_rate_pct: float


class Stock(BaseModel):
    scope: Scope
    use_from: str
    use_to: str
    waste_from: str
    waste_to: str
    items: list[StockItem]
    waste: list[WasteItem]


class SegmentCell(BaseModel):
    segment: Literal["loyal", "regular", "light", "at_risk", "dormant"]
    label: str
    customers: int | None  # 5 人未満は null
    suppressed: bool


class GridCell(BaseModel):
    r: int
    f: int
    customers: int | None
    suppressed: bool


class CohortCell(BaseModel):
    offset: int
    customers: int | None
    rate_pct: float | None
    suppressed: bool
    in_progress: bool


class CohortRow(BaseModel):
    cohort: str  # 初回月の初日
    size: int | None
    suppressed: bool
    includes_existing: bool
    cells: list[CohortCell]


class Cohorts(BaseModel):
    rows: list[CohortRow]
    max_offset: int


class Customers(BaseModel):
    as_of: str | None
    min_cell: int
    total_customers: int | None
    segments: list[SegmentCell]
    grid: list[GridCell]
    repurchase_rate_pct: float | None
    avg_orders: float | None
    avg_spend_lumi: int | None
    at_risk_customers: int | None
    cohorts: Cohorts

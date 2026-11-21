// 分析 API（/api/analytics。docs/api.md「分析（P4）」）の応答の形。API の約束が変わったら、ここと docs/api.md を一緒に直す。
// 金額はルミの整数。日付は ISO 8601 の日付（営業日）。顧客は仮名 ID の集計だけで、人数のセルは 5 人未満が null（suppressed）。

export type Scope = { all_stores: boolean; store_id: number | null; store_name: string | null };

/** open = 営業日で集計済み（売上 0 を含む）/ closed = 休業（値は null）/ not_built = 営業日だが未集計 / partial = 一部の店が未集計 */
export type DayState = 'open' | 'closed' | 'not_built' | 'partial';

export type Overview = {
  scope: Scope;
  business_date: string;
  sales_lumi: number;
  orders: number;
  avg_ticket_lumi: number | null;
  in_progress: number;
  open_stores: number;
  store_count: number;
  closed_reason: string | null;
  yesterday: { business_date: string; state: DayState; sales_lumi: number | null; orders: number | null; avg_ticket_lumi: number | null };
};

export type Grain = 'day' | 'week' | 'month';

export type SalesPoint = { start: string; sales_lumi: number | null; orders: number | null; open_days: number; state: DayState };

export type NotComparableReason = 'previous_missing' | 'weekday_mismatch' | 'open_days_mismatch' | 'previous_zero';
export type Comparison =
  | { state: 'ok'; previous_sales_lumi: number | null; change_pct: number | null; reason: null; message: null }
  | { state: 'not_comparable'; previous_sales_lumi: null; change_pct: null; reason: NotComparableReason | string | null; message: string | null };

export type SalesSeries = {
  scope: Scope;
  grain: Grain;
  from: string;
  to: string;
  points: SalesPoint[];
  total: { sales_lumi: number; orders: number; open_days: number; missing_days: number };
  previous: { from: string; to: string };
  comparison: Comparison;
};

export type AbcClass = 'A' | 'B' | 'C';
export type ProductItem = {
  item_id: number;
  code: string;
  name: string;
  category: 'drink' | 'food' | 'beans';
  qty: number;
  sales_lumi: number;
  share_pct: number;
  cum_share_pct: number;
  abc: AbcClass;
};
export type Products = {
  scope: Scope;
  from: string;
  to: string;
  days: number;
  totals: { sales_lumi: number; qty: number; cups: number };
  items: ProductItem[];
};

export type HourCell = { weekday: number; hour: number; orders: number; sales_lumi: number };
export type Hourly = {
  scope: Scope;
  from: string;
  to: string;
  days: number;
  hours: number[];
  cells: HourCell[];
  store_days: { weekday: number; store_days: number }[];
  max_orders: number;
};

export type StockItem = {
  item_id: number;
  code: string;
  name: string;
  kind: 'material' | 'sellable';
  unit: string;
  on_hand: number;
  reserved: number;
  avg_daily_use: number;
  days_of_cover: number | null;
  gap_to_reorder: number | null;
  reorder_point: number;
  low_stores: number;
  store_count: number;
  low: boolean;
};
export type WasteReasons = { expired: number; damaged: number; quality: number; other: number };
export type WasteItem = { item_id: number; code: string; name: string; unit: string; total: number; by_reason: WasteReasons; waste_rate_pct: number };
export type Stock = {
  scope: Scope;
  use_from: string;
  use_to: string;
  waste_from: string;
  waste_to: string;
  items: StockItem[];
  waste: WasteItem[];
};

export type SegmentKey = 'loyal' | 'regular' | 'light' | 'at_risk' | 'dormant';
export type SegmentCell = { segment: SegmentKey; label: string; customers: number | null; suppressed: boolean };
export type GridCell = { r: number; f: number; customers: number | null; suppressed: boolean };
export type CohortCell = { offset: number; customers: number | null; rate_pct: number | null; suppressed: boolean; in_progress: boolean };
export type CohortRow = { cohort: string; size: number | null; suppressed: boolean; includes_existing: boolean; cells: CohortCell[] };
export type Customers = {
  as_of: string | null;
  min_cell: number;
  total_customers: number | null;
  segments: SegmentCell[];
  grid: GridCell[];
  repurchase_rate_pct: number | null;
  avg_orders: number | null;
  avg_spend_lumi: number | null;
  at_risk_customers: number | null;
  cohorts: { rows: CohortRow[]; max_offset: number };
};

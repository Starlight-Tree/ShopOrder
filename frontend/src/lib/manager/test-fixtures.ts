// テスト用の部品（本番のコードからは import しない）
import type { Customers, Hourly, Overview, Products, SalesSeries, Stock, StockItem } from './types';

const scope = { all_stores: true, store_id: null, store_name: null } as const;

export const overview = (over: Partial<Overview> = {}): Overview => ({
  scope,
  business_date: '2026-11-21',
  sales_lumi: 15550,
  orders: 18,
  avg_ticket_lumi: 864,
  in_progress: 3,
  open_stores: 12,
  store_count: 12,
  closed_reason: null,
  yesterday: { business_date: '2026-11-20', state: 'open', sales_lumi: 26640, orders: 30, avg_ticket_lumi: 888 },
  ...over,
});

export const sales = (over: Partial<SalesSeries> = {}): SalesSeries => ({
  scope,
  grain: 'day',
  from: '2026-11-14',
  to: '2026-11-20',
  points: [
    { start: '2026-11-14', sales_lumi: 1000, orders: 2, open_days: 1, state: 'open' },
    { start: '2026-11-15', sales_lumi: null, orders: null, open_days: 0, state: 'closed' },
    { start: '2026-11-16', sales_lumi: 0, orders: 0, open_days: 1, state: 'open' },
    { start: '2026-11-17', sales_lumi: null, orders: null, open_days: 1, state: 'not_built' },
    { start: '2026-11-18', sales_lumi: 2000, orders: 4, open_days: 1, state: 'open' },
  ],
  total: { sales_lumi: 3000, orders: 6, open_days: 4, missing_days: 1 },
  previous: { from: '2026-11-07', to: '2026-11-13' },
  comparison: { state: 'ok', previous_sales_lumi: 2700, change_pct: 11.1, reason: null, message: null },
  ...over,
});

export const products = (): Products => ({
  scope,
  from: '2026-10-24',
  to: '2026-11-20',
  days: 28,
  totals: { sales_lumi: 15690, qty: 34, cups: 32 },
  items: [
    { item_id: 1, code: 'oasis-blend', name: 'オアシスブレンド', category: 'drink', qty: 27, sales_lumi: 12150, share_pct: 77.4, cum_share_pct: 77.4, abc: 'A' },
    { item_id: 4, code: 'cafe-latte', name: 'カフェラテ', category: 'drink', qty: 5, sales_lumi: 2500, share_pct: 15.9, cum_share_pct: 93.3, abc: 'A' },
    { item_id: 9, code: 'hot-sandwich', name: 'ホットサンド', category: 'food', qty: 2, sales_lumi: 1040, share_pct: 6.6, cum_share_pct: 100, abc: 'B' },
  ],
});

export const hourly = (): Hourly => ({
  scope,
  from: '2026-10-24',
  to: '2026-11-20',
  days: 28,
  hours: [8, 9, 10],
  cells: [
    { weekday: 1, hour: 8, orders: 20, sales_lumi: 18000 },
    { weekday: 1, hour: 9, orders: 5, sales_lumi: 4000 },
    { weekday: 5, hour: 8, orders: 10, sales_lumi: 9000 },
    { weekday: 7, hour: 10, orders: 1, sales_lumi: 450 },
  ],
  store_days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, store_days: 4 })),
  max_orders: 20,
});

export const stockItem = (over: Partial<StockItem> = {}): StockItem => ({
  item_id: 1,
  code: 'coffee-beans',
  name: 'コーヒー豆',
  kind: 'material',
  unit: 'g',
  on_hand: 6000,
  reserved: 0,
  avg_daily_use: 300,
  days_of_cover: 20,
  gap_to_reorder: 3500,
  reorder_point: 2000,
  low_stores: 0,
  store_count: 1,
  low: false,
  ...over,
});

export const stock = (over: Partial<Stock> = {}): Stock => ({
  scope: { all_stores: false, store_id: 1, store_name: '居住区本店' },
  use_from: '2026-11-07',
  use_to: '2026-11-20',
  waste_from: '2026-10-22',
  waste_to: '2026-11-20',
  items: [
    stockItem(),
    stockItem({ item_id: 2, code: 'milk', name: '牛乳', unit: 'ml', on_hand: 2100, avg_daily_use: 250, days_of_cover: 8.4, gap_to_reorder: -900, reorder_point: 4000, low_stores: 1, low: true }),
    stockItem({ item_id: 3, code: 'matcha', name: '抹茶', unit: 'g', on_hand: 800, avg_daily_use: 0, days_of_cover: null, gap_to_reorder: 600 }),
  ],
  waste: [{ item_id: 2, code: 'milk', name: '牛乳', unit: 'ml', total: 1200, by_reason: { expired: 800, damaged: 400, quality: 0, other: 0 }, waste_rate_pct: 3.5 }],
  ...over,
});

export const customers = (over: Partial<Customers> = {}): Customers => ({
  as_of: '2026-11-21',
  min_cell: 5,
  total_customers: 117,
  segments: [
    { segment: 'loyal', label: '常連', customers: 20, suppressed: false },
    { segment: 'regular', label: '通い', customers: 40, suppressed: false },
    { segment: 'light', label: 'ときどき', customers: 30, suppressed: false },
    { segment: 'at_risk', label: '離れかけ', customers: 17, suppressed: false },
    { segment: 'dormant', label: '休眠', customers: 10, suppressed: false },
  ],
  grid: [3, 2, 1].flatMap((r) => [1, 2, 3].map((f) => ({ r, f, customers: r * 10 + f, suppressed: false }))),
  repurchase_rate_pct: 87.2,
  avg_orders: 15.2,
  avg_spend_lumi: 13000,
  at_risk_customers: 17,
  cohorts: {
    max_offset: 2,
    rows: [
      {
        cohort: '2026-09-01',
        size: 24,
        suppressed: false,
        includes_existing: true,
        cells: [
          { offset: 0, customers: 24, rate_pct: 100, suppressed: false, in_progress: false },
          { offset: 1, customers: 20, rate_pct: 83.3, suppressed: false, in_progress: false },
          { offset: 2, customers: null, rate_pct: null, suppressed: true, in_progress: true },
        ],
      },
      {
        cohort: '2026-11-01',
        size: null,
        suppressed: true,
        includes_existing: false,
        cells: [{ offset: 0, customers: null, rate_pct: null, suppressed: true, in_progress: true }],
      },
    ],
  },
  ...over,
});

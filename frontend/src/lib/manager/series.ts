// 店長の画面のデータ整形（画面に依らない純粋な関数）。指標の定義は docs/metrics.md。
import type {
  AbcClass,
  Comparison,
  Customers,
  DayState,
  GridCell,
  Grain,
  Hourly,
  ProductItem,
  SalesPoint,
  SegmentCell,
  StockItem,
} from './types';
import { COMPARISON_REASONS } from './messages';

export const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'] as const;
export const DASH = '—';

/** 金額（ルミ）。null は「—」（休業・未集計・計算できない） */
export function lumi(value: number | null | undefined): string {
  return value === null || value === undefined ? DASH : `${value.toLocaleString('ja-JP')} ルミ`;
}

export function count(value: number | null | undefined, unit = ''): string {
  return value === null || value === undefined ? DASH : `${value.toLocaleString('ja-JP')}${unit}`;
}

export function pct(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined) return DASH;
  const text = `${Math.abs(value).toFixed(1)}%`;
  return signed ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${text}` : `${value < 0 ? '−' : ''}${text}`;
}

// ---- 日付の表示 ----

function parseDate(iso: string): { y: number; m: number; d: number; weekday: number } {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 月 = 0
  return { y, m, d, weekday };
}

/** 点の見出し。日: 11/20（金）、週: 11/16 の週、月: 10 月 */
export function pointLabel(iso: string, grain: Grain): string {
  const { y, m, d, weekday } = parseDate(iso);
  if (grain === 'month') return `${y} 年 ${m} 月`;
  if (grain === 'week') return `${m}/${d} の週`;
  return `${m}/${d}（${WEEKDAYS[weekday]}）`;
}

/** グラフの横軸の短い見出し */
export function axisLabel(iso: string, grain: Grain): string {
  const { m, d } = parseDate(iso);
  return grain === 'month' ? `${m}月` : `${m}/${d}`;
}

export const STATE_LABELS: Record<DayState, string> = { open: '', closed: '休業', not_built: '未集計', partial: '一部未集計' };

// ---- 売上の推移 ----

/**
 * 移動平均。直近 window 個の点のうち、値のある点（休業・未集計は null）だけの平均。値のある点が minPoints 未満なら null。
 * 休業日を 0 として混ぜない（営業日だけで平均する）。
 */
export function movingAverage(values: readonly (number | null)[], window = 7, minPoints = 3): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v): v is number => v !== null);
    return slice.length >= Math.min(minPoints, window) ? Math.round(slice.reduce((a, b) => a + b, 0) / slice.length) : null;
  });
}

export type SalesRow = {
  key: string;
  label: string; // 表の見出し
  axis: string; // 横軸
  sales: number | null;
  average: number | null;
  orders: number | null;
  state: DayState;
  openDays: number;
};

export function toSalesRows(points: readonly SalesPoint[], grain: Grain, window = 7, minPoints = 3): SalesRow[] {
  const avg = movingAverage(points.map((p) => p.sales_lumi), window, minPoints);
  return points.map((p, i) => ({
    key: p.start,
    label: pointLabel(p.start, grain),
    axis: axisLabel(p.start, grain),
    sales: p.sales_lumi,
    average: avg[i] ?? null,
    orders: p.orders,
    state: p.state,
    openDays: p.open_days,
  }));
}

/** 表のセルの文: 売上 0 は「0 ルミ」、休業・未集計は文字（0 と区別する） */
export function salesCell(row: Pick<SalesRow, 'sales' | 'state'>): string {
  if (row.state === 'closed') return '休業';
  if (row.state === 'not_built') return '未集計';
  if (row.state === 'partial') return '一部未集計';
  return lumi(row.sales);
}

export function comparisonText(c: Comparison): { ok: boolean; text: string } {
  if (c.state === 'ok' && c.change_pct !== null) return { ok: true, text: `前の期間より ${pct(c.change_pct, true)}（前の期間: ${lumi(c.previous_sales_lumi)}）` };
  const reason = (c.reason && COMPARISON_REASONS[c.reason]) || c.message || '比べられません。';
  return { ok: false, text: `比較不可。${reason}` };
}

// ---- 商品別 ----

export const ABC_LABELS: Record<AbcClass, string> = { A: 'A（売上の 80% まで）', B: 'B（95% まで）', C: 'C（残り）' };
export const CATEGORY_LABELS = { drink: 'ドリンク', food: 'フード', beans: '豆' } as const;

/** A / B / C の品数 */
export function abcCount(items: readonly Pick<ProductItem, 'abc'>[]): Record<AbcClass, number> {
  const n: Record<AbcClass, number> = { A: 0, B: 0, C: 0 };
  for (const i of items) n[i.abc] += 1;
  return n;
}

/** 横棒に出す上位 n 品。名前に区分（A/B/C）を添える（色だけに頼らない）。長い名前は切らず、そのまま */
export function productBars(items: readonly ProductItem[], top = 10): { name: string; sales: number; abc: AbcClass }[] {
  return items.slice(0, top).map((i) => ({ name: `${i.name}（${i.abc}）`, sales: i.sales_lumi, abc: i.abc }));
}

// ---- 曜日 × 時間帯 ----

export const HEAT_LEVELS = 5;

/** 0 件は 0。1 件以上は、最大値に対する割合を 1〜5 の段階にする（切り上げ。最大値は 5） */
export function heatLevel(orders: number, max: number): number {
  if (orders <= 0 || max <= 0) return 0;
  return Math.min(HEAT_LEVELS, Math.max(1, Math.ceil((orders / max) * HEAT_LEVELS)));
}

export type HeatRow = { hour: number; label: string; cells: { weekday: number; orders: number; level: number }[]; total: number };

/** 行 = 時間帯、列 = 曜日（月〜日）。狭い画面でも、7 列に収まる */
export function buildHeatmap(h: Pick<Hourly, 'hours' | 'cells' | 'max_orders'>): { rows: HeatRow[]; weekdayTotals: number[]; grand: number } {
  const byKey = new Map(h.cells.map((c) => [`${c.weekday}-${c.hour}`, c.orders]));
  const rows = h.hours.map((hour) => {
    const cells = WEEKDAYS.map((_, i) => {
      const orders = byKey.get(`${i + 1}-${hour}`) ?? 0;
      return { weekday: i + 1, orders, level: heatLevel(orders, h.max_orders) };
    });
    return { hour, label: `${hour}:00〜${hour}:59`, cells, total: cells.reduce((s, c) => s + c.orders, 0) };
  });
  const weekdayTotals = WEEKDAYS.map((_, i) => rows.reduce((s, r) => s + (r.cells[i]?.orders ?? 0), 0));
  return { rows, weekdayTotals, grand: weekdayTotals.reduce((a, b) => a + b, 0) };
}

// ---- 在庫 ----

/** 残日数の少ない順（残日数が無い品は最後）。同じなら ID 順 */
export function sortByCover(items: readonly StockItem[]): StockItem[] {
  return [...items].sort((a, b) => {
    const ac = a.days_of_cover ?? Number.POSITIVE_INFINITY;
    const bc = b.days_of_cover ?? Number.POSITIVE_INFINITY;
    return ac - bc || a.item_id - b.item_id;
  });
}

export function stockBars(items: readonly StockItem[], top = 10): { name: string; days: number; low: boolean }[] {
  return sortByCover(items)
    .filter((i) => i.days_of_cover !== null)
    .slice(0, top)
    .map((i) => ({ name: i.low ? `${i.name}（発注点割れ）` : i.name, days: i.days_of_cover as number, low: i.low }));
}

export function coverText(item: Pick<StockItem, 'days_of_cover'>): string {
  return item.days_of_cover === null ? '消費なし' : `${item.days_of_cover.toLocaleString('ja-JP')} 日`;
}

/** 発注点との差。負なら下回っている（足りない量） */
export function gapText(item: Pick<StockItem, 'gap_to_reorder' | 'unit'>): string {
  if (item.gap_to_reorder === null) return DASH;
  const n = Math.abs(item.gap_to_reorder).toLocaleString('ja-JP');
  return item.gap_to_reorder < 0 ? `${n} ${item.unit} 足りない` : `+${n} ${item.unit}`;
}

// ---- 顧客 ----

export const SUPPRESSED = '5 人未満';

export function peopleText(cell: { customers: number | null; suppressed: boolean }): string {
  return cell.suppressed || cell.customers === null ? SUPPRESSED : `${cell.customers.toLocaleString('ja-JP')} 人`;
}

export function segmentBars(segments: readonly SegmentCell[]): { name: string; customers: number | null; suppressed: boolean }[] {
  return segments.map((s) => ({ name: s.suppressed ? `${s.label}（${SUPPRESSED}）` : s.label, customers: s.suppressed ? null : s.customers, suppressed: s.suppressed }));
}

const R_LABELS: Record<number, string> = { 3: '直近 14 日以内', 2: '15〜30 日前', 1: '31 日以上前' };
const F_LABELS: Record<number, string> = { 1: '9 回以下', 2: '10〜29 回', 3: '30 回以上' };

/** R × F の表（行 R、列 F）。人数のセルは、5 人未満を隠す */
export function gridTable(grid: readonly GridCell[]): { rows: { r: number; label: string; cells: { f: number; label: string; text: string; suppressed: boolean }[] }[] } {
  const rs = [3, 2, 1];
  return {
    rows: rs.map((r) => ({
      r,
      label: R_LABELS[r] ?? '',
      cells: [1, 2, 3].map((f) => {
        const cell = grid.find((g) => g.r === r && g.f === f);
        return { f, label: F_LABELS[f] ?? '', text: cell ? peopleText(cell) : DASH, suppressed: cell?.suppressed ?? false };
      }),
    })),
  };
}

export function cohortMonth(iso: string): string {
  const { y, m } = parseDate(iso);
  return `${y} 年 ${m} 月`;
}

/** コホート表（行 = 初回月、列 = 経過月）。5 人未満は隠す。当月は途中なので注記する */
export function cohortTable(c: Customers['cohorts']): {
  headers: string[];
  rows: { key: string; label: string; size: string; note: string | null; cells: { offset: number; text: string; suppressed: boolean; inProgress: boolean }[] }[];
} {
  const headers = Array.from({ length: c.max_offset + 1 }, (_, i) => (i === 0 ? '初回月' : `+${i} か月`));
  return {
    headers,
    rows: c.rows.map((r) => ({
      key: r.cohort,
      label: cohortMonth(r.cohort),
      size: r.suppressed || r.size === null ? SUPPRESSED : `${r.size.toLocaleString('ja-JP')} 人`,
      note: r.includes_existing ? 'データの開始前から来ていた人を含みます' : null,
      cells: r.cells.map((cell) => ({
        offset: cell.offset,
        text: cell.suppressed || cell.customers === null ? SUPPRESSED : `${pct(cell.rate_pct)}（${cell.customers.toLocaleString('ja-JP')} 人）`,
        suppressed: cell.suppressed,
        inProgress: cell.in_progress,
      })),
    })),
  };
}

// ---- 期間の選択 ----

export const GRAIN_OPTIONS: { value: Grain; label: string; counts: number[]; defaultCount: number; unit: string }[] = [
  { value: 'day', label: '日', counts: [14, 28, 56, 90], defaultCount: 28, unit: '日' },
  { value: 'week', label: '週', counts: [8, 12, 26], defaultCount: 12, unit: '週' },
  { value: 'month', label: '月', counts: [3, 6, 12], defaultCount: 3, unit: 'か月' },
];
export const DAYS_OPTIONS = [7, 28, 56, 90] as const;

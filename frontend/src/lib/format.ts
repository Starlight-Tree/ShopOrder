import type { MenuItem, Variant } from './types';

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];

/** 金額（ルミ。整数）。例: 1800 → "1,800 ルミ" */
export function formatLumi(amount: number): string {
  return `${amount.toLocaleString('ja-JP')} ルミ`;
}

/** 価格の範囲。1 つなら "450 ルミ"、複数なら "380〜520 ルミ" */
export function priceRange(variants: Pick<Variant, 'price_lumi'>[]): string {
  if (variants.length === 0) return '';
  const prices = variants.map((v) => v.price_lumi);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatLumi(min) : `${min.toLocaleString('ja-JP')}〜${formatLumi(max)}`;
}

/** 定休日。無ければ「年中無休」 */
export function closedLabel(closedWeekday: number | null): string {
  return closedWeekday === null ? '年中無休' : `定休日 ${WEEKDAYS[closedWeekday - 1] ?? ''}`;
}

/** 毎年の期間 "12-01" 〜 "12-25" → "12/1〜12/25" */
export function seasonLabel(item: Pick<MenuItem, 'season_from' | 'season_to'>): string | null {
  if (!item.season_from || !item.season_to) return null;
  const md = (s: string) => {
    const [m, d] = s.split('-');
    return `${Number(m)}/${Number(d)}`;
  };
  return `${md(item.season_from)}〜${md(item.season_to)}`;
}

/** 時間帯 "07:00"〜"10:30"（片方だけでもよい）。無ければ null */
export function soldWindowLabel(item: Pick<MenuItem, 'sold_from' | 'sold_until'>): string | null {
  if (!item.sold_from && !item.sold_until) return null;
  if (item.sold_from && item.sold_until) return `${item.sold_from}〜${item.sold_until}`;
  return item.sold_from ? `${item.sold_from} から` : `${item.sold_until} まで`;
}

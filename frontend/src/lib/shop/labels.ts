// 画面に出す固定の日本語（区分・理由・変種）。API の応答の文言は信用せず、code から選ぶ。
import type { ClosedReason, MenuItem, UnavailableReason, Variant } from '../types';

export type Category = MenuItem['category'];

export const CATEGORIES: readonly Category[] = ['drink', 'food', 'beans'];

export const CATEGORY_LABEL: Record<Category, string> = { drink: 'ドリンク', food: 'フード', beans: '豆' };

/** クエリ ?category= の値。未指定・不正は null（すべて） */
export function parseCategory(raw: string | string[] | undefined): Category | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return CATEGORIES.find((c) => c === v) ?? null;
}

const CLOSED_REASON_LABEL: Record<ClosedReason, string> = {
  closed_today: '本日は定休日です',
  temporary_closure: '臨時休業中です',
  outside_hours: '営業時間外です',
  past_last_order: 'ラストオーダーを過ぎました',
  mobile_order_unavailable: 'この店はモバイルオーダーをご利用いただけません',
};

/** 店が注文を受けられない理由。未知の値・null でも、固定の文を返す */
export function closedReasonText(reason: string | null | undefined): string {
  return (reason && (CLOSED_REASON_LABEL as Record<string, string>)[reason]) || '今は注文を受け付けていません';
}

const UNAVAILABLE_REASON_LABEL: Record<UnavailableReason, string> = {
  out_of_season: '季節外のため',
  out_of_hours: '販売時間外のため',
  sold_out: '売り切れのため',
};

/** 品を注文できない理由。未知の値・null でも、固定の文を返す */
export function unavailableReasonText(reason: string | null | undefined): string {
  return (reason && (UNAVAILABLE_REASON_LABEL as Record<string, string>)[reason]) || '今は注文できません';
}

const TEMPERATURE_LABEL: Record<string, string> = { hot: 'ホット', ice: 'アイス' };

/** サイズ・温度の表示。"-" は「無い」の意味。両方無ければ「通常」 */
export function variantLabel(v: Pick<Variant, 'size' | 'temperature'>): string {
  const parts: string[] = [];
  if (v.size && v.size !== '-') parts.push(`${v.size} サイズ`);
  if (v.temperature && v.temperature !== '-') parts.push(TEMPERATURE_LABEL[v.temperature] ?? v.temperature);
  return parts.length > 0 ? parts.join('・') : '通常';
}

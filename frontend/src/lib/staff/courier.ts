// 配達員の画面の、画面に依らない部分: ボタン・暗証コードの入力の整え方・不在の理由。
import type { CourierAction } from './delivery-types';

export const COURIER_ACTION_LABELS: Record<CourierAction, string> = {
  pickup: '集荷した',
  depart: '出発する',
  deliver: '到着・暗証コードで確認',
  fail: '不在・受け取れない',
};

const ORDER: readonly CourierAction[] = ['pickup', 'depart', 'deliver', 'fail'];

export type CourierButton = { action: CourierAction; label: string };

/** allowed_actions → ボタン。知らない action は出さない。重複は 1 つに。進める操作を先、不在を最後に */
export function courierButtons(allowed: readonly string[]): CourierButton[] {
  return ORDER.filter((a) => allowed.includes(a)).map((action) => ({ action, label: COURIER_ACTION_LABELS[action] }));
}

export const PIN_LENGTH = 4;

/** 暗証コードの入力 → 4 桁の数字。全角の数字も受ける（NFKC）。前後の空白は除く。4 桁の数字でなければ null */
export function normalizePin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.normalize('NFKC').trim();
  return /^\d{4}$/.test(s) ? s : null;
}

export const FAIL_REASONS = [
  { value: 'absent', label: '不在' },
  { value: 'cannot_receive', label: '受け取れない' },
  { value: 'other', label: 'その他' },
] as const;

export type FailReasonValue = (typeof FAIL_REASONS)[number]['value'];

export function isFailReason(value: unknown): value is FailReasonValue {
  return FAIL_REASONS.some((r) => r.value === value);
}

/** 暗証コードの残りの回数の文 */
export function attemptsLeftText(left: number | null): string | null {
  if (left === null) return null;
  return left <= 1 ? `残り ${Math.max(0, left)} 回（間違えると配達が止まります）` : `残り ${left} 回`;
}

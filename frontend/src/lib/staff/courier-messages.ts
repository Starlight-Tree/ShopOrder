// 配達員の画面に出す固定の文と、API の失敗（status・code）から文を選ぶ関数。
// 文は、すべてこちらで決める（API の message・例外の文面は出さない）。暗証コードの入力値は、どの文にも入れない。
import type { ApiErrorBody } from '../contract';
import { attemptsLeftText } from './courier';
import type { CourierAction, DeliveryOutcome } from './delivery-types';
import type { Loaded } from './loaders';
import { MSG } from './messages';

export const COURIER_MSG = {
  gone: '配達が見つかりません。更新します',
  stateChanged: '配達の状態が変わりました。更新します',
  pinFormat: '暗証コードは 4 桁の数字で入力してください',
  pinInvalid: '暗証コードが違います',
  pinLocked: '暗証コードを続けて間違えたため、この配達は止まりました。店に連絡してください',
  pinExpired: '暗証コードの有効期限が切れました。店に連絡してください',
  reasonRequired: '理由を選んでください',
  loadFailed: '配達を読み込めませんでした',
  retrying: '自動で再試行します。',
  staleTitle: '最新の配達を読み込めませんでした',
  staleBody: '表示は、少し前の内容です。自動で再試行します。',
  dismiss: '閉じる',
} as const;

/** 配達員の一覧に出る状態（API は assigned / picked_up / delivering だけを返す） */
export const COURIER_STATUS_LABELS: Record<string, string> = {
  assigned: '集荷待ち',
  picked_up: '集荷済み（出発前）',
  delivering: '配達中',
};

export function courierStatusLabel(status: string): string {
  return COURIER_STATUS_LABELS[status] ?? '状態を確認中';
}

const SUCCESS_BY_ACTION: Record<CourierAction, string> = {
  pickup: '集荷しました。お届け先が表示されます',
  depart: '出発しました',
  deliver: '配達が完了しました',
  fail: '店へ戻しました。店が再配達か取消しを決めます',
};

/**
 * 結果の文に、どの配達かを前置きする（複数の担当があるとき、画面の上に出る文が、どのカードの結果か分かるように）。
 * 番号が整数で読めなければ、前置きなし。
 */
export function withPickupNo(pickupNo: unknown, text: string): string {
  return typeof pickupNo === 'number' && Number.isInteger(pickupNo) ? `受け取り番号 ${pickupNo}: ${text}` : text;
}

/** 操作が通ったときの文。受け取り番号が読めなければ、番号なし */
export function courierSuccessMessage(pickupNo: number | null, action: CourierAction): string {
  return withPickupNo(pickupNo, SUCCESS_BY_ACTION[action]);
}

/** 一覧の取得に失敗したときの文（ok・unauthorized 以外）。API の文面は出さない */
export function courierLoadErrorMessage(loaded: Exclude<Loaded<unknown>, { state: 'ok' } | { state: 'unauthorized' }>): string {
  if (loaded.state === 'forbidden') return MSG.forbidden;
  return loaded.unreachable ? MSG.unreachable : MSG.generic;
}

type Failure = Extract<DeliveryOutcome, { ok: false }>;

/** 残りの回数は 0〜5 の整数だけ受ける（それ以外は、回数なしの文にする） */
function attemptsLeftOf(error: ApiErrorBody): number | null {
  const n = error.attempts_left;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
}

/**
 * API の失敗 → 画面の文。refresh は、画面を取り直す印（他の人が先に操作した・状態や回数が変わったとき）。
 * 暗証コードの 3 つの失敗（違う・凍結・期限切れ）は、別の文にする。
 */
export function courierFailureFrom(res: { status: number; error: ApiErrorBody }, action: CourierAction): Failure {
  const { status, error } = res;
  if (status === 0) return { ok: false, kind: 'unreachable', message: MSG.unreachable, refresh: false };
  if (status === 401) return { ok: false, kind: 'unauthorized', message: MSG.generic, refresh: false };
  if (status === 403) return { ok: false, kind: 'forbidden', message: MSG.forbidden, refresh: false };
  if (status === 404) return { ok: false, kind: 'not_found', message: COURIER_MSG.gone, refresh: true };
  if (status === 409) {
    if (error.code === 'pin_locked') return { ok: false, kind: 'conflict', message: COURIER_MSG.pinLocked, refresh: true };
    if (error.code === 'pin_expired') return { ok: false, kind: 'conflict', message: COURIER_MSG.pinExpired, refresh: true };
    return { ok: false, kind: 'conflict', message: COURIER_MSG.stateChanged, refresh: true };
  }
  if (status === 422) {
    if (error.code === 'pin_invalid') {
      const left = attemptsLeftText(attemptsLeftOf(error));
      // 回数が減ったので、画面も取り直す（カードの「残り」が古いままにならないように）
      return { ok: false, kind: 'invalid', message: left ? `${COURIER_MSG.pinInvalid}。${left}` : COURIER_MSG.pinInvalid, refresh: true };
    }
    return { ok: false, kind: 'invalid', message: action === 'deliver' ? COURIER_MSG.pinFormat : MSG.invalidInput, refresh: false };
  }
  if (status >= 400 && status < 500) return { ok: false, kind: 'invalid', message: MSG.generic, refresh: false };
  return { ok: false, kind: 'error', message: MSG.generic, refresh: false };
}

// 画面に出す固定の文と、API の失敗（status・code）から文を選ぶ関数。
// ログインの失敗は、理由を分けない（401 と 429 だけ区別する）。例外の文面・API のアドレスは出さない。
import type { ApiErrorBody } from '../contract';
import type { FailureKind } from './types';

export const MSG = {
  loginEmpty: 'メールアドレスとパスワードを入力してください',
  loginInvalid: 'メールアドレスまたはパスワードが違います',
  loginTooMany: 'ログインに続けて失敗しました。しばらくしてから、もう一度お試しください',
  loginFailed: 'ログインできませんでした。しばらくしてから、もう一度お試しください',
  conflict: '他の人が先に操作しました。更新します',
  orderNotFound: '注文が見つかりません。更新します',
  itemNotFound: '品目が見つかりません。画面を更新してください',
  forbidden: 'この操作をする権限がありません',
  invalidInput: '入力内容を確かめてください',
  unreachable: 'API に接続できません。しばらくしてから、もう一度お試しください',
  generic: 'うまくいきませんでした。もう一度お試しください',
  cancelReasonRequired: '取消しの理由を入力してください（100 文字まで）',
} as const;

export function loginErrorMessage(status: number): string {
  if (status === 401) return MSG.loginInvalid;
  if (status === 429) return MSG.loginTooMany;
  return MSG.loginFailed;
}

/** API の message は固定の日本語の短い文（docs/api.md）。そうでないもの（長い・空）は使わない */
function safeMessage(error: ApiErrorBody): string | null {
  const m = error.message;
  return typeof m === 'string' && m.length > 0 && m.length <= 100 ? m : null;
}

export function failureFrom(
  res: { status: number; error: ApiErrorBody },
  notFoundMessage: string = MSG.orderNotFound,
): { kind: FailureKind; message: string } {
  const { status, error } = res;
  if (status === 0) return { kind: 'unreachable', message: MSG.unreachable };
  if (status === 401) return { kind: 'unauthorized', message: MSG.generic };
  if (status === 403) return { kind: 'forbidden', message: MSG.forbidden };
  if (status === 404) return { kind: 'not_found', message: notFoundMessage };
  if (status === 409 && error.code === 'invalid_transition') return { kind: 'conflict', message: MSG.conflict };
  if (status === 422) return { kind: 'invalid', message: safeMessage(error) ?? MSG.invalidInput };
  if (status >= 400 && status < 500) return { kind: 'invalid', message: safeMessage(error) ?? MSG.generic };
  return { kind: 'error', message: MSG.generic };
}

const SUCCESS_BY_ACTION = {
  accept: '受付済みにしました',
  start: '調理中にしました',
  ready: '準備完了にしました',
  complete: '渡し済みにしました',
  cancel: '取り消しました',
} as const;

export function transitionSuccessMessage(pickupNo: number, action: keyof typeof SUCCESS_BY_ACTION): string {
  return `受け取り番号 ${pickupNo} を${SUCCESS_BY_ACTION[action]}`;
}

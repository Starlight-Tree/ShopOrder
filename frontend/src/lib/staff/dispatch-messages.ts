// 配車ボードの固定の文と、API の失敗（status・code）から文を選ぶ関数。
// 文は、API の message ではなく、ここに置いた固定のものを使う（例外の文字列・サーバーのパス・住所を画面に出さない）。
import type { ApiErrorBody } from '../contract';
import { failureFrom, MSG } from './messages';
import type { FailureKind } from './types';

export const DISPATCH_MSG = {
  courierRequired: '勤務中の配達員を選んでください',
  noCourierOnDuty: '勤務中の配達員がいません',
  courierOffDuty: 'その配達員は、勤務中ではなくなりました。更新します',
  courierNotFound: '配達員が見つかりません。更新します',
  noSlot: '再配達で選べる枠がありません。枠が空いてから、もう一度お試しください',
  zoneSuspended: '砂嵐の警報が出ている区画のため、再配達できません。警報が解除されてから、もう一度お試しください',
  mockOnly: '模擬の配達のときだけ使える操作です。更新します',
  noCourierAvailable: '提案できる配達員がいません。配達員を選んで割り当ててください',
  zoneNotFound: '区画が見つかりません。更新します',
  cancelDone: '注文を取り消しました',
  cancelHint: '取り消すと、返金と、在庫・配達の枠の確保の取り消しが行われます。',
} as const;

/** 失敗の分類と画面の文。refresh は、画面を最新に取り直すべきか（他の人が先に操作した・状態が変わった） */
export type DispatchFailure = { kind: FailureKind; message: string; refresh: boolean };

/** 宅配の操作の 409 / 404（code ごと）。ここに無いものは、スタッフ共通の failureFrom に任せる */
const KNOWN: ReadonlyArray<{ status: number; code: string; failure: DispatchFailure }> = [
  { status: 409, code: 'courier_off_duty', failure: { kind: 'conflict', message: DISPATCH_MSG.courierOffDuty, refresh: true } },
  { status: 404, code: 'courier_not_found', failure: { kind: 'not_found', message: DISPATCH_MSG.courierNotFound, refresh: true } },
  { status: 409, code: 'no_slot_available', failure: { kind: 'invalid', message: DISPATCH_MSG.noSlot, refresh: false } },
  { status: 409, code: 'zone_suspended', failure: { kind: 'invalid', message: DISPATCH_MSG.zoneSuspended, refresh: true } },
  { status: 409, code: 'mock_only', failure: { kind: 'invalid', message: DISPATCH_MSG.mockOnly, refresh: true } },
  { status: 409, code: 'no_courier_available', failure: { kind: 'invalid', message: DISPATCH_MSG.noCourierAvailable, refresh: false } },
  { status: 404, code: 'zone_not_found', failure: { kind: 'not_found', message: DISPATCH_MSG.zoneNotFound, refresh: true } },
];

export function dispatchFailureFrom(
  res: { status: number; error: ApiErrorBody },
  notFoundMessage: string = MSG.orderNotFound,
): DispatchFailure {
  const known = KNOWN.find((k) => k.status === res.status && k.code === res.error.code);
  if (known) return known.failure;
  const base = failureFrom(res, notFoundMessage);
  return { ...base, refresh: base.kind === 'conflict' || base.kind === 'not_found' };
}

// ---- 成功の文。応答（StaffOrder・Zone）から、表示に使う項目だけを、型を確かめて読む ----

function field(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined;
}

/** 文の目的語。"受け取り番号 12 を"。応答から読めなければ "注文を" */
export function orderObject(data: unknown): string {
  const no = field(data, 'pickup_no');
  return typeof no === 'number' && Number.isInteger(no) ? `受け取り番号 ${no} を` : '注文を';
}

export function assignedMessage(data: unknown): string {
  const name = field(field(field(data, 'delivery'), 'courier'), 'name');
  return `${orderObject(data)}${typeof name === 'string' && name !== '' ? `${name}に` : ''}割り当てました`;
}

export const redeliverMessage = (data: unknown): string => `${orderObject(data)}再配達にしました（選べる中で最も早い枠）`;

export const mockAdvanceMessage = (data: unknown): string => `${orderObject(data)}模擬で 1 つ進めました`;

export function suspensionMessage(data: unknown, suspended: boolean): string {
  const name = field(data, 'name');
  const zone = typeof name === 'string' && name !== '' ? `${name}の` : '区画の';
  return suspended ? `${zone}砂嵐の警報を立てました。この区画の宅配は、受け付けません` : `${zone}砂嵐の警報を解除しました`;
}

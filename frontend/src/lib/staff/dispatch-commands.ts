// 配車ボードの書き込み（割り当て・再配達・模擬の進行・砂嵐の警報・取消し）。Server Action から呼ぶ。Cookie・redirect はここで扱わない（action 側）。
// Server Action の引数はクライアントから来る（信用しない）ので、形をここで確かめてから API へ送る。権限は API が毎回確かめる。
// 失敗は DeliveryOutcome（refresh = 画面を取り直す印）で返す。文は固定（dispatch-messages.ts）。
import { apiRequest } from '../server-api';
import { performTransition } from './commands';
import type { DeliveryOutcome, DispatchCancelInput, AssignInput, MockAdvanceInput, RedeliverInput, SuspensionInput } from './delivery-types';
import {
  assignedMessage,
  DISPATCH_MSG,
  dispatchFailureFrom,
  mockAdvanceMessage,
  redeliverMessage,
  suspensionMessage,
} from './dispatch-messages';
import type { StaffApi } from './loaders';
import { MSG } from './messages';

const PUBLIC_ID_RE = /^[A-Za-z0-9]{4,32}$/;
const INT32_MAX = 2_147_483_647;

const isPublicId = (v: unknown): v is string => typeof v === 'string' && PUBLIC_ID_RE.test(v);
/** 配達員・区画の ID（1 以上の整数。DB の int の範囲） */
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= INT32_MAX;

const invalid = (message: string = MSG.invalidInput): DeliveryOutcome => ({ ok: false, kind: 'invalid', message, refresh: false });

/** 配達員を割り当てる（ready → assigned。assigned なら付け替え）。POST /api/staff/orders/{id}/assign */
export async function performAssign(token: string, input: AssignInput, api: StaffApi = apiRequest): Promise<DeliveryOutcome> {
  const { publicId, courierId } = input ?? {};
  if (!isPublicId(publicId) || !isId(courierId)) return invalid();
  const res = await api<unknown>(`/api/staff/orders/${publicId}/assign`, { method: 'POST', body: { courier_id: courierId }, staffToken: token });
  if (!res.ok) return { ok: false, ...dispatchFailureFrom(res) };
  return { ok: true, message: assignedMessage(res.data) };
}

/** 再配達（delivery_failed → ready）。枠は省略 = 選べる中で最も早い枠。POST .../redeliver */
export async function performRedeliver(token: string, input: RedeliverInput, api: StaffApi = apiRequest): Promise<DeliveryOutcome> {
  const { publicId } = input ?? {};
  if (!isPublicId(publicId)) return invalid();
  const res = await api<unknown>(`/api/staff/orders/${publicId}/redeliver`, { method: 'POST', staffToken: token });
  if (!res.ok) return { ok: false, ...dispatchFailureFrom(res) };
  return { ok: true, message: redeliverMessage(res.data) };
}

/** 模擬の配達を 1 つ進める（DELIVERY_PROVIDER=mock のときだけ API が受ける）。POST .../mock-advance */
export async function performMockAdvance(token: string, input: MockAdvanceInput, api: StaffApi = apiRequest): Promise<DeliveryOutcome> {
  const { publicId } = input ?? {};
  if (!isPublicId(publicId)) return invalid();
  const res = await api<unknown>(`/api/staff/orders/${publicId}/mock-advance`, { method: 'POST', staffToken: token });
  if (!res.ok) return { ok: false, ...dispatchFailureFrom(res) };
  return { ok: true, message: mockAdvanceMessage(res.data) };
}

/** 砂嵐の警報を立てる・解除する（店長だけ。staff・courier は API が 403）。PUT /api/staff/zones/{id}/suspension */
export async function performSuspension(token: string, input: SuspensionInput, api: StaffApi = apiRequest): Promise<DeliveryOutcome> {
  const { zoneId, suspended } = input ?? {};
  if (!isId(zoneId) || typeof suspended !== 'boolean') return invalid();
  const res = await api<unknown>(`/api/staff/zones/${zoneId}/suspension`, { method: 'PUT', body: { suspended }, staffToken: token });
  if (!res.ok) return { ok: false, ...dispatchFailureFrom(res, DISPATCH_MSG.zoneNotFound) };
  return { ok: true, message: suspensionMessage(res.data, suspended) };
}

/** 取消し。既存の performTransition（cancel・理由が必須）を使い、配車ボードの結果の形にする */
export async function performDispatchCancel(token: string, input: DispatchCancelInput, api: StaffApi = apiRequest): Promise<DeliveryOutcome> {
  const { publicId, reason } = input ?? {};
  const result = await performTransition(token, { publicId: publicId as string, action: 'cancel', reason }, api);
  if (result.ok) return { ok: true, message: DISPATCH_MSG.cancelDone };
  return { ok: false, kind: result.kind, message: result.message, refresh: result.kind === 'conflict' || result.kind === 'not_found' };
}

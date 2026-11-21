// 配車ボードのサーバー側の取得。fetch は server-api の apiRequest を通す（テストでは api を差し替える）。
// 失敗は例外にせず、画面が分けて扱える形（認証切れ・権限なし・その他）で返す（loaders.ts の Loaded と同じ）。
import { apiRequest } from '../server-api';
import type { Courier, DispatchBoardData, DispatchOrder, DispatchSuggestion, FailureReason, StaffDelivery, Zone } from './delivery-types';
import { DISPATCH_STATUSES } from './dispatch';
import type { Loaded, StaffApi } from './loaders';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** { id, name } の参照（店・区画・配達員）。読めれば、この 2 項目だけの新しいオブジェクト */
function toRef(v: unknown): { id: number; name: string } | null {
  return isObject(v) && typeof v.id === 'number' && typeof v.name === 'string' ? { id: v.id, name: v.name } : null;
}

/** 配達員。画面が使う項目だけの新しいオブジェクトにする（読めなければ null） */
function toCourier(v: unknown): Courier | null {
  if (!isObject(v)) return null;
  if (typeof v.id !== 'number' || typeof v.store_id !== 'number' || typeof v.name !== 'string' || typeof v.vehicle !== 'string') return null;
  if (typeof v.is_on_duty !== 'boolean' || typeof v.active_count !== 'number') return null;
  return { id: v.id, store_id: v.store_id, name: v.name, vehicle: v.vehicle, is_on_duty: v.is_on_duty, active_count: v.active_count, zone: toRef(v.zone) };
}

function toDelivery(v: unknown): StaffDelivery | null {
  if (!isObject(v) || typeof v.status !== 'string' || typeof v.attempt !== 'number') return null;
  const zone = toRef(v.zone);
  const slot = v.slot;
  if (!zone || !isObject(slot) || typeof slot.id !== 'number' || typeof slot.starts_at !== 'string' || typeof slot.ends_at !== 'string') return null;
  const courier = toRef(v.courier);
  return {
    status: v.status as StaffDelivery['status'],
    zone,
    slot: { id: slot.id, starts_at: slot.starts_at, ends_at: slot.ends_at },
    courier,
    attempt: v.attempt,
    failure_reason: typeof v.failure_reason === 'string' ? (v.failure_reason as FailureReason) : null,
  };
}

function toSuggestion(v: unknown): DispatchSuggestion | null {
  return isObject(v) && typeof v.courier_id === 'number' && typeof v.courier_name === 'string' && typeof v.minutes === 'number'
    ? { courier_id: v.courier_id, courier_name: v.courier_name, minutes: v.minutes }
    : null;
}

function toItem(v: unknown): DispatchOrder['items'][number] | null {
  return isObject(v) && typeof v.name === 'string' && typeof v.size === 'string' && typeof v.temperature === 'string' && typeof v.qty === 'number'
    ? { name: v.name, size: v.size, temperature: v.temperature, qty: v.qty }
    : null;
}

/**
 * 配車ボードに出せる注文を、画面が使う項目だけの新しいオブジェクトにする。読めない（描けない）ものは null。
 * 詰め替えるのは、loader の返す値がそのままブラウザーへ渡る props になるため（API が住所・暗証コードなどを誤って返しても、ここで落とす）。
 */
function toDispatchOrder(v: unknown): DispatchOrder | null {
  if (!isObject(v) || typeof v.public_id !== 'string' || typeof v.pickup_no !== 'number' || typeof v.status !== 'string') return null;
  const store = toRef(v.store);
  const delivery = toDelivery(v.delivery);
  if (!store || !delivery || !Array.isArray(v.items) || !Array.isArray(v.allowed_actions)) return null;
  const items = v.items.map(toItem);
  if (items.some((i) => i === null)) return null;
  return {
    public_id: v.public_id,
    pickup_no: v.pickup_no,
    status: v.status,
    store,
    items: items as DispatchOrder['items'],
    allowed_actions: v.allowed_actions.filter((a): a is string => typeof a === 'string'),
    delivery,
    suggestion: toSuggestion(v.suggestion),
  };
}

const present = <T>(v: T | null): v is T => v !== null;

function isZone(v: unknown): v is Zone {
  return (
    isObject(v) &&
    typeof v.id === 'number' &&
    typeof v.name === 'string' &&
    typeof v.fee_lumi === 'number' &&
    (v.free_over_lumi === null || typeof v.free_over_lumi === 'number') &&
    typeof v.min_order_lumi === 'number' &&
    typeof v.base_minutes === 'number' &&
    typeof v.is_suspended === 'boolean'
  );
}

/**
 * 配車ボード（GET /api/staff/deliveries）。注文は枠の開始が早い順（API の順のまま）。
 * 店長は storeId で店を選ぶ（null は全店）。店に属するスタッフ・店長は、API が自店に絞る。
 * 応答の形が違う（配列でない）ときは error。読めない注文・配達員は捨てる（1 件の不良で、ボード全体を止めない）。
 * 返す注文・配達員は、画面が使う項目だけを写した新しいオブジェクト（応答のオブジェクトは、そのまま渡さない）。
 */
export async function loadDispatchBoard(token: string, opts: { storeId: number | null }, api: StaffApi = apiRequest): Promise<Loaded<DispatchBoardData>> {
  const q = [`status=${DISPATCH_STATUSES.join(',')}`];
  if (opts.storeId !== null) q.push(`store_id=${opts.storeId}`);
  const res = await api<unknown>(`/api/staff/deliveries?${q.join('&')}`, { staffToken: token });
  if (!res.ok) {
    if (res.status === 401) return { state: 'unauthorized' };
    if (res.status === 403) return { state: 'forbidden' };
    return { state: 'error', unreachable: res.status === 0 };
  }
  const data = res.data;
  if (!isObject(data) || !Array.isArray(data.orders) || !Array.isArray(data.couriers)) return { state: 'error', unreachable: false };
  return {
    state: 'ok',
    data: {
      provider: data.provider === 'mock' ? 'mock' : 'inhouse',
      couriers: data.couriers.map(toCourier).filter(present),
      orders: data.orders.map(toDispatchOrder).filter(present),
    },
  };
}

/**
 * 区画の一覧と、砂嵐の警報の状態（GET /api/delivery/zones。認証なし）。storeId があれば、その店が届ける区画だけ。
 * 読めなければ null（区画の欄に「読み込めません」を出すだけで、ボードは止めない）。
 */
export async function loadZones(opts: { storeId: number | null }, api: StaffApi = apiRequest): Promise<Zone[] | null> {
  const res = await api<unknown>(opts.storeId === null ? '/api/delivery/zones' : `/api/delivery/zones?store_id=${opts.storeId}`);
  return res.ok && Array.isArray(res.data) ? res.data.filter(isZone) : null;
}

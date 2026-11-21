// 配車ボードのサーバー側の取得。fetch は server-api の apiRequest を通す（テストでは api を差し替える）。
// 失敗は例外にせず、画面が分けて扱える形（認証切れ・権限なし・その他）で返す（loaders.ts の Loaded と同じ）。
import { apiRequest } from '../server-api';
import type { Courier, DispatchBoardData, DispatchOrder, Zone } from './delivery-types';
import { deliveryOf, DISPATCH_STATUSES } from './dispatch';
import type { Loaded, StaffApi } from './loaders';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isCourier(v: unknown): v is Courier {
  return isObject(v) && typeof v.id === 'number' && typeof v.store_id === 'number' && typeof v.name === 'string' && typeof v.is_on_duty === 'boolean' && typeof v.active_count === 'number';
}

/** 配車ボードに出せる注文か。宅配の情報（枠・状態）が読めないものは描けない */
function isDispatchOrder(v: unknown): v is DispatchOrder {
  return (
    isObject(v) &&
    typeof v.public_id === 'string' &&
    typeof v.pickup_no === 'number' &&
    typeof v.status === 'string' &&
    isObject(v.store) &&
    typeof v.store.id === 'number' &&
    Array.isArray(v.items) &&
    Array.isArray(v.allowed_actions) &&
    deliveryOf(v) !== null
  );
}

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
      couriers: data.couriers.filter(isCourier),
      orders: data.orders.filter(isDispatchOrder),
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

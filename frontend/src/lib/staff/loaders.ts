// サーバー側の取得。fetch は server-api の apiRequest を通す（テストでは api を差し替える）。
// 失敗は例外にせず、画面が分けて扱える形（認証切れ・権限なし・その他）で返す。
import type { ApiResult } from '../server-api';
import { apiRequest } from '../server-api';
import type { Staff, StaffOrder, StockRow } from '../contract';
import type { Store } from '../types';
import { BOARD_STATUSES } from './orders';

export type StaffApi = typeof apiRequest;

export type Loaded<T> =
  | { state: 'ok'; data: T }
  | { state: 'unauthorized' }
  | { state: 'forbidden' }
  | { state: 'error'; unreachable: boolean };

function toLoaded<T>(res: ApiResult<T>): Loaded<T> {
  if (res.ok) return { state: 'ok', data: res.data };
  if (res.status === 401) return { state: 'unauthorized' };
  if (res.status === 403) return { state: 'forbidden' };
  return { state: 'error', unreachable: res.status === 0 };
}

export const loadMe = async (token: string, api: StaffApi = apiRequest): Promise<Loaded<Staff>> =>
  toLoaded(await api<Staff>('/api/staff/me', { staffToken: token }));

/** 調理ボードの注文（古い順）。店長は storeId で店を選ぶ。null は全店 */
export async function loadOrders(token: string, opts: { storeId: number | null }, api: StaffApi = apiRequest): Promise<Loaded<StaffOrder[]>> {
  const q = [`status=${BOARD_STATUSES.join(',')}`];
  if (opts.storeId !== null) q.push(`store_id=${opts.storeId}`);
  return toLoaded(await api<StaffOrder[]>(`/api/staff/orders?${q.join('&')}`, { staffToken: token }));
}

export async function loadStock(token: string, opts: { storeId: number | null }, api: StaffApi = apiRequest): Promise<Loaded<StockRow[]>> {
  const path = opts.storeId === null ? '/api/staff/stock' : `/api/staff/stock?store_id=${opts.storeId}`;
  return toLoaded(await api<StockRow[]>(path, { staffToken: token }));
}

/** 店の一覧（認証なし）。読めなければ null（店名が出せないだけで、画面は止めない） */
export async function loadStores(api: StaffApi = apiRequest): Promise<Store[] | null> {
  const res = await api<Store[]>('/api/stores');
  return res.ok && Array.isArray(res.data) ? res.data : null;
}

export type SessionState =
  | { kind: 'ok'; token: string; staff: Staff }
  | { kind: 'anonymous' } // Cookie が無い
  | { kind: 'expired' } // トークンが API に拒まれた（401）。Cookie を消してログインへ
  | { kind: 'unavailable' }; // API に聞けなかった（接続・5xx）。Cookie は消さない

export async function resolveSession(token: string | null | undefined, api: StaffApi = apiRequest): Promise<SessionState> {
  if (!token) return { kind: 'anonymous' };
  const me = await loadMe(token, api);
  if (me.state === 'ok') return { kind: 'ok', token, staff: me.data };
  if (me.state === 'unauthorized') return { kind: 'expired' };
  return { kind: 'unavailable' };
}

// 配達員の画面の、サーバー側の取得。fetch は apiRequest を通す（テストでは api を差し替える）。
// 失敗は例外にせず、画面が分けて扱える形（認証切れ・権限なし・その他）で返す（loaders.ts の Loaded と同じ）。
import { apiRequest } from '../server-api';
import type { CourierDelivery } from './delivery-types';
import type { Loaded, StaffApi } from './loaders';

/** 自分の担当（GET /api/courier/deliveries。assigned / picked_up / delivering。枠の開始が早い順） */
export async function loadCourierDeliveries(token: string, api: StaffApi = apiRequest): Promise<Loaded<CourierDelivery[]>> {
  const res = await api<CourierDelivery[]>('/api/courier/deliveries', { staffToken: token });
  if (res.ok) return Array.isArray(res.data) ? { state: 'ok', data: res.data } : { state: 'error', unreachable: false };
  if (res.status === 401) return { state: 'unauthorized' };
  if (res.status === 403) return { state: 'forbidden' };
  return { state: 'error', unreachable: res.status === 0 };
}

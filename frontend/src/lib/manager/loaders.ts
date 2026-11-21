// サーバー側の取得（分析 API）。fetch は server-api の apiRequest を通す（テストでは api を差し替える）。
// 失敗は例外にせず、画面が分けて扱える形（認証切れ・権限なし・その他）で返す。トークンはクライアントへ渡さない。
import { apiRequest, type ApiResult } from '../server-api';
import type { Loaded, StaffApi } from '../staff/loaders';
import type { Customers, Grain, Hourly, Overview, Products, SalesSeries, Stock } from './types';

export type { Loaded };

function toLoaded<T>(res: ApiResult<T>): Loaded<T> {
  if (res.ok) return { state: 'ok', data: res.data };
  if (res.status === 401) return { state: 'unauthorized' };
  if (res.status === 403) return { state: 'forbidden' };
  return { state: 'error', unreachable: res.status === 0 };
}

function path(base: string, params: Record<string, string | number | null | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return q.length ? `${base}?${q.join('&')}` : base;
}

type StoreOpt = { storeId: number | null };

export const loadOverview = async (token: string, o: StoreOpt, api: StaffApi = apiRequest): Promise<Loaded<Overview>> =>
  toLoaded(await api<Overview>(path('/api/analytics/overview', { store_id: o.storeId }), { staffToken: token }));

export const loadSales = async (token: string, o: StoreOpt & { grain: Grain; count: number }, api: StaffApi = apiRequest): Promise<Loaded<SalesSeries>> =>
  toLoaded(await api<SalesSeries>(path('/api/analytics/sales', { grain: o.grain, count: o.count, store_id: o.storeId }), { staffToken: token }));

export const loadProducts = async (token: string, o: StoreOpt & { days: number }, api: StaffApi = apiRequest): Promise<Loaded<Products>> =>
  toLoaded(await api<Products>(path('/api/analytics/products', { days: o.days, store_id: o.storeId }), { staffToken: token }));

export const loadHourly = async (token: string, o: StoreOpt & { days: number }, api: StaffApi = apiRequest): Promise<Loaded<Hourly>> =>
  toLoaded(await api<Hourly>(path('/api/analytics/hourly', { days: o.days, store_id: o.storeId }), { staffToken: token }));

export const loadStock = async (token: string, o: StoreOpt, api: StaffApi = apiRequest): Promise<Loaded<Stock>> =>
  toLoaded(await api<Stock>(path('/api/analytics/stock', { store_id: o.storeId }), { staffToken: token }));

export const loadCustomers = async (token: string, api: StaffApi = apiRequest): Promise<Loaded<Customers>> =>
  toLoaded(await api<Customers>('/api/analytics/customers', { staffToken: token }));

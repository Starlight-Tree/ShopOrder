// 分析画面の page が最初に呼ぶ。ログイン（Cookie）を確かめ、店の選択（全店の店長だけ）を決める。
import type { Staff } from '../contract';
import { parseStoreParam } from '../staff/orders';
import { getStores } from '../staff/session';
import type { Store } from '../types';
import { canViewAnalytics, isAllStoreManager, storeOption } from './access';
import { requireManagerSession } from './session';

export type Raw = Record<string, string | string[] | undefined>;

export type ManagerContext =
  | { kind: 'unavailable' } // API に聞けなかった（Cookie は消さない）
  | { kind: 'courier' } // 配達員は、分析を使えない
  | { kind: 'ok'; token: string; staff: Staff; allStores: boolean; storeId: number | null; stores: Store[] | null };

export async function getManagerContext(searchParams: Promise<Raw>): Promise<ManagerContext> {
  const auth = await requireManagerSession();
  if (!auth) return { kind: 'unavailable' };
  const { token, staff } = auth;
  if (!canViewAnalytics(staff)) return { kind: 'courier' };
  const allStores = isAllStoreManager(staff);
  const params = await searchParams;
  const storeId = storeOption(staff, allStores ? parseStoreParam(params.store) : null);
  const stores = allStores ? await getStores() : null;
  return { kind: 'ok', token, staff, allStores, storeId, stores };
}

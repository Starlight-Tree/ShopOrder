// 誰が何を見られるか（画面の出し分け。権限の本体は API が毎回確かめる）。
import type { Staff } from '../contract';

/** 全店の店長（店に属さない manager）。店を選べる。顧客の分析を見られる */
export const isAllStoreManager = (staff: Pick<Staff, 'role' | 'store_id'>): boolean => staff.role === 'manager' && staff.store_id === null;

/** 売上・在庫を見られるか（スタッフ・店長。配達員は不可） */
export const canViewAnalytics = (staff: Pick<Staff, 'role'>): boolean => staff.role === 'staff' || staff.role === 'manager';

/** 店の選択（?store=）を受け付けるのは、全店の店長だけ。それ以外は、API が自店に絞る */
export const storeOption = (staff: Pick<Staff, 'role' | 'store_id'>, requested: number | null): number | null => (isAllStoreManager(staff) ? requested : null);

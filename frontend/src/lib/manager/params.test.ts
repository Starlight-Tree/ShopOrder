import { describe, expect, it } from 'vitest';
import { canViewAnalytics, isAllStoreManager, storeOption } from './access';
import { parseCount, parseDays, parseGrain } from './params';

describe('検索条件の読み取り', () => {
  it('grain は day / week / month だけ。それ以外・配列・未指定は day', () => {
    expect(parseGrain('week')).toBe('week');
    expect(parseGrain('month')).toBe('month');
    expect(parseGrain('year')).toBe('day');
    expect(parseGrain(undefined)).toBe('day');
    expect(parseGrain(['week', 'month'])).toBe('week');
  });
  it('count は、その単位で許す選択肢だけ。それ以外は既定', () => {
    expect(parseCount('56', 'day')).toBe(56);
    expect(parseCount('13', 'day')).toBe(28);
    expect(parseCount('12', 'week')).toBe(12);
    expect(parseCount('99', 'week')).toBe(12);
    expect(parseCount('6', 'month')).toBe(6);
    expect(parseCount(undefined, 'month')).toBe(3);
    expect(parseCount('abc', 'day')).toBe(28);
  });
  it('days は 7 / 28 / 56 / 90 だけ', () => {
    expect(parseDays('90')).toBe(90);
    expect(parseDays('10')).toBe(28);
    expect(parseDays(undefined)).toBe(28);
    expect(parseDays('7', 56)).toBe(7);
  });
});

describe('誰が何を見られるか', () => {
  const allStore = { role: 'manager', store_id: null } as const;
  const tied = { role: 'manager', store_id: 3 } as const;
  const staff = { role: 'staff', store_id: 1 } as const;
  const courier = { role: 'courier', store_id: 1 } as const;
  it('全店の店長だけが、店を選べて、顧客を見られる', () => {
    expect(isAllStoreManager(allStore)).toBe(true);
    expect(isAllStoreManager(tied)).toBe(false);
    expect(isAllStoreManager(staff)).toBe(false);
  });
  it('配達員は分析を使えない', () => {
    expect(canViewAnalytics(courier)).toBe(false);
    expect(canViewAnalytics(staff)).toBe(true);
    expect(canViewAnalytics(tied)).toBe(true);
  });
  it('店の選択は、全店の店長だけが受け付ける（ほかは API が自店に絞る）', () => {
    expect(storeOption(allStore, 5)).toBe(5);
    expect(storeOption(allStore, null)).toBeNull();
    expect(storeOption(staff, 5)).toBeNull();
    expect(storeOption(tied, 5)).toBeNull();
  });
});

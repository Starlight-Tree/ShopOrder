// URL の検索条件（?grain=・?count=・?days=・?store=）の読み取り。画面（サーバー）が受け取る値は、ここで許す範囲に直す（API へ渡す前の確認）。
import { DAYS_OPTIONS, GRAIN_OPTIONS } from './series';
import type { Grain } from './types';

type Raw = string | string[] | undefined;
const first = (v: Raw): string | undefined => (Array.isArray(v) ? v[0] : v);

export function parseGrain(v: Raw): Grain {
  const g = first(v);
  return g === 'week' || g === 'month' ? g : 'day';
}

/** 期間の数（日・週・月の個数）。許す選択肢（series.ts の GRAIN_OPTIONS）以外は、既定 */
export function parseCount(v: Raw, grain: Grain): number {
  const option = GRAIN_OPTIONS.find((o) => o.value === grain)!;
  const n = Number(first(v));
  return option.counts.includes(n) ? n : option.defaultCount;
}

export function parseDays(v: Raw, fallback = 28): number {
  const n = Number(first(v));
  return (DAYS_OPTIONS as readonly number[]).includes(n) ? n : fallback;
}

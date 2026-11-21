import Link from 'next/link';
import { GRAIN_OPTIONS } from '../../lib/manager/series';
import type { Grain } from '../../lib/manager/types';

type Props = { basePath: string; store: number | null; grain: Grain; count: number };

const href = (basePath: string, store: number | null, grain: Grain, count: number | null) => {
  const q = new URLSearchParams({ grain });
  if (count !== null) q.set('count', String(count));
  if (store !== null) q.set('store', String(store));
  return `${basePath}?${q.toString()}`;
};

/** 売上の推移の、日・週・月と期間の数の切り替え（リンク。サーバーで描き直す）。今のものに aria-current */
export function PeriodNav({ basePath, store, grain, count }: Props) {
  const option = GRAIN_OPTIONS.find((o) => o.value === grain)!;
  return (
    <div className="mg-period">
      <nav aria-label="集計の単位" className="mg-seg">
        {GRAIN_OPTIONS.map((o) => (
          <Link key={o.value} href={href(basePath, store, o.value, null)} aria-current={o.value === grain ? 'true' : undefined}>
            {o.label}
          </Link>
        ))}
      </nav>
      <nav aria-label="期間の長さ" className="mg-seg">
        {option.counts.map((n) => (
          <Link key={n} href={href(basePath, store, grain, n)} aria-current={n === count ? 'true' : undefined}>
            {n} {option.unit}
          </Link>
        ))}
      </nav>
    </div>
  );
}

const DAYS_LABEL = (n: number) => `${n} 日`;

/** 日数の切り替え（商品別・時間帯） */
export function DaysNav({ basePath, store, days, options }: { basePath: string; store: number | null; days: number; options: readonly number[] }) {
  return (
    <nav aria-label="期間の長さ" className="mg-seg">
      {options.map((n) => {
        const q = new URLSearchParams({ days: String(n) });
        if (store !== null) q.set('store', String(store));
        return (
          <Link key={n} href={`${basePath}?${q.toString()}`} aria-current={n === days ? 'true' : undefined}>
            {DAYS_LABEL(n)}
          </Link>
        );
      })}
    </nav>
  );
}

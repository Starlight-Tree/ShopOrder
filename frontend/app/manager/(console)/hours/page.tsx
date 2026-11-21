import { blockedView, failureView } from '../../../../src/components/manager/Gate';
import { HourlyHeatmap } from '../../../../src/components/manager/HourlyHeatmap';
import { DaysNav } from '../../../../src/components/manager/PeriodNav';
import { ScopeSelect } from '../../../../src/components/manager/ScopeSelect';
import { getManagerContext, type Raw } from '../../../../src/lib/manager/context';
import { loadHourly } from '../../../../src/lib/manager/loaders';
import { parseDays } from '../../../../src/lib/manager/params';
import { DAYS_OPTIONS } from '../../../../src/lib/manager/series';

export const metadata = { title: '時間帯' };

export default async function HoursPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const ctx = await getManagerContext(searchParams);
  if (ctx.kind !== 'ok') return blockedView(ctx, '/manager/hours');
  const days = parseDays((await searchParams).days);
  const hourly = await loadHourly(ctx.token, { storeId: ctx.storeId, days });
  return (
    <>
      <h1>曜日 × 時間帯</h1>
      {ctx.allStores && ctx.stores ? <ScopeSelect stores={ctx.stores} selectedId={ctx.storeId} /> : null}
      <DaysNav basePath="/manager/hours" store={ctx.storeId} days={days} options={DAYS_OPTIONS} />
      {failureView(hourly, '曜日 × 時間帯を読み込めませんでした') ?? (hourly.state === 'ok' ? <HourlyHeatmap hourly={hourly.data} /> : null)}
    </>
  );
}

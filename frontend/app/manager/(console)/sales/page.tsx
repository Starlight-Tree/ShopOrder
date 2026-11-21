import { blockedView, failureView } from '../../../../src/components/manager/Gate';
import { PeriodNav } from '../../../../src/components/manager/PeriodNav';
import { SalesPanel } from '../../../../src/components/manager/SalesPanel';
import { ScopeSelect } from '../../../../src/components/manager/ScopeSelect';
import { getManagerContext, type Raw } from '../../../../src/lib/manager/context';
import { loadSales } from '../../../../src/lib/manager/loaders';
import { parseCount, parseGrain } from '../../../../src/lib/manager/params';

export const metadata = { title: '売上' };

export default async function SalesPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const ctx = await getManagerContext(searchParams);
  if (ctx.kind !== 'ok') return blockedView(ctx, '/manager/sales');
  const params = await searchParams;
  const grain = parseGrain(params.grain);
  const count = parseCount(params.count, grain);
  const sales = await loadSales(ctx.token, { storeId: ctx.storeId, grain, count });
  return (
    <>
      <h1>売上の推移</h1>
      {ctx.allStores && ctx.stores ? <ScopeSelect stores={ctx.stores} selectedId={ctx.storeId} /> : null}
      <PeriodNav basePath="/manager/sales" store={ctx.storeId} grain={grain} count={count} />
      {failureView(sales, '売上の推移を読み込めませんでした') ?? (sales.state === 'ok' ? <SalesPanel series={sales.data} /> : null)}
    </>
  );
}

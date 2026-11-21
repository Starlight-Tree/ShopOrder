import Link from 'next/link';
import { blockedView, failureView } from '../../../src/components/manager/Gate';
import { SalesPanel } from '../../../src/components/manager/SalesPanel';
import { ScopeSelect } from '../../../src/components/manager/ScopeSelect';
import { Tiles } from '../../../src/components/manager/Tiles';
import { getManagerContext, type Raw } from '../../../src/lib/manager/context';
import { loadOverview, loadSales } from '../../../src/lib/manager/loaders';

export const metadata = { title: '概況' };

export default async function OverviewPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const ctx = await getManagerContext(searchParams);
  if (ctx.kind !== 'ok') return blockedView(ctx, '/manager');
  const [overview, sales] = await Promise.all([
    loadOverview(ctx.token, { storeId: ctx.storeId }),
    loadSales(ctx.token, { storeId: ctx.storeId, grain: 'day', count: 28 }),
  ]);
  return (
    <>
      <h1>今日の概況</h1>
      {ctx.allStores && ctx.stores ? <ScopeSelect stores={ctx.stores} selectedId={ctx.storeId} /> : null}
      {failureView(overview, '今日の概況を読み込めませんでした') ?? (overview.state === 'ok' ? <Tiles overview={overview.data} /> : null)}
      <h2>売上の推移（直近 28 日）</h2>
      {failureView(sales, '売上の推移を読み込めませんでした') ?? (sales.state === 'ok' ? <SalesPanel series={sales.data} /> : null)}
      <p className="mg-more">
        <Link href="/manager/sales">日・週・月で見る</Link>
      </p>
    </>
  );
}

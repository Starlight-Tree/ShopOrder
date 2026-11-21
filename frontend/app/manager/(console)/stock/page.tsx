import { blockedView, failureView } from '../../../../src/components/manager/Gate';
import { ScopeSelect } from '../../../../src/components/manager/ScopeSelect';
import { StockPanel } from '../../../../src/components/manager/StockPanel';
import { getManagerContext, type Raw } from '../../../../src/lib/manager/context';
import { loadStock } from '../../../../src/lib/manager/loaders';

export const metadata = { title: '在庫' };

export default async function StockPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const ctx = await getManagerContext(searchParams);
  if (ctx.kind !== 'ok') return blockedView(ctx, '/manager/stock');
  const stock = await loadStock(ctx.token, { storeId: ctx.storeId });
  return (
    <>
      <h1>在庫</h1>
      {ctx.allStores && ctx.stores ? <ScopeSelect stores={ctx.stores} selectedId={ctx.storeId} /> : null}
      {failureView(stock, '在庫を読み込めませんでした') ?? (stock.state === 'ok' ? <StockPanel stock={stock.data} /> : null)}
    </>
  );
}

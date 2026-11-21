import { blockedView, failureView } from '../../../../src/components/manager/Gate';
import { DaysNav } from '../../../../src/components/manager/PeriodNav';
import { ProductsPanel } from '../../../../src/components/manager/ProductsPanel';
import { ScopeSelect } from '../../../../src/components/manager/ScopeSelect';
import { getManagerContext, type Raw } from '../../../../src/lib/manager/context';
import { loadProducts } from '../../../../src/lib/manager/loaders';
import { parseDays } from '../../../../src/lib/manager/params';
import { DAYS_OPTIONS } from '../../../../src/lib/manager/series';

export const metadata = { title: '商品別' };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const ctx = await getManagerContext(searchParams);
  if (ctx.kind !== 'ok') return blockedView(ctx, '/manager/products');
  const days = parseDays((await searchParams).days);
  const products = await loadProducts(ctx.token, { storeId: ctx.storeId, days });
  return (
    <>
      <h1>商品別（ABC）</h1>
      {ctx.allStores && ctx.stores ? <ScopeSelect stores={ctx.stores} selectedId={ctx.storeId} /> : null}
      <DaysNav basePath="/manager/products" store={ctx.storeId} days={days} options={DAYS_OPTIONS} />
      {failureView(products, '商品別の売上を読み込めませんでした') ?? (products.state === 'ok' ? <ProductsPanel products={products.data} /> : null)}
    </>
  );
}

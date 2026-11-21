import type { Metadata } from 'next';
import { LoadError } from '../../../src/components/shop/LoadError';
import { OrderList } from '../../../src/components/shop/OrderList';
import { getOrders } from '../../../src/lib/shop/queries';
import { getShopCtx } from '../../../src/lib/shop/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '注文履歴' };

export default async function OrdersPage() {
  const result = await getOrders(await getShopCtx());
  return (
    <>
      <h1>注文履歴</h1>
      {result.ok ? <OrderList orders={result.data} /> : <LoadError error={result.error} status={result.status} />}
    </>
  );
}

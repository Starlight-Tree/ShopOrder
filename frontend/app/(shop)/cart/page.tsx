import type { Metadata } from 'next';
import { CartView } from '../../../src/components/shop/CartView';
import { LoadError } from '../../../src/components/shop/LoadError';
import { loadCartPage } from '../../../src/lib/shop/queries';
import { getShopCtx } from '../../../src/lib/shop/session';
import { selectAddressAction, selectFulfillmentAction, selectSlotAction, setQtyAction } from '../../shop-actions/cart';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'カート' };

// カート: 品・受け取り方法（店頭・宅配）・宅配のお届け先と時間枠。?date= は、時間枠を出す日（今日から 7 日先まで）
export default async function CartPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const result = await loadCartPage(await getShopCtx(), { date: (await searchParams).date });
  return (
    <>
      <h1>カート</h1>
      {result.ok ? (
        <CartView data={result.data} actions={{ qty: setQtyAction, fulfillment: selectFulfillmentAction, address: selectAddressAction, slot: selectSlotAction }} />
      ) : (
        <LoadError error={result.error} status={result.status} />
      )}
    </>
  );
}

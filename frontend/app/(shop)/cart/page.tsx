import type { Metadata } from 'next';
import { CartView } from '../../../src/components/shop/CartView';
import { LoadError } from '../../../src/components/shop/LoadError';
import { loadCartPage } from '../../../src/lib/shop/queries';
import { getShopCtx } from '../../../src/lib/shop/session';
import { setQtyAction } from '../../shop-actions/cart';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'カート' };

export default async function CartPage() {
  const result = await loadCartPage(await getShopCtx());
  return (
    <>
      <h1>カート</h1>
      {result.ok ? <CartView cart={result.data.cart} store={result.data.store} qtyAction={setQtyAction} /> : <LoadError error={result.error} status={result.status} />}
    </>
  );
}

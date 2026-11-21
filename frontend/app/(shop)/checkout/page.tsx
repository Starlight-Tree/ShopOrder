import type { Metadata } from 'next';
import { CheckoutCard } from '../../../src/components/shop/CheckoutCard';
import { LoadError } from '../../../src/components/shop/LoadError';
import { postCheckoutProposal } from '../../../src/lib/shop/queries';
import { getShopCtx } from '../../../src/lib/shop/session';
import { placeOrderAction } from '../../shop-actions/orders';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ご注文の確認' };

// 確認: 「確定の許可証」（POST /api/cart/checkout-proposal）を作って、確認カードを出す。
// 冪等キーは、この画面を描いた時点で作る（確定ボタンの二重クリック・再送で、二重注文にならない）。
export default async function CheckoutPage() {
  const result = await postCheckoutProposal(await getShopCtx());
  return (
    <>
      <h1>ご注文の確認</h1>
      {result.ok ? (
        <CheckoutCard proposal={result.data} idempotencyKey={crypto.randomUUID()} confirmAction={placeOrderAction} />
      ) : (
        <LoadError error={result.error} status={result.status} />
      )}
    </>
  );
}

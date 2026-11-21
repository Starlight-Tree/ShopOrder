import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LoadError } from '../../../../src/components/shop/LoadError';
import { OrderView } from '../../../../src/components/shop/OrderView';
import { devToolsEnabled } from '../../../../src/lib/shop/dev-user';
import { noticeText } from '../../../../src/lib/shop/errors';
import { isValidPublicId } from '../../../../src/lib/shop/input';
import { getOrder } from '../../../../src/lib/shop/queries';
import { getShopCtx } from '../../../../src/lib/shop/session';
import { cancelOrderAction, payOrderAction } from '../../../shop-actions/orders';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ご注文の状況' };

// 注文の状況: 状態は API の status から描く。受け取り番号を大きく、5 秒ごとに再取得（OrderAutoRefresh）
export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!isValidPublicId(id)) notFound();
  const result = await getOrder(await getShopCtx(), id);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <LoadError error={result.error} status={result.status} />;
  }
  return (
    <>
      <OrderView
        order={result.data}
        serverNow={new Date().toISOString()}
        devTools={devToolsEnabled()}
        payAction={payOrderAction}
        cancelAction={cancelOrderAction}
        notice={noticeText((await searchParams).notice)}
      />
      <p>
        <Link href="/orders" className="shop-link-btn">
          注文履歴へ
        </Link>
      </p>
    </>
  );
}

import { redirect } from 'next/navigation';
import { ApiUnavailable, Notice } from '../../../src/components/staff/Notices';
import { OrderBoard } from '../../../src/components/staff/OrderBoard';
import { loadOrders } from '../../../src/lib/staff/loaders';
import { MSG } from '../../../src/lib/staff/messages';
import { parseStoreParam } from '../../../src/lib/staff/orders';
import { getStores, requireStaff } from '../../../src/lib/staff/session';
import { transitionAction } from './actions';

export const metadata = { title: '調理ボード' };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function BoardPage({ searchParams }: Props) {
  const auth = await requireStaff();
  if (!auth) return <ApiUnavailable href="/staff" />;
  const { token, staff } = auth;

  if (staff.role === 'courier') {
    return (
      <>
        <h1>調理ボード</h1>
        <Notice kind="info" title="配達員のアカウントでは、調理ボードは使えません">
          <p>配達員の画面は、宅配の段階で追加します。</p>
        </Notice>
      </>
    );
  }

  // 店の選択は、全店の店長だけ（店に属するスタッフ・店長は、API が自店に絞る）
  const allStores = staff.role === 'manager' && staff.store_id === null;
  const selectedStoreId = allStores ? parseStoreParam((await searchParams).store) : null;
  const [stores, orders] = await Promise.all([allStores ? getStores() : Promise.resolve(null), loadOrders(token, { storeId: selectedStoreId })]);
  if (orders.state === 'unauthorized') redirect('/staff/expired');

  return (
    <>
      <h1>調理ボード</h1>
      <OrderBoard
        orders={orders.state === 'ok' ? orders.data : null}
        errorMessage={orders.state === 'forbidden' ? MSG.forbidden : orders.state === 'error' && orders.unreachable ? MSG.unreachable : MSG.generic}
        now={new Date().toISOString()}
        stores={stores}
        showStoreSelect={allStores && stores !== null}
        selectedStoreId={selectedStoreId}
        onTransition={transitionAction}
      />
    </>
  );
}

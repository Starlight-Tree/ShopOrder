import { redirect } from 'next/navigation';
import { ApiUnavailable, Notice } from '../../../../src/components/staff/Notices';
import { StockForms } from '../../../../src/components/staff/StockForms';
import { StockTable } from '../../../../src/components/staff/StockTable';
import { StoreSelect } from '../../../../src/components/staff/StoreSelect';
import { loadStock } from '../../../../src/lib/staff/loaders';
import { MSG } from '../../../../src/lib/staff/messages';
import { parseStoreParam } from '../../../../src/lib/staff/orders';
import { getStores, requireStaff } from '../../../../src/lib/staff/session';
import { adjustStockAction, receiveStockAction, wasteStockAction } from '../actions';

export const metadata = { title: '在庫' };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function StockPage({ searchParams }: Props) {
  const auth = await requireStaff();
  if (!auth) return <ApiUnavailable href="/staff/stock" />;
  const { token, staff } = auth;

  if (staff.role === 'courier') {
    return (
      <>
        <h1>在庫</h1>
        <Notice kind="info" title="配達員のアカウントでは、在庫は使えません" />
      </>
    );
  }

  // 全店の店長は、店を 1 つ選んで見る（在庫の操作の API は、店を指定する項目が契約に無いので、操作は店に属するアカウントだけ）
  const allStores = staff.role === 'manager' && staff.store_id === null;
  const selectedStoreId = allStores ? parseStoreParam((await searchParams).store) : null;
  const stores = allStores ? await getStores() : null;

  const header = (
    <>
      <h1>在庫</h1>
      {allStores && stores ? <StoreSelect stores={stores} selectedId={selectedStoreId} allowAll={false} /> : null}
    </>
  );

  if (allStores && selectedStoreId === null) {
    return (
      <>
        {header}
        <Notice kind="info" title="店を選ぶと、在庫が表示されます">
          {stores === null ? <p>店の一覧を読み込めませんでした。しばらくしてから、もう一度開いてください。</p> : null}
        </Notice>
      </>
    );
  }

  const stock = await loadStock(token, { storeId: selectedStoreId });
  if (stock.state === 'unauthorized') redirect('/staff/expired');
  if (stock.state !== 'ok') {
    return (
      <>
        {header}
        <Notice title="在庫を読み込めませんでした">
          <p>{stock.state === 'forbidden' ? MSG.forbidden : stock.unreachable ? MSG.unreachable : MSG.generic}</p>
        </Notice>
      </>
    );
  }

  return (
    <>
      {header}
      <StockTable rows={stock.data} />
      <h2>在庫の操作</h2>
      {allStores ? (
        <Notice kind="info" title="全店の店長のアカウントでは、入荷・廃棄・棚卸しの記録はできません">
          <p>店のスタッフのアカウントで記録してください。</p>
        </Notice>
      ) : (
        <StockForms items={stock.data} receive={receiveStockAction} waste={wasteStockAction} adjust={adjustStockAction} />
      )}
    </>
  );
}

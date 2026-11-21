import { CustomersPanel } from '../../../../src/components/manager/CustomersPanel';
import { blockedView, failureView } from '../../../../src/components/manager/Gate';
import { Notice } from '../../../../src/components/manager/Notice';
import { isAllStoreManager } from '../../../../src/lib/manager/access';
import { getManagerContext, type Raw } from '../../../../src/lib/manager/context';
import { loadCustomers } from '../../../../src/lib/manager/loaders';
import { MGMSG } from '../../../../src/lib/manager/messages';

export const metadata = { title: '顧客' };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const ctx = await getManagerContext(searchParams);
  if (ctx.kind !== 'ok') return blockedView(ctx, '/manager/customers');
  // 顧客の分析は、全店の店長だけ（店舗スタッフと、店に属する店長は不可。API も 403）
  if (!isAllStoreManager(ctx.staff)) {
    return (
      <>
        <h1>顧客</h1>
        <Notice kind="info" title={MGMSG.customersOnlyManager} />
      </>
    );
  }
  const customers = await loadCustomers(ctx.token);
  return (
    <>
      <h1>顧客（RFM・コホート）</h1>
      <p className="mg-note">{MGMSG.purpose} 個別の顧客は表示しません（仮名 ID の集計だけ）。</p>
      {failureView(customers, '顧客の分析を読み込めませんでした') ?? (customers.state === 'ok' ? <CustomersPanel customers={customers.data} /> : null)}
    </>
  );
}

import type { Metadata } from 'next';
import { AddressManager } from '../../../src/components/shop/AddressManager';
import { LoadError } from '../../../src/components/shop/LoadError';
import { loadAddressesPage } from '../../../src/lib/shop/queries';
import { getShopCtx } from '../../../src/lib/shop/session';
import { createAddressAction, deleteAddressAction } from '../../shop-actions/addresses';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'お届け先の住所' };

// お届け先の住所（宅配）。一覧・追加・削除。住所は個人情報（本人の画面にだけ出す。ログ・URL・エラー文に出さない）
export default async function AddressesPage() {
  const result = await loadAddressesPage(await getShopCtx());
  return (
    <>
      <h1>お届け先の住所</h1>
      <p className="lead">宅配でお届けする住所を登録します。宅配のカートで、登録した住所から選べます。（住所はダミーです。実在の住所を入れないでください）</p>
      {result.ok ? (
        <AddressManager addresses={result.data.addresses} zones={result.data.zones} createAction={createAddressAction} deleteAction={deleteAddressAction} />
      ) : (
        <LoadError error={result.error} status={result.status} />
      )}
    </>
  );
}

import Link from 'next/link';
import type { Address } from '../../lib/contract';
import { MAX_ADDRESSES } from '../../lib/shop/constants';
import type { FormAction } from '../../lib/shop/types';
import type { Zone } from '../../lib/types';
import { AddressForm } from './AddressForm';
import { DeleteAddressForm } from './DeleteAddressForm';

/**
 * お届け先の住所の管理（一覧・追加・削除）。住所（番地・メモ）は個人情報で、本人の画面にだけ出す。
 * zones はエリアの選択肢（読めなければ null。追加フォームは出さない）
 */
export function AddressManager({ addresses, zones, createAction, deleteAction }: { addresses: Address[]; zones: Zone[] | null; createAction: FormAction; deleteAction: FormAction }) {
  const full = addresses.length >= MAX_ADDRESSES;
  return (
    <div className="shop-addresses">
      <section aria-labelledby="addr-list">
        <h2 id="addr-list">
          登録した住所（{addresses.length} / {MAX_ADDRESSES} 件）
        </h2>
        {addresses.length === 0 ? (
          <p className="muted">まだ住所がありません。下のフォームから登録してください。</p>
        ) : (
          <ul className="shop-address-list">
            {addresses.map((a) => (
              <li key={a.id} className="card">
                <p className="card-title">{a.label}</p>
                <dl className="shop-dl">
                  <div>
                    <dt>エリア</dt>
                    <dd>{a.area_name}</dd>
                  </div>
                  <div>
                    <dt>住所</dt>
                    <dd>{a.line}</dd>
                  </div>
                  {a.note ? (
                    <div>
                      <dt>メモ</dt>
                      <dd>{a.note}</dd>
                    </div>
                  ) : null}
                </dl>
                <DeleteAddressForm addressId={a.id} label={a.label} action={deleteAction} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="shop-panel" aria-labelledby="addr-new">
        <h2 id="addr-new">住所を追加する</h2>
        {full ? (
          <p className="shop-warn" role="status">
            住所は {MAX_ADDRESSES} 件まで登録できます。使わない住所を削除すると、追加できます。
          </p>
        ) : zones === null ? (
          <p className="shop-warn" role="alert">
            エリアの一覧を読み込めませんでした。しばらくしてから、もう一度開いてください。
          </p>
        ) : (
          <AddressForm zones={zones} action={createAction} />
        )}
      </section>

      <p>
        <Link href="/cart" className="shop-link-btn">
          カートへ戻る
        </Link>
      </p>
    </div>
  );
}

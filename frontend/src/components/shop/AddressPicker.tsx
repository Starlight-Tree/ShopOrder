import Link from 'next/link';
import type { Address } from '../../lib/contract';
import { addressChoice } from '../../lib/shop/delivery-view';
import type { FormAction } from '../../lib/shop/types';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

/**
 * 宅配のお届け先の選択（カートの住所。PUT /api/cart）。住所の本文（番地・メモ）は出さず、ラベルとエリアだけ。
 * 店が届けないエリアの住所は、理由つきで選べない（最終の判断は API）
 */
export function AddressPicker({ addresses, selectedId, served, action }: { addresses: Address[] | null; selectedId: number | null; served: ReadonlySet<number> | null; action: FormAction }) {
  return (
    <section aria-labelledby="cart-address">
      <h3 id="cart-address">お届け先の住所を選ぶ</h3>
      {addresses === null ? (
        <p className="shop-warn" role="alert">
          住所を読み込めませんでした。しばらくしてから、もう一度開いてください。
        </p>
      ) : addresses.length === 0 ? (
        <p>登録した住所がありません。先に住所を登録してください。</p>
      ) : (
        <ul className="shop-choices">
          {addresses.map((a) => {
            const choice = addressChoice(a, served);
            const reasonId = `address-${a.id}-reason`;
            return (
              <li key={a.id} className={`shop-choice${a.id === selectedId ? ' shop-choice-on' : ''}`}>
                <div className="shop-choice-info">
                  <p className="card-title">{a.label}</p>
                  <p className="muted">{a.area_name}</p>
                  {choice.selectable ? null : (
                    <p id={reasonId} className="shop-store-reason">
                      {choice.reason}
                    </p>
                  )}
                </div>
                {a.id === selectedId ? (
                  <span className="shop-tag-ok">選択中</span>
                ) : choice.selectable ? (
                  <ActionForm action={action} className="shop-choice-form">
                    <input type="hidden" name="address_id" value={a.id} />
                    <SubmitButton kind="secondary" ariaLabel={`${a.label}をお届け先にする`} pendingLabel="選んでいます…">
                      この住所にする
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <button type="button" className="shop-btn shop-btn-secondary" disabled aria-label={`${a.label}は選べません`} aria-describedby={reasonId}>
                    選べません
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p>
        <Link href="/addresses" className="shop-link-btn">
          {addresses !== null && addresses.length === 0 ? '住所を登録する' : '住所を追加・削除する'}
        </Link>
      </p>
    </section>
  );
}

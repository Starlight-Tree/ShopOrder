import Link from 'next/link';
import type { Cart, Fulfillment } from '../../lib/contract';
import { formatLumi } from '../../lib/format';
import { describeError } from '../../lib/shop/errors';
import { FULFILLMENT_LABEL, FULFILLMENTS } from '../../lib/shop/delivery-labels';
import { feeText, servedAreaCodes, slotLabel } from '../../lib/shop/delivery-view';
import type { CartPageData } from '../../lib/shop/queries';
import type { FormAction } from '../../lib/shop/types';
import { ActionForm } from './ActionForm';
import { AddressPicker } from './AddressPicker';
import { SlotPicker } from './SlotPicker';
import { SubmitButton } from './SubmitButton';

export type FulfillmentActions = { fulfillment: FormAction; address: FormAction; slot: FormAction };

/** この店・今の状態で、その受け取り方法を選べない理由（選べるなら null）。最終の判断は API（宅配の issues・409） */
function methodReason(fulfillment: Fulfillment, cart: Cart, zones: CartPageData['zones']): string | null {
  if (fulfillment === 'pickup') return null;
  if (!cart.store) return '先に、受け取る店を選んでください';
  if (zones !== null && zones.length === 0) return 'この店は宅配をしていません';
  return null;
}

function Methods({ cart, zones, action }: { cart: Cart; zones: CartPageData['zones']; action: FormAction }) {
  return (
    <ul className="shop-methods" aria-label="受け取り方法">
      {FULFILLMENTS.map((f) => {
        const on = cart.fulfillment === f;
        const reason = on ? null : methodReason(f, cart, zones);
        const reasonId = `method-${f}-reason`;
        return (
          <li key={f} className={`shop-method${on ? ' shop-method-on' : ''}`}>
            <div className="shop-choice-info">
              <p className="card-title">{FULFILLMENT_LABEL[f]}</p>
              {reason ? (
                <p id={reasonId} className="shop-store-reason">
                  {reason}
                </p>
              ) : null}
            </div>
            {on ? (
              <span className="shop-tag-ok">選択中</span>
            ) : reason ? (
              <button type="button" className="shop-btn shop-btn-secondary" disabled aria-label={`${FULFILLMENT_LABEL[f]}は選べません`} aria-describedby={reasonId}>
                選べません
              </button>
            ) : (
              <ActionForm action={action} className="shop-choice-form">
                <input type="hidden" name="fulfillment" value={f} />
                <SubmitButton kind="secondary" ariaLabel={`受け取り方法を${FULFILLMENT_LABEL[f]}にする`} pendingLabel="切り替えています…">
                  この方法にする
                </SubmitButton>
              </ActionForm>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 宅配の選択の要約（お届け先・時間枠・送料・無料になる金額・最低注文額） */
function DeliverySummary({ cart }: { cart: Cart }) {
  const d = cart.delivery;
  const zone = d?.zone ?? null;
  return (
    <dl className="shop-dl">
      <div>
        <dt>お届け先</dt>
        <dd>{d?.address ? `${d.address.label}（${d.address.area_name}）` : '未選択'}</dd>
      </div>
      <div>
        <dt>お届けの時間枠</dt>
        <dd>{d?.slot ? slotLabel(d.slot) : '未選択'}</dd>
      </div>
      <div>
        <dt>送料</dt>
        <dd>{zone ? feeText(cart.delivery_fee_lumi) : 'お届け先を選ぶと表示されます'}</dd>
      </div>
      {zone ? (
        <>
          <div>
            <dt>送料が無料になる金額</dt>
            <dd>{zone.free_over_lumi === null ? '設定なし' : `品の小計が ${formatLumi(zone.free_over_lumi)}以上`}</dd>
          </div>
          <div>
            <dt>最低注文額</dt>
            <dd>{formatLumi(zone.min_order_lumi)}（品の小計。送料を除く）</dd>
          </div>
        </>
      ) : null}
    </dl>
  );
}

/**
 * カートの「受け取り」: 店・受け取り方法（店頭・宅配）。宅配なら、お届け先・時間枠・送料の案内。
 * 画面で絞るのは表示だけ（宅配をしない店・届かない住所を選べなくする）。通すかどうかは、API が毎回決める。
 */
export function FulfillmentPanel({ data, actions }: { data: CartPageData; actions: FulfillmentActions }) {
  const { cart, zones, delivery } = data;
  const served = servedAreaCodes(zones);
  return (
    <section className="shop-panel" aria-labelledby="cart-store">
      <h2 id="cart-store">受け取り</h2>
      <dl className="shop-dl">
        <div>
          <dt>受け取る店</dt>
          <dd>
            {cart.store ? cart.store.name : '未選択'}
            <Link href="/" className="shop-link-btn">
              {cart.store ? '店を変える' : '店を選ぶ'}
            </Link>
          </dd>
        </div>
      </dl>
      <Methods cart={cart} zones={zones} action={actions.fulfillment} />
      {cart.fulfillment === 'delivery' && cart.store ? (
        zones !== null && zones.length === 0 ? (
          <p className="shop-warn" role="alert">
            {describeError({ code: 'delivery_unavailable' }).text}
          </p>
        ) : (
          <div className="shop-delivery">
            <DeliverySummary cart={cart} />
            {delivery ? (
              <>
                <AddressPicker addresses={delivery.addresses} selectedId={cart.delivery?.address?.id ?? null} served={served} action={actions.address} />
                <SlotPicker
                  days={delivery.days}
                  date={delivery.date}
                  slots={delivery.slots}
                  failed={delivery.slotsFailed}
                  hasAddress={cart.delivery?.address != null}
                  selectedSlotId={cart.delivery?.slot?.id ?? null}
                  action={actions.slot}
                />
              </>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}

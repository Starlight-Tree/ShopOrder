import Link from 'next/link';
import type { CartLine } from '../../lib/contract';
import { formatLumi } from '../../lib/format';
import { MAX_LINE_QTY } from '../../lib/shop/constants';
import { freeShippingNote } from '../../lib/shop/delivery-view';
import { unavailableReasonText, variantLabel } from '../../lib/shop/labels';
import type { CartPageData } from '../../lib/shop/queries';
import type { FormAction } from '../../lib/shop/types';
import { checkoutBlockers } from '../../lib/shop/view';
import { ActionForm } from './ActionForm';
import { FulfillmentPanel, type FulfillmentActions } from './FulfillmentPanel';
import { SubmitButton } from './SubmitButton';
import { Totals } from './Totals';

export type CartActions = FulfillmentActions & { qty: FormAction };

/** 行ごとの数量（−・＋・削除）。PUT /api/cart/items/{variant_id} へ、絶対値で送る */
function CartLineRow({ line, qtyAction }: { line: CartLine; qtyAction: FormAction }) {
  return (
    <li className="shop-line">
      <div className="shop-line-main">
        <p className="card-title">{line.name}</p>
        <p className="muted">
          {variantLabel(line)}・{formatLumi(line.unit_price_lumi)}
        </p>
      </div>
      {line.available ? null : (
        <p className="shop-warn shop-line-warn" role="status">
          <strong>今は注文できません</strong>（{unavailableReasonText(line.unavailable_reason)}）。「削除」で、カートから外してください。
        </p>
      )}
      <ActionForm action={qtyAction} className="shop-line-form">
        <input type="hidden" name="variant_id" value={line.variant_id} />
        <div className="shop-qty" role="group" aria-label={`${line.name}の数量`}>
          <SubmitButton kind="secondary" name="qty" value={line.qty - 1} disabled={line.qty <= 1} ariaLabel={`${line.name}を 1 つ減らす`}>
            −
          </SubmitButton>
          <span className="shop-qty-value">
            {line.qty}
            <span className="shop-sr-only"> 個</span>
          </span>
          <SubmitButton kind="secondary" name="qty" value={line.qty + 1} disabled={line.qty >= MAX_LINE_QTY || !line.available} ariaLabel={`${line.name}を 1 つ増やす`}>
            ＋
          </SubmitButton>
        </div>
        <SubmitButton kind="text" name="qty" value={0} ariaLabel={`${line.name}をカートから削除する`}>
          削除
        </SubmitButton>
      </ActionForm>
      <p className="shop-line-total">{formatLumi(line.line_total_lumi)}</p>
    </li>
  );
}

/** カート: 行・小計・送料・合計・店・受け取り方法（店頭・宅配。宅配はお届け先と時間枠）・「注文内容を確認する」 */
export function CartView({ data, actions }: { data: CartPageData; actions: CartActions }) {
  const { cart, store } = data;
  if (cart.lines.length === 0) {
    return (
      <div className="notice">
        <p>カートは空です。</p>
        <p>
          <Link href="/" className="shop-btn shop-btn-primary">
            メニューを見る
          </Link>
        </p>
      </div>
    );
  }
  const blockers = checkoutBlockers(cart, store);
  const hasUnavailable = cart.lines.some((l) => !l.available);
  const freeNote = freeShippingNote(cart.delivery, cart.subtotal_lumi);
  return (
    <div className="shop-cart">
      {hasUnavailable ? (
        <p className="shop-warn" role="alert">
          今は注文できない品が入っています。該当の品を削除すると、注文に進めます。
        </p>
      ) : null}

      <FulfillmentPanel data={data} actions={actions} />

      <section aria-labelledby="cart-lines">
        <h2 id="cart-lines">ご注文の品</h2>
        <ul className="shop-lines">
          {cart.lines.map((line) => (
            <CartLineRow key={line.variant_id} line={line} qtyAction={actions.qty} />
          ))}
        </ul>
      </section>

      <section className="shop-panel" aria-labelledby="cart-total">
        <h2 id="cart-total">お支払い金額</h2>
        <Totals subtotalLumi={cart.subtotal_lumi} feeLumi={cart.delivery_fee_lumi} totalLumi={cart.total_lumi} delivery={cart.fulfillment === 'delivery'} feeKnown={cart.fulfillment !== 'delivery' || Boolean(cart.delivery?.zone)} />
        {freeNote ? <p className="muted">{freeNote}</p> : null}
        {blockers.length === 0 ? (
          <p>
            <Link href="/checkout" prefetch={false} className="shop-btn shop-btn-primary shop-btn-block">
              注文内容を確認する
            </Link>
          </p>
        ) : (
          <div>
            <button type="button" className="shop-btn shop-btn-primary shop-btn-block" disabled aria-describedby="cart-blockers">
              注文内容を確認する
            </button>
            <ul id="cart-blockers" className="shop-blockers">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

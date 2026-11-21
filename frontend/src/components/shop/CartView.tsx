import Link from 'next/link';
import type { Cart, CartLine } from '../../lib/contract';
import { formatLumi } from '../../lib/format';
import { MAX_LINE_QTY } from '../../lib/shop/constants';
import { unavailableReasonText, variantLabel } from '../../lib/shop/labels';
import type { FormAction } from '../../lib/shop/types';
import { checkoutBlockers } from '../../lib/shop/view';
import type { Store } from '../../lib/types';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

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

/** カート: 行・小計・合計・店・受け取り方法（店頭のみ）・「注文内容を確認する」 */
export function CartView({ cart, store, qtyAction }: { cart: Cart; store: Store | null; qtyAction: FormAction }) {
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
  return (
    <div className="shop-cart">
      {hasUnavailable ? (
        <p className="shop-warn" role="alert">
          今は注文できない品が入っています。該当の品を削除すると、注文に進めます。
        </p>
      ) : null}

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
          <div>
            <dt>受け取り方法</dt>
            <dd>
              <ul className="shop-methods">
                <li className="shop-method shop-method-on">
                  店頭でお渡し <span className="shop-tag-ok">選択中</span>
                </li>
                <li className="shop-method shop-method-off">
                  宅配 <span className="tag">準備中</span>
                </li>
              </ul>
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="cart-lines">
        <h2 id="cart-lines">ご注文の品</h2>
        <ul className="shop-lines">
          {cart.lines.map((line) => (
            <CartLineRow key={line.variant_id} line={line} qtyAction={qtyAction} />
          ))}
        </ul>
      </section>

      <section className="shop-panel" aria-labelledby="cart-total">
        <h2 id="cart-total">お支払い金額</h2>
        <dl className="shop-totals">
          <div>
            <dt>小計</dt>
            <dd>{formatLumi(cart.subtotal_lumi)}</dd>
          </div>
          {cart.delivery_fee_lumi > 0 ? (
            <div>
              <dt>送料</dt>
              <dd>{formatLumi(cart.delivery_fee_lumi)}</dd>
            </div>
          ) : null}
          <div className="shop-total-row">
            <dt>合計</dt>
            <dd>{formatLumi(cart.total_lumi)}</dd>
          </div>
        </dl>
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

import Link from 'next/link';
import type { CheckoutProposal } from '../../lib/contract';
import { formatLumi } from '../../lib/format';
import { PIN_PREVIEW, fulfillmentText } from '../../lib/shop/delivery-labels';
import { slotLabel } from '../../lib/shop/delivery-view';
import { formatClock } from '../../lib/shop/format';
import { variantLabel } from '../../lib/shop/labels';
import type { FormAction } from '../../lib/shop/types';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';
import { Totals } from './Totals';

/**
 * 確認カード（店・受け取り方法・品・送料・合計）と、「注文を確定する」ボタン。宅配は、お届け先（ラベルとエリア）と時間枠も出す。
 * 確定の API を呼べるのは、このボタンだけ。冪等キーは、確認画面を描いたときに作って、フォームに持たせる
 * （二重クリック・再送でも、注文は 1 つ）。
 */
export function CheckoutCard({ proposal, idempotencyKey, confirmAction }: { proposal: CheckoutProposal; idempotencyKey: string; confirmAction: FormAction }) {
  const until = formatClock(proposal.expires_at);
  const isDelivery = proposal.fulfillment === 'delivery';
  const delivery = isDelivery ? proposal.delivery : null;
  return (
    <article className="shop-panel shop-checkout" aria-labelledby="checkout-title">
      <h2 id="checkout-title">ご注文内容の確認</h2>
      <dl className="shop-dl">
        <div>
          <dt>受け取る店</dt>
          <dd>{proposal.store.name}</dd>
        </div>
        <div>
          <dt>受け取り方法</dt>
          <dd>{fulfillmentText(proposal.fulfillment)}</dd>
        </div>
        {delivery ? (
          <>
            <div>
              <dt>お届け先</dt>
              <dd>{delivery.address ? `${delivery.address.label}（${delivery.address.area_name}）` : '未選択'}</dd>
            </div>
            <div>
              <dt>お届けの時間枠</dt>
              <dd>{delivery.slot ? slotLabel(delivery.slot) : '未選択'}</dd>
            </div>
          </>
        ) : null}
      </dl>
      <ul className="shop-lines shop-lines-compact">
        {proposal.lines.map((l) => (
          <li key={l.variant_id} className="shop-line shop-line-compact">
            <div className="shop-line-main">
              <p className="card-title">{l.name}</p>
              <p className="muted">
                {variantLabel(l)}・{formatLumi(l.unit_price_lumi)} × {l.qty}
              </p>
            </div>
            <p className="shop-line-total">{formatLumi(l.line_total_lumi)}</p>
          </li>
        ))}
      </ul>
      <Totals subtotalLumi={proposal.subtotal_lumi} feeLumi={proposal.delivery_fee_lumi} totalLumi={proposal.total_lumi} delivery={isDelivery} compact={!isDelivery} />
      <p className="muted">
        「注文を確定する」を押すと、注文が確定し、在庫{isDelivery ? 'とお届けの時間枠' : ''}が一定時間確保されます。お支払い（模擬）は、次の画面で行います。
        {until ? `この確認は ${until} まで有効です。` : null}
      </p>
      {isDelivery ? <p className="muted">{PIN_PREVIEW}</p> : null}
      <ActionForm key={idempotencyKey} action={confirmAction} className="shop-confirm-form">
        <input type="hidden" name="proposal_id" value={proposal.id} />
        <input type="hidden" name="idempotency_key" value={idempotencyKey} />
        <SubmitButton pendingLabel="確定しています…">注文を確定する</SubmitButton>
        <Link href="/cart" prefetch={false} className="shop-btn shop-btn-secondary">
          カートに戻る
        </Link>
      </ActionForm>
    </article>
  );
}

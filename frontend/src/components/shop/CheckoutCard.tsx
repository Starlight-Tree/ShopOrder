import Link from 'next/link';
import type { CheckoutProposal } from '../../lib/contract';
import { formatLumi } from '../../lib/format';
import { formatClock } from '../../lib/shop/format';
import { variantLabel } from '../../lib/shop/labels';
import type { FormAction } from '../../lib/shop/types';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

/**
 * 確認カード（店・品・合計・店頭でお渡し）と、「注文を確定する」ボタン。
 * 確定の API を呼べるのは、このボタンだけ。冪等キーは、確認画面を描いたときに作って、フォームに持たせる
 * （二重クリック・再送でも、注文は 1 つ）。
 */
export function CheckoutCard({ proposal, idempotencyKey, confirmAction }: { proposal: CheckoutProposal; idempotencyKey: string; confirmAction: FormAction }) {
  const until = formatClock(proposal.expires_at);
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
          <dd>店頭でお渡し</dd>
        </div>
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
      <dl className="shop-totals">
        <div className="shop-total-row">
          <dt>合計</dt>
          <dd>{formatLumi(proposal.total_lumi)}</dd>
        </div>
      </dl>
      <p className="muted">
        「注文を確定する」を押すと、注文が確定し、在庫が一定時間確保されます。お支払い（模擬）は、次の画面で行います。
        {until ? `この確認は ${until} まで有効です。` : null}
      </p>
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

import type { Order } from '../../lib/contract';
import { FAILED_GUIDANCE, PIN_GUIDANCE, failureReasonText } from '../../lib/shop/delivery-labels';
import { slotLabel, visiblePin } from '../../lib/shop/delivery-view';
import { formatClock } from '../../lib/shop/format';

/**
 * 暗証コード（集荷後だけ。picked_up・delivering）。目立たせ、配達員にだけ伝えるよう添える。
 * コードは、この要素の文字以外（URL・属性・ログ）に出さない。スクリーンリーダーには、1 桁ずつ読ませる
 */
function PinBox({ pin }: { pin: string }) {
  return (
    <div className="shop-pin" role="group" aria-labelledby="pin-title">
      <p id="pin-title" className="shop-pin-title">
        受け取り用の暗証コード
      </p>
      <p className="shop-pin-code">
        <span aria-hidden="true">{pin}</span>
        <span className="shop-sr-only">{pin.split('').join(' ')}</span>
      </p>
      <p className="shop-pin-note">{PIN_GUIDANCE}</p>
    </div>
  );
}

/** 宅配の注文の「お届けの状況」: お届け先（ラベル）・時間枠・到着の目安・配達員の名前・暗証コード・お届けできなかったときの案内 */
export function DeliverySection({ order }: { order: Order }) {
  const d = order.delivery;
  if (order.fulfillment !== 'delivery' || !d || order.status === 'cancelled') return null;
  const pin = visiblePin(order.status, d.pin);
  const failed = order.status === 'delivery_failed' || d.status === 'failed';
  const eta = d.eta_at ? formatClock(d.eta_at) : '';
  return (
    <section className="shop-panel" aria-labelledby="delivery-title">
      <h2 id="delivery-title">お届けの状況</h2>
      {failed ? (
        <div className="shop-failed" role="status">
          <p>
            <strong>お届けできませんでした</strong>
          </p>
          <p>{failureReasonText(d.failure_reason)}</p>
          <p>{FAILED_GUIDANCE}</p>
        </div>
      ) : null}
      {pin ? <PinBox pin={pin} /> : null}
      <dl className="shop-dl">
        <div>
          <dt>お届け先</dt>
          <dd>
            {d.address.label}（{d.zone.name}）
          </dd>
        </div>
        <div>
          <dt>お届けの時間枠</dt>
          <dd>{slotLabel(d.slot)}</dd>
        </div>
        {eta && !failed ? (
          <div>
            <dt>到着の目安</dt>
            <dd>{eta} ごろ</dd>
          </div>
        ) : null}
        <div>
          <dt>配達員</dt>
          <dd>{d.courier ? d.courier.name : '手配中です'}</dd>
        </div>
        {d.attempt > 1 ? (
          <div>
            <dt>配達の回数</dt>
            <dd>{d.attempt} 回目（再配達）</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

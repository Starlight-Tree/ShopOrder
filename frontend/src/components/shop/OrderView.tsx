import type { Order } from '../../lib/contract';
import { formatLumi } from '../../lib/format';
import { formatDateTime } from '../../lib/shop/format';
import { variantLabel } from '../../lib/shop/labels';
import { cancelReasonText, statusHeadline, statusLabel } from '../../lib/shop/order-steps';
import type { FormAction } from '../../lib/shop/types';
import { ActionForm } from './ActionForm';
import { CancelOrderForm } from './CancelOrderForm';
import { OrderAutoRefresh } from './OrderAutoRefresh';
import { OrderStepper } from './OrderStepper';
import { ReservationCountdown } from './ReservationCountdown';
import { SubmitButton } from './SubmitButton';

/** placed（確保済み・お支払い待ち）のときの、模擬の支払い・確保の残り時間 */
function PayPanel({ order, serverNow, devTools, payAction }: { order: Order; serverNow: string; devTools: boolean; payAction: FormAction }) {
  return (
    <section className="shop-panel" aria-labelledby="pay-title">
      <h2 id="pay-title">お支払い（模擬）</h2>
      <p>
        お支払い金額は <strong className="price">{formatLumi(order.total_lumi)}</strong> です。実際のお支払いは行われません（模擬）。
      </p>
      {order.reservation_expires_at ? (
        <p>
          在庫の確保：<ReservationCountdown expiresAt={order.reservation_expires_at} serverNow={serverNow} />
        </p>
      ) : null}
      <ActionForm action={payAction} className="shop-pay-form">
        <input type="hidden" name="public_id" value={order.public_id} />
        <input type="hidden" name="simulate" value="ok" />
        <SubmitButton disabled={!order.can_pay} pendingLabel="お支払い中…">
          支払う（模擬）
        </SubmitButton>
        {order.can_pay ? null : <p className="muted">いまはお支払いできません。画面が更新されるまで、お待ちください。</p>}
      </ActionForm>
      {devTools ? (
        <ActionForm action={payAction} className="shop-pay-form shop-dev">
          <input type="hidden" name="public_id" value={order.public_id} />
          <input type="hidden" name="simulate" value="decline" />
          <span className="tag">開発用</span>
          <SubmitButton kind="secondary" disabled={!order.can_pay}>
            支払いを失敗させる（模擬）
          </SubmitButton>
        </ActionForm>
      ) : null}
    </section>
  );
}

/** 注文の画面: 受け取り番号（大きく）・状態の進み・品・合計。状態は API の status から描く */
export function OrderView({
  order,
  serverNow,
  devTools,
  payAction,
  cancelAction,
  notice,
}: {
  order: Order;
  /** サーバーが画面を作った時刻（ISO）。カウントダウンの時計のずれを補う */
  serverNow: string;
  devTools: boolean;
  payAction: FormAction;
  cancelAction: FormAction;
  /** 画面の上に出す知らせ（支払いの失敗・確保の期限切れ） */
  notice?: string | null;
}) {
  const cancelled = order.status === 'cancelled';
  const reason = cancelled ? cancelReasonText(order.cancel_reason) : null;
  return (
    <article className="shop-order" aria-labelledby="order-title">
      <header className="shop-order-head">
        <h1 id="order-title" className="shop-sr-only">
          ご注文の状況
        </h1>
        <p className="muted">受け取り番号</p>
        <p className="shop-pickup-no" aria-label={`受け取り番号 ${order.pickup_no}`}>
          {order.pickup_no}
        </p>
        <p className="shop-status" role="status">
          <span className={`shop-status-badge shop-status-${order.status}`}>{statusLabel(order.status)}</span>
          {statusHeadline(order.status)}
        </p>
        <p className="muted">
          {order.store.name}・注文番号 {order.public_id}
        </p>
      </header>

      {notice ? (
        <p className="shop-msg shop-msg-error" role="alert">
          {notice}
        </p>
      ) : null}

      {cancelled ? (
        <section className="shop-panel shop-cancelled" aria-labelledby="cancelled-title">
          <h2 id="cancelled-title">この注文は取消されました</h2>
          {reason ? <p>理由：{reason}</p> : null}
          <p className="muted">在庫の確保は戻されています。支払い済みだった場合は、返金されます。</p>
        </section>
      ) : (
        <OrderStepper status={order.status} events={order.events} />
      )}

      {order.status === 'placed' ? <PayPanel order={order} serverNow={serverNow} devTools={devTools} payAction={payAction} /> : null}

      <section className="shop-panel" aria-labelledby="order-items">
        <h2 id="order-items">ご注文の内容</h2>
        <ul className="shop-lines shop-lines-compact">
          {order.items.map((it, i) => (
            <li key={`${it.name}-${it.size}-${it.temperature}-${i}`} className="shop-line shop-line-compact">
              <div className="shop-line-main">
                <p className="card-title">{it.name}</p>
                <p className="muted">
                  {variantLabel(it)}・{formatLumi(it.unit_price_lumi)} × {it.qty}
                </p>
              </div>
              <p className="shop-line-total">{formatLumi(it.line_total_lumi)}</p>
            </li>
          ))}
        </ul>
        <dl className="shop-totals">
          <div>
            <dt>小計</dt>
            <dd>{formatLumi(order.subtotal_lumi)}</dd>
          </div>
          {order.delivery_fee_lumi > 0 ? (
            <div>
              <dt>送料</dt>
              <dd>{formatLumi(order.delivery_fee_lumi)}</dd>
            </div>
          ) : null}
          <div className="shop-total-row">
            <dt>合計</dt>
            <dd>{formatLumi(order.total_lumi)}</dd>
          </div>
        </dl>
        <dl className="shop-dl">
          <div>
            <dt>受け取り方法</dt>
            <dd>店頭でお渡し</dd>
          </div>
          <div>
            <dt>注文日時</dt>
            <dd>{formatDateTime(order.placed_at)}</dd>
          </div>
        </dl>
      </section>

      {order.can_cancel ? (
        <section className="shop-panel" aria-labelledby="cancel-title">
          <h2 id="cancel-title">注文の取消し</h2>
          <CancelOrderForm publicId={order.public_id} action={cancelAction} />
        </section>
      ) : null}

      <OrderAutoRefresh status={order.status} />
    </article>
  );
}

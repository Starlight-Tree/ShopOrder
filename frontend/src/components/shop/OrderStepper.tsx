import type { CSSProperties } from 'react';
import { orderSteps, eventTimes } from '../../lib/shop/order-steps';
import type { Fulfillment, OrderEvent, OrderStatus } from '../../lib/contract';
import { formatClock } from '../../lib/shop/format';

const STATE_LABEL = { done: '完了', current: '現在', upcoming: 'これから' } as const;

/**
 * 状態の進み。status から描く。取消しは別表示。
 * 店頭: placed → paid → accepted → preparing → ready → completed。
 * 宅配: ready のあとに、配達員の決定・集荷・配達中が続く。配達できなかったとき（delivery_failed）は、最後に「お届けできませんでした」を出す
 */
export function OrderStepper({ status, events, fulfillment = 'pickup' }: { status: OrderStatus; events: OrderEvent[]; fulfillment?: Fulfillment }) {
  const steps = orderSteps(status, fulfillment);
  if (!steps) return null;
  const times = eventTimes(events, fulfillment === 'delivery'); // 宅配は再配達で状態が繰り返される。今の配達の時刻を出す
  return (
    <ol
      className={`shop-steps${fulfillment === 'delivery' ? ' shop-steps-delivery' : ''}`}
      style={{ '--steps': steps.length } as CSSProperties}
      aria-label={fulfillment === 'delivery' ? '注文と配達の進み' : '注文の進み'}
    >
      {steps.map((s) => {
        const at = times[s.status];
        const clock = at ? formatClock(at) : '';
        return (
          <li key={s.status} className={`shop-step shop-step-${s.state}${s.status === 'delivery_failed' ? ' shop-step-failed' : ''}`} aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className="shop-step-dot" aria-hidden="true" />
            <span className="shop-step-label">{s.label}</span>
            <span className="shop-sr-only">（{STATE_LABEL[s.state]}）</span>
            {clock && s.state !== 'upcoming' ? <span className="shop-step-time muted">{clock}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

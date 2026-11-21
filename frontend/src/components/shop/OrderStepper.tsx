import { orderSteps, eventTimes } from '../../lib/shop/order-steps';
import type { OrderEvent, OrderStatus } from '../../lib/contract';
import { formatClock } from '../../lib/shop/format';

const STATE_LABEL = { done: '完了', current: '現在', upcoming: 'これから' } as const;

/** 状態の進み（placed → paid → accepted → preparing → ready → completed）。status から描く。取消しは別表示 */
export function OrderStepper({ status, events }: { status: OrderStatus; events: OrderEvent[] }) {
  const steps = orderSteps(status);
  if (!steps) return null;
  const times = eventTimes(events);
  return (
    <ol className="shop-steps" aria-label="注文の進み">
      {steps.map((s) => {
        const at = times[s.status];
        const clock = at ? formatClock(at) : '';
        return (
          <li key={s.status} className={`shop-step shop-step-${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
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

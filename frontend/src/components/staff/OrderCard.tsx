'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { StaffAction, StaffOrder } from '../../lib/contract';
import { DEFAULT_UTC_OFFSET_HOURS, DELIVERY_STATUS_LABELS, deliveryOf, slotText } from '../../lib/staff/dispatch';
import { actionButtons, elapsedMinutes, formatElapsed, isOverdue, itemSpec, OVERDUE_MINUTES } from '../../lib/staff/orders';
import { CancelForm } from './dispatch/CancelForm';

type Props = {
  order: StaffOrder;
  /** 表示の基準の時刻（サーバーの現在。5 秒ごとの取り直しで進む）。クライアントの時計は使わない */
  now: string;
  /** 宅配の枠の時刻を出すための、店のローカル時刻の UTC からの差（時間） */
  utcOffsetHours?: number;
  busy: boolean;
  /** 遷移を実行する。成功したら true */
  onAct: (order: StaffOrder, action: StaffAction, reason?: string) => Promise<boolean>;
};

/**
 * 注文 1 件のカード。顧客の個人情報は出さない（受け取り番号・品・経過時間・操作だけ）。
 * 注文の内容（order）のうち、ここで描く項目だけを使う。
 * 宅配の注文には「宅配」の印・配達の状態・枠の時刻を添える。操作は allowed_actions だけに従う（宅配は complete が無く、配達員の割り当ては配車ボードで行う）。
 */
export function OrderCard({ order, now, utcOffsetHours = DEFAULT_UTC_OFFSET_HOURS, busy, onAct }: Props) {
  const delivery = deliveryOf(order);
  const minutes = elapsedMinutes(order.placed_at, now);
  // 「注文から 10 分超」は、店頭の受け取りの目安。宅配は枠の時刻で動くので、強調しない
  const overdue = delivery === null && isOverdue(minutes);
  const buttons = actionButtons(order.allowed_actions ?? []);
  const [cancelOpen, setCancelOpen] = useState(false);

  return (
    <li className={`st-card${overdue ? ' is-overdue' : ''}`} data-status={order.status}>
      <article aria-label={`受け取り番号 ${order.pickup_no}`}>
        <div className="st-card-head">
          <p className="st-pickup">
            <span className="st-pickup-label">受け取り番号</span>
            <span className="st-pickup-no">{order.pickup_no}</span>
          </p>
          <p className="st-elapsed">
            <span className="st-elapsed-label">経過</span>
            <span className="st-elapsed-value">{formatElapsed(minutes)}</span>
            {overdue ? <span className="tag tag-warn">{OVERDUE_MINUTES} 分超</span> : null}
          </p>
        </div>
        {delivery ? (
          <p className="st-delivery-mark">
            <span className="tag tag-delivery">宅配</span>
            <span className="tag">{DELIVERY_STATUS_LABELS[delivery.status] ?? delivery.status}</span>
            <span className="st-delivery-slot">枠 {slotText(delivery.slot, now, utcOffsetHours)}</span>
            {order.status === 'ready' ? (
              <Link className="st-delivery-link" href="/staff/dispatch">
                配車で割り当てる
              </Link>
            ) : null}
          </p>
        ) : null}
        <ul className="st-items">
          {order.items.map((item, i) => {
            const spec = itemSpec(item);
            return (
              <li key={`${item.name}-${item.size}-${item.temperature}-${i}`}>
                <span className="st-item-name">{item.name}</span>
                {spec ? <span className="st-item-spec">{spec}</span> : null}
                <span className="st-item-qty">
                  <span aria-hidden="true">× </span>
                  <span className="sr-only">数量 </span>
                  {item.qty}
                </span>
              </li>
            );
          })}
        </ul>
        {buttons.length > 0 ? (
          <div className="st-actions">
            {buttons.map((b) =>
              b.action === 'cancel' ? (
                <button
                  key={b.action}
                  type="button"
                  className="st-btn st-btn-danger-outline"
                  disabled={busy}
                  aria-expanded={cancelOpen}
                  onClick={() => setCancelOpen((v) => !v)}
                >
                  {b.label}
                </button>
              ) : (
                <button key={b.action} type="button" className="st-btn st-btn-primary" disabled={busy} onClick={() => void onAct(order, b.action)}>
                  {b.label}
                </button>
              ),
            )}
          </div>
        ) : null}
        {cancelOpen ? (
          <CancelForm
            busy={busy}
            hint="取り消すと、返金と在庫の確保の取り消しが行われます。"
            onSubmit={(reason) => onAct(order, 'cancel', reason)}
            onClose={() => setCancelOpen(false)}
          />
        ) : null}
      </article>
    </li>
  );
}

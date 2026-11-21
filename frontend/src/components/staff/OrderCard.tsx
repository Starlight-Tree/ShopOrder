'use client';
import { useId, useState, type FormEvent } from 'react';
import type { StaffAction, StaffOrder } from '../../lib/contract';
import { actionButtons, elapsedMinutes, formatElapsed, isOverdue, itemSpec, OVERDUE_MINUTES } from '../../lib/staff/orders';

type Props = {
  order: StaffOrder;
  /** 表示の基準の時刻（サーバーの現在。5 秒ごとの取り直しで進む）。クライアントの時計は使わない */
  now: string;
  busy: boolean;
  /** 遷移を実行する。成功したら true */
  onAct: (order: StaffOrder, action: StaffAction, reason?: string) => Promise<boolean>;
};

/**
 * 注文 1 件のカード。顧客の個人情報は出さない（受け取り番号・品・経過時間・操作だけ）。
 * 注文の内容（order）のうち、ここで描く項目だけを使う。
 */
export function OrderCard({ order, now, busy, onAct }: Props) {
  const minutes = elapsedMinutes(order.placed_at, now);
  const overdue = isOverdue(minutes);
  const buttons = actionButtons(order.allowed_actions ?? []);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonId = useId();
  const hintId = useId();

  async function submitCancel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = reason.trim();
    if (r === '') {
      setReasonError('取消しの理由を入力してください');
      return;
    }
    setReasonError(null);
    const ok = await onAct(order, 'cancel', r);
    if (ok) {
      setCancelOpen(false);
      setReason('');
    }
  }

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
          <form className="st-cancel" onSubmit={submitCancel} noValidate>
            <div className="st-field">
              <label htmlFor={reasonId}>取消しの理由（必須）</label>
              <input
                id={reasonId}
                type="text"
                value={reason}
                maxLength={100}
                required
                autoComplete="off"
                aria-describedby={hintId}
                aria-invalid={reasonError ? true : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
              <p id={hintId} className={reasonError ? 'st-field-error' : 'muted'} role={reasonError ? 'alert' : undefined}>
                {reasonError ?? '取り消すと、返金と在庫の確保の取り消しが行われます。'}
              </p>
            </div>
            <div className="st-actions">
              <button type="submit" className="st-btn st-btn-danger" disabled={busy}>
                取消しを確定する
              </button>
              <button
                type="button"
                className="st-btn st-btn-secondary"
                disabled={busy}
                onClick={() => {
                  setCancelOpen(false);
                  setReasonError(null);
                }}
              >
                やめる
              </button>
            </div>
          </form>
        ) : null}
      </article>
    </li>
  );
}

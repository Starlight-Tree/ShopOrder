'use client';
import { useId, useState, type FormEvent } from 'react';
import type { Courier, DispatchOrder } from '../../../lib/staff/delivery-types';
import {
  attemptLabel,
  canMockAdvance,
  courierChoices,
  defaultCourierId,
  DELIVERY_STATUS_LABELS,
  failureLabel,
  slotText,
  suggestionLabel,
} from '../../../lib/staff/dispatch';
import { DISPATCH_MSG } from '../../../lib/staff/dispatch-messages';
import { itemSpec } from '../../../lib/staff/orders';
import { CancelForm } from './CancelForm';

type Props = {
  order: DispatchOrder;
  /** 配車ボードの配達員（店をまたぐことがある。選択肢は、注文の店の分だけに絞る） */
  couriers: readonly Courier[];
  provider: 'mock' | 'inhouse';
  /** サーバーの現在（ISO 8601）。枠が今日かどうかの基準。クライアントの時計は使わない */
  now: string;
  utcOffsetHours: number;
  /** 店名を出す（全店の表示のとき） */
  showStore: boolean;
  /** どれかの操作の実行中。二重送信を防ぐため、ボード全体で押せなくする */
  busy: boolean;
  /** 各操作は、成功したら true */
  onAssign: (order: DispatchOrder, courierId: number) => Promise<boolean>;
  onRedeliver: (order: DispatchOrder) => Promise<boolean>;
  onMockAdvance: (order: DispatchOrder) => Promise<boolean>;
  onCancel: (order: DispatchOrder, reason: string) => Promise<boolean>;
};

/** 配達員の割り当て（選択 + ボタン）。勤務外の配達員は選べない。assigned のときは付け替え */
function AssignForm({ order, couriers, busy, onAssign }: Pick<Props, 'order' | 'couriers' | 'busy' | 'onAssign'>) {
  const choices = courierChoices(order, couriers);
  const hasOnDuty = choices.some((c) => !c.disabled);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const errorId = useId();
  // 触っていなければ、提案の配達員（更新で提案が変わっても追従する）
  const value = picked ?? defaultCourierId(order, choices);
  const reassign = order.status === 'assigned';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const chosen = choices.find((c) => String(c.id) === value);
    if (!chosen || chosen.disabled) {
      setError(DISPATCH_MSG.courierRequired);
      return;
    }
    setError(null);
    await onAssign(order, chosen.id);
  }

  return (
    <form className="st-assign" onSubmit={submit} noValidate>
      <div className="st-field">
        <label htmlFor={selectId}>{reassign ? '担当の付け替え' : '配達員'}</label>
        <select
          id={selectId}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setPicked(e.target.value);
            setError(null);
          }}
        >
          <option value="">選んでください</option>
          {choices.map((c) => (
            <option key={c.id} value={String(c.id)} disabled={c.disabled}>
              {c.label}
            </option>
          ))}
        </select>
        {error ? (
          <p id={errorId} className="st-field-error" role="alert">
            {error}
          </p>
        ) : null}
        {!hasOnDuty ? <p className="muted">{DISPATCH_MSG.noCourierOnDuty}</p> : null}
      </div>
      <button type="submit" className="st-btn st-btn-primary" disabled={busy || !hasOnDuty}>
        {reassign ? '付け替える' : '割り当てる'}
      </button>
    </form>
  );
}

/**
 * 配車ボードの注文 1 件。住所・暗証コードは API が返さないので、出さない（受け取り番号・品・枠・区画・担当・提案・理由だけ）。
 * 操作は allowed_actions（API が決める）に従って出す。mock のときだけ「模擬で 1 つ進める」。
 */
export function DispatchCard({ order, couriers, provider, now, utcOffsetHours, showStore, busy, onAssign, onRedeliver, onMockAdvance, onCancel }: Props) {
  const { delivery } = order;
  const allowed = order.allowed_actions;
  const [cancelOpen, setCancelOpen] = useState(false);
  const retry = attemptLabel(delivery.attempt);
  const failure = failureLabel(delivery.failure_reason);
  const canRedeliver = allowed.includes('redeliver');
  const canMock = canMockAdvance(provider, order.status, order.suggestion);
  const canCancel = allowed.includes('cancel');

  return (
    <li className="st-card" data-status={order.status}>
      <article aria-label={`受け取り番号 ${order.pickup_no}`}>
        <div className="st-card-head">
          <p className="st-pickup">
            <span className="st-pickup-label">受け取り番号</span>
            <span className="st-pickup-no">{order.pickup_no}</span>
          </p>
          <p className="st-slot">
            <span className="st-slot-label">配達の枠</span>
            <span className="st-slot-value">{slotText(delivery.slot, now, utcOffsetHours)}</span>
          </p>
        </div>
        <p className="st-tags">
          <span className="tag">{DELIVERY_STATUS_LABELS[delivery.status] ?? delivery.status}</span>
          <span className="tag">区画 {delivery.zone.name}</span>
          {showStore ? <span className="tag">{order.store.name}</span> : null}
          {retry ? <span className="tag tag-warn">{retry}</span> : null}
        </p>
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
        <dl className="st-facts">
          <div>
            <dt>担当</dt>
            <dd>{delivery.courier ? delivery.courier.name : '未割り当て'}</dd>
          </div>
          {order.suggestion ? (
            <div>
              <dt>提案</dt>
              <dd>{suggestionLabel(order.suggestion)}</dd>
            </div>
          ) : null}
          {failure ? (
            <div>
              <dt>失敗の理由</dt>
              <dd className="st-fact-strong">{failure}</dd>
            </div>
          ) : null}
        </dl>

        {allowed.includes('assign') ? <AssignForm order={order} couriers={couriers} busy={busy} onAssign={onAssign} /> : null}

        {canRedeliver || canMock || canCancel ? (
          <div className="st-actions">
            {canRedeliver ? (
              <button type="button" className="st-btn st-btn-primary" disabled={busy} onClick={() => void onRedeliver(order)}>
                再配達する（最も早い枠）
              </button>
            ) : null}
            {canMock ? (
              <button type="button" className="st-btn st-btn-secondary" disabled={busy} onClick={() => void onMockAdvance(order)}>
                模擬で 1 つ進める
              </button>
            ) : null}
            {canCancel ? (
              <button type="button" className="st-btn st-btn-danger-outline" disabled={busy} aria-expanded={cancelOpen} onClick={() => setCancelOpen((v) => !v)}>
                取消し
              </button>
            ) : null}
          </div>
        ) : null}
        {cancelOpen ? (
          <CancelForm busy={busy} hint={DISPATCH_MSG.cancelHint} onSubmit={(reason) => onCancel(order, reason)} onClose={() => setCancelOpen(false)} />
        ) : null}
      </article>
    </li>
  );
}

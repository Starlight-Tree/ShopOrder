'use client';
import { useId, useRef, useState, type FormEvent } from 'react';
import { attemptsLeftText, courierButtons, FAIL_REASONS, isFailReason, normalizePin, PIN_LENGTH, type FailReasonValue } from '../../lib/staff/courier';
import { COURIER_MSG, courierStatusLabel } from '../../lib/staff/courier-messages';
import type { CourierActionInput, CourierDelivery } from '../../lib/staff/delivery-types';
import { slotLabel } from '../../lib/staff/dispatch';
import { itemSpec } from '../../lib/staff/orders';

/** 操作の中身。配達の指定（publicId）は、カードが付ける */
export type CardAction = Omit<CourierActionInput, 'publicId'>;

type Props = {
  delivery: CourierDelivery;
  /** サーバーの現在（ISO 8601）。枠が今日かどうかの基準。クライアントの時計は使わない */
  now: string;
  /** 店のローカル時刻の時差（時間） */
  offsetHours: number;
  busy: boolean;
  /** 操作を実行する。通ったら true */
  onAct: (delivery: CourierDelivery, action: CardAction) => Promise<boolean>;
};

type Panel = 'deliver' | 'fail' | null;

/**
 * 配達 1 件のカード。受け取り番号・店・区画・枠・品・状態、集荷後だけ住所。ボタンは API の allowed_actions から決める。
 * 暗証コードは、ここの入力欄の中だけに置く（name を付けない = フォームの送信に載らず、URL にも出ない）。
 */
export function DeliveryCard({ delivery, now, offsetHours, busy, onAct }: Props) {
  const buttons = courierButtons(delivery.allowed_actions ?? []);
  const [panel, setPanel] = useState<Panel>(null);
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState<FailReasonValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const pinId = useId();
  const hintId = useId();
  const errorId = useId();
  const reasonGroup = useId();
  const pinInput = useRef<HTMLInputElement>(null);
  const attemptsText = attemptsLeftText(delivery.pin_attempts_left);

  /** 欄を開く・閉じる・切り替える。入力した暗証コードと選んだ理由は、そのたびに捨てる（開き直したときに前の値が出ないように） */
  function toggle(next: Exclude<Panel, null>) {
    setError(null);
    setPin('');
    setReason(null);
    setPanel((current) => (current === next ? null : next));
  }

  async function submitPin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const normalized = normalizePin(pin);
    if (normalized === null) {
      setError(COURIER_MSG.pinFormat);
      return;
    }
    setError(null);
    const ok = await onAct(delivery, { action: 'deliver', pin: normalized });
    setPin(''); // 通っても外れても、入力は残さない（誤りの後は、聞き直して入れ直す）
    if (ok) setPanel(null);
    else pinInput.current?.focus(); // 続けて入れ直せるよう、入力欄へ戻す（押したボタンに残さない）
  }

  async function submitFail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (!isFailReason(reason)) {
      setError(COURIER_MSG.reasonRequired);
      return;
    }
    setError(null);
    const ok = await onAct(delivery, { action: 'fail', reason });
    if (ok) {
      setPanel(null);
      setReason(null);
    }
  }

  return (
    <li className="cr-card" data-status={delivery.status}>
      <article aria-label={`受け取り番号 ${delivery.pickup_no}`}>
        <div className="cr-card-head">
          <p className="cr-pickup">
            <span className="cr-pickup-label">受け取り番号</span>
            <span className="cr-pickup-no">{delivery.pickup_no}</span>
          </p>
          <p className="cr-status">
            <span className="cr-status-label">状態</span>
            <span className="tag cr-status-tag">{courierStatusLabel(delivery.status)}</span>
          </p>
        </div>

        <dl className="cr-meta">
          <div>
            <dt>店</dt>
            <dd>{delivery.store.name}</dd>
          </div>
          <div>
            <dt>区画</dt>
            <dd>{delivery.zone.name}</dd>
          </div>
          <div>
            <dt>枠</dt>
            <dd>{slotLabel(delivery.slot, now, offsetHours)}</dd>
          </div>
        </dl>

        <ul className="cr-items">
          {delivery.items.map((item, i) => {
            const spec = itemSpec(item);
            return (
              <li key={`${item.name}-${item.size}-${item.temperature}-${i}`}>
                <span className="cr-item-name">{item.name}</span>
                {spec ? <span className="cr-item-spec">{spec}</span> : null}
                <span className="cr-item-qty">
                  <span aria-hidden="true">× </span>
                  <span className="sr-only">数量 </span>
                  {item.qty}
                </span>
              </li>
            );
          })}
        </ul>

        {delivery.address ? (
          <section className="cr-address" aria-label="お届け先">
            <p className="cr-address-label">{delivery.address.label}</p>
            <p className="cr-address-line">{delivery.address.line}</p>
            {delivery.address.note ? (
              <p className="cr-address-note">
                <span className="cr-address-note-label">メモ</span>
                {delivery.address.note}
              </p>
            ) : null}
          </section>
        ) : null}

        {buttons.length > 0 ? (
          <div className="cr-actions">
            {buttons.map((b) =>
              b.action === 'deliver' || b.action === 'fail' ? (
                <button
                  key={b.action}
                  type="button"
                  className={`st-btn cr-btn ${b.action === 'fail' ? 'st-btn-danger-outline' : 'st-btn-primary'}`}
                  disabled={busy}
                  aria-expanded={panel === b.action}
                  aria-controls={panel === b.action ? panelId : undefined}
                  onClick={() => toggle(b.action as 'deliver' | 'fail')}
                >
                  {b.label}
                </button>
              ) : (
                <button key={b.action} type="button" className="st-btn st-btn-primary cr-btn" disabled={busy} onClick={() => void onAct(delivery, { action: b.action })}>
                  {b.label}
                </button>
              ),
            )}
          </div>
        ) : null}

        {panel === 'deliver' ? (
          <form id={panelId} className="cr-panel" onSubmit={submitPin} noValidate>
            <div className="st-field">
              <label htmlFor={pinId}>お客さまから聞いた暗証コード（{PIN_LENGTH} 桁）</label>
              {/* name を付けない: フォームの値として送られず、JavaScript が無くても URL（クエリ）に出ない */}
              <input
                id={pinId}
                ref={pinInput}
                className="cr-pin-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={PIN_LENGTH + 2} // 前後の空白の分
                value={pin}
                autoFocus
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${hintId} ${errorId}` : hintId}
                onChange={(e) => {
                  setPin(e.target.value);
                  setError(null); // 直し始めたら、前のエラーは消す
                }}
              />
              <p id={hintId} className="muted">
                {attemptsText ?? `${PIN_LENGTH} 桁の数字で入力してください`}
              </p>
              {error ? (
                <p id={errorId} className="st-field-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="cr-actions">
              <button type="submit" className="st-btn st-btn-primary cr-btn" disabled={busy}>
                暗証コードを確認して完了
              </button>
              <button type="button" className="st-btn st-btn-secondary cr-btn" disabled={busy} onClick={() => toggle('deliver')}>
                やめる
              </button>
            </div>
          </form>
        ) : null}

        {panel === 'fail' ? (
          <form id={panelId} className="cr-panel" onSubmit={submitFail} noValidate>
            <fieldset className="cr-reasons" aria-describedby={error ? errorId : undefined}>
              <legend>理由を選んでください</legend>
              {FAIL_REASONS.map((r) => (
                <label key={r.value} className="cr-radio">
                  <input
                    type="radio"
                    name={reasonGroup}
                    value={r.value}
                    checked={reason === r.value}
                    onChange={() => {
                      setReason(r.value);
                      setError(null);
                    }}
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </fieldset>
            {error ? (
              <p id={errorId} className="st-field-error" role="alert">
                {error}
              </p>
            ) : (
              <p className="muted">報告すると、この配達は止まり、店へ戻ります。</p>
            )}
            <div className="cr-actions">
              <button type="submit" className="st-btn st-btn-danger cr-btn" disabled={busy}>
                この理由で店へ戻す
              </button>
              <button type="button" className="st-btn st-btn-secondary cr-btn" disabled={busy} onClick={() => toggle('fail')}>
                やめる
              </button>
            </div>
          </form>
        ) : null}
      </article>
    </li>
  );
}

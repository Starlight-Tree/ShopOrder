'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { COURIER_MSG, withPickupNo } from '../../lib/staff/courier-messages';
import type { CourierActionInput, CourierDelivery, DeliveryOutcome } from '../../lib/staff/delivery-types';
import { MSG } from '../../lib/staff/messages';
import { Notice } from '../staff/Notices';
import { REFRESH_INTERVAL_MS, useAutoRefresh } from '../staff/useAutoRefresh';
import { DeliveryCard, type CardAction } from './DeliveryCard';

/** 成功の文を、この時間（ミリ秒）のあと消す。失敗の文は、読むまで残す（閉じるボタンで消せる） */
export const OK_NOTICE_MS = 8000;

type Props = {
  /** null = 取得に失敗（errorMessage を出し、自動の再取得は続ける。取れていた一覧があれば、それを出し続ける） */
  deliveries: CourierDelivery[] | null;
  errorMessage?: string | null;
  /** サーバーの現在（ISO 8601）。枠の「今日」の基準 */
  now: string;
  /** 店のローカル時刻の時差（時間。LOCAL_UTC_OFFSET_HOURS） */
  offsetHours: number;
  onAct: (input: CourierActionInput) => Promise<DeliveryOutcome>;
};

type Message = { kind: 'ok' | 'error'; text: string };

/**
 * 配達員の担当の一覧。5 秒ごとにサーバーの描画を取り直す。操作の結果の文は、一覧の側に置く
 * （暗証コードの凍結などで、カードが一覧から消えても、文が残るように）。
 * 取り直しが 1 回失敗しても、最後に取れた一覧は出し続ける（入力中の暗証コード・開いた欄・集荷後の住所が、戸口で消えないように）。
 */
export function CourierBoard({ deliveries, errorMessage, now, offsetHours, onAct }: Props) {
  const router = useRouter();
  const refresh = useAutoRefresh();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Message | null>(null);
  // 二重送信を止める。state は次の描画まで変わらないので、同じ瞬間の 2 回目のクリックは ref で弾く
  const inFlight = useRef(false);
  // 最後に取れた一覧。取り直しの失敗（deliveries が null）のときに使う。同じ値を入れ直すだけなので、描画の中で書いてよい
  const lastDeliveries = useRef<CourierDelivery[] | null>(null);
  if (deliveries !== null) lastDeliveries.current = deliveries;
  const shown = deliveries ?? lastDeliveries.current;

  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const timer = setTimeout(() => setNotice((current) => (current === notice ? null : current)), OK_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  async function act(delivery: CourierDelivery, action: CardAction): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    let result: DeliveryOutcome;
    try {
      result = await onAct({ publicId: delivery.public_id, ...action });
    } catch {
      result = { ok: false, kind: 'error', message: MSG.generic, refresh: false };
    }
    inFlight.current = false;
    setPending(false);
    if (result.ok) {
      setNotice({ kind: 'ok', text: result.message });
      return true;
    }
    // 失敗の文には、どの配達かを付ける（成功の文は API の受け取り番号が付いている）
    setNotice({ kind: 'error', text: withPickupNo(delivery.pickup_no, result.message) });
    // 他の人が先に操作した・状態が変わった・暗証コードの回数が減った: 最新に取り直す
    if (result.refresh) router.refresh();
    return false;
  }

  return (
    <div className="cr-board">
      <div className="cr-toolbar">
        <p className="muted">{REFRESH_INTERVAL_MS / 1000} 秒ごとに自動で更新します</p>
        <button type="button" className="st-btn st-btn-secondary cr-btn cr-btn-small" onClick={refresh}>
          今すぐ更新
        </button>
      </div>

      {/* 結果の文は、常に存在する領域の中身を差し替える（領域ごと出すと、読み上げられないことがある） */}
      <div className="st-live" role="status" aria-live="polite" aria-atomic="true">
        {notice ? (
          <p className={`${notice.kind === 'error' ? 'st-message st-message-error' : 'st-message st-message-ok'} cr-message`}>
            <span className="cr-message-body">
              <span className="st-message-label">{notice.kind === 'error' ? '操作できませんでした' : '完了'}</span>
              {notice.text}
            </span>
            {notice.kind === 'error' ? (
              <button type="button" className="st-btn st-btn-secondary cr-btn cr-btn-small cr-dismiss" onClick={() => setNotice(null)}>
                {COURIER_MSG.dismiss}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>

      {shown === null ? (
        <Notice title={COURIER_MSG.loadFailed}>
          <p>{errorMessage ?? MSG.generic}</p>
          <p>{COURIER_MSG.retrying}</p>
        </Notice>
      ) : (
        <>
          {deliveries === null ? (
            <Notice title={COURIER_MSG.staleTitle}>
              <p>{errorMessage ?? MSG.generic}</p>
              <p>{COURIER_MSG.staleBody}</p>
            </Notice>
          ) : null}
          {shown.length === 0 ? (
            <div className="cr-empty">
              <p className="cr-empty-title">いま担当の配達はありません</p>
              <p className="muted">店が配達を割り当てると、ここに表示されます。</p>
            </div>
          ) : (
            <ul className="cr-card-list">
              {shown.map((delivery) => (
                <DeliveryCard key={delivery.public_id} delivery={delivery} now={now} offsetHours={offsetHours} busy={pending} onAct={act} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

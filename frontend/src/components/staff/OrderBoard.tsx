'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { StaffAction, StaffOrder } from '../../lib/contract';
import { MSG, transitionSuccessMessage } from '../../lib/staff/messages';
import { BOARD_STATUSES, COLUMN_LABELS, groupByStatus } from '../../lib/staff/orders';
import type { TransitionInput, TransitionResult } from '../../lib/staff/types';
import type { Store } from '../../lib/types';
import { Notice } from './Notices';
import { OrderCard } from './OrderCard';
import { StoreSelect } from './StoreSelect';
import { REFRESH_INTERVAL_MS, useAutoRefresh } from './useAutoRefresh';

type Props = {
  /** null = 取得に失敗（errorMessage を出し、5 秒ごとの再取得は続ける） */
  orders: StaffOrder[] | null;
  errorMessage?: string | null;
  /** サーバーの現在（ISO 8601）。経過時間の基準 */
  now: string;
  /** 宅配の枠の時刻を出すための、店のローカル時刻の UTC からの差（時間。LOCAL_UTC_OFFSET_HOURS）。省略は既定（9） */
  utcOffsetHours?: number;
  /** 店の選択を出す（全店の店長だけ） */
  stores: readonly Pick<Store, 'id' | 'name'>[] | null;
  showStoreSelect: boolean;
  selectedStoreId: number | null;
  onTransition: (input: TransitionInput) => Promise<TransitionResult>;
};

type Message = { kind: 'ok' | 'error'; text: string };

/** 調理ボード: 受付待ち・受付済み・調理中・準備完了の 4 列。5 秒ごとに、サーバーの描画を取り直す */
export function OrderBoard({ orders, errorMessage, now, utcOffsetHours, stores, showStoreSelect, selectedStoreId, onTransition }: Props) {
  const router = useRouter();
  const refresh = useAutoRefresh();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Message | null>(null);
  const groups = orders ? groupByStatus(orders) : null;

  async function act(order: StaffOrder, action: StaffAction, reason?: string): Promise<boolean> {
    setPendingId(order.public_id);
    let result: TransitionResult;
    try {
      result = await onTransition({ publicId: order.public_id, action, reason });
    } catch {
      result = { ok: false, kind: 'error', message: MSG.generic };
    }
    setPendingId(null);
    if (result.ok) {
      setNotice({ kind: 'ok', text: transitionSuccessMessage(order.pickup_no, action) });
      return true;
    }
    setNotice({ kind: 'error', text: result.message });
    // 他の人が先に操作した（409）・注文が無い（404）: 最新に取り直す
    if (result.kind === 'conflict' || result.kind === 'not_found') router.refresh();
    return false;
  }

  return (
    <div className="st-board">
      <div className="st-toolbar">
        {showStoreSelect && stores ? <StoreSelect stores={stores} selectedId={selectedStoreId} allowAll /> : null}
        <div className="st-toolbar-refresh">
          <p className="muted">{REFRESH_INTERVAL_MS / 1000} 秒ごとに自動で更新します（この画面を開いている間）</p>
          <button type="button" className="st-btn st-btn-secondary" onClick={refresh}>
            今すぐ更新
          </button>
        </div>
      </div>

      {/* 結果の文は、常に存在する領域の中身を差し替える（領域ごと出すと、読み上げられないことがある） */}
      <div className="st-live" role="status" aria-live="polite" aria-atomic="true">
        {notice ? (
          <p className={notice.kind === 'error' ? 'st-message st-message-error' : 'st-message st-message-ok'}>
            <span className="st-message-label">{notice.kind === 'error' ? '操作できませんでした' : '完了'}</span>
            {notice.text}
          </p>
        ) : null}
      </div>

      {groups === null ? (
        <Notice title="注文を読み込めませんでした">
          <p>{errorMessage ?? MSG.generic}</p>
          <p>自動で再試行します。</p>
        </Notice>
      ) : (
        <div className="st-columns">
          {BOARD_STATUSES.map((status) => {
            const list = groups[status];
            const headingId = `st-col-${status}`;
            return (
              <section key={status} className="st-column" aria-labelledby={headingId} data-status={status}>
                <h2 id={headingId} className="st-column-title">
                  {COLUMN_LABELS[status]}
                  <span className="st-count" aria-label={`${list.length} 件`}>
                    {list.length}
                  </span>
                </h2>
                {list.length === 0 ? (
                  <p className="st-empty muted">なし</p>
                ) : (
                  <ul className="st-card-list">
                    {list.map((order) => (
                      <OrderCard key={order.public_id} order={order} now={now} utcOffsetHours={utcOffsetHours} busy={pendingId === order.public_id} onAct={act} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

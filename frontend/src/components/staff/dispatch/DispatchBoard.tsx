'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type {
  AssignInput,
  DeliveryOutcome,
  DispatchBoardData,
  DispatchCancelInput,
  MockAdvanceInput,
  RedeliverInput,
  SuspensionInput,
  Zone,
} from '../../../lib/staff/delivery-types';
import { DISPATCH_COLUMN_LABELS, DISPATCH_COLUMNS, groupDispatch } from '../../../lib/staff/dispatch';
import { MSG } from '../../../lib/staff/messages';
import type { Store } from '../../../lib/types';
import { Notice } from '../Notices';
import { StoreSelect } from '../StoreSelect';
import { REFRESH_INTERVAL_MS, useAutoRefresh } from '../useAutoRefresh';
import { CourierPanel } from './CourierPanel';
import { DispatchCard } from './DispatchCard';
import { ZonePanel } from './ZonePanel';

type Props = {
  /** null = 取得に失敗（errorMessage を出し、5 秒ごとの再取得は続ける） */
  board: DispatchBoardData | null;
  errorMessage?: string | null;
  /** 区画と砂嵐の警報の状態。null = 読み込めなかった */
  zones: readonly Zone[] | null;
  /** サーバーの現在（ISO 8601）。枠が今日かどうかの基準 */
  now: string;
  /** 店のローカル時刻の UTC からの差（時間。LOCAL_UTC_OFFSET_HOURS） */
  utcOffsetHours: number;
  /** 店の選択を出す（全店の店長だけ） */
  stores: readonly Pick<Store, 'id' | 'name'>[] | null;
  showStoreSelect: boolean;
  selectedStoreId: number | null;
  /** 砂嵐の警報の操作を出す（店長だけ。権限は API が毎回決める） */
  canSuspend: boolean;
  onAssign: (input: AssignInput) => Promise<DeliveryOutcome>;
  onRedeliver: (input: RedeliverInput) => Promise<DeliveryOutcome>;
  onMockAdvance: (input: MockAdvanceInput) => Promise<DeliveryOutcome>;
  onCancel: (input: DispatchCancelInput) => Promise<DeliveryOutcome>;
  onSuspension: (input: SuspensionInput) => Promise<DeliveryOutcome>;
};

type Message = { kind: 'ok' | 'error'; text: string };

/**
 * 配車ボード: 割り当て待ち・割り当て済み・配達中・不在・要対応の 4 列と、脇に配達員・砂嵐の警報。5 秒ごとに、サーバーの描画を取り直す。
 * 操作は 1 つずつ（実行中は、ボード全体の操作ボタンを押せなくして、二重送信を防ぐ）。
 */
export function DispatchBoard({
  board,
  errorMessage,
  zones,
  now,
  utcOffsetHours,
  stores,
  showStoreSelect,
  selectedStoreId,
  canSuspend,
  onAssign,
  onRedeliver,
  onMockAdvance,
  onCancel,
  onSuspension,
}: Props) {
  const router = useRouter();
  const refresh = useAutoRefresh();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // state は次の描画まで変わらないので、同じ瞬間の 2 回目の呼び出しは、ここで止める
  const [notice, setNotice] = useState<Message | null>(null);
  const groups = board ? groupDispatch(board.orders) : null;

  // 画面に出す店名: 全店の表示（注文・配達員が複数の店にまたがる）のときだけ、カードに添える
  const storeNames = new Map<number, string>();
  for (const s of stores ?? []) storeNames.set(s.id, s.name);
  for (const o of board?.orders ?? []) storeNames.set(o.store.id, o.store.name);
  const showStore = new Set([...(board?.orders ?? []).map((o) => o.store.id), ...(board?.couriers ?? []).map((c) => c.store_id)]).size > 1;

  async function run(call: () => Promise<DeliveryOutcome>): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    let result: DeliveryOutcome;
    try {
      result = await call();
    } catch {
      result = { ok: false, kind: 'error', message: MSG.generic, refresh: false };
    }
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      setNotice({ kind: 'ok', text: result.message });
      return true;
    }
    setNotice({ kind: 'error', text: result.message });
    // 他の人が先に操作した・状態が変わった: 最新に取り直す
    if (result.refresh) router.refresh();
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

      <div className="st-dispatch">
        {board === null || groups === null ? (
          <Notice title="配車ボードを読み込めませんでした">
            <p>{errorMessage ?? MSG.generic}</p>
            <p>自動で再試行します。</p>
          </Notice>
        ) : (
          <div className="st-dispatch-columns">
            {DISPATCH_COLUMNS.map((column) => {
              const list = groups[column];
              const headingId = `st-dcol-${column}`;
              return (
                <section key={column} className="st-column" aria-labelledby={headingId} data-column={column}>
                  <h2 id={headingId} className="st-column-title">
                    {DISPATCH_COLUMN_LABELS[column]}
                    <span className="st-count" aria-label={`${list.length} 件`}>
                      {list.length}
                    </span>
                  </h2>
                  {list.length === 0 ? (
                    <p className="st-empty muted">なし</p>
                  ) : (
                    <ul className="st-card-list">
                      {list.map((order) => (
                        <DispatchCard
                          key={order.public_id}
                          order={order}
                          couriers={board.couriers}
                          provider={board.provider}
                          now={now}
                          utcOffsetHours={utcOffsetHours}
                          showStore={showStore}
                          busy={busy}
                          onAssign={(o, courierId) => run(() => onAssign({ publicId: o.public_id, courierId }))}
                          onRedeliver={(o) => run(() => onRedeliver({ publicId: o.public_id }))}
                          onMockAdvance={(o) => run(() => onMockAdvance({ publicId: o.public_id }))}
                          onCancel={(o, reason) => run(() => onCancel({ publicId: o.public_id, reason }))}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}

        <aside className="st-dispatch-side" aria-label="配達員と砂嵐の警報">
          {board ? <CourierPanel couriers={board.couriers} storeNames={storeNames} /> : null}
          <ZonePanel zones={zones} canSuspend={canSuspend} busy={busy} onSuspension={(z, suspended) => run(() => onSuspension({ zoneId: z.id, suspended }))} />
        </aside>
      </div>
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { POLL_INTERVAL_MS } from '../../lib/shop/constants';
import { isTerminalStatus } from '../../lib/shop/order-steps';

/** 注文の状態を一定間隔で再取得する（router.refresh）。タブが見えていないときは止め、終了状態（受け取り済み・取消し）では動かさない */
export function OrderAutoRefresh({ status, intervalMs = POLL_INTERVAL_MS }: { status: string; intervalMs?: number }) {
  const router = useRouter();
  const active = !isTerminalStatus(status);

  useEffect(() => {
    if (!active) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const id = setInterval(refreshIfVisible, intervalMs);
    // タブに戻ったら、待たずに最新にする
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [active, intervalMs, router]);

  return active ? <p className="muted shop-autorefresh">この画面は {Math.round(intervalMs / 1000)} 秒ごとに自動で更新されます。</p> : null;
}

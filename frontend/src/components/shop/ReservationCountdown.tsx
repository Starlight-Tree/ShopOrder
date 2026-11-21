'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { formatRemaining, remainingSeconds } from '../../lib/shop/countdown';

/**
 * 在庫の確保の残り時間（クライアントのカウントダウン）。0 になったら、注文を再取得する（期限切れの取消しを画面に反映する）。
 * serverNow は、サーバーが画面を作った時刻。ブラウザーの時計のずれは、これとの差で補う（最初の描画も、サーバーと同じ値になる）。
 */
export function ReservationCountdown({ expiresAt, serverNow }: { expiresAt: string; serverNow: string }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(() => remainingSeconds(expiresAt, Date.parse(serverNow)));
  // 期限ごとに 1 回だけ再取得する（注文がまだ placed のままでも、再取得を繰り返さない。5 秒ごとの再取得は別にある）
  const refreshedFor = useRef<string | null>(null);

  useEffect(() => {
    const offset = Date.parse(serverNow) - Date.now();
    const tick = () => {
      const r = remainingSeconds(expiresAt, Date.now() + (Number.isFinite(offset) ? offset : 0));
      setRemaining(r);
      if (r === 0 && refreshedFor.current !== expiresAt) {
        refreshedFor.current = expiresAt;
        router.refresh();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, serverNow, router]);

  if (remaining === null) return null;
  if (remaining === 0) {
    return (
      <span role="timer" className="shop-countdown shop-countdown-over">
        確保の期限が過ぎました。注文の状態を確認しています…
      </span>
    );
  }
  return (
    <span role="timer" className="shop-countdown">
      あと <strong>{formatRemaining(remaining)}</strong>
    </span>
  );
}

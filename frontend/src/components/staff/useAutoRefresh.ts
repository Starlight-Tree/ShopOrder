'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';

export const REFRESH_INTERVAL_MS = 5000;

/**
 * 一定の間隔で router.refresh()（サーバーの描画を取り直す）。タブが非表示の間は止め、表示に戻ったら、すぐ 1 回取って再開する。
 * 戻り値は、手動で取り直す関数。
 */
export function useAutoRefresh(intervalMs: number = REFRESH_INTERVAL_MS): () => void {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, intervalMs]);

  return refresh;
}

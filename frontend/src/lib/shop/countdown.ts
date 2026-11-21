// 在庫の確保の残り時間（reservation_expires_at まで）

/** 残り秒（切り上げ。0 以上）。時刻が読めなければ null */
export function remainingSeconds(expiresAtIso: string, nowMs: number): number | null {
  const at = Date.parse(expiresAtIso);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** 例: 872 → "14 分 32 秒"、45 → "45 秒"、0 → "0 秒" */
export function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

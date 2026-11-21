// 画面の表示用の整形。金額は ../format の formatLumi（"1,350 ルミ"）を使う。
import type { Cart } from '../contract';

/** 日時を表示する時間帯。店の営業時間の基準と合わせる必要がある（docs に定義が無いので、環境変数で変えられる） */
export const SHOP_TIME_ZONE = process.env.SHOP_TIME_ZONE || 'Asia/Tokyo';

function parts(iso: string, timeZone: string): Record<string, string> | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const fmt = new Intl.DateTimeFormat('ja-JP', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
}

/** "11/21 08:59"（24 時間制）。読めなければ空 */
export function formatDateTime(iso: string, timeZone: string = SHOP_TIME_ZONE): string {
  const p = parts(iso, timeZone);
  return p ? `${p.month}/${p.day} ${p.hour}:${p.minute}` : '';
}

/** "08:59"。読めなければ空 */
export function formatClock(iso: string, timeZone: string = SHOP_TIME_ZONE): string {
  const p = parts(iso, timeZone);
  return p ? `${p.hour}:${p.minute}` : '';
}

/** カートの点数（数量の合計） */
export function cartCount(cart: Pick<Cart, 'lines'> | null): number {
  return cart ? cart.lines.reduce((sum, l) => sum + l.qty, 0) : 0;
}

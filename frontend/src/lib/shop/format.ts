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

const DATE_PARTS = (timeZone: string) =>
  new Intl.DateTimeFormat('ja-JP', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });

function dateParts(iso: string, timeZone: string): Record<string, string> | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Object.fromEntries(DATE_PARTS(timeZone).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
}

/** その時間帯での日付 "2026-11-21"。読めなければ null */
export function localDate(iso: string, timeZone: string = SHOP_TIME_ZONE): string | null {
  const p = dateParts(iso, timeZone);
  return p ? `${p.year}-${p.month}-${p.day}` : null;
}

/** "11/22（日）"。読めなければ空 */
export function formatMonthDay(iso: string, timeZone: string = SHOP_TIME_ZONE): string {
  const p = dateParts(iso, timeZone);
  return p ? `${Number(p.month)}/${Number(p.day)}（${p.weekday}）` : '';
}

/** カートの点数（数量の合計） */
export function cartCount(cart: Pick<Cart, 'lines'> | null): number {
  return cart ? cart.lines.reduce((sum, l) => sum + l.qty, 0) : 0;
}

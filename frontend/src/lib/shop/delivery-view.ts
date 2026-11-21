// 宅配の画面の判断（純粋な関数）。日付の選択肢・時間枠の表示・住所を選べるか・送料の案内・暗証コードを出してよいか。
import type { CartDelivery } from '../contract';
import { formatLumi } from '../format';
import type { Slot, SlotRef, Zone } from '../types';
import { DELIVERY_DAYS_AHEAD } from './constants';
import { formatClock, formatMonthDay, SHOP_TIME_ZONE } from './format';

// ---- 日付 ----

export type DayOption = { date: string; label: string };

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** その時刻の、店の時間帯での日付 "2026-11-21" */
export function todayIn(nowMs: number, timeZone: string = SHOP_TIME_ZONE): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(nowMs))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 時間枠を選べる日（今日から 7 日先まで）。label は「今日 11/21（土）」「明日 11/22（日）」「11/23（月）」 */
export function dayOptions(nowMs: number, timeZone: string = SHOP_TIME_ZONE, daysAhead: number = DELIVERY_DAYS_AHEAD): DayOption[] {
  const [y, m, d] = todayIn(nowMs, timeZone).split('-').map(Number) as [number, number, number];
  return Array.from({ length: daysAhead + 1 }, (_, i) => {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    const md = `${day.getUTCMonth() + 1}/${day.getUTCDate()}（${WEEKDAYS[day.getUTCDay()]}）`;
    return { date: day.toISOString().slice(0, 10), label: i === 0 ? `今日 ${md}` : i === 1 ? `明日 ${md}` : md };
  });
}

/** ?date= の値。選べる日のどれかでなければ null */
export function parseDateParam(raw: string | string[] | undefined, options: readonly DayOption[]): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return options.find((o) => o.date === v)?.date ?? null;
}

// ---- 時間枠 ----

/** "13:00〜13:30"。読めなければ空 */
export function slotRange(slot: Pick<SlotRef, 'starts_at' | 'ends_at'>): string {
  const from = formatClock(slot.starts_at);
  const to = formatClock(slot.ends_at);
  return from && to ? `${from}〜${to}` : '';
}

/** "11/22（日） 13:00〜13:30"（確認・注文の画面。日付つき） */
export function slotLabel(slot: Pick<SlotRef, 'starts_at' | 'ends_at'>): string {
  const day = formatMonthDay(slot.starts_at);
  const range = slotRange(slot);
  return day && range ? `${day} ${range}` : range;
}

export type SlotChoice = { selectable: boolean; note: string };

/** 枠の選べるか・残りの表示。選べるかは API の available に従い、満枠・締め切り済みは色ではなく文字で示す */
export function slotChoice(slot: Pick<Slot, 'available' | 'remaining' | 'unavailable_reason'>): SlotChoice {
  if (slot.available) return { selectable: true, note: `残り ${slot.remaining}` };
  if (slot.unavailable_reason === 'full') return { selectable: false, note: '満枠' };
  if (slot.unavailable_reason === 'cutoff') return { selectable: false, note: '締め切り済み' };
  return { selectable: false, note: '選べません' };
}

// ---- 住所・区画 ----

/** 店が届ける区画のエリア。区画が読めなかった（null）・届ける区画が無い（空）ときは null（判断は API に任せる） */
export function servedAreaCodes(zones: readonly Zone[] | null): ReadonlySet<number> | null {
  return zones && zones.length > 0 ? new Set(zones.map((z) => z.area_code)) : null;
}

/** 住所を選べるか。店が届けないエリアの住所は、理由つきで選べない */
export function addressChoice(address: { area_code: number }, served: ReadonlySet<number> | null): { selectable: boolean; reason: string | null } {
  if (served && !served.has(address.area_code)) return { selectable: false, reason: 'この店は、このエリアへは届けられません' };
  return { selectable: true, reason: null };
}

// ---- 送料の案内 ----

/** 送料の表示。0 は「無料」 */
export function feeText(feeLumi: number): string {
  return feeLumi === 0 ? '無料' : formatLumi(feeLumi);
}

/** 送料が無料になる金額の案内（区画が決まっていて、無料の条件がある場合）。品の小計が以上なら無料（ちょうども無料） */
export function freeShippingNote(delivery: Pick<CartDelivery, 'zone' | 'free_over_lumi'> | null, subtotalLumi: number): string | null {
  const freeOver = delivery?.zone ? delivery.free_over_lumi : null;
  if (freeOver === null || freeOver === undefined || subtotalLumi <= 0) return null;
  if (subtotalLumi >= freeOver) return '送料は無料です。';
  return `あと ${formatLumi(freeOver - subtotalLumi)}で送料が無料になります（品の小計が ${formatLumi(freeOver)}以上）。`;
}

// ---- 暗証コード ----

/** 暗証コードを出してよいか。集荷後（picked_up・delivering）で、4 桁の数字のときだけ。それ以外は、API が何を返しても出さない */
export function visiblePin(status: string, pin: string | null | undefined): string | null {
  if (status !== 'picked_up' && status !== 'delivering') return null;
  return typeof pin === 'string' && /^[0-9]{4}$/.test(pin) ? pin : null;
}

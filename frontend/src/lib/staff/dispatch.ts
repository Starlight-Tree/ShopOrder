// 配車ボードの、画面に依らない部分: 列への振り分け・時刻の文・配達員の選択肢・ラベル。
import { formatLumi } from '../format';
import type { Courier, DispatchOrder, DispatchSuggestion, FailureReason, SlotRef, StaffDelivery, Zone } from './delivery-types';

/** 配車ボードに出す注文の状態（API の `status` の既定と同じ） */
export const DISPATCH_STATUSES = ['ready', 'assigned', 'picked_up', 'delivering', 'delivery_failed'] as const;

export type DispatchColumn = 'ready' | 'assigned' | 'moving' | 'delivery_failed';
export const DISPATCH_COLUMNS: readonly DispatchColumn[] = ['ready', 'assigned', 'moving', 'delivery_failed'];

export const DISPATCH_COLUMN_LABELS: Record<DispatchColumn, string> = {
  ready: '割り当て待ち',
  assigned: '割り当て済み（集荷前）',
  moving: '配達中',
  delivery_failed: '不在・要対応',
};

export function columnOf(status: string): DispatchColumn | null {
  if (status === 'ready' || status === 'assigned' || status === 'delivery_failed') return status;
  if (status === 'picked_up' || status === 'delivering') return 'moving';
  return null;
}

/** API の順（枠の開始が早い順）を保ったまま、列に分ける。ボードに無い状態は捨てる */
export function groupDispatch(orders: readonly DispatchOrder[]): Record<DispatchColumn, DispatchOrder[]> {
  const groups: Record<DispatchColumn, DispatchOrder[]> = { ready: [], assigned: [], moving: [], delivery_failed: [] };
  for (const order of orders) {
    const column = columnOf(order.status);
    if (column) groups[column].push(order);
  }
  return groups;
}

// ---- 時刻（店のローカル時刻。API は UTC で返す） ----

export const DEFAULT_UTC_OFFSET_HOURS = 9;

/** 環境変数 LOCAL_UTC_OFFSET_HOURS（API と同じ名前）の値 → 整数の時差。先頭の + は受ける（API の int() と同じ）。読めない・範囲外（-12〜14 の外）は既定の 9 */
export function parseOffsetHours(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || !/^[+-]?\d{1,2}$/.test(raw.trim())) return DEFAULT_UTC_OFFSET_HOURS;
  const n = Number(raw.trim());
  return n >= -12 && n <= 14 ? n : DEFAULT_UTC_OFFSET_HOURS;
}

function local(iso: string, offsetHours: number): Date | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + offsetHours * 3_600_000) : null;
}

const two = (n: number) => String(n).padStart(2, '0');

/** "13:30"。読めなければ空文字 */
export function formatClock(iso: string, offsetHours: number): string {
  const d = local(iso, offsetHours);
  return d ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : '';
}

/** 枠の文。今日（now のローカル日付）なら "13:00〜13:30"、別の日なら "11/22 13:00〜13:30" */
export function slotLabel(slot: Pick<SlotRef, 'starts_at' | 'ends_at'>, now: string, offsetHours: number): string {
  const start = local(slot.starts_at, offsetHours);
  const today = local(now, offsetHours);
  const range = `${formatClock(slot.starts_at, offsetHours)}〜${formatClock(slot.ends_at, offsetHours)}`;
  if (!start || !today) return range;
  const sameDay = start.getUTCFullYear() === today.getUTCFullYear() && start.getUTCMonth() === today.getUTCMonth() && start.getUTCDate() === today.getUTCDate();
  return sameDay ? range : `${start.getUTCMonth() + 1}/${start.getUTCDate()} ${range}`;
}

// ---- ラベル ----

export const FAILURE_LABELS: Record<FailureReason, string> = {
  absent: '不在',
  cannot_receive: '受け取れない',
  other: 'その他',
  pin_locked: '暗証コードの誤り（凍結）',
};

export function failureLabel(reason: string | null): string | null {
  return reason === null ? null : (FAILURE_LABELS as Record<string, string>)[reason] ?? reason;
}

export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  pending: '割り当て待ち',
  assigned: '割り当て済み',
  picked_up: '集荷済み',
  delivering: '配達中',
  delivered: '配達済み',
  failed: '配達できず',
  cancelled: '取消し',
};

const VEHICLE_LABELS: Record<string, string> = { 'hover-scooter': '浮上スクーター' };
export const vehicleLabel = (vehicle: string): string => VEHICLE_LABELS[vehicle] ?? vehicle;

// ---- 配達員の選択 ----

/** 提案の文。店にいる（0 分）か、店まで何分か */
export function suggestionLabel(s: Pick<DispatchSuggestion, 'courier_name' | 'minutes'>): string {
  return s.minutes <= 0 ? `${s.courier_name}（店にいる）` : `${s.courier_name}（店まで ${s.minutes} 分）`;
}

export type CourierChoice = { id: number; label: string; disabled: boolean };

/** その注文の店の配達員を、選択肢にする。勤務外は選べない（文字でも示す）。担当中の件数も出す */
export function courierChoices(order: Pick<DispatchOrder, 'store'>, couriers: readonly Courier[]): CourierChoice[] {
  return couriers
    .filter((c) => c.store_id === order.store.id)
    .map((c) => ({
      id: c.id,
      label: `${c.name}${c.is_on_duty ? '' : '（勤務外）'}・担当 ${c.active_count} 件`,
      disabled: !c.is_on_duty,
    }));
}

// ---- 区画 ----

/** 区画の条件の 1 行。例: "送料 150 ルミ・2,000 ルミ以上で無料・最低注文 600 ルミ・基準 25 分" */
export function zoneSummary(zone: Pick<Zone, 'fee_lumi' | 'free_over_lumi' | 'min_order_lumi' | 'base_minutes'>): string {
  const free = zone.free_over_lumi === null ? '' : `・${formatLumi(zone.free_over_lumi)}以上で無料`;
  return `送料 ${formatLumi(zone.fee_lumi)}${free}・最低注文 ${formatLumi(zone.min_order_lumi)}・基準 ${zone.base_minutes} 分`;
}

// ---- 宅配の情報の読み取り・操作の出し分け（調理ボードと配車ボードで使う） ----

/**
 * 注文から、宅配の情報を読む。調理ボードの注文は contract.ts の StaffOrder（店頭の型）なので、型に頼らず、実行時に形を確かめる。
 * 宅配でない（delivery が無い・null）・形が違うものは null。
 */
export function deliveryOf(order: object): StaffDelivery | null {
  const d = (order as { delivery?: unknown }).delivery;
  if (typeof d !== 'object' || d === null) return null;
  const { status, slot, attempt } = d as Partial<StaffDelivery>;
  if (typeof status !== 'string' || typeof attempt !== 'number') return null;
  if (typeof slot?.starts_at !== 'string' || typeof slot.ends_at !== 'string') return null;
  return d as StaffDelivery;
}

/** 枠の文。開始・終了のどちらかが読めなければ「時刻不明」（slotLabel は、読めないと "〜" だけ・"13:00〜" だけを返すので、画面ではこちらを使う） */
export function slotText(slot: Pick<SlotRef, 'starts_at' | 'ends_at'>, now: string, offsetHours: number): string {
  return formatClock(slot.starts_at, offsetHours) === '' || formatClock(slot.ends_at, offsetHours) === '' ? '時刻不明' : slotLabel(slot, now, offsetHours);
}

/** 模擬で進められる注文の状態（これ以外は API が 409 invalid_transition にする） */
export const MOCK_ADVANCE_STATUSES = ['ready', 'assigned', 'picked_up', 'delivering'] as const;

/**
 * 「模擬で 1 つ進める」を出すか。配達の提供者が mock で、進められる状態のときだけ（API は mock 以外を 409 mock_only にする）。
 * ready は「提案の配達員を割り当てる」ので、提案が無い（勤務中の配達員がいない）ときは出さない（押しても 409 no_courier_available になる）。
 */
export function canMockAdvance(provider: string, status: string, suggestion: DispatchSuggestion | null): boolean {
  if (provider !== 'mock' || !(MOCK_ADVANCE_STATUSES as readonly string[]).includes(status)) return false;
  return status !== 'ready' || suggestion !== null;
}

/** 配達の回数の文。初回は null。再配達（2 回目以降）は "配達 2 回目（再配達）" */
export function attemptLabel(attempt: number): string | null {
  return attempt > 1 ? `配達 ${attempt} 回目（再配達）` : null;
}

/** 割り当ての選択の初期値（select の value）。提案の配達員が選べる中にいればその ID、いなければ空 */
export function defaultCourierId(order: Pick<DispatchOrder, 'suggestion'>, choices: readonly CourierChoice[]): string {
  const id = order.suggestion?.courier_id;
  return id !== undefined && choices.some((c) => c.id === id && !c.disabled) ? String(id) : '';
}

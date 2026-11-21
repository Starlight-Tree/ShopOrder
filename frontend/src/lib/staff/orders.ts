// 調理ボードの、画面に依らない部分: 列への振り分け・経過時間・ボタン・表示用の文。
import type { OrderItem, StaffAction, StaffOrder, StaffRole } from '../contract';
import type { Store } from '../types';

/** 調理ボードに出す状態（左から右の順）。API には、この順のまま status で渡す */
export const BOARD_STATUSES = ['paid', 'accepted', 'preparing', 'ready'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export const COLUMN_LABELS: Record<BoardStatus, string> = {
  paid: '受付待ち',
  accepted: '受付済み',
  preparing: '調理中',
  ready: '準備完了',
};

/** 注文から、この分数を超えたら強調する（10 分ちょうどは強調しない） */
export const OVERDUE_MINUTES = 10;

export const ROLE_LABELS: Record<StaffRole, string> = { staff: 'スタッフ', manager: '店長', courier: '配達員' };

/** 古い順（API の順）を保ったまま、状態ごとに分ける。ボードに無い状態の注文は捨てる */
export function groupByStatus(orders: readonly StaffOrder[]): Record<BoardStatus, StaffOrder[]> {
  const groups: Record<BoardStatus, StaffOrder[]> = { paid: [], accepted: [], preparing: [], ready: [] };
  for (const order of orders) {
    if ((BOARD_STATUSES as readonly string[]).includes(order.status)) groups[order.status as BoardStatus].push(order);
  }
  return groups;
}

/** 注文（placed_at）から now までの経過分（切り捨て）。日時が読めなければ null。時計のずれで負になったら 0 */
export function elapsedMinutes(placedAt: string, now: string | number | Date): number | null {
  const start = Date.parse(placedAt);
  const end = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 60_000));
}

export function isOverdue(minutes: number | null): boolean {
  return minutes !== null && minutes > OVERDUE_MINUTES;
}

export function formatElapsed(minutes: number | null): string {
  if (minutes === null) return '経過時間を計算できません';
  if (minutes < 1) return '1 分未満';
  if (minutes < 60) return `${minutes} 分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 時間` : `${h} 時間 ${m} 分`;
}

export const ACTION_LABELS: Record<StaffAction, string> = {
  accept: '受ける',
  start: '調理開始',
  ready: '準備完了',
  complete: '渡した',
  cancel: '取消し',
};

const ACTION_ORDER: readonly StaffAction[] = ['accept', 'start', 'ready', 'complete', 'cancel'];

export type ActionButton = { action: StaffAction; label: string; variant: 'primary' | 'danger' };

/** allowed_actions → ボタン。知らない action は出さない。重複は 1 つに。進める操作を先、取消しを最後に */
export function actionButtons(allowed: readonly string[]): ActionButton[] {
  return ACTION_ORDER.filter((a) => allowed.includes(a)).map((action) => ({
    action,
    label: ACTION_LABELS[action],
    variant: action === 'cancel' ? 'danger' : 'primary',
  }));
}

const TEMPERATURE_LABELS: Record<string, string> = { hot: 'ホット', ice: 'アイス' };

/** 「M・ホット」のような、サイズと温度（フードなどの '-' は出さない） */
export function itemSpec(item: Pick<OrderItem, 'size' | 'temperature'>): string {
  const parts: string[] = [];
  if (item.size && item.size !== '-') parts.push(item.size);
  if (item.temperature && item.temperature !== '-') parts.push(TEMPERATURE_LABELS[item.temperature] ?? item.temperature);
  return parts.join('・');
}

/** ヘッダーの店名。全店の店長は「全店」。店の一覧が読めなかったときは「自店」 */
export function storeLabel(staff: { store_id: number | null }, stores: readonly Pick<Store, 'id' | 'name'>[] | null): string {
  if (staff.store_id === null) return '全店';
  return stores?.find((s) => s.id === staff.store_id)?.name ?? '自店';
}

/** ?store= の値 → 店の ID。数字以外・0 以下・長すぎるものは null（全店・未選択） */
export function parseStoreParam(value: string | string[] | undefined): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

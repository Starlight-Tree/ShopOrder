// 注文の状態（status）→ 画面の進み・見出し。状態は API の status から描く（events の文言は信じない）。
import type { OrderEvent, OrderStatus } from '../contract';

export type StepState = 'done' | 'current' | 'upcoming';
export type Step = { status: OrderStatus; label: string; state: StepState };

/** 取消し以外の、進みの順序 */
export const FLOW: readonly OrderStatus[] = ['placed', 'paid', 'accepted', 'preparing', 'ready', 'completed'];

const STEP_LABEL: Record<OrderStatus, string> = {
  placed: 'お支払い待ち',
  paid: '支払い済み',
  accepted: 'お店が受付',
  preparing: '調理中',
  ready: '受け取れます',
  completed: '受け取り済み',
  cancelled: '取消し',
};

const HEADLINE: Record<OrderStatus, string> = {
  placed: 'お支払いをお待ちしています',
  paid: 'お支払いを確認しました。お店の受付をお待ちください',
  accepted: 'お店が注文を受け付けました',
  preparing: '調理しています',
  ready: '受け取れます。お店のカウンターで、受け取り番号をお伝えください',
  completed: 'お受け取りありがとうございました',
  cancelled: 'この注文は取消されました',
};

export function statusLabel(status: string): string {
  return (STEP_LABEL as Record<string, string>)[status] ?? '状態を確認中';
}

export function statusHeadline(status: string): string {
  return (HEADLINE as Record<string, string>)[status] ?? '状態を確認しています';
}

/** これ以上、状態が変わらない（再取得を止めてよい） */
export function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'cancelled';
}

/** 進みの表示。cancelled は別表示なので null。completed は全部 done */
export function orderSteps(status: OrderStatus): Step[] | null {
  if (status === 'cancelled') return null;
  const at = FLOW.indexOf(status);
  return FLOW.map((s, i) => {
    let state: StepState = 'upcoming';
    if (at >= 0 && (i < at || status === 'completed')) state = 'done';
    else if (i === at) state = 'current';
    return { status: s, label: STEP_LABEL[s], state };
  });
}

/** 状態ごとの最初の時刻（events の to_status と at だけを使う） */
export function eventTimes(events: readonly Pick<OrderEvent, 'to_status' | 'at'>[]): Partial<Record<OrderStatus, string>> {
  const out: Partial<Record<OrderStatus, string>> = {};
  for (const e of events) if (!(e.to_status in out)) out[e.to_status] = e.at;
  return out;
}

const CANCEL_REASON: Record<string, string> = {
  payment_declined: 'お支払いに失敗したため',
  reservation_expired: 'お支払いの期限が切れたため',
  customer_cancelled: 'お客様のご希望による取消し',
  customer: 'お客様のご希望による取消し',
};

/** 取消しの理由。既知の code は固定の文にする。未知の code（英小文字・数字・_ だけ）は出さない。それ以外は店が書いた文として出す */
export function cancelReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const known = CANCEL_REASON[reason];
  if (known) return known;
  return /^[a-z0-9_]+$/.test(reason) ? null : reason;
}

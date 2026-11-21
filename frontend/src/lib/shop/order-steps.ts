// 注文の状態（status）→ 画面の進み・見出し。状態は API の status から描く（events の文言は信じない）。
// 宅配（fulfillment = 'delivery'）は、準備完了のあとに配達の段階が続く。省略した fulfillment は店頭。
import type { Fulfillment, OrderEvent, OrderStatus } from '../contract';

export type StepState = 'done' | 'current' | 'upcoming';
export type Step = { status: OrderStatus; label: string; state: StepState };

/** 取消し以外の、進みの順序（店頭） */
export const FLOW: readonly OrderStatus[] = ['placed', 'paid', 'accepted', 'preparing', 'ready', 'completed'];

/** 取消し・配達の失敗以外の、進みの順序（宅配） */
export const DELIVERY_FLOW: readonly OrderStatus[] = ['placed', 'paid', 'accepted', 'preparing', 'ready', 'assigned', 'picked_up', 'delivering', 'completed'];

const STEP_LABEL: Record<OrderStatus, string> = {
  placed: 'お支払い待ち',
  paid: '支払い済み',
  accepted: 'お店が受付',
  preparing: '調理中',
  ready: '受け取れます',
  completed: '受け取り済み',
  cancelled: '取消し',
  assigned: '配達員が決定',
  picked_up: '集荷済み',
  delivering: '配達中',
  delivered: 'お届け済み',
  delivery_failed: 'お届けできませんでした',
};

/** 宅配で、店頭と言い方が違う状態 */
const DELIVERY_STEP_LABEL: Partial<Record<OrderStatus, string>> = { ready: '準備完了', completed: 'お届け済み' };

const HEADLINE: Record<OrderStatus, string> = {
  placed: 'お支払いをお待ちしています',
  paid: 'お支払いを確認しました。お店の受付をお待ちください',
  accepted: 'お店が注文を受け付けました',
  preparing: '調理しています',
  ready: '受け取れます。お店のカウンターで、受け取り番号をお伝えください',
  completed: 'お受け取りありがとうございました',
  cancelled: 'この注文は取消されました',
  assigned: '配達員が決まりました。お店で品を受け取り次第、出発します',
  picked_up: '配達員が品を受け取りました。まもなく出発します',
  delivering: '配達中です。まもなくお届けします',
  delivered: 'お届けしました。ありがとうございました',
  delivery_failed: 'お届けできませんでした。お店からの連絡をお待ちください',
};

const DELIVERY_HEADLINE: Partial<Record<OrderStatus, string>> = {
  ready: '品ができました。配達員の手配をお待ちください',
  completed: 'お届けしました。ありがとうございました',
};

export function statusLabel(status: string, fulfillment: Fulfillment = 'pickup'): string {
  if (fulfillment === 'delivery') {
    const own = (DELIVERY_STEP_LABEL as Record<string, string>)[status];
    if (own) return own;
  }
  return (STEP_LABEL as Record<string, string>)[status] ?? '状態を確認中';
}

export function statusHeadline(status: string, fulfillment: Fulfillment = 'pickup'): string {
  if (fulfillment === 'delivery') {
    const own = (DELIVERY_HEADLINE as Record<string, string>)[status];
    if (own) return own;
  }
  return (HEADLINE as Record<string, string>)[status] ?? '状態を確認しています';
}

/** これ以上、状態が変わらない（再取得を止めてよい）。配達の途中・配達の失敗（再配達・取消しがありうる）は、終わりではない */
export function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * 進みの表示。cancelled は別表示なので null。completed は全部 done。
 * 宅配の delivered は completed と同じ（同じトランザクションで completed になる）。
 * 宅配の delivery_failed は、配達中までを完了にして、「お届けできませんでした」を現在にする（再配達で ready に戻れば、また最初から進む）
 */
export function orderSteps(status: OrderStatus, fulfillment: Fulfillment = 'pickup'): Step[] | null {
  if (status === 'cancelled') return null;
  const delivery = fulfillment === 'delivery';
  const label = (s: OrderStatus) => statusLabel(s, fulfillment);
  if (delivery && status === 'delivery_failed') {
    const before = DELIVERY_FLOW.slice(0, DELIVERY_FLOW.indexOf('completed'));
    return [...before.map((s): Step => ({ status: s, label: label(s), state: 'done' })), { status: 'delivery_failed', label: label('delivery_failed'), state: 'current' }];
  }
  const flow = delivery ? DELIVERY_FLOW : FLOW;
  const done = status === 'completed' || (delivery && status === 'delivered');
  const at = done ? flow.length - 1 : flow.indexOf(status);
  return flow.map((s, i) => {
    let state: StepState = 'upcoming';
    if (at >= 0 && (i < at || done)) state = 'done';
    else if (i === at) state = 'current';
    return { status: s, label: label(s), state };
  });
}

/**
 * 状態ごとの時刻（events の to_status と at だけを使う）。既定は最初の時刻。
 * latest=true は最後の時刻（events は古い順）。宅配の再配達では ready・assigned・picked_up・delivering が繰り返されるので、今の配達の時刻を出すために使う
 */
export function eventTimes(events: readonly Pick<OrderEvent, 'to_status' | 'at'>[], latest = false): Partial<Record<OrderStatus, string>> {
  const out: Partial<Record<OrderStatus, string>> = {};
  for (const e of events) if (latest || !(e.to_status in out)) out[e.to_status] = e.at;
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

// API のエラー（code）から、画面に出す固定の日本語の文と、直し方の行き先を選ぶ。
// API の message や例外の文字列は画面に出さない（未知の code は、汎用の固定文）。
import { MAX_ADDRESSES, MAX_ORDER_TOTAL_LUMI } from './constants';
import { formatLumi } from '../format';
import { closedReasonText } from './labels';
import type { NextLink } from './types';

export type ErrorInfo = { text: string; next: NextLink | null };

type ErrorLike = { code: string; [extra: string]: unknown };

const TO_MENU: NextLink = { label: 'メニューへ', href: '/' };
const TO_CART: NextLink = { label: 'カートを見る', href: '/cart' };
const TO_CHECKOUT: NextLink = { label: '注文内容を確認しなおす', href: '/checkout' };
const TO_STORES: NextLink = { label: '店を選びなおす', href: '/' };

const GENERIC = 'うまくいきませんでした。しばらくしてから、もう一度お試しください。';

export function describeError(err: ErrorLike, status?: number): ErrorInfo {
  switch (err.code) {
    case 'cart_empty':
      return { text: 'カートが空です。メニューから品を選んでください。', next: TO_MENU };
    case 'store_not_selected':
      return { text: '受け取る店が選ばれていません。メニュー画面で店を選んでください。', next: TO_STORES };
    case 'store_closed':
      return {
        text: `選んだ店は、今は注文を受け付けていません（${closedReasonText(typeof err.closed_reason === 'string' ? err.closed_reason : null)}）。別の店を選ぶか、営業時間内にもう一度お試しください。`,
        next: TO_STORES,
      };
    case 'item_unavailable':
      return { text: '今は注文できない品がカートに入っています。カートで、その品を削除してください。', next: TO_CART };
    case 'sold_out': {
      const name = typeof err.item_name === 'string' && err.item_name ? `「${err.item_name}」` : 'カートの品';
      return { text: `${name}は売り切れました。カートから外すか、数量を減らしてください。`, next: TO_CART };
    }
    case 'over_limit':
      return { text: `1 回のご注文は、合計 ${formatLumi(MAX_ORDER_TOTAL_LUMI)}以内です。カートで数量を減らしてください。`, next: TO_CART };
    case 'proposal_expired':
      return { text: '注文内容の確認の有効期限が切れました。もう一度、注文内容を確認してください。', next: TO_CHECKOUT };
    case 'proposal_stale':
      return { text: 'カートの内容が変わりました（品・送料・お届け先・時間枠など）。もう一度、注文内容を確認してください。', next: TO_CHECKOUT };
    case 'idempotency_conflict':
      return { text: 'この確認画面は、別の内容で使われています。もう一度、注文内容を確認してください。', next: TO_CHECKOUT };
    case 'reservation_expired':
      return { text: '在庫の確保の期限が切れたため、この注文は取消されました。もう一度、メニューから注文してください。', next: TO_MENU };
    case 'payment_declined':
      return { text: 'お支払いに失敗しました（模擬）。この注文は取消され、在庫の確保も戻しました。もう一度、メニューから注文してください。', next: TO_MENU };
    case 'not_cancellable':
      return { text: 'お店が注文を受け付けたあとは、この画面から取消せません。取消したいときは、お店にお伝えください。', next: null };
    // ---- 宅配（P2）。カートの delivery.issues と、確認・確定・カートの更新の 409 は、同じ code・同じ文（直し方つき） ----
    case 'store_required':
      return { text: '先に、受け取る店を選んでください。', next: TO_STORES };
    case 'delivery_unavailable':
      return { text: '選んだ店は、宅配をしていません。店頭でのお受け取りにするか、別の店を選んでください。', next: TO_CART };
    case 'address_required':
      return { text: 'お届け先の住所を選んでください。住所がないときは、「お届け先」で登録してください。', next: TO_CART };
    case 'slot_required':
      return { text: 'お届けの時間枠を選んでください。', next: TO_CART };
    case 'out_of_zone':
      return { text: '選んだ店は、その住所のエリアへは届けられません。別の住所か、別の店を選んでください。', next: TO_CART };
    case 'zone_suspended':
      return { text: '砂嵐の警報のため、その住所のエリアへの宅配は、今は受け付けていません。警報が解除されてからお試しいただくか、店頭でのお受け取りをお選びください。', next: TO_CART };
    case 'below_minimum': {
      const min = typeof err.min_order_lumi === 'number' ? err.min_order_lumi : null;
      const text = min === null ? '宅配の最低注文額に届いていません。品を足してください。' : `宅配は、品の小計（送料を除く）が ${formatLumi(min)}以上のときにご利用いただけます。品を足してください。`;
      return { text, next: TO_MENU };
    }
    case 'slot_closed':
      return { text: '選んだ日は、宅配をお休みしています。別の日の時間枠を選んでください。', next: TO_CART };
    case 'slot_cutoff':
      return { text: '選んだ時間枠は、受付を締め切りました。別の時間枠を選んでください。', next: TO_CART };
    case 'slot_full':
      return { text: '選んだ時間枠は、満枠になりました。別の時間枠を選んでください。', next: TO_CART };
    // 以下の 2 つは、カート・住所の画面の操作の失敗（その画面にいるので、リンクは付けない）
    case 'address_not_found':
      return { text: 'お届け先の住所が見つかりません。住所を選びなおしてください。', next: null };
    case 'slot_not_found':
      return { text: '時間枠が見つかりません。別の時間枠を選んでください。', next: null };
    case 'invalid_area':
      return { text: 'エリアの指定が正しくありません。一覧から選びなおしてください。', next: null };
    case 'too_many_addresses':
      return { text: `住所は ${MAX_ADDRESSES} 件まで登録できます。使わない住所を削除してから、追加してください。`, next: null };
    case 'invalid_date':
      return { text: '日付は、今日から 7 日先までの中から選んでください。', next: null };
    case 'invalid_input':
      return { text: '入力内容を確かめて、もう一度お試しください。', next: null };
    case 'unreachable':
      return { text: 'サーバーに接続できませんでした。しばらくしてから、もう一度お試しください。', next: null };
    default:
      if (status === 404) return { text: '見つかりませんでした。', next: TO_MENU };
      return { text: GENERIC, next: null };
  }
}

/** 注文の画面の上に出す知らせ（?notice=）。未知の値は出さない */
export function noticeText(code: string | string[] | undefined): string | null {
  const v = Array.isArray(code) ? code[0] : code;
  if (v === 'payment_declined' || v === 'reservation_expired' || v === 'not_cancellable') return describeError({ code: v }).text;
  return null;
}

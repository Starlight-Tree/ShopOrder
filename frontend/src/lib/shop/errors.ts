// API のエラー（code）から、画面に出す固定の日本語の文と、直し方の行き先を選ぶ。
// API の message や例外の文字列は画面に出さない（未知の code は、汎用の固定文）。
import { MAX_ORDER_TOTAL_LUMI } from './constants';
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
      return { text: 'カートの内容が変わりました。もう一度、注文内容を確認してください。', next: TO_CHECKOUT };
    case 'idempotency_conflict':
      return { text: 'この確認画面は、別の内容で使われています。もう一度、注文内容を確認してください。', next: TO_CHECKOUT };
    case 'reservation_expired':
      return { text: '在庫の確保の期限が切れたため、この注文は取消されました。もう一度、メニューから注文してください。', next: TO_MENU };
    case 'payment_declined':
      return { text: 'お支払いに失敗しました（模擬）。この注文は取消され、在庫の確保も戻しました。もう一度、メニューから注文してください。', next: TO_MENU };
    case 'not_cancellable':
      return { text: 'お店が注文を受け付けたあとは、この画面から取消せません。取消したいときは、お店にお伝えください。', next: null };
    case 'delivery_unsupported':
      return { text: '宅配は準備中です。店頭でのお受け取りをお選びください。', next: null };
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

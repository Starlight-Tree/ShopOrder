// Server Action の中身（Cookie・redirect・refresh に依らない部分）。入力を確かめてから API を呼び、結果を ActionState にする。
// 'use server' の薄い入口は app/shop-actions/。ここは fetch を差し替えて試せる。
import { MAX_LINE_QTY } from './constants';
import { describeError } from './errors';
import { isValidPublicId, isValidToken, type Simulate } from './input';
import { getCart, postCancel, postOrder, postPay, putCartItem, putCartStore } from './queries';
import type { ActionState, ShopCtx } from './types';

type Failure = { ok: false; status: number; error: { code: string; [extra: string]: unknown } };

function fail(r: Failure): ActionState {
  const info = describeError(r.error, r.status);
  return { ok: false, message: info.text, ...(info.next ? { next: info.next } : {}) };
}

const INVALID: ActionState = { ok: false, message: '入力内容を確かめて、もう一度お試しください。' };

export async function selectStore(ctx: ShopCtx, storeId: number | null): Promise<ActionState> {
  if (storeId === null) return INVALID;
  const r = await putCartStore(ctx, storeId);
  if (!r.ok) return fail(r);
  return { ok: true, message: r.data.store ? `受け取る店を「${r.data.store.name}」にしました` : undefined };
}

/** 数量を絶対値で指定する（0 で外す）。+/- のボタンも、この関数に絶対値を渡す */
export async function setQty(ctx: ShopCtx, variantId: number | null, qty: number | null): Promise<ActionState> {
  if (variantId === null || qty === null) return INVALID;
  const r = await putCartItem(ctx, variantId, qty);
  if (!r.ok) return fail(r);
  return { ok: true };
}

/** 「カートに入れる」: 今の数量に 1 を足す（上限 20）。API は絶対値指定なので、先にカートを読む */
export async function addToCart(ctx: ShopCtx, variantId: number | null): Promise<ActionState> {
  if (variantId === null) return INVALID;
  const cart = await getCart(ctx);
  if (!cart.ok) return fail(cart);
  const current = cart.data.lines.find((l) => l.variant_id === variantId)?.qty ?? 0;
  if (current >= MAX_LINE_QTY) return { ok: false, message: `同じ品は ${MAX_LINE_QTY} 個までです。`, next: { label: 'カートを見る', href: '/cart' } };
  const r = await putCartItem(ctx, variantId, current + 1);
  if (!r.ok) return fail(r);
  return { ok: true, message: `カートに入れました（この品は ${current + 1} 個）` };
}

export type PlaceOrderResult = { state: ActionState; redirectTo: string | null };

/** 注文の確定。冪等キーは確認画面を描いたときに作ったもの（二重クリック・再送でも、注文は 1 つ） */
export async function placeOrder(ctx: ShopCtx, proposalId: string | null, idempotencyKey: string | null): Promise<PlaceOrderResult> {
  if (!isValidToken(proposalId) || !isValidToken(idempotencyKey)) return { state: INVALID, redirectTo: null };
  const r = await postOrder(ctx, proposalId, idempotencyKey);
  if (!r.ok) return { state: fail(r), redirectTo: null };
  return { state: { ok: true }, redirectTo: `/orders/${encodeURIComponent(r.data.public_id)}` };
}

export type PayResult = { state: ActionState; redirectTo: string | null };

/** 模擬の支払い。decline（失敗の模擬）は開発用で、devTools が false なら受け付けない */
export async function payOrder(ctx: ShopCtx, publicId: string | null, simulate: Simulate | null, devTools: boolean): Promise<PayResult> {
  if (!isValidPublicId(publicId) || simulate === null) return { state: INVALID, redirectTo: null };
  if (simulate === 'decline' && !devTools) return { state: INVALID, redirectTo: null };
  const r = await postPay(ctx, publicId, simulate);
  if (r.ok) return { state: { ok: true }, redirectTo: null };
  // 注文の状態が変わった失敗（支払いの失敗・確保の期限切れ）は、注文の画面の上に知らせを出す
  if (r.error.code === 'payment_declined' || r.error.code === 'reservation_expired') {
    return { state: fail(r), redirectTo: `/orders/${encodeURIComponent(publicId)}?notice=${r.error.code}` };
  }
  return { state: fail(r), redirectTo: null };
}

export type CancelResult = { state: ActionState; redirectTo: string | null };

/** 顧客の取消し。受付のあと（409 not_cancellable）は、注文の状態が変わっていて取消しの欄ごと消えるので、文は注文の画面の上に知らせとして出す */
export async function cancelOrder(ctx: ShopCtx, publicId: string | null): Promise<CancelResult> {
  if (!isValidPublicId(publicId)) return { state: INVALID, redirectTo: null };
  const r = await postCancel(ctx, publicId);
  if (r.ok) return { state: { ok: true }, redirectTo: null };
  if (r.error.code === 'not_cancellable') return { state: fail(r), redirectTo: `/orders/${encodeURIComponent(publicId)}?notice=not_cancellable` };
  return { state: fail(r), redirectTo: null };
}

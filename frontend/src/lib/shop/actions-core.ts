// Server Action の中身（Cookie・redirect・refresh に依らない部分）。入力を確かめてから API を呼び、結果を ActionState にする。
// 'use server' の薄い入口は app/shop-actions/。ここは fetch を差し替えて試せる。
import type { Cart, Fulfillment } from '../contract';
import { MAX_LINE_QTY } from './constants';
import { describeError } from './errors';
import { isValidPublicId, isValidToken, type AddressInput, type Simulate } from './input';
import { deleteAddress, getCart, postAddress, postCancel, postOrder, postPay, putCart, putCartItem, type CartSelection } from './queries';
import type { ActionState, ShopCtx } from './types';

type Failure = { ok: false; status: number; error: { code: string; [extra: string]: unknown } };

/** here は、いま開いている画面のパス。直し方のリンクがその画面自身なら、出さない */
function fail(r: Failure, here?: string): ActionState {
  const info = describeError(r.error, r.status);
  const next = info.next && info.next.href !== here ? info.next : null;
  return { ok: false, message: info.text, ...(next ? { next } : {}) };
}

const INVALID: ActionState = { ok: false, message: '入力内容を確かめて、もう一度お試しください。' };

/** カートの今の選択（住所・枠を、API が全部置き換えるので、変えない項目はここから写す） */
function currentSelection(cart: Cart): CartSelection {
  return {
    storeId: cart.store?.id ?? null,
    fulfillment: cart.fulfillment,
    addressId: cart.delivery?.address?.id ?? null,
    slotId: cart.delivery?.slot?.id ?? null,
  };
}

/**
 * 受け取る店を選ぶ。受け取り方法・住所は引き継ぐ（時間枠は店ごとなので外す）。
 * 宅配で、選んでいた住所がその店の届ける区画の外（409 out_of_zone）なら、住所を外して店を変える
 */
export async function selectStore(ctx: ShopCtx, storeId: number | null): Promise<ActionState> {
  if (storeId === null) return INVALID;
  const cart = await getCart(ctx);
  if (!cart.ok) return fail(cart);
  const now = currentSelection(cart.data);
  const next: CartSelection = now.fulfillment === 'delivery' ? { storeId, fulfillment: 'delivery', addressId: now.addressId, slotId: null } : { storeId, fulfillment: 'pickup' };
  let r = await putCart(ctx, next);
  let droppedAddress = false;
  if (!r.ok && r.error.code === 'out_of_zone' && next.addressId) {
    r = await putCart(ctx, { ...next, addressId: null });
    droppedAddress = r.ok;
  }
  if (!r.ok) return fail(r);
  const name = r.data.store ? `受け取る店を「${r.data.store.name}」にしました` : undefined;
  return { ok: true, message: droppedAddress && name ? `${name}。選んでいたお届け先は、この店では届けられないため外しました。` : name };
}

/** 受け取り方法（店頭・宅配）を切り替える。店は引き継ぎ、住所・時間枠は選びなおす（店頭では持たない） */
export async function selectFulfillment(ctx: ShopCtx, fulfillment: Fulfillment | null): Promise<ActionState> {
  if (fulfillment === null) return INVALID;
  const cart = await getCart(ctx);
  if (!cart.ok) return fail(cart, '/cart');
  const r = await putCart(ctx, { storeId: cart.data.store?.id ?? null, fulfillment });
  if (!r.ok) return fail(r, '/cart');
  return { ok: true, message: fulfillment === 'delivery' ? '宅配にしました。お届け先と時間枠を選んでください' : '店頭でのお受け取りにしました' };
}

/** 宅配の住所を選ぶ（店・時間枠は今のまま）。店が未選択なら、API を呼ばずに店を選ぶよう案内する */
export async function selectAddress(ctx: ShopCtx, addressId: number | null): Promise<ActionState> {
  if (addressId === null) return INVALID;
  const cart = await getCart(ctx);
  if (!cart.ok) return fail(cart, '/cart');
  if (!cart.data.store) return fail({ ok: false, status: 422, error: { code: 'store_required' } }, '/cart');
  const r = await putCart(ctx, { ...currentSelection(cart.data), fulfillment: 'delivery', addressId });
  if (!r.ok) return fail(r, '/cart');
  return { ok: true, message: 'お届け先を選びました' };
}

/** 宅配の時間枠を選ぶ（店・住所は今のまま）。満枠・締め切り（409）は、選びなおしを促す（カートは変わらない） */
export async function selectSlot(ctx: ShopCtx, slotId: number | null): Promise<ActionState> {
  if (slotId === null) return INVALID;
  const cart = await getCart(ctx);
  if (!cart.ok) return fail(cart, '/cart');
  if (!cart.data.store) return fail({ ok: false, status: 422, error: { code: 'store_required' } }, '/cart');
  const r = await putCart(ctx, { ...currentSelection(cart.data), fulfillment: 'delivery', slotId });
  if (!r.ok) return fail(r, '/cart');
  return { ok: true, message: 'お届けの時間枠を選びました' };
}

// ---- 住所（個人情報。入力・応答を、ログ・エラー文・戻り値に入れない） ----

const ADDRESS_INVALID: ActionState = {
  ok: false,
  message: '入力内容を確かめてください。ラベルは 1〜20 文字、住所は 1〜100 文字、メモは 100 文字までです。エリアは一覧から選んでください。',
};

/** 住所を登録する。input は parseAddressInput の結果（null なら、API を呼ばない） */
export async function addAddress(ctx: ShopCtx, input: AddressInput | null): Promise<ActionState> {
  if (input === null) return ADDRESS_INVALID;
  const r = await postAddress(ctx, input);
  if (!r.ok) return fail(r, '/addresses');
  return { ok: true, message: '住所を登録しました' };
}

/** 住所を削除する。選んでいたカートの住所は、API が外す。過去の注文は変わらない */
export async function removeAddress(ctx: ShopCtx, addressId: number | null): Promise<ActionState> {
  if (addressId === null) return INVALID;
  const r = await deleteAddress(ctx, addressId);
  if (!r.ok) return fail(r, '/addresses');
  return { ok: true, message: '住所を削除しました' };
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

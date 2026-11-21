// 画面のサーバー側から、API を呼ぶ関数。ブラウザーは API を直接呼ばない。
// 利用者は X-Dev-User（Cookie oasis_dev_user の値）で渡す。失敗は例外にせず、ApiResult で返す（呼ぶ側が code で文言を選ぶ）。
import { cache } from 'react';
import type { Cart, CheckoutProposal, Order, OrderSummary } from '../contract';
import { apiRequest, type ApiResult } from '../server-api';
import type { MenuItem, Store } from '../types';
import type { ShopCtx } from './types';

const seg = (v: string | number) => encodeURIComponent(String(v));

export const getStores = (ctx: ShopCtx) => apiRequest<Store[]>('/api/stores', { devUser: ctx.devUser });

/** store_id があれば、その店の在庫・時間帯を見た available がつく */
export const getMenu = (ctx: ShopCtx, storeId?: number | null) =>
  apiRequest<MenuItem[]>(storeId ? `/api/menu?store_id=${seg(storeId)}` : '/api/menu', { devUser: ctx.devUser });

export const getCart = (ctx: ShopCtx) => apiRequest<Cart>('/api/cart', { devUser: ctx.devUser });

// 画面の描画では、ヘッダーとページが同時にカートを読む（空のカートの作成が重ならないよう、1 回にまとめる）。
// Server Action の中では使わない（書き込みのあと、同じ要求の再描画で古い値を返さないため）。
const cartOnce = cache((devUser: string | undefined) => apiRequest<Cart>('/api/cart', { devUser }));
const getCartForRender = (ctx: ShopCtx) => cartOnce(ctx.devUser);

/** 店と受け取り方法（店頭のみ）。宅配は P2 まで */
export const putCartStore = (ctx: ShopCtx, storeId: number | null) =>
  apiRequest<Cart>('/api/cart', { method: 'PUT', body: { store_id: storeId, fulfillment: 'pickup' }, devUser: ctx.devUser });

/** 数量の絶対値指定。0 で外す */
export const putCartItem = (ctx: ShopCtx, variantId: number, qty: number) =>
  apiRequest<Cart>(`/api/cart/items/${seg(variantId)}`, { method: 'PUT', body: { qty }, devUser: ctx.devUser });

export const postCheckoutProposal = (ctx: ShopCtx) =>
  apiRequest<CheckoutProposal>('/api/cart/checkout-proposal', { method: 'POST', devUser: ctx.devUser });

/** 注文の確定。呼べるのは画面の確定ボタン（Server Action）だけ */
export const postOrder = (ctx: ShopCtx, proposalId: string, idempotencyKey: string) =>
  apiRequest<Order>('/api/orders', { method: 'POST', body: { proposal_id: proposalId }, devUser: ctx.devUser, idempotencyKey });

export const getOrders = (ctx: ShopCtx) => apiRequest<OrderSummary[]>('/api/orders', { devUser: ctx.devUser });

export const getOrder = (ctx: ShopCtx, publicId: string) => apiRequest<Order>(`/api/orders/${seg(publicId)}`, { devUser: ctx.devUser });

export const postPay = (ctx: ShopCtx, publicId: string, simulate: 'ok' | 'decline') =>
  apiRequest<Order>(`/api/orders/${seg(publicId)}/pay`, { method: 'POST', body: { simulate }, devUser: ctx.devUser });

export const postCancel = (ctx: ShopCtx, publicId: string) =>
  apiRequest<Order>(`/api/orders/${seg(publicId)}/cancel`, { method: 'POST', devUser: ctx.devUser });

// ---- 画面ごとのまとめ取得 ----

export type MenuPageData = {
  stores: Store[];
  /** カートが読めなかったら null（メニューは見せるが、注文はできない） */
  cart: Cart | null;
  /** カートの店（stores に無ければ null） */
  selectedStore: Store | null;
  menu: MenuItem[];
};

/** メニュー画面: 店の一覧・カート・メニュー（カートの店があれば、その店の在庫を見た形） */
export async function loadMenuPage(ctx: ShopCtx): Promise<ApiResult<MenuPageData>> {
  const [stores, cart] = await Promise.all([getStores(ctx), getCartForRender(ctx)]);
  if (!stores.ok) return stores;
  const cartData = cart.ok ? cart.data : null;
  const selectedStore = cartData?.store ? (stores.data.find((s) => s.id === cartData.store?.id) ?? null) : null;
  const menu = await getMenu(ctx, selectedStore?.id ?? null);
  if (!menu.ok) return menu;
  return { ok: true, status: 200, data: { stores: stores.data, cart: cartData, selectedStore, menu: menu.data } };
}

export type CartPageData = { cart: Cart; store: Store | null };

/** カート画面: カートと、その店（営業中か見るため。店の一覧が読めなくてもカートは見せる） */
export async function loadCartPage(ctx: ShopCtx): Promise<ApiResult<CartPageData>> {
  const [cart, stores] = await Promise.all([getCartForRender(ctx), getStores(ctx)]);
  if (!cart.ok) return cart;
  const store = cart.data.store && stores.ok ? (stores.data.find((s) => s.id === cart.data.store?.id) ?? null) : null;
  return { ok: true, status: 200, data: { cart: cart.data, store } };
}

/** ヘッダーのカートの点数。読めなければ null（点数を出さない） */
export async function loadCartCount(ctx: ShopCtx): Promise<number | null> {
  const cart = await getCartForRender(ctx);
  return cart.ok ? cart.data.lines.reduce((sum, l) => sum + l.qty, 0) : null;
}

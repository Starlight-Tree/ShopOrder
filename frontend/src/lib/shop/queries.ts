// 画面のサーバー側から、API を呼ぶ関数。ブラウザーは API を直接呼ばない。
// 利用者は X-Dev-User（Cookie shop_order_dev_user の値）で渡す。失敗は例外にせず、ApiResult で返す（呼ぶ側が code で文言を選ぶ）。
import { cache } from 'react';
import type { Address, Cart, CheckoutProposal, Fulfillment, Order, OrderSummary } from '../contract';
import { apiRequest, type ApiResult } from '../server-api';
import type { MenuItem, SlotList, Store, Zone } from '../types';
import { dayOptions, parseDateParam, type DayOption } from './delivery-view';
import { localDate } from './format';
import type { AddressInput } from './input';
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

/** カートの店・受け取り方法・宅配の住所と時間枠。API はこの全部を置き換える（省略した住所・枠は null） */
export type CartSelection = { storeId: number | null; fulfillment: Fulfillment; addressId?: number | null; slotId?: number | null };

/** PUT /api/cart。店頭には住所・枠を付けない（付けると 422 pickup_with_delivery_fields） */
export const putCart = (ctx: ShopCtx, sel: CartSelection) =>
  apiRequest<Cart>('/api/cart', {
    method: 'PUT',
    body:
      sel.fulfillment === 'delivery'
        ? { store_id: sel.storeId, fulfillment: 'delivery', address_id: sel.addressId ?? null, slot_id: sel.slotId ?? null }
        : { store_id: sel.storeId, fulfillment: 'pickup' },
    devUser: ctx.devUser,
  });

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

// ---- 宅配（P2）: 住所・区画・時間枠 ----

export const getAddresses = (ctx: ShopCtx) => apiRequest<Address[]>('/api/addresses', { devUser: ctx.devUser });

/** 住所の登録。本文（住所・メモ）は個人情報。呼ぶ側もここも、ログ・例外・URL に出さない */
export const postAddress = (ctx: ShopCtx, input: AddressInput) =>
  apiRequest<Address>('/api/addresses', {
    method: 'POST',
    body: { label: input.label, area_code: input.areaCode, line: input.line, note: input.note },
    devUser: ctx.devUser,
  });

export const deleteAddress = (ctx: ShopCtx, addressId: number) => apiRequest<void>(`/api/addresses/${seg(addressId)}`, { method: 'DELETE', devUser: ctx.devUser });

/** 区画の一覧。storeId があれば、その店が届ける区画だけ（宅配をしない店は []） */
export const getZones = (ctx: ShopCtx, storeId?: number | null) =>
  apiRequest<Zone[]>(storeId ? `/api/delivery/zones?store_id=${seg(storeId)}` : '/api/delivery/zones', { devUser: ctx.devUser });

/** その日（YYYY-MM-DD。店の時間帯）の時間枠。zoneId があれば、その区画の砂嵐を反映する */
export const getSlots = (ctx: ShopCtx, storeId: number, date: string, zoneId?: number | null) =>
  apiRequest<SlotList>(`/api/stores/${seg(storeId)}/slots?date=${seg(date)}${zoneId ? `&zone_id=${seg(zoneId)}` : ''}`, { devUser: ctx.devUser });

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

/** 宅配のカートの、住所と時間枠の選択に使うデータ（読めなかったものは null。カートそのものは見せる） */
export type DeliveryPicks = {
  addresses: Address[] | null;
  /** 時間枠を選べる日（今日から 7 日先まで） */
  days: DayOption[];
  /** 枠を出している日（YYYY-MM-DD） */
  date: string;
  /** 住所が選ばれていて、読めたときだけ（住所を選ぶと、その区画の砂嵐を反映できる） */
  slots: SlotList | null;
  slotsFailed: boolean;
};

export type CartPageData = {
  cart: Cart;
  store: Store | null;
  /** カートの店が届ける区画（店が選ばれていて、読めたとき）。空なら、この店は宅配をしていない。読めなければ null（判断は API に任せる） */
  zones: Zone[] | null;
  /** 宅配のカート（店が選ばれている）のときだけ */
  delivery: DeliveryPicks | null;
};

/**
 * カート画面: カートと、その店（営業中か見るため）、宅配なら住所・時間枠。
 * 店の一覧・区画・住所・枠が読めなくても、カートは見せる。date は ?date=（今日から 7 日先まで。無ければ、選んだ枠の日、無ければ今日）
 */
export async function loadCartPage(ctx: ShopCtx, opts: { date?: string | string[] | null; now?: number } = {}): Promise<ApiResult<CartPageData>> {
  const [cart, stores] = await Promise.all([getCartForRender(ctx), getStores(ctx)]);
  if (!cart.ok) return cart;
  const c = cart.data;
  const store = c.store && stores.ok ? (stores.data.find((s) => s.id === c.store?.id) ?? null) : null;
  const storeId = c.store?.id ?? null;
  const delivering = storeId !== null && c.fulfillment === 'delivery';

  const days = dayOptions(opts.now ?? Date.now());
  const selectedDay = c.delivery?.slot ? parseDateParam(localDate(c.delivery.slot.starts_at) ?? undefined, days) : null;
  const date = parseDateParam(opts.date ?? undefined, days) ?? selectedDay ?? days[0]!.date;
  const address = c.delivery?.address ?? null;

  const [zones, addresses, slots] = await Promise.all([
    storeId !== null ? getZones(ctx, storeId) : null,
    delivering ? getAddresses(ctx) : null,
    delivering && address ? getSlots(ctx, storeId, date, c.delivery?.zone?.id ?? null) : null,
  ]);
  return {
    ok: true,
    status: 200,
    data: {
      cart: c,
      store,
      zones: zones?.ok ? zones.data : null,
      delivery: delivering ? { addresses: addresses?.ok ? addresses.data : null, days, date, slots: slots?.ok ? slots.data : null, slotsFailed: slots !== null && !slots.ok } : null,
    },
  };
}

export type AddressesPageData = { addresses: Address[]; zones: Zone[] | null };

/** 住所の画面: 住所の一覧と、エリアの選択肢（区画）。区画が読めなくても、一覧は見せる */
export async function loadAddressesPage(ctx: ShopCtx): Promise<ApiResult<AddressesPageData>> {
  const [addresses, zones] = await Promise.all([getAddresses(ctx), getZones(ctx)]);
  if (!addresses.ok) return addresses;
  return { ok: true, status: 200, data: { addresses: addresses.data, zones: zones.ok ? zones.data : null } };
}

/** ヘッダーのカートの点数。読めなければ null（点数を出さない） */
export async function loadCartCount(ctx: ShopCtx): Promise<number | null> {
  const cart = await getCartForRender(ctx);
  return cart.ok ? cart.data.lines.reduce((sum, l) => sum + l.qty, 0) : null;
}

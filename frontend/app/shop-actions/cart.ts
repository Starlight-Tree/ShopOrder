'use server';

import { refresh } from 'next/cache';
import { addToCart, selectAddress, selectFulfillment, selectSlot, selectStore, setQty } from '../../src/lib/shop/actions-core';
import { formString, parseFulfillment, parseId, parseQty } from '../../src/lib/shop/input';
import { getShopCtx } from '../../src/lib/shop/session';
import type { ActionState } from '../../src/lib/shop/types';

// ブラウザーから届く値は信用しない（parseId / parseQty で型と範囲を確かめる）。API を呼ぶのは、画面のサーバー側だけ。

/** 受け取る店を選ぶ（PUT /api/cart） */
export async function selectStoreAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await selectStore(await getShopCtx(), parseId(formString(formData, 'store_id')));
  refresh();
  return state;
}

/** 「カートに入れる」（今の数量 + 1） */
export async function addToCartAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await addToCart(await getShopCtx(), parseId(formString(formData, 'variant_id')));
  refresh();
  return state;
}

/** 行の数量（−・＋・削除）。数量は絶対値で受ける（0 で外す） */
export async function setQtyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await setQty(await getShopCtx(), parseId(formString(formData, 'variant_id')), parseQty(formString(formData, 'qty')));
  refresh();
  return state;
}

/** 受け取り方法（店頭・宅配）を切り替える（PUT /api/cart） */
export async function selectFulfillmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await selectFulfillment(await getShopCtx(), parseFulfillment(formString(formData, 'fulfillment')));
  refresh();
  return state;
}

/** 宅配のお届け先の住所を選ぶ（PUT /api/cart）。住所の本文は扱わない（ID だけ） */
export async function selectAddressAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await selectAddress(await getShopCtx(), parseId(formString(formData, 'address_id')));
  refresh();
  return state;
}

/** 宅配のお届けの時間枠を選ぶ（PUT /api/cart）。満枠・締め切りの失敗でも、枠の一覧を新しくする */
export async function selectSlotAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await selectSlot(await getShopCtx(), parseId(formString(formData, 'slot_id')));
  refresh();
  return state;
}

'use server';

import { refresh } from 'next/cache';
import { addToCart, selectStore, setQty } from '../../src/lib/shop/actions-core';
import { formString, parseId, parseQty } from '../../src/lib/shop/input';
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

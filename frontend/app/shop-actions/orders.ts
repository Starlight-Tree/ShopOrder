'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { cancelOrder, payOrder, placeOrder } from '../../src/lib/shop/actions-core';
import { devToolsEnabled } from '../../src/lib/shop/dev-user';
import { formString, parseSimulate } from '../../src/lib/shop/input';
import { getShopCtx } from '../../src/lib/shop/session';
import type { ActionState } from '../../src/lib/shop/types';

/**
 * 注文を確定する（POST /api/orders）。確定の API を呼べるのは、確認画面のこのボタン（Server Action）だけ。
 * 冪等キー・提案の ID は、確認画面を描いたときに作ったもの。
 */
export async function placeOrderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { state, redirectTo } = await placeOrder(await getShopCtx(), formString(formData, 'proposal_id'), formString(formData, 'idempotency_key'));
  if (redirectTo) {
    // 確定でカートが空になる。ヘッダーの点数も新しくしてから、注文の画面へ進む
    refresh();
    redirect(redirectTo);
  }
  return state;
}

/** 模擬の支払い（ok は支払い、decline は失敗の模擬。decline は開発用） */
export async function payOrderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { state, redirectTo } = await payOrder(await getShopCtx(), formString(formData, 'public_id'), parseSimulate(formString(formData, 'simulate')), devToolsEnabled());
  refresh();
  if (redirectTo) redirect(redirectTo);
  return state;
}

/** 顧客の取消し（placed / paid のとき） */
export async function cancelOrderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { state, redirectTo } = await cancelOrder(await getShopCtx(), formString(formData, 'public_id'));
  refresh();
  if (redirectTo) redirect(redirectTo);
  return state;
}

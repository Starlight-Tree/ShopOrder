'use server';

import { refresh } from 'next/cache';
import { addAddress, removeAddress } from '../../src/lib/shop/actions-core';
import { formString, parseAddressInput, parseId } from '../../src/lib/shop/input';
import { getShopCtx } from '../../src/lib/shop/session';
import type { ActionState } from '../../src/lib/shop/types';

// 住所（line・note）は個人情報。入力も応答も、ログ・エラー文・戻り値に入れない（戻り値は固定の文だけ）。

/** 住所を登録する（POST /api/addresses） */
export async function createAddressAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await addAddress(await getShopCtx(), parseAddressInput(formData));
  refresh();
  return state;
}

/** 住所を削除する（DELETE /api/addresses/{id}） */
export async function deleteAddressAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const state = await removeAddress(await getShopCtx(), parseId(formString(formData, 'address_id')));
  refresh();
  return state;
}

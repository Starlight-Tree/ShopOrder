'use server';

import { refresh } from 'next/cache';
import { cookies } from 'next/headers';
import { DEV_USER_COOKIE } from '../../src/lib/shop/constants';
import { devToolsEnabled, isValidDevUser } from '../../src/lib/shop/dev-user';
import { formString } from '../../src/lib/shop/input';
import type { ActionState } from '../../src/lib/shop/types';

/** 開発用ログイン名を Cookie（shop_order_dev_user）に入れる。値は [a-z0-9-]{1,40} だけ。本番（NODE_ENV=production）では受け付けない */
export async function setDevUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!devToolsEnabled()) return { ok: false, message: 'この環境では使えません。' };
  const jar = await cookies();
  if (formString(formData, 'reset')) {
    jar.delete(DEV_USER_COOKIE);
    refresh();
    return { ok: true, message: '既定の利用者に戻しました' };
  }
  const name = (formString(formData, 'dev_user') ?? '').trim();
  if (!isValidDevUser(name)) return { ok: false, message: '半角の小文字・数字・ハイフン（1〜40 文字）で入力してください。' };
  jar.set(DEV_USER_COOKIE, name, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 });
  refresh();
  return { ok: true, message: `ログイン名を ${name} にしました` };
}

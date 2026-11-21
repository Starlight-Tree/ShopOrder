// 要求の Cookie から、API へ渡す利用者（開発用ログイン名）を取り出す。Server Component / Server Action の中だけで使う。
import { cookies } from 'next/headers';
import { DEV_USER_COOKIE } from './constants';
import { devUserFromCookie } from './dev-user';
import type { ShopCtx } from './types';

export async function getShopCtx(): Promise<ShopCtx> {
  const jar = await cookies();
  return { devUser: devUserFromCookie(jar.get(DEV_USER_COOKIE)?.value) };
}

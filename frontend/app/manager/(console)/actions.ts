'use server';
// 分析画面の Server Action（ログアウトだけ）。トークンは API 側でも無効にして、Cookie を消す。
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { clearedManagerCookieOptions, MANAGER_COOKIE } from '../../../src/lib/manager/cookie';
import { performLogout } from '../../../src/lib/staff/commands';

export async function managerLogoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(MANAGER_COOKIE)?.value;
  if (token) await performLogout(token);
  store.set(MANAGER_COOKIE, '', clearedManagerCookieOptions(process.env.NODE_ENV));
  redirect('/manager/login');
}

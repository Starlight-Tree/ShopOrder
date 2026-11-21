// 認証切れ（API がトークンを拒んだ）のとき、分析画面の layout / page が redirect してくる先。
// Server Component は Cookie を消せないので、ここ（Route Handler）で消して、ログインへ戻す。
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { clearedManagerCookieOptions, MANAGER_COOKIE } from '../../../src/lib/manager/cookie';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<never> {
  (await cookies()).set(MANAGER_COOKIE, '', clearedManagerCookieOptions(process.env.NODE_ENV));
  return redirect('/manager/login');
}

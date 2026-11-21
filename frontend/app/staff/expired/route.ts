// 認証切れ（API がトークンを拒んだ）のとき、業務画面の layout / page が redirect してくる先。
// Server Component は Cookie を消せないので、ここ（Route Handler）で消して、ログインへ戻す。
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { clearedCookieOptions, STAFF_COOKIE } from '../../../src/lib/staff/cookie';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<never> {
  (await cookies()).set(STAFF_COOKIE, '', clearedCookieOptions(process.env.NODE_ENV));
  return redirect('/staff/login');
}

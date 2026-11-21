'use server';
// ログイン。API が返したトークンは、HttpOnly の Cookie に入れるだけで、画面（クライアント）へは返さない。
// 進む先は role で振り分ける（配達員は /staff/courier、それ以外は /staff）。表示の振り分けだけで、権限は API が毎回決める。
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { performLogin } from '../../../src/lib/staff/commands';
import { STAFF_COOKIE, staffCookieOptions } from '../../../src/lib/staff/cookie';
import { staffHomePath } from '../../../src/lib/staff/courier';
import type { LoginState } from '../../../src/lib/staff/types';

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const result = await performLogin(formData.get('email'), formData.get('password'));
  if (!result.ok) return { error: result.message };
  (await cookies()).set(STAFF_COOKIE, result.token, staffCookieOptions(result.expiresAt, process.env.NODE_ENV));
  redirect(staffHomePath(result.staff.role));
}

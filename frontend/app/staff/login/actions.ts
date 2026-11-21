'use server';
// ログイン。API が返したトークンは、HttpOnly の Cookie に入れるだけで、画面（クライアント）へは返さない。
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { performLogin } from '../../../src/lib/staff/commands';
import { STAFF_COOKIE, staffCookieOptions } from '../../../src/lib/staff/cookie';
import type { LoginState } from '../../../src/lib/staff/types';

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const result = await performLogin(formData.get('email'), formData.get('password'));
  if (!result.ok) return { error: result.message };
  (await cookies()).set(STAFF_COOKIE, result.token, staffCookieOptions(result.expiresAt, process.env.NODE_ENV));
  redirect('/staff');
}

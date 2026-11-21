'use server';
// ログイン（スタッフと同じ API）。API が返したトークンは、HttpOnly の Cookie に入れるだけで、画面（クライアント）へは返さない。
// Cookie は、スタッフの画面と同じ名前（shop_order_staff）で、Path=/manager（スタッフの Cookie は Path=/staff で /manager に届かないため）。
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { MANAGER_COOKIE, managerCookieOptions } from '../../../src/lib/manager/cookie';
import { performLogin } from '../../../src/lib/staff/commands';
import type { LoginState } from '../../../src/lib/staff/types';

export async function managerLoginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const result = await performLogin(formData.get('email'), formData.get('password'));
  if (!result.ok) return { error: result.message };
  (await cookies()).set(MANAGER_COOKIE, result.token, managerCookieOptions(result.expiresAt, process.env.NODE_ENV));
  redirect('/manager');
}

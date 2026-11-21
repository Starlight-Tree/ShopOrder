'use server';
// 配達員の操作の Server Action。ブラウザーから呼ばれるので、毎回 Cookie のトークンを読み、API が権限（配達員か・自分の担当か）を確かめる。
// 認証切れ（401）のときは、Cookie を消してログインへ。暗証コードは、ここでも、ログや戻り値に出さない。
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { clearedCookieOptions, STAFF_COOKIE } from '../../../src/lib/staff/cookie';
import { performCourierAction } from '../../../src/lib/staff/courier-commands';
import type { CourierActionInput, DeliveryOutcome } from '../../../src/lib/staff/delivery-types';
import { readStaffToken } from '../../../src/lib/staff/session';

export async function courierAction(input: CourierActionInput): Promise<DeliveryOutcome> {
  const token = await readStaffToken();
  if (!token) redirect('/staff/login');
  const result = await performCourierAction(token, input);
  if (!result.ok && result.kind === 'unauthorized') {
    (await cookies()).set(STAFF_COOKIE, '', clearedCookieOptions(process.env.NODE_ENV));
    redirect('/staff/login');
  }
  // 成功と、状態が変わった（他の人が先に操作・暗証コードの回数が減った）ときは、一覧を最新にする
  if (result.ok || result.refresh) revalidatePath('/staff/courier');
  return result;
}

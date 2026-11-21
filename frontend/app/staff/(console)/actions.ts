'use server';
// 業務画面の Server Action。ブラウザーから呼ばれるので、毎回 Cookie のトークンを読み、API が権限を確かめる。
// 認証切れ（401）のときは、Cookie を消してログインへ。
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { performLogout, performStockOp, performTransition } from '../../../src/lib/staff/commands';
import { clearedCookieOptions, STAFF_COOKIE } from '../../../src/lib/staff/cookie';
import type { StockFormState, StockOp, TransitionInput, TransitionResult } from '../../../src/lib/staff/types';

async function tokenOrLogin(): Promise<string> {
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) redirect('/staff/login');
  return token;
}

async function expireAndLogin(): Promise<never> {
  (await cookies()).set(STAFF_COOKIE, '', clearedCookieOptions(process.env.NODE_ENV));
  return redirect('/staff/login');
}

export async function transitionAction(input: TransitionInput): Promise<TransitionResult> {
  const token = await tokenOrLogin();
  const result = await performTransition(token, input);
  if (!result.ok && result.kind === 'unauthorized') return expireAndLogin();
  // 成功と、他の人が先に操作した（409・404）ときは、ボードを最新にする
  if (result.ok || result.kind === 'conflict' || result.kind === 'not_found') revalidatePath('/staff');
  return result;
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(STAFF_COOKIE)?.value;
  if (token) await performLogout(token);
  store.set(STAFF_COOKIE, '', clearedCookieOptions(process.env.NODE_ENV));
  redirect('/staff/login');
}

async function runStock(op: StockOp, prev: StockFormState, formData: FormData): Promise<StockFormState> {
  const token = await tokenOrLogin();
  const result = await performStockOp(token, op, {
    itemId: formData.get('item_id'),
    amount: formData.get(op === 'adjust' ? 'delta' : 'qty'),
    reason: formData.get('reason'),
  });
  if (!result.ok && result.kind === 'unauthorized') return expireAndLogin();
  if (result.ok || (!result.ok && result.kind === 'not_found')) revalidatePath('/staff/stock');
  return { status: result.ok ? 'ok' : 'error', message: result.message, seq: prev.seq + 1 };
}

export async function receiveStockAction(prev: StockFormState, formData: FormData): Promise<StockFormState> {
  return runStock('receive', prev, formData);
}
export async function wasteStockAction(prev: StockFormState, formData: FormData): Promise<StockFormState> {
  return runStock('waste', prev, formData);
}
export async function adjustStockAction(prev: StockFormState, formData: FormData): Promise<StockFormState> {
  return runStock('adjust', prev, formData);
}

'use server';
// 配車ボードの Server Action。ブラウザーから呼ばれるので、毎回 Cookie のトークンを読み、API が権限を確かめる。
// 入口は薄く、入力の検査と API の呼び出しは lib/staff/dispatch-commands.ts。認証切れ（401）のときは、Cookie を消してログインへ。
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { clearedCookieOptions, STAFF_COOKIE } from '../../../../src/lib/staff/cookie';
import type { AssignInput, DeliveryOutcome, DispatchCancelInput, MockAdvanceInput, RedeliverInput, SuspensionInput } from '../../../../src/lib/staff/delivery-types';
import { performAssign, performDispatchCancel, performMockAdvance, performRedeliver, performSuspension } from '../../../../src/lib/staff/dispatch-commands';

async function run(op: (token: string) => Promise<DeliveryOutcome>): Promise<DeliveryOutcome> {
  const store = await cookies();
  const token = store.get(STAFF_COOKIE)?.value;
  if (!token) redirect('/staff/login');
  const result = await op(token);
  if (!result.ok && result.kind === 'unauthorized') {
    store.set(STAFF_COOKIE, '', clearedCookieOptions(process.env.NODE_ENV));
    return redirect('/staff/login');
  }
  // 成功と、他の人が先に操作した・状態が変わったとき（refresh）は、配車ボードと調理ボードを最新にする
  if (result.ok || result.refresh) {
    revalidatePath('/staff/dispatch');
    revalidatePath('/staff');
  }
  return result;
}

export async function assignAction(input: AssignInput): Promise<DeliveryOutcome> {
  return run((token) => performAssign(token, input));
}

export async function redeliverAction(input: RedeliverInput): Promise<DeliveryOutcome> {
  return run((token) => performRedeliver(token, input));
}

export async function mockAdvanceAction(input: MockAdvanceInput): Promise<DeliveryOutcome> {
  return run((token) => performMockAdvance(token, input));
}

export async function suspensionAction(input: SuspensionInput): Promise<DeliveryOutcome> {
  return run((token) => performSuspension(token, input));
}

export async function cancelDeliveryAction(input: DispatchCancelInput): Promise<DeliveryOutcome> {
  return run((token) => performDispatchCancel(token, input));
}

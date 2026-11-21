// サーバー側（Server Component・Server Action・Route Handler）で、Cookie のトークンと、今のスタッフを扱う。
// トークンはここで読んで API へ付けるだけ。クライアントへは渡さない。
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { Staff } from '../contract';
import { loadStores, resolveSession, type SessionState } from './loaders';
import { STAFF_COOKIE } from './cookie';

export async function readStaffToken(): Promise<string | null> {
  return (await cookies()).get(STAFF_COOKIE)?.value ?? null;
}

/** 1 回の描画の中では、/api/staff/me を 1 回だけ呼ぶ（layout と page で共有） */
export const getSession = cache(async (): Promise<SessionState> => resolveSession(await readStaffToken()));

export const getStores = cache(async () => loadStores());

/**
 * 業務画面の page が呼ぶ。layout は、画面の移動（クライアント側）のたびには走らないので、page でも確かめる。
 * Cookie が無ければログインへ。API に拒まれたら、Cookie を消す経路（/staff/expired）へ。
 * API に聞けなかったときは null（画面で「接続できません」を出す。Cookie は消さない）。
 */
export async function requireStaff(): Promise<{ token: string; staff: Staff } | null> {
  const s = await getSession();
  if (s.kind === 'ok') return { token: s.token, staff: s.staff };
  if (s.kind === 'unavailable') return null;
  return redirect(s.kind === 'expired' ? '/staff/expired' : '/staff/login');
}

// サーバー側（Server Component・Server Action・Route Handler）で、Cookie のトークンと、今のスタッフを扱う。
// スタッフの画面（src/lib/staff/session.ts）と同じ流儀。違いは、移動先が /manager/login・/manager/expired なこと（Cookie の Path が /manager のため）。
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { Staff } from '../contract';
import { resolveSession, type SessionState } from '../staff/loaders';
import { MANAGER_COOKIE } from './cookie';

export async function readManagerToken(): Promise<string | null> {
  return (await cookies()).get(MANAGER_COOKIE)?.value ?? null;
}

/** 1 回の描画の中では、/api/staff/me を 1 回だけ呼ぶ（layout と page で共有） */
export const getSession = cache(async (): Promise<SessionState> => resolveSession(await readManagerToken()));

/**
 * 分析画面の page が呼ぶ。layout は画面の移動のたびには走らないので、page でも確かめる。
 * Cookie が無ければログインへ。API に拒まれたら、Cookie を消す経路（/manager/expired）へ。API に聞けなかったときは null（「接続できません」を出す）。
 */
export async function requireManagerSession(): Promise<{ token: string; staff: Staff } | null> {
  const s = await getSession();
  if (s.kind === 'ok') return { token: s.token, staff: s.staff };
  if (s.kind === 'unavailable') return null;
  return redirect(s.kind === 'expired' ? '/manager/expired' : '/manager/login');
}

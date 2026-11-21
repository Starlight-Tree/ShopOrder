// 店長の画面（/manager）の Cookie。スタッフのログイン Cookie（shop_order_staff）と同じ名前・同じトークン（POST /api/staff/login）。
// ただしスタッフの Cookie は Path=/staff なので、/manager には送られない。そこで /manager のログインは、同じ名前の Cookie を Path=/manager で別に出す
// （/staff の Cookie には触らない。ブラウザーは Path の違う同名の Cookie を別々に持つ）。属性（HttpOnly・SameSite=Lax・production で Secure・期限）は共通部をそのまま使う。
import { clearedCookieOptions, STAFF_COOKIE, staffCookieOptions, type StaffCookieOptions } from '../staff/cookie';

export const MANAGER_COOKIE = STAFF_COOKIE;
export const MANAGER_COOKIE_PATH = '/manager';

export function managerCookieOptions(expiresAt: string | null | undefined, nodeEnv: string | undefined, now?: number): StaffCookieOptions {
  return { ...staffCookieOptions(expiresAt, nodeEnv, now), path: MANAGER_COOKIE_PATH };
}

/** 消す属性。Path が違うと消えないので、出したときと同じ Path にする */
export function clearedManagerCookieOptions(nodeEnv: string | undefined): StaffCookieOptions {
  return { ...clearedCookieOptions(nodeEnv), path: MANAGER_COOKIE_PATH };
}

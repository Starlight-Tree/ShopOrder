// スタッフのトークンを入れる Cookie。HttpOnly（画面の JavaScript から読めない）・SameSite=Lax・Path=/staff・production では Secure。
// トークンはサーバー側（Server Component・Server Action）だけが読み、クライアントへ渡さない。
export const STAFF_COOKIE = 'shop_order_staff';
export const STAFF_COOKIE_PATH = '/staff';
/** API の既定の有効期間（docs/api.md: 12 時間）。expires_at が読めないときに使う */
export const DEFAULT_MAX_AGE_SECONDS = 12 * 60 * 60;

export type StaffCookieOptions = {
  httpOnly: true;
  sameSite: 'lax';
  path: string;
  secure: boolean;
  expires?: Date;
  maxAge?: number;
};

const base = (nodeEnv: string | undefined) =>
  ({ httpOnly: true, sameSite: 'lax', path: STAFF_COOKIE_PATH, secure: nodeEnv === 'production' }) as const;

/** ログイン時の Cookie の属性。API が返した expires_at が未来なら、それまで。読めなければ 12 時間 */
export function staffCookieOptions(expiresAt: string | null | undefined, nodeEnv: string | undefined, now: number = Date.now()): StaffCookieOptions {
  const t = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isFinite(t) && t > now) return { ...base(nodeEnv), expires: new Date(t) };
  return { ...base(nodeEnv), maxAge: DEFAULT_MAX_AGE_SECONDS };
}

/** Cookie を消す属性。Path が違うと消えないので、設定したときと同じ Path・Secure で、期限を 0 にする */
export function clearedCookieOptions(nodeEnv: string | undefined): StaffCookieOptions {
  return { ...base(nodeEnv), maxAge: 0 };
}

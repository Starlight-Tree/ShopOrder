import { describe, expect, it } from 'vitest';
import { STAFF_COOKIE } from '../staff/cookie';
import { clearedManagerCookieOptions, MANAGER_COOKIE, managerCookieOptions, MANAGER_COOKIE_PATH } from './cookie';

describe('店長の画面の Cookie', () => {
  it('名前はスタッフの Cookie と同じ（shop_order_staff）。Path だけ /manager', () => {
    expect(MANAGER_COOKIE).toBe(STAFF_COOKIE);
    expect(MANAGER_COOKIE_PATH).toBe('/manager');
    const o = managerCookieOptions('2026-11-21T12:00:00Z', 'development', Date.parse('2026-11-21T00:00:00Z'));
    expect(o).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/manager', secure: false });
    expect(o.expires).toEqual(new Date('2026-11-21T12:00:00Z'));
  });
  it('production では Secure。期限が読めなければ 12 時間', () => {
    const o = managerCookieOptions(null, 'production');
    expect(o).toMatchObject({ secure: true, path: '/manager', maxAge: 12 * 60 * 60 });
  });
  it('消すときも Path は /manager（Path が違うと消えない）', () => {
    expect(clearedManagerCookieOptions('production')).toMatchObject({ path: '/manager', maxAge: 0, httpOnly: true, secure: true });
  });
});

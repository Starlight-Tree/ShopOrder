import { describe, expect, it } from 'vitest';
import { clearedCookieOptions, DEFAULT_MAX_AGE_SECONDS, STAFF_COOKIE, staffCookieOptions } from './cookie';

const NOW = Date.parse('2026-11-21T03:00:00Z');

describe('staffCookieOptions', () => {
  it('名前は shop_order_staff。HttpOnly・SameSite=Lax・Path=/staff', () => {
    expect(STAFF_COOKIE).toBe('shop_order_staff');
    const o = staffCookieOptions('2026-11-21T15:00:00Z', 'development', NOW);
    expect(o).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/staff', secure: false });
    expect(o.expires).toEqual(new Date('2026-11-21T15:00:00Z'));
  });

  it('production では Secure。production 以外では付けない（http://localhost で動くように）', () => {
    expect(staffCookieOptions('2026-11-21T15:00:00Z', 'production', NOW).secure).toBe(true);
    expect(staffCookieOptions('2026-11-21T15:00:00Z', 'test', NOW).secure).toBe(false);
    expect(staffCookieOptions('2026-11-21T15:00:00Z', undefined, NOW).secure).toBe(false);
  });

  it('expires_at が読めない・過去なら、12 時間', () => {
    for (const bad of [null, undefined, '', '壊れた', '2026-11-21T02:00:00Z']) {
      const o = staffCookieOptions(bad, 'production', NOW);
      expect(o.maxAge).toBe(DEFAULT_MAX_AGE_SECONDS);
      expect(o.expires).toBeUndefined();
    }
    expect(DEFAULT_MAX_AGE_SECONDS).toBe(43200);
  });
});

describe('clearedCookieOptions', () => {
  it('同じ Path・Secure で、期限を 0 にする（Path が違うと消えない）', () => {
    expect(clearedCookieOptions('production')).toEqual({ httpOnly: true, sameSite: 'lax', path: '/staff', secure: true, maxAge: 0 });
    expect(clearedCookieOptions('development').secure).toBe(false);
  });
});

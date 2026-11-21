import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STAFF_COOKIE } from '../../../src/lib/staff/cookie';
import { loginAction } from './actions';

const mocks = vi.hoisted(() => ({ set: vi.fn(), redirect: vi.fn(), performLogin: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.set }) }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../src/lib/staff/commands', () => ({ performLogin: mocks.performLogin }));

const form = () => {
  const fd = new FormData();
  fd.set('email', 'someone@oasis-cafe.example');
  fd.set('password', 'pw');
  return fd;
};
const loggedIn = (role: string) => ({ ok: true, token: 'tok-1', expiresAt: '2099-01-01T00:00:00Z', staff: { id: 1, name: 'テスト', role, store_id: 1 } });

beforeEach(() => {
  mocks.set.mockReset();
  mocks.performLogin.mockReset();
  // 本物の redirect は例外で処理を止める。ここでも止めて、行き先を取り出す
  mocks.redirect.mockReset().mockImplementation((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  });
});

describe('loginAction: ログイン後の振り分け', () => {
  it('配達員は /staff/courier へ（/courier ではない。Cookie の Path は /staff）', async () => {
    mocks.performLogin.mockResolvedValue(loggedIn('courier'));
    await expect(loginAction({ error: null }, form())).rejects.toThrow('REDIRECT:/staff/courier');
  });

  it('スタッフ・店長は /staff へ', async () => {
    for (const role of ['staff', 'manager']) {
      mocks.performLogin.mockResolvedValue(loggedIn(role));
      await expect(loginAction({ error: null }, form())).rejects.toThrow(/^REDIRECT:\/staff$/);
    }
    expect(mocks.redirect).toHaveBeenCalledTimes(2);
    expect(mocks.redirect.mock.calls.map((c) => c[0])).toEqual(['/staff', '/staff']);
  });

  it('Cookie は、トークンを HttpOnly・Path=/staff で入れる（配達員でも Path を広げない）', async () => {
    mocks.performLogin.mockResolvedValue(loggedIn('courier'));
    await expect(loginAction({ error: null }, form())).rejects.toThrow();
    expect(mocks.set).toHaveBeenCalledTimes(1);
    const [name, value, options] = mocks.set.mock.calls[0]!;
    expect(name).toBe(STAFF_COOKIE);
    expect(value).toBe('tok-1');
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/staff' });
  });

  it('ログインに失敗したら、Cookie を入れず、どこへも進めない。文だけ返す', async () => {
    mocks.performLogin.mockResolvedValue({ ok: false, message: 'メールアドレスまたはパスワードが違います' });
    expect(await loginAction({ error: null }, form())).toEqual({ error: 'メールアドレスまたはパスワードが違います' });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

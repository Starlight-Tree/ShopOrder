import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { staffUser } from '../../../src/lib/staff/test-fixtures';
import ConsoleLayout from './layout';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), getStores: vi.fn(), redirect: vi.fn() }));
vi.mock('../../../src/lib/staff/session', () => ({ getSession: mocks.getSession, getStores: mocks.getStores }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, usePathname: () => '/staff' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('./actions', () => ({ logoutAction: vi.fn(async () => {}) }));

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.getStores.mockReset().mockResolvedValue([{ id: 1, name: '居住区本店' }]);
  mocks.redirect.mockReset().mockImplementation((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  });
});

const session = (role: 'staff' | 'manager' | 'courier') => ({ kind: 'ok', token: 'tok', staff: staffUser({ role, store_id: role === 'manager' ? null : 1 }) });
const renderLayout = async () => render(await ConsoleLayout({ children: <p>本文</p> }));

describe('(console) の layout: 認証の門と、配達員の振り分け', () => {
  it('配達員は /staff/courier へ進める（調理ボード・在庫は、配達員の API 権限に無い）', async () => {
    mocks.getSession.mockResolvedValue(session('courier'));
    await expect(renderLayout()).rejects.toThrow('REDIRECT:/staff/courier');
    expect(mocks.getStores).not.toHaveBeenCalled();
  });

  it('スタッフ・店長は、ヘッダーつきで本文を出す（「配達員は…宅配の段階で追加」の知らせは出ない）', async () => {
    for (const role of ['staff', 'manager'] as const) {
      mocks.getSession.mockResolvedValue(session(role));
      const view = await renderLayout();
      expect(screen.getByText('本文')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'スタッフメニュー' })).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('宅配の段階');
      view.unmount();
    }
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('Cookie が無ければログインへ。API に拒まれたら /staff/expired（Cookie を消す経路）へ', async () => {
    mocks.getSession.mockResolvedValue({ kind: 'anonymous' });
    await expect(renderLayout()).rejects.toThrow('REDIRECT:/staff/login');
    mocks.getSession.mockResolvedValue({ kind: 'expired' });
    await expect(renderLayout()).rejects.toThrow('REDIRECT:/staff/expired');
  });

  it('API に聞けなければ、「接続できません」を出す（振り分けも、ログアウトもしない）', async () => {
    mocks.getSession.mockResolvedValue({ kind: 'unavailable' });
    await renderLayout();
    expect(screen.getByRole('alert')).toHaveTextContent('API に接続できません');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

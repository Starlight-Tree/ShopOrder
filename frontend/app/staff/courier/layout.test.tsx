import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { staffUser } from '../../../src/lib/staff/test-fixtures';
import CourierLayout from './layout';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), redirect: vi.fn() }));
vi.mock('../../../src/lib/staff/session', () => ({ getSession: mocks.getSession }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../(console)/actions', () => ({ logoutAction: vi.fn(async () => {}) }));

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.redirect.mockReset().mockImplementation((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  });
});

const ok = (role: 'staff' | 'manager' | 'courier') => ({ kind: 'ok', token: 'tok', staff: staffUser({ name: 'ラシード', role }) });
const renderLayout = async () => render(await CourierLayout({ children: <p>配達の一覧</p> }));

describe('/staff/courier の layout: 認証の門', () => {
  it('配達員なら、専用のヘッダー（名前・ログアウト）と本文を出す', async () => {
    mocks.getSession.mockResolvedValue(ok('courier'));
    await renderLayout();
    expect(screen.getByText('配達の一覧')).toBeInTheDocument();
    expect(screen.getByText('ラシード')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ログアウト' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull(); // StaffNav は使わない
    expect(screen.getByRole('main')).toHaveAttribute('id', 'cr-main');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('Cookie が無ければログインへ。API に拒まれたら /staff/expired（Cookie を消す経路）へ', async () => {
    mocks.getSession.mockResolvedValue({ kind: 'anonymous' });
    await expect(renderLayout()).rejects.toThrow('REDIRECT:/staff/login');
    mocks.getSession.mockResolvedValue({ kind: 'expired' });
    await expect(renderLayout()).rejects.toThrow('REDIRECT:/staff/expired');
  });

  it('API に聞けなければ（接続・5xx）、ヘッダーだけ省いて、本文（page）は出す。Cookie は触らず、移動もしない', async () => {
    mocks.getSession.mockResolvedValue({ kind: 'unavailable' });
    await renderLayout();
    expect(screen.getByText('配達の一覧')).toBeInTheDocument(); // 本文を差し替えない（取れていた一覧と入力中の欄を、page 側で残すため）
    expect(screen.getByRole('main')).toHaveAttribute('id', 'cr-main');
    expect(screen.queryByRole('button', { name: 'ログアウト' })).toBeNull(); // 名前が分からないので、ヘッダーは出さない
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('ヘッダーが出る・出ないで、本文の枠は同じ位置（本文の部品が作り直されない）', async () => {
    mocks.getSession.mockResolvedValue(ok('courier'));
    const withHeader = await CourierLayout({ children: <p>配達の一覧</p> });
    mocks.getSession.mockResolvedValue({ kind: 'unavailable' });
    const without = await CourierLayout({ children: <p>配達の一覧</p> });
    const slots = (node: unknown) => (node as { props: { children: Array<{ type?: unknown } | null> } }).props.children;
    expect(slots(withHeader)).toHaveLength(2);
    expect(slots(without)).toHaveLength(2);
    expect(slots(without)[0]).toBeNull();
    expect(slots(withHeader)[1]!.type).toBe(slots(without)[1]!.type);
  });

  it('配達員でなければ（スタッフ・店長）、/staff へ。配達の画面は見せない', async () => {
    for (const role of ['staff', 'manager'] as const) {
      mocks.getSession.mockResolvedValue(ok(role));
      await expect(renderLayout()).rejects.toThrow(/^REDIRECT:\/staff$/);
    }
  });
});

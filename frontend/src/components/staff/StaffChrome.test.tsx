import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { staffUser } from '../../lib/staff/test-fixtures';
import { StaffHeader } from './StaffHeader';
import { StoreSelect } from './StoreSelect';

const nav = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), pathname: '/staff' }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, usePathname: () => nav.pathname }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  nav.replace.mockClear();
  nav.pathname = '/staff';
});

describe('StaffHeader', () => {
  it('店名・氏名・ロールと、ボード・配車・在庫・ログアウトを出す', () => {
    render(<StaffHeader staff={staffUser({ name: 'ミナ・ハーシム', role: 'staff' })} storeName="居住区本店" logoutAction={vi.fn(async () => {})} />);
    expect(screen.getByText('居住区本店')).toBeInTheDocument();
    expect(screen.getByText('ミナ・ハーシム')).toBeInTheDocument();
    expect(screen.getByText('スタッフ', { selector: '.tag' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'スタッフメニュー' });
    expect(within(nav).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['ボード', '/staff'],
      ['配車', '/staff/dispatch'],
      ['在庫', '/staff/stock'],
    ]);
    expect(screen.getByRole('button', { name: 'ログアウト' })).toBeInTheDocument();
  });

  it('店長は「店長」、全店', () => {
    render(<StaffHeader staff={staffUser({ role: 'manager', store_id: null })} storeName="全店" logoutAction={vi.fn(async () => {})} />);
    expect(screen.getByText('店長', { selector: '.tag' })).toBeInTheDocument();
    expect(screen.getByText('全店')).toBeInTheDocument();
  });

  it('今いるページに aria-current="page"（色だけに頼らない）', () => {
    nav.pathname = '/staff/stock';
    render(<StaffHeader staff={staffUser()} storeName="居住区本店" logoutAction={vi.fn(async () => {})} />);
    expect(screen.getByRole('link', { name: '在庫' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'ボード' })).not.toHaveAttribute('aria-current');
  });

  it('配車ボードでは「配車」だけが現在のページ（調理ボードの「ボード」は違う）', () => {
    nav.pathname = '/staff/dispatch';
    render(<StaffHeader staff={staffUser()} storeName="居住区本店" logoutAction={vi.fn(async () => {})} />);
    expect(screen.getByRole('link', { name: '配車' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'ボード' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: '在庫' })).not.toHaveAttribute('aria-current');
  });

  it('ログアウトのフォームは、渡された Server Action を呼ぶ', async () => {
    const logout = vi.fn(async () => {});
    render(<StaffHeader staff={staffUser()} storeName="居住区本店" logoutAction={logout} />);
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it('本文へ移動するリンクがある', () => {
    render(<StaffHeader staff={staffUser()} storeName="居住区本店" logoutAction={vi.fn(async () => {})} />);
    expect(screen.getByRole('link', { name: '本文へ移動' })).toHaveAttribute('href', '#st-main');
  });
});

describe('StoreSelect', () => {
  const stores = [{ id: 1, name: '居住区本店' }, { id: 2, name: '発着場中央店' }];

  it('選んだ店を「切り替える」で ?store= にする（選んだだけでは変えない）', () => {
    render(<StoreSelect stores={stores} selectedId={null} allowAll />);
    fireEvent.change(screen.getByLabelText('表示する店'), { target: { value: '2' } });
    expect(nav.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(nav.replace).toHaveBeenCalledWith('/staff?store=2');
  });

  it('「全店」を選ぶと、?store= を外す', () => {
    render(<StoreSelect stores={stores} selectedId={2} allowAll />);
    expect(screen.getByLabelText('表示する店')).toHaveValue('2');
    fireEvent.change(screen.getByLabelText('表示する店'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(nav.replace).toHaveBeenCalledWith('/staff');
  });

  it('allowAll でない（在庫）ときは「全店」が無く、未選択の案内を出す', () => {
    render(<StoreSelect stores={stores} selectedId={null} allowAll={false} />);
    expect(screen.queryByRole('option', { name: '全店' })).toBeNull();
    expect(screen.getByRole('option', { name: '店を選んでください' })).toBeDisabled();
  });
});

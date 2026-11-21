import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { staffUser } from '../../lib/staff/test-fixtures';
import { ManagerHeader } from './ManagerHeader';
import { DaysNav, PeriodNav } from './PeriodNav';
import { ScopeSelect } from './ScopeSelect';
import { DummyBanner, Notice } from './Notice';

const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: '/manager', search: '' }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, usePathname: () => nav.pathname, useSearchParams: () => new URLSearchParams(nav.search) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  nav.replace.mockClear();
  nav.pathname = '/manager';
  nav.search = '';
});

describe('ManagerHeader', () => {
  it('全店の店長: メニューに「顧客」まで。店名・氏名・ロール・ログアウト', () => {
    render(<ManagerHeader staff={staffUser({ role: 'manager', store_id: null, name: '店長（全店）' })} storeName="全店" showCustomers logoutAction={vi.fn(async () => {})} />);
    const menu = screen.getByRole('navigation', { name: '分析メニュー' });
    expect(within(menu).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['概況', '/manager'],
      ['売上', '/manager/sales'],
      ['商品', '/manager/products'],
      ['時間帯', '/manager/hours'],
      ['在庫', '/manager/stock'],
      ['顧客', '/manager/customers'],
    ]);
    expect(screen.getByText('全店')).toBeInTheDocument();
    expect(screen.getByText('店長', { selector: '.tag' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ログアウト' })).toBeInTheDocument();
  });
  it('店舗スタッフ（自店だけ）: 「顧客」は出ない', () => {
    render(<ManagerHeader staff={staffUser()} storeName="居住区本店" showCustomers={false} logoutAction={vi.fn(async () => {})} />);
    expect(screen.queryByRole('link', { name: '顧客' })).toBeNull();
    expect(screen.getByRole('link', { name: '在庫' })).toBeInTheDocument();
  });
  it('今いるページに aria-current="page"。本文へ移動するリンクがある', () => {
    nav.pathname = '/manager/stock';
    render(<ManagerHeader staff={staffUser()} storeName="居住区本店" showCustomers={false} logoutAction={vi.fn(async () => {})} />);
    expect(screen.getByRole('link', { name: '在庫' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '概況' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: '本文へ移動' })).toHaveAttribute('href', '#mg-main');
  });
  it('ログアウトは、渡された Server Action を呼ぶ', async () => {
    const logout = vi.fn(async () => {});
    render(<ManagerHeader staff={staffUser()} storeName="居住区本店" showCustomers={false} logoutAction={logout} />);
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });
});

describe('ScopeSelect（店の絞り込み）', () => {
  const stores = [{ id: 1, name: '居住区本店' }, { id: 2, name: '発着場中央店' }];
  it('選んだだけでは変えず、「切り替える」で ?store= にする。ほかの条件は残す', () => {
    nav.pathname = '/manager/sales';
    nav.search = 'grain=week&count=12';
    render(<ScopeSelect stores={stores} selectedId={null} />);
    fireEvent.change(screen.getByLabelText('表示する店'), { target: { value: '2' } });
    expect(nav.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(nav.replace).toHaveBeenCalledWith('/manager/sales?grain=week&count=12&store=2');
  });
  it('「全店」を選ぶと、?store= を外す', () => {
    nav.search = 'store=2&days=28';
    render(<ScopeSelect stores={stores} selectedId={2} />);
    expect(screen.getByLabelText('表示する店')).toHaveValue('2');
    fireEvent.change(screen.getByLabelText('表示する店'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(nav.replace).toHaveBeenCalledWith('/manager?days=28');
  });
});

describe('PeriodNav / DaysNav', () => {
  it('日・週・月と期間の数のリンク。今のものに aria-current。店の選択を引き継ぐ', () => {
    render(<PeriodNav basePath="/manager/sales" store={3} grain="week" count={12} />);
    const units = screen.getByRole('navigation', { name: '集計の単位' });
    expect(within(units).getByRole('link', { name: '週' })).toHaveAttribute('aria-current', 'true');
    expect(within(units).getByRole('link', { name: '月' })).toHaveAttribute('href', '/manager/sales?grain=month&store=3');
    const counts = screen.getByRole('navigation', { name: '期間の長さ' });
    expect(within(counts).getByRole('link', { name: '12 週' })).toHaveAttribute('aria-current', 'true');
    expect(within(counts).getByRole('link', { name: '26 週' })).toHaveAttribute('href', '/manager/sales?grain=week&count=26&store=3');
  });
  it('日数のリンク', () => {
    render(<DaysNav basePath="/manager/hours" store={null} days={28} options={[7, 28, 90]} />);
    expect(screen.getByRole('link', { name: '28 日' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: '90 日' })).toHaveAttribute('href', '/manager/hours?days=90');
  });
});

describe('知らせ', () => {
  it('ダミーの明記（見出しのタグと文）。エラーは role=alert、info は status', () => {
    render(
      <>
        <DummyBanner text="この画面の数字は、すべてダミーです" />
        <Notice title="読み込めませんでした" />
        <Notice kind="info" title="店を選んでください" />
      </>,
    );
    expect(screen.getByRole('note')).toHaveTextContent('ダミー');
    expect(screen.getByRole('alert')).toHaveTextContent('読み込めませんでした');
    expect(screen.getByRole('status')).toHaveTextContent('店を選んでください');
  });
});

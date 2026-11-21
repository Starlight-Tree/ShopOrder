import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { staffUser } from '../../lib/staff/test-fixtures';
import { CourierHeader } from './CourierHeader';

const courier = staffUser({ id: 7, name: 'ラシード', role: 'courier', store_id: 1 });

describe('CourierHeader', () => {
  it('名前・「配達員」の表示・ログアウトだけを出す（調理ボード・在庫への行き来は無い）', () => {
    render(<CourierHeader staff={courier} logoutAction={vi.fn(async () => {})} />);
    expect(screen.getByText('ラシード')).toBeInTheDocument();
    expect(screen.getByText('配達員', { selector: '.tag' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ログアウト' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: 'ボード' })).toBeNull();
    expect(screen.queryByRole('link', { name: '在庫' })).toBeNull();
  });

  it('ログアウトのフォームは、渡された Server Action を呼ぶ', async () => {
    const logout = vi.fn(async () => {});
    render(<CourierHeader staff={courier} logoutAction={logout} />);
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it('本文へ移動するリンクが、本文の id を指す', () => {
    render(<CourierHeader staff={courier} logoutAction={vi.fn(async () => {})} />);
    expect(screen.getByRole('link', { name: '本文へ移動' })).toHaveAttribute('href', '#cr-main');
  });
});

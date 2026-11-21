import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoginState } from '../../lib/staff/types';
import { LoginForm } from './LoginForm';

describe('LoginForm', () => {
  const fill = (email: string, password: string) => {
    fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: email } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: password } });
  };

  it('メールとパスワードの欄と、ログインのボタン。パスワードは password 型', () => {
    render(<LoginForm action={vi.fn(async () => ({ error: null }))} />);
    expect(screen.getByLabelText('メールアドレス')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('パスワード')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('パスワード')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: 'ログイン' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Server Action へ email・password を FormData で渡す', async () => {
    const action = vi.fn(async (): Promise<LoginState> => ({ error: null }));
    render(<LoginForm action={action} />);
    fill('staff-a@oasis-cafe.example', 'pw-1');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = (action.mock.calls[0] as unknown as [LoginState, FormData])[1];
    expect([fd.get('email'), fd.get('password')]).toEqual(['staff-a@oasis-cafe.example', 'pw-1']);
  });

  it('失敗は固定の文を role=alert で出す。メールは残る', async () => {
    const action = vi.fn(async (): Promise<LoginState> => ({ error: 'メールアドレスまたはパスワードが違います' }));
    render(<LoginForm action={action} />);
    fill('staff-a@oasis-cafe.example', 'bad');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('メールアドレスまたはパスワードが違います');
    expect(screen.getByLabelText('メールアドレス')).toHaveValue('staff-a@oasis-cafe.example');
  });

  it('送信中は、ボタンを押せず、文言が変わる', async () => {
    let release: (s: LoginState) => void = () => {};
    const action = vi.fn(() => new Promise<LoginState>((resolve) => (release = resolve)));
    render(<LoginForm action={action} />);
    fill('a@b.example', 'x');
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    const busy = await screen.findByRole('button', { name: 'ログインしています…' });
    expect(busy).toBeDisabled();
    release({ error: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'ログイン' })).toBeEnabled());
  });
});

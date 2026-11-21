'use client';
import { useActionState, useState } from 'react';
import type { LoginState } from '../../lib/staff/types';

type Props = { action: (prev: LoginState, formData: FormData) => Promise<LoginState> };

/** メールとパスワード。失敗は固定の文（理由を分けない）。メールは残し、パスワードは消える */
export function LoginForm({ action }: Props) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  const [email, setEmail] = useState('');
  return (
    <form action={formAction} className="st-form" aria-describedby={state.error ? 'st-login-error' : undefined}>
      {state.error ? (
        <p id="st-login-error" className="st-form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="st-field">
        <label htmlFor="st-email">メールアドレス</label>
        <input
          id="st-email"
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="st-field">
        <label htmlFor="st-password">パスワード</label>
        <input id="st-password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
      </div>
      <button type="submit" className="st-btn st-btn-primary st-btn-block" disabled={pending}>
        {pending ? 'ログインしています…' : 'ログイン'}
      </button>
    </form>
  );
}

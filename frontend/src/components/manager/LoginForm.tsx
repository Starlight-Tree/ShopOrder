'use client';
import { useActionState, useState } from 'react';
import type { LoginState } from '../../lib/staff/types';

type Props = { action: (prev: LoginState, formData: FormData) => Promise<LoginState> };

/** メールとパスワード（スタッフのログインと同じ API）。失敗は固定の文（理由を分けない）。メールは残し、パスワードは消える */
export function ManagerLoginForm({ action }: Props) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  const [email, setEmail] = useState('');
  return (
    <form action={formAction} className="mg-form" aria-describedby={state.error ? 'mg-login-error' : undefined}>
      {state.error ? (
        <p id="mg-login-error" className="mg-form-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="mg-field">
        <label htmlFor="mg-email">メールアドレス</label>
        <input id="mg-email" name="email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="mg-field">
        <label htmlFor="mg-password">パスワード</label>
        <input id="mg-password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
      </div>
      <button type="submit" className="mg-btn mg-btn-primary" disabled={pending}>
        {pending ? 'ログインしています…' : 'ログイン'}
      </button>
    </form>
  );
}

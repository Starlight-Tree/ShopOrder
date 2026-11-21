'use client';

import Link from 'next/link';
import { useActionState, type ReactNode } from 'react';
import type { ActionState, FormAction } from '../../lib/shop/types';

/** Server Action の結果（成功の一言・失敗の文と直し方のリンク）をフォームの下に出す */
export function ActionMessage({ state }: { state: ActionState }) {
  if (!state) return null;
  if (state.ok) {
    return state.message ? (
      <p className="shop-msg shop-msg-ok" role="status">
        {state.message}
      </p>
    ) : null;
  }
  return (
    <p className="shop-msg shop-msg-error" role="alert">
      {state.message}
      {state.next ? (
        <>
          {' '}
          <Link href={state.next.href} prefetch={false}>
            {state.next.label}
          </Link>
        </>
      ) : null}
    </p>
  );
}

/** Server Action を呼ぶフォーム。JS が無くても送れる（progressive enhancement）。結果の文は下に出る */
export function ActionForm({ action, children, className }: { action: FormAction; children: ReactNode; className?: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      <ActionMessage state={state} />
    </form>
  );
}

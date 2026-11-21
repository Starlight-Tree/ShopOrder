'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

export type ButtonKind = 'primary' | 'secondary' | 'danger' | 'text';

/** 送信中は無効にする（二重クリックを防ぐ）。同じフォームの送信ボタンは、まとめて無効になる */
export function SubmitButton({
  children,
  pendingLabel,
  kind = 'primary',
  name,
  value,
  disabled,
  formNoValidate,
  ariaLabel,
  describedBy,
}: {
  children: ReactNode;
  pendingLabel?: string;
  kind?: ButtonKind;
  name?: string;
  value?: string | number;
  disabled?: boolean;
  formNoValidate?: boolean;
  ariaLabel?: string;
  describedBy?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`shop-btn shop-btn-${kind}`}
      name={name}
      value={value}
      disabled={disabled || pending}
      formNoValidate={formNoValidate}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-busy={pending || undefined}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

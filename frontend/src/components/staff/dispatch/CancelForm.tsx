'use client';
import { useId, useState, type FormEvent } from 'react';

type Props = {
  busy: boolean;
  /** 入力欄の下の説明（取り消すと何が起きるか） */
  hint: string;
  /** 取消しを実行する。成功したら true（呼び出し側が閉じる） */
  onSubmit: (reason: string) => Promise<boolean>;
  onClose: () => void;
};

/** 取消しの理由の入力（必須）。調理ボードの注文カードと配車ボードのカードで共通 */
export function CancelForm({ busy, hint, onSubmit, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const hintId = useId();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = reason.trim();
    if (r === '') {
      setError('取消しの理由を入力してください');
      return;
    }
    setError(null);
    if (await onSubmit(r)) onClose();
  }

  return (
    <form className="st-cancel" onSubmit={submit} noValidate>
      <div className="st-field">
        <label htmlFor={reasonId}>取消しの理由（必須）</label>
        <input
          id={reasonId}
          type="text"
          value={reason}
          maxLength={100}
          required
          autoComplete="off"
          aria-describedby={hintId}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setReason(e.target.value)}
        />
        <p id={hintId} className={error ? 'st-field-error' : 'muted'} role={error ? 'alert' : undefined}>
          {error ?? hint}
        </p>
      </div>
      <div className="st-actions">
        <button type="submit" className="st-btn st-btn-danger" disabled={busy}>
          取消しを確定する
        </button>
        <button type="button" className="st-btn st-btn-secondary" disabled={busy} onClick={onClose}>
          やめる
        </button>
      </div>
    </form>
  );
}

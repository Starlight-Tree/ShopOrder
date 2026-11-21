'use client';

import { useState } from 'react';
import type { FormAction } from '../../lib/shop/types';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

/** 「取消す」。押し間違いを防ぐため、1 回目は確認に変わる（2 回目で送る） */
export function CancelOrderForm({ publicId, action }: { publicId: string; action: FormAction }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="shop-btn shop-btn-danger" onClick={() => setConfirming(true)}>
        取消す
      </button>
    );
  }
  return (
    <ActionForm action={action} className="shop-cancel-form">
      <input type="hidden" name="public_id" value={publicId} />
      <p role="alert">この注文を取消します。よろしいですか？（支払い済みの場合は、返金されます）</p>
      <div className="shop-actions">
        <SubmitButton kind="danger" pendingLabel="取消しています…">
          取消しを確定する
        </SubmitButton>
        <button type="button" className="shop-btn shop-btn-secondary" onClick={() => setConfirming(false)}>
          やめる
        </button>
      </div>
    </ActionForm>
  );
}

'use client';

import { useState } from 'react';
import type { FormAction } from '../../lib/shop/types';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

/** 「削除する」。押し間違いを防ぐため、1 回目は確認に変わる（2 回目で送る） */
export function DeleteAddressForm({ addressId, label, action }: { addressId: number; label: string; action: FormAction }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="shop-btn shop-btn-secondary" aria-label={`${label}を削除する`} onClick={() => setConfirming(true)}>
        削除する
      </button>
    );
  }
  return (
    <ActionForm action={action} className="shop-cancel-form">
      <input type="hidden" name="address_id" value={addressId} />
      <p role="alert">「{label}」を削除します。よろしいですか？（カートで選んでいた場合は、外れます。これまでの注文は変わりません）</p>
      <div className="shop-actions">
        <SubmitButton kind="danger" pendingLabel="削除しています…" ariaLabel={`${label}の削除を確定する`}>
          削除を確定する
        </SubmitButton>
        <button type="button" className="shop-btn shop-btn-secondary" onClick={() => setConfirming(false)}>
          やめる
        </button>
      </div>
    </ActionForm>
  );
}

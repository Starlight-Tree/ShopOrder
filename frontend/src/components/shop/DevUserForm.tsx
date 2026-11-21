'use client';

import type { FormAction } from '../../lib/shop/types';
import { currentDevUserLabel } from '../../lib/shop/dev-user';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

/** 開発用ログイン名の切替（Cookie shop_order_dev_user）。本番では、呼ぶ側が出さない */
export function DevUserForm({ action, current }: { action: FormAction; current: string | undefined }) {
  return (
    <ActionForm action={action} className="shop-devuser">
      <p className="shop-devuser-title">開発用</p>
      <div className="shop-devuser-row">
        <label htmlFor="dev-user">開発用ログイン名</label>
        <input
          id="dev-user"
          name="dev_user"
          type="text"
          defaultValue={current ?? ''}
          placeholder="demo-customer"
          pattern="[a-z0-9\-]{1,40}"
          maxLength={40}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby="dev-user-hint"
        />
        <SubmitButton kind="secondary">切り替える</SubmitButton>
        <SubmitButton kind="text" name="reset" value="1" formNoValidate>
          既定に戻す
        </SubmitButton>
      </div>
      <p id="dev-user-hint" className="muted">
        半角の小文字・数字・ハイフン（1〜40 文字）。いまは {currentDevUserLabel(current)}。
      </p>
    </ActionForm>
  );
}

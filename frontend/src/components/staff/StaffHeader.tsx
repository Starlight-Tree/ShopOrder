import type { Staff } from '../../lib/contract';
import { ROLE_LABELS } from '../../lib/staff/orders';
import { StaffNav } from './StaffNav';

type Props = { staff: Staff; storeName: string; logoutAction: () => Promise<void> };

/** スタッフ用のヘッダー: 店名・氏名・ロール・ボード/在庫・ログアウト */
export function StaffHeader({ staff, storeName, logoutAction }: Props) {
  return (
    <header className="st-header">
      <a className="st-skip" href="#st-main">
        本文へ移動
      </a>
      <div className="st-header-inner">
        <p className="st-brand">
          <span className="st-brand-name">オアシス珈琲</span>
          <span className="st-brand-sub">スタッフ</span>
        </p>
        <StaffNav />
        <p className="st-who">
          <span className="st-who-store">{storeName}</span>
          <span className="st-who-name">{staff.name}</span>
          <span className="tag">{ROLE_LABELS[staff.role] ?? staff.role}</span>
        </p>
        <form action={logoutAction} className="st-logout">
          <button type="submit" className="st-btn st-btn-secondary">
            ログアウト
          </button>
        </form>
      </div>
    </header>
  );
}

import type { Staff } from '../../lib/contract';
import { ROLE_LABELS } from '../../lib/staff/orders';
import { ManagerNav } from './ManagerNav';

type Props = { staff: Staff; storeName: string; showCustomers: boolean; logoutAction: () => Promise<void> };

/** 分析画面のヘッダー: 店名・氏名・ロール・メニュー・ログアウト */
export function ManagerHeader({ staff, storeName, showCustomers, logoutAction }: Props) {
  return (
    <header className="mg-header">
      <a className="mg-skip" href="#mg-main">
        本文へ移動
      </a>
      <div className="mg-header-inner">
        <p className="mg-brand">
          <span className="mg-brand-name">オアシス珈琲</span>
          <span className="mg-brand-sub">分析</span>
        </p>
        <ManagerNav showCustomers={showCustomers} />
        <p className="mg-who">
          <span className="mg-who-store">{storeName}</span>
          <span>{staff.name}</span>
          <span className="tag">{ROLE_LABELS[staff.role] ?? staff.role}</span>
        </p>
        <form action={logoutAction} className="mg-logout">
          <button type="submit" className="mg-btn">
            ログアウト
          </button>
        </form>
      </div>
    </header>
  );
}

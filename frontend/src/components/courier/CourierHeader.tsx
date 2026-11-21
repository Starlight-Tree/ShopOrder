import type { Staff } from '../../lib/contract';
import { ROLE_LABELS } from '../../lib/staff/orders';

type Props = { staff: Staff; logoutAction: () => Promise<void> };

/** 配達員用のヘッダー: 名前・ログアウトだけ（調理ボード・在庫の行き来は無い）。スマートフォンで押しやすい大きさ */
export function CourierHeader({ staff, logoutAction }: Props) {
  return (
    <header className="cr-header">
      <a className="st-skip" href="#cr-main">
        本文へ移動
      </a>
      <div className="cr-header-inner">
        <p className="cr-brand">
          <span className="cr-brand-name">オアシス珈琲</span>
          <span className="cr-brand-sub">配達</span>
        </p>
        <p className="cr-who">
          <span className="cr-who-name">{staff.name}</span>
          <span className="tag">{ROLE_LABELS[staff.role] ?? staff.role}</span>
        </p>
        <form action={logoutAction} className="cr-logout">
          <button type="submit" className="st-btn st-btn-secondary cr-btn">
            ログアウト
          </button>
        </form>
      </div>
    </header>
  );
}

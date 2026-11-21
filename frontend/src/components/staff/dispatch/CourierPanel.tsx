import type { Courier } from '../../../lib/staff/delivery-types';
import { vehicleLabel } from '../../../lib/staff/dispatch';

type Props = {
  couriers: readonly Courier[];
  /** 店の ID → 店名（店をまたぐ表示のときだけ、店名を添える） */
  storeNames: ReadonlyMap<number, string>;
};

/** 配達員の一覧: 勤務中か・担当の件数・最後にいた区画・乗り物。状態は色だけでなく文字でも示す */
export function CourierPanel({ couriers, storeNames }: Props) {
  const multiStore = new Set(couriers.map((c) => c.store_id)).size > 1;
  return (
    <section className="st-panel" aria-labelledby="st-couriers-title">
      <h2 id="st-couriers-title" className="st-panel-title">
        配達員
        <span className="st-count" aria-label={`${couriers.length} 人`}>
          {couriers.length}
        </span>
      </h2>
      {couriers.length === 0 ? (
        <p className="st-empty muted">配達員がいません</p>
      ) : (
        <ul className="st-courier-list">
          {couriers.map((c) => (
            <li key={c.id} className="st-courier">
              <p className="st-courier-head">
                <span className="st-courier-name">{c.name}</span>
                <span className={c.is_on_duty ? 'tag tag-ok' : 'tag'}>{c.is_on_duty ? '勤務中' : '勤務外'}</span>
              </p>
              <p className="muted st-courier-meta">
                {multiStore ? `${storeNames.get(c.store_id) ?? `店 ${c.store_id}`}・` : ''}担当 {c.active_count} 件・最後にいた区画 {c.zone ? c.zone.name : '不明'}・{vehicleLabel(c.vehicle)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

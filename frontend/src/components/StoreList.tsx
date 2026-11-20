import { closedLabel } from '../lib/format';
import type { Store } from '../lib/types';

/** エリアごとに、店の一覧。モバイルオーダー不可の店と、ラストオーダーが早い店は、そのことを出す。 */
export function StoreList({ stores }: { stores: Store[] }) {
  const areas = [...new Set(stores.map((s) => s.area))];
  return (
    <div className="areas">
      {areas.map((area) => (
        <section key={area} aria-labelledby={`area-${area}`}>
          <h3 id={`area-${area}`}>{area}</h3>
          <ul className="cards">
            {stores
              .filter((s) => s.area === area)
              .map((s) => (
                <li key={s.id} className="card">
                  <p className="card-title">{s.name}</p>
                  <p className="muted">{s.address}</p>
                  <p>
                    {s.open_time}〜{s.close_time}・{closedLabel(s.closed_weekday)}・{s.seats} 席
                  </p>
                  <p className="notes">
                    {!s.mobile_order ? <span className="tag">モバイルオーダー不可</span> : null}
                    {s.last_order_minutes === 15 ? <span className="tag">ラストオーダーは閉店 15 分前</span> : null}
                  </p>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

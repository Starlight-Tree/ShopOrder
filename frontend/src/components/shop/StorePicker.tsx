import type { Store } from '../../lib/types';
import type { FormAction } from '../../lib/shop/types';
import { groupStoresByArea, storeStatus } from '../../lib/shop/view';
import { closedLabel } from '../../lib/format';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

/**
 * 受け取る店の選択（カートの店。PUT /api/cart）。営業中でない店は、理由つきで選べない。
 * 未選択のときは開き、選んだら閉じる（<details>。JS が無くても動く）。
 */
export function StorePicker({ stores, selectedId, action }: { stores: Store[]; selectedId: number | null; action: FormAction }) {
  const selected = stores.find((s) => s.id === selectedId) ?? null;
  return (
    <section className="shop-panel" aria-labelledby="store-picker-heading">
      <h2 id="store-picker-heading" className="shop-sr-only">
        受け取る店の選択
      </h2>
      <details className="shop-details" open={selected === null}>
        <summary>
          <span className="shop-summary-label">
            受け取る店
          </span>
          <strong className="shop-summary-value">{selected ? selected.name : '店を選んでください'}</strong>
          <span className="shop-summary-action">{selected ? '変更する' : '選ぶ'}</span>
        </summary>
        <p className="muted">店頭でお受け取りの注文です。営業中の店から選べます。</p>
        {groupStoresByArea(stores).map(({ area, stores: inArea }) => (
          <div key={area} className="shop-store-area">
            <h3>{area}</h3>
            <ul className="shop-store-list">
              {inArea.map((s) => {
                const status = storeStatus(s);
                const isSelected = s.id === selectedId;
                const reasonId = `store-${s.id}-reason`;
                return (
                  <li key={s.id} className="shop-store">
                    <div className="shop-store-info">
                      <p className="card-title">{s.name}</p>
                      <p className="muted">
                        {s.open_time}〜{s.close_time}・{closedLabel(s.closed_weekday)}
                      </p>
                      {status.selectable ? null : (
                        <p id={reasonId} className="shop-store-reason">
                          {status.reason}
                        </p>
                      )}
                    </div>
                    {isSelected ? (
                      <span className="shop-tag-ok">選択中</span>
                    ) : status.selectable ? (
                      <ActionForm action={action} className="shop-store-form">
                        <input type="hidden" name="store_id" value={s.id} />
                        <SubmitButton kind="secondary" ariaLabel={`${s.name}を選ぶ`}>
                          この店にする
                        </SubmitButton>
                      </ActionForm>
                    ) : (
                      <button type="button" className="shop-btn shop-btn-secondary" disabled aria-label={`${s.name}は選べません`} aria-describedby={reasonId}>
                        選べません
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </details>
    </section>
  );
}

import { formatLumi, seasonLabel, soldWindowLabel } from '../../lib/format';
import { CATEGORIES, CATEGORY_LABEL, variantLabel, type Category } from '../../lib/shop/labels';
import type { FormAction } from '../../lib/shop/types';
import { menuImageSrc } from '../../lib/shop/menu-images';
import { filterMenu, storeNote, variantState } from '../../lib/shop/view';
import type { MenuItem, Store } from '../../lib/types';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

const STORE_NOTE_ID = 'menu-store-note';

/** 品ごとのカード: 写真（あれば）・名前・説明・アレルゲン・変種（サイズ・温度ごとの価格）・「カートに入れる」 */
function MenuCard({ item, store, addAction }: { item: MenuItem; store: Store | null; addAction: FormAction }) {
  const season = seasonLabel(item);
  const window = soldWindowLabel(item);
  const image = menuImageSrc(item.code);
  return (
    <li className="card shop-item">
      {image ? (
        <div className="shop-item-thumb">
          {/* 名前が下にあるので、画像は飾り（alt なし） */}
          <img src={image} alt="" width={1024} height={768} loading="lazy" decoding="async" />
        </div>
      ) : null}
      <h3 className="card-title">{item.name}</h3>
      <p className="muted">{item.description}</p>
      <p className="notes">
        {season ? <span className="tag">{season} 限定</span> : null}
        {window ? <span className="tag">{window}</span> : null}
        {item.allergens.length > 0 ? <span className="tag">含む: {item.allergens.join('・')}</span> : null}
      </p>
      <ul className="shop-variants">
        {item.variants.map((v) => {
          const state = variantState(v, store);
          // 店のせい（未選択・営業外）の理由は、メニューの上の 1 か所に出す（品ごとには繰り返さない）
          const reasonId = state.scope === 'store' ? STORE_NOTE_ID : `variant-${v.id}-reason`;
          const buttonLabel = `${item.name}（${variantLabel(v)}）をカートに入れる`;
          return (
            <li key={v.id} className="shop-variant">
              <div className="shop-variant-info">
                <span>{variantLabel(v)}</span>
                <span className="price">{formatLumi(v.price_lumi)}</span>
              </div>
              {state.canAdd ? (
                <ActionForm action={addAction} className="shop-variant-form">
                  <input type="hidden" name="variant_id" value={v.id} />
                  <SubmitButton ariaLabel={buttonLabel} pendingLabel="入れています…">
                    カートに入れる
                  </SubmitButton>
                </ActionForm>
              ) : (
                <div className="shop-variant-form">
                  <button type="button" className="shop-btn shop-btn-primary" disabled aria-label={buttonLabel} aria-describedby={reasonId}>
                    カートに入れる
                  </button>
                  {state.scope === 'variant' ? (
                    <p id={reasonId} className="shop-variant-reason">
                      {state.reason}
                    </p>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** 区分ごとのメニュー。category で絞り込める */
export function MenuGrid({ items, store, category, addAction }: { items: MenuItem[]; store: Store | null; category: Category | null; addAction: FormAction }) {
  const shown = filterMenu(items, category);
  const categories = CATEGORIES.filter((c) => shown.some((i) => i.category === c));
  if (categories.length === 0) return <p className="muted">この区分の品は、今ありません。</p>;
  const note = storeNote(store);
  return (
    <div className="areas">
      {note ? (
        <p id={STORE_NOTE_ID} className="shop-warn" role="status">
          {note}
        </p>
      ) : null}
      {categories.map((c) => (
        <section key={c} aria-labelledby={`menu-${c}`}>
          <h2 id={`menu-${c}`}>{CATEGORY_LABEL[c]}</h2>
          <ul className="shop-cards">
            {shown
              .filter((i) => i.category === c)
              .map((item) => (
                <MenuCard key={item.id} item={item} store={store} addAction={addAction} />
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

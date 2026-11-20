import { priceRange, seasonLabel, soldWindowLabel } from '../lib/format';
import type { MenuItem } from '../lib/types';

const CATEGORY_LABEL: Record<MenuItem['category'], string> = { drink: 'ドリンク', food: 'フード', beans: '豆' };

/** 区分ごとに、メニューの一覧。価格はルミ（税込）。期間・時間帯のある品は、それを出す。 */
export function MenuList({ items }: { items: MenuItem[] }) {
  const categories = (['drink', 'food', 'beans'] as const).filter((c) => items.some((i) => i.category === c));
  return (
    <div className="areas">
      {categories.map((category) => (
        <section key={category} aria-labelledby={`menu-${category}`}>
          <h3 id={`menu-${category}`}>{CATEGORY_LABEL[category]}</h3>
          <ul className="cards">
            {items
              .filter((i) => i.category === category)
              .map((item) => {
                const season = seasonLabel(item);
                const window = soldWindowLabel(item);
                return (
                  <li key={item.id} className="card">
                    <p className="card-title">{item.name}</p>
                    <p className="price">{priceRange(item.variants)}</p>
                    <p className="muted">{item.description}</p>
                    <p className="notes">
                      {season ? <span className="tag">{season} 限定</span> : null}
                      {window ? <span className="tag">{window}</span> : null}
                      {item.allergens.length > 0 ? <span className="tag">含む: {item.allergens.join('・')}</span> : null}
                    </p>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}

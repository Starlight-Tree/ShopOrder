import Link from 'next/link';
import { CATEGORIES, CATEGORY_LABEL, type Category } from '../../lib/shop/labels';

/** カテゴリの絞り込み（?category=。リンクなので JS が無くても動く） */
export function CategoryTabs({ current }: { current: Category | null }) {
  const tabs: { key: Category | null; label: string; href: string }[] = [
    { key: null, label: 'すべて', href: '/' },
    ...CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABEL[c], href: `/?category=${c}` })),
  ];
  return (
    <nav aria-label="カテゴリ" className="shop-tabs">
      <ul>
        {tabs.map((t) => (
          <li key={t.label}>
            <Link href={t.href} className="shop-tab" aria-current={t.key === current ? 'page' : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

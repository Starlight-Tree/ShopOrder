'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavItem = { href: string; label: string; match: (path: string) => boolean };

const ITEMS: NavItem[] = [
  { href: '/', label: 'メニュー', match: (p) => p === '/' },
  { href: '/cart', label: 'カート', match: (p) => p === '/cart' || p.startsWith('/checkout') },
  { href: '/orders', label: '注文履歴', match: (p) => p.startsWith('/orders') },
];

/** 今のページのリンクを判定する（テスト用に公開） */
export function isActive(pathname: string | null, href: string): boolean {
  const item = ITEMS.find((i) => i.href === href);
  return !!item && pathname !== null && item.match(pathname);
}

/** ヘッダーのメニュー・カート（点数）・注文履歴。今のページに aria-current を付ける */
export function ShopNav({ cartCount }: { cartCount: number | null }) {
  const pathname = usePathname();
  return (
    <nav aria-label="メインメニュー" className="shop-nav">
      <ul>
        {ITEMS.map((item) => {
          const current = isActive(pathname, item.href);
          const isCart = item.href === '/cart';
          return (
            <li key={item.href}>
              <Link href={item.href} aria-current={current ? 'page' : undefined} className="shop-nav-link">
                {item.label}
                {isCart && cartCount !== null ? (
                  <>
                    <span className="shop-badge" aria-hidden="true">
                      {cartCount}
                    </span>
                    <span className="shop-sr-only">（{cartCount} 点）</span>
                  </>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

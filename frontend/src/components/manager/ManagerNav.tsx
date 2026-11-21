'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const MANAGER_LINKS = [
  { href: '/manager', label: '概況', match: (p: string) => p === '/manager' },
  { href: '/manager/sales', label: '売上', match: (p: string) => p.startsWith('/manager/sales') },
  { href: '/manager/products', label: '商品', match: (p: string) => p.startsWith('/manager/products') },
  { href: '/manager/hours', label: '時間帯', match: (p: string) => p.startsWith('/manager/hours') },
  { href: '/manager/stock', label: '在庫', match: (p: string) => p.startsWith('/manager/stock') },
  { href: '/manager/customers', label: '顧客', match: (p: string) => p.startsWith('/manager/customers'), allStoreOnly: true },
] as const;

/** 分析画面のメニュー。「顧客」は全店の店長だけに出す（API も、それ以外は 403） */
export function ManagerNav({ showCustomers }: { showCustomers: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="分析メニュー" className="mg-nav">
      <ul>
        {MANAGER_LINKS.filter((l) => !('allStoreOnly' in l) || showCustomers).map((l) => {
          const active = l.match(pathname);
          return (
            <li key={l.href}>
              <Link href={l.href} aria-current={active ? 'page' : undefined} className={active ? 'is-active' : undefined}>
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

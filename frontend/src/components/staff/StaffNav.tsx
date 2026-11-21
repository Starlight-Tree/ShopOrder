'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/staff', label: 'ボード', match: (p: string) => p === '/staff' },
  { href: '/staff/stock', label: '在庫', match: (p: string) => p === '/staff/stock' || p.startsWith('/staff/stock/') },
] as const;

export function StaffNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="スタッフメニュー" className="st-nav">
      <ul>
        {LINKS.map((l) => {
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

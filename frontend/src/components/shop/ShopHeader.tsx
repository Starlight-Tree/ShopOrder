import Link from 'next/link';
import { ShopNav } from './ShopNav';

/** ヘッダー: ロゴ・メニュー・カート（点数）・注文履歴 */
export function ShopHeader({ cartCount }: { cartCount: number | null }) {
  return (
    <header className="shop-header">
      <div className="shop-header-inner">
        <Link href="/" className="shop-logo">
          <span className="shop-logo-mark" aria-hidden="true" />
          オアシス珈琲
        </Link>
        <ShopNav cartCount={cartCount} />
      </div>
    </header>
  );
}

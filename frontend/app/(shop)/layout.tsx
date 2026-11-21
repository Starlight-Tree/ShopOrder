import type { ReactNode } from 'react';
import { DevUserForm } from '../../src/components/shop/DevUserForm';
import { ShopFooter } from '../../src/components/shop/ShopFooter';
import { ShopHeader } from '../../src/components/shop/ShopHeader';
import { devToolsEnabled } from '../../src/lib/shop/dev-user';
import { loadCartCount } from '../../src/lib/shop/queries';
import { getShopCtx } from '../../src/lib/shop/session';
import '../../src/styles/shop.css';
import { setDevUserAction } from '../shop-actions/dev-user';

// 顧客の画面の共通の枠（ヘッダー・本文・フッター）。スタッフの画面（app/staff）は別の枠
export default async function ShopLayout({ children }: { children: ReactNode }) {
  const ctx = await getShopCtx();
  const cartCount = await loadCartCount(ctx);
  return (
    <div className="shop-root">
      <a className="shop-skip" href="#main">
        本文へ移動
      </a>
      <ShopHeader cartCount={cartCount} />
      <main id="main" className="shop-main" tabIndex={-1}>
        {children}
      </main>
      <ShopFooter>{devToolsEnabled() ? <DevUserForm action={setDevUserAction} current={ctx.devUser} /> : null}</ShopFooter>
    </div>
  );
}

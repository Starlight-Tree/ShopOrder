import type { ReactNode } from 'react';

/** フッター。children には、開発用ログイン名の切替（開発のときだけ）を渡す */
export function ShopFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className="shop-footer">
      <div className="shop-footer-inner">
        <p className="muted">オアシス珈琲は、惑星ザーハード、アルカ市の架空のカフェです。データはすべてダミー、お支払いは模擬です。</p>
        {children}
      </div>
    </footer>
  );
}

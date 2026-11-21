import Link from 'next/link';

export default function ShopNotFound() {
  return (
    <>
      <h1>見つかりませんでした</h1>
      <div className="notice">
        <p>お探しのページ、または注文は見つかりませんでした。</p>
        <p>
          <Link href="/" className="shop-btn shop-btn-primary">
            メニューへ
          </Link>
        </p>
      </div>
    </>
  );
}

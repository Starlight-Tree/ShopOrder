import { LoadError } from '../../src/components/shop/LoadError';
import { MenuScreen } from '../../src/components/shop/MenuScreen';
import { parseCategory } from '../../src/lib/shop/labels';
import { loadMenuPage } from '../../src/lib/shop/queries';
import { getShopCtx } from '../../src/lib/shop/session';
import { addToCartAction, selectStoreAction } from '../shop-actions/cart';

export const dynamic = 'force-dynamic';

// メニュー: 店の選択（カートの店）・カテゴリの絞り込み・品ごとのカード
export default async function MenuPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const category = parseCategory((await searchParams).category);
  const result = await loadMenuPage(await getShopCtx());
  return (
    <>
      <h1>メニュー</h1>
      <p className="lead">砂漠のオアシスのように、人が集まる場所をつくる。店を選んで、メニューから店頭でお受け取りの注文ができます。（架空のカフェ。データはすべてダミー）</p>
      {result.ok ? (
        <MenuScreen data={result.data} category={category} selectStoreAction={selectStoreAction} addAction={addToCartAction} />
      ) : (
        <LoadError error={result.error} status={result.status} />
      )}
    </>
  );
}

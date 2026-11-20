import { MenuList } from '../src/components/MenuList';
import { StoreList } from '../src/components/StoreList';
import { fetchMenu, fetchStores } from '../src/lib/api';
import type { MenuItem, Store } from '../src/lib/types';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let data: { stores: Store[]; menu: MenuItem[] } | null = null;
  try {
    const [stores, menu] = await Promise.all([fetchStores(), fetchMenu()]);
    data = { stores, menu };
  } catch {
    data = null;
  }

  return (
    <main className="page">
      <h1>オアシス珈琲</h1>
      <p className="lead">砂漠のオアシスのように、人が集まる場所をつくる。惑星ザーハード、アルカ市の 12 店舗です。（架空のカフェ。データはすべてダミー）</p>
      {data === null ? (
        <div className="notice" role="alert">
          <p>店とメニューを読み込めませんでした。しばらくしてから、もう一度開いてください。</p>
        </div>
      ) : (
        <>
          <h2>メニュー</h2>
          <MenuList items={data.menu} />
          <h2>店舗</h2>
          <StoreList stores={data.stores} />
        </>
      )}
    </main>
  );
}

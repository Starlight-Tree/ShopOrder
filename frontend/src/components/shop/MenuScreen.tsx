import type { Category } from '../../lib/shop/labels';
import type { MenuPageData } from '../../lib/shop/queries';
import type { FormAction } from '../../lib/shop/types';
import { CategoryTabs } from './CategoryTabs';
import { MenuGrid } from './MenuGrid';
import { StorePicker } from './StorePicker';

/** メニュー画面の中身: 店の選択・カテゴリの絞り込み・品のカード */
export function MenuScreen({ data, category, selectStoreAction, addAction }: { data: MenuPageData; category: Category | null; selectStoreAction: FormAction; addAction: FormAction }) {
  return (
    <>
      <StorePicker stores={data.stores} selectedId={data.selectedStore?.id ?? null} action={selectStoreAction} />
      {data.cart === null ? (
        <p className="shop-warn" role="alert">
          カートを読み込めませんでした。しばらくしてから、もう一度開いてください。
        </p>
      ) : null}
      <CategoryTabs current={category} />
      <MenuGrid items={data.menu} store={data.selectedStore} category={category} addAction={addAction} />
      <p className="muted">アレルギーのある方は、ご注文の前に、お店へご確認ください。価格は税込です。</p>
    </>
  );
}

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cart } from '../../lib/contract';
import type { CartPageData } from '../../lib/shop/queries';
import { cart, cartLine, menuItem, store } from '../../lib/shop/testing';
import type { FormAction } from '../../lib/shop/types';
import type { Store } from '../../lib/types';
import { CartView } from './CartView';
import { CategoryTabs } from './CategoryTabs';
import { MenuGrid } from './MenuGrid';
import { MenuScreen } from './MenuScreen';
import { ShopHeader } from './ShopHeader';
import { StorePicker } from './StorePicker';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ refresh: vi.fn() }) }));

const noop: FormAction = async () => null;
const cartActions = { qty: noop, fulfillment: noop, address: noop, slot: noop };
const pageData = (c: Cart, s: Store | null, extra: Partial<CartPageData> = {}): CartPageData => ({ cart: c, store: s, zones: null, delivery: null, ...extra });

beforeEach(() => {
  nav.pathname = '/';
});

describe('ヘッダー', () => {
  it('ロゴ・メニュー・カート（点数）・注文履歴。今のページに aria-current', () => {
    nav.pathname = '/cart';
    render(<ShopHeader cartCount={3} />);
    expect(screen.getByRole('link', { name: 'オアシス珈琲' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'メニュー' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '注文履歴' })).toHaveAttribute('href', '/orders');
    const cartLink = screen.getByRole('link', { name: /カート/ });
    expect(cartLink).toHaveAttribute('href', '/cart');
    expect(cartLink).toHaveAttribute('aria-current', 'page');
    expect(cartLink).toHaveTextContent('3');
    expect(screen.getByText('（3 点）')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'メニュー' })).not.toHaveAttribute('aria-current');
  });

  it('点数が読めないときは、点数を出さない。確認画面ではカートが現在地', () => {
    nav.pathname = '/checkout';
    render(<ShopHeader cartCount={null} />);
    expect(screen.getByRole('link', { name: 'カート' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText(/点）/)).toBeNull();
  });

  it('注文の詳細でも、注文履歴が現在地', () => {
    nav.pathname = '/orders/K7M2Q9XD';
    render(<ShopHeader cartCount={0} />);
    expect(screen.getByRole('link', { name: '注文履歴' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('店の選択', () => {
  const stores = [
    store({ id: 1, name: '居住区本店' }),
    store({ id: 2, name: '居住区信号塔店', mobile_order: false, accepting_orders: false, closed_reason: 'mobile_order_unavailable' }),
    store({ id: 3, name: '発着場中央店', area: '発着場', accepting_orders: false, closed_reason: 'outside_hours' }),
  ];

  it('営業中でない店は、理由つきで選べない（ボタンは無効）', () => {
    render(<StorePicker stores={stores} selectedId={null} action={noop} />);
    const closed = screen.getByText('発着場中央店').closest('li')!;
    expect(within(closed).getByText('営業時間外です')).toBeInTheDocument();
    expect(within(closed).getByRole('button', { name: '発着場中央店は選べません' })).toBeDisabled();
    expect(within(closed).getByRole('button', { name: '発着場中央店は選べません' })).toHaveAccessibleDescription('営業時間外です');
    const mo = screen.getByText('居住区信号塔店').closest('li')!;
    expect(within(mo).getByText('この店はモバイルオーダーをご利用いただけません')).toBeInTheDocument();
    expect(within(mo).getByRole('button', { name: '居住区信号塔店は選べません' })).toBeDisabled();
    // 営業中の店は選べる（store_id を送る）
    const open = screen.getByText('居住区本店').closest('li')!;
    expect(within(open).getByRole('button', { name: '居住区本店を選ぶ' })).toBeEnabled();
    expect(open.querySelector('input[name="store_id"]')).toHaveValue('1');
  });

  it('未選択なら開いている。選択済みなら閉じて、店名と「選択中」を出す', () => {
    const { container, rerender } = render(<StorePicker stores={stores} selectedId={null} action={noop} />);
    expect(container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText('店を選んでください')).toBeInTheDocument();
    rerender(<StorePicker stores={stores} selectedId={1} action={noop} />);
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('選択中')).toBeInTheDocument();
    expect(screen.getByText('変更する')).toBeInTheDocument();
  });

  it('エリアごとに並べる', () => {
    render(<StorePicker stores={stores} selectedId={null} action={noop} />);
    expect(screen.getByRole('heading', { name: '居住区' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '発着場' })).toBeInTheDocument();
  });
});

describe('メニュー', () => {
  const items = [
    menuItem({ id: 1, name: 'オアシスブレンド' }),
    menuItem({
      id: 2, name: 'ミートパイ', category: 'food', allergens: ['卵', '乳', '小麦'], sold_from: '11:00',
      variants: [{ id: 21, size: '-', temperature: '-', price_lumi: 480, available: false, unavailable_reason: 'out_of_hours' }],
    }),
    menuItem({
      id: 3, name: 'アイスラテ', category: 'drink',
      variants: [
        { id: 31, size: 'M', temperature: 'ice', price_lumi: 500, available: false, unavailable_reason: 'sold_out' },
        { id: 32, size: 'L', temperature: 'ice', price_lumi: 570, available: true, unavailable_reason: null },
      ],
    }),
    menuItem({
      id: 4, name: '帰還祭の限定ドリンク', season_from: '12-01', season_to: '12-25',
      variants: [{ id: 41, size: 'M', temperature: 'hot', price_lumi: 550, available: false, unavailable_reason: 'out_of_season' }],
    }),
    menuItem({ id: 5, name: 'オアシスブレンドの豆', category: 'beans', variants: [{ id: 51, size: '-', temperature: '-', price_lumi: 1800, available: true, unavailable_reason: null }] }),
  ];

  it('品ごとに、名前・説明・アレルゲン・変種（サイズ・温度ごとの価格）・「カートに入れる」', () => {
    render(<MenuGrid items={items} store={store()} category={null} addAction={noop} />);
    const card = screen.getByRole('heading', { name: 'オアシスブレンド' }).closest('li')!;
    expect(within(card).getByText('深煎りの 3 種ブレンド')).toBeInTheDocument();
    expect(within(card).getByText('S サイズ・ホット')).toBeInTheDocument();
    expect(within(card).getByText('380 ルミ')).toBeInTheDocument();
    expect(within(card).getByText('450 ルミ')).toBeInTheDocument();
    const add = within(card).getByRole('button', { name: 'オアシスブレンド（M サイズ・ホット）をカートに入れる' });
    expect(add).toBeEnabled();
    expect(add.closest('form')!.querySelector('input[name="variant_id"]')).toHaveValue('12');
    const pie = screen.getByRole('heading', { name: 'ミートパイ' }).closest('li')!;
    expect(within(pie).getByText('含む: 卵・乳・小麦')).toBeInTheDocument();
    expect(within(pie).getByText('11:00 から')).toBeInTheDocument();
  });

  it('available=false の変種は、理由つきで無効（季節外・時間外・売り切れ）。同じ品の他の変種は入れられる', () => {
    render(<MenuGrid items={items} store={store()} category={null} addAction={noop} />);
    const pie = screen.getByRole('heading', { name: 'ミートパイ' }).closest('li')!;
    expect(within(pie).getByText('販売時間外のため')).toBeInTheDocument();
    expect(within(pie).getByRole('button', { name: 'ミートパイ（通常）をカートに入れる' })).toBeDisabled();

    const latte = screen.getByRole('heading', { name: 'アイスラテ' }).closest('li')!;
    expect(within(latte).getByText('売り切れのため')).toBeInTheDocument();
    expect(within(latte).getByText('M サイズ・アイス').closest('li')!.querySelector('button')).toBeDisabled();
    expect(within(latte).getByRole('button', { name: 'アイスラテ（L サイズ・アイス）をカートに入れる' })).toBeEnabled();

    const festival = screen.getByRole('heading', { name: '帰還祭の限定ドリンク' }).closest('li')!;
    expect(within(festival).getByText('季節外のため')).toBeInTheDocument();
    expect(within(festival).getByText('12/1〜12/25 限定')).toBeInTheDocument();
    expect(within(festival).getByRole('button', { name: '帰還祭の限定ドリンク（M サイズ・ホット）をカートに入れる' })).toBeDisabled();
  });

  it('無効のボタンは、理由の文と関連づける（aria-describedby）', () => {
    render(<MenuGrid items={items} store={store()} category={null} addAction={noop} />);
    const pie = screen.getByRole('heading', { name: 'ミートパイ' }).closest('li')!;
    // 無効のボタンも、どの品かが名前で分かる（読み上げで「カートに入れる」だけにならない）
    expect(within(pie).getByRole('button', { name: 'ミートパイ（通常）をカートに入れる' })).toHaveAccessibleDescription('販売時間外のため');
  });

  it('店が未選択・営業外なら、すべて無効。理由は品ごとに繰り返さず、メニューの上に 1 回だけ出す', () => {
    const { rerender } = render(<MenuGrid items={[items[0]!]} store={null} category={null} addAction={noop} />);
    const buttons = screen.getAllByRole('button', { name: /カートに入れる/ }) as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(screen.getAllByText('先に、受け取る店を選んでください。')).toHaveLength(1);
    expect(buttons.every((b) => b.getAttribute('aria-describedby') === 'menu-store-note')).toBe(true);
    expect(buttons[0]).toHaveAccessibleDescription('先に、受け取る店を選んでください。');
    rerender(<MenuGrid items={[items[0]!]} store={store({ accepting_orders: false, closed_reason: 'outside_hours' })} category={null} addAction={noop} />);
    expect(screen.getAllByText(/選んだ「居住区本店」は、今は注文を受け付けていません（営業時間外です）/)).toHaveLength(1);
    expect((screen.getAllByRole('button', { name: /カートに入れる/ }) as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true);
  });

  it('営業中の店では、店のせいの注意は出さない', () => {
    render(<MenuGrid items={[items[0]!]} store={store()} category={null} addAction={noop} />);
    expect(screen.queryByText(/先に、受け取る店/)).toBeNull();
    expect(document.getElementById('menu-store-note')).toBeNull();
  });

  it('カテゴリで絞り込む（ドリンク・フード・豆）。区分の見出しは、あるものだけ', () => {
    const { rerender } = render(<MenuGrid items={items} store={store()} category={null} addAction={noop} />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['ドリンク', 'フード', '豆']);
    rerender(<MenuGrid items={items} store={store()} category="beans" addAction={noop} />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['豆']);
    expect(screen.queryByRole('heading', { name: 'ミートパイ' })).toBeNull();
    expect(screen.getByText('1,800 ルミ')).toBeInTheDocument();
    rerender(<MenuGrid items={[]} store={store()} category="food" addAction={noop} />);
    expect(screen.getByText('この区分の品は、今ありません。')).toBeInTheDocument();
  });

  it('カテゴリのタブは、リンク（?category=）で、選択中に aria-current', () => {
    render(<CategoryTabs current="food" />);
    expect(screen.getByRole('link', { name: 'すべて' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'ドリンク' })).toHaveAttribute('href', '/?category=drink');
    expect(screen.getByRole('link', { name: 'フード' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '豆' })).toHaveAttribute('href', '/?category=beans');
    expect(screen.getByRole('link', { name: 'すべて' })).not.toHaveAttribute('aria-current');
  });

  it('メニュー画面: 選んだ店が営業外なら警告。カートが読めなければ、そのことを出す', () => {
    const closed = store({ accepting_orders: false, closed_reason: 'past_last_order' });
    const data = { stores: [closed], cart: cart(), selectedStore: closed, menu: items };
    const { rerender } = render(<MenuScreen data={data} category={null} selectStoreAction={noop} addAction={noop} />);
    expect(screen.getByText(/今は注文を受け付けていません（ラストオーダーを過ぎました）。別の店を選んでください/)).toBeInTheDocument();
    rerender(<MenuScreen data={{ ...data, cart: null, selectedStore: null }} category={null} selectStoreAction={noop} addAction={noop} />);
    expect(screen.getByText(/カートを読み込めませんでした/)).toBeInTheDocument();
  });
});

describe('カート', () => {
  const lines = [
    cartLine({ variant_id: 12, name: 'オアシスブレンド', qty: 2, unit_price_lumi: 450, line_total_lumi: 900 }),
    cartLine({ variant_id: 21, name: 'ミートパイ', size: '-', temperature: '-', qty: 1, unit_price_lumi: 480, line_total_lumi: 480 }),
  ];
  const full = cart({ lines, subtotal_lumi: 1380, total_lumi: 1380 });

  it('行ごとの数量（±と削除）。ボタンは絶対値（現在 ± 1・0）を送る', () => {
    render(<CartView data={pageData(full, store())} actions={cartActions} />);
    const row = screen.getByText('オアシスブレンド').closest('li')!;
    expect(row.querySelector('input[name="variant_id"]')).toHaveValue('12');
    const less = within(row).getByRole('button', { name: 'オアシスブレンドを 1 つ減らす' });
    const more = within(row).getByRole('button', { name: 'オアシスブレンドを 1 つ増やす' });
    const del = within(row).getByRole('button', { name: 'オアシスブレンドをカートから削除する' });
    expect([less, more, del].map((b) => [b.getAttribute('name'), b.getAttribute('value')])).toEqual([['qty', '1'], ['qty', '3'], ['qty', '0']]);
    // 1 個のときは、− を無効にする（削除は別のボタン）
    const single = screen.getByText('ミートパイ').closest('li')!;
    expect(within(single).getByRole('button', { name: 'ミートパイを 1 つ減らす' })).toBeDisabled();
    expect(within(single).getByText('通常・480 ルミ')).toBeInTheDocument();
  });

  it('20 個で + を無効にする', () => {
    render(<CartView data={pageData(cart({ lines: [cartLine({ qty: 20 })] }), store())} actions={cartActions} />);
    expect(screen.getByRole('button', { name: 'オアシスブレンドを 1 つ増やす' })).toBeDisabled();
  });

  it('小計・合計・店・受け取り方法（店頭が選択中。宅配へ切り替えられる）', () => {
    render(<CartView data={pageData(full, store())} actions={cartActions} />);
    const totals = screen.getByRole('heading', { name: 'お支払い金額' }).closest('section')!;
    expect(within(totals).getByText('小計').nextSibling).toHaveTextContent('1,380 ルミ');
    expect(within(totals).getByText('合計').nextSibling).toHaveTextContent('1,380 ルミ');
    expect(within(totals).queryByText('送料')).toBeNull();
    expect(screen.getByText('居住区本店')).toBeInTheDocument();
    expect(screen.getByText('店頭でお渡し').closest('li')).toHaveTextContent('選択中');
    const toDelivery = screen.getByRole('button', { name: '受け取り方法を宅配にする' });
    expect(toDelivery.closest('form')!.querySelector('input[name="fulfillment"]')).toHaveValue('delivery');
    expect(screen.getByRole('link', { name: '店を変える' })).toHaveAttribute('href', '/');
  });

  it('進める状態なら「注文内容を確認する」は /checkout へのリンク', () => {
    render(<CartView data={pageData(full, store())} actions={cartActions} />);
    expect(screen.getByRole('link', { name: '注文内容を確認する' })).toHaveAttribute('href', '/checkout');
  });

  it('available=false の行は警告し、確認へは進めない（理由つき）', () => {
    const bad = cart({ lines: [cartLine({ available: false, unavailable_reason: 'sold_out' }), lines[1]!] });
    render(<CartView data={pageData(bad, store())} actions={cartActions} />);
    expect(screen.getByText('今は注文できません')).toBeInTheDocument();
    expect(screen.getByText(/売り切れのため/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('今は注文できない品が入っています');
    expect(screen.queryByRole('link', { name: '注文内容を確認する' })).toBeNull();
    const cta = screen.getByRole('button', { name: '注文内容を確認する' });
    expect(cta).toBeDisabled();
    expect(cta).toHaveAccessibleDescription(/今は注文できない品があります/);
    // 品切れの行は、増やせない。削除はできる
    const row = screen.getByText('今は注文できません').closest('li')!;
    expect(within(row).getByRole('button', { name: 'オアシスブレンドを 1 つ増やす' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'オアシスブレンドをカートから削除する' })).toBeEnabled();
  });

  it('選んだ店が営業外なら、確認へ進めない', () => {
    render(<CartView data={pageData(full, store({ accepting_orders: false, closed_reason: 'closed_today' }))} actions={cartActions} />);
    expect(screen.getByRole('button', { name: '注文内容を確認する' })).toBeDisabled();
    expect(screen.getByText(/本日は定休日です/)).toBeInTheDocument();
  });

  it('空のカート: メニューへの案内。店が未選択: 店を選ぶリンクと、進めない理由', () => {
    const { rerender } = render(<CartView data={pageData(cart({ lines: [], subtotal_lumi: 0, total_lumi: 0 }), null)} actions={cartActions} />);
    expect(screen.getByText('カートは空です。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'メニューを見る' })).toHaveAttribute('href', '/');
    rerender(<CartView data={pageData(cart({ store: null }), null)} actions={cartActions} />);
    expect(screen.getByRole('link', { name: '店を選ぶ' })).toBeInTheDocument();
    expect(screen.getByText('受け取る店を選んでください')).toBeInTheDocument();
  });
});

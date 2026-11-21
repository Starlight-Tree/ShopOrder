// 画面（app/(shop)/ の Server Component）を、fetch を差し替えて描く。Cookie → X-Dev-User・本番での開発用の道具の非表示・確認画面ごとの冪等キー・404
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, cart, cartLine, menuItem, order, proposal, stubApi, store } from '../../lib/shop/testing';
import CartPage from '../../../app/(shop)/cart/page';
import CheckoutPage from '../../../app/(shop)/checkout/page';
import ShopLayout from '../../../app/(shop)/layout';
import MenuPage from '../../../app/(shop)/page';
import OrderPage from '../../../app/(shop)/orders/[id]/page';
import OrdersPage from '../../../app/(shop)/orders/page';

const env = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => (name === 'shop_order_dev_user' && env.cookie !== undefined ? { name, value: env.cookie } : undefined) }) }));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ refresh: vi.fn() }),
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

beforeEach(() => {
  env.cookie = undefined;
  vi.unstubAllEnvs();
});

const noParams = Promise.resolve({} as Record<string, string | string[] | undefined>);

describe('共通の枠（app/(shop)/layout.tsx）', () => {
  it('ヘッダーのカートの点数。Cookie の利用者を X-Dev-User で API へ渡す', async () => {
    env.cookie = 'alice-2';
    const { calls } = stubApi((r) => (r.path === '/api/cart' ? { body: cart({ lines: [cartLine({ qty: 2 }), cartLine({ variant_id: 13, qty: 1 })] }) } : undefined));
    render(await ShopLayout({ children: <p>本文</p> }));
    expect(screen.getByRole('link', { name: /カート/ })).toHaveTextContent('3');
    expect(screen.getByText('本文')).toBeInTheDocument();
    expect(calls.map((c) => c.headers['X-Dev-User'])).toEqual(['alice-2']);
  });

  it('規則に合わない Cookie の値は、ヘッダーに入れない', async () => {
    env.cookie = 'Bad Value;\r\nX-Evil: 1';
    const { calls } = stubApi(() => ({ body: cart() }));
    render(await ShopLayout({ children: null }));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !('X-Dev-User' in c.headers))).toBe(true);
  });

  it('開発では、フッターに開発用ログイン名の切替（今の名前入り）を出す', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    env.cookie = 'alice-2';
    stubApi(() => ({ body: cart() }));
    render(await ShopLayout({ children: null }));
    expect(screen.getByLabelText('開発用ログイン名')).toHaveValue('alice-2');
  });

  it('NODE_ENV が production のときは、切替を出さない', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubApi(() => ({ body: cart() }));
    render(await ShopLayout({ children: null }));
    expect(screen.queryByLabelText('開発用ログイン名')).toBeNull();
    expect(screen.queryByRole('button', { name: '切り替える' })).toBeNull();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('カートが読めなくても、枠は描く（点数を出さないだけ）', async () => {
    stubApi(() => apiError(500, 'boom'));
    render(await ShopLayout({ children: <p>本文</p> }));
    expect(screen.getByText('本文')).toBeInTheDocument();
    expect(screen.queryByText(/点）/)).toBeNull();
  });
});

describe('メニュー /', () => {
  it('カートの店があれば、その店の在庫を見たメニューを取る。?category= で絞る', async () => {
    const stores = [store({ id: 1 }), store({ id: 3, name: '発着場中央店', area: '発着場', accepting_orders: false, closed_reason: 'outside_hours' })];
    const { calls } = stubApi((r) => {
      if (r.path === '/api/stores') return { body: stores };
      if (r.path === '/api/cart') return { body: cart() };
      if (r.path.startsWith('/api/menu')) return { body: [menuItem({ id: 1 }), menuItem({ id: 2, name: 'ミートパイ', category: 'food' })] };
    });
    render(await MenuPage({ searchParams: Promise.resolve({ category: 'food' }) }));
    expect(calls.some((c) => c.path === '/api/menu?store_id=1')).toBe(true);
    expect(screen.getByRole('heading', { name: 'ミートパイ' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'オアシスブレンド' })).toBeNull();
    expect(screen.getByText('選択中')).toBeInTheDocument();
    expect(screen.getByText('営業時間外です')).toBeInTheDocument();
  });

  it('店の一覧が読めなければ、固定の文で知らせる（例外の文字列・接続先は出さない）', async () => {
    stubApi(() => apiError(500, 'internal', { trace: 'SECRET' }));
    render(await MenuPage({ searchParams: noParams }));
    expect(screen.getByRole('alert')).toHaveTextContent('うまくいきませんでした');
    expect(document.body).not.toHaveTextContent('SECRET');
  });
});

describe('カート /cart', () => {
  it('カートと、その店（営業外なら確認へ進めない）', async () => {
    stubApi((r) => {
      if (r.path === '/api/cart') return { body: cart() };
      if (r.path === '/api/stores') return { body: [store({ accepting_orders: false, closed_reason: 'closed_today' })] };
    });
    render(await CartPage({ searchParams: noParams }));
    expect(screen.getByRole('button', { name: '注文内容を確認する' })).toBeDisabled();
    expect(screen.getByText(/本日は定休日です/)).toBeInTheDocument();
  });
});

describe('確認 /checkout', () => {
  it('提案を作って確認カードを出す。冪等キーは、画面を描くたびに新しく作る', async () => {
    const { calls } = stubApi((r) => (r.path === '/api/cart/checkout-proposal' ? { body: proposal() } : undefined));
    const keyOf = () => document.querySelector<HTMLInputElement>('input[name="idempotency_key"]')!.value;
    const first = render(await CheckoutPage());
    const k1 = keyOf();
    expect(k1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    first.unmount();
    render(await CheckoutPage());
    expect(keyOf()).not.toBe(k1);
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/cart/checkout-proposal')).toHaveLength(2);
    expect(calls.some((c) => c.path === '/api/orders')).toBe(false); // 画面を描くだけでは、注文を確定しない
    expect(screen.getByRole('button', { name: '注文を確定する' })).toBeInTheDocument();
  });

  it.each([
    ['store_closed', { closed_reason: 'outside_hours' }, /営業時間外です/],
    ['sold_out', { item_name: 'ミートパイ' }, /「ミートパイ」は売り切れました/],
    ['item_unavailable', { variant_ids: [12] }, /今は注文できない品/],
    ['over_limit', {}, /30,000 ルミ以内/],
    ['cart_empty', {}, /カートが空です/],
    ['store_not_selected', {}, /店が選ばれていません/],
  ])('提案が 409 %s なら、固定の日本語の文と直し方（確定ボタンは出さない）', async (code, extra, text) => {
    stubApi(() => apiError(409, code, extra));
    render(await CheckoutPage());
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(within(screen.getByRole('alert')).getByRole('link')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '注文を確定する' })).toBeNull();
  });
});

describe('注文 /orders/[id]', () => {
  const params = (id: string) => Promise.resolve({ id });

  it('placed: 支払う（模擬）と確保の残り時間。開発では失敗の模擬も出す', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    env.cookie = 'bob';
    const { calls } = stubApi((r) => (r.path === '/api/orders/K7M2Q9XD' ? { body: order() } : undefined));
    render(await OrderPage({ params: params('K7M2Q9XD'), searchParams: noParams }));
    expect(screen.getByRole('button', { name: '支払う（模擬）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '支払いを失敗させる（模擬）' })).toBeInTheDocument();
    expect(calls[0]!.headers['X-Dev-User']).toBe('bob');
  });

  it('NODE_ENV が production のときは、支払いを失敗させるボタンを出さない', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubApi(() => ({ body: order() }));
    render(await OrderPage({ params: params('K7M2Q9XD'), searchParams: noParams }));
    expect(screen.getByRole('button', { name: '支払う（模擬）' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /支払いを失敗させる/ })).toBeNull();
  });

  it('?notice=payment_declined は、固定の文で上に出す。未知の値は出さない', async () => {
    stubApi(() => ({ body: order({ status: 'cancelled', can_pay: false, can_cancel: false, cancel_reason: 'payment_declined' }) }));
    const { unmount } = render(await OrderPage({ params: params('K7M2Q9XD'), searchParams: Promise.resolve({ notice: 'payment_declined' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent('お支払いに失敗しました（模擬）');
    unmount();
    render(await OrderPage({ params: params('K7M2Q9XD'), searchParams: Promise.resolve({ notice: '<script>x</script>' }) }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('他人の注文・存在しない注文（404）は、見つかりません（存在を教えない）', async () => {
    stubApi(() => apiError(404, 'not_found'));
    await expect(OrderPage({ params: params('ZZZZZZZZ'), searchParams: noParams })).rejects.toThrow('NOT_FOUND');
  });

  it('不正な ID は、API を呼ばずに見つかりません', async () => {
    const { calls } = stubApi(() => ({ body: order() }));
    await expect(OrderPage({ params: params('../cart'), searchParams: noParams })).rejects.toThrow('NOT_FOUND');
    await expect(OrderPage({ params: params('a..b'), searchParams: noParams })).rejects.toThrow('NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('API が落ちているときは、固定の文（404 にしない）', async () => {
    stubApi(() => apiError(503, 'down'));
    render(await OrderPage({ params: params('K7M2Q9XD'), searchParams: noParams }));
    expect(screen.getByRole('alert')).toHaveTextContent('うまくいきませんでした');
  });
});

describe('注文履歴 /orders', () => {
  it('自分の注文を出す', async () => {
    stubApi((r) => (r.path === '/api/orders' ? { body: [{ public_id: 'K7M2Q9XD', pickup_no: 12, status: 'paid', store: { id: 1, name: '居住区本店' }, total_lumi: 900, placed_at: '2026-11-21T01:00:00Z' }] } : undefined));
    render(await OrdersPage());
    expect(screen.getByRole('link', { name: /居住区本店/ })).toHaveAttribute('href', '/orders/K7M2Q9XD');
  });
});

// 宅配（P2）の画面（app/(shop)/ の Server Component）と、Server Action の薄い入口を、fetch を差し替えて試す
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddressesPage from '../../../app/(shop)/addresses/page';
import CartPage from '../../../app/(shop)/cart/page';
import CheckoutPage from '../../../app/(shop)/checkout/page';
import OrderPage from '../../../app/(shop)/orders/[id]/page';
import { createAddressAction, deleteAddressAction } from '../../../app/shop-actions/addresses';
import { selectAddressAction, selectFulfillmentAction, selectSlotAction } from '../../../app/shop-actions/cart';
import { address, apiError, cart, cartDelivery, deliveryCart, deliveryOrder, deliveryProposal, orderDelivery, slot, slotList, store, stubApi, zone, type StubReply, type StubRequest } from '../../lib/shop/testing';

const env = vi.hoisted(() => ({ cookie: undefined as string | undefined, refresh: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => (name === 'shop_order_dev_user' && env.cookie !== undefined ? { name, value: env.cookie } : undefined) }) }));
vi.mock('next/cache', () => ({ refresh: env.refresh }));
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
  env.refresh.mockClear();
  vi.unstubAllEnvs();
});

const noParams = Promise.resolve({} as Record<string, string | string[] | undefined>);
const puts = (calls: StubRequest[]) => calls.filter((c) => c.method === 'PUT').map((c) => c.body);

/** カートの画面に要る API の既定の応答 */
function cartApi(cartBody = deliveryCart(), over: (req: StubRequest) => StubReply = () => undefined) {
  return stubApi((req) => {
    const o = over(req);
    if (o) return o;
    if (req.path === '/api/cart') return { body: cartBody };
    if (req.path === '/api/stores') return { body: [store()] };
    if (req.path.startsWith('/api/delivery/zones')) return { body: [zone({ id: 1, name: '居住区', area_code: 1 }), zone()] };
    if (req.path === '/api/addresses') return { body: [address()] };
    if (req.path.startsWith('/api/stores/1/slots')) return { body: slotList({ slots: [slot()] }) };
  });
}

describe('カート /cart（宅配）', () => {
  // 今日の日付（選べる日の範囲）は、ページが Date.now() で決める。時計を固定する（11/21（土）19:00 の店の時間）
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('宅配のカート: 住所・時間枠を読んで描く。利用者は X-Dev-User で渡す。住所の番地は出さない', async () => {
    env.cookie = 'alice-2';
    const { calls } = cartApi();
    render(await CartPage({ searchParams: noParams }));
    expect(screen.getByRole('heading', { name: 'お届け先の住所を選ぶ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '受け取り方法を店頭でお渡しにする' })).toBeInTheDocument();
    expect(screen.getByText('選択中', { selector: '.shop-slot-note' })).toBeInTheDocument(); // カートで選んだ枠の日（11/22）が、既定
    expect(calls.map((c) => c.path)).toContain('/api/stores/1/slots?date=2026-11-22&zone_id=2');
    expect(calls.every((c) => c.headers['X-Dev-User'] === 'alice-2')).toBe(true);
    expect(document.body).not.toHaveTextContent('アルカ市発着場2-1-5');
  });

  it('?date= の日の枠を読む', async () => {
    const ok = cartApi(deliveryCart({ delivery: cartDelivery({ slot: null }) }));
    render(await CartPage({ searchParams: Promise.resolve({ date: '2026-11-24' }) }));
    expect(ok.calls.some((c) => c.path === '/api/stores/1/slots?date=2026-11-24&zone_id=2')).toBe(true);
  });

  it('日付に細工した値（別のパラメーター・パス）は、API に渡さない', async () => {
    const { calls } = cartApi(deliveryCart({ delivery: cartDelivery({ slot: null }) }));
    render(await CartPage({ searchParams: Promise.resolve({ date: '2026-11-24&zone_id=9' }) }));
    const slotCalls = calls.filter((c) => c.path.includes('/slots'));
    expect(slotCalls).toHaveLength(1);
    expect(slotCalls[0]!.path).not.toContain('zone_id=9');
    expect(slotCalls[0]!.path).toMatch(/^\/api\/stores\/1\/slots\?date=\d{4}-\d{2}-\d{2}&zone_id=2$/);
  });

  it('店頭のカートは、これまでどおり。宅配へ切り替えるボタンがある', async () => {
    cartApi(cart());
    render(await CartPage({ searchParams: noParams }));
    expect(screen.getByRole('button', { name: '受け取り方法を宅配にする' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '注文内容を確認する' })).toHaveAttribute('href', '/checkout');
  });

  it('時間枠が読めなくても、カートは描く（固定の文で知らせる。例外の文字列・接続先は出さない）', async () => {
    cartApi(deliveryCart(), (req) => (req.path.includes('/slots') ? apiError(500, 'internal_error', { message: 'SECRET /srv/app.py' }) : undefined));
    render(await CartPage({ searchParams: noParams }));
    expect(screen.getByText(/時間枠を読み込めませんでした/)).toBeInTheDocument();
    expect(screen.getByText('オアシスブレンド')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET');
  });
});

describe('確認 /checkout（宅配）', () => {
  it('宅配の確認カード（お届け先・時間枠・送料つきの合計）を出す。画面を描くだけでは、注文を確定しない', async () => {
    const { calls } = stubApi((r) => (r.path === '/api/cart/checkout-proposal' ? { body: deliveryProposal() } : undefined));
    render(await CheckoutPage());
    expect(screen.getByText('お届け先').nextSibling).toHaveTextContent('自宅（発着場）');
    expect(screen.getByText('合計').nextSibling).toHaveTextContent('1,100 ルミ');
    expect(calls.some((c) => c.path === '/api/orders')).toBe(false);
  });

  it.each([
    ['delivery_unavailable', {}, /宅配をしていません/],
    ['address_required', {}, /お届け先の住所を選んでください/],
    ['slot_required', {}, /お届けの時間枠を選んでください/],
    ['out_of_zone', {}, /届けられません/],
    ['zone_suspended', {}, /砂嵐の警報/],
    ['below_minimum', { min_order_lumi: 700 }, /700 ルミ以上/],
    ['slot_closed', {}, /お休みしています/],
    ['slot_cutoff', {}, /受付を締め切りました/],
    ['slot_full', {}, /満枠になりました/],
  ])('提案が 409 %s なら、固定の日本語の文と直し方のリンク（確定ボタンは出さない）', async (code, extra, text) => {
    stubApi(() => apiError(409, code, extra));
    render(await CheckoutPage());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(within(alert).getByRole('link')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '注文を確定する' })).toBeNull();
  });
});

describe('住所 /addresses', () => {
  it('住所の一覧と、エリアの選択肢（区画）。利用者は X-Dev-User で渡す', async () => {
    env.cookie = 'bob';
    const { calls } = cartApi();
    render(await AddressesPage());
    expect(screen.getByRole('heading', { name: '登録した住所（1 / 10 件）' })).toBeInTheDocument();
    expect(screen.getByText('アルカ市発着場2-1-5 305')).toBeInTheDocument(); // 本人の画面にだけ出す
    expect(within(screen.getByLabelText('エリア')).getAllByRole('option').map((o) => o.textContent)).toEqual(['選んでください', '居住区', '発着場']);
    expect(calls.map((c) => c.path).sort()).toEqual(['/api/addresses', '/api/delivery/zones']);
    expect(calls.every((c) => c.headers['X-Dev-User'] === 'bob')).toBe(true);
  });

  it('住所が読めなければ、固定の文（API の message・住所は出さない）', async () => {
    stubApi(() => apiError(500, 'internal_error', { message: 'SECRET アルカ市発着場2-1-5' }));
    render(await AddressesPage());
    expect(screen.getByRole('alert')).toHaveTextContent('うまくいきませんでした');
    expect(document.body).not.toHaveTextContent('SECRET');
  });
});

describe('注文 /orders/[id]（宅配）', () => {
  const params = (id: string) => Promise.resolve({ id });

  it('配達中: 暗証コードを出す。利用者は X-Dev-User で渡し、暗証コードは URL・クエリに出ない', async () => {
    env.cookie = 'bob';
    const { calls } = stubApi((r) =>
      r.path === '/api/orders/K7M2Q9XD' ? { body: deliveryOrder({ status: 'delivering', can_pay: false, can_cancel: false, delivery: orderDelivery({ status: 'delivering', pin: '4821', courier: { name: 'ラシード' } }) }) } : undefined,
    );
    render(await OrderPage({ params: params('K7M2Q9XD'), searchParams: noParams }));
    expect(screen.getByText('4821')).toBeInTheDocument();
    expect(screen.getByText('配達員にお伝えください。ほかの人には教えないでください。')).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['X-Dev-User']).toBe('bob');
    expect(calls.some((c) => c.path.includes('4821'))).toBe(false);
    expect([...document.querySelectorAll('a')].some((a) => (a.getAttribute('href') ?? '').includes('4821'))).toBe(false);
  });

  it('集荷前は、API が暗証コードを返してきても出さない', async () => {
    stubApi(() => ({ body: deliveryOrder({ status: 'assigned', can_pay: false, delivery: orderDelivery({ status: 'assigned', pin: '4821' }) }) }));
    render(await OrderPage({ params: params('K7M2Q9XD'), searchParams: noParams }));
    expect(screen.queryByText('4821')).toBeNull();
  });

  it('他人の注文（404）は、見つかりません。API が落ちていれば、固定の文', async () => {
    stubApi(() => apiError(404, 'not_found'));
    await expect(OrderPage({ params: params('ZZZZZZZZ'), searchParams: noParams })).rejects.toThrow('NOT_FOUND');
    stubApi(() => apiError(503, 'down'));
    render(await OrderPage({ params: params('K7M2Q9XD'), searchParams: noParams }));
    expect(screen.getByRole('alert')).toHaveTextContent('うまくいきませんでした');
  });
});

describe('Server Action の入口（薄い。値を確かめて、核の関数へ渡す）', () => {
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  it('住所の登録: FormData を検査して API へ。画面を更新する。結果は固定の文', async () => {
    env.cookie = 'bob';
    const { calls } = stubApi(() => ({ status: 201, body: address() }));
    const state = await createAddressAction(null, form({ label: '自宅', area_code: '2', line: 'アルカ市発着場2-1-5 305', note: '' }));
    expect(state).toEqual({ ok: true, message: '住所を登録しました' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/addresses', body: { label: '自宅', area_code: 2, line: 'アルカ市発着場2-1-5 305', note: null } });
    expect(calls[0]!.headers['X-Dev-User']).toBe('bob');
    expect(env.refresh).toHaveBeenCalledTimes(1);
  });

  it('住所の登録: 範囲外（長すぎる・エリアなし）は API を呼ばない', async () => {
    const { calls } = stubApi(() => ({ status: 201, body: address() }));
    expect(await createAddressAction(null, form({ label: 'あ'.repeat(21), area_code: '2', line: '住所' }))).toMatchObject({ ok: false });
    expect(await createAddressAction(null, form({ label: '自宅', line: '住所' }))).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('住所の削除: 不正な ID は API を呼ばない', async () => {
    const { calls } = stubApi(() => ({ status: 204 }));
    expect(await deleteAddressAction(null, form({ address_id: '3; DROP' }))).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    expect(await deleteAddressAction(null, form({ address_id: '3' }))).toMatchObject({ ok: true });
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/addresses/3' });
  });

  it('受け取り方法・住所・時間枠の選択: 値を確かめる（不正な値は API を呼ばない）', async () => {
    const { calls } = cartApi(deliveryCart());
    expect(await selectFulfillmentAction(null, form({ fulfillment: 'drone' }))).toMatchObject({ ok: false });
    expect(await selectAddressAction(null, form({ address_id: '0' }))).toMatchObject({ ok: false });
    expect(await selectSlotAction(null, form({ slot_id: 'abc' }))).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    expect(await selectFulfillmentAction(null, form({ fulfillment: 'pickup' }))).toMatchObject({ ok: true });
    expect(await selectAddressAction(null, form({ address_id: '5' }))).toMatchObject({ ok: true });
    expect(await selectSlotAction(null, form({ slot_id: '42' }))).toMatchObject({ ok: true });
    expect(puts(calls)).toEqual([
      { store_id: 1, fulfillment: 'pickup' },
      { store_id: 1, fulfillment: 'delivery', address_id: 5, slot_id: 41 },
      { store_id: 1, fulfillment: 'delivery', address_id: 3, slot_id: 42 },
    ]);
    expect(env.refresh).toHaveBeenCalledTimes(6); // 失敗しても、画面（枠の一覧）を新しくする
  });
});

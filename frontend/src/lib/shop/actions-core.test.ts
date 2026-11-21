import { describe, expect, it } from 'vitest';
import { addToCart, cancelOrder, payOrder, placeOrder, selectStore, setQty } from './actions-core';
import { apiError, cart, cartLine, order, stubApi } from './testing';

describe('カートに入れる（今の数量 + 1）', () => {
  it('カートに無ければ 1、あれば +1 を絶対値で送る', async () => {
    const { calls } = stubApi((req) => (req.method === 'GET' ? { body: cart({ lines: [cartLine({ variant_id: 12, qty: 2 })] }) } : { body: cart() }));
    const a = await addToCart({}, 12);
    const b = await addToCart({}, 99);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
      ['/api/cart/items/12', { qty: 3 }],
      ['/api/cart/items/99', { qty: 1 }],
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
  });

  it('同じ品が 20 個なら、API を呼ばずに断る', async () => {
    const { calls } = stubApi(() => ({ body: cart({ lines: [cartLine({ variant_id: 12, qty: 20 })] }) }));
    const r = await addToCart({}, 12);
    expect(r).toMatchObject({ ok: false });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('不正な ID は API を呼ばない。API の失敗は固定の文', async () => {
    const { calls } = stubApi(() => apiError(409, 'item_unavailable', { variant_ids: [12] }));
    expect(await addToCart({}, null)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    const r = await addToCart({}, 12);
    expect(r).toMatchObject({ ok: false });
  });
});

describe('数量・店', () => {
  it('数量は絶対値で送る（0 で削除）。不正な値は API を呼ばない', async () => {
    const { calls } = stubApi(() => ({ body: cart() }));
    await setQty({}, 12, 0);
    await setQty({}, 12, null);
    await setQty({}, null, 3);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/cart/items/12', body: { qty: 0 } });
  });

  it('店を選ぶ: 成功は店名を知らせる。422 delivery_unsupported・閉店は固定の文', async () => {
    stubApi(() => ({ body: cart() }));
    expect(await selectStore({}, 1)).toMatchObject({ ok: true, message: '受け取る店を「居住区本店」にしました' });
    stubApi(() => apiError(409, 'store_closed', { closed_reason: 'closed_today' }));
    const r = await selectStore({}, 1);
    expect(r).toMatchObject({ ok: false });
    expect(r && !r.ok && r.message).toContain('本日は定休日です');
    expect(await selectStore({}, null)).toMatchObject({ ok: false });
  });
});

describe('注文の確定（確認画面のボタンだけが呼ぶ）', () => {
  const ids = ['3f0c9a52-8d9e-4b6e-9a0e-0d3f6b6f9a11', 'c4a1d9f0-1b7e-4d8a-8a55-2f6f9d1b7e00'] as const;

  it('冪等キーを Idempotency-Key に、提案の ID を本文に付けて送り、注文の画面へ進む', async () => {
    const { calls } = stubApi(() => ({ status: 201, body: order({ public_id: 'K7M2Q9XD' }) }));
    const r = await placeOrder({ devUser: 'alice-1' }, ids[0], ids[1]);
    expect(r.redirectTo).toBe('/orders/K7M2Q9XD');
    expect(calls[0]?.headers['Idempotency-Key']).toBe(ids[1]);
    expect(calls[0]?.body).toEqual({ proposal_id: ids[0] });
  });

  it('同じキーの再送（200）でも、同じ注文の画面へ進む', async () => {
    stubApi(() => ({ status: 200, body: order({ public_id: 'K7M2Q9XD' }) }));
    expect((await placeOrder({}, ids[0], ids[1])).redirectTo).toBe('/orders/K7M2Q9XD');
  });

  it.each([
    ['store_closed', '今は注文を受け付けていません'],
    ['sold_out', '売り切れ'],
    ['item_unavailable', '今は注文できない品'],
    ['proposal_stale', 'カートの内容が変わりました'],
    ['proposal_expired', '有効期限が切れました'],
    ['over_limit', '30,000 ルミ以内'],
  ])('409 %s は、固定の日本語と直し方のリンクを返し、画面は移らない', async (code, fragment) => {
    stubApi(() => apiError(409, code, { item_name: 'ミートパイ', closed_reason: 'outside_hours' }));
    const r = await placeOrder({}, ids[0], ids[1]);
    expect(r.redirectTo).toBeNull();
    expect(r.state).toMatchObject({ ok: false });
    expect(r.state && !r.state.ok && r.state.message).toContain(fragment);
    expect(r.state && !r.state.ok && r.state.next?.href).toBeTruthy();
  });

  it('キー・提案の ID が不正なら、API を呼ばない', async () => {
    const { calls } = stubApi(() => ({ status: 201, body: order() }));
    expect((await placeOrder({}, 'x', ids[1])).redirectTo).toBeNull();
    expect((await placeOrder({}, ids[0], null)).redirectTo).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('支払い・取消し', () => {
  it('ok は、画面に留まって再取得する（redirect なし）', async () => {
    const { calls } = stubApi(() => ({ body: order({ status: 'paid' }) }));
    const r = await payOrder({}, 'K7M2Q9XD', 'ok', false);
    expect(r).toEqual({ state: { ok: true }, redirectTo: null });
    expect(calls[0]).toMatchObject({ path: '/api/orders/K7M2Q9XD/pay', body: { simulate: 'ok' } });
  });

  it('decline（402）と確保の期限切れ（409）は、注文の画面の上に知らせを出す', async () => {
    stubApi(() => apiError(402, 'payment_declined'));
    expect((await payOrder({}, 'K7M2Q9XD', 'decline', true)).redirectTo).toBe('/orders/K7M2Q9XD?notice=payment_declined');
    stubApi(() => apiError(409, 'reservation_expired'));
    expect((await payOrder({}, 'K7M2Q9XD', 'ok', true)).redirectTo).toBe('/orders/K7M2Q9XD?notice=reservation_expired');
  });

  it('decline は、開発用でなければ（本番）API を呼ばずに断る', async () => {
    const { calls } = stubApi(() => ({ body: order() }));
    const r = await payOrder({}, 'K7M2Q9XD', 'decline', false);
    expect(r.state).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('不正な注文 ID は API を呼ばない', async () => {
    const { calls } = stubApi(() => ({ body: order() }));
    expect((await payOrder({}, '../x', 'ok', true)).state).toMatchObject({ ok: false });
    expect((await cancelOrder({}, '../x')).state).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('取消し: 成功は ok。受付後（409 not_cancellable）は店に伝える案内', async () => {
    stubApi(() => ({ body: order({ status: 'cancelled' }) }));
    expect(await cancelOrder({}, 'K7M2Q9XD')).toEqual({ state: { ok: true }, redirectTo: null });
    stubApi(() => apiError(409, 'not_cancellable'));
    const r = await cancelOrder({}, 'K7M2Q9XD');
    expect(r.state && !r.state.ok && r.state.message).toContain('お店に');
    // 状態が変わって取消しの欄が消えるので、文は注文の画面の上の知らせにする
    expect(r.redirectTo).toBe('/orders/K7M2Q9XD?notice=not_cancellable');
  });
});

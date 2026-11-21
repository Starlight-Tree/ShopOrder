import { describe, expect, it } from 'vitest';
import { loadCartCount, loadCartPage, loadMenuPage, getMenu, getOrder, postCheckoutProposal, postOrder, postPay, putCartItem, putCartStore } from './queries';
import { apiError, cart, cartLine, menuItem, order, proposal, store, stubApi } from './testing';

describe('API の呼び出し（fetch を差し替えて試す）', () => {
  it('利用者は X-Dev-User で渡す。無ければヘッダーを付けない', async () => {
    const { calls } = stubApi(() => ({ body: cart() }));
    await putCartStore({ devUser: 'alice-1' }, 3);
    await putCartStore({}, 3);
    expect(calls[0]?.headers['X-Dev-User']).toBe('alice-1');
    expect(calls[1]?.headers['X-Dev-User']).toBeUndefined();
  });

  it('PUT /api/cart は店と受け取り方法（店頭のみ）。数量は絶対値', async () => {
    const { calls } = stubApi(() => ({ body: cart() }));
    await putCartStore({}, 3);
    await putCartItem({}, 12, 4);
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/cart', body: { store_id: 3, fulfillment: 'pickup' } });
    expect(calls[1]).toMatchObject({ method: 'PUT', path: '/api/cart/items/12', body: { qty: 4 } });
  });

  it('メニューは、店があれば store_id つき。無ければ付けない', async () => {
    const { calls } = stubApi(() => ({ body: [] }));
    await getMenu({}, 5);
    await getMenu({}, null);
    expect(calls.map((c) => c.path)).toEqual(['/api/menu?store_id=5', '/api/menu']);
  });

  it('確定: Idempotency-Key のヘッダーと { proposal_id } の本文', async () => {
    const { calls } = stubApi(() => ({ status: 201, body: order() }));
    const r = await postOrder({ devUser: 'alice-1' }, 'p-12345678', 'key-12345678');
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/orders', body: { proposal_id: 'p-12345678' } });
    expect(calls[0]?.headers['Idempotency-Key']).toBe('key-12345678');
    expect(calls[0]?.headers['X-Dev-User']).toBe('alice-1');
  });

  it('公開 ID は URL エンコードして、パスに入れる（../ で別の API を呼ばせない）', async () => {
    const { calls } = stubApi(() => ({ body: order() }));
    await getOrder({}, '../staff/orders');
    await postPay({}, 'K7M2Q9XD', 'decline');
    expect(calls[0]?.path).toBe('/api/orders/..%2Fstaff%2Forders');
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/orders/K7M2Q9XD/pay', body: { simulate: 'decline' } });
  });

  it('失敗は例外にせず、code を返す（409 の code・422・接続失敗）', async () => {
    stubApi(() => apiError(409, 'store_closed', { closed_reason: 'outside_hours' }));
    const r = await postCheckoutProposal({});
    expect(r).toMatchObject({ ok: false, status: 409, error: { code: 'store_closed', closed_reason: 'outside_hours' } });
  });

  it('接続できないときは status 0・code unreachable（接続先の文字列を含めない）', async () => {
    stubApi(() => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:8000');
    });
    const r = await postCheckoutProposal({});
    expect(r).toMatchObject({ ok: false, status: 0, error: { code: 'unreachable' } });
    expect(JSON.stringify(r)).not.toContain('10.0.0.5');
  });
});

describe('メニュー画面のまとめ取得', () => {
  it('カートの店があれば、その店の在庫を見たメニューを取る', async () => {
    const { calls } = stubApi((req) => {
      if (req.path === '/api/stores') return { body: [store({ id: 1 }), store({ id: 2, name: '発着場中央店', area: '発着場' })] };
      if (req.path === '/api/cart') return { body: cart({ store: { id: 2, name: '発着場中央店' } }) };
      if (req.path.startsWith('/api/menu')) return { body: [menuItem()] };
    });
    const r = await loadMenuPage({ devUser: 'alice-1' });
    expect(r.ok && r.data.selectedStore?.id).toBe(2);
    expect(calls.map((c) => c.path)).toContain('/api/menu?store_id=2');
  });

  it('店が未選択なら、在庫を見ないメニュー。カートが読めなくてもメニューは返す', async () => {
    const { calls } = stubApi((req) => {
      if (req.path === '/api/stores') return { body: [store()] };
      if (req.path === '/api/cart') return apiError(500, 'unknown');
      if (req.path.startsWith('/api/menu')) return { body: [menuItem()] };
    });
    const r = await loadMenuPage({});
    expect(r.ok && r.data.cart).toBeNull();
    expect(r.ok && r.data.selectedStore).toBeNull();
    expect(calls.map((c) => c.path)).toContain('/api/menu');
  });

  it('店の一覧・メニューが読めなければ失敗を返す', async () => {
    stubApi((req) => (req.path === '/api/stores' ? apiError(500, 'unknown') : { body: cart() }));
    expect((await loadMenuPage({})).ok).toBe(false);
  });
});

describe('カート画面・ヘッダーのまとめ取得', () => {
  it('カートと、その店（営業中か見るため）。店の一覧が読めなくてもカートは返す', async () => {
    stubApi((req) => (req.path === '/api/cart' ? { body: cart() } : apiError(500, 'unknown')));
    const r = await loadCartPage({});
    expect(r.ok && r.data.cart.lines).toHaveLength(1);
    expect(r.ok && r.data.store).toBeNull();
  });

  it('ヘッダーの点数は数量の合計。読めなければ null', async () => {
    stubApi(() => ({ body: cart({ lines: [cartLine({ qty: 2 }), cartLine({ variant_id: 13, qty: 1 })] }) }));
    expect(await loadCartCount({})).toBe(3);
    stubApi(() => apiError(500, 'unknown'));
    expect(await loadCartCount({})).toBeNull();
  });
});

describe('確認の許可証', () => {
  it('POST /api/cart/checkout-proposal の応答をそのまま返す', async () => {
    const { calls } = stubApi(() => ({ body: proposal() }));
    const r = await postCheckoutProposal({ devUser: 'alice-1' });
    expect(r.ok && r.data.total_lumi).toBe(900);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/cart/checkout-proposal' });
  });
});

// 宅配（P2）の API の呼び出し（fetch を差し替えて試す）と、カート・住所の画面のまとめ取得
import { describe, expect, it } from 'vitest';
import { deleteAddress, getAddresses, getSlots, getZones, loadAddressesPage, loadCartPage, postAddress, putCart } from './queries';
import { address, apiError, cart, cartDelivery, deliveryCart, slotList, store, stubApi, zone, type StubReply, type StubRequest } from './testing';

const NOW = Date.parse('2026-11-21T10:00:00Z'); // 店の時間帯で 11/21（土）19:00

/** カート・店・区画・住所・枠の既定の応答。over で上書きする（undefined を返すと既定） */
function api(cartBody: ReturnType<typeof cart>, over: (req: StubRequest) => StubReply = () => undefined) {
  return stubApi((req) => {
    const o = over(req);
    if (o) return o;
    if (req.path === '/api/cart') return { body: cartBody };
    if (req.path === '/api/stores') return { body: [store()] };
    if (req.path.startsWith('/api/delivery/zones')) return { body: [zone({ id: 1, name: '居住区', area_code: 1 }), zone()] };
    if (req.path === '/api/addresses') return { body: [address()] };
    if (req.path.startsWith('/api/stores/1/slots')) return { body: slotList() };
  });
}

describe('PUT /api/cart（受け取り方法の一般化）', () => {
  it('宅配は、店・住所・枠を全部送る（省略は null）', async () => {
    const { calls } = stubApi(() => ({ body: cart() }));
    await putCart({}, { storeId: 1, fulfillment: 'delivery', addressId: 3, slotId: 41 });
    await putCart({}, { storeId: 1, fulfillment: 'delivery' });
    await putCart({}, { storeId: null, fulfillment: 'delivery' });
    expect(calls.map((c) => c.body)).toEqual([
      { store_id: 1, fulfillment: 'delivery', address_id: 3, slot_id: 41 },
      { store_id: 1, fulfillment: 'delivery', address_id: null, slot_id: null },
      { store_id: null, fulfillment: 'delivery', address_id: null, slot_id: null },
    ]);
  });

  it('店頭は、住所・枠を付けない（渡されても落とす。付けると API が 422 にする）', async () => {
    const { calls } = stubApi(() => ({ body: cart() }));
    await putCart({}, { storeId: 1, fulfillment: 'pickup', addressId: 3, slotId: 41 });
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/api/cart', body: { store_id: 1, fulfillment: 'pickup' } });
    expect(Object.keys(calls[0]!.body as object)).toEqual(['store_id', 'fulfillment']);
  });
});

describe('住所・区画・時間枠の API', () => {
  it('住所: 一覧・登録（body は API の形）・削除（ID をエンコードして DELETE）', async () => {
    const { calls } = stubApi((req) => (req.method === 'DELETE' ? { status: 204 } : req.method === 'POST' ? { status: 201, body: address() } : { body: [address()] }));
    const list = await getAddresses({ devUser: 'alice-1' });
    const created = await postAddress({}, { label: '自宅', areaCode: 2, line: '住所', note: null });
    const removed = await deleteAddress({}, 3);
    await deleteAddress({}, '../staff' as unknown as number);
    expect(list.ok && list.data[0]?.label).toBe('自宅');
    expect(created.ok).toBe(true);
    expect(removed).toMatchObject({ ok: true, status: 204 });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/api/addresses'],
      ['POST', '/api/addresses'],
      ['DELETE', '/api/addresses/3'],
      ['DELETE', '/api/addresses/..%2Fstaff'],
    ]);
    expect(calls[0]?.headers['X-Dev-User']).toBe('alice-1');
    expect(calls[1]?.body).toEqual({ label: '自宅', area_code: 2, line: '住所', note: null });
  });

  it('住所の登録の失敗は、例外にせず code を返す（応答の本文を、そのままは出さない）', async () => {
    stubApi(() => apiError(422, 'too_many_addresses'));
    expect(await postAddress({}, { label: 'a', areaCode: 1, line: 'b', note: null })).toMatchObject({ ok: false, status: 422, error: { code: 'too_many_addresses' } });
  });

  it('区画: store_id があれば、その店が届ける区画だけ', async () => {
    const { calls } = stubApi(() => ({ body: [] }));
    await getZones({});
    await getZones({}, 1);
    await getZones({}, null);
    expect(calls.map((c) => c.path)).toEqual(['/api/delivery/zones', '/api/delivery/zones?store_id=1', '/api/delivery/zones']);
  });

  it('時間枠: date は必須、zone_id があれば付ける（その区画の砂嵐を反映する）', async () => {
    const { calls } = stubApi(() => ({ body: slotList() }));
    await getSlots({}, 1, '2026-11-22', 2);
    await getSlots({}, 1, '2026-11-22');
    await getSlots({}, 1, '2026-11-22', null);
    await getSlots({}, 1, '2026-11-22&zone_id=9');
    expect(calls.map((c) => c.path)).toEqual([
      '/api/stores/1/slots?date=2026-11-22&zone_id=2',
      '/api/stores/1/slots?date=2026-11-22',
      '/api/stores/1/slots?date=2026-11-22',
      '/api/stores/1/slots?date=2026-11-22%26zone_id%3D9', // 日付に別のパラメーターを混ぜさせない
    ]);
  });
});

describe('カート画面のまとめ取得（宅配）', () => {
  it('店頭のカート: 店の区画だけ読む（宅配を選べるかを見るため）。住所・枠は読まない', async () => {
    const { calls } = api(cart());
    const r = await loadCartPage({}, { now: NOW });
    expect(r.ok && r.data.zones?.map((z) => z.name)).toEqual(['居住区', '発着場']);
    expect(r.ok && r.data.delivery).toBeNull();
    const paths = calls.map((c) => c.path);
    expect(paths).toContain('/api/delivery/zones?store_id=1');
    expect(paths.some((p) => p === '/api/addresses' || p.includes('/slots'))).toBe(false);
  });

  it('店が未選択のカート: 区画も住所も枠も読まない', async () => {
    const { calls } = api(cart({ store: null }));
    const r = await loadCartPage({}, { now: NOW });
    expect(r.ok && r.data.zones).toBeNull();
    expect(r.ok && r.data.delivery).toBeNull();
    expect(calls.map((c) => c.path).sort()).toEqual(['/api/cart', '/api/stores']);
  });

  it('宅配のカート: 住所・（住所を選んでいれば）選んだ区画つきの枠を読む。日付は、選んだ枠の日が既定', async () => {
    const { calls } = api(deliveryCart());
    const r = await loadCartPage({ devUser: 'alice-1' }, { now: NOW });
    expect(r.ok && r.data.delivery).toMatchObject({ date: '2026-11-22', slotsFailed: false });
    expect(r.ok && r.data.delivery?.addresses?.[0]?.label).toBe('自宅');
    expect(r.ok && r.data.delivery?.slots?.slots).toHaveLength(1);
    expect(r.ok && r.data.delivery?.days).toHaveLength(8);
    expect(calls.map((c) => c.path)).toContain('/api/stores/1/slots?date=2026-11-22&zone_id=2');
    expect(calls.every((c) => c.headers['X-Dev-User'] === 'alice-1')).toBe(true);
  });

  it('?date= があれば、その日の枠。範囲外・不正な値は捨てる（選んだ枠の日・今日になる）', async () => {
    const own = api(deliveryCart({ delivery: cartDelivery({ slot: null }) }));
    const a = await loadCartPage({}, { date: '2026-11-24', now: NOW });
    expect(a.ok && a.data.delivery?.date).toBe('2026-11-24');
    expect(own.calls.map((c) => c.path)).toContain('/api/stores/1/slots?date=2026-11-24&zone_id=2');
    const b = await loadCartPage({}, { date: '2026-12-31', now: NOW });
    expect(b.ok && b.data.delivery?.date).toBe('2026-11-21'); // 枠を選んでいなければ今日
    const c = await loadCartPage({}, { date: '../../etc', now: NOW });
    expect(c.ok && c.data.delivery?.date).toBe('2026-11-21');
    const d = await loadCartPage({}, { date: ['2026-11-23', 'x'], now: NOW });
    expect(d.ok && d.data.delivery?.date).toBe('2026-11-23');
  });

  it('選んだ枠が選べる日の外（過去など）なら、今日にする', async () => {
    api(deliveryCart({ delivery: cartDelivery({ slot: { id: 1, starts_at: '2026-11-01T04:00:00Z', ends_at: '2026-11-01T04:30:00Z' } }) }));
    const r = await loadCartPage({}, { now: NOW });
    expect(r.ok && r.data.delivery?.date).toBe('2026-11-21');
  });

  it('住所を選んでいなければ、枠は読まない（区画が決まらない）', async () => {
    const { calls } = api(deliveryCart({ delivery: cartDelivery({ address: null, zone: null, slot: null, issues: ['address_required', 'slot_required'] }) }));
    const r = await loadCartPage({}, { now: NOW });
    expect(r.ok && r.data.delivery?.slots).toBeNull();
    expect(r.ok && r.data.delivery?.slotsFailed).toBe(false);
    expect(calls.some((c) => c.path.includes('/slots'))).toBe(false);
  });

  it('区画・住所・枠が読めなくても、カートは返す（読めなかったものは null・枠は失敗の印）', async () => {
    api(deliveryCart(), (req) => (req.path === '/api/cart' || req.path === '/api/stores' ? undefined : apiError(500, 'internal_error')));
    const r = await loadCartPage({}, { now: NOW });
    expect(r.ok && r.data.cart.lines).toHaveLength(1);
    expect(r.ok && r.data.zones).toBeNull();
    expect(r.ok && r.data.delivery).toMatchObject({ addresses: null, slots: null, slotsFailed: true });
  });

  it('カートが読めなければ失敗を返す', async () => {
    api(cart(), (req) => (req.path === '/api/cart' ? apiError(500, 'internal_error') : undefined));
    expect((await loadCartPage({}, { now: NOW })).ok).toBe(false);
  });
});

describe('住所の画面のまとめ取得', () => {
  it('住所の一覧と、エリアの選択肢（区画）', async () => {
    api(cart());
    const r = await loadAddressesPage({});
    expect(r.ok && r.data.addresses.map((a) => a.label)).toEqual(['自宅']);
    expect(r.ok && r.data.zones?.map((z) => z.area_code)).toEqual([1, 2]);
  });

  it('区画が読めなくても、一覧は返す。一覧が読めなければ失敗を返す', async () => {
    api(cart(), (req) => (req.path.startsWith('/api/delivery/zones') ? apiError(500, 'internal_error') : undefined));
    const r = await loadAddressesPage({});
    expect(r.ok && r.data.zones).toBeNull();
    expect(r.ok && r.data.addresses).toHaveLength(1);
    api(cart(), (req) => (req.path === '/api/addresses' ? apiError(500, 'internal_error') : undefined));
    expect((await loadAddressesPage({})).ok).toBe(false);
  });
});

// 宅配（P2）の Server Action の中身: 受け取り方法・店・住所・時間枠の選択（PUT /api/cart は全部を置き換える）と、住所の登録・削除
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addAddress, removeAddress, selectAddress, selectFulfillment, selectSlot, selectStore } from './actions-core';
import type { AddressInput } from './input';
import { address, apiError, cart, cartDelivery, deliveryCart, stubApi, type StubRequest } from './testing';

const puts = (calls: StubRequest[]) => calls.filter((c) => c.method === 'PUT').map((c) => c.body);

/** GET /api/cart は current を返し、PUT は reply（既定は成功）を返す */
const cartApi = (current: ReturnType<typeof cart>, put: (req: StubRequest) => ReturnType<typeof apiError> | { body: unknown } = () => ({ body: current })) =>
  stubApi((req) => (req.method === 'GET' && req.path === '/api/cart' ? { body: current } : req.method === 'PUT' ? put(req) : undefined));

describe('受け取り方法を切り替える', () => {
  it('宅配へ: 店は引き継ぎ、住所・枠は付けない（選びなおす）', async () => {
    const { calls } = cartApi(cart());
    const r = await selectFulfillment({ devUser: 'alice-1' }, 'delivery');
    expect(puts(calls)).toEqual([{ store_id: 1, fulfillment: 'delivery', address_id: null, slot_id: null }]);
    expect(r).toMatchObject({ ok: true });
    expect(r && r.ok && r.message).toContain('お届け先と時間枠を選んでください');
  });

  it('店頭へ: 住所・枠を持たない（付けると API が 422 にする）', async () => {
    const { calls } = cartApi(deliveryCart());
    await selectFulfillment({}, 'pickup');
    expect(puts(calls)).toEqual([{ store_id: 1, fulfillment: 'pickup' }]);
  });

  it('店が未選択でも、受け取り方法は切り替えられる（店は null のまま）', async () => {
    const { calls } = cartApi(cart({ store: null }));
    await selectFulfillment({}, 'delivery');
    expect(puts(calls)).toEqual([{ store_id: null, fulfillment: 'delivery', address_id: null, slot_id: null }]);
  });

  it('不正な値は API を呼ばない', async () => {
    const { calls } = stubApi(() => ({ body: cart() }));
    expect(await selectFulfillment({}, null)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

describe('お届け先の住所を選ぶ', () => {
  it('店・時間枠は今のまま、住所だけを変えて送る（全部を置き換える API なので、今の枠を写す）', async () => {
    const { calls } = cartApi(deliveryCart());
    const r = await selectAddress({}, 7);
    expect(puts(calls)).toEqual([{ store_id: 1, fulfillment: 'delivery', address_id: 7, slot_id: 41 }]);
    expect(r).toMatchObject({ ok: true, message: 'お届け先を選びました' });
  });

  it('枠をまだ選んでいなければ null。店頭のカートでも、住所を選んだら宅配にする', async () => {
    const { calls } = cartApi(cart());
    await selectAddress({}, 3);
    expect(puts(calls)).toEqual([{ store_id: 1, fulfillment: 'delivery', address_id: 3, slot_id: null }]);
  });

  it('店が未選択なら、API を書き込まずに、店を選ぶ案内（店を選びなおすリンクつき）', async () => {
    const { calls } = cartApi(cart({ store: null }));
    const r = await selectAddress({}, 3);
    expect(puts(calls)).toEqual([]);
    expect(r).toMatchObject({ ok: false, message: '先に、受け取る店を選んでください。', next: { href: '/' } });
  });

  it('店の届ける区画の外（409 out_of_zone）は固定の文。いまのカートの画面のリンクは出さない', async () => {
    cartApi(deliveryCart(), () => apiError(409, 'out_of_zone'));
    const r = await selectAddress({}, 9);
    expect(r).toMatchObject({ ok: false });
    expect(r && !r.ok && r.message).toContain('届けられません');
    expect(r && !r.ok && r.next).toBeUndefined();
  });

  it('他人の住所・無い住所（404）は、固定の文。不正な ID は API を呼ばない', async () => {
    cartApi(deliveryCart(), () => apiError(404, 'address_not_found'));
    expect(await selectAddress({}, 9)).toMatchObject({ ok: false, message: expect.stringContaining('住所が見つかりません') });
    const { calls } = stubApi(() => ({ body: cart() }));
    expect(await selectAddress({}, null)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

describe('お届けの時間枠を選ぶ', () => {
  it('店・住所は今のまま、枠だけを変えて送る', async () => {
    const { calls } = cartApi(deliveryCart());
    const r = await selectSlot({}, 55);
    expect(puts(calls)).toEqual([{ store_id: 1, fulfillment: 'delivery', address_id: 3, slot_id: 55 }]);
    expect(r).toMatchObject({ ok: true, message: 'お届けの時間枠を選びました' });
  });

  it.each([
    ['slot_full', '満枠になりました'],
    ['slot_cutoff', '受付を締め切りました'],
    ['slot_closed', 'お休みしています'],
    ['slot_not_found', '時間枠が見つかりません'],
  ])('409・404 %s は、選びなおしを促す固定の文（カートの画面にいるので、リンクは出さない）', async (code, fragment) => {
    cartApi(deliveryCart(), () => apiError(code === 'slot_not_found' ? 404 : 409, code));
    const r = await selectSlot({}, 55);
    expect(r).toMatchObject({ ok: false });
    expect(r && !r.ok && r.message).toContain(fragment);
    expect(r && !r.ok && r.next).toBeUndefined();
  });

  it('店が未選択・不正な ID は、書き込まない', async () => {
    const { calls } = cartApi(cart({ store: null }));
    expect(await selectSlot({}, 55)).toMatchObject({ ok: false });
    expect(await selectSlot({}, null)).toMatchObject({ ok: false });
    expect(puts(calls)).toEqual([]);
  });
});

describe('店を選ぶ（宅配のカート）', () => {
  it('宅配なら、受け取り方法・住所を引き継ぎ、時間枠は外す（枠は店ごと）', async () => {
    const { calls } = cartApi(deliveryCart(), () => ({ body: cart({ store: { id: 2, name: '発着場中央店' } }) }));
    const r = await selectStore({}, 2);
    expect(puts(calls)).toEqual([{ store_id: 2, fulfillment: 'delivery', address_id: 3, slot_id: null }]);
    expect(r).toEqual({ ok: true, message: '受け取る店を「発着場中央店」にしました' });
  });

  it('店頭なら、これまでどおり店と店頭だけを送る', async () => {
    const { calls } = cartApi(cart());
    await selectStore({}, 2);
    expect(puts(calls)).toEqual([{ store_id: 2, fulfillment: 'pickup' }]);
  });

  it('選んでいた住所が新しい店の届ける区画の外（409 out_of_zone）なら、住所を外して店を変え、そのことを知らせる', async () => {
    let n = 0;
    const { calls } = cartApi(deliveryCart(), () => (n++ === 0 ? apiError(409, 'out_of_zone') : { body: cart({ store: { id: 4, name: '遺跡テラス店' } }) }));
    const r = await selectStore({}, 4);
    expect(puts(calls)).toEqual([
      { store_id: 4, fulfillment: 'delivery', address_id: 3, slot_id: null },
      { store_id: 4, fulfillment: 'delivery', address_id: null, slot_id: null },
    ]);
    expect(r).toMatchObject({ ok: true });
    expect(r && r.ok && r.message).toBe('受け取る店を「遺跡テラス店」にしました。選んでいたお届け先は、この店では届けられないため外しました。');
  });

  it('選んだ住所が無ければ、out_of_zone でもやり直さず、その失敗を返す', async () => {
    const { calls } = cartApi(deliveryCart({ delivery: cartDelivery({ address: null }) }), () => apiError(409, 'out_of_zone'));
    const r = await selectStore({}, 4);
    expect(puts(calls)).toHaveLength(1);
    expect(r).toMatchObject({ ok: false });
  });

  it('住所を選んでいても、out_of_zone 以外の失敗（店が無いなど）はやり直さない', async () => {
    const { calls } = cartApi(deliveryCart(), () => apiError(404, 'store_not_found'));
    const r = await selectStore({}, 4);
    expect(puts(calls)).toHaveLength(1);
    expect(r).toMatchObject({ ok: false });
  });
});

describe('住所の登録・削除（個人情報）', () => {
  const input: AddressInput = { label: '自宅', areaCode: 2, line: 'アルカ市発着場2-1-5 305', note: '呼び鈴は 1 回' };

  afterEach(() => vi.restoreAllMocks());

  it('登録: API の形（area_code・note）で送り、結果は固定の文だけ（住所を返さない）', async () => {
    const { calls } = stubApi(() => ({ status: 201, body: address() }));
    const r = await addAddress({ devUser: 'alice-1' }, input);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/addresses', body: { label: '自宅', area_code: 2, line: 'アルカ市発着場2-1-5 305', note: '呼び鈴は 1 回' } });
    expect(calls[0]?.headers['X-Dev-User']).toBe('alice-1');
    expect(r).toEqual({ ok: true, message: '住所を登録しました' });
    expect(JSON.stringify(r)).not.toContain('発着場2-1-5');
  });

  it('入力が不正（null）なら、API を呼ばず、入力の範囲を固定の文で示す', async () => {
    const { calls } = stubApi(() => ({ status: 201, body: address() }));
    const r = await addAddress({}, null);
    expect(calls).toHaveLength(0);
    expect(r).toMatchObject({ ok: false });
    expect(r && !r.ok && r.message).toContain('ラベルは 1〜20 文字');
  });

  it.each([
    ['invalid_area', 422, 'エリアの指定が正しくありません'],
    ['too_many_addresses', 422, '10 件まで'],
  ])('%s は固定の文。住所の本文・API の message を含めない', async (code, status, fragment) => {
    stubApi(() => apiError(status, code, { message: 'SECRET アルカ市発着場2-1-5' }));
    const r = await addAddress({}, input);
    expect(r).toMatchObject({ ok: false });
    expect(r && !r.ok && r.message).toContain(fragment);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|発着場2-1-5|呼び鈴/);
  });

  it('登録の失敗・接続の失敗でも、住所をログ・コンソールに出さない', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    stubApi(() => {
      throw new Error(`connect ECONNREFUSED body=${input.line}`);
    });
    const r = await addAddress({}, input);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain('発着場2-1-5');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('削除: DELETE /api/addresses/{id}（204）。他人の住所（404）・不正な ID は固定の文・API を呼ばない', async () => {
    const { calls } = stubApi(() => ({ status: 204 }));
    expect(await removeAddress({}, 3)).toEqual({ ok: true, message: '住所を削除しました' });
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/api/addresses/3' });
    stubApi(() => apiError(404, 'address_not_found'));
    const r = await removeAddress({}, 99);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('住所が見つかりません') });
    expect(r && !r.ok && r.next).toBeUndefined();
    const second = stubApi(() => ({ status: 204 }));
    expect(await removeAddress({}, null)).toMatchObject({ ok: false });
    expect(second.calls).toHaveLength(0);
  });
});

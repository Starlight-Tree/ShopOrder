import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDispatchBoard, loadZones } from './dispatch-loaders';
import { courier, dispatchOrder, zone } from './dispatch-fixtures';
import { jsonResponse } from './test-fixtures';

type FetchCall = { url: string; init: RequestInit };

/** global fetch を差し替える。呼び出しを記録して、応答を順に返す */
function stubFetch(...responses: (Response | Error)[]) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('応答が足りない');
      return next;
    }),
  );
  return calls;
}

const headerOf = (call: FetchCall, name: string) => (call.init.headers as Record<string, string>)[name];

afterEach(() => vi.unstubAllGlobals());

describe('loadDispatchBoard', () => {
  const board = (over: Record<string, unknown> = {}) => ({ provider: 'mock', couriers: [courier()], orders: [dispatchOrder()], ...over });

  it('GET /api/staff/deliveries。状態 5 つを status に渡し、Bearer でトークンを付ける。fetch は no-store', async () => {
    const calls = stubFetch(jsonResponse(200, board()));
    const res = await loadDispatchBoard('tok-1', { storeId: null });
    expect(res).toEqual({ state: 'ok', data: board() });
    expect(calls[0]!.url).toMatch(/\/api\/staff\/deliveries\?status=ready,assigned,picked_up,delivering,delivery_failed$/);
    expect(headerOf(calls[0]!, 'Authorization')).toBe('Bearer tok-1');
    expect(calls[0]!.init.cache).toBe('no-store');
  });

  it('店長が店を選んだら store_id を付ける', async () => {
    const calls = stubFetch(jsonResponse(200, board()));
    await loadDispatchBoard('t', { storeId: 3 });
    expect(calls[0]!.url).toMatch(/status=ready,assigned,picked_up,delivering,delivery_failed&store_id=3$/);
  });

  it('注文は、API の順（枠の開始が早い順）のまま返す', async () => {
    stubFetch(jsonResponse(200, board({ orders: [dispatchOrder({ public_id: 'BBBB0002' }), dispatchOrder({ public_id: 'AAAA0001' })] })));
    const res = await loadDispatchBoard('t', { storeId: null });
    expect(res.state === 'ok' && res.data.orders.map((o) => o.public_id)).toEqual(['BBBB0002', 'AAAA0001']);
  });

  it('配達の提供者は mock のときだけ mock。それ以外・欠けているときは inhouse（模擬のボタンを出さない側に倒す）', async () => {
    stubFetch(jsonResponse(200, board({ provider: 'inhouse' })), jsonResponse(200, board({ provider: 'whatever' })), jsonResponse(200, board({ provider: undefined })));
    for (let i = 0; i < 3; i++) {
      const res = await loadDispatchBoard('t', { storeId: null });
      expect(res.state === 'ok' && res.data.provider).toBe('inhouse');
    }
  });

  it('宅配の情報が読めない注文・形の違う配達員は捨てる（1 件の不良で、ボード全体を止めない）', async () => {
    const noDelivery = { ...dispatchOrder({ public_id: 'NODELIV1' }), delivery: null };
    const noActions = { ...dispatchOrder({ public_id: 'NOACTION' }), allowed_actions: undefined };
    stubFetch(jsonResponse(200, board({ orders: [dispatchOrder({ public_id: 'GOOD0001' }), noDelivery, noActions, 'x', null], couriers: [courier({ id: 7 }), { id: 'x' }, null] })));
    const res = await loadDispatchBoard('t', { storeId: null });
    expect(res.state).toBe('ok');
    if (res.state === 'ok') {
      expect(res.data.orders.map((o) => o.public_id)).toEqual(['GOOD0001']);
      expect(res.data.couriers.map((c) => c.id)).toEqual([7]);
    }
  });

  it('描けない行は捨てる: 区画が無い配達・品目が null・店名が無い・乗り物が無い配達員（描画で例外になるため）', async () => {
    const base = dispatchOrder({ public_id: 'BASE0001' });
    const noZone = { ...base, public_id: 'NOZONE01', delivery: { ...base.delivery, zone: undefined } };
    const nullItem = { ...base, public_id: 'NULLITEM', items: [null] };
    const noStoreName = { ...base, public_id: 'NOSTORE1', store: { id: 1 } };
    const noEnd = { ...base, public_id: 'NOENDAT1', delivery: { ...base.delivery, slot: { id: 41, starts_at: base.delivery.slot.starts_at } } };
    const noVehicle = { ...courier({ id: 8 }), vehicle: undefined };
    stubFetch(jsonResponse(200, board({ orders: [base, noZone, nullItem, noStoreName, noEnd], couriers: [courier({ id: 7 }), noVehicle] })));
    const res = await loadDispatchBoard('t', { storeId: null });
    expect(res.state === 'ok' && res.data.orders.map((o) => o.public_id)).toEqual(['BASE0001']);
    expect(res.state === 'ok' && res.data.couriers.map((c) => c.id)).toEqual([7]);
  });

  it('返す値は、画面が使う項目だけ。API が住所・暗証コード・電話・氏名などを誤って返しても、ブラウザーへ渡る props に残らない', async () => {
    const leaky = {
      ...dispatchOrder({ public_id: 'LEAKY001' }),
      address: { label: '自宅', line: '岩山区 7-3-1 ヘリオス荘 204' },
      pin: '4821',
      phone: '090-0000-0000',
      customer_name: 'ザーハード・ルミ',
      events: [{ to_status: 'ready', note: '内部メモ' }],
      delivery: { ...dispatchOrder().delivery, address: { line: '岩山区 7-3-1' }, pin: '4821', courier: { id: 7, name: 'ラシード', phone: '080-1111-2222' } },
      items: [{ name: 'オアシスブレンド', size: 'M', temperature: 'hot', qty: 2, unit_price_lumi: 450, memo: 'メモ' }],
      suggestion: { courier_id: 7, courier_name: 'ラシード', minutes: 0, phone: '080-1111-2222' },
    };
    stubFetch(jsonResponse(200, board({ orders: [leaky], couriers: [{ ...courier(), phone: '080-1111-2222', home_address: '遺跡区 1-1' }] })));
    const res = await loadDispatchBoard('t', { storeId: null });
    expect(res.state).toBe('ok');
    const json = JSON.stringify(res.state === 'ok' ? res.data : null);
    for (const secret of ['岩山区', '4821', '090-0000', 'ザーハード・ルミ', '内部メモ', '080-1111', '遺跡区', 'unit_price_lumi', 'メモ']) expect(json).not.toContain(secret);
    // 必要な項目は残る
    if (res.state === 'ok') {
      expect(res.data.orders[0]).toEqual(dispatchOrder({ public_id: 'LEAKY001', delivery: { courier: { id: 7, name: 'ラシード' } } }));
      expect(res.data.couriers[0]).toEqual(courier());
    }
  });

  it('応答の形が違う（orders・couriers が配列でない・オブジェクトでない）なら error（接続の不調ではない）', async () => {
    stubFetch(jsonResponse(200, { provider: 'mock' }), jsonResponse(200, []), jsonResponse(200, null), jsonResponse(200, board({ orders: 'x' })));
    for (let i = 0; i < 4; i++) expect(await loadDispatchBoard('t', { storeId: null })).toEqual({ state: 'error', unreachable: false });
  });

  it('401 → unauthorized、403 → forbidden、5xx・接続不可 → error（unreachable で区別）', async () => {
    stubFetch(jsonResponse(401, { detail: { code: 'unauthorized', message: '認証が必要です' } }));
    expect(await loadDispatchBoard('t', { storeId: null })).toEqual({ state: 'unauthorized' });
    stubFetch(jsonResponse(403, { detail: { code: 'forbidden', message: '権限がありません' } }));
    expect(await loadDispatchBoard('t', { storeId: null })).toEqual({ state: 'forbidden' });
    stubFetch(jsonResponse(500, { detail: 'boom' }));
    expect(await loadDispatchBoard('t', { storeId: null })).toEqual({ state: 'error', unreachable: false });
    stubFetch(new Error('connect ECONNREFUSED 10.0.0.5:8000'));
    expect(await loadDispatchBoard('t', { storeId: null })).toEqual({ state: 'error', unreachable: true });
  });
});

describe('loadZones（認証なし）', () => {
  it('GET /api/delivery/zones。店を選んでいれば store_id を付ける。トークンは送らない', async () => {
    const calls = stubFetch(jsonResponse(200, [zone()]), jsonResponse(200, [zone()]));
    expect(await loadZones({ storeId: null })).toEqual([zone()]);
    expect(await loadZones({ storeId: 2 })).toEqual([zone()]);
    expect(calls[0]!.url).toMatch(/\/api\/delivery\/zones$/);
    expect(calls[1]!.url).toMatch(/\/api\/delivery\/zones\?store_id=2$/);
    expect(headerOf(calls[0]!, 'Authorization')).toBeUndefined();
  });

  it('無料の条件が無い区画（free_over_lumi: null）も読める。形の違う区画は捨てる', async () => {
    stubFetch(jsonResponse(200, [zone({ free_over_lumi: null }), { id: 1 }, null, zone({ id: 3, is_suspended: true })]));
    const zones = await loadZones({ storeId: null });
    expect(zones?.map((z) => [z.id, z.is_suspended])).toEqual([[2, false], [3, true]]);
  });

  it('読めなければ null（ボードは止めない）', async () => {
    stubFetch(jsonResponse(500, {}), jsonResponse(200, { zones: [] }), new Error('ECONNREFUSED'));
    expect(await loadZones({ storeId: null })).toBeNull();
    expect(await loadZones({ storeId: null })).toBeNull();
    expect(await loadZones({ storeId: null })).toBeNull();
  });
});

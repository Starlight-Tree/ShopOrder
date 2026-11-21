import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMe, loadOrders, loadStock, loadStores, resolveSession } from './loaders';
import { jsonResponse, order, staffUser, stockRow } from './test-fixtures';

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

describe('loadOrders', () => {
  it('状態 4 つを status に渡し、Bearer でトークンを付ける。fetch は no-store', async () => {
    const calls = stubFetch(jsonResponse(200, [order()]));
    const res = await loadOrders('tok-1', { storeId: null });
    expect(res).toEqual({ state: 'ok', data: [order()] });
    expect(calls[0]!.url).toMatch(/\/api\/staff\/orders\?status=paid,accepted,preparing,ready$/);
    expect(headerOf(calls[0]!, 'Authorization')).toBe('Bearer tok-1');
    expect(calls[0]!.init.cache).toBe('no-store');
  });

  it('店長が店を選んだら store_id を付ける', async () => {
    const calls = stubFetch(jsonResponse(200, []));
    await loadOrders('t', { storeId: 3 });
    expect(calls[0]!.url).toMatch(/status=paid,accepted,preparing,ready&store_id=3$/);
  });

  it('401 → unauthorized、403 → forbidden、5xx・接続不可 → error（unreachable で区別）', async () => {
    stubFetch(jsonResponse(401, { detail: { code: 'unauthorized', message: '認証が必要です' } }));
    expect(await loadOrders('t', { storeId: null })).toEqual({ state: 'unauthorized' });
    stubFetch(jsonResponse(403, { detail: { code: 'forbidden', message: '権限がありません' } }));
    expect(await loadOrders('t', { storeId: null })).toEqual({ state: 'forbidden' });
    stubFetch(jsonResponse(500, { detail: 'boom' }));
    expect(await loadOrders('t', { storeId: null })).toEqual({ state: 'error', unreachable: false });
    stubFetch(new Error('connect ECONNREFUSED 10.0.0.5:8000'));
    expect(await loadOrders('t', { storeId: null })).toEqual({ state: 'error', unreachable: true });
  });
});

describe('loadStock / loadStores / loadMe', () => {
  it('在庫: store_id は店長が選んだときだけ', async () => {
    const calls = stubFetch(jsonResponse(200, [stockRow()]), jsonResponse(200, []));
    await loadStock('t', { storeId: null });
    await loadStock('t', { storeId: 2 });
    expect(calls[0]!.url).toMatch(/\/api\/staff\/stock$/);
    expect(calls[1]!.url).toMatch(/\/api\/staff\/stock\?store_id=2$/);
  });

  it('店の一覧は認証なし。読めなければ null', async () => {
    const calls = stubFetch(jsonResponse(200, [{ id: 1, name: '居住区本店' }]), jsonResponse(500, {}));
    expect(await loadStores()).toEqual([{ id: 1, name: '居住区本店' }]);
    expect(headerOf(calls[0]!, 'Authorization')).toBeUndefined();
    expect(await loadStores()).toBeNull();
  });

  it('GET /api/staff/me', async () => {
    const calls = stubFetch(jsonResponse(200, staffUser()));
    expect(await loadMe('tok')).toEqual({ state: 'ok', data: staffUser() });
    expect(calls[0]!.url).toMatch(/\/api\/staff\/me$/);
  });
});

describe('resolveSession（認証の門の判断）', () => {
  it('Cookie が無ければ anonymous（API を呼ばない）', async () => {
    const calls = stubFetch();
    expect(await resolveSession(null)).toEqual({ kind: 'anonymous' });
    expect(await resolveSession('')).toEqual({ kind: 'anonymous' });
    expect(calls).toHaveLength(0);
  });

  it('200 → ok（トークンとスタッフ）', async () => {
    stubFetch(jsonResponse(200, staffUser({ role: 'manager', store_id: null })));
    expect(await resolveSession('tok')).toEqual({ kind: 'ok', token: 'tok', staff: staffUser({ role: 'manager', store_id: null }) });
  });

  it('401 → expired（Cookie を消してログインへ）', async () => {
    stubFetch(jsonResponse(401, { detail: { code: 'unauthorized', message: '認証が必要です' } }));
    expect(await resolveSession('tok')).toEqual({ kind: 'expired' });
  });

  it('接続できない・5xx → unavailable（Cookie は消さない。API の不調でログアウトさせない）', async () => {
    stubFetch(new Error('ECONNREFUSED'));
    expect(await resolveSession('tok')).toEqual({ kind: 'unavailable' });
    stubFetch(jsonResponse(503, {}));
    expect(await resolveSession('tok')).toEqual({ kind: 'unavailable' });
  });
});

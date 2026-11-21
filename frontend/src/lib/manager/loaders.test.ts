import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../staff/test-fixtures';
import { loadCustomers, loadHourly, loadOverview, loadProducts, loadSales, loadStock } from './loaders';
import { overview } from './test-fixtures';

type FetchCall = { url: string; init: RequestInit };

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
const header = (c: FetchCall, name: string) => (c.init.headers as Record<string, string>)[name];

afterEach(() => vi.unstubAllGlobals());

describe('分析の取得', () => {
  it('概況: トークンを Bearer で付け、store_id は選んだときだけ。fetch は no-store', async () => {
    const calls = stubFetch(jsonResponse(200, overview()), jsonResponse(200, overview()));
    expect(await loadOverview('tok-1', { storeId: null })).toEqual({ state: 'ok', data: overview() });
    await loadOverview('tok-1', { storeId: 3 });
    expect(calls[0]!.url).toMatch(/\/api\/analytics\/overview$/);
    expect(calls[1]!.url).toMatch(/\/api\/analytics\/overview\?store_id=3$/);
    expect(header(calls[0]!, 'Authorization')).toBe('Bearer tok-1');
    expect(calls[0]!.init.cache).toBe('no-store');
  });
  it('売上・商品・時間帯・在庫・顧客のパスと条件', async () => {
    const calls = stubFetch(...Array.from({ length: 5 }, () => jsonResponse(200, {})), jsonResponse(200, {}));
    await loadSales('t', { storeId: 2, grain: 'week', count: 12 });
    await loadProducts('t', { storeId: null, days: 28 });
    await loadHourly('t', { storeId: 4, days: 56 });
    await loadStock('t', { storeId: null });
    await loadCustomers('t');
    expect(calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ''))).toEqual([
      '/api/analytics/sales?grain=week&count=12&store_id=2',
      '/api/analytics/products?days=28',
      '/api/analytics/hourly?days=56&store_id=4',
      '/api/analytics/stock',
      '/api/analytics/customers',
    ]);
  });
  it('401 → unauthorized、403 → forbidden、5xx・接続不可 → error（unreachable で区別）', async () => {
    stubFetch(jsonResponse(401, { detail: { code: 'unauthorized', message: '認証が必要です。' } }));
    expect(await loadCustomers('t')).toEqual({ state: 'unauthorized' });
    stubFetch(jsonResponse(403, { detail: { code: 'forbidden', message: 'この操作はできません。' } }));
    expect(await loadCustomers('t')).toEqual({ state: 'forbidden' });
    stubFetch(jsonResponse(500, { detail: 'boom' }));
    expect(await loadStock('t', { storeId: null })).toEqual({ state: 'error', unreachable: false });
    stubFetch(new Error('connect ECONNREFUSED 10.0.0.5:8000'));
    expect(await loadStock('t', { storeId: null })).toEqual({ state: 'error', unreachable: true });
  });
});

import { describe, expect, it } from 'vitest';
import { delivery } from './courier-test-fixtures';
import { loadCourierDeliveries } from './courier-loaders';
import type { StaffApi } from './loaders';

type Result = { ok: true; status: number; data: unknown } | { ok: false; status: number; error: { code: string; message: string } };

function fakeApi(result: Result) {
  const calls: Array<{ path: string; opts: Parameters<StaffApi>[1] }> = [];
  const api = (async (path: string, opts: Parameters<StaffApi>[1]) => {
    calls.push({ path, opts });
    return result;
  }) as unknown as StaffApi;
  return { api, calls };
}
const ng = (status: number): Result => ({ ok: false, status, error: { code: 'x', message: '固定の文' } });

describe('loadCourierDeliveries', () => {
  it('GET /api/courier/deliveries に Bearer のトークンを付け、そのまま返す（並びは API の順）', async () => {
    const list = [delivery({ public_id: 'A0000001' }), delivery({ public_id: 'A0000002', pickup_no: 13 })];
    const { api, calls } = fakeApi({ ok: true, status: 200, data: list });
    expect(await loadCourierDeliveries('tok-1', api)).toEqual({ state: 'ok', data: list });
    expect(calls).toEqual([{ path: '/api/courier/deliveries', opts: { staffToken: 'tok-1' } }]);
  });

  it('担当が無ければ、空の配列（空の状態を出せる）', async () => {
    expect(await loadCourierDeliveries('t', fakeApi({ ok: true, status: 200, data: [] }).api)).toEqual({ state: 'ok', data: [] });
  });

  it('401 → unauthorized、403 → forbidden', async () => {
    expect(await loadCourierDeliveries('t', fakeApi(ng(401)).api)).toEqual({ state: 'unauthorized' });
    expect(await loadCourierDeliveries('t', fakeApi(ng(403)).api)).toEqual({ state: 'forbidden' });
  });

  it('5xx・接続不可 → error（unreachable で区別）', async () => {
    expect(await loadCourierDeliveries('t', fakeApi(ng(500)).api)).toEqual({ state: 'error', unreachable: false });
    expect(await loadCourierDeliveries('t', fakeApi(ng(0)).api)).toEqual({ state: 'error', unreachable: true });
  });

  it('200 でも、配列でなければ error（画面は読み込めなかったと出す）', async () => {
    expect(await loadCourierDeliveries('t', fakeApi({ ok: true, status: 200, data: { detail: 'x' } }).api)).toEqual({ state: 'error', unreachable: false });
    expect(await loadCourierDeliveries('t', fakeApi({ ok: true, status: 200, data: null }).api)).toEqual({ state: 'error', unreachable: false });
  });
});

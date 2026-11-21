import { describe, expect, it } from 'vitest';
import { performAssign, performDispatchCancel, performMockAdvance, performRedeliver, performSuspension } from './dispatch-commands';
import { DISPATCH_MSG } from './dispatch-messages';
import type { StaffApi } from './loaders';
import { MSG } from './messages';

type Call = { path: string; opts: Parameters<StaffApi>[1] };

/** apiRequest の代わり。呼び出しを記録し、応答を順に返す */
function fakeApi(...results: Array<{ ok: true; status: number; data: unknown } | { ok: false; status: number; error: { code: string; message: string } }>) {
  const calls: Call[] = [];
  const queue = [...results];
  const api = (async (path: string, opts: Parameters<StaffApi>[1]) => {
    calls.push({ path, opts });
    const r = queue.shift();
    if (!r) throw new Error('応答が足りない');
    return r;
  }) as unknown as StaffApi;
  return { api, calls };
}
const ok = (data: unknown, status = 200) => ({ ok: true as const, status, data });
const ng = (status: number, code = 'x', message = '固定の文') => ({ ok: false as const, status, error: { code, message } });

const LEAK = 'psycopg.errors.X at /app/app/dispatch.py:88';
const BAD_IDS = ['../stock', 'K7M2Q9XD/assign?x=1', '', 'AB', 'あいうえお', 123, null, undefined];

describe('performAssign（割り当て・付け替え）', () => {
  it('POST /api/staff/orders/{id}/assign {courier_id}。トークンを付け、配達員の名前つきの文を返す', async () => {
    const { api, calls } = fakeApi(ok({ pickup_no: 12, delivery: { courier: { id: 7, name: 'ラシード' } } }));
    const r = await performAssign('tok', { publicId: 'K7M2Q9XD', courierId: 7 }, api);
    expect(r).toEqual({ ok: true, message: '受け取り番号 12 をラシードに割り当てました' });
    expect(calls).toEqual([{ path: '/api/staff/orders/K7M2Q9XD/assign', opts: { method: 'POST', body: { courier_id: 7 }, staffToken: 'tok' } }]);
  });

  it('クライアントから来る値を信用しない: 注文 ID・配達員 ID の形が違えば、API を呼ばない', async () => {
    const { api, calls } = fakeApi();
    for (const publicId of BAD_IDS) expect(await performAssign('tok', { publicId: publicId as never, courierId: 7 }, api)).toEqual({ ok: false, kind: 'invalid', message: MSG.invalidInput, refresh: false });
    for (const courierId of [0, -1, 1.5, NaN, Infinity, 3_000_000_000, '7', null, undefined, {}]) {
      expect(await performAssign('tok', { publicId: 'K7M2Q9XD', courierId: courierId as never }, api)).toMatchObject({ ok: false, kind: 'invalid', refresh: false });
    }
    expect(await performAssign('tok', null as never, api)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(calls).toHaveLength(0);
  });

  it('勤務外・配達員が無い・他の人が先に操作した: 画面を取り直す（refresh）', async () => {
    expect(await performAssign('tok', { publicId: 'K7M2Q9XD', courierId: 7 }, fakeApi(ng(409, 'courier_off_duty', LEAK)).api)).toEqual({
      ok: false,
      kind: 'conflict',
      message: DISPATCH_MSG.courierOffDuty,
      refresh: true,
    });
    expect(await performAssign('tok', { publicId: 'K7M2Q9XD', courierId: 7 }, fakeApi(ng(404, 'courier_not_found')).api)).toMatchObject({ kind: 'not_found', refresh: true });
    expect(await performAssign('tok', { publicId: 'K7M2Q9XD', courierId: 7 }, fakeApi(ng(409, 'invalid_transition')).api)).toMatchObject({ kind: 'conflict', message: MSG.conflict, refresh: true });
  });

  it('401 は unauthorized（action が Cookie を消す）。5xx・接続不可は固定の文（サーバーの文面を出さない）', async () => {
    expect(await performAssign('tok', { publicId: 'K7M2Q9XD', courierId: 7 }, fakeApi(ng(401)).api)).toMatchObject({ ok: false, kind: 'unauthorized', refresh: false });
    expect(await performAssign('tok', { publicId: 'K7M2Q9XD', courierId: 7 }, fakeApi(ng(500, 'x', LEAK)).api)).toEqual({ ok: false, kind: 'error', message: MSG.generic, refresh: false });
    expect(await performAssign('tok', { publicId: 'K7M2Q9XD', courierId: 7 }, fakeApi(ng(0, 'unreachable', LEAK)).api)).toEqual({ ok: false, kind: 'unreachable', message: MSG.unreachable, refresh: false });
  });
});

describe('performRedeliver（再配達）', () => {
  it('POST .../redeliver。枠は送らない（API が最も早い枠を選ぶ）', async () => {
    const { api, calls } = fakeApi(ok({ pickup_no: 12 }));
    const r = await performRedeliver('tok', { publicId: 'K7M2Q9XD' }, api);
    expect(r).toEqual({ ok: true, message: '受け取り番号 12 を再配達にしました（選べる中で最も早い枠）' });
    expect(calls).toEqual([{ path: '/api/staff/orders/K7M2Q9XD/redeliver', opts: { method: 'POST', staffToken: 'tok' } }]);
    expect(calls[0]!.opts).not.toHaveProperty('body');
  });

  it('枠が無い（no_slot_available）・砂嵐（zone_suspended）は、固定の文で示す', async () => {
    expect(await performRedeliver('tok', { publicId: 'K7M2Q9XD' }, fakeApi(ng(409, 'no_slot_available', LEAK)).api)).toEqual({ ok: false, kind: 'invalid', message: DISPATCH_MSG.noSlot, refresh: false });
    expect(await performRedeliver('tok', { publicId: 'K7M2Q9XD' }, fakeApi(ng(409, 'zone_suspended', LEAK)).api)).toEqual({ ok: false, kind: 'invalid', message: DISPATCH_MSG.zoneSuspended, refresh: true });
  });

  it('他の人が先に操作した（409 invalid_transition）は取り直す。注文 ID の形が違えば API を呼ばない', async () => {
    expect(await performRedeliver('tok', { publicId: 'K7M2Q9XD' }, fakeApi(ng(409, 'invalid_transition')).api)).toMatchObject({ kind: 'conflict', refresh: true });
    const { api, calls } = fakeApi();
    for (const publicId of BAD_IDS) expect(await performRedeliver('tok', { publicId: publicId as never }, api)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(calls).toHaveLength(0);
  });
});

describe('performMockAdvance（模擬で 1 つ進める）', () => {
  it('POST .../mock-advance', async () => {
    const { api, calls } = fakeApi(ok({ pickup_no: 12 }));
    expect(await performMockAdvance('tok', { publicId: 'K7M2Q9XD' }, api)).toEqual({ ok: true, message: '受け取り番号 12 を模擬で 1 つ進めました' });
    expect(calls).toEqual([{ path: '/api/staff/orders/K7M2Q9XD/mock-advance', opts: { method: 'POST', staffToken: 'tok' } }]);
  });

  it('mock 以外（409 mock_only）は取り直す。提案できる配達員がいない（no_courier_available）は、手動の割り当てを促す', async () => {
    expect(await performMockAdvance('tok', { publicId: 'K7M2Q9XD' }, fakeApi(ng(409, 'mock_only')).api)).toEqual({ ok: false, kind: 'invalid', message: DISPATCH_MSG.mockOnly, refresh: true });
    expect(await performMockAdvance('tok', { publicId: 'K7M2Q9XD' }, fakeApi(ng(409, 'no_courier_available')).api)).toEqual({
      ok: false,
      kind: 'invalid',
      message: DISPATCH_MSG.noCourierAvailable,
      refresh: false,
    });
  });

  it('注文 ID の形が違えば API を呼ばない', async () => {
    const { api, calls } = fakeApi();
    for (const publicId of BAD_IDS) expect(await performMockAdvance('tok', { publicId: publicId as never }, api)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

describe('performSuspension（砂嵐の警報。店長だけ）', () => {
  it('立てる: PUT /api/staff/zones/{id}/suspension {suspended: true}', async () => {
    const { api, calls } = fakeApi(ok({ id: 2, name: '発着場', is_suspended: true }));
    const r = await performSuspension('tok', { zoneId: 2, suspended: true }, api);
    expect(r).toEqual({ ok: true, message: '発着場の砂嵐の警報を立てました。この区画の宅配は、受け付けません' });
    expect(calls).toEqual([{ path: '/api/staff/zones/2/suspension', opts: { method: 'PUT', body: { suspended: true }, staffToken: 'tok' } }]);
  });

  it('解除する: suspended: false', async () => {
    const { api, calls } = fakeApi(ok({ id: 2, name: '発着場', is_suspended: false }));
    const r = await performSuspension('tok', { zoneId: 2, suspended: false }, api);
    expect(r).toEqual({ ok: true, message: '発着場の砂嵐の警報を解除しました' });
    expect(calls[0]!.opts).toMatchObject({ body: { suspended: false } });
  });

  it('クライアントから来る値を信用しない: 区画 ID が整数でない・suspended が真偽値でなければ、API を呼ばない', async () => {
    const { api, calls } = fakeApi();
    for (const zoneId of [0, -2, 2.5, '2', '2/../1', null, undefined, 3_000_000_000]) {
      expect(await performSuspension('tok', { zoneId: zoneId as never, suspended: true }, api)).toMatchObject({ ok: false, kind: 'invalid' });
    }
    for (const suspended of ['true', 1, 0, null, undefined]) {
      expect(await performSuspension('tok', { zoneId: 2, suspended: suspended as never }, api)).toMatchObject({ ok: false, kind: 'invalid' });
    }
    expect(calls).toHaveLength(0);
  });

  it('店長以外（403）は forbidden（画面の絞りを権限の根拠にしない。API が決める）。区画が無ければ取り直す', async () => {
    expect(await performSuspension('tok', { zoneId: 2, suspended: true }, fakeApi(ng(403, 'forbidden', LEAK)).api)).toEqual({ ok: false, kind: 'forbidden', message: MSG.forbidden, refresh: false });
    expect(await performSuspension('tok', { zoneId: 9, suspended: true }, fakeApi(ng(404, 'zone_not_found')).api)).toEqual({ ok: false, kind: 'not_found', message: DISPATCH_MSG.zoneNotFound, refresh: true });
    // 区画の操作の 404 は、「注文」ではなく「区画」が見つからない
    expect(await performSuspension('tok', { zoneId: 9, suspended: true }, fakeApi(ng(404, 'not_found')).api)).toMatchObject({ kind: 'not_found', message: DISPATCH_MSG.zoneNotFound });
  });
});

describe('performDispatchCancel（取消し。既存の transition の cancel）', () => {
  it('POST .../transition {action: cancel, reason}。理由の前後の空白は削る', async () => {
    const { api, calls } = fakeApi(ok({}));
    expect(await performDispatchCancel('tok', { publicId: 'K7M2Q9XD', reason: '  住所が届けられない  ' }, api)).toEqual({ ok: true, message: DISPATCH_MSG.cancelDone });
    expect(calls).toEqual([{ path: '/api/staff/orders/K7M2Q9XD/transition', opts: { method: 'POST', body: { action: 'cancel', reason: '住所が届けられない' }, staffToken: 'tok' } }]);
  });

  it('理由が必須（空・空白だけ・101 文字以上は、API を呼ばない）', async () => {
    const { api, calls } = fakeApi();
    for (const reason of [undefined, '', '   ', 'あ'.repeat(101)]) {
      expect(await performDispatchCancel('tok', { publicId: 'K7M2Q9XD', reason }, api)).toEqual({ ok: false, kind: 'invalid', message: MSG.cancelReasonRequired, refresh: false });
    }
    expect(calls).toHaveLength(0);
  });

  it('注文 ID の形が違えば、API を呼ばない', async () => {
    const { api, calls } = fakeApi();
    for (const publicId of BAD_IDS) expect(await performDispatchCancel('tok', { publicId: publicId as never, reason: '理由' }, api)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await performDispatchCancel('tok', null as never, api)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it('他の人が先に操作した（409）・注文が無い（404）は取り直す。401 は取り直さない', async () => {
    expect(await performDispatchCancel('tok', { publicId: 'K7M2Q9XD', reason: 'x' }, fakeApi(ng(409, 'invalid_transition')).api)).toEqual({ ok: false, kind: 'conflict', message: MSG.conflict, refresh: true });
    expect(await performDispatchCancel('tok', { publicId: 'K7M2Q9XD', reason: 'x' }, fakeApi(ng(404, 'not_found')).api)).toMatchObject({ kind: 'not_found', refresh: true });
    expect(await performDispatchCancel('tok', { publicId: 'K7M2Q9XD', reason: 'x' }, fakeApi(ng(401)).api)).toMatchObject({ kind: 'unauthorized', refresh: false });
    expect(await performDispatchCancel('tok', { publicId: 'K7M2Q9XD', reason: 'x' }, fakeApi(ng(500, 'x', LEAK)).api)).toEqual({ ok: false, kind: 'error', message: MSG.generic, refresh: false });
  });
});

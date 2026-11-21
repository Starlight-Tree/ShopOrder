import { describe, expect, it } from 'vitest';
import { performCourierAction } from './courier-commands';
import { COURIER_MSG } from './courier-messages';
import type { CourierActionInput } from './delivery-types';
import type { StaffApi } from './loaders';
import { MSG } from './messages';

type Call = { path: string; opts: Parameters<StaffApi>[1] };
type Result = { ok: true; status: number; data: unknown } | { ok: false; status: number; error: { code: string; message: string; [k: string]: unknown } };

/** apiRequest の代わり。呼び出しを記録し、応答を順に返す */
function fakeApi(...results: Result[]) {
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
const ok = (data: unknown = { pickup_no: 12 }): Result => ({ ok: true, status: 200, data });
const ng = (status: number, code = 'x', extra: Record<string, unknown> = {}): Result => ({
  ok: false,
  status,
  error: { code, message: 'サーバーの文面（出さない）', ...extra },
});

const ID = 'K7M2Q9XD';
const run = (input: Partial<CourierActionInput> & { action: unknown }, api: StaffApi) => performCourierAction('tok', { publicId: ID, ...input } as CourierActionInput, api);

describe('performCourierAction: API の呼び方', () => {
  it('pickup・depart: POST /api/courier/deliveries/{id}/{action}。本文なし。トークンは Bearer（staffToken）', async () => {
    for (const action of ['pickup', 'depart'] as const) {
      const { api, calls } = fakeApi(ok());
      const r = await run({ action }, api);
      expect(r.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.path).toBe(`/api/courier/deliveries/${ID}/${action}`);
      expect(calls[0]!.opts).toMatchObject({ method: 'POST', staffToken: 'tok' });
      expect(calls[0]!.opts?.body).toBeUndefined();
    }
  });

  it('deliver: 暗証コードを整えて（全角・空白）本文 { pin } で送る', async () => {
    const { api, calls } = fakeApi(ok());
    expect((await run({ action: 'deliver', pin: ' ４８２１ ' }, api)).ok).toBe(true);
    expect(calls[0]!.path).toBe(`/api/courier/deliveries/${ID}/deliver`);
    expect(calls[0]!.opts?.body).toEqual({ pin: '4821' });
  });

  it('fail: 決まった理由だけを { reason } で送る', async () => {
    for (const reason of ['absent', 'cannot_receive', 'other'] as const) {
      const { api, calls } = fakeApi(ok());
      expect((await run({ action: 'fail', reason }, api)).ok).toBe(true);
      expect(calls[0]!.opts?.body).toEqual({ reason });
    }
  });

  it('pickup に pin・reason を付けられても、送らない', async () => {
    const { api, calls } = fakeApi(ok());
    await run({ action: 'pickup', pin: '4821', reason: 'absent' }, api);
    expect(calls[0]!.opts?.body).toBeUndefined();
  });

  it('成功の文: 受け取り番号つき（応答に無ければ、番号なし）', async () => {
    expect(await run({ action: 'pickup' }, fakeApi(ok({ pickup_no: 12 })).api)).toEqual({ ok: true, message: '受け取り番号 12: 集荷しました。お届け先が表示されます' });
    expect(await run({ action: 'depart' }, fakeApi(ok({})).api)).toEqual({ ok: true, message: '出発しました' });
    expect(await run({ action: 'depart' }, fakeApi(ok(null)).api)).toEqual({ ok: true, message: '出発しました' });
  });
});

describe('performCourierAction: クライアントから来る値を信用しない（API を呼ばない）', () => {
  it('暗証コードが 4 桁の数字でなければ、API を呼ばず、形の文', async () => {
    const { api, calls } = fakeApi();
    for (const pin of [undefined, '', '123', '12345', 'abcd', '12 34', '48-1', 4821 as unknown as string]) {
      expect(await run({ action: 'deliver', pin }, api)).toEqual({ ok: false, kind: 'invalid', message: COURIER_MSG.pinFormat, refresh: false });
    }
    expect(calls).toHaveLength(0);
  });

  it('不在の理由が決まったものでなければ、API を呼ばない（自由記述は受けない）', async () => {
    const { api, calls } = fakeApi();
    for (const reason of [undefined, '', '不在', '玄関に誰もいなかった', 'pin_locked', 'ABSENT', 1 as unknown as 'other']) {
      expect(await run({ action: 'fail', reason: reason as never }, api)).toEqual({ ok: false, kind: 'invalid', message: COURIER_MSG.reasonRequired, refresh: false });
    }
    expect(calls).toHaveLength(0);
  });

  it('知らない action・形の違う ID・形の違う入力は、API を呼ばない（パスを組み立てない）', async () => {
    const { api, calls } = fakeApi();
    for (const input of [
      { publicId: ID, action: 'assign' },
      { publicId: ID, action: 'cancel' },
      { publicId: ID, action: '../stock' },
      { publicId: ID, action: undefined },
      { publicId: '../staff/orders', action: 'pickup' },
      { publicId: `${ID}/pickup?x=1`, action: 'pickup' },
      { publicId: '', action: 'pickup' },
      { publicId: 123, action: 'pickup' },
      { action: 'pickup' },
      null,
      undefined,
    ]) {
      const r = await performCourierAction('tok', input as never, api);
      expect(r).toEqual({ ok: false, kind: 'invalid', message: MSG.generic, refresh: false });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('performCourierAction: API の失敗の分類', () => {
  it('他の人が先に操作した・状態が変わった（409）は、画面を取り直す', async () => {
    expect(await run({ action: 'pickup' }, fakeApi(ng(409, 'invalid_transition')).api)).toEqual({
      ok: false,
      kind: 'conflict',
      message: COURIER_MSG.stateChanged,
      refresh: true,
    });
  });

  it('配達が無い・他の配達員の担当（404）は、画面を取り直す', async () => {
    expect(await run({ action: 'depart' }, fakeApi(ng(404, 'not_found')).api)).toMatchObject({ ok: false, kind: 'not_found', message: COURIER_MSG.gone, refresh: true });
  });

  it('暗証コードの誤り（422 pin_invalid）: 残りの回数つき。画面を取り直す', async () => {
    const r = await run({ action: 'deliver', pin: '0000' }, fakeApi(ng(422, 'pin_invalid', { attempts_left: 4 })).api);
    expect(r).toEqual({ ok: false, kind: 'invalid', message: '暗証コードが違います。残り 4 回', refresh: true });
  });

  it('暗証コードの凍結（409 pin_locked）と期限切れ（409 pin_expired）は、別の文', async () => {
    const locked = await run({ action: 'deliver', pin: '0000' }, fakeApi(ng(409, 'pin_locked')).api);
    const expired = await run({ action: 'deliver', pin: '0000' }, fakeApi(ng(409, 'pin_expired')).api);
    expect(locked).toMatchObject({ ok: false, message: COURIER_MSG.pinLocked, refresh: true });
    expect(expired).toMatchObject({ ok: false, message: COURIER_MSG.pinExpired, refresh: true });
    expect(locked).not.toEqual(expired);
  });

  it('401 は unauthorized（action 側が Cookie を消してログインへ）。403 は権限なし', async () => {
    expect(await run({ action: 'pickup' }, fakeApi(ng(401, 'unauthorized')).api)).toMatchObject({ ok: false, kind: 'unauthorized', refresh: false });
    expect(await run({ action: 'pickup' }, fakeApi(ng(403, 'forbidden')).api)).toMatchObject({ ok: false, kind: 'forbidden', message: MSG.forbidden });
  });

  it('接続できない（status 0）・5xx は、固定の文。サーバーの文面・例外の文字列を出さない', async () => {
    expect(await run({ action: 'pickup' }, fakeApi({ ok: false, status: 0, error: { code: 'unreachable', message: 'connect ECONNREFUSED 10.0.0.5:8000' } }).api)).toEqual({
      ok: false,
      kind: 'unreachable',
      message: MSG.unreachable,
      refresh: false,
    });
    const r = await run({ action: 'pickup' }, fakeApi(ng(500, 'internal_error')).api);
    expect(r).toEqual({ ok: false, kind: 'error', message: MSG.generic, refresh: false });
    expect(JSON.stringify(r)).not.toContain('サーバーの文面');
  });
});

describe('暗証コードを、結果に残さない', () => {
  it('どの結果にも、入力した暗証コードが入っていない（成功・誤り・凍結・期限切れ・形の誤り・5xx）', async () => {
    const pin = '4821';
    const outcomes = await Promise.all([
      run({ action: 'deliver', pin }, fakeApi(ok({ pickup_no: 12 })).api),
      run({ action: 'deliver', pin }, fakeApi(ng(422, 'pin_invalid', { attempts_left: 2, pin })).api),
      run({ action: 'deliver', pin }, fakeApi(ng(409, 'pin_locked')).api),
      run({ action: 'deliver', pin }, fakeApi(ng(409, 'pin_expired')).api),
      run({ action: 'deliver', pin }, fakeApi(ng(422, 'invalid_input')).api),
      run({ action: 'deliver', pin }, fakeApi(ng(500)).api),
      run({ action: 'deliver', pin: `${pin}x` }, fakeApi().api),
    ]);
    for (const outcome of outcomes) expect(JSON.stringify(outcome)).not.toContain(pin);
  });

  it('暗証コードは、API の呼び出しのパス（URL）に載せない。本文だけ', async () => {
    const { api, calls } = fakeApi(ok());
    await run({ action: 'deliver', pin: '4821' }, api);
    expect(calls[0]!.path).not.toContain('4821');
    expect(calls[0]!.path).not.toContain('?');
  });
});

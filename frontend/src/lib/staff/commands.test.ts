import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStockFields, performLogin, performLogout, performStockOp, performTransition } from './commands';
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

afterEach(() => vi.restoreAllMocks());

describe('performLogin', () => {
  const staff = { id: 1, name: 'ミナ', role: 'staff', store_id: 1 };

  it('成功: トークンと期限を返す。API へは email・password を POST', async () => {
    const { api, calls } = fakeApi(ok({ token: 'secret-token', expires_at: '2026-11-21T15:00:00Z', staff }));
    const r = await performLogin('  staff-a@oasis-cafe.example ', 'pw', api);
    expect(r).toEqual({ ok: true, token: 'secret-token', expiresAt: '2026-11-21T15:00:00Z', staff });
    expect(calls[0]!.path).toBe('/api/staff/login');
    expect(calls[0]!.opts).toMatchObject({ method: 'POST', body: { email: 'staff-a@oasis-cafe.example', password: 'pw' } });
  });

  it('401 と 429 は別の文。理由（メールが無い・パスワードが違う）は分けない', async () => {
    expect(await performLogin('a@b.example', 'x', fakeApi(ng(401, 'invalid_credentials')).api)).toEqual({ ok: false, message: MSG.loginInvalid });
    expect(await performLogin('a@b.example', 'x', fakeApi(ng(429, 'too_many_attempts')).api)).toEqual({ ok: false, message: MSG.loginTooMany });
    expect(await performLogin('a@b.example', 'x', fakeApi(ng(0, 'unreachable', 'API に接続できません')).api)).toEqual({ ok: false, message: MSG.loginFailed });
    expect(await performLogin('a@b.example', 'x', fakeApi(ng(500)).api)).toEqual({ ok: false, message: MSG.loginFailed });
  });

  it('空・長すぎる入力は API を呼ばない。応答にトークンが無ければ失敗', async () => {
    const { api, calls } = fakeApi();
    expect(await performLogin('', 'x', api)).toEqual({ ok: false, message: MSG.loginEmpty });
    expect(await performLogin('a@b.example', '', api)).toEqual({ ok: false, message: MSG.loginEmpty });
    expect(await performLogin(null, undefined, api)).toEqual({ ok: false, message: MSG.loginEmpty });
    expect(await performLogin('a'.repeat(300) + '@b.example', 'x', api)).toEqual({ ok: false, message: MSG.loginInvalid });
    expect(calls).toHaveLength(0);
    expect(await performLogin('a@b.example', 'x', fakeApi(ok({ staff })).api)).toEqual({ ok: false, message: MSG.loginFailed });
  });
});

describe('performLogout', () => {
  it('POST /api/staff/logout にトークンを付ける', async () => {
    const { api, calls } = fakeApi(ok(undefined, 204));
    await performLogout('tok', api);
    expect(calls[0]).toEqual({ path: '/api/staff/logout', opts: { method: 'POST', staffToken: 'tok' } });
  });
});

describe('performTransition', () => {
  it('accept: POST /transition {action}。理由は送らない', async () => {
    const { api, calls } = fakeApi(ok({}));
    expect(await performTransition('tok', { publicId: 'K7M2Q9XD', action: 'accept', reason: '無視される' }, api)).toEqual({ ok: true });
    expect(calls[0]).toEqual({ path: '/api/staff/orders/K7M2Q9XD/transition', opts: { method: 'POST', body: { action: 'accept' }, staffToken: 'tok' } });
  });

  it('cancel: 理由が必須（空・空白だけ・101 文字以上は API を呼ばない）。前後の空白は削る', async () => {
    const { api, calls } = fakeApi(ok({}));
    for (const reason of [undefined, '', '   ', 'あ'.repeat(101)]) {
      const r = await performTransition('tok', { publicId: 'K7M2Q9XD', action: 'cancel', reason }, api);
      expect(r).toEqual({ ok: false, kind: 'invalid', message: MSG.cancelReasonRequired });
    }
    expect(calls).toHaveLength(0);
    expect(await performTransition('tok', { publicId: 'K7M2Q9XD', action: 'cancel', reason: '  材料切れ  ' }, api)).toEqual({ ok: true });
    expect(calls[0]!.opts).toMatchObject({ body: { action: 'cancel', reason: '材料切れ' } });
  });

  it('クライアントから来る値を信用しない: 知らない action・形の違う ID は API を呼ばない（パスを組み立てない）', async () => {
    const { api, calls } = fakeApi();
    for (const input of [
      { publicId: 'K7M2Q9XD', action: 'refund' },
      { publicId: '../stock', action: 'accept' },
      { publicId: 'K7M2Q9XD/transition?x=1', action: 'accept' },
      { publicId: '', action: 'accept' },
      { publicId: 123, action: 'accept' },
    ]) {
      const r = await performTransition('tok', input as never, api);
      expect(r.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('409 invalid_transition は conflict（画面は「他の人が先に操作しました。更新します」を出して取り直す）', async () => {
    const { api } = fakeApi(ng(409, 'invalid_transition', 'その操作はできません'));
    expect(await performTransition('tok', { publicId: 'K7M2Q9XD', action: 'start' }, api)).toEqual({ ok: false, kind: 'conflict', message: '他の人が先に操作しました。更新します' });
  });

  it('401 は unauthorized、5xx は固定の文（サーバーの文面を出さない）', async () => {
    expect(await performTransition('tok', { publicId: 'K7M2Q9XD', action: 'accept' }, fakeApi(ng(401)).api)).toMatchObject({ ok: false, kind: 'unauthorized' });
    expect(await performTransition('tok', { publicId: 'K7M2Q9XD', action: 'accept' }, fakeApi(ng(500, 'x', 'psycopg.errors.X: /app/db.py')).api)).toEqual({ ok: false, kind: 'error', message: MSG.generic });
  });
});

describe('parseStockFields', () => {
  const f = (over: Partial<{ itemId: unknown; amount: unknown; reason: unknown }>) => ({ itemId: '3', amount: '10', reason: '', ...over });

  it('入荷: 数は 1 以上の整数。理由は任意', () => {
    expect(parseStockFields('receive', f({}))).toEqual({ ok: true, itemId: 3, amount: 10, body: { qty: 10 } });
    expect(parseStockFields('receive', f({ reason: ' 納品書 7 ' }))).toMatchObject({ body: { qty: 10, reason: '納品書 7' } });
    for (const bad of ['0', '-1', '1.5', '', 'abc', '1e3', '12345678']) expect(parseStockFields('receive', f({ amount: bad })).ok).toBe(false);
  });

  it('全角の数字も受ける', () => {
    expect(parseStockFields('receive', f({ amount: '１２', itemId: '３' }))).toMatchObject({ ok: true, itemId: 3, amount: 12 });
  });

  it('廃棄: 理由が必須', () => {
    expect(parseStockFields('waste', f({ reason: '' }))).toEqual({ ok: false, message: '理由を入力してください' });
    expect(parseStockFields('waste', f({ reason: '   ' })).ok).toBe(false);
    expect(parseStockFields('waste', f({ reason: '期限切れ' }))).toEqual({ ok: true, itemId: 3, amount: 10, body: { qty: 10, reason: '期限切れ' } });
  });

  it('棚卸し: 差分は 0 ではない整数（負も可）。理由が必須。body のキーは delta', () => {
    expect(parseStockFields('adjust', f({ amount: '-3', reason: '数え直し' }))).toEqual({ ok: true, itemId: 3, amount: -3, body: { delta: -3, reason: '数え直し' } });
    expect(parseStockFields('adjust', f({ amount: '−3', reason: '数え直し' }))).toMatchObject({ amount: -3 }); // 全角のマイナス
    expect(parseStockFields('adjust', f({ amount: '0', reason: 'x' })).ok).toBe(false);
    expect(parseStockFields('adjust', f({ amount: '+', reason: 'x' })).ok).toBe(false);
    expect(parseStockFields('adjust', f({ amount: '5', reason: '' })).ok).toBe(false);
  });

  it('品目の ID が数字でなければ拒む（パスを組み立てない）', () => {
    for (const bad of ['', '0', 'a', '1/receive', '../x', null, undefined]) expect(parseStockFields('receive', f({ itemId: bad })).ok).toBe(false);
  });

  it('理由は 100 文字まで', () => {
    expect(parseStockFields('waste', f({ reason: 'あ'.repeat(100) })).ok).toBe(true);
    expect(parseStockFields('waste', f({ reason: 'あ'.repeat(101) })).ok).toBe(false);
  });
});

describe('performStockOp', () => {
  const row = { item_id: 3, name: 'オアシスブレンド豆', unit: 'g', on_hand: 5400 };

  it('入荷: POST /api/staff/stock/{id}/receive {qty}。更新後の行から文を作る', async () => {
    const { api, calls } = fakeApi(ok(row));
    const r = await performStockOp('tok', 'receive', { itemId: '3', amount: '400', reason: '' }, api);
    expect(calls[0]).toEqual({ path: '/api/staff/stock/3/receive', opts: { method: 'POST', body: { qty: 400 }, staffToken: 'tok' } });
    expect(r).toEqual({ ok: true, message: '「オアシスブレンド豆」を入荷しました（400 g）。実在庫は 5400 gになりました' });
  });

  it('廃棄: .../waste {qty, reason}', async () => {
    const { api, calls } = fakeApi(ok(row));
    const r = await performStockOp('tok', 'waste', { itemId: '3', amount: '50', reason: '期限切れ' }, api);
    expect(calls[0]!.path).toBe('/api/staff/stock/3/waste');
    expect(calls[0]!.opts).toMatchObject({ body: { qty: 50, reason: '期限切れ' } });
    expect(r.ok && r.message).toContain('廃棄しました');
  });

  it('棚卸し: .../adjust {delta, reason}。差分の符号を文に出す', async () => {
    const { api, calls } = fakeApi(ok(row), ok(row));
    const minus = await performStockOp('tok', 'adjust', { itemId: '3', amount: '-30', reason: '数え直し' }, api);
    const plus = await performStockOp('tok', 'adjust', { itemId: '3', amount: '20', reason: '数え直し' }, api);
    expect(calls[0]!.path).toBe('/api/staff/stock/3/adjust');
    expect(calls[0]!.opts).toMatchObject({ body: { delta: -30, reason: '数え直し' } });
    expect(minus.ok && minus.message).toContain('（-30 g）');
    expect(plus.ok && plus.message).toContain('（+20 g）');
  });

  it('入力の誤りは API を呼ばない。API の失敗は固定の文で返す', async () => {
    const { api, calls } = fakeApi(ng(404), ng(409, 'insufficient_stock', '実在庫より多くは廃棄できません'), ng(401));
    expect(await performStockOp('tok', 'waste', { itemId: '3', amount: '5', reason: '' }, api)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(calls).toHaveLength(0);
    expect(await performStockOp('tok', 'receive', { itemId: '3', amount: '5', reason: '' }, api)).toEqual({ ok: false, kind: 'not_found', message: MSG.itemNotFound });
    expect(await performStockOp('tok', 'waste', { itemId: '3', amount: '5', reason: 'x' }, api)).toEqual({ ok: false, kind: 'invalid', message: '実在庫より多くは廃棄できません' });
    expect(await performStockOp('tok', 'waste', { itemId: '3', amount: '5', reason: 'x' }, api)).toMatchObject({ ok: false, kind: 'unauthorized' });
  });

  it('知らない操作名は API を呼ばない', async () => {
    const { api, calls } = fakeApi();
    expect(await performStockOp('tok', 'delete' as never, { itemId: '3', amount: '5', reason: 'x' }, api)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

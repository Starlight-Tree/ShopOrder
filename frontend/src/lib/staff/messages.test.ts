import { describe, expect, it } from 'vitest';
import { failureFrom, loginErrorMessage, MSG, transitionSuccessMessage } from './messages';

describe('loginErrorMessage', () => {
  it('401 と 429 を区別し、理由は分けない', () => {
    expect(loginErrorMessage(401)).toBe(MSG.loginInvalid);
    expect(loginErrorMessage(429)).toBe(MSG.loginTooMany);
    expect(loginErrorMessage(401)).not.toContain('メールアドレスが');
    expect(loginErrorMessage(401)).not.toContain('パスワードが違います。');
  });
  it('それ以外（接続できない・5xx・想定外）は、同じ固定の文', () => {
    for (const s of [0, 400, 403, 500, 503]) expect(loginErrorMessage(s)).toBe(MSG.loginFailed);
  });
});

describe('failureFrom（API の失敗 → 画面の文）', () => {
  const err = (status: number, code = 'x', message = '固定の文') => ({ status, error: { code, message } });

  it('409 invalid_transition は「他の人が先に操作しました。更新します」', () => {
    expect(failureFrom(err(409, 'invalid_transition'))).toEqual({ kind: 'conflict', message: '他の人が先に操作しました。更新します' });
  });
  it('409 でも code が違えば（在庫不足など）、API の固定の文を出す。取り直しは求めない', () => {
    expect(failureFrom(err(409, 'insufficient_stock', '原材料が足りません'))).toEqual({ kind: 'invalid', message: '原材料が足りません' });
  });
  it('401 は unauthorized、403 は権限、404 は見つからない、接続できないは unreachable', () => {
    expect(failureFrom(err(401)).kind).toBe('unauthorized');
    expect(failureFrom(err(403))).toEqual({ kind: 'forbidden', message: MSG.forbidden });
    expect(failureFrom(err(404))).toEqual({ kind: 'not_found', message: MSG.orderNotFound });
    expect(failureFrom(err(404), MSG.itemNotFound).message).toBe(MSG.itemNotFound);
    expect(failureFrom(err(0, 'unreachable', 'http://api:8000 に接続できません'))).toEqual({ kind: 'unreachable', message: MSG.unreachable });
  });
  it('5xx と、長すぎる・空の message は使わない（サーバーの文面を画面に出さない）', () => {
    expect(failureFrom(err(500, 'boom', 'Traceback (most recent call last): /app/x.py'))).toEqual({ kind: 'error', message: MSG.generic });
    expect(failureFrom(err(400, 'bad', 'あ'.repeat(101))).message).toBe(MSG.generic);
    expect(failureFrom(err(400, 'bad', '')).message).toBe(MSG.generic);
    expect(failureFrom(err(422, 'invalid_input', '')).message).toBe(MSG.invalidInput);
  });
});

describe('transitionSuccessMessage', () => {
  it('操作ごとに、受け取り番号つきの文', () => {
    expect(transitionSuccessMessage(12, 'accept')).toBe('受け取り番号 12 を受付済みにしました');
    expect(transitionSuccessMessage(12, 'start')).toBe('受け取り番号 12 を調理中にしました');
    expect(transitionSuccessMessage(12, 'ready')).toBe('受け取り番号 12 を準備完了にしました');
    expect(transitionSuccessMessage(12, 'complete')).toBe('受け取り番号 12 を渡し済みにしました');
    expect(transitionSuccessMessage(12, 'cancel')).toBe('受け取り番号 12 を取り消しました');
  });
});

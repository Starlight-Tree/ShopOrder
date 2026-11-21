import { describe, expect, it } from 'vitest';
import { COURIER_MSG, courierFailureFrom, courierLoadErrorMessage, courierStatusLabel, courierSuccessMessage, withPickupNo } from './courier-messages';
import { MSG } from './messages';

const err = (code: string, extra: Record<string, unknown> = {}) => ({ code, message: 'サーバーの文面', ...extra });

describe('courierFailureFrom: 暗証コードの 3 つの失敗は、別の文', () => {
  it('422 pin_invalid: 残りの回数つき。画面を取り直す（カードの「残り」を新しくする）', () => {
    const r = courierFailureFrom({ status: 422, error: err('pin_invalid', { attempts_left: 3 }) }, 'deliver');
    expect(r).toEqual({ ok: false, kind: 'invalid', message: '暗証コードが違います。残り 3 回', refresh: true });
  });

  it('残りが 1 回なら、止まることを添える', () => {
    const r = courierFailureFrom({ status: 422, error: err('pin_invalid', { attempts_left: 1 }) }, 'deliver');
    expect(r.message).toBe('暗証コードが違います。残り 1 回（間違えると配達が止まります）');
  });

  it('attempts_left が 0〜5 の整数でなければ、回数なしの文（サーバーの値をそのまま出さない）', () => {
    for (const bad of [undefined, null, '3', 3.5, -1, 6, 999, Number.NaN]) {
      const r = courierFailureFrom({ status: 422, error: err('pin_invalid', { attempts_left: bad }) }, 'deliver');
      expect(r.message).toBe(COURIER_MSG.pinInvalid);
    }
  });

  it('409 pin_locked: 配達が止まった。店へ連絡', () => {
    const r = courierFailureFrom({ status: 409, error: err('pin_locked') }, 'deliver');
    expect(r).toEqual({ ok: false, kind: 'conflict', message: COURIER_MSG.pinLocked, refresh: true });
    expect(COURIER_MSG.pinLocked).toContain('止まりました');
  });

  it('409 pin_expired: 期限切れ。店へ連絡', () => {
    const r = courierFailureFrom({ status: 409, error: err('pin_expired') }, 'deliver');
    expect(r).toEqual({ ok: false, kind: 'conflict', message: COURIER_MSG.pinExpired, refresh: true });
    expect(COURIER_MSG.pinExpired).toContain('有効期限');
  });

  it('3 つの文は、互いに違う', () => {
    const texts = new Set([
      courierFailureFrom({ status: 422, error: err('pin_invalid', { attempts_left: 4 }) }, 'deliver').message,
      courierFailureFrom({ status: 409, error: err('pin_locked') }, 'deliver').message,
      courierFailureFrom({ status: 409, error: err('pin_expired') }, 'deliver').message,
    ]);
    expect(texts.size).toBe(3);
  });
});

describe('courierFailureFrom: その他', () => {
  it('他の 409（invalid_transition など）は、状態が変わった。画面を取り直す', () => {
    expect(courierFailureFrom({ status: 409, error: err('invalid_transition') }, 'pickup')).toEqual({
      ok: false,
      kind: 'conflict',
      message: COURIER_MSG.stateChanged,
      refresh: true,
    });
  });

  it('404: 配達が無い（他の配達員の担当・取り消された）。画面を取り直す', () => {
    expect(courierFailureFrom({ status: 404, error: err('not_found') }, 'depart')).toMatchObject({ kind: 'not_found', message: COURIER_MSG.gone, refresh: true });
  });

  it('401・403・接続不可: 取り直さない。固定の文', () => {
    expect(courierFailureFrom({ status: 401, error: err('unauthorized') }, 'pickup')).toEqual({ ok: false, kind: 'unauthorized', message: MSG.generic, refresh: false });
    expect(courierFailureFrom({ status: 403, error: err('forbidden') }, 'pickup')).toEqual({ ok: false, kind: 'forbidden', message: MSG.forbidden, refresh: false });
    expect(courierFailureFrom({ status: 0, error: err('unreachable') }, 'pickup')).toEqual({ ok: false, kind: 'unreachable', message: MSG.unreachable, refresh: false });
  });

  it('422（形の誤り）: 完了なら暗証コードの形、それ以外は入力の確認', () => {
    expect(courierFailureFrom({ status: 422, error: err('invalid_input') }, 'deliver')).toMatchObject({ message: COURIER_MSG.pinFormat, refresh: false });
    expect(courierFailureFrom({ status: 422, error: err('invalid_input') }, 'fail')).toMatchObject({ message: MSG.invalidInput, refresh: false });
  });

  it('5xx・その他の 4xx: サーバーの文面を出さない', () => {
    const msg = 'psycopg.errors.X: /app/db.py line 3';
    expect(courierFailureFrom({ status: 500, error: { code: 'internal_error', message: msg } }, 'pickup')).toEqual({ ok: false, kind: 'error', message: MSG.generic, refresh: false });
    expect(courierFailureFrom({ status: 418, error: { code: 'x', message: msg } }, 'pickup')).toMatchObject({ kind: 'invalid', message: MSG.generic });
  });
});

describe('courierStatusLabel / courierSuccessMessage', () => {
  it('状態は、文字で示す（色だけにしない）', () => {
    expect(courierStatusLabel('assigned')).toBe('集荷待ち');
    expect(courierStatusLabel('picked_up')).toBe('集荷済み（出発前）');
    expect(courierStatusLabel('delivering')).toBe('配達中');
  });

  it('知らない状態は、API の文字列を出さず、固定の文', () => {
    expect(courierStatusLabel('something_new')).toBe('状態を確認中');
  });

  it('成功の文: 受け取り番号つき。番号が読めなければ、番号なし', () => {
    expect(courierSuccessMessage(12, 'pickup')).toBe('受け取り番号 12: 集荷しました。お届け先が表示されます');
    expect(courierSuccessMessage(12, 'deliver')).toBe('受け取り番号 12: 配達が完了しました');
    expect(courierSuccessMessage(null, 'depart')).toBe('出発しました');
  });
});

describe('withPickupNo: どの配達の結果かを前置きする', () => {
  it('整数の受け取り番号があれば前置きし、読めなければ、そのまま返す', () => {
    expect(withPickupNo(12, '暗証コードが違います')).toBe('受け取り番号 12: 暗証コードが違います');
    expect(withPickupNo(0, '文')).toBe('受け取り番号 0: 文');
    for (const bad of [null, undefined, '12', 1.5, Number.NaN, {}]) expect(withPickupNo(bad, '文')).toBe('文');
  });
});

describe('courierLoadErrorMessage: 一覧が取れなかったときの文', () => {
  it('権限なし・接続できない・その他を、固定の文で分ける', () => {
    expect(courierLoadErrorMessage({ state: 'forbidden' })).toBe(MSG.forbidden);
    expect(courierLoadErrorMessage({ state: 'error', unreachable: true })).toBe(MSG.unreachable);
    expect(courierLoadErrorMessage({ state: 'error', unreachable: false })).toBe(MSG.generic);
  });
});

import { describe, expect, it } from 'vitest';
import {
  assignedMessage,
  DISPATCH_MSG,
  dispatchFailureFrom,
  mockAdvanceMessage,
  orderObject,
  redeliverMessage,
  suspensionMessage,
} from './dispatch-messages';
import { MSG } from './messages';

const res = (status: number, code = 'x', message = '固定の文') => ({ status, error: { code, message } });
const LEAK = 'psycopg.errors.UniqueViolation at /app/app/dispatch.py:88 (10.0.0.5)';

describe('dispatchFailureFrom（宅配の操作の失敗）', () => {
  it.each([
    [409, 'courier_off_duty', 'conflict', DISPATCH_MSG.courierOffDuty, true],
    [404, 'courier_not_found', 'not_found', DISPATCH_MSG.courierNotFound, true],
    [409, 'no_slot_available', 'invalid', DISPATCH_MSG.noSlot, false],
    [409, 'zone_suspended', 'invalid', DISPATCH_MSG.zoneSuspended, true],
    [409, 'mock_only', 'invalid', DISPATCH_MSG.mockOnly, true],
    [409, 'no_courier_available', 'invalid', DISPATCH_MSG.noCourierAvailable, false],
    [404, 'zone_not_found', 'not_found', DISPATCH_MSG.zoneNotFound, true],
  ] as const)('%i %s は、固定の文で返す（API の文面は使わない）', (status, code, kind, message, refresh) => {
    expect(dispatchFailureFrom(res(status, code, LEAK))).toEqual({ kind, message, refresh });
  });

  it('再配達で枠が無い・砂嵐のときの文は、理由と次の手を示す', () => {
    expect(DISPATCH_MSG.noSlot).toContain('枠');
    expect(DISPATCH_MSG.zoneSuspended).toContain('砂嵐');
  });

  it('409 invalid_transition は、他の人が先に操作した（conflict）。画面を取り直す', () => {
    expect(dispatchFailureFrom(res(409, 'invalid_transition'))).toEqual({ kind: 'conflict', message: MSG.conflict, refresh: true });
  });

  it('404（注文が無い）は取り直す。文は呼び出し側が選べる', () => {
    expect(dispatchFailureFrom(res(404, 'not_found'))).toEqual({ kind: 'not_found', message: MSG.orderNotFound, refresh: true });
    expect(dispatchFailureFrom(res(404, 'not_found'), 'x')).toMatchObject({ message: 'x' });
  });

  it('認証・権限・接続・サーバーの失敗は、取り直さない。文は固定', () => {
    expect(dispatchFailureFrom(res(401, 'unauthorized'))).toMatchObject({ kind: 'unauthorized', refresh: false });
    expect(dispatchFailureFrom(res(403, 'forbidden', LEAK))).toEqual({ kind: 'forbidden', message: MSG.forbidden, refresh: false });
    expect(dispatchFailureFrom(res(0, 'unreachable', LEAK))).toEqual({ kind: 'unreachable', message: MSG.unreachable, refresh: false });
    expect(dispatchFailureFrom(res(500, 'x', LEAK))).toEqual({ kind: 'error', message: MSG.generic, refresh: false });
  });

  it('code だけでなく status も合うときだけ、宅配の文にする', () => {
    expect(dispatchFailureFrom(res(500, 'mock_only', LEAK))).toEqual({ kind: 'error', message: MSG.generic, refresh: false });
    expect(dispatchFailureFrom(res(404, 'no_slot_available'))).toMatchObject({ kind: 'not_found', message: MSG.orderNotFound });
  });

  it('表に無い 4xx は、スタッフ共通の failureFrom に任せる（API の固定の文。100 文字を超える・空の文は使わず、固定の文に倒す）', () => {
    expect(dispatchFailureFrom(res(422, 'validation_error', '入力が正しくありません'))).toEqual({ kind: 'invalid', message: '入力が正しくありません', refresh: false });
    expect(dispatchFailureFrom(res(409, 'something_new', '状態が合いません'))).toMatchObject({ kind: 'invalid', message: '状態が合いません' });
    expect(dispatchFailureFrom(res(422, 'x', LEAK.repeat(2)))).toEqual({ kind: 'invalid', message: MSG.invalidInput, refresh: false });
    expect(dispatchFailureFrom(res(400, 'x', ''))).toEqual({ kind: 'invalid', message: MSG.generic, refresh: false });
  });

  it('どの文にも、API の文面（例外・パス・アドレス）は入らない', () => {
    for (const [status, code] of [[409, 'courier_off_duty'], [409, 'invalid_transition'], [409, 'zone_suspended'], [500, 'x'], [404, 'courier_not_found'], [403, 'forbidden']] as const) {
      const out = dispatchFailureFrom(res(status, code, LEAK));
      expect(out.message).not.toContain('psycopg');
      expect(out.message).not.toContain('/app');
    }
  });
});

describe('成功の文（応答から、型を確かめて読む）', () => {
  it('受け取り番号が読めれば出す。読めなければ「注文を」', () => {
    expect(orderObject({ pickup_no: 12 })).toBe('受け取り番号 12 を');
    expect(orderObject({ pickup_no: '12' })).toBe('注文を');
    expect(orderObject({ pickup_no: 1.5 })).toBe('注文を');
    expect(orderObject(null)).toBe('注文を');
    expect(orderObject(undefined)).toBe('注文を');
    expect(orderObject('x')).toBe('注文を');
  });

  it('割り当て: 担当の配達員の名前を添える。読めなければ名前なし', () => {
    expect(assignedMessage({ pickup_no: 12, delivery: { courier: { id: 7, name: 'ラシード' } } })).toBe('受け取り番号 12 をラシードに割り当てました');
    expect(assignedMessage({ pickup_no: 12, delivery: { courier: null } })).toBe('受け取り番号 12 を割り当てました');
    expect(assignedMessage(undefined)).toBe('注文を割り当てました');
  });

  it('再配達・模擬の進行', () => {
    expect(redeliverMessage({ pickup_no: 12 })).toBe('受け取り番号 12 を再配達にしました（選べる中で最も早い枠）');
    expect(mockAdvanceMessage({ pickup_no: 12 })).toBe('受け取り番号 12 を模擬で 1 つ進めました');
  });

  it('砂嵐の警報: 立てた・解除した。区画名が読めなければ「区画の」', () => {
    expect(suspensionMessage({ name: '発着場' }, true)).toBe('発着場の砂嵐の警報を立てました。この区画の宅配は、受け付けません');
    expect(suspensionMessage({ name: '発着場' }, false)).toBe('発着場の砂嵐の警報を解除しました');
    expect(suspensionMessage(null, false)).toBe('区画の砂嵐の警報を解除しました');
  });
});

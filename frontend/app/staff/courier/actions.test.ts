import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STAFF_COOKIE } from '../../../src/lib/staff/cookie';
import type { DeliveryOutcome } from '../../../src/lib/staff/delivery-types';
import { courierAction } from './actions';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), redirect: vi.fn(), revalidatePath: vi.fn(), perform: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.get, set: mocks.set }) }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('../../../src/lib/staff/courier-commands', () => ({ performCourierAction: mocks.perform }));

const input = { publicId: 'K7M2Q9XD', action: 'deliver', pin: '4821' } as const;
const failure = (over: Partial<Extract<DeliveryOutcome, { ok: false }>>): DeliveryOutcome => ({ ok: false, kind: 'invalid', message: '文', refresh: false, ...over });

beforeEach(() => {
  mocks.get.mockReset().mockReturnValue({ value: 'tok-1' });
  mocks.set.mockReset();
  mocks.revalidatePath.mockReset();
  mocks.perform.mockReset();
  mocks.redirect.mockReset().mockImplementation((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  });
});

describe('courierAction（Server Action）', () => {
  it('Cookie のトークンと、クライアントから来た入力を、そのまま検査の関数へ渡す（形の検査は performCourierAction）', async () => {
    mocks.perform.mockResolvedValue({ ok: true, message: '完了' });
    await courierAction(input);
    expect(mocks.get).toHaveBeenCalledWith(STAFF_COOKIE);
    expect(mocks.perform).toHaveBeenCalledWith('tok-1', input);
  });

  it('Cookie が無ければ、API を呼ばずにログインへ', async () => {
    mocks.get.mockReturnValue(undefined);
    await expect(courierAction(input)).rejects.toThrow('REDIRECT:/staff/login');
    expect(mocks.perform).not.toHaveBeenCalled();
  });

  it('成功: 一覧を最新にして、結果を返す', async () => {
    mocks.perform.mockResolvedValue({ ok: true, message: '完了' });
    expect(await courierAction(input)).toEqual({ ok: true, message: '完了' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/staff/courier');
  });

  it('状態が変わった失敗（refresh: true）は、一覧を最新にする。それ以外の失敗は、しない', async () => {
    mocks.perform.mockResolvedValue(failure({ kind: 'conflict', refresh: true }));
    await courierAction(input);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    mocks.revalidatePath.mockClear();
    mocks.perform.mockResolvedValue(failure({ kind: 'error', refresh: false }));
    expect(await courierAction(input)).toMatchObject({ ok: false, kind: 'error' });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('認証切れ（401）: Cookie を消して、ログインへ', async () => {
    mocks.perform.mockResolvedValue(failure({ kind: 'unauthorized' }));
    await expect(courierAction(input)).rejects.toThrow('REDIRECT:/staff/login');
    expect(mocks.set).toHaveBeenCalledWith(STAFF_COOKIE, '', expect.objectContaining({ maxAge: 0, path: '/staff' }));
  });
});

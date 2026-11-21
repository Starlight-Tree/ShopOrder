import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CourierBoard } from '../../../src/components/courier/CourierBoard';
import { delivery } from '../../../src/lib/staff/courier-test-fixtures';
import { MSG } from '../../../src/lib/staff/messages';
import { staffUser } from '../../../src/lib/staff/test-fixtures';
import CourierPage from './page';

const mocks = vi.hoisted(() => ({ requireStaff: vi.fn(), load: vi.fn(), redirect: vi.fn() }));
vi.mock('../../../src/lib/staff/session', () => ({ requireStaff: mocks.requireStaff }));
vi.mock('../../../src/lib/staff/courier-loaders', () => ({ loadCourierDeliveries: mocks.load }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('./actions', () => ({ courierAction: vi.fn() }));

beforeEach(() => {
  mocks.requireStaff.mockReset();
  mocks.load.mockReset();
  mocks.redirect.mockReset().mockImplementation((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  });
  vi.unstubAllEnvs();
});

const as = (role: 'staff' | 'manager' | 'courier') => ({ token: 'tok-1', staff: staffUser({ role, name: 'ラシード' }) });

/** page が返す要素の木から、CourierBoard の要素を探す（描画せず、渡す props を確かめる） */
function findBoard(node: ReactNode): ReactElement<ComponentProps<typeof CourierBoard>> {
  if (isValidElement(node)) {
    if (node.type === CourierBoard) return node as ReactElement<ComponentProps<typeof CourierBoard>>;
    const children = (node.props as { children?: ReactNode }).children;
    for (const child of Array.isArray(children) ? children : [children]) {
      try {
        return findBoard(child);
      } catch {
        /* 次の子を探す */
      }
    }
  }
  throw new Error('CourierBoard が見つからない');
}
const renderPage = async () => findBoard(await CourierPage()).props;

describe('/staff/courier の page: 門（layout は画面の移動で再実行されないので、page でも確かめる）', () => {
  it('配達員でなければ（スタッフ・店長）、一覧を取らずに /staff へ', async () => {
    for (const role of ['staff', 'manager'] as const) {
      mocks.requireStaff.mockResolvedValue(as(role));
      await expect(CourierPage()).rejects.toThrow(/^REDIRECT:\/staff$/);
    }
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('一覧が 401 なら、Cookie を消す経路（/staff/expired）へ', async () => {
    mocks.requireStaff.mockResolvedValue(as('courier'));
    mocks.load.mockResolvedValue({ state: 'unauthorized' });
    await expect(CourierPage()).rejects.toThrow('REDIRECT:/staff/expired');
  });

  it('requireStaff 自身のリダイレクト（Cookie なし・認証切れ）は、そのまま通す', async () => {
    mocks.requireStaff.mockImplementation(async () => {
      throw new Error('REDIRECT:/staff/login');
    });
    await expect(CourierPage()).rejects.toThrow('REDIRECT:/staff/login');
    expect(mocks.load).not.toHaveBeenCalled();
  });
});

describe('/staff/courier の page: 一覧と、失敗の文の選び分け', () => {
  it('取れたら、配達員のトークンで取った一覧を渡す。時差は環境変数（既定 +9）', async () => {
    mocks.requireStaff.mockResolvedValue(as('courier'));
    const list = [delivery()];
    mocks.load.mockResolvedValue({ state: 'ok', data: list });
    const props = await renderPage();
    expect(mocks.load).toHaveBeenCalledWith('tok-1');
    expect(props.deliveries).toBe(list);
    expect(props.offsetHours).toBe(9);
    expect(Number.isFinite(Date.parse(props.now))).toBe(true);

    vi.stubEnv('LOCAL_UTC_OFFSET_HOURS', '0');
    expect((await renderPage()).offsetHours).toBe(0);
    vi.stubEnv('LOCAL_UTC_OFFSET_HOURS', 'abc');
    expect((await renderPage()).offsetHours).toBe(9); // 読めなければ既定
  });

  it('権限なし（403）: 一覧なし・「権限がありません」の文', async () => {
    mocks.requireStaff.mockResolvedValue(as('courier'));
    mocks.load.mockResolvedValue({ state: 'forbidden' });
    expect(await renderPage()).toMatchObject({ deliveries: null, errorMessage: MSG.forbidden });
  });

  it('API に接続できない: 一覧なし・「接続できません」の文。それ以外の失敗（5xx など）は、固定の文', async () => {
    mocks.requireStaff.mockResolvedValue(as('courier'));
    mocks.load.mockResolvedValue({ state: 'error', unreachable: true });
    expect(await renderPage()).toMatchObject({ deliveries: null, errorMessage: MSG.unreachable });
    mocks.load.mockResolvedValue({ state: 'error', unreachable: false });
    expect(await renderPage()).toMatchObject({ deliveries: null, errorMessage: MSG.generic });
  });

  it('API に聞けない（requireStaff が null）: 画面は残し、一覧なし・「接続できません」の文。一覧は取りに行かない', async () => {
    mocks.requireStaff.mockResolvedValue(null);
    expect(await renderPage()).toMatchObject({ deliveries: null, errorMessage: MSG.unreachable });
    expect(mocks.load).not.toHaveBeenCalled();
  });
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffOrder } from '../../lib/contract';
import { dispatchOrder } from '../../lib/staff/dispatch-fixtures';
import { NOW, order } from '../../lib/staff/test-fixtures';
import type { TransitionInput, TransitionResult } from '../../lib/staff/types';
import { OrderBoard } from './OrderBoard';

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/staff',
}));

const okAction = () => vi.fn<(input: TransitionInput) => Promise<TransitionResult>>(async () => ({ ok: true }));

type Over = Partial<Parameters<typeof OrderBoard>[0]>;
const renderBoard = (over: Over = {}) => {
  const onTransition = over.onTransition ?? okAction();
  render(
    <OrderBoard orders={[]} now={NOW} stores={null} showStoreSelect={false} selectedStoreId={null} onTransition={onTransition} {...over} />,
  );
  return onTransition;
};

beforeEach(() => {
  nav.refresh.mockClear();
  nav.replace.mockClear();
});

describe('OrderBoard の列', () => {
  it('4 つの列（受付待ち・受付済み・調理中・準備完了）を、この順に出し、件数を付ける', () => {
    renderBoard({
      orders: [
        order({ public_id: 'A0000001', pickup_no: 1, status: 'paid' }),
        order({ public_id: 'A0000002', pickup_no: 2, status: 'paid' }),
        order({ public_id: 'A0000003', pickup_no: 3, status: 'ready', allowed_actions: ['complete', 'cancel'] }),
      ],
    });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['受付待ち2', '受付済み0', '調理中0', '準備完了1']);
    const paid = screen.getByRole('region', { name: /受付待ち/ });
    expect(within(paid).getAllByRole('article')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: /受付済み/ })).getByText('なし')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: /準備完了/ })).getByRole('article', { name: '受け取り番号 3' })).toBeInTheDocument();
  });

  it('取得に失敗したら、列の代わりに知らせを出す（再取得は続ける）', () => {
    renderBoard({ orders: null, errorMessage: 'API に接続できません。しばらくしてから、もう一度お試しください' });
    expect(screen.getByRole('alert')).toHaveTextContent('注文を読み込めませんでした');
    expect(screen.getByRole('alert')).toHaveTextContent('自動で再試行します');
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('OrderCard の中身', () => {
  it('受け取り番号（大）・品（名前・サイズ・温度・数量）・経過時間を出す', () => {
    renderBoard({ orders: [order({ pickup_no: 12 })] });
    const card = screen.getByRole('article', { name: '受け取り番号 12' });
    expect(within(card).getByText('12')).toHaveClass('st-pickup-no');
    expect(within(card).getByText('オアシスブレンド')).toBeInTheDocument();
    expect(within(card).getByText('M・ホット')).toBeInTheDocument();
    expect(card).toHaveTextContent('数量 2');
    expect(within(card).getByText('5 分')).toBeInTheDocument();
  });

  it('フード（サイズ・温度が "-"）は、"-" を出さない', () => {
    renderBoard({ orders: [order({ items: [{ name: 'ホットサンド', size: '-', temperature: '-', unit_price_lumi: 520, qty: 1, line_total_lumi: 520 }] })] });
    const card = screen.getByRole('article');
    expect(card).toHaveTextContent('ホットサンド');
    expect(card.textContent).not.toContain('-');
  });

  it('10 分を超えたら、色だけでなく「10 分超」の文字を出して強調する。10 分ちょうどは出さない', () => {
    renderBoard({
      orders: [
        order({ public_id: 'A0000001', pickup_no: 1, placed_at: '2026-11-21T02:54:00Z' }), // 11 分
        order({ public_id: 'A0000002', pickup_no: 2, placed_at: '2026-11-21T02:55:00Z' }), // 10 分
      ],
    });
    const late = screen.getByRole('article', { name: '受け取り番号 1' });
    const onTime = screen.getByRole('article', { name: '受け取り番号 2' });
    expect(within(late).getByText('10 分超')).toBeInTheDocument();
    expect(late.closest('li')).toHaveClass('is-overdue');
    expect(within(onTime).queryByText('10 分超')).toBeNull();
    expect(onTime.closest('li')).not.toHaveClass('is-overdue');
  });

  it('顧客の個人情報は出さない（API が誤って含めても、描かない）', () => {
    const leaky = { ...order(), customer_name: '田中 太郎', email: 'tanaka@example.com', phone: '090-0000-0000', address: 'アルカ市居住区1-4-2' };
    const { container } = render(
      <OrderBoard orders={[leaky]} now={NOW} stores={null} showStoreSelect={false} selectedStoreId={null} onTransition={okAction()} />,
    );
    for (const secret of ['田中', 'tanaka@example.com', '090-', 'アルカ市居住区']) expect(container.textContent).not.toContain(secret);
  });
});

describe('操作ボタン（allowed_actions）', () => {
  it('API が許した操作だけを、ラベルつきで出す', () => {
    renderBoard({
      orders: [
        order({ public_id: 'A0000001', pickup_no: 1, status: 'paid', allowed_actions: ['accept', 'cancel'] }),
        order({ public_id: 'A0000002', pickup_no: 2, status: 'accepted', allowed_actions: ['start', 'cancel'] }),
        order({ public_id: 'A0000003', pickup_no: 3, status: 'preparing', allowed_actions: ['ready'] }),
        order({ public_id: 'A0000004', pickup_no: 4, status: 'ready', allowed_actions: ['complete', 'cancel'] }),
      ],
    });
    const names = (no: number) => within(screen.getByRole('article', { name: `受け取り番号 ${no}` })).getAllByRole('button').map((b) => b.textContent);
    expect(names(1)).toEqual(['受ける', '取消し']);
    expect(names(2)).toEqual(['調理開始', '取消し']);
    expect(names(3)).toEqual(['準備完了']);
    expect(names(4)).toEqual(['渡した', '取消し']);
  });

  it('許された操作が無ければ、ボタンは出さない', () => {
    renderBoard({ orders: [order({ allowed_actions: [] })] });
    expect(screen.queryByRole('button', { name: '受ける' })).toBeNull();
  });

  it('「受ける」→ transition を {publicId, action} で呼び、成功の文を出す', async () => {
    const onTransition = renderBoard({ orders: [order({ public_id: 'K7M2Q9XD', pickup_no: 12 })] });
    fireEvent.click(screen.getByRole('button', { name: '受ける' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('受け取り番号 12 を受付済みにしました'));
    expect(onTransition).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', action: 'accept', reason: undefined });
    expect(nav.refresh).not.toHaveBeenCalled(); // 成功の取り直しは、Server Action 側（revalidatePath）
  });

  it('処理中は、その注文のボタンを押せない（二重送信を防ぐ）', async () => {
    let release: (r: TransitionResult) => void = () => {};
    const onTransition = vi.fn(() => new Promise<TransitionResult>((resolve) => (release = resolve)));
    renderBoard({ orders: [order()], onTransition });
    fireEvent.click(screen.getByRole('button', { name: '受ける' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '受ける' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '受ける' }));
    expect(onTransition).toHaveBeenCalledTimes(1);
    await act(async () => release({ ok: true }));
    expect(screen.getByRole('button', { name: '受ける' })).toBeEnabled();
  });
});

describe('取消し（理由が必須）', () => {
  it('「取消し」を押すと理由の入力が出る。空のまま確定はできず、API（transition）を呼ばない', async () => {
    const onTransition = renderBoard({ orders: [order()] });
    fireEvent.click(screen.getByRole('button', { name: '取消し' }));
    expect(screen.getByLabelText('取消しの理由（必須）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消しを確定する' }));
    expect(await screen.findByText('取消しの理由を入力してください')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('取消しの理由（必須）'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '取消しを確定する' }));
    expect(onTransition).not.toHaveBeenCalled();
  });

  it('理由を入れて確定すると、cancel を reason つきで呼び、入力を閉じる', async () => {
    const onTransition = renderBoard({ orders: [order({ public_id: 'K7M2Q9XD', pickup_no: 12 })] });
    fireEvent.click(screen.getByRole('button', { name: '取消し' }));
    fireEvent.change(screen.getByLabelText('取消しの理由（必須）'), { target: { value: ' 材料切れ ' } });
    fireEvent.click(screen.getByRole('button', { name: '取消しを確定する' }));
    await waitFor(() => expect(onTransition).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', action: 'cancel', reason: '材料切れ' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('受け取り番号 12 を取り消しました'));
    expect(screen.queryByLabelText('取消しの理由（必須）')).toBeNull();
  });

  it('「やめる」で閉じる。取消しに失敗したら、入力は残す', async () => {
    const onTransition = vi.fn(async (): Promise<TransitionResult> => ({ ok: false, kind: 'invalid', message: 'この注文は取り消せません' }));
    renderBoard({ orders: [order()], onTransition });
    fireEvent.click(screen.getByRole('button', { name: '取消し' }));
    fireEvent.change(screen.getByLabelText('取消しの理由（必須）'), { target: { value: '材料切れ' } });
    fireEvent.click(screen.getByRole('button', { name: '取消しを確定する' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('この注文は取り消せません'));
    expect(screen.getByLabelText('取消しの理由（必須）')).toHaveValue('材料切れ');
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByLabelText('取消しの理由（必須）')).toBeNull();
  });
});

describe('409（他の人が先に操作した）', () => {
  it('「他の人が先に操作しました。更新します」を出し、router.refresh() で取り直す', async () => {
    const onTransition = vi.fn(async (): Promise<TransitionResult> => ({ ok: false, kind: 'conflict', message: '他の人が先に操作しました。更新します' }));
    renderBoard({ orders: [order()], onTransition });
    fireEvent.click(screen.getByRole('button', { name: '受ける' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('他の人が先に操作しました。更新します'));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it('その他の失敗は、文だけ出す。取り直しはしない', async () => {
    const onTransition = vi.fn(async (): Promise<TransitionResult> => ({ ok: false, kind: 'error', message: 'うまくいきませんでした。もう一度お試しください' }));
    renderBoard({ orders: [order()], onTransition });
    fireEvent.click(screen.getByRole('button', { name: '受ける' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('うまくいきませんでした'));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('Server Action が例外を投げても、固定の文を出す（例外の文面は出さない）', async () => {
    const onTransition = vi.fn(async (): Promise<TransitionResult> => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:8000');
    });
    renderBoard({ orders: [order()], onTransition });
    fireEvent.click(screen.getByRole('button', { name: '受ける' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('うまくいきませんでした'));
    expect(screen.getByRole('status').textContent).not.toContain('ECONNREFUSED');
  });
});

describe('店の選択（店長）と自動更新', () => {
  it('全店の店長には店の選択を出す。それ以外には出さない', () => {
    const stores = [{ id: 1, name: '居住区本店' }, { id: 2, name: '発着場中央店' }];
    const { unmount } = render(<OrderBoard orders={[]} now={NOW} stores={stores} showStoreSelect selectedStoreId={2} onTransition={okAction()} />);
    expect(screen.getByLabelText('表示する店')).toHaveValue('2');
    expect(within(screen.getByLabelText('表示する店')).getByRole('option', { name: '全店' })).toBeInTheDocument();
    unmount();
    render(<OrderBoard orders={[]} now={NOW} stores={stores} showStoreSelect={false} selectedStoreId={null} onTransition={okAction()} />);
    expect(screen.queryByLabelText('表示する店')).toBeNull();
  });

  it('「今すぐ更新」で router.refresh()', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '今すぐ更新' }));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it('更新の間隔を画面に書く（5 秒）', () => {
    renderBoard();
    expect(screen.getByText(/5 秒ごとに自動で更新/)).toBeInTheDocument();
  });
});

describe('宅配の注文（調理ボードに出る分）', () => {
  // 調理ボードの API は、宅配の注文にも delivery を付ける（contract.ts の StaffOrder は店頭だけの型なので、形を合わせて渡す）
  // 注文の骨格は店頭の order()（調理ボードの StaffOrder）で、宅配の項目（delivery）だけ dispatchOrder から借りる
  const deliveryOrder = (over: NonNullable<Parameters<typeof dispatchOrder>[0]> & { placed_at?: string } = {}) => {
    const { placed_at = '2026-11-21T02:54:00Z', ...rest } = over;
    const d = dispatchOrder(rest);
    const base = order({
      public_id: d.public_id,
      pickup_no: d.pickup_no,
      status: d.status as StaffOrder['status'],
      allowed_actions: d.allowed_actions as StaffOrder['allowed_actions'],
      placed_at,
    });
    return { ...base, fulfillment: 'delivery', delivery: d.delivery } as unknown as StaffOrder;
  };

  it('「宅配」の印・配達の状態・枠の時刻を出す。店頭の注文には出さない', () => {
    renderBoard({ orders: [deliveryOrder({ public_id: 'A0000001', pickup_no: 1 }), order({ public_id: 'A0000002', pickup_no: 2 })] });
    const d = screen.getByRole('article', { name: '受け取り番号 1' });
    expect(within(d).getByText('宅配')).toBeInTheDocument();
    expect(within(d).getByText('割り当て待ち', { selector: '.tag' })).toBeInTheDocument();
    expect(within(d).getByText('枠 13:00〜13:30')).toBeInTheDocument();
    const p = screen.getByRole('article', { name: '受け取り番号 2' });
    expect(within(p).queryByText('宅配')).toBeNull();
    expect(within(p).queryByText(/^枠 /)).toBeNull();
  });

  it('枠は店のローカル時刻（utcOffsetHours）で出す。別の日の枠は月/日つき', () => {
    renderBoard({
      utcOffsetHours: 0,
      orders: [
        deliveryOrder({ public_id: 'A0000001', pickup_no: 1 }),
        deliveryOrder({ public_id: 'A0000002', pickup_no: 2, delivery: { slot: { id: 42, starts_at: '2026-11-22T04:00:00Z', ends_at: '2026-11-22T04:30:00Z' } } }),
      ],
    });
    expect(within(screen.getByRole('article', { name: '受け取り番号 1' })).getByText('枠 04:00〜04:30')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: '受け取り番号 2' })).getByText('枠 11/22 04:00〜04:30')).toBeInTheDocument();
  });

  it('宅配の注文に、渡し済み（complete）の操作を出さない。API が allowed_actions から外すので、画面は列から決めない', () => {
    // 準備完了の列にいる宅配の注文: allowed_actions は ['assign', 'cancel']（complete が無い）。assign は配車ボードの操作なので、ここでは出さない
    renderBoard({ orders: [deliveryOrder({ status: 'ready', allowed_actions: ['assign', 'cancel'] })] });
    const card = screen.getByRole('article', { name: '受け取り番号 12' });
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['取消し']);
    expect(within(card).queryByRole('button', { name: '渡した' })).toBeNull();
    expect(within(card).getByRole('link', { name: '配車で割り当てる' })).toHaveAttribute('href', '/staff/dispatch');
  });

  it('準備完了より前（受付待ちなど）の宅配の注文も、同じ操作（受ける・調理開始など）が出る。配車のリンクは ready だけ', () => {
    renderBoard({ orders: [deliveryOrder({ status: 'paid', allowed_actions: ['accept', 'cancel'], delivery: { status: 'pending' } })] });
    const card = screen.getByRole('article', { name: '受け取り番号 12' });
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['受ける', '取消し']);
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('配達の状態の印は、割り当てが始まる ready から出す。受付〜調理中の「割り当て待ち」（delivery.status = pending）は出さない', () => {
    renderBoard({
      orders: [
        deliveryOrder({ public_id: 'A0000001', pickup_no: 1, status: 'paid', allowed_actions: ['accept', 'cancel'], delivery: { status: 'pending' } }),
        deliveryOrder({ public_id: 'A0000002', pickup_no: 2, status: 'preparing', allowed_actions: ['ready', 'cancel'], delivery: { status: 'pending' } }),
        deliveryOrder({ public_id: 'A0000003', pickup_no: 3, status: 'ready', allowed_actions: ['assign', 'cancel'], delivery: { status: 'pending' } }),
      ],
    });
    for (const no of [1, 2]) {
      const c = screen.getByRole('article', { name: `受け取り番号 ${no}` });
      expect(within(c).getByText('宅配')).toBeInTheDocument();
      expect(within(c).queryByText('割り当て待ち')).toBeNull();
      expect(within(c).getByText(/^枠 /)).toBeInTheDocument();
    }
    expect(within(screen.getByRole('article', { name: '受け取り番号 3' })).getByText('割り当て待ち', { selector: '.tag' })).toBeInTheDocument();
  });

  it('宅配の注文は、「注文から 10 分超」で強調しない（枠の時刻で動くため）。店頭の注文は従来どおり', () => {
    renderBoard({
      orders: [
        deliveryOrder({ public_id: 'A0000001', pickup_no: 1, placed_at: '2026-11-21T01:00:00Z' }), // 2 時間以上前
        order({ public_id: 'A0000002', pickup_no: 2, placed_at: '2026-11-21T01:00:00Z' }),
      ],
    });
    const d = screen.getByRole('article', { name: '受け取り番号 1' });
    expect(within(d).queryByText('10 分超')).toBeNull();
    expect(d.closest('li')).not.toHaveClass('is-overdue');
    expect(within(d).getByText('2 時間 5 分')).toBeInTheDocument(); // 経過時間は、そのまま出す
    expect(screen.getByRole('article', { name: '受け取り番号 2' }).closest('li')).toHaveClass('is-overdue');
  });

  it('宅配の注文の取消しも、理由つきで transition を呼ぶ', async () => {
    const onTransition = renderBoard({ orders: [deliveryOrder({ status: 'ready', allowed_actions: ['assign', 'cancel'] })] });
    fireEvent.click(screen.getByRole('button', { name: '取消し' }));
    fireEvent.change(screen.getByLabelText('取消しの理由（必須）'), { target: { value: '住所が届けられない' } });
    fireEvent.click(screen.getByRole('button', { name: '取消しを確定する' }));
    await waitFor(() => expect(onTransition).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', action: 'cancel', reason: '住所が届けられない' }));
  });

  it('delivery の形が違う注文は、印を出さず、店頭の注文として描く（落とさない）', () => {
    const broken = { ...order(), delivery: { status: 'pending' } } as unknown as StaffOrder;
    renderBoard({ orders: [broken] });
    expect(screen.getByRole('article', { name: '受け取り番号 12' })).toBeInTheDocument();
    expect(screen.queryByText('宅配')).toBeNull();
  });
});

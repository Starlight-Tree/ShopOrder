import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryOutcome } from '../../../lib/staff/delivery-types';
import { courier, dispatchOrder, zone } from '../../../lib/staff/dispatch-fixtures';
import { NOW } from '../../../lib/staff/test-fixtures';
import { DispatchBoard } from './DispatchBoard';

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/staff/dispatch',
}));

const done = (message = '完了しました'): DeliveryOutcome => ({ ok: true, message });
const okAction = () => vi.fn<(input: unknown) => Promise<DeliveryOutcome>>(async () => done());

type Props = Parameters<typeof DispatchBoard>[0];

/** 既定: 店 1 の配達員 2 人（ラシード勤務中・ハッサン勤務外）と、割り当て待ちの宅配 1 件。操作はすべて成功する */
function setup(over: Partial<Props> = {}) {
  const actions = {
    onAssign: okAction(),
    onRedeliver: okAction(),
    onMockAdvance: okAction(),
    onCancel: okAction(),
    onSuspension: okAction(),
  };
  const props: Props = {
    board: { provider: 'inhouse', couriers: [courier({ id: 7, name: 'ラシード' }), courier({ id: 9, name: 'ハッサン', is_on_duty: false, active_count: 0 })], orders: [dispatchOrder()] },
    zones: [zone({ id: 1, name: '居住区', fee_lumi: 150, min_order_lumi: 600, base_minutes: 25 }), zone({ id: 2, name: '発着場' })],
    now: NOW,
    utcOffsetHours: 9,
    stores: null,
    showStoreSelect: false,
    selectedStoreId: null,
    canSuspend: false,
    ...actions,
    ...over,
  };
  render(<DispatchBoard {...props} />);
  return actions;
}

const card = (no: number) => screen.getByRole('article', { name: `受け取り番号 ${no}` });
const buttonNames = (el: HTMLElement) => within(el).queryAllByRole('button').map((b) => b.textContent);

beforeEach(() => {
  nav.refresh.mockClear();
  nav.replace.mockClear();
});

describe('列', () => {
  it('4 つの列（割り当て待ち・割り当て済み・配達中・不在・要対応）を、この順に出し、件数を付ける', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [courier()],
        orders: [
          dispatchOrder({ public_id: 'A0000001', pickup_no: 1, status: 'ready' }),
          dispatchOrder({ public_id: 'A0000002', pickup_no: 2, status: 'ready' }),
          dispatchOrder({ public_id: 'A0000003', pickup_no: 3, status: 'delivering', allowed_actions: [] }),
          dispatchOrder({ public_id: 'A0000004', pickup_no: 4, status: 'picked_up', allowed_actions: [] }),
          dispatchOrder({ public_id: 'A0000005', pickup_no: 5, status: 'delivery_failed', allowed_actions: ['redeliver', 'cancel'] }),
        ],
      },
    });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(0, 4)).toEqual(['割り当て待ち2', '割り当て済み（集荷前）0', '配達中2', '不在・要対応1']);
    expect(within(screen.getByRole('region', { name: /割り当て待ち/ })).getAllByRole('article')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: /割り当て済み/ })).getByText('なし')).toBeInTheDocument();
    const moving = screen.getByRole('region', { name: /配達中/ });
    expect(within(moving).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['受け取り番号 3', '受け取り番号 4']);
    expect(within(screen.getByRole('region', { name: /不在・要対応/ })).getByRole('article', { name: '受け取り番号 5' })).toBeInTheDocument();
  });

  it('取得に失敗したら、列の代わりに知らせを出す（再取得は続ける）。区画の欄は残る', () => {
    setup({ board: null, errorMessage: 'API に接続できません。しばらくしてから、もう一度お試しください' });
    expect(screen.getByRole('alert')).toHaveTextContent('配車ボードを読み込めませんでした');
    expect(screen.getByRole('alert')).toHaveTextContent('自動で再試行します');
    expect(screen.queryByRole('region', { name: /割り当て待ち/ })).toBeNull();
    expect(screen.getByRole('heading', { name: '砂嵐の警報' })).toBeInTheDocument();
  });
});

describe('注文のカード', () => {
  it('受け取り番号（大）・枠の時刻・区画・品・担当・提案を出す', () => {
    setup();
    const c = card(12);
    expect(within(c).getByText('12')).toHaveClass('st-pickup-no');
    expect(within(c).getByText('13:00〜13:30')).toBeInTheDocument();
    expect(within(c).getByText('区画 居住区')).toBeInTheDocument();
    expect(within(c).getByText('オアシスブレンド')).toBeInTheDocument();
    expect(within(c).getByText('M・ホット')).toBeInTheDocument();
    expect(c).toHaveTextContent('数量 2');
    expect(within(c).getByText('未割り当て')).toBeInTheDocument();
    expect(within(c).getByText('ラシード（店にいる）')).toBeInTheDocument();
    expect(within(c).getByText('割り当て待ち', { selector: '.tag' })).toBeInTheDocument();
  });

  it('枠は、今日なら時刻だけ、別の日なら月/日つき。時刻は渡された時差（LOCAL_UTC_OFFSET_HOURS）で決まる', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [],
        orders: [
          dispatchOrder({ public_id: 'A0000001', pickup_no: 1 }),
          dispatchOrder({ public_id: 'A0000002', pickup_no: 2, delivery: { slot: { id: 42, starts_at: '2026-11-22T04:00:00Z', ends_at: '2026-11-22T04:30:00Z' } } }),
        ],
      },
    });
    expect(within(card(1)).getByText('13:00〜13:30')).toBeInTheDocument();
    expect(within(card(2)).getByText('11/22 13:00〜13:30')).toBeInTheDocument();
  });

  it('時差 0 なら、同じ枠が UTC の時刻で出る', () => {
    setup({ utcOffsetHours: 0 });
    expect(within(card(12)).getByText('04:00〜04:30')).toBeInTheDocument();
  });

  it('担当の配達員・配達の状態（集荷済み）を出す', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [courier()],
        orders: [dispatchOrder({ status: 'picked_up', allowed_actions: [], suggestion: null, delivery: { status: 'picked_up', courier: { id: 7, name: 'ラシード' } } })],
      },
    });
    const c = card(12);
    expect(within(c).getByText('ラシード')).toBeInTheDocument();
    expect(within(c).getByText('集荷済み', { selector: '.tag' })).toBeInTheDocument();
    expect(within(c).queryByText('提案')).toBeNull();
  });

  it('再配達（2 回目以降）は、色だけでなく文字で出す。初回は出さない', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [],
        orders: [
          dispatchOrder({ public_id: 'A0000001', pickup_no: 1 }),
          dispatchOrder({ public_id: 'A0000002', pickup_no: 2, delivery: { attempt: 2 } }),
        ],
      },
    });
    expect(within(card(1)).queryByText(/再配達/)).toBeNull();
    expect(within(card(2)).getByText('配達 2 回目（再配達）')).toBeInTheDocument();
  });

  it('不在・要対応: 失敗の理由を出す', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [],
        orders: [dispatchOrder({ status: 'delivery_failed', suggestion: null, allowed_actions: ['redeliver', 'cancel'], delivery: { status: 'failed', failure_reason: 'absent' } })],
      },
    });
    const c = card(12);
    expect(within(c).getByText('失敗の理由')).toBeInTheDocument();
    expect(within(c).getByText('不在')).toBeInTheDocument();
    expect(within(c).getByText('配達できず', { selector: '.tag' })).toBeInTheDocument();
  });

  it('暗証コードの凍結の理由も、文で出す', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [],
        orders: [dispatchOrder({ status: 'delivery_failed', allowed_actions: ['redeliver'], delivery: { status: 'failed', failure_reason: 'pin_locked' } })],
      },
    });
    expect(within(card(12)).getByText('暗証コードの誤り（凍結）')).toBeInTheDocument();
  });

  it('住所・暗証コード・電話・氏名は出さない（API が誤って含めても、描かない）', () => {
    const leaky = {
      ...dispatchOrder(),
      address: { label: '自宅', line: 'アルカ市居住区1-4-2 305', note: '呼び鈴は 1 回' },
      pin: '4821',
      phone: '090-0000-0000',
      customer_name: '田中 太郎',
      delivery: { ...dispatchOrder().delivery, address: { line: 'アルカ市居住区1-4-2 305' }, pin: '4821' },
    };
    const { container } = render(
      <DispatchBoard
        board={{ provider: 'inhouse', couriers: [], orders: [leaky] }}
        zones={[]}
        now={NOW}
        utcOffsetHours={9}
        stores={null}
        showStoreSelect={false}
        selectedStoreId={null}
        canSuspend={false}
        onAssign={okAction()}
        onRedeliver={okAction()}
        onMockAdvance={okAction()}
        onCancel={okAction()}
        onSuspension={okAction()}
      />,
    );
    for (const secret of ['アルカ市居住区', '呼び鈴', '4821', '090-', '田中']) expect(container.textContent).not.toContain(secret);
  });

  it('全店の表示（注文・配達員が複数の店にまたがる）では、店名を添える。1 店なら添えない', () => {
    const { unmount } = render(
      <DispatchBoard
        board={{
          provider: 'inhouse',
          couriers: [courier({ id: 7, store_id: 1 }), courier({ id: 8, store_id: 2, name: 'ナジャ' })],
          orders: [dispatchOrder({ public_id: 'A0000001', pickup_no: 1 }), dispatchOrder({ public_id: 'A0000002', pickup_no: 2, store: { id: 2, name: '発着場中央店' } })],
        }}
        zones={[]}
        now={NOW}
        utcOffsetHours={9}
        stores={[{ id: 1, name: '居住区本店' }, { id: 2, name: '発着場中央店' }]}
        showStoreSelect
        selectedStoreId={null}
        canSuspend={false}
        onAssign={okAction()}
        onRedeliver={okAction()}
        onMockAdvance={okAction()}
        onCancel={okAction()}
        onSuspension={okAction()}
      />,
    );
    expect(within(card(1)).getByText('居住区本店')).toBeInTheDocument();
    expect(within(card(2)).getByText('発着場中央店')).toBeInTheDocument();
    expect(screen.getByText(/発着場中央店・担当 1 件/)).toBeInTheDocument(); // 配達員の欄にも店名
    unmount();
    setup();
    expect(within(card(12)).queryByText('居住区本店')).toBeNull();
  });
});

describe('操作ボタン（allowed_actions と provider）', () => {
  it('割り当て待ち: 配達員の選択と「割り当てる」、取消し。complete（渡した）は出さない', () => {
    setup();
    const c = card(12);
    expect(within(c).getByRole('combobox', { name: '配達員' })).toBeInTheDocument();
    expect(buttonNames(c)).toEqual(['割り当てる', '取消し']);
    expect(within(c).queryByRole('button', { name: '渡した' })).toBeNull();
  });

  it('割り当て済み: 「付け替える」。選択の名前も付け替えになる', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [courier()],
        orders: [dispatchOrder({ status: 'assigned', suggestion: null, delivery: { status: 'assigned', courier: { id: 7, name: 'ラシード' } } })],
      },
    });
    expect(within(card(12)).getByRole('combobox', { name: '担当の付け替え' })).toBeInTheDocument();
    expect(buttonNames(card(12))).toEqual(['付け替える', '取消し']);
  });

  it('不在・要対応: 「再配達する」と取消し。割り当ての選択は出ない', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [courier()],
        orders: [dispatchOrder({ status: 'delivery_failed', suggestion: null, allowed_actions: ['redeliver', 'cancel'], delivery: { status: 'failed', failure_reason: 'absent' } })],
      },
    });
    expect(buttonNames(card(12))).toEqual(['再配達する（最も早い枠）', '取消し']);
    expect(within(card(12)).queryByRole('combobox')).toBeNull();
  });

  it('許された操作が無ければ（配達中）、ボタンは出さない。API が許していない操作は、画面が足さない', () => {
    setup({ board: { provider: 'inhouse', couriers: [courier()], orders: [dispatchOrder({ status: 'delivering', allowed_actions: [], delivery: { status: 'delivering' } })] } });
    expect(buttonNames(card(12))).toEqual([]);
    expect(within(card(12)).queryByRole('combobox')).toBeNull();
  });

  it('「模擬で 1 つ進める」は、provider が mock のとき、進められる状態（割り当て待ち・割り当て済み・配達中）だけに出す', () => {
    const orders = [
      dispatchOrder({ public_id: 'A0000001', pickup_no: 1, status: 'ready' }),
      dispatchOrder({ public_id: 'A0000002', pickup_no: 2, status: 'assigned', allowed_actions: ['assign', 'cancel'], delivery: { status: 'assigned' } }),
      dispatchOrder({ public_id: 'A0000003', pickup_no: 3, status: 'delivering', allowed_actions: [], delivery: { status: 'delivering' } }),
      dispatchOrder({ public_id: 'A0000004', pickup_no: 4, status: 'delivery_failed', allowed_actions: ['redeliver', 'cancel'], delivery: { status: 'failed', failure_reason: 'absent' } }),
    ];
    setup({ board: { provider: 'mock', couriers: [courier()], orders } });
    for (const no of [1, 2, 3]) expect(within(card(no)).getByRole('button', { name: '模擬で 1 つ進める' })).toBeInTheDocument();
    expect(within(card(4)).queryByRole('button', { name: '模擬で 1 つ進める' })).toBeNull();
  });

  it('provider が mock でなければ、模擬のボタンはどこにも出ない', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [courier()],
        orders: [dispatchOrder({ status: 'delivering', allowed_actions: [] }), dispatchOrder({ public_id: 'A0000002', pickup_no: 2 })],
      },
    });
    expect(screen.queryByRole('button', { name: '模擬で 1 つ進める' })).toBeNull();
  });
});

describe('割り当て', () => {
  it('選択は、提案の配達員が初期値。他店の配達員は選択肢に無く、勤務外は選べない（文字でも示す）', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [courier({ id: 7, name: 'ラシード' }), courier({ id: 9, name: 'ハッサン', is_on_duty: false, active_count: 0 }), courier({ id: 8, store_id: 2, name: 'ナジャ' })],
        orders: [dispatchOrder()],
      },
    });
    const select = within(card(12)).getByRole('combobox', { name: '配達員' });
    expect(select).toHaveValue('7');
    const options = within(select).getAllByRole('option').map((o) => [o.textContent, (o as HTMLOptionElement).disabled]);
    expect(options).toEqual([
      ['選んでください', false],
      ['ラシード・担当 1 件', false],
      ['ハッサン（勤務外）・担当 0 件', true],
    ]);
    expect(screen.queryByRole('option', { name: /ナジャ/ })).toBeNull();
  });

  it('「割り当てる」で、{publicId, courierId} を渡し、成功の文を出す', async () => {
    const { onAssign } = setup({ board: { provider: 'inhouse', couriers: [courier({ id: 7 }), courier({ id: 10, name: 'ユスラ' })], orders: [dispatchOrder()] } });
    fireEvent.change(within(card(12)).getByRole('combobox', { name: '配達員' }), { target: { value: '10' } });
    onAssign.mockResolvedValueOnce(done('受け取り番号 12 をユスラに割り当てました'));
    fireEvent.click(within(card(12)).getByRole('button', { name: '割り当てる' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('受け取り番号 12 をユスラに割り当てました'));
    expect(onAssign).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', courierId: 10 });
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('提案がそのまま採用できる（初期値のまま押す）', async () => {
    const { onAssign } = setup();
    fireEvent.click(within(card(12)).getByRole('button', { name: '割り当てる' }));
    await waitFor(() => expect(onAssign).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', courierId: 7 }));
  });

  it('配達員を選んでいなければ、エラーを出して、API（onAssign）を呼ばない', () => {
    const { onAssign } = setup({ board: { provider: 'inhouse', couriers: [courier()], orders: [dispatchOrder({ suggestion: null })] } });
    fireEvent.click(within(card(12)).getByRole('button', { name: '割り当てる' }));
    expect(within(card(12)).getByRole('alert')).toHaveTextContent('勤務中の配達員を選んでください');
    expect(onAssign).not.toHaveBeenCalled();
    // 選び直すとエラーは消える
    fireEvent.change(within(card(12)).getByRole('combobox'), { target: { value: '7' } });
    expect(within(card(12)).queryByRole('alert')).toBeNull();
  });

  it('勤務中の配達員がいなければ、その旨を文で出し、ボタンを押せない', () => {
    setup({ board: { provider: 'inhouse', couriers: [courier({ is_on_duty: false })], orders: [dispatchOrder({ suggestion: null })] } });
    expect(within(card(12)).getByText('勤務中の配達員がいません')).toBeInTheDocument();
    expect(within(card(12)).getByRole('button', { name: '割り当てる' })).toBeDisabled();
  });

  it('担当の付け替え: 別の配達員を選んで「付け替える」', async () => {
    const { onAssign } = setup({
      board: {
        provider: 'inhouse',
        couriers: [courier({ id: 7 }), courier({ id: 10, name: 'ユスラ' })],
        orders: [dispatchOrder({ status: 'assigned', suggestion: null, delivery: { status: 'assigned', courier: { id: 7, name: 'ラシード' } } })],
      },
    });
    fireEvent.change(within(card(12)).getByRole('combobox', { name: '担当の付け替え' }), { target: { value: '10' } });
    fireEvent.click(within(card(12)).getByRole('button', { name: '付け替える' }));
    await waitFor(() => expect(onAssign).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', courierId: 10 }));
  });

  it('更新で、選んでいた配達員が勤務外になったら、押してもエラーにする（古い選択で送らない）', () => {
    const base = { provider: 'inhouse' as const, orders: [dispatchOrder({ suggestion: null })] };
    const handlers = { onAssign: okAction(), onRedeliver: okAction(), onMockAdvance: okAction(), onCancel: okAction(), onSuspension: okAction() };
    const common = { zones: [], now: NOW, utcOffsetHours: 9, stores: null, showStoreSelect: false, selectedStoreId: null, canSuspend: false, ...handlers };
    const { rerender } = render(<DispatchBoard board={{ ...base, couriers: [courier({ id: 7 })] }} {...common} />);
    fireEvent.change(screen.getByRole('combobox', { name: '配達員' }), { target: { value: '7' } });
    rerender(<DispatchBoard board={{ ...base, couriers: [courier({ id: 7, is_on_duty: false })] }} {...common} />);
    fireEvent.click(screen.getByRole('button', { name: '割り当てる' }));
    expect(handlers.onAssign).not.toHaveBeenCalled();
  });
});

describe('再配達・模擬の進行', () => {
  it('「再配達する」で onRedeliver を {publicId} で呼ぶ。枠は送らない（API が最も早い枠を選ぶ）', async () => {
    const { onRedeliver } = setup({
      board: {
        provider: 'inhouse',
        couriers: [],
        orders: [dispatchOrder({ status: 'delivery_failed', suggestion: null, allowed_actions: ['redeliver', 'cancel'], delivery: { status: 'failed', failure_reason: 'absent' } })],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /再配達する/ }));
    await waitFor(() => expect(onRedeliver).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD' }));
  });

  it('再配達できない（枠が無い・砂嵐）ときは、API の返した固定の文を出す。取り直しは、refresh の印のとき', async () => {
    const onRedeliver = vi.fn(async (): Promise<DeliveryOutcome> => ({ ok: false, kind: 'invalid', message: '再配達で選べる枠がありません。枠が空いてから、もう一度お試しください', refresh: false }));
    setup({
      board: { provider: 'inhouse', couriers: [], orders: [dispatchOrder({ status: 'delivery_failed', suggestion: null, allowed_actions: ['redeliver'], delivery: { status: 'failed' } })] },
      onRedeliver,
    });
    fireEvent.click(screen.getByRole('button', { name: /再配達する/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('再配達で選べる枠がありません'));
    expect(screen.getByRole('status')).toHaveTextContent('操作できませんでした');
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('「模擬で 1 つ進める」で onMockAdvance を {publicId} で呼び、結果の文を出す', async () => {
    const onMockAdvance = vi.fn(async (): Promise<DeliveryOutcome> => done('受け取り番号 12 を模擬で 1 つ進めました'));
    setup({ board: { provider: 'mock', couriers: [courier()], orders: [dispatchOrder()] }, onMockAdvance });
    fireEvent.click(screen.getByRole('button', { name: '模擬で 1 つ進める' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('受け取り番号 12 を模擬で 1 つ進めました'));
    expect(onMockAdvance).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD' });
  });
});

describe('取消し（理由が必須）', () => {
  it('「取消し」で理由の入力が出る。空のまま確定はできず、onCancel を呼ばない', async () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: '取消し' }));
    expect(screen.getByLabelText('取消しの理由（必須）')).toBeInTheDocument();
    expect(screen.getByText(/枠の確保の取り消し/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消しを確定する' }));
    expect(await screen.findByText('取消しの理由を入力してください')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('取消しの理由（必須）'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '取消しを確定する' }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('理由を入れて確定すると、{publicId, reason} で呼び、入力を閉じる', async () => {
    const onCancel = vi.fn(async (): Promise<DeliveryOutcome> => done('注文を取り消しました'));
    setup({ onCancel });
    fireEvent.click(screen.getByRole('button', { name: '取消し' }));
    fireEvent.change(screen.getByLabelText('取消しの理由（必須）'), { target: { value: ' お客さまの連絡 ' } });
    fireEvent.click(screen.getByRole('button', { name: '取消しを確定する' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', reason: 'お客さまの連絡' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('注文を取り消しました'));
    expect(screen.queryByLabelText('取消しの理由（必須）')).toBeNull();
  });

  it('取消しに失敗したら、入力は残す。「やめる」で閉じる', async () => {
    const onCancel = vi.fn(async (): Promise<DeliveryOutcome> => ({ ok: false, kind: 'invalid', message: 'この注文は取り消せません', refresh: false }));
    setup({ onCancel });
    fireEvent.click(screen.getByRole('button', { name: '取消し' }));
    fireEvent.change(screen.getByLabelText('取消しの理由（必須）'), { target: { value: '連絡' } });
    fireEvent.click(screen.getByRole('button', { name: '取消しを確定する' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('この注文は取り消せません'));
    expect(screen.getByLabelText('取消しの理由（必須）')).toHaveValue('連絡');
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByLabelText('取消しの理由（必須）')).toBeNull();
  });
});

describe('他の人が先に操作した（409）・二重送信・例外', () => {
  it('refresh の印がある失敗は、文を出して router.refresh() で取り直す', async () => {
    const onAssign = vi.fn(async (): Promise<DeliveryOutcome> => ({ ok: false, kind: 'conflict', message: '他の人が先に操作しました。更新します', refresh: true }));
    setup({ onAssign });
    fireEvent.click(screen.getByRole('button', { name: '割り当てる' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('他の人が先に操作しました。更新します'));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it('処理中は、ボード全体の操作ボタンを押せない。同じ操作を 2 回呼ばない', async () => {
    let release: (r: DeliveryOutcome) => void = () => {};
    const onAssign = vi.fn(() => new Promise<DeliveryOutcome>((resolve) => (release = resolve)));
    setup({
      board: { provider: 'mock', couriers: [courier()], orders: [dispatchOrder({ public_id: 'A0000001', pickup_no: 1 }), dispatchOrder({ public_id: 'A0000002', pickup_no: 2 })] },
      onAssign,
      canSuspend: true,
    });
    fireEvent.click(within(card(1)).getByRole('button', { name: '割り当てる' }));
    await waitFor(() => expect(within(card(1)).getByRole('button', { name: '割り当てる' })).toBeDisabled());
    // 別の注文・区画の操作も止まる（実行中の結果の文が、上書きされない）
    expect(within(card(2)).getByRole('button', { name: '割り当てる' })).toBeDisabled();
    expect(within(card(2)).getByRole('button', { name: '模擬で 1 つ進める' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '居住区の警報を立てる' })).toBeDisabled();
    fireEvent.click(within(card(1)).getByRole('button', { name: '割り当てる' }));
    expect(onAssign).toHaveBeenCalledTimes(1);
    await act(async () => release(done()));
    expect(within(card(1)).getByRole('button', { name: '割り当てる' })).toBeEnabled();
  });

  it('Server Action が例外を投げても、固定の文を出す（例外の文面は出さない）', async () => {
    const onMockAdvance = vi.fn(async (): Promise<DeliveryOutcome> => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:8000');
    });
    setup({ board: { provider: 'mock', couriers: [courier()], orders: [dispatchOrder()] }, onMockAdvance });
    fireEvent.click(screen.getByRole('button', { name: '模擬で 1 つ進める' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('うまくいきませんでした'));
    expect(screen.getByRole('status').textContent).not.toContain('ECONNREFUSED');
    expect(screen.getByRole('button', { name: '模擬で 1 つ進める' })).toBeEnabled();
  });
});

describe('配達員の一覧（ボードの脇）', () => {
  it('名前・勤務中か（文字で）・担当の件数・最後にいた区画・乗り物を出す', () => {
    setup({
      board: {
        provider: 'inhouse',
        couriers: [
          courier({ id: 7, name: 'ラシード', active_count: 2, zone: { id: 1, name: '居住区' } }),
          courier({ id: 9, name: 'ハッサン', is_on_duty: false, active_count: 0, zone: null }),
        ],
        orders: [],
      },
    });
    const panel = screen.getByRole('region', { name: /配達員/ });
    const items = within(panel).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('ラシード勤務中担当 2 件・最後にいた区画 居住区・浮上スクーター');
    expect(items[1]).toHaveTextContent('ハッサン勤務外担当 0 件・最後にいた区画 不明・浮上スクーター');
  });

  it('配達員がいなければ、その旨', () => {
    setup({ board: { provider: 'inhouse', couriers: [], orders: [] } });
    expect(within(screen.getByRole('region', { name: /配達員/ })).getByText('配達員がいません')).toBeInTheDocument();
  });
});

describe('砂嵐の警報（区画の停止）', () => {
  const zones = [
    zone({ id: 1, name: '居住区', fee_lumi: 150, free_over_lumi: 2000, min_order_lumi: 600, base_minutes: 25 }),
    zone({ id: 2, name: '発着場', is_suspended: true }),
  ];

  it('状態は全員に、色だけでなく文字で見せる。区画の条件（送料・最低注文額など）も出す', () => {
    setup({ zones, canSuspend: false });
    const panel = screen.getByRole('region', { name: '砂嵐の警報' });
    const [calm, storm] = within(panel).getAllByRole('listitem');
    expect(calm).toHaveTextContent('居住区');
    expect(calm).toHaveTextContent('受付中');
    expect(calm).toHaveTextContent('送料 150 ルミ・2,000 ルミ以上で無料・最低注文 600 ルミ・基準 25 分');
    expect(storm).toHaveTextContent('警報中（受付停止）');
  });

  it('店長以外（canSuspend でない）には、立てる・解除する操作を出さない（その旨の説明だけ）', () => {
    setup({ zones, canSuspend: false });
    const panel = screen.getByRole('region', { name: '砂嵐の警報' });
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
    expect(panel).toHaveTextContent('店長だけができます');
  });

  it('店長: 警報を立てるときは、全店への影響を示して確かめてから、{zoneId, suspended: true} で呼ぶ', async () => {
    const { onSuspension } = setup({ zones, canSuspend: true });
    fireEvent.click(screen.getByRole('button', { name: '居住区の警報を立てる' }));
    expect(onSuspension).not.toHaveBeenCalled(); // 押しただけでは立てない
    expect(screen.getByRole('group', { name: '居住区の警報の確認' })).toHaveTextContent('全店で、この区画への宅配を受け付けなくなります');
    fireEvent.click(screen.getByRole('button', { name: '警報を立てて受付を止める' }));
    await waitFor(() => expect(onSuspension).toHaveBeenCalledWith({ zoneId: 1, suspended: true }));
    await waitFor(() => expect(screen.queryByRole('group', { name: '居住区の警報の確認' })).toBeNull());
  });

  it('店長: 確認で「やめる」なら、立てない', () => {
    const { onSuspension } = setup({ zones, canSuspend: true });
    fireEvent.click(screen.getByRole('button', { name: '居住区の警報を立てる' }));
    fireEvent.click(within(screen.getByRole('group', { name: '居住区の警報の確認' })).getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('group', { name: '居住区の警報の確認' })).toBeNull();
    expect(onSuspension).not.toHaveBeenCalled();
  });

  it('店長: 警報中の区画は、すぐ「解除する」（確認なし）。{zoneId, suspended: false} で呼ぶ', async () => {
    const onSuspension = vi.fn(async (): Promise<DeliveryOutcome> => done('発着場の砂嵐の警報を解除しました'));
    setup({ zones, canSuspend: true, onSuspension });
    fireEvent.click(screen.getByRole('button', { name: '発着場の警報を解除する' }));
    await waitFor(() => expect(onSuspension).toHaveBeenCalledWith({ zoneId: 2, suspended: false }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('発着場の砂嵐の警報を解除しました'));
  });

  it('店長でも、API が拒んだ（403）ら、固定の文を出す（画面の絞りを権限の根拠にしない）', async () => {
    const onSuspension = vi.fn(async (): Promise<DeliveryOutcome> => ({ ok: false, kind: 'forbidden', message: 'この操作をする権限がありません', refresh: false }));
    setup({ zones, canSuspend: true, onSuspension });
    fireEvent.click(screen.getByRole('button', { name: '発着場の警報を解除する' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('この操作をする権限がありません'));
  });

  it('区画が読めなかったら、その旨を出す。届ける区画が無ければ、その旨', () => {
    const { unmount } = render(
      <DispatchBoard
        board={{ provider: 'inhouse', couriers: [], orders: [] }}
        zones={null}
        now={NOW}
        utcOffsetHours={9}
        stores={null}
        showStoreSelect={false}
        selectedStoreId={null}
        canSuspend
        onAssign={okAction()}
        onRedeliver={okAction()}
        onMockAdvance={okAction()}
        onCancel={okAction()}
        onSuspension={okAction()}
      />,
    );
    expect(screen.getByText(/区画の状態を読み込めませんでした/)).toBeInTheDocument();
    unmount();
    setup({ zones: [] });
    expect(screen.getByText('届ける区画がありません')).toBeInTheDocument();
  });
});

describe('店の選択（全店の店長）と自動更新', () => {
  it('全店の店長には店の選択を出す。それ以外には出さない', () => {
    const stores = [{ id: 1, name: '居住区本店' }, { id: 2, name: '発着場中央店' }];
    const { unmount } = render(
      <DispatchBoard
        board={{ provider: 'inhouse', couriers: [], orders: [] }}
        zones={[]}
        now={NOW}
        utcOffsetHours={9}
        stores={stores}
        showStoreSelect
        selectedStoreId={2}
        canSuspend
        onAssign={okAction()}
        onRedeliver={okAction()}
        onMockAdvance={okAction()}
        onCancel={okAction()}
        onSuspension={okAction()}
      />,
    );
    expect(screen.getByLabelText('表示する店')).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(nav.replace).toHaveBeenCalledWith('/staff/dispatch?store=2');
    unmount();
    setup();
    expect(screen.queryByLabelText('表示する店')).toBeNull();
  });

  it('「今すぐ更新」で router.refresh()。更新の間隔（5 秒）を画面に書く', () => {
    setup();
    expect(screen.getByText(/5 秒ごとに自動で更新/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '今すぐ更新' }));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADDRESS, delivery, NOW } from '../../lib/staff/courier-test-fixtures';
import type { CourierActionInput, DeliveryOutcome } from '../../lib/staff/delivery-types';
import { CourierBoard, OK_NOTICE_MS } from './CourierBoard';

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, usePathname: () => '/staff/courier' }));

type Act = (input: CourierActionInput) => Promise<DeliveryOutcome>;
const okAct = (message = '完了しました') => vi.fn<Act>(async () => ({ ok: true, message }));
const ng = (message: string, refresh: boolean, kind: 'invalid' | 'conflict' | 'error' = 'invalid'): DeliveryOutcome => ({ ok: false, kind, message, refresh });

type Over = Partial<Parameters<typeof CourierBoard>[0]>;
function renderBoard(over: Over = {}) {
  const onAct = over.onAct ?? okAct();
  render(<CourierBoard deliveries={[]} now={NOW} offsetHours={9} onAct={onAct} {...over} />);
  return onAct as ReturnType<typeof okAct>;
}

const delivering = (over = {}) =>
  delivery({ status: 'delivering', address: { ...ADDRESS }, pin_attempts_left: 5, allowed_actions: ['deliver', 'fail'], ...over });

/** 暗証コードの欄を開く（「到着・暗証コードで確認」を押す） */
function openPinPanel() {
  fireEvent.click(screen.getByRole('button', { name: '到着・暗証コードで確認' }));
  return screen.getByLabelText(/暗証コード（4 桁）/) as HTMLInputElement;
}

beforeEach(() => {
  nav.refresh.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('一覧とカードの中身', () => {
  it('担当が無ければ、空の状態を出す（カードなし）', () => {
    renderBoard({ deliveries: [] });
    expect(screen.getByText('いま担当の配達はありません')).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('取得に失敗したら、一覧の代わりに知らせを出す（再取得は続ける）', () => {
    renderBoard({ deliveries: null, errorMessage: 'API に接続できません。しばらくしてから、もう一度お試しください' });
    expect(screen.getByRole('alert')).toHaveTextContent('配達を読み込めませんでした');
    expect(screen.getByRole('alert')).toHaveTextContent('自動で再試行します');
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('取り直しが 1 回失敗しても、取れていた一覧を出し続ける。入力中の欄・入力値・住所も消えない', () => {
    const board = (deliveries: Parameters<typeof CourierBoard>[0]['deliveries'], errorMessage?: string) => (
      <CourierBoard deliveries={deliveries} errorMessage={errorMessage} now={NOW} offsetHours={9} onAct={okAct()} />
    );
    const view = render(board([delivering()]));
    const input = openPinPanel();
    fireEvent.change(input, { target: { value: '48' } });

    view.rerender(board(null, 'API に接続できません。しばらくしてから、もう一度お試しください'));
    expect(screen.getByRole('article', { name: '受け取り番号 12' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'お届け先' })).toHaveTextContent('アルカ市発着場2-1-5 305');
    expect(screen.getByLabelText(/暗証コード（4 桁）/)).toBe(input); // 作り直されていない
    expect(input.value).toBe('48');
    expect(screen.getByRole('alert')).toHaveTextContent('最新の配達を読み込めませんでした');
    expect(screen.getByRole('alert')).toHaveTextContent('API に接続できません');
    expect(screen.getByRole('alert')).toHaveTextContent('表示は、少し前の内容です');

    // 次の取得が成功したら、知らせは消え、一覧は新しい内容になる（入力は残る）
    view.rerender(board([delivering({ pickup_no: 12, pin_attempts_left: 4 })]));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('残り 4 回')).toBeInTheDocument();
    expect((screen.getByLabelText(/暗証コード（4 桁）/) as HTMLInputElement).value).toBe('48');
  });

  it('最初から取れていなければ、一覧の代わりに知らせだけ（古い一覧は無い）。取れたら一覧に変わる', () => {
    const view = render(<CourierBoard deliveries={null} errorMessage="API に接続できません" now={NOW} offsetHours={9} onAct={okAct()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('配達を読み込めませんでした');
    expect(screen.queryByText('表示は、少し前の内容です。自動で再試行します。')).toBeNull();
    view.rerender(<CourierBoard deliveries={[delivery()]} now={NOW} offsetHours={9} onAct={okAct()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('取れていた一覧が空でも、失敗の知らせを出す（空の状態も、少し前の内容と分かるように）', () => {
    const view = render(<CourierBoard deliveries={[]} now={NOW} offsetHours={9} onAct={okAct()} />);
    view.rerender(<CourierBoard deliveries={null} errorMessage="x" now={NOW} offsetHours={9} onAct={okAct()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('最新の配達を読み込めませんでした');
    expect(screen.getByText('いま担当の配達はありません')).toBeInTheDocument();
  });

  it('受け取り番号・店・区画・枠の時刻（今日は日付なし）・品・状態を出す', () => {
    renderBoard({ deliveries: [delivery()] });
    const card = screen.getByRole('article', { name: '受け取り番号 12' });
    expect(within(card).getByText('12')).toHaveClass('cr-pickup-no');
    expect(within(card).getByText('居住区本店')).toBeInTheDocument();
    expect(within(card).getByText('発着場')).toBeInTheDocument();
    expect(within(card).getByText('13:00〜13:30')).toBeInTheDocument(); // 04:00Z = 13:00（+9）
    expect(within(card).getByText('オアシスブレンド')).toBeInTheDocument();
    expect(within(card).getByText('M・ホット')).toBeInTheDocument();
    expect(card).toHaveTextContent('数量 2');
    expect(within(card).getByText('集荷待ち')).toBeInTheDocument(); // 状態は文字で
  });

  it('別の日の枠は、日付を付ける。時差は offsetHours に従う', () => {
    renderBoard({ deliveries: [delivery({ slot: { id: 1, starts_at: '2026-11-22T04:00:00Z', ends_at: '2026-11-22T04:30:00Z' } })] });
    expect(screen.getByText('11/22 13:00〜13:30')).toBeInTheDocument();
  });

  it('API の順（枠の開始が早い順）のまま並べる', () => {
    renderBoard({
      deliveries: [delivery({ public_id: 'A0000001', pickup_no: 7 }), delivery({ public_id: 'A0000002', pickup_no: 3 })],
    });
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['受け取り番号 7', '受け取り番号 3']);
  });

  it('フード（サイズ・温度が "-"）は、"-" を出さない', () => {
    renderBoard({ deliveries: [delivery({ items: [{ name: 'ホットサンド', size: '-', temperature: '-', qty: 1 }] })] });
    expect(screen.getByRole('article').textContent).not.toContain('-');
  });
});

describe('住所は集荷後だけ（API が出さないものを、画面も出さない）', () => {
  it('集荷前（address が null）は、住所の欄そのものが無い', () => {
    renderBoard({ deliveries: [delivery({ status: 'assigned', address: null })] });
    expect(screen.queryByRole('region', { name: 'お届け先' })).toBeNull();
    expect(document.body.textContent).not.toContain(ADDRESS.line);
  });

  it('集荷後は、label・line・note を出す', () => {
    renderBoard({ deliveries: [delivery({ status: 'picked_up', address: { ...ADDRESS }, allowed_actions: ['depart'] })] });
    const address = screen.getByRole('region', { name: 'お届け先' });
    expect(address).toHaveTextContent('自宅');
    expect(address).toHaveTextContent('アルカ市発着場2-1-5 305');
    expect(address).toHaveTextContent('メモ呼び鈴は 1 回');
  });

  it('note が無ければ、メモの行を出さない', () => {
    renderBoard({ deliveries: [delivery({ status: 'picked_up', address: { label: '自宅', line: 'アルカ市発着場2-1-5 305', note: null }, allowed_actions: ['depart'] })] });
    expect(screen.getByRole('region', { name: 'お届け先' })).not.toHaveTextContent('メモ');
  });
});

describe('ボタンは allowed_actions から', () => {
  it('assigned: 「集荷した」だけ。押すと pickup を送り、成功の文を出す', async () => {
    const onAct = renderBoard({ deliveries: [delivery()], onAct: okAct('受け取り番号 12: 集荷しました。お届け先が表示されます') });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['今すぐ更新', '集荷した']);
    fireEvent.click(screen.getByRole('button', { name: '集荷した' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('集荷しました'));
    expect(onAct).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', action: 'pickup' });
    expect(screen.getByRole('status')).toHaveTextContent('完了'); // 結果は文字で（色だけにしない）
  });

  it('picked_up: 「出発する」だけ。押すと depart を送る', async () => {
    const onAct = renderBoard({ deliveries: [delivery({ status: 'picked_up', address: { ...ADDRESS }, allowed_actions: ['depart'] })] });
    fireEvent.click(screen.getByRole('button', { name: '出発する' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', action: 'depart' }));
  });

  it('delivering: 「到着・暗証コードで確認」と「不在・受け取れない」。店の操作（assign・cancel）は出ない', () => {
    renderBoard({ deliveries: [delivering({ allowed_actions: ['deliver', 'fail', 'assign', 'cancel'] })] });
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['今すぐ更新', '到着・暗証コードで確認', '不在・受け取れない']);
  });

  it('操作がない状態（allowed_actions が空）は、ボタンなし', () => {
    renderBoard({ deliveries: [delivery({ allowed_actions: [] })] });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['今すぐ更新']);
  });

  it('操作の途中は、全部のボタンを止め、同じ操作を 2 回送らない（二重送信の防止）', async () => {
    let finish: (o: DeliveryOutcome) => void = () => {};
    const onAct = vi.fn<Act>(() => new Promise<DeliveryOutcome>((resolve) => (finish = resolve)));
    renderBoard({ deliveries: [delivery(), delivery({ public_id: 'B0000002', pickup_no: 13 })], onAct });
    const [first, second] = screen.getAllByRole('button', { name: '集荷した' });
    fireEvent.click(first!);
    fireEvent.click(first!);
    fireEvent.click(second!);
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: '集荷した' }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    finish({ ok: true, message: '済み' });
    await waitFor(() => expect(screen.getAllByRole('button', { name: '集荷した' }).every((b) => !(b as HTMLButtonElement).disabled)).toBe(true));
  });

  it('操作が例外で終わっても、固定の文だけを出す（例外の文字列を出さない）', async () => {
    const onAct = vi.fn<Act>(async () => {
      throw new Error('connect ECONNREFUSED /app/secret/path');
    });
    renderBoard({ deliveries: [delivery()], onAct });
    fireEvent.click(screen.getByRole('button', { name: '集荷した' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('うまくいきませんでした'));
    expect(document.body.textContent).not.toContain('ECONNREFUSED');
    expect(document.body.textContent).not.toContain('/app/secret');
  });
});

describe('結果と、画面の取り直し（refresh の印）', () => {
  it('他の人が先に操作した（refresh: true）: 文を出して、画面を取り直す', async () => {
    renderBoard({ deliveries: [delivery()], onAct: vi.fn<Act>(async () => ng('配達の状態が変わりました。更新します', true, 'conflict')) });
    fireEvent.click(screen.getByRole('button', { name: '集荷した' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('配達の状態が変わりました。更新します'));
    expect(screen.getByRole('status')).toHaveTextContent('操作できませんでした');
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it('refresh: false（接続できない・5xx など）は、取り直さない', async () => {
    renderBoard({ deliveries: [delivery()], onAct: vi.fn<Act>(async () => ng('API に接続できません', false, 'error')) });
    fireEvent.click(screen.getByRole('button', { name: '集荷した' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('API に接続できません'));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('成功は、取り直しを画面から呼ばない（Server Action が一覧を最新にする）', async () => {
    renderBoard({ deliveries: [delivery()] });
    fireEvent.click(screen.getByRole('button', { name: '集荷した' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('完了しました'));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('失敗の文にも、どの配達かを付ける（複数の担当があっても、上に出る文が、どのカードの結果か分かる）', async () => {
    const onAct = vi.fn<Act>(async () => ng('暗証コードが違います。残り 4 回', true));
    renderBoard({ deliveries: [delivering(), delivering({ public_id: 'B0000002', pickup_no: 13 })], onAct });
    const second = screen.getByRole('article', { name: '受け取り番号 13' });
    fireEvent.click(within(second).getByRole('button', { name: '到着・暗証コードで確認' }));
    fireEvent.change(within(second).getByLabelText(/暗証コード（4 桁）/), { target: { value: '0000' } });
    fireEvent.click(within(second).getByRole('button', { name: '暗証コードを確認して完了' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('受け取り番号 13: 暗証コードが違います。残り 4 回'));
    expect(onAct).toHaveBeenCalledWith({ publicId: 'B0000002', action: 'deliver', pin: '0000' });
  });

  it('例外で終わった失敗の文にも、番号が付く', async () => {
    renderBoard({
      deliveries: [delivery()],
      onAct: vi.fn<Act>(async () => {
        throw new Error('x');
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: '集荷した' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('受け取り番号 12: うまくいきませんでした'));
  });

  it('成功の文は、数秒で消える（画面の上に出しっぱなしにしない）。次の文は、前の文の時間で消えない', async () => {
    vi.useFakeTimers();
    renderBoard({ deliveries: [delivery()], onAct: okAct('受け取り番号 12: 集荷しました') });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '集荷した' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('集荷しました');
    act(() => {
      vi.advanceTimersByTime(OK_NOTICE_MS - 1);
    });
    expect(screen.getByRole('status')).toHaveTextContent('集荷しました');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '集荷した' })); // 2 回目: 時間は、ここから数え直す
    });
    act(() => {
      vi.advanceTimersByTime(OK_NOTICE_MS - 1);
    });
    expect(screen.getByRole('status')).toHaveTextContent('集荷しました');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement(); // 領域は残す（読み上げのため）
  });

  it('失敗の文は、時間では消えず、「閉じる」で消せる', async () => {
    vi.useFakeTimers();
    renderBoard({ deliveries: [delivery()], onAct: vi.fn<Act>(async () => ng('配達の状態が変わりました。更新します', true, 'conflict')) });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '集荷した' }));
    });
    act(() => {
      vi.advanceTimersByTime(OK_NOTICE_MS * 10);
    });
    expect(screen.getByRole('status')).toHaveTextContent('配達の状態が変わりました');
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('成功の文には「閉じる」を付けない', async () => {
    renderBoard({ deliveries: [delivery()] });
    fireEvent.click(screen.getByRole('button', { name: '集荷した' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('完了しました'));
    expect(screen.queryByRole('button', { name: '閉じる' })).toBeNull();
  });

  it('「今すぐ更新」で取り直す', () => {
    renderBoard({ deliveries: [] });
    fireEvent.click(screen.getByRole('button', { name: '今すぐ更新' }));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it('自動更新の案内（5 秒ごと）を出す', () => {
    renderBoard();
    expect(screen.getByText('5 秒ごとに自動で更新します')).toBeInTheDocument();
  });
});

describe('暗証コードの入力', () => {
  it('欄は、ボタンを押すまで出ない。押すと出て、残りの回数が見える。もう一度押すと閉じる', () => {
    renderBoard({ deliveries: [delivering()] });
    expect(screen.queryByLabelText(/暗証コード（4 桁）/)).toBeNull();
    const button = screen.getByRole('button', { name: '到着・暗証コードで確認' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    const input = openPinPanel();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('残り 5 回')).toBeInTheDocument();
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'off');
    fireEvent.click(button);
    expect(screen.queryByLabelText(/暗証コード（4 桁）/)).toBeNull();
  });

  it('残りが 1 回なら、止まることを文字で示す', () => {
    renderBoard({ deliveries: [delivering({ pin_attempts_left: 1 })] });
    openPinPanel();
    expect(screen.getByText('残り 1 回（間違えると配達が止まります）')).toBeInTheDocument();
  });

  it('全角・前後の空白を整えて deliver を送る。送ったあと、入力は空になり、欄は閉じる', async () => {
    const onAct = renderBoard({ deliveries: [delivering()] });
    const input = openPinPanel();
    fireEvent.change(input, { target: { value: ' ４８２１ ' } });
    fireEvent.click(screen.getByRole('button', { name: '暗証コードを確認して完了' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', action: 'deliver', pin: '4821' }));
    await waitFor(() => expect(screen.queryByLabelText(/暗証コード（4 桁）/)).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('完了しました');
  });

  it('Enter（フォームの送信）でも送れる', async () => {
    const onAct = renderBoard({ deliveries: [delivering()] });
    const input = openPinPanel();
    fireEvent.change(input, { target: { value: '4821' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(onAct).toHaveBeenCalledTimes(1));
  });

  it('4 桁の数字でなければ、API へ送らず、その場で知らせる。入力は残す（直せるように）', () => {
    const onAct = renderBoard({ deliveries: [delivering()] });
    const input = openPinPanel();
    for (const bad of ['', '123', '12345', 'abcd', '12 34']) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: '暗証コードを確認して完了' }));
      expect(screen.getByRole('alert')).toHaveTextContent('暗証コードは 4 桁の数字で入力してください');
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '12 34' } });
    expect(input.value).toBe('12 34');
  });

  it('誤り（pin_invalid）: 残りの回数つきの文を出し、画面を取り直し、入力は空にする。欄は開いたまま', async () => {
    const onAct = vi.fn<Act>(async () => ng('暗証コードが違います。残り 4 回', true));
    renderBoard({ deliveries: [delivering()], onAct });
    const input = openPinPanel();
    fireEvent.change(input, { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: '暗証コードを確認して完了' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('暗証コードが違います。残り 4 回'));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText(/暗証コード（4 桁）/) as HTMLInputElement).value).toBe('');
  });

  it('入力 → やめる → 開き直すと、入力は空（前に入れた値を残さない）', () => {
    renderBoard({ deliveries: [delivering()] });
    const input = openPinPanel();
    fireEvent.change(input, { target: { value: '4821' } });
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByLabelText(/暗証コード（4 桁）/)).toBeNull();
    expect(openPinPanel().value).toBe('');
  });

  it('入力 → 不在の欄へ切り替え → 暗証コードの欄へ戻る、でも空。選んだ理由も、閉じれば消える', () => {
    renderBoard({ deliveries: [delivering()] });
    fireEvent.change(openPinPanel(), { target: { value: '4821' } });
    fireEvent.click(screen.getByRole('button', { name: '不在・受け取れない' }));
    fireEvent.click(screen.getByLabelText('その他'));
    expect(screen.getByLabelText('その他')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '不在・受け取れない' })); // 閉じる
    fireEvent.click(screen.getByRole('button', { name: '不在・受け取れない' })); // 開き直す
    expect(screen.getByLabelText('その他')).not.toBeChecked();
    expect(openPinPanel().value).toBe('');
    expect(document.body.innerHTML).not.toContain('4821');
  });

  it('形の誤りの知らせは、入力を直し始めたら消える（次の送信まで残さない）', () => {
    renderBoard({ deliveries: [delivering()] });
    const input = openPinPanel();
    fireEvent.change(input, { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: '暗証コードを確認して完了' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: '1234' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('誤り（pin_invalid）の後は、フォーカスが入力欄へ戻る（続けて入れ直せる）', async () => {
    renderBoard({ deliveries: [delivering()], onAct: vi.fn<Act>(async () => ng('暗証コードが違います。残り 4 回', true)) });
    const input = openPinPanel();
    fireEvent.change(input, { target: { value: '0000' } });
    const submit = screen.getByRole('button', { name: '暗証コードを確認して完了' });
    submit.focus();
    expect(submit).toHaveFocus();
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('暗証コードが違います'));
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.value).toBe('');
  });

  it('凍結（pin_locked）で、カードが一覧から消えても、文は一覧の側に残る', async () => {
    const message = '暗証コードを続けて間違えたため、この配達は止まりました。店に連絡してください';
    const onAct = vi.fn<Act>(async () => ng(message, true, 'conflict'));
    const view = render(<CourierBoard deliveries={[delivering()]} now={NOW} offsetHours={9} onAct={onAct} />);
    const input = openPinPanel();
    fireEvent.change(input, { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: '暗証コードを確認して完了' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('止まりました'));
    view.rerender(<CourierBoard deliveries={[]} now={NOW} offsetHours={9} onAct={onAct} />);
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(message);
  });

  it('暗証コードを URL・クエリに残さない: 入力に name が無く、フォームに送信先（action・method）が無い', () => {
    renderBoard({ deliveries: [delivering()] });
    const input = openPinPanel();
    expect(input).not.toHaveAttribute('name');
    const form = input.closest('form')!;
    expect(form).not.toHaveAttribute('action');
    expect(form).not.toHaveAttribute('method');
    expect(new FormData(form).has('pin')).toBe(false);
    expect([...new FormData(form).keys()]).toEqual([]);
  });

  it('入力した暗証コードが、文・属性・URL のどこにも残らない', async () => {
    renderBoard({ deliveries: [delivering()], onAct: vi.fn<Act>(async () => ng('暗証コードが違います。残り 4 回', true)) });
    const input = openPinPanel();
    fireEvent.change(input, { target: { value: '4821' } });
    fireEvent.click(screen.getByRole('button', { name: '暗証コードを確認して完了' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('暗証コードが違います'));
    expect(document.body.innerHTML).not.toContain('4821');
    expect(window.location.href).not.toContain('4821');
  });
});

describe('不在・受け取れない', () => {
  const openFail = () => fireEvent.click(screen.getByRole('button', { name: '不在・受け取れない' }));

  it('理由は 3 つの選択肢だけ（自由記述の欄が無い）', () => {
    renderBoard({ deliveries: [delivering()] });
    openFail();
    const group = screen.getByRole('group', { name: '理由を選んでください' });
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['absent', 'cannot_receive', 'other']);
    expect(within(group).getByLabelText('不在')).toBeInTheDocument();
    expect(within(group).getByLabelText('受け取れない')).toBeInTheDocument();
    expect(within(group).getByLabelText('その他')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('理由を選ばずに送ると、API へ送らず、知らせる', () => {
    const onAct = renderBoard({ deliveries: [delivering()] });
    openFail();
    fireEvent.click(screen.getByRole('button', { name: 'この理由で店へ戻す' }));
    expect(screen.getByRole('alert')).toHaveTextContent('理由を選んでください');
    expect(onAct).not.toHaveBeenCalled();
  });

  it('理由を選んで送ると fail と理由を送る。店へ戻ることを事前に示す', async () => {
    const onAct = renderBoard({ deliveries: [delivering()] });
    openFail();
    expect(screen.getByText('報告すると、この配達は止まり、店へ戻ります。')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('受け取れない'));
    fireEvent.click(screen.getByRole('button', { name: 'この理由で店へ戻す' }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({ publicId: 'K7M2Q9XD', action: 'fail', reason: 'cannot_receive' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: '理由を選んでください' })).toBeNull());
  });

  it('暗証コードの欄と不在の欄は、同時には開かない', () => {
    renderBoard({ deliveries: [delivering()] });
    openPinPanel();
    openFail();
    expect(screen.queryByLabelText(/暗証コード（4 桁）/)).toBeNull();
    expect(screen.getByRole('group', { name: '理由を選んでください' })).toBeInTheDocument();
  });

  it('カードが複数あっても、理由の選択はカードごと（同じグループにならない）', () => {
    renderBoard({ deliveries: [delivering(), delivering({ public_id: 'B0000002', pickup_no: 13 })] });
    const [a, b] = screen.getAllByRole('button', { name: '不在・受け取れない' });
    fireEvent.click(a!);
    fireEvent.click(b!);
    const groups = screen.getAllByRole('group', { name: '理由を選んでください' });
    fireEvent.click(within(groups[0]!).getByLabelText('不在'));
    fireEvent.click(within(groups[1]!).getByLabelText('その他'));
    expect(within(groups[0]!).getByLabelText('不在')).toBeChecked();
    expect(within(groups[1]!).getByLabelText('その他')).toBeChecked();
  });
});

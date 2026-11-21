import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { order, proposal } from '../../lib/shop/testing';
import type { ActionState, FormAction } from '../../lib/shop/types';
import { ActionForm } from './ActionForm';
import { CheckoutCard } from './CheckoutCard';
import { DevUserForm } from './DevUserForm';
import { LoadError } from './LoadError';
import { OrderAutoRefresh } from './OrderAutoRefresh';
import { OrderList } from './OrderList';
import { OrderStepper } from './OrderStepper';
import { OrderView } from './OrderView';
import { ReservationCountdown } from './ReservationCountdown';
import { ShopFooter } from './ShopFooter';

// useRouter() は、本物では描画のあいだ同じ object を返す。差し替えも、同じ object を返す（毎回新しくすると、effect が毎回やりなおしになる）
const nav = vi.hoisted(() => {
  const refresh = vi.fn();
  return { refresh, router: { refresh } };
});
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => nav.router }));

const noop: FormAction = async () => null;
const spyAction = (result: ActionState = null) => vi.fn<FormAction>(async () => result);

beforeEach(() => {
  nav.refresh.mockClear();
});

describe('確認カード（確定ボタンの画面）', () => {
  it('店・品・合計・店頭でお渡し・有効期限。確定ボタンは 1 つ', () => {
    render(<CheckoutCard proposal={proposal()} idempotencyKey="11111111-2222-3333-4444-555555555555" confirmAction={noop} />);
    const card = screen.getByRole('article');
    expect(within(card).getByText('居住区本店')).toBeInTheDocument();
    expect(within(card).getByText('店頭でお渡し')).toBeInTheDocument();
    expect(within(card).getByText('オアシスブレンド')).toBeInTheDocument();
    expect(within(card).getByText('M サイズ・ホット・450 ルミ × 2')).toBeInTheDocument();
    expect(within(card).getAllByText('900 ルミ').length).toBeGreaterThanOrEqual(2);
    expect(within(card).getByText(/まで有効です/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '注文を確定する' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'カートに戻る' })).toHaveAttribute('href', '/cart');
  });

  it('提案の ID と冪等キーを、フォームの隠し項目で持つ（確認画面を描いたときのキー）', () => {
    render(<CheckoutCard proposal={proposal({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })} idempotencyKey="11111111-2222-3333-4444-555555555555" confirmAction={noop} />);
    const form = screen.getByRole('button', { name: '注文を確定する' }).closest('form')!;
    expect(form.querySelector('input[name="proposal_id"]')).toHaveValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(form.querySelector('input[name="idempotency_key"]')).toHaveValue('11111111-2222-3333-4444-555555555555');
  });

  it('送信すると、確定の Server Action に冪等キーと提案の ID が渡る', async () => {
    const action = spyAction();
    render(<CheckoutCard proposal={proposal({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })} idempotencyKey="11111111-2222-3333-4444-555555555555" confirmAction={action} />);
    fireEvent.submit(screen.getByRole('button', { name: '注文を確定する' }).closest('form')!);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const form = action.mock.calls[0]![1];
    expect(form.get('idempotency_key')).toBe('11111111-2222-3333-4444-555555555555');
    expect(form.get('proposal_id')).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('409 の失敗は、固定の文と直し方のリンクで出す', async () => {
    const action = spyAction({ ok: false, message: 'カートの内容が変わりました。もう一度、注文内容を確認してください。', next: { label: '注文内容を確認しなおす', href: '/checkout' } });
    render(<CheckoutCard proposal={proposal()} idempotencyKey="11111111-2222-3333-4444-555555555555" confirmAction={action} />);
    fireEvent.submit(screen.getByRole('button', { name: '注文を確定する' }).closest('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('カートの内容が変わりました');
    expect(within(alert).getByRole('link', { name: '注文内容を確認しなおす' })).toHaveAttribute('href', '/checkout');
  });

  it('確認画面を描きなおす（キーが変わる）と、前の失敗の文は消える', async () => {
    const action = spyAction({ ok: false, message: '前の失敗' });
    const { rerender } = render(<CheckoutCard proposal={proposal()} idempotencyKey="11111111-2222-3333-4444-555555555555" confirmAction={action} />);
    fireEvent.submit(screen.getByRole('button', { name: '注文を確定する' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('前の失敗');
    rerender(<CheckoutCard proposal={proposal()} idempotencyKey="99999999-2222-3333-4444-555555555555" confirmAction={action} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ActionForm（結果の文）', () => {
  it('成功の一言は status、失敗は alert で出す', async () => {
    const { rerender } = render(
      <ActionForm action={spyAction({ ok: true, message: 'できました' })}>
        <button type="submit">送る</button>
      </ActionForm>,
    );
    fireEvent.submit(screen.getByRole('button', { name: '送る' }).closest('form')!);
    expect(await screen.findByRole('status')).toHaveTextContent('できました');
    rerender(
      <ActionForm key="2" action={spyAction({ ok: false, message: 'だめでした' })}>
        <button type="submit">送る</button>
      </ActionForm>,
    );
    fireEvent.submit(screen.getByRole('button', { name: '送る' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('だめでした');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('注文の画面', () => {
  const baseProps = { serverNow: '2026-11-21T10:00:00Z', devTools: false, payAction: noop, cancelAction: noop };
  const view = (over = {}, props = {}) => render(<OrderView order={order(over)} {...baseProps} {...props} />);

  it('placed: 受け取り番号（大きく）・お支払い待ち・支払う（模擬）・確保の残り時間・取消す', () => {
    view();
    expect(screen.getByLabelText('受け取り番号 12')).toHaveTextContent('12');
    expect(screen.getByRole('status')).toHaveTextContent('お支払い待ち');
    const pay = screen.getByRole('button', { name: '支払う（模擬）' });
    expect(pay).toBeEnabled();
    expect(pay.closest('form')!.querySelector('input[name="simulate"]')).toHaveValue('ok');
    expect(pay.closest('form')!.querySelector('input[name="public_id"]')).toHaveValue('K7M2Q9XD');
    expect(screen.getByRole('timer')).toHaveTextContent('あと 15 分 0 秒');
    expect(screen.getByRole('button', { name: '取消す' })).toBeInTheDocument();
    expect(screen.getByText(/5 秒ごとに自動で更新/)).toBeInTheDocument();
  });

  it('状態の進みは status から描く（events の文言は使わない）', () => {
    view({ status: 'preparing', can_pay: false, events: [{ to_status: 'ready', at: '2026-11-21T10:05:00Z', actor_type: 'staff', reason: 'もう完了です' }] });
    const steps = within(screen.getByRole('list', { name: '注文の進み' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent?.replace(/\s+/g, ''))).toEqual([
      'お支払い待ち（完了）', '支払い済み（完了）', 'お店が受付（完了）', '調理中（現在）', '受け取れます（これから）', '受け取り済み（これから）',
    ].map((x) => expect.stringContaining(x)));
    expect(steps[3]).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByText('もう完了です')).toBeNull();
    expect(screen.queryByRole('button', { name: '支払う（模擬）' })).toBeNull();
  });

  it('ready: 受け取れます（カウンターで番号を伝える）', () => {
    view({ status: 'ready', can_pay: false, can_cancel: false });
    expect(screen.getByRole('status')).toHaveTextContent('受け取れます');
    expect(screen.getByRole('status')).toHaveTextContent('受け取り番号');
    expect(screen.queryByRole('button', { name: '取消す' })).toBeNull();
  });

  it('completed: 全部完了。自動更新の文は出さない', () => {
    view({ status: 'completed', can_pay: false, can_cancel: false });
    expect(screen.getByRole('status')).toHaveTextContent('受け取り済み');
    expect(screen.queryByText(/秒ごとに自動で更新/)).toBeNull();
    for (const s of within(screen.getByRole('list', { name: '注文の進み' })).getAllByRole('listitem')) expect(s).toHaveTextContent('完了');
  });

  it('cancelled: 進みは出さず、別表示（理由つき）。支払いも取消しも出さない', () => {
    view({ status: 'cancelled', can_pay: false, can_cancel: false, cancel_reason: 'payment_declined', reservation_expires_at: null });
    expect(screen.queryByRole('list', { name: '注文の進み' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'この注文は取消されました' })).toBeInTheDocument();
    expect(screen.getByText('理由：お支払いに失敗したため')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '支払う（模擬）' })).toBeNull();
    expect(screen.queryByText(/秒ごとに自動で更新/)).toBeNull();
  });

  it('開発用の「支払いを失敗させる」は、devTools のときだけ（本番は出さない）', () => {
    const { unmount } = view({}, { devTools: false });
    expect(screen.queryByRole('button', { name: /支払いを失敗させる/ })).toBeNull();
    unmount();
    view({}, { devTools: true });
    const decline = screen.getByRole('button', { name: /^支払いを失敗させる（模擬）$/ });
    expect(decline.closest('form')!.querySelector('input[name="simulate"]')).toHaveValue('decline');
  });

  it('can_pay が false なら、支払いのボタンは無効（理由を出す）', () => {
    view({ can_pay: false });
    expect(screen.getByRole('button', { name: '支払う（模擬）' })).toBeDisabled();
    expect(screen.getByText(/いまはお支払いできません/)).toBeInTheDocument();
  });

  it('品・小計・合計・店頭でお渡し・知らせ（?notice=）', () => {
    view({}, { notice: 'お支払いに失敗しました（模擬）。' });
    expect(screen.getByRole('alert')).toHaveTextContent('お支払いに失敗しました（模擬）。');
    const items = screen.getByRole('heading', { name: 'ご注文の内容' }).closest('section')!;
    expect(within(items).getByText('M サイズ・ホット・450 ルミ × 2')).toBeInTheDocument();
    expect(within(items).getByText('店頭でお渡し')).toBeInTheDocument();
    expect(within(items).getByText('合計').nextSibling).toHaveTextContent('900 ルミ');
  });

  it('取消す: 1 回目は確認に変わり、2 回目で送る。やめるで戻れる', async () => {
    const cancel = spyAction();
    view({}, { cancelAction: cancel });
    fireEvent.click(screen.getByRole('button', { name: '取消す' }));
    expect(screen.getByRole('alert')).toHaveTextContent('この注文を取消します');
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.getByRole('button', { name: '取消す' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消す' }));
    fireEvent.submit(screen.getByRole('button', { name: '取消しを確定する' }).closest('form')!);
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel.mock.calls[0]![1].get('public_id')).toBe('K7M2Q9XD');
  });

  it('進みの時刻は、あった状態だけ出す（これからの状態には出さない）', () => {
    render(<OrderStepper status="paid" events={[{ to_status: 'placed', at: '2026-11-21T01:00:00Z', actor_type: 'customer', reason: null }, { to_status: 'paid', at: '2026-11-21T01:02:00Z', actor_type: 'customer', reason: null }, { to_status: 'accepted', at: '2026-11-21T01:03:00Z', actor_type: 'staff', reason: null }]} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('10:00');
    expect(items[1]).toHaveTextContent('10:02');
    expect(items[2]).not.toHaveTextContent('10:03');
  });
});

describe('確保の残り時間（クライアントのカウントダウン）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1 秒ごとに進み、0 になったら 1 回だけ再取得する', () => {
    render(<ReservationCountdown expiresAt="2026-11-21T10:00:03Z" serverNow="2026-11-21T10:00:00Z" />);
    expect(screen.getByRole('timer')).toHaveTextContent('あと 3 秒');
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByRole('timer')).toHaveTextContent('あと 2 秒');
    expect(nav.refresh).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByRole('timer')).toHaveTextContent('確保の期限が過ぎました');
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(5000));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it('ブラウザーの時計がずれていても、サーバーの時刻との差で補う', () => {
    vi.setSystemTime(new Date('2026-11-21T12:00:00Z')); // ブラウザーの時計が 2 時間進んでいる
    render(<ReservationCountdown expiresAt="2026-11-21T10:01:00Z" serverNow="2026-11-21T10:00:00Z" />);
    expect(screen.getByRole('timer')).toHaveTextContent('あと 1 分 0 秒');
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('timer')).toHaveTextContent('あと 50 秒');
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('期限を新しくしたら（再取得のあと）、新しい期限で数えなおす', () => {
    const { rerender } = render(<ReservationCountdown expiresAt="2026-11-21T10:00:01Z" serverNow="2026-11-21T10:00:00Z" />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    rerender(<ReservationCountdown expiresAt="2026-11-21T10:10:00Z" serverNow="2026-11-21T10:00:01Z" />);
    expect(screen.getByRole('timer')).toHaveTextContent('あと 9 分 59 秒');
  });

  it('時刻が読めなければ、何も出さない', () => {
    const { container } = render(<ReservationCountdown expiresAt="いつか" serverNow="2026-11-21T10:00:00Z" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('注文の自動再取得（5 秒ごと）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('進行中は 5 秒ごとに router.refresh する', () => {
    render(<OrderAutoRefresh status="preparing" />);
    act(() => void vi.advanceTimersByTime(4999));
    expect(nav.refresh).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(nav.refresh).toHaveBeenCalledTimes(3);
  });

  it('タブが見えていないときは止める。戻ったら、待たずに再取得する', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<OrderAutoRefresh status="paid" />);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(nav.refresh).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'cancelled'])('終了状態（%s）では動かさない', (status) => {
    const { container } = render(<OrderAutoRefresh status={status} />);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(nav.refresh).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('終了状態になったら止まる（再取得の結果で status が変わったとき）', () => {
    const { rerender } = render(<OrderAutoRefresh status="ready" />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    rerender(<OrderAutoRefresh status="completed" />);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it('画面を離れたら（アンマウント）止まる', () => {
    const { unmount } = render(<OrderAutoRefresh status="placed" />);
    unmount();
    act(() => void vi.advanceTimersByTime(30_000));
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});

describe('注文履歴', () => {
  it('受け取り番号・店・日時・金額・状態を、注文の画面へのリンクで出す', () => {
    render(
      <OrderList
        orders={[
          { public_id: 'K7M2Q9XD', pickup_no: 12, status: 'ready', fulfillment: 'pickup', store: { id: 1, name: '居住区本店' }, total_lumi: 1350, placed_at: '2026-11-21T01:00:00Z' },
          { public_id: 'AAAA1111', pickup_no: 3, status: 'cancelled', fulfillment: 'pickup', store: { id: 4, name: '遺跡テラス店' }, total_lumi: 480, placed_at: '2026-11-20T01:00:00Z' },
        ]}
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/orders/K7M2Q9XD', '/orders/AAAA1111']);
    expect(links[0]).toHaveTextContent('12');
    expect(links[0]).toHaveTextContent('居住区本店');
    expect(links[0]).toHaveTextContent('1,350 ルミ');
    expect(links[0]).toHaveTextContent('11/21 10:00');
    expect(links[0]).toHaveTextContent('受け取れます');
    expect(links[1]).toHaveTextContent('取消し');
  });

  it('空のときは、メニューへの案内', () => {
    render(<OrderList orders={[]} />);
    expect(screen.getByText('まだ注文がありません。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'メニューを見る' })).toHaveAttribute('href', '/');
  });
});

describe('フッター・開発用ログイン名', () => {
  it('フォームは、ログイン名・切り替える・既定に戻す。今の名前を出す', () => {
    render(
      <ShopFooter>
        <DevUserForm action={noop} current="alice-2" />
      </ShopFooter>,
    );
    const input = screen.getByLabelText('開発用ログイン名');
    expect(input).toHaveValue('alice-2');
    expect(input).toHaveAttribute('name', 'dev_user');
    expect(input).toHaveAttribute('maxlength', '40');
    expect(new RegExp(input.getAttribute('pattern')!).test('alice-2')).toBe(true);
    expect(screen.getByRole('button', { name: '切り替える' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '既定に戻す' })).toHaveAttribute('name', 'reset');
    expect(screen.getByText(/いまは alice-2/)).toBeInTheDocument();
  });

  it('名前が無ければ、既定（demo-customer）と出す。children が無ければ、注意書きだけ', () => {
    const { unmount } = render(<DevUserForm action={noop} current={undefined} />);
    expect(screen.getByText(/いまは demo-customer（既定）/)).toBeInTheDocument();
    unmount();
    render(<ShopFooter />);
    expect(screen.queryByLabelText('開発用ログイン名')).toBeNull();
    expect(screen.getByText(/データはすべてダミー/)).toBeInTheDocument();
  });

  it('送信すると、入力した名前が Server Action に渡る', async () => {
    const action = spyAction({ ok: true, message: 'ログイン名を bob にしました' });
    render(<DevUserForm action={action} current={undefined} />);
    fireEvent.change(screen.getByLabelText('開発用ログイン名'), { target: { value: 'bob' } });
    fireEvent.submit(screen.getByRole('button', { name: '切り替える' }).closest('form')!);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]![1].get('dev_user')).toBe('bob');
    expect(await screen.findByRole('status')).toHaveTextContent('ログイン名を bob にしました');
  });
});

describe('読み込みの失敗', () => {
  it('固定の文と直し方のリンク（API の message は出さない）', () => {
    render(<LoadError error={{ code: 'cart_empty', message: 'SECRET internal text' }} status={409} />);
    expect(screen.getByRole('alert')).toHaveTextContent('カートが空です');
    expect(screen.queryByText(/SECRET/)).toBeNull();
    expect(screen.getByRole('link', { name: 'メニューへ' })).toHaveAttribute('href', '/');
  });

  it('接続できない・未知の code は、汎用の固定文', () => {
    const { rerender } = render(<LoadError error={{ code: 'unreachable' }} status={0} />);
    expect(screen.getByRole('alert')).toHaveTextContent('サーバーに接続できませんでした');
    rerender(<LoadError error={{ code: 'weird', message: 'Traceback (most recent call last)' }} status={500} />);
    expect(screen.getByRole('alert')).toHaveTextContent('うまくいきませんでした');
    expect(screen.queryByText(/Traceback/)).toBeNull();
  });
});

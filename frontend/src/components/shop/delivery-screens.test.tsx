// 宅配（P2）の画面の部品: 受け取り方法・住所・時間枠の選択、確認、注文の配達の状況（暗証コード）、住所の管理
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cart, Order, OrderDelivery } from '../../lib/contract';
import { dayOptions } from '../../lib/shop/delivery-view';
import type { CartPageData } from '../../lib/shop/queries';
import { address, cart, cartDelivery, deliveryCart, deliveryOrder, deliveryProposal, order, orderDelivery, proposal, slot, slotList, store, zone } from '../../lib/shop/testing';
import type { ActionState, FormAction } from '../../lib/shop/types';
import { AddressManager } from './AddressManager';
import { CartView } from './CartView';
import { CheckoutCard } from './CheckoutCard';
import { OrderAutoRefresh } from './OrderAutoRefresh';
import { OrderList } from './OrderList';
import { OrderStepper } from './OrderStepper';
import { OrderView } from './OrderView';
import { ShopHeader } from './ShopHeader';

const nav = vi.hoisted(() => {
  const refresh = vi.fn();
  return { refresh, router: { refresh }, pathname: '/' };
});
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav.router }));

const noop: FormAction = async () => null;
const spyAction = (result: ActionState = null) => vi.fn<FormAction>(async () => result);
const NOW = Date.parse('2026-11-21T10:00:00Z'); // 店の時間帯（Asia/Tokyo）で 11/21（土）

beforeEach(() => {
  nav.refresh.mockClear();
  nav.pathname = '/';
});

// ---- カート ----

const actions = { qty: noop, fulfillment: noop, address: noop, slot: noop };

const slots = [
  slot({ id: 41 }),
  slot({ id: 42, starts_at: '2026-11-22T04:30:00Z', ends_at: '2026-11-22T05:00:00Z', remaining: 1 }),
  slot({ id: 43, starts_at: '2026-11-22T05:00:00Z', ends_at: '2026-11-22T05:30:00Z', available: false, remaining: 0, unavailable_reason: 'full' }),
  slot({ id: 44, starts_at: '2026-11-22T05:30:00Z', ends_at: '2026-11-22T06:00:00Z', available: false, remaining: 2, unavailable_reason: 'cutoff' }),
];
const addresses = [address(), address({ id: 4, label: '実家', area_code: 4, area_name: '遺跡', line: '遺跡テラス9-9' }), address({ id: 5, label: '勤務先', area_code: 1, area_name: '居住区', line: '居住区信号塔1-1' })];

function deliveryData(over: Partial<CartPageData> = {}, cartOver: Partial<Cart> = {}): CartPageData {
  return {
    cart: deliveryCart(cartOver),
    store: store(),
    zones: [zone({ id: 1, name: '居住区', area_code: 1 }), zone()],
    delivery: { addresses, days: dayOptions(NOW), date: '2026-11-22', slots: slotList({ slots }), slotsFailed: false },
    ...over,
  };
}

const renderCart = (data: CartPageData, a = actions) => render(<CartView data={data} actions={a} />);

describe('カート: 受け取り方法', () => {
  it('宅配が選択中。店頭へ切り替えるボタンは、受け取り方法を送る', () => {
    renderCart(deliveryData());
    const methods = screen.getByRole('list', { name: '受け取り方法' });
    expect(within(methods).getByText('宅配').closest('li')).toHaveTextContent('選択中');
    const toPickup = within(methods).getByRole('button', { name: '受け取り方法を店頭でお渡しにする' });
    expect(toPickup.closest('form')!.querySelector('input[name="fulfillment"]')).toHaveValue('pickup');
    expect(within(methods).queryByRole('button', { name: '受け取り方法を宅配にする' })).toBeNull();
  });

  it('店頭のカートでも、宅配に切り替えられる。宅配の選択（住所・枠）は、まだ出さない', () => {
    renderCart({ cart: cart(), store: store(), zones: [zone()], delivery: null });
    const toDelivery = screen.getByRole('button', { name: '受け取り方法を宅配にする' });
    expect(toDelivery.closest('form')!.querySelector('input[name="fulfillment"]')).toHaveValue('delivery');
    expect(screen.queryByRole('heading', { name: 'お届け先の住所を選ぶ' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'お届けの時間枠を選ぶ' })).toBeNull();
  });

  it('宅配をしない店（区画が空）は、宅配を選べない（理由つき）。区画が読めなければ、選べる（API が決める）', () => {
    const { unmount } = renderCart({ cart: cart(), store: store(), zones: [], delivery: null });
    const off = screen.getByRole('button', { name: '宅配は選べません' });
    expect(off).toBeDisabled();
    expect(off).toHaveAccessibleDescription('この店は宅配をしていません');
    unmount();
    renderCart({ cart: cart(), store: store(), zones: null, delivery: null });
    expect(screen.getByRole('button', { name: '受け取り方法を宅配にする' })).toBeEnabled();
  });

  it('店が未選択なら、宅配は選べない（先に店を選ぶ）', () => {
    renderCart({ cart: cart({ store: null }), store: null, zones: null, delivery: null });
    expect(screen.getByRole('button', { name: '宅配は選べません' })).toHaveAccessibleDescription('先に、受け取る店を選んでください');
    expect(screen.getByRole('button', { name: '注文内容を確認する' })).toBeDisabled();
  });

  it('宅配のカートで、店が宅配をしていなくなったら、住所・枠の選択は出さず、固定の文で知らせる', () => {
    renderCart(deliveryData({ zones: [], delivery: null }, { delivery: cartDelivery({ address: null, zone: null, slot: null, issues: ['delivery_unavailable', 'address_required', 'slot_required'] }) }));
    expect(screen.getAllByRole('alert').some((a) => a.textContent?.includes('選んだ店は、宅配をしていません'))).toBe(true);
    expect(screen.queryByRole('heading', { name: 'お届け先の住所を選ぶ' })).toBeNull();
    expect(screen.getByRole('button', { name: '注文内容を確認する' })).toBeDisabled();
  });
});

describe('カート: 送料・無料になる金額・最低注文額', () => {
  it('お届け先・時間枠・送料・無料になる金額・最低注文額と、小計・送料・合計', () => {
    renderCart(deliveryData());
    const panel = screen.getByRole('heading', { name: '受け取り' }).closest('section')!;
    expect(within(panel).getByText('お届け先').nextSibling).toHaveTextContent('自宅（発着場）');
    expect(within(panel).getByText('お届けの時間枠').nextSibling).toHaveTextContent('11/22（日） 13:00〜13:30');
    expect(within(panel).getByText('送料').nextSibling).toHaveTextContent('200 ルミ');
    expect(within(panel).getByText('送料が無料になる金額').nextSibling).toHaveTextContent('品の小計が 2,000 ルミ以上');
    expect(within(panel).getByText('最低注文額').nextSibling).toHaveTextContent('700 ルミ（品の小計。送料を除く）');
    const totals = screen.getByRole('heading', { name: 'お支払い金額' }).closest('section')!;
    expect(within(totals).getByText('小計').nextSibling).toHaveTextContent('900 ルミ');
    expect(within(totals).getByText('送料').nextSibling).toHaveTextContent('200 ルミ');
    expect(within(totals).getByText('合計').nextSibling).toHaveTextContent('1,100 ルミ');
    expect(within(totals).getByText('あと 1,100 ルミで送料が無料になります（品の小計が 2,000 ルミ以上）。')).toBeInTheDocument();
  });

  it('無料のとき（小計 2,000 ルミちょうど）は、送料が「無料」で、合計は小計と同じ', () => {
    renderCart(deliveryData({}, { subtotal_lumi: 2000, delivery_fee_lumi: 0, total_lumi: 2000, delivery: cartDelivery({ fee_lumi: 0 }) }));
    const totals = screen.getByRole('heading', { name: 'お支払い金額' }).closest('section')!;
    expect(within(totals).getByText('送料').nextSibling).toHaveTextContent('無料');
    expect(within(totals).getByText('合計').nextSibling).toHaveTextContent('2,000 ルミ');
    expect(within(totals).getByText('送料は無料です。')).toBeInTheDocument();
  });

  it('住所が未選択のあいだは、送料などは「お届け先を選ぶと表示されます」', () => {
    renderCart(deliveryData({}, { delivery_fee_lumi: 0, total_lumi: 900, delivery: cartDelivery({ address: null, zone: null, slot: null, fee_lumi: 0, free_over_lumi: null, min_order_lumi: null, issues: ['address_required', 'slot_required'] }) }));
    const panel = screen.getByRole('heading', { name: '受け取り' }).closest('section')!;
    expect(within(panel).getByText('送料').nextSibling).toHaveTextContent('お届け先を選ぶと表示されます');
    expect(within(panel).queryByText('最低注文額')).toBeNull();
    expect(within(panel).getByText('お届け先').nextSibling).toHaveTextContent('未選択');
  });
});

describe('カート: issues（確認へ進めない理由）', () => {
  it('住所・枠が未選択: API の順に、直し方つきの文を出し、確認へのボタンは無効', () => {
    renderCart(deliveryData({}, { delivery: cartDelivery({ address: null, zone: null, slot: null, issues: ['address_required', 'slot_required'] }) }));
    const cta = screen.getByRole('button', { name: '注文内容を確認する' });
    expect(cta).toBeDisabled();
    const items = within(document.getElementById('cart-blockers')!).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['お届け先の住所を選んでください。住所がないときは、「お届け先」で登録してください。', 'お届けの時間枠を選んでください。']);
    expect(cta).toHaveAccessibleDescription(/お届け先の住所を選んでください/);
  });

  it('最低注文額に届かない・砂嵐・枠が満枠: それぞれ固定の文', () => {
    renderCart(deliveryData({}, { delivery: cartDelivery({ issues: ['zone_suspended', 'below_minimum', 'slot_full'], min_order_lumi: 700 }) }));
    const text = document.getElementById('cart-blockers')!.textContent!;
    expect(text).toContain('砂嵐の警報');
    expect(text).toContain('700 ルミ以上');
    expect(text).toContain('満枠になりました');
    expect(text.indexOf('砂嵐')).toBeLessThan(text.indexOf('700 ルミ'));
    expect(text.indexOf('700 ルミ')).toBeLessThan(text.indexOf('満枠'));
  });

  it('issues が空なら、確認へ進める', () => {
    renderCart(deliveryData());
    expect(screen.getByRole('link', { name: '注文内容を確認する' })).toHaveAttribute('href', '/checkout');
  });
});

describe('カート: お届け先の住所', () => {
  it('ラベルとエリアだけ出す（番地・メモは出さない）。選択中の印と、選べる住所の「この住所にする」', () => {
    renderCart(deliveryData());
    const section = screen.getByRole('heading', { name: 'お届け先の住所を選ぶ' }).closest('section')!;
    const home = within(section).getByText('自宅').closest('li')!;
    expect(home).toHaveTextContent('選択中');
    const work = within(section).getByText('勤務先').closest('li')!;
    const pick = within(work).getByRole('button', { name: '勤務先をお届け先にする' });
    expect(pick.closest('form')!.querySelector('input[name="address_id"]')).toHaveValue('5');
    expect(document.body).not.toHaveTextContent('アルカ市発着場2-1-5');
    expect(document.body).not.toHaveTextContent('呼び鈴は 1 回');
  });

  it('店が届けないエリアの住所は、理由つきで選べない', () => {
    renderCart(deliveryData());
    const far = screen.getByText('実家').closest('li')!;
    const btn = within(far).getByRole('button', { name: '実家は選べません' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription('この店は、このエリアへは届けられません');
  });

  it('住所の選択は、住所の ID を Server Action に渡す', async () => {
    const action = spyAction({ ok: true, message: 'お届け先を選びました' });
    renderCart(deliveryData(), { ...actions, address: action });
    fireEvent.submit(screen.getByRole('button', { name: '勤務先をお届け先にする' }).closest('form')!);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]![1].get('address_id')).toBe('5');
    expect(await screen.findByRole('status')).toHaveTextContent('お届け先を選びました');
  });

  it('住所が無い: 登録へ誘う。読み込めなかった: 固定の文。どちらも、住所の管理へのリンクがある', () => {
    const { unmount } = renderCart(deliveryData({ delivery: { addresses: [], days: dayOptions(NOW), date: '2026-11-22', slots: null, slotsFailed: false } }, { delivery: cartDelivery({ address: null, zone: null, slot: null, issues: ['address_required', 'slot_required'] }) }));
    expect(screen.getByText(/登録した住所がありません/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '住所を登録する' })).toHaveAttribute('href', '/addresses');
    unmount();
    renderCart(deliveryData({ delivery: { addresses: null, days: dayOptions(NOW), date: '2026-11-22', slots: slotList(), slotsFailed: false } }));
    expect(screen.getByText(/住所を読み込めませんでした/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '住所を追加・削除する' })).toHaveAttribute('href', '/addresses');
  });
});

describe('カート: お届けの時間枠', () => {
  it('日付は今日から 7 日先まで（8 件）。選んでいる日に aria-current。リンクは ?date=', () => {
    renderCart(deliveryData());
    const days = within(screen.getByRole('navigation', { name: 'お届けの日付' })).getAllByRole('link');
    expect(days).toHaveLength(8);
    expect(days[0]).toHaveTextContent('今日 11/21（土）');
    expect(days[0]).toHaveAttribute('href', '/cart?date=2026-11-21');
    expect(days[1]).toHaveAttribute('aria-current', 'date');
    expect(days[1]).toHaveTextContent('明日 11/22（日）');
    expect(days[0]).not.toHaveAttribute('aria-current');
    expect(days[7]).toHaveAttribute('href', '/cart?date=2026-11-28');
  });

  it('枠: 選択中・残り・満枠・締め切り済みを、文字で示す。選べない枠は無効', () => {
    renderCart(deliveryData());
    const section = screen.getByRole('heading', { name: 'お届けの時間枠を選ぶ' }).closest('section')!;
    const items = within(section).getAllByRole('listitem').filter((li) => li.textContent?.includes('〜'));
    expect(items.map((li) => li.textContent)).toEqual(['13:00〜13:30選択中', '13:30〜14:00残り 1', '14:00〜14:30満枠', '14:30〜15:00締め切り済み']);
    // 選択中の枠は、ボタンではない
    expect(within(items[0]!).queryByRole('button')).toBeNull();
    const open = within(section).getByRole('button', { name: '13:30〜14:00（残り 1）' });
    expect(open).toBeEnabled();
    expect([open.getAttribute('name'), open.getAttribute('value')]).toEqual(['slot_id', '42']);
    expect(within(section).getByRole('button', { name: '14:00〜14:30（満枠）' })).toBeDisabled();
    expect(within(section).getByRole('button', { name: '14:30〜15:00（締め切り済み）' })).toBeDisabled();
  });

  it('枠の選択は、1 つのフォームで送る（送信中は、枠のボタンがまとめて無効になり、二重に送れない）', async () => {
    let finish: (s: ActionState) => void = () => {};
    const action = vi.fn<FormAction>(() => new Promise<ActionState>((resolve) => (finish = resolve)));
    renderCart(deliveryData(), { ...actions, slot: action });
    const open = screen.getByRole('button', { name: '13:30〜14:00（残り 1）' });
    const form = open.closest('form')!;
    expect(within(form).getAllByRole('button')).toHaveLength(3);
    fireEvent.submit(form);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(open).toBeDisabled());
    await act(async () => finish({ ok: false, message: '選んだ時間枠は、満枠になりました。別の時間枠を選んでください。' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('満枠になりました');
  });

  it('枠が出ない理由（休業・砂嵐など）は、固定の文。枠は並べない', () => {
    renderCart(deliveryData({ delivery: { addresses, days: dayOptions(NOW), date: '2026-11-22', slots: slotList({ reason: 'storm_warning', slots: [] }), slotsFailed: false } }));
    expect(screen.getByRole('status')).toHaveTextContent('砂嵐の警報が出ている');
    expect(screen.queryByRole('button', { name: /残り/ })).toBeNull();
  });

  it('その日に枠が無い・読み込めなかったときは、固定の文', () => {
    const { unmount } = renderCart(deliveryData({ delivery: { addresses, days: dayOptions(NOW), date: '2026-11-22', slots: slotList({ slots: [] }), slotsFailed: false } }));
    expect(screen.getByText('この日は、選べる時間枠がありません。')).toBeInTheDocument();
    unmount();
    renderCart(deliveryData({ delivery: { addresses, days: dayOptions(NOW), date: '2026-11-22', slots: null, slotsFailed: true } }));
    expect(screen.getByText(/時間枠を読み込めませんでした/)).toBeInTheDocument();
  });

  it('住所を選ぶまでは、日付も枠も出さず、先に住所を選ぶよう案内する', () => {
    renderCart(deliveryData({ delivery: { addresses, days: dayOptions(NOW), date: '2026-11-21', slots: null, slotsFailed: false } }, { delivery: cartDelivery({ address: null, zone: null, slot: null, issues: ['address_required', 'slot_required'] }) }));
    expect(screen.getByText(/先に、お届け先の住所を選んでください/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'お届けの日付' })).toBeNull();
  });
});

describe('ヘッダー', () => {
  it('お届け先（住所）へのリンクがある。住所の画面では、現在地になる', () => {
    nav.pathname = '/addresses';
    render(<ShopHeader cartCount={0} />);
    const link = screen.getByRole('link', { name: 'お届け先' });
    expect(link).toHaveAttribute('href', '/addresses');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'メニュー' })).not.toHaveAttribute('aria-current');
  });
});

// ---- 住所の管理 ----

describe('住所の管理', () => {
  const zones = [zone({ id: 1, name: '居住区', area_code: 1 }), zone(), zone({ id: 3, name: '岩山', area_code: 3 })];
  const props = { addresses: [address(), address({ id: 4, label: '実家', area_name: '遺跡', note: null, line: '遺跡テラス9-9' })], zones, createAction: noop, deleteAction: noop };

  it('住所の一覧: ラベル・エリア・住所・メモ（あれば）と、件数（N / 10 件）', () => {
    render(<AddressManager {...props} />);
    expect(screen.getByRole('heading', { name: '登録した住所（2 / 10 件）' })).toBeInTheDocument();
    const home = screen.getByText('自宅').closest('li')!;
    expect(within(home).getByText('住所').nextSibling).toHaveTextContent('アルカ市発着場2-1-5 305');
    expect(within(home).getByText('メモ').nextSibling).toHaveTextContent('呼び鈴は 1 回');
    expect(within(screen.getByText('実家').closest('li')!).queryByText('メモ')).toBeNull();
    expect(screen.getByRole('link', { name: 'カートへ戻る' })).toHaveAttribute('href', '/cart');
  });

  it('住所が無いときは、登録を案内する', () => {
    render(<AddressManager {...props} addresses={[]} />);
    expect(screen.getByText(/まだ住所がありません/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '登録した住所（0 / 10 件）' })).toBeInTheDocument();
  });

  it('削除: 1 回目は確認に変わり、2 回目で送る（住所の ID）。やめるで戻れる', async () => {
    const del = spyAction({ ok: true, message: '住所を削除しました' });
    render(<AddressManager {...props} deleteAction={del} />);
    fireEvent.click(screen.getByRole('button', { name: '自宅を削除する' }));
    expect(screen.getByRole('alert')).toHaveTextContent('「自宅」を削除します');
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.getByRole('button', { name: '自宅を削除する' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '自宅を削除する' }));
    fireEvent.submit(screen.getByRole('button', { name: '自宅の削除を確定する' }).closest('form')!);
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del.mock.calls[0]![1].get('address_id')).toBe('3');
  });

  it('追加フォーム: ラベル・エリア（区画から）・住所・メモ。文字数の上限を、入力の属性に持つ', () => {
    render(<AddressManager {...props} />);
    const label = screen.getByLabelText(/ラベル/);
    expect(label).toHaveAttribute('maxlength', '20');
    expect(label).toBeRequired();
    expect(screen.getByLabelText(/^住所（/)).toHaveAttribute('maxlength', '100');
    expect(screen.getByLabelText(/メモ/)).toHaveAttribute('maxlength', '100');
    expect(screen.getByLabelText(/メモ/)).not.toBeRequired();
    const area = screen.getByLabelText('エリア');
    expect(area).toBeRequired();
    expect(within(area).getAllByRole('option').map((o) => [o.textContent, (o as HTMLOptionElement).value])).toEqual([['選んでください', ''], ['居住区', '1'], ['発着場', '2'], ['岩山', '3']]);
  });

  it('送信すると、入力が Server Action に渡る。成功したら、フォームを空にして、結果を知らせる', async () => {
    const create = spyAction({ ok: true, message: '住所を登録しました' });
    render(<AddressManager {...props} createAction={create} />);
    fireEvent.change(screen.getByLabelText(/ラベル/), { target: { value: '勤務先' } });
    fireEvent.change(screen.getByLabelText('エリア'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/^住所（/), { target: { value: '岩山ベース4-2' } });
    fireEvent.change(screen.getByLabelText(/メモ/), { target: { value: '受付へ' } });
    fireEvent.submit(screen.getByRole('button', { name: '住所を登録する' }).closest('form')!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const form = create.mock.calls[0]![1];
    expect([form.get('label'), form.get('area_code'), form.get('line'), form.get('note')]).toEqual(['勤務先', '3', '岩山ベース4-2', '受付へ']);
    expect(await screen.findByRole('status')).toHaveTextContent('住所を登録しました');
    await waitFor(() => expect(screen.getByLabelText(/ラベル/)).toHaveValue(''));
    expect(screen.getByLabelText(/^住所（/)).toHaveValue('');
    expect(screen.getByLabelText(/メモ/)).toHaveValue('');
    expect(screen.getByLabelText('エリア')).toHaveValue('');
  });

  it('失敗（エリアが無い・件数の上限）は、固定の文を出し、入力は消さない（直して、もう一度送れる）', async () => {
    const create = spyAction({ ok: false, message: 'エリアの指定が正しくありません。一覧から選びなおしてください。' });
    render(<AddressManager {...props} createAction={create} />);
    fireEvent.change(screen.getByLabelText(/ラベル/), { target: { value: '勤務先' } });
    fireEvent.change(screen.getByLabelText(/^住所（/), { target: { value: '岩山ベース4-2' } });
    fireEvent.submit(screen.getByRole('button', { name: '住所を登録する' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('エリアの指定が正しくありません');
    expect(screen.getByLabelText(/ラベル/)).toHaveValue('勤務先');
    expect(screen.getByLabelText(/^住所（/)).toHaveValue('岩山ベース4-2');
  });

  it('10 件あれば、フォームの代わりに、上限の案内を出す', () => {
    const ten = Array.from({ length: 10 }, (_, i) => address({ id: i + 1, label: `住所${i + 1}` }));
    render(<AddressManager {...props} addresses={ten} />);
    expect(screen.getByRole('heading', { name: '登録した住所（10 / 10 件）' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('住所は 10 件まで登録できます');
    expect(screen.queryByRole('button', { name: '住所を登録する' })).toBeNull();
  });

  it('エリアの一覧が読めなければ、フォームは出さず、固定の文で知らせる（住所の一覧は出す）', () => {
    render(<AddressManager {...props} zones={null} />);
    expect(screen.getByRole('alert')).toHaveTextContent('エリアの一覧を読み込めませんでした');
    expect(screen.queryByLabelText('エリア')).toBeNull();
    expect(screen.getByText('自宅')).toBeInTheDocument();
  });
});

// ---- 確認 ----

describe('確認カード（宅配）', () => {
  const key = '11111111-2222-3333-4444-555555555555';

  it('受け取り方法・お届け先（ラベルとエリア）・時間枠・小計・送料・合計。暗証コードは集荷後に出ると前もって伝える', () => {
    render(<CheckoutCard proposal={deliveryProposal()} idempotencyKey={key} confirmAction={noop} />);
    const card = screen.getByRole('article');
    expect(within(card).getByText('受け取り方法').nextSibling).toHaveTextContent('宅配（お届け）');
    expect(within(card).getByText('お届け先').nextSibling).toHaveTextContent('自宅（発着場）');
    expect(within(card).getByText('お届けの時間枠').nextSibling).toHaveTextContent('11/22（日） 13:00〜13:30');
    expect(within(card).getByText('小計').nextSibling).toHaveTextContent('900 ルミ');
    expect(within(card).getByText('送料').nextSibling).toHaveTextContent('200 ルミ');
    expect(within(card).getByText('合計').nextSibling).toHaveTextContent('1,100 ルミ');
    expect(within(card).getByText(/集荷したあと、注文の画面に、受け取り用の暗証コード/)).toBeInTheDocument();
    expect(within(card).getByText(/お届けの時間枠が一定時間確保されます/)).toBeInTheDocument();
    expect(within(card).queryByText('店頭でお渡し')).toBeNull();
    expect(screen.getAllByRole('button', { name: '注文を確定する' })).toHaveLength(1);
  });

  it('送料が無料なら「無料」と出す', () => {
    render(<CheckoutCard proposal={deliveryProposal({ subtotal_lumi: 2000, delivery_fee_lumi: 0, total_lumi: 2000 })} idempotencyKey={key} confirmAction={noop} />);
    expect(screen.getByText('送料').nextSibling).toHaveTextContent('無料');
  });

  it('送料・区画・枠が変わった 409（proposal_stale）・満枠・締め切りなどは、固定の文と直し方のリンクで出す', async () => {
    const action = spyAction({ ok: false, message: '選んだ時間枠は、満枠になりました。別の時間枠を選んでください。', next: { label: 'カートを見る', href: '/cart' } });
    render(<CheckoutCard proposal={deliveryProposal()} idempotencyKey={key} confirmAction={action} />);
    fireEvent.submit(screen.getByRole('button', { name: '注文を確定する' }).closest('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('満枠になりました');
    expect(within(alert).getByRole('link', { name: 'カートを見る' })).toHaveAttribute('href', '/cart');
  });

  it('店頭の確認カードは、これまでどおり（お届け先なし・合計だけ・暗証コードの案内なし）', () => {
    render(<CheckoutCard proposal={proposal()} idempotencyKey={key} confirmAction={noop} />);
    expect(screen.queryByText('お届け先')).toBeNull();
    expect(screen.queryByText('送料')).toBeNull();
    expect(screen.queryByText('小計')).toBeNull();
    expect(screen.queryByText(/暗証コード/)).toBeNull();
    expect(screen.getByText('店頭でお渡し')).toBeInTheDocument();
  });
});

// ---- 注文 ----

describe('注文の画面（宅配）', () => {
  const baseProps = { serverNow: '2026-11-22T03:00:00Z', devTools: false, payAction: noop, cancelAction: noop };
  const view = (over: Partial<Order> = {}, delivery: Partial<OrderDelivery> = {}, props = {}) =>
    render(<OrderView order={deliveryOrder({ can_pay: false, can_cancel: false, ...over, delivery: orderDelivery(delivery) })} {...baseProps} {...props} />);
  const stepItems = () => within(screen.getByRole('list', { name: '注文と配達の進み' })).getAllByRole('listitem');

  it('受付番号（受け取りには使わない）・お届け先・時間枠・配達員・送料つきの合計・受け取り方法', () => {
    view({ status: 'paid' });
    expect(screen.getByLabelText('受付番号 12')).toHaveTextContent('12');
    const panel = screen.getByRole('heading', { name: 'お届けの状況' }).closest('section')!;
    expect(within(panel).getByText('お届け先').nextSibling).toHaveTextContent('自宅（発着場）');
    expect(within(panel).getByText('お届けの時間枠').nextSibling).toHaveTextContent('11/22（日） 13:00〜13:30');
    expect(within(panel).getByText('配達員').nextSibling).toHaveTextContent('手配中です');
    const items = screen.getByRole('heading', { name: 'ご注文の内容' }).closest('section')!;
    expect(within(items).getByText('小計').nextSibling).toHaveTextContent('900 ルミ');
    expect(within(items).getByText('送料').nextSibling).toHaveTextContent('200 ルミ');
    expect(within(items).getByText('合計').nextSibling).toHaveTextContent('1,100 ルミ');
    expect(within(items).getByText('宅配（お届け）')).toBeInTheDocument();
    // 住所の番地は、注文の画面にも出さない（API も返さない）
    expect(document.body).not.toHaveTextContent('アルカ市');
  });

  it('ready: 店頭の「受け取れます・カウンターで」ではなく、配達員の手配待ちを伝える。暗証コードはまだ無い', () => {
    view({ status: 'ready' });
    expect(screen.getByRole('status')).toHaveTextContent('準備完了');
    expect(screen.getByRole('status')).toHaveTextContent('配達員の手配をお待ちください');
    expect(screen.getByRole('status')).not.toHaveTextContent('カウンター');
    expect(screen.queryByRole('group', { name: '受け取り用の暗証コード' })).toBeNull();
  });

  it('宅配の進み（9 段階）: ready のあとに、配達員が決定・集荷済み・配達中・お届け済み', () => {
    view({ status: 'assigned' }, { status: 'assigned', courier: { name: 'ラシード' } });
    expect(stepItems().map((s) => s.textContent?.replace(/\s+/g, ''))).toEqual(
      ['お支払い待ち（完了）', '支払い済み（完了）', 'お店が受付（完了）', '調理中（完了）', '準備完了（完了）', '配達員が決定（現在）', '集荷済み（これから）', '配達中（これから）', 'お届け済み（これから）'].map((x) => expect.stringContaining(x)),
    );
    expect(stepItems()[5]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('status')).toHaveTextContent('配達員が決まりました');
    expect(screen.getByText('配達員').nextSibling).toHaveTextContent('ラシード');
  });

  it('進みの時刻は、events の宅配の状態（assigned・picked_up）からも出す', () => {
    const at = (t: string) => ({ actor_type: 'staff' as const, reason: null, at: t });
    view({ status: 'picked_up', events: [{ to_status: 'ready', ...at('2026-11-22T03:00:00Z') }, { to_status: 'assigned', ...at('2026-11-22T03:05:00Z') }, { to_status: 'picked_up', ...at('2026-11-22T03:10:00Z') }] }, { status: 'picked_up', pin: '4821' });
    const items = stepItems();
    expect(items[5]).toHaveTextContent('12:05');
    expect(items[6]).toHaveTextContent('12:10');
    expect(items[7]).not.toHaveTextContent(':');
  });

  describe('暗証コード（集荷後だけ）', () => {
    it.each(['picked_up', 'delivering'] as const)('%s: 目立たせて出し、配達員にだけ伝えるよう添える', (status) => {
      view({ status }, { status, pin: '4821', courier: { name: 'ラシード' } });
      const pin = screen.getByRole('group', { name: '受け取り用の暗証コード' });
      expect(within(pin).getByText('4821')).toBeInTheDocument();
      expect(within(pin).getByText('4 8 2 1')).toHaveClass('shop-sr-only'); // 読み上げは 1 桁ずつ
      expect(within(pin).getByText('配達員にお伝えください。ほかの人には教えないでください。')).toBeInTheDocument();
    });

    it.each(['paid', 'accepted', 'preparing', 'ready', 'assigned', 'delivered', 'completed'] as const)('%s: 集荷の前（と、終わったあと）は、API が返してきても、出さない', (status) => {
      view({ status }, { pin: '4821' });
      expect(screen.queryByText('4821')).toBeNull();
      expect(screen.queryByText(/暗証コード/)).toBeNull();
    });

    it('集荷後でも、API が暗証コードを返していなければ（null）、枠を出さない', () => {
      view({ status: 'picked_up' }, { status: 'picked_up', pin: null });
      expect(screen.queryByRole('group', { name: '受け取り用の暗証コード' })).toBeNull();
    });

    it('暗証コードは、画面の文字以外（リンク・属性）にも、コンソールにも出ない', () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
      view({ status: 'delivering' }, { status: 'delivering', pin: '4821' });
      const attrs = [...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value));
      expect(attrs.some((v) => v.includes('4821'))).toBe(false);
      expect([...document.querySelectorAll('a')].some((a) => (a.getAttribute('href') ?? '').includes('4821'))).toBe(false);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    });

    it('形が違う値（4 桁の数字でない）は出さない', () => {
      view({ status: 'delivering' }, { status: 'delivering', pin: '<b>1</b>' });
      expect(screen.queryByRole('group', { name: '受け取り用の暗証コード' })).toBeNull();
      expect(document.body).not.toHaveTextContent('<b>');
    });
  });

  it('delivering: 配達中・到着の目安・配達員の名前。自動更新の案内も出る', () => {
    view({ status: 'delivering' }, { status: 'delivering', courier: { name: 'ラシード' }, eta_at: '2026-11-22T04:20:00Z', pin: '4821' });
    expect(screen.getByRole('status')).toHaveTextContent('配達中です');
    expect(stepItems()[7]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('到着の目安').nextSibling).toHaveTextContent('13:20 ごろ');
    expect(screen.getByText('配達員').nextSibling).toHaveTextContent('ラシード');
    expect(screen.getByText(/5 秒ごとに自動で更新/)).toBeInTheDocument();
  });

  it('delivery_failed（不在）: お届けできなかったこと・理由・お店からの連絡を待つ案内。再配達の回数。暗証コード・到着の目安は出さない', () => {
    view({ status: 'delivery_failed' }, { status: 'failed', failure_reason: 'absent', attempt: 2, pin: '4821', eta_at: '2026-11-22T04:20:00Z' });
    const failed = screen.getByText('不在のため、お届けできませんでした。').closest('div')!;
    expect(failed).toHaveTextContent('お届けできませんでした');
    expect(failed).toHaveTextContent('再配達の時間枠の調整や取消しは、お店が行います');
    expect(screen.getByText('配達の回数').nextSibling).toHaveTextContent('2 回目（再配達）');
    expect(screen.queryByText('4821')).toBeNull();
    expect(screen.queryByText('到着の目安')).toBeNull();
    const last = stepItems().at(-1)!;
    expect(last).toHaveTextContent('お届けできませんでした（現在）');
    expect(last).toHaveClass('shop-step-failed');
    expect(screen.getByText(/5 秒ごとに自動で更新/)).toBeInTheDocument(); // 再配達に備えて、更新を続ける
  });

  it.each([
    ['cannot_receive', 'お受け取りいただけなかったため'],
    ['pin_locked', '暗証コードが続けて合わなかったため'],
    ['other', 'お届けできませんでした。'],
  ] as const)('配達できなかった理由 %s は、固定の文', (reason, fragment) => {
    view({ status: 'delivery_failed' }, { status: 'failed', failure_reason: reason });
    expect(document.body).toHaveTextContent(fragment);
  });

  it('completed: お届けしました。全部完了。自動更新は止まる。取消し・暗証コードは出ない', () => {
    view({ status: 'completed' }, { status: 'delivered', eta_at: null });
    expect(screen.getByRole('status')).toHaveTextContent('お届けしました');
    for (const s of stepItems()) expect(s).toHaveTextContent('完了');
    expect(screen.queryByText(/秒ごとに自動で更新/)).toBeNull();
    expect(screen.queryByText('到着の目安')).toBeNull();
  });

  it('cancelled: 取消しの表示だけ（配達の状況・進みは出さない）', () => {
    view({ status: 'cancelled', cancel_reason: 'payment_declined' }, { status: 'cancelled', eta_at: null });
    expect(screen.getByRole('heading', { name: 'この注文は取消されました' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'お届けの状況' })).toBeNull();
    expect(screen.queryByRole('list', { name: '注文と配達の進み' })).toBeNull();
  });

  it('顧客の取消しは、API の can_cancel のまま（宅配でも、支払い・受付前の既存の条件）', () => {
    const { unmount } = view({ status: 'paid', can_cancel: true });
    expect(screen.getByRole('button', { name: '取消す' })).toBeInTheDocument();
    unmount();
    view({ status: 'delivering', can_cancel: false });
    expect(screen.queryByRole('button', { name: '取消す' })).toBeNull();
  });

  it('placed: お支払い（模擬）が出る。配達の状況は、時間枠だけが分かる', () => {
    view({ status: 'placed', can_pay: true, reservation_expires_at: '2026-11-22T03:15:00Z' }, {});
    expect(screen.getByRole('button', { name: '支払う（模擬）' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'お届けの状況' })).toBeInTheDocument();
  });

  it('店頭の注文は、お届けの状況を出さず、これまでどおり（受け取り番号・進みの名前）', () => {
    render(<OrderView order={order({ status: 'ready', can_pay: false, can_cancel: false })} {...baseProps} />);
    expect(screen.getByLabelText('受け取り番号 12')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'お届けの状況' })).toBeNull();
    expect(screen.getByRole('list', { name: '注文の進み' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('受け取れます');
  });
});

describe('進みの表示（宅配）', () => {
  it('店頭は 6 段階・宅配は 9 段階。配達できなかったときは、最後が「お届けできませんでした」', () => {
    const { rerender } = render(<OrderStepper status="ready" events={[]} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    rerender(<OrderStepper status="ready" events={[]} fulfillment="delivery" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
    expect(screen.getByRole('list').getAttribute('style')).toContain('--steps: 9');
    rerender(<OrderStepper status="delivery_failed" events={[]} fulfillment="delivery" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
    expect(screen.queryByText('お届け済み')).toBeNull();
  });

  it('取消しは、進みを出さない', () => {
    const { container } = render(<OrderStepper status="cancelled" events={[]} fulfillment="delivery" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('注文履歴（宅配の印）', () => {
  it('宅配の注文には「宅配」の印・受付番号・配達の状態。店頭には印を付けない', () => {
    render(
      <OrderList
        orders={[
          { public_id: 'DELIVERY1', pickup_no: 12, status: 'delivering', fulfillment: 'delivery', store: { id: 1, name: '居住区本店' }, total_lumi: 1100, placed_at: '2026-11-22T01:00:00Z' },
          { public_id: 'PICKUP001', pickup_no: 3, status: 'ready', fulfillment: 'pickup', store: { id: 1, name: '居住区本店' }, total_lumi: 900, placed_at: '2026-11-22T00:00:00Z' },
          { public_id: 'FAILED001', pickup_no: 4, status: 'delivery_failed', fulfillment: 'delivery', store: { id: 1, name: '居住区本店' }, total_lumi: 900, placed_at: '2026-11-21T00:00:00Z' },
        ]}
      />,
    );
    const [delivering, pickup, failed] = screen.getAllByRole('link');
    expect(delivering).toHaveTextContent('宅配');
    expect(delivering).toHaveTextContent('受付番号');
    expect(delivering).toHaveTextContent('配達中');
    expect(delivering).toHaveTextContent('1,100 ルミ');
    expect(pickup).not.toHaveTextContent('宅配');
    expect(pickup).toHaveTextContent('受け取り番号');
    expect(pickup).toHaveTextContent('受け取れます');
    expect(failed).toHaveTextContent('お届けできませんでした');
    expect(failed.querySelector('.shop-status-delivery_failed')).not.toBeNull();
  });

  it('宅配の ready は「準備完了」（店頭の「受け取れます」と書かない）', () => {
    render(<OrderList orders={[{ public_id: 'DELIVERY1', pickup_no: 12, status: 'ready', fulfillment: 'delivery', store: { id: 1, name: '居住区本店' }, total_lumi: 1100, placed_at: '2026-11-22T01:00:00Z' }]} />);
    expect(screen.getByRole('link')).toHaveTextContent('準備完了');
    expect(screen.getByRole('link')).not.toHaveTextContent('受け取れます');
  });
});

describe('注文の自動再取得（宅配の状態）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['ready', 'assigned', 'picked_up', 'delivering', 'delivery_failed'])('%s でも、5 秒ごとに再取得する（配達の進み・再配達を反映する）', (status) => {
    render(<OrderAutoRefresh status={status} />);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(nav.refresh).toHaveBeenCalledTimes(2);
  });

  it('配達が終わって completed になったら、止まる', () => {
    const { rerender } = render(<OrderAutoRefresh status="delivering" />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    rerender(<OrderAutoRefresh status="completed" />);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

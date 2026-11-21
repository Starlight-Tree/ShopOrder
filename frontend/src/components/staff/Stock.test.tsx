import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { stockRow } from '../../lib/staff/test-fixtures';
import type { StockFormState } from '../../lib/staff/types';
import { StockForms } from './StockForms';
import { StockTable } from './StockTable';

describe('StockTable', () => {
  const rows = [
    stockRow({ item_id: 1, name: 'オアシスブレンド豆', on_hand: 5000, reserved: 400, available: 4200, reorder_point: 1000 }),
    stockRow({ item_id: 2, name: '牛乳', unit: 'ml', on_hand: 900, reserved: 300, available: 400, reorder_point: 2000, low: true }),
  ];

  it('品名・単位・実在庫・確保中・使える数・発注点を表で出す', () => {
    render(<StockTable rows={rows} />);
    const table = screen.getByRole('table');
    for (const h of ['品名', '単位', '実在庫', '確保中', '使える数', '発注点', '状態']) {
      expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument();
    }
    const row = screen.getByRole('row', { name: /オアシスブレンド豆/ });
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['g', '5000', '400', '4200', '1000', '足りている']);
  });

  it('low の行は、色だけでなく「少ない」の文字を出し、強調の class を付ける。low でない行には出さない', () => {
    render(<StockTable rows={rows} />);
    const lowRow = screen.getByRole('row', { name: /牛乳/ });
    expect(within(lowRow).getByText('少ない')).toBeInTheDocument();
    expect(lowRow).toHaveClass('is-low');
    const okRow = screen.getByRole('row', { name: /オアシスブレンド豆/ });
    expect(within(okRow).queryByText('少ない')).toBeNull();
    expect(okRow).not.toHaveClass('is-low');
    expect(screen.getByText('1 品目が少なくなっています')).toBeInTheDocument();
  });

  it('少ない品目が無ければ、そう書く。品目が無ければ空の文', () => {
    const { unmount } = render(<StockTable rows={[rows[0]!]} />);
    expect(screen.getByText(/少ない品目はありません/)).toBeInTheDocument();
    unmount();
    render(<StockTable rows={[]} />);
    expect(screen.getByText('在庫の品目がありません。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('狭い幅の縦積み用に、各セルへ data-label を付ける', () => {
    render(<StockTable rows={rows} />);
    const lowRow = screen.getByRole('row', { name: /牛乳/ });
    expect(within(lowRow).getAllByRole('cell').map((c) => c.getAttribute('data-label'))).toEqual(['単位', '実在庫', '確保中', '使える数', '発注点', '状態']);
  });
});

describe('StockForms', () => {
  const items = [
    { item_id: 1, name: 'オアシスブレンド豆', unit: 'g', on_hand: 5000 },
    { item_id: 2, name: '牛乳', unit: 'ml', on_hand: 900 },
  ];
  type A = (prev: StockFormState, fd: FormData) => Promise<StockFormState>;
  const result = (status: 'ok' | 'error', message: string): A => vi.fn(async (prev) => ({ status, message, seq: prev.seq + 1 }));

  function renderForms(over: Partial<{ receive: A; waste: A; adjust: A }> = {}) {
    const actions = { receive: result('ok', '入荷しました'), waste: result('ok', '廃棄しました'), adjust: result('ok', '調整しました'), ...over };
    render(<StockForms items={items} {...actions} />);
    return actions;
  }
  const section = (name: string) => screen.getByRole('region', { name });

  it('入荷・廃棄・棚卸しの 3 つのフォームを出す。品目は、実在庫つきで選ぶ', () => {
    renderForms();
    for (const n of ['入荷', '廃棄', '棚卸し']) expect(section(n)).toBeInTheDocument();
    expect(within(section('入荷')).getByRole('option', { name: 'オアシスブレンド豆（実在庫 5000 g）' })).toBeInTheDocument();
  });

  it('必須の項目: 廃棄と棚卸しは理由が必須、入荷は任意', () => {
    renderForms();
    expect(within(section('入荷')).getByLabelText('メモ（任意）')).not.toBeRequired();
    expect(within(section('廃棄')).getByLabelText('廃棄の理由（必須）')).toBeRequired();
    expect(within(section('棚卸し')).getByLabelText('棚卸しの理由（必須）')).toBeRequired();
  });

  it('入荷: FormData（item_id・qty・reason）で Server Action を呼び、成功の文を出し、数と理由を空にする', async () => {
    const { receive } = renderForms();
    const form = section('入荷');
    fireEvent.change(within(form).getByLabelText('品目'), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText('入荷した数'), { target: { value: '300' } });
    fireEvent.change(within(form).getByLabelText('メモ（任意）'), { target: { value: '納品書 7' } });
    fireEvent.click(within(form).getByRole('button', { name: '入荷を記録する' }));
    await waitFor(() => expect(within(form).getByRole('status')).toHaveTextContent('入荷しました'));
    const fd = (receive as ReturnType<typeof vi.fn>).mock.calls[0]![1] as FormData;
    expect([fd.get('item_id'), fd.get('qty'), fd.get('reason')]).toEqual(['2', '300', '納品書 7']);
    await waitFor(() => expect(within(form).getByLabelText('入荷した数')).toHaveValue(''));
    expect(within(form).getByLabelText('メモ（任意）')).toHaveValue('');
    expect(within(form).getByLabelText('品目')).toHaveValue('2'); // 品目は残す
  });

  it('棚卸し: 差分は delta で送る（負の数も）', async () => {
    const { adjust } = renderForms();
    const form = section('棚卸し');
    fireEvent.change(within(form).getByLabelText('品目'), { target: { value: '1' } });
    fireEvent.change(within(form).getByLabelText(/^差分/), { target: { value: '-30' } });
    fireEvent.change(within(form).getByLabelText('棚卸しの理由（必須）'), { target: { value: '数え直し' } });
    fireEvent.click(within(form).getByRole('button', { name: '棚卸しの差分を記録する' }));
    await waitFor(() => expect(adjust).toHaveBeenCalled());
    const fd = (adjust as ReturnType<typeof vi.fn>).mock.calls[0]![1] as FormData;
    expect([fd.get('item_id'), fd.get('delta'), fd.get('reason')]).toEqual(['1', '-30', '数え直し']);
    expect(fd.get('qty')).toBeNull();
  });

  it('失敗したら、文を（結果の領域に）出し、入力は残す（打ち直させない）', async () => {
    renderForms({ waste: result('error', '実在庫より多くは廃棄できません') });
    const form = section('廃棄');
    fireEvent.change(within(form).getByLabelText('品目'), { target: { value: '1' } });
    fireEvent.change(within(form).getByLabelText('廃棄した数'), { target: { value: '99999' } });
    fireEvent.change(within(form).getByLabelText('廃棄の理由（必須）'), { target: { value: '期限切れ' } });
    fireEvent.click(within(form).getByRole('button', { name: '廃棄を記録する' }));
    await waitFor(() => expect(within(form).getByRole('status')).toHaveTextContent('実在庫より多くは廃棄できません'));
    expect(within(form).getByRole('status')).toHaveTextContent('記録できませんでした');
    expect(within(form).getByLabelText('廃棄した数')).toHaveValue('99999');
    expect(within(form).getByLabelText('廃棄の理由（必須）')).toHaveValue('期限切れ');
  });
});

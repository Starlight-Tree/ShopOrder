import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MenuItem, Store } from '../lib/types';
import { MenuList } from './MenuList';
import { StoreList } from './StoreList';

const store = (over: Partial<Store>): Store => ({
  id: 1, code: 'a', name: '居住区本店', area: '居住区', address: 'アルカ市居住区1-4-2', open_time: '07:00', close_time: '21:00',
  closed_weekday: null, last_order_minutes: 30, mobile_order: true, seats: 68, ...over,
});

const item = (over: Partial<MenuItem>): MenuItem => ({
  id: 1, code: 'oasis-blend', name: 'オアシスブレンド', category: 'drink', description: '深煎りの 3 種ブレンド', allergens: [],
  season_from: null, season_to: null, sold_from: null, sold_until: null,
  variants: [{ id: 1, size: 'S', temperature: 'hot', price_lumi: 380 }, { id: 2, size: 'L', temperature: 'hot', price_lumi: 520 }], ...over,
});

describe('StoreList', () => {
  it('エリアごとに店を並べ、営業時間・定休日・席を出す', () => {
    render(<StoreList stores={[store({}), store({ id: 2, name: '発着場中央店', area: '発着場', closed_weekday: 1, seats: 54 })]} />);
    expect(screen.getByRole('heading', { name: '居住区' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '発着場' })).toBeInTheDocument();
    expect(screen.getByText('07:00〜21:00・年中無休・68 席')).toBeInTheDocument();
    expect(screen.getByText(/定休日 月/)).toBeInTheDocument();
  });

  it('モバイルオーダー不可と、早いラストオーダーは、タグで知らせる。普通の店には出さない', () => {
    render(<StoreList stores={[store({ name: '居住区信号塔店', mobile_order: false }), store({ id: 2, name: '遺跡発掘小屋店', area: '遺跡', last_order_minutes: 15 }), store({ id: 3, name: '居住区本店' })]} />);
    expect(screen.getAllByText('モバイルオーダー不可')).toHaveLength(1);
    expect(screen.getAllByText('ラストオーダーは閉店 15 分前')).toHaveLength(1);
  });
});

describe('MenuList', () => {
  it('区分ごとに並べ、価格はルミの範囲で出す', () => {
    render(<MenuList items={[item({}), item({ id: 2, name: 'ホットサンド', category: 'food', variants: [{ id: 3, size: '-', temperature: '-', price_lumi: 520 }] })]} />);
    expect(screen.getByRole('heading', { name: 'ドリンク' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'フード' })).toBeInTheDocument();
    expect(screen.getByText('380〜520 ルミ')).toBeInTheDocument();
    expect(screen.getByText('520 ルミ')).toBeInTheDocument();
  });

  it('期間・時間帯・アレルゲンは、タグで出す', () => {
    render(<MenuList items={[item({ name: '帰還祭の限定ドリンク', season_from: '12-01', season_to: '12-25' }), item({ id: 2, name: 'ガトーショコラ', category: 'food', allergens: ['卵', '乳'], sold_from: '11:00' })]} />);
    expect(screen.getByText('12/1〜12/25 限定')).toBeInTheDocument();
    expect(screen.getByText('11:00 から')).toBeInTheDocument();
    expect(screen.getByText('含む: 卵・乳')).toBeInTheDocument();
  });

  it('豆の区分が無ければ、見出しも出さない', () => {
    const { container } = render(<MenuList items={[item({})]} />);
    expect(within(container).queryByRole('heading', { name: '豆' })).toBeNull();
  });
});

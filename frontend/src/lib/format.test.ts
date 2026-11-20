import { describe, expect, it } from 'vitest';
import { closedLabel, formatLumi, priceRange, seasonLabel, soldWindowLabel } from './format';

describe('formatLumi / priceRange', () => {
  it('ルミの金額に桁区切りを付ける', () => {
    expect(formatLumi(450)).toBe('450 ルミ');
    expect(formatLumi(1800)).toBe('1,800 ルミ');
  });

  it('価格の範囲。1 つだけなら範囲にしない。空なら空', () => {
    expect(priceRange([{ price_lumi: 450 }])).toBe('450 ルミ');
    expect(priceRange([{ price_lumi: 520 }, { price_lumi: 380 }, { price_lumi: 450 }])).toBe('380〜520 ルミ');
    expect(priceRange([])).toBe('');
  });
});

describe('closedLabel / seasonLabel / soldWindowLabel', () => {
  it('定休日（1 = 月 … 7 = 日）。無ければ年中無休', () => {
    expect(closedLabel(null)).toBe('年中無休');
    expect(closedLabel(3)).toBe('定休日 水');
    expect(closedLabel(7)).toBe('定休日 日');
  });

  it('毎年の期間は、月と日の 0 を落として表す。無ければ null', () => {
    expect(seasonLabel({ season_from: '12-01', season_to: '12-25' })).toBe('12/1〜12/25');
    expect(seasonLabel({ season_from: null, season_to: null })).toBeNull();
  });

  it('販売の時間帯', () => {
    expect(soldWindowLabel({ sold_from: '07:00', sold_until: '10:30' })).toBe('07:00〜10:30');
    expect(soldWindowLabel({ sold_from: '11:00', sold_until: null })).toBe('11:00 から');
    expect(soldWindowLabel({ sold_from: null, sold_until: null })).toBeNull();
  });
});

// 配達員の画面のテスト用の部品（本番のコードからは import しない）
import type { CourierDelivery } from './delivery-types';

/** 店のローカル（時差 +9）で 12:05。枠の 13:00〜13:30 は「今日」 */
export const NOW = '2026-11-21T03:05:00Z';

export const delivery = (over: Partial<CourierDelivery> = {}): CourierDelivery => ({
  public_id: 'K7M2Q9XD',
  pickup_no: 12,
  status: 'assigned',
  store: { id: 1, name: '居住区本店' },
  zone: { id: 2, name: '発着場' },
  slot: { id: 41, starts_at: '2026-11-21T04:00:00Z', ends_at: '2026-11-21T04:30:00Z' },
  items: [{ name: 'オアシスブレンド', size: 'M', temperature: 'hot', qty: 2 }],
  address: null,
  attempt: 1,
  pin_attempts_left: null,
  eta_at: null,
  allowed_actions: ['pickup'],
  ...over,
});

export const ADDRESS = { label: '自宅', line: 'アルカ市発着場2-1-5 305', note: '呼び鈴は 1 回' } as const;

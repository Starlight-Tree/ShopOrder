// 配車ボードのテスト用の部品（本番のコードからは import しない）。NOW（test-fixtures.ts）= 2026-11-21 12:05（UTC+9）の日の枠。
import type { Courier, DispatchOrder, StaffDelivery, Zone } from './delivery-types';

/** 割り当て待ち（ready）の宅配の注文。枠は NOW の日の 13:00〜13:30（UTC+9）。提案は店にいるラシード */
export const dispatchOrder = (over: Partial<Omit<DispatchOrder, 'delivery'>> & { delivery?: Partial<StaffDelivery> } = {}): DispatchOrder => {
  const { delivery, ...rest } = over;
  return {
    public_id: 'K7M2Q9XD',
    pickup_no: 12,
    status: 'ready',
    fulfillment: 'delivery',
    store: { id: 1, name: '居住区本店' },
    items: [{ name: 'オアシスブレンド', size: 'M', temperature: 'hot', unit_price_lumi: 450, qty: 2, line_total_lumi: 900 }],
    subtotal_lumi: 900,
    delivery_fee_lumi: 150,
    total_lumi: 1050,
    placed_at: '2026-11-21T02:30:00Z',
    reservation_expires_at: null,
    events: [],
    cancel_reason: null,
    can_pay: false,
    can_cancel: false,
    allowed_actions: ['assign', 'cancel'],
    delivery: {
      status: 'pending',
      zone: { id: 1, name: '居住区' },
      slot: { id: 41, starts_at: '2026-11-21T04:00:00Z', ends_at: '2026-11-21T04:30:00Z' },
      courier: null,
      attempt: 1,
      failure_reason: null,
      ...delivery,
    },
    suggestion: { courier_id: 7, courier_name: 'ラシード', minutes: 0 },
    ...rest,
  };
};

export const courier = (over: Partial<Courier> = {}): Courier => ({
  id: 7,
  store_id: 1,
  name: 'ラシード',
  vehicle: 'hover-scooter',
  is_on_duty: true,
  active_count: 1,
  zone: { id: 1, name: '居住区' },
  ...over,
});

export const zone = (over: Partial<Zone> = {}): Zone => ({
  id: 2,
  name: '発着場',
  area_code: 2,
  fee_lumi: 200,
  free_over_lumi: 2000,
  min_order_lumi: 700,
  base_minutes: 30,
  is_suspended: false,
  ...over,
});

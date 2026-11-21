// テスト用の部品（本番のコードからは import しない）
import type { Staff, StaffOrder, StockRow } from '../contract';

export const NOW = '2026-11-21T03:05:00Z';

export const order = (over: Partial<StaffOrder> = {}): StaffOrder => ({
  public_id: 'K7M2Q9XD',
  pickup_no: 12,
  status: 'paid',
  fulfillment: 'pickup',
  store: { id: 1, name: '居住区本店' },
  items: [{ name: 'オアシスブレンド', size: 'M', temperature: 'hot', unit_price_lumi: 450, qty: 2, line_total_lumi: 900 }],
  subtotal_lumi: 900,
  delivery_fee_lumi: 0,
  total_lumi: 900,
  placed_at: '2026-11-21T03:00:00Z', // NOW の 5 分前
  reservation_expires_at: null,
  events: [],
  cancel_reason: null,
  can_pay: false,
  can_cancel: true,
  allowed_actions: ['accept', 'cancel'],
  ...over,
});

export const staffUser = (over: Partial<Staff> = {}): Staff => ({ id: 1, name: 'ミナ・ハーシム', role: 'staff', store_id: 1, ...over });

export const stockRow = (over: Partial<StockRow> = {}): StockRow => ({
  item_id: 1,
  code: 'beans-ob',
  name: 'オアシスブレンド豆',
  kind: 'material',
  unit: 'g',
  on_hand: 5000,
  reserved: 400,
  available: 4200,
  reorder_point: 1000,
  low: false,
  ...over,
});

/** fetch の応答（JSON）。 */
export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

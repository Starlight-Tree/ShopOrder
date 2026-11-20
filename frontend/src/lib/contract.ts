// docs/api.md の応答の形（P1: 店頭受け取りの注文）。API の約束が変わったら、ここと docs/api.md を一緒に直す。
import type { ClosedReason, UnavailableReason } from './types';

export type CartLine = {
  variant_id: number;
  item_code: string;
  name: string;
  size: string;
  temperature: string;
  unit_price_lumi: number;
  qty: number;
  line_total_lumi: number;
  available: boolean;
  unavailable_reason: UnavailableReason | null;
};

export type Cart = {
  version: number;
  store: { id: number; name: string } | null;
  fulfillment: 'pickup';
  lines: CartLine[];
  subtotal_lumi: number;
  delivery_fee_lumi: number;
  total_lumi: number;
};

export type CheckoutProposal = {
  id: string;
  cart_version: number;
  total_lumi: number;
  expires_at: string;
  store: { id: number; name: string };
  lines: CartLine[];
  pickup_note: string;
};

export type OrderStatus = 'placed' | 'paid' | 'accepted' | 'preparing' | 'ready' | 'completed' | 'cancelled';

export type OrderItem = {
  name: string;
  size: string;
  temperature: string;
  unit_price_lumi: number;
  qty: number;
  line_total_lumi: number;
};

export type OrderEvent = { to_status: OrderStatus; at: string; actor_type: 'customer' | 'staff' | 'system'; reason: string | null };

export type Order = {
  public_id: string;
  pickup_no: number;
  status: OrderStatus;
  fulfillment: 'pickup';
  store: { id: number; name: string };
  items: OrderItem[];
  subtotal_lumi: number;
  delivery_fee_lumi: number;
  total_lumi: number;
  placed_at: string;
  reservation_expires_at: string | null;
  payment: { provider: string; status: 'pending' | 'paid' | 'failed' | 'refunded' } | null;
  events: OrderEvent[];
  cancel_reason: string | null;
  can_pay: boolean;
  can_cancel: boolean;
};

export type OrderSummary = Pick<Order, 'public_id' | 'pickup_no' | 'status' | 'store' | 'total_lumi' | 'placed_at'>;

export type StaffRole = 'staff' | 'manager' | 'courier';
export type Staff = { id: number; name: string; role: StaffRole; store_id: number | null };
export type StaffAction = 'accept' | 'start' | 'ready' | 'complete' | 'cancel';
export type StaffOrder = Omit<Order, 'payment'> & { allowed_actions: StaffAction[] };

export type StockRow = {
  item_id: number;
  code: string;
  name: string;
  kind: 'material' | 'sellable';
  unit: string;
  on_hand: number;
  reserved: number;
  available: number;
  reorder_point: number;
  low: boolean;
};

/** エラー本文の形（`detail` が { code, message } のとき）。入力の形の誤り（422 の配列）は code が無い。 */
export type ApiErrorBody = { code: string; message: string; [extra: string]: unknown };
export type { ClosedReason };

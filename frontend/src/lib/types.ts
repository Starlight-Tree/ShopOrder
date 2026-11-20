// API（backend/app/schemas.py）の応答の形
export type Store = {
  id: number;
  code: string;
  name: string;
  area: string;
  address: string;
  open_time: string; // "07:00"
  close_time: string;
  closed_weekday: number | null; // 1 = 月 … 7 = 日
  last_order_minutes: number;
  mobile_order: boolean;
  seats: number;
  accepting_orders?: boolean; // docs/api.md（注文を受けられるか）
  closed_reason?: ClosedReason | null;
};

export type ClosedReason = 'closed_today' | 'temporary_closure' | 'outside_hours' | 'past_last_order' | 'mobile_order_unavailable';

export type UnavailableReason = 'out_of_season' | 'out_of_hours' | 'sold_out';

export type Variant = {
  id: number;
  size: string;
  temperature: string;
  price_lumi: number;
  available?: boolean; // /api/menu?store_id= のときだけ
  unavailable_reason?: UnavailableReason | null;
};

export type MenuItem = {
  id: number;
  code: string;
  name: string;
  category: 'drink' | 'food' | 'beans';
  description: string;
  allergens: string[];
  season_from: string | null; // "12-01"
  season_to: string | null;
  sold_from: string | null; // "07:00"
  sold_until: string | null;
  variants: Variant[];
};

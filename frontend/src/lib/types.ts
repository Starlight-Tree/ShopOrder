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

// ---- 宅配（P2。docs/api.md「宅配（P2）」）。認証なしで読める区画・時間枠の形 ----

export type ZoneRef = { id: number; name: string };

export type SlotRef = { id: number; starts_at: string; ends_at: string };

/** 区画（= エリア）。送料・無料になる金額・最低注文額・基準の所要分・砂嵐の警報 */
export type Zone = {
  id: number;
  name: string;
  area_code: number;
  fee_lumi: number;
  free_over_lumi: number | null;
  min_order_lumi: number;
  base_minutes: number;
  is_suspended: boolean;
};

/** 枠を選べない理由。full = 満席、cutoff = 受付の締めを過ぎた */
export type SlotUnavailableReason = 'full' | 'cutoff';

export type Slot = SlotRef & {
  capacity: number;
  booked: number;
  remaining: number;
  available: boolean;
  unavailable_reason: SlotUnavailableReason | null;
};

/** 枠の一覧が空になる理由（`reason` が付くとき `slots` は空） */
export type SlotListReason = 'delivery_unavailable' | 'mobile_order_unavailable' | 'temporary_closure' | 'closed_today' | 'storm_warning' | 'zone_unserved';

export type SlotList = { store_id: number; date: string; zone_id: number | null; reason: SlotListReason | null; slots: Slot[] };

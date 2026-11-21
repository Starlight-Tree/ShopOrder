// 顧客の画面（P1）で使う定数。値の出どころは docs/api.md と docs/order-flow.md（設計の既定。設定値にする前提）。

/** 1 つの変種の数量の上限（PUT /api/cart/items/{variant_id} は 0..20） */
export const MAX_LINE_QTY = 20;

/** 1 回の注文の合計の上限（ルミ。over_limit） */
export const MAX_ORDER_TOTAL_LUMI = 30_000;

/** 開発用ログイン名を入れる Cookie（値は X-Dev-User に付けて API へ渡す） */
export const DEV_USER_COOKIE = 'shop_order_dev_user';

/** API 側の既定の利用者（X-Dev-User が無いとき） */
export const DEFAULT_DEV_USER = 'demo-customer';

/** 注文画面の再取得の間隔（ミリ秒） */
export const POLL_INTERVAL_MS = 5000;

// ---- 宅配（P2）。値は docs/api.md「宅配（P2）」 ----

/** 時間枠を選べる日数。今日から 7 日先まで（今日を含めて 8 日分） */
export const DELIVERY_DAYS_AHEAD = 7;

/** 1 人が持てる住所の数（too_many_addresses） */
export const MAX_ADDRESSES = 10;

/** 住所の入力の上限（文字数）。API の検査と同じ */
export const ADDRESS_LABEL_MAX = 20;
export const ADDRESS_LINE_MAX = 100;
export const ADDRESS_NOTE_MAX = 100;

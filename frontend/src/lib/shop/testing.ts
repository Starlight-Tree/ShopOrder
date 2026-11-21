// テスト用の道具（fetch の差し替えと、API の応答の見本）。アプリ本体からは使わない。
import { vi } from 'vitest';
import type { Cart, CartLine, CheckoutProposal, Order } from '../contract';
import type { MenuItem, Store } from '../types';

export type StubRequest = { method: string; path: string; headers: Record<string, string>; body: unknown };
export type StubReply = { status?: number; body?: unknown } | undefined;

/** fetch を差し替える。handler が undefined を返したら 404。呼ばれた要求は calls に残る */
export function stubApi(handler: (req: StubRequest) => StubReply | Promise<StubReply>) {
  const calls: StubRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const req: StubRequest = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const reply = await handler(req);
    if (!reply) return new Response(JSON.stringify({ detail: { code: 'not_found', message: 'x' } }), { status: 404 });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return { calls };
}

export const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ status, body: { detail: { code, message: '固定の文', ...extra } } });

export const store = (over: Partial<Store> = {}): Store => ({
  id: 1, code: 'residential-main', name: '居住区本店', area: '居住区', address: 'アルカ市居住区1-4-2', open_time: '07:00', close_time: '21:00',
  closed_weekday: null, last_order_minutes: 30, mobile_order: true, seats: 68, accepting_orders: true, closed_reason: null, ...over,
});

export const menuItem = (over: Partial<MenuItem> = {}): MenuItem => ({
  id: 1, code: 'oasis-blend', name: 'オアシスブレンド', category: 'drink', description: '深煎りの 3 種ブレンド', allergens: [],
  season_from: null, season_to: null, sold_from: null, sold_until: null,
  variants: [
    { id: 11, size: 'S', temperature: 'hot', price_lumi: 380, available: true, unavailable_reason: null },
    { id: 12, size: 'M', temperature: 'hot', price_lumi: 450, available: true, unavailable_reason: null },
  ],
  ...over,
});

export const cartLine = (over: Partial<CartLine> = {}): CartLine => ({
  variant_id: 12, item_code: 'oasis-blend', name: 'オアシスブレンド', size: 'M', temperature: 'hot', unit_price_lumi: 450, qty: 2, line_total_lumi: 900,
  available: true, unavailable_reason: null, ...over,
});

export const cart = (over: Partial<Cart> = {}): Cart => ({
  version: 3, store: { id: 1, name: '居住区本店' }, fulfillment: 'pickup', lines: [cartLine()], subtotal_lumi: 900, delivery_fee_lumi: 0, total_lumi: 900, ...over,
});

export const proposal = (over: Partial<CheckoutProposal> = {}): CheckoutProposal => ({
  id: '3f0c9a52-8d9e-4b6e-9a0e-0d3f6b6f9a11', cart_version: 3, total_lumi: 900, expires_at: '2026-11-21T10:10:00Z', store: { id: 1, name: '居住区本店' },
  lines: [cartLine()], pickup_note: '店頭でお渡しします', ...over,
});

export const order = (over: Partial<Order> = {}): Order => ({
  public_id: 'K7M2Q9XD', pickup_no: 12, status: 'placed', fulfillment: 'pickup', store: { id: 1, name: '居住区本店' },
  items: [{ name: 'オアシスブレンド', size: 'M', temperature: 'hot', unit_price_lumi: 450, qty: 2, line_total_lumi: 900 }],
  subtotal_lumi: 900, delivery_fee_lumi: 0, total_lumi: 900, placed_at: '2026-11-21T10:00:00Z', reservation_expires_at: '2026-11-21T10:15:00Z',
  payment: { provider: 'mock', status: 'pending' }, events: [{ to_status: 'placed', at: '2026-11-21T10:00:00Z', actor_type: 'customer', reason: null }],
  cancel_reason: null, can_pay: true, can_cancel: true, ...over,
});

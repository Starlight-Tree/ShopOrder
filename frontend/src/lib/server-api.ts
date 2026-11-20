// 画面のサーバー側から API を呼ぶ共通の関数（書き込み用）。ブラウザーは API を直接呼ばない。
// 失敗（4xx / 5xx）でも例外にせず { ok: false, status, error } を返す。呼ぶ側が code で画面の文言を選ぶ。
// 例外の文面（API のアドレスなど）は画面に出さない。接続できないときは status 0。
import type { ApiErrorBody } from './contract';

const BASE = (process.env.API_BASE_URL ?? 'http://localhost:8400').replace(/\/+$/, '');

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiErrorBody };

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** 顧客の開発用ログイン名（X-Dev-User）。無ければ API 側の既定（demo-customer） */
  devUser?: string;
  /** スタッフのトークン（Authorization: Bearer） */
  staffToken?: string;
  idempotencyKey?: string;
};

const FALLBACK: ApiErrorBody = { code: 'unknown', message: 'うまくいきませんでした。もう一度お試しください' };

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.devUser) headers['X-Dev-User'] = opts.devUser;
  if (opts.staffToken) headers.Authorization = `Bearer ${opts.staffToken}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, error: { code: 'unreachable', message: 'API に接続できません' } };
  }
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  const detail = (json as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && typeof (detail as ApiErrorBody).code === 'string') {
    return { ok: false, status: res.status, error: detail as ApiErrorBody };
  }
  return { ok: false, status: res.status, error: res.status === 422 ? { code: 'invalid_input', message: '入力内容を確かめてください' } : FALLBACK };
}

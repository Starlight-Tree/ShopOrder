import type { MenuItem, Store } from './types';

// 画面のサーバー側（Next.js）から API を呼ぶ。ブラウザーは API を直接呼ばないので、CORS は要らない。
// Docker の Compose では http://api:8000、素の起動では http://localhost:8400。
const BASE = (process.env.API_BASE_URL ?? 'http://localhost:8400').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'API に接続できません');
  }
  // 例外の文面（API のアドレスなど）は画面に出さない。固定の文だけ
  if (!res.ok) throw new ApiError(res.status, `API がエラーを返しました（${res.status}）`);
  return (await res.json()) as T;
}

export const fetchStores = () => get<Store[]>('/api/stores');
export const fetchMenu = () => get<MenuItem[]>('/api/menu');

import { defineConfig, devices } from '@playwright/test';

// E2E は、使い捨ての DB（shop_order_e2e。ダミーの履歴 90 日つき）に向けた本物の API（backend/tests/e2e_server.py）と、
// E2E 用にビルドした Next.js の画面（next start）を、別のポートで立てて、実ブラウザー（Chromium）でつなぐ。
// 決済・配達・通知・チャットは模擬。実 API は呼ばない。ポートは開発用（3400・8400）と重ならない（3401・8401）。
// 前提: TEST_DATABASE_URL（使い捨ての Postgres の管理用 URL。開発コンテナでは設定済み）と、backend/.venv（開発コンテナでは作成済み）。
const API_PORT = Number(process.env.E2E_API_PORT ?? 8401);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3401);
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const PYTHON = process.env.E2E_PYTHON ?? '.venv/bin/python';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts', // vitest の既定の対象（*.test.* / *.spec.*）と重ならない名前
  // 1 つの DB を共有するので、順に流す（注文・在庫が、テスト間で干渉しないように）
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // DB の作り直し → マイグレーション → seed → 待ち受け（seed が終わってから /health が通る）
      command: `${PYTHON} -m tests.e2e_server`,
      cwd: '../backend',
      env: { E2E_API_PORT: String(API_PORT), E2E_WEB_ORIGIN: WEB_URL },
      url: `${API_URL}/health`,
      reuseExistingServer: false, // 古いコードのサーバーを見ないよう、使い回さない
      timeout: 180_000,
    },
    {
      // 画面のサーバー側が、この API を呼ぶ（ブラウザーは API を直接呼ばない）
      command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${WEB_PORT}`,
      env: { API_BASE_URL: API_URL, LOCAL_UTC_OFFSET_HOURS: '9' },
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});

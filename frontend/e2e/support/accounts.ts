import { test, type Browser, type Page } from '@playwright/test';

// seed のデモのアカウント（backend/seed.go）。パスワードは backend/e2e_server.go が渡す値と同じ（ダミー）
export const STAFF_PASSWORD = 'e2e-staff-pass';
export const MAIN_STAFF_EMAIL = 'staff-residential-main@oasis-cafe.example';
export const MANAGER_EMAIL = 'manager@oasis-cafe.example';

/** スタッフ・店長のログイン画面から入る（画面の Cookie に、API のトークンが入る） */
export async function login(page: Page, loginPath: '/staff/login' | '/manager/login', email: string): Promise<void> {
  await page.goto(loginPath);
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /ログイン/ }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'));
}

/** 別の Cookie（別の利用者）の画面を開く。顧客・スタッフ・店長は Cookie も別（CLAUDE.md） */
export async function newPage(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
  const context = await browser.newContext(options);
  return context.newPage();
}

/**
 * 顧客を、テストごとの別の開発用ログイン名（Cookie shop_order_dev_user）にする。カート・住所・注文は利用者ごとなので、
 * テスト同士が干渉しない（既定の demo-customer を共有すると、先のテストの店・受け取り方法がカートに残る）。
 * ログイン名を設定する画面の操作は、本番ビルド（next start）では使えないので、Cookie を直接入れる。
 */
export async function asCustomer(page: Page, name: string): Promise<void> {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('baseURL が未設定です');
  await page.context().addCookies([{ name: 'shop_order_dev_user', value: name, url: baseURL }]);
}

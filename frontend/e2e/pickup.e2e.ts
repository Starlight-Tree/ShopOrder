import { expect, test } from '@playwright/test';
import { MAIN_STAFF_EMAIL, asCustomer, login, newPage } from './support/accounts';

// 店頭受け取りの通し: 顧客が注文して支払う → スタッフが受付〜受け渡し → 顧客の画面が進む。
// 単体テストでは見えない、画面 ↔ 画面のサーバー側 ↔ API ↔ DB のつながりを確かめる。
test('店頭受け取りの注文が、受付から受け渡しまで通る', async ({ page, browser }) => {
  await asCustomer(page, 'e2e-pickup');
  // 顧客: 店を選び、カートに入れて、確認 → 確定 → 支払い（模擬）
  await page.goto('/');
  await page.getByRole('button', { name: '居住区本店を選ぶ' }).click();
  await page.getByRole('button', { name: 'オアシスブレンド（S サイズ・ホット）をカートに入れる' }).click();
  await page.goto('/cart');
  await expect(page.getByText('S サイズ・ホット・380 ルミ')).toBeVisible();
  await page.getByText('注文内容を確認する').click();
  await expect(page.getByRole('heading', { name: 'ご注文内容の確認' })).toBeVisible();
  await page.getByRole('button', { name: '注文を確定する' }).click();
  await page.waitForURL(/\/orders\/[A-Z0-9]+/);
  await expect(page.getByText('お支払いをお待ちしています')).toBeVisible();
  await page.getByRole('button', { name: '支払う（模擬）' }).click();
  await expect(page.getByText('お支払いを確認しました')).toBeVisible();
  const orderUrl = page.url();

  // スタッフ（居住区本店）: 受付待ちに出る → 受ける → 調理開始 → 準備完了 → 渡した
  const staff = await newPage(browser);
  await login(staff, '/staff/login', MAIN_STAFF_EMAIL);
  await expect(staff).toHaveURL(/\/staff$/);
  const card = staff.getByRole('article').filter({ hasText: 'オアシスブレンド' }).first();
  await expect(card).toBeVisible();
  // 他店（居住区ドーム店）のスタッフのボードには、この注文は出ない（権限は API が毎回確認する）。ボードが描画されたことも確かめる
  const other = await newPage(browser);
  await login(other, '/staff/login', 'staff-residential-dome@oasis-cafe.example');
  await expect(other.getByText('居住区ドーム店のスタッフ')).toBeVisible();
  await expect(other.getByRole('heading', { name: /受付待ち/ })).toBeVisible();
  await expect(other.getByRole('article').filter({ hasText: 'オアシスブレンド' })).toHaveCount(0);

  for (const label of ['受ける', '調理開始', '準備完了', '渡した']) {
    await card.getByRole('button', { name: label, exact: true }).click();
    if (label !== '渡した') await expect(staff.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
  await expect(staff.getByText(/を渡し済みにしました/)).toBeVisible();

  // 顧客の画面（5 秒ごとの自動更新、または再読み込み）が、受け取り済みになる
  await page.goto(orderUrl);
  await expect(page.getByText('お受け取りありがとうございました')).toBeVisible();
});

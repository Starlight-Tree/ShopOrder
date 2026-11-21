import { expect, type Page } from '@playwright/test';

/**
 * 店を選び、品をカートに入れる。カートへの追加（サーバーアクション）が終わるまで待つ（ヘッダーの「カート（N 点）」が変わるまで）。
 * 待たずに /cart へ移ると、書き込みと読み込みが競合して、空のカートを見ることがある。
 */
export async function addToCart(page: Page, store: string, itemLabel: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: `${store}を選ぶ` }).click();
  await page.getByRole('button', { name: itemLabel }).click();
  await expect(page.getByRole('link', { name: /カート.*（1 点）/ })).toBeVisible();
}

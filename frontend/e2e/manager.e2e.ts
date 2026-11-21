import { expect, test, type Page } from '@playwright/test';
import { MANAGER_EMAIL, login, newPage } from './support/accounts';

// 店長の分析（/manager）。docs/analytics.md の「未確認」だった目視を、実ブラウザーで毎回確かめる:
// グラフが描画される（Recharts v3 の幅 0 の不具合の再発を防ぐ）・390px で横スクロールが出ない・週月の切り替え・店の切り替え・
// 「表で見る」・コホートの表・ツールチップ・ダーク。ダミーの履歴 90 日つきの DB（全店の店長）。
const PAGES = ['/manager', '/manager/sales', '/manager/products', '/manager/hours', '/manager/stock', '/manager/customers'];
// グラフ（Recharts の svg。凡例の小さな svg は数えない）を持つ画面（時間帯は HTML の表だけ）
const CHART_PAGES = PAGES.filter((p) => p !== '/manager/hours');

async function openManager(page: Page, path: string) {
  await page.goto(path);
}

/** 動的 import のグラフが描画されるまで待ち、幅 0 の外枠でないこと（Recharts v3 の不具合）を確かめる */
async function expectChartsRendered(page: Page) {
  const surfaces = page.locator('.recharts-wrapper > svg.recharts-surface');
  await expect(surfaces.first()).toBeVisible();
  for (const box of await Promise.all((await surfaces.all()).map((s) => s.boundingBox()))) {
    expect(box?.width ?? 0).toBeGreaterThan(50);
    expect(box?.height ?? 0).toBeGreaterThan(50);
  }
}

test.describe('ライト・デスクトップ', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, '/manager/login', MANAGER_EMAIL);
  });

  for (const path of CHART_PAGES) {
    test(`${path}: グラフが描画される`, async ({ page }) => {
      await openManager(page, path);
      await expectChartsRendered(page);
    });
  }

  test('売上: 日・週・月を切り替えられる', async ({ page }) => {
    await openManager(page, '/manager/sales');
    const grain = page.getByRole('navigation', { name: '集計の単位' });
    await grain.getByRole('link', { name: '週' }).click();
    await expect(page).toHaveURL(/grain=week/);
    await expectChartsRendered(page);
    await grain.getByRole('link', { name: '月' }).click();
    await expect(page).toHaveURL(/grain=month/);
    await expectChartsRendered(page);
    await expect(grain.getByRole('link', { name: '月' })).toHaveAttribute('aria-current', /.+/);
  });

  test('概況: 店を切り替えると、その店の表示になる', async ({ page }) => {
    await openManager(page, '/manager');
    await page.getByLabel('表示する店').selectOption({ label: '居住区本店' });
    await page.getByRole('button', { name: '切り替える' }).click();
    await expect(page).toHaveURL(/store=\d+/);
    await expect(page.getByLabel('表示する店')).toHaveValue(/\d+/);
    await expectChartsRendered(page);
  });

  test('売上: 「表で見る」で同じ数字の表になり、「グラフ」で戻る', async ({ page }) => {
    await openManager(page, '/manager/sales');
    await expectChartsRendered(page);
    const card = page.locator('section.mg-card').filter({ has: page.getByRole('heading', { name: '売上の推移（日ごと）' }) });
    await card.getByRole('button', { name: '表で見る' }).click();
    await expect(card.getByRole('table')).toBeVisible();
    expect(await card.getByRole('row').count()).toBeGreaterThan(10);
    await expect(card.locator('.recharts-wrapper > svg.recharts-surface')).toHaveCount(0);
    await card.getByRole('button', { name: 'グラフ' }).click();
    await expect(card.locator('.recharts-wrapper > svg.recharts-surface')).toBeVisible();
  });

  test('売上: グラフに重ねると、ツールチップが出る', async ({ page }) => {
    await openManager(page, '/manager/sales');
    const surface = page.locator('.recharts-wrapper > svg.recharts-surface').first();
    await expect(surface).toBeVisible();
    const box = (await surface.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2 + 2);
    await expect(page.locator('.recharts-tooltip-wrapper').filter({ hasText: /ルミ/ }).first()).toBeVisible();
  });

  test('顧客: RFM の表とコホートの表が出て、5 人未満は伏せる', async ({ page }) => {
    await openManager(page, '/manager/customers');
    const rfm = page.getByRole('table', { name: /最後の注文の新しさ（行）と、注文回数（列）ごとの人数/ });
    await expect(rfm).toBeVisible();
    const cohort = page.getByRole('table', { name: /初回月ごとの、経過月ごとの継続の割合/ });
    await expect(cohort).toBeVisible();
    expect(await cohort.getByRole('row').count()).toBeGreaterThan(2);
    // 5 人未満のセルは、人数を出さない（個人が特定されないように）
    await expect(page.getByText('人数のセルは、5 人未満のとき出しません')).toBeVisible();
    for (const cell of await rfm.getByRole('cell').allInnerTexts()) {
      expect(cell).not.toMatch(/^[1-4] 人$/);
    }
  });
});

test.describe('スマートフォン幅（390px）', () => {
  for (const path of PAGES) {
    test(`${path}: 横スクロールが出ない`, async ({ browser }) => {
      const page = await newPage(browser, { viewport: { width: 390, height: 844 } });
      await login(page, '/manager/login', MANAGER_EMAIL);
      await openManager(page, path);
      if (CHART_PAGES.includes(path)) await expectChartsRendered(page);
      const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    });
  }
});

test.describe('ダーク', () => {
  for (const path of CHART_PAGES) {
    test(`${path}: ダークでも描画され、背景が暗い`, async ({ browser }) => {
      const page = await newPage(browser, { colorScheme: 'dark' });
      await login(page, '/manager/login', MANAGER_EMAIL);
      await openManager(page, path);
      await expectChartsRendered(page);
      const [r, g, b] = (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).match(/\d+/g)!.map(Number) as [number, number, number];
      expect((r + g + b) / 3).toBeLessThan(100);
    });
  }
});

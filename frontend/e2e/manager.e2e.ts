import { expect, test, type Locator, type Page } from '@playwright/test';
import { MANAGER_EMAIL, login, newPage } from './support/accounts';

// 店長の分析（/manager）。docs/analytics.md の「未確認」だった目視のうち、機械で判定できる分を、実ブラウザーで毎回確かめる:
// グラフが描画される（Recharts v3 の幅 0 の不具合の再発を防ぐ。線・棒が実際に描かれることまで）・390px で横スクロールが出ない・
// 週月の切り替え・店の切り替え・「表で見る」・ツールチップ・コホートの表・ダーク。ダミーの履歴 90 日つきの DB（全店の店長）。
// 文字の切れや色の読みやすさのような、見た目の良し悪しは判定できない（目視）。
const PAGES = ['/manager', '/manager/sales', '/manager/products', '/manager/hours', '/manager/stock', '/manager/customers'];

const LINE = '.recharts-line-curve';
const BAR = '.recharts-bar-rectangle';
// グラフを持つ画面ごとの、グラフのカード（見出し）と、描かれているはずの印（線・棒）。時間帯は HTML の表だけ（別のテスト）
const CHARTS: Record<string, { title: string; mark: string }[]> = {
  '/manager': [{ title: '売上の推移（日ごと）', mark: LINE }],
  '/manager/sales': [{ title: '売上の推移（日ごと）', mark: LINE }],
  '/manager/products': [{ title: '商品別の売上', mark: BAR }],
  '/manager/stock': [
    { title: '在庫の残日数', mark: BAR },
    { title: '廃棄の量と理由', mark: BAR },
  ],
  '/manager/customers': [{ title: 'RFM の分布（区分ごとの人数）', mark: BAR }],
};
const CHART_PAGES = Object.keys(CHARTS);

function card(page: Page, title: string): Locator {
  return page.locator('section.mg-card').filter({ has: page.getByRole('heading', { name: title }) });
}

/**
 * グラフが描かれていること。外枠（svg）の幅・高さが 0 でない（以前の不具合の再発を防ぐ）だけでなく、線・棒が実際にあり、
 * 「データなし」の文（mg-empty）に置き換わっていないことまで見る。凡例の小さな svg は数えない。
 */
async function expectChartsRendered(page: Page, path: string) {
  for (const { title, mark } of CHARTS[path] ?? []) {
    const c = card(page, title);
    const surface = c.locator('.recharts-wrapper > svg.recharts-surface');
    await expect(surface, `${path}「${title}」のグラフ`).toBeVisible();
    const box = (await surface.boundingBox())!;
    expect(box.width, `${title}の幅`).toBeGreaterThan(50);
    expect(box.height, `${title}の高さ`).toBeGreaterThan(50);
    expect(await c.locator(mark).count(), `${title}に線・棒がある`).toBeGreaterThan(0);
    await expect(c.locator('.mg-empty')).toHaveCount(0);
  }
}

function rgb(color: string): [number, number, number, number] {
  const m = color.match(/[\d.]+/g)?.map(Number);
  if (!m || m.length < 3) throw new Error(`色を読めません: ${color}`);
  return [m[0]!, m[1]!, m[2]!, m[3] ?? 1];
}
const luminance = ([r, g, b]: number[]) => (r! + g! + b!) / 3;

test.describe('ライト・デスクトップ', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, '/manager/login', MANAGER_EMAIL);
  });

  for (const path of CHART_PAGES) {
    test(`${path}: グラフが描かれる`, async ({ page }) => {
      await page.goto(path);
      await expectChartsRendered(page, path);
    });
  }

  test('時間帯: ヒートマップの表が出る', async ({ page }) => {
    await page.goto('/manager/hours');
    await expect(page.getByRole('heading', { name: '曜日 × 時間帯', level: 1 })).toBeVisible();
    const heat = page.getByTestId('heatmap');
    await expect(heat).toBeVisible();
    expect(await heat.getByRole('row').count()).toBeGreaterThan(2);
    // 数字が入っている（色だけに頼らない）
    expect(await heat.locator('td').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringMatching(/^[1-9]\d*$/)]));
    await expect(page.getByText('読み込めませんでした')).toHaveCount(0); // 失敗の表示（Notice）が出ていない
  });

  test('売上: 日・週・月に切り替えると、集計の単位が変わる', async ({ page }) => {
    await page.goto('/manager/sales');
    const grain = page.getByRole('navigation', { name: '集計の単位' });
    await grain.getByRole('link', { name: '週' }).click();
    await expect(page).toHaveURL(/grain=week/);
    // URL ではなく、API が返した集計の単位（見出し・表の期間の見出し）で確かめる
    await expect(page.getByRole('heading', { name: '売上の推移（週ごと）' })).toBeVisible();
    await card(page, '売上の推移（週ごと）').getByRole('button', { name: '表で見る' }).click();
    await expect(card(page, '売上の推移（週ごと）').getByRole('rowheader').first()).toContainText('週');
    await grain.getByRole('link', { name: '月' }).click();
    await expect(page).toHaveURL(/grain=month/);
    await expect(page.getByRole('heading', { name: '売上の推移（月ごと）' })).toBeVisible();
    await expect(grain.getByRole('link', { name: '月' })).toHaveAttribute('aria-current', /.+/);
    await card(page, '売上の推移（月ごと）').getByRole('button', { name: '表で見る' }).click();
    await expect(card(page, '売上の推移（月ごと）').getByRole('rowheader').first()).toContainText(/\d+ 年 \d+ 月/);
    await grain.getByRole('link', { name: '日' }).click();
    await expect(page.getByRole('heading', { name: '売上の推移（日ごと）' })).toBeVisible();
    // 「表で見る」の状態は、切り替えをまたいで保たれる（同じカード）。グラフに戻して、描かれることを確かめる
    await card(page, '売上の推移（日ごと）').getByRole('button', { name: 'グラフ' }).click();
    await expectChartsRendered(page, '/manager/sales');
  });

  test('概況: 店を切り替えると、全店の表示から、その店の表示になる', async ({ page }) => {
    await page.goto('/manager');
    // 全店のときだけ出る注記（「全 12 店のうち … 店が営業日です」）
    await expect(page.getByText(/全 \d+ 店のうち \d+ 店が営業日です/)).toBeVisible();
    await page.getByLabel('表示する店').selectOption({ label: '居住区本店' });
    await page.getByRole('button', { name: '切り替える' }).click();
    await expect(page).toHaveURL(/store=\d+/);
    await expect(page.getByText(/全 \d+ 店のうち/)).toHaveCount(0); // 絞り込みが効いて、店の分の表示になる
    await expect(page.getByLabel('表示する店')).toHaveValue(/\d+/);
    await expectChartsRendered(page, '/manager');
  });

  test('売上: 「表で見る」で日ごとの表になり、「グラフ」で戻る', async ({ page }) => {
    await page.goto('/manager/sales');
    await expectChartsRendered(page, '/manager/sales');
    const c = card(page, '売上の推移（日ごと）');
    await c.getByRole('button', { name: '表で見る' }).click();
    await expect(c.getByRole('table')).toBeVisible();
    expect(await c.getByRole('row').count()).toBeGreaterThan(10);
    // 売上の列に、ルミの数字が入っている（休業の日は「—」）
    expect(await c.locator('td[data-label="売上"]').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringMatching(/\d[\d,]*\s*ルミ/)]));
    await expect(c.locator('.recharts-wrapper > svg.recharts-surface')).toHaveCount(0);
    await c.getByRole('button', { name: 'グラフ' }).click();
    await expect(c.locator('.recharts-wrapper > svg.recharts-surface')).toBeVisible();
  });

  test('売上: グラフに重ねると、ツールチップが出る', async ({ page }) => {
    await page.goto('/manager/sales');
    const surface = card(page, '売上の推移（日ごと）').locator('.recharts-wrapper > svg.recharts-surface');
    await expect(surface).toBeVisible();
    const box = (await surface.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2 + 2);
    await expect(page.locator('.recharts-tooltip-wrapper').filter({ hasText: /ルミ/ }).first()).toBeVisible();
  });

  test('顧客: RFM とコホートの表が出て、5 人未満の人数は伏せる', async ({ page }) => {
    await page.goto('/manager/customers');
    const rfm = page.getByRole('table', { name: /最後の注文の新しさ（行）と、注文回数（列）ごとの人数/ });
    const cohort = page.getByRole('table', { name: /初回月ごとの、経過月ごとの継続の割合/ });
    await expect(rfm).toBeVisible();
    await expect(cohort).toBeVisible();
    expect(await cohort.getByRole('row').count()).toBeGreaterThan(2);
    await expect(page.getByText('人数のセルは、5 人未満のとき出しません')).toBeVisible();
    const rfmCells = await rfm.getByRole('cell').allInnerTexts();
    expect(rfmCells.some((t) => t.includes('5 人未満')), '伏せられたセルが 1 つはある（ダミーの顧客の分布）').toBe(true);
    expect(rfmCells.filter((t) => /^[1-4] 人$/.test(t.trim())), 'RFM に 1〜4 人の数字が出ない').toEqual([]);
    // コホート: 経過月ごとの「割合（人数）」と、初回月の人数の列にも、1〜4 人の数字が出ない
    const cohortCells = [...(await cohort.getByRole('cell').allInnerTexts()), ...(await cohort.getByRole('rowheader').allInnerTexts())];
    expect(cohortCells.filter((t) => /（[1-4] 人）|^[1-4] 人$/.test(t.trim())), 'コホートに 1〜4 人の数字が出ない').toEqual([]);
  });
});

test.describe('スマートフォン幅（390px）', () => {
  for (const path of PAGES) {
    test(`${path}: 横スクロールが出ない`, async ({ browser }) => {
      const page = await newPage(browser, { viewport: { width: 390, height: 844 } });
      await login(page, '/manager/login', MANAGER_EMAIL);
      await page.goto(path);
      if (path in CHARTS) await expectChartsRendered(page, path);
      else await expect(page.getByTestId('heatmap')).toBeVisible();
      const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    });
  }
});

test.describe('ダーク', () => {
  for (const path of CHART_PAGES) {
    test(`${path}: ダークでもグラフが描かれ、地と文字が暗い・明るい`, async ({ browser }) => {
      const page = await newPage(browser, { colorScheme: 'dark' });
      await login(page, '/manager/login', MANAGER_EMAIL);
      await page.goto(path);
      await expectChartsRendered(page, path);
      // ページの地・カードの地は暗く（透明でない）、本文の文字は明るい。ダーク用の色の変数が効いている印
      const colors = await page.evaluate(() => {
        const bg = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : '');
        return { body: bg(document.body), card: bg(document.querySelector('section.mg-card')), text: getComputedStyle(document.querySelector('main h1') ?? document.body).color };
      });
      const body = rgb(colors.body);
      const cardBg = rgb(colors.card);
      expect(body[3], 'ページの地は透明でない').toBeGreaterThan(0);
      expect(cardBg[3], 'カードの地は透明でない').toBeGreaterThan(0);
      expect(luminance(body), 'ページの地が暗い').toBeLessThan(100);
      expect(luminance(cardBg), 'カードの地が暗い').toBeLessThan(100);
      expect(luminance(rgb(colors.text)), '本文の文字が明るい').toBeGreaterThan(150);
    });
  }
});

import { expect, test } from '@playwright/test';
import { MAIN_STAFF_EMAIL, asCustomer, login, newPage } from './support/accounts';
import { addToCart } from './support/shop';

const COURIER_EMAIL = 'courier-residential-main-1@oasis-cafe.example';

// 宅配の通し: 顧客（住所・時間枠・暗証コード）→ スタッフ（調理）→ 配車（配達員の割り当て）→ 配達員（集荷・出発・暗証コードで完了）→ 顧客の画面。
// 4 つの役割は、アカウントも Cookie も別（CLAUDE.md）。
test('宅配の注文が、住所の登録から暗証コードでの受け渡しまで通る', async ({ page, browser }) => {
  await asCustomer(page, 'e2e-delivery');
  // 顧客: 住所を登録する
  await page.goto('/addresses');
  await page.getByLabel(/ラベル/).fill('自宅');
  await page.locator('#address-area').selectOption({ label: '居住区' });
  await page.locator('#address-line').fill('アルカ市居住区2-1-5 305');
  await page.getByRole('button', { name: '住所を登録する' }).click();
  await expect(page.getByText('住所を登録しました')).toBeVisible();

  // 顧客: 店・品・宅配・住所・時間枠を選ぶ
  await addToCart(page, '居住区本店', 'オアシスブレンド（S サイズ・ホット）をカートに入れる');
  await page.goto('/cart');
  // 宅配には最低注文額（品の小計 600 ルミ）がある。380 ルミの品を 2 つにして、760 ルミにする
  await page.getByRole('button', { name: 'オアシスブレンドを 1 つ増やす' }).click();
  await expect(page.getByRole('group', { name: 'オアシスブレンドの数量' })).toContainText('2');
  await page.getByRole('button', { name: '受け取り方法を宅配にする' }).click();
  await page.getByRole('button', { name: '自宅をお届け先にする' }).click();
  await expect(page.getByRole('heading', { name: 'お届けの時間枠を選ぶ' })).toBeVisible();
  // 今日の枠に頼らない: 店の時刻で夜（19 時過ぎ）は、今日の枠が 1 つも無く、残りの短い枠は途中で締まる。
  // 明日の最後の枠なら、いつ流しても選べて、テストの途中で締まらない（居住区本店は定休日が無い）
  await page.getByRole('navigation', { name: 'お届けの日付' }).getByRole('link', { name: /^明日/ }).click();
  await expect(page).toHaveURL(/date=/);
  const slot = page.locator('.shop-slots button:not([disabled])').last();
  await expect(slot).toBeVisible();
  await slot.click();
  await expect(page.getByText('お届けの時間枠を選んでください。')).toHaveCount(0);
  await page.getByText('注文内容を確認する').click();
  await expect(page.getByRole('heading', { name: 'ご注文内容の確認' })).toBeVisible();
  await expect(page.getByText('自宅（居住区）')).toBeVisible();
  await expect(page.getByText('受け取り用の暗証コード（4 桁）が表示されます')).toBeVisible(); // 集荷後に出る、という案内
  await page.getByRole('button', { name: '注文を確定する' }).click();
  await page.waitForURL(/\/orders\/[A-Z0-9]+/);
  await page.getByRole('button', { name: '支払う（模擬）' }).click();
  await expect(page.getByText('お支払いを確認しました')).toBeVisible();
  const orderUrl = page.url();


  // スタッフ: 受付 → 調理 → 準備完了
  const staff = await newPage(browser);
  await login(staff, '/staff/login', MAIN_STAFF_EMAIL);
  const card = staff.getByRole('article').filter({ hasText: 'オアシスブレンド' }).first();
  for (const label of ['受ける', '調理開始', '準備完了']) {
    await card.getByRole('button', { name: label, exact: true }).click();
    await expect(staff.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }

  // 配車: 配達員を割り当てる
  await staff.goto('/staff/dispatch');
  const dispatchCard = staff.getByRole('article').filter({ hasText: 'オアシスブレンド' }).first();
  await expect(dispatchCard).toBeVisible();
  await dispatchCard.getByRole('button', { name: '割り当てる' }).click();
  await expect(staff.getByRole('button', { name: '付け替える' }).first()).toBeVisible();

  // 配達員が決まっても、集荷の前は暗証コードが出ない（集荷後だけ。状態の文を先に待つので、空振りで通らない）
  await page.goto(orderUrl);
  await expect(page.locator('.shop-status')).toContainText('配達員が決まりました');
  await expect(page.locator('.shop-pin')).toHaveCount(0);

  // 配達員: 集荷 → 出発 → 到着・暗証コードで確認（間違った暗証コードは通らない）
  const courier = await newPage(browser);
  await login(courier, '/staff/login', COURIER_EMAIL);
  await expect(courier).toHaveURL(/\/staff\/courier/);
  const job = courier.getByRole('article').filter({ hasText: 'オアシスブレンド' }).first();
  await job.getByRole('button', { name: '集荷した' }).click();
  await expect(job.getByRole('button', { name: '出発する' })).toBeVisible();

  // 顧客の画面に、集荷後だけ暗証コード（4 桁）が出る。配達員の画面には出ない（お客さまから聞く値）
  await page.goto(orderUrl);
  await expect(page.locator('.shop-pin')).toBeVisible();
  const pin = (await page.locator('.shop-pin-code [aria-hidden="true"]').innerText()).trim();
  expect(pin).toMatch(/^\d{4}$/);
  await expect(courier.locator('body')).not.toContainText(pin);

  await job.getByRole('button', { name: '出発する' }).click();
  await job.getByRole('button', { name: '到着・暗証コードで確認' }).click();
  const wrong = pin === '0000' ? '1111' : '0000'; // 間違った暗証コードでは、完了にならない
  await courier.getByLabel(/暗証コード/).fill(wrong);
  await courier.getByRole('button', { name: '暗証コードを確認して完了' }).click();
  // 間違いの応答を待つ（応答が、入力欄を消すことがあるため、先に正しい値を入れない）
  await expect(courier.locator('.cr-message')).toContainText('暗証コードが違います');
  await courier.getByLabel(/暗証コード/).fill(pin);
  await courier.getByRole('button', { name: '暗証コードを確認して完了' }).click();
  await expect(courier.locator('.cr-message')).not.toContainText('暗証コードが違います');
  await expect(courier.locator('.cr-message .st-message-label')).toHaveText('完了');

  // 顧客の画面が、お届け済みになる
  await page.goto(orderUrl);
  await expect(page.locator('.shop-status')).toContainText('お届けしました。ありがとうございました'); // 進み具合の見出し（「お届け済み」）は、お届け前も出るので使わない
  await expect(page.locator('.shop-pin')).toHaveCount(0); // 済んだ注文には、暗証コードを出さない
});

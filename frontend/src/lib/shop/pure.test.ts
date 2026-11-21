import { describe, expect, it } from 'vitest';
import { formatLumi } from '../format';
import { remainingSeconds, formatRemaining } from './countdown';
import { devToolsEnabled, devUserFromCookie, isValidDevUser } from './dev-user';
import { describeError, noticeText } from './errors';
import { formatClock, formatDateTime, cartCount, zoneFromOffset } from './format';
import { formString, isValidPublicId, isValidToken, parseId, parseQty, parseSimulate } from './input';
import { closedReasonText, parseCategory, unavailableReasonText, variantLabel } from './labels';
import { cancelReasonText, eventTimes, isTerminalStatus, orderSteps, statusHeadline, statusLabel } from './order-steps';
import { cart, cartLine, menuItem, store } from './testing';
import { checkoutBlockers, filterMenu, groupStoresByArea, storeNote, storeStatus, variantState } from './view';

describe('金額（ルミ）', () => {
  it('桁区切りと「ルミ」。1,350 ルミ', () => {
    expect(formatLumi(1350)).toBe('1,350 ルミ');
    expect(formatLumi(0)).toBe('0 ルミ');
  });
});

describe('残り時間', () => {
  const exp = '2026-11-21T10:15:00Z';
  it('残り秒は切り上げ。過ぎたら 0（負にしない）', () => {
    expect(remainingSeconds(exp, Date.parse('2026-11-21T10:00:00Z'))).toBe(900);
    expect(remainingSeconds(exp, Date.parse('2026-11-21T10:14:59.200Z'))).toBe(1);
    expect(remainingSeconds(exp, Date.parse('2026-11-21T10:15:00Z'))).toBe(0);
    expect(remainingSeconds(exp, Date.parse('2026-11-21T11:00:00Z'))).toBe(0);
  });
  it('読めない時刻は null', () => {
    expect(remainingSeconds('いつか', 0)).toBeNull();
  });
  it('分と秒で表す', () => {
    expect(formatRemaining(872)).toBe('14 分 32 秒');
    expect(formatRemaining(60)).toBe('1 分 0 秒');
    expect(formatRemaining(45)).toBe('45 秒');
    expect(formatRemaining(0)).toBe('0 秒');
    expect(formatRemaining(-5)).toBe('0 秒');
  });
});

describe('エラーの code → 固定の日本語（直し方つき）', () => {
  it.each([
    ['cart_empty', 'カートが空です', '/'],
    ['store_not_selected', '受け取る店が選ばれていません', '/'],
    ['item_unavailable', '今は注文できない品', '/cart'],
    ['over_limit', '30,000 ルミ以内です', '/cart'],
    ['proposal_expired', '有効期限が切れました', '/checkout'],
    ['proposal_stale', 'カートの内容が変わりました', '/checkout'],
    ['idempotency_conflict', '別の内容で使われています', '/checkout'],
    ['reservation_expired', '期限が切れた', '/'],
    ['payment_declined', 'お支払いに失敗しました（模擬）', '/'],
  ])('%s', (code, fragment, href) => {
    const info = describeError({ code });
    expect(info.text).toContain(fragment);
    expect(info.next?.href).toBe(href);
  });

  it('store_closed は closed_reason を日本語にして添える。未知の理由でも固定の文', () => {
    expect(describeError({ code: 'store_closed', closed_reason: 'outside_hours' }).text).toContain('営業時間外です');
    expect(describeError({ code: 'store_closed', closed_reason: 'past_last_order' }).text).toContain('ラストオーダーを過ぎました');
    expect(describeError({ code: 'store_closed', closed_reason: '<script>' }).text).toContain('今は注文を受け付けていません');
  });

  it('sold_out は品の名前を入れる。名前が無ければ「カートの品」', () => {
    expect(describeError({ code: 'sold_out', item_name: 'ミートパイ' }).text).toContain('「ミートパイ」は売り切れました');
    expect(describeError({ code: 'sold_out' }).text).toContain('カートの品は売り切れました');
  });

  it('未知の code・API の message・例外の文字列は、画面に出さない', () => {
    const info = describeError({ code: 'boom', message: 'Traceback /srv/app/secret.py' });
    expect(info.text).toBe('うまくいきませんでした。しばらくしてから、もう一度お試しください。');
    expect(info.text).not.toContain('Traceback');
    expect(describeError({ code: 'unreachable' }).text).toContain('接続できませんでした');
    expect(describeError({ code: 'x' }, 404).text).toBe('見つかりませんでした。');
  });

  it('?notice= は既知の 3 つだけ文にする', () => {
    expect(noticeText('payment_declined')).toContain('お支払いに失敗');
    expect(noticeText(['reservation_expired'])).toContain('期限');
    expect(noticeText('not_cancellable')).toContain('お店にお伝えください');
    expect(noticeText('<b>x</b>')).toBeNull();
    expect(noticeText(undefined)).toBeNull();
  });
});

describe('注文の状態 → 進み', () => {
  it('placed は 1 つ目が現在、残りがこれから', () => {
    const steps = orderSteps('placed')!;
    expect(steps.map((s) => s.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(steps[0]?.label).toBe('お支払い待ち');
  });
  it('ready は、手前が完了・ready が現在・completed がこれから', () => {
    const steps = orderSteps('ready')!;
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'current', 'upcoming']);
    expect(steps[4]?.label).toBe('受け取れます');
  });
  it('completed は全部完了。cancelled は進みを出さない（別表示）', () => {
    expect(orderSteps('completed')!.every((s) => s.state === 'done')).toBe(true);
    expect(orderSteps('cancelled')).toBeNull();
  });
  it('見出し・ラベル。未知の状態でも固定の文', () => {
    expect(statusLabel('paid')).toBe('支払い済み');
    expect(statusHeadline('cancelled')).toBe('この注文は取消されました');
    expect(statusLabel('refunded')).toBe('状態を確認中');
    expect(statusHeadline('refunded')).toBe('状態を確認しています');
  });
  it('終了状態は completed と cancelled だけ', () => {
    expect(['completed', 'cancelled'].map(isTerminalStatus)).toEqual([true, true]);
    expect(['placed', 'paid', 'accepted', 'preparing', 'ready'].some(isTerminalStatus)).toBe(false);
  });
  it('events からは、状態ごとの最初の時刻だけを取る', () => {
    const t = eventTimes([
      { to_status: 'placed', at: 'A' },
      { to_status: 'paid', at: 'B' },
      { to_status: 'paid', at: 'C' },
    ]);
    expect(t).toEqual({ placed: 'A', paid: 'B' });
  });
  it('latest（宅配の再配達）なら、状態ごとの最後の時刻。繰り返されない状態は同じ', () => {
    const events = [
      { to_status: 'placed' as const, at: 'A' },
      { to_status: 'ready' as const, at: 'B' },
      { to_status: 'delivery_failed' as const, at: 'C' },
      { to_status: 'ready' as const, at: 'D' },
    ];
    expect(eventTimes(events, true)).toEqual({ placed: 'A', ready: 'D', delivery_failed: 'C' });
    expect(eventTimes(events)).toEqual({ placed: 'A', ready: 'B', delivery_failed: 'C' });
  });
  it('取消しの理由: 既知の code は固定の文、未知の code は出さない、店が書いた文はそのまま', () => {
    expect(cancelReasonText('payment_declined')).toBe('お支払いに失敗したため');
    expect(cancelReasonText('some_internal_code')).toBeNull();
    expect(cancelReasonText('材料が切れたため')).toBe('材料が切れたため');
    expect(cancelReasonText(null)).toBeNull();
  });
});

describe('開発用ログイン名', () => {
  it('[a-z0-9-]{1,40} だけ通す', () => {
    expect(isValidDevUser('demo-customer')).toBe(true);
    expect(isValidDevUser('a'.repeat(40))).toBe(true);
    expect(isValidDevUser('a'.repeat(41))).toBe(false);
    expect(isValidDevUser('')).toBe(false);
    expect(isValidDevUser('Alice')).toBe(false);
    expect(isValidDevUser('a b')).toBe(false);
    expect(isValidDevUser('a\r\nX-Evil: 1')).toBe(false);
    expect(isValidDevUser(undefined)).toBe(false);
  });
  it('Cookie の値が規則に合わなければ、ヘッダーに入れない', () => {
    expect(devUserFromCookie('alice-1')).toBe('alice-1');
    expect(devUserFromCookie('Bad Value')).toBeUndefined();
    expect(devUserFromCookie(undefined)).toBeUndefined();
  });
  it('本番では開発用の道具を出さない', () => {
    expect(devToolsEnabled('production')).toBe(false);
    expect(devToolsEnabled('development')).toBe(true);
    expect(devToolsEnabled('test')).toBe(true);
  });
});

describe('Server Action へ届く値の検査', () => {
  it('ID・数量は整数の範囲だけ', () => {
    expect(parseId('12')).toBe(12);
    expect(parseId('0')).toBeNull();
    expect(parseId('1; DROP')).toBeNull();
    expect(parseId('-3')).toBeNull();
    expect(parseId(null)).toBeNull();
    expect(parseQty('0')).toBe(0);
    expect(parseQty('20')).toBe(20);
    expect(parseQty('21')).toBeNull();
    expect(parseQty('-1')).toBeNull();
    expect(parseQty('1.5')).toBeNull();
  });
  it('注文の公開 ID は記号を許さない（URL のパスに入れるため）', () => {
    expect(isValidPublicId('K7M2Q9XD')).toBe(true);
    expect(isValidPublicId('../admin')).toBe(false);
    expect(isValidPublicId('K7M2/Q9XD')).toBe(false);
    expect(isValidPublicId('AB')).toBe(false);
  });
  it('冪等キー・提案の ID は 8〜64 文字の英数字とハイフン', () => {
    expect(isValidToken('3f0c9a52-8d9e-4b6e-9a0e-0d3f6b6f9a11')).toBe(true);
    expect(isValidToken('short')).toBe(false);
    expect(isValidToken('a'.repeat(65))).toBe(false);
    expect(isValidToken('abcdefgh ijkl')).toBe(false);
    expect(isValidToken(null)).toBe(false);
  });
  it('simulate は ok / decline だけ。FormData は文字列だけ取り出す', () => {
    expect(parseSimulate('ok')).toBe('ok');
    expect(parseSimulate('decline')).toBe('decline');
    expect(parseSimulate('fail')).toBeNull();
    const fd = new FormData();
    fd.set('a', 'x');
    fd.set('f', new File(['x'], 'x.txt'));
    expect(formString(fd, 'a')).toBe('x');
    expect(formString(fd, 'f')).toBeNull();
    expect(formString(fd, 'none')).toBeNull();
  });
});

describe('日時・点数', () => {
  it('24 時間制で、月/日 時:分（指定した時間帯で）', () => {
    expect(formatDateTime('2026-11-21T10:05:00Z', 'UTC')).toBe('11/21 10:05');
    expect(formatDateTime('2026-11-21T10:05:00Z', 'Asia/Tokyo')).toBe('11/21 19:05');
    expect(formatDateTime('2026-11-21T00:05:00Z', 'UTC')).toBe('11/21 00:05');
    expect(formatClock('2026-11-21T10:05:00Z', 'UTC')).toBe('10:05');
    expect(formatDateTime('いつか', 'UTC')).toBe('');
  });
  it('カートの点数は数量の合計', () => {
    expect(cartCount(null)).toBe(0);
    expect(cartCount(cart({ lines: [cartLine({ qty: 2 }), cartLine({ variant_id: 13, qty: 3 })] }))).toBe(5);
  });
});

describe('ラベル', () => {
  it('変種: サイズ・温度。"-" は無いこと。両方無ければ「通常」', () => {
    expect(variantLabel({ size: 'M', temperature: 'hot' })).toBe('M サイズ・ホット');
    expect(variantLabel({ size: 'L', temperature: 'ice' })).toBe('L サイズ・アイス');
    expect(variantLabel({ size: '-', temperature: '-' })).toBe('通常');
    expect(variantLabel({ size: 'M', temperature: '-' })).toBe('M サイズ');
  });
  it('理由は固定の文。未知・null でも出る', () => {
    expect(closedReasonText('closed_today')).toBe('本日は定休日です');
    expect(closedReasonText('temporary_closure')).toBe('臨時休業中です');
    expect(closedReasonText(null)).toBe('今は注文を受け付けていません');
    expect(unavailableReasonText('out_of_season')).toBe('季節外のため');
    expect(unavailableReasonText('out_of_hours')).toBe('販売時間外のため');
    expect(unavailableReasonText('sold_out')).toBe('売り切れのため');
    expect(unavailableReasonText(null)).toBe('今は注文できません');
  });
  it('カテゴリの絞り込みの値', () => {
    expect(parseCategory('drink')).toBe('drink');
    expect(parseCategory(['beans', 'food'])).toBe('beans');
    expect(parseCategory('wine')).toBeNull();
    expect(parseCategory(undefined)).toBeNull();
  });
});

describe('画面の判断', () => {
  it('店: 営業中は選べる。営業外は理由つきで選べない。MO 不可は理由が MO 不可', () => {
    expect(storeStatus(store())).toEqual({ selectable: true, reason: null });
    expect(storeStatus(store({ accepting_orders: false, closed_reason: 'outside_hours' }))).toEqual({ selectable: false, reason: '営業時間外です' });
    expect(storeStatus(store({ accepting_orders: false, closed_reason: null, mobile_order: false })).reason).toContain('モバイルオーダー');
    // accepting_orders が無い古い応答
    expect(storeStatus(store({ accepting_orders: undefined })).selectable).toBe(true);
    expect(storeStatus(store({ accepting_orders: undefined, mobile_order: false })).selectable).toBe(false);
  });
  it('店はエリアごとにまとめる', () => {
    const g = groupStoresByArea([store({ id: 1 }), store({ id: 2, area: '発着場' }), store({ id: 3 })]);
    expect(g.map((x) => [x.area, x.stores.length])).toEqual([['居住区', 2], ['発着場', 1]]);
  });
  it('変種: 店が未選択・営業外・品切れ・季節外・時間外は理由つきで無効', () => {
    const ok = { available: true, unavailable_reason: null } as const;
    expect(variantState(ok, store())).toEqual({ canAdd: true, reason: null, scope: null });
    expect(variantState(ok, null)).toMatchObject({ canAdd: false, scope: 'store' });
    expect(variantState(ok, store({ accepting_orders: false, closed_reason: 'outside_hours' }))).toMatchObject({ scope: 'store', reason: expect.stringContaining('営業時間外') });
    expect(variantState({ available: false, unavailable_reason: 'sold_out' }, store())).toEqual({ canAdd: false, reason: '売り切れのため', scope: 'variant' });
    expect(variantState({ available: false, unavailable_reason: 'out_of_season' }, store()).reason).toBe('季節外のため');
    expect(variantState({ available: false, unavailable_reason: 'out_of_hours' }, store()).reason).toBe('販売時間外のため');
    // available が無い（store_id 無しの取得）は、店が選ばれていれば入れられる
    expect(variantState({}, store()).canAdd).toBe(true);
  });
  it('店のせいで注文できない理由は、メニューの上に 1 回だけ（営業中の店なら出さない）', () => {
    expect(storeNote(null)).toBe('先に、受け取る店を選んでください。');
    expect(storeNote(store())).toBeNull();
    expect(storeNote(store({ name: '発着場中央店', accepting_orders: false, closed_reason: 'outside_hours' }))).toBe('選んだ「発着場中央店」は、今は注文を受け付けていません（営業時間外です）。別の店を選んでください。');
  });
  it('カテゴリで絞る', () => {
    const items = [menuItem({ id: 1 }), menuItem({ id: 2, category: 'food' })];
    expect(filterMenu(items, null)).toHaveLength(2);
    expect(filterMenu(items, 'food').map((i) => i.id)).toEqual([2]);
  });
  it('確認へ進めない理由: 空・店なし・営業外・品切れの行・上限超え', () => {
    expect(checkoutBlockers(cart(), store())).toEqual([]);
    expect(checkoutBlockers(cart({ lines: [], subtotal_lumi: 0, total_lumi: 0 }), store())).toEqual(['カートが空です']);
    expect(checkoutBlockers(cart({ store: null }), null)).toEqual(['受け取る店を選んでください']);
    expect(checkoutBlockers(cart(), store({ accepting_orders: false, closed_reason: 'closed_today' }))[0]).toContain('本日は定休日です');
    expect(checkoutBlockers(cart({ lines: [cartLine({ available: false, unavailable_reason: 'sold_out' })] }), store())[0]).toContain('今は注文できない品');
    expect(checkoutBlockers(cart({ subtotal_lumi: 30_001, total_lumi: 30_001 }), store())[0]).toContain('30,000 ルミ');
    expect(checkoutBlockers(cart({ subtotal_lumi: 30_000, total_lumi: 30_000 }), store())).toEqual([]);
  });
});

describe('zoneFromOffset（API と同じ時差から、時間帯の名前）', () => {
  it('整数の時差を Etc/GMT に直す（符号が逆）。0 は UTC。先頭の + も読む', () => {
    expect(zoneFromOffset('9')).toBe('Etc/GMT-9');
    expect(zoneFromOffset('+9')).toBe('Etc/GMT-9');
    expect(zoneFromOffset('-5')).toBe('Etc/GMT+5');
    expect(zoneFromOffset('0')).toBe('UTC');
    expect(zoneFromOffset(' 14 ')).toBe('Etc/GMT-14');
    expect(zoneFromOffset('-12')).toBe('Etc/GMT+12');
  });

  it('API が受け付けない値（範囲外・小数・文字・空・未設定）は null', () => {
    for (const bad of ['15', '-13', '5.5', 'abc', '', '  ', undefined]) expect(zoneFromOffset(bad)).toBeNull();
  });

  it('その時間帯で、時刻が時差どおりに出る（UTC 04:00 は、+9 なら 13:00、-5 なら 前日 23:00）', () => {
    expect(formatClock('2026-11-22T04:00:00Z', zoneFromOffset('9')!)).toBe('13:00');
    expect(formatDateTime('2026-11-22T04:00:00Z', zoneFromOffset('-5')!)).toBe('11/21 23:00');
  });
});

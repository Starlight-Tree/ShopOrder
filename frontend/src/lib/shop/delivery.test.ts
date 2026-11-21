// 宅配（P2）の純粋な関数: 日付・時間枠・住所・送料の案内・暗証コードの出し分け・配達の段階・エラーの文・入力の検査
import { describe, expect, it } from 'vitest';
import { FAILED_GUIDANCE, PIN_GUIDANCE, failureReasonText, fulfillmentText, pickupNoLabel, slotListReasonText } from './delivery-labels';
import { addressChoice, dayOptions, feeText, freeShippingNote, parseDateParam, servedAreaCodes, slotChoice, slotLabel, slotRange, todayIn, visiblePin } from './delivery-view';
import { describeError } from './errors';
import { formatMonthDay, localDate } from './format';
import { formString, parseAddressInput, parseAreaCode, parseFulfillment } from './input';
import { DELIVERY_FLOW, isTerminalStatus, orderSteps, statusHeadline, statusLabel } from './order-steps';
import { cart, cartDelivery, deliveryCart, slot, store, zone } from './testing';
import { checkoutBlockers } from './view';

const NOW = Date.parse('2026-11-21T10:00:00Z'); // 店の時間帯（Asia/Tokyo）で 11/21（土）19:00

describe('時間枠を選べる日（今日から 7 日先まで）', () => {
  it('今日を含めて 8 日分。今日・明日は、そう書く', () => {
    const days = dayOptions(NOW, 'Asia/Tokyo');
    expect(days).toHaveLength(8);
    expect(days.map((d) => d.date)).toEqual(['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28']);
    expect(days[0]!.label).toBe('今日 11/21（土）');
    expect(days[1]!.label).toBe('明日 11/22（日）');
    expect(days[2]!.label).toBe('11/23（月）');
    expect(days[7]!.label).toBe('11/28（土）');
  });

  it('日付は、店の時間帯で決める（UTC では前日でも、店では翌日）', () => {
    expect(todayIn(Date.parse('2026-11-21T15:30:00Z'), 'Asia/Tokyo')).toBe('2026-11-22');
    expect(todayIn(Date.parse('2026-11-21T15:30:00Z'), 'UTC')).toBe('2026-11-21');
    expect(dayOptions(Date.parse('2026-11-21T15:30:00Z'), 'Asia/Tokyo')[0]!.date).toBe('2026-11-22');
  });

  it('月・年をまたいでも、正しい日付と曜日', () => {
    const month = dayOptions(Date.parse('2026-11-28T01:00:00Z'), 'Asia/Tokyo');
    expect(month.map((d) => d.label).slice(2, 5)).toEqual(['11/30（月）', '12/1（火）', '12/2（水）']);
    const year = dayOptions(Date.parse('2026-12-28T01:00:00Z'), 'Asia/Tokyo');
    expect(year[4]!).toEqual({ date: '2027-01-01', label: '1/1（金）' });
  });

  it('?date= は、選べる日のどれかだけ通す（形式が合っても範囲外・別の形は捨てる）', () => {
    const days = dayOptions(NOW, 'Asia/Tokyo');
    expect(parseDateParam('2026-11-23', days)).toBe('2026-11-23');
    expect(parseDateParam(['2026-11-24', '2026-11-25'], days)).toBe('2026-11-24');
    expect(parseDateParam('2026-11-20', days)).toBeNull(); // 昨日
    expect(parseDateParam('2026-11-29', days)).toBeNull(); // 8 日先
    expect(parseDateParam('2026-11-23<script>', days)).toBeNull();
    expect(parseDateParam('', days)).toBeNull();
    expect(parseDateParam(undefined, days)).toBeNull();
  });

  it('時刻 → 店の時間帯の日付・「11/22（日）」', () => {
    expect(localDate('2026-11-21T15:30:00Z', 'Asia/Tokyo')).toBe('2026-11-22');
    expect(localDate('いつか')).toBeNull();
    expect(formatMonthDay('2026-11-22T04:00:00Z', 'Asia/Tokyo')).toBe('11/22（日）');
    expect(formatMonthDay('いつか')).toBe('');
  });
});

describe('時間枠の表示', () => {
  it('枠の範囲・日付つきの枠', () => {
    const s = slot();
    expect(slotRange(s)).toBe('13:00〜13:30');
    expect(slotLabel(s)).toBe('11/22（日） 13:00〜13:30');
    expect(slotRange({ starts_at: 'x', ends_at: 'y' })).toBe('');
  });

  it('選べる枠は残り。満枠・締め切り済みは、選べず、文字で示す（API の available に従う）', () => {
    expect(slotChoice(slot({ remaining: 3 }))).toEqual({ selectable: true, note: '残り 3' });
    expect(slotChoice(slot({ available: false, remaining: 0, unavailable_reason: 'full' }))).toEqual({ selectable: false, note: '満枠' });
    expect(slotChoice(slot({ available: false, unavailable_reason: 'cutoff' }))).toEqual({ selectable: false, note: '締め切り済み' });
    expect(slotChoice(slot({ available: false, unavailable_reason: null })).selectable).toBe(false);
    // available が真なら、remaining が 0 でも API を信じる（画面で残りから選べるかを決めない）
    expect(slotChoice(slot({ available: true, remaining: 0 })).selectable).toBe(true);
  });

  it('枠が出ない理由は、固定の文。未知の理由・null でも固定の文', () => {
    expect(slotListReasonText('delivery_unavailable')).toContain('宅配をしていません');
    expect(slotListReasonText('temporary_closure')).toContain('臨時休業');
    expect(slotListReasonText('closed_today')).toContain('定休日');
    expect(slotListReasonText('storm_warning')).toContain('砂嵐の警報');
    expect(slotListReasonText('zone_unserved')).toContain('届けられません');
    expect(slotListReasonText('mobile_order_unavailable')).toContain('モバイルオーダー');
    expect(slotListReasonText('<script>')).toBe('今は、宅配の時間枠をお出しできません。');
    expect(slotListReasonText(null)).toBe('今は、宅配の時間枠をお出しできません。');
  });
});

describe('住所・区画・送料の案内', () => {
  it('店が届けるエリアの外の住所は、選べない（届ける区画が読めない・無いときは、API に任せる）', () => {
    const served = servedAreaCodes([zone({ area_code: 1 }), zone({ id: 2, area_code: 2 })]);
    expect(addressChoice({ area_code: 2 }, served)).toEqual({ selectable: true, reason: null });
    expect(addressChoice({ area_code: 4 }, served)).toEqual({ selectable: false, reason: 'この店は、このエリアへは届けられません' });
    expect(servedAreaCodes(null)).toBeNull();
    expect(servedAreaCodes([])).toBeNull();
    expect(addressChoice({ area_code: 4 }, null).selectable).toBe(true);
  });

  it('送料の表示は 0 なら「無料」。無料になる金額の案内は、ちょうどなら無料（2,000 ルミちょうどは無料）', () => {
    expect(feeText(0)).toBe('無料');
    expect(feeText(200)).toBe('200 ルミ');
    const d = cartDelivery();
    expect(freeShippingNote(d, 1500)).toBe('あと 500 ルミで送料が無料になります（品の小計が 2,000 ルミ以上）。');
    expect(freeShippingNote(d, 1999)).toContain('あと 1 ルミで');
    expect(freeShippingNote(d, 2000)).toBe('送料は無料です。');
    expect(freeShippingNote(d, 2500)).toBe('送料は無料です。');
  });

  it('区画が決まっていない・無料の条件が無い・品が無いときは、案内しない', () => {
    expect(freeShippingNote(null, 1000)).toBeNull();
    expect(freeShippingNote(cartDelivery({ zone: null, free_over_lumi: null }), 1000)).toBeNull();
    expect(freeShippingNote({ zone: zone({ free_over_lumi: null }), free_over_lumi: null }, 1000)).toBeNull();
    expect(freeShippingNote(cartDelivery(), 0)).toBeNull();
  });

  it('受け取り方法・番号の言い方', () => {
    expect(fulfillmentText('pickup')).toBe('店頭でお渡し');
    expect(fulfillmentText('delivery')).toBe('宅配（お届け）');
    expect(pickupNoLabel('pickup')).toBe('受け取り番号');
    expect(pickupNoLabel('delivery')).toBe('受付番号');
  });
});

describe('暗証コードを出してよいか', () => {
  it('集荷後（picked_up・delivering）の 4 桁の数字だけ。ほかの状態では、API が返してきても出さない', () => {
    expect(visiblePin('picked_up', '4821')).toBe('4821');
    expect(visiblePin('delivering', '0042')).toBe('0042');
    for (const status of ['placed', 'paid', 'accepted', 'preparing', 'ready', 'assigned', 'delivered', 'delivery_failed', 'completed', 'cancelled']) {
      expect(visiblePin(status, '4821')).toBeNull();
    }
  });

  it('無い・形が違う値は出さない（4 桁の数字以外を画面に載せない）', () => {
    expect(visiblePin('delivering', null)).toBeNull();
    expect(visiblePin('delivering', undefined)).toBeNull();
    expect(visiblePin('delivering', '482')).toBeNull();
    expect(visiblePin('delivering', '48211')).toBeNull();
    expect(visiblePin('delivering', '48a1')).toBeNull();
    expect(visiblePin('delivering', '<b>1</b>')).toBeNull();
  });

  it('案内の文は、配達員にだけ伝える内容', () => {
    expect(PIN_GUIDANCE).toBe('配達員にお伝えください。ほかの人には教えないでください。');
  });
});

describe('配達の段階（宅配の進み）', () => {
  const states = (status: Parameters<typeof orderSteps>[0]) => orderSteps(status, 'delivery')!.map((s) => s.state);

  it('宅配の順序は、準備完了のあとに、配達員の決定・集荷・配達中が続く', () => {
    expect(DELIVERY_FLOW).toEqual(['placed', 'paid', 'accepted', 'preparing', 'ready', 'assigned', 'picked_up', 'delivering', 'completed']);
    expect(orderSteps('placed', 'delivery')!.map((s) => s.label)).toEqual(['お支払い待ち', '支払い済み', 'お店が受付', '調理中', '準備完了', '配達員が決定', '集荷済み', '配達中', 'お届け済み']);
  });

  it('ready は、配達員が決まるのを待つ（店頭の「受け取れます」とは違う）', () => {
    expect(states('ready')).toEqual(['done', 'done', 'done', 'done', 'current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(statusLabel('ready', 'delivery')).toBe('準備完了');
    expect(statusLabel('ready')).toBe('受け取れます');
    expect(statusHeadline('ready', 'delivery')).toContain('配達員の手配をお待ちください');
    expect(statusHeadline('ready', 'delivery')).not.toContain('カウンター');
  });

  it.each([
    ['assigned', 5, '配達員が決定'],
    ['picked_up', 6, '集荷済み'],
    ['delivering', 7, '配達中'],
  ] as const)('%s は、手前が完了・その段階が現在・残りがこれから', (status, index, label) => {
    const steps = orderSteps(status, 'delivery')!;
    expect(steps.map((s) => s.state)).toEqual(DELIVERY_FLOW.map((_, i) => (i < index ? 'done' : i === index ? 'current' : 'upcoming')));
    expect(steps[index]!.label).toBe(label);
  });

  it('completed・delivered は、全部完了（delivered は同じトランザクションで completed になる）', () => {
    expect(states('completed').every((s) => s === 'done')).toBe(true);
    expect(states('delivered').every((s) => s === 'done')).toBe(true);
    expect(statusHeadline('completed', 'delivery')).toContain('お届けしました');
    expect(statusHeadline('completed')).toBe('お受け取りありがとうございました');
  });

  it('delivery_failed は、配達中までを完了にして、「お届けできませんでした」を現在にする（お届け済みは出さない）', () => {
    const steps = orderSteps('delivery_failed', 'delivery')!;
    expect(steps.map((s) => s.status)).toEqual(['placed', 'paid', 'accepted', 'preparing', 'ready', 'assigned', 'picked_up', 'delivering', 'delivery_failed']);
    expect(steps.slice(0, -1).every((s) => s.state === 'done')).toBe(true);
    expect(steps.at(-1)).toMatchObject({ label: 'お届けできませんでした', state: 'current' });
    expect(statusHeadline('delivery_failed', 'delivery')).toContain('お店からの連絡をお待ちください');
  });

  it('cancelled は進みを出さない。店頭の進みは変わらない', () => {
    expect(orderSteps('cancelled', 'delivery')).toBeNull();
    expect(orderSteps('ready')!).toHaveLength(6);
    expect(orderSteps('ready')![4]).toMatchObject({ label: '受け取れます', state: 'current' });
  });

  it('終了は completed・cancelled だけ。配達の途中・配達の失敗（再配達・取消しがありうる）は、再取得を続ける', () => {
    expect(['completed', 'cancelled'].map(isTerminalStatus)).toEqual([true, true]);
    for (const s of ['assigned', 'picked_up', 'delivering', 'delivered', 'delivery_failed']) expect(isTerminalStatus(s)).toBe(false);
  });

  it('配達できなかった理由は、固定の文。未知・null でも固定の文', () => {
    expect(failureReasonText('absent')).toBe('不在のため、お届けできませんでした。');
    expect(failureReasonText('cannot_receive')).toContain('お受け取りいただけなかった');
    expect(failureReasonText('pin_locked')).toContain('暗証コード');
    expect(failureReasonText('other')).toBe('お届けできませんでした。');
    expect(failureReasonText('Traceback')).toBe('お届けできませんでした。');
    expect(failureReasonText(null)).toBe('お届けできませんでした。');
    expect(FAILED_GUIDANCE).toContain('お店が行います');
  });
});

describe('宅配のエラー・カートの issues → 固定の日本語（直し方つき）', () => {
  it.each([
    ['store_required', '先に、受け取る店を選んでください', '/'],
    ['delivery_unavailable', '宅配をしていません', '/cart'],
    ['address_required', 'お届け先の住所を選んでください', '/cart'],
    ['slot_required', 'お届けの時間枠を選んでください', '/cart'],
    ['out_of_zone', '届けられません', '/cart'],
    ['zone_suspended', '砂嵐の警報', '/cart'],
    ['slot_closed', 'お休みしています', '/cart'],
    ['slot_cutoff', '受付を締め切りました', '/cart'],
    ['slot_full', '満枠になりました', '/cart'],
  ])('%s', (code, fragment, href) => {
    const info = describeError({ code });
    expect(info.text).toContain(fragment);
    expect(info.next?.href).toBe(href);
  });

  it('住所・時間枠が見つからない（404）は、その画面の操作の失敗なので、リンクは付けない', () => {
    expect(describeError({ code: 'address_not_found' })).toEqual({ text: 'お届け先の住所が見つかりません。住所を選びなおしてください。', next: null });
    expect(describeError({ code: 'slot_not_found' }).text).toContain('時間枠が見つかりません');
    expect(describeError({ code: 'slot_not_found' }).next).toBeNull();
  });

  it('below_minimum は最低注文額（送料を除く）を添え、メニューへ誘う。額が無くても固定の文', () => {
    const info = describeError({ code: 'below_minimum', min_order_lumi: 700 });
    expect(info.text).toContain('700 ルミ以上');
    expect(info.text).toContain('送料を除く');
    expect(info.next?.href).toBe('/');
    expect(describeError({ code: 'below_minimum' }).text).toBe('宅配の最低注文額に届いていません。品を足してください。');
    expect(describeError({ code: 'below_minimum', min_order_lumi: '<b>1</b>' }).text).not.toContain('<b>');
  });

  it('住所の登録・日付の失敗は、固定の文（直し方のリンクは付けない）', () => {
    expect(describeError({ code: 'invalid_area' })).toEqual({ text: 'エリアの指定が正しくありません。一覧から選びなおしてください。', next: null });
    expect(describeError({ code: 'too_many_addresses' }).text).toContain('10 件まで');
    expect(describeError({ code: 'invalid_date' }).text).toContain('7 日先');
  });

  it('proposal_stale は、送料・お届け先・時間枠が変わった場合も含む。確認のやり直しへ誘う', () => {
    const info = describeError({ code: 'proposal_stale' });
    expect(info.text).toContain('カートの内容が変わりました');
    expect(info.text).toContain('送料');
    expect(info.next?.href).toBe('/checkout');
  });

  it('API の message・未知の code は出さない。API が返さなくなった delivery_unsupported も、汎用の文', () => {
    expect(describeError({ code: 'slot_full', message: 'SECRET /srv/app.py' }).text).not.toContain('SECRET');
    expect(describeError({ code: 'delivery_unsupported' }).text).toBe('うまくいきませんでした。しばらくしてから、もう一度お試しください。');
  });
});

describe('カートの issues → 確認へ進めない理由', () => {
  it('API の順のまま、直し方つきの固定の文にする', () => {
    const c = deliveryCart({ delivery: cartDelivery({ address: null, zone: null, slot: null, issues: ['address_required', 'slot_required'] }) });
    expect(checkoutBlockers(c, store())).toEqual(['お届け先の住所を選んでください。住所がないときは、「お届け先」で登録してください。', 'お届けの時間枠を選んでください。']);
  });

  it('docs/api.md の順（delivery_unavailable → address_required → … → below_minimum → slot_*）を崩さない', () => {
    const issues = ['delivery_unavailable', 'address_required', 'slot_required', 'out_of_zone', 'zone_suspended', 'below_minimum', 'slot_closed', 'slot_cutoff', 'slot_full'];
    const texts = checkoutBlockers(deliveryCart({ delivery: cartDelivery({ issues, min_order_lumi: 700 }) }), store());
    expect(texts).toHaveLength(9);
    expect(texts[5]).toContain('700 ルミ以上');
    expect(texts[8]).toContain('満枠');
  });

  it('issues が空なら、進める。店頭は、delivery が無くても進める', () => {
    expect(checkoutBlockers(deliveryCart(), store())).toEqual([]);
    expect(checkoutBlockers(cart(), store())).toEqual([]);
  });

  it('店が未選択のときは、店を選ぶ案内だけ（issues は、店が無いことの結果なので出さない）', () => {
    const c = deliveryCart({ store: null, delivery: cartDelivery({ issues: ['delivery_unavailable', 'address_required'] }) });
    expect(checkoutBlockers(c, null)).toEqual(['受け取る店を選んでください']);
  });

  it('1 注文の上限は、品の小計で見る（送料を足して超えても、止めない）', () => {
    expect(checkoutBlockers(deliveryCart({ subtotal_lumi: 29_900, delivery_fee_lumi: 400, total_lumi: 30_300 }), store())).toEqual([]);
    expect(checkoutBlockers(deliveryCart({ subtotal_lumi: 30_001, total_lumi: 30_201 }), store())[0]).toContain('30,000 ルミ');
  });

  it('品の行が無ければ「カートが空」だけ', () => {
    expect(checkoutBlockers(deliveryCart({ lines: [], subtotal_lumi: 0, total_lumi: 0 }), store())).toEqual(['カートが空です']);
  });
});

describe('Server Action へ届く宅配の値の検査', () => {
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };
  const valid = { label: '自宅', area_code: '2', line: 'アルカ市発着場2-1-5 305', note: '呼び鈴は 1 回' };

  it('受け取り方法は pickup / delivery だけ。エリア番号は 1〜99', () => {
    expect(parseFulfillment('pickup')).toBe('pickup');
    expect(parseFulfillment('delivery')).toBe('delivery');
    expect(parseFulfillment('drone')).toBeNull();
    expect(parseFulfillment(null)).toBeNull();
    expect(parseAreaCode('1')).toBe(1);
    expect(parseAreaCode('99')).toBe(99);
    for (const bad of ['0', '100', '-1', '1.5', '01', '', 'a', null]) expect(parseAreaCode(bad)).toBeNull();
  });

  it('住所の入力: 前後の空白を除いて通す。メモが空なら null', () => {
    expect(parseAddressInput(form(valid))).toEqual({ label: '自宅', areaCode: 2, line: 'アルカ市発着場2-1-5 305', note: '呼び鈴は 1 回' });
    expect(parseAddressInput(form({ ...valid, label: '  自宅  ', line: ' 住所 ', note: '   ' }))).toEqual({ label: '自宅', areaCode: 2, line: '住所', note: null });
    const noNote = form(valid);
    noNote.delete('note');
    expect(parseAddressInput(noNote)?.note).toBeNull();
  });

  it('範囲は API と同じ（ラベル 1〜20・住所 1〜100・メモ 100 まで）。文字数はコードポイントで数える', () => {
    expect(parseAddressInput(form({ ...valid, label: 'あ'.repeat(20) }))).not.toBeNull();
    expect(parseAddressInput(form({ ...valid, label: 'あ'.repeat(21) }))).toBeNull();
    expect(parseAddressInput(form({ ...valid, label: '' }))).toBeNull();
    expect(parseAddressInput(form({ ...valid, label: '   ' }))).toBeNull();
    expect(parseAddressInput(form({ ...valid, line: 'あ'.repeat(100) }))).not.toBeNull();
    expect(parseAddressInput(form({ ...valid, line: 'あ'.repeat(101) }))).toBeNull();
    expect(parseAddressInput(form({ ...valid, note: 'あ'.repeat(100) }))).not.toBeNull();
    expect(parseAddressInput(form({ ...valid, note: 'あ'.repeat(101) }))).toBeNull();
    // 絵文字は UTF-16 では 2 文字だが、1 文字として数える（20 個まで通る）
    expect(parseAddressInput(form({ ...valid, label: '🏠'.repeat(20) }))).not.toBeNull();
    expect(parseAddressInput(form({ ...valid, label: '🏠'.repeat(21) }))).toBeNull();
  });

  it('エリアが無い・不正、制御文字・FormData のファイルは通さない', () => {
    expect(parseAddressInput(form({ label: '自宅', line: '住所' }))).toBeNull();
    expect(parseAddressInput(form({ ...valid, area_code: 'x' }))).toBeNull();
    expect(parseAddressInput(form({ ...valid, line: '住所\u0000' }))).toBeNull();
    expect(parseAddressInput(form({ ...valid, label: '自宅\n' }))).not.toBeNull(); // 前後の改行は空白として除かれる
    expect(parseAddressInput(form({ ...valid, label: '自\n宅' }))).toBeNull();
    const withFile = form(valid);
    withFile.set('line', new File(['x'], 'x.txt'));
    expect(formString(withFile, 'line')).toBeNull();
    expect(parseAddressInput(withFile)).toBeNull();
  });
});

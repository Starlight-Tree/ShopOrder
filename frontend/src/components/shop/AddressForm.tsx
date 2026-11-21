'use client';

import { useActionState, useEffect, useState } from 'react';
import { ADDRESS_LABEL_MAX, ADDRESS_LINE_MAX, ADDRESS_NOTE_MAX } from '../../lib/shop/constants';
import type { FormAction } from '../../lib/shop/types';
import type { Zone } from '../../lib/types';
import { ActionMessage } from './ActionForm';
import { SubmitButton } from './SubmitButton';

/**
 * 住所の登録フォーム（ラベル 1〜20 字・エリア・住所 1〜100 字・メモ 100 字まで）。エリアは区画の一覧（GET /api/delivery/zones）から選ぶ。
 * 入力は、失敗しても消えない（成功したら空にする）。入力の中身は、エラー文・ログ・URL に出さない（失敗の文は固定）。
 * 検査は、ここ（入力の目安）と Server Action と API の 3 か所で行う。信用するのは API だけ
 */
export function AddressForm({ zones, action }: { zones: Zone[]; action: FormAction }) {
  const [state, formAction] = useActionState(action, null);
  const [label, setLabel] = useState('');
  const [areaCode, setAreaCode] = useState('');
  const [line, setLine] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (state?.ok) {
      setLabel('');
      setAreaCode('');
      setLine('');
      setNote('');
    }
  }, [state]);

  return (
    <form action={formAction} className="shop-form">
      <div className="shop-field">
        <label htmlFor="address-label">ラベル（{ADDRESS_LABEL_MAX} 文字まで）</label>
        <input id="address-label" name="label" type="text" className="shop-input" required maxLength={ADDRESS_LABEL_MAX} autoComplete="off" placeholder="例: 自宅" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="shop-field">
        <label htmlFor="address-area">エリア</label>
        <select id="address-area" name="area_code" className="shop-input" required value={areaCode} onChange={(e) => setAreaCode(e.target.value)}>
          <option value="">選んでください</option>
          {zones.map((z) => (
            <option key={z.id} value={z.area_code}>
              {z.name}
            </option>
          ))}
        </select>
      </div>
      <div className="shop-field">
        <label htmlFor="address-line">住所（{ADDRESS_LINE_MAX} 文字まで）</label>
        <input id="address-line" name="line" type="text" className="shop-input" required maxLength={ADDRESS_LINE_MAX} autoComplete="off" value={line} onChange={(e) => setLine(e.target.value)} />
      </div>
      <div className="shop-field">
        <label htmlFor="address-note">メモ（任意。{ADDRESS_NOTE_MAX} 文字まで）</label>
        <input id="address-note" name="note" type="text" className="shop-input" maxLength={ADDRESS_NOTE_MAX} autoComplete="off" placeholder="例: 呼び鈴は 1 回" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="shop-actions">
        <SubmitButton pendingLabel="登録しています…">住所を登録する</SubmitButton>
      </div>
      <ActionMessage state={state} />
    </form>
  );
}

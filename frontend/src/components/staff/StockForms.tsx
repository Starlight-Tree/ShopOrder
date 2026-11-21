'use client';
import { useActionState, useEffect, useId, useState } from 'react';
import type { StockRow } from '../../lib/contract';
import type { StockFormState, StockOp } from '../../lib/staff/types';

type Action = (prev: StockFormState, formData: FormData) => Promise<StockFormState>;
type Item = Pick<StockRow, 'item_id' | 'name' | 'unit' | 'on_hand'>;

type Props = { items: readonly Item[]; receive: Action; waste: Action; adjust: Action };

const IDLE: StockFormState = { status: 'idle', message: '', seq: 0 };

const COPY: Record<
  StockOp,
  { title: string; lead: string; amountName: 'qty' | 'delta'; amountLabel: string; amountHint: string; reasonLabel: string; reasonRequired: boolean; submit: string }
> = {
  receive: {
    title: '入荷',
    lead: '工房などから届いた分を、実在庫に足します。',
    amountName: 'qty',
    amountLabel: '入荷した数',
    amountHint: '1 以上の整数',
    reasonLabel: 'メモ（任意）',
    reasonRequired: false,
    submit: '入荷を記録する',
  },
  waste: {
    title: '廃棄',
    lead: '期限切れ・作り損じなどで捨てた分を、実在庫から引きます。',
    amountName: 'qty',
    amountLabel: '廃棄した数',
    amountHint: '1 以上の整数',
    reasonLabel: '廃棄の理由（必須）',
    reasonRequired: true,
    submit: '廃棄を記録する',
  },
  adjust: {
    title: '棚卸し',
    lead: '数えた結果が帳簿と違うとき、差分を足し引きします。履歴は残ります。',
    amountName: 'delta',
    amountLabel: '差分（数えた数 − 帳簿の数）',
    amountHint: '0 ではない整数。減っていれば負の数（例: -3）',
    reasonLabel: '棚卸しの理由（必須）',
    reasonRequired: true,
    submit: '棚卸しの差分を記録する',
  },
};

function StockOpForm({ op, items, action }: { op: StockOp; items: readonly Item[]; action: Action }) {
  const copy = COPY[op];
  const [state, formAction, pending] = useActionState(action, IDLE);
  const uid = useId();
  const [itemId, setItemId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  // 成功したら、数と理由を空にする（品目は残す）。失敗したら、入力を残す
  useEffect(() => {
    if (state.status === 'ok') {
      setAmount('');
      setReason('');
    }
  }, [state.seq, state.status]);

  const ids = { item: `${uid}-item`, amount: `${uid}-amount`, hint: `${uid}-hint`, reason: `${uid}-reason`, title: `${uid}-title` };
  return (
    <section className="st-op" aria-labelledby={ids.title}>
      <h3 id={ids.title}>{copy.title}</h3>
      <p className="muted">{copy.lead}</p>
      <form action={formAction} className="st-form">
        <div className="st-field">
          <label htmlFor={ids.item}>品目</label>
          <select id={ids.item} name="item_id" required value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="" disabled>
              品目を選んでください
            </option>
            {items.map((it) => (
              <option key={it.item_id} value={String(it.item_id)}>
                {it.name}（実在庫 {it.on_hand} {it.unit}）
              </option>
            ))}
          </select>
        </div>
        <div className="st-field">
          <label htmlFor={ids.amount}>{copy.amountLabel}</label>
          <input
            id={ids.amount}
            name={copy.amountName}
            type="text"
            inputMode={op === 'adjust' ? 'text' : 'numeric'}
            autoComplete="off"
            required
            aria-describedby={ids.hint}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <p id={ids.hint} className="muted">
            {copy.amountHint}
          </p>
        </div>
        <div className="st-field">
          <label htmlFor={ids.reason}>{copy.reasonLabel}</label>
          <input
            id={ids.reason}
            name="reason"
            type="text"
            autoComplete="off"
            maxLength={100}
            required={copy.reasonRequired}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <button type="submit" className="st-btn st-btn-primary" disabled={pending}>
          {pending ? '記録しています…' : copy.submit}
        </button>
        <div role="status" aria-live="polite" aria-atomic="true">
          {state.status !== 'idle' ? (
            <p className={state.status === 'ok' ? 'st-message st-message-ok' : 'st-message st-message-error'}>
              <span className="st-message-label">{state.status === 'ok' ? '完了' : '記録できませんでした'}</span>
              {state.message}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

/** 入荷・廃棄・棚卸しのフォーム（Server Action）。品目は、表と同じ一覧から選ぶ */
export function StockForms({ items, receive, waste, adjust }: Props) {
  return (
    <div className="st-ops">
      <StockOpForm op="receive" items={items} action={receive} />
      <StockOpForm op="waste" items={items} action={waste} />
      <StockOpForm op="adjust" items={items} action={adjust} />
    </div>
  );
}

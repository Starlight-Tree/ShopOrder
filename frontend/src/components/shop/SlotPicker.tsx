import Link from 'next/link';
import { slotListReasonText } from '../../lib/shop/delivery-labels';
import { slotChoice, slotRange, type DayOption } from '../../lib/shop/delivery-view';
import type { FormAction } from '../../lib/shop/types';
import type { SlotList } from '../../lib/types';
import { ActionForm } from './ActionForm';
import { SubmitButton } from './SubmitButton';

/**
 * 宅配のお届けの時間枠の選択（カートの枠。PUT /api/cart）。日付（今日〜7 日先）を選ぶと、その日の枠が並ぶ。
 * 残り・満枠・締め切り済みは文字で示す（色だけにしない）。枠が出ない理由（休業・砂嵐など）は固定の文。
 */
export function SlotPicker({
  days,
  date,
  slots,
  failed,
  hasAddress,
  selectedSlotId,
  action,
}: {
  days: DayOption[];
  date: string;
  slots: SlotList | null;
  failed: boolean;
  hasAddress: boolean;
  selectedSlotId: number | null;
  action: FormAction;
}) {
  return (
    <section aria-labelledby="cart-slot">
      <h3 id="cart-slot">お届けの時間枠を選ぶ</h3>
      {hasAddress ? (
        <>
          <nav aria-label="お届けの日付" className="shop-days">
            <ul>
              {days.map((d) => (
                <li key={d.date}>
                  <Link href={`/cart?date=${d.date}`} prefetch={false} scroll={false} aria-current={d.date === date ? 'date' : undefined} className="shop-tab">
                    {d.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {failed || slots === null ? (
            <p className="shop-warn" role="alert">
              時間枠を読み込めませんでした。しばらくしてから、もう一度お試しください。
            </p>
          ) : slots.reason ? (
            <p className="shop-warn" role="status">
              {slotListReasonText(slots.reason)}
            </p>
          ) : slots.slots.length === 0 ? (
            <p className="muted">この日は、選べる時間枠がありません。</p>
          ) : (
            <ActionForm action={action} className="shop-slot-form">
              <ul className="shop-slots">
                {slots.slots.map((s) => {
                  const choice = slotChoice(s);
                  return (
                    <li key={s.id}>
                      {s.id === selectedSlotId ? (
                        <span className="shop-slot shop-slot-on">
                          <span className="shop-slot-time">{slotRange(s)}</span>
                          <span className="shop-slot-note">選択中</span>
                        </span>
                      ) : (
                        <SubmitButton kind="secondary" name="slot_id" value={s.id} disabled={!choice.selectable} ariaLabel={`${slotRange(s)}（${choice.note}）`}>
                          <span className="shop-slot">
                            <span className="shop-slot-time">{slotRange(s)}</span>
                            <span className="shop-slot-note">{choice.note}</span>
                          </span>
                        </SubmitButton>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ActionForm>
          )}
        </>
      ) : (
        <p className="muted">先に、お届け先の住所を選んでください。選ぶと、その地域の状況を反映した時間枠が出ます。</p>
      )}
    </section>
  );
}

import { redirect } from 'next/navigation';
import { CourierBoard } from '../../../src/components/courier/CourierBoard';
import { courierLoadErrorMessage } from '../../../src/lib/staff/courier-messages';
import { loadCourierDeliveries } from '../../../src/lib/staff/courier-loaders';
import type { CourierDelivery } from '../../../src/lib/staff/delivery-types';
import { parseOffsetHours } from '../../../src/lib/staff/dispatch';
import { MSG } from '../../../src/lib/staff/messages';
import { requireStaff } from '../../../src/lib/staff/session';
import { courierAction } from './actions';

export const metadata = { title: '配達' };

export default async function CourierPage() {
  // layout は画面の移動（クライアント側）では再実行されないので、page でも確かめる
  const auth = await requireStaff();
  if (auth && auth.staff.role !== 'courier') redirect('/staff');

  // 一覧が取れなかったとき（API に聞けない・5xx・権限なし）も、画面は出す。null を渡すと、画面は、最後に取れた一覧を出し続ける
  let deliveries: CourierDelivery[] | null = null;
  let errorMessage: string = MSG.unreachable; // auth が null = API に聞けなかった
  if (auth) {
    const loaded = await loadCourierDeliveries(auth.token);
    if (loaded.state === 'unauthorized') redirect('/staff/expired');
    if (loaded.state === 'ok') deliveries = loaded.data;
    else errorMessage = courierLoadErrorMessage(loaded);
  }

  return (
    <>
      <h1>配達</h1>
      <CourierBoard
        deliveries={deliveries}
        errorMessage={errorMessage}
        now={new Date().toISOString()}
        offsetHours={parseOffsetHours(process.env.LOCAL_UTC_OFFSET_HOURS)}
        onAct={courierAction}
      />
    </>
  );
}

import { redirect } from 'next/navigation';
import { DispatchBoard } from '../../../../src/components/staff/dispatch/DispatchBoard';
import { ApiUnavailable } from '../../../../src/components/staff/Notices';
import { loadDispatchBoard, loadZones } from '../../../../src/lib/staff/dispatch-loaders';
import { parseOffsetHours } from '../../../../src/lib/staff/dispatch';
import { MSG } from '../../../../src/lib/staff/messages';
import { parseStoreParam } from '../../../../src/lib/staff/orders';
import { getStores, requireStaff } from '../../../../src/lib/staff/session';
import { assignAction, cancelDeliveryAction, mockAdvanceAction, redeliverAction, suspensionAction } from './actions';

export const metadata = { title: '配車' };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function DispatchPage({ searchParams }: Props) {
  const auth = await requireStaff();
  if (!auth) return <ApiUnavailable href="/staff/dispatch" />;
  const { token, staff } = auth;

  // 配達員の画面は別（配車ボードは店の側の画面）
  if (staff.role === 'courier') redirect('/staff/courier');

  // 店の選択は、全店の店長だけ（店に属するスタッフ・店長は、API が自店に絞る）
  const allStores = staff.role === 'manager' && staff.store_id === null;
  const selectedStoreId = allStores ? parseStoreParam((await searchParams).store) : null;
  const zoneStoreId = staff.store_id ?? selectedStoreId;
  const [stores, board, zones] = await Promise.all([
    allStores ? getStores() : Promise.resolve(null),
    loadDispatchBoard(token, { storeId: selectedStoreId }),
    loadZones({ storeId: zoneStoreId }),
  ]);
  if (board.state === 'unauthorized') redirect('/staff/expired');

  return (
    <>
      <h1>配車ボード</h1>
      <DispatchBoard
        board={board.state === 'ok' ? board.data : null}
        errorMessage={board.state === 'forbidden' ? MSG.forbidden : board.state === 'error' && board.unreachable ? MSG.unreachable : MSG.generic}
        zones={zones}
        now={new Date().toISOString()}
        utcOffsetHours={parseOffsetHours(process.env.LOCAL_UTC_OFFSET_HOURS)}
        stores={stores}
        showStoreSelect={allStores && stores !== null}
        selectedStoreId={selectedStoreId}
        canSuspend={staff.role === 'manager'}
        onAssign={assignAction}
        onRedeliver={redeliverAction}
        onMockAdvance={mockAdvanceAction}
        onCancel={cancelDeliveryAction}
        onSuspension={suspensionAction}
      />
    </>
  );
}

import type { ReactNode } from 'react';
import { ApiUnavailable } from '../../../src/components/staff/Notices';
import { StaffHeader } from '../../../src/components/staff/StaffHeader';
import { storeLabel } from '../../../src/lib/staff/orders';
import { getSession, getStores } from '../../../src/lib/staff/session';
import { redirect } from 'next/navigation';
import { logoutAction } from './actions';

// 認証の門。Cookie をサーバーで読み、GET /api/staff/me で確かめる。トークンはクライアントへ渡さない。
// ・Cookie が無い → ログインへ
// ・API が 401 → Cookie を消す経路（/staff/expired）経由でログインへ
// ・API に聞けない（接続・5xx）→ Cookie は消さず、「接続できません」を出す
// layout は画面の移動（クライアント側）では再実行されないので、各 page でも requireStaff() で確かめる。
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (session.kind === 'anonymous') redirect('/staff/login');
  if (session.kind === 'expired') redirect('/staff/expired');
  if (session.kind === 'unavailable') {
    return (
      <main id="st-main" className="st-main">
        <ApiUnavailable href="/staff" />
      </main>
    );
  }
  const stores = await getStores();
  return (
    <>
      <StaffHeader staff={session.staff} storeName={storeLabel(session.staff, stores)} logoutAction={logoutAction} />
      <main id="st-main" className="st-main">
        {children}
      </main>
    </>
  );
}

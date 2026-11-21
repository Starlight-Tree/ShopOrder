import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ManagerHeader } from '../../../src/components/manager/ManagerHeader';
import { ApiUnavailable, DummyBanner } from '../../../src/components/manager/Notice';
import { isAllStoreManager } from '../../../src/lib/manager/access';
import { MGMSG } from '../../../src/lib/manager/messages';
import { getSession } from '../../../src/lib/manager/session';
import { storeLabel } from '../../../src/lib/staff/orders';
import { getStores } from '../../../src/lib/staff/session';
import { managerLogoutAction } from './actions';

// 認証の門。Cookie をサーバーで読み、GET /api/staff/me で確かめる。トークンはクライアントへ渡さない。
// ・Cookie が無い → ログインへ / API が 401 → Cookie を消す経路（/manager/expired）経由でログインへ / 聞けない（接続・5xx）→ 「接続できません」
// layout は画面の移動（クライアント側）では再実行されないので、各 page でも確かめる。
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (session.kind === 'anonymous') redirect('/manager/login');
  if (session.kind === 'expired') redirect('/manager/expired');
  if (session.kind === 'unavailable') {
    return (
      <main id="mg-main" className="mg-main">
        <ApiUnavailable href="/manager" />
      </main>
    );
  }
  const stores = await getStores();
  return (
    <>
      <ManagerHeader
        staff={session.staff}
        storeName={storeLabel(session.staff, stores)}
        showCustomers={isAllStoreManager(session.staff)}
        logoutAction={managerLogoutAction}
      />
      <main id="mg-main" className="mg-main">
        <DummyBanner text={MGMSG.dummy} />
        {children}
      </main>
    </>
  );
}

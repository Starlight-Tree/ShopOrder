import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { CourierHeader } from '../../../src/components/courier/CourierHeader';
import { getSession } from '../../../src/lib/staff/session';
import '../../../src/styles/courier.css';
import { logoutAction } from '../(console)/actions';

// 配達員の画面（/staff/courier）。(console) の外に置き、専用のヘッダーを持つ。
// 場所が /staff の下なのは、スタッフの Cookie の Path が /staff だから（/courier には届かない。Path は広げない）。
// 認証の門（トークンはクライアントへ渡さない）:
// ・Cookie が無い → ログインへ
// ・API が 401 → Cookie を消す経路（/staff/expired）経由でログインへ
// ・API に聞けない（接続・5xx）→ Cookie は消さない。ヘッダーだけ省き、本文（page）は出す: page が「接続できません」を出し、
//   取れていた一覧と入力中の欄を残したまま、自動で再試行する（ここで本文ごと差し替えると、戸口で入力と住所が消える）
// ・配達員でない（スタッフ・店長）→ 調理ボード（/staff）へ。表示を絞るだけで、権限は API が毎回決める
export default async function CourierLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (session.kind === 'anonymous') redirect('/staff/login');
  if (session.kind === 'expired') redirect('/staff/expired');
  if (session.kind === 'ok' && session.staff.role !== 'courier') redirect('/staff');
  // 枠の並び（ヘッダー・本文）は、ヘッダーの有無で変えない（本文が作り直されて、状態が消えないように）
  return (
    <div className="courier-root">
      {session.kind === 'ok' ? <CourierHeader staff={session.staff} logoutAction={logoutAction} /> : null}
      <main id="cr-main" className="cr-main">
        {children}
      </main>
    </div>
  );
}

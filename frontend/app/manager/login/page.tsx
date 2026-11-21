import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ManagerLoginForm } from '../../../src/components/manager/LoginForm';
import { getSession } from '../../../src/lib/manager/session';
import { managerLoginAction } from './actions';

export const metadata = { title: 'ログイン' };

export default async function ManagerLoginPage() {
  // すでにログインしていれば、概況へ（API に拒まれる Cookie なら、フォームを出す。Cookie は次のログインで置き換わる）
  const session = await getSession();
  if (session.kind === 'ok') redirect('/manager');

  return (
    <main id="mg-main" className="mg-login">
      <div className="mg-login-card">
        <p className="mg-brand">
          <span className="mg-brand-name">オアシス珈琲</span>
          <span className="mg-brand-sub">分析</span>
        </p>
        <h1>分析 ログイン</h1>
        <p className="mg-muted">店長・店のスタッフ用の画面です。スタッフの画面と同じアカウントです。</p>
        <ManagerLoginForm action={managerLoginAction} />
        <p className="mg-muted mg-login-foot">
          調理ボードは<Link href="/staff">スタッフの画面</Link>、お客さまのご注文は<Link href="/">トップページ</Link>からどうぞ。
        </p>
      </div>
    </main>
  );
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LoginForm } from '../../../src/components/staff/LoginForm';
import { getSession } from '../../../src/lib/staff/session';
import { loginAction } from './actions';

export const metadata = { title: 'ログイン' };

export default async function StaffLoginPage() {
  // すでにログインしていれば、ボードへ（API に拒まれる Cookie なら、フォームを出す。Cookie は次のログインで置き換わる）
  const session = await getSession();
  if (session.kind === 'ok') redirect('/staff');

  return (
    <main id="st-main" className="st-login">
      <div className="st-login-card">
        <p className="st-brand">
          <span className="st-brand-name">オアシス珈琲</span>
          <span className="st-brand-sub">スタッフ</span>
        </p>
        <h1>スタッフ ログイン</h1>
        <p className="muted">店のスタッフ・店長用の画面です。</p>
        <LoginForm action={loginAction} />
        <p className="muted st-login-foot">
          お客さまのご注文は、<Link href="/">トップページ</Link>からどうぞ。
        </p>
      </div>
    </main>
  );
}

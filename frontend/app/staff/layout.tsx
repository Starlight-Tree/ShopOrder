import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../../src/styles/staff.css';

// スタッフ用の画面（ログインと業務画面）の共通。検索に出さない。見た目は globals.css のトークンを使い、staff.css は .staff-root の中だけに効かせる
export const metadata: Metadata = {
  title: { default: 'スタッフ', template: '%s｜スタッフ｜オアシス珈琲' },
  robots: { index: false, follow: false },
};

export default function StaffLayout({ children }: { children: ReactNode }) {
  return <div className="staff-root">{children}</div>;
}

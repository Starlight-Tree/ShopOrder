import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../../src/styles/manager.css';

// 店長・店舗スタッフの分析画面（ログインと本体）の共通。検索に出さない。見た目は globals.css のトークンを使い、manager.css は .manager-root の中だけに効かせる
export const metadata: Metadata = {
  title: { default: '分析', template: '%s｜分析｜オアシス珈琲' },
  robots: { index: false, follow: false },
};

export default function ManagerLayout({ children }: { children: ReactNode }) {
  return <div className="manager-root">{children}</div>;
}

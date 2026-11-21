import type { ReactNode } from 'react';

/** 読み込めなかったときなどの、画面の中の知らせ。色だけに頼らず、見出しの文字も付ける */
export function Notice({ kind = 'error', title, children }: { kind?: 'error' | 'info'; title: string; children?: ReactNode }) {
  return (
    <div className={`mg-notice mg-notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <p className="mg-notice-title">{title}</p>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function ApiUnavailable({ href }: { href: string }) {
  return (
    <Notice title="API に接続できません">
      <p>しばらくしてから、もう一度開いてください。</p>
      <p>
        <a className="mg-btn" href={href}>
          もう一度読み込む
        </a>
      </p>
    </Notice>
  );
}

/** 画面の頭に出す、ダミーの明記 */
export function DummyBanner({ text }: { text: string }) {
  return (
    <p className="mg-dummy" role="note">
      <span className="mg-dummy-tag">ダミー</span>
      {text}
    </p>
  );
}

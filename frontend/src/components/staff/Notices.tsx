import type { ReactNode } from 'react';

/** 読み込めなかったときなどの、画面の中の知らせ。色だけに頼らず、見出しの文字も付ける */
export function Notice({ kind = 'error', title, children }: { kind?: 'error' | 'info'; title: string; children?: ReactNode }) {
  return (
    <div className={`st-notice st-notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <p className="st-notice-title">{title}</p>
      {children ? <div className="st-notice-body">{children}</div> : null}
    </div>
  );
}

/** API に聞けなかった（接続・5xx）。再読み込みのリンク（フルのページ遷移）を付ける */
export function ApiUnavailable({ href }: { href: string }) {
  return (
    <Notice title="API に接続できません">
      <p>しばらくしてから、もう一度開いてください。</p>
      <p>
        <a className="st-btn st-btn-secondary" href={href}>
          もう一度読み込む
        </a>
      </p>
    </Notice>
  );
}

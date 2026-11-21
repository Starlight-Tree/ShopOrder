import { redirect } from 'next/navigation';
import { MGMSG } from '../../lib/manager/messages';
import type { Loaded } from '../../lib/manager/loaders';
import type { ManagerContext } from '../../lib/manager/context';
import { ApiUnavailable, Notice } from './Notice';

/** 分析画面に入れないとき（API に聞けない・配達員）の表示 */
export function blockedView(ctx: Exclude<ManagerContext, { kind: 'ok' }>, href: string) {
  if (ctx.kind === 'unavailable') return <ApiUnavailable href={href} />;
  return (
    <>
      <h1>分析</h1>
      <Notice kind="info" title={MGMSG.courier} />
    </>
  );
}

/**
 * 取得に失敗したときの表示。認証切れ（401）は、Cookie を消す経路へ（redirect）。
 * 成功なら null（呼ぶ側が中身を出す）。
 */
export function failureView<T>(loaded: Loaded<T>, title: string) {
  if (loaded.state === 'ok') return null;
  if (loaded.state === 'unauthorized') return redirect('/manager/expired');
  const message = loaded.state === 'forbidden' ? MGMSG.forbidden : loaded.unreachable ? MGMSG.unreachable : MGMSG.generic;
  return (
    <Notice title={title}>
      <p>{message}</p>
    </Notice>
  );
}

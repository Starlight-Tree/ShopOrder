import Link from 'next/link';
import { describeError } from '../../lib/shop/errors';

/** API の読み込みに失敗したときの表示（固定の文と、直し方のリンク。例外の文字列は出さない） */
export function LoadError({ error, status }: { error: { code: string; [extra: string]: unknown }; status?: number }) {
  const info = describeError(error, status);
  return (
    <div className="notice" role="alert">
      <p>{info.text}</p>
      {info.next ? (
        <p>
          <Link href={info.next.href} prefetch={false} className="shop-btn shop-btn-secondary">
            {info.next.label}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

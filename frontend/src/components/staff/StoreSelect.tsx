'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useId, type FormEvent } from 'react';
import type { Store } from '../../lib/types';

type Props = {
  stores: readonly Pick<Store, 'id' | 'name'>[];
  selectedId: number | null;
  /** true: 「全店」を選べる（ボード）。false: 店を 1 つ選ぶ必要がある（在庫） */
  allowAll: boolean;
};

/** 店長の、店の選択。選んだだけでは変えず、「切り替える」で ?store= を更新する（入力で画面が勝手に変わらないように） */
export function StoreSelect({ stores, selectedId, allowAll }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const id = useId();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get('store') ?? '');
    router.replace(value ? `${pathname}?store=${encodeURIComponent(value)}` : pathname);
  }

  return (
    <form method="get" onSubmit={onSubmit} className="st-storeselect" key={selectedId ?? 'all'}>
      <label htmlFor={id}>表示する店</label>
      <select id={id} name="store" defaultValue={selectedId === null ? '' : String(selectedId)}>
        {allowAll ? (
          <option value="">全店</option>
        ) : (
          <option value="" disabled>
            店を選んでください
          </option>
        )}
        {stores.map((s) => (
          <option key={s.id} value={String(s.id)}>
            {s.name}
          </option>
        ))}
      </select>
      <button type="submit" className="st-btn st-btn-secondary">
        切り替える
      </button>
    </form>
  );
}

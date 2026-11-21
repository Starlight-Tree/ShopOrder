'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, type FormEvent } from 'react';
import type { Store } from '../../lib/types';

type Props = { stores: readonly Pick<Store, 'id' | 'name'>[]; selectedId: number | null };

/** 全店の店長の、店の絞り込み。選んだだけでは変えず、「切り替える」で ?store= を更新する（期間などの他の条件は残す） */
export function ScopeSelect({ stores, selectedId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const id = useId();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get('store') ?? '');
    const next = new URLSearchParams(search.toString());
    if (value) next.set('store', value);
    else next.delete('store');
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  }

  return (
    <form method="get" onSubmit={onSubmit} className="mg-scope" key={selectedId ?? 'all'}>
      <label htmlFor={id}>表示する店</label>
      <select id={id} name="store" defaultValue={selectedId === null ? '' : String(selectedId)}>
        <option value="">全店</option>
        {stores.map((s) => (
          <option key={s.id} value={String(s.id)}>
            {s.name}
          </option>
        ))}
      </select>
      <button type="submit" className="mg-btn">
        切り替える
      </button>
    </form>
  );
}

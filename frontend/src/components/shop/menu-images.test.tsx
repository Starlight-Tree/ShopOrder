import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { menuItem, store } from '../../lib/shop/testing';
import type { FormAction } from '../../lib/shop/types';
import { MenuGrid } from './MenuGrid';

const images = vi.hoisted(() => ({ codes: new Set<string>() }));
vi.mock('../../lib/shop/menu-images', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/shop/menu-images')>();
  return { ...original, menuImageSrc: (code: string) => original.menuImageSrc(code, images.codes) };
});

const noop: FormAction = async () => null;

describe('メニューの写真', () => {
  it('写真がある品だけ、飾りの画像（alt なし）を出す。無い品は出さない', () => {
    images.codes = new Set(['oasis-blend']);
    const items = [menuItem(), menuItem({ id: 2, code: 'cafe-latte', name: 'カフェラテ' })];
    const { container } = render(<MenuGrid items={items} store={store()} category={null} addAction={noop} />);
    const imgs = container.querySelectorAll('.shop-item-thumb img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute('src', '/images/menu/oasis-blend.jpg');
    expect(imgs[0]).toHaveAttribute('alt', '');
  });

  it('写真が 1 枚も無いときは、画像の枠を出さない', () => {
    images.codes = new Set();
    const { container } = render(<MenuGrid items={[menuItem()]} store={store()} category={null} addAction={noop} />);
    expect(container.querySelector('.shop-item-thumb')).toBeNull();
  });
});

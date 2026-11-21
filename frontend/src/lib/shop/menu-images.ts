/**
 * メニューの写真。Git に置く生成済みの画像（frontend/public/images/menu/<code>.jpg）。
 * 写真がある品の code だけを、ここに足す（生成の手順: scripts/generate-images/README.md）。無い品は、写真なしで出す。
 */
export const MENU_IMAGE_CODES: ReadonlySet<string> = new Set<string>([
  'oasis-blend',
  'seasonal-blend',
  'kikan-limited',
  'cafe-latte',
  'americano',
  'cappuccino',
  'matcha-latte',
  'black-tea',
  'hot-sandwich',
  'meat-pie',
  'cheesecake',
  'gateau-chocolat',
  'morning-set',
  'beans-oasis',
  'beans-seasonal',
]);

export function menuImageSrc(code: string, available: ReadonlySet<string> = MENU_IMAGE_CODES): string | null {
  return available.has(code) ? `/images/menu/${code}.jpg` : null;
}

// shop.css（と globals.css）の色が、ライト・ダークの両方で WCAG AA を満たすかを、CSS の値から検査する。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const globals = read('../../../app/globals.css');
const shop = read('../../styles/shop.css');

function tokens(block: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (block ?? '').matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}
const firstBlock = (css: string, selector: string) => css.match(new RegExp(`^${selector}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
const darkBlock = (css: string, selector: string) => css.match(new RegExp(`@media \\(prefers-color-scheme: dark\\)\\s*\\{\\s*${selector}\\s*\\{([^}]*)\\}`))?.[1];

const light = { ...tokens(firstBlock(globals, ':root')), ...tokens(firstBlock(shop, '\\.shop-root')) };
const dark = { ...light, ...tokens(darkBlock(globals, ':root')), ...tokens(darkBlock(shop, '\\.shop-root')) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// [前景, 背景]。文字は 4.5:1
const TEXT: [string, string][] = [
  ['--text', '--bg'], ['--text', '--surface'],
  ['--muted', '--bg'], ['--muted', '--surface'],
  ['--primary', '--bg'], ['--primary', '--surface'],
  ['--shop-on-primary', '--primary'],
  ['--tag-text', '--tag-bg'],
  ['--shop-danger', '--shop-danger-bg'], ['--shop-danger', '--surface'], ['--shop-danger', '--bg'],
  ['--shop-on-danger', '--shop-danger-solid'],
  ['--shop-warn', '--shop-warn-bg'], ['--shop-warn', '--surface'], ['--shop-warn', '--bg'],
  ['--shop-ok', '--shop-ok-bg'],
  ['--shop-disabled-text', '--shop-disabled-bg'],
];
// 枠・フォーカスなどの部品は 3:1。フォーカスの輪郭は offset 2px で、ボタンの色ではなく、ページの背景に接する（なので --primary との組は見ない）
const NON_TEXT: [string, string][] = [
  ['--shop-line', '--bg'], ['--shop-line', '--surface'],
  ['--shop-focus', '--bg'], ['--shop-focus', '--surface'],
];

describe.each([
  ['ライト', light],
  ['ダーク', dark],
])('%s: 色のコントラスト', (_name, t) => {
  it('トークンが読めている', () => {
    for (const k of ['--bg', '--surface', '--text', '--primary', '--shop-line', '--shop-focus']) expect(t[k]).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it.each(TEXT)('文字 %s on %s は 4.5:1 以上', (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(NON_TEXT)('部品 %s on %s は 3:1 以上', (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(3);
  });
});

describe('操作の大きさ', () => {
  it('ボタンとリンクのボタンは、高さ 44px 以上', () => {
    expect(shop).toMatch(/\.shop-btn\s*\{[^}]*min-height:\s*44px/);
    expect(shop).toMatch(/\.shop-btn\s*\{[^}]*min-width:\s*44px/);
    expect(shop).toMatch(/\.shop-nav-link\s*\{[^}]*min-height:\s*44px/);
    expect(shop).toMatch(/\.shop-tab\s*\{[^}]*min-height:\s*44px/);
    expect(shop).toMatch(/\.shop-link-btn\s*\{[^}]*min-height:\s*44px/);
  });
  it('フォーカスの輪郭を消さない', () => {
    expect(shop).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--shop-focus\);\s*outline-offset:\s*2px/);
  });
});

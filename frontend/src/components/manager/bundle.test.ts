// Recharts は、動的 import の先（components/manager/charts/）だけが読む。顧客の画面・スタッフの画面・店長の画面の本体は、静かに読み込まない（初期表示に影響させない）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../../..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules' || name === '.next') return [];
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe('Recharts の読み込み', () => {
  const sources = [...files(join(root, 'app')), ...files(join(root, 'src'))].map((p) => ({ path: relative(root, p), text: readFileSync(p, 'utf8') }));

  it("'recharts' を import するのは、components/manager/charts/ のファイルだけ", () => {
    const importers = sources.filter((s) => /from\s+['"]recharts['"]|import\(\s*['"]recharts['"]\s*\)/.test(s.text)).map((s) => s.path);
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.every((p) => p.startsWith('src/components/manager/charts/'))).toBe(true);
  });

  it('charts/ のファイルは、LazyCharts.tsx の動的 import（ssr: false）からだけ読まれる', () => {
    const lazy = sources.find((s) => s.path === 'src/components/manager/LazyCharts.tsx')!;
    expect(lazy.text).toMatch(/dynamic\(\(\) => import\('\.\/charts\/SalesLineChart'\), \{ ssr: false/);
    expect(lazy.text).toMatch(/dynamic\(\(\) => import\('\.\/charts\/HorizontalBars'\), \{ ssr: false/);
    const staticImports = sources.filter((s) => /from\s+['"][^'"]*\/charts\/[^'"]+['"]/.test(s.text)).map((s) => s.path);
    expect(staticImports).toEqual([]); // 静的な import は無い
  });

  it('顧客の画面（app/ の manager・staff 以外）は、店長の画面の部品も manager.css も読まない', () => {
    const customerSide = sources.filter((s) => !s.path.startsWith('app/manager/') && !s.path.startsWith('app/staff/') && !s.path.startsWith('src/components/manager/') && !s.path.startsWith('src/lib/manager/') && !s.path.startsWith('src/styles/manager.css') && !s.path.startsWith('src/components/staff/') && !s.path.startsWith('src/lib/staff/'));
    expect(customerSide.filter((s) => /from\s+['"][^'"]*manager[^'"]*['"]|import\s+['"][^'"]*manager[^'"]*['"]/.test(s.text)).map((s) => s.path)).toEqual([]);
  });
});

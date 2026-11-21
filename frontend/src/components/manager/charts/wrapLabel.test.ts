import { describe, expect, it } from 'vitest';
import { LINE_CHARS, MAX_LINES, wrapLabel } from './wrapLabel';

describe('wrapLabel', () => {
  it('keeps a short name on one line', () => {
    expect(wrapLabel('オアシスブレンド')).toEqual(['オアシスブレンド']);
  });

  it('wraps a long name and keeps the trailing mark', () => {
    const lines = wrapLabel('オアシスブレンド（発注点割れ）');
    expect(lines.length).toBe(2);
    expect(lines.join('')).toBe('オアシスブレンド（発注点割れ）');
    expect(lines.every((l) => Array.from(l).length <= LINE_CHARS)).toBe(true);
  });

  it('breaks before a parenthesis instead of inside the mark', () => {
    expect(wrapLabel('ガトーショコラ（発注点割れ）')).toEqual(['ガトーショコラ', '（発注点割れ）']);
    expect(wrapLabel('オアシスブレンドの豆（200 g）')).toEqual(['オアシスブレンドの豆', '（200 g）']);
  });

  it('truncates only past the line limit, at the end of the last line', () => {
    const name = 'あ'.repeat(LINE_CHARS * MAX_LINES + 5);
    const lines = wrapLabel(name);
    expect(lines.length).toBe(MAX_LINES);
    const last = lines[MAX_LINES - 1] ?? '';
    expect(last.endsWith('…')).toBe(true);
    expect(Array.from(last).length).toBe(LINE_CHARS);
  });

  it('does not truncate a name that exactly fills the limit', () => {
    const lines = wrapLabel('あ'.repeat(LINE_CHARS * MAX_LINES));
    expect(lines.join('')).toBe('あ'.repeat(LINE_CHARS * MAX_LINES));
  });

  it('returns one empty line for an empty name', () => {
    expect(wrapLabel('')).toEqual(['']);
  });
});

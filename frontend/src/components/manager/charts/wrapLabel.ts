// 横棒グラフの縦軸の名前を、折り返して複数行にする。Recharts の既定は 1 行で、長い品名が軸の外に切れていた。
// 全角を 1 文字として数える近似（半角が混ざると、実際の幅はこれより狭い）。
// 「（発注点割れ）」「（200 g）」のような括弧書きは、品名の途中で割らず、括弧の前で改行する（注意の印を読みやすく保つ）。
// 省略は行数の上限を超えたときだけ、最後の行の末尾で行う。
export const LINE_CHARS = 10;
export const MAX_LINES = 3;

function chunk(chars: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += LINE_CHARS) out.push(chars.slice(i, i + LINE_CHARS).join(''));
  return out;
}

export function wrapLabel(name: string): string[] {
  const chars = Array.from(name);
  if (chars.length === 0) return [''];
  const cut = chars.indexOf('（');
  const parts = chars.length > LINE_CHARS && cut > 0 ? [chars.slice(0, cut), chars.slice(cut)] : [chars];
  const lines = parts.flatMap(chunk);
  if (lines.length <= MAX_LINES) return lines;
  const kept = lines.slice(0, MAX_LINES);
  kept[MAX_LINES - 1] = `${Array.from(kept[MAX_LINES - 1] ?? '').slice(0, LINE_CHARS - 1).join('')}…`;
  return kept;
}

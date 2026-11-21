'use client';
import { useId, useState, type ReactNode } from 'react';

type Mode = 'chart' | 'table';
type Props = {
  title: string;
  /** グラフの内容を、1 文で（グラフの代わりに読める要約）。表でも見られることを添える */
  summary?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  /** 表示を切り替えるボタンの名前（グラフ側）。ヒートマップは「色」 */
  chartLabel?: string;
  note?: ReactNode;
};

/** すべてのグラフの枠。「グラフ」と「表で見る」を切り替える（色の凡例だけで意味が決まらないように、同じ数字を表でも見られる）。表のときは、グラフの部品を読み込まない */
export function ChartCard({ title, summary, chart, table, chartLabel = 'グラフ', note }: Props) {
  const [mode, setMode] = useState<Mode>('chart');
  const headingId = useId();
  return (
    <section className="mg-card" aria-labelledby={headingId}>
      <div className="mg-card-head">
        <h2 id={headingId}>{title}</h2>
        <div className="mg-toggle" role="group" aria-label={`${title}の表示`}>
          <button type="button" className="mg-toggle-btn" aria-pressed={mode === 'chart'} onClick={() => setMode('chart')}>
            {chartLabel}
          </button>
          <button type="button" className="mg-toggle-btn" aria-pressed={mode === 'table'} onClick={() => setMode('table')}>
            表で見る
          </button>
        </div>
      </div>
      {summary ? <p className="mg-summary">{summary}</p> : null}
      <div className="mg-card-body">{mode === 'chart' ? chart : table}</div>
      {note ? <p className="mg-note">{note}</p> : null}
    </section>
  );
}

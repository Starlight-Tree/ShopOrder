'use client';
// 売上の推移の折れ線（日々の売上 + 移動平均）。Recharts は、このファイルだけが読み込む（LazyCharts から動的 import。顧客の画面の初期表示に影響させない）。
// 色は CSS の変数（manager.css）だけ。休業・未集計の点は値が null で、線が途切れる（0 とは別）。
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import { lumi, salesCell, type SalesRow } from '../../../lib/manager/series';

type Props = { rows: SalesRow[]; averageLabel: string };

function SalesTooltip({ active, label, payload, rows, averageLabel }: TooltipContentProps & { rows: SalesRow[]; averageLabel: string }) {
  if (!active || !payload?.length) return null;
  const row = rows.find((r) => r.axis === label);
  if (!row) return null;
  return (
    <div className="mg-tooltip" role="status">
      <p className="mg-tooltip-title">{row.label}</p>
      <p>
        売上: <strong>{salesCell(row)}</strong>
      </p>
      {row.average !== null ? (
        <p>
          {averageLabel}: <strong>{lumi(row.average)}</strong>
        </p>
      ) : null}
      {row.orders !== null ? <p>注文: {row.orders.toLocaleString('ja-JP')} 件</p> : null}
    </div>
  );
}

export default function SalesLineChart({ rows, averageLabel }: Props) {
  return (
    <div className="mg-chart" style={{ height: 300 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--mg-grid)" vertical={false} />
          <XAxis dataKey="axis" tick={{ fill: 'var(--mg-muted)', fontSize: 12 }} stroke="var(--mg-axis)" minTickGap={16} />
          <YAxis
            tick={{ fill: 'var(--mg-muted)', fontSize: 12 }}
            stroke="var(--mg-axis)"
            width={52}
            tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
          />
          <Tooltip content={(props: TooltipContentProps) => <SalesTooltip {...props} rows={rows} averageLabel={averageLabel} />} />
          <Legend wrapperStyle={{ color: 'var(--mg-text)', fontSize: 13 }} />
          <Line type="monotone" dataKey="sales" name="売上" stroke="var(--mg-series-1)" strokeWidth={1.5} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="average" name={averageLabel} stroke="var(--mg-series-2)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

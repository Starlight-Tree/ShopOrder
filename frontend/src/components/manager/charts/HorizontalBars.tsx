'use client';
// 横棒（1 系列）。商品別の売上・在庫の残日数・廃棄の率・顧客の区分の人数に使う。Recharts は動的 import（LazyCharts）から。
// 色は CSS の変数だけ。注意の印（alert）は、色に加えて、名前の文字（呼び出し側が「（発注点割れ）」などを添える）でも伝える。
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';

export type BarRow = { name: string; value: number | null; alert?: boolean };
type Props = { rows: BarRow[]; unit: string; valueName: string; ariaLabel?: string };

function BarTooltip({ active, payload, unit, valueName }: TooltipContentProps & { unit: string; valueName: string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as BarRow | undefined;
  if (!row) return null;
  return (
    <div className="mg-tooltip" role="status">
      <p className="mg-tooltip-title">{row.name}</p>
      <p>
        {valueName}: <strong>{row.value === null ? '5 人未満' : `${row.value.toLocaleString('ja-JP')}${unit}`}</strong>
      </p>
    </div>
  );
}

export default function HorizontalBars({ rows, unit, valueName }: Props) {
  const height = Math.max(160, rows.length * 34 + 40);
  return (
    <div className="mg-chart" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }} barCategoryGap={6}>
          <CartesianGrid stroke="var(--mg-grid)" horizontal={false} />
          <XAxis type="number" tick={{ fill: 'var(--mg-muted)', fontSize: 12 }} stroke="var(--mg-axis)" allowDecimals={false} />
          <YAxis type="category" dataKey="name" width={132} tick={{ fill: 'var(--mg-text)', fontSize: 12 }} stroke="var(--mg-axis)" interval={0} />
          <Tooltip cursor={{ fill: 'var(--mg-hover)' }} content={(props: TooltipContentProps) => <BarTooltip {...props} unit={unit} valueName={valueName} />} />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={r.name} fill={r.alert ? 'var(--mg-alert)' : 'var(--mg-series-1)'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

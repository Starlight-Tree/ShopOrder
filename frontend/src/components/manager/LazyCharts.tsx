'use client';
// Recharts を使うグラフは、すべてここから動的 import する（ssr: false）。顧客の画面・スタッフの画面は、このファイルを読み込まない。
// 読み込み中は、同じ高さの枠を出す（表示のずれを小さくする）。「表で見る」にしている間は、グラフの部品を読み込まない。
import dynamic from 'next/dynamic';

function ChartSkeleton() {
  return (
    <div className="mg-chart mg-chart-loading" role="status" aria-live="polite" style={{ height: 240 }}>
      グラフを読み込んでいます…
    </div>
  );
}

export const SalesLineChart = dynamic(() => import('./charts/SalesLineChart'), { ssr: false, loading: () => <ChartSkeleton /> });
export const HorizontalBars = dynamic(() => import('./charts/HorizontalBars'), { ssr: false, loading: () => <ChartSkeleton /> });

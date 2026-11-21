import type { StockRow } from '../../lib/contract';

/**
 * 在庫の表。少ない品目（low）は、色だけに頼らず「少ない」の文字も出す。
 * 狭い幅では、1 行を縦に積む（横スクロールを出さない。CSS の data-label）。
 */
export function StockTable({ rows }: { rows: readonly StockRow[] }) {
  if (rows.length === 0) return <p className="muted">在庫の品目がありません。</p>;
  const lowCount = rows.filter((r) => r.low).length;
  return (
    <>
      <p className="st-stock-summary">
        {rows.length} 品目
        {lowCount > 0 ? (
          <>
            のうち、<strong className="st-low-count">{lowCount} 品目が少なくなっています</strong>
          </>
        ) : (
          '。少ない品目はありません'
        )}
      </p>
      {/* 狭い幅で CSS が display を変えても、表の意味（役割）が残るように、役割を明示する */}
      <table className="st-table" role="table">
        <caption className="sr-only">在庫の一覧（品名・単位・実在庫・確保中・使える数・発注点・状態）</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">品名</th>
            <th scope="col" role="columnheader">単位</th>
            <th scope="col" role="columnheader" className="num">
              実在庫
            </th>
            <th scope="col" role="columnheader" className="num">
              確保中
            </th>
            <th scope="col" role="columnheader" className="num">
              使える数
            </th>
            <th scope="col" role="columnheader" className="num">
              発注点
            </th>
            <th scope="col" role="columnheader">状態</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((r, i) => (
            <tr key={`${r.item_id}-${i}`} role="row" className={r.low ? 'is-low' : undefined}>
              <th scope="row" role="rowheader" data-label="品名">
                {r.name}
              </th>
              <td role="cell" data-label="単位">{r.unit}</td>
              <td role="cell" data-label="実在庫" className="num">
                {r.on_hand}
              </td>
              <td role="cell" data-label="確保中" className="num">
                {r.reserved}
              </td>
              <td role="cell" data-label="使える数" className="num">
                {r.available}
              </td>
              <td role="cell" data-label="発注点" className="num">
                {r.reorder_point}
              </td>
              <td role="cell" data-label="状態">{r.low ? <span className="tag tag-danger">少ない</span> : <span className="muted">足りている</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted st-table-note">使える数 = 実在庫 − 確保中 − 安全在庫。使える数が発注点を下回ると「少ない」と出します。</p>
    </>
  );
}

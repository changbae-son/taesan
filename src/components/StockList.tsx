import type { Stock } from '../types';
import styles from './StockList.module.css';

interface Props {
  stocks: Stock[];
  onSelect: (id: string) => void;
}

function getStatusBadge(stock: Stock) {
  const filled = (stock.buyPlans || []).filter((b) => b.filled).length;
  if (filled === 0) return { text: '관찰', color: '#888', bg: '#f0f0f0' };
  if ((stock.totalQuantity || 0) === 0) return { text: '완료', color: '#4a90d9', bg: '#e8f0fe' };
  return { text: '보유', color: '#4caf50', bg: '#e8f5e9' };
}

function renderDots(stock: Stock) {
  return (stock.buyPlans || []).map((bp, i) => {
    let color = '#ddd';
    if (bp.filled) {
      if (i < 2) color = '#4caf50';
      else if (i === 2) color = '#ff9800';
      else color = '#f44336';
    }
    return (
      <span
        key={i}
        className={styles.dot}
        style={{ background: color }}
        title={`${bp.level}차`}
      />
    );
  });
}

function getProfitPercent(stock: Stock): number {
  if ((stock.avgPrice || 0) === 0) return 0;
  return (((stock.currentPrice || 0) - stock.avgPrice) / stock.avgPrice) * 100;
}

function getNextBuyPrice(stock: Stock): number {
  const next = (stock.buyPlans || []).find((b) => !b.filled);
  return next?.price || 0;
}

function getNextSellPrice(stock: Stock): number {
  const next = (stock.sellPlans || []).find((s) => !s.filled);
  return next?.price || 0;
}

function getMASellPrice(stock: Stock): number {
  const next = (stock.maSells || []).find((m) => !m.filled);
  return next?.price || 0;
}

export default function StockList({ stocks, onSelect }: Props) {
  return (
    <div className={styles.container}>
      <h2 className={styles.title}>전체 종목 리스트</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>종목명</th>
              <th>상태</th>
              <th>진행</th>
              <th>다음매수가</th>
              <th>다음매도가</th>
              <th>MA매도가</th>
              <th>평단가</th>
              <th>잔고</th>
              <th>손익%</th>
              <th>룰</th>
            </tr>
          </thead>
          <tbody>
            {stocks.length === 0 && (
              <tr>
                <td colSpan={10} className={styles.empty}>
                  종목을 추가해주세요
                </td>
              </tr>
            )}
            {stocks.map((stock) => {
              const badge = getStatusBadge(stock);
              const profit = getProfitPercent(stock);
              return (
                <tr
                  key={stock.id}
                  className={styles.row}
                  onClick={() => onSelect(stock.id)}
                >
                  <td className={styles.name}>{stock.name}</td>
                  <td>
                    <span
                      className={styles.badge}
                      style={{ color: badge.color, background: badge.bg }}
                    >
                      {badge.text}
                    </span>
                  </td>
                  <td>
                    <div className={styles.dots}>{renderDots(stock)}</div>
                  </td>
                  <td className={styles.num}>
                    {getNextBuyPrice(stock).toLocaleString() || '-'}
                  </td>
                  <td className={styles.num}>
                    {getNextSellPrice(stock).toLocaleString() || '-'}
                  </td>
                  <td className={styles.num} style={{ color: '#ff9800' }}>
                    {getMASellPrice(stock).toLocaleString() || '-'}
                  </td>
                  <td className={styles.num} style={{ color: '#ff9800' }}>
                    {(stock.avgPrice || 0).toLocaleString() || '-'}
                  </td>
                  <td className={styles.num}>
                    {(stock.totalQuantity || 0).toLocaleString()}
                  </td>
                  <td
                    className={styles.num}
                    style={{ color: profit >= 0 ? '#4caf50' : '#f44336', fontWeight: 600 }}
                  >
                    {(stock.avgPrice || 0) > 0 ? `${profit.toFixed(2)}%` : '-'}
                  </td>
                  <td>
                    <span className={styles.ruleBadge}>
                      {stock.rule}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

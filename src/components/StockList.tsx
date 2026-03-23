import type { Stock, Trade } from '../types';
import styles from './StockList.module.css';

interface Props {
  stocks: Stock[];
  trades: Trade[];
  onSelect: (id: string) => void;
}

function getStatus(stock: Stock) {
  const filled = (stock.buyPlans || []).filter((b) => b.filled).length;
  if (filled === 0) return { text: '관찰', color: '#888', bg: '#f0f0f0' };
  if ((stock.totalQuantity || 0) === 0) return { text: '완료', color: '#4a90d9', bg: '#e8f0fe' };
  return { text: '보유', color: '#4caf50', bg: '#e8f5e9' };
}

function getProfitPercent(stock: Stock): number {
  if ((stock.avgPrice || 0) === 0) return 0;
  return (((stock.currentPrice || 0) - stock.avgPrice) / stock.avgPrice) * 100;
}

function getSellProgress(stock: Stock, trades: Trade[]): number {
  // 매매일지에서 해당 종목 매도 횟수 (날짜별 그룹)
  const sellDates = new Set(
    trades.filter((t) => t.stockName === stock.name && t.type === 'sell').map((t) => t.date)
  );
  const planFilled = (stock.sellPlans || []).filter((s) => s.filled).length;
  return Math.max(sellDates.size, planFilled);
}

export default function StockList({ stocks, trades, onSelect }: Props) {
  return (
    <div className={styles.container}>
      <h2 className={styles.title}>전체 종목 리스트</h2>

      {stocks.length === 0 && (
        <div className={styles.emptyCard}>종목을 추가해주세요</div>
      )}

      <div className={styles.grid}>
        {stocks.map((stock) => {
          const status = getStatus(stock);
          const profit = getProfitPercent(stock);
          const buyFilled = (stock.buyPlans || []).filter((b) => b.filled).length;
          const buyTotal = (stock.buyPlans || []).length || 5;
          const sellFilled = getSellProgress(stock, trades);
          const sellTotal = 5;
          const nextBuy = (stock.buyPlans || []).find((b) => !b.filled);
          const nextSell = (stock.sellPlans || []).find((s) => !s.filled);

          return (
            <div
              key={stock.id}
              className={styles.card}
              onClick={() => onSelect(stock.id)}
            >
              {/* 헤더 */}
              <div className={styles.cardHeader}>
                <span className={styles.stockName}>{stock.name}</span>
                <div className={styles.headerRight}>
                  <span
                    className={styles.statusBadge}
                    style={{ color: status.color, background: status.bg }}
                  >
                    {status.text}
                  </span>
                  <span className={styles.ruleBadge}>{stock.rule}</span>
                </div>
              </div>

              {/* 매수/매도 진행 */}
              <div className={styles.progressSection}>
                <div className={styles.progressItem}>
                  <div className={styles.progressLabel}>
                    <span>매수</span>
                    <span className={styles.progressCount}>{buyFilled}/{buyTotal}차</span>
                  </div>
                  <div className={styles.progressBar}>
                    <div className={styles.dots}>
                      {(stock.buyPlans || []).map((bp, i) => (
                        <span
                          key={i}
                          className={`${styles.dot} ${bp.filled ? styles.dotFilled : ''}`}
                          style={bp.filled ? {
                            background: i < 2 ? '#4caf50' : i === 2 ? '#ff9800' : '#f44336',
                          } : undefined}
                        />
                      ))}
                    </div>
                    <div className={styles.bar}>
                      <div
                        className={styles.barFill}
                        style={{
                          width: `${(buyFilled / buyTotal) * 100}%`,
                          background: buyFilled <= 2 ? '#4caf50' : buyFilled === 3 ? '#ff9800' : '#f44336',
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className={styles.progressItem}>
                  <div className={styles.progressLabel}>
                    <span>매도</span>
                    <span className={styles.progressCount}>{sellFilled}/{sellTotal}회</span>
                  </div>
                  <div className={styles.progressBar}>
                    <div className={styles.dots}>
                      {[0, 1, 2, 3, 4].map((i) => (
                        <span
                          key={i}
                          className={`${styles.dot} ${i < sellFilled ? styles.dotSellFilled : ''}`}
                        />
                      ))}
                    </div>
                    <div className={styles.bar}>
                      <div
                        className={styles.barFill}
                        style={{
                          width: `${(sellFilled / sellTotal) * 100}%`,
                          background: '#f44336',
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* 주요 수치 */}
              <div className={styles.metrics}>
                <div className={styles.metricItem}>
                  <span className={styles.metricLabel}>평단가</span>
                  <span className={styles.metricValue} style={{ color: '#ff9800' }}>
                    {(stock.avgPrice || 0).toLocaleString()}
                  </span>
                </div>
                <div className={styles.metricItem}>
                  <span className={styles.metricLabel}>현재가</span>
                  <span className={styles.metricValue}>
                    {(stock.currentPrice || 0).toLocaleString()}
                  </span>
                </div>
                <div className={styles.metricItem}>
                  <span className={styles.metricLabel}>손익</span>
                  <span
                    className={styles.profitValue}
                    style={{ color: profit >= 0 ? '#4caf50' : '#f44336' }}
                  >
                    {(stock.avgPrice || 0) > 0 ? `${profit >= 0 ? '+' : ''}${profit.toFixed(1)}%` : '-'}
                  </span>
                </div>
                <div className={styles.metricItem}>
                  <span className={styles.metricLabel}>잔고</span>
                  <span className={styles.metricValue}>
                    {(stock.totalQuantity || 0).toLocaleString()}
                  </span>
                </div>
              </div>

              {/* 다음 매수/매도 */}
              {(nextBuy || nextSell) && (
                <div className={styles.nextActions}>
                  {nextBuy && (
                    <span className={styles.nextBuy}>
                      다음매수 {nextBuy.price.toLocaleString()}
                    </span>
                  )}
                  {nextSell && (
                    <span className={styles.nextSell}>
                      다음매도 {nextSell.price.toLocaleString()}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

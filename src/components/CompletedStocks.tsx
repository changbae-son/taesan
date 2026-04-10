import type { Stock, Trade } from '../types';
import styles from './CompletedStocks.module.css';

interface Props {
  stocks: Stock[];
  trades: Trade[];
  onDelete: (id: string) => void;
}

export default function CompletedStocks({ stocks, trades, onDelete }: Props) {
  // 보유수량 0이고, 매수 체결이 있었던 종목 = 매매완료
  const completed = stocks.filter(
    (s) => s.totalQuantity === 0 && s.buyPlans.some((bp) => bp.filled)
  );

  // 종목별 수익 계산
  const getStats = (stock: Stock) => {
    const stockTrades = trades.filter((t) => t.stockName === stock.name);
    const buys = stockTrades.filter((t) => t.type === 'buy');
    const sells = stockTrades.filter((t) => t.type === 'sell');

    // 매수 총액/수량
    let totalBuyAmt = 0;
    let totalBuyQty = 0;
    stock.buyPlans.forEach((bp) => {
      if (bp.filled) {
        const qty = bp.filledQuantity || bp.quantity;
        const price = bp.filledPrice || bp.price;
        totalBuyAmt += price * qty;
        totalBuyQty += qty;
      }
    });
    const avgBuyPrice = totalBuyQty > 0 ? Math.round(totalBuyAmt / totalBuyQty) : 0;

    // 매도 총액/수량
    let totalSellAmt = 0;
    let totalSellQty = 0;
    stock.sellPlans.forEach((sp) => {
      if (sp.filled) {
        const qty = sp.filledQuantity || sp.quantity;
        const price = sp.filledPrice || sp.price;
        totalSellAmt += price * qty;
        totalSellQty += qty;
      }
    });
    stock.maSells.forEach((ms) => {
      if (ms.filled) {
        totalSellAmt += ms.price * ms.quantity;
        totalSellQty += ms.quantity;
      }
    });
    const avgSellPrice = totalSellQty > 0 ? Math.round(totalSellAmt / totalSellQty) : 0;

    // 실현 수익
    const profit = totalSellAmt - totalBuyAmt;
    const profitPercent = totalBuyAmt > 0 ? ((totalSellAmt - totalBuyAmt) / totalBuyAmt) * 100 : 0;

    // 날짜: 매매일지 > sellPlans filledDate > buyPlans filledDate
    const firstBuyDate = buys.length > 0
      ? buys[0].date
      : stock.buyPlans.find((bp) => bp.filledDate)?.filledDate || '';
    const sellPlanDates = stock.sellPlans
      .filter((sp) => sp.filled && sp.filledDate)
      .map((sp) => sp.filledDate as string)
      .sort();
    const lastSellDate = sells.length > 0
      ? sells[sells.length - 1].date
      : sellPlanDates.length > 0
        ? sellPlanDates[sellPlanDates.length - 1]
        : '';

    // 매수 차수
    const filledBuys = stock.buyPlans.filter((bp) => bp.filled).length;
    // 매도 횟수
    const filledSells = stock.sellPlans.filter((sp) => sp.filled).length +
      stock.maSells.filter((ms) => ms.filled).length;

    return {
      avgBuyPrice,
      avgSellPrice,
      totalBuyQty,
      totalSellQty,
      totalBuyAmt,
      totalSellAmt,
      profit,
      profitPercent,
      firstBuyDate,
      lastSellDate,
      filledBuys,
      filledSells,
      rule: stock.rule,
    };
  };

  // 전체 요약
  const totalProfit = completed.reduce((sum, s) => {
    const st = getStats(s);
    return sum + st.profit;
  }, 0);
  const totalBuyAmt = completed.reduce((sum, s) => {
    const st = getStats(s);
    return sum + st.totalBuyAmt;
  }, 0);
  const totalProfitPercent = totalBuyAmt > 0 ? (totalProfit / totalBuyAmt) * 100 : 0;

  if (completed.length === 0) {
    return (
      <div className={styles.container}>
        <h2 className={styles.pageTitle}>매매완료 종목</h2>
        <div className={styles.empty}>
          <p>매매가 완료된 종목이 없습니다.</p>
          <p className={styles.emptyHint}>보유수량이 0이 되면 자동으로 여기에 표시됩니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.pageTitle}>
        매매완료 종목
        <span className={styles.count}>{completed.length}종목</span>
      </h2>

      {/* 전체 요약 */}
      <div className={styles.totalSummary}>
        <div className={styles.totalItem}>
          <span className={styles.totalLabel}>총 투자금액</span>
          <span className={styles.totalValue}>{totalBuyAmt.toLocaleString()}원</span>
        </div>
        <div className={styles.totalItem}>
          <span className={styles.totalLabel}>총 실현수익</span>
          <span className={styles.totalValue} style={{ color: totalProfit >= 0 ? '#e53935' : '#1565c0' }}>
            {totalProfit >= 0 ? '+' : ''}{totalProfit.toLocaleString()}원
          </span>
        </div>
        <div className={styles.totalItem}>
          <span className={styles.totalLabel}>총 수익률</span>
          <span className={styles.totalValue} style={{ color: totalProfitPercent >= 0 ? '#e53935' : '#1565c0' }}>
            {totalProfitPercent >= 0 ? '+' : ''}{totalProfitPercent.toFixed(2)}%
          </span>
        </div>
      </div>

      {/* 종목 카드 */}
      <div className={styles.cardGrid}>
        {completed.map((stock) => {
          const st = getStats(stock);
          const isProfit = st.profitPercent >= 0;
          return (
            <div key={stock.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <h3 className={styles.stockName}>{stock.name}</h3>
                <span className={`${styles.profitBadge} ${isProfit ? styles.profitBadgeGreen : styles.profitBadgeRed}`}>
                  {isProfit ? '+' : ''}{st.profitPercent.toFixed(1)}%
                </span>
              </div>

              <div className={styles.cardBody}>
                <div className={styles.priceRow}>
                  <div className={styles.priceItem}>
                    <span className={styles.priceLabel}>평균매수가</span>
                    <span className={styles.priceValue}>{st.avgBuyPrice.toLocaleString()}</span>
                  </div>
                  <div className={styles.priceArrow}>{isProfit ? '>' : '<'}</div>
                  <div className={styles.priceItem}>
                    <span className={styles.priceLabel}>평균매도가</span>
                    <span className={styles.priceValue} style={{ color: isProfit ? '#e53935' : '#1565c0' }}>
                      {st.avgSellPrice.toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className={styles.statsRow}>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>매수수량</span>
                    <span className={styles.statValue}>{st.totalBuyQty.toLocaleString()}</span>
                  </div>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>매도수량</span>
                    <span className={styles.statValue}>{st.totalSellQty.toLocaleString()}</span>
                  </div>
                  <div className={styles.statItem}>
                    <span className={styles.statLabel}>실현수익</span>
                    <span className={styles.statValue} style={{ color: isProfit ? '#e53935' : '#1565c0' }}>
                      {st.profit >= 0 ? '+' : ''}{st.profit.toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className={styles.metaRow}>
                  <span className={styles.metaItem}>
                    진입 {st.filledBuys}차 / 매도 {st.filledSells}회
                  </span>
                  <span className={styles.metaItem}>
                    룰{st.rule}
                  </span>
                  {(st.firstBuyDate || st.lastSellDate) && (
                    <span className={styles.metaItem}>
                      {st.firstBuyDate || '?'} ~ {st.lastSellDate || '?'}
                    </span>
                  )}
                </div>
              </div>

              <div className={styles.cardFooter}>
                <button
                  className={styles.deleteBtn}
                  onClick={() => {
                    if (confirm(`"${stock.name}" 종목을 삭제하시겠습니까?`)) {
                      onDelete(stock.id);
                    }
                  }}
                >
                  삭제
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

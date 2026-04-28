import { useState } from 'react';
import type { Stock, Trade } from '../types';
import styles from './StockList.module.css';

// 매수 기록 불완전 여부 판단
// - 보유 중인데 (totalQuantity > 0)
// - 매매일지 buy 기록도 없고
// - buyPlans 체결 fallback 데이터(filledDate+filledPrice+filledQuantity)도 없는 경우
function checkIncomplete(stock: Stock, trades: Trade[]): boolean {
  if ((stock.totalQuantity || 0) <= 0) return false;
  const hasTrades = trades.some((t) => t.stockName === stock.name && t.type === 'buy');
  if (hasTrades) return false;
  // filledDate 없어도 price/qty만 있으면 완전한 기록으로 간주 (API가 날짜 미지원 시 대비)
  const hasFallback = (stock.buyPlans || []).some(
    (bp) => bp.filled && bp.filledPrice && bp.filledQuantity
  );
  return !hasFallback;
}

interface Props {
  stocks: Stock[];
  trades: Trade[];
  onSelect: (id: string) => void;
}

function getProfitPercent(stock: Stock): number {
  if ((stock.avgPrice || 0) === 0) return 0;
  return (((stock.currentPrice || 0) - stock.avgPrice) / stock.avgPrice) * 100;
}

function getNextBuyGap(stock: Stock): number | null {
  const nextBuy = (stock.buyPlans || []).find((b) => !b.filled);
  if (!nextBuy || !stock.currentPrice || stock.currentPrice <= 0) return null;
  return ((stock.currentPrice - nextBuy.price) / nextBuy.price) * 100;
}

function getNextSellGap(stock: Stock): number | null {
  const nextSell = (stock.sellPlans || []).find((s) => !s.filled);
  if (!nextSell || !stock.currentPrice || stock.currentPrice <= 0) return null;
  return ((stock.currentPrice - nextSell.price) / nextSell.price) * 100;
}

function getFirstBuyQty(stock: Stock): number {
  const first = (stock.buyPlans || []).find((b) => b.level === 1);
  if (first && first.filled && first.filledQuantity) return first.filledQuantity;
  if (first && first.quantity) return first.quantity;
  return 0;
}

// 1차 매수 총금액 (체결 데이터 우선, 없으면 계획가)
function getFirstBuyAmt(stock: Stock): number {
  const first = (stock.buyPlans || []).find((b) => b.level === 1);
  if (first) {
    const price = (first.filled && first.filledPrice) ? first.filledPrice : first.price;
    const qty = (first.filled && first.filledQuantity) ? first.filledQuantity : first.quantity;
    if (price > 0 && qty > 0) return price * qty;
  }
  // fallback: Stock 기본 필드
  if (stock.firstBuyPrice > 0 && stock.firstBuyQuantity > 0) {
    return stock.firstBuyPrice * stock.firstBuyQuantity;
  }
  return 0;
}

// 금액 표시 포맷 (만원 단위)
function fmtAmt(n: number): string {
  if (n <= 0) return '-';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(0)}만`;
  return n.toLocaleString();
}

type GroupKey = 'signal' | 'waiting' | 'holding';

function getGroup(stock: Stock): GroupKey {
  if (stock.buySignal === 'signal') return 'signal';
  if (stock.buySignal === 'waiting') return 'waiting';
  return 'holding';
}

// 보유중 3단계 티어 분류
// 0: 매도 임박 (다음 매도가 -2% 이내)
// 1: 수익권 보유 (수익률 +3% 이상)
// 2: 일반 보유 (나머지)
function getHoldingTier(stock: Stock): number {
  const sellGap = getNextSellGap(stock);
  if (sellGap !== null && sellGap >= -2) return 0;
  if (getProfitPercent(stock) >= 3) return 1;
  return 2;
}

export default function StockList({ stocks, trades, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = stocks.filter((stock) => {
    if (!stock.name || !stock.name.trim()) return false;
    const hasFilled = (stock.buyPlans || []).some((b) => b.filled);
    if ((stock.totalQuantity || 0) === 0 && hasFilled) return false;
    return true;
  });

  // 그룹별 분류
  const grouped: Record<GroupKey, Stock[]> = { signal: [], waiting: [], holding: [] };
  for (const stock of filtered) {
    grouped[getGroup(stock)].push(stock);
  }

  // 정렬: 신호/대기는 매수가 근접 순
  grouped.signal.sort((a, b) => (getNextBuyGap(a) ?? 999) - (getNextBuyGap(b) ?? 999));
  grouped.waiting.sort((a, b) => (getNextBuyGap(a) ?? 999) - (getNextBuyGap(b) ?? 999));

  // 보유중: 3단계 액션 중심 정렬
  // [Tier 0] 매도 임박 → sellGap 오름차순 (목표가에 가장 가까운 것 먼저)
  // [Tier 1] 수익권 보유 → 수익률 내림차순 (높은 수익 먼저, 25% 수동매도 준비)
  // [Tier 2] 일반 보유 → 다음 매수가 근접 오름차순 (추가매수 임박 먼저), gap없으면 수익률 오름차순
  grouped.holding.sort((a, b) => {
    const tierA = getHoldingTier(a);
    const tierB = getHoldingTier(b);
    if (tierA !== tierB) return tierA - tierB;

    if (tierA === 0) {
      // 매도 임박: 목표가와 가장 가까운(gap 최소) 순
      return (getNextSellGap(a) ?? 999) - (getNextSellGap(b) ?? 999);
    }
    if (tierA === 1) {
      // 수익권: 수익률 내림차순
      return getProfitPercent(b) - getProfitPercent(a);
    }
    // 일반 보유: 다음 매수가 근접 오름차순
    const bgA = getNextBuyGap(a);
    const bgB = getNextBuyGap(b);
    if (bgA !== null && bgB !== null) return bgA - bgB;
    if (bgA !== null) return -1;
    if (bgB !== null) return 1;
    return getProfitPercent(a) - getProfitPercent(b);
  });

  const groupConfig: { key: GroupKey; label: string; icon: string; color: string }[] = [
    { key: 'signal', label: '매수신호', icon: '🔴', color: '#c62828' },
    { key: 'waiting', label: '매수대기', icon: '⏳', color: '#e65100' },
    { key: 'holding', label: '보유중', icon: '📊', color: '#1976d2' },
  ];

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // 대시보드 요약
  const totalProfit = filtered.reduce((sum, s) => {
    if (s.avgPrice > 0 && s.currentPrice > 0 && s.totalQuantity > 0) {
      return sum + (s.currentPrice - s.avgPrice) * s.totalQuantity;
    }
    return sum;
  }, 0);

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>전체 종목 리스트</h2>

      {/* 요약 대시보드 */}
      <div className={styles.dashboard}>
        <div className={styles.dashItem}>
          <span className={styles.dashNum}>{filtered.length}</span>
          <span className={styles.dashLabel}>전체</span>
        </div>
        <div className={`${styles.dashItem} ${styles.dashSignal}`}>
          <span className={styles.dashNum}>{grouped.signal.length}</span>
          <span className={styles.dashLabel}>매수신호</span>
        </div>
        <div className={`${styles.dashItem} ${styles.dashWaiting}`}>
          <span className={styles.dashNum}>{grouped.waiting.length}</span>
          <span className={styles.dashLabel}>매수대기</span>
        </div>
        <div className={styles.dashItem}>
          <span className={styles.dashNum} style={{ color: totalProfit >= 0 ? '#4caf50' : '#f44336' }}>
            {totalProfit >= 0 ? '+' : ''}{Math.round(totalProfit).toLocaleString()}
          </span>
          <span className={styles.dashLabel}>평가손익</span>
        </div>
      </div>

      {filtered.length === 0 && (
        <div className={styles.emptyCard}>종목을 추가해주세요</div>
      )}

      {/* 그룹별 카드 리스트 */}
      <div className={styles.groups}>
        {groupConfig.map(({ key, label, icon, color }) => {
          const group = grouped[key];
          if (group.length === 0) return null;
          const isCollapsed = collapsed[key] || false;

          return (
            <div key={key} className={styles.group}>
              <div
                className={styles.groupHeader}
                style={{ borderLeftColor: color }}
                onClick={() => toggleCollapse(key)}
              >
                <span className={styles.groupArrow}>{isCollapsed ? '▶' : '▼'}</span>
                <span className={styles.groupIcon}>{icon}</span>
                <span className={styles.groupLabel} style={{ color }}>{label}</span>
                <span className={styles.groupCount}>{group.length}</span>
              </div>

              {!isCollapsed && (
                <div className={styles.grid}>
                  {group.map((stock) => {
                    const profit = getProfitPercent(stock);
                    const buyFilled = (stock.buyPlans || []).filter((b) => b.filled).length;
                    const buyTotal = (stock.buyPlans || []).length || 5;
                    const sellFilled = (stock.sellPlans || []).filter((s) => s.filled).length;
                    const nextBuy = (stock.buyPlans || []).find((b) => !b.filled);
                    const nextSell = (stock.sellPlans || []).find((s) => !s.filled);
                    const buyGap = getNextBuyGap(stock);
                    const sellGap = getNextSellGap(stock);
                    const firstBuyQty = getFirstBuyQty(stock);
                    const isManualSell = nextSell && nextSell.percent >= 25;

                    const cardClass = stock.buySignal === 'signal' ? styles.cardSignal
                      : stock.buySignal === 'waiting' ? styles.cardWaiting
                      : styles.card;

                    // 양봉/음봉 (매수신호·매수대기만)
                    const openPrice = stock.buySignalOpen || 0;
                    const hasCandle = (stock.buySignal === 'signal' || stock.buySignal === 'waiting')
                      && openPrice > 0 && stock.currentPrice > 0;
                    const isYang = hasCandle && stock.currentPrice > openPrice;
                    const isUm = hasCandle && stock.currentPrice < openPrice;
                    const candleType = isYang ? 'yang' : isUm ? 'um' : 'doji';
                    const candleRate = openPrice > 0
                      ? ((stock.currentPrice - openPrice) / openPrice) * 100
                      : 0;
                    const barWidth = Math.min(Math.abs(candleRate) / 5 * 100, 100);

                    const incomplete = checkIncomplete(stock, trades);
                    const firstBuyAmt = getFirstBuyAmt(stock);
                    const currentVal = (stock.currentPrice || 0) * (stock.totalQuantity || 0);
                    const showAmt = (stock.totalQuantity || 0) > 0 && firstBuyAmt > 0;

                    return (
                      <div
                        key={stock.id}
                        className={cardClass}
                        onClick={() => onSelect(stock.id)}
                      >
                        {/* 1줄: 종목명 + 금액 + 상태 */}
                        <div className={styles.cardRow1}>
                          <span className={styles.stockName}>
                            {stock.name}
                            {stock.code && <span className={styles.stockCode}>{stock.code.replace(/^A/, '')}</span>}
                            {incomplete && (
                              <span className={styles.incompleteBadge} title="매수 기록 불완전 — 클릭하여 체결 정보 입력">⚠️</span>
                            )}
                          </span>
                          {showAmt && (
                            <span className={styles.amtInfo}>
                              <span className={styles.amtInit}>{fmtAmt(firstBuyAmt)}</span>
                              <span className={styles.amtArrow}>→</span>
                              <span
                                className={styles.amtCurrent}
                                style={{ color: currentVal >= firstBuyAmt ? '#4caf50' : '#f44336' }}
                              >
                                {fmtAmt(currentVal)}
                              </span>
                            </span>
                          )}
                          <div className={styles.badges}>
                            {stock.buySignal === 'signal' && (
                              <span className={styles.signalBadge}>매수신호!</span>
                            )}
                            {stock.buySignal === 'waiting' && (
                              <span className={styles.waitingBadge}>매수대기</span>
                            )}
                          </div>
                        </div>

                        {/* 진행도 점 표시 */}
                        <div className={styles.progressDots}>
                          <span className={styles.progressLabel}>매수</span>
                          <span className={styles.dots}>
                            {Array.from({ length: buyTotal }).map((_, i) => (
                              <span
                                key={i}
                                className={`${styles.dot} ${i < buyFilled ? styles.dotFilledBuy : ''}`}
                              />
                            ))}
                          </span>
                          <span className={styles.progressNum}>{buyFilled}/{buyTotal}</span>
                          <span className={styles.progressDivider}>·</span>
                          <span className={styles.progressLabel}>매도</span>
                          <span className={styles.dots}>
                            {Array.from({ length: 5 }).map((_, i) => (
                              <span
                                key={i}
                                className={`${styles.dot} ${i < sellFilled ? styles.dotFilledSell : ''}`}
                              />
                            ))}
                          </span>
                          <span className={styles.progressNum}>{sellFilled}/5</span>
                        </div>

                        {/* 2줄: 핵심 수치 */}
                        <div className={styles.cardRow2}>
                          <div className={styles.metric}>
                            <span className={styles.metricLabel}>현재가</span>
                            <span className={styles.metricMain}>
                              {(stock.currentPrice || 0).toLocaleString()}
                            </span>
                          </div>
                          <div className={styles.metric}>
                            <span className={styles.metricLabel}>평단가</span>
                            <span className={styles.metricVal}>
                              {(stock.avgPrice || 0).toLocaleString()}
                            </span>
                          </div>
                          <div className={styles.metric}>
                            <span className={styles.metricLabel}>손익</span>
                            <span className={styles.metricVal} style={{
                              color: profit >= 0 ? '#4caf50' : '#f44336',
                              fontWeight: 700,
                            }}>
                              {stock.avgPrice > 0 ? `${profit >= 0 ? '+' : ''}${profit.toFixed(1)}%` : '-'}
                            </span>
                          </div>
                          <div className={styles.metric}>
                            <span className={styles.metricLabel}>잔고 / 1차</span>
                            <span className={styles.metricVal}>
                              {(stock.totalQuantity || 0).toLocaleString()}
                              {firstBuyQty > 0 && (
                                <span className={styles.firstQty}> / {firstBuyQty.toLocaleString()}</span>
                              )}
                            </span>
                          </div>
                        </div>

                        {/* 양봉/음봉 표시 (매수신호·매수대기) */}
                        {hasCandle && (
                          <div className={styles.candleRow}>
                            <span className={`${styles.candleLabel} ${
                              candleType === 'yang' ? styles.candleLabelYang
                              : candleType === 'um' ? styles.candleLabelUm
                              : styles.candleLabelDoji
                            }`}>
                              {candleType === 'yang' ? '양봉' : candleType === 'um' ? '음봉' : '보합'}
                            </span>
                            <div className={styles.candleBar}>
                              <div
                                className={`${styles.candleBarFill} ${
                                  candleType === 'yang' ? styles.candleBarYang
                                  : candleType === 'um' ? styles.candleBarUm
                                  : styles.candleBarDoji
                                }`}
                                style={{ width: `${barWidth}%` }}
                              />
                            </div>
                            <span className={`${styles.candleRate} ${
                              candleType === 'yang' ? styles.candleRateYang
                              : candleType === 'um' ? styles.candleRateUm
                              : ''
                            }`}>
                              {candleRate >= 0 ? '+' : ''}{candleRate.toFixed(1)}%
                            </span>
                          </div>
                        )}

                        {/* 3줄: 다음 매수/매도 (메인 강조) */}
                        <div className={styles.actionRow}>
                          {nextBuy && (
                            <div className={styles.actionBlock}>
                              <div className={styles.actionHeader}>
                                <span className={styles.actionLabel}>다음매수</span>
                                <span className={styles.actionLevel}>{nextBuy.level}차</span>
                                {buyGap !== null && Math.abs(buyGap) <= 10 && (
                                  <span className={`${styles.gapBadge} ${
                                    Math.abs(buyGap) <= 3 ? styles.gapBadgeUrgent
                                    : Math.abs(buyGap) <= 5 ? styles.gapBadgeClose
                                    : styles.gapBadgeFar
                                  }`}>
                                    {buyGap >= 0 ? '+' : ''}{buyGap.toFixed(1)}%
                                  </span>
                                )}
                              </div>
                              <div className={styles.actionPrice}>
                                {nextBuy.price.toLocaleString()}
                              </div>
                            </div>
                          )}
                          {nextSell && (
                            <div className={`${styles.actionBlock} ${isManualSell ? styles.actionBlockManual : ''}`}>
                              <div className={styles.actionHeader}>
                                <span className={styles.actionLabel}>다음매도</span>
                                <span className={styles.actionLevel}>+{nextSell.percent}%</span>
                                {isManualSell && (
                                  <span className={styles.manualBadge}>수동</span>
                                )}
                                {sellGap !== null && Math.abs(sellGap) <= 10 && (
                                  <span className={`${styles.gapBadge} ${
                                    Math.abs(sellGap) <= 3 ? styles.gapBadgeUrgent
                                    : Math.abs(sellGap) <= 5 ? styles.gapBadgeClose
                                    : styles.gapBadgeFar
                                  }`}>
                                    {sellGap >= 0 ? '+' : ''}{sellGap.toFixed(1)}%
                                  </span>
                                )}
                              </div>
                              <div className={styles.actionPriceSell}>
                                {nextSell.price.toLocaleString()}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

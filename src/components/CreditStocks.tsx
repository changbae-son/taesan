import { useMemo, useState } from 'react';
import type { Stock, Position } from '../types';
import styles from './CreditStocks.module.css';

interface Props {
  stocks: Stock[];
  onSelectStock: (id: string) => void;
}

type SortKey = 'dueDate' | 'amount' | 'quantity' | 'profit' | 'name';

const fmt = (n: number) => Math.round(n).toLocaleString();
const fmtSign = (n: number) => (n >= 0 ? `+${fmt(n)}` : fmt(n));
const colorOf = (n: number) => (n >= 0 ? '#4caf50' : '#f44336');

function daysBetween(dateStr?: string): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const diff = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return diff;
}

export default function CreditStocks({ stocks, onSelectStock }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('dueDate');

  // 신용 포지션 보유 종목만 필터링
  const creditStocks = useMemo(() => {
    const items: {
      stock: Stock;
      creditPos: Position;
      cashPos?: Position;
      creditAmt: number;
      creditRatio: number;
      profit: number;
      profitAmt: number;
      dDay: number | null;
    }[] = [];
    for (const s of stocks) {
      if (!Array.isArray(s.positions)) continue;
      const credit = s.positions.find((p) => p.type === 'credit');
      if (!credit || credit.quantity <= 0) continue;
      const cash = s.positions.find((p) => p.type === 'cash');
      const creditAmt = credit.quantity * credit.avgPrice;
      const creditRatio = (s.totalQuantity || 0) > 0
        ? Math.round((credit.quantity / s.totalQuantity) * 100)
        : 0;
      const profit = (s.currentPrice || 0) > 0 && credit.avgPrice > 0
        ? ((s.currentPrice - credit.avgPrice) / credit.avgPrice) * 100
        : 0;
      const profitAmt = (s.currentPrice || 0) > 0
        ? (s.currentPrice - credit.avgPrice) * credit.quantity
        : 0;
      const dDay = daysBetween(credit.dueDate);
      items.push({
        stock: s,
        creditPos: credit,
        cashPos: cash,
        creditAmt,
        creditRatio,
        profit,
        profitAmt,
        dDay,
      });
    }
    // 정렬
    items.sort((a, b) => {
      switch (sortKey) {
        case 'dueDate':
          // null은 뒤로
          if (a.dDay === null && b.dDay === null) return 0;
          if (a.dDay === null) return 1;
          if (b.dDay === null) return -1;
          return a.dDay - b.dDay;
        case 'amount': return b.creditAmt - a.creditAmt;
        case 'quantity': return b.creditPos.quantity - a.creditPos.quantity;
        case 'profit': return b.profit - a.profit;
        case 'name': return a.stock.name.localeCompare(b.stock.name);
        default: return 0;
      }
    });
    return items;
  }, [stocks, sortKey]);

  // KPI
  const kpi = useMemo(() => {
    let totalCount = creditStocks.length;
    let totalCreditAmt = 0;
    let totalInterestAccrued = 0;
    let imminentCount = 0; // D-7 이내
    let totalProfit = 0;
    for (const item of creditStocks) {
      totalCreditAmt += item.creditAmt;
      totalInterestAccrued += item.creditPos.interestAccrued || 0;
      totalProfit += item.profitAmt;
      if (item.dDay !== null && item.dDay <= 7) imminentCount++;
    }
    return { totalCount, totalCreditAmt, totalInterestAccrued, imminentCount, totalProfit };
  }, [creditStocks]);

  // 월별 만기 캘린더 (향후 3개월)
  const calendar = useMemo(() => {
    const buckets: Record<string, number> = {};
    for (const item of creditStocks) {
      if (!item.creditPos.dueDate) continue;
      const month = item.creditPos.dueDate.slice(0, 7);
      buckets[month] = (buckets[month] || 0) + 1;
    }
    return Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));
  }, [creditStocks]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>💳 신용종목 관리</h2>
        <p className={styles.subtitle}>현재 보유 중인 신용/융자거래 포지션 모니터링</p>
      </div>

      {/* KPI */}
      <div className={styles.kpiGrid}>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>신용 종목</span>
          <span className={styles.kpiValue}>{kpi.totalCount}건</span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>신용 잔고</span>
          <span className={styles.kpiValue}>{fmt(kpi.totalCreditAmt)}원</span>
        </div>
        <div className={`${styles.kpiCard} ${kpi.imminentCount > 0 ? styles.kpiUrgent : ''}`}>
          <span className={styles.kpiLabel}>만기 임박 (D-7)</span>
          <span className={styles.kpiValue} style={{ color: kpi.imminentCount > 0 ? '#c62828' : '#333' }}>
            {kpi.imminentCount}건
          </span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>누적 이자</span>
          <span className={styles.kpiValue} style={{ color: kpi.totalInterestAccrued > 0 ? '#c62828' : '#888' }}>
            {kpi.totalInterestAccrued > 0 ? `−${fmt(kpi.totalInterestAccrued)}` : '0'}원
          </span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>신용 평가손익</span>
          <span className={styles.kpiValue} style={{ color: colorOf(kpi.totalProfit) }}>
            {fmtSign(kpi.totalProfit)}원
          </span>
        </div>
      </div>

      {/* 빈 상태 */}
      {creditStocks.length === 0 && (
        <div className={styles.empty}>
          <p>현재 신용/융자거래로 보유 중인 종목이 없습니다.</p>
          <p className={styles.emptyHint}>
            키움 데이터받기 또는 매매일지에서 신용 매수 trade 추가 시 여기에 표시됩니다.
          </p>
        </div>
      )}

      {/* 정렬 옵션 */}
      {creditStocks.length > 0 && (
        <div className={styles.toolbar}>
          <span className={styles.toolbarLabel}>정렬:</span>
          {([
            { key: 'dueDate', label: '만기 가까운 순' },
            { key: 'amount', label: '잔고 큰 순' },
            { key: 'quantity', label: '수량 많은 순' },
            { key: 'profit', label: '수익률 순' },
            { key: 'name', label: '종목명' },
          ] as { key: SortKey; label: string }[]).map((opt) => (
            <button
              key={opt.key}
              className={`${styles.sortBtn} ${sortKey === opt.key ? styles.sortBtnActive : ''}`}
              onClick={() => setSortKey(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* 종목 리스트 */}
      <div className={styles.list}>
        {creditStocks.map((item) => {
          const { stock, creditPos, cashPos, creditAmt, creditRatio, profit, profitAmt, dDay } = item;
          const isMixed = !!cashPos;
          const dDayColor = dDay === null ? '#888'
            : dDay <= 7 ? '#c62828'
            : dDay <= 14 ? '#ff9800'
            : '#4a90d9';
          return (
            <div key={stock.id} className={styles.itemCard}>
              <div className={styles.itemHeader}>
                <div className={styles.itemNameRow}>
                  <span className={styles.itemName}>{stock.name}</span>
                  {stock.code && <span className={styles.itemCode}>({stock.code.replace(/^A/, '')})</span>}
                  <span className={styles.mixBadge}>
                    {isMixed ? `[신혼합 ${creditRatio}%]` : '[신용 100%]'}
                  </span>
                </div>
                <button
                  className={styles.detailBtn}
                  onClick={() => onSelectStock(stock.id)}
                >
                  종목상세 →
                </button>
              </div>

              <div className={styles.itemGrid}>
                <div className={styles.itemMetric}>
                  <span className={styles.metricLabel}>신용 수량</span>
                  <span className={styles.metricValue}>
                    {creditPos.quantity.toLocaleString()}주
                    {isMixed && cashPos && (
                      <span className={styles.metricSub}> / 총 {stock.totalQuantity.toLocaleString()}주</span>
                    )}
                  </span>
                </div>
                <div className={styles.itemMetric}>
                  <span className={styles.metricLabel}>신용 평단</span>
                  <span className={styles.metricValue}>{fmt(creditPos.avgPrice)}원</span>
                </div>
                <div className={styles.itemMetric}>
                  <span className={styles.metricLabel}>잔고 금액</span>
                  <span className={styles.metricValue}>{fmt(creditAmt)}원</span>
                </div>
                <div className={styles.itemMetric}>
                  <span className={styles.metricLabel}>평가 손익</span>
                  <span className={styles.metricValue} style={{ color: colorOf(profit) }}>
                    {profit >= 0 ? '+' : ''}{profit.toFixed(2)}%
                    <span className={styles.metricSub}> ({fmtSign(profitAmt)})</span>
                  </span>
                </div>
                {creditPos.dueDate && (
                  <div className={styles.itemMetric}>
                    <span className={styles.metricLabel}>만기일</span>
                    <span className={styles.metricValue}>
                      {creditPos.dueDate}
                      <span className={styles.dDayBadge} style={{ color: dDayColor }}>
                        {dDay !== null && dDay >= 0 ? `D-${dDay}` : dDay !== null ? `만기 지남 (${-dDay}일)` : ''}
                      </span>
                    </span>
                  </div>
                )}
                {typeof creditPos.interestRate === 'number' && (
                  <div className={styles.itemMetric}>
                    <span className={styles.metricLabel}>연 이자율</span>
                    <span className={styles.metricValue}>{(creditPos.interestRate * 100).toFixed(2)}%</span>
                  </div>
                )}
                {typeof creditPos.interestAccrued === 'number' && creditPos.interestAccrued > 0 && (
                  <div className={styles.itemMetric}>
                    <span className={styles.metricLabel}>누적 이자</span>
                    <span className={styles.metricValue} style={{ color: '#c62828' }}>
                      −{fmt(creditPos.interestAccrued)}원
                    </span>
                  </div>
                )}
                {creditPos.since && (
                  <div className={styles.itemMetric}>
                    <span className={styles.metricLabel}>매수일</span>
                    <span className={styles.metricValue}>{creditPos.since}</span>
                  </div>
                )}
              </div>

              {!creditPos.dueDate && (
                <p className={styles.warningHint}>
                  💡 만기 정보 미설정 — Phase 2에서 자동 설정됩니다 (매수일 +90일 추정)
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* 만기 캘린더 */}
      {calendar.length > 0 && (
        <div className={styles.calendarCard}>
          <h3 className={styles.calendarTitle}>📅 만기 캘린더</h3>
          <div className={styles.calendarGrid}>
            {calendar.map(([month, count]) => (
              <div key={month} className={styles.calendarBucket}>
                <span className={styles.calendarMonth}>{month}</span>
                <span className={styles.calendarCount}>{count}건</span>
                <span className={styles.calendarBar} style={{ width: `${Math.min(100, count * 25)}%` }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 안내 박스 */}
      <div className={styles.infoBox}>
        <h4 className={styles.infoTitle}>📚 신용거래 안내</h4>
        <ul className={styles.infoList}>
          <li>신용/융자거래는 <strong>90일 만기</strong> — 만기 지나면 반대매매(강제청산) 발생</li>
          <li>연 약 <strong>7~9% 이자</strong> 일할 계산</li>
          <li>담보유지비율 <strong>140% 미만</strong> 시 추가 담보 요구 또는 반대매매</li>
          <li>매매 액션 (매도/연장/현물전환)은 <strong>종목 상세</strong>에서 진행</li>
          <li>이 화면은 모니터링 전용 (Phase 2에서 만기 알림 텔레그램 추가 예정)</li>
        </ul>
      </div>
    </div>
  );
}

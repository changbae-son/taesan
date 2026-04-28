import { useState } from 'react';
import type { Stock, Trade } from '../types';
import styles from './CompletedStocks.module.css';

interface Props {
  stocks: Stock[];
  trades: Trade[];
  onDelete: (id: string) => void;
}

const REENTRY_API = 'https://asia-northeast3-teasan-f4c17.cloudfunctions.net/reentryControl';

type FilterType = 'all' | 'tracking' | 'ready' | 'paused' | 'no_tracking';

export default function CompletedStocks({ stocks, trades, onDelete }: Props) {
  const [filter, setFilter] = useState<FilterType>('all');
  const [busy, setBusy] = useState<string | null>(null); // 작업 중인 종목명
  const [editLowIdx, setEditLowIdx] = useState<string | null>(null);
  const [editLowDraft, setEditLowDraft] = useState<{ price: number; date: string } | null>(null);

  // 보유수량 0이고, 매수 체결이 있었던 종목 = 매매완료
  const completed = stocks.filter(
    (s) => s.totalQuantity === 0 && s.buyPlans.some((bp) => bp.filled)
  );

  // 종목별 수익 계산 (현재 사이클 + 과거 사이클 합산)
  const getStats = (stock: Stock) => {
    const stockTrades = trades.filter((t) => t.stockName === stock.name);
    const buys = stockTrades.filter((t) => t.type === 'buy');
    const sells = stockTrades.filter((t) => t.type === 'sell');

    // 매수/매도 총액 (현재 buyPlans/sellPlans/maSells 기준)
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

    // 과거 사이클 합산 (cycles[])
    let cyclesBuyAmt = 0;
    let cyclesSellAmt = 0;
    let cyclesProfit = 0;
    (stock.cycles || []).forEach((c) => {
      cyclesBuyAmt += c.totalBuyAmt || 0;
      cyclesSellAmt += c.totalSellAmt || 0;
      cyclesProfit += c.realizedProfit || 0;
    });

    const avgBuyPrice = totalBuyQty > 0 ? Math.round(totalBuyAmt / totalBuyQty) : 0;
    const avgSellPrice = totalSellQty > 0 ? Math.round(totalSellAmt / totalSellQty) : 0;

    // 현재 사이클 실현수익
    const currentProfit = totalSellAmt - totalBuyAmt;
    const currentProfitPct = totalBuyAmt > 0 ? (currentProfit / totalBuyAmt) * 100 : 0;

    // 누적 실현수익 (사이클 합산)
    const cumulativeProfit = currentProfit + cyclesProfit;
    const cumulativeBuyAmt = totalBuyAmt + cyclesBuyAmt;
    const cumulativeProfitPct = cumulativeBuyAmt > 0 ? (cumulativeProfit / cumulativeBuyAmt) * 100 : 0;

    // 날짜
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

    const filledBuys = stock.buyPlans.filter((bp) => bp.filled).length;
    const filledSells = stock.sellPlans.filter((sp) => sp.filled).length +
      stock.maSells.filter((ms) => ms.filled).length;

    return {
      avgBuyPrice,
      avgSellPrice,
      totalBuyQty,
      totalSellQty,
      totalBuyAmt,
      totalSellAmt,
      profit: currentProfit,
      profitPercent: currentProfitPct,
      cumulativeProfit,
      cumulativeProfitPct,
      cyclesCount: (stock.cycles || []).length,
      firstBuyDate,
      lastSellDate,
      filledBuys,
      filledSells,
      rule: stock.rule,
    };
  };

  // 필터링
  const getStatusKey = (stock: Stock): FilterType => {
    if (!stock.reentry?.enabled) {
      return stock.reentry?.status === 'paused' ? 'paused' : 'no_tracking';
    }
    if (stock.reentry.status === 'ready') return 'ready';
    return 'tracking';
  };

  const filteredCompleted = completed.filter((s) => {
    if (filter === 'all') return true;
    return getStatusKey(s) === filter;
  });

  // 카운트
  const counts = {
    all: completed.length,
    tracking: completed.filter((s) => getStatusKey(s) === 'tracking').length,
    ready: completed.filter((s) => getStatusKey(s) === 'ready').length,
    paused: completed.filter((s) => getStatusKey(s) === 'paused').length,
    no_tracking: completed.filter((s) => getStatusKey(s) === 'no_tracking').length,
  };

  // 전체 요약 (누적)
  const totalProfit = completed.reduce((sum, s) => sum + getStats(s).cumulativeProfit, 0);
  const totalBuyAmt = completed.reduce((sum, s) => {
    const st = getStats(s);
    let cyclesBuy = 0;
    (s.cycles || []).forEach((c) => { cyclesBuy += c.totalBuyAmt || 0; });
    return sum + st.totalBuyAmt + cyclesBuy;
  }, 0);
  const totalProfitPercent = totalBuyAmt > 0 ? (totalProfit / totalBuyAmt) * 100 : 0;

  // 재진입 컨트롤 호출
  const callReentry = async (stockName: string, action: string, extra?: any) => {
    setBusy(stockName);
    try {
      const res = await fetch(REENTRY_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ stockName, action, ...extra }),
      });
      const data = await res.json();
      if (!data.success) {
        // 종목코드 누락 시 사용자에게 직접 입력 요청
        if (data.needsCode) {
          const code = prompt(
            `${stockName}의 종목코드를 입력하세요\n` +
            `(예: 356860, A356860, 또는 정확한 6자리 숫자)\n\n` +
            `${data.hint || ''}`
          );
          if (code && code.trim()) {
            // 재시도 (code 포함)
            await callReentry(stockName, action, { ...extra, code: code.trim() });
            return;
          }
          alert(`취소됨: 종목코드 없이는 재진입 추적을 시작할 수 없습니다.`);
        } else {
          alert(`실패: ${data.error}`);
        }
      }
    } catch (e: any) {
      alert(`오류: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

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
          <span className={styles.totalLabel}>총 투자금액 (누적)</span>
          <span className={styles.totalValue}>{totalBuyAmt.toLocaleString()}원</span>
        </div>
        <div className={styles.totalItem}>
          <span className={styles.totalLabel}>총 실현수익 (누적)</span>
          <span className={styles.totalValue} style={{ color: totalProfit >= 0 ? '#e53935' : '#1565c0' }}>
            {totalProfit >= 0 ? '+' : ''}{totalProfit.toLocaleString()}원
          </span>
        </div>
        <div className={styles.totalItem}>
          <span className={styles.totalLabel}>총 수익률 (누적)</span>
          <span className={styles.totalValue} style={{ color: totalProfitPercent >= 0 ? '#e53935' : '#1565c0' }}>
            {totalProfitPercent >= 0 ? '+' : ''}{totalProfitPercent.toFixed(2)}%
          </span>
        </div>
      </div>

      {/* 필터 */}
      <div className={styles.filterRow}>
        {([
          { key: 'all', label: '전체' },
          { key: 'tracking', label: '추적중' },
          { key: 'ready', label: '🔥 매수임박' },
          { key: 'paused', label: '일시중지' },
          { key: 'no_tracking', label: '추적안함' },
        ] as { key: FilterType; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            className={`${styles.filterBtn} ${filter === key ? styles.filterBtnActive : ''}`}
            onClick={() => setFilter(key)}
          >
            {label} <span className={styles.filterCount}>{counts[key]}</span>
          </button>
        ))}
      </div>

      {/* 종목 카드 */}
      <div className={styles.cardGrid}>
        {filteredCompleted.map((stock) => {
          const st = getStats(stock);
          const isProfit = st.cumulativeProfitPct >= 0;
          const r = stock.reentry;
          const isReady = r?.enabled && r?.status === 'ready';
          const isTracking = r?.enabled && r?.status === 'tracking';
          const isPaused = r?.status === 'paused';

          // 재진입 진행 계산
          let reboundPct = 0;
          if (r?.lowPrice && stock.currentPrice) {
            reboundPct = ((stock.currentPrice - r.lowPrice) / r.lowPrice) * 100;
          }
          let dropFromPeakPct = 0;
          if (r?.peakPrice && stock.currentPrice) {
            dropFromPeakPct = ((stock.currentPrice - r.peakPrice) / r.peakPrice) * 100;
          }

          return (
            <div
              key={stock.id}
              className={`${styles.card} ${isReady ? styles.cardReady : isTracking ? styles.cardTracking : ''}`}
            >
              <div className={styles.cardHeader}>
                <h3 className={styles.stockName}>
                  {stock.name}
                  {stock.code && <span className={styles.stockCode}>({stock.code})</span>}
                </h3>
                <div className={styles.headerRight}>
                  <span className={`${styles.profitBadge} ${isProfit ? styles.profitBadgeGreen : styles.profitBadgeRed}`}>
                    누적 {isProfit ? '+' : ''}{st.cumulativeProfitPct.toFixed(1)}%
                  </span>
                  <button
                    className={styles.deleteBtnInline}
                    title="종목 삭제"
                    onClick={() => {
                      if (confirm(`"${stock.name}" 종목을 삭제하시겠습니까?`)) {
                        onDelete(stock.id);
                      }
                    }}
                  >
                    🗑️
                  </button>
                </div>
              </div>

              {/* 사이클 요약 */}
              <div className={styles.cardBody}>
                <div className={styles.cycleSummary}>
                  사이클 {st.cyclesCount + 1}: 진입 {st.filledBuys}차 / 매도 {st.filledSells}회
                  {st.cyclesCount > 0 && <span className={styles.cycleBadge}>+ 과거 {st.cyclesCount}회</span>}
                  <span className={styles.metaItem}>룰{st.rule}</span>
                </div>

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
                    <span className={styles.statLabel}>이번 사이클 수익</span>
                    <span className={styles.statValue} style={{ color: st.profit >= 0 ? '#e53935' : '#1565c0' }}>
                      {st.profit >= 0 ? '+' : ''}{st.profit.toLocaleString()}
                    </span>
                  </div>
                </div>

                {(st.firstBuyDate || st.lastSellDate) && (
                  <div className={styles.metaRow}>
                    <span className={styles.metaItem}>
                      {st.firstBuyDate || '?'} ~ {st.lastSellDate || '?'}
                    </span>
                  </div>
                )}

                {/* 재진입 추적 카드 */}
                {r && (
                  <div className={`${styles.reentryCard} ${isReady ? styles.reentryReady : ''}`}>
                    <div className={styles.reentryHeader}>
                      {isReady && <span className={styles.reentryStatusReady}>🔥 매수 임박</span>}
                      {isTracking && r.rebounded && <span className={styles.reentryStatusPeak}>📈 신고점 추적</span>}
                      {isTracking && !r.rebounded && <span className={styles.reentryStatusLow}>📉 최저가 추적</span>}
                      {isPaused && <span className={styles.reentryStatusPaused}>⏸️ 일시중지</span>}
                      {stock.currentPrice > 0 && (
                        <span className={styles.reentryCurrent}>
                          현재 {stock.currentPrice.toLocaleString()}원
                        </span>
                      )}
                    </div>

                    <div className={styles.reentryGrid}>
                      <div className={styles.reentryItem}>
                        <span className={styles.reentryLabel}>최저가</span>
                        <span className={styles.reentryValue}>
                          {r.lowPrice.toLocaleString()}원
                          <span className={styles.reentrySource}>
                            {r.lowPriceSource === 'kiwoom_daily' ? '일봉' : r.lowPriceSource === 'manual' ? '수동' : '실시간'}
                          </span>
                        </span>
                        <span className={styles.reentryDate}>{r.lowPriceDate}</span>
                      </div>
                      <div className={styles.reentryItem}>
                        <span className={styles.reentryLabel}>
                          신고점 {r.rebounded && <span className={styles.reentryCheck}>✅ 반등</span>}
                        </span>
                        <span className={styles.reentryValue}>
                          {r.peakPrice.toLocaleString()}원
                        </span>
                        <span className={styles.reentryDate}>
                          {r.peakPriceDate} ({reboundPct >= 0 ? '+' : ''}{reboundPct.toFixed(0)}% from low)
                        </span>
                      </div>
                      <div className={styles.reentryItem}>
                        <span className={styles.reentryLabel}>매수 목표가</span>
                        <span className={styles.reentryValue} style={{ color: isReady ? '#e53935' : '#666' }}>
                          {r.targetPrice.toLocaleString()}원
                        </span>
                        <span className={styles.reentryDate}>peak × 0.5</span>
                      </div>
                      <div className={styles.reentryItem}>
                        <span className={styles.reentryLabel}>현재 진행</span>
                        <span className={styles.reentryValue} style={{ color: isReady ? '#e53935' : '#666' }}>
                          {dropFromPeakPct.toFixed(1)}%
                        </span>
                        <span className={styles.reentryDate}>from peak</span>
                      </div>
                    </div>

                    {isReady && (
                      <div className={styles.reentryReadyHint}>
                        ⚡ -50% 도달! 양봉 발생 시 자동으로 텔레그램 매수신호 발송됩니다.
                        {r.signalSent && r.signalDate && (
                          <span> · ✉️ {r.signalDate} 발송완료</span>
                        )}
                      </div>
                    )}

                    {/* 최저가 수정 폼 */}
                    {editLowIdx === stock.id && editLowDraft && (
                      <div className={styles.editLowForm}>
                        <input
                          type="number"
                          className={styles.editLowInput}
                          value={editLowDraft.price || ''}
                          placeholder="실제 최저가"
                          onChange={(e) => setEditLowDraft({ ...editLowDraft, price: Number(e.target.value) })}
                        />
                        <input
                          type="date"
                          className={styles.editLowInput}
                          value={editLowDraft.date}
                          onChange={(e) => setEditLowDraft({ ...editLowDraft, date: e.target.value })}
                        />
                        <button
                          className={styles.reentrySave}
                          onClick={async () => {
                            await callReentry(stock.name, 'setLow', { lowPrice: editLowDraft.price, lowPriceDate: editLowDraft.date });
                            setEditLowIdx(null);
                            setEditLowDraft(null);
                          }}
                          disabled={busy === stock.name}
                        >
                          저장
                        </button>
                        <button className={styles.reentryCancel} onClick={() => { setEditLowIdx(null); setEditLowDraft(null); }}>취소</button>
                      </div>
                    )}

                    {/* 컨트롤 버튼 */}
                    {editLowIdx !== stock.id && (
                      <div className={styles.reentryControls}>
                        {isPaused ? (
                          <button
                            className={styles.reentryBtn}
                            onClick={() => callReentry(stock.name, 'resume')}
                            disabled={busy === stock.name}
                          >▶️ 추적 재개</button>
                        ) : (
                          <button
                            className={styles.reentryBtn}
                            onClick={() => callReentry(stock.name, 'pause')}
                            disabled={busy === stock.name}
                          >⏸️ 추적 중지</button>
                        )}
                        <button
                          className={styles.reentryBtn}
                          onClick={() => {
                            if (confirm(`"${stock.name}" 추적을 리셋하시겠습니까? 현재가부터 새로 추적합니다.`)) {
                              callReentry(stock.name, 'reset');
                            }
                          }}
                          disabled={busy === stock.name}
                        >🔄 리셋</button>
                        <button
                          className={styles.reentryBtn}
                          onClick={() => {
                            setEditLowIdx(stock.id);
                            setEditLowDraft({ price: r.lowPrice, date: r.lowPriceDate });
                          }}
                        >✏️ 최저가 수정</button>
                      </div>
                    )}
                  </div>
                )}

                {/* 추적 미시작 시 시작 버튼 */}
                {!r && (
                  <div className={styles.reentryStartBox}>
                    <span className={styles.reentryStartHint}>
                      재진입 추적이 시작되지 않은 종목입니다 (회사명 변경 등으로 미감지)
                    </span>
                    <button
                      className={styles.reentryBtn}
                      onClick={() => callReentry(stock.name, 'start')}
                      disabled={busy === stock.name}
                    >🎯 재진입 추적 시작</button>
                  </div>
                )}
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}

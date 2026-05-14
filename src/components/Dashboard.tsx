import { useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import type { Stock, Trade, Snapshot } from '../types';
import styles from './Dashboard.module.css';

interface Props {
  stocks: Stock[];
  trades: Trade[];
  snapshots: Snapshot[];
}

const COLORS = ['#4caf50', '#ff9800', '#f44336', '#4a90d9', '#9c27b0'];
const SYSTEM_TAGS = new Set(['#키움동기화', '#단위의심', '키움동기화', '단위의심']);

// 키움 표준 수수료/세금 (StockDetail과 동일 기준)
const BUY_FEE_RATE = 0.00015;  // 매수 수수료 0.015%
const SELL_FEE_RATE = 0.00015; // 매도 수수료 0.015%
const SELL_TAX_RATE = 0.0020;  // 매도 거래세 0.18~0.20% (평균 0.20%)

type Period = 'all' | 'year' | 'month' | 'week';

const fmt = (n: number) => Math.round(n).toLocaleString();
const fmtSign = (n: number) => (n >= 0 ? `+${fmt(n)}` : fmt(n));
const colorOf = (n: number) => (n >= 0 ? '#4caf50' : '#f44336');

function getPeriodStart(period: Period): Date {
  const now = new Date();
  if (period === 'year') return new Date(now.getFullYear(), 0, 1);
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }
  return new Date(0);
}

export default function Dashboard({ stocks, trades, snapshots }: Props) {
  // ─── A. 수수료/세금 표시 토글 + B. 기간 필터 ───
  const [showNet, setShowNet] = useState(false);
  const [period, setPeriod] = useState<Period>('all');

  // 기간 필터 적용된 trades
  const filteredTrades = useMemo(() => {
    if (period === 'all') return trades;
    const start = getPeriodStart(period);
    return trades.filter((t) => {
      if (!t.date) return false;
      const d = new Date(t.date);
      return d >= start;
    });
  }, [trades, period]);

  // ─── 종목별 매수/매도 집계 (trades 기반 정확 계산) ───
  const perStock = useMemo(() => {
    const map: Record<
      string,
      {
        name: string;
        boughtAmt: number;
        boughtQty: number;
        soldAmt: number;
        soldQty: number;
        avgBuyPrice: number;
        realized: number;     // gross
        realizedNet: number;  // net (수수료/세금 차감)
        fees: number;
      }
    > = {};
    for (const t of filteredTrades) {
      if (!t.stockName) continue;
      const k = t.stockName;
      if (!map[k]) {
        map[k] = { name: k, boughtAmt: 0, boughtQty: 0, soldAmt: 0, soldQty: 0, avgBuyPrice: 0, realized: 0, realizedNet: 0, fees: 0 };
      }
      const price = Number(t.price) || 0;
      const qty = Number(t.quantity) || 0;
      if (qty <= 0 || price <= 0) continue;
      if (t.type === 'buy') {
        map[k].boughtAmt += price * qty;
        map[k].boughtQty += qty;
      } else if (t.type === 'sell') {
        map[k].soldAmt += price * qty;
        map[k].soldQty += qty;
      }
    }
    Object.values(map).forEach((s) => {
      s.avgBuyPrice = s.boughtQty > 0 ? s.boughtAmt / s.boughtQty : 0;
      s.realized = s.soldAmt - s.soldQty * s.avgBuyPrice;
      // 수수료/세금: 매수 0.015% + 매도 0.015% + 매도 거래세 0.20%
      const buyFee = s.boughtAmt * BUY_FEE_RATE;
      const sellFee = s.soldAmt * SELL_FEE_RATE;
      const sellTax = s.soldAmt * SELL_TAX_RATE;
      s.fees = buyFee + sellFee + sellTax;
      s.realizedNet = s.realized - s.fees;
    });
    return map;
  }, [filteredTrades]);

  // ─── 전체 KPI ───
  const kpi = useMemo(() => {
    const holdings = stocks.filter((s) => (s.totalQuantity || 0) > 0);
    const completed = stocks.filter(
      (s) => (s.totalQuantity || 0) === 0 && ((s.cycles && s.cycles.length > 0) || (s.sellPlans || []).some((p) => p.filled))
    );

    let totalBoughtAmt = 0;
    let totalRealizedGross = 0;
    let totalRealizedNet = 0;
    let totalFees = 0;
    for (const ps of Object.values(perStock)) {
      totalBoughtAmt += ps.boughtAmt;
      totalRealizedGross += ps.realized;
      totalRealizedNet += ps.realizedNet;
      totalFees += ps.fees;
    }
    const totalRealized = showNet ? totalRealizedNet : totalRealizedGross;

    let unrealized = 0;
    let holdingMarketValue = 0;
    let holdingCostBasis = 0;
    for (const s of holdings) {
      const avg = Number(s.avgPrice) || 0;
      const cur = Number(s.currentPrice) || 0;
      const qty = Number(s.totalQuantity) || 0;
      if (avg > 0 && qty > 0) {
        unrealized += (cur - avg) * qty;
        holdingMarketValue += cur * qty;
        holdingCostBasis += avg * qty;
      }
    }

    const realizedPct = totalBoughtAmt > 0 ? (totalRealized / totalBoughtAmt) * 100 : 0;
    const unrealizedPct = holdingCostBasis > 0 ? (unrealized / holdingCostBasis) * 100 : 0;

    return {
      holdingCount: holdings.length,
      completedCount: completed.length,
      totalCount: stocks.length,
      totalBoughtAmt,
      totalRealized,
      totalRealizedGross,
      totalRealizedNet,
      totalFees,
      realizedPct,
      unrealized,
      unrealizedPct,
      holdingMarketValue,
      holdingCostBasis,
    };
  }, [stocks, perStock, showNet]);

  // ─── D. 매수 trade 누락 경고 (감자/합병 보정 이력 있는 종목은 정상으로 간주, 제외) ───
  const stocksWithCorporateActions = useMemo(() => {
    const set = new Set<string>();
    for (const s of stocks) {
      if (Array.isArray(s.corporateActions) && s.corporateActions.length > 0) {
        set.add(s.name);
      }
    }
    return set;
  }, [stocks]);

  const missingBuyStocks = useMemo(() => {
    const issues: { name: string; boughtQty: number; soldQty: number; gap: number; soldAmt: number }[] = [];
    for (const ps of Object.values(perStock)) {
      if (ps.soldQty > 0 && ps.boughtQty < ps.soldQty) {
        // 감자/합병 보정 이력이 있는 종목은 정상 가능성 → 경고에서 제외
        if (stocksWithCorporateActions.has(ps.name)) continue;
        issues.push({
          name: ps.name,
          boughtQty: ps.boughtQty,
          soldQty: ps.soldQty,
          gap: ps.soldQty - ps.boughtQty,
          soldAmt: ps.soldAmt,
        });
      }
    }
    return issues.sort((a, b) => b.gap - a.gap);
  }, [perStock, stocksWithCorporateActions]);

  // ─── 월별 실현손익 (전체 trades 기준, 기간 필터 무시) ───
  const monthlyRealized = useMemo(() => {
    // 1) 전체 기간 stock별 평균 매수단가 계산
    const stockBoughtAmt: Record<string, number> = {};
    const stockBoughtQty: Record<string, number> = {};
    for (const t of trades) {
      if (t.type !== 'buy' || !t.stockName) continue;
      const price = Number(t.price) || 0;
      const qty = Number(t.quantity) || 0;
      if (price <= 0 || qty <= 0) continue;
      stockBoughtAmt[t.stockName] = (stockBoughtAmt[t.stockName] || 0) + price * qty;
      stockBoughtQty[t.stockName] = (stockBoughtQty[t.stockName] || 0) + qty;
    }
    const stockAvgBuy: Record<string, number> = {};
    for (const name of Object.keys(stockBoughtAmt)) {
      const q = stockBoughtQty[name];
      stockAvgBuy[name] = q > 0 ? stockBoughtAmt[name] / q : 0;
    }
    // 2) 월별 sell trade 집계
    const monthMap: Record<string, { month: string; gross: number; net: number }> = {};
    for (const t of trades) {
      if (t.type !== 'sell' || !t.stockName || !t.date) continue;
      const m = t.date.slice(0, 7);
      const price = Number(t.price) || 0;
      const qty = Number(t.quantity) || 0;
      const avgBuy = stockAvgBuy[t.stockName] || 0;
      if (avgBuy <= 0 || qty <= 0 || price <= 0) continue;
      const gross = (price - avgBuy) * qty;
      const sellAmt = price * qty;
      const fees = avgBuy * qty * BUY_FEE_RATE + sellAmt * (SELL_FEE_RATE + SELL_TAX_RATE);
      const net = gross - fees;
      if (!monthMap[m]) monthMap[m] = { month: m, gross: 0, net: 0 };
      monthMap[m].gross += gross;
      monthMap[m].net += net;
    }
    return Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));
  }, [trades]);

  // ─── 종목별 손익% (보유 종목만) ───
  const profitData = useMemo(
    () =>
      stocks
        .filter((s) => (s.totalQuantity || 0) > 0 && (s.avgPrice || 0) > 0 && (s.currentPrice || 0) > 0)
        .map((s) => ({
          name: s.name,
          profit: Number((((s.currentPrice - s.avgPrice) / s.avgPrice) * 100).toFixed(2)),
        }))
        .sort((a, b) => b.profit - a.profit),
    [stocks]
  );

  // ─── TOP3 수익 / TOP3 손실 (보유 종목 기준) ───
  const topGainers = useMemo(() => profitData.slice(0, 3), [profitData]);
  const topLosers = useMemo(() => [...profitData].reverse().slice(0, 3), [profitData]);

  // ─── 월별 매수/매도 횟수 (전체 기간 — 추세 시각화용) ───
  const monthlyTrades = useMemo(() => {
    const monthMap: Record<string, { month: string; buy: number; sell: number; buyAmt: number; sellAmt: number }> = {};
    for (const t of trades) {
      if (!t.date) continue;
      const m = t.date.slice(0, 7); // YYYY-MM
      if (!monthMap[m]) monthMap[m] = { month: m, buy: 0, sell: 0, buyAmt: 0, sellAmt: 0 };
      const price = Number(t.price) || 0;
      const qty = Number(t.quantity) || 0;
      if (t.type === 'buy') {
        monthMap[m].buy += 1;
        monthMap[m].buyAmt += price * qty;
      } else if (t.type === 'sell') {
        monthMap[m].sell += 1;
        monthMap[m].sellAmt += price * qty;
      }
    }
    return Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));
  }, [trades]);

  // ─── 차수별 진입 분포 (보유 종목만) ───
  const buyStageData = useMemo(() => {
    const counts = [0, 0, 0, 0, 0];
    stocks
      .filter((s) => (s.totalQuantity || 0) > 0)
      .forEach((s) => {
        const filled = (s.buyPlans || []).filter((b) => b.filled).length;
        if (filled > 0 && filled <= 5) counts[filled - 1]++;
      });
    return counts.map((value, i) => ({ name: `${i + 1}차`, value }));
  }, [stocks]);

  // ─── 매수 차수별 매도 성공률 (보유 + 매매완료 사이클 통합) ───
  // 정의: N차까지 매수 도달한 종목/사이클 중에서 매도 1회 이상 발생한 비율
  const buyLevelSuccess = useMemo(() => {
    const reached = [0, 0, 0, 0, 0]; // N차 이상 매수
    const sold = [0, 0, 0, 0, 0]; // 그 중 매도 1회+
    const consider = (buyPlans: any[], sellPlans: any[], maSells: any[]) => {
      const filled = (buyPlans || []).filter((b) => b.filled).length;
      const hasSell = (sellPlans || []).some((p) => p.filled) || (maSells || []).some((m) => m.filled);
      for (let i = 0; i < filled && i < 5; i++) {
        reached[i]++;
        if (hasSell) sold[i]++;
      }
    };
    for (const s of stocks) {
      consider(s.buyPlans, s.sellPlans, s.maSells);
      for (const c of s.cycles || []) consider(c.buyPlans, c.sellPlans, c.maSells);
    }
    return reached.map((r, i) => ({
      name: `${i + 1}차+`,
      rate: r > 0 ? Number(((sold[i] / r) * 100).toFixed(1)) : 0,
      sample: r,
    }));
  }, [stocks]);

  // ─── 매도 분류: 수익% 매도 vs MA 매도 (보유+사이클 통합) ───
  const sellTypeData = useMemo(() => {
    let profitSell = 0;
    let maSell = 0;
    for (const s of stocks) {
      profitSell += (s.sellPlans || []).filter((p) => p.filled).length;
      maSell += (s.maSells || []).filter((m) => m.filled).length;
      for (const c of s.cycles || []) {
        profitSell += (c.sellPlans || []).filter((p) => p.filled).length;
        maSell += (c.maSells || []).filter((m) => m.filled).length;
      }
    }
    const total = profitSell + maSell;
    return [
      { name: '수익% 매도', value: profitSell, pct: total > 0 ? ((profitSell / total) * 100).toFixed(1) : '0' },
      { name: 'MA 매도', value: maSell, pct: total > 0 ? ((maSell / total) * 100).toFixed(1) : '0' },
    ];
  }, [stocks]);

  // ─── 매매 사이클 분석 ───
  const cycleStats = useMemo(() => {
    const all: { profitPercent: number; days: number; cycleNo: number; stockName: string }[] = [];
    for (const s of stocks) {
      for (const c of s.cycles || []) {
        const start = c.startDate ? new Date(c.startDate).getTime() : 0;
        const end = c.endDate ? new Date(c.endDate).getTime() : 0;
        const days = start && end ? Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24))) : 0;
        all.push({ profitPercent: c.profitPercent || 0, days, cycleNo: c.cycleNo, stockName: s.name });
      }
    }
    if (all.length === 0) {
      return { count: 0, avgProfit: 0, avgDays: 0, bestProfit: 0, worstProfit: 0 };
    }
    const sum = all.reduce((a, b) => a + b.profitPercent, 0);
    const dayss = all.reduce((a, b) => a + b.days, 0);
    return {
      count: all.length,
      avgProfit: sum / all.length,
      avgDays: dayss / all.length,
      bestProfit: Math.max(...all.map((c) => c.profitPercent)),
      worstProfit: Math.min(...all.map((c) => c.profitPercent)),
    };
  }, [stocks]);

  // ─── 매매 패턴 분석 ───
  const ruleACount = stocks.filter((s) => s.rule === 'A').length;
  const ruleBCount = stocks.filter((s) => s.rule === 'B').length;

  // ─── 태그 통계 (시스템 태그 제외) ───
  const topTags = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of trades) {
      for (const tag of t.tags || []) {
        const norm = tag.startsWith('#') ? tag.slice(1) : tag;
        if (SYSTEM_TAGS.has(tag) || SYSTEM_TAGS.has(norm)) continue;
        counts[norm] = (counts[norm] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8);
  }, [trades]);

  // snapshots는 deprecated이지만 backward-compat용으로 유지 (사용 안 함)
  void snapshots;

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>통계 대시보드</h2>

      {/* 기간 필터 + Net/Gross 토글 */}
      <div className={styles.controlsRow}>
        <div className={styles.periodTabs}>
          {([
            { key: 'all', label: '전체' },
            { key: 'year', label: '올해' },
            { key: 'month', label: '이번달' },
            { key: 'week', label: '최근 7일' },
          ] as { key: Period; label: string }[]).map((p) => (
            <button
              key={p.key}
              className={`${styles.periodTab} ${period === p.key ? styles.periodTabActive : ''}`}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className={styles.netToggle} title="키움 표준 수수료 0.015% + 매도 거래세 0.20% 차감">
          <input
            type="checkbox"
            checked={showNet}
            onChange={(e) => setShowNet(e.target.checked)}
          />
          수수료/세금 반영 (Net)
        </label>
      </div>

      {/* D. 매수 trade 누락 경고 */}
      {missingBuyStocks.length > 0 && (
        <div className={styles.warningCard}>
          <h3 className={styles.warningTitle}>⚠️ 매수 trade 누락 경고 ({missingBuyStocks.length}건)</h3>
          <p className={styles.warningHint}>
            매도수량 &gt; 매수수량인 종목입니다. 실현손익이 과대계상될 수 있어요. 종목 상세에서 매수 trade를 보강하거나 수동 입력해주세요.
          </p>
          <ul className={styles.warningList}>
            {missingBuyStocks.slice(0, 10).map((s) => (
              <li key={s.name} className={styles.warningItem}>
                <span className={styles.warningName}>{s.name}</span>
                <span className={styles.warningDetail}>
                  매수 {s.boughtQty.toLocaleString()}주 / 매도 {s.soldQty.toLocaleString()}주
                  <span className={styles.warningGap}> · 누락 {s.gap.toLocaleString()}주</span>
                </span>
              </li>
            ))}
            {missingBuyStocks.length > 10 && (
              <li className={styles.warningMore}>...외 {missingBuyStocks.length - 10}건</li>
            )}
          </ul>
        </div>
      )}

      {/* KPI */}
      <div className={styles.kpiGrid}>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>보유 종목 / 매매완료</span>
          <span className={styles.kpiValue}>
            {kpi.holdingCount} / <span style={{ color: '#888', fontSize: 18 }}>{kpi.completedCount}</span>
          </span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>평가손익 (보유)</span>
          <span className={styles.kpiValue} style={{ color: colorOf(kpi.unrealized) }}>
            {fmtSign(kpi.unrealized)}원
          </span>
          <span className={styles.kpiSub} style={{ color: colorOf(kpi.unrealizedPct) }}>
            {kpi.unrealizedPct >= 0 ? '+' : ''}
            {kpi.unrealizedPct.toFixed(2)}%
          </span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>
            실현손익 {period === 'all' ? '(누적)' : period === 'year' ? '(올해)' : period === 'month' ? '(이번달)' : '(최근 7일)'}
            <span className={styles.kpiBadge}>{showNet ? 'Net' : 'Gross'}</span>
          </span>
          <span className={styles.kpiValue} style={{ color: colorOf(kpi.totalRealized) }}>
            {fmtSign(kpi.totalRealized)}원
          </span>
          <span className={styles.kpiSub} style={{ color: colorOf(kpi.realizedPct) }}>
            {kpi.realizedPct >= 0 ? '+' : ''}
            {kpi.realizedPct.toFixed(2)}%
            {showNet && kpi.totalFees > 0 && (
              <span className={styles.kpiFeeNote}> · 차감 −{fmt(kpi.totalFees)}원</span>
            )}
          </span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>총 매수금액</span>
          <span className={styles.kpiValue} style={{ color: '#333' }}>
            {fmt(kpi.totalBoughtAmt)}원
          </span>
          <span className={styles.kpiSub}>보유 시가 {fmt(kpi.holdingMarketValue)}원</span>
        </div>
      </div>

      {/* TOP3 카드 */}
      {(topGainers.length > 0 || topLosers.length > 0) && (
        <div className={styles.topRow}>
          <div className={styles.chartCard}>
            <h3 className={styles.chartTitle}>🏆 수익 TOP3 (보유)</h3>
            {topGainers.length === 0 ? (
              <p className={styles.emptyHint}>보유 종목 없음</p>
            ) : (
              <ul className={styles.topList}>
                {topGainers.map((g) => (
                  <li key={g.name} className={styles.topItem}>
                    <span className={styles.topName}>{g.name}</span>
                    <span style={{ color: colorOf(g.profit), fontWeight: 700 }}>
                      {g.profit >= 0 ? '+' : ''}
                      {g.profit.toFixed(2)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={styles.chartCard}>
            <h3 className={styles.chartTitle}>📉 손실 TOP3 (보유)</h3>
            {topLosers.length === 0 ? (
              <p className={styles.emptyHint}>보유 종목 없음</p>
            ) : (
              <ul className={styles.topList}>
                {topLosers.map((g) => (
                  <li key={g.name} className={styles.topItem}>
                    <span className={styles.topName}>{g.name}</span>
                    <span style={{ color: colorOf(g.profit), fontWeight: 700 }}>
                      {g.profit >= 0 ? '+' : ''}
                      {g.profit.toFixed(2)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* 종목별 손익% */}
      {profitData.length > 0 && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>종목별 현재 손익% (보유)</h3>
          <ResponsiveContainer width="100%" height={Math.max(250, profitData.length * 30)}>
            <BarChart data={profitData} layout="vertical" margin={{ left: 60 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" fontSize={12} tickFormatter={(v) => `${v}%`} />
              <YAxis type="category" dataKey="name" fontSize={11} width={80} />
              <Tooltip formatter={(v) => [`${Number(v).toFixed(2)}%`, '손익']} />
              <Bar dataKey="profit">
                {profitData.map((entry, i) => (
                  <Cell key={i} fill={entry.profit >= 0 ? '#4caf50' : '#f44336'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 월별 매매 횟수 */}
      {monthlyTrades.length > 0 && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>월별 매매 횟수</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={monthlyTrades}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" fontSize={11} />
              <YAxis fontSize={12} />
              <Tooltip
                formatter={(v, name) => [`${v}건`, name === 'buy' ? '매수' : '매도']}
              />
              <Legend formatter={(v) => (v === 'buy' ? '매수' : '매도')} />
              <Bar dataKey="buy" fill="#4a90d9" />
              <Bar dataKey="sell" fill="#ff9800" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* B. 월별 실현손익 (전체 기간, gross/net 토글 반영) */}
      {monthlyRealized.length > 0 && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>
            월별 실현손익
            <span className={styles.kpiBadge}>{showNet ? 'Net' : 'Gross'}</span>
          </h3>
          <p className={styles.chartHint}>
            매도 trade를 월별로 집계 · 종목별 전체 기간 평균매수가 기준
            {showNet && ' · 수수료/세금 차감'}
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={monthlyRealized}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" fontSize={11} />
              <YAxis
                fontSize={12}
                tickFormatter={(v) => `${(v / 10000).toFixed(0)}만`}
              />
              <Tooltip
                formatter={(v: any) => [`${fmtSign(Number(v))}원`, showNet ? 'Net 실현손익' : 'Gross 실현손익']}
              />
              <Bar dataKey={showNet ? 'net' : 'gross'}>
                {monthlyRealized.map((entry, i) => {
                  const v = showNet ? entry.net : entry.gross;
                  return <Cell key={i} fill={v >= 0 ? '#4caf50' : '#f44336'} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 차수별 진입 분포 */}
      {buyStageData.some((d) => d.value > 0) && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>차수별 진입 분포 (보유)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={buyStageData.filter((d) => d.value > 0)}
                cx="50%"
                cy="50%"
                outerRadius={80}
                dataKey="value"
                label={(entry) => `${entry.name}: ${entry.value}`}
              >
                {buyStageData
                  .filter((d) => d.value > 0)
                  .map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
              </Pie>
              <Legend />
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 매수 차수별 매도 성공률 */}
      {buyLevelSuccess.some((d) => d.sample > 0) && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>매수 차수별 매도 진입률</h3>
          <p className={styles.chartHint}>
            N차까지 매수한 종목/사이클 중 매도(수익% 또는 MA) 1회 이상 발생한 비율
          </p>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={buyLevelSuccess}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" fontSize={12} />
              <YAxis fontSize={12} tickFormatter={(v) => `${v}%`} domain={[0, 100]} />
              <Tooltip
                formatter={(v: any, _n, p: any) =>
                  [`${v}% (표본 ${p.payload.sample}건)`, '매도 진입률']
                }
              />
              <Bar dataKey="rate" fill="#4a90d9" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 매도 분류 (수익% vs MA) */}
      {sellTypeData[0].value + sellTypeData[1].value > 0 && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>매도 유형 분포</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={sellTypeData}
                cx="50%"
                cy="50%"
                outerRadius={80}
                dataKey="value"
                label={(entry: any) => `${entry.name}: ${entry.value}건 (${entry.pct}%)`}
              >
                <Cell fill="#4caf50" />
                <Cell fill="#9c27b0" />
              </Pie>
              <Legend />
              <Tooltip formatter={(v) => `${v}건`} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 매매 사이클 분석 */}
      {cycleStats.count > 0 && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>매매 사이클 분석</h3>
          <p className={styles.chartHint}>매매완료(전량매도) 후 영구 보관된 사이클 기준</p>
          <div className={styles.patternGrid}>
            <div className={styles.patternItem}>
              <span className={styles.patternLabel}>완료 사이클</span>
              <span className={styles.patternValue}>{cycleStats.count}회</span>
            </div>
            <div className={styles.patternItem}>
              <span className={styles.patternLabel}>평균 수익률</span>
              <span className={styles.patternValue} style={{ color: colorOf(cycleStats.avgProfit) }}>
                {cycleStats.avgProfit >= 0 ? '+' : ''}
                {cycleStats.avgProfit.toFixed(2)}%
              </span>
            </div>
            <div className={styles.patternItem}>
              <span className={styles.patternLabel}>평균 보유일</span>
              <span className={styles.patternValue}>{cycleStats.avgDays.toFixed(0)}일</span>
            </div>
            <div className={styles.patternItem}>
              <span className={styles.patternLabel}>최고 수익률</span>
              <span className={styles.patternValue} style={{ color: '#4caf50' }}>
                +{cycleStats.bestProfit.toFixed(2)}%
              </span>
            </div>
            <div className={styles.patternItem}>
              <span className={styles.patternLabel}>최저 수익률</span>
              <span className={styles.patternValue} style={{ color: colorOf(cycleStats.worstProfit) }}>
                {cycleStats.worstProfit >= 0 ? '+' : ''}
                {cycleStats.worstProfit.toFixed(2)}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 매매 패턴 분석 */}
      <div className={styles.chartCard}>
        <h3 className={styles.chartTitle}>매매 패턴 분석</h3>
        <div className={styles.patternGrid}>
          <div className={styles.patternItem} title="룰A: 매수가 대비 -10% / 룰B: 저점 대비 -10%">
            <span className={styles.patternLabel}>룰A / 룰B</span>
            <span className={styles.patternValue}>
              {ruleACount} / {ruleBCount}
            </span>
          </div>
          <div className={styles.patternItem}>
            <span className={styles.patternLabel}>총 매매 일지</span>
            <span className={styles.patternValue}>{trades.length}건</span>
          </div>
          <div className={styles.patternItem}>
            <span className={styles.patternLabel}>매수 / 매도 / 관찰</span>
            <span className={styles.patternValue}>
              {trades.filter((t) => t.type === 'buy').length} /{' '}
              {trades.filter((t) => t.type === 'sell').length} /{' '}
              {trades.filter((t) => t.type === 'watch').length}
            </span>
          </div>
        </div>
        {topTags.length > 0 && (
          <div className={styles.tagSection}>
            <span className={styles.patternLabel}>자주 사용한 태그 (사용자 태그만)</span>
            <div className={styles.tagList}>
              {topTags.map(([tag, count]) => (
                <span key={tag} className={styles.tagBadge}>
                  #{tag} ({count})
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

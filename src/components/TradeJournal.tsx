import { useState, useMemo } from 'react';
import type { Trade, Stock } from '../types';
import styles from './TradeJournal.module.css';

interface Props {
  trades: Trade[];
  stocks: Stock[];
  onAdd: (trade: Omit<Trade, 'id' | 'createdAt'>) => void;
  onUpdate: (trade: Trade) => void;
  onDelete: (id: string) => void;
}

const today = new Date().toISOString().slice(0, 10);

// ── 타입 정의 ────────────────────────────────────────────────
type TypeFilter = 'all' | 'buy' | 'sell' | 'watch';
type PeriodFilter = 'all' | '1m' | '3m' | '6m' | '1y';
type PnLFilter = 'all' | 'profit' | 'loss';

interface TradeContext {
  planLevel: number;       // buyPlans/sellPlans 차수 (계획 차수 - 날짜 그룹 기준)
  tradeOrder: number;      // 종목의 N번째 매수/매도 거래 (참고용)
  exceedsPlan: boolean;    // 계획 차수 초과 (예: 6번째 날짜인데 계획은 5차까지)
  qtyBefore: number;
  qtyAfter: number;
  avgBefore: number;
  avgAfter: number;
  realizedPnL?: number;    // 매도 시 실현 손익 (수수료/세금 차감 포함)
  pnlPercent?: number;     // 매도 시 수익률
  fees?: number;           // 매도 시 차감된 수수료/세금
  isEstimated?: boolean;   // 매수 이력 부족으로 stock.avgPrice 사용한 추정값
  estimatedReason?: string; // 추정 사유
  isKiwoom: boolean;
  // Fix 4: 계획가 대비
  planPrice?: number;      // 매칭된 계획 차수의 가격
  planGap?: number;        // (실제가 - 계획가) / 계획가 * 100
  // Fix 2: 검증 - 종목 단위로 묶음
  stockVerifyStatus?: 'match' | 'mismatch' | 'estimated' | 'no-stock';
}

interface StockVerification {
  stockName: string;
  hasStock: boolean;
  expectedQty: number;     // stock.totalQuantity
  computedQty: number;     // trades 기반 누적
  qtyMatch: boolean;
  expectedAvg: number;     // stock.avgPrice
  computedAvg: number;     // trades 기반 누적
  avgMatch: boolean;
  qtyDiff: number;
  avgDiffPct: number;
  hasEstimated: boolean;
  status: 'match' | 'mismatch' | 'estimated' | 'no-stock';
  mismatchReason?: 'qty' | 'avg' | 'both';   // 불일치 원인 분류
  missingBuyQty?: number;                     // 매도 시 매수 이력 부족 수량
}

// 한국 주식 매도 비용: 거래세 0.18% + 증권사 수수료 약 0.015% = 약 0.195%
const FEE_RATE = 0.00195;
const QTY_TOLERANCE = 0;        // 수량은 정확 일치 요구
const AVG_TOLERANCE_PCT = 1;    // 평단은 1% 이내 오차 허용

// ── 트레이드별 문맥 계산 ─────────────────────────────────────
// 종목별로 시간순 정렬 후 누적 평단/보유/손익 계산
// 차수는 buyPlans/sellPlans와 날짜 그룹으로 매칭 (StockDetail과 동일 로직)
function computeContexts(
  trades: Trade[],
  stocks: Stock[],
  applyFees: boolean,
): { contexts: Map<string, TradeContext>; verifications: Map<string, StockVerification> } {
  const map = new Map<string, TradeContext>();
  const verifications = new Map<string, StockVerification>();
  const byStock: Record<string, Trade[]> = {};

  for (const t of trades) {
    if (!byStock[t.stockName]) byStock[t.stockName] = [];
    byStock[t.stockName].push(t);
  }

  Object.entries(byStock).forEach(([stockName, list]) => {
    const stock = stocks.find((s) => s.name === stockName);
    const stockAvg = stock?.avgPrice || 0;
    const buyPlans = stock?.buyPlans || [];
    const sellPlans = stock?.sellPlans || [];

    // 시간순 (오래된 것 → 최신)
    const sorted = [...list].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    // 차수 매칭: StockDetail과 동일하게 날짜별 그룹 기준
    // 같은 날 매수는 같은 차수, 새 날짜는 다음 차수
    const buyDateOrder: string[] = [];
    const sellDateOrder: string[] = [];
    sorted.forEach((t) => {
      if (t.type === 'buy' && !buyDateOrder.includes(t.date)) buyDateOrder.push(t.date);
      if (t.type === 'sell' && !sellDateOrder.includes(t.date)) sellDateOrder.push(t.date);
    });
    const dateToBuyPlanLevel: Record<string, number> = {};
    buyDateOrder.forEach((d, i) => (dateToBuyPlanLevel[d] = i + 1));
    const dateToSellPlanLevel: Record<string, number> = {};
    sellDateOrder.forEach((d, i) => (dateToSellPlanLevel[d] = i + 1));

    let avg = 0;
    let qty = 0;
    let buyCount = 0;
    let sellCount = 0;
    let stockHasEstimated = false;
    let totalMissingBuyQty = 0;  // 매도 시 매수 이력 부족 누적량

    for (const t of sorted) {
      const isKiwoom = t.id.startsWith('trade_kiwoom_');
      if (t.type === 'buy') {
        buyCount += 1;
        const prevAvg = avg;
        const prevQty = qty;
        const newQty = qty + t.quantity;
        const newAvg = newQty > 0 ? (avg * qty + t.price * t.quantity) / newQty : 0;
        avg = newAvg;
        qty = newQty;

        // 차수 매칭 (날짜 그룹 기준)
        const planLevel = dateToBuyPlanLevel[t.date] || 0;
        const exceedsPlan = buyPlans.length > 0 && planLevel > buyPlans.length;
        const matchedPlan = !exceedsPlan && planLevel > 0 ? buyPlans[planLevel - 1] : undefined;
        const planPrice = matchedPlan?.price;
        const planGap = planPrice && planPrice > 0
          ? ((t.price - planPrice) / planPrice) * 100
          : undefined;

        map.set(t.id, {
          planLevel,
          tradeOrder: buyCount,
          exceedsPlan,
          qtyBefore: prevQty,
          qtyAfter: qty,
          avgBefore: prevAvg,
          avgAfter: avg,
          planPrice,
          planGap,
          isKiwoom,
        });
      } else if (t.type === 'sell') {
        sellCount += 1;
        const prevQty = qty;
        const prevAvg = avg;

        // 평단 결정: 매수 이력이 충분하면 자체 계산 평단, 부족하면 stock.avgPrice
        let useAvg: number;
        let isEstimated = false;
        let estimatedReason: string | undefined;
        let pnl: number | undefined;
        let pnlPct: number | undefined;
        let fees: number | undefined;

        const fullCost = t.price * t.quantity;
        const calcFees = applyFees ? fullCost * FEE_RATE : 0;

        if (qty >= t.quantity && avg > 0) {
          // 매수 이력 충분 — 자체 계산 평단 사용
          useAvg = avg;
          pnl = (t.price - useAvg) * t.quantity - calcFees;
          pnlPct = ((t.price - useAvg) / useAvg) * 100;
          fees = applyFees ? calcFees : undefined;
        } else if (qty > 0 && avg > 0) {
          // 매수 이력 일부 있음 — 부분 추정 (보유분은 실제 평단, 초과분은 종목 평단)
          const knownPnl = (t.price - avg) * qty - (applyFees ? t.price * qty * FEE_RATE : 0);
          const shortQty = t.quantity - qty;
          const fallbackAvg = stockAvg > 0 ? stockAvg : avg;
          const unknownPnl = (t.price - fallbackAvg) * shortQty - (applyFees ? t.price * shortQty * FEE_RATE : 0);
          useAvg = avg;
          pnl = knownPnl + unknownPnl;
          pnlPct = ((t.price - avg) / avg) * 100;  // 알려진 평단 기준
          fees = applyFees ? calcFees : undefined;
          isEstimated = true;
          stockHasEstimated = true;
          totalMissingBuyQty += shortQty;
          estimatedReason = `매수 이력 부족(보유 ${qty}주 / 매도 ${t.quantity}주) — 초과분 ${shortQty}주는 종목 평단 사용`;
        } else if (stockAvg > 0) {
          // 매수 이력 전무 — stock.avgPrice 전체 사용
          useAvg = stockAvg;
          isEstimated = true;
          stockHasEstimated = true;
          totalMissingBuyQty += t.quantity;
          estimatedReason = `매수 기록 없음 — 종목 평단(${stockAvg.toLocaleString()}원) 사용`;
          pnl = (t.price - useAvg) * t.quantity - calcFees;
          pnlPct = ((t.price - useAvg) / useAvg) * 100;
          fees = applyFees ? calcFees : undefined;
        } else {
          useAvg = 0;
          isEstimated = true;
          stockHasEstimated = true;
          totalMissingBuyQty += t.quantity;
          estimatedReason = '평단 데이터 없음 — 손익 계산 불가';
          pnl = undefined;
          pnlPct = undefined;
        }

        qty = Math.max(0, qty - t.quantity);

        // 매도 차수 매칭
        const planLevel = dateToSellPlanLevel[t.date] || 0;
        const exceedsPlan = sellPlans.length > 0 && planLevel > sellPlans.length;
        const matchedPlan = !exceedsPlan && planLevel > 0 ? sellPlans[planLevel - 1] : undefined;
        const planPrice = matchedPlan?.price;
        const planGap = planPrice && planPrice > 0
          ? ((t.price - planPrice) / planPrice) * 100
          : undefined;

        map.set(t.id, {
          planLevel,
          tradeOrder: sellCount,
          exceedsPlan,
          qtyBefore: prevQty,
          qtyAfter: qty,
          avgBefore: prevAvg,
          avgAfter: prevAvg,
          realizedPnL: pnl,
          pnlPercent: pnlPct,
          fees,
          isEstimated,
          estimatedReason,
          planPrice,
          planGap,
          isKiwoom,
        });
        void useAvg;
      } else {
        map.set(t.id, {
          planLevel: 0,
          tradeOrder: 0,
          exceedsPlan: false,
          qtyBefore: qty,
          qtyAfter: qty,
          avgBefore: avg,
          avgAfter: avg,
          isKiwoom,
        });
      }
    }

    // ── 검증: trades 누적 vs stock 실제값 ─────────────────────
    const expectedQty = stock?.totalQuantity || 0;
    const expectedAvg = stock?.avgPrice || 0;
    const qtyDiff = qty - expectedQty;
    const avgDiffPct = expectedAvg > 0 && expectedQty > 0
      ? Math.abs((avg - expectedAvg) / expectedAvg) * 100
      : 0;
    const qtyMatch = Math.abs(qtyDiff) <= QTY_TOLERANCE;
    // 완전 매도(expectedQty=0)이면 평단 검증 생략 — stock.avgPrice는 잔고 없을 때 의미 없음
    const avgMatch = expectedQty === 0
      ? true
      : expectedAvg > 0
        ? avgDiffPct <= AVG_TOLERANCE_PCT
        : true;
    let mismatchReason: StockVerification['mismatchReason'];
    if (!qtyMatch && !avgMatch) mismatchReason = 'both';
    else if (!qtyMatch) mismatchReason = 'qty';
    else if (!avgMatch) mismatchReason = 'avg';
    let status: StockVerification['status'];
    if (!stock) status = 'no-stock';
    else if (stockHasEstimated) status = 'estimated';
    else if (qtyMatch && avgMatch) status = 'match';
    else status = 'mismatch';

    const verification: StockVerification = {
      stockName,
      hasStock: !!stock,
      expectedQty,
      computedQty: qty,
      qtyMatch,
      expectedAvg,
      computedAvg: avg,
      avgMatch,
      qtyDiff,
      avgDiffPct,
      hasEstimated: stockHasEstimated,
      status,
      mismatchReason,
      missingBuyQty: totalMissingBuyQty > 0 ? totalMissingBuyQty : undefined,
    };
    verifications.set(stockName, verification);

    // 트레이드 컨텍스트에도 검증 상태 주입
    sorted.forEach((t) => {
      const ctx = map.get(t.id);
      if (ctx) ctx.stockVerifyStatus = status;
    });
  });

  return { contexts: map, verifications };
}

// ── 기간 필터 계산 ────────────────────────────────────────────
function isWithinPeriod(dateStr: string, period: PeriodFilter): boolean {
  if (period === 'all') return true;
  const d = new Date(dateStr);
  const now = new Date();
  const monthsAgo = new Date();
  const m = period === '1m' ? 1 : period === '3m' ? 3 : period === '6m' ? 6 : 12;
  monthsAgo.setMonth(now.getMonth() - m);
  return d >= monthsAgo;
}

// ── 숫자 포맷 ─────────────────────────────────────────────────
function fmt(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}
function fmtSigned(n: number): string {
  return (n >= 0 ? '+' : '') + Math.round(n).toLocaleString('ko-KR');
}

// ── 상대 날짜 라벨 (오늘/어제/N일전) ──────────────────────────
function relativeDateLabel(dateStr: string): string | null {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((todayStart.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return '오늘';
  if (diffDays === 1) return '어제';
  if (diffDays > 0 && diffDays <= 7) return `${diffDays}일 전`;
  if (diffDays < 0) return '미래';
  return null;
}

// ── 월별 집계 ────────────────────────────────────────────────
interface MonthSummary {
  buyCount: number;
  sellCount: number;
  watchCount: number;
  buyAmount: number;
  sellAmount: number;
  realizedPnL: number;
  estimatedPnL: number;       // 추정 매도건의 P&L 합 (전체 P&L에 포함된 값)
  estimatedSellCount: number; // 추정 매도건수
  uncalculatedCount: number;  // 평단 데이터 없어 계산 못한 건수
  totalFees: number;          // 차감된 수수료/세금 합
  winCount: number;
  lossCount: number;
}
function computeMonthSummary(list: Trade[], ctxMap: Map<string, TradeContext>): MonthSummary {
  const s: MonthSummary = {
    buyCount: 0,
    sellCount: 0,
    watchCount: 0,
    buyAmount: 0,
    sellAmount: 0,
    realizedPnL: 0,
    estimatedPnL: 0,
    estimatedSellCount: 0,
    uncalculatedCount: 0,
    totalFees: 0,
    winCount: 0,
    lossCount: 0,
  };
  for (const t of list) {
    const amt = t.price * t.quantity;
    if (t.type === 'buy') {
      s.buyCount += 1;
      s.buyAmount += amt;
    } else if (t.type === 'sell') {
      s.sellCount += 1;
      s.sellAmount += amt;
      const ctx = ctxMap.get(t.id);
      if (ctx?.realizedPnL !== undefined) {
        s.realizedPnL += ctx.realizedPnL;
        if (ctx.realizedPnL >= 0) s.winCount += 1;
        else s.lossCount += 1;
        if (ctx.isEstimated) {
          s.estimatedPnL += ctx.realizedPnL;
          s.estimatedSellCount += 1;
        }
        if (ctx.fees) s.totalFees += ctx.fees;
      } else {
        s.uncalculatedCount += 1;
      }
    } else {
      s.watchCount += 1;
    }
  }
  return s;
}

// ── 태산 체크리스트 템플릿 ───────────────────────────────────
const CHECKLIST_TEMPLATE = [
  '☐ N차 매수가 -10% 터치',
  '☐ 당일 양봉 확인',
  '☐ 거래량 증가',
  '☐ 20/60/120일선 참고',
  '☐ 시장 상황 양호',
].join('\n');

// ── 메인 컴포넌트 ─────────────────────────────────────────────
export default function TradeJournal({
  trades,
  stocks,
  onAdd,
  onUpdate,
  onDelete,
}: Props) {
  const [form, setForm] = useState({
    date: today,
    stockName: '',
    type: 'buy' as 'buy' | 'sell' | 'watch',
    price: 0,
    quantity: 0,
    memo: '',
    tagInput: '',
  });
  const [filterStock, setFilterStock] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [filterMemo, setFilterMemo] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('all');
  const [pnlFilter, setPnLFilter] = useState<PnLFilter>('all');
  const [editId, setEditId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [applyFees, setApplyFees] = useState(true);
  const [showMismatchDetail, setShowMismatchDetail] = useState(false);

  // 계산: 문맥 (평단/보유/손익) — 매수 이력 부족 시 stock.avgPrice fallback
  const { contexts: contextMap, verifications: stockVerifications } = useMemo(
    () => computeContexts(trades, stocks, applyFees),
    [trades, stocks, applyFees],
  );

  // 기존 태그 목록 추출 (자동완성용)
  const allTags = useMemo(() => {
    const counter: Record<string, number> = {};
    trades.forEach((t) => t.tags.forEach((tag) => (counter[tag] = (counter[tag] || 0) + 1)));
    return Object.entries(counter)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [trades]);

  const handleSubmit = () => {
    if (!form.stockName.trim()) return;
    const tags = form.tagInput
      .split(/[\s,]+/)
      .filter((t) => t.startsWith('#'))
      .map((t) => t.replace('#', ''));

    if (editId) {
      const original = trades.find((t) => t.id === editId);
      if (original) {
        onUpdate({
          ...original,
          date: form.date,
          stockName: form.stockName,
          type: form.type,
          price: form.price,
          quantity: form.quantity,
          memo: form.memo,
          tags,
        });
      }
      setEditId(null);
    } else {
      onAdd({
        date: form.date,
        stockName: form.stockName,
        type: form.type,
        price: form.price,
        quantity: form.quantity,
        memo: form.memo,
        tags,
      });
    }
    setForm({
      date: today,
      stockName: '',
      type: 'buy',
      price: 0,
      quantity: 0,
      memo: '',
      tagInput: '',
    });
    setFormOpen(false);
  };

  const startEdit = (trade: Trade) => {
    setEditId(trade.id);
    setForm({
      date: trade.date,
      stockName: trade.stockName,
      type: trade.type,
      price: trade.price,
      quantity: trade.quantity,
      memo: trade.memo,
      tagInput: trade.tags.map((t) => `#${t}`).join(' '),
    });
    setFormOpen(true);
  };

  const cancelEdit = () => {
    setEditId(null);
    setForm({
      date: today,
      stockName: '',
      type: 'buy',
      price: 0,
      quantity: 0,
      memo: '',
      tagInput: '',
    });
    setFormOpen(false);
  };

  const appendTemplate = () => {
    setForm((f) => ({ ...f, memo: f.memo ? f.memo + '\n' + CHECKLIST_TEMPLATE : CHECKLIST_TEMPLATE }));
  };

  const addTagChip = (tag: string) => {
    const current = form.tagInput;
    const has = current.includes(`#${tag}`);
    if (has) return;
    setForm((f) => ({ ...f, tagInput: (f.tagInput ? f.tagInput + ' ' : '') + `#${tag}` }));
  };

  // ── 필터링 ────────────────────────────────────────────────
  let filtered = trades;
  if (typeFilter !== 'all') {
    filtered = filtered.filter((t) => t.type === typeFilter);
  }
  if (periodFilter !== 'all') {
    filtered = filtered.filter((t) => isWithinPeriod(t.date, periodFilter));
  }
  if (filterStock) {
    filtered = filtered.filter((t) => t.stockName.includes(filterStock));
  }
  if (filterTag) {
    const k = filterTag.replace('#', '').toLowerCase();
    filtered = filtered.filter((t) => t.tags.some((tag) => tag.toLowerCase().includes(k)));
  }
  if (filterMemo) {
    const k = filterMemo.toLowerCase();
    filtered = filtered.filter((t) => (t.memo || '').toLowerCase().includes(k));
  }
  if (pnlFilter !== 'all') {
    filtered = filtered.filter((t) => {
      const ctx = contextMap.get(t.id);
      if (!ctx || ctx.realizedPnL === undefined) return false;
      return pnlFilter === 'profit' ? ctx.realizedPnL >= 0 : ctx.realizedPnL < 0;
    });
  }

  // 월별 그룹
  const grouped: Record<string, Trade[]> = {};
  filtered.forEach((t) => {
    const month = t.date.slice(0, 7);
    if (!grouped[month]) grouped[month] = [];
    grouped[month].push(t);
  });

  const typeLabel = { buy: '매수', sell: '매도', watch: '관찰' };
  const typeColorClass = {
    buy: styles.typeBuy,
    sell: styles.typeSell,
    watch: styles.typeWatch,
  };

  // 전체 기간 요약 (필터 반영) + 전체 누적 (필터 무관)
  const totalSummary = useMemo(() => {
    return computeMonthSummary(filtered, contextMap);
  }, [filtered, contextMap]);

  const grandTotal = useMemo(() => {
    return computeMonthSummary(trades, contextMap);
  }, [trades, contextMap]);

  // 검증 집계: 종목별 상태 카운트
  const verifySummary = useMemo(() => {
    let match = 0,
      mismatch = 0,
      estimated = 0,
      noStock = 0;
    const mismatchList: StockVerification[] = [];
    stockVerifications.forEach((v) => {
      if (v.status === 'match') match += 1;
      else if (v.status === 'mismatch') {
        mismatch += 1;
        mismatchList.push(v);
      } else if (v.status === 'estimated') estimated += 1;
      else noStock += 1;
    });
    return { match, mismatch, estimated, noStock, mismatchList };
  }, [stockVerifications]);

  const hasActiveFilter =
    typeFilter !== 'all' ||
    periodFilter !== 'all' ||
    pnlFilter !== 'all' ||
    filterStock !== '' ||
    filterTag !== '' ||
    filterMemo !== '';

  const clearFilters = () => {
    setTypeFilter('all');
    setPeriodFilter('all');
    setPnLFilter('all');
    setFilterStock('');
    setFilterTag('');
    setFilterMemo('');
  };

  return (
    <div className={styles.container}>
      <div className={styles.titleRow}>
        <h2 className={styles.title}>매매 일지</h2>
        <button
          className={`${styles.newBtn} ${formOpen ? styles.newBtnActive : ''}`}
          onClick={() => (editId ? cancelEdit() : setFormOpen((v) => !v))}
        >
          {formOpen ? (editId ? '✕ 편집 취소' : '− 접기') : '＋ 새 일지 작성'}
        </button>
      </div>

      {/* 전체 요약 카드 */}
      <div className={styles.summaryBar}>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>매수</span>
          <span className={`${styles.summaryValue} ${styles.buyColor}`}>{totalSummary.buyCount}건</span>
          <span className={styles.summarySub}>{fmt(totalSummary.buyAmount)}원</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>매도</span>
          <span className={`${styles.summaryValue} ${styles.sellColor}`}>{totalSummary.sellCount}건</span>
          <span className={styles.summarySub}>{fmt(totalSummary.sellAmount)}원</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>
            실현손익 {hasActiveFilter && <span className={styles.filterTag}>필터</span>}
          </span>
          <span
            className={`${styles.summaryValue} ${
              totalSummary.realizedPnL >= 0 ? styles.buyColor : styles.sellColor
            }`}
          >
            {fmtSigned(totalSummary.realizedPnL)}원
          </span>
          <span className={styles.summarySub}>
            승 {totalSummary.winCount} / 패 {totalSummary.lossCount}
            {totalSummary.estimatedSellCount > 0 && (
              <span className={styles.estimatedNote} title="매수 이력 부족 종목은 종목 평단으로 추정 계산">
                {' '}⚠️ 추정 {totalSummary.estimatedSellCount}건
              </span>
            )}
          </span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>전체 누적</span>
          <span
            className={`${styles.summaryValue} ${
              grandTotal.realizedPnL >= 0 ? styles.buyColor : styles.sellColor
            }`}
          >
            {fmtSigned(grandTotal.realizedPnL)}원
          </span>
          <span className={styles.summarySub}>
            매도 {grandTotal.sellCount}건
            {grandTotal.uncalculatedCount > 0 && (
              <span className={styles.estimatedNote}>
                {' '}· 미계산 {grandTotal.uncalculatedCount}
              </span>
            )}
          </span>
        </div>
      </div>

      {/* 검증 바 (Fix 2): 매매일지 누적 vs 실제 보유값 일치 여부 — 클릭 시 상세 토글 */}
      {stockVerifications.size > 0 && (
        <div className={styles.verifyBar}>
          {/* 요약 헤더 행 — 클릭으로 상세 토글 */}
          <div
            className={styles.verifyBarRow}
            onClick={() => setShowMismatchDetail((v) => !v)}
          >
            <span className={styles.verifyBarTitle}>🔍 검증 현황</span>
            {verifySummary.match > 0 && (
              <span className={styles.verifyBarMatch}>
                ✓ 일치 <b>{verifySummary.match}</b>종목
              </span>
            )}
            {verifySummary.mismatch > 0 && (
              <span className={styles.verifyBarMismatch}>
                ⚠️ 불일치 <b>{verifySummary.mismatch}</b>종목
              </span>
            )}
            {verifySummary.estimated > 0 && (
              <span className={styles.verifyBarEstimated}>
                ⓘ 추정 <b>{verifySummary.estimated}</b>종목
              </span>
            )}
            {verifySummary.noStock > 0 && (
              <span className={styles.verifyBarNoStock}>
                · 미등록 {verifySummary.noStock}종목
              </span>
            )}
            <span className={styles.verifyBarToggle}>
              {showMismatchDetail ? '▲' : '▼'} 상세
            </span>
          </div>

          {/* 종목별 상세 패널 */}
          {showMismatchDetail && (
            <div className={styles.verifyDetail}>
              {[...stockVerifications.values()]
                .filter((v) => v.status !== 'no-stock')
                .sort((a, b) => {
                  const order: Record<string, number> = { mismatch: 0, estimated: 1, match: 2 };
                  return (order[a.status] ?? 3) - (order[b.status] ?? 3);
                })
                .map((v) => (
                  <div
                    key={v.stockName}
                    className={`${styles.verifyDetailRow} ${
                      v.status === 'mismatch'
                        ? styles.verifyDetailMismatch
                        : v.status === 'estimated'
                          ? styles.verifyDetailEstimated
                          : styles.verifyDetailMatch
                    }`}
                    onClick={() => {
                      setFilterStock(v.stockName);
                      setShowMismatchDetail(false);
                    }}
                    title="클릭 → 해당 종목 필터"
                  >
                    <span className={styles.verifyDetailName}>{v.stockName}</span>
                    <span className={styles.verifyDetailStatus}>
                      {v.status === 'match' ? '✓ 일치' : v.status === 'estimated' ? '⚠ 추정' : '❌ 불일치'}
                    </span>
                    {v.status !== 'match' && (
                      <>
                        {!v.qtyMatch && (
                          <span className={`${styles.verifyDetailChip} ${styles.verifyDetailChipQty}`}>
                            수량 계산{v.computedQty}주 / 실제{v.expectedQty}주 ({v.qtyDiff >= 0 ? '+' : ''}{v.qtyDiff})
                          </span>
                        )}
                        {!v.avgMatch && v.expectedQty > 0 && (
                          <span className={`${styles.verifyDetailChip} ${styles.verifyDetailChipAvg}`}>
                            평단 {fmt(v.computedAvg)}원 / 실제 {fmt(v.expectedAvg)}원 ({v.avgDiffPct.toFixed(1)}% 차이)
                          </span>
                        )}
                        {v.missingBuyQty && v.missingBuyQty > 0 && (
                          <span className={`${styles.verifyDetailChip} ${styles.verifyDetailChipMissing}`}>
                            매수이력 부족 {v.missingBuyQty}주
                          </span>
                        )}
                        {v.mismatchReason && (
                          <span className={styles.verifyDetailReason}>
                            원인: {v.mismatchReason === 'qty' ? '수량 불일치' : v.mismatchReason === 'avg' ? '평단 불일치' : '수량+평단 불일치'}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                ))}
            </div>
          )}

          {verifySummary.mismatch > 0 && !showMismatchDetail && (
            <div className={styles.verifyBarHint}>
              ⚠️ 매수/매도 누락 또는 과다 기록 가능성 — ▼ 상세를 클릭하여 확인하세요.
            </div>
          )}
        </div>
      )}

      {/* 계산 옵션 바 */}
      <div className={styles.calcOptionBar}>
        <label className={styles.feeToggle}>
          <input
            type="checkbox"
            checked={applyFees}
            onChange={(e) => setApplyFees(e.target.checked)}
          />
          <span>세금/수수료 반영 (0.195%)</span>
        </label>
        {totalSummary.totalFees > 0 && (
          <span className={styles.feeInfo}>
            차감 합계: <b>{fmt(totalSummary.totalFees)}원</b>
          </span>
        )}
        {totalSummary.estimatedSellCount > 0 && (
          <span className={styles.estimatedInfo}>
            ⚠️ 추정 {totalSummary.estimatedSellCount}건의 합계: {fmtSigned(totalSummary.estimatedPnL)}원
            <span className={styles.estimatedHint}> (매수 이력 부족)</span>
          </span>
        )}
      </div>

      {/* 작성/편집 폼 (접기/펼치기) */}
      {formOpen && (
        <div className={styles.form}>
          {editId && <div className={styles.editingNotice}>✏️ 편집 중</div>}
          <div className={styles.formRow}>
            <label>
              날짜
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </label>
            <label>
              종목명
              <input
                list="stock-names"
                value={form.stockName}
                onChange={(e) => setForm({ ...form, stockName: e.target.value })}
                placeholder="종목명 입력"
              />
              <datalist id="stock-names">
                {stocks.map((s) => (
                  <option key={s.id} value={s.name} />
                ))}
              </datalist>
            </label>
            <label>
              구분
              <select
                value={form.type}
                onChange={(e) =>
                  setForm({
                    ...form,
                    type: e.target.value as 'buy' | 'sell' | 'watch',
                  })
                }
              >
                <option value="buy">매수</option>
                <option value="sell">매도</option>
                <option value="watch">관찰</option>
              </select>
            </label>
          </div>
          <div className={styles.formRow}>
            <label>
              가격
              <input
                type="number"
                value={form.price || ''}
                onChange={(e) =>
                  setForm({ ...form, price: Number(e.target.value) })
                }
              />
            </label>
            <label>
              수량
              <input
                type="number"
                value={form.quantity || ''}
                onChange={(e) =>
                  setForm({ ...form, quantity: Number(e.target.value) })
                }
              />
            </label>
            <label>
              태그
              <input
                value={form.tagInput}
                onChange={(e) => setForm({ ...form, tagInput: e.target.value })}
                placeholder="#태산 #대선주"
              />
            </label>
          </div>

          {allTags.length > 0 && (
            <div className={styles.tagChips}>
              <span className={styles.tagChipsLabel}>자주 쓴 태그:</span>
              {allTags.map(([tag, count]) => (
                <span
                  key={tag}
                  className={styles.tagChip}
                  onClick={() => addTagChip(tag)}
                  title="클릭하여 추가"
                >
                  #{tag} <span className={styles.tagChipCount}>{count}</span>
                </span>
              ))}
            </div>
          )}

          <label className={styles.memoLabel}>
            <div className={styles.memoHeader}>
              <span>메모</span>
              <button
                type="button"
                className={styles.templateBtn}
                onClick={appendTemplate}
              >
                📋 태산 체크리스트 삽입
              </button>
            </div>
            <textarea
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              placeholder="매매 근거, 시장 상황 등..."
              rows={4}
            />
          </label>
          <div className={styles.formActions}>
            <button className={styles.submitBtn} onClick={handleSubmit}>
              {editId ? '수정 완료' : '일지 저장'}
            </button>
            <button className={styles.cancelEditBtn} onClick={cancelEdit}>
              취소
            </button>
          </div>
        </div>
      )}

      {/* 강화된 필터 */}
      <div className={styles.filterBar}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>구분</span>
          <div className={styles.segmented}>
            {(['all', 'buy', 'sell', 'watch'] as TypeFilter[]).map((v) => (
              <button
                key={v}
                className={`${styles.segBtn} ${typeFilter === v ? styles.segBtnActive : ''} ${
                  v === 'buy' && typeFilter === v ? styles.segBtnBuy : ''
                } ${v === 'sell' && typeFilter === v ? styles.segBtnSell : ''}`}
                onClick={() => setTypeFilter(v)}
              >
                {v === 'all' ? '전체' : typeLabel[v]}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>기간</span>
          <div className={styles.segmented}>
            {([
              ['all', '전체'],
              ['1m', '1개월'],
              ['3m', '3개월'],
              ['6m', '6개월'],
              ['1y', '1년'],
            ] as [PeriodFilter, string][]).map(([v, l]) => (
              <button
                key={v}
                className={`${styles.segBtn} ${periodFilter === v ? styles.segBtnActive : ''}`}
                onClick={() => setPeriodFilter(v)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>손익</span>
          <div className={styles.segmented}>
            {([
              ['all', '전체'],
              ['profit', '수익'],
              ['loss', '손실'],
            ] as [PnLFilter, string][]).map(([v, l]) => (
              <button
                key={v}
                className={`${styles.segBtn} ${pnlFilter === v ? styles.segBtnActive : ''} ${
                  v === 'profit' && pnlFilter === v ? styles.segBtnBuy : ''
                } ${v === 'loss' && pnlFilter === v ? styles.segBtnSell : ''}`}
                onClick={() => setPnLFilter(v)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.filterTextGroup}>
          <input
            className={styles.filterInput}
            placeholder="종목명"
            value={filterStock}
            onChange={(e) => setFilterStock(e.target.value)}
          />
          <input
            className={styles.filterInput}
            placeholder="#태그"
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
          />
          <input
            className={styles.filterInput}
            placeholder="메모 검색"
            value={filterMemo}
            onChange={(e) => setFilterMemo(e.target.value)}
          />
          {hasActiveFilter && (
            <button className={styles.clearBtn} onClick={clearFilters}>
              초기화
            </button>
          )}
        </div>
      </div>

      {/* 일지 목록 */}
      {Object.entries(grouped)
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, list]) => {
          const ms = computeMonthSummary(list, contextMap);
          return (
            <div key={month} className={styles.monthGroup}>
              <div className={styles.monthHeader}>
                <h3 className={styles.monthTitle}>{month}</h3>
                <div className={styles.monthSummary}>
                  <span className={`${styles.monthStat} ${styles.buyColor}`}>
                    매수 {ms.buyCount}건
                  </span>
                  <span className={`${styles.monthStat} ${styles.sellColor}`}>
                    매도 {ms.sellCount}건
                  </span>
                  {ms.sellCount > 0 && (
                    <span
                      className={`${styles.monthPnL} ${
                        ms.realizedPnL >= 0 ? styles.buyColor : styles.sellColor
                      }`}
                    >
                      실현 {fmtSigned(ms.realizedPnL)}원
                    </span>
                  )}
                </div>
              </div>

              <div className={styles.tradeGrid}>
              {list.map((trade) => {
                const ctx = contextMap.get(trade.id);
                const stock = stocks.find((st) => st.name === trade.stockName);
                const verify = stockVerifications.get(trade.stockName);
                const amount = trade.price * trade.quantity;
                const isPnLPositive = ctx?.realizedPnL !== undefined && ctx.realizedPnL >= 0;
                const relLabel = relativeDateLabel(trade.date);
                // planGap 해석: 매수는 계획보다 싸게(-) = 유리, 매도는 계획보다 비싸게(+) = 유리
                const planGapFavorable = ctx?.planGap !== undefined
                  ? (trade.type === 'buy' ? ctx.planGap <= 0 : ctx.planGap >= 0)
                  : false;
                return (
                  <div
                    key={trade.id}
                    className={`${styles.tradeCard} ${
                      trade.type === 'sell'
                        ? isPnLPositive
                          ? styles.tradeCardProfit
                          : styles.tradeCardLoss
                        : ''
                    } ${
                      verify?.status === 'mismatch' ? styles.tradeCardMismatch : ''
                    }`}
                  >
                    <div className={styles.tradeHeader}>
                      <span className={styles.tradeDate}>
                        {trade.date}
                        {relLabel && (
                          <span className={styles.tradeDateRel}>{relLabel}</span>
                        )}
                      </span>
                      <span className={`${styles.tradeType} ${typeColorClass[trade.type]}`}>
                        {typeLabel[trade.type]}
                        {ctx && ctx.planLevel > 0 && (
                          <span
                            className={`${styles.tradeLevel} ${
                              ctx.exceedsPlan ? styles.tradeLevelExceed : ''
                            }`}
                            title={
                              ctx.exceedsPlan
                                ? `계획 차수 초과 — 거래 ${ctx.tradeOrder}번째, 계획은 ${
                                    trade.type === 'buy' ? stock?.buyPlans?.length : stock?.sellPlans?.length
                                  }차까지`
                                : `계획 ${ctx.planLevel}차 (거래 ${ctx.tradeOrder}번째)`
                            }
                          >
                            {ctx.exceedsPlan ? `초과(${ctx.tradeOrder})` : `${ctx.planLevel}차`}
                          </span>
                        )}
                      </span>
                      <span className={styles.tradeStock}>
                        {trade.stockName}
                        {stock?.code && (
                          <span className={styles.tradeStockCode}>({stock.code})</span>
                        )}
                        {verify && verify.status === 'mismatch' && (
                          <span
                            className={styles.verifyBadgeMismatch}
                            title={`검증 불일치 — 계산 보유 ${verify.computedQty}주 vs 실제 ${verify.expectedQty}주 (차이 ${verify.qtyDiff >= 0 ? '+' : ''}${verify.qtyDiff}주), 계산 평단 ${fmt(verify.computedAvg)} vs 실제 ${fmt(verify.expectedAvg)} (오차 ${verify.avgDiffPct.toFixed(2)}%)`}
                          >
                            ⚠️ 불일치
                          </span>
                        )}
                        {verify && verify.status === 'match' && (
                          <span
                            className={styles.verifyBadgeMatch}
                            title={`검증 통과 — 계산 보유/평단이 실제와 일치 (${verify.computedQty}주, ${fmt(verify.computedAvg)}원)`}
                          >
                            ✓ 검증
                          </span>
                        )}
                      </span>
                      {ctx?.isKiwoom && (
                        <span className={styles.kiwoomBadge} title="키움 연동 자동 기록">
                          🤖 자동
                        </span>
                      )}
                      <span className={styles.tradePrice}>
                        {fmt(trade.price)}원 × {trade.quantity}
                        <span className={styles.tradeAmount}> = {fmt(amount)}원</span>
                      </span>
                    </div>

                    {ctx && (trade.type === 'buy' || trade.type === 'sell') && (
                      <div className={styles.contextRow}>
                        {/* 계획가 대비 비교 (Fix 4) */}
                        {ctx.planPrice && ctx.planGap !== undefined && (
                          <span
                            className={`${styles.planGapChip} ${
                              planGapFavorable ? styles.planGapGood : styles.planGapBad
                            }`}
                            title={`${trade.type === 'buy' ? '매수' : '매도'} 계획가 ${fmt(ctx.planPrice)}원 대비 실제 ${fmt(trade.price)}원 = ${ctx.planGap >= 0 ? '+' : ''}${ctx.planGap.toFixed(2)}%`}
                          >
                            계획 {fmt(ctx.planPrice)}원 · {ctx.planGap >= 0 ? '+' : ''}
                            {ctx.planGap.toFixed(1)}%
                            <span className={styles.planGapLabel}>
                              {' '}
                              {planGapFavorable ? '유리' : '불리'}
                            </span>
                          </span>
                        )}
                        {trade.type === 'buy' && ctx.avgBefore > 0 && (
                          <span className={styles.contextChip}>
                            평단 {fmt(ctx.avgBefore)} → <b>{fmt(ctx.avgAfter)}</b>원
                            {ctx.avgBefore > 0 && (
                              <span className={styles.contextDelta}>
                                {' '}
                                ({((ctx.avgAfter - ctx.avgBefore) / ctx.avgBefore * 100).toFixed(1)}%)
                              </span>
                            )}
                          </span>
                        )}
                        {trade.type === 'buy' && ctx.avgBefore === 0 && (
                          <span className={styles.contextChip}>
                            평단 신규 <b>{fmt(ctx.avgAfter)}</b>원
                          </span>
                        )}
                        <span className={styles.contextChip}>
                          보유 {ctx.qtyBefore} → <b>{ctx.qtyAfter}</b>주
                        </span>
                        {trade.type === 'sell' && ctx.isEstimated && (
                          <span
                            className={styles.estimatedBadge}
                            title={ctx.estimatedReason}
                          >
                            ⚠️ 추정
                          </span>
                        )}
                        {trade.type === 'sell' && ctx.fees !== undefined && ctx.fees > 0 && (
                          <span className={styles.feeChip} title="거래세 0.18% + 수수료 0.015%">
                            -{fmt(ctx.fees)}원 세금/수수료
                          </span>
                        )}
                        {trade.type === 'sell' && ctx.realizedPnL !== undefined && (
                          <span
                            className={`${styles.contextPnL} ${
                              isPnLPositive ? styles.pnlProfit : styles.pnlLoss
                            }`}
                          >
                            실현 {fmtSigned(ctx.realizedPnL)}원
                            <span className={styles.pnlPercent}>
                              {' '}
                              ({(ctx.pnlPercent || 0) >= 0 ? '+' : ''}
                              {(ctx.pnlPercent || 0).toFixed(1)}%)
                            </span>
                          </span>
                        )}
                        {trade.type === 'sell' && ctx.realizedPnL === undefined && (
                          <span className={styles.uncalcChip} title={ctx.estimatedReason}>
                            ⚠️ 손익 계산 불가
                          </span>
                        )}
                      </div>
                    )}

                    {trade.memo && <p className={styles.tradeMemo}>{trade.memo}</p>}

                    {trade.tags.length > 0 && (
                      <div className={styles.tradeTags}>
                        {trade.tags.map((tag, i) => (
                          <span key={i} className={styles.tag}>
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className={styles.tradeActions}>
                      <button onClick={() => startEdit(trade)}>수정</button>
                      <button
                        onClick={() => {
                          if (confirm('삭제하시겠습니까?')) onDelete(trade.id);
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
        })}

      {filtered.length === 0 && (
        <p className={styles.empty}>
          {hasActiveFilter ? '조건에 맞는 일지가 없습니다. 필터를 초기화해보세요.' : '매매 일지가 없습니다.'}
        </p>
      )}
    </div>
  );
}

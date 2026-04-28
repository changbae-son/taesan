import { useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { Stock, Trade, Snapshot } from '../types';
import { recalcStock } from '../hooks/useStocks';
import styles from './StockDetail.module.css';

interface Props {
  stock: Stock;
  trades: Trade[];
  snapshots: Snapshot[];
  onSave: (stock: Stock) => void;
  onDelete: (id: string) => void;
  onSnapshot: (stockId: string, stockName: string, profit: number) => void;
}

export default function StockDetail({
  stock,
  trades,
  snapshots,
  onSave,
  onDelete,
  onSnapshot,
}: Props) {
  const [local, setLocal] = useState<Stock>(stock);
  const [showBasicInfo, setShowBasicInfo] = useState(false);

  // ── 수익매도 수동 편집 ──
  const [sellEditIdx, setSellEditIdx] = useState<number | null>(null);
  const [sellEditDraft, setSellEditDraft] = useState<{
    date: string; price: number; qty: number;
  } | null>(null);

  // ── 기본 정보 수정 draft ──
  const [editDraft, setEditDraft] = useState<{
    prices: number[];
    quantities: number[];
    currentPrice: number;
    filledDates: (string | undefined)[];
    filledPrices: (number | undefined)[];
    filledQtys: (number | undefined)[];
  } | null>(null);

  const openBasicEdit = () => {
    setEditDraft({
      prices: local.buyPlans.map((bp) => bp.price || 0),
      quantities: local.buyPlans.map((bp) => bp.quantity || local.firstBuyQuantity || 0),
      currentPrice: local.currentPrice || 0,
      filledDates: local.buyPlans.map((bp) => bp.filledDate),
      filledPrices: local.buyPlans.map((bp) => bp.filledPrice),
      filledQtys: local.buyPlans.map((bp) => bp.filledQuantity),
    });
    setShowBasicInfo(true);
  };

  const handleDraftPrice = (idx: number, val: number) => {
    if (!editDraft) return;
    const prices = [...editDraft.prices];
    prices[idx] = val;
    // 1차 가격 변경 시 미체결 하위 차수 자동 cascade
    if (idx === 0 && val > 0) {
      for (let j = 1; j < 5; j++) {
        if (!local.buyPlans[j].filled) {
          prices[j] = Math.round(prices[j - 1] * 0.9);
        }
      }
    }
    setEditDraft({ ...editDraft, prices });
  };

  const handleDraftQty = (idx: number, val: number) => {
    if (!editDraft) return;
    const quantities = [...editDraft.quantities];
    quantities[idx] = val;
    setEditDraft({ ...editDraft, quantities });
  };

  const handleDraftFillDate = (idx: number, val: string) => {
    if (!editDraft) return;
    const filledDates = [...editDraft.filledDates];
    filledDates[idx] = val || undefined;
    setEditDraft({ ...editDraft, filledDates });
  };

  const handleDraftFillPrice = (idx: number, val: number) => {
    if (!editDraft) return;
    const filledPrices = [...editDraft.filledPrices];
    filledPrices[idx] = val > 0 ? val : undefined;
    setEditDraft({ ...editDraft, filledPrices });
  };

  const handleDraftFillQty = (idx: number, val: number) => {
    if (!editDraft) return;
    const filledQtys = [...editDraft.filledQtys];
    filledQtys[idx] = val > 0 ? val : undefined;
    setEditDraft({ ...editDraft, filledQtys });
  };

  const confirmBasicEdit = () => {
    if (!editDraft) return;
    // recalcStock으로 평단/매도계획 재계산 (가격 cascade 제외)
    const base = recalcStock({
      ...local,
      firstBuyPrice: editDraft.prices[0],
      firstBuyQuantity: editDraft.quantities[0],
      currentPrice: editDraft.currentPrice,
    });
    // 수동 입력한 가격/수량/체결정보로 override
    // 체결 정보(가격+수량)가 모두 입력되면 자동으로 filled=true 처리
    const finalBuyPlans = base.buyPlans.map((bp, i) => {
      const fp = editDraft.filledPrices[i];
      const fq = editDraft.filledQtys[i];
      const hasFillInfo = (fp ?? 0) > 0 && (fq ?? 0) > 0;
      const willBeFilled = bp.filled || hasFillInfo;
      // 사용자가 직접 입력한 체결 정보는 manualOverride=true로 보호
      // (다음 sync/reconcile에서 덮어쓰지 않도록)
      const isManualEntry = hasFillInfo && (
        editDraft.filledPrices[i] !== bp.filledPrice ||
        editDraft.filledQtys[i] !== bp.filledQuantity ||
        editDraft.filledDates[i] !== bp.filledDate
      );
      return {
        ...bp,
        price: editDraft.prices[i] > 0 ? editDraft.prices[i] : bp.price,
        quantity: editDraft.quantities[i] > 0 ? editDraft.quantities[i] : bp.quantity,
        filled: willBeFilled,
        filledDate: willBeFilled ? editDraft.filledDates[i] : bp.filledDate,
        filledPrice: willBeFilled ? fp : bp.filledPrice,
        filledQuantity: willBeFilled ? fq : bp.filledQuantity,
        manualOverride: isManualEntry || bp.manualOverride,
      };
    });
    // 평단가 재계산 (filled buyPlans 기준)
    let totalCost = 0;
    let totalQty = 0;
    for (const bp of finalBuyPlans) {
      if (bp.filled) {
        const p = bp.filledPrice || bp.price;
        const q = bp.filledQuantity || bp.quantity;
        totalCost += p * q;
        totalQty += q;
      }
    }
    const newAvg = totalQty > 0 ? Math.round(totalCost / totalQty) : base.avgPrice;
    const final: Stock = {
      ...base,
      buyPlans: finalBuyPlans,
      avgPrice: newAvg,
      totalQuantity: totalQty > 0 ? totalQty : base.totalQuantity,
      updatedAt: Date.now(),
    };
    setLocal(final);
    onSave(final);
    setEditDraft(null);
    setShowBasicInfo(false);
  };

  useEffect(() => {
    setLocal(stock);
  }, [stock]);

  const update = (partial: Partial<Stock>) => {
    const next = recalcStock({ ...local, ...partial });
    setLocal(next);
    onSave(next);
  };

  const updateField = (field: keyof Stock, value: number | string) => {
    update({ [field]: value } as Partial<Stock>);
  };

  const toggleBuyFilled = (index: number) => {
    const plans = [...local.buyPlans];
    plans[index] = { ...plans[index], filled: !plans[index].filled };
    // 추가매수 시 매도가 리셋
    const resetSells = plans[index].filled
      ? local.sellPlans.map((sp) => ({ ...sp, filled: false }))
      : local.sellPlans;
    update({ buyPlans: plans, sellPlans: resetSells });
  };

  const toggleSellFilled = (index: number) => {
    const plans = [...local.sellPlans];
    plans[index] = { ...plans[index], filled: !plans[index].filled };
    const newSellCount = plans[index].filled
      ? local.sellCount + 1
      : Math.max(0, local.sellCount - 1);
    update({ sellPlans: plans, sellCount: newSellCount });
    // 매도 체결 시 수익률 스냅샷 저장
    if (plans[index].filled && local.avgPrice > 0) {
      const profit =
        ((plans[index].price - local.avgPrice) / local.avgPrice) * 100;
      onSnapshot(local.id, local.name, profit);
    }
  };

  const toggleMAFilled = (index: number) => {
    const ma = [...local.maSells];
    ma[index] = { ...ma[index], filled: !ma[index].filled };
    update({ maSells: ma });
    if (ma[index].filled && local.avgPrice > 0) {
      const profit =
        ((ma[index].price - local.avgPrice) / local.avgPrice) * 100;
      onSnapshot(local.id, local.name, profit);
    }
  };

  const updateMAPrice = (index: number, price: number) => {
    const ma = [...local.maSells];
    ma[index] = { ...ma[index], price };
    update({ maSells: ma });
  };

  const updateMAQty = (index: number, quantity: number) => {
    const ma = [...local.maSells];
    ma[index] = { ...ma[index], quantity };
    update({ maSells: ma });
  };

  // 수익매도 수동 편집 열기
  const openSellEdit = (i: number) => {
    const sp = local.sellPlans[i];
    setSellEditIdx(i);
    setSellEditDraft({
      date: sp.filledDate || '',
      price: sp.filledPrice || sp.price || 0,
      qty: sp.filledQuantity || sp.quantity || 0,
    });
    setSplitIdx(null);
  };

  // 수익매도 수동 편집 저장 (manualOverride=true 설정)
  const confirmSellEdit = () => {
    if (sellEditIdx === null || !sellEditDraft) return;
    const plans = [...local.sellPlans];
    plans[sellEditIdx] = {
      ...plans[sellEditIdx],
      filled: true,
      filledDate: sellEditDraft.date,
      filledPrice: sellEditDraft.price,
      filledQuantity: sellEditDraft.qty,
      manualOverride: true,
    };
    const newSellCount = plans.filter((p) => p.filled).length;
    update({ sellPlans: plans, sellCount: newSellCount });
    setSellEditIdx(null);
    setSellEditDraft(null);
  };

  // 수익매도 수동 편집 해제 (manualOverride 제거 → sync 자동 반영 허용)
  const clearSellOverride = (i: number) => {
    const plans = [...local.sellPlans];
    const { manualOverride: _removed, ...rest } = plans[i] as any;
    plans[i] = rest;
    update({ sellPlans: plans });
  };

  // ── MA 분리 (sellPlan → maSells 이동) ──
  const [splitIdx, setSplitIdx] = useState<number | null>(null);
  const [splitDraft, setSplitDraft] = useState<{
    ma: number; qty: number; price: number; date: string;
  } | null>(null);

  const openSplitToMA = (i: number) => {
    const sp = local.sellPlans[i];
    setSplitIdx(i);
    setSplitDraft({
      ma: 60, // 기본 60일선
      qty: sp.filledQuantity || 0,
      price: sp.filledPrice || 0,
      date: sp.filledDate || new Date().toISOString().slice(0, 10),
    });
    setSellEditIdx(null);
  };

  const confirmSplitToMA = () => {
    if (splitIdx === null || !splitDraft) return;
    const sp = local.sellPlans[splitIdx];
    const splitQty = splitDraft.qty;
    if (splitQty <= 0) return;
    const currentFilledQty = sp.filledQuantity || 0;
    if (splitQty > currentFilledQty) {
      alert(`분리 수량(${splitQty})이 체결 수량(${currentFilledQty})을 초과합니다.`);
      return;
    }

    // 1. sellPlan 차감
    const plans = [...local.sellPlans];
    const remaining = currentFilledQty - splitQty;
    plans[splitIdx] = {
      ...sp,
      filledQuantity: remaining,
      filled: remaining > 0,
      manualOverride: true, // sync 보호
    };
    if (remaining === 0) {
      plans[splitIdx].filledDate = '';
      plans[splitIdx].filledPrice = 0;
    }

    // 2. maSells에 추가 (해당 MA 슬롯)
    const maList = [...local.maSells];
    const maIdx = maList.findIndex((m) => m.ma === splitDraft.ma);
    if (maIdx >= 0) {
      // 기존 슬롯이 비어있으면 채우고, 이미 차있으면 수량 누적
      const existing = maList[maIdx];
      if (existing.filled) {
        const totalQty = existing.quantity + splitQty;
        const totalAmt = existing.price * existing.quantity + splitDraft.price * splitQty;
        maList[maIdx] = {
          ...existing,
          quantity: totalQty,
          price: Math.round(totalAmt / totalQty),
          filledDate: splitDraft.date,
          insertAfterPercent: sp.percent,
          splitFromPercent: sp.percent,
        };
      } else {
        maList[maIdx] = {
          ...existing,
          quantity: splitQty,
          price: splitDraft.price,
          filled: true,
          filledDate: splitDraft.date,
          insertAfterPercent: sp.percent,
          splitFromPercent: sp.percent,
        };
      }
    }

    const newSellCount = plans.filter((p) => p.filled).length;
    update({ sellPlans: plans, maSells: maList, sellCount: newSellCount });
    setSplitIdx(null);
    setSplitDraft(null);
  };

  // ── MA 행 → sellPlan 복원 ──
  const restoreMAToSell = (maIdx: number) => {
    const m = local.maSells[maIdx];
    if (!m.filled || !m.splitFromPercent) {
      alert('분리 정보가 없는 MA 매도는 복원할 수 없습니다.');
      return;
    }
    const targetPercent = m.splitFromPercent;
    const plans = [...local.sellPlans];
    const targetIdx = plans.findIndex((p) => p.percent === targetPercent);
    if (targetIdx < 0) return;

    const sp = plans[targetIdx];
    const currentQty = sp.filledQuantity || 0;
    const currentPrice = sp.filledPrice || 0;
    const newQty = currentQty + m.quantity;
    const newAmt = currentPrice * currentQty + m.price * m.quantity;
    const newPrice = newQty > 0 ? Math.round(newAmt / newQty) : 0;

    plans[targetIdx] = {
      ...sp,
      filled: true,
      filledQuantity: newQty,
      filledPrice: newPrice,
      filledDate: sp.filledDate || m.filledDate || '',
    };

    // maSells 항목 비움
    const maList = [...local.maSells];
    maList[maIdx] = {
      ma: m.ma,
      price: 0,
      quantity: 0,
      filled: false,
    };

    update({ sellPlans: plans, maSells: maList });
  };

  const profitPercent =
    local.avgPrice > 0
      ? ((local.currentPrice - local.avgPrice) / local.avgPrice) * 100
      : 0;

  const profitAmount =
    local.avgPrice > 0 && local.totalQuantity > 0
      ? (local.currentPrice - local.avgPrice) * local.totalQuantity
      : 0;

  const filledBuys = local.buyPlans.filter((b) => b.filled).length;
  const stockSnapshots = snapshots.filter((s) => s.stockId === local.id);

  // 다음 매수 차수 인덱스
  const nextBuyIdx = local.buyPlans.findIndex((b) => !b.filled);

  // 현재가 근접 판단 + 긴급도
  const getNearInfo = (target: number) => {
    if (!local.currentPrice || !target) return null;
    const gap = ((local.currentPrice - target) / target) * 100;
    const absGap = Math.abs(gap);
    if (absGap > 3) return null;
    const urgency: 1 | 2 | 3 = absGap <= 1 ? 3 : absGap <= 2 ? 2 : 1;
    return { gap, absGap, urgency };
  };
  const priceGapText = (target: number) => {
    if (!local.currentPrice || !target) return '';
    const gap = ((local.currentPrice - target) / target) * 100;
    return `(${gap >= 0 ? '+' : ''}${gap.toFixed(1)}%)`;
  };

  // 매매일지에서 해당 종목의 실제 매수/매도 내역
  const stockTrades = trades
    .filter((t) => t.stockName === local.name)
    .sort((a, b) => a.date.localeCompare(b.date));
  const actualBuys = stockTrades.filter((t) => t.type === 'buy');
  const actualSells = stockTrades.filter((t) => t.type === 'sell');

  // buyPlans 체결 데이터로 fallback (Kiwoom 연동 이전 종목 대응)
  // filledDate 없어도 filledPrice+filledQuantity 있으면 fallback 허용 (종가매수 등 API 날짜 미지원 대비)
  const syntheticBuys: Trade[] = local.buyPlans
    .filter((bp) => bp.filled && bp.filledPrice && bp.filledQuantity)
    .map((bp) => ({
      id: `synthetic-${local.id}-${bp.level}`,
      date: bp.filledDate || new Date(local.updatedAt || Date.now()).toISOString().slice(0, 10),
      stockName: local.name,
      type: 'buy' as const,
      price: bp.filledPrice!,
      quantity: bp.filledQuantity!,
      memo: `${bp.level}차 매수 (계획 기반)${bp.filledDate ? '' : ' — 날짜 미상'}`,
      tags: [] as string[],
      createdAt: 0,
    }));
  // 실제 매매일지 기록 우선, 없으면 buyPlans 체결 데이터 사용
  const effectiveBuys = actualBuys.length > 0 ? actualBuys : syntheticBuys;

  // 매수를 날짜별로 그룹핑
  const buysByDate: { date: string; qty: number; amt: number }[] = [];
  const buyDateMap: Record<string, { qty: number; amt: number }> = {};
  for (const b of effectiveBuys) {
    if (!buyDateMap[b.date]) buyDateMap[b.date] = { qty: 0, amt: 0 };
    buyDateMap[b.date].qty += b.quantity;
    buyDateMap[b.date].amt += b.price * b.quantity;
  }
  Object.keys(buyDateMap).sort().forEach((d) => {
    buysByDate.push({ date: d, ...buyDateMap[d] });
  });

  // 실제 평균단가 (체결 기반) - 계획가 기반(local.avgPrice)과 비교용
  const actualTotalQty = buysByDate.reduce((sum, b) => sum + b.qty, 0);
  const actualTotalAmt = buysByDate.reduce((sum, b) => sum + b.amt, 0);
  const actualAvgPrice = actualTotalQty > 0 ? Math.round(actualTotalAmt / actualTotalQty) : 0;
  const avgPriceDiffers = actualAvgPrice > 0 && Math.abs(actualAvgPrice - local.avgPrice) / (local.avgPrice || 1) > 0.01;
  const actualProfitPercent = actualAvgPrice > 0
    ? ((local.currentPrice - actualAvgPrice) / actualAvgPrice) * 100
    : 0;

  // 매도: 개별 체결 순차 매핑 (날짜↑, 같은 날짜는 가격↑)
  // 각 체결 건이 하나의 sellPlan 슬롯과 1:1 대응
  const sellsIndividual: { date: string; qty: number; amt: number; trades: Trade[] }[] = [
    ...actualSells
  ]
    .sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      if (dc !== 0) return dc;
      return a.price - b.price; // 같은 날: 가격 오름차순 (백엔드와 동일 정렬)
    })
    .map((s) => ({
      date: s.date,
      qty: s.quantity,
      amt: s.price * s.quantity,
      trades: [s],
    }));

  // 하위 호환용 별칭 (기존 코드 참조 최소화)
  const sellsByDate = sellsIndividual;

  // 다음 매도 차수 인덱스
  const nextSellIdx = local.sellPlans.findIndex((s, i) => !s.filled && !sellsIndividual[i]);

  // 1차 매수 참고 정보 (헤더 배지용)
  const firstBuyPlan = local.buyPlans[0];
  const firstBuyActual = buysByDate[0];
  const firstBuyRefQty = firstBuyActual?.qty || firstBuyPlan?.filledQuantity || firstBuyPlan?.quantity || 0;
  const firstBuyRefPrice = firstBuyActual
    ? Math.round(firstBuyActual.amt / firstBuyActual.qty)
    : (firstBuyPlan?.filledPrice || firstBuyPlan?.price || 0);
  const firstBuyRefFilled = !!firstBuyPlan?.filled || !!firstBuyActual;

  // 1차 매도 참고 정보 (첫 번째 체결된 매도)
  const firstFilledSellIdx = local.sellPlans.findIndex((s, i) => s.filled || !!sellsByDate[i]);
  const firstSellPlan = firstFilledSellIdx >= 0 ? local.sellPlans[firstFilledSellIdx] : null;
  const firstSellActual = firstFilledSellIdx >= 0 ? sellsByDate[firstFilledSellIdx] : null;
  const firstSellRefQty = firstSellActual?.qty || firstSellPlan?.filledQuantity || firstSellPlan?.quantity || 0;
  const firstSellRefPrice = firstSellActual
    ? Math.round(firstSellActual.amt / firstSellActual.qty)
    : (firstSellPlan?.filledPrice || firstSellPlan?.price || 0);
  const firstSellRefPercent = firstSellPlan?.percent || 0;

  return (
    <div className={styles.container}>
      {/* 헤더 */}
      <div className={styles.header}>
        <h2 className={styles.title}>
          {local.name}
          {local.code && <span className={styles.codeLabel}>({local.code})</span>}
        </h2>
        <span
          className={styles.badge}
          style={{
            background:
              filledBuys === 0
                ? '#f0f0f0'
                : local.totalQuantity === 0
                ? '#e8f0fe'
                : '#e8f5e9',
          }}
        >
          {filledBuys === 0 ? '관찰' : local.totalQuantity === 0 ? '완료' : '보유'}
        </span>
        <button
          className={styles.deleteBtn}
          onClick={() => {
            if (confirm(`"${local.name}" 종목을 삭제하시겠습니까?`)) {
              onDelete(local.id);
            }
          }}
        >
          삭제
        </button>
      </div>

      {/* 알림 */}
      {filledBuys >= 4 && (
        <div className={styles.alertRed}>
          4차 이상 진입! 비중 관리에 주의하세요.
        </div>
      )}
      {local.sellCount >= 3 && local.rule === 'A' && (
        <div className={styles.alertOrange}>
          3회 매도 달성! 룰B(저점 대비 -10%) 전환을 검토하세요.
        </div>
      )}
      {local.rule === 'B' && (
        <div className={styles.alertBlue}>
          룰B 적용 중: 저점 대비 -10%에서 양봉 매수
          {local.bottomPrice && local.bottomPrice > 0 && (
            <>
              <br />
              추적 저점: <strong>{local.bottomPrice.toLocaleString()}원</strong>
              {' → '}다음 매수가: <strong>{Math.round(local.bottomPrice * 0.9).toLocaleString()}원</strong>
            </>
          )}
        </div>
      )}
      {local.totalQuantity > 0 && effectiveBuys.length === 0 && (
        <div className={styles.alertOrange}>
          ⚠️ <strong>매수 기록 불완전</strong> — 매수 내역을 확인할 수 없습니다.
          <br />
          기본정보 수정에서 체결 차수의 <strong>체결일·체결가·체결수량</strong>을 입력하면 이 경고가 사라집니다.
        </div>
      )}

      {/* 다음 액션 배너 (매매 판단 최우선) */}
      {(() => {
        const nextBuy = local.buyPlans.find((b) => !b.filled);
        const nextSellForBanner = local.sellPlans.find((s, i) => !s.filled && !sellsByDate[i]);
        const buyGap = nextBuy && local.currentPrice > 0
          ? ((local.currentPrice - nextBuy.price) / nextBuy.price) * 100
          : null;
        const sellGap = nextSellForBanner && local.currentPrice > 0
          ? ((local.currentPrice - nextSellForBanner.price) / nextSellForBanner.price) * 100
          : null;
        const buyUrgent = buyGap !== null && buyGap >= 0 && buyGap <= 3;
        const sellUrgent = sellGap !== null && sellGap >= -3 && sellGap <= 0;

        if (!nextBuy && !nextSellForBanner) return null;

        return (
          <div className={styles.actionBanner}>
            {nextBuy && (
              <div className={`${styles.bannerBlock} ${styles.bannerBuy} ${buyUrgent ? styles.bannerUrgent : ''}`}>
                <div className={styles.bannerHeader}>
                  <span className={styles.bannerIcon}>🎯</span>
                  <span className={styles.bannerTitle}>다음 매수</span>
                  <span className={styles.bannerLevel}>{nextBuy.level}차</span>
                  {firstBuyRefFilled && firstBuyRefQty > 0 && firstBuyRefPrice > 0 && nextBuy.level > 1 && (
                    <span className={styles.bannerHistory}>
                      1차 <b>{firstBuyRefQty.toLocaleString()}주</b> @ <b>{firstBuyRefPrice.toLocaleString()}원</b> ✓
                    </span>
                  )}
                  <span className={styles.bannerQtyInline}>
                    {nextBuy.level}차수량 <b>{nextBuy.quantity.toLocaleString()}주</b>
                  </span>
                  {buyGap !== null && (
                    <span className={`${styles.bannerGap} ${
                      Math.abs(buyGap) <= 3 ? styles.bannerGapUrgent
                      : Math.abs(buyGap) <= 5 ? styles.bannerGapClose
                      : styles.bannerGapFar
                    }`}>
                      {buyGap >= 0 ? '+' : ''}{buyGap.toFixed(1)}%
                    </span>
                  )}
                </div>
                <div className={styles.bannerMainRow}>
                  <span className={styles.bannerPrice}>
                    {nextBuy.price.toLocaleString()}
                    <span className={styles.bannerUnit}>원</span>
                  </span>
                  <span className={styles.bannerNowPrice}>
                    현재 <b>{local.currentPrice.toLocaleString()}</b>
                    <span className={styles.bannerNowUnit}>원</span>
                  </span>
                </div>
              </div>
            )}
            {nextSellForBanner && (
              <div className={`${styles.bannerBlock} ${styles.bannerSell} ${sellUrgent ? styles.bannerUrgent : ''}`}>
                <div className={styles.bannerHeader}>
                  <span className={styles.bannerIcon}>💰</span>
                  <span className={styles.bannerTitle}>다음 매도</span>
                  <span className={styles.bannerLevel}>+{nextSellForBanner.percent}%</span>
                  {nextSellForBanner.percent >= 25 && (
                    <span className={styles.bannerManual}>수동</span>
                  )}
                  {firstSellPlan && firstSellRefQty > 0 && firstSellRefPrice > 0 && firstSellPlan.percent !== nextSellForBanner.percent && (
                    <span className={styles.bannerHistory}>
                      +{firstSellRefPercent}% <b>{firstSellRefQty.toLocaleString()}주</b> @ <b>{firstSellRefPrice.toLocaleString()}원</b> ✓
                    </span>
                  )}
                  <span className={styles.bannerQtyInline}>
                    이번 <b>{nextSellForBanner.quantity.toLocaleString()}주</b> (20%)
                  </span>
                  {sellGap !== null && (
                    <span className={`${styles.bannerGap} ${
                      Math.abs(sellGap) <= 3 ? styles.bannerGapUrgent
                      : Math.abs(sellGap) <= 5 ? styles.bannerGapClose
                      : styles.bannerGapFar
                    }`}>
                      {sellGap >= 0 ? '+' : ''}{sellGap.toFixed(1)}%
                    </span>
                  )}
                </div>
                <div className={styles.bannerMainRow}>
                  <span className={styles.bannerPrice}>
                    {nextSellForBanner.price.toLocaleString()}
                    <span className={styles.bannerUnit}>원</span>
                  </span>
                  <span className={styles.bannerNowPrice}>
                    현재 <b>{local.currentPrice.toLocaleString()}</b>
                    <span className={styles.bannerNowUnit}>원</span>
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* 룰 토글 */}
      <div className={styles.ruleToggle}>
        <span className={styles.ruleLabel}>매매 규칙:</span>
        <button
          className={`${styles.ruleBtn} ${local.rule === 'A' ? styles.ruleActive : ''}`}
          onClick={() => updateField('rule', 'A')}
        >
          룰A (매수가 -10%)
        </button>
        <button
          className={`${styles.ruleBtn} ${local.rule === 'B' ? styles.ruleBActive : ''}`}
          onClick={() => updateField('rule', 'B')}
        >
          룰B (저점 -10%)
        </button>
        {local.sellCount >= 3 && local.rule === 'A' && (
          <span className={styles.chip}>룰B 전환 가능</span>
        )}
      </div>

      {/* 통합 요약바 (평균단가 계획/실제 2줄 + 손익 금액) */}
      <div className={styles.summary}>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>평균단가</span>
          {avgPriceDiffers ? (
            <>
              <span className={styles.summaryValueSmall} style={{ color: '#888' }}>
                계획 {local.avgPrice.toLocaleString()}
              </span>
              <span className={styles.summaryValue} style={{ color: '#d32f2f' }}>
                실제 {actualAvgPrice.toLocaleString()}
              </span>
            </>
          ) : (
            <span className={styles.summaryValue} style={{ color: '#ff9800' }}>
              {(actualAvgPrice || local.avgPrice).toLocaleString()}
            </span>
          )}
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>보유수량</span>
          <span className={styles.summaryValue}>
            {local.totalQuantity.toLocaleString()}
          </span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>평가손익</span>
          <span
            className={styles.summaryValue}
            style={{ color: profitPercent >= 0 ? '#d32f2f' : '#1565c0' }}
          >
            {profitPercent >= 0 ? '+' : ''}{profitPercent.toFixed(2)}%
          </span>
          {profitAmount !== 0 && (
            <span className={styles.summarySubValue}
              style={{ color: profitAmount >= 0 ? '#d32f2f' : '#1565c0' }}>
              {profitAmount >= 0 ? '+' : ''}{Math.round(profitAmount).toLocaleString()}원
            </span>
          )}
          {avgPriceDiffers && (
            <span className={styles.summarySubValue} style={{ color: '#888', fontSize: '10px' }}>
              실제 {actualProfitPercent >= 0 ? '+' : ''}{actualProfitPercent.toFixed(1)}%
            </span>
          )}
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>진입차수</span>
          <span className={styles.summaryValue}>{filledBuys}차</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>매도횟수</span>
          <span className={styles.summaryValue}>{local.sellCount}회</span>
        </div>
      </div>

      {/* 이동평균선 표시 */}
      {local.currentPrice > 0 && (local.ma20 || local.ma60 || local.ma120) && (
        <div className={styles.maBar}>
          {([
            { label: 'MA20', val: local.ma20 },
            { label: 'MA60', val: local.ma60 },
            { label: 'MA120', val: local.ma120 },
          ] as { label: string; val?: number }[])
            .filter((m) => (m.val ?? 0) > 0)
            .map((m) => {
              const gap = (((local.currentPrice - (m.val ?? 0)) / (m.val ?? 1)) * 100);
              const isNear = Math.abs(gap) <= 4;
              const isAbove = gap >= 0;
              return (
                <div
                  key={m.label}
                  className={`${styles.maChip} ${isNear ? (isAbove ? styles.maChipNearAbove : styles.maChipNearBelow) : ''}`}
                >
                  <span className={styles.maChipLabel}>{m.label}</span>
                  <span className={styles.maChipPrice}>{(m.val ?? 0).toLocaleString()}</span>
                  <span
                    className={styles.maChipGap}
                    style={{ color: isAbove ? '#c62828' : '#1565c0' }}
                  >
                    {isAbove ? '+' : ''}{gap.toFixed(1)}%
                  </span>
                </div>
              );
            })}
          {local.maCalcDate && (
            <span className={styles.maCalcDate}>{local.maCalcDate} 기준</span>
          )}
        </div>
      )}

      {/* 기본 정보 (접이식) */}
      <div className={styles.card}>
        <div
          className={styles.collapseHeader}
          onClick={() => {
            if (!showBasicInfo) openBasicEdit();
            else { setShowBasicInfo(false); setEditDraft(null); }
          }}
        >
          <span className={styles.collapseArrow}>{showBasicInfo ? '▼' : '▶'}</span>
          <h3 className={styles.cardTitleInline}>기본 정보 수정</h3>
          <span className={styles.collapseHint}>
            {showBasicInfo ? '' : '매수가 · 수량 · 현재가 (차수별 수정)'}
          </span>
        </div>

        {showBasicInfo && editDraft && (
          <div style={{ marginTop: 12 }}>
            {/* 차수별 매수가/수량 테이블 */}
            <table className={styles.editDraftTable}>
              <thead>
                <tr>
                  <th>차수</th>
                  <th>계획가</th>
                  <th>계획수량</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {local.buyPlans.map((bp, i) => (
                  <>
                    {/* 메인 행: 계획가 / 계획수량 */}
                    <tr key={`main-${i}`} className={bp.filled ? styles.editFilledRow : ''}>
                      <td className={styles.editLevelCell}>
                        <span className={styles.editLevelBadge}>{bp.level}차</span>
                        {bp.filled && <span className={styles.editFilledBadge}>체결</span>}
                      </td>
                      <td>
                        <input
                          type="number"
                          className={styles.editDraftInput}
                          value={editDraft.prices[i] || ''}
                          placeholder="계획가"
                          readOnly={bp.filled}
                          onChange={(e) => handleDraftPrice(i, Number(e.target.value))}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className={styles.editDraftInput}
                          value={editDraft.quantities[i] || ''}
                          placeholder="수량"
                          onChange={(e) => handleDraftQty(i, Number(e.target.value))}
                        />
                      </td>
                      <td className={styles.editPricePreview}>
                        {!bp.filled && editDraft.prices[i] > 0 && (
                          <span>{editDraft.prices[i].toLocaleString()}원</span>
                        )}
                      </td>
                    </tr>
                    {/* 서브 행: 모든 차수에 체결정보 입력 가능
                        — 미체결 차수도 체결가+체결수량 입력 시 자동으로 체결 처리됨 */}
                    <tr key={`fill-${i}`} className={`${styles.editFillDataRow} ${!bp.filled ? styles.editFillDataRowUnfilled : ''}`}>
                      <td colSpan={4}>
                        <div className={styles.editFillDataInner}>
                          <span className={styles.editFillDataLabel}>
                            {bp.filled ? '체결 정보' : '체결 정보 (입력 시 자동 체결 처리)'}
                          </span>
                          <div className={styles.editFillDataField}>
                            <label>체결일</label>
                            <input
                              type="date"
                              className={styles.editDraftInput}
                              value={editDraft.filledDates[i] || ''}
                              onChange={(e) => handleDraftFillDate(i, e.target.value)}
                            />
                          </div>
                          <div className={styles.editFillDataField}>
                            <label>체결가</label>
                            <input
                              type="number"
                              className={styles.editDraftInput}
                              value={editDraft.filledPrices[i] || ''}
                              placeholder="실제 체결가"
                              onChange={(e) => handleDraftFillPrice(i, Number(e.target.value))}
                            />
                          </div>
                          <div className={styles.editFillDataField}>
                            <label>체결수량</label>
                            <input
                              type="number"
                              className={styles.editDraftInput}
                              value={editDraft.filledQtys[i] || ''}
                              placeholder="실제 수량"
                              onChange={(e) => handleDraftFillQty(i, Number(e.target.value))}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  </>
                ))}
              </tbody>
            </table>

            {/* 현재가 */}
            <div className={styles.editCurrentRow}>
              <label className={styles.editCurrentLabel}>현재가</label>
              <input
                type="number"
                className={styles.editDraftInput}
                value={editDraft.currentPrice || ''}
                placeholder="현재가"
                onChange={(e) => setEditDraft({ ...editDraft, currentPrice: Number(e.target.value) })}
              />
            </div>

            {/* 안내 메시지 */}
            <p className={styles.editHint}>
              💡 체결 차수: 체결일·체결가·체결수량 입력 시 매수 기록 불완전 경고가 사라집니다.
            </p>

            {/* 버튼 */}
            <div className={styles.editActionRow}>
              <button className={styles.editConfirmBtn} onClick={confirmBasicEdit}>
                수정 완료
              </button>
              <button
                className={styles.editCancelBtn}
                onClick={() => { setEditDraft(null); setShowBasicInfo(false); }}
              >
                취소
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 매수 / 수익매도 계획 — 나란히 */}
      <div className={styles.plansRow}>

        {/* 매수 계획 */}
        <div className={`${styles.card} ${styles.planCard}`}>
          <div className={styles.planCardHeader}>
            <h3 className={styles.cardTitle} style={{ color: '#d32f2f', margin: 0 }}>매수 계획</h3>
            {(() => {
              let cnt = 0, qty = 0, amt = 0;
              local.buyPlans.forEach((bp, i) => {
                if (!bp.filled) return;
                const act = buysByDate[i];
                const q = act ? act.qty : (bp.filledQuantity || bp.quantity);
                const p = act ? Math.round(act.amt / act.qty) : (bp.filledPrice || bp.price);
                cnt++; qty += q; amt += q * p;
              });
              if (cnt === 0) return null;
              return (
                <span className={styles.planStatsBuy}>
                  {cnt}차 · {qty.toLocaleString()}주 · {Math.round(amt / 10000).toLocaleString()}만원 투입
                </span>
              );
            })()}
          </div>
          <table className={styles.planTableCompact}>
            <tbody>
              {(() => {
                let cumQty = 0;
                return local.buyPlans.map((bp, i) => {
                  const actual = buysByDate[i];
                  const realPrice = actual ? Math.round(actual.amt / actual.qty) : bp.filledPrice || 0;
                  const realQty = actual ? actual.qty : bp.filledQuantity || 0;
                  const realDate = actual?.date || bp.filledDate || '';
                  const nearInfo = !bp.filled ? getNearInfo(bp.price) : null;
                  const thisQty = bp.filled ? (realQty || bp.quantity) : bp.quantity;
                  cumQty += thisQty;
                  return (
                    <tr
                      key={i}
                      className={`${bp.filled ? styles.filledRow : ''} ${nearInfo ? styles.nearbyBuyRow : ''}`}
                      style={!nearInfo && i === nextBuyIdx && !bp.filled ? { background: '#fffde7' } : undefined}
                    >
                      {/* 차수 + 날짜 */}
                      <td className={styles.levelCell}>
                        <span className={styles.levelBadge}>{bp.level}차</span>
                        {i === nextBuyIdx && !bp.filled && (
                          <span className={styles.nextChip}>다음</span>
                        )}
                        {nearInfo && (
                          <span className={`${styles.nearbyBuyChip} ${
                            nearInfo.urgency === 3 ? styles.chipUrgency3 : nearInfo.urgency === 2 ? styles.chipUrgency2 : styles.chipUrgency1
                          }`}>
                            {nearInfo.gap >= 0 ? '+' : ''}{nearInfo.gap.toFixed(1)}%
                          </span>
                        )}
                        {bp.filled && realDate && (
                          <div className={styles.dateUnder}>
                            <input
                              type="date"
                              className={styles.dateInputCompact}
                              value={realDate}
                              onChange={(e) => {
                                const plans = [...local.buyPlans];
                                plans[i] = { ...plans[i], filledDate: e.target.value };
                                update({ buyPlans: plans });
                              }}
                            />
                          </div>
                        )}
                        {!bp.filled && !realDate && <div className={styles.dateUnder} style={{ color: '#ccc' }}>-</div>}
                      </td>
                      {/* 계획가 */}
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>계획가</span>
                        <span className={i === nextBuyIdx && !bp.filled ? styles.nextBuyPrice : styles.planPrice}>
                          {bp.price.toLocaleString()}
                        </span>
                        {i === nextBuyIdx && !bp.filled && local.currentPrice > 0 && (
                          <span className={`${styles.currentPriceTag} ${nearInfo?.urgency === 3 ? styles.priceTagUrgentBuy : ''}`}>
                            현재 {local.currentPrice.toLocaleString()}
                            <span className={styles.priceGap}>{priceGapText(bp.price)}</span>
                          </span>
                        )}
                      </td>
                      {/* 실제가 */}
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>실제가</span>
                        {bp.filled && realPrice > 0
                          ? <span className={styles.actualPrice}>{realPrice.toLocaleString()}</span>
                          : <span className={styles.dashText}>-</span>}
                      </td>
                      {/* 수량 + 누적 */}
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>수량</span>
                        <span className={bp.filled ? styles.filledQty : styles.plannedQty}>
                          {(bp.filled ? (realQty || bp.quantity) : bp.quantity).toLocaleString()}
                        </span>
                        <span className={styles.cumulativeQty} style={{ color: bp.filled ? '#1565c0' : '#bbb' }}>
                          {bp.filled ? `누적 ${cumQty.toLocaleString()}주` : `전체 ${cumQty.toLocaleString()}주`}
                        </span>
                      </td>
                      {/* 체결 버튼 */}
                      <td className={styles.btnCell}>
                        <button
                          className={`${styles.fillBtn} ${bp.filled ? styles.fillBtnActive : ''}`}
                          onClick={() => toggleBuyFilled(i)}
                        >
                          {bp.filled ? '체결' : '미체결'}
                        </button>
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>

        {/* 수익 매도 계획 */}
        <div className={`${styles.card} ${styles.planCard}`}>
          <div className={styles.planCardHeader}>
            <h3 className={styles.cardTitle} style={{ color: '#1565c0', margin: 0 }}>수익 매도 계획</h3>
            {(() => {
              let cnt = 0, qty = 0, amt = 0;
              local.sellPlans.forEach((sp, i) => {
                const act = sellsByDate[i];
                if (!sp.filled && !act) return;
                const q = act ? act.qty : (sp.filledQuantity || sp.quantity);
                const p = act ? Math.round(act.amt / act.qty) : (sp.filledPrice || sp.price);
                cnt++; qty += q; amt += q * p;
              });
              const totalBoughtH = local.buyPlans.reduce((s, bp) => bp.filled ? s + (bp.filledQuantity || bp.quantity) : s, 0);
              const maSoldH = local.maSells.reduce((s, ms) => ms.filled ? s + ms.quantity : s, 0);
              const remQty = Math.max(0, totalBoughtH - qty - maSoldH);
              return (
                <span className={styles.planStatsSell}>
                  {cnt > 0 ? `${cnt}회 · ${qty.toLocaleString()}주 · ${Math.round(amt / 10000).toLocaleString()}만원 회수` : '매도 없음'}
                  {totalBoughtH > 0 && ` · 잔여 ${remQty.toLocaleString()}주`}
                </span>
              );
            })()}
          </div>
          <table className={styles.planTableCompact}>
            <tbody>
              {(() => {
                const totalBought = local.buyPlans.reduce((sum, bp) => {
                  if (!bp.filled) return sum;
                  return sum + (bp.filledQuantity || bp.quantity);
                }, 0);
                const maSold = local.maSells.reduce((sum, ms) => ms.filled ? sum + ms.quantity : sum, 0);
                let remaining = totalBought - maSold;

                // MA 행 렌더 헬퍼
                const renderMARow = (m: typeof local.maSells[0], mi: number) => {
                  const profit = local.avgPrice > 0 && m.price > 0
                    ? ((m.price - local.avgPrice) / local.avgPrice) * 100 : null;
                  const shortD = m.filledDate ? m.filledDate.slice(5) : '';
                  return (
                    <tr key={`ma-${mi}`} className={styles.maInsertedRow}>
                      <td className={styles.levelCell}>
                        <span className={styles.maInsertedBadge}>MA{m.ma}</span>
                        {shortD && <div className={styles.dateUnder}>{shortD}</div>}
                      </td>
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>MA가</span>
                        <span className={styles.dashText}>-</span>
                      </td>
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>실제가</span>
                        <span className={styles.actualPrice} style={{ color: '#ff9800' }}>
                          {m.price.toLocaleString()}
                        </span>
                        {profit !== null && (
                          <span className={styles.profitUnder} style={{ color: profit >= 0 ? '#4caf50' : '#f44336' }}>
                            {profit >= 0 ? '+' : ''}{profit.toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>수량</span>
                        <span className={styles.filledQty} style={{ color: '#ff9800' }}>{m.quantity.toLocaleString()}</span>
                        <span className={styles.cumulativeQty}>MA 매도</span>
                      </td>
                      <td className={styles.btnCell}>
                        {m.splitFromPercent !== undefined && (
                          <button
                            className={styles.maRestoreBtn}
                            onClick={() => restoreMAToSell(mi)}
                            title={`+${m.splitFromPercent}% 차수로 복원`}
                          >
                            ↩️
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                };

                const rows: any[] = [];

                // [insertAfterPercent === 0] 1차 이전 MA 매도
                local.maSells.forEach((m, mi) => {
                  if (m.filled && m.insertAfterPercent === 0) {
                    rows.push(renderMARow(m, mi));
                  }
                });

                local.sellPlans.forEach((sp, i) => {
                  // manualOverride: sp 값 우선 (분리/편집 보호)
                  const useSpOnly = sp.manualOverride === true;
                  const actual = useSpOnly ? null : sellsByDate[i];
                  const realPrice = actual ? Math.round(actual.amt / actual.qty) : sp.filledPrice || 0;
                  const realQty = actual ? actual.qty : sp.filledQuantity || 0;
                  const realDate = actual?.date || sp.filledDate || '';
                  const isFilled = sp.filled || !!actual;
                  const realProfit = isFilled && local.avgPrice > 0 && realPrice > 0
                    ? ((realPrice - local.avgPrice) / local.avgPrice) * 100 : null;
                  const metTarget = isFilled && realPrice >= sp.price;
                  const sellNearInfo = !isFilled ? getNearInfo(sp.price) : null;
                  const soldThisRound = isFilled ? (realQty || sp.quantity) : 0;
                  remaining -= soldThisRound;
                  const remainingAfter = Math.max(0, remaining);
                  const shortDate = realDate ? realDate.slice(5) : '';

                  rows.push(
                    <tr key={i} className={`${isFilled ? styles.sellFilledRow : ''} ${sellNearInfo ? styles.nearbySellRow : ''}`}>
                      {/* 목표% + 날짜 */}
                      <td className={styles.levelCell}>
                        <span className={styles.levelBadge} style={{ color: '#1565c0' }}>+{sp.percent}%</span>
                        {sp.percent >= 25 && (
                          <span className={styles.manualSellBadge}>수동</span>
                        )}
                        {sellNearInfo && (
                          <span className={`${styles.nearbySellChip} ${
                            sellNearInfo.urgency === 3 ? styles.chipUrgency3 : sellNearInfo.urgency === 2 ? styles.chipUrgency2 : styles.chipUrgency1
                          }`}>
                            {sellNearInfo.gap >= 0 ? '+' : ''}{sellNearInfo.gap.toFixed(1)}%
                          </span>
                        )}
                        {isFilled && shortDate && (
                          <div className={styles.dateUnder}>{shortDate}</div>
                        )}
                        {!isFilled && <div className={styles.dateUnder} style={{ color: '#ccc' }}>-</div>}
                      </td>
                      {/* 목표가 */}
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>목표가</span>
                        <span className={i === nextSellIdx && !isFilled ? styles.nextSellPrice : styles.planPrice}>
                          {sp.price.toLocaleString()}
                        </span>
                        {i === nextSellIdx && !isFilled && local.currentPrice > 0 && (
                          <span className={`${styles.currentPriceTag} ${sellNearInfo?.urgency === 3 ? styles.priceTagUrgentSell : ''}`}>
                            현재 {local.currentPrice.toLocaleString()}
                            <span className={styles.priceGap}>{priceGapText(sp.price)}</span>
                          </span>
                        )}
                      </td>
                      {/* 실제가 + 수익률 */}
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>실제가</span>
                        {isFilled && realPrice > 0 ? (
                          <>
                            <span
                              className={styles.actualPrice}
                              style={{ color: metTarget ? '#1565c0' : '#ff9800' }}
                              title={metTarget ? '목표 달성' : '목표 미달 매도'}
                            >
                              {!metTarget && <span className={styles.undershotIcon}>⚠️</span>}
                              {realPrice.toLocaleString()}
                            </span>
                            {realProfit !== null && (
                              <span className={styles.profitUnder} style={{ color: realProfit >= 0 ? '#4caf50' : '#f44336' }}>
                                {realProfit >= 0 ? '+' : ''}{realProfit.toFixed(1)}%
                              </span>
                            )}
                          </>
                        ) : <span className={styles.dashText}>-</span>}
                      </td>
                      {/* 수량 + 잔여 */}
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>수량</span>
                        {isFilled
                          ? <span className={styles.filledQty}>{(realQty || sp.quantity).toLocaleString()}</span>
                          : <span className={styles.plannedQty}>{sp.quantity.toLocaleString()}</span>}
                        <span className={styles.cumulativeQty} style={{ color: remainingAfter <= 0 && isFilled ? '#f44336' : '#888' }}>
                          {isFilled
                            ? `잔여 ${remainingAfter.toLocaleString()}`
                            : (remaining + soldThisRound > 0 ? `잔여 ${(remaining + soldThisRound).toLocaleString()}` : '-')}
                        </span>
                      </td>
                      {/* 체결 + MA버튼 + 수동편집 */}
                      <td className={styles.btnCell}>
                        <button
                          className={`${styles.fillBtn} ${isFilled ? styles.sellBtnActive : ''}`}
                          onClick={() => toggleSellFilled(i)}
                        >
                          {isFilled ? '체결' : '미체결'}
                        </button>
                        {isFilled && (sp.filledQuantity || 0) > 0 && sellEditIdx !== i && splitIdx !== i && (
                          <button className={styles.splitBtn} onClick={() => openSplitToMA(i)} title="이 차수의 일부/전체를 MA 매도로 분리">🔀 MA</button>
                        )}
                        {sellEditIdx !== i && splitIdx !== i && (
                          <button className={styles.sellEditBtn} onClick={() => openSellEdit(i)}>✏️</button>
                        )}
                        {sp.manualOverride && sellEditIdx !== i && splitIdx !== i && (
                          <span className={styles.manualOverrideBadge} title="수동 편집됨 (sync 보호)">수동</span>
                        )}
                        {sellEditIdx === i && sellEditDraft && (
                          <div className={styles.sellEditPopup}>
                            <div className={styles.sellEditRow}>
                              <label className={styles.sellEditLabel}>날짜</label>
                              <input
                                type="date"
                                className={styles.sellEditInput}
                                value={sellEditDraft.date}
                                onChange={(e) => setSellEditDraft({ ...sellEditDraft, date: e.target.value })}
                              />
                            </div>
                            <div className={styles.sellEditRow}>
                              <label className={styles.sellEditLabel}>체결가</label>
                              <input
                                type="number"
                                className={styles.sellEditInput}
                                value={sellEditDraft.price || ''}
                                onChange={(e) => setSellEditDraft({ ...sellEditDraft, price: Number(e.target.value) })}
                              />
                            </div>
                            <div className={styles.sellEditRow}>
                              <label className={styles.sellEditLabel}>수량</label>
                              <input
                                type="number"
                                className={styles.sellEditInput}
                                value={sellEditDraft.qty || ''}
                                onChange={(e) => setSellEditDraft({ ...sellEditDraft, qty: Number(e.target.value) })}
                              />
                            </div>
                            <div className={styles.sellEditActions}>
                              <button className={styles.sellEditSave} onClick={confirmSellEdit}>저장</button>
                              <button className={styles.sellEditCancel} onClick={() => { setSellEditIdx(null); setSellEditDraft(null); }}>취소</button>
                              {sp.manualOverride && (
                                <button className={styles.sellEditReset} onClick={() => { clearSellOverride(i); setSellEditIdx(null); setSellEditDraft(null); }}>수동해제</button>
                              )}
                            </div>
                          </div>
                        )}
                        {splitIdx === i && splitDraft && (
                          <div className={styles.splitPopup}>
                            <div className={styles.splitTitle}>
                              🔀 MA 매도로 분리 (현재 +{sp.percent}% 차수)
                            </div>
                            <div className={styles.sellEditRow}>
                              <label className={styles.sellEditLabel}>이평선</label>
                              <div className={styles.maRadioGroup}>
                                {[20, 60, 120].map((d) => (
                                  <button
                                    key={d}
                                    className={`${styles.maRadioBtn} ${splitDraft.ma === d ? styles.maRadioBtnActive : ''}`}
                                    onClick={() => setSplitDraft({ ...splitDraft, ma: d })}
                                  >
                                    MA{d}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className={styles.sellEditRow}>
                              <label className={styles.sellEditLabel}>날짜</label>
                              <input
                                type="date"
                                className={styles.sellEditInput}
                                value={splitDraft.date}
                                onChange={(e) => setSplitDraft({ ...splitDraft, date: e.target.value })}
                              />
                            </div>
                            <div className={styles.sellEditRow}>
                              <label className={styles.sellEditLabel}>체결가</label>
                              <input
                                type="number"
                                className={styles.sellEditInput}
                                value={splitDraft.price || ''}
                                onChange={(e) => setSplitDraft({ ...splitDraft, price: Number(e.target.value) })}
                              />
                            </div>
                            <div className={styles.sellEditRow}>
                              <label className={styles.sellEditLabel}>분리 수량</label>
                              <input
                                type="number"
                                className={styles.sellEditInput}
                                value={splitDraft.qty || ''}
                                max={sp.filledQuantity || 0}
                                onChange={(e) => setSplitDraft({ ...splitDraft, qty: Number(e.target.value) })}
                              />
                            </div>
                            <div className={styles.splitHint}>
                              현재 체결 {(sp.filledQuantity || 0).toLocaleString()}주 → 분리 후 +{sp.percent}%에 {((sp.filledQuantity || 0) - splitDraft.qty).toLocaleString()}주 남음
                            </div>
                            <div className={styles.sellEditActions}>
                              <button className={styles.sellEditSave} onClick={confirmSplitToMA}>분리 실행</button>
                              <button className={styles.sellEditCancel} onClick={() => { setSplitIdx(null); setSplitDraft(null); }}>취소</button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );

                  // 이 sellPlan 다음에 끼어드는 MA 매도들
                  local.maSells.forEach((m, mi) => {
                    if (m.filled && m.insertAfterPercent === sp.percent) {
                      rows.push(renderMARow(m, mi));
                    }
                  });
                });
                return rows;
              })()}
            </tbody>
          </table>
          <div className={styles.sellNote}>
            누적 매도: {sellsIndividual.length}회 ({actualSells.length}건)
            {sellsIndividual.length >= 3 && <span className={styles.chip}>룰B 전환 가능</span>}
          </div>
        </div>

      </div>{/* /plansRow */}

      {/* 이동평균선 매도 */}
      <div className={styles.card} style={{ borderLeft: '3px solid #ff9800' }}>
        <h3 className={styles.cardTitle} style={{ color: '#ff9800' }}>
          이동평균선 매도
        </h3>
        <p className={styles.maWarning}>
          손실이어도 매도 원칙! (이동평균선 도달 시 반드시 매도)
        </p>
        <table className={styles.planTable}>
          <thead>
            <tr>
              <th>이평선</th>
              <th>가격</th>
              <th>수량</th>
              <th>손익%</th>
              <th>체결</th>
            </tr>
          </thead>
          <tbody>
            {local.maSells.map((ms, i) => {
              const maProfit =
                local.avgPrice > 0
                  ? ((ms.price - local.avgPrice) / local.avgPrice) * 100
                  : 0;
              const maNearInfo = !ms.filled && ms.price > 0 ? getNearInfo(ms.price) : null;
              return (
                <tr key={i} className={`${ms.filled ? styles.maFilledRow : ''} ${maNearInfo ? styles.nearbySellRow : ''}`}>
                  <td>
                    {ms.ma}일선
                    {maNearInfo && (
                      <span className={`${styles.nearbySellChip} ${
                        maNearInfo.urgency === 3 ? styles.chipUrgency3 : maNearInfo.urgency === 2 ? styles.chipUrgency2 : styles.chipUrgency1
                      }`}>
                        {maNearInfo.gap >= 0 ? '+' : ''}{maNearInfo.gap.toFixed(1)}%
                      </span>
                    )}
                    {ms.fromSellPlan && (
                      <span className={styles.maFromBadge}>+{local.sellPlans[ms.fromSellPlan - 1]?.percent}%에서 이동</span>
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      className={styles.maInput}
                      value={ms.price || ''}
                      onChange={(e) => updateMAPrice(i, Number(e.target.value))}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      className={styles.maInput}
                      value={ms.quantity || ''}
                      onChange={(e) => updateMAQty(i, Number(e.target.value))}
                    />
                  </td>
                  <td
                    className={styles.numCell}
                    style={{ color: maProfit >= 0 ? '#4caf50' : '#f44336' }}
                  >
                    {ms.price > 0 && local.avgPrice > 0
                      ? `${maProfit.toFixed(2)}%`
                      : '-'}
                  </td>
                  <td>
                    <button
                      className={`${styles.fillBtn} ${ms.filled ? styles.maBtnActive : ''}`}
                      onClick={() => toggleMAFilled(i)}
                    >
                      {ms.filled ? '체결' : '미체결'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 수익 추이 차트 */}
      {stockSnapshots.length > 0 && (
        <div className={styles.card}>
          <h3 className={styles.cardTitle}>수익 추이</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={stockSnapshots}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" fontSize={12} />
              <YAxis
                fontSize={12}
                tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
              />
              <Tooltip
                formatter={(v) => [`${Number(v).toFixed(2)}%`, '수익률']}
              />
              <Line
                type="monotone"
                dataKey="profitPercent"
                stroke="#4a90d9"
                strokeWidth={2}
                dot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

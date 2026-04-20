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
  const [maSelectIdx, setMaSelectIdx] = useState<number | null>(null);
  const [showBasicInfo, setShowBasicInfo] = useState(false);

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
    const finalBuyPlans = base.buyPlans.map((bp, i) => ({
      ...bp,
      price: editDraft.prices[i] > 0 ? editDraft.prices[i] : bp.price,
      quantity: editDraft.quantities[i] > 0 ? editDraft.quantities[i] : bp.quantity,
      // 체결 차수만 체결 정보 저장
      ...(bp.filled && {
        filledDate: editDraft.filledDates[i],
        filledPrice: editDraft.filledPrices[i],
        filledQuantity: editDraft.filledQtys[i],
      }),
    }));
    const final: Stock = { ...base, buyPlans: finalBuyPlans, updatedAt: Date.now() };
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

  // 수익매도 → 이동평균선 매도로 이동 (sellsByDate는 렌더 시점에 참조)
  const moveToMA = (sellIdx: number, maDay: number, actualData?: { price: number; qty: number; date: string }) => {
    const sp = local.sellPlans[sellIdx];
    const price = actualData?.price || sp.price;
    const qty = actualData?.qty || sp.quantity;
    const date = actualData?.date || sp.filledDate || '';

    // 해당 이평선 찾아서 업데이트
    const ma = [...local.maSells];
    const maIdx = ma.findIndex((m) => m.ma === maDay);
    if (maIdx >= 0) {
      ma[maIdx] = { ...ma[maIdx], price, quantity: qty, filled: true, filledDate: date, fromSellPlan: sellIdx + 1 };
    }

    // 수익매도에서 체결 해제
    const sells = [...local.sellPlans];
    sells[sellIdx] = { ...sells[sellIdx], filled: false };

    update({ sellPlans: sells, maSells: ma });
    setMaSelectIdx(null);
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
  const syntheticBuys: Trade[] = local.buyPlans
    .filter((bp) => bp.filled && bp.filledDate && bp.filledPrice && bp.filledQuantity)
    .map((bp) => ({
      id: `synthetic-${local.id}-${bp.level}`,
      date: bp.filledDate!,
      stockName: local.name,
      type: 'buy' as const,
      price: bp.filledPrice!,
      quantity: bp.filledQuantity!,
      memo: `${bp.level}차 매수 (계획 기반)`,
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

  // 매도를 날짜별로 그룹핑
  const sellsByDate: { date: string; qty: number; amt: number; trades: Trade[] }[] = [];
  const sellDateMap: Record<string, { qty: number; amt: number; trades: Trade[] }> = {};
  for (const s of actualSells) {
    if (!sellDateMap[s.date]) sellDateMap[s.date] = { qty: 0, amt: 0, trades: [] };
    sellDateMap[s.date].qty += s.quantity;
    sellDateMap[s.date].amt += s.price * s.quantity;
    sellDateMap[s.date].trades.push(s);
  }
  Object.keys(sellDateMap).sort().forEach((d) => {
    sellsByDate.push({ date: d, ...sellDateMap[d] });
  });

  // 다음 매도 차수 인덱스
  const nextSellIdx = local.sellPlans.findIndex((s, i) => !s.filled && !sellsByDate[i]);

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
                    {/* 서브 행: 체결 차수만 — 체결일 / 체결가 / 체결수량 */}
                    {bp.filled && (
                      <tr key={`fill-${i}`} className={styles.editFillDataRow}>
                        <td colSpan={4}>
                          <div className={styles.editFillDataInner}>
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
                    )}
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

                return local.sellPlans.map((sp, i) => {
                  const actual = sellsByDate[i];
                  const realPrice = actual ? Math.round(actual.amt / actual.qty) : sp.filledPrice || 0;
                  const realQty = actual ? actual.qty : sp.filledQuantity || 0;
                  const realDate = actual?.date || sp.filledDate || '';
                  const realProfit = (sp.filled || actual) && local.avgPrice > 0 && realPrice > 0
                    ? ((realPrice - local.avgPrice) / local.avgPrice) * 100 : null;
                  const metTarget = (sp.filled || actual) && realPrice >= sp.price;
                  const sellNearInfo = !sp.filled && !actual ? getNearInfo(sp.price) : null;
                  const soldThisRound = (sp.filled || actual) ? (realQty || sp.quantity) : 0;
                  remaining -= soldThisRound;
                  const remainingAfter = Math.max(0, remaining);
                  const shortDate = realDate ? realDate.slice(5) : '';

                  return (
                    <tr key={i} className={`${sp.filled || actual ? styles.sellFilledRow : ''} ${sellNearInfo ? styles.nearbySellRow : ''}`}>
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
                        {(sp.filled || actual) && shortDate && (
                          <div className={styles.dateUnder}>{shortDate}</div>
                        )}
                        {!(sp.filled || actual) && <div className={styles.dateUnder} style={{ color: '#ccc' }}>-</div>}
                      </td>
                      {/* 목표가 */}
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>목표가</span>
                        <span className={i === nextSellIdx && !sp.filled && !actual ? styles.nextSellPrice : styles.planPrice}>
                          {sp.price.toLocaleString()}
                        </span>
                        {i === nextSellIdx && !sp.filled && !actual && local.currentPrice > 0 && (
                          <span className={`${styles.currentPriceTag} ${sellNearInfo?.urgency === 3 ? styles.priceTagUrgentSell : ''}`}>
                            현재 {local.currentPrice.toLocaleString()}
                            <span className={styles.priceGap}>{priceGapText(sp.price)}</span>
                          </span>
                        )}
                      </td>
                      {/* 실제가 + 수익률 */}
                      <td className={styles.numCell}>
                        <span className={styles.colLabel}>실제가</span>
                        {(sp.filled || actual) && realPrice > 0 ? (
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
                        {(sp.filled || actual)
                          ? <span className={styles.filledQty}>{(realQty || sp.quantity).toLocaleString()}</span>
                          : <span className={styles.plannedQty}>{sp.quantity.toLocaleString()}</span>}
                        <span className={styles.cumulativeQty} style={{ color: remainingAfter <= 0 && (sp.filled || actual) ? '#f44336' : '#888' }}>
                          {(sp.filled || actual)
                            ? `잔여 ${remainingAfter.toLocaleString()}`
                            : (remaining + soldThisRound > 0 ? `잔여 ${(remaining + soldThisRound).toLocaleString()}` : '-')}
                        </span>
                      </td>
                      {/* 체결 + MA버튼 */}
                      <td className={styles.btnCell}>
                        <button
                          className={`${styles.fillBtn} ${sp.filled || actual ? styles.sellBtnActive : ''}`}
                          onClick={() => toggleSellFilled(i)}
                        >
                          {sp.filled || actual ? '체결' : '미체결'}
                        </button>
                        {(sp.filled || actual) && maSelectIdx !== i && (
                          <button className={styles.maTransferBtn} onClick={() => setMaSelectIdx(i)}>MA</button>
                        )}
                        {maSelectIdx === i && (
                          <div className={styles.maSelectPopup}>
                            <span className={styles.maSelectLabel}>이평선:</span>
                            {[20, 60, 120].map((d) => (
                              <button key={d} className={styles.maSelectBtn}
                                onClick={() => moveToMA(i, d, actual ? { price: Math.round(actual.amt / actual.qty), qty: actual.qty, date: actual.date } : undefined)}>
                                {d}일
                              </button>
                            ))}
                            <button className={styles.maSelectCancel} onClick={() => setMaSelectIdx(null)}>취소</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
          <div className={styles.sellNote}>
            누적 매도: {sellsByDate.length}회 ({actualSells.length}건)
            {sellsByDate.length >= 3 && <span className={styles.chip}>룰B 전환 가능</span>}
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

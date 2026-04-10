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

  // 매수를 날짜별로 그룹핑
  const buysByDate: { date: string; qty: number; amt: number }[] = [];
  const buyDateMap: Record<string, { qty: number; amt: number }> = {};
  for (const b of actualBuys) {
    if (!buyDateMap[b.date]) buyDateMap[b.date] = { qty: 0, amt: 0 };
    buyDateMap[b.date].qty += b.quantity;
    buyDateMap[b.date].amt += b.price * b.quantity;
  }
  Object.keys(buyDateMap).sort().forEach((d) => {
    buysByDate.push({ date: d, ...buyDateMap[d] });
  });

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

  return (
    <div className={styles.container}>
      {/* 헤더 */}
      <div className={styles.header}>
        <h2 className={styles.title}>{local.name}</h2>
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
        </div>
      )}

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

      {/* 기본 입력 */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>기본 정보</h3>
        <div className={styles.inputGrid}>
          <label>
            1차 매수가
            <input
              type="number"
              value={local.firstBuyPrice || ''}
              onChange={(e) =>
                updateField('firstBuyPrice', Number(e.target.value))
              }
            />
          </label>
          <label>
            1차 수량
            <input
              type="number"
              value={local.firstBuyQuantity || ''}
              onChange={(e) =>
                updateField('firstBuyQuantity', Number(e.target.value))
              }
            />
          </label>
          <label>
            현재가
            <input
              type="number"
              value={local.currentPrice || ''}
              onChange={(e) =>
                updateField('currentPrice', Number(e.target.value))
              }
            />
          </label>
          <label>
            평균단가
            <input type="text" value={local.avgPrice.toLocaleString()} readOnly />
          </label>
        </div>
      </div>

      {/* 요약바 */}
      <div className={styles.summary}>
        <div className={styles.summaryItem}>
          <span className={styles.summaryLabel}>평균단가</span>
          <span className={styles.summaryValue} style={{ color: '#ff9800' }}>
            {local.avgPrice.toLocaleString()}
          </span>
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
            style={{ color: profitPercent >= 0 ? '#4caf50' : '#f44336' }}
          >
            {profitPercent.toFixed(2)}%
          </span>
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

      {/* 매수 계획 */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle} style={{ color: '#4caf50' }}>
          매수 계획
        </h3>
        <table className={styles.planTable}>
          <thead>
            <tr>
              <th>차수</th>
              <th>계획가</th>
              <th>실제 매수가</th>
              <th>계획수량</th>
              <th>체결수량</th>
              <th>체결일</th>
              <th>체결</th>
            </tr>
          </thead>
          <tbody>
            {local.buyPlans.map((bp, i) => {
              const actual = buysByDate[i];
              // 실제 체결 데이터: 매매일지 > filledPrice/filledQuantity > plan 기본값
              const realPrice = actual ? Math.round(actual.amt / actual.qty) : bp.filledPrice || 0;
              const realQty = actual ? actual.qty : bp.filledQuantity || 0;
              const realDate = actual?.date || bp.filledDate || '';
              const nearInfo = !bp.filled ? getNearInfo(bp.price) : null;
              return (
                <tr
                  key={i}
                  className={`${bp.filled ? styles.filledRow : ''} ${nearInfo ? styles.nearbyBuyRow : ''}`}
                  style={
                    !nearInfo && i === nextBuyIdx && !bp.filled
                      ? { background: '#fffde7' }
                      : undefined
                  }
                >
                  <td>
                    {bp.level}차
                    {i === nextBuyIdx && !bp.filled && (
                      <span className={styles.nextChip}>다음 매수</span>
                    )}
                    {nearInfo && (
                      <span className={`${styles.nearbyBuyChip} ${
                        nearInfo.urgency === 3 ? styles.chipUrgency3 : nearInfo.urgency === 2 ? styles.chipUrgency2 : styles.chipUrgency1
                      }`}>
                        매수 {nearInfo.gap >= 0 ? '+' : ''}{nearInfo.gap.toFixed(1)}%
                      </span>
                    )}
                  </td>
                  <td className={styles.numCell}>
                    {bp.price.toLocaleString()}
                    {i === nextBuyIdx && !bp.filled && local.currentPrice > 0 && (
                      <>
                        <br />
                        <span className={`${styles.currentPriceTag} ${
                          nearInfo?.urgency === 3 ? styles.priceTagUrgentBuy : ''
                        }`}>
                          현재 {local.currentPrice.toLocaleString()}
                        </span>
                        <span className={styles.priceGap}>{priceGapText(bp.price)}</span>
                      </>
                    )}
                  </td>
                  <td className={styles.numCell}>
                    {bp.filled && realPrice > 0 ? (
                      <span className={styles.actualPrice}>
                        {realPrice.toLocaleString()}
                      </span>
                    ) : '-'}
                  </td>
                  <td className={`${styles.numCell} ${styles.plannedQty}`}>
                    {bp.quantity.toLocaleString()}
                  </td>
                  <td className={styles.numCell}>
                    {bp.filled ? (
                      <span className={styles.filledQty}>
                        {(realQty || bp.quantity).toLocaleString()}
                      </span>
                    ) : (
                      <span className={styles.pendingQty}>-</span>
                    )}
                  </td>
                  <td className={styles.dateCell}>
                    {bp.filled ? (
                      <input
                        type="date"
                        className={styles.dateInput}
                        value={realDate || ''}
                        onChange={(e) => {
                          const plans = [...local.buyPlans];
                          plans[i] = { ...plans[i], filledDate: e.target.value };
                          update({ buyPlans: plans });
                        }}
                      />
                    ) : '-'}
                  </td>
                  <td>
                    <button
                      className={`${styles.fillBtn} ${bp.filled ? styles.fillBtnActive : ''}`}
                      onClick={() => toggleBuyFilled(i)}
                    >
                      {bp.filled ? '체결' : '미체결'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 수익 매도 계획 */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle} style={{ color: '#f44336' }}>
          수익 매도 계획 (20%씩 분할)
        </h3>
        <table className={styles.planTable}>
          <thead>
            <tr>
              <th>목표</th>
              <th>목표가</th>
              <th>실제 매도가</th>
              <th>계획수량</th>
              <th>체결수량</th>
              <th>잔여수량</th>
              <th>체결일</th>
              <th>실현수익률</th>
              <th>체결</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              // 잔여수량 계산: 총 매수 수량에서 매도 누적 차감
              const totalBought = local.buyPlans.reduce((sum, bp) => {
                if (!bp.filled) return sum;
                return sum + (bp.filledQuantity || bp.quantity);
              }, 0);
              // MA매도 차감
              const maSold = local.maSells.reduce((sum, ms) => ms.filled ? sum + ms.quantity : sum, 0);
              let remaining = totalBought - maSold;

              return local.sellPlans.map((sp, i) => {
                const actual = sellsByDate[i];
                const realPrice = actual ? Math.round(actual.amt / actual.qty) : sp.filledPrice || 0;
                const realQty = actual ? actual.qty : sp.filledQuantity || 0;
                const realDate = actual?.date || sp.filledDate || '';
                const realProfit = (sp.filled || actual) && local.avgPrice > 0 && realPrice > 0
                  ? ((realPrice - local.avgPrice) / local.avgPrice) * 100
                  : null;
                const metTarget = (sp.filled || actual) && realPrice >= sp.price;
                const sellNearInfo = !sp.filled && !actual ? getNearInfo(sp.price) : null;

                // 이번 매도로 차감
                const soldThisRound = (sp.filled || actual) ? (realQty || sp.quantity) : 0;
                remaining -= soldThisRound;
                const remainingAfter = Math.max(0, remaining);

                return (
                  <tr key={i} className={`${sp.filled || actual ? styles.sellFilledRow : ''} ${sellNearInfo ? styles.nearbySellRow : ''}`}>
                    <td>
                      +{sp.percent}%
                      {sellNearInfo && (
                        <span className={`${styles.nearbySellChip} ${
                          sellNearInfo.urgency === 3 ? styles.chipUrgency3 : sellNearInfo.urgency === 2 ? styles.chipUrgency2 : styles.chipUrgency1
                        }`}>
                          매도 {sellNearInfo.gap >= 0 ? '+' : ''}{sellNearInfo.gap.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className={styles.numCell}>
                      {sp.price.toLocaleString()}
                      {i === nextSellIdx && !sp.filled && !actual && local.currentPrice > 0 && (
                        <>
                          <br />
                          <span className={`${styles.currentPriceTag} ${
                            sellNearInfo?.urgency === 3 ? styles.priceTagUrgentSell : ''
                          }`}>
                            현재 {local.currentPrice.toLocaleString()}
                          </span>
                          <span className={styles.priceGap}>{priceGapText(sp.price)}</span>
                        </>
                      )}
                    </td>
                    <td className={styles.numCell}>
                      {(sp.filled || actual) && realPrice > 0 ? (
                        <span
                          className={styles.actualPrice}
                          style={{ color: metTarget ? '#4caf50' : '#ff9800' }}
                        >
                          {realPrice.toLocaleString()}
                        </span>
                      ) : '-'}
                    </td>
                    <td className={`${styles.numCell} ${styles.plannedQty}`}>
                      {sp.quantity.toLocaleString()}
                    </td>
                    <td className={styles.numCell}>
                      {(sp.filled || actual) ? (
                        <span className={styles.filledQty}>{(realQty || sp.quantity).toLocaleString()}</span>
                      ) : (
                        <span className={styles.pendingQty}>-</span>
                      )}
                    </td>
                    <td className={styles.numCell}>
                      <span className={remainingAfter <= 0 ? styles.zeroQty : styles.remainQty}>
                        {(sp.filled || actual) ? remainingAfter.toLocaleString() : (remaining + soldThisRound > 0 ? (remaining + soldThisRound).toLocaleString() : '-')}
                      </span>
                    </td>
                  <td className={styles.dateCell}>
                    {(sp.filled || actual) ? (realDate || '-') : '-'}
                  </td>
                  <td className={styles.numCell}>
                    {realProfit !== null ? (
                      <span style={{ color: realProfit >= 0 ? '#4caf50' : '#f44336', fontWeight: 600 }}>
                        {realProfit >= 0 ? '+' : ''}{realProfit.toFixed(1)}%
                      </span>
                    ) : '-'}
                  </td>
                  <td>
                    <button
                      className={`${styles.fillBtn} ${sp.filled || actual ? styles.sellBtnActive : ''}`}
                      onClick={() => toggleSellFilled(i)}
                    >
                      {sp.filled || actual ? '체결' : '미체결'}
                    </button>
                    {(sp.filled || actual) && maSelectIdx !== i && (
                      <button
                        className={styles.maTransferBtn}
                        onClick={() => setMaSelectIdx(i)}
                        title="이동평균선 매도로 이동"
                      >
                        MA매도
                      </button>
                    )}
                    {maSelectIdx === i && (
                      <div className={styles.maSelectPopup}>
                        <span className={styles.maSelectLabel}>이평선 선택:</span>
                        {[20, 60, 120].map((d) => (
                          <button
                            key={d}
                            className={styles.maSelectBtn}
                            onClick={() => moveToMA(i, d, actual ? {
                              price: Math.round(actual.amt / actual.qty),
                              qty: actual.qty,
                              date: actual.date,
                            } : undefined)}
                          >
                            {d}일
                          </button>
                        ))}
                        <button
                          className={styles.maSelectCancel}
                          onClick={() => setMaSelectIdx(null)}
                        >
                          취소
                        </button>
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
          {sellsByDate.length >= 3 && (
            <span className={styles.chip}>룰B 전환 가능</span>
          )}
        </div>
      </div>

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

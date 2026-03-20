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
import type { Stock, Snapshot } from '../types';
import { recalcStock } from '../hooks/useStocks';
import styles from './StockDetail.module.css';

interface Props {
  stock: Stock;
  snapshots: Snapshot[];
  onSave: (stock: Stock) => void;
  onDelete: (id: string) => void;
  onSnapshot: (stockId: string, stockName: string, profit: number) => void;
}

export default function StockDetail({
  stock,
  snapshots,
  onSave,
  onDelete,
  onSnapshot,
}: Props) {
  const [local, setLocal] = useState<Stock>(stock);

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

  const profitPercent =
    local.avgPrice > 0
      ? ((local.currentPrice - local.avgPrice) / local.avgPrice) * 100
      : 0;

  const filledBuys = local.buyPlans.filter((b) => b.filled).length;
  const stockSnapshots = snapshots.filter((s) => s.stockId === local.id);

  // 다음 매수 차수 인덱스
  const nextBuyIdx = local.buyPlans.findIndex((b) => !b.filled);

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
              <th>매수가</th>
              <th>수량</th>
              <th>체결</th>
            </tr>
          </thead>
          <tbody>
            {local.buyPlans.map((bp, i) => (
              <tr
                key={i}
                className={bp.filled ? styles.filledRow : ''}
                style={
                  i === nextBuyIdx && !bp.filled
                    ? { background: '#fffde7' }
                    : undefined
                }
              >
                <td>
                  {bp.level}차
                  {i === nextBuyIdx && !bp.filled && (
                    <span className={styles.nextChip}>다음 매수</span>
                  )}
                </td>
                <td className={styles.numCell}>
                  {bp.price.toLocaleString()}
                </td>
                <td className={styles.numCell}>{bp.quantity.toLocaleString()}</td>
                <td>
                  <button
                    className={`${styles.fillBtn} ${bp.filled ? styles.fillBtnActive : ''}`}
                    onClick={() => toggleBuyFilled(i)}
                  >
                    {bp.filled ? '체결' : '미체결'}
                  </button>
                </td>
              </tr>
            ))}
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
              <th>매도가</th>
              <th>수량</th>
              <th>체결</th>
            </tr>
          </thead>
          <tbody>
            {local.sellPlans.map((sp, i) => (
              <tr key={i} className={sp.filled ? styles.sellFilledRow : ''}>
                <td>+{sp.percent}%</td>
                <td className={styles.numCell}>
                  {sp.price.toLocaleString()}
                </td>
                <td className={styles.numCell}>{sp.quantity.toLocaleString()}</td>
                <td>
                  <button
                    className={`${styles.fillBtn} ${sp.filled ? styles.sellBtnActive : ''}`}
                    onClick={() => toggleSellFilled(i)}
                  >
                    {sp.filled ? '체결' : '미체결'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className={styles.sellNote}>
          누적 매도 횟수: {local.sellCount}회
          {local.sellCount >= 3 && (
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
              return (
                <tr key={i} className={ms.filled ? styles.maFilledRow : ''}>
                  <td>{ms.ma}일선</td>
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

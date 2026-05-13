import { useState, useEffect, useRef } from 'react';
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
  stocks: Stock[];
  trades: Trade[];
  snapshots: Snapshot[];
  onSave: (stock: Stock, immediate?: boolean) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  onSnapshot: (stockId: string, stockName: string, profit: number) => void;
}

export default function StockDetail({
  stock,
  stocks,
  trades,
  snapshots,
  onSave,
  onDelete,
  onSelect,
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

  // 기본 정보 수정 저장 — backend manualBuyEdit endpoint 통한 강제 저장
  const confirmBasicEdit = async () => {
    if (!editDraft) return;
    // recalcStock으로 평단/매도계획 재계산 (가격 cascade 제외)
    const base = recalcStock({
      ...local,
      firstBuyPrice: editDraft.prices[0],
      firstBuyQuantity: editDraft.quantities[0],
      currentPrice: editDraft.currentPrice,
    });
    // 수동 입력한 가격/수량/체결정보로 override
    const finalBuyPlans = base.buyPlans.map((bp, i) => {
      const fp = editDraft.filledPrices[i];
      const fq = editDraft.filledQtys[i];
      const hasFillInfo = (fp ?? 0) > 0 && (fq ?? 0) > 0;
      const willBeFilled = bp.filled || hasFillInfo;
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
        filledDate: willBeFilled ? (editDraft.filledDates[i] || '') : (bp.filledDate || ''),
        filledPrice: willBeFilled ? (fp || 0) : (bp.filledPrice || 0),
        filledQuantity: willBeFilled ? (fq || 0) : (bp.filledQuantity || 0),
        manualOverride: isManualEntry || bp.manualOverride === true,
      };
    });
    // 평단가/총보유 재계산
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
    const newTotalQty = totalQty > 0 ? totalQty : base.totalQuantity;

    // 백엔드 manualBuyEdit 강제 저장 (response await + alert)
    setPersistBusy(true);
    try {
      const buyPlanEdits = finalBuyPlans.map((bp) => ({
        level: bp.level,
        set: {
          price: bp.price,
          quantity: bp.quantity,
          filled: bp.filled,
          filledDate: bp.filledDate || '',
          filledPrice: bp.filledPrice || 0,
          filledQuantity: bp.filledQuantity || 0,
          manualOverride: bp.manualOverride === true,
        },
      }));
      const topFields = {
        firstBuyPrice: editDraft.prices[0] || 0,
        firstBuyQuantity: editDraft.quantities[0] || 0,
        currentPrice: editDraft.currentPrice || 0,
        avgPrice: newAvg,
        totalQuantity: newTotalQty,
      };
      const res = await fetch(MANUAL_BUY_EDIT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          stockName: local.name,
          buyPlanEdits,
          topFields,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(`저장 실패: ${data.error || '알 수 없는 오류'}\n다시 시도해주세요.`);
        return;
      }
      // 성공 → optimistic setLocal + race guard
      const final: Stock = {
        ...base,
        buyPlans: finalBuyPlans,
        avgPrice: newAvg,
        totalQuantity: newTotalQty,
        updatedAt: Date.now(),
      };
      setLocal(final);
      lastUserActionRef.current = Date.now();
      setEditDraft(null);
      setShowBasicInfo(false);
    } catch (e: any) {
      alert(`네트워크 오류: ${e.message}\n인터넷 연결을 확인하고 다시 시도해주세요.`);
    } finally {
      setPersistBusy(false);
    }
  };

  // ──────────────────────────────────────────────────────────────
  // 백엔드 직접 저장 헬퍼 — manualSellEdit endpoint 호출
  // 클라이언트 setDoc 대신 atomic backend update로 race condition + 캐시 문제 차단
  // ──────────────────────────────────────────────────────────────
  const MANUAL_SELL_EDIT_API = 'https://asia-northeast3-teasan-f4c17.cloudfunctions.net/manualSellEdit';
  const MANUAL_BUY_EDIT_API = 'https://asia-northeast3-teasan-f4c17.cloudfunctions.net/manualBuyEdit';
  const APPLY_SPLIT_MERGE_API = 'https://asia-northeast3-teasan-f4c17.cloudfunctions.net/applySplitMergeRatio';

  // ── 액면분할/병합 처리 ──
  const [showSplitMerge, setShowSplitMerge] = useState(false);
  const [splitMergeDraft, setSplitMergeDraft] = useState<{
    date: string;
    ratioPreset: string; // "5", "0.2", "custom"
    customRatio: number;
  }>({
    date: new Date().toISOString().slice(0, 10),
    ratioPreset: '5',
    customRatio: 5,
  });
  const [splitMergePreview, setSplitMergePreview] = useState<any[] | null>(null);

  const getEffectiveRatio = () => {
    if (splitMergeDraft.ratioPreset === 'custom') return splitMergeDraft.customRatio;
    return parseFloat(splitMergeDraft.ratioPreset);
  };

  const previewSplitMerge = async () => {
    const ratio = getEffectiveRatio();
    if (!ratio || ratio <= 0 || ratio === 1) {
      alert('비율은 0보다 큰 1이 아닌 숫자여야 합니다.');
      return;
    }
    try {
      const res = await fetch(APPLY_SPLIT_MERGE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          stockName: local.name,
          ratio,
          splitDate: splitMergeDraft.date,
          preview: true,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(`미리보기 실패: ${data.error}`);
        return;
      }
      setSplitMergePreview(data.changes || []);
      if ((data.changes || []).length === 0) {
        alert('정정 대상 trade 없음 (분할일 이전 매수/매도 trade 없음)');
      }
    } catch (e: any) {
      alert(`네트워크 오류: ${e.message}`);
    }
  };

  const applySplitMerge = async () => {
    if (!splitMergePreview || splitMergePreview.length === 0) {
      alert('먼저 미리보기를 실행해주세요.');
      return;
    }
    const ratio = getEffectiveRatio();
    const direction = ratio > 1 ? `${ratio}:1 병합` : `1:${Math.round(1 / ratio)} 분할`;
    if (!confirm(
      `${local.name}에 ${direction} 비율을 적용하시겠습니까?\n\n` +
      `${splitMergePreview.length}건의 trade가 정정됩니다.\n` +
      `(${splitMergeDraft.date} 이전 매수/매도 trade 대상)\n\n` +
      `* 매수/매도 총액은 그대로 보존됩니다.`
    )) return;

    setPersistBusy(true);
    try {
      const res = await fetch(APPLY_SPLIT_MERGE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          stockName: local.name,
          ratio,
          splitDate: splitMergeDraft.date,
          preview: false,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(`적용 실패: ${data.error}`);
        return;
      }
      alert(`✅ ${data.appliedCount}건 정정 완료\n곧 buyPlans/sellPlans 자동 갱신됩니다.`);
      setShowSplitMerge(false);
      setSplitMergePreview(null);
      lastUserActionRef.current = Date.now();
    } catch (e: any) {
      alert(`네트워크 오류: ${e.message}`);
    } finally {
      setPersistBusy(false);
    }
  };
  const [, setPersistBusy] = useState(false);

  const persistSellEdit = async (
    newSellPlans: typeof local.sellPlans,
    newMaSells: typeof local.maSells,
  ): Promise<boolean> => {
    setPersistBusy(true);
    try {
      // ✅ 옵션 D: 슬롯별 consumedTradeIds 자동 계산 (이미 있으면 보존)
      // 매칭 알고리즘: date 일치 trades 중 단일 정확 매칭 → 그리디 조합 매칭
      // 못 찾으면 빈 배열 → 백엔드가 옵션 C(수량 fallback)로 처리
      const allSells = trades
        .filter((t) => t.stockName === local.name && t.type === 'sell' && t.id)
        .sort((a, b) => {
          const dc = (a.date || '').localeCompare(b.date || '');
          if (dc !== 0) return dc;
          return (a.price || 0) - (b.price || 0);
        });
      // trade.id별 사용된 qty 추적 (부분 분할 지원: 한 trade를 여러 슬롯이 공유 가능)
      const usedQtyByTrade: Record<string, number> = {};
      const tradeRemain = (t: any) => (Number(t.quantity) || 0) - (usedQtyByTrade[t.id] || 0);

      const resolveIds = (date: string, qty: number, filledPrice?: number): string[] => {
        if (!date || qty <= 0) return [];
        const candidates = allSells
          .filter((t) => t.date === date)
          .map((t) => ({...t, remain: tradeRemain(t)}))
          .filter((t) => t.remain > 0);
        // 1-A) date + qty + price 단일 정확 매칭 (remain 기준)
        if (filledPrice && filledPrice > 0) {
          const exactByPrice = candidates.find(
            (t) => t.remain === qty && (Number(t.price) || 0) === filledPrice
          );
          if (exactByPrice) {
            usedQtyByTrade[exactByPrice.id] = (usedQtyByTrade[exactByPrice.id] || 0) + qty;
            return [exactByPrice.id];
          }
          // 1-B) date + qty + price (가중평균 역추적) 다중 조합
          if (candidates.length <= 10 && candidates.length >= 2) {
            const n = candidates.length;
            for (let mask = 1; mask < (1 << n); mask++) {
              let sumQty = 0, sumAmt = 0;
              const subset: string[] = [];
              for (let i = 0; i < n; i++) {
                if (mask & (1 << i)) {
                  const t = candidates[i];
                  sumQty += t.remain;
                  sumAmt += t.remain * (Number(t.price) || 0);
                  subset.push(t.id);
                }
              }
              if (sumQty === qty) {
                const avg = sumQty > 0 ? Math.round(sumAmt / sumQty) : 0;
                if (avg === filledPrice) {
                  for (let i = 0; i < n; i++) {
                    if (mask & (1 << i)) {
                      const t = candidates[i];
                      usedQtyByTrade[t.id] = (usedQtyByTrade[t.id] || 0) + t.remain;
                    }
                  }
                  return subset;
                }
              }
            }
          }
          // 1-C) ✅ 부분 매칭: 같은 가격 trade 중 remain >= qty
          // (광전자 5/7 160주를 +5% 80 + ma20 80으로 분할 케이스)
          const partial = candidates.find((t) => (Number(t.price) || 0) === filledPrice && t.remain >= qty);
          if (partial) {
            usedQtyByTrade[partial.id] = (usedQtyByTrade[partial.id] || 0) + qty;
            return [partial.id];
          }
        }
        // 2) 단일 qty 정확 매칭 (가격 무시 — remain 기준)
        const exact = candidates.find((t) => t.remain === qty);
        if (exact) {
          usedQtyByTrade[exact.id] = (usedQtyByTrade[exact.id] || 0) + qty;
          return [exact.id];
        }
        // 3) 그리디 조합 (remain 작은 것부터)
        const byQtyAsc = [...candidates].sort((a, b) => a.remain - b.remain);
        let remaining = qty;
        const ids: string[] = [];
        for (const t of byQtyAsc) {
          if (t.remain <= remaining) {
            ids.push(t.id);
            usedQtyByTrade[t.id] = (usedQtyByTrade[t.id] || 0) + t.remain;
            remaining -= t.remain;
            if (remaining === 0) break;
          }
        }
        if (remaining === 0) {
          return ids;
        }
        return []; // 매칭 실패 → fallback
      };

      // 슬롯에 consumedTradeIds 적용 (기존 값 보존 우선)
      // 우선순위: maSells (split된 슬롯) → sellPlans (병합 슬롯)
      // 이렇게 하면 split된 trade가 ma에 먼저 할당되어 정확
      const enrichMa = (newMaSells || []).map((m) => {
        if (!m.filled) return m;
        const existing = Array.isArray(m.consumedTradeIds) ? m.consumedTradeIds : null;
        if (existing && existing.length > 0) {
          // 기존 consumedTradeIds가 있으면 그 슬롯의 qty만큼 trade에서 점유한 것으로 기록
          const perTrade = (Number(m.quantity) || 0) / existing.length;
          existing.forEach((id) => {
            usedQtyByTrade[id] = (usedQtyByTrade[id] || 0) + perTrade;
          });
          return m;
        }
        const ids = resolveIds(m.filledDate || '', Number(m.quantity) || 0, Number(m.price) || 0);
        return ids.length > 0 ? { ...m, consumedTradeIds: ids } : m;
      });
      const enrichSell = newSellPlans.map((p) => {
        if (!p.manualOverride || !p.filled) return p;
        const existing = Array.isArray(p.consumedTradeIds) ? p.consumedTradeIds : null;
        if (existing && existing.length > 0) {
          const perTrade = (Number(p.filledQuantity) || 0) / existing.length;
          existing.forEach((id) => {
            usedQtyByTrade[id] = (usedQtyByTrade[id] || 0) + perTrade;
          });
          return p;
        }
        const ids = resolveIds(p.filledDate || '', Number(p.filledQuantity) || 0, Number(p.filledPrice) || 0);
        return ids.length > 0 ? { ...p, consumedTradeIds: ids } : p;
      });
      newSellPlans = enrichSell;
      newMaSells = enrichMa;

      const sellPlanEdits = newSellPlans.map((p) => ({
        percent: p.percent,
        set: {
          filled: !!p.filled,
          filledPrice: p.filledPrice || 0,
          filledQuantity: p.filledQuantity || 0,
          filledDate: p.filledDate || '',
          manualOverride: p.manualOverride === true,
          // ✅ 옵션 D: 사용자가 흡수한 trade.id 명시 (정확 매칭용, undefined면 reconcile이 fallback)
          consumedTradeIds: Array.isArray(p.consumedTradeIds) ? p.consumedTradeIds : [],
        },
      }));
      const maSellEdits = (newMaSells || []).map((m) => ({
        ma: m.ma,
        set: {
          filled: !!m.filled,
          price: m.price || 0,
          quantity: m.quantity || 0,
          filledDate: m.filledDate || '',
          insertAfterPercent: m.insertAfterPercent ?? null,
          splitFromPercent: m.splitFromPercent ?? null,
          consumedTradeIds: Array.isArray(m.consumedTradeIds) ? m.consumedTradeIds : [],
        },
      }));
      const res = await fetch(MANUAL_SELL_EDIT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          stockName: local.name,
          sellPlanEdits,
          maSellEdits,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(`저장 실패: ${data.error || '알 수 없는 오류'}\n다시 시도해주세요.`);
        return false;
      }
      // 성공 → optimistic 즉시 setLocal + race guard 적용
      // (onSnapshot이 곧 같은 데이터로 동기화 갱신)
      const newCount = newSellPlans.filter((p) => p.filled).length +
        (newMaSells || []).filter((m) => m.filled).length;
      setLocal({
        ...local,
        sellPlans: newSellPlans,
        maSells: newMaSells,
        sellCount: newCount,
        updatedAt: Date.now(),
      });
      lastUserActionRef.current = Date.now();
      return true;
    } catch (e: any) {
      alert(`네트워크 오류: ${e.message}\n인터넷 연결을 확인하고 다시 시도해주세요.`);
      return false;
    } finally {
      setPersistBusy(false);
    }
  };

  // 사용자 액션 직후 일정 시간 동안 stock prop 동기화 무시 (race condition 방지)
  // 백엔드 sync (kiwoomSync, onTradeCreated 등)가 동시에 트리거되어도
  // 사용자 진행중인 분리/편집/이동 작업이 옛 데이터로 덮어씌워지지 않도록 보호
  const lastUserActionRef = useRef<number>(0);
  const USER_ACTION_GRACE_MS = 2500; // 2.5초

  useEffect(() => {
    // 최근 사용자 액션 후 grace 기간이면 동기화 무시
    if (Date.now() - lastUserActionRef.current < USER_ACTION_GRACE_MS) {
      return;
    }
    setLocal(stock);
  }, [stock]);

  // immediate=true: 디바운스 없이 즉시 Firestore 저장 (critical 작업용)
  const update = (partial: Partial<Stock>, immediate = false) => {
    const next = recalcStock({ ...local, ...partial, updatedAt: Date.now() });
    setLocal(next);
    lastUserActionRef.current = Date.now(); // 사용자 액션 시점 기록
    onSave(next, immediate);
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
    update({ buyPlans: plans, sellPlans: resetSells }, true); // immediate
  };

  const toggleSellFilled = async (index: number) => {
    const plans = [...local.sellPlans];
    plans[index] = { ...plans[index], filled: !plans[index].filled };
    const ok = await persistSellEdit(plans, local.maSells);
    if (ok && plans[index].filled && local.avgPrice > 0) {
      const profit = ((plans[index].price - local.avgPrice) / local.avgPrice) * 100;
      onSnapshot(local.id, local.name, profit);
    }
  };

  const toggleMAFilled = async (index: number) => {
    const ma = [...local.maSells];
    const today = new Date().toISOString().slice(0, 10);
    const wasFilled = ma[index].filled;
    ma[index] = {
      ...ma[index],
      filled: !wasFilled,
      // 체결 시 날짜 없으면 오늘로, 미체결 전환 시 그대로 보존
      filledDate: !wasFilled
        ? (ma[index].filledDate || today)
        : ma[index].filledDate,
    };
    const ok = await persistSellEdit(local.sellPlans, ma);
    if (ok && ma[index].filled && local.avgPrice > 0) {
      const profit = ((ma[index].price - local.avgPrice) / local.avgPrice) * 100;
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

  const updateMAFilledDate = async (index: number, date: string) => {
    const ma = [...local.maSells];
    ma[index] = { ...ma[index], filledDate: date };
    await persistSellEdit(local.sellPlans, ma);
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

  // 수익매도 수동 편집 저장 (manualOverride=true 설정) - backend 직접 저장
  const confirmSellEdit = async () => {
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
    const ok = await persistSellEdit(plans, local.maSells);
    if (ok) {
      setSellEditIdx(null);
      setSellEditDraft(null);
    }
  };

  // 수익매도 슬롯 비우기 - backend 직접 저장
  const clearSellSlot = async (i: number) => {
    const plans = [...local.sellPlans];
    plans[i] = {
      ...plans[i],
      filled: false,
      filledDate: '',
      filledPrice: 0,
      filledQuantity: 0,
      manualOverride: true,
    };
    const ok = await persistSellEdit(plans, local.maSells);
    if (ok) {
      setSellEditIdx(null);
      setSellEditDraft(null);
    }
  };

  // 수익매도 수동 편집 해제 - backend 직접 저장
  const clearSellOverride = async (i: number) => {
    const plans = [...local.sellPlans];
    plans[i] = { ...plans[i], manualOverride: false };
    await persistSellEdit(plans, local.maSells);
  };

  // ── 미분류 매도 이동 ──
  // 매핑 안 된 trade를 sellPlans 또는 maSells로 수동 이동
  // ✅ Phase 1: t.id를 받아서 consumedTradeIds에 누적 → 이중 처리 차단
  const moveUnmappedToSell = async (t: { id: string; date: string; price: number; quantity: number }) => {
    const percentStr = prompt('어느 차수로 이동? (5 / 10 / 15 / 20 / 25)', '25');
    if (!percentStr) return;
    const percent = parseInt(percentStr.replace(/\D/g, ''));
    if (![5, 10, 15, 20, 25].includes(percent)) {
      alert('5, 10, 15, 20, 25 중 하나만 가능합니다.');
      return;
    }
    const plans = [...local.sellPlans];
    const idx = plans.findIndex((p) => p.percent === percent);
    if (idx < 0) return;

    if (plans[idx].filled) {
      // 합치기 모드 (가중평균)
      const oldP = plans[idx].filledPrice || 0;
      const oldQ = plans[idx].filledQuantity || 0;
      const newQ = oldQ + t.quantity;
      const newP = newQ > 0 ? Math.round((oldP * oldQ + t.price * t.quantity) / newQ) : 0;
      const ok = confirm(
        `+${percent}%에 합치시겠습니까?\n` +
        `기존: ${oldP.toLocaleString()} × ${oldQ}주\n` +
        `추가: ${t.price.toLocaleString()} × ${t.quantity}주\n` +
        `결과: ${newP.toLocaleString()}원 (가중평균) × ${newQ}주`
      );
      if (!ok) return;
      const existingIds = Array.isArray(plans[idx].consumedTradeIds) ? plans[idx].consumedTradeIds : [];
      plans[idx] = {
        ...plans[idx],
        filledDate: t.date > (plans[idx].filledDate || '') ? t.date : (plans[idx].filledDate || ''),
        filledPrice: newP,
        filledQuantity: newQ,
        manualOverride: true,
        // ✅ trade.id 누적 (중복 방지)
        consumedTradeIds: existingIds.includes(t.id) ? existingIds : [...existingIds, t.id],
      };
    } else {
      plans[idx] = {
        ...plans[idx],
        filled: true,
        filledDate: t.date,
        filledPrice: t.price,
        filledQuantity: t.quantity,
        manualOverride: true,
        consumedTradeIds: [t.id],
      };
    }
    await persistSellEdit(plans, local.maSells);
  };

  const moveUnmappedToMa = async (t: { id: string; date: string; price: number; quantity: number }) => {
    const maStr = prompt('어느 이동평균선으로? (20 / 60 / 120)', '20');
    if (!maStr) return;
    const ma = parseInt(maStr.replace(/\D/g, ''));
    if (![20, 60, 120].includes(ma)) {
      alert('20, 60, 120 중 하나만 가능합니다.');
      return;
    }
    const insertStr = prompt(
      '몇 % 차수 다음에 표시할까요? (0 / 5 / 10 / 15 / 20 / 25)\n' +
      '(0: 1차 이전, 25: 5차 이후)',
      '25'
    );
    if (!insertStr) return;
    const insertAfter = parseInt(insertStr.replace(/\D/g, ''));
    if (![0, 5, 10, 15, 20, 25].includes(insertAfter)) {
      alert('0, 5, 10, 15, 20, 25 중 하나만 가능합니다.');
      return;
    }

    const maList = [...(local.maSells || [])];
    // 누락 슬롯 보강
    for (const m of [20, 60, 120]) {
      if (!maList.find((x) => x.ma === m)) {
        maList.push({ ma: m, price: 0, quantity: 0, filled: false });
      }
    }
    const idx = maList.findIndex((m) => m.ma === ma);

    if (maList[idx].filled) {
      // 합치기: 가중평균
      const oldP = maList[idx].price || 0;
      const oldQ = maList[idx].quantity || 0;
      const newQ = oldQ + t.quantity;
      const newP = newQ > 0 ? Math.round((oldP * oldQ + t.price * t.quantity) / newQ) : 0;
      const ok = confirm(
        `MA${ma}와 합치시겠습니까?\n` +
        `기존: ${oldP.toLocaleString()} × ${oldQ}주\n` +
        `추가: ${t.price.toLocaleString()} × ${t.quantity}주\n` +
        `결과: ${newP.toLocaleString()}원 (가중평균) × ${newQ}주`
      );
      if (!ok) return;
      const existingIds = Array.isArray(maList[idx].consumedTradeIds) ? maList[idx].consumedTradeIds! : [];
      maList[idx] = {
        ...maList[idx],
        price: newP,
        quantity: newQ,
        filledDate: t.date > (maList[idx].filledDate || '') ? t.date : (maList[idx].filledDate || ''),
        insertAfterPercent: insertAfter,
        // ✅ trade.id 누적 (이중 처리 차단)
        consumedTradeIds: existingIds.includes(t.id) ? existingIds : [...existingIds, t.id],
      };
    } else {
      maList[idx] = {
        ...maList[idx],
        filled: true,
        price: t.price,
        quantity: t.quantity,
        filledDate: t.date,
        insertAfterPercent: insertAfter,
        consumedTradeIds: [t.id],
      };
    }
    await persistSellEdit(local.sellPlans, maList);
  };

  // ── 수익매도 차수 간 이동 ──
  const [moveSellIdx, setMoveSellIdx] = useState<number | null>(null);

  const openMoveSell = (i: number) => {
    setMoveSellIdx(i);
    setSellEditIdx(null);
    setSplitIdx(null);
  };

  // fromIdx의 체결 데이터를 toPercent 차수로 이동 또는 합치기
  // - 도착이 비어있으면 단순 이동
  // - 도착에 이미 체결 있으면 confirm 후 가중평균 합산
  const moveSellToPercent = async (fromIdx: number, toPercent: number) => {
    const plans = [...local.sellPlans];
    const fromPlan = plans[fromIdx];
    const toIdx = plans.findIndex((p) => p.percent === toPercent);
    if (toIdx < 0) {
      alert('이동 대상 차수를 찾을 수 없습니다.');
      return;
    }
    if (fromIdx === toIdx) {
      setMoveSellIdx(null);
      return;
    }
    const toPlan = plans[toIdx];

    const fromPrice = fromPlan.filledPrice || 0;
    const fromQty = fromPlan.filledQuantity || 0;
    if (fromQty <= 0 || fromPrice <= 0) {
      alert('출발 차수에 유효한 체결 정보가 없습니다.');
      return;
    }

    if (toPlan.filled) {
      // 합치기 모드: 가중평균 계산
      const toPrice = toPlan.filledPrice || 0;
      const toQty = toPlan.filledQuantity || 0;
      const totalQty = fromQty + toQty;
      const totalAmt = fromPrice * fromQty + toPrice * toQty;
      const mergedPrice = totalQty > 0 ? Math.round(totalAmt / totalQty) : 0;

      const ok = confirm(
        `+${fromPlan.percent}% 체결을 +${toPercent}%와 합치시겠습니까?\n\n` +
        `현재:\n` +
        `  +${fromPlan.percent}%: ${fromPrice.toLocaleString()}원 × ${fromQty}주\n` +
        `  +${toPercent}%: ${toPrice.toLocaleString()}원 × ${toQty}주\n\n` +
        `합치기 결과:\n` +
        `  +${toPercent}%: ${mergedPrice.toLocaleString()}원 (가중평균) × ${totalQty}주\n` +
        `  +${fromPlan.percent}%: 비움 (sync 보호)\n\n` +
        `* 매도 총액(${totalAmt.toLocaleString()}원)은 변하지 않습니다.`
      );
      if (!ok) return;

      // 도착 슬롯: 가중평균 합산 (날짜는 더 최근 것 우선)
      const mergedDate = (toPlan.filledDate || '') > (fromPlan.filledDate || '')
        ? toPlan.filledDate
        : fromPlan.filledDate;
      plans[toIdx] = {
        ...toPlan,
        filled: true,
        filledDate: mergedDate || '',
        filledPrice: mergedPrice,
        filledQuantity: totalQty,
        manualOverride: true,
      };
    } else {
      // 단순 이동 모드: 출발 → 도착으로 복사
      plans[toIdx] = {
        ...toPlan,
        filled: true,
        filledDate: fromPlan.filledDate || '',
        filledPrice: fromPrice,
        filledQuantity: fromQty,
        manualOverride: true,
      };
    }

    // 출발 슬롯: 비우기 + 보호
    plans[fromIdx] = {
      ...fromPlan,
      filled: false,
      filledDate: '',
      filledPrice: 0,
      filledQuantity: 0,
      manualOverride: true,
    };

    // 합치기 모드 + fromIdx 이후에 체결된 차수 있으면 → cascade up 제안
    if (toPlan.filled) {
      const filledAfter = plans.slice(fromIdx + 1).filter((p) => p.filled);
      if (filledAfter.length > 0) {
        const cascadeMsg =
          `차수가 비게 됩니다. 다음 차수들을 자동으로 앞당길까요?\n\n` +
          filledAfter.map((p, i) => {
            const targetPercent = plans[fromIdx + i].percent;
            return `  +${targetPercent}% ← +${p.percent}% (${(p.filledPrice||0).toLocaleString()}원 × ${p.filledQuantity}주)`;
          }).join('\n') +
          `\n  +${plans[plans.length - 1].percent}%: 비어있음 (새 매도 자동 매핑 가능)\n\n` +
          `(추천: 자동매매 분할 합치기 후 자연스러운 차수 정렬)`;

        if (confirm(cascadeMsg)) {
          // Cascade up 실행: 빈 슬롯이 다음 체결 슬롯 데이터를 가져옴
          for (let i = fromIdx; i < plans.length - 1; i++) {
            if (plans[i].filled) continue; // 이미 차있으면 스킵
            // 다음 체결 슬롯 찾기
            let nextIdx = -1;
            for (let j = i + 1; j < plans.length; j++) {
              if (plans[j].filled) { nextIdx = j; break; }
            }
            if (nextIdx < 0) break;
            const src = plans[nextIdx];
            plans[i] = {
              ...plans[i], // percent / quantity 계획값 유지
              filled: true,
              filledDate: src.filledDate || '',
              filledPrice: src.filledPrice || 0,
              filledQuantity: src.filledQuantity || 0,
              manualOverride: true,
            };
            plans[nextIdx] = {
              ...plans[nextIdx],
              filled: false,
              filledDate: '',
              filledPrice: 0,
              filledQuantity: 0,
              manualOverride: false, // 마지막 빈 슬롯은 자동 매핑 허용
            };
          }
        }
      }
    }

    const ok = await persistSellEdit(plans, local.maSells);
    if (ok) setMoveSellIdx(null);
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

  const confirmSplitToMA = async () => {
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
    // ✅ 안전망: maSells가 없거나 해당 MA 슬롯 없으면 자동 생성
    const maList = [...(local.maSells || [])];
    let maIdx = maList.findIndex((m) => m.ma === splitDraft.ma);
    if (maIdx < 0) {
      // 해당 MA 슬롯이 아예 없는 경우 신규 추가
      maList.push({
        ma: splitDraft.ma,
        price: 0,
        quantity: 0,
        filled: false,
      });
      maIdx = maList.length - 1;
    }
    const existing = maList[maIdx];
    // 기존 슬롯이 비어있으면 채우고, 이미 차있으면 수량 누적
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

    const ok = await persistSellEdit(plans, maList);
    if (ok) {
      setSplitIdx(null);
      setSplitDraft(null);
    }
  };

  // ── MA 행 드래그 이동 (insertAfterPercent 변경) ──
  const [draggingMaIdx, setDraggingMaIdx] = useState<number | null>(null);

  const moveMaToInsertAfter = async (maIdx: number, newInsertAfter: number) => {
    const m = local.maSells[maIdx];
    if (!m) return;
    if (m.insertAfterPercent === newInsertAfter) return; // 변화 없음
    const maList = [...local.maSells];
    maList[maIdx] = { ...m, insertAfterPercent: newInsertAfter };
    await persistSellEdit(local.sellPlans, maList);
  };

  // ── MA 행 → sellPlan 복원 ──
  const restoreMAToSell = async (maIdx: number) => {
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

    await persistSellEdit(plans, maList);
  };

  // 평가손익: 보유 0주(매매완료) 또는 currentPrice=0이면 0%로 표시
  // (잔고 0인 종목에 -100% 표시되던 버그 차단)
  const profitPercent =
    local.avgPrice > 0 && local.totalQuantity > 0 && local.currentPrice > 0
      ? ((local.currentPrice - local.avgPrice) / local.avgPrice) * 100
      : 0;

  const profitAmount =
    local.avgPrice > 0 && local.totalQuantity > 0 && local.currentPrice > 0
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
  // ⚠️ filledDate 비어있으면 빈 문자열 그대로 — updatedAt(=최근 sync 시각)을 매수일로 위장하면
  // "1차 매수일이 오늘"처럼 오인되므로 절대 fallback 금지. UI에서 "-" 또는 "날짜미상"으로 표시.
  const syntheticBuys: Trade[] = local.buyPlans
    .filter((bp) => bp.filled && bp.filledPrice && bp.filledQuantity)
    .map((bp) => ({
      id: `synthetic-${local.id}-${bp.level}`,
      date: bp.filledDate || '',
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

  // 종목 단위 manualOverride 감지 — 사용자가 한 번이라도 sellPlan을 직접 정리하면
  // trade 기반 자동 fallback을 모든 슬롯에서 비활성화 (sellPlans만 신뢰)
  const hasAnyManualOverride = local.sellPlans.some((sp) => sp.manualOverride === true);

  // 슬롯별 trade fallback (manualOverride 종목은 빈 배열로 강제)
  const sellsByDate = hasAnyManualOverride ? [] : sellsIndividual;

  // ── 미분류 매도 감지 (옵션 D + 옵션 C fallback 결합) ──
  // 1단계: consumedTradeIds 명시된 슬롯의 trade.id는 정확히 제외
  // 2단계: consumedTradeIds 없는 slot은 수량 기반 fallback (legacy 데이터 호환)
  const consumedIdSetFE = new Set<string>();
  for (const sp of local.sellPlans) {
    if (Array.isArray(sp.consumedTradeIds)) {
      for (const id of sp.consumedTradeIds) if (id) consumedIdSetFE.add(String(id));
    }
  }
  for (const m of local.maSells || []) {
    if (Array.isArray(m.consumedTradeIds)) {
      for (const id of m.consumedTradeIds) if (id) consumedIdSetFE.add(String(id));
    }
  }

  // 옵션 C fallback 대상 수량 (consumedTradeIds 없는 filled slot)
  const fallbackQtyFromSell = local.sellPlans.reduce((s, p) => {
    if (p.filled && !(Array.isArray(p.consumedTradeIds) && p.consumedTradeIds.length > 0)) {
      return s + (p.filledQuantity || 0);
    }
    return s;
  }, 0);
  const fallbackQtyFromMa = (local.maSells || []).reduce((s, m) => {
    if (m.filled && !(Array.isArray(m.consumedTradeIds) && m.consumedTradeIds.length > 0)) {
      return s + (m.quantity || 0);
    }
    return s;
  }, 0);
  const fallbackTotalQty = fallbackQtyFromSell + fallbackQtyFromMa;

  // 후보 trades = consumedIdSet에 없는 매도
  const candidateSells = actualSells.filter((t) => !consumedIdSetFE.has(String(t.id)));

  // 후보 trades를 정렬해서 fallback 수량만큼 흡수 시뮬레이션
  const unmappedTrades: Array<{ id: string; date: string; price: number; quantity: number }> = [];
  const sortedCandidates = [...candidateSells].sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') || a.price - b.price
  );
  let consumed = 0;
  for (const t of sortedCandidates) {
    if (consumed + t.quantity <= fallbackTotalQty) {
      consumed += t.quantity; // fallback에 흡수됨
    } else if (consumed < fallbackTotalQty) {
      const partial = t.quantity - (fallbackTotalQty - consumed);
      unmappedTrades.push({ id: t.id, date: t.date, price: t.price, quantity: partial });
      consumed = fallbackTotalQty;
    } else {
      unmappedTrades.push({ id: t.id, date: t.date, price: t.price, quantity: t.quantity });
    }
  }
  const unmappedSellQty = unmappedTrades.reduce((s, t) => s + t.quantity, 0);

  // 다음 매도 차수 인덱스 (manualOverride 종목은 sellPlans만 보고 판단)
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

  // 종목 빠른 전환: 보유 → 매매완료 → 관찰 순으로 정렬
  const sortedNavStocks = [...stocks]
    .filter((s) => s.name && s.name.trim())
    .sort((a, b) => {
      const tierOf = (s: Stock) => {
        if ((s.totalQuantity || 0) > 0) return 0; // 보유
        if ((s.buyPlans || []).some((b) => b.filled)) return 1; // 매매완료
        return 2; // 관찰
      };
      const ta = tierOf(a);
      const tb = tierOf(b);
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, 'ko');
    });
  const currentNavIdx = sortedNavStocks.findIndex((s) => s.id === local.id);
  const prevStock = currentNavIdx > 0 ? sortedNavStocks[currentNavIdx - 1] : null;
  const nextStock = currentNavIdx >= 0 && currentNavIdx < sortedNavStocks.length - 1
    ? sortedNavStocks[currentNavIdx + 1] : null;

  return (
    <div className={styles.container}>
      {/* 종목 빠른 전환 바 */}
      <div className={styles.navBar}>
        <button
          className={styles.navBtn}
          disabled={!prevStock}
          onClick={() => prevStock && onSelect(prevStock.id)}
          title={prevStock ? `이전: ${prevStock.name}` : '이전 종목 없음'}
        >
          ◀
        </button>
        <select
          className={styles.navSelect}
          value={local.id}
          onChange={(e) => onSelect(e.target.value)}
        >
          {sortedNavStocks.map((s) => {
            const tier = (s.totalQuantity || 0) > 0
              ? '🟢'
              : (s.buyPlans || []).some((b) => b.filled) ? '🔵' : '⚪';
            return (
              <option key={s.id} value={s.id}>
                {tier} {s.name}{s.code ? ` (${s.code.replace(/^A/, '')})` : ''}
              </option>
            );
          })}
        </select>
        <button
          className={styles.navBtn}
          disabled={!nextStock}
          onClick={() => nextStock && onSelect(nextStock.id)}
          title={nextStock ? `다음: ${nextStock.name}` : '다음 종목 없음'}
        >
          ▶
        </button>
        <span className={styles.navCounter}>
          {currentNavIdx + 1} / {sortedNavStocks.length}
        </span>
      </div>

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
        {/* ✅ 옵션 H: 매도 매핑 불일치 경고 배지 */}
        {(local.mappingAuditDiff || 0) !== 0 && (
          <span
            className={styles.auditBadge}
            title={`매도 trade 수량과 매핑 수량 차이: ${local.mappingAuditDiff! > 0 ? '+' : ''}${local.mappingAuditDiff}주\n양수: trade가 더 많음 (누락)\n음수: 매핑이 더 많음 (이중집계)`}
          >
            ⚠️ 매핑 불일치 {local.mappingAuditDiff! > 0 ? '+' : ''}{local.mappingAuditDiff}주
          </span>
        )}
        {/* ✅ 옵션 B: 슬롯-가격 band 불일치 경고 배지 */}
        {(local.mappingBandIssues || 0) > 0 && (
          <span
            className={styles.auditBandBadge}
            title={`수익% 슬롯에 가격대가 맞지 않는 매도가 매핑됨\n예: +25% 슬롯에 +11% 매도가 들어가는 케이스\n수동 정정이 필요합니다.`}
          >
            🚨 슬롯-가격 불일치 {local.mappingBandIssues}건
          </span>
        )}
        {/* ✅ P3: 매핑 신뢰도 (consumedTradeIds 누락) 경고 배지 */}
        {(local.mappingIntegrityIssues || 0) > 0 && (
          <span
            className={styles.auditIntegrityBadge}
            title={`체결된 슬롯 중 ${local.mappingIntegrityIssues}개가 trade.id 명시 매칭 없이 옵션 C fallback에 의존.\n→ 매핑 정확도가 낮을 수 있음.\n슬롯을 한 번 다시 만지거나 마이그레이션을 실행하면 자동 해소됩니다.`}
          >
            ⚙️ 매핑 신뢰도 낮음 {local.mappingIntegrityIssues}건
          </span>
        )}
        {/* ✅ Option B: consumedTradeIds 불일치 경고 배지 (가장 심각) */}
        {(local.mappingConsumedMismatch || 0) > 0 && (
          <span
            className={styles.auditMismatchBadge}
            title={`체결된 슬롯의 consumedTradeIds가 슬롯 데이터(가격/수량)와 일치하지 않음 ${local.mappingConsumedMismatch}건.\n자동 정정 시도 후에도 해소 안 된 케이스 — 수동 정정 필요.\n같은 trade가 미분류에도 노출될 수 있음 (짬뽕 위험).`}
          >
            🔥 정합성 위반 {local.mappingConsumedMismatch}건
          </span>
        )}
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
              <button
                className={styles.splitMergeBtn}
                onClick={() => setShowSplitMerge(true)}
                title="액면분할 또는 액면병합 발생 시 trade 일괄 정정"
              >
                🔄 액면분할/병합 처리
              </button>
            </div>

            {/* 액면분할/병합 처리 모달 */}
            {showSplitMerge && (
              <div className={styles.splitMergePanel}>
                <h4 className={styles.splitMergeTitle}>🔄 액면분할/병합 처리</h4>
                <p className={styles.splitMergeHint}>
                  분할/병합 일자 이전 trade의 (가격, 수량)을 비율에 맞게 정정합니다.<br/>
                  매수/매도 총액은 보존됩니다.
                </p>

                <div className={styles.splitMergeRow}>
                  <label>분할/병합 일자</label>
                  <input
                    type="date"
                    className={styles.splitMergeInput}
                    value={splitMergeDraft.date}
                    onChange={(e) => {
                      setSplitMergeDraft({...splitMergeDraft, date: e.target.value});
                      setSplitMergePreview(null);
                    }}
                  />
                </div>

                <div className={styles.splitMergeRow}>
                  <label>비율</label>
                  <select
                    className={styles.splitMergeInput}
                    value={splitMergeDraft.ratioPreset}
                    onChange={(e) => {
                      setSplitMergeDraft({...splitMergeDraft, ratioPreset: e.target.value});
                      setSplitMergePreview(null);
                    }}
                  >
                    <option value="2">2:1 병합 (2주→1주, 가격×2)</option>
                    <option value="5">5:1 병합 (5주→1주, 가격×5) ⭐</option>
                    <option value="10">10:1 병합 (10주→1주, 가격×10)</option>
                    <option value="0.5">1:2 분할 (1주→2주, 가격÷2)</option>
                    <option value="0.2">1:5 분할 (1주→5주, 가격÷5)</option>
                    <option value="0.1">1:10 분할 (1주→10주, 가격÷10)</option>
                    <option value="0.01">1:100 분할 (1주→100주, 가격÷100)</option>
                    <option value="0.001">1:1000 분할 (1주→1,000주, 가격÷1,000)</option>
                    <option value="custom">직접 입력</option>
                  </select>
                </div>

                {splitMergeDraft.ratioPreset === 'custom' && (
                  <div className={styles.splitMergeRow}>
                    <label>직접 입력</label>
                    <input
                      type="number"
                      step="0.0001"
                      className={styles.splitMergeInput}
                      value={splitMergeDraft.customRatio}
                      onChange={(e) => {
                        setSplitMergeDraft({...splitMergeDraft, customRatio: parseFloat(e.target.value) || 0});
                        setSplitMergePreview(null);
                      }}
                      placeholder=">1: 병합, <1: 분할"
                    />
                  </div>
                )}

                {/* 미리보기 결과 */}
                {splitMergePreview && splitMergePreview.length > 0 && (
                  <div className={styles.splitMergePreview}>
                    <strong>📋 미리보기 ({splitMergePreview.length}건):</strong>
                    {splitMergePreview.map((c: any, i: number) => (
                      <div key={i} className={styles.splitMergePreviewRow}>
                        {c.date} [{c.type === 'buy' ? '매수' : '매도'}]
                        <span className={styles.smPreviewBefore}>
                          {c.before.price.toLocaleString()}×{c.before.quantity}
                        </span>
                        →
                        <span className={styles.smPreviewAfter}>
                          {c.after.price.toLocaleString()}×{c.after.quantity}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className={styles.splitMergeActions}>
                  <button className={styles.smPreviewBtn} onClick={previewSplitMerge}>📋 미리보기</button>
                  <button
                    className={styles.smApplyBtn}
                    onClick={applySplitMerge}
                    disabled={!splitMergePreview || splitMergePreview.length === 0}
                  >
                    ✅ 적용
                  </button>
                  <button
                    className={styles.smCancelBtn}
                    onClick={() => { setShowSplitMerge(false); setSplitMergePreview(null); }}
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
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
                        {bp.filled && (
                          <div className={styles.dateUnder}>
                            <input
                              type="date"
                              className={styles.dateInputCompact}
                              value={realDate}
                              placeholder="날짜 미상"
                              title={realDate ? '' : '매수일이 기록되지 않음 — 클릭하여 입력'}
                              onChange={(e) => {
                                const plans = [...local.buyPlans];
                                plans[i] = { ...plans[i], filledDate: e.target.value };
                                update({ buyPlans: plans });
                              }}
                            />
                            {!realDate && <span style={{ color: '#aaa', fontSize: '10px', marginLeft: 4 }}>날짜 미상</span>}
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
                      {/* 체결 버튼 + 금액 */}
                      <td className={styles.btnCell}>
                        <button
                          className={`${styles.fillBtn} ${bp.filled ? styles.fillBtnActive : ''}`}
                          onClick={() => toggleBuyFilled(i)}
                        >
                          {bp.filled ? '체결' : '미체결'}
                        </button>
                        {bp.filled && (() => {
                          const buyQty = realQty || bp.quantity || 0;
                          const buyPrice = realPrice || bp.filledPrice || bp.price || 0;
                          const buyAmt = buyQty * buyPrice;
                          return buyAmt > 0 ? (
                            <span className={styles.buyRowAmt} title="이 차수 매수 금액">
                              {buyAmt.toLocaleString()}원
                            </span>
                          ) : null;
                        })()}
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
              // ✅ 수익매도 + MA매도 통합 합산 (같은 카드에 모두 표시되므로 헤더도 통합)
              let cnt = 0, qty = 0, amt = 0;
              local.sellPlans.forEach((sp, i) => {
                const act = sellsByDate[i];
                if (!sp.filled && !act) return;
                const q = act ? act.qty : (sp.filledQuantity || sp.quantity);
                const p = act ? Math.round(act.amt / act.qty) : (sp.filledPrice || sp.price);
                cnt++; qty += q; amt += q * p;
              });
              // MA 매도도 포함 (수익 매도 계획 카드 본문에 같이 표시됨)
              local.maSells.forEach((m) => {
                if (!m.filled) return;
                cnt++;
                qty += m.quantity || 0;
                amt += (m.price || 0) * (m.quantity || 0);
              });
              const totalBoughtH = local.buyPlans.reduce((s, bp) => bp.filled ? s + (bp.filledQuantity || bp.quantity) : s, 0);
              const remQty = Math.max(0, totalBoughtH - qty);
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

                // MA 행 렌더 헬퍼 (드래그 가능)
                const renderMARow = (m: typeof local.maSells[0], mi: number) => {
                  const profit = local.avgPrice > 0 && m.price > 0
                    ? ((m.price - local.avgPrice) / local.avgPrice) * 100 : null;
                  const shortD = m.filledDate ? m.filledDate.slice(5) : '';
                  const isDragging = draggingMaIdx === mi;
                  return (
                    <tr
                      key={`ma-${mi}`}
                      className={`${styles.maInsertedRow} ${isDragging ? styles.maRowDragging : ''}`}
                      draggable
                      onDragStart={(e) => {
                        setDraggingMaIdx(mi);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', `ma-${mi}`);
                      }}
                      onDragEnd={() => setDraggingMaIdx(null)}
                      title="드래그해서 위치 이동 (다른 차수 행 위에 드롭)"
                    >
                      <td className={styles.levelCell}>
                        <span className={styles.maInsertedBadge}>
                          <span className={styles.dragHandle}>⋮⋮</span> MA{m.ma}
                        </span>
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

                // 드래그 중 → "1차 이전" drop zone 표시
                if (draggingMaIdx !== null) {
                  rows.push(
                    <tr
                      key="drop-top"
                      className={styles.dropZone}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.currentTarget.classList.add(styles.dropZoneOver);
                      }}
                      onDragLeave={(e) => {
                        e.currentTarget.classList.remove(styles.dropZoneOver);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.currentTarget.classList.remove(styles.dropZoneOver);
                        moveMaToInsertAfter(draggingMaIdx, 0);
                      }}
                    >
                      <td colSpan={5} className={styles.dropZoneCell}>↑ 1차 이전 (제일 위)</td>
                    </tr>
                  );
                }

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
                    <tr
                      key={i}
                      className={`${isFilled ? styles.sellFilledRow : ''} ${sellNearInfo ? styles.nearbySellRow : ''} ${draggingMaIdx !== null ? styles.dropTarget : ''}`}
                      onDragOver={(e) => {
                        if (draggingMaIdx !== null) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          e.currentTarget.classList.add(styles.dropTargetOver);
                        }
                      }}
                      onDragLeave={(e) => {
                        e.currentTarget.classList.remove(styles.dropTargetOver);
                      }}
                      onDrop={(e) => {
                        if (draggingMaIdx !== null) {
                          e.preventDefault();
                          e.currentTarget.classList.remove(styles.dropTargetOver);
                          moveMaToInsertAfter(draggingMaIdx, sp.percent);
                        }
                      }}
                    >
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
                        {isFilled && (sp.filledQuantity || 0) > 0 && sellEditIdx !== i && splitIdx !== i && moveSellIdx !== i && (
                          <button className={styles.splitBtn} onClick={() => openSplitToMA(i)} title="이 차수의 일부/전체를 MA 매도로 분리">🔀 MA</button>
                        )}
                        {isFilled && (sp.filledQuantity || 0) > 0 && sellEditIdx !== i && splitIdx !== i && moveSellIdx !== i && (
                          <button className={styles.moveSellBtn} onClick={() => openMoveSell(i)} title="이 체결을 다른 차수로 이동">↕️ 이동</button>
                        )}
                        {sellEditIdx !== i && splitIdx !== i && moveSellIdx !== i && (
                          <button className={styles.sellEditBtn} onClick={() => openSellEdit(i)}>✏️</button>
                        )}
                        {sp.manualOverride && sellEditIdx !== i && splitIdx !== i && moveSellIdx !== i && (
                          <span className={styles.manualOverrideBadge} title="수동 편집됨 (sync 보호)">수동</span>
                        )}
                        {moveSellIdx === i && (
                          <div className={styles.moveSellPopup}>
                            <div className={styles.moveSellTitle}>
                              ↕️ +{sp.percent}% 체결 이동
                            </div>
                            <div className={styles.moveSellInfo}>
                              {(sp.filledPrice || 0).toLocaleString()}원 × {sp.filledQuantity || 0}주
                              {sp.filledDate && ` · ${sp.filledDate.slice(5)}`}
                            </div>
                            <div className={styles.moveSellHint}>이동할 차수 선택:</div>
                            <div className={styles.moveSellTargets}>
                              {[5, 10, 15, 20, 25].filter((p) => p !== sp.percent).map((p) => {
                                const target = local.sellPlans.find((sp2) => sp2.percent === p);
                                const occupied = target?.filled === true;
                                const targetPrice = target?.filledPrice || 0;
                                const targetQty = target?.filledQuantity || 0;
                                return (
                                  <button
                                    key={p}
                                    className={`${styles.moveSellTargetBtn} ${occupied ? styles.moveSellTargetMerge : ''}`}
                                    onClick={() => moveSellToPercent(i, p)}
                                    title={
                                      occupied
                                        ? `+${p}% (${targetPrice.toLocaleString()} × ${targetQty}주)와 합치기 (가중평균)`
                                        : `+${p}%로 이동 (빈 차수)`
                                    }
                                  >
                                    +{p}% {occupied ? '⊕' : '↗'}
                                    {occupied && (
                                      <span className={styles.moveSellTargetMeta}>{targetQty}주</span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                            <button className={styles.sellEditCancel} onClick={() => setMoveSellIdx(null)}>취소</button>
                          </div>
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
                              {isFilled && (
                                <button
                                  className={styles.sellEditClear}
                                  onClick={() => {
                                    if (confirm(`+${sp.percent}% 차수 체결 정보를 비우시겠습니까?\n(보호되어 sync 시 자동 채워지지 않습니다)`)) {
                                      clearSellSlot(i);
                                    }
                                  }}
                                  title="이 차수의 체결 정보를 비우고 sync 보호 (다른 차수로 이동 시 사용)"
                                >
                                  ⚪ 비우기
                                </button>
                              )}
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

          {/* 미분류 매도 영역: sellPlans/maSells에 매핑되지 않은 trade */}
          {unmappedTrades.length > 0 && (
            <div className={styles.unmappedSection}>
              <div className={styles.unmappedHeader}>
                🔄 미분류 매도 — <strong>{unmappedSellQty.toLocaleString()}주</strong> ({unmappedTrades.length}건)
              </div>
              <div className={styles.unmappedHint}>
                실제 매도되었지만 수익매도/MA매도 어디에도 배정 안 된 매도건입니다.
                <br />
                태산매매법 5단계 초과 매도 또는 자동 매핑 누락 가능. 수동으로 분류해주세요.
              </div>
              {unmappedTrades.map((t, idx) => {
                const profitPct = local.avgPrice > 0
                  ? ((t.price - local.avgPrice) / local.avgPrice) * 100
                  : 0;
                return (
                  <div key={idx} className={styles.unmappedRow}>
                    <span className={styles.unmappedDate}>{t.date.slice(5)}</span>
                    <span className={styles.unmappedPrice}>
                      {t.price.toLocaleString()}원 × {t.quantity}주
                      {local.avgPrice > 0 && (
                        <span className={styles.unmappedProfit} style={{ color: profitPct >= 0 ? '#2e7d32' : '#c62828' }}>
                          {' '}{profitPct >= 0 ? '+' : ''}{profitPct.toFixed(1)}%
                        </span>
                      )}
                    </span>
                    <button className={styles.unmappedBtnSell} onClick={() => moveUnmappedToSell(t)}>
                      ↗ 수익매도로
                    </button>
                    <button className={styles.unmappedBtnMa} onClick={() => moveUnmappedToMa(t)}>
                      📉 MA매도로
                    </button>
                  </div>
                );
              })}
            </div>
          )}
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
              <th style={{ textAlign: 'right' }}>손익%</th>
              <th>체결</th>
              <th>체결일</th>
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
                  <td>
                    {ms.filled ? (
                      <input
                        type="date"
                        className={styles.maDateInput}
                        value={ms.filledDate || ''}
                        onChange={(e) => updateMAFilledDate(i, e.target.value)}
                      />
                    ) : (
                      <span className={styles.dashText}>-</span>
                    )}
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

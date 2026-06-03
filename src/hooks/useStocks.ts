// v2.4 - corporateActions 종목: avgPrice·미체결qty Firestore/firstBuyQty 기준 유지
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  query,
  orderBy,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Stock } from '../types';
import { TRASH_RETENTION_MS } from '../types';

const DEBOUNCE_MS = 600;

function createDefaultStock(name: string): Omit<Stock, 'id'> {
  return {
    name,
    rule: 'A',
    firstBuyPrice: 0,
    firstBuyQuantity: 0,
    currentPrice: 0,
    avgPrice: 0,
    totalQuantity: 0,
    buyPlans: Array.from({ length: 5 }, (_, i) => ({
      level: i + 1,
      price: 0,
      quantity: 0,
      filled: false,
    })),
    sellPlans: [5, 10, 15, 20, 25].map((p) => ({
      percent: p,
      price: 0,
      quantity: 0,
      filled: false,
    })),
    maSells: [20, 60, 120].map((ma) => ({
      ma,
      price: 0,
      quantity: 0,
      filled: false,
    })),
    sellCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function recalcStock(stock: Stock): Stock {
  const s = { ...stock };
  const { firstBuyPrice, firstBuyQuantity, rule, bottomPrice } = s;

  // ─── 룰B 활성화 게이트: 마지막 매수 차수 이후 누적 매도(이익+MA) 3회 이상 ───
  // 1) 마지막으로 체결된 매수 차수의 filledDate 찾기 (없으면 빈 문자열)
  const lastFilledBuyDate = s.buyPlans
    .filter((bp) => bp.filled && !!bp.filledDate)
    .reduce((max, bp) => ((bp.filledDate || '') > max ? (bp.filledDate || '') : max), '');
  // 2) 그 날짜 이후(같은 날은 제외 — 매수 직후의 매도는 다른 라운드로 분리하기 위함)에 발생한 매도 카운트
  //    같은 날 매수+매도는 보수적으로 매수 후로 간주하지 않음 (정확한 시각 정보 없음)
  const countSellsAfter = (cutoffDate: string): number => {
    let count = 0;
    s.sellPlans.forEach((sp) => {
      if ((sp.filled || (sp.filledQuantity || 0) > 0) && (sp.filledDate || '') > cutoffDate) count++;
    });
    s.maSells.forEach((ms) => {
      if (ms.filled && (ms.filledDate || '') > cutoffDate) count++;
    });
    return count;
  };
  const sellsSinceLastBuy = countSellsAfter(lastFilledBuyDate);
  s.sellsSinceLastBuy = sellsSinceLastBuy;
  const ruleBActive = rule === 'B' && sellsSinceLastBuy >= 3 && (bottomPrice || 0) > 0;
  s.ruleBActive = ruleBActive;
  // 룰B로 설정됐지만 아직 매도 3회 미만 → 룰A 폴백 (기존 isRuleB 로직 차단)
  const isRuleB = ruleBActive;
  // 합병/감자 이력이 있는 종목: firstBuyPrice 기반 비중동일 계산이 부정확
  // → 미체결 수량은 firstBuyQuantity로 통일, avgPrice는 Firestore(키움) 값 유지
  const hasCorporateActions = Array.isArray(s.corporateActions) && s.corporateActions.length > 0;

  // 매수 계획 자동 계산 (태산매매법)
  // 룰A: 2차 이후 매수가 = 이전 차수 실제 매수가 × 0.9 (계단식)
  // 룰B: 첫 미체결 차수 = bottomPrice × 0.9, 그 이후 = 이전 차수 × 0.9 (계단식)
  if (firstBuyPrice > 0 && firstBuyQuantity > 0) {
    // 누적형 재계산: updated[i-1]를 참조하므로 룰 전환 즉시 cascade 반영됨
    const updated: typeof s.buyPlans = [];
    for (let i = 0; i < s.buyPlans.length; i++) {
      const bp = s.buyPlans[i];
      let calcPrice: number;

      if (i === 0) {
        calcPrice = firstBuyPrice;
      } else if (bp.filled) {
        // 체결된 차수는 그대로 보존 (filledPrice 우선)
        calcPrice = bp.filledPrice || bp.price;
      } else if (isRuleB) {
        // 룰B: 첫 미체결이면 bottomPrice × 0.9, 그 이후는 이전 차수 × 0.9
        const prev = updated[i - 1];
        if (prev.filled) {
          // 첫 미체결 차수
          calcPrice = Math.round((bottomPrice as number) * 0.9);
        } else {
          // 이전도 미체결 → 룰B 계단식
          calcPrice = Math.round((prev.price || 0) * 0.9);
        }
      } else {
        // 룰A: 이전 차수 (체결가 우선) × 0.9
        const prev = updated[i - 1];
        const prevActualPrice = prev.filledPrice || prev.price || firstBuyPrice * Math.pow(0.9, i - 1);
        calcPrice = Math.round(prevActualPrice * 0.9);
      }

      // 비중 동일 원칙: 각 차수 계획 수량 = 1차 매수금액 / 해당 차수 가격
      // 체결된 차수: filledQuantity 우선 (실제 체결 수량), 없으면 저장된 quantity
      // 미체결 차수: corporateActions 종목은 firstBuyQuantity 고정, 아니면 비례 계산
      const firstBuyAmt = firstBuyPrice * firstBuyQuantity;
      const planQty = bp.filled
        ? (bp.filledQuantity || bp.quantity || firstBuyQuantity)
        : hasCorporateActions
          ? firstBuyQuantity
          : (calcPrice > 0 && firstBuyAmt > 0
            ? Math.round(firstBuyAmt / calcPrice)
            : firstBuyQuantity);

      // 차수별 룰 stamping:
      //   1차(i===0): 진입 매수 → 항상 'A' 기준
      //   체결 차수: 기존 stamp 보존 (없으면 'A' 폴백 — 레거시 데이터)
      //   미체결 차수: 현재 룰B 활성 여부로 결정 (체결 시점에 그대로 굳음)
      const stageRule: 'A' | 'B' =
        i === 0 ? 'A'
          : bp.filled ? (bp.rule || 'A')
            : (isRuleB ? 'B' : 'A');

      updated.push({
        ...bp,
        price: bp.filled ? (bp.filledPrice || bp.price) : calcPrice,
        quantity: planQty,
        filledDate: bp.filledDate,
        filledQuantity: bp.filledQuantity,
        filledPrice: bp.filledPrice,
        rule: stageRule,
      });
    }
    s.buyPlans = updated;
  }

  // 평단가 & 보유수량 계산 (실제 체결 데이터 우선 사용)
  let totalCost = 0;
  let totalQty = 0;
  s.buyPlans.forEach((bp) => {
    if (bp.filled) {
      const qty = bp.filledQuantity || bp.quantity;
      const price = bp.filledPrice || bp.price;
      if (price > 0 && qty > 0) {
        totalCost += price * qty;
        totalQty += qty;
      }
    }
  });

  // MA 매도로 차감된 수량
  let soldQty = 0;
  s.maSells.forEach((ms) => {
    if (ms.filled) soldQty += ms.quantity;
  });
  // 수익 매도로 차감
  // filledQuantity > 0이면 filled 플래그 무관하게 실제 체결로 처리
  // (reconcile manualOverride 보호 시 filled=false로 남는 버그 대비)
  s.sellPlans.forEach((sp) => {
    if (sp.filled || (sp.filledQuantity && sp.filledQuantity > 0)) {
      soldQty += sp.filledQuantity || sp.quantity;
    }
  });

  // 전량매도 감지: 모든 매도 계획이 체결(또는 filledQuantity>0)된 경우 → totalQuantity = 0
  const allSellsFilled = s.sellPlans.length > 0 && s.sellPlans.every(
    (sp) => sp.filled || ((sp.filledQuantity || 0) > 0)
  );
  s.totalQuantity = allSellsFilled ? 0 : Math.max(0, totalQty - soldQty);
  // corporateActions 종목: 합병/감자 후 단순 buyPlans 가중평균은 부정확
  // → reconcile이 키움 기반으로 설정한 Firestore avgPrice 유지
  s.avgPrice = (hasCorporateActions && (stock.avgPrice || 0) > 0)
    ? stock.avgPrice
    : (totalQty > 0 ? Math.round(totalCost / totalQty) : 0);

  // 매도 계획 자동 계산 (체결된 항목의 실제 데이터는 보존)
  // filledQuantity > 0이면 실제 체결 데이터가 있으므로 price/quantity 보존 (filled 플래그 무관)
  if (s.avgPrice > 0) {
    const sellQty = Math.round(totalQty * 0.2);
    s.sellPlans = s.sellPlans.map((sp) => {
      const effectiveFilled = sp.filled || ((sp.filledQuantity || 0) > 0);
      const sellPrice = Math.round(s.avgPrice * (1 + sp.percent / 100));
      return {
        ...sp,
        price: effectiveFilled ? sp.price : sellPrice,
        quantity: effectiveFilled ? sp.quantity : sellQty,
        filledDate: sp.filledDate,
        filledQuantity: sp.filledQuantity,
        filledPrice: sp.filledPrice,
      };
    });
  }

  return s;
}

export function useStocks() {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(true);
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    // 3초 후에도 응답 없으면 로딩 해제
    const timeout = setTimeout(() => setLoading(false), 3000);
    const q = query(collection(db, 'stocks'), orderBy('createdAt', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      clearTimeout(timeout);
      try {
        const list: Stock[] = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        })) as Stock[];
        // recalcStock 적용: Firestore의 stale totalQuantity/avgPrice를
        // buyPlans/sellPlans 실제 체결 데이터 기반으로 재계산 (매매완료 종목이 진행중으로 보이는 문제 방지)
        setStocks(list.map((s) => {
          try {
            return recalcStock(s);
          } catch (e) {
            console.error(`[recalcStock] ${s?.name} 오류:`, e);
            return s; // 오류 시 원본 데이터 그대로 사용
          }
        }));
      } catch (e) {
        console.error('[useStocks] snapshot 처리 오류:', e);
      } finally {
        setLoading(false);
      }
    }, (err) => {
      console.warn('Firestore subscription error:', err);
      clearTimeout(timeout);
      setLoading(false);
    });
    return () => {
      clearTimeout(timeout);
      unsub();
    };
  }, []);

  // saveStock(stock, true) = 즉시 저장 (디바운스 skip) - critical 작업용
  // saveStock(stock) = 디바운스 저장 (입력 중 자동저장용)
  const saveStock = useCallback(async (stock: Stock, immediate = false) => {
    // 보류 중인 디바운스 취소
    if (debounceTimers.current[stock.id]) {
      clearTimeout(debounceTimers.current[stock.id]);
      delete debounceTimers.current[stock.id];
    }
    if (immediate) {
      const { id, ...data } = stock;
      await setDoc(doc(db, 'stocks', id), { ...data, updatedAt: Date.now() });
      return;
    }
    debounceTimers.current[stock.id] = setTimeout(async () => {
      const { id, ...data } = stock;
      await setDoc(doc(db, 'stocks', id), { ...data, updatedAt: Date.now() });
    }, DEBOUNCE_MS);
  }, []);

  // addStock(name): 기본 종목 추가
  // addStock(name, { referencePeakPrice }): Watchlist에서 promote 시 최고점 함께 저장 (룰B 기준점)
  const addStock = useCallback(async (
    name: string,
    options?: { referencePeakPrice?: number; code?: string }
  ) => {
    const id = `stock_${Date.now()}`;
    const data: any = createDefaultStock(name);
    if (options?.referencePeakPrice && options.referencePeakPrice > 0) {
      data.referencePeakPrice = options.referencePeakPrice;
      data.referencePeakDate = new Date().toISOString().slice(0, 10);
    }
    if (options?.code) {
      data.code = options.code;
    }
    await setDoc(doc(db, 'stocks', id), data);
    return id;
  }, []);

  // Soft-delete: stocks → stocks_trash 로 이동 (30일 보관 후 cron이 영구삭제)
  const removeStock = useCallback(async (id: string) => {
    const ref = doc(db, 'stocks', id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const data = snap.data() as Omit<Stock, 'id'>;
    const now = Date.now();
    await setDoc(doc(db, 'stocks_trash', id), {
      ...data,
      originalId: id,
      deletedAt: now,
      expiresAt: now + TRASH_RETENTION_MS,
    });
    await deleteDoc(ref);
  }, []);

  return { stocks, loading, saveStock, addStock, removeStock };
}

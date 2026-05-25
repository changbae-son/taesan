// v2.3 - filledQuantity>0 매도 계획도 soldQty 반영 (filled 플래그 누락 버그 대응)
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
  const isRuleB = rule === 'B' && (bottomPrice || 0) > 0;

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
      // 미체결 차수: 1차 매수금액(firstBuyPrice × firstBuyQuantity) / 해당 차수 가격으로 비례 계산
      const firstBuyAmt = firstBuyPrice * firstBuyQuantity;
      const planQty = bp.filled
        ? (bp.filledQuantity || bp.quantity || firstBuyQuantity)
        : (calcPrice > 0 && firstBuyAmt > 0
          ? Math.round(firstBuyAmt / calcPrice)
          : firstBuyQuantity);

      updated.push({
        ...bp,
        price: bp.filled ? (bp.filledPrice || bp.price) : calcPrice,
        quantity: planQty,
        filledDate: bp.filledDate,
        filledQuantity: bp.filledQuantity,
        filledPrice: bp.filledPrice,
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
  s.avgPrice = totalQty > 0 ? Math.round(totalCost / totalQty) : 0;

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

  const addStock = useCallback(async (name: string) => {
    const id = `stock_${Date.now()}`;
    const data = createDefaultStock(name);
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

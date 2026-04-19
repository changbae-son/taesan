import { useState, useEffect, useCallback, useRef } from 'react';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  query,
  orderBy,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Stock } from '../types';

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
  const { firstBuyPrice, firstBuyQuantity } = s;

  // 매수 계획 자동 계산 (실제 체결가 기준 - 태산매매법)
  // 2차 이후 매수가 = 이전 차수 실제 매수가 × 0.9
  if (firstBuyPrice > 0 && firstBuyQuantity > 0) {
    s.buyPlans = s.buyPlans.map((bp, i) => {
      let calcPrice: number;
      if (i === 0) {
        calcPrice = firstBuyPrice;
      } else {
        // 이전 차수의 실제 체결가 우선, 없으면 계획가 사용
        const prevPlan = s.buyPlans[i - 1];
        const prevActualPrice = prevPlan.filledPrice || prevPlan.price || firstBuyPrice * Math.pow(0.9, i - 1);
        calcPrice = Math.round(prevActualPrice * 0.9);
      }

      return {
        ...bp,
        price: bp.filled ? bp.price : calcPrice, // 체결된 항목은 가격 보존
        quantity: firstBuyQuantity,
        filledDate: bp.filledDate,
        filledQuantity: bp.filledQuantity,
        filledPrice: bp.filledPrice,
      };
    });
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
  // 수익 매도로 차감 (실제 체결 수량 우선)
  s.sellPlans.forEach((sp) => {
    if (sp.filled) soldQty += sp.filledQuantity || sp.quantity;
  });

  s.totalQuantity = Math.max(0, totalQty - soldQty);
  s.avgPrice = totalQty > 0 ? Math.round(totalCost / totalQty) : 0;

  // 매도 계획 자동 계산 (체결된 항목의 실제 데이터는 보존)
  if (s.avgPrice > 0) {
    const sellQty = Math.round(totalQty * 0.2);
    s.sellPlans = s.sellPlans.map((sp) => {
      const sellPrice = Math.round(s.avgPrice * (1 + sp.percent / 100));
      return {
        ...sp,
        price: sp.filled ? sp.price : sellPrice,
        quantity: sp.filled ? sp.quantity : sellQty,
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
      const list: Stock[] = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      })) as Stock[];
      setStocks(list);
      setLoading(false);
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

  const saveStock = useCallback((stock: Stock) => {
    if (debounceTimers.current[stock.id]) {
      clearTimeout(debounceTimers.current[stock.id]);
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

  const removeStock = useCallback(async (id: string) => {
    await deleteDoc(doc(db, 'stocks', id));
  }, []);

  return { stocks, loading, saveStock, addStock, removeStock };
}

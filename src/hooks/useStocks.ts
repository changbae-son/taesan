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

export function recalcStock(stock: Stock, opts?: { trustStoredQty?: boolean }): Stock {
  const s = { ...stock };
  const { firstBuyPrice, firstBuyQuantity, rule, bottomPrice } = s;
  // 원본 Firestore totalQuantity (reconcile이 trades 기반으로 계산한 정확값)
  const storedQty = typeof stock.totalQuantity === 'number' ? stock.totalQuantity : null;

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

  // ─── 차수별 룰 판정 (백엔드 mapTradesToPlans와 동일 규칙) ───
  // N차 rule = (N-1차 매수 직후 ~ N차 매수 직전) 매도 회수 >= 3 ? 'B' : 'A'
  //   · 1차 = 'A'(진입), 같은 날·같은 가격 부분체결 = 1회, 직전 미체결 → 'A'
  const normDForRule = (d: string): string => {
    if (!d) return '';
    if (d.length === 8 && !d.includes('-')) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return d;
  };
  const countSellRoundsBetween = (start: string, end: string): number => {
    const groups = new Set<string>();
    const add = (date?: string, price?: number) => {
      const d = normDForRule(date || '');
      if (!d || d <= start) return;
      if (end && d >= end) return;
      groups.add(`${d}_${price || 0}`);
    };
    s.sellPlans.forEach((sp) => {
      if (sp.filled || (sp.filledQuantity || 0) > 0) add(sp.filledDate, sp.filledPrice);
    });
    s.maSells.forEach((m) => {
      if (m.filled) add(m.filledDate, m.price);
    });
    return groups.size;
  };
  const buyFilledDates = s.buyPlans.map((bp) => (bp.filled ? normDForRule(bp.filledDate || '') : ''));
  const stageRuleFor = (idx: number): 'A' | 'B' => {
    if (idx === 0) return 'A'; // 1차 진입 = 항상 룰A
    // ✅ 사용자가 매매규칙을 룰B로 수동 전환 + 저점 설정 시: 미체결 차수는 룰B 우선 적용.
    //   (체결된 과거 차수는 그 시점 사실대로 자동판정 유지 — 과거를 덮지 않음)
    if (!s.buyPlans[idx].filled && rule === 'B' && (bottomPrice || 0) > 0) return 'B';
    const prevDate = buyFilledDates[idx - 1];
    if (!prevDate) return 'A'; // 직전 차수 미체결 → 매도 구간 없음 → 룰A
    const thisDate = buyFilledDates[idx] || ''; // 미체결이면 '' (지금까지)
    return countSellRoundsBetween(prevDate, thisDate) >= 3 ? 'B' : 'A';
  };
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

      // ✅ 차수별 룰: 직전 매수 후 매도 회수로 자동 판정 (종목 rule 버튼 무관)
      const stageRule: 'A' | 'B' = stageRuleFor(i);
      const thisStageRuleB = stageRule === 'B' && (bottomPrice || 0) > 0;

      if (i === 0) {
        calcPrice = firstBuyPrice;
      } else if (bp.filled) {
        // 체결된 차수는 그대로 보존 (filledPrice 우선)
        calcPrice = bp.filledPrice || bp.price;
      } else if (thisStageRuleB) {
        // 룰B 차수: 첫 룰B면 bottomPrice × 0.9, 연속이면 이전 차수 × 0.9
        const prev = updated[i - 1];
        if (prev.filled) {
          calcPrice = Math.round((bottomPrice as number) * 0.9);
        } else {
          calcPrice = Math.round((prev.price || 0) * 0.9);
        }
      } else {
        // 룰A 차수: 이전 차수 (체결가 우선) × 0.9
        const prev = updated[i - 1];
        const prevActualPrice = prev.filledPrice || prev.price || firstBuyPrice * Math.pow(0.9, i - 1);
        calcPrice = Math.round(prevActualPrice * 0.9);
      }

      // ─── 기준가(basisPrice): 룰이 정한 매수 기준가 (체결돼도 실제가로 안 덮음) ───
      //   룰A N차 = (N-1차 실제가 우선) × 0.9 / 룰B N차 = 저점 × 0.9
      //   룰B인데 저점(bottomPrice) 없으면 0 (계산 불가 → UI '저점필요')
      let basisPrice: number;
      if (i === 0) {
        basisPrice = firstBuyPrice; // 1차 기준 = 진입 실제가
      } else if (stageRule === 'B') {
        if ((bottomPrice || 0) > 0) {
          const prev = updated[i - 1];
          basisPrice = prev.filled
            ? Math.round((bottomPrice as number) * 0.9)
            : Math.round((prev.basisPrice || prev.price || 0) * 0.9);
        } else {
          basisPrice = 0; // 룰B 저점 미설정
        }
      } else {
        // 룰A: 이전 차수 실제가(체결) 우선 × 0.9, 없으면 이전 기준가 × 0.9
        const prev = updated[i - 1];
        const prevActual = prev.filledPrice || prev.basisPrice || prev.price || firstBuyPrice * Math.pow(0.9, i - 1);
        basisPrice = Math.round(prevActual * 0.9);
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

      updated.push({
        ...bp,
        price: bp.filled ? (bp.filledPrice || bp.price) : calcPrice,
        basisPrice,
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
  const mappedRemain = Math.max(0, totalQty - soldQty);
  // ✅ 미분류 매도 대응: sellPlans/maSells에 매핑 안 된 매도가 있으면 mappedRemain이 과다.
  //    trustStoredQty=true(로드 시점)면 reconcile이 trades 기반으로 계산한 Firestore
  //    totalQuantity를 신뢰 (단, 전량매도 감지 시는 0).
  //    편집 시점(trustStoredQty 미지정)엔 매핑 기반 재계산 — 사용자 토글 즉시 반영.
  if (allSellsFilled) {
    s.totalQuantity = 0;
  } else if (
    opts?.trustStoredQty &&
    storedQty !== null &&
    storedQty >= 0 &&
    storedQty !== mappedRemain
  ) {
    // Firestore(키움/trades 기반)가 매핑 잔고와 다름 = 미분류 매도 존재 → Firestore 신뢰
    s.totalQuantity = storedQty;
  } else {
    s.totalQuantity = mappedRemain;
  }
  // 3대 정본: 평단 = 키움(reconcile/sync가 기록한 Firestore avgPrice).
  // 키움 관리 종목(code 有)·합병감자 종목은 키움 평단 유지 — 프론트 buyPlans 가중평균
  // 재계산이 매도분 원가차감 평단(키움)을 덮어써서 기준가가 키움과 어긋나던 문제 방지
  // (예: 젬백스 키움14957 vs buyPlans가중15940). 수동·신규 종목(code 無)만 계산값 사용.
  const keepKiwoomAvg = (hasCorporateActions || !!s.code) && (stock.avgPrice || 0) > 0;
  s.avgPrice = keepKiwoomAvg
    ? (stock.avgPrice as number)
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
  // 원본 Firestore 문서 캐시 (recalc 적용 전) — 저장 시 진실 필드 보호용
  const rawDocsRef = useRef<Record<string, any>>({});

  useEffect(() => {
    // 3초 후에도 응답 없으면 로딩 해제
    const timeout = setTimeout(() => setLoading(false), 3000);
    const q = query(collection(db, 'stocks'), orderBy('createdAt', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      clearTimeout(timeout);
      try {
        const raw: Record<string, any> = {};
        snap.docs.forEach((d) => { raw[d.id] = d.data(); });
        rawDocsRef.current = raw;
        const list: Stock[] = snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        })) as Stock[];
        // recalcStock 적용: Firestore의 stale totalQuantity/avgPrice를
        // buyPlans/sellPlans 실제 체결 데이터 기반으로 재계산 (매매완료 종목이 진행중으로 보이는 문제 방지)
        setStocks(list.map((s) => {
          try {
            // 로드 시점: Firestore totalQuantity(reconcile trades 기반 정확값) 신뢰
            // → 미분류 매도가 슬롯에 매핑 안 돼도 화면 잔고 정확
            return recalcStock(s, { trustStoredQty: true });
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

  // ─── 진실 필드 보호 (단일 진실 원칙) ───
  // totalQuantity/avgPrice의 진실 = 키움 잔고(sync/reconcile이 기록).
  // 프론트 recalcStock 재계산값이 이를 덮어쓰면, 미분류 매도가 있는 종목의
  // 잔고가 오염됨 (예: CS 매매완료 0 → 60으로 되살아나던 버그).
  // → 키움 관리 종목(code 있음)은 저장 시 원본 Firestore 값으로 강제.
  //    (수동 종목·신규 종목은 원본 없으므로 계산값 그대로 저장)
  const protectTruthFields = useCallback((id: string, data: any): any => {
    const raw = rawDocsRef.current[id];
    if (!raw) return data; // 신규 종목 — 보호 대상 아님
    const isKiwoomManaged = !!(data.code || raw.code);
    if (!isKiwoomManaged) return data;
    const out = { ...data };
    if (typeof raw.totalQuantity === 'number') out.totalQuantity = raw.totalQuantity;
    if (typeof raw.avgPrice === 'number' && raw.avgPrice > 0) out.avgPrice = raw.avgPrice;
    return out;
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
      await setDoc(doc(db, 'stocks', id), protectTruthFields(id, { ...data, updatedAt: Date.now() }));
      return;
    }
    debounceTimers.current[stock.id] = setTimeout(async () => {
      const { id, ...data } = stock;
      await setDoc(doc(db, 'stocks', id), protectTruthFields(id, { ...data, updatedAt: Date.now() }));
    }, DEBOUNCE_MS);
  }, [protectTruthFields]);

  // addStock(name): 기본 종목 추가
  // addStock(name, { referencePeakPrice }): Watchlist에서 promote 시 최고점 함께 저장 (룰B 기준점)
  const addStock = useCallback(async (
    name: string,
    options?: { referencePeakPrice?: number; referencePeakDate?: string; code?: string }
  ) => {
    const id = `stock_${Date.now()}`;
    const data: any = createDefaultStock(name);
    if (options?.referencePeakPrice && options.referencePeakPrice > 0) {
      data.referencePeakPrice = options.referencePeakPrice;
      // 관심종목에 기록된 기준 최고가 날짜 우선, 없으면 오늘 (룰B 저점추적 시작일)
      data.referencePeakDate = options.referencePeakDate || new Date().toISOString().slice(0, 10);
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

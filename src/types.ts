export interface BuyPlan {
  level: number; // 1~5차
  price: number;
  quantity: number; // 계획 수량
  filled: boolean;
  filledDate?: string; // 체결일 (YYYY-MM-DD)
  filledQuantity?: number; // 실제 체결 수량
  filledPrice?: number; // 실제 체결 단가
  manualOverride?: boolean; // true면 sync/reconcile 시 덮어쓰지 않음
}

export interface SellPlan {
  percent: number; // 5, 10, 15, 20, 25
  price: number;
  quantity: number; // 계획 수량
  filled: boolean;
  filledDate?: string; // 체결일 (YYYY-MM-DD)
  filledQuantity?: number; // 실제 체결 수량
  filledPrice?: number; // 실제 체결 단가
  manualOverride?: boolean; // true면 sync/reconcile 시 덮어쓰지 않음
}

export interface MASell {
  ma: number; // 20, 60, 120
  price: number;
  quantity: number;
  filled: boolean;
  filledDate?: string;
  fromSellPlan?: number; // 수익매도 몇차에서 이동했는지 (구버전 호환)
  insertAfterPercent?: number; // 0|5|10|15|20|25 - sellPlans 어느 차수 다음에 표시할지
  splitFromPercent?: number; // 분리 시 원래 sellPlan의 percent (복원용)
}

// 매매완료 후 재진입 추적 (태산매매법: 최저가 → +100% → -50% → 첫 양봉 = 1차 매수)
export interface ReentryTracking {
  enabled: boolean;                    // ON/OFF (사용자 수동 중지 가능)
  status: 'tracking' | 'ready' | 'paused';

  // Phase 1: 최저가 추적
  lowPrice: number;                    // 매매기간 + 매매완료 후 누적 최저가
  lowPriceDate: string;                // 최저가 일자 (YYYY-MM-DD)
  lowPriceSource: 'kiwoom_daily' | 'manual' | 'realtime'; // 최저가 출처

  // Phase 2: 반등 확인 (lowPrice 대비 +100% 도달)
  rebounded: boolean;
  reboundDate?: string;

  // Phase 3: 신고점 추적 (자동 갱신)
  peakPrice: number;
  peakPriceDate: string;

  // Phase 4: -50% 매수 목표가
  targetPrice: number;                 // peakPrice * 0.5

  // 매수 대기 (-50% 도달)
  readyAt?: string;

  // 양봉 신호
  signalSent?: boolean;
  signalDate?: string;

  startedAt: number;                   // 추적 시작 시각 (매매완료 일자 timestamp)
}

// 한 사이클 매매 기록 (매매완료 시점에 영구 보관)
export interface TradingCycle {
  cycleNo: number;                     // 1, 2, 3 ...
  startDate: string;                   // 1차 매수일
  endDate: string;                     // 매매완료일
  totalBuyAmt: number;
  totalSellAmt: number;
  realizedProfit: number;
  profitPercent: number;
  buyPlans: BuyPlan[];                 // 그 사이클 매매기록 스냅샷
  sellPlans: SellPlan[];
  maSells: MASell[];
  reentryLowPrice?: number;            // 그 사이클 종료 후 추적된 최저가 (참고용)
  reentryPeakPrice?: number;
  rule: 'A' | 'B';                     // 그 사이클의 룰
}

export interface Stock {
  id: string;
  name: string;
  code?: string; // 종목코드 (키움 stk_cd)
  rule: 'A' | 'B'; // A: 매수가 대비 -10%, B: 저점 대비 -10%
  firstBuyPrice: number;
  firstBuyQuantity: number;
  currentPrice: number;
  avgPrice: number;
  totalQuantity: number;
  buyPlans: BuyPlan[];
  sellPlans: SellPlan[];
  maSells: MASell[];
  sellCount: number; // 누적 매도 횟수
  buySignal?: 'signal' | 'waiting' | null; // 매수신호 상태
  buySignalAt?: number; // 매수신호 체크 시간
  buySignalOpen?: number; // 당일 시가
  buySignalSent?: boolean; // 해당 차수 첫 양봉 알림 발송 여부
  buySignalLevel?: number; // 알림 발송한 매수 차수
  sellSignalSent?: boolean; // 수동 매도 차수(25%+) 알림 발송 여부
  sellSignalLevel?: number; // 알림 발송한 매도 차수
  sellSignalAt?: number; // 수동 매도 알림 시간
  // Rule B: 저점 추적 (rule='B'일 때 자동 업데이트)
  bottomPrice?: number;  // 마지막 매수 이후 최저가 (Rule B 다음 매수가 = bottomPrice × 0.9)
  // 이동평균선 (15:20~15:30 일 1회 계산)
  ma20?: number;
  ma60?: number;
  ma120?: number;
  maCalcDate?: string;     // 마지막 계산일 (YYYY-MM-DD)
  maAlertDate?: string;    // 마지막 MA 근접 알림 발송일
  maCandles?: number;      // 계산에 사용된 봉 수
  profitAlertDate?: string; // 마지막 23%+ 수익 알림 발송일
  // 재진입 추적 (매매완료 후 다시 1차 매수까지)
  reentry?: ReentryTracking;
  // 사이클 history (영구 보관) - 각 매매완료 시점에 push
  cycles?: TradingCycle[];
  createdAt: number;
  updatedAt: number;
}

// 휴지통: 삭제된 stock을 30일 보관 후 영구삭제
export const TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface TrashedStock extends Stock {
  deletedAt: number;       // 삭제 시각 (timestamp)
  expiresAt: number;       // 영구삭제 예정 시각 (deletedAt + 30일)
  originalId: string;      // 원래 stocks 컬렉션의 doc id
}

export interface Trade {
  id: string;
  date: string;
  stockName: string;
  type: 'buy' | 'sell' | 'watch';
  price: number;
  quantity: number;
  memo: string;
  tags: string[];
  createdAt: number;
}

export interface Snapshot {
  id: string;
  stockId: string;
  stockName: string;
  date: string;
  profitPercent: number;
  createdAt: number;
}

export interface WatchItem {
  id: string;
  name: string;
  code: string;
  peakPrice: number;
  targetPercent: number; // -50 기본
  currentPrice: number;
  openPrice: number;
  prevClose: number;
  status: 'watching' | 'approaching' | 'ready' | 'bought';
  alertLevel: 0 | 1 | 2 | 3;
  createdAt: number;
  updatedAt: number;
}

export type TabType = 'list' | 'detail' | 'journal' | 'dashboard' | 'kiwoom' | 'completed' | 'watchlist';

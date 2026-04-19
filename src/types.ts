export interface BuyPlan {
  level: number; // 1~5차
  price: number;
  quantity: number; // 계획 수량
  filled: boolean;
  filledDate?: string; // 체결일 (YYYY-MM-DD)
  filledQuantity?: number; // 실제 체결 수량
  filledPrice?: number; // 실제 체결 단가
}

export interface SellPlan {
  percent: number; // 5, 10, 15, 20, 25
  price: number;
  quantity: number; // 계획 수량
  filled: boolean;
  filledDate?: string; // 체결일 (YYYY-MM-DD)
  filledQuantity?: number; // 실제 체결 수량
  filledPrice?: number; // 실제 체결 단가
}

export interface MASell {
  ma: number; // 20, 60, 120
  price: number;
  quantity: number;
  filled: boolean;
  filledDate?: string;
  fromSellPlan?: number; // 수익매도 몇차에서 이동했는지
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
  createdAt: number;
  updatedAt: number;
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

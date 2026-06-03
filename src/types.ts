export interface BuyPlan {
  level: number; // 1~5차
  price: number;
  quantity: number; // 계획 수량
  filled: boolean;
  filledDate?: string; // 체결일 (YYYY-MM-DD)
  filledQuantity?: number; // 실제 체결 수량
  filledPrice?: number; // 실제 체결 단가
  manualOverride?: boolean; // true면 sync/reconcile 시 덮어쓰지 않음
  rule?: 'A' | 'B'; // 이 차수 매수가가 산정된 룰 (A: 이전차수×0.9, B: 저점×0.9). 체결되면 그 시점 룰 보존
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
  consumedTradeIds?: string[]; // ✅ 옵션 D: 이 슬롯이 흡수한 trade.id 목록 (정확 매칭용)
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
  consumedTradeIds?: string[]; // ✅ 옵션 D: 이 MA 슬롯이 흡수한 trade.id 목록 (정확 매칭용)
}

// 포지션 (현물/신용 분리 추적)
// 키움 잔고 API는 같은 종목을 현물/신용 별도 row로 반환함.
// fetchHoldings에서 dedupe하여 종목당 하나의 stock doc으로 통합하되,
// 각 포지션 정보(수량/평단/매수일/만기/이자)는 이 배열에 보존.
export interface Position {
  type: 'cash' | 'credit';
  quantity: number;            // 이 포지션 수량
  avgPrice: number;            // 이 포지션 평단가
  since?: string;              // 최초 매수일 (YYYY-MM-DD, 추정)
  // 신용 전용 메타 (Phase 2에서 채워짐)
  dueDate?: string;            // 만기 예정일 (매수일 + 90일)
  interestRate?: number;       // 연 이자율 (예: 0.075 = 7.5%)
  interestAccrued?: number;    // 누적 이자 (원)
  interestAsOf?: string;       // 이자 계산 기준일
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

// 감자/액면분할/액면합병/합병 보정 이력
// ratio 적용 공식: quantity *= ratio, price /= ratio
//   - 10:1 감자          → ratio = 0.1  (수량↓ 가격↑)
//   - 1:10 액면분할      → ratio = 10   (수량↑ 가격↓)
//   - 5:1 액면합병       → ratio = 0.2
//   - 합병(주식교환비율) → ratio = 비율 (예: 1주당 0.7주 → ratio = 0.7)
export interface CorporateAction {
  id: string;                  // 'ca_20260514_001' 형식
  date: string;                // 효력 발생일 YYYY-MM-DD
  ratio: number;               // quantity 배율 (price는 1/ratio 적용)
  type: 'reverseSplit' | 'forwardSplit' | 'capitalReduction' | 'merger';
  note?: string;
  appliedAt: number;           // 보정 실행 timestamp
  affectedTradeIds: string[];  // 보정된 trade IDs (롤백용)
  // 보정 전 firstBuyPrice/firstBuyQuantity 백업 (롤백용)
  backupFirstBuyPrice?: number;
  backupFirstBuyQuantity?: number;
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

// 과거 라운드 수동 수정 저장 (roundHistory)
export interface RoundSellSlot {
  percent: number;
  price: number;       // 해당 라운드 평단 기준 목표가
  quantity: number;    // 수량
  filled: boolean;
  filledDate?: string;
  filledPrice?: number;
}

export interface RoundHistory {
  level: number;           // 매수 차수 (1=1차, 2=2차 ...)
  roundAvgPrice: number;   // 이 라운드 평단가
  holdingAtStart: number;  // 라운드 시작 보유수량
  slotQty: number;         // 슬롯당 계획 수량
  sellSlots: RoundSellSlot[];
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
  // ─── Rule B: 저점 추적 + 양봉 매수 신호 ───
  // 활성화 조건: 마지막 매수 차수 이후 누적 매도(이익+MA) 3회 이상
  bottomPrice?: number;              // 시작점~현재까지 일봉 low 중 최저값
  bottomPriceDate?: string;          // 최저 도달 날짜 (YYYY-MM-DD)
  bottomPriceSource?: 'daily_low' | 'daily_low_frozen' | 'realtime' | 'manual'; // 데이터 소스 (frozen: 3차 매도로 구간 확정)
  referencePeakPrice?: number;       // 시작점 (Watchlist 등록 시 사용자가 입력한 최고점)
  referencePeakDate?: string;        // 시작점 등록 날짜
  sellsSinceLastBuy?: number;        // 마지막 매수 차수 이후 누적 매도 카운트 (recalcStock이 갱신)
  ruleBActive?: boolean;             // 룰B 활성화 여부 (sellsSinceLastBuy >= 3)
  ruleBSignalSent?: boolean;         // 양봉 매수 신호 발송 여부
  ruleBSignalDate?: string;          // 양봉 신호 발송 날짜
  // 이동평균선 (15:20~15:30 일 1회 계산)
  ma20?: number;
  ma60?: number;
  ma120?: number;
  maCalcDate?: string;     // 마지막 계산일 (YYYY-MM-DD)
  maAlertDate?: string;    // 마지막 MA 근접 알림 발송일
  maCandles?: number;      // 계산에 사용된 봉 수
  profitAlertDate?: string; // 마지막 23%+ 수익 알림 발송일
  // ✅ 신용/융자거래 종목 여부 (키움 응답의 별표 prefix로 감지)
  // 현물+신용 혼합 시에도 true (positions 배열로 세부 확인)
  isCreditTrade?: boolean;
  // 현물/신용 포지션 세부 (Phase 1a 추가)
  // 1개 = 단일 포지션 (현물 또는 신용 단독)
  // 2개 = 혼합 (현물 + 신용)
  positions?: Position[];
  // ✅ 매도 매핑 정합성 audit 결과 (auditSellMapping이 백그라운드로 갱신)
  // tradeSellQty - (sellPlans+maSells filled 합) 값. 0이면 정상, !=0이면 mismatch.
  mappingAuditDiff?: number;
  mappingAuditAt?: number;
  // 옵션 B: filled 슬롯의 filledPrice가 percent band와 어긋난 슬롯 수
  mappingBandIssues?: number;
  // P3: consumedTradeIds 누락 슬롯 수 (옵션 C fallback 의존 = 신뢰도 낮음)
  mappingIntegrityIssues?: number;
  // Option B: consumedTradeIds가 slot 데이터와 불일치한 슬롯 수 (잘못된 trade 참조 — 자동 정정 후 남은 건)
  mappingConsumedMismatch?: number;
  // 재진입 추적 (매매완료 후 다시 1차 매수까지)
  reentry?: ReentryTracking;
  // 사이클 history (영구 보관) - 각 매매완료 시점에 push
  cycles?: TradingCycle[];
  // 과거 라운드 수동 수정 이력 (복기 모드에서 직접 편집 시 저장)
  roundHistory?: RoundHistory[];
  // 감자/분할/합병 보정 이력 (Option 1)
  corporateActions?: CorporateAction[];
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
  // ✅ Phase 1a: 신용/융자거래 여부 (키움 응답의 별표 prefix로 감지)
  isCreditTrade?: boolean;
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

export type TabType = 'list' | 'detail' | 'credit' | 'journal' | 'dashboard' | 'kiwoom' | 'completed' | 'watchlist';

export interface BuyPlan {
  level: number; // 1~5차
  price: number;
  quantity: number;
  filled: boolean;
  filledDate?: string; // 체결일 (YYYY-MM-DD)
}

export interface SellPlan {
  percent: number; // 5, 10, 15, 20, 25
  price: number;
  quantity: number;
  filled: boolean;
  filledDate?: string; // 체결일 (YYYY-MM-DD)
}

export interface MASell {
  ma: number; // 20, 60, 120
  price: number;
  quantity: number;
  filled: boolean;
}

export interface Stock {
  id: string;
  name: string;
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

export type TabType = 'list' | 'detail' | 'journal' | 'dashboard' | 'kiwoom';

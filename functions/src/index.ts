/**
 * 태산매매법 - Firebase Cloud Functions
 * 키움증권 REST API → Firestore 동기화
 * v2.3 - 보유수량0 종목도 전량매도 처리, 매도플랜 정확한 반영
 *
 * 구조: 웹앱 → Cloud Function(고정IP) → 키움 REST API → Firestore
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import fetch from "node-fetch";
import cors = require("cors");

// JB Trader Web 브릿지 — 별도 파일로 격리 (태산 로직과 무관)
// 같은 VPC connector / 정적 IP를 공유. 키와 Auth 토큰만 분리.
export {
  jbQuote,
  jbScreenerResults,
  jbScreenerEligible,
  jbTelegramTest,
  jbSendTelegram,
  jbKiwoomKeysStatus,
  jbKiwoomKeysSet,
  jbOrder,
  jbHoldingsSync,
  jbTradesSync,
  jbScreenerFilters,
  jbScreenerFiltersSet,
  jbScreenerHistory,
  jbMa20Bulk,
  jbQuoteAdmin,
  jbSendTelegramAdmin,
  jbOrderAdmin,
  jbHoldingCodesPublishAdmin,
} from "./jb-bridge";

admin.initializeApp();
const db = admin.firestore();
// undefined 값을 자동으로 무시 (Firestore에 저장하지 않음) - 안전망
db.settings({ignoreUndefinedProperties: true});
const corsHandler = cors({origin: true});

// ─── 키움 REST API 설정 ───
interface KiwoomConfig {
  appKey: string;
  appSecret: string;
  accountNo: string;
  htsId: string;
  baseUrl: string;
}

async function getKiwoomConfig(): Promise<KiwoomConfig> {
  const doc = await db.collection("settings").doc("kiwoom").get();
  const data = doc.data();
  if (!data) {
    throw new Error("키움 API 설정이 없습니다. 웹앱에서 설정해주세요.");
  }
  return {
    appKey: data.appKey || "",
    appSecret: data.appSecret || "",
    accountNo: data.accountNo || "",
    htsId: data.htsId || "",
    baseUrl: "https://api.kiwoom.com",
  };
}

// ─── 키움 토큰 발급 ───
async function getAccessToken(config: KiwoomConfig): Promise<string> {
  // 캐시된 토큰 확인
  const tokenDoc = await db.collection("settings").doc("kiwoom_token").get();
  const tokenData = tokenDoc.data();

  if (tokenData && tokenData.expiresAt > Date.now()) {
    return tokenData.accessToken;
  }

  // 새 토큰 발급
  const res = await fetch(`${config.baseUrl}/oauth2/token`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: config.appKey,
      secretkey: config.appSecret,
    }),
  });

  const data = await res.json() as any;

  if (!data.token) {
    throw new Error(`토큰 발급 실패: ${JSON.stringify(data)}`);
  }

  // 토큰 캐시 저장 (23시간 유효)
  await db.collection("settings").doc("kiwoom_token").set({
    accessToken: data.token,
    expiresAt: Date.now() + 23 * 60 * 60 * 1000,
  });

  return data.token;
}

// ─── 키움 종목명/코드 정리 헬퍼 ───
// 신용/융자거래 종목은 키움 API에서 "*종목명" / "*A012345" 형태로 prefix 별표 반환됨.
// ka10072(매도), ka10076(매수) 등에서 응답된 stk_nm/stk_cd에 별표 붙으면
// stocks 컬렉션의 정규 종목명/코드와 매칭 안 됨 → trade 매핑 실패.
// 모든 키움 응답에서 leading * 제거.
function cleanKiwoomField(s: string): string {
  return (s || "").trim().replace(/^\*+/, "");
}

// ─── Phase 1a: trades 기반 positions 재계산 ───
// 키움 kt00005 잔고 API가 같은 종목의 현물+신용을 통합 row로 반환할 때
// trades 컬렉션의 isCreditTrade 플래그로 분리 정보 재구성.
//
// 입력: stockTrades (해당 종목의 모든 trade), totalQuantity (키움 잔고), totalAvg (키움 평단)
// 출력: positions 배열 [{type, quantity, avgPrice, since?}]
//
// 알고리즘:
//   1. trades에서 cash/credit 별로 매수/매도 합산
//   2. 잔여 = 매수 − 매도 (각각)
//   3. 잔여가 키움 totalQty와 차이나면 키움 값을 우선 (잔여 = 키움 비율로 분배)
//   4. avgPrice는 각 type의 매수 가중평균
//   5. since는 가장 오래된 매수일
// 신용 만기일 계산 (매수일 + 90일)
function calcCreditDueDate(sinceDate: string): string {
  try {
    const d = new Date(sinceDate);
    if (isNaN(d.getTime())) return "";
    d.setDate(d.getDate() + 90);
    return d.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

// 일할 이자 계산 (since ~ asOf 사이 일수만큼)
// 기본 연 이자율 7.5%
function calcAccruedInterest(
  creditAmt: number,
  sinceDate: string,
  asOfDate: string,
  annualRate: number = 0.075
): number {
  try {
    const since = new Date(sinceDate);
    const asOf = new Date(asOfDate);
    if (isNaN(since.getTime()) || isNaN(asOf.getTime())) return 0;
    const days = Math.max(0, Math.ceil((asOf.getTime() - since.getTime()) / (1000 * 60 * 60 * 24)));
    return Math.round((creditAmt * annualRate * days) / 365);
  } catch {
    return 0;
  }
}

function computePositionsFromTrades(
  stockTrades: Array<{type: string; price: number; quantity: number; date?: string; isCreditTrade?: boolean}>,
  totalQuantity: number,
  totalAvg: number,
  // Phase 2: 기존 positions가 있으면 만기/이자 메타데이터 보존 + 갱신
  existingPositions?: Array<{type: "cash" | "credit"; quantity: number; avgPrice: number; since?: string; dueDate?: string; interestRate?: number; interestAccrued?: number; interestAsOf?: string}>
): Array<{type: "cash" | "credit"; quantity: number; avgPrice: number; since?: string; dueDate?: string; interestRate?: number; interestAccrued?: number; interestAsOf?: string}> {
  if (totalQuantity <= 0) return [];

  let cashBoughtQty = 0;
  let cashBoughtAmt = 0;
  let cashSoldQty = 0;
  let cashFirstDate: string | undefined;
  let creditBoughtQty = 0;
  let creditBoughtAmt = 0;
  let creditSoldQty = 0;
  let creditFirstDate: string | undefined;

  for (const t of stockTrades) {
    const qty = Number(t.quantity) || 0;
    const price = Number(t.price) || 0;
    if (qty <= 0) continue;
    const isCredit = t.isCreditTrade === true;
    if (t.type === "buy") {
      if (isCredit) {
        creditBoughtQty += qty;
        creditBoughtAmt += qty * price;
        if (!creditFirstDate || (t.date && t.date < creditFirstDate)) creditFirstDate = t.date;
      } else {
        cashBoughtQty += qty;
        cashBoughtAmt += qty * price;
        if (!cashFirstDate || (t.date && t.date < cashFirstDate)) cashFirstDate = t.date;
      }
    } else if (t.type === "sell") {
      if (isCredit) creditSoldQty += qty;
      else cashSoldQty += qty;
    }
  }

  const cashNetQty = Math.max(0, cashBoughtQty - cashSoldQty);
  const creditNetQty = Math.max(0, creditBoughtQty - creditSoldQty);
  const tradesNetTotal = cashNetQty + creditNetQty;

  const cashAvg = cashBoughtQty > 0 ? Math.round(cashBoughtAmt / cashBoughtQty) : 0;
  const creditAvg = creditBoughtQty > 0 ? Math.round(creditBoughtAmt / creditBoughtQty) : 0;

  // 기존 credit position의 메타데이터 (만기/이자) 보존용
  const existingCredit = existingPositions?.find((p) => p.type === "credit");

  // 신용 포지션에 만기/이자 메타데이터 채우기
  const enrichCredit = (pos: {type: "cash" | "credit"; quantity: number; avgPrice: number; since?: string}): typeof pos & {dueDate?: string; interestRate?: number; interestAccrued?: number; interestAsOf?: string} => {
    if (pos.type !== "credit") return pos;
    const todayKstStr = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}))
      .toISOString().slice(0, 10);
    // since 우선순위: trades에서 추론된 값 > 기존 저장값 > 오늘 (fallback)
    // fallback="오늘"은 정확하진 않지만 사용자가 추후 수정 가능
    const since = pos.since || existingCredit?.since || todayKstStr;
    // dueDate: 기존 값 유지 OR since + 90일 자동 계산
    const dueDate = existingCredit?.dueDate || calcCreditDueDate(since);
    const interestRate = existingCredit?.interestRate || 0.075; // 기본 7.5%
    // 이자 누적: since ~ 오늘까지
    const creditAmt = pos.quantity * pos.avgPrice;
    const interestAccrued = calcAccruedInterest(creditAmt, since, todayKstStr, interestRate);
    return {
      ...pos,
      since,
      dueDate,
      interestRate,
      interestAccrued,
      interestAsOf: todayKstStr,
    };
  };

  // 잔여가 키움 totalQty와 일치하면 그대로 사용
  if (tradesNetTotal === totalQuantity) {
    const out: Array<any> = [];
    // ✅ 정본 ②: 단일 포지션(현물전용/신용전용)은 키움 통합평단(totalAvg) 사용.
    //   cashAvg/creditAvg(매수가중)는 매도분 원가차감을 안 해 키움과 달라짐(시지메드텍 1512 vs 1503).
    if (cashNetQty > 0 && creditNetQty === 0 && totalAvg > 0) {
      out.push({type: "cash", quantity: cashNetQty, avgPrice: totalAvg, since: cashFirstDate});
      return out;
    }
    if (creditNetQty > 0 && cashNetQty === 0 && totalAvg > 0) {
      out.push(enrichCredit({type: "credit", quantity: creditNetQty, avgPrice: totalAvg, since: creditFirstDate}));
      return out;
    }
    // 혼합(현물+신용): 키움 통합평단을 type별로 못 나눔 → 각 매수가중 유지
    if (cashNetQty > 0) out.push({type: "cash", quantity: cashNetQty, avgPrice: cashAvg, since: cashFirstDate});
    if (creditNetQty > 0) out.push(enrichCredit({type: "credit", quantity: creditNetQty, avgPrice: creditAvg, since: creditFirstDate}));
    return out;
  }

  // 불일치: 키움 totalQty와 비율 매칭
  if (creditBoughtQty === 0 && cashBoughtQty === 0) {
    return [{type: "cash", quantity: totalQuantity, avgPrice: totalAvg}];
  }

  if (creditBoughtQty === 0) {
    // ✅ 신용 매수 trade가 없으면 전량 현금.
    //   ⚠️ 과거: 평단차이(totalAvg vs cashAvg)>2%를 신용 비중으로 추정 → 매도 종목을
    //      신용혼합으로 오판(젬백스 키움현금572 → cash502+credit70). 평단차이는 매도분
    //      원가차감(키움 이동평균)이지 신용이 아님. → 추정 제거, 전량 현금(키움 totalAvg).
    return [{type: "cash", quantity: totalQuantity, avgPrice: totalAvg, since: cashFirstDate}];
  }

  // credit trade 존재 + 키움 잔고 불일치: 비율 매칭
  const totalBoughtNet = cashNetQty + creditNetQty;
  if (totalBoughtNet === 0) {
    // ✅ Phase 1a 보강: trades 매수=매도라 net=0인데 키움 잔고가 있는 경우
    // 매수 trades의 신용 비율로 잔여를 추정
    const totalBought = cashBoughtQty + creditBoughtQty;
    if (totalBought > 0) {
      const creditBuyRatio = creditBoughtQty / totalBought;
      const creditQty = Math.round(totalQuantity * creditBuyRatio);
      const cashQty = totalQuantity - creditQty;
      const out: Array<any> = [];
      if (cashQty > 0) out.push({type: "cash", quantity: cashQty, avgPrice: cashAvg || totalAvg, since: cashFirstDate});
      if (creditQty > 0) out.push(enrichCredit({type: "credit", quantity: creditQty, avgPrice: creditAvg || totalAvg, since: creditFirstDate}));
      if (out.length > 0) return out;
    }
    return [{type: "cash", quantity: totalQuantity, avgPrice: totalAvg}];
  }
  const ratio = totalQuantity / totalBoughtNet;
  const adjustedCash = Math.round(cashNetQty * ratio);
  const adjustedCredit = totalQuantity - adjustedCash;
  const out: Array<any> = [];
  if (adjustedCash > 0) out.push({type: "cash", quantity: adjustedCash, avgPrice: cashAvg, since: cashFirstDate});
  if (adjustedCredit > 0) out.push(enrichCredit({type: "credit", quantity: adjustedCredit, avgPrice: creditAvg, since: creditFirstDate}));
  return out;
}

// ─── 잔고 조회 (kt00005 체결잔고요청) ───
async function fetchHoldings(
  config: KiwoomConfig,
  token: string
): Promise<any[]> {
  const res = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "authorization": `Bearer ${token}`,
      "api-id": "kt00005",
    },
    body: JSON.stringify({
      dmst_stex_tp: "KRX",
    }),
  });

  const data = await res.json() as any;

  // 에러 체크
  if (data.return_code && data.return_code !== "0") {
    throw new Error(`잔고조회 실패: ${data.return_msg || JSON.stringify(data)}`);
  }

  const stockList = data.stk_cntr_remn || [];

  // 1) row별 파싱
  const rawHoldings = stockList
    .filter((item: any) => parseInt(item.cur_qty || "0") > 0)
    .map((item: any) => {
      // ✅ 신용/융자거래 감지: stk_nm 또는 stk_cd에 별표(*) prefix 있으면 신용거래
      const rawName = (item.stk_nm || "").trim();
      const rawCode = (item.stk_cd || "").trim();
      const isCreditTrade = rawName.startsWith("*") || rawCode.startsWith("*");
      return {
        name: cleanKiwoomField(item.stk_nm),
        code: cleanKiwoomField(item.stk_cd),
        quantity: parseInt(item.cur_qty || "0"),
        avgPrice: parseInt(item.buy_uv || "0"),
        currentPrice: parseInt(item.cur_prc || "0"),
        profitRate: parseFloat(item.pl_rt || "0"),
        profitAmount: parseInt(item.evltv_prft || "0"),
        totalBuyAmount: parseInt(item.pur_amt || "0"),
        isCreditTrade,
      };
    });

  // 2) 같은 종목(code 우선, 없으면 name) 통합: 현물+신용 dedupe
  // 키움 잔고 API는 같은 종목을 현물/신용 별도 row로 반환하므로
  // 통합 시 수량 합산 + 가중평균 + positions 배열 보존
  interface PositionInfo {
    type: "cash" | "credit";
    quantity: number;
    avgPrice: number;
  }
  interface ConsolidatedHolding {
    name: string;
    code: string;
    quantity: number;
    avgPrice: number;
    currentPrice: number;
    profitRate: number;
    profitAmount: number;
    totalBuyAmount: number;
    isCreditTrade: boolean;
    positions: PositionInfo[];
  }
  const byKey: Record<string, ConsolidatedHolding> = {};

  for (const h of rawHoldings) {
    const key = h.code || h.name;
    const posType: "cash" | "credit" = h.isCreditTrade ? "credit" : "cash";
    const position: PositionInfo = {
      type: posType,
      quantity: h.quantity,
      avgPrice: h.avgPrice,
    };

    if (!byKey[key]) {
      byKey[key] = {...h, positions: [position]};
    } else {
      const existing = byKey[key];
      // 같은 type의 포지션이 있으면 합치고, 다르면 별도 항목 유지
      const samePos = existing.positions.find((p: PositionInfo) => p.type === posType);
      if (samePos) {
        // 같은 type 합산 (이론상 발생 안 하지만 방어)
        const totalQty = samePos.quantity + h.quantity;
        const totalAmt = samePos.avgPrice * samePos.quantity + h.avgPrice * h.quantity;
        samePos.quantity = totalQty;
        samePos.avgPrice = totalQty > 0 ? Math.round(totalAmt / totalQty) : 0;
      } else {
        existing.positions.push(position);
      }

      // 통합 잔고 갱신 (수량 합산, 평단 가중평균)
      const totalQty = existing.positions.reduce((s: number, p: PositionInfo) => s + p.quantity, 0);
      const totalAmt = existing.positions.reduce((s: number, p: PositionInfo) => s + p.avgPrice * p.quantity, 0);
      existing.quantity = totalQty;
      existing.avgPrice = totalQty > 0 ? Math.round(totalAmt / totalQty) : 0;
      // 현물+신용 혼합이면 isCreditTrade=true (1개라도 신용이면)
      existing.isCreditTrade = existing.positions.some((p: PositionInfo) => p.type === "credit");
    }
  }

  const consolidated: ConsolidatedHolding[] = Object.values(byKey);
  // dedupe 로그 (2개 이상 통합된 종목 확인)
  for (const h of consolidated) {
    if (h.positions.length > 1) {
      console.log(`[fetchHoldings] ${h.name}(${h.code}) 통합: ${h.positions.map((p: PositionInfo) => `${p.type}(${p.quantity}@${p.avgPrice})`).join(" + ")} → 총 ${h.quantity}주, 평단 ${h.avgPrice}원`);
    }
  }
  return consolidated;
}

// ─── 당일 체결 내역 조회 (ka10076 체결요청) ───
async function fetchTodayTrades(
  config: KiwoomConfig,
  token: string
): Promise<any[]> {
  try {
    const res = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": `Bearer ${token}`,
        "api-id": "ka10076",
      },
      body: JSON.stringify({
        qry_tp: "0",
        sell_tp: "0",
        stex_tp: "1",
      }),
    });

    const data = await res.json() as any;
    if (data.return_code && data.return_code !== 0 && data.return_code !== "0") {
      console.log("당일 체결 조회 실패:", data.return_msg);
      return [];
    }

    const trades = data.cntr || [];
    return Array.isArray(trades) ? trades
      .filter((item: any) => parseInt(item.cntr_qty || "0") > 0)
      .map((item: any) => ({
        name: (item.stk_nm || "").trim(),
        code: (item.stk_cd || "").trim(),
        type: (item.trde_tp || "").includes("매도") ? "sell" : "buy",
        price: parseInt(item.cntr_pric || "0"),
        quantity: parseInt(item.cntr_qty || "0"),
        date: (() => {
          // KST 기준 날짜 (UTC+9) — 장중(9시~15:30)에도 정확한 날짜 보장
          const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
          return `${kst.getFullYear()}${String(kst.getMonth() + 1).padStart(2, "0")}${String(kst.getDate()).padStart(2, "0")}`;
        })(),
        time: item.ord_tm || "",
        orderNo: item.ord_no || "",
      })) : [];
  } catch (err) {
    console.log("당일 체결 조회 스킵:", err);
    return [];
  }
}

// ─── 기간별 체결 내역 조회 ───
// ka10072(일별종목별실현손익) 날짜별 루프 + ka10076(당일체결) 활용
async function fetchTradeHistory(
  config: KiwoomConfig,
  token: string,
  startDate?: string,
  endDate?: string
): Promise<any[]> {
  const allTrades: any[] = [];
  const start = startDate || new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const end = endDate || new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // 날짜 목록 생성 (주말 제외)
  const dates: string[] = [];
  const startD = new Date(start.slice(0, 4) + "-" + start.slice(4, 6) + "-" + start.slice(6, 8));
  const endD = new Date(end.slice(0, 4) + "-" + end.slice(4, 6) + "-" + end.slice(6, 8));

  for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day === 0 || day === 6) continue;
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }

  console.log(`체결 내역 조회: ${dates.length}일 (${start} ~ ${end})`);

  // ka10072 (일별종목별실현손익) - 매도 내역만 조회
  // ※ sell_tp="2"는 실제 매수가 아닌 "매도된 수량의 매수 원가"이므로 사용하지 않음
  for (const dt of dates) {
    try {
      const res = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "authorization": `Bearer ${token}`,
          "api-id": "ka10072",
        },
        body: JSON.stringify({
          strt_dt: dt,
          end_dt: dt,
          ord_dt: dt,
          stk_cd: "",
          sell_tp: "1",
          qry_tp: "0",
          stk_bond_tp: "1",
          dmst_stex_tp: "KRX",
        }),
      });
      const data = await res.json() as any;
      const items = data.dt_stk_div_rlzt_pl || [];
      const valid = items.filter((x: any) => (x.stk_nm || "").trim() !== "");

      if (valid.length > 0) {
        console.log(`[ka10072] ${dt}: ${valid.length}건 매도`);
        for (const item of valid) {
          const qty = parseInt(item.cntr_qty || "0");
          if (qty <= 0) continue;
          // ✅ 신용/융자거래 감지 (별표 prefix) — clean 전에 raw 확인
          const rawNm72 = (item.stk_nm || "").trim();
          const rawCd72 = (item.stk_cd || "").trim();
          const isCredit72 = rawNm72.startsWith("*") || rawCd72.startsWith("*");
          const code72 = cleanKiwoomField(item.stk_cd);
          const name72 = cleanKiwoomField(item.stk_nm);
          const price72 = parseInt(item.cntr_pric || "0");
          const ordNo72 = String(item.ord_no || item.cntr_no || "").trim();
          const orderNo72 = ordNo72 || `sell_${dt}_${code72}_${price72}_${qty}`;
          console.log(
            `[ka10072-item] ${dt} ${code72}: qty=${qty} price=${price72} ` +
            `credit=${isCredit72} ` +
            `ord_no=${ordNo72 || "(없음)"} cntr_no=${String(item.cntr_no||"").trim()||"(없음)"}`
          );
          allTrades.push({
            name: name72,
            code: code72,
            type: "sell",
            price: price72,
            quantity: qty,
            date: dt,
            time: item.cntr_tm || "",
            orderNo: orderNo72,
            isCreditTrade: isCredit72,
          });
        }
      }

      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      console.log(`${dt} ka10072 스킵:`, err);
    }
  }

  // ka10076 (체결요청) - 매수 체결 내역 조회 시도 (날짜별)
  // sell_tp: "2"=매수
  for (const dt of dates) {
    try {
      const res = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "authorization": `Bearer ${token}`,
          "api-id": "ka10076",
        },
        body: JSON.stringify({
          ord_dt: dt,
          stk_cd: "",
          sell_tp: "2",
          qry_tp: "0",
          stk_bond_tp: "1",
          dmst_stex_tp: "KRX",
        }),
      });
      const data = await res.json() as any;
      // 배열 필드 자동 탐색
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key]) && data[key].length > 0) {
          const items = data[key].filter((x: any) => {
            const nm = (x.stk_nm || "").trim();
            const qty = parseInt(x.cntr_qty || x.qty || "0");
            return nm !== "" && qty > 0;
          });
          if (items.length > 0) {
            // ✅ F2 수정 1: sell_tp="2"(매수) 요청이지만 API가 매도를 반환할 수 있음
            // → ka10072 가 매도를 담당하므로 ka10076 에서 매도는 제외 (중복 방지)
            const buyItems = items.filter((x: any) => !(x.trde_tp || "").includes("매도"));
            const sellItemsFromApi = items.length - buyItems.length;
            console.log(
              `[ka10076] ${dt}: 매수 ${buyItems.length}건 처리 / ` +
              `매도 ${sellItemsFromApi}건 ka10072 담당으로 스킵`
            );
            for (const item of buyItems) {
              // ✅ 신용/융자거래 감지 (별표 prefix) — clean 전에 raw 확인
              const rawNm76 = (item.stk_nm || "").trim();
              const rawCd76 = (item.stk_cd || "").trim();
              const isCredit76 = rawNm76.startsWith("*") || rawCd76.startsWith("*");
              const name = cleanKiwoomField(item.stk_nm);
              const qty = parseInt(item.cntr_qty || item.qty || "0");
              if (qty <= 0) continue;
              const price = parseInt(item.cntr_uv || item.cntr_pric || item.ord_uv || "0");
              const code76 = cleanKiwoomField(item.stk_cd);
              // ✅ F2 수정 2: ord_no 있으면 사용, 없으면 price+qty 복합키 (collision 방지)
              const ordNo76 = String(item.ord_no || "").trim();
              allTrades.push({
                name,
                code: code76,
                type: "buy",
                price,
                quantity: qty,
                date: dt,
                time: item.cntr_tm || item.ord_tm || "",
                orderNo: ordNo76 || `buy_${dt}_${code76}_${price}_${qty}`,
                isCreditTrade: isCredit76,
              });
            }
          }
          break; // 첫 번째 배열 필드만 사용
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      // ka10076이 날짜별로 지원하지 않을 수 있음 - 무시
      if (dt === dates[0]) console.log(`[ka10076] 조회 실패:`, err);
    }
  }

  // 종목별 매도/매수 수량 합계 로그
  const sellByStock: Record<string, number> = {};
  const buyByStock: Record<string, number> = {};
  allTrades.forEach((t) => {
    if (t.type === "sell") sellByStock[t.name] = (sellByStock[t.name] || 0) + t.quantity;
    else buyByStock[t.name] = (buyByStock[t.name] || 0) + t.quantity;
  });
  console.log(`매도 내역: ${Object.keys(sellByStock).length}종목`, JSON.stringify(sellByStock));
  if (Object.keys(buyByStock).length > 0) {
    console.log(`매수 내역: ${Object.keys(buyByStock).length}종목`, JSON.stringify(buyByStock));
  }

  // kt00007 (계좌별주문체결내역상세요청) - 매수 내역 포함 가능
  for (const apiId of ["kt00007", "kt00009"]) {
    try {
      const res = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "authorization": `Bearer ${token}`,
          "api-id": apiId,
        },
        body: JSON.stringify({
          strt_dt: start,
          end_dt: end,
          stk_cd: "",
          sell_tp: "0",
          qry_tp: "0",
          dmst_stex_tp: "KRX",
          stex_tp: "1",
          stk_bond_tp: "1",
          mrkt_tp: "0",
        }),
      });
      const data = await res.json() as any;
      console.log(`[${apiId}] code:${data.return_code} msg:${data.return_msg} keys:${Object.keys(data)}`);

      // 배열 필드 탐색
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key]) && data[key].length > 0) {
          const items = data[key];
          console.log(`[${apiId}] 필드 ${key}: ${items.length}건`);
          // 첫 3건 샘플
          items.slice(0, 3).forEach((item: any, idx: number) => {
            console.log(`[${apiId}] ${key}[${idx}]:`, JSON.stringify(item).slice(0, 500));
          });

          // 매수 내역 추출 시도
          const buyItems = items.filter((x: any) => {
            const tp = (x.trde_tp || x.sell_tp || x.io_tp_nm || x.buy_sell || "").toString();
            return tp.includes("매수") || tp === "2" || tp === "buy";
          });
          if (buyItems.length > 0) {
            console.log(`[${apiId}] 매수 ${buyItems.length}건 발견!`);
            buyItems.slice(0, 3).forEach((item: any, idx: number) => {
              console.log(`[${apiId}] 매수[${idx}]:`, JSON.stringify(item).slice(0, 500));
            });

            // 매수 내역을 allTrades에 추가
            for (const item of buyItems) {
              const name = cleanKiwoomField(item.stk_nm);
              const qty = parseInt(item.cntr_qty || item.qty || "0");
              const price = parseInt(item.cntr_pric || item.pric || item.buy_uv || "0");
              const dt = item.ord_dt || item.cntr_dt || item.trde_dt || "";
              if (name && qty > 0) {
                const formattedDate = dt.length === 8
                  ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`
                  : dt;
                const code7 = cleanKiwoomField(item.stk_cd);
                const ordNo7 = String(item.ord_no || item.cntr_no || "").trim();
                allTrades.push({
                  name,
                  code: code7,
                  type: "buy",
                  price,
                  quantity: qty,
                  date: dt,
                  time: item.ord_tm || "",
                  // ✅ F2 수정: ord_no 우선, 없으면 price+qty 복합키
                  orderNo: ordNo7 || `buy_${dt}_${code7}_${price}_${qty}`,
                });
                console.log(`[${apiId}] 매수 추가: ${name} ${qty}주 @${price} (${formattedDate})`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.log(`[${apiId}] 조회 실패:`, err);
    }
  }

  // ─── kt00015 (위탁종합거래내역요청) — 기간별 매수+매도 종합 내역 ───
  // 필드:
  //   cntr_dt=체결일(매매일), trde_dt=거래일(결제일 D+2) → cntr_dt 우선 사용
  //   io_tp_nm="매수"/"매도", stk_cd="A051980"(알파벳 접두사 제거 필요)
  //   trde_qty_jwa_cnt=수량, trde_amt=거래금액(=qty×단가), trde_no=거래번호
  // 페이지네이션: 응답 헤더 cont-yn="Y" 이면 next-key 헤더 추출 후 재요청
  // 중복 처리: ka10072 매도와 겹치는 건 dedup에서 자동 처리
  try {
    let contYn = "N";
    let nextKey = "";
    let pageNum = 0;
    let buyAdded = 0;
    let sellAdded = 0;
    const MAX_PAGES = 100; // 안전 상한 (1페이지 ~3건이면 300건)

    while (pageNum < MAX_PAGES) {
      pageNum++;
      const reqHeaders: Record<string, string> = {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": `Bearer ${token}`,
        "api-id": "kt00015",
      };
      if (contYn === "Y" && nextKey) {
        reqHeaders["cont-yn"] = "Y";
        reqHeaders["next-key"] = nextKey;
      }

      const r15 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({
          strt_dt: start,
          end_dt: end,
          stk_cd: "",
          tp: "0",
          gds_tp: "1",
          qry_tp: "0",
          sell_tp: "0",
          stk_bond_tp: "1",
          dmst_stex_tp: "KRX",
          stex_tp: "1",
        }),
      });

      // 페이지네이션 헤더 추출
      const respContYn = r15.headers.get("cont-yn") || r15.headers.get("Cont-Yn") || "";
      const respNextKey = r15.headers.get("next-key") || r15.headers.get("Next-Key") || "";

      const d15 = await r15.json() as any;
      const items15: any[] = d15.trst_ovrl_trde_prps_array || [];
      console.log(
        `[kt00015 p${pageNum}] code=${d15.return_code} items=${items15.length} ` +
        `cont-yn="${respContYn}" next-key="${respNextKey.slice(0, 20)}"`
      );

      for (const item of items15) {
        const ioTp = (item.io_tp_nm || "").trim();
        const isBuy = ioTp.includes("매수");
        // ✅ 매도는 ka10072 가 정밀하게 처리 (부분체결 120+120 등)
        // kt00015 는 매도를 240 으로 합산해서 반환 → 중복/과산 방지를 위해 스킵
        if (!isBuy) continue;

        const qty = parseInt(item.trde_qty_jwa_cnt || "0");
        if (qty <= 0) continue;

        const rawDate = (item.cntr_dt || item.trde_dt || "").trim();
        if (!rawDate) continue;

        // ✅ 신용/융자거래 감지 (별표 prefix) — clean 전에 raw 확인
        const rawNm15 = (item.stk_nm || "").trim();
        const rawCd15 = (item.stk_cd || "").trim();
        const isCredit15 = rawNm15.startsWith("*") || rawCd15.startsWith("*");
        const rawCode = cleanKiwoomField(item.stk_cd);
        const code15 = rawCode.replace(/^[A-Za-z]/, "");
        const name15 = cleanKiwoomField(item.stk_nm);
        if (!name15 || !code15) continue;

        const trdeAmt = parseInt(item.trde_amt || "0");
        const price15 = qty > 0 && trdeAmt > 0 ? Math.round(trdeAmt / qty) : 0;
        const ordNo15 = (item.trde_no || "").trim();
        const type15 = isBuy ? "buy" : "sell";

        console.log(
          `[kt00015 p${pageNum}] ${rawDate} ${name15}(${code15}) ${type15} ` +
          `${qty}주 @${price15} credit=${isCredit15} trde_no=${ordNo15 || "(없음)"}`
        );

        allTrades.push({
          name: name15,
          code: code15,
          type: type15,
          price: price15,
          quantity: qty,
          date: rawDate,
          time: item.proc_tm || "",
          orderNo: ordNo15 || `kt15_${rawDate}_${code15}_${price15}_${qty}`,
          isCreditTrade: isCredit15,
        });

        if (isBuy) buyAdded++;
        else sellAdded++;
      }

      // 다음 페이지 여부 확인
      if (respContYn === "Y" && respNextKey) {
        contYn = "Y";
        nextKey = respNextKey;
        await new Promise((r) => setTimeout(r, 200)); // API 레이트 리밋
      } else {
        break; // 더 이상 페이지 없음
      }
    }
    console.log(`[kt00015] 완료: ${pageNum}페이지 처리 / 매수 ${buyAdded}건 / 매도 ${sellAdded}건 추가`);
  } catch (err) {
    console.log(`[kt00015] 조회 실패:`, err);
  }

  // ─── kt00007 (계좌별주문체결내역상세) — 신용/융자 매수 보강 ───
  // kt00015는 위탁(현금)만 반환 → 신용 매수가 누락됨
  // kt00007은 crd_tp 필드로 신용 거래 식별 가능 + loan_dt(대출일)도 함께
  // io_tp_nm 예: "현금매수 K", "융자매수 K", "현금매도 K", "융자매도 K"
  for (const dt of dates) {
    try {
      let creditBuyAdded = 0;
      let creditSellAdded = 0;
      let cashAdded = 0;
      const r7 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "authorization": `Bearer ${token}`,
          "api-id": "kt00007",
        },
        body: JSON.stringify({
          ord_dt: dt,
          qry_tp: "1", // 전체 (체결+미체결)
          stk_bond_tp: "0",
          sell_tp: "0",
          stk_cd: "",
          fr_ord_no: "",
          dmst_stex_tp: "%",
        }),
      });
      const d7 = await r7.json() as any;
      if (d7.return_code && d7.return_code !== 0 && d7.return_code !== "0") {
        console.log(`[kt00007 ${dt}] return_code=${d7.return_code} msg=${d7.return_msg}`);
        continue;
      }
      let items7: any[] = [];
      for (const k of Object.keys(d7)) {
        if (Array.isArray(d7[k]) && d7[k].length > 0) {
          items7 = d7[k];
          break;
        }
      }
      for (const item of items7) {
        const qty = parseInt(item.cntr_qty || "0");
        if (qty <= 0) continue;
        const ioTp = (item.io_tp_nm || "").trim();
        const crdTp = (item.crd_tp || "").trim();
        // 매수/매도 판정
        let type7: "buy" | "sell" | null = null;
        if (ioTp.includes("매수")) type7 = "buy";
        else if (ioTp.includes("매도")) type7 = "sell";
        if (!type7) continue;
        // 신용 거래 판정 (crd_tp 또는 io_tp_nm에 "융자"/"신용")
        const isCredit = ioTp.includes("융자") || ioTp.includes("신용") ||
          crdTp.includes("융자") || crdTp.includes("신용");

        // ✅ kt00007 보강 정책:
        //   - 신용 매수/매도: 모두 추가 (kt00015는 위탁만 반환, 신용 누락)
        //   - 현금 매수: 추가 (kt00015가 일부 현금매수도 누락 — 흥구석유 5/27 케이스)
        //   - 현금 매도: 스킵 (ka10072 담당). ⚠️ kt00007 ord_no 정본화는 기존 ka10072
        //       fallback 데이터와 중복(앱클론 18주 등) 발생 — fallback→ord_no 대체
        //       마이그레이션이 선행돼야 안전. 단순 수집은 보류(연관성 검증으로 확인).
        if (!isCredit && type7 !== "buy") {
          continue;
        }

        const rawNm7 = (item.stk_nm || "").trim();
        const rawCd7 = (item.stk_cd || "").trim();
        const name7 = cleanKiwoomField(item.stk_nm);
        const code7 = cleanKiwoomField(item.stk_cd).replace(/^[A-Za-z]/, "");
        if (!name7 || !code7) continue;
        const price7 = parseInt(item.cntr_uv || "0");
        const ordNo7 = String(item.ord_no || "").trim();
        const cntrNo7 = String(item.cntr_no || "").trim();
        const orderNo = ordNo7 || cntrNo7 || `kt07_${dt}_${code7}_${price7}_${qty}`;
        const loanDt = String(item.loan_dt || "").trim();

        console.log(
          `[kt00007 ${dt}] ${name7}(${code7}) ${type7} ${qty}주 @${price7} ` +
          `credit=${isCredit} (${crdTp || ioTp}) loan_dt=${loanDt || "(없음)"} ord=${orderNo}`
        );

        allTrades.push({
          name: name7,
          code: code7,
          type: type7,
          price: price7,
          quantity: qty,
          date: dt,
          time: item.ord_tm || item.cnfm_tm || "",
          orderNo,
          isCreditTrade: isCredit,
          loanDt: loanDt || undefined,
          rawCreditType: crdTp || ioTp,
          // raw raw_nm/cd 보존 (디버깅용)
          _rawNm: rawNm7,
          _rawCd: rawCd7,
        });
        if (isCredit) {
          if (type7 === "buy") creditBuyAdded++;
          else creditSellAdded++;
        } else {
          cashAdded++; // 현금 매수 보강분
        }
      }
      console.log(`[kt00007] ${dt} 완료: 신용 매수 ${creditBuyAdded}건 / 신용 매도 ${creditSellAdded}건 / 현금 ${cashAdded}건 (위탁은 kt00015 담당)`);
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.log(`[kt00007] ${dt} 조회 실패:`, err);
    }
  }

  // ─── In-memory dedup: 두 API 가 같은 체결을 중복 반환할 경우 방어 ───
  // 기준: (code, date, type, price, qty) 가 모두 같으면 동일 체결 후보
  // 규칙:
  //   1) 실제 ord_no 있음 + fallback  → 실제 ord_no 로 교체
  //   2) 실제 ord_no 둘 다 있음        → 서로 다른 ordNo → 키가 애초에 다름 → 이 분기 없음
  //   3) 둘 다 fallback                → 부분체결 가능성 → ordNo 에 _2/_3 suffix 붙여 보존
  //      (re-sync 시 API 순서 고정이면 suffix 도 고정됨)
  const isFallbackKey = (on: string) =>
    on.startsWith("sell_") || on.startsWith("buy_") || on.startsWith("fb_");
  const dedupMap = new Map<string, any>();
  for (let t of allTrades) {
    const key = `${t.code}_${t.date}_${t.type}_${t.price}_${t.quantity}`;
    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, t);
    } else {
      const tReal = !isFallbackKey(t.orderNo);
      const exReal = !isFallbackKey(existing.orderNo);
      if (tReal && !exReal) {
        // 실 ord_no 로 교체 (단, existing의 신용 정보가 있고 t에 없으면 보존)
        const merged = {...t};
        if (existing.isCreditTrade && !merged.isCreditTrade) merged.isCreditTrade = true;
        if (existing.loanDt && !merged.loanDt) merged.loanDt = existing.loanDt;
        if (existing.rawCreditType && !merged.rawCreditType) merged.rawCreditType = existing.rawCreditType;
        console.log(
          `[dedup] 교체: ${t.code} ${t.date} ${t.type} ${t.price}@${t.quantity} ` +
          `fallback(${existing.orderNo}) → real(${t.orderNo}) credit=${merged.isCreditTrade}`
        );
        dedupMap.set(key, merged);
      } else if (tReal && exReal) {
        // ✅ 매도: 같은 가격·수량인데 ord_no가 다르면 = 별개 체결(분할매도/부분체결).
        //   같은 매도면 ka10072/kt00007이 동일 ord_no를 반환하므로 ord_no가 다르면
        //   서로 다른 주문이 확실 → 둘 다 보존(과거엔 같은 체결로 오판해 1건 버렸음).
        //   (id = trade_kiwoom_{ord_no}_{code} 라 각자 유니크하게 저장됨)
        if (t.type === "sell" && t.orderNo !== existing.orderNo) {
          let suffix = 2;
          while (dedupMap.has(`${key}_${suffix}`)) suffix++;
          dedupMap.set(`${key}_${suffix}`, t);
          console.log(
            `[dedup] 매도 같은 가격·수량 다른 ord_no → 별개 보존: ` +
            `${existing.orderNo} + ${t.orderNo} (${t.code} ${t.price}@${t.quantity})`
          );
        } else if ((t.isCreditTrade === true && !existing.isCreditTrade) ||
            (t.loanDt && !existing.loanDt) ||
            (t.rawCreditType && !existing.rawCreditType)) {
          // 매수 또는 같은 ord_no: kt00015/kt00007 신용 정보 병합 (기존 동작)
          if (t.isCreditTrade === true) existing.isCreditTrade = true;
          if (t.loanDt) existing.loanDt = t.loanDt;
          if (t.rawCreditType) existing.rawCreditType = t.rawCreditType;
          console.log(
            `[dedup-merge] 신용정보 병합: ${t.code} ${t.date} ${t.type} ` +
            `${t.price}@${t.quantity} existing(${existing.orderNo}) + credit from ord=${t.orderNo} ` +
            `→ credit=${existing.isCreditTrade}, loan_dt=${existing.loanDt || "(없음)"}`
          );
        }
      } else if (!tReal && !exReal) {
        // 둘 다 fallback → 부분체결 가능성 → suffix 붙여 별도 보존
        let suffix = 2;
        while (dedupMap.has(`${key}_${suffix}`)) suffix++;
        // ⚠️ orderNo 도 suffix 붙여 Firestore tradeId 가 달라지도록
        t = {...t, orderNo: `${t.orderNo}_${suffix}`};
        dedupMap.set(`${key}_${suffix}`, t);
        console.log(
          `[dedup-partial] 부분체결 가능성: ${t.code} ${t.date} ${t.type} ` +
          `${t.price}@${t.quantity} → 별도 저장 (suffix _${suffix})`
        );
      } else if (!tReal && exReal) {
        // existing이 real이고 t가 fallback → existing 유지, t 폐기
        // (existing이 이미 위 또는 별도 path로 신용 정보 처리됨)
      }
    }
  }
  // ─── Cross-type dedup: ka10072 sell(sell_ fallback) ↔ kt00015/kt00007 buy 충돌 방지 ───
  // ka10072 는 매도 전용 API → orderNo = "sell_DATE_CODE_PRICE_QTY" 형식 fallback 키
  // kt00015/kt00007 는 동일 체결을 매수로 잘못 반환하는 경우 발생 → 해당 매수 레코드 제거
  const sellFallbackSignatures = new Set<string>();
  for (const t of dedupMap.values()) {
    if (t.type === "sell" && (t.orderNo || "").startsWith("sell_")) {
      sellFallbackSignatures.add(`${t.code}_${t.date}_${t.price}_${t.quantity}`);
    }
  }
  for (const [key, t] of [...dedupMap.entries()]) {
    if (t.type === "buy") {
      const sig = `${t.code}_${t.date}_${t.price}_${t.quantity}`;
      if (sellFallbackSignatures.has(sig)) {
        console.log(
          `[cross-dedup] ka10072 매도↔buy API 충돌 제거: ${t.code} ${t.date} ` +
          `@${t.price}×${t.quantity} (ordNo: ${t.orderNo})`
        );
        dedupMap.delete(key);
      }
    }
  }

  const dedupedTrades = Array.from(dedupMap.values());
  console.log(
    `[fetchTradeHistory] 완료: 총 ${allTrades.length}건 → dedup 후 ${dedupedTrades.length}건`
  );

  // 최종 종목별 요약 (진단용)
  const finalSell: Record<string, number> = {};
  const finalBuy: Record<string, number> = {};
  dedupedTrades.forEach((t) => {
    if (t.type === "sell") finalSell[t.name] = (finalSell[t.name] || 0) + t.quantity;
    else finalBuy[t.name] = (finalBuy[t.name] || 0) + t.quantity;
  });
  console.log(`[최종] 매도 ${Object.keys(finalSell).length}종목`, JSON.stringify(finalSell));
  console.log(`[최종] 매수 ${Object.keys(finalBuy).length}종목`, JSON.stringify(finalBuy));

  return dedupedTrades;
}

// ─── 체결내역을 종목별 매수/매도 차수에 매핑 ───
function mapTradesToPlans(
  trades: any[],
  stockName: string,
  holdings: any,
  ruleConfig?: {rule?: string; bottomPrice?: number; sellsSinceLastBuy?: number},
  existingMaSells?: any[]
): {buyPlans: any[]; sellPlans: any[]; sellCount: number; firstBuyPrice: number; firstBuyQty: number} {
  // 해당 종목의 체결내역을 날짜+시간 순으로 정렬
  const stockTrades = trades
    .filter((t) => t.name === stockName)
    .sort((a, b) => {
      const dateCompare = (a.date || "").localeCompare(b.date || "");
      if (dateCompare !== 0) return dateCompare;
      return (a.time || "").localeCompare(b.time || "");
    });

  const buys = stockTrades.filter((t) => t.type === "buy");
  const sells = stockTrades.filter((t) => t.type === "sell");

  // 매수 차수 매핑: 같은 날짜의 매수는 같은 차수로 묶음
  const buyByDate: Record<string, {totalQty: number; totalAmt: number; date: string}> = {};
  for (const b of buys) {
    const dt = b.date || "";
    if (!buyByDate[dt]) {
      buyByDate[dt] = {totalQty: 0, totalAmt: 0, date: dt};
    }
    buyByDate[dt].totalQty += b.quantity;
    buyByDate[dt].totalAmt += b.price * b.quantity;
  }

  const buyDates = Object.keys(buyByDate).sort();
  const firstBuy = buyDates.length > 0 ? buyByDate[buyDates[0]] : null;
  const firstBuyPrice = firstBuy ? Math.round(firstBuy.totalAmt / firstBuy.totalQty) : (holdings?.avgPrice || 0);

  // ─── 차수별 룰 판정 (태산매매법 확정 규칙) ───
  // N차 rule = (N-1차 매수 직후 ~ N차 매수 직전) 구간 매도 회수 >= 3 ? 'B' : 'A'
  //   · 1차 = 항상 'A' (진입 매수)
  //   · 같은 날·같은 가격 부분체결 = 1회 (date+price 유니크 그룹)
  //   · 직전 차수가 미체결이면 그 구간 매도 불가 → 'A'
  const normDForRule = (d: string): string => {
    if (!d) return "";
    if (d.length === 8 && !d.includes("-")) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return d;
  };
  const countSellRoundsBetween = (startDate: string, endDate: string): number => {
    const groups = new Set<string>();
    for (const s of sells) {
      const sd = normDForRule(s.date || "");
      if (!sd || sd <= startDate) continue; // 직전 매수일 이후만
      if (endDate && sd >= endDate) continue; // 당 매수일 전만 (endDate="" = 무한대)
      groups.add(`${sd}_${s.price}`);
    }
    return groups.size;
  };
  const stageRuleFor = (level: number, thisBuyDateRaw: string): "A" | "B" => {
    if (level <= 1) return "A"; // 1차 진입 = 항상 룰A
    // ✅ 사용자가 매매규칙을 룰B로 수동 전환 + 저점 설정 시: 미체결 차수(thisBuyDateRaw 빈값)는
    //   룰B 우선 적용. 체결된 과거 차수는 그 시점 사실대로 자동판정 유지(과거를 덮지 않음).
    if (!thisBuyDateRaw && ruleConfig?.rule === "B" && (ruleConfig?.bottomPrice || 0) > 0) return "B";
    const prevBuyDate = normDForRule(buyDates[level - 2] || ""); // (level-1)차 매수일 (0-based: level-2)
    if (!prevBuyDate) return "A"; // 직전 차수 미체결 → 매도 구간 없음 → 룰A
    const thisBuyDate = normDForRule(thisBuyDateRaw || ""); // 미체결이면 "" (지금까지)
    return countSellRoundsBetween(prevBuyDate, thisBuyDate) >= 3 ? "B" : "A";
  };

  // 원래 매수 수량 계산: 매수 내역이 있으면 사용, 없으면 "현재 보유량 + 매도 수량"으로 역산
  const totalSoldQty = sells.reduce((sum, s) => sum + s.quantity, 0);
  const firstBuyQty = firstBuy
    ? firstBuy.totalQty
    : (holdings?.quantity || 0) + totalSoldQty;
  console.log(`[매수역산] ${stockName}: 보유=${holdings?.quantity || 0}, 매도합계=${totalSoldQty}, 원래매수=${firstBuyQty}`);

  // 매수 계획 생성 (최대 5차)
  // 매수 내역이 없으면 보유잔고 기반으로 1차 매수 체결 처리
  const buyPlans = [];
  for (let i = 0; i < 5; i++) {
    const buyDate = buyDates[i];
    const buyData = buyDate ? buyByDate[buyDate] : null;

    if (buyData) {
      const avg = Math.round(buyData.totalAmt / buyData.totalQty);
      const formattedDate = buyDate.length === 8
        ? `${buyDate.slice(0, 4)}-${buyDate.slice(4, 6)}-${buyDate.slice(6, 8)}`
        : buyDate;
      buyPlans.push({
        level: i + 1,
        price: avg,
        quantity: buyData.totalQty,
        filled: true,
        filledDate: formattedDate,
        filledQuantity: buyData.totalQty,
        filledPrice: avg,
        // ✅ 차수별 룰: 직전 매수 후 ~ 이 매수 전 매도 3회+ → 'B', 아니면 'A'
        rule: stageRuleFor(i + 1, formattedDate),
      });
    } else if (i === 0 && buyDates.length === 0 && holdings) {
      // 매수 내역 없지만 보유 중 → 1차 매수 체결로 설정
      // firstBuyQty = 현재보유 + 매도수량 (원래 매수량)
      // ⚠️ filledDate는 비워둠("날짜 미상"). 등록 당일을 추정 날짜로 넣으면
      //    실제 매수일(키움 거래 동기화 전)과 달라 룰B freeze 기준일/매매일지가 틀어짐.
      //    키움 거래가 trades에 들어오면 다음 동기화에서 실제 매수일로 채워짐.
      buyPlans.push({
        level: 1,
        price: holdings.avgPrice || 0,
        quantity: firstBuyQty,
        filled: true,
        filledDate: "",
        filledQuantity: firstBuyQty,
        filledPrice: holdings.avgPrice || 0,
        rule: "A", // 1차 진입 매수는 항상 룰A 기준
      });
    } else {
      // 미체결 차수
      // ✅ 차수별 룰 판정 (직전 매수 후 매도 3회+ → 'B'):
      //   룰B 차수: 첫 룰B면 bottomPrice × 0.9, 연속이면 이전 × 0.9 (계단식)
      //   룰A 차수: 이전 차수 × 0.9
      // bottomPrice 없으면 룰B여도 가격 계산은 룰A 폴백 (이전 × 0.9)
      const thisStageRule = stageRuleFor(i + 1, "");
      const isRuleB = thisStageRule === "B" && (ruleConfig?.bottomPrice || 0) > 0;
      let nextPrice: number;

      if (isRuleB) {
        const prev = i > 0 ? buyPlans[i - 1] : null;
        if (prev && prev.filled) {
          // 첫 미체결 차수 → bottomPrice × 0.9
          nextPrice = Math.round((ruleConfig!.bottomPrice as number) * 0.9);
        } else if (prev) {
          // 이전도 미체결 → 룰B 계단식
          nextPrice = Math.round((prev.price as number) * 0.9);
        } else {
          // i=0 (1차도 미체결) → bottomPrice × 0.9
          nextPrice = Math.round((ruleConfig!.bottomPrice as number) * 0.9);
        }
      } else {
        // 룰A
        const prevPrice: number = i > 0 && buyPlans[i - 1]
          ? (buyPlans[i - 1].price as number)
          : firstBuyPrice;
        nextPrice = prevPrice > 0 ? Math.round(prevPrice * 0.9) : 0;
      }

      // ✅ Bug1 fix: 미체결 차수 수량 = 1차 매수 총금액 / 해당 차수 예상가 (비중 동일 원칙)
      const firstBuyAmt = firstBuyPrice * firstBuyQty;
      const levelQty = nextPrice > 0 && firstBuyAmt > 0
        ? Math.round(firstBuyAmt / nextPrice)
        : firstBuyQty;
      buyPlans.push({
        level: i + 1,
        price: nextPrice,
        quantity: levelQty,
        filled: false,
        filledDate: "",
        // ✅ 차수별 룰: 직전 매수 후 ~ 지금 매도 3회+ → 'B', 아니면 'A'
        rule: stageRuleFor(i + 1, ""),
      });
    }
  }

  // 평균단가 계산 (체결된 매수만)
  let totalCost = 0;
  let totalQty = 0;
  for (const bp of buyPlans) {
    if (bp.filled) {
      totalCost += bp.price * bp.quantity;
      totalQty += bp.quantity;
    }
  }
  const avgPrice = totalQty > 0 ? Math.round(totalCost / totalQty) : firstBuyPrice;

  // ✅ Bug2 fix: 추가매수 시 매도계획 완전 리셋
  // 현재 보유수량 = 전체 체결매수 - 전체 매도
  const currentHoldingQty = Math.max(0, totalQty - totalSoldQty);

  // 날짜 정규화 헬퍼 (YYYYMMDD → YYYY-MM-DD, 이미 대시형이면 그대로)
  const normDate = (d: string): string => {
    if (!d) return "";
    if (d.length === 8 && !d.includes("-")) {
      return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    }
    return d;
  };

  // 최근 매수 일자 (가장 마지막 체결 매수 날짜)
  const lastBuyDateNorm = buyDates.length > 0 ? normDate(buyDates[buyDates.length - 1]) : "";
  // 마지막 매수일의 가장 늦은 체결시각 (같은 날 매수+매도 구분용; 없으면 "")
  let lastBuyTime = "";
  for (const b of buys) {
    if (normDate(b.date || "") === lastBuyDateNorm) {
      const t = String(b.time || "").trim();
      if (t && t > lastBuyTime) lastBuyTime = t;
    }
  }

  // 최근 매수 이후 매도만 현재 라운드 슬롯에 매핑
  // (이전 라운드에서 매도된 내역은 매매일지에만 기록 — 슬롯 초기화)
  // ✅ 같은 날 매수+매도 엣지: 종전 strict(>)는 매수일 당일 매도를 통째 제외해
  //    휴림로봇처럼 매수 직후 같은 날 매도가 누락됨.
  //    → 같은 날 매도는 포함하되, 체결시각이 둘 다 있으면 "매수 시각 이후"만 현재 라운드.
  //      (시각 정보 없으면 보수적으로 포함 = 드롭 방지)
  const currentRoundSellsAll = lastBuyDateNorm
    ? sells.filter((s) => {
      const sd = normDate(s.date || "");
      if (sd > lastBuyDateNorm) return true;
      if (sd === lastBuyDateNorm) {
        const st = String(s.time || "").trim();
        if (st && lastBuyTime) return st >= lastBuyTime; // 시각 있으면 매수 이후만
        return true; // 시각 없음 → 같은 날 매도 포함
      }
      return false;
    })
    : sells;

  // ── MA 우선: MA 슬롯이 흡수(consumedTradeIds)한 거래는 프로필 슬롯 매핑에서 제외 ──
  //   동기화가 MA로 분류된 거래를 프로필 슬롯에 다시 채워 이중 카운트되던 버그 방지.
  const tradeIdOf = (t: any): string => {
    const orderKey = t.orderNo && String(t.orderNo).trim() !== ""
      ? String(t.orderNo)
      : `fb_${t.date || ""}${t.time || ""}_${t.quantity || 0}`;
    return `trade_kiwoom_${orderKey}_${t.code}`;
  };
  const maConsumedIds = new Set<string>();
  for (const m of (existingMaSells || [])) {
    if (Array.isArray(m?.consumedTradeIds)) {
      for (const id of m.consumedTradeIds) maConsumedIds.add(String(id));
    }
  }
  const currentRoundSells = maConsumedIds.size > 0
    ? currentRoundSellsAll.filter((s) => !maConsumedIds.has(tradeIdOf(s)))
    : currentRoundSellsAll;
  const excludedByMa = currentRoundSellsAll.length - currentRoundSells.length;
  if (excludedByMa > 0) {
    console.log(`[매핑] ${stockName} MA흡수 ${excludedByMa}건 프로필 슬롯 제외 (MA 우선)`);
  }

  const sellCount = sells.length;

  // 수익 매도 계획 (5단계) — 추가매수 시 완전 리셋, 슬롯 수량 = 현재보유 / 5
  const slotQty = currentHoldingQty > 0 ? Math.round(currentHoldingQty / 5) : 0;
  const percents = [5, 10, 15, 20, 25];
  const sellPlans = percents.map((p, i) => {
    const sellTrade = currentRoundSells[i]; // 최근 매수 이후 i번째 체결만 매핑 (MA 흡수분 제외)
    // 목표가는 현재 평단가 × (1+%) 로 유지 (실제 체결가와 분리)
    const targetPrice = avgPrice > 0 ? Math.round(avgPrice * (1 + p / 100)) : 0;

    if (sellTrade) {
      const dt = sellTrade.date || "";
      const formattedDate = normDate(dt);
      return {
        percent: p,
        price: targetPrice,
        quantity: sellTrade.quantity,
        filled: true,
        filledDate: formattedDate,
        filledQuantity: sellTrade.quantity,
        filledPrice: sellTrade.price,
        // 어떤 거래를 흡수했는지 명시 → 이후 reconcile/동기화 중복 방지
        consumedTradeIds: [tradeIdOf(sellTrade)],
      };
    }
    return {
      percent: p,
      price: targetPrice,
      quantity: slotQty,
      filled: false,
      filledDate: "",
    };
  });

  // ── 불변식 가드: 매핑된 총 매도수량(프로필+MA) ≤ 실제 매도수량 ──
  //   초과 시 이중 카운트가 남아있다는 뜻 → 경고 로그 (값 강제 변경은 안 함, 추적용)
  const mappedProfitQty = sellPlans.reduce(
    (s, p) => s + (p.filled ? (p.filledQuantity || 0) : 0), 0);
  const mappedMaQty = (existingMaSells || []).reduce(
    (s: number, m: any) => s + ((m?.filled || (m?.quantity || 0) > 0) ? (Number(m.quantity) || 0) : 0), 0);
  const actualSoldQty = sells.reduce((s, t) => s + (Number(t.quantity) || 0), 0);
  if (mappedProfitQty + mappedMaQty > actualSoldQty) {
    console.warn(
      `[불변식위반] ${stockName} 매핑매도 ${mappedProfitQty + mappedMaQty}주 > 실제매도 ${actualSoldQty}주 ` +
      `(프로필 ${mappedProfitQty} + MA ${mappedMaQty}) — 이중카운트 잔존 의심`);
  }

  return {buyPlans, sellPlans, sellCount, firstBuyPrice, firstBuyQty};
}

// ─── 키움 trade 배열을 trades 컬렉션에 저장 (백필용 헬퍼) ───
// 기존 syncToFirestore 안의 trade 저장 로직과 동일 (dedup + sanity check):
//   1) tradeId = trade_kiwoom_${orderKey}_${code}로 이미 있으면 skip
//   2) (code, date, type, price, quantity) 조합으로 이미 있으면 skip (cross-dedup)
//   3) 단위 sanity check (avgPrice 대비 50배 이상/이하면 #단위의심 태그)
//   4) docRef.set
// 반환: 실제로 저장된 trade 수
async function saveKiwoomTradesBackfill(trades: any[]): Promise<number> {
  let saved = 0;
  const now = Date.now();
  for (const t of trades) {
    const orderKey = t.orderNo && String(t.orderNo).trim() !== ""
      ? String(t.orderNo)
      : `fb_${t.date || ""}${t.time || ""}_${t.quantity || 0}`;
    const tradeId = `trade_kiwoom_${orderKey}_${t.code}`;
    const docRef = db.collection("trades").doc(tradeId);
    const doc = await docRef.get();
    if (doc.exists) continue;

    const formattedDate = t.date
      ? `${t.date.slice(0, 4)}-${t.date.slice(4, 6)}-${t.date.slice(6, 8)}`
      : new Date().toISOString().slice(0, 10);

    // Cross-dedup: 같은 (code, date, type, price, quantity) 조합 trade가 이미 있으면 skip
    const dupQuery = await db.collection("trades")
      .where("code", "==", t.code || "")
      .where("date", "==", formattedDate)
      .where("type", "==", t.type)
      .where("price", "==", t.price)
      .where("quantity", "==", t.quantity)
      .limit(1)
      .get();
    if (!dupQuery.empty) {
      const existingId = dupQuery.docs[0].id;
      console.log(`[중복방지/백필] ${t.name} ${formattedDate} ${t.type} ${t.price}x${t.quantity} 이미 있음 (${existingId}) - 스킵`);
      continue;
    }

    // 단위 sanity check
    const tags: string[] = ["#키움동기화", "#백필"];
    try {
      let avgPriceForCheck = 0;
      if (t.code) {
        const stockByCode = await db.collection("stocks").where("code", "==", t.code).limit(1).get();
        if (!stockByCode.empty) avgPriceForCheck = Number(stockByCode.docs[0].data().avgPrice) || 0;
      }
      const tradePrice = Number(t.price) || 0;
      if (avgPriceForCheck > 0 && tradePrice > 0) {
        const ratio = tradePrice / avgPriceForCheck;
        if (ratio >= 50 || ratio <= 0.02) {
          tags.push("#단위의심");
          console.warn(`[단위경고/백필] ${t.name} ${formattedDate} ${t.type} ${tradePrice}원×${t.quantity}주 (평단 ${avgPriceForCheck}원, 비율 ${ratio.toFixed(2)}x)`);
        }
      }
    } catch (e: any) {
      console.error(`[단위경고/백필] sanity check 실패: ${e.message}`);
    }

    await docRef.set({
      date: formattedDate,
      stockName: t.name,
      code: t.code || "",
      orderNo: orderKey,
      type: t.type,
      price: t.price,
      quantity: t.quantity,
      memo: `키움 백필 (${t.time || ""})`,
      tags,
      // ✅ Phase 1a: 신용/융자거래 여부 trade에 보존
      isCreditTrade: t.isCreditTrade === true,
      // ✅ Phase 2 보강: 키움 신용 대출일 (kt00007 loan_dt) 보존 — 정확한 만기 계산용
      ...(t.loanDt ? {loanDt: t.loanDt} : {}),
      ...(t.rawCreditType ? {rawCreditType: t.rawCreditType} : {}),
      createdAt: now,
    });
    saved++;
  }
  return saved;
}

// ─── Firestore에 동기화 ───
async function syncToFirestore(
  holdings: any[],
  trades: any[],
  config?: KiwoomConfig,
  token?: string
): Promise<{syncedStocks: number; syncedTrades: number; soldOutStocks: string[]}> {
  const now = Date.now();
  let syncedStocks = 0;
  let syncedTrades = 0;

  // 단일 진실 모드: sync는 매도 슬롯 미기록 (reconcile이 태그 파생으로 단독 관리)
  const syncTagMode = await getTagModeEnabled();

  // 관심종목 → 실제매수 자동 전환 (동기화 시작 전)
  const transferred = await checkWatchlistBought(holdings);
  if (transferred > 0) {
    console.log(`[동기화] 관심종목 → 실제매수 전환: ${transferred}종목`);
  }

  // 기존 종목 매핑 (종목코드 우선, 이름은 폴백)
  const existingStocks: Record<string, string> = {};
  const existingByCode: Record<string, string> = {};
  const stockDocs = await db.collection("stocks").get();
  stockDocs.forEach((doc) => {
    const data = doc.data();
    if (data.name) {
      existingStocks[data.name] = doc.id;
    }
    if (data.code) {
      existingByCode[data.code] = doc.id;
    }
  });

  // 잔고에서 보유수량 0인 종목은 전량매도로 처리하기 위해 분리
  const activeHoldings = holdings.filter((h) => (h.quantity || 0) > 0);
  const zeroHoldings = holdings.filter((h) => (h.quantity || 0) === 0);
  console.log(`[잔고] 보유 ${activeHoldings.length}종목, 보유0 ${zeroHoldings.length}종목: [${zeroHoldings.map((h: any) => h.name).join(", ")}]`);

  // 잔고 동기화 (보유 중인 종목만)
  for (const h of activeHoldings) {
    // 종목코드 우선 매칭, 없으면 이름 매칭
    const existingDocId = (h.code && existingByCode[h.code]) || existingStocks[h.name];

    // 기존 종목 데이터 미리 로드 (룰/저점 정보 mapTradesToPlans에 전달용)
    let preExistingData: admin.firestore.DocumentData | null = null;
    let preExistingDoc: admin.firestore.DocumentSnapshot | null = null;
    if (existingDocId) {
      preExistingDoc = await db.collection("stocks").doc(existingDocId).get();
      preExistingData = preExistingDoc.exists ? (preExistingDoc.data() || null) : null;
    }

    // 체결내역으로 매수/매도 차수 매핑 (룰B면 bottomPrice 기반 미체결 차수 계산)
    const ruleConfig = preExistingData ? {
      rule: preExistingData.rule,
      bottomPrice: preExistingData.bottomPrice,
      sellsSinceLastBuy: preExistingData.sellsSinceLastBuy,
    } : undefined;
    const mapped = mapTradesToPlans(trades, h.name, h, ruleConfig, preExistingData?.maSells);

    if (existingDocId) {
      // 기존 종목 업데이트 (위에서 미리 로드된 데이터 사용)
      const existingDoc = preExistingDoc!;
      const existingData = preExistingData;

      // 체결 내역이 있을 때만 buyPlans/sellPlans 업데이트
      // 체결 내역 없이 잔고만 조회한 경우 기존 계획 보존
      const hasTrades = trades.some((t) => t.name === h.name);
      const stockTrades = trades.filter((t) => t.name === h.name);
      const stockBuys = stockTrades.filter((t) => t.type === "buy");
      console.log(`[동기화] ${h.name}: hasTrades=${hasTrades}, 매수=${stockBuys.length}건, 매도=${stockTrades.length - stockBuys.length}건, mapped.firstBuyQty=${mapped.firstBuyQty}, holdings.qty=${h.quantity}`);

      // ✅ Phase 1a 수정 (회귀 방지):
      // 키움 kt00005가 단일 row만 반환할 때 기존 multi-position 보존
      const existingPositions = Array.isArray(existingData?.positions) ? existingData!.positions : [];
      const newPositionsRaw = Array.isArray((h as any).positions) ? (h as any).positions : [];
      const shouldKeepExisting = existingPositions.length > 1 && newPositionsRaw.length <= 1;
      const positionsToSave = shouldKeepExisting ? existingPositions : newPositionsRaw;
      const isCreditFromPositions = positionsToSave.some((p: any) => p?.type === "credit");

      const updateData: any = {
        currentPrice: h.currentPrice,
        // ✅ 신용/융자거래 여부 (기존 multi-position 보존 시 그 값 우선)
        isCreditTrade: shouldKeepExisting ? isCreditFromPositions : h.isCreditTrade === true,
        // ✅ Phase 1a: 현물/신용 포지션 세부
        positions: positionsToSave,
        updatedAt: now,
      };
      // code 필드 마이그레이션 (기존 데이터에 code 없으면 주입)
      if (h.code && !existingData?.code) {
        updateData.code = h.code;
      }

      // ✅ 종목명 변경 자동 감지: code로 매칭됐는데 stocks 이름과 holdings 이름이 다르면
      //    → 회사명 변경된 것으로 보고 stocks.name 업데이트 + 모든 trades.stockName 일괄 변경
      if (h.code && existingData?.code === h.code && existingData?.name && existingData.name !== h.name) {
        const oldName = existingData.name;
        const newName = h.name;
        console.log(`[종목명변경 감지] ${oldName} → ${newName} (code: ${h.code})`);

        // trades stockName 일괄 업데이트 (이전 이름으로 저장된 모든 trade)
        const oldNameTradesSnap = await db.collection("trades")
          .where("stockName", "==", oldName)
          .get();
        if (!oldNameTradesSnap.empty) {
          const renameBatch = db.batch();
          oldNameTradesSnap.forEach((doc) => {
            const upd: any = {stockName: newName};
            if (!doc.data().code) upd.code = h.code;
            renameBatch.update(doc.ref, upd);
          });
          await renameBatch.commit();
          console.log(`[종목명변경] trades ${oldNameTradesSnap.size}건 stockName 갱신`);
        }

        // stocks 문서 name 업데이트
        updateData.name = newName;
      }

      if (hasTrades) {
        // 체결 내역 기반으로 전체 업데이트
        updateData.avgPrice = h.avgPrice;
        updateData.totalQuantity = h.quantity;
        // ✅ buyPlans manualOverride 보호 (사용자 수동 입력 보존)
        const existingBuyPlans: any[] = existingData?.buyPlans || [];
        const mergedBuyPlans = mapped.buyPlans.map((newPlan: any, i: number) => {
          const existingPlan = existingBuyPlans[i];
          if (existingPlan?.manualOverride) {
            console.log(`[sync 보호] ${h.name} buy${i + 1}차 manualOverride 유지`);
            return existingPlan;
          }
          return newPlan;
        });
        updateData.buyPlans = mergedBuyPlans;
        // ─── 단일 진실 모드: sync는 매도 슬롯을 기록하지 않음 ───
        //   매도 슬롯의 유일한 작성자 = reconcile(deriveSellSlotsFromTags).
        //   새 매도 trade 저장 시 onTradeCreated 트리거가 reconcile을 호출해 갱신.
        //   (레거시 모드에서만 종전 mapTradesToPlans 결과를 기록)
        if (!syncTagMode) {
          // sellPlans manualOverride 보호 (수동 편집 / MA 분리 보호)
          const existingSellPlans: any[] = existingData?.sellPlans || [];
          const mergedSellPlans = mapped.sellPlans.map((newPlan: any, i: number) => {
            const existingPlan = existingSellPlans[i];
            if (existingPlan?.manualOverride) {
              console.log(`[sync 보호] ${h.name} sell${i + 1}차 manualOverride 유지`);
              return existingPlan; // 수동 편집된 슬롯 유지
            }
            return newPlan;
          });
          updateData.sellPlans = mergedSellPlans;
        }
        updateData.sellCount = mapped.sellCount;
        updateData.firstBuyPrice = mapped.firstBuyPrice;
        updateData.firstBuyQuantity = mapped.firstBuyQty;

        // Rule B: 추가매수 감지 → bottomPrice 리셋
        // 새 매수 차수가 생기면 저점을 새 매수가로 초기화
        if (existingData?.rule === "B") {
          const prevFilledBuys = ((existingData?.buyPlans || []) as any[]).filter((b) => b.filled).length;
          const newFilledBuys = mapped.buyPlans.filter((b) => b.filled).length;
          if (newFilledBuys > prevFilledBuys) {
            // 새 매수 발생 → bottomPrice = 새 매수가 (마지막 체결 매수 차수의 가격)
            const lastBuy = [...mapped.buyPlans].filter((b) => b.filled).pop();
            updateData.bottomPrice = lastBuy?.filledPrice || lastBuy?.price || h.avgPrice;
            console.log(`[Rule B] ${h.name}: 추가매수 감지 → bottomPrice 리셋: ${updateData.bottomPrice}원`);
          }
        }
      } else {
        // 체결 API 데이터 없음 → holdings 데이터로 기본 처리
        if (!existingData?.firstBuyQuantity || existingData.firstBuyQuantity === 0) {
          updateData.firstBuyQuantity = h.quantity;
        }
        if (!existingData?.firstBuyPrice || existingData.firstBuyPrice === 0) {
          updateData.firstBuyPrice = h.avgPrice;
        }
        updateData.avgPrice = h.avgPrice;
        updateData.totalQuantity = h.quantity;

        // buyPlans 1차가 미체결이거나 filledPrice/filledQuantity 없으면
        // holdings 데이터로 채워서 ⚠️ 배지 해소
        const existingBuyPlans: any[] = existingData?.buyPlans || [];
        const bp0 = existingBuyPlans[0];
        if (bp0 && (!bp0.filled || !bp0.filledPrice || !bp0.filledQuantity)) {
          const updatedBuyPlans = existingBuyPlans.map((bp: any, idx: number) => {
            if (idx === 0) {
              return {
                ...bp,
                price: bp.price || h.avgPrice,
                quantity: bp.quantity || h.quantity,
                filled: true,
                filledDate: bp.filledDate || "",
                filledQuantity: bp.filledQuantity || h.quantity,
                filledPrice: bp.filledPrice || h.avgPrice,
              };
            }
            return bp;
          });
          updateData.buyPlans = updatedBuyPlans;
          console.log(`[동기화] ${h.name}: buyPlans 1차 holdings 기반 체결 처리`);
        }
      }

      // ✅ Race condition 방지: update 직전 latest doc 재조회 후 manualOverride 최종 보호
      // (sync 시작 시점과 update 시점 사이에 사용자가 분리/편집했을 수 있음)
      const latestDoc = await db.collection("stocks").doc(existingDocId).get();
      const latestData = latestDoc.data() || {};

      // sellPlans 최종 보호 (latest 기준)
      if (Array.isArray(updateData.sellPlans)) {
        const latestSellPlans: any[] = latestData.sellPlans || [];
        updateData.sellPlans = (updateData.sellPlans as any[]).map((newPlan: any, i: number) => {
          const latest = latestSellPlans[i];
          if (latest?.manualOverride) {
            console.log(`[sync race 보호] ${h.name} sell+${latest.percent}% latest manualOverride 유지`);
            return latest;
          }
          return newPlan;
        });
      }

      // buyPlans 최종 보호 (latest 기준)
      if (Array.isArray(updateData.buyPlans)) {
        const latestBuyPlans: any[] = latestData.buyPlans || [];
        updateData.buyPlans = (updateData.buyPlans as any[]).map((newPlan: any, i: number) => {
          const latest = latestBuyPlans[i];
          if (latest?.manualOverride) {
            console.log(`[sync race 보호] ${h.name} buy${i + 1}차 latest manualOverride 유지`);
            return latest;
          }
          return newPlan;
        });
      }

      // maSells 보존: sync는 maSells를 직접 update 하지 않으므로 latestData의 maSells 그대로 유지
      // (사용자가 분리한 maSells가 race로 손실되는 것 방지)
      if (Array.isArray(latestData.maSells) && latestData.maSells.length > 0) {
        // 명시적으로 latestData.maSells를 적용 (혹시 mapped 결과에 의해 변경됐을 가능성 차단)
        const hasFilledMa = latestData.maSells.some((m: any) => m.filled);
        if (hasFilledMa && !updateData.maSells) {
          // updateData에 maSells가 없어도 명시적으로 latest 적용 (race 방지)
          updateData.maSells = latestData.maSells;
          console.log(`[sync race 보호] ${h.name} maSells 보존 (filled ${latestData.maSells.filter((m: any) => m.filled).length}건)`);
        }
      }

      await db.collection("stocks").doc(existingDocId).update(updateData);
    } else {
      // 새 종목 추가
      const docId = `stock_${now}_${syncedStocks}`;

      const maSells = [20, 60, 120].map((ma) => ({
        ma,
        price: 0,
        quantity: 0,
        filled: false,
      }));

      // ✅ 새 종목 매수 즉시 MA20/60/120 계산 (다음 15:24 사이클까지 기다리지 않음)
      // 매수신호 텔레그램 알림 발송에 필요 (ma값 없으면 알림 발송 못함)
      let initialMa: {ma20: number; ma60: number; ma120: number; candles: number} | null = null;
      if (config && token && h.code) {
        try {
          initialMa = await fetchAndCalcMA(config, token, h.code);
          if (initialMa) {
            console.log(`[신규MA] ${h.name}(${h.code}): MA20=${initialMa.ma20} MA60=${initialMa.ma60} MA120=${initialMa.ma120} (${initialMa.candles}봉)`);
          }
        } catch (err: any) {
          console.warn(`[신규MA] ${h.name} 계산 실패: ${err.message}`);
        }
      }

      const kstNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
      const todayStr = `${kstNow.getFullYear()}-${String(kstNow.getMonth() + 1).padStart(2, "0")}-${String(kstNow.getDate()).padStart(2, "0")}`;

      await db.collection("stocks").doc(docId).set({
        name: h.name,
        code: h.code || "",
        rule: "A",
        firstBuyPrice: mapped.firstBuyPrice,
        firstBuyQuantity: mapped.firstBuyQty,
        currentPrice: h.currentPrice,
        avgPrice: h.avgPrice,
        totalQuantity: h.quantity,
        // ✅ 신용/융자거래 여부
        isCreditTrade: h.isCreditTrade === true,
        // ✅ Phase 1a: 현물/신용 포지션 세부
        positions: Array.isArray((h as any).positions) ? (h as any).positions : [],
        buyPlans: mapped.buyPlans,
        sellPlans: mapped.sellPlans,
        maSells,
        sellCount: mapped.sellCount,
        // ✅ MA 즉시 반영 (있으면)
        ...(initialMa ? {
          ma20: initialMa.ma20,
          ma60: initialMa.ma60,
          ma120: initialMa.ma120,
          maCalcDate: todayStr,
          maCandles: initialMa.candles,
        } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
    syncedStocks++;
  }

  // 잔고에 없거나 수량0인 기존 종목 = 전량 매도 → 매도내역 반영
  const holdingNames = new Set(activeHoldings.map((h) => h.name));
  const soldOutStocks: string[] = [];

  // 모든 trade의 종목명 로그
  const tradeNames = [...new Set(trades.map((t: any) => `${t.name}(${t.type})`))];
  console.log(`[전량매도 시작] existingStocks=${Object.keys(existingStocks).length}개, activeHoldings=${holdingNames.size}개, trades=${trades.length}건, tradeNames=[${tradeNames.join(",")}]`);

  for (const [name, docId] of Object.entries(existingStocks)) {
    if (holdingNames.has(name)) continue;

    const existingDoc = await db.collection("stocks").doc(docId).get();
    const data = existingDoc.data();
    if (!data) continue;

    // 이 종목의 매도 체결 내역
    const stockSells = trades.filter((t: any) => t.name === name && t.type === "sell");
    // sellPlans 중 filled된 것이 있는지 확인
    const hasFilledSells = (data.sellPlans || []).some((sp: any) => sp.filled);

    // ✅ 매핑 보존 — 다음 조건 중 하나라도 만족하면 전량매도 destructive 경로 스킵:
    //   1) 이미 filled sellPlan 존재 (사용자가 합치기/이동한 manual 슬롯 포함)
    //   2) maSells에 filled 있음 (MA 매도 분류 완료)
    //   3) 2차 이상 매수 (buyPlans 보존 필요)
    //   4) cycles 기록 있음 (과거 매매완료 사이클)
    //   5) 어느 slot에라도 consumedTradeIds 있음 (옵션 D 매핑 적용됨)
    //
    // ✅ 핵심: totalQty=0 prerequisite 제거 — totalQty 1000→0 transition 시점에도
    // 기존 매핑이 있으면 보존. 매 sync마다 전량매도가 manualOverride를 파괴하던 버그 차단.
    //
    // 새 종목 (filled 슬롯 전혀 없음 + 첫 전량매도 transition)에만 destructive 경로 허용.
    const hasExistingMappingState =
      hasFilledSells ||
      (data.maSells || []).some((m: any) => m.filled) ||
      (data.buyPlans || []).filter((b: any) => b.filled).length >= 2 ||
      (data.cycles || []).length > 0 ||
      (data.sellPlans || []).some((sp: any) => Array.isArray(sp.consumedTradeIds) && sp.consumedTradeIds.length > 0) ||
      (data.maSells || []).some((m: any) => Array.isArray(m.consumedTradeIds) && m.consumedTradeIds.length > 0);
    if (hasExistingMappingState) {
      // ✅ 매핑은 보존하되 잔고(totalQuantity)는 0으로 동기화
      // 디아이씨처럼 100% 매도 완료한 종목의 보유수량/평가손익이 stale 상태로 남는 버그 차단
      if ((data.totalQuantity || 0) > 0) {
        // 첫 매매완료 전환 — totalQty 업데이트 + 첫 사이클 처리
        const wasActive = true;
        const alreadyCompleted = (data.cycles?.length || 0) > 0;
        // ✅ currentPrice는 보존 (재진입 추적, 시각화에 필요)
        // 매매완료 후에도 현재가는 키움 sync로 계속 업데이트되어야 함
        const completionUpdate: any = {
          totalQuantity: 0,
          updatedAt: now,
        };
        // 첫 매매완료라면 cycles + reentry 추적 시작
        if (wasActive && !alreadyCompleted) {
          const cycleNo = (data.cycles?.length || 0) + 1;
          try {
            const cycle = buildTradingCycle(data as any, cycleNo);
            completionUpdate.cycles = admin.firestore.FieldValue.arrayUnion(cycle);
            if (config && token && data.code) {
              const reentryInit = await initializeReentryTracking(config, token, {
                ...data,
                code: data.code,
                name,
              } as any);
              if (reentryInit) {
                completionUpdate.reentry = reentryInit;
                console.log(`[재진입] ${name} 추적 시작: 최저가 ${reentryInit.lowPrice.toLocaleString()}원 (${reentryInit.lowPriceDate})`);
              }
            }
          } catch (err: any) {
            console.warn(`[전량매도 스킵] ${name} cycle/reentry 초기화 실패:`, err.message);
          }
        }
        await db.collection("stocks").doc(docId).update(completionUpdate);
        console.log(`[전량매도 스킵] ${name}: 매핑 보존 + totalQty ${data.totalQuantity}→0 동기화 (cycle=${alreadyCompleted ? "기존" : "신규"})`);
        soldOutStocks.push(`${name}(매핑보존)`);
      } else {
        console.log(`[전량매도 스킵] ${name}: 기존 매핑 보존 (totalQty 이미 0)`);
      }
      continue;
    }

    console.log(`[전량매도 체크] ${name}: totalQty=${data.totalQuantity}, stockSells=${stockSells.length}건, hasFilledSells=${hasFilledSells}, buyPlansFilled=${(data.buyPlans || []).filter((b: any) => b.filled).length}`);

    // 매도 데이터가 있으면 항상 sellPlans를 최신 ka10072 데이터로 갱신
    if (stockSells.length > 0) {
      // 매도 체결 데이터를 sellPlans에 직접 반영
      const avgBuyPrice = data.avgPrice || 0;
      const existingBuyPlans = data.buyPlans || [];

      // sellPlans 직접 생성 (mapTradesToPlans 대신 직접 처리)
      const sellsByDate: Record<string, {qty: number, amt: number, date: string}> = {};
      for (const sell of stockSells) {
        const key = sell.date;
        if (!sellsByDate[key]) sellsByDate[key] = {qty: 0, amt: 0, date: sell.date};
        sellsByDate[key].qty += sell.quantity;
        sellsByDate[key].amt += sell.price * sell.quantity;
      }

      const percents = [5, 10, 15, 20, 25];
      const newSellPlans: any[] = [];
      const sortedSells = Object.entries(sellsByDate).sort((a, b) => a[0].localeCompare(b[0]));
      for (let i = 0; i < sortedSells.length; i++) {
        const info = sortedSells[i][1];
        const avgPrice = Math.round(info.amt / info.qty);
        const formattedDate = `${info.date.slice(0,4)}-${info.date.slice(4,6)}-${info.date.slice(6,8)}`;
        newSellPlans.push({
          percent: percents[i] || (i + 1) * 5,
          price: avgPrice,
          quantity: info.qty,
          filled: true,
          filledDate: formattedDate,
          filledQuantity: info.qty,
          filledPrice: avgPrice,
        });
      }
      // 나머지 빈 매도 계획 추가 (5차까지)
      while (newSellPlans.length < 5) {
        const idx = newSellPlans.length;
        newSellPlans.push({
          percent: percents[idx] || (idx + 1) * 5,
          price: 0,
          quantity: 0,
          filled: false,
          filledDate: "",
          filledQuantity: 0,
          filledPrice: 0,
        });
      }

      const totalSellQty = stockSells.reduce((s: number, t: any) => s + t.quantity, 0);
      const totalSellAmt = stockSells.reduce((s: number, t: any) => s + t.price * t.quantity, 0);
      const avgSellPrice = totalSellQty > 0 ? Math.round(totalSellAmt / totalSellQty) : 0;
      const filledSellCount = Object.keys(sellsByDate).length;

      // buyPlans도 갱신: 전량매도이므로 총매도수량 = 원래매수수량
      const origBuyQty = totalSellQty; // 전량매도이므로 매도수량 합 = 원래 매수수량
      const existingAvgBuyPrice = data.avgPrice || (existingBuyPlans.find((bp: any) => bp.filled)?.filledPrice) || 0;
      const newBuyPlans = [{
        level: 1,
        price: existingAvgBuyPrice,
        quantity: origBuyQty,
        filled: true,
        filledDate: existingBuyPlans.find((bp: any) => bp.filledDate)?.filledDate || "",
        filledQuantity: origBuyQty,
        filledPrice: existingAvgBuyPrice,
      }];
      // 나머지 빈 매수 계획 (2~5차)
      for (let lv = 2; lv <= 5; lv++) {
        newBuyPlans.push({ level: lv, price: 0, quantity: 0, filled: false, filledDate: "", filledQuantity: 0, filledPrice: 0 });
      }

      console.log(`[전량매도] ${name}: 매도=${stockSells.length}건, 총매도수량=${totalSellQty}, 평균매도가=${avgSellPrice}, 평균매수가=${existingAvgBuyPrice}, 원래매수수량=${origBuyQty}, sellPlans=${filledSellCount}개`);

      // ✅ 매매완료 첫 감지 시 사이클 누적 + reentry 추적 시작
      const wasActive = (data.totalQuantity || 0) > 0;
      const alreadyCompleted = (data.cycles?.length || 0) > 0 && (data.totalQuantity || 0) === 0;

      const completionUpdate: any = {
        totalQuantity: 0,
        currentPrice: 0,
        avgPrice: existingAvgBuyPrice,
        buyPlans: newBuyPlans,
        sellPlans: newSellPlans,
        sellCount: filledSellCount,
        updatedAt: now,
      };

      if (wasActive && !alreadyCompleted) {
        // 첫 매매완료 → 사이클 push + reentry 시작
        const cycleNo = (data.cycles?.length || 0) + 1;
        const cycle = buildTradingCycle({
          ...data,
          buyPlans: newBuyPlans,
          sellPlans: newSellPlans,
        }, cycleNo);
        completionUpdate.cycles = admin.firestore.FieldValue.arrayUnion(cycle);

        if (config && token && data.code) {
          const reentryInit = await initializeReentryTracking(config, token, {
            ...data,
            code: data.code,
            name,
            buyPlans: newBuyPlans,
          });
          if (reentryInit) {
            completionUpdate.reentry = reentryInit;
            console.log(`[재진입] ${name} 추적 시작: 최저가 ${reentryInit.lowPrice.toLocaleString()}원 (${reentryInit.lowPriceDate})`);
          }
        }
      }

      await db.collection("stocks").doc(docId).update(completionUpdate);
      soldOutStocks.push(`${name}(매도${filledSellCount}회)`);

    } else if ((data.totalQuantity || 0) > 0) {
      // 매도 내역 없이 잔고에서 사라진 종목
      console.log(`[전량매도] ${name}: 체결내역 없음, totalQuantity ${data.totalQuantity} → 0`);
      await db.collection("stocks").doc(docId).update({
        totalQuantity: 0,
        currentPrice: 0,
        updatedAt: now,
      });
      soldOutStocks.push(`${name}(내역없음)`);
    } else {
      console.log(`[전량매도] ${name}: totalQty=0, stockSells=0 → 스킵`);
    }
  }
  console.log(`[전량매도 완료] ${soldOutStocks.length}건: ${soldOutStocks.join(", ")}`);

  // 체결 내역 → 매매일지
  // [B안] tradeId = trade_kiwoom_${orderNo}_${code}
  //   - orderNo+code 는 키움 체결의 자연 유니크 키
  //   - 예전: trade_kiwoom_${date}_${orderNo}_${code} → 같은 체결이 여러 날짜로 복제되면 중복 생성됨
  //   - 신규: date 제외 → 같은 orderNo 재조회 시 동일 문서로 수렴 (중복 원천 차단)
  for (const t of trades) {
    // orderNo 누락 방어: 없으면 날짜+시간+수량 해시로 대체 (완전한 구버전 폴백)
    const orderKey = t.orderNo && String(t.orderNo).trim() !== ""
      ? String(t.orderNo)
      : `fb_${t.date || ""}${t.time || ""}_${t.quantity || 0}`;
    const tradeId = `trade_kiwoom_${orderKey}_${t.code}`;
    const docRef = db.collection("trades").doc(tradeId);
    const doc = await docRef.get();

    // ✅ Phase 1a 보강: 기존 trade가 있어도 isCreditTrade/loanDt가 누락된 경우 부분 업데이트
    // (kt00007이 신용 정보를 새로 가져왔을 때, 기존 trade에 적용)
    if (doc.exists) {
      const existing = doc.data() || {};
      const needsCreditUpdate = (t.isCreditTrade === true && existing.isCreditTrade !== true);
      const needsLoanDtUpdate = (t.loanDt && !existing.loanDt);
      if (needsCreditUpdate || needsLoanDtUpdate) {
        const patch: any = {};
        if (needsCreditUpdate) patch.isCreditTrade = true;
        if (needsLoanDtUpdate) patch.loanDt = t.loanDt;
        if (t.rawCreditType && !existing.rawCreditType) patch.rawCreditType = t.rawCreditType;
        await docRef.update(patch);
        console.log(`[기존 trade 신용정보 보강] ${tradeId} ← ${JSON.stringify(patch)}`);
      }
    }

    if (!doc.exists) {
      const formattedDate = t.date
        ? `${t.date.slice(0, 4)}-${t.date.slice(4, 6)}-${t.date.slice(6, 8)}`
        : new Date().toISOString().slice(0, 10);

      // ✅ Cross-dedup 강화: 같은 (code, date, type, price, quantity) 조합 trade가 이미 있으면 skip
      // (키움 API가 같은 체결을 다른 ord_no로 두 번 반환하는 경우 중복 방지)
      const dupQuery = await db.collection("trades")
        .where("code", "==", t.code || "")
        .where("date", "==", formattedDate)
        .where("type", "==", t.type)
        .where("price", "==", t.price)
        .where("quantity", "==", t.quantity)
        .limit(1)
        .get();
      if (!dupQuery.empty) {
        const existingDoc = dupQuery.docs[0];
        const existingId = existingDoc.id;
        const existingData = existingDoc.data() || {};
        // ✅ Phase 1a 보강: 기존 trade의 isCreditTrade/loanDt 누락 시 보강
        const needsCreditUpdate = (t.isCreditTrade === true && existingData.isCreditTrade !== true);
        const needsLoanDtUpdate = (t.loanDt && !existingData.loanDt);
        if (needsCreditUpdate || needsLoanDtUpdate) {
          const patch: any = {};
          if (needsCreditUpdate) patch.isCreditTrade = true;
          if (needsLoanDtUpdate) patch.loanDt = t.loanDt;
          if (t.rawCreditType && !existingData.rawCreditType) patch.rawCreditType = t.rawCreditType;
          await existingDoc.ref.update(patch);
          console.log(`[기존 trade 신용정보 보강] ${existingId} ← ${JSON.stringify(patch)} (cross-dedup 매칭)`);
        }
        console.log(`[중복방지] ${t.name} ${formattedDate} ${t.type} ${t.price}x${t.quantity} 이미 있음 (${existingId}) - 신규 ${tradeId} 스킵`);
        continue;
      }

      // ─── 단위 sanity check (액면분할/병합 단위 오류 자동 감지) ───
      // 기존 stocks의 avgPrice와 새 trade의 price 비교
      // 50배 이상 또는 1/50배 이하 차이면 단위 의심 → 텔레그램 알림 + 태그 부여
      // (자동 정정 X: 정상 변동성 vs 단위 오류 자동 판별 불가, 사용자 확인 후 applySplitMergeRatio/updateTrade로 처리)
      const tags: string[] = ["#키움동기화"];
      try {
        let avgPriceForCheck = 0;
        if (t.code) {
          const stockByCode = await db.collection("stocks").where("code", "==", t.code).limit(1).get();
          if (!stockByCode.empty) avgPriceForCheck = Number(stockByCode.docs[0].data().avgPrice) || 0;
        }
        if (avgPriceForCheck <= 0 && t.name) {
          const stockByName = await db.collection("stocks").where("name", "==", t.name).limit(1).get();
          if (!stockByName.empty) avgPriceForCheck = Number(stockByName.docs[0].data().avgPrice) || 0;
        }
        const tradePrice = Number(t.price) || 0;
        if (avgPriceForCheck > 0 && tradePrice > 0) {
          const ratio = tradePrice / avgPriceForCheck;
          if (ratio >= 50 || ratio <= 0.02) {
            tags.push("#단위의심");
            console.warn(`[단위경고] ${t.name} ${formattedDate} ${t.type} ${tradePrice}원×${t.quantity}주 (평단 ${avgPriceForCheck}원, 비율 ${ratio.toFixed(2)}x) — 액면분할/병합 의심`);
            // 텔레그램 알림: 100배 이상 차이만 (1000배 등 명백한 케이스만 알림, false positive 최소화)
            if (ratio >= 100 || ratio <= 0.01) {
              const direction = ratio >= 100 ? "분할 전→후 미환산" : "병합 전→후 미환산";
              const suggestedRatio = ratio >= 100 ? Math.round(ratio) : Math.round(1 / ratio);
              await sendTelegram(
                `<b>⚠️ 단위 의심 trade 감지 — ${t.name}</b>\n\n` +
                `날짜: ${formattedDate}\n` +
                `유형: ${t.type === "buy" ? "매수" : "매도"}\n` +
                `trade: <b>${tradePrice.toLocaleString()}원 × ${(Number(t.quantity) || 0).toLocaleString()}주</b>\n` +
                `평단가: ${avgPriceForCheck.toLocaleString()}원\n` +
                `비율: <b>${ratio.toFixed(0)}배</b> (${direction} 가능성)\n` +
                `추정 ratio: <b>1:${suggestedRatio.toLocaleString()}</b>\n\n` +
                `🔧 검토 후 <code>applySplitMergeRatio</code> 또는 <code>updateTrade</code>로 정정하세요.\n` +
                `tradeId: <code>${tradeId}</code>`
              );
            }
          }
        }
      } catch (e: any) {
        console.error(`[단위경고] sanity check 실패: ${e.message}`);
      }

      await docRef.set({
        date: formattedDate,
        stockName: t.name,
        code: t.code || "",         // [B안] 쿼리 가능하도록 추가
        orderNo: orderKey,          // [B안] 쿼리 가능하도록 추가
        type: t.type,
        price: t.price,
        quantity: t.quantity,
        memo: `키움 자동동기화 (${t.time || ""})`,
        tags,
        // ✅ Phase 1a: 신용/융자거래 여부 trade에 보존
        isCreditTrade: t.isCreditTrade === true,
        // ✅ Phase 2 보강: 키움 신용 대출일 (kt00007 loan_dt) 보존
        ...(t.loanDt ? {loanDt: t.loanDt} : {}),
        ...(t.rawCreditType ? {rawCreditType: t.rawCreditType} : {}),
        createdAt: now,
      });
      syncedTrades++;
    }
  }

  // 동기화 기록 저장 (수동 동기화)
  await db.collection("settings").doc("lastManualSync").set({
    timestamp: now,
    stocks: syncedStocks,
    trades: syncedTrades,
  });
  // 하위 호환용
  await db.collection("settings").doc("lastSync").set({
    timestamp: now,
    stocks: syncedStocks,
    trades: syncedTrades,
  });

  // ✅ Phase 1a step 7: 동기화 후 positions 자동 분리
  // 다음 조건 중 하나라도 해당하면 reconcileStockPlans 호출:
  //   ① isCreditTrade=true 마킹된 종목
  //   ② trades에 isCreditTrade=true 거래 있는 종목
  //   ③ 키움 평단가 vs trades 평단가 2% 이상 차이 (= 잠재 신용 포지션)
  try {
    const stocksToReconcile = new Set<string>();
    const stocksSnap = await db.collection("stocks").get();

    // 종목별 trades 조회 (성능: 한 번에 받아서 메모리 매핑)
    const allTradesSnap = await db.collection("trades").get();
    const tradesByStock: Record<string, any[]> = {};
    allTradesSnap.forEach((doc) => {
      const t = doc.data();
      if (!t.stockName) return;
      if (!tradesByStock[t.stockName]) tradesByStock[t.stockName] = [];
      tradesByStock[t.stockName].push(t);
    });

    stocksSnap.forEach((doc) => {
      const data = doc.data();
      const name = data.name;
      if (!name || (data.totalQuantity || 0) === 0) return;

      // 조건 ①: 종목에 신용 플래그
      if (data.isCreditTrade === true) {
        stocksToReconcile.add(name);
        return;
      }
      const stockTrades = tradesByStock[name] || [];
      // 조건 ②: trades에 신용 매수
      if (stockTrades.some((t) => t.isCreditTrade === true)) {
        stocksToReconcile.add(name);
        return;
      }
      // 조건 ③: 키움 평단 vs trades 평단 차이 (잠재 신용)
      const stockAvg = Number(data.avgPrice) || 0;
      let tradeBoughtAmt = 0;
      let tradeBoughtQty = 0;
      for (const t of stockTrades) {
        if (t.type !== "buy") continue;
        const q = Number(t.quantity) || 0;
        const p = Number(t.price) || 0;
        tradeBoughtAmt += q * p;
        tradeBoughtQty += q;
      }
      if (tradeBoughtQty > 0 && stockAvg > 0) {
        const tradesAvg = tradeBoughtAmt / tradeBoughtQty;
        const diff = Math.abs(tradesAvg - stockAvg) / stockAvg;
        if (diff > 0.02) {
          // 2% 이상 차이 = 추가 매수분(신용 추정) 존재 가능성
          stocksToReconcile.add(name);
        }
      }
    });

    if (stocksToReconcile.size > 0) {
      console.log(`[kiwoomSync→reconcile] ${stocksToReconcile.size}개 종목 positions 재계산: ${Array.from(stocksToReconcile).join(", ")}`);
      for (const name of stocksToReconcile) {
        try {
          await reconcileStockPlans(name);
        } catch (e: any) {
          console.warn(`[kiwoomSync→reconcile] ${name} 실패: ${e.message}`);
        }
      }
    }
  } catch (e: any) {
    console.warn(`[kiwoomSync→reconcile] positions 자동 분리 실패: ${e.message}`);
  }

  return {syncedStocks, syncedTrades, soldOutStocks};
}

// ═══════════════════════════════════
// Cloud Functions 엔드포인트
// ═══════════════════════════════════

/**
 * 키움 데이터 동기화
 * POST /kiwoomSync
 * body: { startDate?: "20260320", endDate?: "20260320" }
 */
export const kiwoomSync = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 300})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);

        // 날짜 파라미터 (body에서 받음)
        const body = req.body || {};
        const startDate = body.startDate || undefined;
        const endDate = body.endDate || undefined;

        // startDate 없으면 최근 영업일(어제)~오늘(KST) 자동 설정
        // → 종가 매수 / 전일 체결 누락 방지
        const kstNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
        const todayKST = `${kstNow.getFullYear()}${String(kstNow.getMonth() + 1).padStart(2, "0")}${String(kstNow.getDate()).padStart(2, "0")}`;
        // 마지막 영업일 계산 (토/일이면 더 거슬러 올라감)
        const prevBizDay = new Date(kstNow);
        prevBizDay.setDate(prevBizDay.getDate() - 1);
        while (prevBizDay.getDay() === 0 || prevBizDay.getDay() === 6) {
          prevBizDay.setDate(prevBizDay.getDate() - 1);
        }
        const prevBizDayStr = `${prevBizDay.getFullYear()}${String(prevBizDay.getMonth() + 1).padStart(2, "0")}${String(prevBizDay.getDate()).padStart(2, "0")}`;

        const historyStart = startDate || prevBizDayStr;
        const historyEnd = endDate || todayKST;

        console.log(`[kiwoomSync] 체결 조회 범위: ${historyStart} ~ ${historyEnd} (${startDate ? "수동" : "자동"})`);

        // 잔고 + 체결내역 조회
        // ⚠️ fetchTodayTrades(ka10076 전체) 제거:
        //   - historyEnd=todayKST 이므로 fetchTradeHistory 안에서 오늘도 이미 처리됨
        //   - ka10076 sell_tp:"0"(전체) 는 trde_tp 로 타입 판별하는데, API가 "매도"→"1"(숫자)로
        //     반환하면 전부 "buy" 오분류 → 오늘 매도가 매수로 이중 저장되는 버그
        //   - todayTrades 는 fetchTradeHistory 내부 dedup/cross-dedup 을 거치지 않아 중복 방지 불가
        const [holdings, historyTrades] = await Promise.all([
          fetchHoldings(config, token),
          fetchTradeHistory(config, token, historyStart, historyEnd),
        ]);
        const trades = historyTrades;

        // Firestore에 동기화 (config/token 전달 - 재진입 추적용 일봉 조회에 사용)
        const result = await syncToFirestore(holdings, trades, config, token);

        res.json({
          success: true,
          syncedStocks: result.syncedStocks,
          syncedTrades: result.syncedTrades,
          soldOutStocks: result.soldOutStocks,
          holdingsCount: holdings.length,
          tradesCount: trades.length,
          syncTime: new Date().toISOString(),
        });
      } catch (error: any) {
        console.error("동기화 에러:", error);
        res.status(500).json({
          success: false,
          error: error.message || "동기화 실패",
        });
      }
    });
  });

/**
 * 키움 API 설정 저장
 * POST /kiwoomSetup
 * body: { appKey, appSecret, accountNo, htsId }
 */
export const kiwoomSetup = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST만 가능"});
          return;
        }

        const {appKey, appSecret, accountNo, htsId} = req.body;

        if (!appKey || !appSecret || !accountNo) {
          res.status(400).json({error: "appKey, appSecret, accountNo 필수"});
          return;
        }

        await db.collection("settings").doc("kiwoom").set({
          appKey,
          appSecret,
          accountNo,
          htsId: htsId || "",
          baseUrl: "https://api.kiwoom.com",
          updatedAt: Date.now(),
        });

        res.json({success: true, message: "키움 API 설정 저장 완료"});
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error.message,
        });
      }
    });
  });

/**
 * 연결 상태 확인
 * GET /kiwoomStatus
 */
export const kiwoomStatus = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const configDoc = await db.collection("settings").doc("kiwoom").get();
        const lastSyncDoc = await db
          .collection("settings")
          .doc("lastSync")
          .get();

        const hasConfig = configDoc.exists && !!configDoc.data()?.appKey;
        const lastSync = lastSyncDoc.data();

        res.json({
          configured: hasConfig,
          lastSync: lastSync
            ? {
              timestamp: lastSync.timestamp,
              stocks: lastSync.stocks,
              trades: lastSync.trades,
            }
            : null,
        });
      } catch (error: any) {
        res.status(500).json({error: error.message});
      }
    });
  });

// ─── 이동평균선 계산 (ka10081 일봉 데이터) ───
async function fetchAndCalcMA(
  config: KiwoomConfig,
  token: string,
  code: string
): Promise<{ma20: number; ma60: number; ma120: number; candles: number} | null> {
  try {
    const closes: number[] = [];
    let contYn = "N";
    let nextKey = "";
    const MAX_PAGES = 6; // 페이지당 ~20~50봉, 6페이지면 120봉 충분

    for (let page = 0; page < MAX_PAGES; page++) {
      const reqHeaders: Record<string, string> = {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": `Bearer ${token}`,
        "api-id": "ka10081",
      };
      if (contYn === "Y" && nextKey) {
        reqHeaders["cont-yn"] = "Y";
        reqHeaders["next-key"] = nextKey;
      }

      const res = await fetch(`${config.baseUrl}/api/dostk/chart`, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({
          stk_cd: code,
          base_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
          upd_stkpc_tp: "1", // 수정주가 적용
          qry_tp: "0",
        }),
      });

      const respContYn = res.headers.get("cont-yn") || res.headers.get("Cont-Yn") || "";
      const respNextKey = res.headers.get("next-key") || res.headers.get("Next-Key") || "";
      const data = await res.json() as any;

      const chart: any[] = data.stk_dt_pole_chart_qry || data.stk_dt_pole_chart || [];
      for (const c of chart) {
        // cur_prc = 당일 종가 (최신→오래된 순)
        const close = parseInt(c.cur_prc || c.cls_prc || c.close || "0");
        if (close > 0) closes.push(close);
      }

      if (closes.length >= 120 || respContYn !== "Y" || !respNextKey) break;
      contYn = "Y";
      nextKey = respNextKey;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (closes.length < 5) return null;

    const calcMA = (n: number): number => {
      if (closes.length < n) return 0;
      const sum = closes.slice(0, n).reduce((a, b) => a + b, 0);
      return Math.round(sum / n);
    };

    return {
      ma20: calcMA(20),
      ma60: calcMA(60),
      ma120: calcMA(120),
      candles: closes.length,
    };
  } catch (err) {
    console.log(`[MA계산] ${code} 실패:`, err);
    return null;
  }
}

// ─── 종목 일봉 차트 조회 (재진입 추적용 - 저가/종가 포함) ───
// 매매완료 종목의 리얼 최저가를 찾기 위해 사용
interface DailyCandle {
  date: string;     // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
}

async function fetchDailyChart(
  config: KiwoomConfig,
  token: string,
  code: string,
  fromDate?: string  // YYYYMMDD - 이 날짜 이후 데이터만 수집 (없으면 전체)
): Promise<DailyCandle[]> {
  try {
    const candles: DailyCandle[] = [];
    let contYn = "N";
    let nextKey = "";
    const MAX_PAGES = 12; // 페이지당 ~20봉, 12페이지 = ~240봉 (1년+ 커버)

    for (let page = 0; page < MAX_PAGES; page++) {
      const reqHeaders: Record<string, string> = {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": `Bearer ${token}`,
        "api-id": "ka10081",
      };
      if (contYn === "Y" && nextKey) {
        reqHeaders["cont-yn"] = "Y";
        reqHeaders["next-key"] = nextKey;
      }

      const res = await fetch(`${config.baseUrl}/api/dostk/chart`, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({
          stk_cd: code,
          base_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
          upd_stkpc_tp: "1",
          qry_tp: "0",
        }),
      });

      const respContYn = res.headers.get("cont-yn") || res.headers.get("Cont-Yn") || "";
      const respNextKey = res.headers.get("next-key") || res.headers.get("Next-Key") || "";
      const data = await res.json() as any;

      const chart: any[] = data.stk_dt_pole_chart_qry || data.stk_dt_pole_chart || [];
      let stopEarly = false;
      for (const c of chart) {
        const dt = String(c.dt || c.date || "").trim();
        const close = parseInt(c.cur_prc || c.cls_prc || c.close || "0");
        const open = parseInt(c.open_pric || c.op_prc || c.open || "0");
        const high = parseInt(c.high_pric || c.hgst_prc || c.hi_pric || c.high || "0");
        const low = parseInt(c.low_pric || c.lwst_prc || c.lo_pric || c.low || "0");

        if (close <= 0 || !dt) continue;

        // fromDate 이전 봉이면 더 이상 페이지 가져올 필요 없음 (역순 응답이라 중단)
        if (fromDate && dt < fromDate) {
          stopEarly = true;
          break;
        }

        const formatted = dt.length === 8
          ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`
          : dt;

        candles.push({
          date: formatted,
          open: open || close,
          high: high || close,
          low: low || close,
          close,
        });
      }

      if (stopEarly || respContYn !== "Y" || !respNextKey) break;
      contYn = "Y";
      nextKey = respNextKey;
      await new Promise((r) => setTimeout(r, 200));
    }

    return candles;
  } catch (err) {
    console.log(`[일봉] ${code} 실패:`, err);
    return [];
  }
}

// ─── 단일 종목 현재가 조회 (매매완료 reentry 추적용 - holdings에 없는 종목) ───
async function fetchSinglePrice(
  config: KiwoomConfig,
  token: string,
  code: string
): Promise<{currentPrice: number; openPrice: number} | null> {
  try {
    const res = await fetch(`${config.baseUrl}/api/dostk/chart`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "authorization": `Bearer ${token}`,
        "api-id": "ka10081",
      },
      body: JSON.stringify({
        stk_cd: code,
        base_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        upd_stkpc_tp: "0",
        qry_tp: "0",
      }),
    });
    const data = await res.json() as any;
    const chart = data.stk_dt_pole_chart_qry || data.stk_dt_pole_chart || [];
    if (chart.length === 0) return null;
    const top = chart[0];
    return {
      currentPrice: parseInt(top.cur_prc || top.cls_prc || "0"),
      openPrice: parseInt(top.open_pric || top.op_prc || "0"),
    };
  } catch (err) {
    console.log(`[현재가] ${code} 실패:`, err);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
//  재진입 추적 (태산매매법: 매매완료 → +100% → -50% → 첫 양봉)
// ════════════════════════════════════════════════════════════════

// ─── 사이클 history 객체 생성 (매매완료 시점에 stocks.cycles 배열에 push) ───
function buildTradingCycle(
  stockData: any,
  cycleNo: number
): any {
  const today = new Date().toISOString().slice(0, 10);
  const buyPlans = stockData.buyPlans || [];
  const sellPlans = stockData.sellPlans || [];
  const maSells = stockData.maSells || [];

  let totalBuyAmt = 0;
  for (const bp of buyPlans) {
    if (bp.filled) {
      const price = bp.filledPrice || bp.price || 0;
      const qty = bp.filledQuantity || bp.quantity || 0;
      totalBuyAmt += price * qty;
    }
  }
  let totalSellAmt = 0;
  for (const sp of sellPlans) {
    if (sp.filled) {
      const price = sp.filledPrice || sp.price || 0;
      const qty = sp.filledQuantity || sp.quantity || 0;
      totalSellAmt += price * qty;
    }
  }
  for (const m of maSells) {
    if (m.filled) totalSellAmt += (m.price || 0) * (m.quantity || 0);
  }
  const profit = totalSellAmt - totalBuyAmt;
  const profitPct = totalBuyAmt > 0 ? (profit / totalBuyAmt) * 100 : 0;

  // 시작일 = 가장 빠른 매수 filledDate
  const buyDates = buyPlans
    .filter((bp: any) => bp.filled && bp.filledDate)
    .map((bp: any) => bp.filledDate)
    .sort();
  const startDate = buyDates[0] || "";

  return {
    cycleNo,
    startDate,
    endDate: today,
    totalBuyAmt,
    totalSellAmt,
    realizedProfit: profit,
    profitPercent: Math.round(profitPct * 100) / 100,
    buyPlans: buyPlans.map((bp: any) => ({...bp})),
    sellPlans: sellPlans.map((sp: any) => ({...sp})),
    maSells: maSells.map((m: any) => ({...m})),
    rule: stockData.rule || "A",
  };
}

// ─── 매매완료 종목 reentry 추적 시작 (1회성 초기 설정) ───
// 일봉 API로 매매기간 + 이후 누적 최저가 추출
async function initializeReentryTracking(
  config: KiwoomConfig,
  token: string,
  stockData: any
): Promise<any> {
  const code = stockData.code;
  if (!code) {
    console.log(`[재진입 init] ${stockData.name} code 없음 - 추적 시작 불가`);
    return null;
  }

  // 시작일 = 가장 빠른 매수 filledDate
  const buyDates = (stockData.buyPlans || [])
    .filter((bp: any) => bp.filled && bp.filledDate)
    .map((bp: any) => (bp.filledDate as string).replace(/-/g, ""))
    .sort();
  const fromDate = buyDates[0] || undefined;

  console.log(`[재진입 init] ${stockData.name}(${code}) 일봉 조회 시작 (from=${fromDate || "전체"})`);
  const candles = await fetchDailyChart(config, token, code, fromDate);

  if (candles.length === 0) {
    console.log(`[재진입 init] ${stockData.name} 일봉 데이터 없음`);
    return null;
  }

  // 최저가 추출 (모든 봉의 low 중 최솟값)
  let lowPrice = Number.MAX_SAFE_INTEGER;
  let lowDate = "";
  for (const c of candles) {
    if (c.low > 0 && c.low < lowPrice) {
      lowPrice = c.low;
      lowDate = c.date;
    }
  }

  if (lowPrice === Number.MAX_SAFE_INTEGER) {
    console.log(`[재진입 init] ${stockData.name} 유효 저가 없음`);
    return null;
  }

  // 현재가 (최신 봉의 close)
  const sortedCandles = [...candles].sort((a, b) => b.date.localeCompare(a.date));
  const currentPrice = sortedCandles[0]?.close || 0;

  console.log(`[재진입 init] ${stockData.name} 최저가 ${lowPrice.toLocaleString()}원 (${lowDate}), 현재 ${currentPrice.toLocaleString()}원`);

  const today = new Date().toISOString().slice(0, 10);
  const isRebounded = currentPrice >= lowPrice * 2;

  // Firestore는 undefined 거부 - 빈 문자열로 처리하거나 필드 제외
  const result: any = {
    enabled: true,
    status: "tracking",
    lowPrice,
    lowPriceDate: lowDate,
    lowPriceSource: "kiwoom_daily",
    rebounded: isRebounded,
    reboundDate: isRebounded ? today : "",
    peakPrice: currentPrice,
    peakPriceDate: today,
    targetPrice: Math.round(currentPrice * 0.5),
    signalSent: false,
    signalDate: "",
    readyAt: "",
    startedAt: Date.now(),
  };
  return result;
}

// ─── 가격 업데이트 시 reentry 상태 자동 갱신 (옵션 A: 단순 동적 갱신) ───
function updateReentryTracking(
  reentry: any,
  currentPrice: number
): {updated: boolean; newReady: boolean} {
  if (!reentry || !reentry.enabled || reentry.status === "paused") {
    return {updated: false, newReady: false};
  }
  if (currentPrice <= 0) return {updated: false, newReady: false};

  const today = new Date().toISOString().slice(0, 10);
  let updated = false;
  let newReady = false;

  // 1. 최저가 갱신 (현재가가 더 낮으면)
  if (currentPrice < reentry.lowPrice || !reentry.lowPrice) {
    reentry.lowPrice = currentPrice;
    reentry.lowPriceDate = today;
    reentry.lowPriceSource = "realtime";
    updated = true;
  }

  // 2. 반등 확인 (lowPrice * 2 도달)
  if (!reentry.rebounded && reentry.lowPrice > 0 && currentPrice >= reentry.lowPrice * 2) {
    reentry.rebounded = true;
    reentry.reboundDate = today;
    updated = true;
  }

  // 3. 신고점 갱신 (현재가가 peak 초과 - 옵션 A: 단순 동적 갱신)
  if (currentPrice > (reentry.peakPrice || 0)) {
    reentry.peakPrice = currentPrice;
    reentry.peakPriceDate = today;
    reentry.targetPrice = Math.round(currentPrice * 0.5);
    // 새 고점이면 ready 상태에서 다시 tracking으로 (가격이 다시 -50% 도달해야 ready)
    if (reentry.status === "ready") {
      reentry.status = "tracking";
      reentry.readyAt = ""; // Firestore: undefined 대신 빈 문자열
      reentry.signalSent = false;
    }
    updated = true;
  }

  // 4. 매수 대기 진입 (반등 후 + 신고점 -50% 이하)
  if (
    reentry.rebounded &&
    reentry.peakPrice > 0 &&
    currentPrice <= reentry.peakPrice * 0.5 &&
    reentry.status !== "ready"
  ) {
    reentry.status = "ready";
    reentry.readyAt = today;
    newReady = true;
    updated = true;
  }

  return {updated, newReady};
}

// ─── 매매완료 종목 reentry 추적 일괄 업데이트 (가격 fetch + 상태 갱신) ───
async function refreshReentryStocks(config: KiwoomConfig, token: string): Promise<{
  updated: number;
  newReady: string[];
}> {
  const updated: string[] = [];
  const newReady: string[] = [];

  // reentry.enabled=true 인 종목 조회 (보유수량 0인 매매완료 종목 중)
  const snap = await db.collection("stocks").get();
  const targets: Array<{id: string; data: any}> = [];
  snap.forEach((doc) => {
    const d = doc.data();
    if (d.reentry?.enabled && (d.totalQuantity || 0) === 0 && d.code) {
      targets.push({id: doc.id, data: d});
    }
  });

  if (targets.length === 0) return {updated: 0, newReady};

  console.log(`[재진입 갱신] 대상 ${targets.length}종목`);

  for (const {id, data} of targets) {
    try {
      const priceInfo = await fetchSinglePrice(config, token, data.code);
      if (!priceInfo || priceInfo.currentPrice <= 0) continue;

      const reentry = {...data.reentry};
      const result = updateReentryTracking(reentry, priceInfo.currentPrice);

      if (result.updated) {
        await db.collection("stocks").doc(id).update({
          currentPrice: priceInfo.currentPrice,
          reentry,
          updatedAt: Date.now(),
        });
        updated.push(data.name);
        if (result.newReady) {
          newReady.push(data.name);
          console.log(`[재진입] ${data.name} READY 진입 (peak=${reentry.peakPrice}, target=${reentry.targetPrice}, 현재=${priceInfo.currentPrice})`);
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    } catch (err: any) {
      console.log(`[재진입 갱신] ${data.name} 실패: ${err.message}`);
    }
  }

  return {updated: updated.length, newReady};
}

// ─── 보유종목 이동평균 업데이트 + 텔레그램 근접 알림 ───
async function updateHoldingMAs(config: KiwoomConfig, token: string): Promise<void> {
  const stockDocs = await db.collection("stocks").get();
  const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
  const today = `${kst.getFullYear()}-${String(kst.getMonth() + 1).padStart(2, "0")}-${String(kst.getDate()).padStart(2, "0")}`;

  for (const doc of stockDocs.docs) {
    const s = doc.data();
    // 보유 중인 종목만 (수량 > 0)
    if (!s.code || (s.totalQuantity || 0) <= 0) continue;
    // 당일 이미 계산했으면 스킵
    if (s.maCalcDate === today) continue;

    const ma = await fetchAndCalcMA(config, token, s.code);
    if (!ma) {
      console.log(`[MA업데이트] ${s.name}(${s.code}) 봉데이터 없음`);
      continue;
    }

    const curPrice = s.currentPrice || 0;
    const updates: Record<string, any> = {
      ma20: ma.ma20,
      ma60: ma.ma60,
      ma120: ma.ma120,
      maCalcDate: today,
      maCandles: ma.candles,
    };

    // 단계별 근접 알림: 단계마다 당일 1회씩 (±2/1/0%)
    if (curPrice > 0) {
      const stagesField = (s.maStagesAlerted as any) || {};
      const todayStages: Record<string, number> = stagesField.date === today
        ? (stagesField.stages || {}) : {};
      const newStages = {...todayStages};
      const alerts: string[] = [];
      let stagesChanged = false;

      // ✅ 이미 매도 완료한 MA는 알림 스킵 (태산매매법: MA 매도 1회로 종결)
      const maSellsArr: any[] = Array.isArray(s.maSells) ? s.maSells : [];
      const isMaSold = (maNum: number) => {
        const m = maSellsArr.find((x) => x.ma === maNum);
        return m?.filled === true && (Number(m.quantity) || 0) > 0;
      };

      const checkStage = (maVal: number, label: string, maNum: number) => {
        if (maVal <= 0) return;
        if (isMaSold(maNum)) return; // ✅ 매도 완료 MA 스킵
        const gap = ((curPrice - maVal) / maVal) * 100;
        const stage = getMaStage(gap);
        if (!stage) return;
        const key = `${label}:${stage}`;
        if (newStages[key]) return;
        newStages[key] = 1;
        stagesChanged = true;
        alerts.push(maStageMessage(label, stage, gap));
      };
      checkStage(ma.ma20, "MA20", 20);
      checkStage(ma.ma60, "MA60", 60);
      checkStage(ma.ma120, "MA120", 120);

      if (alerts.length > 0 && stagesChanged) {
        updates.maStagesAlerted = {date: today, stages: newStages};
        let msg = `<b>📈 이동평균선 단계 알림 — ${s.name}</b>\n`;
        msg += `현재가: <b>${curPrice.toLocaleString()}원</b>\n`;
        msg += `MA20: ${ma.ma20 > 0 ? ma.ma20.toLocaleString() + "원" : "계산불가"}\n`;
        msg += `MA60: ${ma.ma60 > 0 ? ma.ma60.toLocaleString() + "원" : "계산불가"}\n`;
        msg += `MA120: ${ma.ma120 > 0 ? ma.ma120.toLocaleString() + "원" : "계산불가"}\n\n`;
        for (const a of alerts) msg += `${a}\n`;
        msg += `\n🔍 HTS 차트에서 저항/지지 여부를 직접 확인하세요.`;
        await sendTelegram(msg);
        console.log(`[MA단계알림] ${s.name} 텔레그램 발송: ${alerts.join(" | ")}`);
      }
    }

    await db.collection("stocks").doc(doc.id).update(updates);
    await new Promise((r) => setTimeout(r, 300));
    console.log(`[MA업데이트] ${s.name}: MA20=${ma.ma20} MA60=${ma.ma60} MA120=${ma.ma120} (${ma.candles}봉)`);
  }
}

// ─── 실시간 알림 체크 (5분마다 kiwoomAutoSync에서 호출) ───
// 1) 23%+ 수익 → 25% 매도 준비 알림
// 2) MA선 근접 → 저항/이탈 알림
async function checkRealtimeAlerts(
  stockDataList: Array<{id: string; data: admin.firestore.DocumentData}>,
  holdingsMap: Record<string, {currentPrice: number; avgPrice: number}>
): Promise<void> {
  const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
  const today = `${kst.getFullYear()}-${String(kst.getMonth() + 1).padStart(2, "0")}-${String(kst.getDate()).padStart(2, "0")}`;

  for (const {id, data: s} of stockDataList) {
    if ((s.totalQuantity || 0) <= 0) continue;

    // 현재가: API에서 막 가져온 값 우선, 없으면 Firestore 저장값
    const holding = holdingsMap[s.code || ""];
    const curPrice = holding?.currentPrice || s.currentPrice || 0;
    const avgPrice = holding?.avgPrice || s.avgPrice || 0;
    if (curPrice <= 0 || avgPrice <= 0) continue;

    const profitPct = ((curPrice - avgPrice) / avgPrice) * 100;
    const updates: Record<string, any> = {};

    // ─── 1. 23%+ 수익 근접 알림 (당일 1회) ───
    if (profitPct >= 23 && s.profitAlertDate !== today) {
      // 25% 미체결 매도 계획이 있는 경우만
      const nextSell = (s.sellPlans || []).find((sp: any) => !sp.filled);
      if (nextSell && (nextSell.percent || 0) >= 25) {
        updates.profitAlertDate = today;

        let msg = `<b>💰 매도 준비! ${s.name}</b>\n`;
        msg += `현재 수익: <b>+${profitPct.toFixed(1)}%</b>\n`;
        msg += `평균단가: ${avgPrice.toLocaleString()}원\n`;
        msg += `현재가: ${curPrice.toLocaleString()}원\n\n`;
        msg += `🎯 매도 목표 (+${nextSell.percent}%): <b>${(nextSell.price || 0).toLocaleString()}원</b>\n`;
        if ((nextSell.quantity || 0) > 0) {
          msg += `수량: ${nextSell.quantity.toLocaleString()}주\n`;
        }
        msg += `\n⚠️ <b>HTS에서 수동 매도 준비하세요!</b>`;

        await sendTelegram(msg);
        console.log(`[수익알림] ${s.name}: +${profitPct.toFixed(1)}% → 25% 매도 준비 알림 발송`);
      }
    }

    // ─── 2. MA선 단계별 알림 (당일 단계마다 1회씩, ±2/1/0%) ───
    {
      const stagesField = (s.maStagesAlerted as any) || {};
      const todayStages: Record<string, number> = stagesField.date === today
        ? (stagesField.stages || {}) : {};

      const maChecks = [
        {label: "MA20", maNum: 20, val: (s.ma20 || 0) as number},
        {label: "MA60", maNum: 60, val: (s.ma60 || 0) as number},
        {label: "MA120", maNum: 120, val: (s.ma120 || 0) as number},
      ];

      // ✅ 이미 매도 완료한 MA는 알림 스킵 (태산매매법: MA 매도 1회로 종결)
      const maSellsArr: any[] = Array.isArray(s.maSells) ? s.maSells : [];
      const isMaSold = (maNum: number) => {
        const m = maSellsArr.find((x) => x.ma === maNum);
        return m?.filled === true && (Number(m.quantity) || 0) > 0;
      };

      const newAlerts: string[] = [];
      const newStages = {...todayStages};
      let stagesChanged = false;

      for (const m of maChecks) {
        if (m.val <= 0) continue;
        if (isMaSold(m.maNum)) continue; // ✅ 매도 완료 MA 스킵
        const gap = ((curPrice - m.val) / m.val) * 100;
        const stage = getMaStage(gap);
        if (!stage) continue;
        const key = `${m.label}:${stage}`;
        if (newStages[key]) continue; // 이미 오늘 발송한 단계
        newStages[key] = 1;
        stagesChanged = true;
        newAlerts.push(maStageMessage(m.label, stage, gap));
      }

      if (newAlerts.length > 0 && stagesChanged) {
        updates.maStagesAlerted = {date: today, stages: newStages};

        let msg = `<b>📈 이동평균선 단계 알림 — ${s.name}</b>\n`;
        msg += `현재가: <b>${curPrice.toLocaleString()}원</b>`;
        if (profitPct !== 0) {
          msg += ` (${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(1)}%)`;
        }
        msg += `\n\n`;
        for (const a of newAlerts) msg += `${a}\n`;
        msg += `\n🔍 HTS 차트에서 직접 확인 후 판단하세요.`;

        await sendTelegram(msg);
        console.log(`[MA단계알림] ${s.name}: ${newAlerts.join(" | ")}`);
      }
    }

    if (Object.keys(updates).length > 0) {
      await db.collection("stocks").doc(id).update(updates);
    }
  }
}

/**
 * 장중 자동 동기화 (5분마다, 평일 9:00~15:30 KST)
 * Cloud Scheduler가 자동 호출
 */
export const kiwoomAutoSync = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 300})
  .pubsub.schedule("every 5 minutes")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    const now = new Date();
    const kst = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
    const hour = kst.getHours();
    const min = kst.getMinutes();
    const day = kst.getDay();
    const timeNum = hour * 100 + min;

    // 평일 09:00~15:50 실행 (15:35~15:45 trade 백필 포함)
    if (day === 0 || day === 6 || timeNum < 900 || timeNum > 1550) {
      console.log(`장외 시간 (${hour}:${min}, 요일:${day}) - 스킵`);
      return;
    }

    try {
      const config = await getKiwoomConfig();
      const token = await getAccessToken(config);
      const holdings = await fetchHoldings(config, token);

      // 관심종목 → 실제매수 자동 전환 체크
      const transferred = await checkWatchlistBought(holdings);
      if (transferred > 0) {
        console.log(`[자동동기화] 관심종목 → 실제매수 전환: ${transferred}종목`);
        // ✅ Option A: 매수 전환 시 즉시 오늘 trade 백필
        // (이렇게 안 하면 trades 컬렉션에 매수 trade가 빠져서 매매일지/통계에서 누락됨)
        try {
          const todayApi = `${kst.getFullYear()}${String(kst.getMonth() + 1).padStart(2, "0")}${String(kst.getDate()).padStart(2, "0")}`;
          const todayTrades = await fetchTradeHistory(config, token, todayApi, todayApi);
          const saved = await saveKiwoomTradesBackfill(todayTrades);
          console.log(`[전환후백필] 오늘(${todayApi}) trade ${saved}건 저장`);
        } catch (err: any) {
          console.warn(`[전환후백필] 실패: ${err.message}`);
        }
      }

      // ✅ Option B: 15:35~15:45 KST 1일 1회 오늘 trade 자동 백필
      // 장 마감 후 ka10076 응답이 안정화된 시점에 그날의 매수/매도 trade 일괄 저장
      // (수동 "키움 데이터 받기" 안 눌러도 자동으로 매매 기록 보존)
      if (timeNum >= 1535 && timeNum < 1545) {
        const todayKstStr = `${kst.getFullYear()}-${String(kst.getMonth() + 1).padStart(2, "0")}-${String(kst.getDate()).padStart(2, "0")}`;
        try {
          const lastBackfillDoc = await db.collection("settings").doc("lastTradeBackfill").get();
          const lastBackfillDate = lastBackfillDoc.exists ? lastBackfillDoc.data()?.date : "";
          if (lastBackfillDate !== todayKstStr) {
            const todayApi = todayKstStr.replace(/-/g, "");
            const todayTrades = await fetchTradeHistory(config, token, todayApi, todayApi);
            const saved = await saveKiwoomTradesBackfill(todayTrades);
            await db.collection("settings").doc("lastTradeBackfill").set({
              date: todayKstStr,
              savedCount: saved,
              fetchedCount: todayTrades.length,
              timestamp: Date.now(),
            });
            console.log(`[자동백필/15:40] ${saved}/${todayTrades.length}건 trade 저장 (date=${todayKstStr})`);
          } else {
            console.log(`[자동백필/15:40] 이미 ${todayKstStr} 백필 완료 — 스킵`);
          }
        } catch (err: any) {
          console.warn(`[자동백필/15:40] 실패: ${err.message}`);
        }
      }

      // 자동동기화: 현재가 + 잔고만 업데이트 (buyPlans/sellPlans 보존)
      const stockDocs = await db.collection("stocks").get();
      const codeToId: Record<string, string> = {};
      const nameToId: Record<string, string> = {};
      stockDocs.forEach((d) => {
        const data = d.data();
        if (data.code) codeToId[data.code] = d.id;
        if (data.name) nameToId[data.name] = d.id;
      });

      // holdings → code 기준 맵 (실시간 알림 체크에서 사용)
      const holdingsMap: Record<string, {currentPrice: number; avgPrice: number}> = {};
      for (const h of holdings) {
        if (h.code) holdingsMap[h.code] = {currentPrice: h.currentPrice, avgPrice: h.avgPrice};
      }

      // stockDocs 전체 데이터 맵 (bottomPrice 추적에 사용)
      const stockFullData: Record<string, admin.firestore.DocumentData> = {};
      stockDocs.forEach((d) => { stockFullData[d.id] = d.data(); });

      let updated = 0;
      for (const h of holdings) {
        // 종목코드 우선, 이름은 폴백
        const docId = (h.code && codeToId[h.code]) || nameToId[h.name];
        if (docId) {
          // ✅ Phase 1a 수정 (회귀 방지):
          // 키움 kt00005가 단일 row만 반환할 때 기존의 multi-position을 덮어쓰지 않도록 처리.
          // → 기존 positions가 multi이면(현물+신용 분리됨) 그대로 보존
          //   reconcile이 trades 기반으로 정확한 분리 유지
          const existingData = stockFullData[docId];
          const existingPositions = Array.isArray(existingData?.positions) ? existingData!.positions : [];
          const newPositions = Array.isArray(h.positions) ? h.positions : [];
          const shouldKeepExisting = existingPositions.length > 1 && newPositions.length <= 1;
          const positionsToSave = shouldKeepExisting ? existingPositions : newPositions;
          const isCreditFromPositions = positionsToSave.some((p: any) => p?.type === "credit");

          const updateData: any = {
            currentPrice: h.currentPrice,
            avgPrice: h.avgPrice,
            totalQuantity: h.quantity,
            // ✅ 신용/융자거래 여부 (기존 multi-position 보존 시 그 값 우선)
            isCreditTrade: shouldKeepExisting ? isCreditFromPositions : h.isCreditTrade === true,
            // ✅ Phase 1a: 현물/신용 포지션 세부 (fetchHoldings에서 통합)
            positions: positionsToSave,
            updatedAt: Date.now(),
          };
          // code 필드 마이그레이션
          if (h.code && !codeToId[h.code]) {
            updateData.code = h.code;
          }
          // ─── Rule B 저점 자동 추적 (DEPRECATED — 일봉 기반으로 이전) ───
          // ⚠️ currentPrice 기반 추적은 룰B 정의(일봉 저가 기준)와 충돌
          //    이제 ruleBTracker cron(매일 15:35 KST)이 일봉 low 기반으로 갱신
          //    여기서는 bottomPrice가 한 번도 설정 안 된 경우만 초기값으로 currentPrice 사용
          //    (cron이 다음 실행에서 정확한 일봉 low로 덮어씀)
          const stockData = stockFullData[docId];
          if (stockData?.rule === "B") {
            const storedBottom = stockData.bottomPrice || 0;
            // 초기값 시드만: 기존 값 없을 때만 currentPrice 사용
            if (storedBottom === 0) {
              updateData.bottomPrice = h.currentPrice;
              // buyPlans 미체결 차수 재계산 (manualOverride 보호)
              const existingPlans = Array.isArray(stockData.buyPlans) ? stockData.buyPlans : [];
              if (existingPlans.length > 0) {
                const newBottom = h.currentPrice;
                const recalcedPlans: any[] = [];
                for (let i = 0; i < existingPlans.length; i++) {
                  const bp = existingPlans[i];
                  if (bp.manualOverride || bp.filled) {
                    recalcedPlans.push(bp);
                    continue;
                  }
                  const prev = i > 0 ? recalcedPlans[i - 1] : null;
                  let newPrice: number;
                  if (!prev || prev.filled) {
                    // 첫 미체결 차수 → newBottom × 0.9
                    newPrice = Math.round(newBottom * 0.9);
                  } else {
                    // 이전도 미체결 → 룰B 계단식
                    newPrice = Math.round((prev.price || 0) * 0.9);
                  }
                  recalcedPlans.push({...bp, price: newPrice});
                }
                updateData.buyPlans = recalcedPlans;
              }
            }
          }
          await db.collection("stocks").doc(docId).update(updateData);
          updated++;
        }
      }

      await db.collection("settings").doc("lastAutoSync").set({
        timestamp: Date.now(), stocks: updated,
      });
      await db.collection("settings").doc("lastSync").set({
        timestamp: Date.now(), stocks: updated, trades: 0,
      });

      console.log(`자동동기화 완료: ${updated}종목 현재가 업데이트 (${hour}:${min})`);

      // ✅ Phase 1a: 신용 관련 종목 positions 자동 분리
      // kt00005가 단일 row만 줄 때 trades 기반으로 현물/신용 분리 유지
      try {
        const stocksToReconcile = new Set<string>();
        const allTradesSnap = await db.collection("trades").get();
        const tradesByStock: Record<string, any[]> = {};
        allTradesSnap.forEach((doc) => {
          const t = doc.data();
          if (!t.stockName) return;
          if (!tradesByStock[t.stockName]) tradesByStock[t.stockName] = [];
          tradesByStock[t.stockName].push(t);
        });

        for (const doc of stockDocs.docs) {
          const data = doc.data();
          const name = data.name;
          if (!name || (data.totalQuantity || 0) === 0) continue;
          // ① 신용 플래그 있는 종목
          if (data.isCreditTrade === true) {
            stocksToReconcile.add(name);
            continue;
          }
          // ② 기존 positions에 credit 있는 종목 (회귀 방지)
          if (Array.isArray(data.positions) && data.positions.some((p: any) => p?.type === "credit")) {
            stocksToReconcile.add(name);
            continue;
          }
          // ③ trades에 신용 매수
          const stockTrades = tradesByStock[name] || [];
          if (stockTrades.some((t) => t.isCreditTrade === true)) {
            stocksToReconcile.add(name);
            continue;
          }
          // ④ 키움 평단 vs trades 평단 차이 > 2% (잠재 신용)
          const stockAvg = Number(data.avgPrice) || 0;
          let tradeBoughtAmt = 0;
          let tradeBoughtQty = 0;
          for (const t of stockTrades) {
            if (t.type !== "buy") continue;
            const q = Number(t.quantity) || 0;
            const p = Number(t.price) || 0;
            tradeBoughtAmt += q * p;
            tradeBoughtQty += q;
          }
          if (tradeBoughtQty > 0 && stockAvg > 0) {
            const tradesAvg = tradeBoughtAmt / tradeBoughtQty;
            if (Math.abs(tradesAvg - stockAvg) / stockAvg > 0.02) {
              stocksToReconcile.add(name);
            }
          }
        }

        if (stocksToReconcile.size > 0) {
          console.log(`[autoSync→reconcile] ${stocksToReconcile.size}개 신용 관련 종목 positions 재계산`);
          for (const name of stocksToReconcile) {
            try {
              await reconcileStockPlans(name);
            } catch (e: any) {
              console.warn(`[autoSync→reconcile] ${name} 실패: ${e.message}`);
            }
          }
        }
      } catch (e: any) {
        console.warn(`[autoSync→reconcile] positions 자동 분리 실패: ${e.message}`);
      }

      // 실시간 알림 체크: 23%+ 수익 / MA선 근접 (5분마다)
      const stockDataList = stockDocs.docs.map((d) => ({id: d.id, data: d.data()}));
      await checkRealtimeAlerts(stockDataList, holdingsMap);

      // 관심종목 현재가는 항상 갱신, 1차 매수신호 텔레그램은 종가 무렵(15:10~15:40)에만
      //   (매수신호는 종가 기준 — runBuySignalCheck 게이트와 동일 윈도우)
      const isSignalTime = timeNum >= 1510 && timeNum <= 1540;
      await updateWatchlistPrices(config, token, isSignalTime);

      // 이동평균선 계산 (15:20~15:30, 하루 1회) — MA값 갱신 전용, 알림은 checkRealtimeAlerts가 담당
      if (timeNum >= 1520 && timeNum <= 1530) {
        console.log(`[MA업데이트] 이동평균 계산 시작 (${hour}:${min})`);
        await updateHoldingMAs(config, token);
      }
    } catch (err: any) {
      console.error("자동동기화 실패:", err.message);
    }
  });

/**
 * 가격만 빠르게 업데이트 (프론트엔드 폴링용)
 * GET /kiwoomPriceUpdate
 */
export const kiwoomPriceUpdate = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        const holdings = await fetchHoldings(config, token);

        // 현재가만 업데이트 (buyPlans/sellPlans 건드리지 않음)
        const now = Date.now();
        const stockDocs = await db.collection("stocks").get();
        const codeToId: Record<string, string> = {};
        const nameToId: Record<string, string> = {};
        stockDocs.forEach((doc) => {
          const data = doc.data();
          if (data.code) codeToId[data.code] = doc.id;
          if (data.name) nameToId[data.name] = doc.id;
        });

        let updated = 0;
        for (const h of holdings) {
          const docId = (h.code && codeToId[h.code]) || nameToId[h.name];
          if (docId) {
            await db.collection("stocks").doc(docId).update({
              currentPrice: h.currentPrice,
              updatedAt: now,
            });
            updated++;
          }
        }

        // 매매완료 reentry 추적 종목 가격 갱신 + 상태 전이
        const reentryResult = await refreshReentryStocks(config, token);

        await db.collection("settings").doc("lastSync").set({
          timestamp: now, stocks: updated, trades: 0,
        });

        res.json({
          success: true,
          updated,
          reentryUpdated: reentryResult.updated,
          reentryNewReady: reentryResult.newReady,
          time: new Date().toISOString(),
        });
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 특정 종목 또는 전체 보유 종목의 MA 즉시 계산 (강제 트리거)
 * POST /forceMAUpdate
 * body: { stockNames?: string[] }  - 비어있으면 전체 보유 종목
 *
 * 새 매수 종목이 MA 사이클(15:24)을 놓친 경우 즉시 갱신용.
 */
export const forceMAUpdate = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 300})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const stockNames: string[] | null = req.body?.stockNames || null;
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        const stockDocs = await db.collection("stocks").get();
        const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
        const today = `${kst.getFullYear()}-${String(kst.getMonth() + 1).padStart(2, "0")}-${String(kst.getDate()).padStart(2, "0")}`;

        const results: any[] = [];
        for (const doc of stockDocs.docs) {
          const s = doc.data();
          if (!s.code || (s.totalQuantity || 0) <= 0) continue;
          if (stockNames && stockNames.length > 0 && !stockNames.includes(s.name)) continue;

          const ma = await fetchAndCalcMA(config, token, s.code);
          if (!ma) {
            results.push({stockName: s.name, ok: false, error: "no candle data"});
            continue;
          }
          await db.collection("stocks").doc(doc.id).update({
            ma20: ma.ma20,
            ma60: ma.ma60,
            ma120: ma.ma120,
            maCalcDate: today,
            maCandles: ma.candles,
          });
          results.push({
            stockName: s.name,
            ok: true,
            ma20: ma.ma20,
            ma60: ma.ma60,
            ma120: ma.ma120,
            candles: ma.candles,
          });
          await new Promise((r) => setTimeout(r, 300));
        }

        res.json({success: true, count: results.length, results});
      } catch (error: any) {
        console.error("[forceMAUpdate] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * Cloud Function의 외부 IP 확인
 * GET /checkIp
 */
export const checkIp = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const ipRes = await fetch("https://api.ipify.org?format=json", {timeout: 30000});
        const data = await ipRes.json() as any;
        res.json({ip: data.ip});
      } catch (error: any) {
        res.status(500).json({error: error.message});
      }
    });
  });

// ─── MA 단계 판정 (현재가 vs MA gap%) ───
// 단계: '+2', '+1', '0', '-1', '-2'
//   gap > 2 또는 < -2: 범위 벗어남 (null)
//   1 < gap ≤ 2: '+2' (2% 근접)
//   0.1 < gap ≤ 1: '+1' (1% 임박)
//   -0.1 ≤ gap ≤ 0.1: '0' (도달)
//   -1 ≤ gap < -0.1: '-1' (1% 이탈)
//   -2 ≤ gap < -1: '-2' (2% 이탈)
function getMaStage(gap: number): string | null {
  if (gap > 2) return null;
  if (gap > 1) return "+2";
  if (gap > 0.1) return "+1";
  if (gap >= -0.1) return "0";
  if (gap >= -1) return "-1";
  if (gap >= -2) return "-2";
  return null;
}

function maStageMessage(label: string, stage: string, gap: number): string {
  const gapStr = (gap >= 0 ? "+" : "") + gap.toFixed(1) + "%";
  switch (stage) {
    case "+2": return `📊 ${label}선 2% 근접 (현재 ${gapStr})`;
    case "+1": return `📊 ${label}선 1% 임박 (현재 ${gapStr})`;
    case "0":  return `🎯 ${label}선 도달 (현재 ${gapStr})`;
    case "-1": return `⚠️ ${label}선 1% 이탈 (현재 ${gapStr} → 손실 매도 검토)`;
    case "-2": return `🚨 ${label}선 2% 이탈 (현재 ${gapStr} → 매도 권장)`;
    default: return `${label}선 ${gapStr}`;
  }
}

// ─── 텔레그램 메시지 전송 ───
async function sendTelegram(text: string): Promise<boolean> {
  try {
    const settingsDoc = await db.collection("settings").doc("telegram").get();
    const settings = settingsDoc.data();
    if (!settings?.botToken || !settings?.chatId) {
      console.log("[텔레그램] 설정 없음 - 스킵");
      return false;
    }

    const url = `https://api.telegram.org/bot${settings.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        chat_id: settings.chatId,
        text,
        parse_mode: "HTML",
      }),
    });
    const data = await res.json() as any;
    if (!data.ok) {
      console.error("[텔레그램] 전송 실패:", data.description);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error("[텔레그램] 오류:", err.message);
    return false;
  }
}

// ─── 관심종목 → 실제매수 전환 체크 ───
// holdings에 있는 종목코드가 watchlist에 있으면:
//  1) taesanFirstBuyLog 컬렉션에 로그 기록
//  2) watchlist에서 해당 문서 삭제
//  3) 텔레그램 알림 발송
async function checkWatchlistBought(holdings: any[]): Promise<number> {
  if (!holdings || holdings.length === 0) return 0;

  const watchDocs = await db.collection("watchlist").get();
  if (watchDocs.empty) return 0;

  // 종목코드 + 이름 기반 watchlist 맵 구성
  const watchByCode: Record<string, { id: string; data: any }> = {};
  const watchByName: Record<string, { id: string; data: any }> = {};
  watchDocs.forEach((d) => {
    const data = d.data();
    if (data.code) watchByCode[(data.code || "").trim()] = { id: d.id, data };
    if (data.name) watchByName[(data.name || "").trim()] = { id: d.id, data };
  });

  console.log(`[관심종목→매수] watchlist 총 ${watchDocs.size}개, holdings ${holdings.length}개 체크`);
  console.log(`[관심종목→매수] watch codes: [${Object.keys(watchByCode).join(",")}]`);
  console.log(`[관심종목→매수] holdings codes: [${holdings.map((h) => `${h.name}:${h.code}`).join(",")}]`);

  let transferred = 0;
  for (const h of holdings) {
    if ((h.quantity || 0) <= 0) continue;

    // 종목코드 우선 매칭, 실패 시 이름 매칭 (fallback)
    const hCode = (h.code || "").trim();
    const hName = (h.name || "").trim();
    const matched = (hCode && watchByCode[hCode]) || watchByName[hName];
    if (!matched) continue;

    const { id: watchId, data: watchData } = matched;
    console.log(`[관심종목→매수] 매칭됨: ${hName}(${hCode}) ← watchlist(${watchData.code})`);

    try {
      // 1) 태산1차매수완료이력 로그 기록
      const now = Date.now();
      const kst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
      const dateStr = `${kst.getFullYear()}-${String(kst.getMonth() + 1).padStart(2, "0")}-${String(kst.getDate()).padStart(2, "0")}`;
      const timeStr = `${String(kst.getHours()).padStart(2, "0")}:${String(kst.getMinutes()).padStart(2, "0")}`;

      const targetPrice = Math.round((watchData.peakPrice || 0) * (1 + (watchData.targetPercent || -50) / 100));

      await db.collection("taesanFirstBuyLog").add({
        name: h.name,
        code: h.code,
        peakPrice: watchData.peakPrice || 0,
        targetPercent: watchData.targetPercent || -50,
        targetPrice,
        actualBuyPrice: h.avgPrice || 0,
        actualBuyQuantity: h.quantity || 0,
        currentPrice: h.currentPrice || 0,
        watchedSince: watchData.createdAt || null,
        signalDate: watchData.signalDate || null,
        boughtDate: dateStr,
        boughtTime: timeStr,
        createdAt: now,
      });

      // 2) 관심종목에서 삭제
      await db.collection("watchlist").doc(watchId).delete();

      // 3) 텔레그램 알림
      const dropPercent = watchData.peakPrice > 0
        ? ((h.avgPrice - watchData.peakPrice) / watchData.peakPrice) * 100
        : 0;

      let msg = `<b>🎯 관심종목 매수 확인!</b>\n`;
      msg += `<i>${dateStr} ${timeStr}</i>\n\n`;
      msg += `<b>📌 ${h.name}</b> (${h.code})\n`;
      msg += `  최고점: ${(watchData.peakPrice || 0).toLocaleString()}원\n`;
      msg += `  목표가: ${targetPrice.toLocaleString()}원 (${watchData.targetPercent || -50}%)\n`;
      msg += `  매수가: ${(h.avgPrice || 0).toLocaleString()}원 (${dropPercent.toFixed(1)}%)\n`;
      msg += `  매수량: ${(h.quantity || 0).toLocaleString()}주\n\n`;
      msg += `✅ 관심종목 → <b>실제매매</b>로 이동되었습니다.\n`;
      msg += `📖 태산1차매수완료이력에 기록됨`;

      await sendTelegram(msg);
      console.log(`[관심종목→매수] ${h.name}(${h.code}): 전환 완료`);
      transferred++;
    } catch (err: any) {
      console.error(`[관심종목→매수] ${h.name} 전환 실패:`, err.message);
    }
  }

  return transferred;
}

// ─── 시가 조회 (ka10001 주식기본정보 또는 ka10081 일봉) ───
async function fetchOpenPrices(
  config: KiwoomConfig,
  token: string,
  stockCodes: string[]
): Promise<Record<string, number>> {
  const openPrices: Record<string, number> = {};

  for (const code of stockCodes) {
    try {
      // ka10081 (주식일봉차트조회) - 시가 포함
      const res = await fetch(`${config.baseUrl}/api/dostk/chart`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "authorization": `Bearer ${token}`,
          "api-id": "ka10081",
        },
        body: JSON.stringify({
          stk_cd: code,
          base_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
          upd_stkpc_tp: "0",
          qry_tp: "0",
        }),
      });
      const data = await res.json() as any;
      console.log(`[시가조회] ${code}: keys=${Object.keys(data).join(",")}`);

      // 응답 구조 분석
      const keys = Object.keys(data);
      console.log(`[시가조회] ${code}: keys=${keys.join(",")}`);

      // 일봉 차트 데이터에서 시가 추출
      const chartData = data.stk_dt_pole_chart_qry || data.stk_dt_pole_chart || [];
      if (Array.isArray(chartData) && chartData.length > 0) {
        const today = chartData[0];
        const todayKeys = Object.keys(today);
        console.log(`[시가조회] ${code}: chartKeys=${todayKeys.join(",")}, sample=${JSON.stringify(today).substring(0, 200)}`);
        const openPrice = parseInt(today.open_pric || today.strt_pric || today.open || today.stk_oprc || "0");
        if (openPrice > 0) {
          openPrices[code] = openPrice;
          console.log(`[시가조회] ${code}: 시가=${openPrice}`);
        }
      } else {
        const sample = JSON.stringify(data).substring(0, 300);
        console.log(`[시가조회] ${code}: 차트 없음, data=${sample}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    } catch (err: any) {
      console.log(`[시가조회] ${code} 실패: ${err.message}`);
    }
  }
  return openPrices;
}

// ─── 관심종목 현재가 업데이트 ───
async function updateWatchlistPrices(config: KiwoomConfig, token: string, enableSignal = false): Promise<number> {
  const watchDocs = await db.collection("watchlist").get();
  if (watchDocs.empty) return 0;

  const items: {id: string; name: string; code: string; peakPrice: number; targetPercent: number; prevAlertLevel: number; signalSent: boolean}[] = [];
  watchDocs.forEach((d) => {
    const data = d.data();
    if (data.code && data.status !== "bought") {
      items.push({
        id: d.id,
        name: data.name || "",
        code: data.code,
        peakPrice: data.peakPrice || 0,
        targetPercent: data.targetPercent || -50,
        prevAlertLevel: data.alertLevel || 0,
        signalSent: data.signalSent || false,
      });
    }
  });

  if (items.length === 0) return 0;

  let updated = 0;
  for (const item of items) {
    try {
      const res = await fetch(`${config.baseUrl}/api/dostk/chart`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "authorization": `Bearer ${token}`,
          "api-id": "ka10081",
        },
        body: JSON.stringify({
          stk_cd: item.code,
          base_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
          upd_stkpc_tp: "0",
          qry_tp: "0",
        }),
      });
      const data = await res.json() as any;
      const chart = data.stk_dt_pole_chart_qry || data.stk_dt_pole_chart || [];
      if (chart.length > 0) {
        const curPrice = parseInt(chart[0].cur_prc || "0");
        const openPrice = parseInt(chart[0].open_pric || chart[0].strt_pric || "0");
        const prevClose = chart.length > 1
          ? parseInt(chart[1].cur_prc || "0")
          : parseInt(chart[0].base_pric || chart[0].yday_prc || "0");

        if (curPrice > 0) {
          const dropPercent = item.peakPrice > 0 ? ((curPrice - item.peakPrice) / item.peakPrice) * 100 : 0;
          const isYangbong = openPrice > 0 && curPrice > openPrice;

          let alertLevel: 0 | 1 | 2 | 3 = 0;
          let status = "watching";
          if (dropPercent <= -50 && isYangbong) { alertLevel = 3; status = "ready"; }
          else if (dropPercent <= -45) { alertLevel = 2; status = "approaching"; }
          else if (dropPercent <= -40) { alertLevel = 1; status = "approaching"; }

          const updateData: Record<string, any> = {
            currentPrice: curPrice,
            openPrice: openPrice,
            prevClose: prevClose || 0,
            status,
            alertLevel,
            updatedAt: Date.now(),
          };

          // 텔레그램 알림은 15:10 근처(enableSignal=true)에서만 발송
          if (enableSignal) {
            // 첫 양봉 매수신호: -50% 이하 + 양봉 + 아직 신호 미발송
            if (alertLevel === 3 && !item.signalSent) {
              updateData.signalSent = true;
              updateData.signalDate = new Date().toISOString().slice(0, 10);

              const targetPrice = Math.round(item.peakPrice * (1 + item.targetPercent / 100));
              const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
              const y = kst.getFullYear();
              const mo = String(kst.getMonth() + 1).padStart(2, "0");
              const dd = String(kst.getDate()).padStart(2, "0");
              const hh = kst.getHours();
              const mm = String(kst.getMinutes()).padStart(2, "0");

              let msg = `<b>🔴 관심종목 1차 매수신호!</b>\n`;
              msg += `<i>${y}-${mo}-${dd} ${hh}:${mm}</i>\n\n`;
              msg += `<b>📌 ${item.name}</b> (${item.code})\n`;
              msg += `  최고점: ${item.peakPrice.toLocaleString()}원\n`;
              msg += `  목표가: ${targetPrice.toLocaleString()}원 (-50%)\n`;
              msg += `  현재가: ${curPrice.toLocaleString()}원 (${dropPercent.toFixed(1)}%)\n`;
              msg += `  시가: ${openPrice.toLocaleString()}원 → <b>양봉 확인!</b>\n\n`;
              msg += `⏰ <b>종가매수 준비하세요!</b>`;

              await sendTelegram(msg);
              console.log(`[관심종목] ${item.name}: 첫 양봉 매수신호 텔레그램 발송!`);
            }

            // -50% 이하인데 음봉이면 signalSent 리셋 (다음 양봉에서 다시 알림)
            if (dropPercent <= -50 && !isYangbong && item.signalSent) {
              updateData.signalSent = false;
            }
          }

          await db.collection("watchlist").doc(item.id).update(updateData);
          updated++;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    } catch (err: any) {
      console.log(`[관심종목 가격] ${item.code} 실패: ${err.message}`);
    }
  }
  console.log(`[관심종목] ${updated}/${items.length}종목 현재가 업데이트`);
  return updated;
}

// ─── 매수신호 체크 핵심 로직 ───
async function runBuySignalCheck(): Promise<string> {
    const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
    // 매수신호(첫 양봉) 텔레그램은 종가 무렵(15:10~15:40)에만 발송.
    //   태산매매법은 종가 매수 — 장중/NXT 시간엔 양봉이어도 종가에 음봉될 수 있어 의미 없음.
    //   그 외 상태 갱신(buySignal 화면표시)·관심종목 가격감시는 NXT 시간 포함 항상 수행.
    const _timeNum = kst.getHours() * 100 + kst.getMinutes();
    const isCloseWindow = _timeNum >= 1510 && _timeNum <= 1540;
    console.log(`[매수신호] 체크 시작 ${kst.getHours()}:${kst.getMinutes()} (종가윈도우=${isCloseWindow})`);

    try {
      const config = await getKiwoomConfig();
      const token = await getAccessToken(config);

      // 1. 현재 보유 종목 + Firestore 데이터 조회
      const holdings = await fetchHoldings(config, token);
      const stockDocs = await db.collection("stocks").get();
      const stocks: Record<string, any> = {};
      stockDocs.forEach((doc) => {
        const data = doc.data();
        if (data.name) stocks[data.name] = {...data, docId: doc.id};
      });

      // 2. 현재가 업데이트
      for (const h of holdings) {
        if (stocks[h.name]) {
          stocks[h.name].currentPrice = h.currentPrice;
          stocks[h.name].code = h.code;
        }
      }

      // 3. 4버킷 상태기계 (실제매매 관점)
      //   기준가 = 다음 미체결 차수의 룰 기준가 (룰B 저점×0.9 / 룰A 직전실제×0.9)
      //   🔴 매수신호  : 현재가 ≤ 기준가 AND 양봉(현재가>시가)  → 당일 매수
      //   🟡 신호지난  : 신호이력(미체결) AND 기준가 < 현재가 ≤ 기준가×1.10  → 눌림/재진입 감시
      //   ⏳ 매수대기  : 현재가 ≤ 기준가 AND 음봉             → 첫 양봉 대기
      //   📊 보유중    : 현재가 > 기준가×1.10 (이력 리셋)
      const PASSED_BAND = 1.10;
      const evalList: any[] = [];     // 일반 보유 종목 상태평가 대상
      const reentryList: any[] = [];  // 재진입 1차 후보
      for (const [name, stock] of Object.entries(stocks)) {
        // 매매완료(totalQuantity=0): 재진입 ready만 후보
        if (!stock.buyPlans || (stock.totalQuantity || 0) <= 0) {
          if (
            stock.reentry?.enabled &&
            stock.reentry?.status === "ready" &&
            stock.code &&
            stock.currentPrice > 0
          ) {
            reentryList.push({
              name,
              code: stock.code,
              nextBuyPrice: stock.reentry.targetPrice,
              nextBuyLevel: 1,
              currentPrice: stock.currentPrice,
              quantity: stock.firstBuyQuantity || 0,
              docId: stock.docId,
              alreadySent: stock.reentry?.signalSent === true,
              isReentry: true,
            });
          }
          continue;
        }
        const nextBuy = (stock.buyPlans || []).find((b: any) => !b.filled);
        if (!nextBuy || !stock.currentPrice || stock.currentPrice <= 0) continue;

        // 기준가: 다음 차수의 룰(차수별 stamp)로 계산
        const filledPlans = (stock.buyPlans || []).filter((b: any) => b.filled);
        const lastFilledPrice = filledPlans.length > 0
          ? (filledPlans[filledPlans.length - 1].filledPrice || filledPlans[filledPlans.length - 1].price || 0)
          : 0;
        const stageRule = nextBuy.rule === "B" ? "B" : "A";
        let base: number;
        if (stageRule === "B") {
          base = (stock.bottomPrice || 0) > 0 ? Math.round(stock.bottomPrice * 0.9) : 0; // 0=저점필요
        } else {
          base = lastFilledPrice > 0 ? Math.round(lastFilledPrice * 0.9) : (nextBuy.price || 0);
        }
        if (base <= 0) {
          // 룰B 저점 미설정 등 기준가 불명 → 신호 비움 (시작점 입력 유도)
          if (stock.buySignal && stock.docId) {
            await db.collection("stocks").doc(stock.docId).update({buySignal: null});
          }
          continue;
        }
        evalList.push({
          name,
          code: stock.code || (holdings.find((h) => h.name === name) || {code: ""}).code || "",
          base,
          level: nextBuy.level,
          currentPrice: stock.currentPrice,
          quantity: nextBuy.quantity || stock.firstBuyQuantity || 0,
          docId: stock.docId,
          firedLevel: typeof stock.buySignalFiredLevel === "number" ? stock.buySignalFiredLevel : null,
          sent: stock.buySignalSent === true,
          sentLevel: stock.buySignalLevel,
        });
      }

      // 4. 시가 조회 (현재가 ≤ 기준가 종목 + 재진입 후보만 양봉 판정 필요)
      const codes = [
        ...evalList.filter((e) => e.currentPrice <= e.base).map((e) => e.code),
        ...reentryList.map((e) => e.code),
      ].filter(Boolean);
      const openPrices = await fetchOpenPrices(config, token, codes);

      // 5. 상태 판정
      const signals: any[] = [];
      const waitings: any[] = [];
      const now = Date.now();

      for (const e of evalList) {
        const cur = e.currentPrice;
        const base = e.base;
        const passedCeil = Math.round(base * PASSED_BAND);
        const firedThisLevel = e.firedLevel === e.level;

        if (cur <= base) {
          const openPrice = openPrices[e.code] || 0;
          const isYangbong = openPrice > 0 && cur > openPrice;
          if (isYangbong) {
            const firstAlert = !(e.sent && e.sentLevel === e.level);
            const upd: any = {
              buySignal: "signal",
              buySignalAt: now,
              buySignalOpen: openPrice,
              buySignalFiredLevel: e.level, // 신호이력 (체결/이탈 전까지 유지)
            };
            // 텔레그램 발송·dedup 마킹은 종가 윈도우에만. 그 외엔 화면 상태만 갱신.
            if (isCloseWindow) {
              upd.buySignalSent = true;
              upd.buySignalLevel = e.level;
            }
            await db.collection("stocks").doc(e.docId).update(upd);
            if (firstAlert && isCloseWindow) {
              signals.push({...e, nextBuyPrice: base, nextBuyLevel: e.level, openPrice});
            }
            console.log(`[매수신호] ${e.name}: 🔴 ${e.level}차 기준 ${base} ≥ 현재 ${cur}, 양봉(시가 ${openPrice})${firstAlert ? " 첫알림" : ""}`);
          } else {
            await db.collection("stocks").doc(e.docId).update({
              buySignal: "waiting",
              buySignalAt: now,
              buySignalOpen: openPrice,
            });
            waitings.push({...e, nextBuyPrice: base, nextBuyLevel: e.level, openPrice});
            console.log(`[매수신호] ${e.name}: ⏳ ${e.level}차 기준 ${base} ≥ 현재 ${cur}, 음봉(시가 ${openPrice}) 대기`);
          }
        } else if (firedThisLevel && cur <= passedCeil) {
          // 신호 떴는데 안 사고 기준가 위 (+10% 이내) → 신호지난 (감시)
          await db.collection("stocks").doc(e.docId).update({buySignal: "passed", buySignalAt: now});
          console.log(`[매수신호] ${e.name}: 🟡 신호지난 ${e.level}차 (기준 ${base}, 현재 ${cur} ≤ +10%)`);
        } else {
          // 보유중: 현재가 > 기준가×1.10 이면 이력 완전 리셋
          const upd: any = {buySignal: null};
          if (cur > passedCeil) {
            upd.buySignalFiredLevel = null;
            upd.buySignalSent = false;
          }
          await db.collection("stocks").doc(e.docId).update(upd);
        }
      }

      // 6. 재진입 1차 (별도)
      for (const c of reentryList) {
        const openPrice = openPrices[c.code] || 0;
        const isYangbong = openPrice > 0 && c.currentPrice > openPrice;
        if (c.currentPrice > c.nextBuyPrice) {
          if (c.docId) await db.collection("stocks").doc(c.docId).update({buySignal: null});
          continue;
        }
        if (isYangbong && !c.alreadySent) {
          const upd: any = {
            buySignal: "signal",
            buySignalAt: now,
            buySignalOpen: openPrice,
          };
          // 재진입 매수신호 발송·dedup 마킹도 종가 윈도우에만
          if (isCloseWindow) {
            upd["reentry.signalSent"] = true;
            upd["reentry.signalDate"] = new Date().toISOString().slice(0, 10);
          }
          await db.collection("stocks").doc(c.docId).update(upd);
          if (isCloseWindow) signals.push({...c, openPrice});
        } else if (isYangbong && c.alreadySent) {
          await db.collection("stocks").doc(c.docId).update({buySignal: "signal", buySignalAt: now, buySignalOpen: openPrice});
        } else {
          await db.collection("stocks").doc(c.docId).update({
            buySignal: "waiting", buySignalAt: now, buySignalOpen: openPrice, "reentry.signalSent": false,
          });
          waitings.push({...c, openPrice});
        }
      }

      // 6. 텔레그램: 첫 양봉 매수신호만 발송
      const y = kst.getFullYear();
      const m = String(kst.getMonth() + 1).padStart(2, "0");
      const d = String(kst.getDate()).padStart(2, "0");
      const hh = kst.getHours();
      const mm = String(kst.getMinutes()).padStart(2, "0");

      if (signals.length > 0) {
        // 재진입 신호와 일반 신호 분리해서 발송 (구분 명확화)
        const reentrySignals = signals.filter((s: any) => s.isReentry);
        const normalSignals = signals.filter((s: any) => !s.isReentry);

        if (normalSignals.length > 0) {
          let msg = `<b>🔴 태산매매법 매수신호! (첫 양봉)</b>\n`;
          msg += `<i>${y}-${m}-${d} ${hh}:${mm}</i>\n\n`;
          for (const s of normalSignals) {
            const yangbongRate = s.openPrice > 0 ? ((s.currentPrice - s.openPrice) / s.openPrice * 100).toFixed(1) : "?";
            msg += `<b>📌 ${s.name}</b> (${s.code})\n`;
            msg += `  ${s.nextBuyLevel}차 매수 | 매수가: ${s.nextBuyPrice.toLocaleString()}원\n`;
            msg += `  현재가: ${s.currentPrice.toLocaleString()}원\n`;
            msg += `  시가: ${s.openPrice.toLocaleString()}원 (양봉 +${yangbongRate}%)\n`;
            msg += `  수량: ${s.quantity.toLocaleString()}주\n\n`;
          }
          msg += `⏰ <b>종가배팅 준비하세요!</b>`;
          await sendTelegram(msg);
        }

        if (reentrySignals.length > 0) {
          let msg = `<b>🟣 재진입 1차 매수신호! (매매완료 후 사이클 재개)</b>\n`;
          msg += `<i>${y}-${m}-${d} ${hh}:${mm}</i>\n\n`;
          for (const s of reentrySignals as any[]) {
            const yangbongRate = s.openPrice > 0 ? ((s.currentPrice - s.openPrice) / s.openPrice * 100).toFixed(1) : "?";
            msg += `<b>📌 ${s.name}</b> (${s.code})\n`;
            msg += `  매매완료 후 재진입 | -50% 도달 후 첫 양봉\n`;
            msg += `  현재가: ${s.currentPrice.toLocaleString()}원\n`;
            msg += `  시가: ${s.openPrice.toLocaleString()}원 (양봉 +${yangbongRate}%)\n\n`;
          }
          msg += `⏰ <b>재진입 1차 매수 준비!</b>`;
          await sendTelegram(msg);
        }
      }

      // 대기 종목도 참고 알림 (첫 양봉 미발생 종목) — 매수 관련이라 종가 윈도우에만
      if (waitings.length > 0 && signals.length === 0 && isCloseWindow) {
        let msg = `<b>⏳ 태산매매법 매수 대기</b>\n`;
        msg += `<i>${y}-${m}-${d} ${hh}:${mm}</i>\n\n`;
        for (const c of waitings) {
          msg += `📋 ${c.name} (${c.nextBuyLevel}차)\n`;
          msg += `  매수가: ${c.nextBuyPrice.toLocaleString()}원 | 현재: ${c.currentPrice.toLocaleString()}원\n`;
          msg += `  시가: ${c.openPrice.toLocaleString()}원 → 음봉 (매수 보류)\n\n`;
        }
        await sendTelegram(msg);
      }

    } catch (err: any) {
      console.error("[매수신호] 오류:", err.message);
      await sendTelegram(`⚠️ 매수신호 체크 오류: ${err.message}`);
      return `오류: ${err.message}`;
    }

    // ─── 25%+ 수동 매도 신호 체크 (키움 자동매매 20% 한계 보완) ───
    try {
      const stockDocs = await db.collection("stocks").get();
      const manualSellSignals: {name: string; code: string; percent: number; targetPrice: number; currentPrice: number; quantity: number; gap: number; docId: string}[] = [];

      stockDocs.forEach((doc) => {
        const s = doc.data();
        if (!s.name || !s.sellPlans || !s.currentPrice || s.currentPrice <= 0) return;
        if ((s.totalQuantity || 0) <= 0) return;

        // 다음 미체결 매도 계획
        const nextSell = (s.sellPlans || []).find((sp: any) => !sp.filled);
        if (!nextSell || !nextSell.price) return;

        // 25% 이상 차수만 수동 매도 대상 (키움 자동매매는 20%까지)
        if ((nextSell.percent || 0) < 25) return;

        // 현재가가 목표가 도달 (현재가 >= 매도가)
        if (s.currentPrice >= nextSell.price) {
          const gap = ((s.currentPrice - nextSell.price) / nextSell.price) * 100;
          // dedup 키: percent(수익률) + targetPrice(목표가) 조합
          // → 같은 목표가에서 재발송 방지
          // → 추가매수로 avgPrice 바뀌어 목표가가 달라지면 새로 발송
          const alreadySent = s.sellSignalSent === true &&
            s.sellSignalPercent === nextSell.percent &&
            s.sellSignalPrice === nextSell.price;
          if (!alreadySent) {
            manualSellSignals.push({
              name: s.name,
              code: s.code || "",
              percent: nextSell.percent,
              targetPrice: nextSell.price,
              currentPrice: s.currentPrice,
              quantity: nextSell.quantity || 0,
              gap,
              docId: doc.id,
            });
          }
        } else {
          // ✅ 매도 신호는 한 번 발송 후 리셋 안 함 (가격 내려갔다 올라와도 재발송 없음)
          // 단, 추가매수로 목표가(sellSignalPrice)가 바뀌면 위 조건에서 alreadySent=false → 재발송됨
        }
      });

      if (manualSellSignals.length > 0) {
        const kst2 = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
        const y2 = kst2.getFullYear();
        const m2 = String(kst2.getMonth() + 1).padStart(2, "0");
        const d2 = String(kst2.getDate()).padStart(2, "0");
        const hh2 = kst2.getHours();
        const mm2 = String(kst2.getMinutes()).padStart(2, "0");

        let msg = `<b>💰 수동 매도 신호! (25%+ 키움 자동매매 미설정 차수)</b>\n`;
        msg += `<i>${y2}-${m2}-${d2} ${hh2}:${mm2}</i>\n\n`;
        for (const s of manualSellSignals) {
          msg += `<b>📌 ${s.name}</b>${s.code ? ` (${s.code})` : ""}\n`;
          msg += `  +${s.percent}% 매도 목표가 도달\n`;
          msg += `  목표가: ${s.targetPrice.toLocaleString()}원\n`;
          msg += `  현재가: ${s.currentPrice.toLocaleString()}원 (+${s.gap.toFixed(1)}%)\n`;
          if (s.quantity > 0) msg += `  수량: ${s.quantity.toLocaleString()}주\n`;
          msg += `\n`;
        }
        msg += `⚠️ <b>HTS에서 수동 매도 주문 필요</b>`;
        await sendTelegram(msg);

        // 알림 발송 완료 기록 (percent + price 조합으로 dedup)
        for (const s of manualSellSignals) {
          await db.collection("stocks").doc(s.docId).update({
            sellSignalSent: true,
            sellSignalPercent: s.percent,   // 수익률 단계
            sellSignalPrice: s.targetPrice, // 목표가 (추가매수 후 바뀌면 재발송)
            sellSignalAt: Date.now(),
          });
        }
        console.log(`[수동매도] 알림 발송: ${manualSellSignals.length}종목`);
      } else {
        console.log("[수동매도] 25%+ 도달 종목 없음");
      }
    } catch (err: any) {
      console.error("[수동매도] 오류:", err.message);
    }

    // ─── 관심종목 감시 ───
    try {
      const config = await getKiwoomConfig();
      const token = await getAccessToken(config);
      const watchDocs = await db.collection("watchlist").get();
      if (watchDocs.empty) {
        console.log("[관심종목] 감시 종목 없음");
        return "완료";
      }

      const watchItems: {id: string; name: string; code: string; peakPrice: number; targetPercent: number; prevAlertLevel: number}[] = [];
      watchDocs.forEach((d) => {
        const data = d.data();
        if (data.status !== "bought") {
          watchItems.push({
            id: d.id,
            name: data.name || "",
            code: data.code || "",
            peakPrice: data.peakPrice || 0,
            targetPercent: data.targetPercent || -50,
            prevAlertLevel: data.alertLevel || 0,
          });
        }
      });

      if (watchItems.length === 0) {
        console.log("[관심종목] 활성 감시 종목 없음");
        return "완료";
      }

      console.log(`[관심종목] ${watchItems.length}종목 체크`);

      // 현재가 + 시가 조회
      const watchCodes = watchItems.map((w) => w.code).filter(Boolean);
      const watchPrices = await fetchOpenPrices(config, token, watchCodes);

      // ka10081에서 현재가도 추출 (cur_prc 필드)
      const watchCurrentPrices: Record<string, number> = {};
      for (const code of watchCodes) {
        try {
          const res = await fetch(`${config.baseUrl}/api/dostk/chart`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "ka10081",
            },
            body: JSON.stringify({
              stk_cd: code,
              base_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
              upd_stkpc_tp: "0",
              qry_tp: "0",
            }),
          });
          const data = await res.json() as any;
          const chart = data.stk_dt_pole_chart_qry || data.stk_dt_pole_chart || [];
          if (chart.length > 0) {
            watchCurrentPrices[code] = parseInt(chart[0].cur_prc || "0");
          }
          await new Promise((r) => setTimeout(r, 200));
        } catch (err) {
          // fetchOpenPrices already got this data
        }
      }

      const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
      const y = kst.getFullYear();
      const mo = String(kst.getMonth() + 1).padStart(2, "0");
      const dd = String(kst.getDate()).padStart(2, "0");
      const hh = kst.getHours();
      const mm = String(kst.getMinutes()).padStart(2, "0");

      const alerts: string[] = [];

      for (const w of watchItems) {
        const curPrice = watchCurrentPrices[w.code] || 0;
        const openPrice = watchPrices[w.code] || 0;
        if (curPrice <= 0 || w.peakPrice <= 0) continue;

        const dropPercent = ((curPrice - w.peakPrice) / w.peakPrice) * 100;
        const isYangbong = openPrice > 0 && curPrice > openPrice;

        let alertLevel: 0 | 1 | 2 | 3 = 0;
        let status = "watching";

        if (dropPercent <= -50 && isYangbong) {
          alertLevel = 3;
          status = "ready";
        } else if (dropPercent <= -45) {
          alertLevel = 2;
          status = "approaching";
        } else if (dropPercent <= -40) {
          alertLevel = 1;
          status = "approaching";
        }

        // Firestore 업데이트
        await db.collection("watchlist").doc(w.id).update({
          currentPrice: curPrice,
          openPrice: openPrice,
          status,
          alertLevel,
          updatedAt: Date.now(),
        });

        // alertLevel이 상승했거나 3(매수준비)인 경우 알림
        if (alertLevel > w.prevAlertLevel || alertLevel === 3) {
          // 🔴 alertLevel=3(양봉 1차 매수신호)은 종가 윈도우(15:10~15:40)에만 발송.
          //    ⚠️👀 alertLevel 1·2(매수 임박/눈여겨볼것 = 가격 근접)는 NXT 시간 포함 항상.
          //    (watchlist 상태/alertLevel은 위에서 이미 갱신됨 — 텔레그램만 게이트)
          if (alertLevel === 3 && !isCloseWindow) continue;
          const emoji = alertLevel === 3 ? "🔴" : alertLevel === 2 ? "⚠️" : "👀";
          const label = alertLevel === 3 ? "1차 매수신호!" : alertLevel === 2 ? "매수 임박" : "눈여겨볼것";
          const targetPrice = Math.round(w.peakPrice * (1 + w.targetPercent / 100));
          let line = `${emoji} <b>${w.name}</b> - ${label}\n`;
          line += `  고점: ${w.peakPrice.toLocaleString()}원 → 목표: ${targetPrice.toLocaleString()}원\n`;
          line += `  현재: ${curPrice.toLocaleString()}원 (${dropPercent.toFixed(1)}%)`;
          if (alertLevel === 3) {
            line += `\n  시가: ${openPrice.toLocaleString()}원 → 양봉 확인!`;
          }
          alerts.push(line);
          console.log(`[관심종목] ${w.name}: ${label} (${dropPercent.toFixed(1)}%)`);
        }
      }

      if (alerts.length > 0) {
        let msg = `<b>👀 관심종목 알림</b>\n`;
        msg += `<i>${y}-${mo}-${dd} ${hh}:${mm}</i>\n\n`;
        msg += alerts.join("\n\n");
        await sendTelegram(msg);
        console.log(`[관심종목] 텔레그램 전송: ${alerts.length}건`);
      } else {
        console.log("[관심종목] 알림 대상 없음");
      }
    } catch (err: any) {
      console.error("[관심종목] 오류:", err.message);
    }

    return "완료";
}

/**
 * 매수신호 체크 + 텔레그램 알림 — 옵션 A 다중 스케줄 (NXT 08:00 ~ 20:00)
 *   버킷(매수신호/신호지난/매수대기/보유중)을 주기적으로 갱신.
 *   텔레그램은 첫 양봉 1회만(dedup) → 자주 돌려도 스팸 없음.
 *
 *   프리마켓 08:00~08:30  : 30분 (근접 감시)        — buySignalCheckPre
 *   정규장   09:00~14:50  : 10분 (양봉 변동 핵심)   — buySignalCheck
 *   마감임박 15:00~15:40  : 5분  (매수 결정 구간)   — buySignalCheckClose
 *   애프터   16:00~20:00  : 30분 (근접/이탈 감시)   — buySignalCheckAfter
 */
const BUY_SIGNAL_RUNWITH = {
  vpcConnector: "kiwoom-connector",
  vpcConnectorEgressSettings: "ALL_TRAFFIC" as const,
  timeoutSeconds: 120,
};

// 정규장 09:00~14:50 (10분)
export const buySignalCheck = functions
  .region("asia-northeast3")
  .runWith(BUY_SIGNAL_RUNWITH)
  .pubsub.schedule("*/10 9-14 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    await runBuySignalCheck();
  });

// 프리마켓 08:00, 08:30 (30분)
export const buySignalCheckPre = functions
  .region("asia-northeast3")
  .runWith(BUY_SIGNAL_RUNWITH)
  .pubsub.schedule("0,30 8 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    await runBuySignalCheck();
  });

// 마감 임박 15:00~15:40 (5분) — 매수 결정 구간
export const buySignalCheckClose = functions
  .region("asia-northeast3")
  .runWith(BUY_SIGNAL_RUNWITH)
  .pubsub.schedule("0,5,10,15,20,25,30,35,40 15 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    await runBuySignalCheck();
  });

// 애프터마켓 16:00~20:00 (30분) — NXT 애프터 가격 변동 근접/이탈 감시
export const buySignalCheckAfter = functions
  .region("asia-northeast3")
  .runWith(BUY_SIGNAL_RUNWITH)
  .pubsub.schedule("0,30 16-20 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    await runBuySignalCheck();
  });

/**
 * ─── 룰B 일봉 추적기 (Phase 3 + 4) ───
 * 평일 15:35 KST 실행 (장 마감 직후)
 * 대상: rule='B' 종목 전체
 * 동작:
 *   1) referencePeakDate 이후 일봉 fetch
 *   2) 일봉 low의 최저값 → bottomPrice 갱신 (datapoint 보존)
 *   3) ruleBActive=true && 오늘 일봉 close < trigger(bottomPrice×0.9) && 양봉(close>open)
 *      → 매수 신호 발송 + 텔레그램 알림
 *   4) ruleBSignalSent=true 종목은 중복 발송 차단
 */
async function runRuleBTracker(codeFilter?: string): Promise<{checked: number; bottomUpdated: number; signaled: number; errors: number}> {
  const result = {checked: 0, bottomUpdated: 0, signaled: 0, errors: 0};
  const config = await getKiwoomConfig();
  const token = await getAccessToken(config);
  if (!token) {
    console.log("[ruleB] 토큰 획득 실패");
    return result;
  }

  // 저점 계산 대상: 종목룰='B' OR 차수에 룰B 존재 OR 기준최고가 입력됨.
  //   (STX처럼 종목룰='A'이지만 특정 차수만 룰B인 경우도 저점 필요)
  const allStocksSnap = await db.collection("stocks").get();
  const targetDocs = allStocksSnap.docs.filter((d) => {
    const s = d.data() as any;
    if (!s.code) return false;
    const hasRuleBStage = Array.isArray(s.buyPlans) && s.buyPlans.some((b: any) => b?.rule === "B");
    return s.rule === "B" || hasRuleBStage || (Number(s.referencePeakPrice) || 0) > 0;
  });
  // 단일 종목 즉시 계산용 코드 필터 (시작점 입력 직후 호출)
  const codeClean = codeFilter ? codeFilter.replace(/^A/, "").trim() : "";
  console.log(`[ruleB] 대상 종목 ${targetDocs.length}개${codeClean ? ` (code 필터: ${codeClean})` : ""}`);

  for (const stockDoc of targetDocs) {
    const stockData = stockDoc.data() as any;
    if (codeClean && String(stockData.code || "").replace(/^A/, "") !== codeClean) continue;
    if (!stockData.code) continue;
    result.checked++;

    try {
      // 시작점: referencePeakDate (없으면 createdAt 기준 또는 60일 전)
      let fromYMD: string;
      if (stockData.referencePeakDate) {
        fromYMD = stockData.referencePeakDate.replace(/-/g, "");
      } else {
        const ts = Number(stockData.createdAt) || Date.now();
        const d = new Date(ts);
        fromYMD = d.toISOString().slice(0, 10).replace(/-/g, "");
      }

      // 통합(KRX+NXT, _AL) 일봉 사용 — 사용자 통합차트/스크리너와 동일 기준.
      //   KRX 단독은 NXT의 더 낮은 저가를 놓쳐 저점이 높게 잡힘
      //   (나이벡 4/6: KRX low 24,600 vs 통합 low 23,300).
      let candles = await fetchDailyChart(config, token, `${stockData.code}_AL`, fromYMD);
      if (!candles.length) {
        // _AL 미지원/빈 응답 시 KRX 단독으로 폴백
        candles = await fetchDailyChart(config, token, stockData.code, fromYMD);
      }
      if (!candles.length) {
        console.log(`[ruleB] ${stockData.name} 일봉 데이터 없음 (from ${fromYMD})`);
        continue;
      }

      // ─── 저점 구간 freeze (마지막 매도일) ───
      // 룰B 저점 = [기준 최고가(referencePeakDate)] ~ [마지막 매도일] 구간의 최저가.
      // 매도 3회(룰B 활성 조건) 이상이면, 구간 끝은 "3차 이후 마지막 매도 차수의 날짜".
      //   예) 나이벡: 4/15(+5/+10/+15), 4/23(MA20) → freeze = 4/23 (마지막 매도)
      // 매도 3회 미달이면 freeze 없이 계속 추적 (룰B 활성 전).
      const sellDatesRaw: string[] = [];
      for (const sp of (stockData.sellPlans || [])) {
        if (sp?.filled && sp.filledDate) sellDatesRaw.push(String(sp.filledDate));
      }
      for (const ms of (stockData.maSells || [])) {
        if (ms?.filled && ms.filledDate) sellDatesRaw.push(String(ms.filledDate));
      }
      // YYYY-MM-DD / YYYYMMDD 모두 YYYYMMDD 로 정규화 후 오름차순
      const sellYmds = sellDatesRaw
        .map((d) => d.replace(/-/g, ""))
        .filter((d) => d.length === 8)
        .sort();
      // freeze 기준일 = 매도 3회 이상일 때 "마지막(가장 늦은) 매도일"
      const freezeYMD = sellYmds.length >= 3 ? sellYmds[sellYmds.length - 1] : null;

      // 일봉 low 중 최저값 (freeze 적용 시 freezeYMD 이하 구간만)
      let lowestLow = Infinity;
      let lowestDate = "";
      for (const c of candles) {
        if (c.low <= 0) continue;
        if (freezeYMD && c.date.replace(/-/g, "") > freezeYMD) continue; // 마지막 매도 이후 제외
        if (c.low < lowestLow) {
          lowestLow = c.low;
          lowestDate = c.date;
        }
      }
      if (freezeYMD) {
        console.log(`[ruleB] ${stockData.name} 저점구간 freeze: ~${freezeYMD} (마지막 매도일)`);
      }

      const update: Record<string, any> = {};
      const currentBottom = Number(stockData.bottomPrice) || 0;
      // bottomPrice 갱신:
      //   freeze 구간(3차 매도 확정): 구간 내 최저가로 권위있게 SET (값이 달라지면 보정)
      //     → 과거 freeze 미적용 시절 잘못 내려간 저점도 올바른 값으로 교정됨
      //   freeze 전(추적중): 더 낮은 값이거나 처음일 때만 갱신
      const shouldUpdate = lowestLow !== Infinity && (
        freezeYMD
          ? lowestLow !== currentBottom
          : (currentBottom === 0 || lowestLow < currentBottom)
      );
      if (shouldUpdate) {
        update.bottomPrice = lowestLow;
        update.bottomPriceDate = lowestDate;
        update.bottomPriceSource = freezeYMD ? "daily_low_frozen" : "daily_low";
        result.bottomUpdated++;
        console.log(
          `[ruleB] ${stockData.name} bottomPrice ${freezeYMD ? "확정" : "갱신"}: ${currentBottom} → ${lowestLow} (${lowestDate})`
        );
      }

      // 양봉 매수 신호: ruleBActive=true && 오늘 일봉 close < trigger && 양봉 && 미발송
      const ruleBActive = stockData.ruleBActive === true;
      const alreadySignaled = stockData.ruleBSignalSent === true;
      const effectiveBottom = update.bottomPrice || currentBottom;
      if (ruleBActive && !alreadySignaled && effectiveBottom > 0) {
        // 가장 최근 봉 (역순 응답 가정, 명시적 정렬)
        const sorted = [...candles].sort((a, b) => b.date.localeCompare(a.date));
        const today = sorted[0];
        const trigger = Math.round(effectiveBottom * 0.9);
        if (today && today.close > 0 && today.open > 0 &&
            today.close < trigger && today.close > today.open) {
          update.ruleBSignalSent = true;
          update.ruleBSignalDate = today.date;
          result.signaled++;
          console.log(
            `[ruleB] 🟢 ${stockData.name} 매수신호: 종가 ${today.close} < 트리거 ${trigger}, 양봉 (시가 ${today.open})`
          );
          try {
            await sendTelegram(
              `🟢 룰B 매수신호 — ${stockData.name}\n` +
              `트리거 ${trigger.toLocaleString()}원 미만 양봉 마감\n` +
              `종가 ${today.close.toLocaleString()}원 / 시가 ${today.open.toLocaleString()}원\n` +
              `저점 ${effectiveBottom.toLocaleString()}원 (${update.bottomPriceDate || stockData.bottomPriceDate || "-"})`
            );
          } catch (e: any) {
            console.warn(`[ruleB] 텔레그램 발송 실패: ${e.message}`);
          }
        }
      }

      if (Object.keys(update).length > 0) {
        update.updatedAt = Date.now();
        await stockDoc.ref.update(update);
      }

      // API rate limit 보호
      await new Promise((r) => setTimeout(r, 300));
    } catch (err: any) {
      result.errors++;
      console.error(`[ruleB] ${stockData.name} 오류: ${err.message}`);
    }
  }

  console.log(
    `[ruleB] 완료: 점검 ${result.checked} / 저점갱신 ${result.bottomUpdated} / ` +
    `신호 ${result.signaled} / 오류 ${result.errors}`
  );
  return result;
}

/**
 * 룰B 일봉 추적 cron (평일 15:35 KST)
 */
export const ruleBTracker = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 540})
  .pubsub.schedule("35 15 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    await runRuleBTracker();
  });

/**
 * 룰B 일봉 추적 수동 테스트 (HTTP)
 * POST/GET /ruleBTrackerNow[?code=000250]
 *   code 지정 시 해당 종목만 즉시 저점 재계산 (시작점 입력 직후 호출)
 */
export const ruleBTrackerNow = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 540})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const code = (req.query.code as string) || "";
        const result = await runRuleBTracker(code || undefined);
        res.json({success: true, ...result});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

/**
 * 매수신호 수동 테스트 (HTTP)
 * POST /buySignalTest
 */
export const buySignalTest = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const result = await runBuySignalCheck();
        res.json({success: true, result});
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 관심종목 현재가 수동 업데이트
 * POST /watchlistRefresh
 */
export const watchlistRefresh = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        const updated = await updateWatchlistPrices(config, token);
        res.json({success: true, updated});
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 종목 리스트를 Firestore에 캐시
 * POST /stockListUpdate
 * 키움 API 또는 KRX에서 종목 목록을 받아 캐시
 */
export const stockListUpdate = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120, memory: "512MB"})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        let totalCount = 0;

        // 키움 API로 종목 마스터 조회 시도
        try {
          const config = await getKiwoomConfig();
          const token = await getAccessToken(config);

          // ka10099: 주식종목정보 (KOSPI + KOSDAQ)
          // URI: /api/dostk/stkinfo, body: {mrkt_tp: "0"=KOSPI, "10"=KOSDAQ}
          // 응답: { list: [{code, name, marketCode, marketName, state, ...}] }
          for (const marketCode of ["0", "10"]) {
            const apiRes = await fetch(`${config.baseUrl}/api/dostk/stkinfo`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "authorization": `Bearer ${token}`,
                "api-id": "ka10099",
              },
              body: JSON.stringify({mrkt_tp: marketCode}),
            });
            const data = await apiRes.json() as any;
            const items: any[] = Array.isArray(data.list) ? data.list : [];
            console.log(`[종목리스트] ka10099 mrkt_tp=${marketCode}: ${items.length}개 수신`);

            const marketName = marketCode === "0" ? "KOSPI" : "KOSDAQ";
            // Firestore 배치 저장 (400개씩)
            for (let i = 0; i < items.length; i += 400) {
              const batch = db.batch();
              for (const item of items.slice(i, i + 400)) {
                const code = item.code || item.stk_cd || "";
                const name = item.name || item.stk_nm || "";
                if (code && /^\d{6}$/.test(code) && name) {
                  // kind="A"는 일반종목, 다른 값은 ETF/ETN 등 (S/S2 필터에서 활용)
                  // state에 "투자유의" 등 포함되어도 일단 저장 (필터링은 별도)
                  batch.set(db.collection("stockCodes").doc(`stock_${code}`), {
                    name: name.trim(),
                    code,
                    market: marketName,
                    state: item.state || "",
                    upSizeName: item.upSizeName || "",
                    kind: item.kind || "",
                  });
                  totalCount++;
                }
              }
              await batch.commit();
            }
            await new Promise((r) => setTimeout(r, 300));
          }
        } catch (e: any) {
          console.log(`[종목리스트] 키움 API 실패: ${e.message}`);
        }

        // 키움 실패 시 KRX 시도
        if (totalCount === 0) {
          try {
            for (const market of [{name: "KOSPI", code: "STK"}, {name: "KOSDAQ", code: "KSQ"}]) {
              const krxRes = await fetch(
                "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType=" + market.code,
                {timeout: 15000, headers: {"User-Agent": "Mozilla/5.0"}},
              );
              const html = await krxRes.text();
              console.log(`[종목리스트] KRX ${market.name}: ${html.length}bytes`);

              const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
              for (const row of rows) {
                const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
                if (cells.length >= 2) {
                  const name = (cells[0] || "").replace(/<[^>]*>/g, "").trim();
                  const code = (cells[1] || "").replace(/<[^>]*>/g, "").trim();
                  if (name && /^\d{6}$/.test(code)) {
                    await db.collection("stockCodes").doc(`stock_${code}`).set({
                      name, code, market: market.name,
                    });
                    totalCount++;
                  }
                }
              }
            }
          } catch (e: any) {
            console.log(`[종목리스트] KRX 실패: ${e.message}`);
          }
        }

        await db.collection("settings").doc("stockListCache").set({
          updatedAt: Date.now(), count: totalCount,
        });

        console.log(`[종목리스트] ${totalCount}개 종목 저장 완료`);
        res.json({success: true, count: totalCount});
      } catch (error: any) {
        console.error("[종목리스트] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 종목코드 검색 (Firestore 캐시에서 검색)
 * GET /stockSearch?q=삼성
 */
export const stockSearch = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 10})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const query = (req.query.q as string || "").trim();
        if (!query) {
          res.json({results: []});
          return;
        }

        // Firestore에서 검색 (전체 스캔 후 필터링)
        const snapshot = await db.collection("stockCodes").get();
        const results: {name: string; code: string; market: string}[] = [];
        const queryLower = query.toLowerCase();

        snapshot.forEach((doc) => {
          const data = doc.data();
          if (
            (data.name || "").toLowerCase().includes(queryLower) ||
            (data.code || "").includes(query)
          ) {
            results.push({
              name: data.name,
              code: data.code,
              market: data.market || "",
            });
          }
        });

        // 이름이 정확히 일치하는 것을 먼저 보여주고, 포함하는 것은 뒤에
        results.sort((a, b) => {
          const aExact = a.name.toLowerCase() === queryLower ? 0 : 1;
          const bExact = b.name.toLowerCase() === queryLower ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          const aStart = a.name.toLowerCase().startsWith(queryLower) ? 0 : 1;
          const bStart = b.name.toLowerCase().startsWith(queryLower) ? 0 : 1;
          return aStart - bStart;
        });

        res.json({results: results.slice(0, 15)});
      } catch (error: any) {
        console.error("종목검색 오류:", error.message);
        res.json({results: []});
      }
    });
  });

// ═══════════════════════════════════════════════════════════════
// buyPlans / sellPlans 자동 체결 반영 (C안 + 백필)
// ─────────────────────────────────────────────────────────────
// 목적: trade_kiwoom_* 문서 생성 시 해당 종목의 buyPlans/sellPlans
//       차수 filled 플래그를 자동 갱신. 계획가/계획수량은 보존.
// 설계: 매수=날짜 그룹 기반, 매도=개별 체결 순차 매핑
//       - 매수: 같은 날 여러 번 체결 = 같은 차수
//       - 매도: 개별 체결 건을 순차적으로 슬롯에 배정 (분할 매도 정확 반영)
//       - manualOverride=true 슬롯은 덮어쓰지 않음
//       - 계획 차수 초과 시 로그만 남기고 무시 (수동 확인 유도)
// ═══════════════════════════════════════════════════════════════

/**
 * 종목의 trades를 날짜 그룹핑해서 buyPlans/sellPlans의 filled 플래그와
 * filledPrice/filledQuantity/filledDate를 갱신한다.
 * - 기존 계획의 price/quantity (계획가/계획수량) 는 절대 건드리지 않음
 * - 사용자가 수동 토글한 플래그도 병합 (trades가 있으면 filled=true로 덮어씀,
 *   trades가 없는 차수는 기존 상태 보존)
 */
// ─── 단일 진실 (방안B Phase 4): 태그 기반 매도 슬롯 파생 ───
// 매도 매핑의 유일한 진실 = trade 태그(sellRound/sellSlot).
// sellPlans/maSells는 "태그된 trades의 집계 뷰"로만 생성 — 직접 수정 금지.
// 작성자 단일화: 이 함수만 슬롯을 만들고, reconcile만 이 함수를 호출.
// (sync는 TAG_MODE에서 sellPlans를 쓰지 않음 — onTradeCreated → reconcile이 갱신)

async function getTagModeEnabled(): Promise<boolean> {
  try {
    const doc = await db.collection("settings").doc("featureFlags").get();
    const v = (doc.data() as any || {}).tradeTagBasedMapping;
    return v !== false; // 기본 ON (명시적으로 false일 때만 레거시)
  } catch {
    return true;
  }
}

// 매도 fallback↔ord_no 안전 dedup.
//   키움 ka10072가 같은 매도를 통합(ord_no 있음)과 부분체결(ord_no 없음 → sell_…
//   fallback id) 두 형식으로 반환해 중복 저장되는 케이스 제거.
//   ⚠️ 안전 조건(둘 다 충족할 때만 제거):
//     1) fallback 수량 합 == ord_no 매도 중 하나의 수량 (= 통합/부분 동일 매도 증거)
//     2) fallback 전부 미분류(sellSlot 없음/unmapped) — 사용자 수동분류 보존
//   → 분류된 fallback(하림지주 MA20)·수량 불일치(현대약품 80≠88)는 건드리지 않음.
function dedupSellFallback(trades: any[]): string[] {
  const sells = trades.filter((t) => t.type === "sell" && (Number(t.quantity) || 0) > 0);
  const groups: Record<string, {ordno: any[]; fallback: any[]}> = {};
  for (const t of sells) {
    const id = String(t.id || "");
    const key = `${t.date}|${Number(t.price) || 0}`;
    if (!groups[key]) groups[key] = {ordno: [], fallback: []};
    if (/^trade_kiwoom_sell_/.test(id)) groups[key].fallback.push(t);
    else if (/^trade_kiwoom_\d/.test(id)) groups[key].ordno.push(t);
    // 구포맷/manual 등은 dedup 대상 제외 (보수적)
  }
  const del: string[] = [];
  for (const g of Object.values(groups)) {
    if (g.ordno.length === 0 || g.fallback.length === 0) continue;
    const fbSum = g.fallback.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
    const matchOrd = g.ordno.some((x) => (Number(x.quantity) || 0) === fbSum);
    const fbAllUnmapped = g.fallback.every((x) => !x.sellSlot || x.sellSlot === "unmapped");
    if (matchOrd && fbAllUnmapped) {
      for (const f of g.fallback) del.push(String(f.id));
    }
  }
  return del;
}

// 매도 fallback↔ord_no 안전 dedup V2 (가격 미세차 + 기존 태깅 중복까지).
//   V1 한계: (date,price) 정확 매칭이라 ord_no 통합(8099)과 부분체결 fallback(8100)이
//   1~10원만 달라도 못 잡음. 또 fbAllUnmapped 조건 때문에 이전 reconcile에서 자동태깅돼
//   저장된 중복 fallback도 영영 못 지움(네이블 6/16 잔고0 케이스).
//   V2: 날짜별로 ord_no(정본) 단가에 근접한 미잠금 fallback 묶음을 찾아, 합이 ord 수량과
//   정확히 같으면 그 fallback들을 같은 매도의 중복으로 보고 제거.
//   ⚠️ 안전 조건:
//     1) ord_no 존재(키움 정본) — 정본이 있어야 fallback을 지워도 매도 사실 유지.
//     2) 근접 fallback 합 == ord 수량 (= 동일 매도의 부분체결 묶음 증거).
//     3) slotLocked(사용자 확정 분류)는 보존 — 자동태깅(non-locked)만 제거(ord_no가 재태깅).
//   tol = max(15원, ord단가×0.2%) — 부분체결 단가 미세차만 허용, 별개 매도(큰 차)는 제외.
function dedupSellFallbackV2(trades: any[]): string[] {
  const isFb = (t: any) => /^trade_kiwoom_sell_/.test(String(t.id || ""));
  const isOrd = (t: any) => /^trade_kiwoom_\d/.test(String(t.id || ""));
  const sells = trades.filter((t) => t.type === "sell" && (Number(t.quantity) || 0) > 0);
  const byDate: Record<string, {ord: any[]; fb: any[]}> = {};
  for (const t of sells) {
    const d = String(t.date || "");
    if (!byDate[d]) byDate[d] = {ord: [], fb: []};
    if (isFb(t)) byDate[d].fb.push(t);
    else if (isOrd(t)) byDate[d].ord.push(t);
  }
  const del: string[] = [];
  for (const g of Object.values(byDate)) {
    if (g.ord.length === 0 || g.fb.length === 0) continue;
    // slotLocked(사용자 확정)은 후보에서 제외 — 분류 보존
    let pool = g.fb.filter((f) => !f.slotLocked);
    // 단가 낮은 ord부터 매칭(밴드 겹침 시 결정적 순서)
    const ords = [...g.ord].sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
    for (const o of ords) {
      const op = Number(o.price) || 0;
      const oq = Number(o.quantity) || 0;
      if (oq <= 0 || pool.length === 0) continue;
      const tol = Math.max(15, Math.round(op * 0.002));
      const near = pool.filter((f) => Math.abs((Number(f.price) || 0) - op) <= tol);
      const nearSum = near.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
      if (near.length > 0 && nearSum === oq) {
        const nearIds = new Set(near.map((f) => String(f.id)));
        for (const id of nearIds) del.push(id);
        pool = pool.filter((f) => !nearIds.has(String(f.id)));
      }
    }
  }
  return del;
}

function deriveSellSlotsFromTags(
  stock: any,
  trades: any[]
): {sellPlans: any[]; maSells: any[]} {
  const normD = (d: string): string => {
    if (!d) return "";
    if (d.length === 8 && !d.includes("-")) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return d;
  };
  const buys = trades.filter((t: any) => t.type === "buy" && (Number(t.quantity) || 0) > 0);
  const buyDates = Array.from(new Set(buys.map((b: any) => normD(b.date)))).filter(Boolean).sort();
  const currentRound = Math.max(1, buyDates.length); // 마지막 매수 차수 = 현재 라운드
  const sells = trades.filter((t: any) => t.type === "sell");

  const avg = Number(stock.avgPrice) || 0;
  const holding = Number(stock.totalQuantity) || 0;
  const slotQty = holding > 0 ? Math.round(holding / 5) : 0;

  const existingSell: any[] = Array.isArray(stock.sellPlans) ? stock.sellPlans : [];
  // 슬롯별 집계 — 부분분배(sellSlotSplit) 우선, 없으면 단일 sellSlot.
  //   roundFilter: 현재 라운드만 볼지 (수익/MA 슬롯=true)
  const collectSlot = (slotLabel: string, roundFilter: boolean) => {
    let qty = 0; let amt = 0; let date = ""; const ids: string[] = [];
    for (const t of sells) {
      if (roundFilter && (Number(t.sellRound) || 0) !== currentRound) continue;
      const price = Number(t.price) || 0;
      let portion = 0;
      if (Array.isArray(t.sellSlotSplit) && t.sellSlotSplit.length > 0) {
        // 같은 슬롯에 여러 차수분(2차분 등)이 있으면 합산 (한 매도를 같은 +5%에 13주×2로 분리)
        portion = t.sellSlotSplit
          .filter((sp: any) => sp.slot === slotLabel)
          .reduce((a: number, sp: any) => a + (Number(sp.qty) || 0), 0);
      } else if (t.sellSlot === slotLabel) {
        portion = Number(t.quantity) || 0;
      }
      if (portion <= 0) continue;
      qty += portion;
      amt += price * portion;
      const d = normD(t.date);
      if (d > date) date = d;
      ids.push(String(t.id));
    }
    return {qty, avgPrice: qty > 0 ? Math.round(amt / qty) : 0, date, ids};
  };

  // 수익 슬롯(+5~+25%): 현재 라운드 태그만 (추가매수 시 라운드 리셋 — 태산 규칙)
  const sellPlans = [5, 10, 15, 20, 25].map((p, i) => {
    const a = collectSlot(`+${p}%`, true);
    const ex = existingSell[i];
    const target = avg > 0 ? Math.round(avg * (1 + p / 100)) : (Number(ex?.price) || 0);
    if (a.qty > 0) {
      return {
        percent: p, price: target, quantity: a.qty, filled: true,
        filledDate: a.date, filledQuantity: a.qty, filledPrice: a.avgPrice,
        consumedTradeIds: a.ids,
      };
    }
    // 태그 없음: trade 없는 수동 체결(수동 종목 등)은 보존, 아니면 미체결
    const exManualFill = ex && (ex.filled || (Number(ex.filledQuantity) || 0) > 0) &&
      !(Array.isArray(ex.consumedTradeIds) && ex.consumedTradeIds.length > 0);
    if (exManualFill) return ex;
    return {percent: p, price: target, quantity: slotQty, filled: false, filledDate: ""};
  });

  // MA 슬롯: 수익 슬롯과 동일하게 현재 라운드만 (다음 차수 매수 시 리셋).
  //   과거 라운드 MA 매도는 프론트 복기 뷰(roundView.maSlots)에 라운드별 표시.
  const existingMa: any[] = Array.isArray(stock.maSells) ? stock.maSells : [];
  const maSells = [20, 60, 120].map((ma) => {
    const ex = existingMa.find((m: any) => m.ma === ma) ||
      {ma, price: 0, quantity: 0, filled: false};
    const a = collectSlot(`MA${ma}`, true);
    if (a.qty > 0) {
      return {
        ...ex, filled: true, quantity: a.qty, price: a.avgPrice,
        filledDate: a.date, consumedTradeIds: a.ids,
      };
    }
    const exManualFill = ex.filled &&
      !(Array.isArray(ex.consumedTradeIds) && ex.consumedTradeIds.length > 0);
    if (exManualFill) return ex;
    return {...ex, filled: false, quantity: 0, filledDate: "", consumedTradeIds: []};
  });

  return {sellPlans, maSells};
}

async function reconcileStockPlans(stockName: string): Promise<{
  updated: boolean;
  buyFilled: number;
  sellFilled: number;
  exceedsBuy: number;
  exceedsSell: number;
}> {
  // 해당 종목 stocks 문서 찾기 (이름 기준)
  const stockSnap = await db
    .collection("stocks")
    .where("name", "==", stockName)
    .limit(1)
    .get();

  if (stockSnap.empty) {
    console.log(`[reconcile] 종목 없음: ${stockName}`);
    return {updated: false, buyFilled: 0, sellFilled: 0, exceedsBuy: 0, exceedsSell: 0};
  }

  const stockDoc = stockSnap.docs[0];
  const stock = stockDoc.data();
  const buyPlans: any[] = Array.isArray(stock.buyPlans) ? [...stock.buyPlans] : [];
  const sellPlans: any[] = Array.isArray(stock.sellPlans) ? [...stock.sellPlans] : [];

  // 해당 종목 trades 전체 조회
  const tradesSnap = await db
    .collection("trades")
    .where("stockName", "==", stockName)
    .get();

  if (tradesSnap.empty) {
    return {updated: false, buyFilled: 0, sellFilled: 0, exceedsBuy: 0, exceedsSell: 0};
  }

  let trades = tradesSnap.docs.map((d) => ({id: d.id, ...(d.data() as any)}));

  // ✅ 안전 자동 dedup (태깅 전): ka10072 통합/부분체결 중복 fallback 제거.
  //   V2: 날짜별 ord_no 단가근접 fallback 묶음(합==ord수량) 제거 + slotLocked만 보존.
  //   → 가격 미세차(8099↔8100)·기존 자동태깅 중복까지 처리(앱클론18→9, 네이블 잔고0 류).
  //   dry-run 검증: diagSellDedupV2 (33건 전부 진짜 중복, locked 보존 확인 2026-06-18).
  const _fbDelIds = dedupSellFallbackV2(trades);
  if (_fbDelIds.length > 0) {
    const delBatch = db.batch();
    for (const id of _fbDelIds) delBatch.delete(db.collection("trades").doc(id));
    await delBatch.commit();
    trades = trades.filter((t) => !_fbDelIds.includes(t.id));
    console.log(`[reconcile/dedup] ${stockName} fallback 중복 ${_fbDelIds.length}건 제거: ${_fbDelIds.join(", ")}`);
  }

  // 단일 진실 모드 (방안B Phase 4): 매도 슬롯 = 태그 집계 파생만
  const tagMode = await getTagModeEnabled();

  // ✅ 방안 B: 매도 trade 자동 태깅 (sellSlot 없는 신규 매도만)
  //   키움 동기화로 들어온 새 매도가 라운드+슬롯 태그 없이 미분류로 뜨는 것 방지.
  //   사용자 수동 분류한 trade(sellSlot 있음)는 보존.
  try {
    const buyTradesForTag = trades
      .filter((t: any) => t.type === "buy")
      .map((t: any) => ({date: t.date, price: t.price, quantity: t.quantity}));
    //   재태깅 대상: 슬롯 없음 OR 고아 split(sellSlot="split"인데 분배배열 없음/빈배열).
    //   고아 split = line 6042 수동분배 후 sellSlotSplit이 비워진 잔재 → 어느 슬롯에도
    //   집계 안 돼 잔여수량이 매도 미반영(STX 6/12 120주 → 잔여 343 오표시). slotLocked
    //   (사용자 확정)·unmapped(2단계 충돌 의도)·유효 split은 보존.
    const untaggedSells = trades
      .filter((t: any) => {
        if (t.type !== "sell") return false;
        if (t.slotLocked) return false; // 사용자 확정 분류 보존
        const hasValidSplit = Array.isArray(t.sellSlotSplit) && t.sellSlotSplit.length > 0;
        if (hasValidSplit) return false;
        return !t.sellSlot || t.sellSlot === "split"; // 미태깅 또는 고아 split
      })
      .map((t: any) => ({id: t.id, date: t.date, price: t.price, quantity: t.quantity}));
    if (untaggedSells.length > 0 && buyTradesForTag.length > 0) {
      const tags = computeSellTags(buyTradesForTag, untaggedSells);
      const tagBatch = db.batch();
      for (const tag of tags) {
        tagBatch.update(db.collection("trades").doc(tag.tradeId), {
          sellRound: tag.sellRound,
          sellSlot: tag.sellSlot,
          sellSlotSplit: admin.firestore.FieldValue.delete(), // 고아 split 잔재 제거
        });
      }
      await tagBatch.commit();
      // 인메모리 trades에도 즉시 반영 (아래 derive가 fresh 태그를 보도록)
      const tagById = new Map(tags.map((t) => [t.tradeId, t]));
      for (const t of trades) {
        const g = tagById.get(t.id);
        if (g) {
          (t as any).sellRound = g.sellRound;
          (t as any).sellSlot = g.sellSlot;
          delete (t as any).sellSlotSplit; // 고아 split 잔재 정리
        }
      }
      console.log(`[reconcile/태깅] ${stockName} 신규 매도 ${tags.length}건 자동 태깅`);
    }
  } catch (e: any) {
    console.warn(`[reconcile/태깅] ${stockName} 자동 태깅 실패: ${e.message}`);
  }

  // ✅ 2단계 분류 잠금: 같은 (라운드, 슬롯)에 서로 다른 "날짜" 매도가 2일 이상이면
  //   둘째 날부터 미분류(unmapped). 같은 날 같은 슬롯은 가격이 달라도 물량조절 매도로
  //   보고 합산 유지(대동금속 07-02 좁은구간 다가격 매도). 다른 날만 별개 라운드/매도로
  //   구분(앱클론 6/15·6/16 보호). 사용자 확정(slotLocked)은 충돌 시 우선 유지.
  //   (3대 정본 ③: 분류=사용자 확정 / 자동은 제안. docs ARCHITECTURE_SOURCE_OF_TRUTH 2단계)
  try {
    const effSlot = (t: any): string | null => {
      if (Array.isArray(t.sellSlotSplit) && t.sellSlotSplit.length === 1) return String(t.sellSlotSplit[0].slot || "");
      if (Array.isArray(t.sellSlotSplit) && t.sellSlotSplit.length > 1) return null; // 다중 split 보존
      const s = t.sellSlot;
      if (s && s !== "unmapped" && s !== "split") return String(s);
      return null;
    };
    const grp: Record<string, any[]> = {};
    for (const t of trades) {
      if (t.type !== "sell") continue;
      const slot = effSlot(t);
      if (!slot) continue;
      const key = `${Number(t.sellRound) || 0}|${slot}`;
      if (!grp[key]) grp[key] = [];
      grp[key].push(t);
    }
    const unmapIds: string[] = [];
    for (const arr of Object.values(grp)) {
      // ✅ 그룹에 사용자 확정(slotLocked)이 하나라도 있으면 = 사용자가 이 슬롯을 의도적으로
      //   구성(같은 슬롯 2차 매도 등) → 그룹 전체 보존. 합산은 collectSlot이 처리(누적 표시).
      const hasLocked = arr.some((t: any) => t.slotLocked);
      if (hasLocked) continue;
      // 순수 자동 그룹만 안전장치: 첫 "날짜"만 유지(같은날 다가격=물량조절 합산),
      //   다른 날짜 매도는 미분류(별개 라운드/매도 구분).
      arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const firstDate = String(arr[0].date);
      for (const t of arr) {
        if (String(t.date) !== firstDate) unmapIds.push(String(t.id));
      }
    }
    if (unmapIds.length > 0) {
      const cb = db.batch();
      for (const id of unmapIds) {
        cb.update(db.collection("trades").doc(id), {
          sellSlot: "unmapped",
          sellSlotSplit: admin.firestore.FieldValue.delete(),
        });
      }
      await cb.commit();
      const us = new Set(unmapIds);
      for (const t of trades) {
        if (us.has(String((t as any).id))) {
          (t as any).sellSlot = "unmapped";
          delete (t as any).sellSlotSplit;
        }
      }
      console.log(`[reconcile/충돌] ${stockName} 슬롯 충돌 ${unmapIds.length}건 미분류 처리`);
    }
  } catch (e: any) {
    console.warn(`[reconcile/충돌] ${stockName} 충돌 해소 실패: ${e.message}`);
  }

  // 매수: 날짜 그룹핑 (같은 날 매수 = 같은 차수)
  const buyByDate: Record<string, {qty: number; amt: number}> = {};

  for (const t of trades) {
    if (!t.date) continue;
    const price = Number(t.price) || 0;
    const qty = Number(t.quantity) || 0;
    if (qty <= 0) continue;

    if (t.type === "buy") {
      if (!buyByDate[t.date]) buyByDate[t.date] = {qty: 0, amt: 0};
      buyByDate[t.date].qty += qty;
      buyByDate[t.date].amt += price * qty;
    }
  }

  // 매도: 개별 체결 정렬 (날짜↑, 같은 날짜는 가격↑) → 각 체결을 순차 슬롯에 배정
  const sortedSells = trades
    .filter((t) => t.type === "sell" && t.date && Number(t.quantity) > 0)
    .sort((a, b) => {
      const dc = (a.date || "").localeCompare(b.date || "");
      if (dc !== 0) return dc;
      return (Number(a.price) || 0) - (Number(b.price) || 0); // 같은 날: 가격 오름차순
    });

  const buyDates = Object.keys(buyByDate).sort();

  // ─── 차수별 룰 판정 (mapTradesToPlans와 동일 규칙) ───
  // N차 rule = (N-1차 매수 직후 ~ N차 매수 직전) 매도 회수 >= 3 ? 'B' : 'A'
  const normDForRule = (d: string): string => {
    if (!d) return "";
    if (d.length === 8 && !d.includes("-")) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return d;
  };
  const countSellRoundsBetween = (start: string, end: string): number => {
    const groups = new Set<string>();
    for (const t of sortedSells) {
      const sd = normDForRule(t.date || "");
      if (!sd || sd <= start) continue;
      if (end && sd >= end) continue;
      groups.add(`${sd}_${Number(t.price) || 0}`);
    }
    return groups.size;
  };
  const stageRuleFor = (level: number): "A" | "B" => {
    if (level <= 1) return "A";
    // ✅ 사용자가 매매규칙을 룰B로 수동 전환 + 저점 설정 시: 미체결 차수(buyDates에 없음)는
    //   룰B 우선 적용. 체결된 과거 차수는 그 시점 사실대로 자동판정 유지.
    if (!buyDates[level - 1] && (stock as any).rule === "B" && (Number((stock as any).bottomPrice) || 0) > 0) return "B";
    const prevBuyDate = normDForRule(buyDates[level - 2] || "");
    if (!prevBuyDate) return "A";
    const thisBuyDate = normDForRule(buyDates[level - 1] || ""); // 미체결이면 "" (지금까지)
    return countSellRoundsBetween(prevBuyDate, thisBuyDate) >= 3 ? "B" : "A";
  };

  let buyFilledCount = 0;
  let sellFilledCount = 0;
  let exceedsBuy = 0;
  let exceedsSell = 0;

  // 매수 차수 갱신 (계획가/계획수량 보존, manualOverride 보호)
  for (let i = 0; i < buyDates.length; i++) {
    const date = buyDates[i];
    const info = buyByDate[date];
    const avgPrice = Math.round(info.amt / info.qty);

    if (i < buyPlans.length) {
      const plan = buyPlans[i];
      if (plan.manualOverride) {
        // 사용자 수동 입력된 슬롯은 유지
        console.log(`[reconcile] ${stockName} buy${i + 1}차 manualOverride 보존 (${plan.filledDate} ${plan.filledPrice}원 ${plan.filledQuantity}주)`);
        continue;
      }
      buyPlans[i] = {
        ...plan,
        // 계획가/계획수량(price, quantity)은 절대 변경하지 않음
        filled: true,
        filledDate: date,
        filledQuantity: info.qty,
        filledPrice: avgPrice,
        // ✅ 차수별 룰: 직전 매수 후 매도 3회+ → 'B'
        rule: stageRuleFor(i + 1),
      };
      buyFilledCount++;
    } else {
      // 계획 차수 초과 — 로그만 남기고 건드리지 않음 (사용자 수동 확인)
      exceedsBuy++;
      console.log(
        `[reconcile] ${stockName} 매수 계획 초과: ${date} ${info.qty}주 ` +
          `(계획 ${buyPlans.length}차, 실제 ${i + 1}번째 날짜)`
      );
    }
  }
  // trades에 없는 차수 처리:
  //   - manualOverride=true → 보호
  //   - 사용자가 입력한 데이터 (filledPrice+filledQty 둘 다 있음) → 보호
  //   - 둘 다 없는 옛 자동 데이터만 unfilled 리셋
  for (let i = buyDates.length; i < buyPlans.length; i++) {
    if (!buyPlans[i].filled) continue;
    if (buyPlans[i].manualOverride) {
      console.log(`[reconcile] ${stockName} buy${i + 1}차 manualOverride 보존 (trades 없음)`);
      continue;
    }
    const hasUserData = (buyPlans[i].filledPrice || 0) > 0 && (buyPlans[i].filledQuantity || 0) > 0;
    if (hasUserData) {
      console.log(`[reconcile] ${stockName} buy${i + 1}차 사용자 입력 보존 (filledPrice=${buyPlans[i].filledPrice}, filledQty=${buyPlans[i].filledQuantity})`);
      continue;
    }
    console.log(`[reconcile] ${stockName} buy${i + 1}차 unfilled 리셋 (trades에 없음, 기존 filledDate=${buyPlans[i].filledDate})`);
    buyPlans[i] = {
      ...buyPlans[i],
      filled: false,
      filledDate: "",
      filledQuantity: 0,
      filledPrice: 0,
    };
    buyFilledCount++;
  }

  // ✅ buyPlans 계획가(price) / 계획수량(quantity) 자동 보정 (액면분할/단위오류 대응)
  // - 체결된 차수: filledPrice/filledQuantity 기준으로 price/quantity 갱신
  // - 미체결 차수:
  //     · 룰A: 이전 차수 실제가 × 0.9 (계단식)
  //     · 룰B (rule==='B' && bottomPrice > 0): 첫 미체결 = bottomPrice × 0.9, 그 이후 = 이전 × 0.9
  // - manualOverride 슬롯은 손대지 않음
  const bottomPriceNum = Number(stock.bottomPrice) || 0;
  for (let i = 0; i < buyPlans.length; i++) {
    const bp = buyPlans[i];
    if (bp.manualOverride) continue;

    let correctPrice = bp.price;
    let correctQty = bp.quantity;
    // ✅ 차수별 룰: 직전 매수 후 매도 회수로 자동 판정
    const thisStageRule = stageRuleFor(i + 1);
    const thisRuleB = thisStageRule === "B" && bottomPriceNum > 0;

    if (bp.filled && (bp.filledPrice || 0) > 0) {
      // 체결된 차수: 실제 체결가가 곧 계획가
      correctPrice = bp.filledPrice;
      if ((bp.filledQuantity || 0) > 0) correctQty = bp.filledQuantity;
    } else if (i > 0) {
      // 미체결 차수
      const prev = buyPlans[i - 1];
      if (thisRuleB) {
        if (prev.filled) {
          // 첫 룰B 차수 → bottomPrice × 0.9
          correctPrice = Math.round(bottomPriceNum * 0.9);
        } else {
          // 이전도 미체결 → 룰B 계단식 (직전 차수의 보정 후 price 사용)
          const prevPrice = prev.price || 0;
          if (prevPrice > 0) correctPrice = Math.round(prevPrice * 0.9);
        }
      } else {
        // 룰A: 이전 차수 실제가 × 0.9
        const prevPrice = prev.filledPrice || prev.price || 0;
        if (prevPrice > 0) correctPrice = Math.round(prevPrice * 0.9);
      }
      // ✅ 미체결 수량 = 1차 매수금액 / 해당 차수 예상가 (비중 동일 원칙)
      const firstBp = buyPlans[0];
      const firstBuyPrice = firstBp.filledPrice || firstBp.price || 0;
      const firstBuyQty = firstBp.filledQuantity || firstBp.quantity || 0;
      const firstBuyAmt = firstBuyPrice * firstBuyQty;
      const levelQty = correctPrice > 0 && firstBuyAmt > 0
        ? Math.round(firstBuyAmt / correctPrice)
        : firstBuyQty;
      if (levelQty > 0) correctQty = levelQty;
    }

    // 계획가/수량 또는 rule 변경 시 갱신
    if (correctPrice !== bp.price || correctQty !== bp.quantity || bp.rule !== thisStageRule) {
      console.log(`[reconcile] ${stockName} buy${i + 1}차 보정 (rule ${bp.rule || "?"}→${thisStageRule}): price ${bp.price} → ${correctPrice}, qty ${bp.quantity} → ${correctQty}`);
      buyPlans[i] = {...bp, price: correctPrice, quantity: correctQty, rule: thisStageRule};
      buyFilledCount++; // 변경 트리거
    }
  }

  // 매도 차수 갱신: 개별 체결을 순차 슬롯에 매핑 (manualOverride 보존)
  // ✅ 보너스: sellPlans price(목표가) + quantity(계획수량) 자동 재계산 (기존 데이터 오염 자동 보정)
  // buyPlans 기반으로 평단 직접 계산 (액면병합 후 stock.avgPrice 미갱신 대비)
  const stockAvgFromBuyPlans = (() => {
    let amt = 0; let qty = 0;
    for (const bp of buyPlans) {
      if (bp.filled) {
        amt += (Number(bp.filledPrice) || Number(bp.price) || 0) * (Number(bp.filledQuantity) || Number(bp.quantity) || 0);
        qty += Number(bp.filledQuantity) || Number(bp.quantity) || 0;
      }
    }
    return qty > 0 ? Math.round(amt / qty) : 0;
  })();
  const stockAvg = stockAvgFromBuyPlans > 0 ? stockAvgFromBuyPlans : (Number(stock.avgPrice) || 0);
  // buyPlans filled 합계
  const totalFilledBuyQty = buyPlans.reduce((sum: number, bp: any) =>
    bp.filled ? sum + ((bp.filledQuantity as number) || (bp.quantity as number) || 0) : sum, 0);
  // ✅ 매도 슬롯 수량 = 현재 보유수량 / 5 (추가매수 시 리셋 원칙)
  const totalSoldQtyForSell = sortedSells.reduce((sum: number, s: any) => sum + (Number(s.quantity) || 0), 0);
  const currentHoldingForSell = Math.max(0, totalFilledBuyQty - totalSoldQtyForSell);
  const correctSellQty = currentHoldingForSell > 0 ? Math.round(currentHoldingForSell / 5) : 0;

  for (let i = 0; i < sellPlans.length; i++) {
    const plan = sellPlans[i];
    if (plan.manualOverride) continue; // 수동 편집된 슬롯은 손대지 않음

    let needUpdate = false;
    let correctPrice = plan.price;
    let correctQty = plan.quantity;

    // 목표가 자동 보정 (평단 × (1+%))
    if (stockAvg > 0 && plan.percent) {
      correctPrice = Math.round(stockAvg * (1 + plan.percent / 100));
      if (plan.price !== correctPrice) needUpdate = true;
    }

    // 계획수량 자동 보정 (체결 안 된 차수만 - 체결 차수는 실제 수량 보존)
    if (!plan.filled && correctSellQty > 0 && plan.quantity !== correctSellQty) {
      correctQty = correctSellQty;
      needUpdate = true;
    }

    if (needUpdate) {
      sellPlans[i] = {...plan, price: correctPrice, quantity: correctQty};
      console.log(`[reconcile] ${stockName} sell+${plan.percent}% 보정: 목표가 ${plan.price}→${correctPrice}, 수량 ${plan.quantity}→${correctQty}`);
      sellFilledCount++;
    }
  }

  // ✅ 옵션 D: trade.id 명시적 매칭 + 옵션 C fallback (이중 집계 방지)
  //
  // 1단계: consumedTradeIds 있는 슬롯 → trade.id 직접 매칭으로 정확 흡수
  //   - 사용자 합치기/이동/편집 시점에 어떤 trade를 흡수했는지 명시 저장
  //   - 광전자 케이스 같은 순서 추측 오류 원천 차단
  //
  // 2단계: consumedTradeIds 없는 기존 manualOverride 슬롯 → 옵션 C fallback (수량 기준)
  //   - 마이그레이션 전 데이터 호환성 보장
  //
  // 3단계: maSells도 동일 (consumedTradeIds 우선, 없으면 수량 fallback)
  const maSellsArr: any[] = Array.isArray((stock as any).maSells) ? (stock as any).maSells : [];

  // 1단계: 명시적 trade.id 흡수 (qty 추적 — 부분 분할 지원)
  // 한 trade를 여러 슬롯이 공유 가능: 광전자 5/7 160주 → +5% 80주 + ma20 80주
  //
  // ✅ 근본 수정 (중복흡수 차단):
  //   - manualOverride 슬롯 OR 다중참조(가중평균) 슬롯의 trade는 hardConsumedIds로 완전 제외
  //     → 자동매핑/다른 슬롯이 절대 재사용 못 함 (흥구석유: +5% 단일 수정 후 reconcile이
  //       매도를 +5%에 중복 흡수해 205주로 부풀던 버그 차단)
  //   - 단일참조 + 비수동 슬롯만 부분분할 점유량(consumedQtyByTrade) 추적
  const hardConsumedIds = new Set<string>();
  const consumedQtyByTrade: Record<string, number> = {};
  const registerSlot = (ids: any, qty: number, isManual: boolean) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    if (isManual || ids.length > 1) {
      // 수동 편집 또는 다중참조(가중평균) → trade 전체를 hard 점유 (재사용 차단)
      for (const id of ids) if (id) hardConsumedIds.add(String(id));
    } else {
      // 단일참조 + 비수동 → 부분분할 점유량 추적
      const id = String(ids[0]);
      consumedQtyByTrade[id] = (consumedQtyByTrade[id] || 0) + qty;
    }
  };
  for (const sp of sellPlans) {
    registerSlot(sp.consumedTradeIds, Number(sp.filledQuantity) || 0, sp.manualOverride === true);
  }
  for (const m of maSellsArr) {
    registerSlot(m.consumedTradeIds, Number(m.quantity) || 0, m.manualOverride === true);
  }

  // 2단계: 명시적 매칭 안 된 manualOverride/maSells의 fallback 수량 계산
  const consumedByManualSell = sellPlans.reduce((sum: number, sp: any) => {
    if (sp.manualOverride === true && sp.filled && !Array.isArray(sp.consumedTradeIds)) {
      return sum + (Number(sp.filledQuantity) || 0);
    }
    return sum;
  }, 0);
  const consumedByMaSell = maSellsArr.reduce((sum: number, m: any) => {
    if (m.filled && !Array.isArray(m.consumedTradeIds)) {
      return sum + (Number(m.quantity) || 0);
    }
    return sum;
  }, 0);
  const consumedByManualQty = consumedByManualSell + consumedByMaSell;

  // 3단계: tradesToMap 구성 — hardConsumedIds 완전 제외 + 단일참조 부분분할 remain
  const remainingTrades: any[] = [];
  for (const t of sortedSells) {
    if (hardConsumedIds.has(String(t.id))) continue; // ✅ 수동/다중참조 trade 완전 제외
    const tQty = Number(t.quantity) || 0;
    const consumed = consumedQtyByTrade[String(t.id)] || 0;
    const remain = tQty - consumed;
    if (remain > 0) {
      remainingTrades.push({...t, quantity: remain});
    }
  }

  let skipped = 0;
  const tradesToMap: any[] = [];
  for (const t of remainingTrades) {
    const tQty = Number(t.quantity) || 0;
    if (tQty <= 0) continue;
    if (skipped + tQty <= consumedByManualQty) {
      skipped += tQty; // fallback 완전 흡수
    } else if (skipped < consumedByManualQty) {
      // fallback 부분 흡수 + 부분 매핑
      const remainingPart = tQty - (consumedByManualQty - skipped);
      tradesToMap.push({...t, quantity: remainingPart});
      skipped = consumedByManualQty;
    } else {
      tradesToMap.push(t);
    }
  }

  const consumedIdCount = Object.keys(consumedQtyByTrade).length;
  if (consumedIdCount > 0 || consumedByManualQty > 0) {
    console.log(
      `[reconcile] ${stockName} 흡수: id매칭 ${consumedIdCount}건 + 수량fallback ${consumedByManualQty}주 / ` +
      `자동매핑 대상: ${tradesToMap.reduce((s, t) => s + (Number(t.quantity) || 0), 0)}주`
    );
  }

  // ✅ 옵션 E: band(가격대) 기반 자동매핑 — trade의 실제 수익률과 슬롯 percent를 일치시킴
  //
  // 평단 대비 수익률로 band 분류:
  //   profitPct < 2.5%   → null (MA 매도 후보, 손절 등 — 미분류 유지)
  //   2.5% ≤ < 7.5%      → +5% 슬롯
  //   7.5% ≤ < 12.5%     → +10% 슬롯
  //   12.5% ≤ < 17.5%    → +15% 슬롯
  //   17.5% ≤ < 22.5%    → +20% 슬롯
  //   22.5% 이상         → +25% 슬롯
  //
  // 같은 band에 여러 trade → 가중평균 합산
  // 가격대가 맞지 않으면 미분류 (디아이씨처럼 +25% 슬롯에 +11% 매도가 들어가는 일 차단)

  // ✅ Phase 2: 매도 시점 historical avgPrice 기반 band 분류
  // 4/30 19,240×20처럼 1차 매수만 했을 때의 매도는 1차 매수가(18,350) 기준 +5%로 분류되어야 함.
  // 시스템이 현재 평단(2차 매수 후 16,500)으로 분류하면 +15%로 잘못 매핑됨.
  // buyPlans.filledDate 기반으로 매도일까지의 누적 매수 평단을 계산.

  // 매수 이벤트 (filledDate 기준 정렬)
  const buyEvents: Array<{date: string; qty: number; price: number}> = buyPlans
    .filter((bp: any) => bp.filled && bp.filledDate)
    .map((bp: any) => ({
      date: String(bp.filledDate),
      qty: Number(bp.filledQuantity) || Number(bp.quantity) || 0,
      price: Number(bp.filledPrice) || Number(bp.price) || 0,
    }))
    .filter((b) => b.qty > 0 && b.price > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  // 매도 시점까지의 누적 평단
  const avgPriceAtTime = (sellDate: string): number => {
    let amt = 0;
    let qty = 0;
    for (const b of buyEvents) {
      if (b.date <= sellDate) {
        amt += b.price * b.qty;
        qty += b.qty;
      }
    }
    if (qty > 0) return amt / qty;
    // fallback: 전체 buyPlans 평단 또는 stock.avgPrice
    let totalAmt = 0;
    let totalQty = 0;
    for (const bp of buyPlans) {
      if (bp.filled) {
        const q = Number(bp.filledQuantity) || Number(bp.quantity) || 0;
        const p = Number(bp.filledPrice) || Number(bp.price) || 0;
        totalAmt += p * q;
        totalQty += q;
      }
    }
    return totalQty > 0 ? totalAmt / totalQty : (Number((stock as any).avgPrice) || 0);
  };

  // 전체 평단 (audit/band 검증용 — 현재 평단)
  let totalBuyAmt = 0;
  let totalBuyQty = 0;
  for (const bp of buyPlans) {
    if (bp.filled) {
      const q = Number(bp.filledQuantity) || Number(bp.quantity) || 0;
      const p = Number(bp.filledPrice) || Number(bp.price) || 0;
      totalBuyAmt += p * q;
      totalBuyQty += q;
    }
  }
  const avgBuyPriceCalc = totalBuyQty > 0 ? totalBuyAmt / totalBuyQty : (Number((stock as any).avgPrice) || 0);

  // band 분류 — sellDate에 따라 historical avg 사용
  const classifyByBand = (price: number, sellDate?: string): number | null => {
    const refAvg = sellDate ? avgPriceAtTime(sellDate) : avgBuyPriceCalc;
    if (refAvg <= 0 || price <= 0) return null;
    const profitPct = (price / refAvg - 1) * 100;
    if (profitPct < 2.5) return null;
    if (profitPct < 7.5) return 5;
    if (profitPct < 12.5) return 10;
    if (profitPct < 17.5) return 15;
    if (profitPct < 22.5) return 20;
    return 25;
  };

  // 자동매핑 대상 슬롯: non-manualOverride AND consumedTradeIds 없는 슬롯만
  // (consumedTradeIds 있는 슬롯은 trade.id로 자기증명 → 자동매핑 대상에서 제외)
  const slotIdxByPercent: Record<number, number> = {};
  for (let i = 0; i < sellPlans.length; i++) {
    const sp = sellPlans[i];
    if (sp.manualOverride) continue;
    if (Array.isArray(sp.consumedTradeIds) && sp.consumedTradeIds.length > 0) continue;
    slotIdxByPercent[sp.percent] = i;
  }

  // ✅ 신중 모드 (Option B): 각 band에서 *가장 가까운* trade 1건만 자동 매핑.
  // 같은 band에 다중 trade일 때 가중평균으로 합치면 사용자 의도와 어긋날 수 있음.
  // (MA 매도였는지, 손절이었는지, 추가 +N% 매도였는지 시스템이 모름)
  // → band 중심(5/10/15/20/25%)과의 distance 최소인 1건만 자동, 나머지는 미분류로 노출.

  // 1단계: 각 trade의 band + distance 계산
  type TradeBandInfo = {trade: any; band: number; distance: number};
  const tradesByBand: Record<number, TradeBandInfo[]> = {};
  let unmappedCount = 0;
  let unmappedQty = 0;

  for (const t of tradesToMap) {
    const tQty = Number(t.quantity) || 0;
    const tPrice = Number(t.price) || 0;
    if (tQty <= 0 || tPrice <= 0) continue;
    const sellDate = String(t.date || "");
    const band = classifyByBand(tPrice, sellDate);
    if (band === null || slotIdxByPercent[band] === undefined) {
      unmappedCount++;
      unmappedQty += tQty;
      continue;
    }
    // distance: |profit% - band 중심%|
    const refAvg = avgPriceAtTime(sellDate);
    const profitPct = refAvg > 0 ? (tPrice / refAvg - 1) * 100 : 0;
    const distance = Math.abs(profitPct - band);
    if (!tradesByBand[band]) tradesByBand[band] = [];
    tradesByBand[band].push({trade: t, band, distance});
  }

  // 2단계: 각 band에서 distance 최소 1건만 자동 매핑, 나머지는 unmapped
  const filledByThisReconcile = new Set<number>();
  for (const bandStr of Object.keys(tradesByBand)) {
    const band = Number(bandStr);
    const candidates = tradesByBand[band];
    // distance 오름차순 정렬 → 첫 번째가 자동 매핑 후보
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    const t = best.trade;
    const slotIdx = slotIdxByPercent[band];
    const tQty = Number(t.quantity) || 0;
    const tPrice = Number(t.price) || 0;
    sellPlans[slotIdx] = {
      ...sellPlans[slotIdx],
      filled: true,
      filledDate: String(t.date || ""),
      filledQuantity: tQty,
      filledPrice: tPrice,
      consumedTradeIds: t.id ? [String(t.id)] : [],
    };
    filledByThisReconcile.add(band);
    sellFilledCount++;
    console.log(
      `[reconcile/band] ${stockName} +${band}% ← ${tPrice}원 × ${tQty}주 (${t.date}, distance=${best.distance.toFixed(2)}%)` +
      (candidates.length > 1 ? ` — 추가 ${candidates.length - 1}건은 미분류로 분리` : "")
    );
    // 나머지는 unmapped
    for (let i = 1; i < candidates.length; i++) {
      unmappedCount++;
      unmappedQty += Number(candidates[i].trade.quantity) || 0;
    }
  }

  // non-manual 슬롯 중 이번에 채워지지 않은 곳 = 옛 자동매핑 흔적 → 리셋
  for (let i = 0; i < sellPlans.length; i++) {
    const plan = sellPlans[i];
    if (plan.manualOverride) {
      console.log(`[reconcile] ${stockName} sell+${plan.percent}% manualOverride 보존`);
      continue;
    }
    // ✅ consumedTradeIds 있는 슬롯은 자기증명 → 리셋 안 함 (trade.id로 매핑 보증됨)
    if (Array.isArray(plan.consumedTradeIds) && plan.consumedTradeIds.length > 0) {
      console.log(`[reconcile] ${stockName} sell+${plan.percent}% consumedTradeIds 보존 (${plan.consumedTradeIds.length}건)`);
      continue;
    }
    if (!plan.filled) continue;
    if (filledByThisReconcile.has(plan.percent)) continue;
    console.log(`[reconcile/reset] ${stockName} sell+${plan.percent}% unfilled 리셋 (band 매핑 없음)`);
    sellPlans[i] = {
      ...plan,
      filled: false,
      filledDate: "",
      filledQuantity: 0,
      filledPrice: 0,
      consumedTradeIds: [], // ✅ 리셋 시 consumedTradeIds도 비움
    };
    sellFilledCount++;
  }

  // band 분류 안 된 trade (계획 초과 또는 가격대 미정)
  if (unmappedCount > 0) {
    exceedsSell += unmappedCount;
    console.log(
      `[reconcile/band] ${stockName} 매도 ${unmappedQty}주(${unmappedCount}건) 미분류 ` +
      `- band 매칭 실패 또는 슬롯 manualOverride. 사용자 수동 분류 필요.`
    );
  }

  // ✅ audit: trade 매도수량 - 매핑수량 계산 (mismatch 감지)
  const tradeSellQtyTotal = sortedSells.reduce((s, t) => s + (Number(t.quantity) || 0), 0);
  const finalSellPlanQty = sellPlans
    .filter((p: any) => p.filled)
    .reduce((s: number, p: any) => s + (Number(p.filledQuantity) || 0), 0);
  const finalMaSellQty = maSellsArr
    .filter((m: any) => m.filled)
    .reduce((s: number, m: any) => s + (Number(m.quantity) || 0), 0);
  const mappingAuditDiff = tradeSellQtyTotal - (finalSellPlanQty + finalMaSellQty);

  // ✅ 옵션 B: filled 슬롯의 filledPrice가 percent band와 일치하는지 검증
  // 디아이씨 같은 케이스(잘못된 슬롯에 매핑) 사후 감지
  // ✅ Phase 2: 매도 시점 평단(historical) 기준으로 검증 — 시점별 평단 변화 반영
  let mappingBandIssues = 0;
  for (const sp of sellPlans) {
    if (!sp.filled) continue;
    const fp = Number(sp.filledPrice) || 0;
    if (fp <= 0) continue;
    const sellDate = String(sp.filledDate || "");
    const expectedBand = classifyByBand(fp, sellDate);
    const refAvg = sellDate ? avgPriceAtTime(sellDate) : avgBuyPriceCalc;
    if (expectedBand !== null && expectedBand !== sp.percent) {
      mappingBandIssues++;
      console.warn(
        `[audit/band] ${stockName} +${sp.percent}% 슬롯에 ${fp}원 매핑됨 ` +
        `(${sellDate} 시점 평단 ${refAvg.toFixed(0)}원 기준 실제 band: +${expectedBand}%)`
      );
    }
  }

  // ✅ P3: 매핑 신뢰도 검증 — filled 슬롯에 consumedTradeIds 없으면 옵션 C fallback에 의존 = 신뢰도 낮음
  // 모든 슬롯이 consumedTradeIds로 trade.id를 명시하면 매핑이 100% 정확.
  let mappingIntegrityIssues = 0;
  for (const sp of sellPlans) {
    if (!sp.filled) continue;
    if (!Array.isArray(sp.consumedTradeIds) || sp.consumedTradeIds.length === 0) {
      mappingIntegrityIssues++;
    }
  }
  for (const m of maSellsArr) {
    if (!m.filled) continue;
    if (!Array.isArray(m.consumedTradeIds) || m.consumedTradeIds.length === 0) {
      mappingIntegrityIssues++;
    }
  }
  if (mappingIntegrityIssues > 0) {
    console.warn(
      `[audit/integrity] ${stockName} consumedTradeIds 누락 슬롯: ${mappingIntegrityIssues}건 ` +
      `- 옵션 C fallback 의존 (정확도 낮음). 마이그레이션 권장.`
    );
  }

  // ✅ Option B: 정합성 검증 — consumedTradeIds ↔ filled 데이터 일관성 체크 + 자동 정정
  // 디아이씨 +15% 같은 케이스: filledPrice=8810 vs consumedTradeIds=[8700 trade] = 불일치
  // 자동으로 올바른 trade 찾아서 교체. 못 찾으면 카운터에 기록.
  const tradeById = new Map<string, {id: string; date: string; price: number; quantity: number}>();
  for (const t of sortedSells) {
    tradeById.set(String(t.id), {
      id: String(t.id),
      date: String(t.date || ""),
      price: Number(t.price) || 0,
      quantity: Number(t.quantity) || 0,
    });
  }

  let mappingConsumedMismatch = 0;
  let autoCorrected = 0;

  // 모든 슬롯의 consumedTradeIds qty 합산 (자동 정정 시 used 추적용)
  const trackUsedQty: Record<string, number> = {};

  const validateSlot = (
    slot: any,
    slotLabel: string,
    slotQty: number,
    slotPrice: number,
    slotDate: string
  ): {fixed: boolean; newIds: string[] | null} => {
    if (!Array.isArray(slot.consumedTradeIds) || slot.consumedTradeIds.length === 0) {
      return {fixed: false, newIds: null}; // mappingIntegrityIssues에 이미 잡힘
    }
    // 합산 계산
    let cQty = 0, cAmt = 0;
    let validIdCount = 0;
    for (const id of slot.consumedTradeIds) {
      const t = tradeById.get(String(id));
      if (!t) continue;
      validIdCount++;
      // 단일 참조면 slot의 filledQuantity를 그 trade에서 점유한 양으로 간주
      // 다중 참조면 각 trade의 전체 qty 합산
      if (slot.consumedTradeIds.length === 1) {
        cQty += slotQty;
        cAmt += slotQty * t.price;
      } else {
        cQty += t.quantity;
        cAmt += t.quantity * t.price;
      }
    }
    const cAvg = cQty > 0 ? Math.round(cAmt / cQty) : 0;
    // 단일 참조의 경우 qty는 slot.filledQuantity와 자동 일치
    // 핵심 검증: price 일치 여부 + 모든 ID가 trades에 존재
    const priceMismatch = Math.abs(cAvg - slotPrice) > 1;
    const idMissing = validIdCount < slot.consumedTradeIds.length;

    if (!priceMismatch && !idMissing && cQty === slotQty) {
      return {fixed: false, newIds: null}; // 정합성 OK
    }

    // 불일치 감지 — 자동 정정 시도
    console.warn(
      `[audit/mismatch] ${stockName} ${slotLabel} 정합성 위반: ` +
      `slot(qty=${slotQty}, price=${slotPrice}) vs consumed(qty=${cQty}, avg=${cAvg}, validIds=${validIdCount}/${slot.consumedTradeIds.length})`
    );
    mappingConsumedMismatch++;

    // resolveIds로 올바른 매칭 시도
    if (!slotDate || slotQty <= 0) return {fixed: false, newIds: null};
    const candidates = sortedSells
      .filter((t) => String(t.date) === slotDate)
      .map((t) => ({
        id: String(t.id),
        price: Number(t.price) || 0,
        quantity: Number(t.quantity) || 0,
        remain: (Number(t.quantity) || 0) - (trackUsedQty[String(t.id)] || 0),
      }))
      .filter((t) => t.remain > 0);
    // 1) date + qty + price 정확 매칭
    const exact = candidates.find((t) => t.remain === slotQty && t.price === slotPrice);
    if (exact) {
      trackUsedQty[exact.id] = (trackUsedQty[exact.id] || 0) + slotQty;
      autoCorrected++;
      console.log(`[audit/autofix] ${stockName} ${slotLabel} → ${exact.id} (단일 정확 매칭)`);
      return {fixed: true, newIds: [exact.id]};
    }
    // 2) 같은 가격 부분 매칭
    const partial = candidates.find((t) => t.price === slotPrice && t.remain >= slotQty);
    if (partial) {
      trackUsedQty[partial.id] = (trackUsedQty[partial.id] || 0) + slotQty;
      autoCorrected++;
      console.log(`[audit/autofix] ${stockName} ${slotLabel} → ${partial.id} (부분 매칭)`);
      return {fixed: true, newIds: [partial.id]};
    }
    // 3) 가중평균 역추적 (2^n subset)
    if (candidates.length >= 2 && candidates.length <= 10) {
      const n = candidates.length;
      for (let mask = 1; mask < (1 << n); mask++) {
        let sumQ = 0, sumA = 0;
        const subset: string[] = [];
        for (let i = 0; i < n; i++) {
          if (mask & (1 << i)) {
            sumQ += candidates[i].remain;
            sumA += candidates[i].remain * candidates[i].price;
            subset.push(candidates[i].id);
          }
        }
        if (sumQ === slotQty) {
          const avg = sumQ > 0 ? Math.round(sumA / sumQ) : 0;
          if (avg === slotPrice) {
            for (let i = 0; i < n; i++) {
              if (mask & (1 << i)) {
                trackUsedQty[candidates[i].id] = (trackUsedQty[candidates[i].id] || 0) + candidates[i].remain;
              }
            }
            autoCorrected++;
            console.log(`[audit/autofix] ${stockName} ${slotLabel} → ${subset.join(',')} (가중평균)`);
            return {fixed: true, newIds: subset};
          }
        }
      }
    }
    console.warn(`[audit/autofix-fail] ${stockName} ${slotLabel} 자동 정정 실패 — 수동 정정 필요`);
    return {fixed: false, newIds: null};
  };

  // 먼저 정합성 OK 슬롯들의 trackUsedQty 누적 (이후 검증 시 그 trades는 제외)
  for (const sp of sellPlans) {
    if (sp.filled && Array.isArray(sp.consumedTradeIds) && sp.consumedTradeIds.length > 0) {
      const cQty = Number(sp.filledQuantity) || 0;
      if (sp.consumedTradeIds.length === 1) {
        const t = tradeById.get(String(sp.consumedTradeIds[0]));
        if (t && t.price === Number(sp.filledPrice) && cQty <= t.quantity) {
          trackUsedQty[t.id] = (trackUsedQty[t.id] || 0) + cQty;
        }
      } else {
        for (const id of sp.consumedTradeIds) {
          const t = tradeById.get(String(id));
          if (t) trackUsedQty[t.id] = (trackUsedQty[t.id] || 0) + t.quantity;
        }
      }
    }
  }
  for (const m of maSellsArr) {
    if (m.filled && Array.isArray(m.consumedTradeIds) && m.consumedTradeIds.length > 0) {
      const cQty = Number(m.quantity) || 0;
      if (m.consumedTradeIds.length === 1) {
        const t = tradeById.get(String(m.consumedTradeIds[0]));
        if (t && t.price === Number(m.price) && cQty <= t.quantity) {
          trackUsedQty[t.id] = (trackUsedQty[t.id] || 0) + cQty;
        }
      } else {
        for (const id of m.consumedTradeIds) {
          const t = tradeById.get(String(id));
          if (t) trackUsedQty[t.id] = (trackUsedQty[t.id] || 0) + t.quantity;
        }
      }
    }
  }

  // 슬롯 검증 + 자동 정정
  for (let i = 0; i < sellPlans.length; i++) {
    const sp = sellPlans[i];
    if (!sp.filled || !Array.isArray(sp.consumedTradeIds) || sp.consumedTradeIds.length === 0) continue;
    const res = validateSlot(sp, `sell+${sp.percent}%`, Number(sp.filledQuantity) || 0, Number(sp.filledPrice) || 0, String(sp.filledDate || ""));
    if (res.fixed && res.newIds) {
      sellPlans[i] = {...sp, consumedTradeIds: res.newIds};
      sellFilledCount++;
    }
  }
  for (let i = 0; i < maSellsArr.length; i++) {
    const m = maSellsArr[i];
    if (!m.filled || !Array.isArray(m.consumedTradeIds) || m.consumedTradeIds.length === 0) continue;
    const res = validateSlot(m, `ma${m.ma}`, Number(m.quantity) || 0, Number(m.price) || 0, String(m.filledDate || ""));
    if (res.fixed && res.newIds) {
      maSellsArr[i] = {...m, consumedTradeIds: res.newIds};
      sellFilledCount++;
    }
  }
  if (mappingConsumedMismatch > 0) {
    console.warn(
      `[audit/mismatch] ${stockName} 정합성 위반 ${mappingConsumedMismatch}건 (자동 정정 ${autoCorrected}건, 수동 필요 ${mappingConsumedMismatch - autoCorrected}건)`
    );
  }

  // ─── 단일 진실 모드: 레거시(옵션 D/E) 매핑 결과를 버리고 태그 집계로 교체 ───
  //   매도 슬롯의 유일한 작성자 = deriveSellSlotsFromTags.
  //   수동 분류는 manualSellEdit이 태그를 갱신하므로 여기 자연 반영됨.
  let tagAuditDiff: number | null = null;
  if (tagMode) {
    const derived = deriveSellSlotsFromTags(
      {...stock, sellPlans: stock.sellPlans, maSells: stock.maSells},
      trades
    );
    const beforeJson = JSON.stringify({s: stock.sellPlans || [], m: stock.maSells || []});
    const afterJson = JSON.stringify({s: derived.sellPlans, m: derived.maSells});
    sellPlans.splice(0, sellPlans.length, ...derived.sellPlans);
    maSellsArr.splice(0, maSellsArr.length, ...derived.maSells);
    if (beforeJson !== afterJson) sellFilledCount++;
    const mappedTagQty = [...derived.sellPlans, ...derived.maSells].reduce(
      (s: number, p: any) =>
        s + ((p.filled || (Number(p.filledQuantity) || 0) > 0)
          ? (Number(p.filledQuantity) || Number(p.quantity) || 0) : 0), 0);
    tagAuditDiff = tradeSellQtyTotal - mappedTagQty; // 잔여 = unmapped 태그 수량
    console.log(`[reconcile/단일진실] ${stockName} 태그 파생 슬롯 적용 (unmapped ${tagAuditDiff}주)`);
  }

  // 변경사항이 있을 때만 업데이트
  if (buyFilledCount > 0 || sellFilledCount > 0) {
    // ✅ Race condition 방지: update 직전 latest doc 재조회 후 manualOverride 최종 보호
    const latestDoc = await stockDoc.ref.get();
    const latestData = latestDoc.data() || {};
    const latestSellPlans: any[] = latestData.sellPlans || [];
    const latestBuyPlans: any[] = latestData.buyPlans || [];

    const finalSellPlans = sellPlans.map((newPlan: any, i: number) => {
      const latest = latestSellPlans[i];
      // 단일 진실 모드: 태그가 의도를 담으므로 슬롯 manualOverride 머지 생략
      if (tagMode) return newPlan;
      if (latest?.manualOverride) {
        // ✅ 미체결 manualOverride 재계산: 실제 체결 데이터가 없고 consumedTradeIds도 없는 경우
        // → avgPrice 변경(추가매수 등) 후 목표가가 stale하게 고정되는 문제 방지
        // filled sell: 체결 데이터 보존 / unfilled sell: stockAvg 기준 재계산
        const isActuallyFilled = latest.filled || (Number(latest.filledQuantity) || 0) > 0;
        const hasConsumedTrades = Array.isArray(latest.consumedTradeIds) && latest.consumedTradeIds.length > 0;
        if (!isActuallyFilled && !hasConsumedTrades && stockAvg > 0) {
          const freshPrice = Math.round(stockAvg * (1 + (Number(latest.percent) || 0) / 100));
          const freshQty = correctSellQty;
          console.log(
            `[reconcile] ${stockName} sell+${latest.percent}% manualOverride 미체결 재계산: ` +
            `price ${latest.price} → ${freshPrice}, qty ${latest.quantity} → ${freshQty} (avgPrice ${stockAvg})`
          );
          return {
            ...newPlan,
            price: freshPrice,
            quantity: freshQty,
            manualOverride: false,
          };
        }

        console.log(`[reconcile race 보호] ${stockName} sell+${latest.percent}% latest manualOverride 유지`);
        // ✅ filledQuantity > 0 & filledDate 있으면 filled 플래그 동기화 (체결 데이터 있는데 filled=false 버그 수정)
        const hasFillData = (Number(latest.filledQuantity) || 0) > 0 && !!latest.filledDate;
        const baseLatest = (hasFillData && !latest.filled)
          ? (() => { console.log(`[reconcile race 보호] ${stockName} sell+${latest.percent}% filled 동기화 (filledQty=${latest.filledQuantity})`); return {...latest, filled: true}; })()
          : latest;
        // ✅ consumedTradeIds는 system field이므로 auto-fix 반영 허용 (잘못된 매핑 자동 정정)
        const newIds = newPlan.consumedTradeIds;
        if (Array.isArray(newIds) && JSON.stringify(newIds.sort()) !== JSON.stringify((latest.consumedTradeIds || []).slice().sort())) {
          console.log(`[reconcile race 보호] ${stockName} sell+${latest.percent}% consumedTradeIds 자동정정 반영`);
          return {...baseLatest, consumedTradeIds: newIds};
        }
        return baseLatest;
      }
      return newPlan;
    });
    const finalBuyPlans = buyPlans.map((newPlan: any, i: number) => {
      const latest = latestBuyPlans[i];
      if (latest?.manualOverride) {
        console.log(`[reconcile race 보호] ${stockName} buy${i + 1}차 latest manualOverride 유지`);
        return latest;
      }
      return newPlan;
    });

    // ✅ 룰B 카운터: 마지막 매수 차수 이후 매도(이익+MA) 누적 횟수
    // recalcStock(frontend)와 동일 로직으로 백엔드에서도 계산하여 Firestore에 보존
    // → kiwoomSync의 ruleConfig.sellsSinceLastBuy로 mapTradesToPlans에 전달
    const lastFilledBuyDateBE = (finalBuyPlans as any[])
      .filter((bp) => bp.filled && bp.filledDate)
      .reduce((max: string, bp: any) => ((bp.filledDate || "") > max ? (bp.filledDate || "") : max), "");
    let sellsSinceLastBuyBE = 0;
    (finalSellPlans as any[]).forEach((sp) => {
      const f = sp.filled || (Number(sp.filledQuantity) || 0) > 0;
      if (f && (sp.filledDate || "") > lastFilledBuyDateBE) sellsSinceLastBuyBE++;
    });
    (maSellsArr as any[]).forEach((ms) => {
      if (ms.filled && (ms.filledDate || "") > lastFilledBuyDateBE) sellsSinceLastBuyBE++;
    });
    const ruleBActiveBE = (stock as any).rule === "B" &&
      sellsSinceLastBuyBE >= 3 && (Number((stock as any).bottomPrice) || 0) > 0;

    const reconcileUpdate: Record<string, any> = {
      buyPlans: finalBuyPlans,
      sellPlans: finalSellPlans,
      maSells: maSellsArr,
      sellsSinceLastBuy: sellsSinceLastBuyBE,
      ruleBActive: ruleBActiveBE,
      // 단일 진실 모드: audit = 태그 기준 (diff = unmapped 수량, 슬롯 정합성 이슈는 구조상 0)
      mappingAuditDiff: tagMode && tagAuditDiff !== null ? tagAuditDiff : mappingAuditDiff,
      mappingBandIssues: tagMode ? 0 : mappingBandIssues,
      mappingIntegrityIssues: tagMode ? 0 : mappingIntegrityIssues,
      mappingConsumedMismatch: tagMode ? 0 : Math.max(0, mappingConsumedMismatch - autoCorrected),
      mappingAuditAt: Date.now(),
      updatedAt: Date.now(),
    };

    // ✅ firstBuyPrice / firstBuyQuantity 동기화
    // reconcileStockPlans는 buyPlans[0].price/filledPrice를 실제 체결가로 보정하지만
    // 상위 firstBuyPrice 필드는 갱신하지 않아 기본정보 패널에 이질감 발생
    // → 1차 체결가가 확정된 경우에만 상위 필드도 동기화
    const bp0 = finalBuyPlans[0];
    if (bp0 && bp0.filled && (Number(bp0.filledPrice) || 0) > 0) {
      const syncedFirstPrice = Number(bp0.filledPrice);
      const syncedFirstQty = Number(bp0.filledQuantity) || Number(bp0.quantity) || 0;
      if (syncedFirstPrice !== (Number(stock.firstBuyPrice) || 0)) {
        reconcileUpdate.firstBuyPrice = syncedFirstPrice;
        console.log(`[reconcile] ${stockName} firstBuyPrice 동기화: ${stock.firstBuyPrice} → ${syncedFirstPrice}`);
      }
      if (syncedFirstQty > 0 && syncedFirstQty !== (Number(stock.firstBuyQuantity) || 0)) {
        reconcileUpdate.firstBuyQuantity = syncedFirstQty;
        console.log(`[reconcile] ${stockName} firstBuyQuantity 동기화: ${stock.firstBuyQuantity} → ${syncedFirstQty}`);
      }
    }
    // buyPlans 기반 평단이 stock.avgPrice와 다를 때만 갱신 (액면병합 후 미갱신 보정)
    // ✅ Phase 1a 수정: trades 누락이 있으면 buyPlans avg 부정확 → 키움 값 우선
    // 조건: trades net qty (매수-매도) == 키움 totalQuantity 인 경우에만 override
    const stockTotalQty = Number(stock.totalQuantity) || 0;
    let tradesNetQty = 0;
    let tradesSoldQty = 0;
    for (const t of trades) {
      const q = Number(t.quantity) || 0;
      if (t.type === "buy") tradesNetQty += q;
      else if (t.type === "sell") { tradesNetQty -= q; tradesSoldQty += q; }
    }
    const tradesComplete = tradesNetQty === stockTotalQty;

    // ✅ 단일 진실: 잔고(totalQuantity)의 주인은 키움(kiwoomSync/reconcileHoldingsTruth).
    //    reconcile은 trades로 잔고를 "올리지" 않는다 — trades 누락(키움 조회범위 밖
    //    과거 매도)이 있으면 trades 순보유가 실제보다 많아 매매완료 종목을 되살리는
    //    "원점 회귀" 발생 (CS: 매도60 누락 → trades 60남음 → 키움0 무시하고 60으로 부활).
    //    → 전량매도 감지(trades 순보유 0)일 때 0으로 내리는 것만 허용. 증가는 금지.
    const tradesBasedQty = Math.max(0, tradesNetQty);
    if (tradesBasedQty === 0 && stockTotalQty !== 0) {
      reconcileUpdate.totalQuantity = 0;
      reconcileUpdate.avgPrice = 0;
      console.log(`[reconcile] ${stockName} 전량매도(trades 순보유 0) → totalQuantity/avgPrice 0`);
    } else if (tradesBasedQty !== stockTotalQty) {
      // 불일치하지만 증가 방향 → 키움 잔고 신뢰, 건드리지 않음 (로그만)
      console.log(`[reconcile] ${stockName} totalQuantity 불일치 무시: trades ${tradesBasedQty} vs 키움 ${stockTotalQty} (키움 신뢰)`);
    }

    // ✅ 합병/감자 보정 이력 있는 종목은 trades 기반 단순 평단 덮어쓰기 SKIP
    // 키움이 합병 시점에 평단을 재설정하는데 (예: 재영솔루텍 5:1 합병 후 평단 재산정)
    // 단순 가중평균(매수금액÷매수수량) 으로 덮으면 키움 실제 평단과 차이남
    // ✅ 정본 ②(평단=키움): 매도가 있는 종목은 매수가중(stockAvg)이 키움 이동평균(매도분
    //    원가차감)과 달라지므로 override 금지 — 키움 평단(stock.avgPrice) 유지.
    //    매도 없는 종목만 buyPlans 매수가중으로 보정(액면병합 등 미갱신 케이스, 이땐 매수가중=키움).
    const hasCorporateActions = Array.isArray(stock.corporateActions) && stock.corporateActions.length > 0;
    if (stockAvg > 0 && tradesBasedQty > 0 && stockAvg !== (Number(stock.avgPrice) || 0) && tradesComplete && !hasCorporateActions && tradesSoldQty === 0) {
      reconcileUpdate.avgPrice = stockAvg;
      console.log(`[reconcile] ${stockName} avgPrice 보정: ${stock.avgPrice} → ${stockAvg} (trades 완전, 매도없음)`);
    } else if (stockAvg > 0 && tradesBasedQty > 0 && stockAvg !== (Number(stock.avgPrice) || 0) && tradesComplete && !hasCorporateActions && tradesSoldQty > 0) {
      console.log(`[reconcile] ${stockName} avgPrice 보정 SKIP (매도 ${tradesSoldQty}주 존재 → 키움 평단 ${stock.avgPrice} 유지, 매수가중 ${stockAvg} 무시)`);
    } else if (stockAvg > 0 && tradesBasedQty > 0 && stockAvg !== (Number(stock.avgPrice) || 0) && !tradesComplete) {
      console.log(`[reconcile] ${stockName} avgPrice 보정 SKIP (trades 누락: ${tradesNetQty}주 / 키움 ${stockTotalQty}주, 키움 평단 ${stock.avgPrice} 유지)`);
    } else if (hasCorporateActions && stockAvg > 0 && stockAvg !== (Number(stock.avgPrice) || 0)) {
      console.log(`[reconcile] ${stockName} avgPrice 보정 SKIP (합병/감자 이력 있음, 키움 평단 ${stock.avgPrice} 유지)`);
    }
    // ✅ Phase 1a: trades 기반 positions 재계산
    // ✅ Phase 2: 기존 positions의 만기/이자 메타데이터 보존
    try {
      const stockTotalQty = Number(stock.totalQuantity) || 0;
      const stockTotalAvg = Number(stock.avgPrice) || 0;
      if (stockTotalQty > 0 && stockTotalAvg > 0) {
        const existingPositions = Array.isArray(stock.positions) ? stock.positions : undefined;
        const computedPositions = computePositionsFromTrades(
          trades.map((t: any) => ({
            type: t.type,
            price: Number(t.price) || 0,
            quantity: Number(t.quantity) || 0,
            date: t.date,
            isCreditTrade: t.isCreditTrade === true,
          })),
          stockTotalQty,
          stockTotalAvg,
          existingPositions
        );
        reconcileUpdate.positions = computedPositions;
        // isCreditTrade 종합 플래그: 신용 포지션이 1개라도 있으면 true
        reconcileUpdate.isCreditTrade = computedPositions.some((p) => p.type === "credit");
        if (computedPositions.length > 1) {
          console.log(`[reconcile/positions] ${stockName} 분리: ${computedPositions.map((p) => `${p.type}(${p.quantity}@${p.avgPrice})`).join(" + ")}`);
        }
      }
    } catch (e: any) {
      console.warn(`[reconcile/positions] ${stockName} 계산 실패: ${e.message}`);
    }
    await stockDoc.ref.update(reconcileUpdate);
    console.log(
      `[reconcile] ${stockName} 갱신: 매수 ${buyFilledCount}차, 매도 ${sellFilledCount}차` +
        (exceedsBuy + exceedsSell > 0 ? ` (초과 매수 ${exceedsBuy}, 매도 ${exceedsSell})` : "")
    );
    return {
      updated: true,
      buyFilled: buyFilledCount,
      sellFilled: sellFilledCount,
      exceedsBuy,
      exceedsSell,
    };
  }

  // 변경 없어도 audit diff/band/integrity/consumed mismatch는 최신화
  const existingDiff = Number((stock as any).mappingAuditDiff) || 0;
  const existingBandIssues = Number((stock as any).mappingBandIssues) || 0;
  const existingIntegrity = Number((stock as any).mappingIntegrityIssues) || 0;
  const existingMismatch = Number((stock as any).mappingConsumedMismatch) || 0;
  const newMismatch = Math.max(0, mappingConsumedMismatch - autoCorrected);
  if (
    existingDiff !== mappingAuditDiff ||
    existingBandIssues !== mappingBandIssues ||
    existingIntegrity !== mappingIntegrityIssues ||
    existingMismatch !== newMismatch
  ) {
    try {
      await stockDoc.ref.update({
        mappingAuditDiff,
        mappingBandIssues,
        mappingIntegrityIssues,
        mappingConsumedMismatch: newMismatch,
        mappingAuditAt: Date.now(),
      });
    } catch (e) {
      // ignore
    }
  }

  return {updated: false, buyFilled: 0, sellFilled: 0, exceedsBuy, exceedsSell};
}

/**
 * Firestore 트리거: 신규 trade 문서 생성 시 자동 실행
 * - trade_kiwoom_* 만 처리 (사용자 수동 작성분은 매매일지만 남고 plan에 영향 없음)
 * - 해당 종목의 buyPlans / sellPlans filled 플래그 자동 갱신
 */
// ─── 잔고·평단 진실 복구 (키움 정본) ───
//   잔고/평단의 진실 = 키움(kt00005). 잔고 불일치(매매완료 오염, 수량차) + 평단 불일치
//   (매도분 원가차감 이동평균을 sync 못 받아 매수가중 잔존)를 키움 값으로 보정.
//   ※ reconcile은 매도종목 평단을 "유지(SKIP)"만 하고 키움으로 "올려주지" 않으므로,
//      잔고는 맞고 평단만 어긋난 종목은 이 경로가 유일한 자동 보정처. (healthCheckCron이 매일 호출)
async function runHoldingsTruth(apply: boolean): Promise<any> {
  const config = await getKiwoomConfig();
  const token = await getAccessToken(config);
  const holdings = await fetchHoldings(config, token);

  const byCode: Record<string, any> = {};
  const byName: Record<string, any> = {};
  for (const h of holdings) {
    const c = String(h.code || "").replace(/^A/, "");
    if (c) byCode[c] = h;
    if (h.name) byName[h.name] = h;
  }

  const snap = await db.collection("stocks").get();
  const mismatches: any[] = [];
  let checked = 0;
  for (const d of snap.docs) {
    const s = d.data() as any;
    if (!s.code) continue; // 수동 종목 제외 (키움 진실 없음)
    checked++;
    const code = String(s.code).replace(/^A/, "");
    const h = byCode[code] || byName[s.name];
    const kiwoomQty = h ? (Number(h.quantity) || 0) : 0;
    const storedQty = Number(s.totalQuantity) || 0;
    const kiwoomAvg = h ? (Number(h.avgPrice) || 0) : 0;
    const storedAvg = Number(s.avgPrice) || 0;
    const qtyMismatch = kiwoomQty !== storedQty;
    // 평단 불일치: 보유>0 && 키움평단>0 && 차>1원
    const avgMismatch = kiwoomQty > 0 && kiwoomAvg > 0 && Math.abs(kiwoomAvg - storedAvg) > 1;
    if (!qtyMismatch && !avgMismatch) continue;
    const fix: any = {updatedAt: Date.now()};
    if (qtyMismatch) fix.totalQuantity = kiwoomQty;
    if (kiwoomQty > 0 && kiwoomAvg > 0) fix.avgPrice = kiwoomAvg; // 평단도 키움 정본 반영
    mismatches.push({
      name: s.name, code: s.code, qtyMismatch, avgMismatch,
      storedQty, kiwoomQty, storedAvg, kiwoomAvg, avgFix: fix.avgPrice || null,
    });
    if (apply) {
      await d.ref.update(fix);
      // 평단 보정 시 positions(현물/신용 평단)도 정합 위해 reconcile.
      //   reconcile은 매도종목 avgPrice를 SKIP(=방금 보정한 키움값 유지)하므로 회귀 없음.
      if (avgMismatch) {
        try { await reconcileStockPlans(s.name); } catch (e) { /* best-effort */ }
      }
    }
  }
  return {checked, kiwoomHoldings: holdings.length, mismatchCount: mismatches.length, mismatches};
}

// GET /reconcileHoldingsTruth[?apply=true] — 잔고·평단 키움 보정 (dry-run 기본)
export const reconcileHoldingsTruth = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const apply = String(req.query.apply || "") === "true";
        const r = await runHoldingsTruth(apply);
        res.json({success: true, applied: apply, ...r});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// 매도 슬롯 재지정(이동): POST /retagSells
//   body: { tradeIds:[...], toSlot:'+5%'|'MA120'|... }
//   지정한 매도 trade들의 sellSlot을 toSlot으로 변경(분배 해제) → reconcile.
//   MA→수익차수, 수익차수→MA, 차수간 이동 모두 태그 변경 1경로로 처리.
export const retagSells = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {tradeIds, toSlot, insertAfter} = req.body || {};
        if (!Array.isArray(tradeIds) || tradeIds.length === 0 || !toSlot) {
          res.status(400).json({success: false, error: "tradeIds[], toSlot 필수"});
          return;
        }
        const valid = /^(\+(5|10|15|20|25)%|MA(20|60|120))$/.test(String(toSlot));
        if (!valid) {
          res.status(400).json({success: false, error: `잘못된 toSlot: ${toSlot}`});
          return;
        }
        let stockName = "";
        const batch = db.batch();
        for (const id of tradeIds) {
          const ref = db.collection("trades").doc(String(id));
          const snap = await ref.get();
          if (!snap.exists) continue;
          const t = snap.data() as any;
          if (t.type !== "sell") continue;
          if (!stockName) stockName = t.stockName;
          batch.update(ref, {
            sellSlot: toSlot,
            sellSlotSplit: admin.firestore.FieldValue.delete(),
            slotLocked: true, // 사용자 확정 = 정본. 자동 충돌 미분류에서 제외(잠금)
          });
        }
        await batch.commit();
        // toSlot이 MA면 위치 메타(insertAfterPercent) prime — derive가 ...ex로 보존
        const _mMatch = String(toSlot).match(/^MA(20|60|120)$/);
        if (_mMatch && stockName && typeof insertAfter === "number") {
          const ssnap = await db.collection("stocks").where("name", "==", stockName).limit(1).get();
          if (!ssnap.empty) {
            const sref = ssnap.docs[0].ref;
            const sd = ssnap.docs[0].data() as any;
            const maList = Array.isArray(sd.maSells) ? [...sd.maSells] : [];
            const maNum = Number(_mMatch[1]);
            let mi = maList.findIndex((m: any) => m.ma === maNum);
            if (mi < 0) { maList.push({ma: maNum, price: 0, quantity: 0, filled: false}); mi = maList.length - 1; }
            maList[mi] = {...maList[mi], insertAfterPercent: insertAfter};
            await sref.update({maSells: maList});
          }
        }
        let reconcile: any = null;
        if (stockName) {
          try {
            reconcile = await reconcileStockPlans(stockName);
          } catch (e: any) {
            console.error(`[retagSells] reconcile 실패: ${e.message}`);
          }
        }
        res.json({success: true, stockName, count: tradeIds.length, toSlot, reconcile});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// 매도 부분분배 저장: POST /setSellSplit
//   body: { tradeId, splits:[{slot:'+5%',qty:60},...] }  또는 { tradeId, clear:true }
//   한 매도 trade를 여러 차수 슬롯에 부분 배정. 합계 = trade.quantity 여야 함.
//   저장 후 해당 종목 reconcile → 슬롯 재파생 (각 슬롯 1회 매도로 카운트).
export const setSellSplit = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {tradeId, splits, clear} = req.body || {};
        if (!tradeId) {
          res.status(400).json({success: false, error: "tradeId 필수"});
          return;
        }
        const tref = db.collection("trades").doc(String(tradeId));
        const tsnap = await tref.get();
        if (!tsnap.exists) {
          res.status(404).json({success: false, error: "trade 없음"});
          return;
        }
        const trade = tsnap.data() as any;
        if (trade.type !== "sell") {
          res.status(400).json({success: false, error: "매도 trade만 분배 가능"});
          return;
        }
        const stockName = trade.stockName;

        if (clear) {
          // 분배 + 슬롯 마커 모두 제거 → reconcile 자동태깅이 band로 재분류
          await tref.update({
            sellSlotSplit: admin.firestore.FieldValue.delete(),
            sellSlot: admin.firestore.FieldValue.delete(),
          });
        } else {
          if (!Array.isArray(splits) || splits.length === 0) {
            res.status(400).json({success: false, error: "splits 필요"});
            return;
          }
          const clean = splits
            .map((s: any) => ({slot: String(s.slot), qty: Math.round(Number(s.qty) || 0)}))
            .filter((s: any) => s.qty > 0);
          const sum = clean.reduce((a: number, s: any) => a + s.qty, 0);
          const tradeQty = Number(trade.quantity) || 0;
          if (sum !== tradeQty) {
            res.status(400).json({success: false, error: `분배 합계 ${sum} ≠ 매도수량 ${tradeQty}`});
            return;
          }
          // 분배 저장 + sellSlot은 'split' 마커 (자동태깅 재처리 방지, 단일 슬롯 해석 무력화)
          await tref.update({sellSlotSplit: clean, sellSlot: "split"});
        }

        let reconcile: any = null;
        if (stockName) {
          try {
            reconcile = await reconcileStockPlans(stockName);
          } catch (e: any) {
            console.error(`[setSellSplit] reconcile 실패: ${e.message}`);
          }
        }
        res.json({success: true, tradeId, stockName, cleared: !!clear, reconcile});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// 매도 슬롯 부분 분리/이동: POST /splitSellSlot
//   body: { stockName, fromSlot, toSlot, qty }
//   현재 라운드의 fromSlot 매도를 FIFO(오래된 매도부터)로 qty만큼 toSlot으로 분배.
//   → trade.sellSlotSplit에 기록(단일진실). stock.sellPlans/maSells 직접 편집(구식)을
//      대체 — derive가 trade 태그 기준 재생성하므로 stock 편집은 reconcile이 되돌렸음
//      (STX 6/12 120주가 MA20으로 다시 합쳐지던 문제). slotLocked=true로 자동 재태깅·
//      충돌해소에서 보존. toSlot이 MA면 복원 메타(splitFromPercent) prime.
export const splitSellSlot = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {stockName, fromSlot, toSlot, qty} = req.body || {};
        const slotRe = /^(\+(5|10|15|20|25)%|MA(20|60|120)|unmapped)$/;
        if (!stockName || !slotRe.test(String(fromSlot)) || !slotRe.test(String(toSlot)) ||
            String(fromSlot) === String(toSlot) || !(Number(qty) > 0)) {
          res.status(400).json({success: false, error: "stockName, fromSlot≠toSlot(유효슬롯), qty>0 필수"});
          return;
        }
        const moveQty = Math.round(Number(qty));
        const nD = (d: any) => {
          const x = String(d || "");
          return x.length === 8 && !x.includes("-") ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}` : x;
        };
        const tsnap = await db.collection("trades").where("stockName", "==", stockName).get();
        const all = tsnap.docs.map((d) => ({id: d.id, ref: d.ref, ...(d.data() as any)}));
        const buyDates = [...new Set(all.filter((t) => t.type === "buy").map((b) => nD(b.date)))].filter(Boolean).sort();
        const currentRound = Math.max(1, buyDates.length);
        const allocOf = (t: any): number => {
          if (Array.isArray(t.sellSlotSplit) && t.sellSlotSplit.length > 0) {
            // 같은 슬롯 여러 차수분 합산 (collectSlot과 일관)
            return t.sellSlotSplit
              .filter((s: any) => s.slot === fromSlot)
              .reduce((a: number, s: any) => a + (Number(s.qty) || 0), 0);
          }
          return t.sellSlot === fromSlot ? (Number(t.quantity) || 0) : 0;
        };
        const cands = all
          .filter((t) => t.type === "sell" && (Number(t.sellRound) || 0) === currentRound && allocOf(t) > 0)
          .sort((a, b) => (nD(a.date) < nD(b.date) ? -1 : 1));
        let need = moveQty; let moved = 0;
        const batch = db.batch();
        for (const t of cands) {
          if (need <= 0) break;
          const alloc = allocOf(t);
          const move = Math.min(alloc, need);
          if (move <= 0) continue;
          const parts: Record<string, number> = {};
          if (Array.isArray(t.sellSlotSplit) && t.sellSlotSplit.length > 0) {
            for (const s of t.sellSlotSplit) parts[s.slot] = (parts[s.slot] || 0) + (Number(s.qty) || 0);
          } else {
            parts[t.sellSlot || "unmapped"] = Number(t.quantity) || 0;
          }
          parts[fromSlot] = (parts[fromSlot] || 0) - move;
          parts[toSlot] = (parts[toSlot] || 0) + move;
          const clean = Object.entries(parts).filter(([, q]) => q > 0).map(([slot, q]) => ({slot, qty: q}));
          if (clean.length === 1) {
            batch.update(t.ref, {sellSlot: clean[0].slot, sellSlotSplit: admin.firestore.FieldValue.delete(), slotLocked: true});
          } else {
            batch.update(t.ref, {sellSlot: "split", sellSlotSplit: clean, slotLocked: true});
          }
          need -= move; moved += move;
        }
        if (need > 0) {
          res.status(400).json({success: false, error: `${fromSlot} 현재라운드 가용 ${moved} < 요청 ${moveQty}`});
          return;
        }
        // toSlot이 MA면 stock.maSells에 복원/위치 메타 prime (derive가 ...ex로 보존)
        const mMatch = String(toSlot).match(/^MA(20|60|120)$/);
        if (mMatch) {
          const fpMatch = String(fromSlot).match(/^\+(\d+)%$/);
          const fromPct = fpMatch ? Number(fpMatch[1]) : null;
          const ssnap = await db.collection("stocks").where("name", "==", stockName).limit(1).get();
          if (!ssnap.empty && fromPct != null) {
            const sref = ssnap.docs[0].ref;
            const sd = ssnap.docs[0].data() as any;
            const maList = Array.isArray(sd.maSells) ? [...sd.maSells] : [];
            const maNum = Number(mMatch[1]);
            let mi = maList.findIndex((m: any) => m.ma === maNum);
            if (mi < 0) { maList.push({ma: maNum, price: 0, quantity: 0, filled: false}); mi = maList.length - 1; }
            maList[mi] = {...maList[mi], splitFromPercent: fromPct, insertAfterPercent: fromPct};
            await sref.update({maSells: maList});
          }
        }
        await batch.commit();
        const reconcile = await reconcileStockPlans(stockName);
        res.json({success: true, stockName, fromSlot, toSlot, moved: moveQty, reconcile});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// 단일 종목/전체 reconcile 수동 트리거 (단일 진실 검증·운영용)
// GET /reconcileNow?stockName=흥구석유  또는  ?all=true
export const reconcileNow = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540, memory: "512MB"})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const stockName = (req.query.stockName as string) || "";
        const all = String(req.query.all || "") === "true";
        if (!stockName && !all) {
          res.status(400).json({success: false, error: "stockName 또는 all=true 필수"});
          return;
        }
        if (stockName) {
          const r = await reconcileStockPlans(stockName);
          res.json({success: true, stockName, ...r});
          return;
        }
        // all: stocks 컬렉션 전 종목
        const snap = await db.collection("stocks").get();
        const results: any[] = [];
        for (const d of snap.docs) {
          const name = (d.data() as any).name;
          if (!name) continue;
          try {
            const r = await reconcileStockPlans(name);
            results.push({name, updated: r.updated, sellFilled: r.sellFilled});
          } catch (e: any) {
            results.push({name, error: e.message});
          }
        }
        res.json({success: true, total: results.length, updated: results.filter((r) => r.updated).length, results});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// ✅ 3단계 자동 재계산 트리거: 룰B 관련(rule/저점/기준최고가) 변경 시 buyPlans 자동 재계산.
//   네이블 케이스(룰B 설정·저점 확정했는데 차수별 매수계획 안 바뀜) 해결.
//   reconcile은 rule/bottomPrice/referencePeak를 안 바꾸므로(reconcileUpdate 필드 확인) 무한루프 없음.
export const onStockRuleChange = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 120})
  .firestore.document("stocks/{stockId}")
  .onUpdate(async (change) => {
    try {
      const before = change.before.data() as any;
      const after = change.after.data() as any;
      const ruleChanged = String(before.rule || "") !== String(after.rule || "");
      const bottomChanged = (Number(before.bottomPrice) || 0) !== (Number(after.bottomPrice) || 0);
      const peakChanged =
        (Number(before.referencePeakPrice) || 0) !== (Number(after.referencePeakPrice) || 0) ||
        String(before.referencePeakDate || "") !== String(after.referencePeakDate || "");
      if (!ruleChanged && !bottomChanged && !peakChanged) return;
      if (!after.name) return;
      console.log(`[trigger/ruleChange] ${after.name}: rule=${ruleChanged} bottom=${bottomChanged} peak=${peakChanged} → reconcile`);
      await reconcileStockPlans(after.name);
    } catch (e: any) {
      console.error(`[trigger/ruleChange] 실패: ${e.message}`);
    }
  });

export const onTradeCreated = functions
  .region("asia-northeast3")
  .firestore.document("trades/{tradeId}")
  .onCreate(async (snap, context) => {
    const tradeId = context.params.tradeId;
    const trade = snap.data();

    // 키움 자동 기록만 처리
    if (!tradeId.startsWith("trade_kiwoom_")) {
      return null;
    }

    const stockName = trade?.stockName;
    if (!stockName) {
      console.warn(`[onTradeCreated] stockName 없음: ${tradeId}`);
      return null;
    }

    try {
      const result = await reconcileStockPlans(stockName);
      console.log(
        `[onTradeCreated] ${stockName} (${tradeId}): ` +
          `updated=${result.updated}, 매수 ${result.buyFilled}차, 매도 ${result.sellFilled}차`
      );
    } catch (err: any) {
      console.error(`[onTradeCreated] ${stockName} 처리 실패:`, err.message);
    }

    return null;
  });

/**
 * 진단 엔드포인트: 특정 종목의 trades 날짜별 집계 + buyPlans 현황 비교
 * GET /inspectStockTrades?stockName=XXX
 */
/**
 * 진단: buyPlans/sellPlans/maSells 정합성 검사 (전 종목)
 * GET /diagPlansConsistency
 *
 * 검사 항목:
 *   - 매수 합 (buyPlans filled) vs 매도 합 (sellPlans + maSells filled)
 *   - 잔여 = 매수 - 매도 vs 키움 totalQuantity
 *   - 불일치 종목 + 영향 표시
 */

// ✅ 4단계 상설 검증: "키움 정본 = 시스템" 전 종목 헬스체크
//   ① 잔고 불일치(키움 qty vs totalQuantity) ② 평단 불일치(키움 buy_uv vs avgPrice)
//   ③ 슬롯 충돌(같은 라운드+슬롯 다른 date·price 2단위↑ — 2단계 적용 후 0이어야)
// 신용/현금 판정 검증: GET /diagCreditCheck — 키움 crd_tp vs 시스템 positions/isCreditTrade
export const diagCreditCheck = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        const r = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
          method: "POST",
          headers: {"Content-Type": "application/json; charset=utf-8", "authorization": `Bearer ${token}`, "api-id": "kt00005"},
          body: JSON.stringify({dmst_stex_tp: "KRX"}),
        });
        const data = await r.json() as any;
        const list = (data.stk_cntr_remn || []).filter((i: any) => parseInt(i.cur_qty || "0") > 0);
        const byCode: Record<string, any> = {};
        for (const it of list) {
          const code = cleanKiwoomField(it.stk_cd).replace(/^A/, "");
          const crd = String(it.crd_tp || "").trim();
          const qty = parseInt(it.cur_qty || "0");
          if (!byCode[code]) byCode[code] = {name: cleanKiwoomField(it.stk_nm), cash: 0, credit: 0, crds: new Set<string>()};
          if (crd === "00") byCode[code].cash += qty; else byCode[code].credit += qty;
          byCode[code].crds.add(crd);
        }
        const stocksSnap = await db.collection("stocks").get();
        const mismatches: any[] = [];
        const nameMismatches: any[] = [];
        stocksSnap.forEach((doc) => {
          const s = doc.data() as any;
          const code = String(s.code || "").replace(/^A/, "");
          const kw = byCode[code];
          if (!kw) return;
          // 종목명(사명변경) 대조 — code 같은데 이름 다르면 미반영
          if (kw.name && s.name && s.name !== kw.name) {
            nameMismatches.push({code, system: s.name, kiwoom: kw.name});
          }
          const sysCredit = s.isCreditTrade === true || (Array.isArray(s.positions) && s.positions.some((p: any) => p.type === "credit"));
          const kiwoomCredit = kw.credit > 0;
          if (sysCredit !== kiwoomCredit) {
            mismatches.push({
              name: s.name, sysCredit, kiwoomCash: kw.cash, kiwoomCredit: kw.credit,
              crds: [...kw.crds], sysPositions: (s.positions || []).map((p: any) => `${p.type}:${p.quantity}`),
            });
          }
        });
        res.json({success: true, kiwoomCodes: Object.keys(byCode).length, mismatchCount: mismatches.length, mismatches, nameMismatchCount: nameMismatches.length, nameMismatches});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// dedup V1 vs V2 비교 (dry-run, 쓰기 없음): GET /diagSellDedupV2
//   V2가 추가로 지울 fallback(가격미세차·기존태깅 중복)을 전 종목에서 미리 점검.
//   ?apply=true 면 V2 적용(삭제+reconcile) — 기본은 dry-run.
export const diagSellDedupV2 = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 300})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const apply = req.query.apply === "true";
        const stocksSnap = await db.collection("stocks").get();
        const report: any[] = [];
        let v2ExtraTotal = 0; let lockedSkipped = 0;
        for (const doc of stocksSnap.docs) {
          const s = doc.data() as any;
          const name = s.name;
          if (!name) continue;
          const tradesSnap = await db.collection("trades").where("stockName", "==", name).get();
          if (tradesSnap.empty) continue;
          const trades = tradesSnap.docs.map((d) => ({id: d.id, ...(d.data() as any)}));
          const v1 = new Set(dedupSellFallback(trades));
          const v2 = dedupSellFallbackV2(trades);
          const extra = v2.filter((id) => !v1.has(id));
          // slotLocked인데 V2 후보에서 제외된(보존된) fallback 수 — 참고용
          const lockedFbs = trades.filter((t: any) => t.type === "sell" &&
            /^trade_kiwoom_sell_/.test(String(t.id || "")) && t.slotLocked);
          lockedSkipped += lockedFbs.length;
          if (extra.length > 0) {
            const byId: Record<string, any> = {};
            for (const t of trades) byId[String(t.id)] = t;
            const extraDetail = extra.map((id) => {
              const t = byId[id] || {};
              return {id, date: t.date, price: t.price, qty: t.quantity, sellSlot: t.sellSlot || null, slotLocked: !!t.slotLocked};
            });
            // 같은 날 ord_no 정본(참고)
            const dates = new Set(extraDetail.map((e) => e.date));
            const ordCtx = trades.filter((t: any) => t.type === "sell" &&
              /^trade_kiwoom_\d/.test(String(t.id || "")) && dates.has(t.date))
              .map((t: any) => ({date: t.date, price: t.price, qty: t.quantity, sellSlot: t.sellSlot || null}));
            v2ExtraTotal += extra.length;
            report.push({name, v1Del: v1.size, v2Del: v2.length, extraDel: extra.length, extraDetail, ordContext: ordCtx});
          }
          if (apply && v2.length > 0) {
            const delBatch = db.batch();
            for (const id of v2) delBatch.delete(db.collection("trades").doc(id));
            await delBatch.commit();
            await reconcileStockPlans(name);
          }
        }
        res.json({success: true, mode: apply ? "APPLIED" : "DRY-RUN", stocksWithExtra: report.length, v2ExtraTotal, lockedFallbacksPreserved: lockedSkipped, report});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message, stack: e.stack});
      }
    });
  });

async function runHealthCheck(): Promise<any> {
  const config = await getKiwoomConfig();
  const token = await getAccessToken(config);
  const holdings = await fetchHoldings(config, token);
  const norm = (c: string) => (c || "").replace(/^[*A]+/, "").trim();
  const hMap: Record<string, any> = {};
  for (const h of holdings) hMap[norm(h.code)] = h;

  const stocksSnap = await db.collection("stocks").get();
  const balanceIssues: any[] = [];
  const avgIssues: any[] = [];
  stocksSnap.forEach((doc) => {
    const s = doc.data() as any;
    const code = norm(s.code);
    const sysQty = Number(s.totalQuantity) || 0;
    const kh = hMap[code];
    const kQty = kh ? kh.quantity : 0;
    if (sysQty !== kQty) balanceIssues.push({name: s.name, sys: sysQty, kiwoom: kQty, diff: sysQty - kQty});
    if (kh && sysQty > 0) {
      const ad = (Number(s.avgPrice) || 0) - kh.avgPrice;
      if (Math.abs(ad) > 1) avgIssues.push({name: s.name, sys: Number(s.avgPrice) || 0, kiwoom: kh.avgPrice, diff: ad});
    }
  });

  // 슬롯 충돌 (date+price 단위). 단 hasLocked(사용자 확정 2차 매도) 그룹은 정상 — 제외.
  const tradesSnap = await db.collection("trades").get();
  const grp: Record<string, {dps: Set<string>; hasLocked: boolean}> = {};
  tradesSnap.forEach((doc) => {
    const t = doc.data() as any;
    if (t.type !== "sell") return;
    const round = Number(t.sellRound) || 0;
    const stock = t.stockName || "";
    let slots: Array<{slot: string}> = [];
    if (Array.isArray(t.sellSlotSplit) && t.sellSlotSplit.length > 0) {
      slots = t.sellSlotSplit.map((sp: any) => ({slot: String(sp.slot || "")}));
    } else if (t.sellSlot && t.sellSlot !== "unmapped" && t.sellSlot !== "split") {
      slots = [{slot: String(t.sellSlot)}];
    }
    for (const sl of slots) {
      if (!sl.slot || sl.slot === "unmapped") continue;
      const key = `${stock}|R${round}|${sl.slot}`;
      if (!grp[key]) grp[key] = {dps: new Set(), hasLocked: false};
      // 날짜 단위 충돌 판정(같은날 다가격=물량조절 합산, 다른날만 별개) — 2단계와 일관
      grp[key].dps.add(String(t.date));
      if (t.slotLocked) grp[key].hasLocked = true;
    }
  });
  const slotConflicts: any[] = [];
  for (const [key, g] of Object.entries(grp)) {
    if (g.dps.size >= 2 && !g.hasLocked) slotConflicts.push({key, units: g.dps.size});
  }

  const totalIssues = balanceIssues.length + avgIssues.length + slotConflicts.length;
  return {checkedStocks: stocksSnap.size, totalIssues, balanceIssues, avgIssues, slotConflicts};
}

// GET /diagHealthCheck — 수동 정합성 점검
export const diagHealthCheck = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const r = await runHealthCheck();
        res.json({success: true, ...r});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// 매일 16:10 KST 정기 헬스체크 — 먼저 잔고·평단 키움 보정 후 진단(이상 시에만 텔레그램)
//   ※ 15:50이었으나 kiwoomAutoSync(09:00~15:50 매 5분)의 마지막 실행과 동시 → 동기화
//   중간 상태를 읽어 슬롯충돌 오탐(13건 사례). 자동동기화·백필 완전 종료 후로 이동.
export const healthCheckCron = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 540, memory: "512MB"})
  .pubsub.schedule("10 16 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    try {
      // ✅ 근본 자동보정: 잔고는 맞아도 평단이 키움과 어긋난 종목(매도분 원가차감 미반영)을
      //   키움 buy_uv로 보정 → 진단 전에 정합. reconcile은 평단을 유지만 하므로 이 경로가 필요.
      try {
        const fixed = await runHoldingsTruth(true);
        if (fixed.mismatchCount > 0) console.log(`[holdingsTruth] 잔고·평단 보정 ${fixed.mismatchCount}종목`);
      } catch (e: any) {
        console.warn(`[holdingsTruth] 자동보정 실패: ${e.message}`);
      }
      const r = await runHealthCheck();
      if (r.totalIssues <= 0) {
        console.log("[healthCheck] 정합성 정상 (이상 0)");
        return;
      }
      let msg = `<b>⚠️ 태산 정합성 점검 — 이상 ${r.totalIssues}건</b>\n\n`;
      if (r.balanceIssues.length) {
        msg += `<b>잔고 불일치 ${r.balanceIssues.length}</b>\n`;
        for (const b of r.balanceIssues.slice(0, 8)) msg += `· ${b.name}: sys ${b.sys} ≠ 키움 ${b.kiwoom}\n`;
      }
      if (r.avgIssues.length) {
        msg += `<b>평단 불일치 ${r.avgIssues.length}</b>\n`;
        for (const a of r.avgIssues.slice(0, 8)) msg += `· ${a.name}: ${a.sys} ≠ ${a.kiwoom}\n`;
      }
      if (r.slotConflicts.length) {
        msg += `<b>슬롯 충돌 ${r.slotConflicts.length}</b>\n`;
        for (const c of r.slotConflicts.slice(0, 8)) msg += `· ${c.key}\n`;
      }
      await sendTelegram(msg);
    } catch (e: any) {
      console.error(`[healthCheck] 실패: ${e.message}`);
    }
  });

// 슬롯 충돌 진단(2단계 분류잠금 영향): GET /diagSlotConflict
//   전 종목 매도에서 같은 (종목, 라운드, 슬롯)에 서로 다른 주문(다른 날/가격/id)이
//   둘 이상 모인 케이스 전수 조사. = 2단계에서 "둘째부터 미분류"로 빠질 후보.
//   부분체결은 1단계 정본화로 1주문(merge)이라 여기선 다른 주문만 충돌로 잡힘.
export const diagSlotConflict = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const snap = await db.collection("trades").get();
        const groups: Record<string, Array<{id: string; date: string; price: number; qty: number}>> = {};
        snap.forEach((doc) => {
          const t = doc.data() as any;
          if (t.type !== "sell") return;
          const id = doc.id;
          const round = Number(t.sellRound) || 0;
          const stock = t.stockName || "";
          // effective slots: split이면 각 part, 단일 sellSlot이면 그 라벨
          let slots: Array<{slot: string; qty: number}> = [];
          if (Array.isArray(t.sellSlotSplit) && t.sellSlotSplit.length > 0) {
            slots = t.sellSlotSplit.map((sp: any) => ({slot: String(sp.slot || ""), qty: Number(sp.qty) || 0}));
          } else if (t.sellSlot && t.sellSlot !== "unmapped" && t.sellSlot !== "split") {
            slots = [{slot: String(t.sellSlot), qty: Number(t.quantity) || 0}];
          }
          for (const s of slots) {
            if (!s.slot || s.slot === "unmapped") continue;
            const key = `${stock}|R${round}|${s.slot}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push({id, date: t.date, price: Number(t.price) || 0, qty: s.qty});
          }
        });
        const conflicts: Array<Record<string, any>> = [];
        for (const [key, arr] of Object.entries(groups)) {
          // 충돌 단위 = 날짜. 같은 날(가격 달라도) = 물량조절 1단위(합산). 다른 날만 별개.
          const byDate: Record<string, {date: string; qty: number; ids: string[]; prices: number[]}> = {};
          for (const x of arr) {
            const k = String(x.date);
            if (!byDate[k]) byDate[k] = {date: x.date, qty: 0, ids: [], prices: []};
            byDate[k].qty += x.qty;
            byDate[k].ids.push(x.id);
            byDate[k].prices.push(x.price);
          }
          const units = Object.values(byDate).sort((a, b) => String(a.date).localeCompare(String(b.date)));
          if (units.length >= 2) {
            conflicts.push({
              key, unitCount: units.length,
              totalQty: arr.reduce((s, x) => s + x.qty, 0),
              keep: units[0], // 첫 날 = 슬롯 유지
              unmapped: units.slice(1), // 다른 날 = 미분류 대상
            });
          }
        }
        conflicts.sort((a, b) => b.unitCount - a.unitCount);
        res.json({
          success: true,
          conflictCount: conflicts.length,
          unmappedTradeCount: conflicts.reduce((s, c) => s + c.unmapped.reduce((q: number, u: any) => q + u.ids.length, 0), 0),
          conflicts,
        });
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// 매도 fallback↔ord_no 중복 진단: GET /diagSellDup
//   같은 종목+날짜+가격 그룹에 ord_no 매도(trade_kiwoom_숫자)와 fallback 매도
//   (trade_kiwoom_sell_…)가 공존하는 케이스 전수 조사.
//   근본 dedup 규칙(ord_no 존재 시 fallback 제거)의 안전성·영향 범위 검증용.
export const diagSellDup = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const snap = await db.collection("trades").get();
        const groups: Record<string, {ordno: any[]; fallback: any[]; other: any[]}> = {};
        snap.forEach((doc) => {
          const t = doc.data() as any;
          if (t.type !== "sell") return;
          const id = doc.id;
          const key = `${t.stockName}|${t.date}|${t.price}`;
          if (!groups[key]) groups[key] = {ordno: [], fallback: [], other: []};
          const item = {id, qty: Number(t.quantity) || 0, sellSlot: t.sellSlot || null};
          if (/^trade_kiwoom_sell_/.test(id)) groups[key].fallback.push(item);
          else if (/^trade_kiwoom_\d/.test(id)) groups[key].ordno.push(item);
          else groups[key].other.push(item); // 구포맷/manual 등
        });
        const dups: Array<Record<string, any>> = [];
        for (const [key, g] of Object.entries(groups)) {
          if (g.ordno.length > 0 && g.fallback.length > 0) {
            const ordSum = g.ordno.reduce((s, x) => s + x.qty, 0);
            const fbSum = g.fallback.reduce((s, x) => s + x.qty, 0);
            // fallback 합이 ord_no 매도 중 하나의 수량과 정확히 일치? (통합/부분 중복 강한 증거)
            const matchOrdQty = g.ordno.find((x) => x.qty === fbSum);
            // fallback 일부가 이미 슬롯 분류됨? (제거 시 분류 손실 위험 체크)
            const fbClassified = g.fallback.filter((x) => x.sellSlot && x.sellSlot !== "unmapped");
            dups.push({
              key, ordSum, fbSum,
              fbMatchesAnOrd: !!matchOrdQty,
              fbAllUnmapped: fbClassified.length === 0,
              ordno: g.ordno, fallback: g.fallback,
            });
          }
        }
        dups.sort((a, b) => (a.fbMatchesAnOrd === b.fbMatchesAnOrd ? 0 : a.fbMatchesAnOrd ? -1 : 1));
        res.json({
          success: true,
          dupGroupCount: dups.length,
          cleanMatch: dups.filter((d) => d.fbMatchesAnOrd && d.fbAllUnmapped).length,
          riskyGroups: dups.filter((d) => !d.fbMatchesAnOrd || !d.fbAllUnmapped).length,
          dups,
        });
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// 매도 수집 누락 진단: GET /diagSellGap[?date=20260616]
//   ka10076(sell_tp=0, 전체) 키움 당일 매도 vs trades 저장 매도를 종목별 대조.
//   ka10072만으로 놓친 매도(같은 가격·수량 충돌 등)의 영향 범위 검증용.
export const diagSellGap = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const kstNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
        const date = (req.query.date as string || "").replace(/-/g, "") ||
          `${kstNow.getFullYear()}${String(kstNow.getMonth() + 1).padStart(2, "0")}${String(kstNow.getDate()).padStart(2, "0")}`;
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        // source=kt00007(주문체결내역상세, ord_no·정확단가·신용 완비) 또는 ka10076(기본)
        const source = (req.query.source as string) === "kt00007" ? "kt00007" : "ka10076";
        const apiBody = source === "kt00007" ?
          {ord_dt: date, qry_tp: "1", stk_bond_tp: "0", sell_tp: "0", stk_cd: "", fr_ord_no: "", dmst_stex_tp: "%"} :
          {ord_dt: date, stk_cd: "", sell_tp: "0", qry_tp: "0", stk_bond_tp: "1", stex_tp: "1", dmst_stex_tp: "KRX"};
        const r = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
          method: "POST",
          headers: {"Content-Type": "application/json; charset=utf-8", "authorization": `Bearer ${token}`, "api-id": source},
          body: JSON.stringify(apiBody),
        });
        const data = await r.json() as any;
        let items: any[] = [];
        for (const k of Object.keys(data)) {
          if (Array.isArray(data[k]) && data[k].length > 0) { items = data[k]; break; }
        }
        const sells = items.filter((x: any) => String(x.io_tp_nm || "").includes("매도") && parseInt(x.cntr_qty || "0") > 0);
        const kiwoomByCode: Record<string, {name: string; qty: number; ords: string[]; detail: Record<string, any>}> = {};
        for (const s of sells) {
          const code = cleanKiwoomField(s.stk_cd).replace(/^A/, "");
          const qty = parseInt(s.cntr_qty || "0");
          const ord = String(s.ord_no || "").trim();
          const price = parseInt(s.cntr_uv || s.cntr_pric || s.ord_uv || "0");
          const isCredit = String(s.io_tp_nm || "").includes("신용") || String(s.io_tp_nm || "").includes("융자");
          if (!kiwoomByCode[code]) kiwoomByCode[code] = {name: cleanKiwoomField(s.stk_nm), qty: 0, ords: [], detail: {}};
          kiwoomByCode[code].qty += qty;
          if (ord) {
            kiwoomByCode[code].ords.push(ord);
            kiwoomByCode[code].detail[ord] = {qty, price, credit: isCredit, io: s.io_tp_nm};
          }
        }
        const dateDash = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
        const tsnap = await db.collection("trades").where("date", "==", dateDash).where("type", "==", "sell").get();
        const savedByCode: Record<string, {qty: number; ords: Set<string>}> = {};
        tsnap.forEach((doc) => {
          const t = doc.data() as any;
          const code = String(t.code || "").replace(/^A/, "");
          if (!savedByCode[code]) savedByCode[code] = {qty: 0, ords: new Set()};
          savedByCode[code].qty += Number(t.quantity) || 0;
          const m = doc.id.match(/^trade_kiwoom_(\d+)_/);
          if (m) savedByCode[code].ords.add(m[1]);
        });
        const gaps: Array<Record<string, any>> = [];
        for (const [code, kw] of Object.entries(kiwoomByCode)) {
          const saved = savedByCode[code] || {qty: 0, ords: new Set<string>()};
          const missingOrds = kw.ords.filter((o) => !saved.ords.has(o));
          if (kw.qty !== saved.qty || missingOrds.length > 0) {
            gaps.push({
              code, name: kw.name, kiwoomQty: kw.qty, savedQty: saved.qty, diff: kw.qty - saved.qty,
              missingOrds, missingDetail: missingOrds.map((o) => ({ord: o, ...kw.detail[o]})),
            });
          }
        }
        res.json({success: true, date: dateDash, kiwoomSellCodes: Object.keys(kiwoomByCode).length, gapCount: gaps.length, gaps});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

export const diagPlansConsistency = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const stocksSnap = await db.collection("stocks").get();
        const issues: Array<{
          docId: string;
          name: string;
          code: string;
          totalQuantity: number;
          avgPrice: number;
          buySum: number;
          sellPlanSum: number;
          maSellSum: number;
          computedRemain: number;
          discrepancy: number;
          mistakenlyCompleted: boolean;
        }> = [];
        let okCount = 0;

        stocksSnap.forEach((doc) => {
          const s = doc.data();
          const name = s.name;
          if (!name) return;
          const tq = Number(s.totalQuantity) || 0;
          const buyPlans = Array.isArray(s.buyPlans) ? s.buyPlans : [];
          const sellPlans = Array.isArray(s.sellPlans) ? s.sellPlans : [];
          const maSells = Array.isArray(s.maSells) ? s.maSells : [];

          let buySum = 0;
          for (const bp of buyPlans) {
            if (bp.filled) buySum += Number(bp.filledQuantity) || Number(bp.quantity) || 0;
          }
          let sellPlanSum = 0;
          for (const sp of sellPlans) {
            if (sp.filled) sellPlanSum += Number(sp.filledQuantity) || Number(sp.quantity) || 0;
          }
          let maSellSum = 0;
          for (const m of maSells) {
            if (m.filled) maSellSum += Number(m.quantity) || 0;
          }
          const computedRemain = buySum - sellPlanSum - maSellSum;
          const discrepancy = computedRemain - tq;

          // 매수 trade 없는 종목 (보유 0 + buyPlans 모두 미체결) 스킵
          if (buySum === 0 && tq === 0) return;

          if (Math.abs(discrepancy) > 0) {
            // 잘못 매매완료로 분류될 위험: computedRemain <= 0 인데 키움 잔고 > 0
            const mistakenlyCompleted = computedRemain <= 0 && tq > 0;
            issues.push({
              docId: doc.id,
              name,
              code: s.code || "",
              totalQuantity: tq,
              avgPrice: Number(s.avgPrice) || 0,
              buySum,
              sellPlanSum,
              maSellSum,
              computedRemain,
              discrepancy,
              mistakenlyCompleted,
            });
          } else {
            okCount++;
          }
        });

        // 매매완료 오표시 우선순위로 정렬
        issues.sort((a, b) => {
          if (a.mistakenlyCompleted !== b.mistakenlyCompleted) {
            return a.mistakenlyCompleted ? -1 : 1;
          }
          return Math.abs(b.discrepancy) - Math.abs(a.discrepancy);
        });

        res.json({
          success: true,
          totalStocks: stocksSnap.size,
          okCount,
          issueCount: issues.length,
          mistakenlyCompletedCount: issues.filter((x) => x.mistakenlyCompleted).length,
          issues,
        });
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

// ═══════════════════════════════════════════════════════════════
// 방안 B: 매도 trade 라운드+슬롯 태깅 (근본적 중복 차단)
// ═══════════════════════════════════════════════════════════════
//
// 각 매도 trade에 sellRound(라운드) + sellSlot(차수)를 직접 기록.
// 1 매도 trade = 1 라운드 + 1 슬롯 → 같은 매도가 두 곳에 뜨는 중복 물리적 불가.
//
// 태깅 규칙:
//   sellRound = 매도일 직전 마지막 매수 차수 (1차 라운드, 2차 라운드 ...)
//   sellSlot  = 라운드 평단 대비 수익률 band
//     · profit < 2.5%  → 'unmapped' (손실/MA 매도 후보 — 사용자가 MA로 분류)
//     · 2.5~7.5%       → '+5%'
//     · 7.5~12.5%      → '+10%'
//     · 12.5~17.5%     → '+15%'
//     · 17.5~22.5%     → '+20%'
//     · 22.5%+         → '+25%'
//
// 같은 (round, slot)에 여러 trade(부분체결)는 정상 — UI에서 합산 표시.

interface SellTagResult {
  tradeId: string;
  date: string;
  price: number;
  quantity: number;
  sellRound: number;
  sellSlot: string;
}

function computeSellTags(
  buyTrades: Array<{date: string; price: number; quantity: number}>,
  sellTrades: Array<{id: string; date: string; price: number; quantity: number}>
): SellTagResult[] {
  const normD = (d: string): string => {
    if (!d) return "";
    if (d.length === 8 && !d.includes("-")) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return d;
  };
  // 매수 이벤트 (날짜별 그룹 → 라운드)
  const buyByDate: Record<string, {qty: number; amt: number}> = {};
  for (const b of buyTrades) {
    const d = normD(b.date);
    if (!d) continue;
    const q = Number(b.quantity) || 0;
    const p = Number(b.price) || 0;
    if (q <= 0) continue;
    if (!buyByDate[d]) buyByDate[d] = {qty: 0, amt: 0};
    buyByDate[d].qty += q;
    buyByDate[d].amt += p * q;
  }
  const buyDates = Object.keys(buyByDate).sort();

  // 매도일 시점의 라운드 번호 + 누적 평단
  const roundAndAvgAt = (sellDate: string): {round: number; avg: number} => {
    let round = 0;
    let cumAmt = 0;
    let cumQty = 0;
    for (let i = 0; i < buyDates.length; i++) {
      if (buyDates[i] <= sellDate) {
        round = i + 1; // i번째 매수일 = (i+1)차 라운드
        cumAmt += buyByDate[buyDates[i]].amt;
        cumQty += buyByDate[buyDates[i]].qty;
      }
    }
    const avg = cumQty > 0 ? cumAmt / cumQty : 0;
    return {round: Math.max(1, round), avg};
  };

  const bandSlot = (profitPct: number): string => {
    if (profitPct < 2.5) return "unmapped"; // 손실/MA 후보
    if (profitPct < 7.5) return "+5%";
    if (profitPct < 12.5) return "+10%";
    if (profitPct < 17.5) return "+15%";
    if (profitPct < 22.5) return "+20%";
    return "+25%";
  };

  const results: SellTagResult[] = [];
  for (const t of sellTrades) {
    const sd = normD(t.date);
    const {round, avg} = roundAndAvgAt(sd);
    const price = Number(t.price) || 0;
    const profitPct = avg > 0 ? (price / avg - 1) * 100 : 0;
    const slot = bandSlot(profitPct);
    results.push({
      tradeId: t.id,
      date: sd,
      price,
      quantity: Number(t.quantity) || 0,
      sellRound: round,
      sellSlot: slot,
    });
  }
  return results;
}

/**
 * 매도 trade 태깅 마이그레이션 (전 종목 또는 단일 종목)
 * POST /migrateSellTags  body: { stockName?: string }
 *
 * 각 매도 trade에 sellRound + sellSlot 기록.
 * MA 매도는 기존 maSells consumedTradeIds 기반으로 'MA20'/'MA60'/'MA120' 보존.
 */
export const migrateSellTags = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540, memory: "512MB"})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const onlyStock = (req.body && req.body.stockName) || null;

        // 종목별 처리
        const stocksSnap = await db.collection("stocks").get();
        let processedStocks = 0;
        let taggedTrades = 0;
        const sample: any[] = [];

        for (const doc of stocksSnap.docs) {
          const stock = doc.data();
          const name = stock.name;
          if (!name) continue;
          if (onlyStock && name !== onlyStock) continue;

          const tradesSnap = await db.collection("trades").where("stockName", "==", name).get();
          if (tradesSnap.empty) continue;

          const buyTrades: any[] = [];
          const sellTrades: any[] = [];
          tradesSnap.forEach((d) => {
            const t = d.data();
            if (t.type === "buy") buyTrades.push({date: t.date, price: t.price, quantity: t.quantity});
            else if (t.type === "sell") sellTrades.push({id: d.id, date: t.date, price: t.price, quantity: t.quantity});
          });
          if (sellTrades.length === 0) continue;

          // MA 매도 trade id → MA 슬롯 매핑 (기존 maSells consumedTradeIds 기반)
          const maSlotByTradeId: Record<string, string> = {};
          for (const m of (Array.isArray(stock.maSells) ? stock.maSells : [])) {
            if (m.filled && Array.isArray(m.consumedTradeIds)) {
              for (const id of m.consumedTradeIds) {
                maSlotByTradeId[String(id)] = `MA${m.ma}`;
              }
            }
          }

          const tags = computeSellTags(buyTrades, sellTrades);
          const batch = db.batch();
          for (const tag of tags) {
            // MA 매도면 MA 슬롯 우선 (band 분류보다)
            const finalSlot = maSlotByTradeId[tag.tradeId] || tag.sellSlot;
            batch.update(db.collection("trades").doc(tag.tradeId), {
              sellRound: tag.sellRound,
              sellSlot: finalSlot,
            });
            taggedTrades++;
            if (sample.length < 15) {
              sample.push({stock: name, date: tag.date, price: tag.price, qty: tag.quantity, round: tag.sellRound, slot: finalSlot});
            }
          }
          await batch.commit();
          processedStocks++;
        }

        res.json({success: true, processedStocks, taggedTrades, sample});
      } catch (error: any) {
        console.error("[migrateSellTags] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 진단: 종목코드로 trades 조회 (동명이인/잘못된 매핑 추적용)
 * GET /diagByCode?code=153460
 */
export const diagByCode = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const codeRaw = (req.query.code as string) || "";
        const codeClean = codeRaw.replace(/^A/, "").replace(/^\*+/, "");
        if (!codeClean) {
          res.status(400).json({success: false, error: "code 파라미터 필수"});
          return;
        }

        // trades에서 code 매칭 (A 접두사 양쪽 처리)
        const variants = [codeClean, `A${codeClean}`, `*${codeClean}`, `*A${codeClean}`];
        const tradesByCode: any[] = [];
        const tradesSnap = await db.collection("trades").get();
        tradesSnap.forEach((doc) => {
          const t = doc.data();
          const tCode = String(t.code || "").replace(/^A/, "").replace(/^\*+/, "");
          if (tCode === codeClean) {
            tradesByCode.push({id: doc.id, ...t});
          }
        });

        // stocks에서 code 매칭
        const stocksByCode: any[] = [];
        const stocksSnap = await db.collection("stocks").get();
        stocksSnap.forEach((doc) => {
          const s = doc.data();
          const sCode = String(s.code || "").replace(/^A/, "").replace(/^\*+/, "");
          if (sCode === codeClean) {
            stocksByCode.push({
              docId: doc.id,
              name: s.name,
              code: s.code,
              totalQuantity: s.totalQuantity,
              avgPrice: s.avgPrice,
              firstBuyPrice: s.firstBuyPrice,
              firstBuyQuantity: s.firstBuyQuantity,
              // ── 룰B 진단 필드 ──
              rule: s.rule || null,
              ruleBActive: s.ruleBActive || false,
              bottomPrice: s.bottomPrice || null,
              bottomPriceDate: s.bottomPriceDate || null,
              bottomPriceSource: s.bottomPriceSource || null,
              referencePeakPrice: s.referencePeakPrice || null,
              referencePeakDate: s.referencePeakDate || null,
              sellsSinceLastBuy: s.sellsSinceLastBuy ?? null,
              sellPlansFilled: (s.sellPlans || [])
                .filter((p: any) => p?.filled)
                .map((p: any) => ({percent: p.percent, date: p.filledDate, price: p.filledPrice, qty: p.filledQuantity || p.quantity, consumedTradeIds: p.consumedTradeIds || null, manualOverride: p.manualOverride || false})),
              maSellsFilled: (s.maSells || [])
                .filter((m: any) => m?.filled)
                .map((m: any) => ({ma: m.ma, date: m.filledDate, qty: m.quantity, consumedTradeIds: m.consumedTradeIds || null})),
              buyPlansRule: (s.buyPlans || [])
                .map((b: any) => ({level: b.level, filled: b.filled, rule: b.rule || null, price: b.price, filledDate: b.filledDate || null, manualOverride: b.manualOverride || false})),
              isCreditTrade: s.isCreditTrade || false,
              positions: (s.positions || []).map((p: any) => ({type: p.type, quantity: p.quantity, avgPrice: p.avgPrice, since: p.since || null, dueDate: p.dueDate || null})),
            });
          }
        });

        res.json({
          success: true,
          codeQuery: codeClean,
          variants,
          stocksByCode,
          tradesByCode: tradesByCode.slice(0, 20),
          tradesByCodeCount: tradesByCode.length,
        });
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

// 일봉 정밀 진단: ?code=138610&from=20251215&to=20260423
//   KRX 단독(code) vs 통합(_AL) 일봉을 from~to 구간으로 비교, 각 최저가 표시
export const diagDailyChart = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 60,
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const codeRaw = (req.query.code as string || "").replace(/^A/, "").trim();
        if (!codeRaw) {
          res.status(400).json({success: false, error: "code 필수"});
          return;
        }
        const from = (req.query.from as string || "").replace(/-/g, "");
        const to = (req.query.to as string || "").replace(/-/g, "");
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);

        const summarize = async (stkCd: string) => {
          const candles = await fetchDailyChart(config, token, stkCd, from || undefined);
          const inRange = candles.filter((c) => {
            const d = c.date.replace(/-/g, "");
            if (from && d < from) return false;
            if (to && d > to) return false;
            return true;
          });
          let min = Infinity; let minDate = "";
          for (const c of inRange) {
            if (c.low > 0 && c.low < min) { min = c.low; minDate = c.date; }
          }
          return {
            stkCd,
            count: inRange.length,
            minLow: min === Infinity ? null : min,
            minLowDate: minDate || null,
            // from~to 구간 전체 일봉 (date, low) — 날짜순
            lows: inRange
              .slice()
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((c) => ({date: c.date, low: c.low, open: c.open, high: c.high, close: c.close})),
          };
        };

        const [krx, al] = await Promise.all([
          summarize(codeRaw),
          summarize(`${codeRaw}_AL`),
        ]);

        res.json({success: true, code: codeRaw, from, to, krx, al});
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

// Phase 2b 대상 전수조사: GET /diagRuleBStages
//   단일 bottomPrice로는 부정확한 종목 = 룰B 차수가 2+ OR 룰B 차수 이후 매도 존재
//   (룰B 차수별로 윈도우[refPeak~그 차수 직전 매도]가 달라 차수별 저점 필요)
export const diagRuleBStages = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const snap = await db.collection("stocks").get();
        const norm = (d: string) => (d && d.length === 8 && !d.includes("-")) ?
          `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : (d || "");
        const flagged: any[] = [];
        const allRuleB: any[] = [];
        snap.forEach((doc) => {
          const s = doc.data() as any;
          const buyPlans = s.buyPlans || [];
          const ruleBBuys = buyPlans.filter((b: any) => b?.rule === "B" && b?.filled && b?.filledDate)
            .map((b: any) => ({level: b.level, date: norm(String(b.filledDate))}));
          if (ruleBBuys.length === 0) return;

          // 매도일 모음
          const sellDates: string[] = [];
          for (const p of (s.sellPlans || [])) {
            if ((p?.filled || (p?.filledQuantity || 0) > 0) && p.filledDate) sellDates.push(norm(String(p.filledDate)));
          }
          for (const m of (s.maSells || [])) {
            if (m?.filled && m.filledDate) sellDates.push(norm(String(m.filledDate)));
          }

          // 각 룰B 차수 이후 매도 존재 여부
          const stagesWithLaterSells = ruleBBuys.filter((rb: any) =>
            sellDates.some((sd) => sd > rb.date));
          const risk = ruleBBuys.length >= 2 || stagesWithLaterSells.length > 0;

          const row = {
            name: s.name, code: s.code,
            ruleBStageCount: ruleBBuys.length,
            ruleBStages: ruleBBuys,
            sellDates: sellDates.sort(),
            stagesWithLaterSells: stagesWithLaterSells.map((r: any) => r.level),
            bottomPrice: s.bottomPrice || null,
            risk,
          };
          allRuleB.push(row);
          if (risk) flagged.push(row);
        });
        res.json({
          success: true,
          totalRuleBStocks: allRuleB.length,
          phase2bNeeded: flagged.length,
          flagged,
          allRuleB,
        });
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

// 보유종목 룰B 상태 일괄 진단: GET /diagRuleBStatus
//   각 보유종목의 rule / 매도카운트 / 기준최고가 / 저점 + 룰B 후보(미전환) 플래그
export const diagRuleBStatus = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const snap = await db.collection("stocks").get();
        const rows: any[] = [];
        snap.forEach((doc) => {
          const s = doc.data() as any;
          const qty = Number(s.totalQuantity) || 0;
          if (qty <= 0) return; // 보유종목만
          const sells = Number(s.sellsSinceLastBuy) || 0;
          const hasPeak = Number(s.referencePeakPrice) > 0;
          const isB = s.rule === "B";
          rows.push({
            name: s.name,
            code: s.code,
            rule: s.rule || "A",
            sellsSinceLastBuy: sells,
            referencePeakPrice: s.referencePeakPrice || null,
            referencePeakDate: s.referencePeakDate || null,
            bottomPrice: s.bottomPrice || null,
            bottomPriceDate: s.bottomPriceDate || null,
            bottomPriceSource: s.bottomPriceSource || null,
            // 룰B 후보(미전환): 매도 3회+ && 아직 룰B 아님
            ruleBCandidate: sells >= 3 && !isB,
            // 그 중 기준최고가 유무 (있으면 자동전환 가능 / 없으면 입력 필요)
            needsPeakInput: sells >= 3 && !isB && !hasPeak,
          });
        });
        // 정렬: 후보 먼저, 그다음 매도카운트 내림차순
        rows.sort((a, b) =>
          (Number(b.ruleBCandidate) - Number(a.ruleBCandidate)) ||
          (b.sellsSinceLastBuy - a.sellsSinceLastBuy));
        res.json({
          success: true,
          total: rows.length,
          ruleBActive: rows.filter((r) => r.rule === "B").length,
          candidates: rows.filter((r) => r.ruleBCandidate).length,
          rows,
        });
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

// 매도 슬롯 중복(이중 카운트) 전수조사: GET /diagSellMapping
//   매핑 매도수량(sellPlans filled + maSells filled) vs 실제 매도수량(매수합-보유)
//   불일치(보통 MA슬롯과 프로필슬롯에 같은 거래가 중복 매핑) 종목을 찾아냄
export const diagSellMapping = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const snap = await db.collection("stocks").get();
        const problems: any[] = [];
        const all: any[] = [];
        snap.forEach((doc) => {
          const s = doc.data() as any;
          const buyPlans = s.buyPlans || [];
          const sellPlans = s.sellPlans || [];
          const maSells = s.maSells || [];

          const qFilled = (p: any) =>
            (p?.filled || (p?.filledQuantity || 0) > 0)
              ? (p.filledQuantity || p.quantity || 0) : 0;

          const boughtQty = buyPlans.reduce((sum: number, b: any) => sum + qFilled(b), 0);
          const holdingQty = Number(s.totalQuantity) || 0;
          const actualSoldQty = Math.max(0, boughtQty - holdingQty);

          const sellPlanSold = sellPlans.reduce((sum: number, p: any) => sum + qFilled(p), 0);
          const maSold = maSells.reduce((sum: number, m: any) => sum + qFilled(m), 0);
          const mappedSoldQty = sellPlanSold + maSold;

          const row = {
            name: s.name, code: s.code,
            boughtQty, holdingQty, actualSoldQty,
            mappedSoldQty, sellPlanSold, maSold,
            diff: mappedSoldQty - actualSoldQty,
            sellPlansFilledCount: sellPlans.filter((p: any) => qFilled(p) > 0).length,
            maSellsFilledCount: maSells.filter((m: any) => qFilled(m) > 0).length,
          };
          all.push(row);
          // 매핑 > 실제 = 중복(이중카운트). 매핑 < 실제 = 매핑 누락.
          if (boughtQty > 0 && row.diff !== 0) problems.push(row);
        });
        problems.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
        res.json({
          success: true,
          totalHoldings: all.filter((r) => r.holdingQty > 0 || r.actualSoldQty > 0).length,
          problemCount: problems.length,
          problems,
        });
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

// 매도 슬롯 중복 정리: GET /fixSellMapping?code=000250[&apply=true]
//   maSells(consumedTradeIds=MA의도) 유지 + 프로필 슬롯을 거래로 클린 재구성
//   (manualOverride 무시하고 재빌드 → 유령/중복 슬롯 제거). apply 없으면 dry-run.
export const fixSellMapping = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const codeClean = (req.query.code as string || "").replace(/^A/, "").trim();
        const apply = String(req.query.apply || "") === "true";
        if (!codeClean) {
          res.status(400).json({success: false, error: "code 필수"});
          return;
        }

        // stock 문서 찾기 (code 매칭)
        const stocksSnap = await db.collection("stocks").get();
        let docId = ""; let stock: any = null;
        stocksSnap.forEach((doc) => {
          const s = doc.data();
          if (String(s.code || "").replace(/^A/, "") === codeClean) { docId = doc.id; stock = s; }
        });
        if (!stock) {
          res.status(404).json({success: false, error: "종목 없음"});
          return;
        }

        // trades 로드 (code 매칭) → mapTradesToPlans 입력 형태로 변환
        const tradesSnap = await db.collection("trades").get();
        const trades: any[] = [];
        tradesSnap.forEach((doc) => {
          const t = doc.data();
          if (String(t.code || "").replace(/^A/, "") === codeClean) {
            trades.push({
              name: stock.name,
              type: t.type, date: t.date, time: t.time || "",
              price: t.price, quantity: t.quantity,
              orderNo: t.orderNo, code: t.code,
            });
          }
        });

        const holdingsLike = {name: stock.name, code: stock.code, avgPrice: stock.avgPrice, quantity: stock.totalQuantity};
        const ruleConfig = {rule: stock.rule, bottomPrice: stock.bottomPrice, sellsSinceLastBuy: stock.sellsSinceLastBuy};
        const mapped = mapTradesToPlans(trades, stock.name, holdingsLike, ruleConfig, stock.maSells);

        // 새 sellPlans: manualOverride 제거 (클린 재구성)
        const newSellPlans = mapped.sellPlans.map((p: any) => ({...p, manualOverride: false}));

        const before = {
          sellPlans: (stock.sellPlans || []).map((p: any) => ({percent: p.percent, filled: !!p.filled, qty: p.filledQuantity || 0, price: p.filledPrice || 0, manual: !!p.manualOverride, consumed: p.consumedTradeIds || null})),
          maSells: (stock.maSells || []).filter((m: any) => m.filled).map((m: any) => ({ma: m.ma, qty: m.quantity, consumed: m.consumedTradeIds || null})),
        };
        const after = {
          sellPlans: newSellPlans.map((p: any) => ({percent: p.percent, filled: !!p.filled, qty: p.filledQuantity || 0, price: p.filledPrice || 0, consumed: p.consumedTradeIds || null})),
          maSells: before.maSells, // maSells 유지
        };

        if (apply) {
          await db.collection("stocks").doc(docId).update({sellPlans: newSellPlans, updatedAt: Date.now()});
        }

        res.json({success: true, code: codeClean, name: stock.name, applied: apply, before, after});
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

export const inspectStockTrades = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const stockName =
          (req.query.stockName as string) ||
          (req.body && req.body.stockName) ||
          null;

        if (!stockName) {
          res.status(400).json({success: false, error: "stockName 필수"});
          return;
        }

        // 종목 정보
        const stockSnap = await db
          .collection("stocks")
          .where("name", "==", stockName)
          .limit(1)
          .get();
        const stock = stockSnap.empty ? null : stockSnap.docs[0].data();

        // 종목 trades 전체
        const tradesSnap = await db
          .collection("trades")
          .where("stockName", "==", stockName)
          .get();

        const trades = tradesSnap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            isKiwoom: d.id.startsWith("trade_kiwoom_"),
            date: data.date,
            type: data.type,
            price: data.price,
            quantity: data.quantity,
            memo: data.memo,
            isCreditTrade: data.isCreditTrade,
            sellRound: data.sellRound,
            sellSlot: data.sellSlot,
            sellSlotSplit: data.sellSlotSplit || null,
            slotLocked: data.slotLocked || false,
            createdAt: data.createdAt,
          };
        });

        // 날짜+타입별 집계
        const byDateType: Record<string, {date: string; type: string; qty: number; amt: number; tradeCount: number; tradeIds: string[]}> = {};
        for (const t of trades) {
          if (!t.date) continue;
          const key = `${t.date}_${t.type}`;
          if (!byDateType[key]) {
            byDateType[key] = {date: t.date, type: t.type, qty: 0, amt: 0, tradeCount: 0, tradeIds: []};
          }
          byDateType[key].qty += Number(t.quantity) || 0;
          byDateType[key].amt += (Number(t.price) || 0) * (Number(t.quantity) || 0);
          byDateType[key].tradeCount += 1;
          byDateType[key].tradeIds.push(t.id);
        }

        const dateGroups = Object.values(byDateType).sort((a, b) => {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          return a.type.localeCompare(b.type);
        });

        // 매수/매도 고유 날짜 수
        const buyDates = new Set<string>();
        const sellDates = new Set<string>();
        for (const g of dateGroups) {
          if (g.type === "buy") buyDates.add(g.date);
          if (g.type === "sell") sellDates.add(g.date);
        }

        res.json({
          success: true,
          stockName,
          hasStock: !!stock,
          stock: stock
            ? {
              totalQuantity: stock.totalQuantity,
              avgPrice: stock.avgPrice,
              isCreditTrade: stock.isCreditTrade,
              positions: stock.positions,
              buyPlansCount: (stock.buyPlans || []).length,
              sellPlansCount: (stock.sellPlans || []).length,
              buyPlans: stock.buyPlans,
              sellPlans: stock.sellPlans,
              maSells: stock.maSells,
              corporateActions: stock.corporateActions,
              firstBuyPrice: stock.firstBuyPrice,
              firstBuyQuantity: stock.firstBuyQuantity,
            }
            : null,
          tradesTotal: trades.length,
          kiwoomTrades: trades.filter((t) => t.isKiwoom).length,
          manualTrades: trades.filter((t) => !t.isKiwoom).length,
          uniqueBuyDates: buyDates.size,
          uniqueSellDates: sellDates.size,
          dateGroups,
          exceedsAnalysis: {
            buyPlansCount: (stock?.buyPlans || []).length,
            uniqueBuyDatesCount: buyDates.size,
            exceedsBuy: Math.max(0, buyDates.size - (stock?.buyPlans || []).length),
            sellPlansCount: (stock?.sellPlans || []).length,
            uniqueSellDatesCount: sellDates.size,
            exceedsSell: Math.max(0, sellDates.size - (stock?.sellPlans || []).length),
          },
          trades,
        });
      } catch (error: any) {
        console.error("[inspect] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 야간 자동 reconciliation (B안 보조)
 * 매일 새벽 3시 KST에 모든 종목의 trades ↔ buyPlans 대사 실행
 * - C안 트리거가 실패/누락된 경우에 대비한 safety net
 * - 대사 후 불일치 발견 건은 자동 보정 + 로그
 */
export const nightlyReconcile = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540})
  .pubsub.schedule("0 3 * * *")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    const startedAt = Date.now();
    console.log("[nightlyReconcile] 시작");

    try {
      // trade_kiwoom_* 가 있는 모든 종목 수집
      const tradesSnap = await db.collection("trades").get();
      const nameSet = new Set<string>();
      tradesSnap.forEach((doc) => {
        if (!doc.id.startsWith("trade_kiwoom_")) return;
        const name = (doc.data() as any).stockName;
        if (name) nameSet.add(name);
      });

      const stockNames = Array.from(nameSet);
      let totalUpdated = 0;
      let totalBuyFilled = 0;
      let totalSellFilled = 0;
      let totalExceedsBuy = 0;
      let totalExceedsSell = 0;
      let failedCount = 0;

      for (const name of stockNames) {
        try {
          const r = await reconcileStockPlans(name);
          if (r.updated) totalUpdated++;
          totalBuyFilled += r.buyFilled;
          totalSellFilled += r.sellFilled;
          totalExceedsBuy += r.exceedsBuy;
          totalExceedsSell += r.exceedsSell;
        } catch (err: any) {
          failedCount++;
          console.error(`[nightlyReconcile] ${name} 실패:`, err.message);
        }
      }

      const elapsed = Date.now() - startedAt;
      const summary = {
        timestamp: startedAt,
        totalStocks: stockNames.length,
        updated: totalUpdated,
        buyFilled: totalBuyFilled,
        sellFilled: totalSellFilled,
        exceedsBuy: totalExceedsBuy,
        exceedsSell: totalExceedsSell,
        failedCount,
        elapsedMs: elapsed,
      };

      // 대사 로그를 Firestore에 기록 (최근 30일치만 자동 유지)
      await db.collection("reconcileLogs").add(summary);
      await db.collection("settings").doc("lastReconcile").set(summary);

      console.log(
        `[nightlyReconcile] 완료: ${totalUpdated}/${stockNames.length}종목 갱신, ` +
          `매수 ${totalBuyFilled}차, 매도 ${totalSellFilled}차, ` +
          `초과 매수 ${totalExceedsBuy} 매도 ${totalExceedsSell}, ${elapsed}ms`
      );

      // 오래된 로그 정리 (30일 초과분)
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const oldLogs = await db
        .collection("reconcileLogs")
        .where("timestamp", "<", cutoff)
        .get();
      const batch = db.batch();
      oldLogs.forEach((doc) => batch.delete(doc.ref));
      if (!oldLogs.empty) {
        await batch.commit();
        console.log(`[nightlyReconcile] 오래된 로그 ${oldLogs.size}건 삭제`);
      }
    } catch (err: any) {
      console.error("[nightlyReconcile] 전체 실패:", err.message);
      await db.collection("settings").doc("lastReconcile").set({
        timestamp: startedAt,
        error: err.message,
        elapsedMs: Date.now() - startedAt,
      });
    }

    return null;
  });

/**
 * 키움 체결 중복 제거 (A안)
 * 증상: 수동 키움 동기화 시 같은 orderNo 체결이 여러 날짜로 복제 기록되는 버그
 *       (예: 티엘비 orderNo=0510362 가 65개 날짜로 복제)
 *
 * 로직:
 *   1) 구포맷 `trade_kiwoom_${YYYYMMDD}_${orderNo}_${code}` 문서만 스캔
 *      (신포맷 `trade_kiwoom_${orderNo}_${code}` 는 이미 자연 유니크 → 스킵)
 *   2) `orderNo_code` 로 그룹핑
 *   3) 그룹에 2건 이상이면 중복 — 가장 이른 날짜(같으면 가장 이른 createdAt) 1건만 남기고 삭제
 *   4) 남기는 1건은 신포맷 ID로 마이그레이션 (복사 → 삭제) → 재동기화 시 중복 방지
 *   5) 영향받은 종목 자동 reconcile
 *
 * 안전장치: 기본 dry-run. 실제 실행은 ?execute=true 명시 필요.
 *
 * GET  /dedupeTrades                   → dry-run (삭제 없음, 리포트만)
 * GET  /dedupeTrades?execute=true      → 실제 삭제 + 마이그레이션 + reconcile
 * GET  /dedupeTrades?stockName=XXX     → 특정 종목만
 */
export const dedupeTrades = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const execute = req.query.execute === "true" ||
          (req.body && req.body.execute === true);
        const stockNameFilter =
          (req.query.stockName as string) ||
          (req.body && req.body.stockName) ||
          null;

        const tradesSnap = await db.collection("trades").get();

        // 구포맷만 매치: trade_kiwoom_YYYYMMDD_orderNo(숫자)_code(숫자)
        // 신포맷 `trade_kiwoom_${orderNo}_${code}` 및 autosync 포맷은 자동 제외
        const oldFormatRegex = /^trade_kiwoom_(\d{8})_(\d+)_(\d+)$/;

        const groups: Record<string, Array<{
          id: string;
          date: string;
          orderNo: string;
          code: string;
          data: any;
          createdAt: number;
        }>> = {};

        tradesSnap.forEach((doc) => {
          const match = doc.id.match(oldFormatRegex);
          if (!match) return;
          const [, date, orderNo, code] = match;
          const data = doc.data() as any;

          // 종목명 필터
          if (stockNameFilter && data.stockName !== stockNameFilter) return;

          const key = `${orderNo}_${code}`;
          if (!groups[key]) groups[key] = [];
          groups[key].push({
            id: doc.id,
            date,
            orderNo,
            code,
            data,
            createdAt: (data.createdAt as number) || 0,
          });
        });

        // 중복 그룹만 추출
        const dupEntries = Object.entries(groups).filter(
          ([, arr]) => arr.length > 1
        );

        const reports: any[] = [];
        const affectedStocks = new Set<string>();
        let totalDeleted = 0;
        let totalMigrated = 0;

        for (const [key, arr] of dupEntries) {
          // 유지 기준: 가장 이른 date → 같으면 가장 이른 createdAt
          arr.sort((a, b) => {
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return a.createdAt - b.createdAt;
          });
          const keep = arr[0];
          const remove = arr.slice(1);
          const newId = `trade_kiwoom_${keep.orderNo}_${keep.code}`;
          const willMigrate = keep.id !== newId;

          const report = {
            orderKey: key,
            stockName: keep.data.stockName,
            type: keep.data.type,
            quantity: keep.data.quantity,
            price: keep.data.price,
            keepId: keep.id,
            keepDate: keep.date,
            migrateTo: willMigrate ? newId : null,
            removeCount: remove.length,
            removeIds: execute ? undefined : remove.map((r) => r.id),
            sampleRemoveIds: execute ? remove.slice(0, 3).map((r) => r.id) : undefined,
            totalDatesDuplicated: arr.length,
          };
          reports.push(report);
          affectedStocks.add(keep.data.stockName);

          if (execute) {
            // 1) 중복 삭제 (batch 400개씩)
            for (let i = 0; i < remove.length; i += 400) {
              const chunk = remove.slice(i, i + 400);
              const batch = db.batch();
              chunk.forEach((r) =>
                batch.delete(db.collection("trades").doc(r.id))
              );
              await batch.commit();
              totalDeleted += chunk.length;
            }

            // 2) keep 문서를 신포맷 ID로 마이그레이션
            if (willMigrate) {
              const newRef = db.collection("trades").doc(newId);
              const existing = await newRef.get();
              if (!existing.exists) {
                // 신포맷 ID로 복사 (orderNo/code 필드 추가)
                await newRef.set({
                  ...keep.data,
                  orderNo: keep.orderNo,
                  code: keep.code,
                  migratedFrom: keep.id,
                  migratedAt: Date.now(),
                });
                // 구포맷 삭제
                await db.collection("trades").doc(keep.id).delete();
                totalMigrated++;
              } else {
                // 이미 신포맷이 있으면 구포맷만 삭제 (중복)
                await db.collection("trades").doc(keep.id).delete();
                totalDeleted++;
              }
            }
          }
        }

        // 영향받은 종목 reconcile (실행 시에만)
        let reconcileCount = 0;
        if (execute) {
          for (const name of affectedStocks) {
            try {
              const r = await reconcileStockPlans(name);
              if (r.updated) reconcileCount++;
            } catch (err: any) {
              console.error(`[dedupe] reconcile 실패 ${name}:`, err.message);
            }
          }
        }

        const summary = {
          success: true,
          dryRun: !execute,
          scannedTotal: tradesSnap.size,
          duplicateGroups: dupEntries.length,
          totalDuplicatesFound: dupEntries.reduce(
            (s, [, arr]) => s + arr.length - 1, 0
          ),
          affectedStocks: Array.from(affectedStocks),
          deleted: totalDeleted,
          migrated: totalMigrated,
          reconciled: reconcileCount,
          reports: reports.sort(
            (a, b) => b.removeCount - a.removeCount
          ),
        };

        console.log(
          `[dedupe] ${execute ? "실행" : "dry-run"}: ` +
            `그룹 ${dupEntries.length}, 중복 ${summary.totalDuplicatesFound}건, ` +
            `삭제 ${totalDeleted}, 마이그레이션 ${totalMigrated}, ` +
            `reconcile ${reconcileCount}`
        );

        res.json(summary);
      } catch (error: any) {
        console.error("[dedupe] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 백필 엔드포인트: 기존 trade_kiwoom_* 문서 전체를 일괄 재처리
 * GET  /backfillBuyPlans                   → 모든 종목 reconcile
 * GET  /backfillBuyPlans?stockName=XXX     → 특정 종목만
 * POST /backfillBuyPlans  body: {stockName?}
 */
export const backfillBuyPlans = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 300})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const stockNameFilter =
          (req.query.stockName as string) ||
          (req.body && req.body.stockName) ||
          null;

        // 처리할 종목 목록 결정
        let stockNames: string[] = [];
        if (stockNameFilter) {
          stockNames = [stockNameFilter];
        } else {
          // trade_kiwoom_* 가 있는 모든 종목 수집
          const tradesSnap = await db.collection("trades").get();
          const nameSet = new Set<string>();
          tradesSnap.forEach((doc) => {
            if (!doc.id.startsWith("trade_kiwoom_")) return;
            const name = (doc.data() as any).stockName;
            if (name) nameSet.add(name);
          });
          stockNames = Array.from(nameSet);
        }

        console.log(`[backfill] 시작: ${stockNames.length}종목`);

        const results: any[] = [];
        let totalUpdated = 0;
        let totalBuyFilled = 0;
        let totalSellFilled = 0;
        let totalExceedsBuy = 0;
        let totalExceedsSell = 0;

        for (const name of stockNames) {
          try {
            const r = await reconcileStockPlans(name);
            if (r.updated) totalUpdated++;
            totalBuyFilled += r.buyFilled;
            totalSellFilled += r.sellFilled;
            totalExceedsBuy += r.exceedsBuy;
            totalExceedsSell += r.exceedsSell;
            results.push({
              stockName: name,
              updated: r.updated,
              buyFilled: r.buyFilled,
              sellFilled: r.sellFilled,
              exceedsBuy: r.exceedsBuy,
              exceedsSell: r.exceedsSell,
            });
          } catch (err: any) {
            console.error(`[backfill] ${name} 실패:`, err.message);
            results.push({stockName: name, error: err.message});
          }
        }

        console.log(
          `[backfill] 완료: ${totalUpdated}/${stockNames.length}종목 갱신, ` +
            `매수 ${totalBuyFilled}차, 매도 ${totalSellFilled}차`
        );

        res.json({
          success: true,
          totalStocks: stockNames.length,
          updated: totalUpdated,
          buyFilled: totalBuyFilled,
          sellFilled: totalSellFilled,
          exceedsBuy: totalExceedsBuy,
          exceedsSell: totalExceedsSell,
          results,
        });
      } catch (error: any) {
        console.error("[backfill] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 전수 검증: 모든 종목의 trades 누적 vs stocks 문서 비교
 * GET /verifyAllStocks
 *   query: stockName (선택 — 단일 종목만 검증)
 *         includeClean=1 (선택 — 정상 종목도 결과 포함)
 *
 * 검증 로직:
 *   - trades 에서 해당 종목의 모든 문서 스캔
 *   - buy 누적 수량 − sell 누적 수량 = expectedQuantity
 *   - 가중평균 매수단가 = expectedAvgPrice
 *   - stocks.totalQuantity / stocks.avgPrice 와 비교
 *   - 불일치 시 mismatch 로 분류
 *
 * ※ 읽기 전용 — 절대 데이터 수정 안 함
 */
/**
 * 전체 stocks 종목 일괄 reconcileStockPlans 실행
 * POST /reconcileAllStocks
 *
 * 새 로직(옵션 C: manualOverride 흡수 trade 추적, 이중 집계 차단,
 * buyPlans/sellPlans 계획값 자동 보정)을 모든 종목에 일괄 적용.
 */
export const reconcileAllStocks = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const stocksSnap = await db.collection("stocks").get();
        const results: any[] = [];
        const errors: any[] = [];

        for (const doc of stocksSnap.docs) {
          const data = doc.data();
          const name = data.name;
          if (!name) continue;
          try {
            const result = await reconcileStockPlans(name);
            if (result.updated) {
              results.push({stockName: name, ...result});
            }
          } catch (e: any) {
            errors.push({stockName: name, error: e.message});
            console.error(`[reconcileAll] ${name} 실패: ${e.message}`);
          }
        }

        console.log(`[reconcileAll] 완료: 처리 ${stocksSnap.size}종목, 변경 ${results.length}종목, 오류 ${errors.length}종목`);

        res.json({
          success: true,
          total: stocksSnap.size,
          changedCount: results.length,
          errorCount: errors.length,
          results,
          errors,
        });
      } catch (error: any) {
        console.error("[reconcileAll] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 전체 종목 매도 매핑 정합성 검증
 * GET /auditSellMapping
 *
 * sellPlans+maSells filled 합계 vs trades 매도 합계 비교
 * - 일치: 정상
 * - 불일치: 이중 집계 또는 누락
 */
export const auditSellMapping = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const stocksSnap = await db.collection("stocks").get();
        const issues: any[] = [];
        const cleans: any[] = [];

        const now = Date.now();
        for (const doc of stocksSnap.docs) {
          const stock = doc.data();
          const name = stock.name;
          if (!name) continue;

          const tradesSnap = await db.collection("trades").where("stockName", "==", name).get();
          let tradeSellQty = 0;
          tradesSnap.forEach((d) => {
            const t = d.data();
            if (t.type === "sell") tradeSellQty += Number(t.quantity) || 0;
          });

          const sellPlans = (stock.sellPlans || []) as any[];
          const maSells = (stock.maSells || []) as any[];

          const sellPlanQty = sellPlans
            .filter((p) => p.filled)
            .reduce((s: number, p) => s + (Number(p.filledQuantity) || 0), 0);
          const maSellQty = maSells
            .filter((m) => m.filled)
            .reduce((s: number, m) => s + (Number(m.quantity) || 0), 0);
          const totalMappedQty = sellPlanQty + maSellQty;
          const diff = tradeSellQty - totalMappedQty;

          const entry = {
            stockName: name,
            tradeSellQty,
            sellPlanQty,
            maSellQty,
            totalMappedQty,
            diff,
          };

          if (tradeSellQty !== totalMappedQty) {
            issues.push(entry);
          } else {
            cleans.push(entry);
          }

          // ✅ stocks doc에 audit 결과 캐싱 (프론트 경고 배지에 사용)
          // diff=0이면 mappingAuditDiff=0 / 0이 아니면 그 값 그대로 저장
          if ((stock.mappingAuditDiff || 0) !== diff || !stock.mappingAuditAt) {
            try {
              await doc.ref.update({mappingAuditDiff: diff, mappingAuditAt: now});
            } catch (e) {
              // ignore
            }
          }
        }

        console.log(`[auditSell] 완료: 정합성 ${cleans.length}/${stocksSnap.size}, 불일치 ${issues.length}`);

        res.json({
          success: true,
          total: stocksSnap.size,
          cleanCount: cleans.length,
          issueCount: issues.length,
          issues,
        });
      } catch (error: any) {
        console.error("[auditSell] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

export const verifyAllStocks = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const filter =
          (req.query.stockName as string) ||
          (req.body && req.body.stockName) ||
          null;
        const includeClean =
          req.query.includeClean === "1" ||
          (req.body && req.body.includeClean === true);

        // 검증 대상 종목 목록
        let targetNames: string[] = [];
        if (filter) {
          targetNames = [filter];
        } else {
          // stocks + trades 에서 등장하는 모든 이름 합집합
          const nameSet = new Set<string>();
          const stocksSnap = await db.collection("stocks").get();
          stocksSnap.forEach((doc) => {
            const nm = (doc.data() as any).name;
            if (nm) nameSet.add(nm);
          });
          const tradesSnap = await db.collection("trades").get();
          tradesSnap.forEach((doc) => {
            const nm = (doc.data() as any).stockName;
            if (nm) nameSet.add(nm);
          });
          targetNames = Array.from(nameSet).sort();
        }

        console.log(`[verify] 시작: ${targetNames.length}종목`);

        const mismatches: any[] = [];
        const cleans: any[] = [];
        let totalKiwoomTrades = 0;
        let totalManualTrades = 0;

        for (const name of targetNames) {
          // stocks 문서
          const stockSnap = await db
            .collection("stocks")
            .where("name", "==", name)
            .limit(1)
            .get();
          const stock = stockSnap.empty ? null : stockSnap.docs[0].data() as any;
          const stockId = stockSnap.empty ? null : stockSnap.docs[0].id;

          // trades 전체
          const tradesSnap = await db
            .collection("trades")
            .where("stockName", "==", name)
            .get();

          let buyQty = 0;
          let buyAmt = 0;
          let sellQty = 0;
          let kiwoomCnt = 0;
          let manualCnt = 0;
          const buyByDate: Record<string, {qty: number; amt: number}> = {};
          const sellByDate: Record<string, {qty: number; amt: number}> = {};

          tradesSnap.forEach((doc) => {
            const data = doc.data() as any;
            const qty = Number(data.quantity) || 0;
            const price = Number(data.price) || 0;
            if (doc.id.startsWith("trade_kiwoom_")) kiwoomCnt++;
            else manualCnt++;
            if (data.type === "buy") {
              buyQty += qty;
              buyAmt += qty * price;
              if (data.date) {
                if (!buyByDate[data.date]) buyByDate[data.date] = {qty: 0, amt: 0};
                buyByDate[data.date].qty += qty;
                buyByDate[data.date].amt += qty * price;
              }
            } else if (data.type === "sell") {
              sellQty += qty;
              if (data.date) {
                if (!sellByDate[data.date]) sellByDate[data.date] = {qty: 0, amt: 0};
                sellByDate[data.date].qty += qty;
                sellByDate[data.date].amt += qty * price;
              }
            }
          });

          totalKiwoomTrades += kiwoomCnt;
          totalManualTrades += manualCnt;

          const expectedQty = buyQty - sellQty;
          const expectedAvg = buyQty > 0 ? Math.round(buyAmt / buyQty) : 0;

          const stockQty = stock ? (Number(stock.totalQuantity) || 0) : 0;
          const stockAvg = stock ? (Number(stock.avgPrice) || 0) : 0;

          // 불일치 판정 (잔고는 정확히 일치해야 함, 평단은 ±1원 허용)
          const qtyMismatch = expectedQty !== stockQty;
          const avgMismatch = buyQty > 0 && Math.abs(expectedAvg - stockAvg) > 1;

          const entry = {
            stockName: name,
            stockId,
            hasStock: !!stock,
            tradesTotal: tradesSnap.size,
            kiwoomTrades: kiwoomCnt,
            manualTrades: manualCnt,
            buyQty,
            sellQty,
            buyAmt,
            expectedQty,
            expectedAvg,
            stockQty,
            stockAvg,
            qtyMismatch,
            avgMismatch,
            uniqueBuyDates: Object.keys(buyByDate).length,
            uniqueSellDates: Object.keys(sellByDate).length,
          };

          if (qtyMismatch || avgMismatch) {
            mismatches.push(entry);
          } else {
            cleans.push(entry);
          }
        }

        // 요약
        const summary = {
          totalStocks: targetNames.length,
          mismatchCount: mismatches.length,
          cleanCount: cleans.length,
          totalKiwoomTrades,
          totalManualTrades,
          qtyMismatchOnly: mismatches.filter((m) => m.qtyMismatch && !m.avgMismatch).length,
          avgMismatchOnly: mismatches.filter((m) => !m.qtyMismatch && m.avgMismatch).length,
          bothMismatch: mismatches.filter((m) => m.qtyMismatch && m.avgMismatch).length,
        };

        console.log(
          `[verify] 완료: mismatch ${mismatches.length} / clean ${cleans.length} / total ${targetNames.length}`
        );

        res.json({
          success: true,
          summary,
          mismatches,
          ...(includeClean ? {cleans} : {}),
        });
      } catch (error: any) {
        console.error("[verify] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * trade_kiwoom_* 전량 아카이브 + 삭제
 * POST /archiveAndPurgeKiwoomTrades
 *   body: { dryRun?: true }  (기본 dryRun=true 안전장치)
 *   query: execute=1 (명시적으로 실행)
 *
 * 동작:
 *   1) trades 컬렉션에서 trade_kiwoom_* 전수 조회
 *   2) deleted_trades_${timestamp}/${tradeId} 로 복사 (복구 가능)
 *   3) 원본 trade_kiwoom_* 삭제
 *   4) buyPlans/sellPlans 의 filled 플래그 리셋 (재동기화 후 onTradeCreated 가 재생성)
 *   ※ 수동 입력(trade_kiwoom_ 접두어 없음) 은 건드리지 않음
 */
export const archiveAndPurgeKiwoomTrades = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const execute =
          req.query.execute === "1" ||
          (req.body && req.body.execute === true);
        const dryRun = !execute;

        const tradesSnap = await db.collection("trades").get();
        const kiwoomDocs = tradesSnap.docs.filter((d) =>
          d.id.startsWith("trade_kiwoom_")
        );
        const manualCount = tradesSnap.size - kiwoomDocs.length;

        console.log(
          `[purge] 전체 ${tradesSnap.size}건 중 kiwoom ${kiwoomDocs.length}건 / 수동 ${manualCount}건`
        );

        if (dryRun) {
          // dry-run: 영향 범위만 집계
          const byStock: Record<string, number> = {};
          const byType: Record<string, number> = {};
          kiwoomDocs.forEach((d) => {
            const data = d.data() as any;
            const nm = data.stockName || "(unknown)";
            byStock[nm] = (byStock[nm] || 0) + 1;
            byType[data.type || "(?)"] = (byType[data.type || "(?)"] || 0) + 1;
          });
          res.json({
            success: true,
            dryRun: true,
            toArchive: kiwoomDocs.length,
            manualKept: manualCount,
            uniqueStocks: Object.keys(byStock).length,
            byType,
            byStock,
            note: "실행하려면 ?execute=1 또는 body.execute=true 로 재호출",
          });
          return;
        }

        // 실행 모드: 아카이브 컬렉션 생성
        const stamp = new Date()
          .toISOString()
          .replace(/[-:T.]/g, "")
          .slice(0, 14);
        const archiveCol = `deleted_trades_${stamp}`;
        console.log(`[purge] 아카이브 컬렉션: ${archiveCol}`);

        // 메타 문서 — 나중에 복구할 때 참조
        await db.collection(archiveCol).doc("_meta").set({
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          totalCount: kiwoomDocs.length,
          sourceCollection: "trades",
          reason: "buy/sell reversal bug (line 277 fix) — full resync",
        });

        // 배치 복사 (500개씩 = Firestore 배치 한계)
        let archived = 0;
        let deleted = 0;
        const BATCH = 400;
        for (let i = 0; i < kiwoomDocs.length; i += BATCH) {
          const slice = kiwoomDocs.slice(i, i + BATCH);
          // 1) 아카이브 write
          const writeBatch = db.batch();
          slice.forEach((d) => {
            writeBatch.set(db.collection(archiveCol).doc(d.id), {
              ...d.data(),
              _archivedAt: admin.firestore.FieldValue.serverTimestamp(),
              _originalId: d.id,
            });
          });
          await writeBatch.commit();
          archived += slice.length;

          // 2) 원본 delete
          const delBatch = db.batch();
          slice.forEach((d) => {
            delBatch.delete(db.collection("trades").doc(d.id));
          });
          await delBatch.commit();
          deleted += slice.length;

          console.log(`[purge] ${i + slice.length}/${kiwoomDocs.length} 처리`);
        }

        // buyPlans/sellPlans filled 리셋 — 재동기화 후 트리거가 다시 채워줌
        const stocksSnap = await db.collection("stocks").get();
        let resetStocks = 0;
        for (const sDoc of stocksSnap.docs) {
          const data = sDoc.data() as any;
          const bp = Array.isArray(data.buyPlans) ? data.buyPlans : [];
          const sp = Array.isArray(data.sellPlans) ? data.sellPlans : [];
          const hasFilledBuy = bp.some((p: any) => p && p.filled);
          const hasFilledSell = sp.some((p: any) => p && p.filled);
          if (!hasFilledBuy && !hasFilledSell) continue;

          const nextBp = bp.map((p: any) =>
            p ? {...p, filled: false, filledDate: null, filledPrice: null, filledQuantity: null} : p
          );
          const nextSp = sp.map((p: any) =>
            p ? {...p, filled: false, filledDate: null, filledPrice: null, filledQuantity: null} : p
          );
          await sDoc.ref.update({
            buyPlans: nextBp,
            sellPlans: nextSp,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          resetStocks++;
        }

        console.log(
          `[purge] 완료: archived=${archived} deleted=${deleted} plansReset=${resetStocks}`
        );

        res.json({
          success: true,
          dryRun: false,
          archiveCollection: archiveCol,
          archived,
          deleted,
          manualKept: manualCount,
          plansResetStocks: resetStocks,
          nextSteps: [
            "1) POST /kiwoomSync {startDate, endDate} 로 재동기화 (수정된 코드 기반)",
            "2) GET /verifyAllStocks 로 재검증",
            "3) 문제 시 deleted_trades_" + stamp + " 에서 복구 가능",
          ],
        });
      } catch (error: any) {
        console.error("[purge] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * GET /diagApiExplore
 * 미사용 키움 REST API 4종을 직접 호출해서 원시 응답 확인
 *
 * query:
 *   startDate  (YYYYMMDD, default: 3개월 전)
 *   endDate    (YYYYMMDD, default: 오늘)
 *   stockCode  (선택 — 종목코드, default: "")
 *
 * 테스트 대상:
 *   ka10073 - 일자별종목별실현손익_기간 (ka10072의 기간 버전)
 *   ka10077 - 당일실현손익상세요청
 *   ka10170 - 일별매매일지요청 (매수+매도 포함 가능)
 *   kt00015 - 위탁종합거래내역요청 (매수+매도 종합 가능)
 *
 * ⚠️ 읽기 전용 — 데이터 수정 없음
 */
export const diagApiExplore = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);

        const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const threeMonthsAgo = (() => {
          const d = new Date();
          d.setMonth(d.getMonth() - 3);
          return d.toISOString().slice(0, 10).replace(/-/g, "");
        })();

        const startDate = (req.query.startDate as string) || threeMonthsAgo;
        const endDate = (req.query.endDate as string) || today;
        const stockCode = (req.query.stockCode as string) || "";

        console.log(`[diagApiExplore] 조회기간: ${startDate} ~ ${endDate} / 종목: ${stockCode || "전체"}`);

        const results: Record<string, any> = {};

        // ─── 1. ka10073: 일자별종목별실현손익_기간 ───
        // ka10072의 기간 버전 — 매도 이력 + 매수원가 포함 여부 확인
        try {
          const r73 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "ka10073",
            },
            body: JSON.stringify({
              strt_dt: startDate,
              end_dt: endDate,
              stk_cd: stockCode,
              qry_tp: "0",
              stk_bond_tp: "1",
              dmst_stex_tp: "KRX",
            }),
          });
          const d73 = await r73.json() as any;
          console.log(`[ka10073] return_code=${d73.return_code} return_msg=${d73.return_msg}`);
          console.log(`[ka10073] 응답 keys: ${Object.keys(d73).join(", ")}`);

          // 배열 필드 탐색 및 샘플 출력
          const arrays73: Record<string, any> = {};
          for (const key of Object.keys(d73)) {
            if (Array.isArray(d73[key])) {
              arrays73[key] = d73[key].slice(0, 3); // 첫 3건만
              console.log(`[ka10073] 배열 필드 "${key}": ${d73[key].length}건`);
              if (d73[key].length > 0) {
                console.log(`[ka10073] 샘플[0]: ${JSON.stringify(d73[key][0]).slice(0, 400)}`);
              }
            }
          }
          results["ka10073"] = {
            return_code: d73.return_code,
            return_msg: d73.return_msg,
            all_keys: Object.keys(d73),
            arrays: arrays73,
          };
        } catch (e: any) {
          results["ka10073"] = {error: e.message};
          console.log(`[ka10073] 오류: ${e.message}`);
        }

        await new Promise((r) => setTimeout(r, 300));

        // ─── 2. ka10077: 당일실현손익상세요청 ───
        // "당일"이지만 ord_dt 파라미터로 과거 날짜 조회 가능 여부 확인
        try {
          const r77 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "ka10077",
            },
            body: JSON.stringify({
              strt_dt: startDate,
              end_dt: endDate,
              stk_cd: stockCode,
              qry_tp: "0",
              sell_tp: "0",
              stk_bond_tp: "1",
              dmst_stex_tp: "KRX",
            }),
          });
          const d77 = await r77.json() as any;
          console.log(`[ka10077] return_code=${d77.return_code} return_msg=${d77.return_msg}`);
          console.log(`[ka10077] 응답 keys: ${Object.keys(d77).join(", ")}`);

          const arrays77: Record<string, any> = {};
          for (const key of Object.keys(d77)) {
            if (Array.isArray(d77[key])) {
              arrays77[key] = d77[key].slice(0, 3);
              console.log(`[ka10077] 배열 필드 "${key}": ${d77[key].length}건`);
              if (d77[key].length > 0) {
                console.log(`[ka10077] 샘플[0]: ${JSON.stringify(d77[key][0]).slice(0, 400)}`);
              }
            }
          }
          results["ka10077"] = {
            return_code: d77.return_code,
            return_msg: d77.return_msg,
            all_keys: Object.keys(d77),
            arrays: arrays77,
          };
        } catch (e: any) {
          results["ka10077"] = {error: e.message};
          console.log(`[ka10077] 오류: ${e.message}`);
        }

        await new Promise((r) => setTimeout(r, 300));

        // ─── 3. ka10170: 일별매매일지요청 ───
        // 매수+매도 포함 종합 매매일지 가능성 — ottks_tp 파라미터 추가 (필수)
        // ottks_tp: "1"=국내주식위탁, "2"=신용, "3"=선물/옵션 등 추정
        try {
          const r170 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "ka10170",
            },
            body: JSON.stringify({
              strt_dt: startDate,
              end_dt: endDate,
              stk_cd: stockCode,
              ottks_tp: "1",
              ch_crd_tp: "0",
              qry_tp: "0",
              sell_tp: "0",
              stk_bond_tp: "1",
              dmst_stex_tp: "KRX",
            }),
          });
          const d170 = await r170.json() as any;
          console.log(`[ka10170] return_code=${d170.return_code} return_msg=${d170.return_msg}`);
          console.log(`[ka10170] 응답 keys: ${Object.keys(d170).join(", ")}`);

          const arrays170: Record<string, any> = {};
          for (const key of Object.keys(d170)) {
            if (Array.isArray(d170[key])) {
              arrays170[key] = d170[key].slice(0, 3);
              console.log(`[ka10170] 배열 필드 "${key}": ${d170[key].length}건`);
              if (d170[key].length > 0) {
                console.log(`[ka10170] 샘플[0]: ${JSON.stringify(d170[key][0]).slice(0, 400)}`);
              }
            }
          }
          results["ka10170"] = {
            return_code: d170.return_code,
            return_msg: d170.return_msg,
            all_keys: Object.keys(d170),
            arrays: arrays170,
          };
        } catch (e: any) {
          results["ka10170"] = {error: e.message};
          console.log(`[ka10170] 오류: ${e.message}`);
        }

        await new Promise((r) => setTimeout(r, 300));

        // ─── 4. kt00015: 위탁종합거래내역요청 ───
        // tp 파라미터가 필수 — "1"=현금매수, "2"=현금매도, "3"=신용매수 등 추정
        // tp="1"(매수)부터 시도, 성공하면 멈추고 전체("0") 도 시도
        results["kt00015"] = {};
        for (const tp of ["1", "2", "0", "3"]) {
          try {
            const r15 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "authorization": `Bearer ${token}`,
                "api-id": "kt00015",
              },
              body: JSON.stringify({
                strt_dt: startDate,
                end_dt: endDate,
                stk_cd: stockCode,
                tp,
                gds_tp: "1",
                qry_tp: "0",
                sell_tp: "0",
                stk_bond_tp: "1",
                dmst_stex_tp: "KRX",
                stex_tp: "1",
              }),
            });
            const d15 = await r15.json() as any;
            console.log(`[kt00015 tp=${tp}] code=${d15.return_code} msg=${d15.return_msg}`);

            const arrays15: Record<string, any> = {};
            for (const key of Object.keys(d15)) {
              if (Array.isArray(d15[key])) {
                arrays15[key] = d15[key].slice(0, 3);
                console.log(`[kt00015 tp=${tp}] 배열 "${key}": ${d15[key].length}건`);
                if (d15[key].length > 0) {
                  console.log(`[kt00015 tp=${tp}] 샘플[0]: ${JSON.stringify(d15[key][0]).slice(0, 400)}`);
                }
              }
            }
            results[`kt00015_tp${tp}`] = {
              tp,
              return_code: d15.return_code,
              return_msg: d15.return_msg,
              all_keys: Object.keys(d15),
              arrays: arrays15,
            };
            await new Promise((r) => setTimeout(r, 200));
          } catch (e: any) {
            results[`kt00015_tp${tp}`] = {tp, error: e.message};
          }
        }

        // ─── 5. kt00007 재확인: 현재 파라미터로 실제 응답 구조 점검 ───
        await new Promise((r) => setTimeout(r, 300));
        try {
          const r7 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "kt00007",
            },
            body: JSON.stringify({
              strt_dt: startDate,
              end_dt: endDate,
              stk_cd: stockCode,
              sell_tp: "0",
              qry_tp: "0",
              dmst_stex_tp: "KRX",
              stex_tp: "1",
              stk_bond_tp: "1",
              mrkt_tp: "0",
            }),
          });
          const d7 = await r7.json() as any;
          console.log(`[kt00007] return_code=${d7.return_code} return_msg=${d7.return_msg}`);
          console.log(`[kt00007] 응답 keys: ${Object.keys(d7).join(", ")}`);

          const arrays7: Record<string, any> = {};
          let buyCount7 = 0;
          let sellCount7 = 0;
          for (const key of Object.keys(d7)) {
            if (Array.isArray(d7[key])) {
              // 첫 10건 샘플 + 실제 데이터 있는 항목만 필터
              const realItems = d7[key].filter((x: any) =>
                (x.stk_cd || "").trim() !== "" || (x.stk_nm || "").trim() !== ""
              );
              arrays7[key] = realItems.slice(0, 5);
              console.log(`[kt00007] 배열 "${key}": 전체${d7[key].length}건 / 실데이터${realItems.length}건`);
              for (const item of realItems) {
                const tp = String(item.trde_tp || item.io_tp_nm || item.sell_tp || "");
                console.log(`[kt00007] 항목: stk=${item.stk_nm||""} trde_tp="${item.trde_tp||""}" io_tp_nm="${item.io_tp_nm||""}" cntr_qty=${item.cntr_qty||0} cntr_uv=${item.cntr_uv||0}`);
                if (tp.includes("매수")) buyCount7++;
                if (tp.includes("매도")) sellCount7++;
              }
              if (realItems.length === 0 && d7[key].length > 0) {
                console.log(`[kt00007] 샘플(빈데이터)[0]: ${JSON.stringify(d7[key][0]).slice(0, 300)}`);
              }
            }
          }
          results["kt00007"] = {
            return_code: d7.return_code,
            return_msg: d7.return_msg,
            all_keys: Object.keys(d7),
            buyCount: buyCount7,
            sellCount: sellCount7,
            arrays: arrays7,
          };
        } catch (e: any) {
          results["kt00007"] = {error: e.message};
        }

        // ─── 6. ka10072 대조군: 현재 잘 작동하는 API로 VPC 커넥터 정상 여부 확인 ───
        await new Promise((r) => setTimeout(r, 300));
        try {
          const rCtrl = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "ka10072",
            },
            body: JSON.stringify({
              strt_dt: endDate,
              end_dt: endDate,
              ord_dt: endDate,
              stk_cd: stockCode,
              sell_tp: "1",
              qry_tp: "0",
              stk_bond_tp: "1",
              dmst_stex_tp: "KRX",
            }),
          });
          const dCtrl = await rCtrl.json() as any;
          results["ka10072_control"] = {
            return_code: dCtrl.return_code,
            return_msg: dCtrl.return_msg,
            all_keys: Object.keys(dCtrl),
          };
          console.log(`[ka10072_control] code=${dCtrl.return_code} msg=${dCtrl.return_msg}`);
        } catch (e: any) {
          results["ka10072_control"] = {error: e.message};
        }

        const codeOk = (code: any) => code === 0 || code === "0";
        const kt15Summary: Record<string, string> = {};
        for (const tp of ["1", "2", "0", "3"]) {
          const r = results[`kt00015_tp${tp}`];
          kt15Summary[`kt00015_tp=${tp}`] = codeOk(r?.return_code)
            ? `✅ 성공 (배열: ${Object.keys(r?.arrays || {}).join(",")||"없음"})`
            : `❌ ${r?.return_msg || r?.error || "?"}`;
        }

        res.json({
          success: true,
          period: `${startDate} ~ ${endDate}`,
          stockCode: stockCode || "전체",
          results,
          summary: {
            "ka10072(대조군_VPC확인)": codeOk(results["ka10072_control"]?.return_code) ? "✅ VPC 정상" : `❌ ${results["ka10072_control"]?.return_msg}`,
            ka10073: codeOk(results["ka10073"]?.return_code)
              ? `✅ 성공 (배열: ${Object.keys(results["ka10073"]?.arrays||{}).join(",")||"없음"})`
              : `❌ ${results["ka10073"]?.return_msg || results["ka10073"]?.error}`,
            ka10077: codeOk(results["ka10077"]?.return_code)
              ? `✅ 성공 (배열: ${Object.keys(results["ka10077"]?.arrays||{}).join(",")||"없음"})`
              : `❌ ${results["ka10077"]?.return_msg || results["ka10077"]?.error}`,
            ka10170: codeOk(results["ka10170"]?.return_code)
              ? `✅ 성공 (배열: ${Object.keys(results["ka10170"]?.arrays||{}).join(",")||"없음"})`
              : `❌ ${results["ka10170"]?.return_msg || results["ka10170"]?.error}`,
            ...kt15Summary,
            kt00007: codeOk(results["kt00007"]?.return_code)
              ? `✅ 성공 — 매수${results["kt00007"]?.buyCount||0}건 / 매도${results["kt00007"]?.sellCount||0}건 (배열: ${Object.keys(results["kt00007"]?.arrays||{}).join(",")||"없음"})`
              : `❌ ${results["kt00007"]?.return_msg || results["kt00007"]?.error}`,
          },
          note: "Cloud Functions 로그에서 각 API 의 샘플 필드명 확인 가능",
        });
      } catch (error: any) {
        console.error("[diagApiExplore] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 잘못 저장된 trade 삭제 (운영 데이터 정리용)
 * POST /deleteTrades
 * body: { tradeIds: ["trade_kiwoom_xxx", ...] }
 */
/**
 * 단일 trade 필드 수정 (admin 직접 패치)
 * POST /updateTrade
 * body: { tradeId: "trade_kiwoom_xxx", set: { price?, quantity?, date?, type?, stockName?, code? } }
 *
 * 액면분할, 잘못된 단위 등 trade 데이터 정정 시 사용.
 * trade ID는 유지되고 fields만 update.
 */
export const updateTrade = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {tradeId, set} = req.body || {};
        if (!tradeId || !set || typeof set !== "object") {
          res.status(400).json({success: false, error: "tradeId/set 필수"});
          return;
        }
        const ref = db.collection("trades").doc(String(tradeId));
        const doc = await ref.get();
        if (!doc.exists) {
          res.status(404).json({success: false, error: `trade 없음: ${tradeId}`});
          return;
        }
        const before = doc.data();
        // 허용 필드만 추려서 update (안전)
        const allowed: Record<string, any> = {};
        for (const k of ["price", "quantity", "date", "type", "stockName", "code", "memo", "tags"]) {
          if (k in set) allowed[k] = set[k];
        }
        if (Object.keys(allowed).length === 0) {
          res.status(400).json({success: false, error: "수정 가능한 필드 없음"});
          return;
        }
        await ref.update(allowed);
        const after = {...before, ...allowed};
        console.log(`[updateTrade] ${tradeId}: ${JSON.stringify(allowed)}`);
        res.json({success: true, tradeId, before, after});
      } catch (error: any) {
        console.error("[updateTrade] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

export const deleteTrades = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {tradeIds} = req.body || {};
        if (!Array.isArray(tradeIds) || tradeIds.length === 0) {
          res.status(400).json({success: false, error: "tradeIds 배열 필수"});
          return;
        }
        const batch = db.batch();
        for (const id of tradeIds) {
          batch.delete(db.collection("trades").doc(String(id)));
        }
        await batch.commit();
        console.log(`[deleteTrades] ${tradeIds.length}건 삭제: ${tradeIds.join(", ")}`);
        res.json({success: true, deleted: tradeIds.length, tradeIds});
      } catch (error: any) {
        console.error("[deleteTrades] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 잘못된 종목 동기화 보정 (특정 종목 재동기화)
 * POST /fixStockSync
 * body: { stockName: "원익" } — 해당 종목의 잘못 분류된 buy trade를 제거 후 reconcile
 *
 * 대상: fetchTodayTrades 버그로 오늘 매도가 buy로도 이중 기록된 경우
 * 로직: 오늘 날짜 buy trade 중 동일 날짜/가격/수량의 sell trade가 있으면 buy를 삭제
 */
export const fixStockSync = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {stockName} = req.body || {};
        if (!stockName) {
          res.status(400).json({success: false, error: "stockName 필수"});
          return;
        }

        // 해당 종목의 모든 trades 조회
        const tradesSnap = await db.collection("trades").where("stockName", "==", stockName).get();
        const buys: Array<{id: string; date: string; price: number; qty: number}> = [];
        const sellSigs = new Set<string>();

        tradesSnap.forEach((doc) => {
          const d = doc.data();
          if (d.type === "sell") {
            sellSigs.add(`${d.date}_${d.price}_${d.quantity}`);
          } else if (d.type === "buy") {
            buys.push({id: doc.id, date: d.date, price: d.price, qty: d.quantity});
          }
        });

        // buy 중 같은 날짜+가격+수량의 sell이 있는 것 = 오분류된 매수
        const toDelete: string[] = [];
        for (const b of buys) {
          const sig = `${b.date}_${b.price}_${b.qty}`;
          if (sellSigs.has(sig)) {
            toDelete.push(b.id);
            console.log(`[fixStockSync] ${stockName} 오분류 buy 삭제 대상: ${b.id} (${b.date} @${b.price}×${b.qty})`);
          }
        }

        // 오분류 buy 없어도 항상 reconcile 실행 (기존 오염 데이터 정리)
        if (toDelete.length === 0) {
          const reconcileResult = await reconcileStockPlans(stockName);
          res.json({success: true, stockName, deleted: 0, message: "오분류 buy 없음 — reconcile만 실행", reconcile: reconcileResult});
          return;
        }

        // 삭제 실행
        const batch = db.batch();
        for (const id of toDelete) batch.delete(db.collection("trades").doc(id));
        await batch.commit();

        // 삭제 후 reconcile
        const reconcileResult = await reconcileStockPlans(stockName);
        console.log(`[fixStockSync] ${stockName}: ${toDelete.length}건 삭제 후 reconcile 완료`);

        res.json({
          success: true,
          stockName,
          deleted: toDelete.length,
          deletedIds: toDelete,
          reconcile: reconcileResult,
        });
      } catch (error: any) {
        console.error("[fixStockSync] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 재진입 추적 관리 (시작/중지/리셋/최저가 수정)
 * POST /reentryControl
 * body:
 *   { stockName: "...", action: "start" }   - 추적 시작 (일봉 API 자동 조회)
 *   { stockName: "...", action: "pause" }   - 추적 일시 중지
 *   { stockName: "...", action: "resume" }  - 다시 시작
 *   { stockName: "...", action: "reset" }   - 추적 리셋 (현재가부터 새로)
 *   { stockName: "...", action: "stop" }    - 추적 완전 중단 (reentry 제거)
 *   { stockName: "...", action: "setLow", lowPrice: 12000, lowPriceDate: "2026-04-15" } - 수동 최저가 수정
 */
export const reentryControl = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {stockName, action, lowPrice, lowPriceDate, code: codeInput} = req.body || {};
        if (!stockName || !action) {
          res.status(400).json({success: false, error: "stockName/action 필수"});
          return;
        }

        const snap = await db.collection("stocks")
          .where("name", "==", stockName)
          .limit(1)
          .get();
        if (snap.empty) {
          res.status(404).json({success: false, error: `${stockName} 종목 없음`});
          return;
        }

        const docRef = snap.docs[0].ref;
        const data = snap.docs[0].data();

        if (action === "start") {
          if ((data.totalQuantity || 0) > 0) {
            res.status(400).json({success: false, error: "보유 중인 종목은 매매완료 상태가 아니라 추적 시작 불가"});
            return;
          }

          // code 우선순위: 사용자 입력 > stocks 문서 > stockCodes 컬렉션 자동 검색
          let stockCode = codeInput || data.code;
          if (!stockCode) {
            console.log(`[재진입 init] ${stockName} code 누락 - stockCodes에서 자동 검색 시도`);
            const codesSnap = await db.collection("stockCodes")
              .where("name", "==", stockName)
              .limit(1)
              .get();
            if (!codesSnap.empty) {
              stockCode = codesSnap.docs[0].data().code;
              console.log(`[재진입 init] ${stockName} code 자동 채움: ${stockCode}`);
            } else {
              res.status(400).json({
                success: false,
                error: `${stockName}의 종목코드를 찾을 수 없습니다.`,
                hint: "POST body에 'code' 필드로 종목코드를 직접 입력해주세요. (예: A356860 또는 356860)",
                needsCode: true,
              });
              return;
            }
          }
          // A 접두사 정규화 (키움 API는 A001234 형식)
          if (stockCode && !stockCode.startsWith("A") && /^\d/.test(stockCode)) {
            stockCode = "A" + stockCode;
          }
          // stocks 문서에 code 저장 (다음에 자동 사용)
          if (stockCode !== data.code) {
            await docRef.update({code: stockCode});
          }

          const config = await getKiwoomConfig();
          const token = await getAccessToken(config);
          const reentry = await initializeReentryTracking(config, token, {...data, code: stockCode});
          if (!reentry) {
            res.status(500).json({success: false, error: "일봉 데이터 조회 실패 (키움 API 응답 없음)"});
            return;
          }
          await docRef.update({reentry, updatedAt: Date.now()});
          res.json({success: true, action, reentry, codeAutofilled: !data.code});
          return;
        }

        if (action === "pause") {
          await docRef.update({"reentry.status": "paused", "reentry.enabled": false, updatedAt: Date.now()});
          res.json({success: true, action});
          return;
        }

        if (action === "resume") {
          await docRef.update({"reentry.status": "tracking", "reentry.enabled": true, updatedAt: Date.now()});
          res.json({success: true, action});
          return;
        }

        if (action === "reset") {
          // 현재가부터 다시 추적 시작 (lowPrice = 현재가)
          let stockCode = data.code;
          if (!stockCode) {
            const codesSnap = await db.collection("stockCodes")
              .where("name", "==", stockName)
              .limit(1)
              .get();
            if (!codesSnap.empty) {
              stockCode = codesSnap.docs[0].data().code;
              await docRef.update({code: stockCode});
            } else {
              res.status(400).json({success: false, error: `${stockName}의 종목코드 찾을 수 없음`});
              return;
            }
          }
          const config = await getKiwoomConfig();
          const token = await getAccessToken(config);
          const reentry = await initializeReentryTracking(config, token, {...data, code: stockCode});
          if (!reentry) {
            res.status(500).json({success: false, error: "일봉 데이터 조회 실패"});
            return;
          }
          await docRef.update({reentry, updatedAt: Date.now()});
          res.json({success: true, action, reentry});
          return;
        }

        if (action === "stop") {
          await docRef.update({reentry: admin.firestore.FieldValue.delete(), updatedAt: Date.now()});
          res.json({success: true, action});
          return;
        }

        if (action === "setLow") {
          if (!lowPrice || lowPrice <= 0) {
            res.status(400).json({success: false, error: "lowPrice 필수"});
            return;
          }
          const update: any = {
            "reentry.lowPrice": lowPrice,
            "reentry.lowPriceDate": lowPriceDate || new Date().toISOString().slice(0, 10),
            "reentry.lowPriceSource": "manual",
            updatedAt: Date.now(),
          };
          // peak >= lowPrice * 2면 rebounded 자동 갱신
          if ((data.reentry?.peakPrice || 0) >= lowPrice * 2) {
            update["reentry.rebounded"] = true;
          }
          await docRef.update(update);
          res.json({success: true, action, lowPrice});
          return;
        }

        res.status(400).json({success: false, error: `알 수 없는 action: ${action}`});
      } catch (error: any) {
        console.error("[reentryControl] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 종목명 변경 (회사명 변경 대응)
 * POST /renameStock
 * body: { fromName: "유투바이오", toName: "지구홀딩스", code?: "221800" }
 *
 * 동작:
 *   1) trades 컬렉션에서 stockName=fromName 인 모든 문서를 toName 으로 업데이트
 *      (code 가 비어있고 인자로 받은 code 가 있으면 함께 채워줌)
 *   2) stocks 컬렉션의 fromName 문서를 toName 으로 rename
 *      - 이미 toName 문서가 있으면 충돌 보고 (수동 병합 필요)
 *   3) reconcileStockPlans(toName) 으로 정합성 재검증
 */
/**
 * 액면분할/병합 자동 감지
 * POST /detectSplitMerge
 *
 * 동작: 각 종목별로 trade 기반 추정 평단 vs 키움 잔고 평단 비교
 * - 5배/10배/100배/1000배 차이 발견 시 분할/병합 의심
 * - 응답에 의심 종목 + 추정 비율 리스트
 */
export const detectSplitMerge = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const stocksSnap = await db.collection("stocks").get();
        const suspicious: any[] = [];
        const checked: any[] = [];

        // 흔한 분할/병합 비율 (확인용)
        const ratios = [
          {value: 2, label: "2:1 병합"},
          {value: 5, label: "5:1 병합"},
          {value: 10, label: "10:1 병합"},
          {value: 0.5, label: "1:2 분할"},
          {value: 0.2, label: "1:5 분할"},
          {value: 0.1, label: "1:10 분할"},
          {value: 0.01, label: "1:100 분할"},
          {value: 0.001, label: "1:1000 분할"},
        ];

        for (const doc of stocksSnap.docs) {
          const stock = doc.data();
          const name = stock.name;
          if (!name) continue;
          const stockAvg = Number(stock.avgPrice) || 0;
          const stockQty = Number(stock.totalQuantity) || 0;
          if (stockAvg <= 0 || stockQty <= 0) continue;

          // trade 기반 추정 평단 계산
          const tradesSnap = await db.collection("trades").where("stockName", "==", name).get();
          let buyAmt = 0;
          let buyQty = 0;
          tradesSnap.forEach((d) => {
            const t = d.data();
            if (t.type === "buy") {
              const p = Number(t.price) || 0;
              const q = Number(t.quantity) || 0;
              buyAmt += p * q;
              buyQty += q;
            }
          });
          if (buyQty === 0) continue;
          const tradeAvg = buyAmt / buyQty;

          // tradeAvg vs stockAvg 비교
          // ratio = tradeAvg / stockAvg
          // ratio ≈ 5 → 5:1 병합 (trade 가격이 5배 큰 옛 단위)
          // ratio ≈ 0.001 → 1:1000 분할 (trade 가격이 1/1000 옛 단위)
          const observedRatio = tradeAvg / stockAvg;
          let bestMatch: any = null;
          let bestDiff = Infinity;
          for (const r of ratios) {
            // ratio가 1에 가까우면 (0.95~1.05) 분할/병합 아님
            const diff = Math.abs(observedRatio - r.value) / r.value;
            if (diff < 0.05 && diff < bestDiff) {
              bestMatch = r;
              bestDiff = diff;
            }
          }

          const entry = {
            stockName: name,
            stockAvg,
            stockQty,
            tradeAvg: Math.round(tradeAvg * 100) / 100,
            observedRatio: Math.round(observedRatio * 1000) / 1000,
          };

          if (bestMatch) {
            suspicious.push({
              ...entry,
              suggestedRatio: bestMatch.value,
              suggestedLabel: bestMatch.label,
              confidence: Math.max(0, 1 - bestDiff * 20),
            });
          } else {
            checked.push(entry);
          }
        }

        console.log(`[detectSplitMerge] 검사 ${stocksSnap.size}, 의심 ${suspicious.length}`);
        res.json({success: true, total: stocksSnap.size, suspicious});
      } catch (error: any) {
        console.error("[detectSplitMerge] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 액면분할/병합 비율 적용 (trade 일괄 정정)
 * POST /applySplitMergeRatio
 * body: {
 *   stockName: "...",
 *   ratio: 5,                  // 5 = 5:1 병합, 0.001 = 1:1000 분할
 *   splitDate: "2026-04-03",   // 이 날짜 이전 trade만 정정 (포함 안 함)
 *   preview?: true             // true면 미리보기, false면 실제 적용
 * }
 *
 * 정정 공식:
 *   newQuantity = oldQuantity / ratio (병합: 수량 감소, 분할: 수량 증가)
 *   newPrice = oldPrice * ratio       (병합: 가격 증가, 분할: 가격 감소)
 *   매수/매도 총액 보존됨 (qty × price)
 *
 * 적용 후 자동 reconcile 호출하여 buyPlans/sellPlans 정렬
 */
/**
 * 매핑 신뢰도 마이그레이션: 모든 종목의 filled 슬롯 중 consumedTradeIds 누락 건을 자동 채움
 * POST /migrateConsumedTradeIds
 *
 * 알고리즘 (resolveIds): date + qty + price 정확 매칭 → 가중평균 역추적 → legacy fallback
 * 매칭 못 한 슬롯은 audit warning에 잡혀 사용자 수동 처리.
 *
 * 실행 후 자동 reconcileStockPlans 호출 → 옵션 D 매핑이 정확화됨.
 */
export const migrateConsumedTradeIds = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const stockNameFilter = (req.query.stockName as string) || (req.body && req.body.stockName) || null;
        const stocksSnap = stockNameFilter
          ? await db.collection("stocks").where("name", "==", stockNameFilter).get()
          : await db.collection("stocks").get();

        const summary: any[] = [];
        let totalMigrated = 0;
        let totalUnresolved = 0;

        for (const doc of stocksSnap.docs) {
          const stock = doc.data();
          const name = stock.name;
          if (!name) continue;

          const sellPlans: any[] = Array.isArray(stock.sellPlans) ? [...stock.sellPlans] : [];
          const maSells: any[] = Array.isArray(stock.maSells) ? [...stock.maSells] : [];

          // 전체 sell trades 조회
          const tradesSnap = await db
            .collection("trades")
            .where("stockName", "==", name)
            .where("type", "==", "sell")
            .get();
          const allSells = tradesSnap.docs.map((d) => {
            const data = d.data() as any;
            return {
              id: d.id,
              date: String(data.date || ""),
              price: Number(data.price) || 0,
              quantity: Number(data.quantity) || 0,
            };
          });

          // 이미 사용된 trade.id별 qty 추적 (부분 분할 지원)
          // 한 trade를 여러 슬롯이 공유 가능 (예: 광전자 5/7 160주 → +5% 80 + ma20 80)
          const usedQtyByTrade: Record<string, number> = {};
          for (const sp of sellPlans) {
            if (Array.isArray(sp.consumedTradeIds)) {
              for (const id of sp.consumedTradeIds) {
                if (!id) continue;
                // 슬롯이 같은 trade를 참조하면 그 trade의 filledQuantity만큼 점유
                usedQtyByTrade[String(id)] = (usedQtyByTrade[String(id)] || 0) + (Number(sp.filledQuantity) || 0);
              }
            }
          }
          for (const m of maSells) {
            if (Array.isArray(m.consumedTradeIds)) {
              for (const id of m.consumedTradeIds) {
                if (!id) continue;
                usedQtyByTrade[String(id)] = (usedQtyByTrade[String(id)] || 0) + (Number(m.quantity) || 0);
              }
            }
          }

          const tradeRemaining = (t: {id: string; quantity: number}) =>
            t.quantity - (usedQtyByTrade[t.id] || 0);

          // resolveIds — 부분 분할 지원 강화
          const resolveIds = (date: string, qty: number, slotPrice: number): string[] => {
            if (!date || qty <= 0) return [];
            const candidates = allSells
              .filter((t) => t.date === date)
              .map((t) => ({...t, remaining: tradeRemaining(t)}))
              .filter((t) => t.remaining > 0);
            if (slotPrice > 0) {
              // 1) 단일 정확 매칭 (remaining qty 기준)
              const exact = candidates.find((t) => t.remaining === qty && t.price === slotPrice);
              if (exact) {
                usedQtyByTrade[exact.id] = (usedQtyByTrade[exact.id] || 0) + qty;
                return [exact.id];
              }
              // 2) 가중평균 역추적 (2^n subset, n<=10)
              const n = candidates.length;
              if (n >= 2 && n <= 10) {
                for (let mask = 1; mask < (1 << n); mask++) {
                  let sumQ = 0, sumA = 0;
                  const subset: string[] = [];
                  for (let i = 0; i < n; i++) {
                    if (mask & (1 << i)) {
                      sumQ += candidates[i].remaining;
                      sumA += candidates[i].remaining * candidates[i].price;
                      subset.push(candidates[i].id);
                    }
                  }
                  if (sumQ === qty) {
                    const avg = sumQ > 0 ? Math.round(sumA / sumQ) : 0;
                    if (avg === slotPrice) {
                      for (let i = 0; i < n; i++) {
                        if (mask & (1 << i)) {
                          const id = candidates[i].id;
                          usedQtyByTrade[id] = (usedQtyByTrade[id] || 0) + candidates[i].remaining;
                        }
                      }
                      return subset;
                    }
                  }
                }
              }
              // 3) ✅ 부분 매칭: 같은 가격 trade 중 remaining qty >= 필요 qty
              //    (광전자 5/7 160주를 +5% 80 + ma20 80 공유 케이스)
              const partial = candidates.find((t) => t.price === slotPrice && t.remaining >= qty);
              if (partial) {
                usedQtyByTrade[partial.id] = (usedQtyByTrade[partial.id] || 0) + qty;
                return [partial.id];
              }
            }
            // 5) legacy: date + qty (단일, remaining 기준)
            const exactQty = candidates.find((t) => t.remaining === qty);
            if (exactQty) {
              usedQtyByTrade[exactQty.id] = (usedQtyByTrade[exactQty.id] || 0) + qty;
              return [exactQty.id];
            }
            // 6) greedy 조합 (remaining 작은 것부터)
            const sortedByQty = [...candidates].sort((a, b) => a.remaining - b.remaining);
            let remainingQty = qty;
            const ids: string[] = [];
            for (const t of sortedByQty) {
              if (t.remaining <= remainingQty) {
                ids.push(t.id);
                usedQtyByTrade[t.id] = (usedQtyByTrade[t.id] || 0) + t.remaining;
                remainingQty -= t.remaining;
                if (remainingQty === 0) break;
              }
            }
            if (remainingQty === 0) {
              return ids;
            }
            return [];
          };

          let migrated = 0;
          let unresolved = 0;
          const stockChanges: any[] = [];

          // 우선순위: maSells (split된 슬롯) → sellPlans (병합 슬롯)
          for (let i = 0; i < maSells.length; i++) {
            const m = maSells[i];
            if (!m.filled) continue;
            if (Array.isArray(m.consumedTradeIds) && m.consumedTradeIds.length > 0) continue;
            const ids = resolveIds(m.filledDate || "", Number(m.quantity) || 0, Number(m.price) || 0);
            if (ids.length > 0) {
              maSells[i] = {...m, consumedTradeIds: ids};
              migrated++;
              stockChanges.push({type: "maSell", ma: m.ma, qty: m.quantity, price: m.price, date: m.filledDate, ids});
            } else {
              unresolved++;
              stockChanges.push({type: "maSell", ma: m.ma, qty: m.quantity, price: m.price, date: m.filledDate, ids: null, unresolved: true});
            }
          }

          for (let i = 0; i < sellPlans.length; i++) {
            const sp = sellPlans[i];
            if (!sp.filled) continue;
            if (Array.isArray(sp.consumedTradeIds) && sp.consumedTradeIds.length > 0) continue;
            const ids = resolveIds(sp.filledDate || "", Number(sp.filledQuantity) || 0, Number(sp.filledPrice) || 0);
            if (ids.length > 0) {
              sellPlans[i] = {...sp, consumedTradeIds: ids};
              migrated++;
              stockChanges.push({type: "sellPlan", percent: sp.percent, qty: sp.filledQuantity, price: sp.filledPrice, date: sp.filledDate, ids});
            } else {
              unresolved++;
              stockChanges.push({type: "sellPlan", percent: sp.percent, qty: sp.filledQuantity, price: sp.filledPrice, date: sp.filledDate, ids: null, unresolved: true});
            }
          }

          if (migrated > 0) {
            await doc.ref.update({sellPlans, maSells, updatedAt: Date.now()});
            // 변경 후 reconcile 자동 트리거 (옵션 D + 옵션 E 정확 적용)
            try {
              await reconcileStockPlans(name);
            } catch (e: any) {
              console.error(`[migrate] ${name} reconcile 실패: ${e.message}`);
            }
          }

          totalMigrated += migrated;
          totalUnresolved += unresolved;
          if (migrated > 0 || unresolved > 0) {
            summary.push({stockName: name, migrated, unresolved, changes: stockChanges});
          }
        }

        console.log(`[migrate] 완료: 총 ${totalMigrated}건 마이그레이션, ${totalUnresolved}건 미해결`);
        res.json({
          success: true,
          totalStocks: stocksSnap.size,
          totalMigrated,
          totalUnresolved,
          affectedStocks: summary.length,
          summary,
        });
      } catch (error: any) {
        console.error("[migrate] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

export const applySplitMergeRatio = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {stockName, ratio, splitDate, preview, type, note} = req.body || {};
        if (!stockName || !ratio || !splitDate) {
          res.status(400).json({success: false, error: "stockName/ratio/splitDate 필수"});
          return;
        }
        if (typeof ratio !== "number" || ratio <= 0 || ratio === 1) {
          res.status(400).json({success: false, error: "ratio는 0보다 큰 1이 아닌 숫자 (5=병합, 0.001=분할)"});
          return;
        }

        // 대상 trade 조회 (splitDate 이전)
        const tradesSnap = await db.collection("trades")
          .where("stockName", "==", stockName)
          .get();

        const targets: Array<{id: string; data: any}> = [];
        tradesSnap.forEach((d) => {
          const data = d.data();
          if (!data.date || data.date >= splitDate) return; // 분할일 이후는 제외
          if (data.type !== "buy" && data.type !== "sell") return;
          targets.push({id: d.id, data});
        });

        // stock 문서 조회 (firstBuyPrice/Quantity 보정 + filled 슬롯 직접 보정 + 이력 기록)
        const stockSnap = await db.collection("stocks").where("name", "==", stockName).limit(1).get();
        const stockDoc = stockSnap.empty ? null : stockSnap.docs[0];
        const stockData = stockDoc ? stockDoc.data() : null;

        // 정정 계산 (trade)
        const changes = targets.map(({id, data}) => {
          const oldPrice = Number(data.price) || 0;
          const oldQty = Number(data.quantity) || 0;
          // 병합 (ratio > 1): qty ÷ ratio, price × ratio
          // 분할 (ratio < 1): qty × (1/ratio), price × ratio
          const newQty = Math.round(oldQty / ratio);
          const newPrice = Math.round(oldPrice * ratio);
          return {
            tradeId: id,
            type: data.type,
            date: data.date,
            before: {price: oldPrice, quantity: oldQty, total: oldPrice * oldQty},
            after: {price: newPrice, quantity: newQty, total: newPrice * newQty},
          };
        });

        // stock의 firstBuyPrice/Quantity 보정 변화 계산 (효력일 이전이면)
        let firstBuyBackup: {price?: number; quantity?: number} | null = null;
        const stockUpdate: Record<string, any> = {};
        if (stockData) {
          // firstBuy 정보가 효력일 이전 1차 매수 데이터라고 가정
          // 1차 매수 trade가 splitDate 이전이면 보정 필요
          const firstBuy = (stockData.buyPlans || []).find((b: any) => b.level === 1);
          if (firstBuy && firstBuy.filledDate && firstBuy.filledDate < splitDate) {
            const oldP = Number(stockData.firstBuyPrice) || 0;
            const oldQ = Number(stockData.firstBuyQuantity) || 0;
            if (oldP > 0 || oldQ > 0) {
              firstBuyBackup = {price: oldP, quantity: oldQ};
              stockUpdate.firstBuyPrice = Math.round(oldP * ratio);
              stockUpdate.firstBuyQuantity = Math.round(oldQ / ratio);
            }
          }
        }

        // filled 슬롯 보정 변화 계산 (효력일 이전 filledDate)
        const slotChanges: Array<{kind: string; key: string | number; before: any; after: any}> = [];
        const newBuyPlans = Array.isArray(stockData?.buyPlans) ? stockData!.buyPlans.map((b: any) => {
          if (b.filled && b.filledDate && b.filledDate < splitDate) {
            const oldP = Number(b.filledPrice) || 0;
            const oldQ = Number(b.filledQuantity) || 0;
            const newP = Math.round(oldP * ratio);
            const newQ = Math.round(oldQ / ratio);
            slotChanges.push({
              kind: "buyPlan",
              key: b.level,
              before: {price: oldP, quantity: oldQ},
              after: {price: newP, quantity: newQ},
            });
            return {...b, filledPrice: newP, filledQuantity: newQ, price: newP, quantity: newQ};
          }
          return b;
        }) : null;

        const newSellPlans = Array.isArray(stockData?.sellPlans) ? stockData!.sellPlans.map((s: any) => {
          if (s.filled && s.filledDate && s.filledDate < splitDate) {
            const oldP = Number(s.filledPrice) || 0;
            const oldQ = Number(s.filledQuantity) || 0;
            const newP = Math.round(oldP * ratio);
            const newQ = Math.round(oldQ / ratio);
            slotChanges.push({
              kind: "sellPlan",
              key: s.percent,
              before: {price: oldP, quantity: oldQ},
              after: {price: newP, quantity: newQ},
            });
            return {...s, filledPrice: newP, filledQuantity: newQ};
          }
          return s;
        }) : null;

        const newMaSells = Array.isArray(stockData?.maSells) ? stockData!.maSells.map((m: any) => {
          if (m.filled && m.filledDate && m.filledDate < splitDate) {
            const oldP = Number(m.price) || 0;
            const oldQ = Number(m.quantity) || 0;
            const newP = Math.round(oldP * ratio);
            const newQ = Math.round(oldQ / ratio);
            slotChanges.push({
              kind: "maSell",
              key: m.ma,
              before: {price: oldP, quantity: oldQ},
              after: {price: newP, quantity: newQ},
            });
            return {...m, price: newP, quantity: newQ};
          }
          return m;
        }) : null;

        if (preview === true) {
          res.json({
            success: true,
            preview: true,
            ratio,
            splitDate,
            total: targets.length,
            changes,
            slotChanges,
            firstBuyChange: firstBuyBackup ? {
              before: firstBuyBackup,
              after: {price: stockUpdate.firstBuyPrice, quantity: stockUpdate.firstBuyQuantity},
            } : null,
          });
          return;
        }

        if (targets.length === 0 && slotChanges.length === 0 && !firstBuyBackup) {
          res.json({success: true, message: "정정 대상 trade/슬롯 없음", preview: false, changes: []});
          return;
        }

        // action ID 생성 (timestamp 기반)
        const actionId = `ca_${splitDate.replace(/-/g, "")}_${Date.now()}`;

        // 1) 보정 전 trade 백업 (롤백용)
        const backupBatch = db.batch();
        for (const c of changes) {
          backupBatch.set(
            db.collection("trades_backup_corporate_action").doc(`${actionId}_${c.tradeId}`),
            {
              actionId,
              stockName,
              tradeId: c.tradeId,
              before: c.before,
              type: c.type,
              date: c.date,
              backedUpAt: Date.now(),
            }
          );
        }
        if (changes.length > 0) await backupBatch.commit();

        // 2) trade 일괄 update
        const updateBatch = db.batch();
        for (const c of changes) {
          updateBatch.update(db.collection("trades").doc(c.tradeId), {
            price: c.after.price,
            quantity: c.after.quantity,
          });
        }
        if (changes.length > 0) await updateBatch.commit();

        // 3) stock 보정 (firstBuyPrice/Quantity + filled 슬롯 + corporateActions 이력)
        if (stockDoc && (Object.keys(stockUpdate).length > 0 || slotChanges.length > 0)) {
          const corporateAction = {
            id: actionId,
            date: splitDate,
            ratio,
            type: type || (ratio > 1 ? "reverseSplit" : "forwardSplit"),
            note: note || "",
            appliedAt: Date.now(),
            affectedTradeIds: changes.map((c) => c.tradeId),
            backupFirstBuyPrice: firstBuyBackup?.price,
            backupFirstBuyQuantity: firstBuyBackup?.quantity,
            slotChanges,
          };
          if (newBuyPlans) stockUpdate.buyPlans = newBuyPlans;
          if (newSellPlans) stockUpdate.sellPlans = newSellPlans;
          if (newMaSells) stockUpdate.maSells = newMaSells;
          stockUpdate.corporateActions = [
            ...(Array.isArray(stockData?.corporateActions) ? stockData!.corporateActions : []),
            corporateAction,
          ];
          stockUpdate.updatedAt = Date.now();
          await stockDoc.ref.update(stockUpdate);
        } else if (stockDoc) {
          // 슬롯 변경 없어도 이력은 기록
          const corporateAction = {
            id: actionId,
            date: splitDate,
            ratio,
            type: type || (ratio > 1 ? "reverseSplit" : "forwardSplit"),
            note: note || "",
            appliedAt: Date.now(),
            affectedTradeIds: changes.map((c) => c.tradeId),
            slotChanges: [],
          };
          await stockDoc.ref.update({
            corporateActions: [
              ...(Array.isArray(stockData?.corporateActions) ? stockData!.corporateActions : []),
              corporateAction,
            ],
            updatedAt: Date.now(),
          });
        }

        console.log(`[applySplitMergeRatio] ${stockName} ratio=${ratio} splitDate=${splitDate}: ${changes.length}건 trade + ${slotChanges.length}건 슬롯 정정 (action=${actionId})`);

        // 4) 자동 reconcile (buyPlans/sellPlans 재정렬 — manualOverride 보호됨)
        const reconcileResult = await reconcileStockPlans(stockName);

        res.json({
          success: true,
          preview: false,
          ratio,
          splitDate,
          actionId,
          appliedCount: changes.length,
          slotChangedCount: slotChanges.length,
          changes,
          slotChanges,
          reconcile: reconcileResult,
        });
      } catch (error: any) {
        console.error("[applySplitMergeRatio] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 감자/분할/합병 보정 되돌리기
 * POST /revertCorporateAction
 * body: { stockName, actionId }
 *
 * trades_backup_corporate_action에서 백업된 데이터로 trade 복구하고,
 * stock의 corporateActions 배열에서 해당 action 제거,
 * firstBuyPrice/Quantity도 백업값으로 복구.
 */
export const revertCorporateAction = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {stockName, actionId} = req.body || {};
        if (!stockName || !actionId) {
          res.status(400).json({success: false, error: "stockName/actionId 필수"});
          return;
        }

        const stockSnap = await db.collection("stocks").where("name", "==", stockName).limit(1).get();
        if (stockSnap.empty) {
          res.status(404).json({success: false, error: `${stockName} 종목 없음`});
          return;
        }
        const stockDoc = stockSnap.docs[0];
        const stockData = stockDoc.data();
        const actions = Array.isArray(stockData.corporateActions) ? stockData.corporateActions : [];
        const action = actions.find((a: any) => a.id === actionId);
        if (!action) {
          res.status(404).json({success: false, error: `보정 이력 ${actionId} 없음`});
          return;
        }

        // 백업된 trade 데이터 조회
        const backupSnap = await db.collection("trades_backup_corporate_action")
          .where("actionId", "==", actionId).get();

        // trade 복구
        const restoreBatch = db.batch();
        let restored = 0;
        backupSnap.forEach((d) => {
          const bk = d.data();
          if (bk.tradeId && bk.before) {
            restoreBatch.update(db.collection("trades").doc(bk.tradeId), {
              price: bk.before.price,
              quantity: bk.before.quantity,
            });
            restored++;
          }
        });
        if (restored > 0) await restoreBatch.commit();

        // 백업 doc 삭제
        const deleteBatch = db.batch();
        backupSnap.forEach((d) => deleteBatch.delete(d.ref));
        if (!backupSnap.empty) await deleteBatch.commit();

        // stock 복구
        const stockUpdate: Record<string, any> = {
          corporateActions: actions.filter((a: any) => a.id !== actionId),
          updatedAt: Date.now(),
        };

        // firstBuy 복구
        if (typeof action.backupFirstBuyPrice === "number") {
          stockUpdate.firstBuyPrice = action.backupFirstBuyPrice;
        }
        if (typeof action.backupFirstBuyQuantity === "number") {
          stockUpdate.firstBuyQuantity = action.backupFirstBuyQuantity;
        }

        // 슬롯 변경 복구
        const slotChanges = Array.isArray(action.slotChanges) ? action.slotChanges : [];
        if (slotChanges.length > 0) {
          const buyPlans = Array.isArray(stockData.buyPlans) ? [...stockData.buyPlans] : [];
          const sellPlans = Array.isArray(stockData.sellPlans) ? [...stockData.sellPlans] : [];
          const maSells = Array.isArray(stockData.maSells) ? [...stockData.maSells] : [];

          for (const sc of slotChanges) {
            if (sc.kind === "buyPlan") {
              const idx = buyPlans.findIndex((b: any) => b.level === sc.key);
              if (idx >= 0) {
                buyPlans[idx] = {
                  ...buyPlans[idx],
                  filledPrice: sc.before.price,
                  filledQuantity: sc.before.quantity,
                  price: sc.before.price,
                  quantity: sc.before.quantity,
                };
              }
            } else if (sc.kind === "sellPlan") {
              const idx = sellPlans.findIndex((s: any) => s.percent === sc.key);
              if (idx >= 0) {
                sellPlans[idx] = {...sellPlans[idx], filledPrice: sc.before.price, filledQuantity: sc.before.quantity};
              }
            } else if (sc.kind === "maSell") {
              const idx = maSells.findIndex((m: any) => m.ma === sc.key);
              if (idx >= 0) {
                maSells[idx] = {...maSells[idx], price: sc.before.price, quantity: sc.before.quantity};
              }
            }
          }
          stockUpdate.buyPlans = buyPlans;
          stockUpdate.sellPlans = sellPlans;
          stockUpdate.maSells = maSells;
        }

        await stockDoc.ref.update(stockUpdate);
        console.log(`[revertCorporateAction] ${stockName} ${actionId} 복구: trade ${restored}건 + 슬롯 ${slotChanges.length}건`);

        // reconcile (전체 재정렬)
        const reconcileResult = await reconcileStockPlans(stockName);

        res.json({
          success: true,
          actionId,
          restoredTrades: restored,
          restoredSlots: slotChanges.length,
          reconcile: reconcileResult,
        });
      } catch (error: any) {
        console.error("[revertCorporateAction] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 종목 buyPlans + 핵심 필드 수동 수정 (admin 직접 패치)
 * POST /manualBuyEdit
 * body: {
 *   stockName: "...",
 *   buyPlanEdits?: [{level, set: {filled, filledPrice, filledQuantity, filledDate, price, quantity, manualOverride}}],
 *   topFields?: { firstBuyPrice?, firstBuyQuantity?, currentPrice?, avgPrice?, totalQuantity? }
 * }
 *
 * 종목상세 "기본 정보 수정"의 백엔드 강제 저장용.
 * - 응답 await으로 실패 즉시 사용자 알림 가능
 * - Race condition 차단 (백엔드 atomic update)
 */
export const manualBuyEdit = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {stockName, buyPlanEdits = [], topFields = {}} = req.body || {};
        if (!stockName) {
          res.status(400).json({success: false, error: "stockName 필수"});
          return;
        }

        const snap = await db.collection("stocks").where("name", "==", stockName).limit(1).get();
        if (snap.empty) {
          res.status(404).json({success: false, error: `${stockName} 종목 없음`});
          return;
        }
        const docRef = snap.docs[0].ref;
        const data = snap.docs[0].data();

        const buyPlans = Array.isArray(data.buyPlans) ? [...data.buyPlans] : [];
        const changes: any[] = [];

        // buyPlans 편집 (level 기준)
        for (const e of buyPlanEdits) {
          const idx = buyPlans.findIndex((b: any) => b.level === e.level);
          if (idx < 0) {
            changes.push({type: "buyPlan", level: e.level, status: "not_found"});
            continue;
          }
          const before = {...buyPlans[idx]};
          const merged = {...buyPlans[idx], ...e.set};
          // manualOverride: e.set에서 명시 안 했으면 기존값 유지 (false 명시 가능)
          if ("manualOverride" in (e.set || {})) {
            merged.manualOverride = e.set.manualOverride === true;
          }
          buyPlans[idx] = merged;
          changes.push({type: "buyPlan", level: e.level, status: "updated", before, after: merged});
        }

        // topFields 편집 (avgPrice/totalQuantity 등)
        const topAllowed: Record<string, any> = {};
        for (const k of ["firstBuyPrice", "firstBuyQuantity", "currentPrice", "avgPrice", "totalQuantity"]) {
          if (k in topFields) topAllowed[k] = topFields[k];
        }

        await docRef.update({
          buyPlans,
          ...topAllowed,
          updatedAt: Date.now(),
        });

        // ✅ 사용자 편집 직후 reconcile 자동 실행:
        // - 옛 자동매핑 stale 슬롯이 trades와 불일치하는 경우 정리
        // - 옵션 C(consumedByManual)로 manualOverride 슬롯은 자동 보존
        let reconcile: any = null;
        try {
          reconcile = await reconcileStockPlans(stockName);
        } catch (e: any) {
          console.error(`[manualBuyEdit] reconcile 실패: ${e.message}`);
        }

        res.json({success: true, stockName, changes, buyPlans, ...topAllowed, reconcile});
      } catch (error: any) {
        console.error("[manualBuyEdit] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 종목 sellPlans/maSells 수동 수정 (admin 직접 패치)
 * POST /manualSellEdit
 * body: {
 *   stockName: "...",
 *   sellPlanEdits?: [{percent, set: {filled, filledPrice, filledQuantity, filledDate, manualOverride, consumedTradeIds?}}],
 *   maSellEdits?: [{ma, set: {filled, price, quantity, filledDate, insertAfterPercent, splitFromPercent, consumedTradeIds?}}]
 * }
 *
 * ✅ 옵션 D: consumedTradeIds[] 가 set에 포함되면 reconcile이 정확히 그 trade.id만 흡수.
 * 클라이언트 saveStock 디바운스 race condition 우회용 (즉시 atomic 적용).
 * sellPlans / maSells의 임의 슬롯을 수정하고 manualOverride 자동 부여.
 */
export const manualSellEdit = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {stockName, sellPlanEdits = [], maSellEdits = []} = req.body || {};
        if (!stockName) {
          res.status(400).json({success: false, error: "stockName 필수"});
          return;
        }

        const snap = await db.collection("stocks").where("name", "==", stockName).limit(1).get();
        if (snap.empty) {
          res.status(404).json({success: false, error: `${stockName} 종목 없음`});
          return;
        }
        const docRef = snap.docs[0].ref;
        const data = snap.docs[0].data();

        const sellPlans = Array.isArray(data.sellPlans) ? [...data.sellPlans] : [];
        let maSells = Array.isArray(data.maSells) ? [...data.maSells] : [];

        const changes: any[] = [];

        // sellPlans 편집
        for (const e of sellPlanEdits) {
          const idx = sellPlans.findIndex((p: any) => p.percent === e.percent);
          if (idx < 0) {
            changes.push({type: "sellPlan", percent: e.percent, status: "not_found"});
            continue;
          }
          const before = {...sellPlans[idx]};
          sellPlans[idx] = {
            ...sellPlans[idx],
            ...e.set,
            // manualOverride는 자동 true (수동 편집의 핵심)
            manualOverride: e.set?.manualOverride !== false,
          };
          changes.push({type: "sellPlan", percent: e.percent, status: "updated", before, after: sellPlans[idx]});
        }

        // maSells 편집 (없으면 추가)
        for (const e of maSellEdits) {
          let idx = maSells.findIndex((m: any) => m.ma === e.ma);
          if (idx < 0) {
            // 슬롯 신규 생성
            maSells.push({ma: e.ma, price: 0, quantity: 0, filled: false});
            idx = maSells.length - 1;
          }
          const before = {...maSells[idx]};
          maSells[idx] = {
            ...maSells[idx],
            ...e.set,
          };
          changes.push({type: "maSell", ma: e.ma, status: "updated", before, after: maSells[idx]});
        }

        // 누락된 표준 MA 슬롯(20/60/120) 보강
        for (const ma of [20, 60, 120]) {
          if (!maSells.find((m: any) => m.ma === ma)) {
            maSells.push({ma, price: 0, quantity: 0, filled: false});
          }
        }
        // ma 순서 정렬
        maSells = maSells.sort((a: any, b: any) => a.ma - b.ma);

        // sellCount 재계산
        const sellCount = sellPlans.filter((p: any) => p.filled).length +
          maSells.filter((m: any) => m.filled).length;

        await docRef.update({
          sellPlans,
          maSells,
          sellCount,
          updatedAt: Date.now(),
        });

        // ✅ 방안 B: 편집된 슬롯의 consumedTradeIds trade에 sellSlot 태그 동기화
        //   사용자가 미분류 매도를 +N%/MA로 분류하면, 그 trade의 sellSlot도 함께 갱신
        //   → 태그 기반 미분류 감지(tradeTagBasedMapping)와 일관 유지
        try {
          const tagBatch = db.batch();
          let tagCount = 0;
          for (const e of sellPlanEdits) {
            const ids = e.set?.consumedTradeIds;
            if (Array.isArray(ids)) {
              for (const id of ids) {
                if (!id) continue;
                tagBatch.update(db.collection("trades").doc(String(id)), {sellSlot: `+${e.percent}%`});
                tagCount++;
              }
            }
          }
          for (const e of maSellEdits) {
            const ids = e.set?.consumedTradeIds;
            if (Array.isArray(ids)) {
              for (const id of ids) {
                if (!id) continue;
                tagBatch.update(db.collection("trades").doc(String(id)), {sellSlot: `MA${e.ma}`});
                tagCount++;
              }
            }
          }
          if (tagCount > 0) await tagBatch.commit();
        } catch (e: any) {
          console.warn(`[manualSellEdit] sellSlot 태그 동기화 실패: ${e.message}`);
        }

        // ✅ 사용자 편집 직후 reconcile 자동 실행 (옵션 A: 원천 해결):
        // - manualOverride=true 슬롯이 trade를 흡수한 후 옛 자동매핑이 stale로 남는 케이스 자동 청소
        // - 옵션 C(consumedByManual)로 manualOverride/maSells filled 합만큼 sortedSells skip
        // - 남은 trade가 없으면 non-manualOverride 슬롯의 filled=true는 자동 리셋
        // - reconcile 내부에 latest doc 재조회+manualOverride 최종 보호 있어서 race 안전
        let reconcile: any = null;
        try {
          reconcile = await reconcileStockPlans(stockName);
        } catch (e: any) {
          console.error(`[manualSellEdit] reconcile 실패: ${e.message}`);
        }

        // reconcile 후 최신 sellPlans/maSells 재조회 (UI에 정확한 결과 반환)
        let finalSellPlans = sellPlans;
        let finalMaSells = maSells;
        try {
          const refreshed = await docRef.get();
          const rd = refreshed.data() || {};
          if (Array.isArray(rd.sellPlans)) finalSellPlans = rd.sellPlans;
          if (Array.isArray(rd.maSells)) finalMaSells = rd.maSells;
        } catch (e) {
          // ignore
        }

        res.json({success: true, stockName, changes, sellPlans: finalSellPlans, maSells: finalMaSells, reconcile});
      } catch (error: any) {
        console.error("[manualSellEdit] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

export const renameStock = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {fromName, toName, code} = req.body || {};
        if (!fromName || !toName) {
          res.status(400).json({success: false, error: "fromName/toName 필수"});
          return;
        }
        if (fromName === toName) {
          res.status(400).json({success: false, error: "fromName과 toName이 동일"});
          return;
        }

        const result: any = {
          fromName,
          toName,
          tradesRenamed: 0,
          stockRenamed: false,
          conflict: false,
          reconcile: null,
        };

        // 1. trades stockName 변경
        const tradesSnap = await db.collection("trades")
          .where("stockName", "==", fromName)
          .get();

        if (!tradesSnap.empty) {
          const batch = db.batch();
          tradesSnap.forEach((doc) => {
            const update: any = {stockName: toName};
            if (code && !doc.data().code) {
              update.code = code;
            }
            batch.update(doc.ref, update);
          });
          await batch.commit();
          result.tradesRenamed = tradesSnap.size;
          console.log(`[renameStock] trades ${tradesSnap.size}건 ${fromName} → ${toName}`);
        }

        // 2. stocks 문서 이름 변경
        const fromStockSnap = await db.collection("stocks")
          .where("name", "==", fromName)
          .limit(1)
          .get();

        if (!fromStockSnap.empty) {
          const fromDoc = fromStockSnap.docs[0];
          const fromData = fromDoc.data();

          // 새 이름이 이미 stocks 컬렉션에 있는지 확인
          const toStockSnap = await db.collection("stocks")
            .where("name", "==", toName)
            .limit(1)
            .get();

          if (!toStockSnap.empty) {
            // 충돌: 두 stocks 문서를 자동 병합하지 않고 보고
            result.conflict = true;
            result.conflictMessage = `이미 stocks 컬렉션에 "${toName}" 문서가 존재합니다. 수동 병합이 필요합니다. fromDocId=${fromDoc.id}, toDocId=${toStockSnap.docs[0].id}`;
            console.log(`[renameStock] 충돌: ${result.conflictMessage}`);
          } else {
            // 단순 rename
            const updateData: any = {name: toName, updatedAt: Date.now()};
            if (code && !fromData.code) {
              updateData.code = code;
            }
            await fromDoc.ref.update(updateData);
            result.stockRenamed = true;
            console.log(`[renameStock] stocks: ${fromName} → ${toName} (docId=${fromDoc.id})`);
          }
        } else {
          console.log(`[renameStock] stocks에 ${fromName} 문서 없음 (trades만 rename)`);
        }

        // 3. reconcile (충돌 없을 때만)
        if (!result.conflict) {
          result.reconcile = await reconcileStockPlans(toName);
        }

        res.json({success: true, ...result});
      } catch (error: any) {
        console.error("[renameStock] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 휴지통 자동 영구삭제 (stocks_trash)
 *
 * 정책:
 *   - 사용자가 매매완료 탭에서 종목 삭제 시 stocks_trash 로 이동 (30일 보관)
 *   - expiresAt = deletedAt + 30일
 *   - 매일 KST 03:30 실행하여 expiresAt < now() 인 문서 영구삭제
 *
 * 안전:
 *   - 한 번에 최대 500건 (Firestore batch 제한)
 *   - 실패해도 다음 날 재시도되므로 멱등
 */
export const purgeExpiredTrash = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 120})
  .pubsub.schedule("30 3 * * *")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    const startedAt = Date.now();
    console.log("[purgeExpiredTrash] 시작");

    try {
      const expired = await db
        .collection("stocks_trash")
        .where("expiresAt", "<", startedAt)
        .limit(500)
        .get();

      if (expired.empty) {
        console.log("[purgeExpiredTrash] 영구삭제 대상 없음");
        return null;
      }

      const batch = db.batch();
      expired.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();

      const elapsed = Date.now() - startedAt;
      console.log(
        `[purgeExpiredTrash] ${expired.size}건 영구삭제 완료 (${elapsed}ms)`
      );

      await db.collection("settings").doc("lastTrashPurge").set({
        timestamp: startedAt,
        purgedCount: expired.size,
        elapsedMs: elapsed,
      });
    } catch (err: any) {
      console.error("[purgeExpiredTrash] 실패:", err.message);
      await db.collection("settings").doc("lastTrashPurge").set({
        timestamp: startedAt,
        error: err.message,
        elapsedMs: Date.now() - startedAt,
      });
    }

    return null;
  });


/**
 * ─── 마이그레이션 안전장치: 전체 백업 endpoint ───
 *
 * POST /backupCollections
 * body: { label?: string }  // 예: "pre-credit-phase1"
 *
 * stocks + trades 컬렉션 전체를 timestamp 백업 컬렉션으로 복사.
 * 백업 컬렉션명: `{collection}_backup_{label}_{timestamp}`
 *
 * 사용 예:
 *   curl -X POST .../backupCollections -d '{"label":"pre-credit-phase1"}'
 *
 * 복구는 restoreFromBackup endpoint 사용.
 */
export const backupCollections = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540, memory: "512MB"})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {label = "manual"} = req.body || {};
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const stocksBackupName = `stocks_backup_${label}_${ts}`;
        const tradesBackupName = `trades_backup_${label}_${ts}`;

        // stocks 백업
        const stocksSnap = await db.collection("stocks").get();
        let stocksCount = 0;
        let batch = db.batch();
        let batchCount = 0;
        for (const doc of stocksSnap.docs) {
          batch.set(db.collection(stocksBackupName).doc(doc.id), {
            ...doc.data(),
            _backupAt: Date.now(),
            _backupLabel: label,
            _originalDocId: doc.id,
          });
          stocksCount++;
          batchCount++;
          if (batchCount >= 400) {
            await batch.commit();
            batch = db.batch();
            batchCount = 0;
          }
        }
        if (batchCount > 0) await batch.commit();

        // trades 백업
        const tradesSnap = await db.collection("trades").get();
        let tradesCount = 0;
        batch = db.batch();
        batchCount = 0;
        for (const doc of tradesSnap.docs) {
          batch.set(db.collection(tradesBackupName).doc(doc.id), {
            ...doc.data(),
            _backupAt: Date.now(),
            _backupLabel: label,
            _originalDocId: doc.id,
          });
          tradesCount++;
          batchCount++;
          if (batchCount >= 400) {
            await batch.commit();
            batch = db.batch();
            batchCount = 0;
          }
        }
        if (batchCount > 0) await batch.commit();

        // 백업 메타 기록
        await db.collection("settings").doc(`backup_${ts}`).set({
          label,
          timestamp: ts,
          stocksBackupName,
          tradesBackupName,
          stocksCount,
          tradesCount,
          createdAt: Date.now(),
        });

        console.log(`[backupCollections] ${label} 백업 완료: stocks ${stocksCount}건 → ${stocksBackupName}, trades ${tradesCount}건 → ${tradesBackupName}`);
        res.json({
          success: true,
          label,
          timestamp: ts,
          stocksBackupName,
          tradesBackupName,
          stocksCount,
          tradesCount,
        });
      } catch (error: any) {
        console.error("[backupCollections] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 백업에서 복원
 * POST /restoreFromBackup
 * body: { stocksBackupName, tradesBackupName, deleteCurrent?: boolean }
 *
 * deleteCurrent=true이면 현재 stocks/trades 전체 삭제 후 복원 (위험)
 * 기본은 백업 데이터로 덮어쓰기만 (현재 doc 보존, 백업 docId 기준 upsert)
 *
 * 사용 시 매우 신중히 확인.
 */
export const restoreFromBackup = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 540, memory: "512MB"})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {stocksBackupName, tradesBackupName, deleteCurrent = false, confirm} = req.body || {};
        if (!stocksBackupName || !tradesBackupName) {
          res.status(400).json({success: false, error: "stocksBackupName/tradesBackupName 필수"});
          return;
        }
        if (confirm !== "YES_RESTORE_OVERWRITE") {
          res.status(400).json({
            success: false,
            error: "안전 확인 필요: confirm 필드에 'YES_RESTORE_OVERWRITE' 보내야 실행",
          });
          return;
        }

        // 백업 존재 확인
        const stocksBackupSnap = await db.collection(stocksBackupName).get();
        const tradesBackupSnap = await db.collection(tradesBackupName).get();
        if (stocksBackupSnap.empty && tradesBackupSnap.empty) {
          res.status(404).json({success: false, error: "백업 컬렉션이 비어있거나 존재하지 않음"});
          return;
        }

        // 현재 데이터를 먼저 "복원 직전 백업"으로 저장 (롤백의 롤백 가능)
        const safetyTs = new Date().toISOString().replace(/[:.]/g, "-");
        const safetyStocksName = `stocks_pre_restore_${safetyTs}`;
        const safetyTradesName = `trades_pre_restore_${safetyTs}`;

        const currentStocksSnap = await db.collection("stocks").get();
        let batch = db.batch();
        let bc = 0;
        for (const doc of currentStocksSnap.docs) {
          batch.set(db.collection(safetyStocksName).doc(doc.id), doc.data());
          bc++;
          if (bc >= 400) { await batch.commit(); batch = db.batch(); bc = 0; }
        }
        if (bc > 0) await batch.commit();

        const currentTradesSnap = await db.collection("trades").get();
        batch = db.batch();
        bc = 0;
        for (const doc of currentTradesSnap.docs) {
          batch.set(db.collection(safetyTradesName).doc(doc.id), doc.data());
          bc++;
          if (bc >= 400) { await batch.commit(); batch = db.batch(); bc = 0; }
        }
        if (bc > 0) await batch.commit();

        // 현재 데이터 삭제 (옵션)
        let deletedStocks = 0;
        let deletedTrades = 0;
        if (deleteCurrent) {
          batch = db.batch();
          bc = 0;
          for (const doc of currentStocksSnap.docs) {
            batch.delete(doc.ref);
            deletedStocks++;
            bc++;
            if (bc >= 400) { await batch.commit(); batch = db.batch(); bc = 0; }
          }
          if (bc > 0) await batch.commit();

          batch = db.batch();
          bc = 0;
          for (const doc of currentTradesSnap.docs) {
            batch.delete(doc.ref);
            deletedTrades++;
            bc++;
            if (bc >= 400) { await batch.commit(); batch = db.batch(); bc = 0; }
          }
          if (bc > 0) await batch.commit();
        }

        // 백업 데이터로 복원
        let restoredStocks = 0;
        batch = db.batch();
        bc = 0;
        for (const doc of stocksBackupSnap.docs) {
          const data = doc.data();
          // 백업 메타 필드 제거
          delete data._backupAt;
          delete data._backupLabel;
          delete data._originalDocId;
          batch.set(db.collection("stocks").doc(doc.id), data);
          restoredStocks++;
          bc++;
          if (bc >= 400) { await batch.commit(); batch = db.batch(); bc = 0; }
        }
        if (bc > 0) await batch.commit();

        let restoredTrades = 0;
        batch = db.batch();
        bc = 0;
        for (const doc of tradesBackupSnap.docs) {
          const data = doc.data();
          delete data._backupAt;
          delete data._backupLabel;
          delete data._originalDocId;
          batch.set(db.collection("trades").doc(doc.id), data);
          restoredTrades++;
          bc++;
          if (bc >= 400) { await batch.commit(); batch = db.batch(); bc = 0; }
        }
        if (bc > 0) await batch.commit();

        console.log(`[restoreFromBackup] 완료: stocks ${restoredStocks}건, trades ${restoredTrades}건 복원. safety backup: ${safetyStocksName}, ${safetyTradesName}`);
        res.json({
          success: true,
          deletedStocks,
          deletedTrades,
          restoredStocks,
          restoredTrades,
          safetyBackup: {
            stocksName: safetyStocksName,
            tradesName: safetyTradesName,
          },
        });
      } catch (error: any) {
        console.error("[restoreFromBackup] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 백업 목록 조회
 * GET /listBackups
 */
export const listBackups = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const settingsSnap = await db.collection("settings").get();
        const backups: any[] = [];
        settingsSnap.forEach((d) => {
          if (d.id.startsWith("backup_")) {
            backups.push({id: d.id, ...d.data()});
          }
        });
        backups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({success: true, backups});
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * Feature Flag 관리
 * GET /featureFlags  → 현재 flag 조회
 * POST /featureFlags body: { key, value } → flag 설정
 *
 * 신용거래 Phase 1 작업 시:
 *   creditPositionsEnabled: 신용 통합 로직 활성화 (default false)
 *   creditTabEnabled: 신용종목 탭 활성화 (default false)
 *   creditMaturityAlertEnabled: 만기 알림 cron 활성화 (default false)
 *
 * flag off로 두면 새 코드는 실행되지 않고 기존 동작 그대로 유지됨.
 * 문제 발생 시 flag만 false로 바꾸면 즉시 옛 동작으로 복귀.
 */
export const featureFlags = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        if (req.method === "GET") {
          const doc = await db.collection("settings").doc("featureFlags").get();
          const data = doc.exists ? doc.data() : {};
          res.json({success: true, flags: data});
          return;
        }
        if (req.method === "POST") {
          const {key, value} = req.body || {};
          if (!key) {
            res.status(400).json({success: false, error: "key 필수"});
            return;
          }
          await db.collection("settings").doc("featureFlags").set(
            {[key]: value, [`${key}_updatedAt`]: Date.now()},
            {merge: true}
          );
          const doc = await db.collection("settings").doc("featureFlags").get();
          res.json({success: true, flags: doc.data()});
          return;
        }
        res.status(405).json({success: false, error: "GET 또는 POST만 지원"});
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * ─── Phase 2: 신용거래 만기 알림 + 일일 이자 갱신 ───
 *
 * 매일 09:00 KST cron으로 실행:
 *   1) 모든 신용 포지션의 누적 이자 재계산 (since ~ 오늘)
 *   2) 만기 D-7 / D-3 / D-1 / D-day / 만기 지난 종목 텔레그램 알림
 *
 * featureFlags.creditMaturityAlertEnabled = true 일 때만 알림 발송.
 * (이자 계산은 항상 실행 - 데이터 정확성 위해)
 *
 * 수동 호출: POST /creditMaturityCheck
 */
async function runCreditMaturityCheck(): Promise<{
  processed: number;
  imminent: Array<{name: string; dueDate: string; dDay: number; creditAmt: number}>;
  overdue: Array<{name: string; dueDate: string; overdueDays: number; creditAmt: number}>;
}> {
  const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
  const today = kst.toISOString().slice(0, 10);
  console.log(`[creditMaturity] 체크 시작 ${today}`);

  const stocksSnap = await db.collection("stocks").get();
  let processed = 0;
  const imminent: Array<{name: string; dueDate: string; dDay: number; creditAmt: number}> = [];
  const overdue: Array<{name: string; dueDate: string; overdueDays: number; creditAmt: number}> = [];

  for (const doc of stocksSnap.docs) {
    const data = doc.data();
    if (!Array.isArray(data.positions)) continue;
    if ((data.totalQuantity || 0) === 0) continue;

    const creditIdx = data.positions.findIndex((p: any) => p.type === "credit");
    if (creditIdx === -1) continue;

    const credit = data.positions[creditIdx];
    if (!credit.since) continue;

    // 누적 이자 재계산
    const creditAmt = credit.quantity * credit.avgPrice;
    const interestRate = credit.interestRate || 0.075;
    const newAccrued = calcAccruedInterest(creditAmt, credit.since, today, interestRate);
    const dueDate = credit.dueDate || calcCreditDueDate(credit.since);

    // positions 갱신
    const newPositions = [...data.positions];
    newPositions[creditIdx] = {
      ...credit,
      dueDate: dueDate || credit.dueDate,
      interestAccrued: newAccrued,
      interestAsOf: today,
      interestRate,
    };
    await doc.ref.update({positions: newPositions, updatedAt: Date.now()});
    processed++;

    // 만기 D-day 계산
    if (dueDate) {
      const due = new Date(dueDate);
      const dDay = Math.ceil((due.getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24));
      if (dDay >= 0 && dDay <= 7) {
        imminent.push({name: data.name, dueDate, dDay, creditAmt});
      } else if (dDay < 0) {
        overdue.push({name: data.name, dueDate, overdueDays: -dDay, creditAmt});
      }
    }
  }

  // 텔레그램 알림 (featureFlag ON일 때만)
  try {
    const flagsDoc = await db.collection("settings").doc("featureFlags").get();
    const flags = flagsDoc.exists ? flagsDoc.data() || {} : {};
    if (flags.creditMaturityAlertEnabled === true && (imminent.length > 0 || overdue.length > 0)) {
      let msg = `<b>💳 신용거래 만기 알림</b>\n`;
      msg += `<i>${today}</i>\n\n`;

      if (overdue.length > 0) {
        msg += `<b>🔴 만기 경과 (반대매매 위험!)</b>\n`;
        for (const o of overdue) {
          msg += `📌 ${o.name}: ${o.dueDate} (${o.overdueDays}일 경과) · 잔고 ${o.creditAmt.toLocaleString()}원\n`;
        }
        msg += `\n`;
      }

      if (imminent.length > 0) {
        msg += `<b>⚠️ 만기 D-7 이내</b>\n`;
        imminent.sort((a, b) => a.dDay - b.dDay);
        for (const i of imminent) {
          const emoji = i.dDay <= 1 ? "🚨" : i.dDay <= 3 ? "⚠️" : "⏰";
          msg += `${emoji} ${i.name}: ${i.dueDate} (D-${i.dDay}) · 잔고 ${i.creditAmt.toLocaleString()}원\n`;
        }
        msg += `\n`;
      }

      msg += `<i>👉 만기 도래 종목은 매도 또는 만기 연장(현물 전환) 검토하세요.</i>`;
      await sendTelegram(msg);
      console.log(`[creditMaturity] 텔레그램 발송: 임박 ${imminent.length}, 경과 ${overdue.length}`);
    } else {
      console.log(`[creditMaturity] 알림 스킵 (flag=${flags.creditMaturityAlertEnabled}, imminent=${imminent.length}, overdue=${overdue.length})`);
    }
  } catch (e: any) {
    console.warn(`[creditMaturity] 텔레그램 발송 실패: ${e.message}`);
  }

  return {processed, imminent, overdue};
}

/**
 * 신용거래 만기/이자 일일 cron
 * 매일 09:00 KST 평일 실행
 */
export const creditMaturityCron = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 300})
  .pubsub.schedule("0 9 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    const result = await runCreditMaturityCheck();
    console.log(`[creditMaturityCron] 완료: processed=${result.processed}, imminent=${result.imminent.length}, overdue=${result.overdue.length}`);
  });

/**
 * 수동 trade 주입 (어드민 — 키움 API에서 안 가져오는 신용 매수 등 보강용)
 * POST /manualInjectTrade
 * body: { stockName, code, date, type, price, quantity, memo?, isCreditTrade?, tags? }
 *
 * 안전 가드:
 *   1) 같은 (stockName, date, type, price, quantity) 조합 trade가 이미 있으면 중복 거부
 *   2) tradeId = "trade_manual_${ts}_${stockName_slug}"
 *   3) reconcileStockPlans 자동 호출
 */
export const manualInjectTrade = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const {
          stockName, code, date, type, price, quantity,
          memo = "", isCreditTrade = false, tags = [],
          tradeIdOverride = "",
        } = req.body || {};
        if (!stockName || !date || !type || !price || !quantity) {
          res.status(400).json({success: false, error: "stockName/date/type/price/quantity 필수"});
          return;
        }
        if (type !== "buy" && type !== "sell") {
          res.status(400).json({success: false, error: "type은 buy 또는 sell"});
          return;
        }

        // tradeIdOverride 지정 시: 그 id 존재로만 중복 판정(같은 가격·수량 다건 매도 보강용).
        //   미지정 시: 기존 동작(같은 종목·날짜·타입·가격·수량 = 중복 거부).
        if (tradeIdOverride) {
          const ex = await db.collection("trades").doc(String(tradeIdOverride)).get();
          if (ex.exists) {
            res.status(409).json({success: false, error: "중복 trade 존재(id)", existingId: tradeIdOverride});
            return;
          }
        } else {
          const existing = await db.collection("trades")
            .where("stockName", "==", stockName)
            .where("date", "==", date)
            .where("type", "==", type)
            .get();
          for (const doc of existing.docs) {
            const t = doc.data();
            if (Number(t.price) === Number(price) && Number(t.quantity) === Number(quantity)) {
              res.status(409).json({
                success: false,
                error: "중복 trade 존재",
                existingId: doc.id,
                existing: t,
              });
              return;
            }
          }
        }

        const ts = Date.now();
        const slug = stockName.replace(/[^a-zA-Z0-9가-힣]/g, "").slice(0, 20);
        const tradeId = tradeIdOverride ? String(tradeIdOverride) : `trade_manual_${ts}_${slug}`;

        const finalTags: string[] = Array.isArray(tags) ? [...tags] : [];
        if (isCreditTrade && !finalTags.includes("신용")) finalTags.push("신용");

        await db.collection("trades").doc(tradeId).set({
          date,
          stockName,
          code: code || "",
          type,
          price: Number(price),
          quantity: Number(quantity),
          memo,
          tags: finalTags,
          isCreditTrade: isCreditTrade === true,
          createdAt: ts,
        });

        // 자동 reconcile
        let reconcileResult: any = null;
        try {
          reconcileResult = await reconcileStockPlans(stockName);
        } catch (e: any) {
          reconcileResult = {error: e.message};
        }

        res.json({
          success: true,
          tradeId,
          reconcile: reconcileResult,
        });
      } catch (error: any) {
        console.error("[manualInjectTrade] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 텔레그램 작동 테스트
 * POST /telegramTest body: { message?: string }
 */
export const telegramTest = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        // 설정 확인
        const settingsDoc = await db.collection("settings").doc("telegram").get();
        const settings = settingsDoc.exists ? settingsDoc.data() || {} : {};
        const hasBotToken = !!settings.botToken;
        const hasChatId = !!settings.chatId;
        const chatIdMasked = settings.chatId
          ? String(settings.chatId).slice(0, 3) + "***" + String(settings.chatId).slice(-3)
          : null;

        if (!hasBotToken || !hasChatId) {
          res.json({
            success: false,
            hasBotToken,
            hasChatId,
            error: "텔레그램 설정 누락 (settings/telegram doc의 botToken 또는 chatId 비어있음)",
          });
          return;
        }

        // 테스트 메시지 발송
        const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
        const ts = `${kst.getFullYear()}-${String(kst.getMonth() + 1).padStart(2, "0")}-${String(kst.getDate()).padStart(2, "0")} ${String(kst.getHours()).padStart(2, "0")}:${String(kst.getMinutes()).padStart(2, "0")}:${String(kst.getSeconds()).padStart(2, "0")}`;
        const msgText = (req.body && req.body.message)
          ? String(req.body.message)
          : `<b>🧪 태산 텔레그램 작동 테스트</b>\n<i>${ts} KST</i>\n\n` +
            `✅ 봇 토큰 정상\n` +
            `✅ 채팅 ID 정상 (${chatIdMasked})\n` +
            `✅ Cloud Function 정상\n\n` +
            `이 메시지가 보이면 알림 시스템 OK`;

        const url = `https://api.telegram.org/bot${settings.botToken}/sendMessage`;
        const r = await fetch(url, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            chat_id: settings.chatId,
            text: msgText,
            parse_mode: "HTML",
          }),
        });
        const data = await r.json() as any;

        res.json({
          success: data.ok === true,
          hasBotToken: true,
          hasChatId: true,
          chatIdMasked,
          telegramResponse: {
            ok: data.ok,
            result: data.ok ? {
              message_id: data.result?.message_id,
              date: data.result?.date,
              chat: data.result?.chat ? {
                id: data.result.chat.id,
                type: data.result.chat.type,
                title: data.result.chat.title,
                username: data.result.chat.username,
              } : null,
            } : null,
            description: data.description,
            error_code: data.error_code,
          },
        });
      } catch (error: any) {
        console.error("[telegramTest] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 진단: 특정 날짜의 키움 매수 trade API 원본 응답
 * GET /diagKiwoomTrades?date=20260514&stockName=그래피
 *
 * 사용: 신용 매수가 누락되는지 키움 raw 응답 확인
 */
export const diagKiwoomTrades = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 60})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const date = (req.query.date as string) || "20260514";
        const filterName = (req.query.stockName as string) || "";
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);

        const results: any = {date, filterName, ka10076: null, kt00015: null, kt00009: null, kt00007: null};

        // ka10076 (당일 매수) — 단, 과거 날짜도 ord_dt로 지정 가능
        try {
          const r = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "ka10076",
            },
            body: JSON.stringify({
              ord_dt: date,
              stk_cd: "",
              sell_tp: "0", // 전체 (매수+매도) — 신용 포함 가능성 확인
              qry_tp: "0",
              stk_bond_tp: "1",
              stex_tp: "1", // 누락 파라미터 추가
              dmst_stex_tp: "KRX",
            }),
          });
          const data = await r.json() as any;
          let items: any[] = [];
          for (const key of Object.keys(data)) {
            if (Array.isArray(data[key]) && data[key].length > 0) {
              items = data[key];
              break;
            }
          }
          // 필터 적용 + 원본 그대로 표시
          const filtered = filterName
            ? items.filter((x: any) => {
                const nm = (x.stk_nm || "").trim();
                const cd = (x.stk_cd || "").trim();
                return nm.includes(filterName) || nm.replace(/^\*+/, "").includes(filterName) ||
                  cd.includes(filterName) || cd.replace(/^\*+/, "").replace(/^A/, "").includes(filterName);
              })
            : items;
          results.ka10076 = {
            return_code: data.return_code,
            return_msg: data.return_msg,
            totalItems: items.length,
            filteredCount: filtered.length,
            samples: filtered.slice(0, 5),
          };
        } catch (e: any) {
          results.ka10076 = {error: e.message};
        }

        // kt00015 (위탁종합거래내역) — 기간별
        try {
          const r = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "kt00015",
            },
            body: JSON.stringify({
              strt_dt: date,
              end_dt: date,
              tp: "0",
              gds_tp: "0",
              dmst_stex_tp: "%",
              frgn_stex_tp: "%",
              stk_cd: "",
              crnc_cd: "",
            }),
          });
          const data = await r.json() as any;
          const items: any[] = data.trst_ovrl_trde_prps_array || [];
          const filtered = filterName
            ? items.filter((x: any) => {
                const nm = (x.stk_nm || "").trim();
                const cd = (x.stk_cd || "").trim();
                return nm.includes(filterName) || nm.replace(/^\*+/, "").includes(filterName) ||
                  cd.includes(filterName) || cd.replace(/^\*+/, "").replace(/^A/, "").includes(filterName);
              })
            : items;
          results.kt00015 = {
            return_code: data.return_code,
            return_msg: data.return_msg,
            totalItems: items.length,
            filteredCount: filtered.length,
            samples: filtered.slice(0, 5),
          };
        } catch (e: any) {
          results.kt00015 = {error: e.message};
        }

        // kt00009 (계좌별주문체결현황요청) — 신용 포함 여부 시험
        try {
          const r = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "kt00009",
            },
            body: JSON.stringify({
              ord_dt: date,
              stk_cd: "",
              stk_bond_tp: "0",
              mrkt_tp: "0",
              dmst_stex_tp: "%",
              sell_tp: "0",
              qry_tp: "0",
            }),
          });
          const data = await r.json() as any;
          let items: any[] = [];
          for (const key of Object.keys(data)) {
            if (Array.isArray(data[key]) && data[key].length > 0) {
              items = data[key];
              break;
            }
          }
          const filtered = filterName
            ? items.filter((x: any) => {
                const nm = (x.stk_nm || "").trim();
                const cd = (x.stk_cd || "").trim();
                return nm.includes(filterName) || nm.replace(/^\*+/, "").includes(filterName) ||
                  cd.includes(filterName) || cd.replace(/^\*+/, "").replace(/^A/, "").includes(filterName);
              })
            : items;
          results.kt00009 = {
            return_code: data.return_code,
            return_msg: data.return_msg,
            keys: Object.keys(data).filter((k) => Array.isArray(data[k])),
            totalItems: items.length,
            filteredCount: filtered.length,
            samples: filtered.slice(0, 5),
          };
        } catch (e: any) {
          results.kt00009 = {error: e.message};
        }

        // kt00007 (계좌별주문체결내역상세) — 신용 포함 여부 시험
        try {
          const r = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "kt00007",
            },
            body: JSON.stringify({
              ord_dt: date,
              qry_tp: "1",
              stk_bond_tp: "0",
              sell_tp: "0",
              stk_cd: "",
              fr_ord_no: "",
              dmst_stex_tp: "%",
            }),
          });
          const data = await r.json() as any;
          let items: any[] = [];
          for (const key of Object.keys(data)) {
            if (Array.isArray(data[key]) && data[key].length > 0) {
              items = data[key];
              break;
            }
          }
          const filtered = filterName
            ? items.filter((x: any) => {
                const nm = (x.stk_nm || "").trim();
                const cd = (x.stk_cd || "").trim();
                return nm.includes(filterName) || nm.replace(/^\*+/, "").includes(filterName) ||
                  cd.includes(filterName) || cd.replace(/^\*+/, "").replace(/^A/, "").includes(filterName);
              })
            : items;
          results.kt00007 = {
            return_code: data.return_code,
            return_msg: data.return_msg,
            keys: Object.keys(data).filter((k) => Array.isArray(data[k])),
            totalItems: items.length,
            filteredCount: filtered.length,
            samples: filtered.slice(0, 5),
          };
        } catch (e: any) {
          results.kt00007 = {error: e.message};
        }

        res.json({success: true, ...results});
      } catch (error: any) {
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

/**
 * 신용거래 만기 체크 수동 호출 (테스트용)
 * POST /creditMaturityCheck
 */
export const creditMaturityCheck = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 300})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const result = await runCreditMaturityCheck();
        res.json({success: true, ...result});
      } catch (error: any) {
        console.error("[creditMaturityCheck] 오류:", error.message);
        res.status(500).json({success: false, error: error.message});
      }
    });
  });

// ══════════════════════════════════════════════════════════════════════════════
// S기법 / S2기법 스크리너
// ══════════════════════════════════════════════════════════════════════════════
//
// S기법: KOSPI 시총 1.3조+ → EN20/20 하단선(MA20×0.8) 2% 이내 접근 시 알림
// S2기법: 2달치 일봉에서 가장 최근 거래대금 5천억+ 양봉일 이후, 하단선 첫 접근 시 알림
// 두 기법 종목 중복 가능 (S+S2 양쪽 모두 표시)
//
// Firestore:
//   sScreener/sEligible/stocks/{code}    - S기법 후보 (일일 갱신)
//   sScreener/s2Eligible/stocks/{code}   - S2기법 후보 (일일 갱신)
//   sScreener/alertState/stocks/{code}   - 중복알림 방지용 상태
//   sScreener/alerts/items/{code}        - 최근 알림 (UI 표시용)
//   sScreener/lastCheck                  - 마지막 체크 시각
//   settings/telegram_s                  - S스크리너 전용 텔레그램 봇 설정
// ══════════════════════════════════════════════════════════════════════════════

const S_MARKET_CAP_MIN_EOK = 13000;   // 1조 3천억 = 13,000억원
const S2_VOLUME_MIN_EOK = 5000;       // 5,000억원
const S2_LOOKBACK_DAYS = 150;         // 5달치 거래일
const SCREENER_ALERT_THRESHOLD_PCT = 2.0;
// 하단선 대비 너무 깊게(-8% 이상) 이탈한 종목은 권리락/액면분할 등으로 밴드(MA20)가
// 옛 가격 기준으로 남아 생긴 "오신호"일 가능성이 큼 → 알림 보류 + 재계산 필요 로그.
//   1차 진입 후보는 gap≈0(밴드 도달), 정상 이탈도 보통 -수% 이내라 영향 없음.
//   (실제 매매엔 무관 — 알림/alert목록만 보류, 적격 밴드는 daily 재계산이 자가치유)
const SCREENER_DEEP_GAP_PCT = -8.0;

// ka10001 단건 시세/시총 조회 (스크리너 전용)
// stk_cd 접미사 "_AL"로 KRX+NXT 통합 데이터 조회. 미지원시 일반 코드 폴백.
async function screenerFetchStockInfo(
  config: KiwoomConfig,
  token: string,
  code: string,
): Promise<{ currentPrice: number; marketCapEok: number; name: string } | null> {
  const n = (v: unknown): number => {
    const s = typeof v === "string" ? v.replace(/[+,\s]/g, "") : String(v);
    const num = Number(s);
    return Number.isFinite(num) ? Math.abs(num) : 0;
  };
  const callKa10001 = async (stkCd: string): Promise<any | null> => {
    try {
      const res = await fetch(`${config.baseUrl}/api/dostk/stkinfo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "authorization": `Bearer ${token}`,
          "api-id": "ka10001",
        },
        body: JSON.stringify({stk_cd: stkCd}),
      });
      const data = await res.json() as any;
      // 빈 응답 체크 (NXT 미지원 등)
      if (!data.cur_prc && !data.mac) return null;
      return data;
    } catch {
      return null;
    }
  };
  // _AL만 시도 (NXT 미지원 종목 = 거의 모두 시총 1.3조 미만 잡주 → 어차피 필터링됨)
  const data = await callKa10001(code + "_AL");
  if (!data) return null;
  return {
    currentPrice: n(data.cur_prc),
    marketCapEok: n(data.mac),
    name: typeof data.stk_nm === "string" ? data.stk_nm.trim() : code,
  };
}

// 2달치 일봉 조회 (스크리너 S2 전용)
interface ScreenerBar {
  date: string;       // YYYYMMDD
  open: number;
  close: number;
  low: number;
  tradeValueEok: number;  // 억원
}

async function screenerFetchBars(
  config: KiwoomConfig,
  token: string,
  code: string,
  days = S2_LOOKBACK_DAYS,
): Promise<ScreenerBar[]> {
  // stk_cd 접미사 "_AL"로 KRX+NXT 통합 일봉 조회 (정규장만보다 정확)
  const num = (v: unknown): number => Math.abs(parseInt(String(v || "0").replace(/[+,\s]/g, "")) || 0);

  const fetchPage = async (stkCd: string, contYn: string, nextKey: string) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "authorization": `Bearer ${token}`,
      "api-id": "ka10081",
    };
    if (contYn === "Y" && nextKey) {
      headers["cont-yn"] = "Y";
      headers["next-key"] = nextKey;
    }
    const res = await fetch(`${config.baseUrl}/api/dostk/chart`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        stk_cd: stkCd,
        base_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        upd_stkpc_tp: "1",
        qry_tp: "0",
      }),
    });
    const respContYn = res.headers.get("cont-yn") || res.headers.get("Cont-Yn") || "";
    const respNextKey = res.headers.get("next-key") || res.headers.get("Next-Key") || "";
    const data = await res.json() as any;
    return {data, respContYn, respNextKey};
  };

  const tryFetch = async (stkCd: string): Promise<ScreenerBar[]> => {
    const out: ScreenerBar[] = [];
    let contYn = "N", nextKey = "";
    for (let page = 0; page < 6 && out.length < days; page++) {
      const {data, respContYn, respNextKey} = await fetchPage(stkCd, contYn, nextKey);
      const chart: any[] = data.stk_dt_pole_chart_qry || data.stk_dt_pole_chart || [];
      for (const c of chart) {
        const close = num(c.cur_prc || c.cls_prc);
        const open = num(c.opn_prc || c.open_pric || c.strt_prc);
        const low = num(c.low_prc || c.lwst_prc || c.low_pric);
        // trde_prica는 백만원 단위 → 억원으로 환산 (÷100)
        const tvEok = Math.round(num(c.trde_prica) / 100);
        const date = String(c.stk_bsop_date || c.dt || "");
        if (close > 0 && date) out.push({date, open, close, low, tradeValueEok: tvEok});
      }
      if (respContYn !== "Y" || !respNextKey) break;
      contYn = "Y";
      nextKey = respNextKey;
      await new Promise((r) => setTimeout(r, 150));
    }
    return out;
  };

  // _AL만 시도 (S기법은 시총 1.3조+, S2도 거래대금 큰 종목 위주 — 모두 NXT 지원)
  const bars = await tryFetch(code + "_AL");
  return bars.slice(0, days);
}

// ETF/ETN/스팩 제외 필터
// S/S2 분할매매에 적합하지 않은 종목을 종목명 패턴으로 식별.
// kind="A" (일반종목)는 통과, kind 값이 다르거나 패턴 매칭되면 제외.
function isExcludedSecurity(name: string, kind?: string): boolean {
  // 1) kind 필드 활용 (ka10099의 kind="A"가 일반종목)
  if (kind && kind !== "" && kind !== "A") return true;

  if (!name) return false;
  const upper = name.toUpperCase().trim();

  // 2) ETF/ETN — 발행사 prefix 매칭
  const etfPrefixes = [
    "KODEX", "TIGER", "ARIRANG", "HANARO", "KOSEF",
    "ACE ", "ACE_", "PLUS ", "PLUS_", "SOL ", "SOL_",
    "KBSTAR", "TIMEFOLIO", "1Q ", "HK ", "KIWOOM",
    "TREX", "WON ", "WOORI", "DAISHIN", "히어로즈",
    "KCGI", "BNK", "FOCUS", "VITA",
  ];
  for (const p of etfPrefixes) {
    if (upper.startsWith(p.toUpperCase())) return true;
  }

  // 3) ETN — "ETN" 또는 "QV" 포함
  if (upper.includes("ETN") || upper.includes(" QV") || upper.startsWith("QV")) return true;

  // 4) 스팩 (SPAC)
  if (name.includes("스팩") || upper.includes("SPAC")) return true;
  if (name.includes("기업인수목적")) return true;

  return false;
}

// 오늘 알림 이력 기록 (sScreener/alertHistory/items/{YYYYMMDD-code})
// 매번 알림 발송 또는 알림 조건 충족 시 호출.
async function recordAlertHistory(
  code: string,
  name: string,
  types: string[],
  cur: number,
  lowerBand: number,
  gap: number,
  level: "below" | "1pct" | "2pct",
  marketCapEok: number | null,
  bigVolDay: string | null,
  bigVolTradeValueEok: number | null,
): Promise<void> {
  try {
    const kstNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
    const yyyy = kstNow.getFullYear();
    const mm = String(kstNow.getMonth() + 1).padStart(2, "0");
    const dd = String(kstNow.getDate()).padStart(2, "0");
    const dateKey = `${yyyy}${mm}${dd}`;
    const historyId = `${dateKey}-${code}`;
    const historyRef = db.collection("sScreener").doc("alertHistory").collection("items").doc(historyId);
    const histDoc = await historyRef.get();
    const histData = histDoc.data();
    const now = Date.now();
    const levelRank: Record<string, number> = {below: 3, "1pct": 2, "2pct": 1};
    if (histData) {
      const prevRank = levelRank[histData.worstLevel] || 0;
      const currRank = levelRank[level] || 0;
      await historyRef.set({
        lastAlertAt: now,
        currentPrice: cur,
        minGap: Math.min(histData.minGap ?? 999, gap),
        worstLevel: currRank > prevRank ? level : histData.worstLevel,
        alertCount: (histData.alertCount || 0) + 1,
      }, {merge: true});
    } else {
      await historyRef.set({
        date: dateKey,
        code,
        name,
        types,
        firstAlertAt: now,
        lastAlertAt: now,
        currentPrice: cur,
        lowerBand,
        minGap: gap,
        worstLevel: level,
        alertCount: 1,
        marketCapEok,
        bigVolDay,
        bigVolTradeValueEok,
      });
    }
  } catch (e: any) {
    console.error("[alertHistory] 저장 실패:", e.message);
  }
}

// S스크리너 전용 텔레그램 발송 (taesan Firestore: settings/telegram_s)
async function sendTelegramSScreener(text: string): Promise<void> {
  try {
    const doc = await db.collection("settings").doc("telegram_s").get();
    const cfg = doc.data();
    if (!cfg?.botToken || !cfg?.chatId) {
      console.log("[S텔레그램] settings/telegram_s 설정 없음 - 스킵");
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({chat_id: cfg.chatId, text, parse_mode: "HTML"}),
    });
    const data = await res.json() as any;
    if (!data.ok) console.error("[S텔레그램] 전송 실패:", data.description);
  } catch (e: any) {
    console.error("[S텔레그램] 오류:", e.message);
  }
}

// S2 거래대금 양봉 기준(억) 로드 — 사용자 설정값(settings/telegram_s.s2VolumeMinEok),
//   기본 5000, 안전범위 [1000, 100000]. jb-s-web 프리셋 버튼에서 변경.
async function loadS2VolumeMinEok(): Promise<number> {
  try {
    const doc = await db.collection("settings").doc("telegram_s").get();
    const n = Number(doc.data()?.s2VolumeMinEok);
    if (!Number.isFinite(n) || n <= 0) return S2_VOLUME_MIN_EOK;
    return Math.min(100000, Math.max(1000, Math.round(n)));
  } catch {
    return S2_VOLUME_MIN_EOK;
  }
}

// 설정에서 S/S2 텔레그램 필터 로드
async function loadScreenerFilters(): Promise<{enableS: boolean; enableS2: boolean}> {
  try {
    const doc = await db.collection("settings").doc("telegram_s").get();
    const cfg = doc.data();
    return {
      enableS: cfg?.enableS !== false,
      enableS2: cfg?.enableS2 !== false,
    };
  } catch {
    return {enableS: true, enableS2: true};
  }
}

function shouldSendByFilter(
  types: string[],
  filters: {enableS: boolean; enableS2: boolean},
): boolean {
  const isS = types.includes("S");
  const isS2 = types.includes("S2");
  if (isS && isS2) return filters.enableS || filters.enableS2;
  if (isS) return filters.enableS;
  if (isS2) return filters.enableS2;
  return true;
}

// S기법 일일 업데이트 로직 (스케줄/수동 공용)
async function runSScreenerDailyS(
  market: "KOSPI" | "KOSDAQ" = "KOSPI",
): Promise<{processed: number; eligible: number; market: string}> {
  console.log(`[S스크리너] S기법 ${market} 업데이트 시작`);
  const config = await getKiwoomConfig();
  const token = await getAccessToken(config);

  const snap = await db.collection("stockCodes").where("market", "==", market).get();
  const allStocks = snap.docs.map((d) => ({
    code: d.data().code as string,
    name: d.data().name as string,
    kind: (d.data().kind as string) || "",
  }));
  // ETF/ETN/스팩 제외
  const stocks = allStocks.filter((s) => !isExcludedSecurity(s.name, s.kind));
  const excludedCount = allStocks.length - stocks.length;
  console.log(`[S스크리너] ${market} ${stocks.length}종목 스캔 (ETF/ETN/스팩 ${excludedCount}개 제외)`);

  // 해당 market의 기존 S eligible만 초기화 (다른 market 보존)
  const prev = await db.collection("sScreener").doc("sEligible").collection("stocks")
    .where("market", "==", market).get();
  if (!prev.empty) {
    for (let i = 0; i < prev.docs.length; i += 400) {
      const batch = db.batch();
      prev.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  let eligibleCount = 0;
  let processed = 0;
  for (const stk of stocks) {
    processed++;
    await new Promise((r) => setTimeout(r, 100));

    const info = await screenerFetchStockInfo(config, token, stk.code);
    if (!info) continue;
    if (info.marketCapEok < S_MARKET_CAP_MIN_EOK) continue;

    await new Promise((r) => setTimeout(r, 100));
    // 통합(KRX+NXT) 일봉으로 MA20 계산 — screenerFetchBars 사용
    const bars = await screenerFetchBars(config, token, stk.code, 25);
    if (bars.length < 20) continue;
    const ma20 = Math.round(bars.slice(0, 20).reduce((s, b) => s + b.close, 0) / 20);
    if (ma20 <= 0) continue;

    const lowerBand = Math.round(ma20 * 0.8);

    await db.collection("sScreener").doc("sEligible").collection("stocks").doc(stk.code).set({
      code: stk.code,
      name: info.name || stk.name,
      market,
      ma20,
      lowerBand,
      marketCapEok: info.marketCapEok,
      types: ["S"],
      updatedAt: Date.now(),
    });
    eligibleCount++;
  }
  console.log(`[S스크리너] S기법 ${market} 완료: ${processed}처리, ${eligibleCount}종목 eligible`);
  return {processed, eligible: eligibleCount, market};
}

// KOSPI 스케줄 (평일 21:00 KST — NXT 종료 후 1시간 마진 → 오늘 종가 정확 반영)
export const sScreenerDailyS = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .pubsub.schedule("0 21 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    try {
      await runSScreenerDailyS("KOSPI");
    } catch (e: any) {
      console.error("[S스크리너] S기법 KOSPI 오류:", e.message);
    }
  });

// KOSDAQ 스케줄 (평일 21:02 KST — KOSPI S 직후)
export const sScreenerDailyS_KOSDAQ = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .pubsub.schedule("2 21 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    try {
      await runSScreenerDailyS("KOSDAQ");
    } catch (e: any) {
      console.error("[S스크리너] S기법 KOSDAQ 오류:", e.message);
    }
  });

// 수동 트리거: ?market=KOSPI(기본) 또는 ?market=KOSDAQ
export const sScreenerDailySNow = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const mkt = (req.query.market as string || "KOSPI").toUpperCase();
        if (mkt !== "KOSPI" && mkt !== "KOSDAQ") {
          res.status(400).json({error: "market must be KOSPI or KOSDAQ"});
          return;
        }
        const r = await runSScreenerDailyS(mkt as "KOSPI" | "KOSDAQ");
        res.json({success: true, ...r});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// S2기법 일일 업데이트 로직 (스케줄/수동 공용)
async function runSScreenerDailyS2(
  market: "KOSPI" | "KOSDAQ" = "KOSPI",
): Promise<{processed: number; eligible: number; market: string}> {
  const volMinEok = await loadS2VolumeMinEok(); // 사용자 설정 거래대금 기준 (기본 5000억)
  console.log(`[S스크리너] S2기법 ${market} 업데이트 시작 (거래대금 기준 ${volMinEok}억)`);
  const config = await getKiwoomConfig();
  const token = await getAccessToken(config);

  // S2 종목 필터링:
  //  - KOSPI: 대형/중형/소형 전부 (광전자 같은 중소형 경계 종목도 5천억 양봉 발생 가능)
  //  - KOSDAQ: 대형/중형만 (소형주 1,500+ 개 시간 부담)
  //  - ETF/ETN/스팩 제외 (분할매매 부적합)
  const snap = await db.collection("stockCodes").where("market", "==", market).get();
  const allMapped = snap.docs.map((d) => ({
    code: d.data().code as string,
    name: d.data().name as string,
    upSizeName: (d.data().upSizeName as string) || "",
    kind: (d.data().kind as string) || "",
  }));
  const sizeFiltered = allMapped.filter((s) => {
    if (market === "KOSPI") {
      return s.upSizeName === "대형주" || s.upSizeName === "중형주" || s.upSizeName === "소형주";
    }
    return s.upSizeName === "대형주" || s.upSizeName === "중형주";
  });
  const stocks = sizeFiltered.filter((s) => !isExcludedSecurity(s.name, s.kind));
  const excludedCount = sizeFiltered.length - stocks.length;
  console.log(`[S스크리너] S2 ${market} ${stocks.length}종목 스캔 (ETF/ETN/스팩 ${excludedCount}개 제외)`);

  // 해당 market의 기존 s2Eligible만 초기화 (다른 market 보존)
  const prev = await db.collection("sScreener").doc("s2Eligible").collection("stocks")
    .where("market", "==", market).get();
  if (!prev.empty) {
    for (let i = 0; i < prev.docs.length; i += 400) {
      const batch = db.batch();
      prev.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  let eligibleCount = 0;
  let processed = 0;
  for (const stk of stocks) {
    processed++;
    await new Promise((r) => setTimeout(r, 100));

    const bars = await screenerFetchBars(config, token, stk.code, S2_LOOKBACK_DAYS);
    if (bars.length < 20) continue;

    const ma20 = Math.round(bars.slice(0, 20).reduce((s, b) => s + b.close, 0) / 20);
    if (ma20 <= 0) continue;
    const lowerBand = Math.round(ma20 * 0.8);

    // 가장 최근 5천억+ 양봉 찾기 (bars는 최신→오래된 순, idx 작을수록 최근)
    let bigVolIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.tradeValueEok >= volMinEok && b.close > b.open) {
        bigVolIdx = i;
        break;
      }
    }
    if (bigVolIdx < 0) continue;

    // bigVol일 이후(더 최신) 구간 bars[0..bigVolIdx-1] 에서
    // "그 일자 시점의 MA20×0.8" 을 lowerBand로 사용해 첫 하단선 접근 판정.
    // (기존 버그: "오늘 lowerBand" 로 과거를 평가하면 양봉 사이클이 이미 끝났어도
    //  하단선 자체가 시간에 따라 내려와 과거 접근이 "안 닿음" 으로 잘못 판정됨.)
    //
    // bars 정렬: 최신 → 오래된. i 일자 시점의 MA20 = bars[i..i+19] (i 일자 포함 직전 20일).
    let firstTouchIdx = -1;
    let firstTouchInfo: {
      date: string;
      low: number;
      lowerBandAtDay: number;
    } | null = null;
    for (let i = bigVolIdx - 1; i >= 0; i--) {
      const window = bars.slice(i, i + 20);
      if (window.length < 20) continue;
      const ma20AtDay = Math.round(
        window.reduce((s, b) => s + b.close, 0) / 20,
      );
      const lowerBandAtDay = Math.round(ma20AtDay * 0.8);
      // 사이클 종료 판정은 "정확 도달/이탈"만 인정 (저가 ≤ 하단선).
      // 텔레그램 알림(sScreenerCheck)은 별도로 1pct/2pct 근접도 발송 — 영향 없음.
      // 케이스: 카카오 2026-03-04 저가 47,050 vs 하단선 46,534 (+1.11% 거리)
      //  → 종전 ×1.02 룰에서는 사이클 종료 처리되어 후보 탈락.
      //  → ×1.00 으로 변경: 정확 도달 안 한 경우 후보 유지.
      if (bars[i].low <= lowerBandAtDay) {
        firstTouchIdx = i;
        firstTouchInfo = {
          date: bars[i].date,
          low: bars[i].low,
          lowerBandAtDay,
        };
        break;
      }
    }
    // 양봉 이후 이미 한 번 하단선 정확 도달이 일어났다면 사이클 종료 → 제외
    if (firstTouchIdx >= 0) {
      console.log(
        `[S2] ${stk.code} ${stk.name} 사이클 종료 (양봉 ${bars[bigVolIdx].date} → ` +
          `첫 접근 ${firstTouchInfo?.date} @ low ${firstTouchInfo?.low}, ` +
          `당시 lowerBand ${firstTouchInfo?.lowerBandAtDay})`,
      );
      continue;
    }

    await db.collection("sScreener").doc("s2Eligible").collection("stocks").doc(stk.code).set({
      code: stk.code,
      name: stk.name,
      market,
      ma20,
      lowerBand,
      bigVolDay: bars[bigVolIdx].date,
      bigVolTradeValueEok: bars[bigVolIdx].tradeValueEok,
      types: ["S2"],
      updatedAt: Date.now(),
    });
    eligibleCount++;
  }
  console.log(`[S스크리너] S2기법 ${market} 완료: ${processed}처리, ${eligibleCount}종목 eligible`);
  return {processed, eligible: eligibleCount, market};
}

// KOSPI 스케줄 (평일 08:52 KST)
export const sScreenerDailyS2 = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 540,
    memory: "512MB",
  })
  // 평일 21:05 KST — KOSPI S 완료 후 (S 처리 시간 ~5분 가정)
  .pubsub.schedule("5 21 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    try {
      await runSScreenerDailyS2("KOSPI");
    } catch (e: any) {
      console.error("[S스크리너] S2기법 KOSPI 오류:", e.message);
    }
  });

// KOSDAQ 스케줄 (평일 21:07 KST)
export const sScreenerDailyS2_KOSDAQ = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .pubsub.schedule("7 21 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    try {
      await runSScreenerDailyS2("KOSDAQ");
    } catch (e: any) {
      console.error("[S스크리너] S2기법 KOSDAQ 오류:", e.message);
    }
  });

// 수동 트리거: ?market=KOSPI(기본) 또는 ?market=KOSDAQ
export const sScreenerDailyS2Now = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const mkt = (req.query.market as string || "KOSPI").toUpperCase();
        if (mkt !== "KOSPI" && mkt !== "KOSDAQ") {
          res.status(400).json({error: "market must be KOSPI or KOSDAQ"});
          return;
        }
        const r = await runSScreenerDailyS2(mkt as "KOSPI" | "KOSDAQ");
        res.json({success: true, ...r});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

// 다양한 API/파라미터 조합으로 일봉 데이터 비교 (정규장 vs 통합 검증)
export const screenerCompareApis = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 60,
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const code = (req.query.code as string || "066570").trim();
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);

        const baseDate = (req.query.date as string) ||
          new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}))
            .toISOString().slice(0, 10).replace(/-/g, "");

        const callApi = async (apiId: string, uri: string, body: any, extraHeaders: Record<string, string> = {}) => {
          try {
            const r = await fetch(`${config.baseUrl}${uri}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "authorization": `Bearer ${token}`,
                "api-id": apiId,
                ...extraHeaders,
              },
              body: JSON.stringify(body),
            });
            const data: any = await r.json();
            return {
              apiId, uri, body, extraHeaders,
              status: r.status,
              keys: Object.keys(data),
              sample: JSON.stringify(data).substring(0, 800),
            };
          } catch (e: any) {
            return {apiId, uri, body, extraHeaders, error: e.message};
          }
        };

        // ka10001(현재가/시총)도 _AL 지원하는지 검증
        const tests = [
          // ka10001 (주식기본정보) - 일반 vs _AL 비교
          {apiId: "ka10001", uri: "/api/dostk/stkinfo", body: {stk_cd: code}},
          {apiId: "ka10001", uri: "/api/dostk/stkinfo", body: {stk_cd: code + "_AL"}},
          {apiId: "ka10001", uri: "/api/dostk/stkinfo", body: {stk_cd: code + "_NX"}},
        ];

        const results = [];
        for (const t of tests) {
          results.push(await callApi(t.apiId, t.uri, t.body, (t as any).headers || {}));
          await new Promise((r) => setTimeout(r, 200));
        }

        res.json({code, baseDate, results});
      } catch (e: any) {
        res.status(500).json({error: e.message});
      }
    });
  });

// 특정 종목 일봉 raw 데이터 조회 (단위 검증용)
// stockCodes 도큐먼트 + 60일치 일봉 + 5천억 양봉 후보 추출
export const screenerRawBars = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 60,
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const code = (req.query.code as string || "").trim();
        if (!/^\d{6}$/.test(code)) {
          res.status(400).json({error: "code (6자리) 필요"});
          return;
        }
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);

        // 1) stockCodes 도큐먼트 조회 (upSizeName 등)
        const stkDoc = await db.collection("stockCodes").doc(`stock_${code}`).get();
        const stkData = stkDoc.exists ? stkDoc.data() : null;

        // 2) 일봉 데이터 — 여러 페이지 받아서 150일치 확보 (_AL 통합)
        const num = (v: unknown): number => Math.abs(parseInt(String(v || "0").replace(/[+,\s]/g, "")) || 0);
        const bars: any[] = [];
        let contYn = "N", nextKey = "";
        const stkCd = code + "_AL";
        for (let page = 0; page < 6 && bars.length < 160; page++) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json; charset=utf-8",
            "authorization": `Bearer ${token}`,
            "api-id": "ka10081",
          };
          if (contYn === "Y" && nextKey) {
            headers["cont-yn"] = "Y";
            headers["next-key"] = nextKey;
          }
          const r = await fetch(`${config.baseUrl}/api/dostk/chart`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              stk_cd: stkCd,
              base_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
              upd_stkpc_tp: "1",
              qry_tp: "0",
            }),
          });
          contYn = r.headers.get("cont-yn") || r.headers.get("Cont-Yn") || "";
          nextKey = r.headers.get("next-key") || r.headers.get("Next-Key") || "";
          const data: any = await r.json();
          const chart: any[] = data.stk_dt_pole_chart_qry || data.stk_dt_pole_chart || [];
          for (const c of chart) {
            const open = num(c.opn_prc || c.open_pric || c.strt_prc);
            const close = num(c.cur_prc || c.cls_prc);
            const tvEok = Math.round(num(c.trde_prica) / 100);
            bars.push({
              dt: c.dt || c.stk_bsop_date,
              open, close,
              tvEok,
              isYangBong: close > open,
              isBig5kEok: tvEok >= 5000,
            });
          }
          if (contYn !== "Y" || !nextKey) break;
          await new Promise((r) => setTimeout(r, 150));
        }

        // 3) 5천억+ 양봉 후보만 추출
        const bigVolDays = bars.filter((b) => b.isBig5kEok && b.isYangBong);

        res.json({
          code,
          stockCodes: stkData,
          totalBars: bars.length,
          oldestDate: bars[bars.length - 1]?.dt,
          newestDate: bars[0]?.dt,
          bigVolDays,
          allBigVolDays: bars.filter((b) => b.isBig5kEok),
          firstFiveBars: bars.slice(0, 5),
        });
      } catch (e: any) {
        res.status(500).json({error: e.message});
      }
    });
  });

// S2 eligible 종목 전체 리스트 (디버그)
export const screenerS2List = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const snap = await db.collection("sScreener").doc("s2Eligible").collection("stocks").get();
        const items = snap.docs.map((d) => d.data());
        items.sort((a: any, b: any) => (b.bigVolTradeValueEok || 0) - (a.bigVolTradeValueEok || 0));
        res.json({count: snap.size, items});
      } catch (e: any) {
        res.status(500).json({error: e.message});
      }
    });
  });

// 단일 종목 S2 정보 조회 (디버그)
export const screenerStockInfo = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const code = (req.query.code as string || "").trim();
        if (!/^\d{6}$/.test(code)) {
          res.status(400).json({error: "code (6자리) 필요"});
          return;
        }
        const [sDoc, s2Doc, alertDoc] = await Promise.all([
          db.collection("sScreener").doc("sEligible").collection("stocks").doc(code).get(),
          db.collection("sScreener").doc("s2Eligible").collection("stocks").doc(code).get(),
          db.collection("sScreener").doc("alerts").collection("items").doc(code).get(),
        ]);
        res.json({
          code,
          sEligible: sDoc.exists ? sDoc.data() : null,
          s2Eligible: s2Doc.exists ? s2Doc.data() : null,
          alert: alertDoc.exists ? alertDoc.data() : null,
        });
      } catch (e: any) {
        res.status(500).json({error: e.message});
      }
    });
  });

// 진단: ka10099를 다양한 URI에서 시도
export const screenerDiag = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 60,
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);

        const uris = [
          "/api/dostk/stkinfo",
          "/api/dostk/mrkcond",
          "/api/dostk/sect",
          "/api/dostk/elw",
          "/api/dostk/etf",
          "/api/dostk/rkinfo",
          "/api/dostk/slb",
          "/api/dostk/master",
        ];

        const tryUri = async (uri: string) => {
          const r = await fetch(`${config.baseUrl}${uri}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "authorization": `Bearer ${token}`,
              "api-id": "ka10099",
            },
            body: JSON.stringify({mrkt_tp: "0"}),
          });
          const data = await r.json() as any;
          return {
            uri,
            status: r.status,
            keys: Object.keys(data),
            sample: JSON.stringify(data).substring(0, 400),
          };
        };

        const results = [];
        for (const u of uris) {
          results.push(await tryUri(u));
          await new Promise((r) => setTimeout(r, 200));
        }

        const codesSnap = await db.collection("stockCodes").get();
        res.json({
          attempts: results,
          stockCodesTotal: codesSnap.size,
        });
      } catch (e: any) {
        res.status(500).json({error: e.message});
      }
    });
  });

// ── 장중 10분 체크 (평일 09:00~15:30 KST) ───────────────────────────────────
export const sScreenerCheck = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 300,
    memory: "256MB",
  })
  .pubsub.schedule("every 10 minutes")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
    const h = kst.getHours(); const m = kst.getMinutes(); const d = kst.getDay();
    const t = h * 100 + m;
    if (d === 0 || d === 6 || t < 900 || t > 1530) {
      console.log(`[S체크] 장외 시간 (${h}:${m}, 요일:${d}) - 스킵`);
      return;
    }

    console.log("[S체크] 장중 체크 시작");
    try {
      const config = await getKiwoomConfig();
      const token = await getAccessToken(config);

      const [sSnap, s2Snap] = await Promise.all([
        db.collection("sScreener").doc("sEligible").collection("stocks").get(),
        db.collection("sScreener").doc("s2Eligible").collection("stocks").get(),
      ]);

      // 종목별 병합 (S + S2 둘 다 가능)
      const map = new Map<string, any>();
      sSnap.docs.forEach((d) => map.set(d.id, {...d.data()}));
      s2Snap.docs.forEach((d) => {
        const existing = map.get(d.id);
        if (existing) {
          existing.types = ["S", "S2"];
          existing.bigVolDay = d.data().bigVolDay;
          existing.bigVolTradeValueEok = d.data().bigVolTradeValueEok;
        } else {
          map.set(d.id, {...d.data()});
        }
      });

      const eligible = Array.from(map.values());
      console.log(`[S체크] eligible ${eligible.length}종목 체크 중`);

      // 이전 alerts/checkStatus 초기화 (stale 데이터 제거)
      const [prevAlerts, prevStatus] = await Promise.all([
        db.collection("sScreener").doc("alerts").collection("items").get(),
        db.collection("sScreener").doc("checkStatus").collection("items").get(),
      ]);
      for (const snap of [prevAlerts, prevStatus]) {
        if (snap.empty) continue;
        for (let i = 0; i < snap.docs.length; i += 400) {
          const b = db.batch();
          snap.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
          await b.commit();
        }
      }

      const now = Date.now();
      const alertItems: any[] = [];
      const checkStatusItems: any[] = [];
      let alertCount = 0;
      let suspectCount = 0; // 깊은 이탈(권리락 의심)로 알림 보류한 종목 수

      // S/S2 텔레그램 필터 (settings/telegram_s.{enableS, enableS2}, 기본 둘 다 true)
      const screenerFilters = await loadScreenerFilters();
      let filteredOutCount = 0;

      // 보유 종목 코드 로드 — jb-s-web holdingsCheck가 5분마다 publish
      //   이 리스트에 있는 종목은 텔레그램 알림 제외 (이미 보유 중인 종목은 매수 후보 알림 불필요,
      //   매도 알림은 jb-s-web holdingsCheck가 별도 처리)
      let heldCodes = new Set<string>();
      try {
        const heldDoc = await db.collection("settings").doc("jb_holdings_codes").get();
        const heldData = heldDoc.data();
        if (heldData?.codes && Array.isArray(heldData.codes)) {
          heldCodes = new Set(heldData.codes);
        }
      } catch {
        /* ignore - 보유 종목 정보 없으면 제외 안 함 */
      }
      let heldFilteredCount = 0;

      for (const stk of eligible) {
        await new Promise((r) => setTimeout(r, 130));

        const info = await screenerFetchStockInfo(config, token, stk.code);
        if (!info || info.currentPrice <= 0) continue;

        const cur = info.currentPrice;
        const gap = ((cur - stk.lowerBand) / stk.lowerBand) * 100;

        // 전체 eligible 종목 현재가/gap 캐시 (모달용)
        checkStatusItems.push({
          code: stk.code,
          currentPrice: cur,
          gap: parseFloat(gap.toFixed(2)),
          checkedAt: now,
        });

        let level: "below" | "1pct" | "2pct" | "none";
        if (gap <= SCREENER_DEEP_GAP_PCT) {
          // 권리락/데이터 의심 — 하단선보다 너무 깊게 이탈 → 알림 보류 (재계산 필요)
          //   checkStatus(모달용 gap)는 위에서 이미 실제값으로 캐시됨 → 데이터 확인은 유지
          level = "none";
          suspectCount++;
          console.warn(
            `[S체크] ⚠️ 깊은 이탈 알림 보류: ${info.name || stk.name}(${stk.code}) ` +
            `gap=${gap.toFixed(1)}% 현재가=${cur} 하단선=${stk.lowerBand} ` +
            "→ 권리락/데이터 의심, daily 재계산으로 자가치유 예정",
          );
        } else if (gap <= 0) level = "below";
        else if (gap <= 1) level = "1pct";
        else if (gap <= SCREENER_ALERT_THRESHOLD_PCT) level = "2pct";
        else level = "none";

        // alert items는 2% 이내만 저장
        if (level !== "none") {
          alertItems.push({
            code: stk.code,
            name: info.name || stk.name,
            currentPrice: cur,
            lowerBand: stk.lowerBand,
            ma20: stk.ma20,
            gap: parseFloat(gap.toFixed(2)),
            level,
            types: stk.types,
            marketCapEok: stk.marketCapEok || null,
            bigVolDay: stk.bigVolDay || null,
            bigVolTradeValueEok: stk.bigVolTradeValueEok || null,
            checkedAt: now,
          });
          // 오늘 알림 이력 기록 (날짜별 종목 누적)
          await recordAlertHistory(
            stk.code,
            info.name || stk.name,
            stk.types,
            cur,
            stk.lowerBand,
            gap,
            level as "below" | "1pct" | "2pct",
            stk.marketCapEok || null,
            stk.bigVolDay || null,
            stk.bigVolTradeValueEok || null,
          );
        }

        if (level === "none") continue;

        // 중복 알림 방지
        const stateDoc = await db.collection("sScreener").doc("alertState").collection("stocks").doc(stk.code).get();
        const prev = stateDoc.data();
        const sameLevel = prev?.level === level;
        const recentlySent = prev && (now - prev.sentAt) < 60 * 60 * 1000;
        if (sameLevel && recentlySent) continue;

        await db.collection("sScreener").doc("alertState").collection("stocks").doc(stk.code).set({
          level, sentAt: now,
        });

        const typeTag = stk.types.join("+");

        // S/S2 토글 필터 (사용자가 설정에서 S 또는 S2 알림을 꺼둔 경우 건너뛰기)
        if (!shouldSendByFilter(stk.types, screenerFilters)) {
          filteredOutCount++;
          continue;
        }

        // 보유 종목 필터 — 이미 보유 중이면 매수 후보 알림 안 보냄 (혼란 방지)
        if (heldCodes.has(stk.code)) {
          heldFilteredCount++;
          continue;
        }

        const emoji = level === "below" ? "🚨" : level === "1pct" ? "⚠️" : "📊";
        const lvText = level === "below" ? "하단선 이탈" : level === "1pct" ? "1% 이내 접근" : "2% 이내 접근";
        const gapText = gap <= 0 ? `${gap.toFixed(1)}%` : `+${gap.toFixed(1)}%`;
        const stockName = info.name || stk.name;

        // 종목명/코드를 <code>로 감싸서 텔레그램에서 탭하면 클립보드 복사 가능
        // 맨 윗줄 보라색 띠 = "매수 후보(관심권)" 컬러코드 — 보유종목 매수/매도 액션
        // 신호(초록/파랑/주황/빨강 띠)와 한눈에 구분되도록.
        const msg = [
          "🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪",
          `${emoji} <b>매수 후보 · ${typeTag}</b> · ${lvText}`,
          `📌 <code>${stockName}</code>  <code>${stk.code}</code>`,
          `현재가: ${cur.toLocaleString()}원`,
          `EN하단선: ${stk.lowerBand.toLocaleString()}원`,
          `근접도: ${gapText}`,
          stk.marketCapEok ? `시총: ${stk.marketCapEok.toLocaleString()}억원` : "",
          stk.bigVolDay ? `5천억양봉일: ${stk.bigVolDay} (${stk.bigVolTradeValueEok?.toLocaleString() || "?"}억)` : "",
        ].filter(Boolean).join("\n");

        await sendTelegramSScreener(msg);
        alertCount++;
      }

      // 알림 이력 일괄 저장 (UI용)
      if (alertItems.length > 0) {
        for (let i = 0; i < alertItems.length; i += 400) {
          const b = db.batch();
          alertItems.slice(i, i + 400).forEach((a) => {
            b.set(db.collection("sScreener").doc("alerts").collection("items").doc(a.code), a);
          });
          await b.commit();
        }
      }

      // 전체 eligible 종목 현재가/gap 캐시 (모달용)
      if (checkStatusItems.length > 0) {
        for (let i = 0; i < checkStatusItems.length; i += 400) {
          const b = db.batch();
          checkStatusItems.slice(i, i + 400).forEach((a) => {
            b.set(db.collection("sScreener").doc("checkStatus").collection("items").doc(a.code), a);
          });
          await b.commit();
        }
      }

      await db.collection("sScreener").doc("lastCheck").set({
        checkedAt: now,
        eligibleCount: eligible.length,
        alertItemCount: alertItems.length,
        sentCount: alertCount,
        filteredOutCount,
        heldFilteredCount,
        suspectCount,
        heldCount: heldCodes.size,
        filters: screenerFilters,
      });

      console.log(
        `[S체크] 완료. ${alertItems.length}건 알림범위, ${alertCount}건 신규 발송, ` +
          `${filteredOutCount}건 필터 차단, ${heldFilteredCount}건 보유 제외, ` +
          `${suspectCount}건 깊은이탈 보류 ` +
          `(필터: S=${screenerFilters.enableS}, S2=${screenerFilters.enableS2}, 보유=${heldCodes.size})`,
      );
    } catch (e: any) {
      console.error("[S체크] 오류:", e.message);
    }
  });

// ── 수동 트리거 (테스트용) ───────────────────────────────────────────────────
export const sScreenerCheckNow = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 300,
    memory: "256MB",
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        const [sSnap, s2Snap] = await Promise.all([
          db.collection("sScreener").doc("sEligible").collection("stocks").get(),
          db.collection("sScreener").doc("s2Eligible").collection("stocks").get(),
        ]);
        const map = new Map<string, any>();
        sSnap.docs.forEach((d) => map.set(d.id, {...d.data()}));
        s2Snap.docs.forEach((d) => {
          const ex = map.get(d.id);
          if (ex) {
            ex.types = ["S", "S2"];
            ex.bigVolDay = d.data().bigVolDay;
          } else map.set(d.id, {...d.data()});
        });
        const eligible = Array.from(map.values());

        // 이전 alerts/checkStatus 초기화
        const [prevAlerts, prevStatus] = await Promise.all([
          db.collection("sScreener").doc("alerts").collection("items").get(),
          db.collection("sScreener").doc("checkStatus").collection("items").get(),
        ]);
        for (const snap of [prevAlerts, prevStatus]) {
          if (snap.empty) continue;
          for (let i = 0; i < snap.docs.length; i += 400) {
            const b = db.batch();
            snap.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
            await b.commit();
          }
        }

        const now = Date.now();
        const alertItems: any[] = [];
        const checkStatusItems: any[] = [];
        for (const stk of eligible) {
          await new Promise((r) => setTimeout(r, 130));
          const info = await screenerFetchStockInfo(config, token, stk.code);
          if (!info || info.currentPrice <= 0) continue;
          const gap = ((info.currentPrice - stk.lowerBand) / stk.lowerBand) * 100;
          checkStatusItems.push({
            code: stk.code,
            currentPrice: info.currentPrice,
            gap: parseFloat(gap.toFixed(2)),
            checkedAt: now,
          });
          if (gap > SCREENER_ALERT_THRESHOLD_PCT) continue;
          if (gap <= SCREENER_DEEP_GAP_PCT) {
            // 권리락/데이터 의심 — 너무 깊은 이탈은 알림 보류 (스케줄 sScreenerCheck와 동일 가드)
            console.warn(
              `[S체크Now] ⚠️ 깊은 이탈 보류: ${info.name || stk.name}(${stk.code}) ` +
              `gap=${gap.toFixed(1)}% 현재가=${info.currentPrice} 하단선=${stk.lowerBand} → 권리락/데이터 의심`,
            );
            continue;
          }
          const level = gap <= 0 ? "below" : gap <= 1 ? "1pct" : "2pct";
          alertItems.push({
            code: stk.code, name: info.name || stk.name,
            currentPrice: info.currentPrice, lowerBand: stk.lowerBand, ma20: stk.ma20,
            gap: parseFloat(gap.toFixed(2)), level, types: stk.types,
            marketCapEok: stk.marketCapEok || null, bigVolDay: stk.bigVolDay || null,
            checkedAt: now,
          });
          // 오늘 알림 이력 기록
          await recordAlertHistory(
            stk.code,
            info.name || stk.name,
            stk.types,
            info.currentPrice,
            stk.lowerBand,
            gap,
            level as "below" | "1pct" | "2pct",
            stk.marketCapEok || null,
            stk.bigVolDay || null,
            stk.bigVolTradeValueEok || null,
          );
        }
        for (const items of [alertItems, checkStatusItems]) {
          if (items.length === 0) continue;
          const coll = items === alertItems ? "alerts" : "checkStatus";
          for (let i = 0; i < items.length; i += 400) {
            const b = db.batch();
            items.slice(i, i + 400).forEach((a) =>
              b.set(db.collection("sScreener").doc(coll).collection("items").doc(a.code), a));
            await b.commit();
          }
        }
        await db.collection("sScreener").doc("lastCheck").set({
          checkedAt: now, eligibleCount: eligible.length, alertItemCount: alertItems.length,
        });
        res.json({success: true, eligible: eligible.length, alerts: alertItems.length, checkStatus: checkStatusItems.length});
      } catch (e: any) {
        res.status(500).json({success: false, error: e.message});
      }
    });
  });

/**
 * ════════════════════════════════════════════════════════════════
 *  diagSellMigrateDryRun — 1단계 체결 정본화 시뮬레이션 (Read-Only)
 *  docs/ARCHITECTURE_SOURCE_OF_TRUTH.md §7-1
 *
 *  목적: kt00007 ord_no를 매도 정본으로 전환 시
 *        - 어떤 fallback이 어떤 ord_no로 대체되는지
 *        - sellSlot(분류) 승계 미리보기
 *        - 모호/무매칭 케이스 식별
 *        → 실데이터 건드리기 전 100% 확인.
 *
 *  안전: Firestore write 0건. 키움 API 조회만.
 *
 *  사용:
 *    GET /diagSellMigrateDryRun
 *    GET /diagSellMigrateDryRun?from=20260318&to=20260616
 *    GET /diagSellMigrateDryRun?stockName=앱클론
 *
 *  기본 범위: 최근 90일 (영업일만 조회).
 *
 *  출력: { summary, byStock, details }
 *  - details verdict: willReplace | ambiguous | noMatch
 *  - ambiguous → candidates 배열 (사용자가 수동 결정)
 * ════════════════════════════════════════════════════════════════
 */
export const diagSellMigrateDryRun = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      const startedAt = Date.now();
      try {
        const kstNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
        const fmt = (d: Date) =>
          `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
        const todayStr = fmt(kstNow);
        const defaultFrom = new Date(kstNow.getTime() - 90 * 24 * 60 * 60 * 1000);
        const defaultFromStr = fmt(defaultFrom);
        const from = (req.query.from as string || defaultFromStr).replace(/-/g, "");
        const to = (req.query.to as string || todayStr).replace(/-/g, "");
        const stockNameFilter = (req.query.stockName as string || "").trim();

        const dates: string[] = [];
        const fromDate = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00+09:00`);
        const toDate = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00+09:00`);
        for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
          const dow = d.getDay();
          if (dow === 0 || dow === 6) continue;
          dates.push(fmt(d));
        }

        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        type KwSell = {ord_no: string; qty: number; price: number; credit: boolean; ioTpNm: string};
        const kwByCodeDate = new Map<string, KwSell[]>();
        let kwFetchedDates = 0;
        let kwSellCount = 0;
        let kwFetchFailed = 0;

        for (const dt of dates) {
          try {
            const r7 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "authorization": `Bearer ${token}`,
                "api-id": "kt00007",
              },
              body: JSON.stringify({
                ord_dt: dt,
                qry_tp: "1",
                stk_bond_tp: "0",
                sell_tp: "0",
                stk_cd: "",
                fr_ord_no: "",
                dmst_stex_tp: "%",
              }),
            });
            const d7 = await r7.json() as any;
            if (d7.return_code && d7.return_code !== 0 && d7.return_code !== "0") {
              kwFetchFailed++;
              continue;
            }
            let items7: any[] = [];
            for (const k of Object.keys(d7)) {
              if (Array.isArray(d7[k]) && d7[k].length > 0) {items7 = d7[k]; break;}
            }
            for (const item of items7) {
              const qty = parseInt(item.cntr_qty || "0");
              if (qty <= 0) continue;
              const ioTp = (item.io_tp_nm || "").trim();
              if (!ioTp.includes("매도")) continue;
              const code = cleanKiwoomField(item.stk_cd).replace(/^[A-Za-z]/, "");
              if (!code) continue;
              const price = parseInt(item.cntr_uv || "0");
              const ordNo = String(item.ord_no || "").trim();
              if (!ordNo) continue;
              const crdTp = (item.crd_tp || "").trim();
              const isCredit = ioTp.includes("융자") || ioTp.includes("신용") ||
                crdTp.includes("융자") || crdTp.includes("신용");
              const key = `${code}_${dt}`;
              if (!kwByCodeDate.has(key)) kwByCodeDate.set(key, []);
              kwByCodeDate.get(key)!.push({ord_no: ordNo, qty, price, credit: isCredit, ioTpNm: ioTp});
              kwSellCount++;
            }
            kwFetchedDates++;
            await new Promise((r) => setTimeout(r, 150));
          } catch (e) {
            kwFetchFailed++;
          }
        }

        const fromDash = `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}`;
        const toDash = `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}`;
        // composite index 회피 — 단일 필드 쿼리 후 in-memory 필터
        const tsnapAll = await db.collection("trades")
          .where("type", "==", "sell")
          .get();
        const tradeDocs = tsnapAll.docs.filter((doc) => {
          const date = String((doc.data() as any).date || "");
          return date >= fromDash && date <= toDash;
        });

        const isFallback = (on: string): boolean =>
          !on || on.startsWith("sell_") || on.startsWith("buy_") ||
          on.startsWith("fb_") || on.startsWith("kt07_") || on.startsWith("kt15_");

        type Detail = {
          docId: string;
          stockName: string;
          code: string;
          date: string;
          price: number;
          qty: number;
          orderNo: string;
          currentSellSlot: string | null;
          verdict: "willReplace" | "ambiguous" | "noMatch";
          candidates?: Array<{ord_no: string; qty: number; price: number; credit: boolean; ioTpNm: string}>;
          newOrderNo?: string;
          newDocId?: string;
          inheritedSellSlot?: string | null;
          inheritedSellSlotSplit?: any;
        };
        const details: Detail[] = [];
        const byStock: Record<string, {fallback: number; willReplace: number; ambiguous: number; noMatch: number}> = {};
        let realCount = 0;

        tradeDocs.forEach((doc) => {
          const t = doc.data() as any;
          const orderNo = String(t.orderNo || "").trim();
          const stockName = String(t.stockName || "");
          if (stockNameFilter && !stockName.includes(stockNameFilter)) return;
          if (!isFallback(orderNo)) {realCount++; return;}

          const code = String(t.code || "").replace(/^A/, "");
          const date = String(t.date || "").replace(/-/g, "");
          const qty = Number(t.quantity) || 0;
          const price = Number(t.price) || 0;
          const key = `${code}_${date}`;
          const candidates = (kwByCodeDate.get(key) || [])
            .filter((c) => c.qty === qty && c.price === price);

          let verdict: "willReplace" | "ambiguous" | "noMatch";
          let newOrderNo: string | undefined;
          if (candidates.length === 1) {
            verdict = "willReplace";
            newOrderNo = candidates[0].ord_no;
          } else if (candidates.length > 1) {
            verdict = "ambiguous";
          } else {
            verdict = "noMatch";
          }

          if (!byStock[stockName]) byStock[stockName] = {fallback: 0, willReplace: 0, ambiguous: 0, noMatch: 0};
          byStock[stockName].fallback++;
          byStock[stockName][verdict]++;

          const baseDetail: Detail = {
            docId: doc.id,
            stockName,
            code,
            date: String(t.date || ""),
            price,
            qty,
            orderNo,
            currentSellSlot: t.sellSlot || null,
            verdict,
          };
          if (verdict === "willReplace" && newOrderNo) {
            baseDetail.newOrderNo = newOrderNo;
            baseDetail.newDocId = `trade_kiwoom_${newOrderNo}_${code}`;
            baseDetail.inheritedSellSlot = t.sellSlot || null;
            baseDetail.inheritedSellSlotSplit = t.sellSlotSplit || null;
          } else if (verdict === "ambiguous") {
            baseDetail.candidates = candidates;
          }
          details.push(baseDetail);
        });

        const summary = {
          dateRange: {from: fromDash, to: toDash, weekdayCount: dates.length},
          kiwoomFetch: {datesQueried: kwFetchedDates, datesFailed: kwFetchFailed, sellOrders: kwSellCount},
          firestoreSells: {totalAll: tsnapAll.size, inRange: tradeDocs.length, realOrdNo: realCount, fallback: details.length},
          migration: {
            willReplace: details.filter((d) => d.verdict === "willReplace").length,
            ambiguous: details.filter((d) => d.verdict === "ambiguous").length,
            noMatch: details.filter((d) => d.verdict === "noMatch").length,
          },
          elapsedMs: Date.now() - startedAt,
        };

        const byStockArr = Object.entries(byStock)
          .map(([name, v]) => ({name, ...v}))
          .sort((a, b) => b.fallback - a.fallback);

        res.json({
          success: true,
          summary,
          byStock: byStockArr,
          details,
        });
      } catch (e: any) {
        console.error("[diagSellMigrateDryRun] 실패:", e.message);
        res.status(500).json({success: false, error: e.message, elapsedMs: Date.now() - startedAt});
      }
    });
  });

/**
 * ════════════════════════════════════════════════════════════════
 *  diagSellNoMatchProbe — noMatch 매도의 정체 정밀 진단 (Read-Only)
 *  docs/ARCHITECTURE_SOURCE_OF_TRUTH.md §7-1 후속
 *
 *  목적: diagSellMigrateDryRun에서 kt00007에 매칭 안 된 fallback 매도들을
 *        ka10072 + kt00007 양쪽 API로 다시 조회해 정체를 분류:
 *        - ka10072O_kt7X : ka10072엔 있고 kt00007엔 없음 (API 차이 — kt7 정본화 불가 대상)
 *        - bothMissing   : 양쪽 다 없음 (수동입력 / 옛 데이터 의심)
 *        - kt7HasOther   : kt00007에 같은 종목·날짜 매도는 있으나 가격/수량 다름
 *        → noMatch 81건의 처리 방향 결정.
 *
 *  안전: Firestore write 0건. 키움 API 조회만.
 *
 *  사용:
 *    GET /diagSellNoMatchProbe                    (최근 90일)
 *    GET /diagSellNoMatchProbe?from=20260318&to=20260616
 *    GET /diagSellNoMatchProbe?stockName=엠아이큐브솔루션
 * ════════════════════════════════════════════════════════════════
 */
export const diagSellNoMatchProbe = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      const startedAt = Date.now();
      try {
        const kstNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
        const fmt = (d: Date) =>
          `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
        const todayStr = fmt(kstNow);
        const defaultFrom = new Date(kstNow.getTime() - 90 * 24 * 60 * 60 * 1000);
        const from = (req.query.from as string || fmt(defaultFrom)).replace(/-/g, "");
        const to = (req.query.to as string || todayStr).replace(/-/g, "");
        const stockNameFilter = (req.query.stockName as string || "").trim();

        const fromDash = `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}`;
        const toDash = `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}`;

        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);

        const isFallback = (on: string): boolean =>
          !on || on.startsWith("sell_") || on.startsWith("buy_") ||
          on.startsWith("fb_") || on.startsWith("kt07_") || on.startsWith("kt15_");

        // ─── 1) Firestore 매도 fallback 수집 (날짜 범위) ───
        const tsnapAll = await db.collection("trades").where("type", "==", "sell").get();
        type FbSell = {docId: string; stockName: string; code: string; date: string; dt: string; qty: number; price: number; orderNo: string; sellSlot: string | null};
        const fallbacks: FbSell[] = [];
        tsnapAll.docs.forEach((doc) => {
          const t = doc.data() as any;
          const date = String(t.date || "");
          if (date < fromDash || date > toDash) return;
          const stockName = String(t.stockName || "");
          if (stockNameFilter && !stockName.includes(stockNameFilter)) return;
          const orderNo = String(t.orderNo || "").trim();
          if (!isFallback(orderNo)) return;
          fallbacks.push({
            docId: doc.id,
            stockName,
            code: String(t.code || "").replace(/^A/, ""),
            date,
            dt: date.replace(/-/g, ""),
            qty: Number(t.quantity) || 0,
            price: Number(t.price) || 0,
            orderNo,
            sellSlot: t.sellSlot || null,
          });
        });

        // ─── 2) 필요한 날짜 집합만 양쪽 API 조회 ───
        const neededDates = Array.from(new Set(fallbacks.map((f) => f.dt))).sort();

        // (code,dt) → ka10072 매도 목록
        type ApiSell = {qty: number; price: number; ord_no: string};
        const ka72 = new Map<string, ApiSell[]>();
        const kt7 = new Map<string, ApiSell[]>();

        for (const dt of neededDates) {
          // ka10072 (매도 실현손익)
          try {
            const r72 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
              method: "POST",
              headers: {"Content-Type": "application/json; charset=utf-8", "authorization": `Bearer ${token}`, "api-id": "ka10072"},
              body: JSON.stringify({strt_dt: dt, end_dt: dt, ord_dt: dt, stk_cd: "", sell_tp: "1", qry_tp: "0", stk_bond_tp: "1", dmst_stex_tp: "KRX"}),
            });
            const d72 = await r72.json() as any;
            const items = d72.dt_stk_div_rlzt_pl || [];
            for (const item of items) {
              if (!(item.stk_nm || "").trim()) continue;
              const qty = parseInt(item.cntr_qty || "0");
              if (qty <= 0) continue;
              const code = cleanKiwoomField(item.stk_cd).replace(/^[A-Za-z]/, "");
              const price = parseInt(item.cntr_pric || "0");
              const ord = String(item.ord_no || item.cntr_no || "").trim();
              const key = `${code}_${dt}`;
              if (!ka72.has(key)) ka72.set(key, []);
              ka72.get(key)!.push({qty, price, ord_no: ord});
            }
          } catch (e) { /* skip */ }
          await new Promise((r) => setTimeout(r, 120));

          // kt00007 (주문체결상세) — 매도 전체 (현금 포함)
          try {
            const r7 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
              method: "POST",
              headers: {"Content-Type": "application/json; charset=utf-8", "authorization": `Bearer ${token}`, "api-id": "kt00007"},
              body: JSON.stringify({ord_dt: dt, qry_tp: "1", stk_bond_tp: "0", sell_tp: "0", stk_cd: "", fr_ord_no: "", dmst_stex_tp: "%"}),
            });
            const d7 = await r7.json() as any;
            let items7: any[] = [];
            for (const k of Object.keys(d7)) {
              if (Array.isArray(d7[k]) && d7[k].length > 0) {items7 = d7[k]; break;}
            }
            for (const item of items7) {
              const qty = parseInt(item.cntr_qty || "0");
              if (qty <= 0) continue;
              if (!(item.io_tp_nm || "").includes("매도")) continue;
              const code = cleanKiwoomField(item.stk_cd).replace(/^[A-Za-z]/, "");
              const price = parseInt(item.cntr_uv || "0");
              const ord = String(item.ord_no || "").trim();
              const key = `${code}_${dt}`;
              if (!kt7.has(key)) kt7.set(key, []);
              kt7.get(key)!.push({qty, price, ord_no: ord});
            }
          } catch (e) { /* skip */ }
          await new Promise((r) => setTimeout(r, 120));
        }

        // ─── 3) 각 fallback 정체 분류 ───
        type Probe = FbSell & {
          category: "ka72O_kt7X" | "ka72O_kt7O" | "bothMissing" | "kt7HasOther" | "ka72HasOther";
          ka72Match: ApiSell[];
          kt7Match: ApiSell[];
          kt7SameCodeDate: ApiSell[];
          ka72SameCodeDate: ApiSell[];
        };
        const probes: Probe[] = [];
        const catCount: Record<string, number> = {};
        const catByStock: Record<string, Record<string, number>> = {};

        for (const f of fallbacks) {
          const key = `${f.code}_${f.dt}`;
          const ka72All = ka72.get(key) || [];
          const kt7All = kt7.get(key) || [];
          const ka72Match = ka72All.filter((x) => x.qty === f.qty && x.price === f.price);
          const kt7Match = kt7All.filter((x) => x.qty === f.qty && x.price === f.price);

          let category: Probe["category"];
          if (kt7Match.length > 0) {
            category = "ka72O_kt7O"; // kt7에도 있음 (dryRun에서 noMatch였다면 ord_no 없는 케이스)
          } else if (ka72Match.length > 0) {
            category = "ka72O_kt7X"; // ka72엔 있는데 kt7엔 없음 (API 차이)
          } else if (kt7All.length > 0) {
            category = "kt7HasOther"; // kt7에 같은 종목·날짜 다른 가격/수량
          } else if (ka72All.length > 0) {
            category = "ka72HasOther";
          } else {
            category = "bothMissing"; // 양쪽 다 없음
          }

          catCount[category] = (catCount[category] || 0) + 1;
          if (!catByStock[f.stockName]) catByStock[f.stockName] = {};
          catByStock[f.stockName][category] = (catByStock[f.stockName][category] || 0) + 1;

          probes.push({
            ...f,
            category,
            ka72Match,
            kt7Match,
            kt7SameCodeDate: kt7All,
            ka72SameCodeDate: ka72All,
          });
        }

        const summary = {
          dateRange: {from: fromDash, to: toDash},
          fallbackProbed: fallbacks.length,
          datesQueried: neededDates.length,
          categories: catCount,
          legend: {
            ka72O_kt7X: "ka10072엔 있고 kt00007엔 없음 — kt7 정본화 불가, ka72 ord_no 사용 검토",
            ka72O_kt7O: "양쪽 API에 있음 — dryRun에서 ord_no 누락된 케이스(재확인)",
            kt7HasOther: "kt7에 같은 종목·날짜 매도 있으나 가격/수량 불일치",
            ka72HasOther: "ka72에 같은 종목·날짜 매도 있으나 가격/수량 불일치",
            bothMissing: "양쪽 API 모두 없음 — 수동입력/옛데이터 의심",
          },
          elapsedMs: Date.now() - startedAt,
        };

        const byStockArr = Object.entries(catByStock)
          .map(([name, cats]) => ({name, total: Object.values(cats).reduce((a, b) => a + b, 0), ...cats}))
          .sort((a, b) => b.total - a.total);

        res.json({success: true, summary, byStock: byStockArr, probes});
      } catch (e: any) {
        console.error("[diagSellNoMatchProbe] 실패:", e.message);
        res.status(500).json({success: false, error: e.message, elapsedMs: Date.now() - startedAt});
      }
    });
  });

// ════════════════════════════════════════════════════════════════
//  매도 정본화 공용 로직 (dry-run / 실행 공유)
//  docs/ARCHITECTURE_SOURCE_OF_TRUTH.md §5-1 (A안: kt00007 주문 정본 + split 승계)
// ════════════════════════════════════════════════════════════════

type KtOrder = {ord_no: string; qty: number; price: number; credit: boolean};
type FbTrade = {docId: string; qty: number; price: number; sellSlot: string | null; sellSlotSplit: any[] | null; sellRound: number | null; raw: any};
type SlotPart = {slot: string; qty: number};

// fallback 1건을 슬롯 파트로 펼침 (기존 split 우선, 없으면 단일 sellSlot, 없으면 unmapped)
function fbToSlotParts(f: FbTrade): SlotPart[] {
  if (Array.isArray(f.sellSlotSplit) && f.sellSlotSplit.length > 0) {
    return f.sellSlotSplit.map((sp: any) => ({slot: String(sp.slot || "unmapped"), qty: Number(sp.qty) || 0}));
  }
  return [{slot: f.sellSlot || "unmapped", qty: f.qty}];
}

// items 중 합이 정확히 target인 부분집합 — 여러 해 중 가중평균가가 refPrice에 가장 가까운 것
function findExactSubset(items: FbTrade[], target: number, refPrice: number): FbTrade[] | null {
  // 과대 N 방어: 15개 초과면 그리디(qty desc)로 근사
  if (items.length > 15) {
    const sorted = [...items].sort((a, b) => b.qty - a.qty);
    const chosen: FbTrade[] = [];
    let sum = 0;
    for (const it of sorted) {
      if (sum + it.qty <= target) {chosen.push(it); sum += it.qty;}
      if (sum === target) return chosen;
    }
    return null;
  }
  let best: FbTrade[] | null = null;
  let bestDiff = Infinity;
  const chosen: FbTrade[] = [];
  const dfs = (start: number, sumQty: number) => {
    if (sumQty === target) {
      let amt = 0;
      for (const c of chosen) amt += c.price * c.qty;
      const wavg = amt / target;
      const diff = Math.abs(wavg - refPrice);
      if (diff < bestDiff) {bestDiff = diff; best = chosen.slice();}
      return;
    }
    if (sumQty > target) return;
    for (let i = start; i < items.length; i++) {
      chosen.push(items[i]);
      dfs(i + 1, sumQty + items[i].qty);
      chosen.pop();
    }
  };
  dfs(0, 0);
  return best;
}

type MigAction = {
  type: "replace" | "merge";
  ordNo: string;
  newDocId: string;
  qty: number;
  ktPrice: number;
  fromDocIds: string[];
  sellSlot?: string | null;        // replace
  sellSlotSplit?: SlotPart[];      // merge
  weightedAvg?: number;            // merge 가격검증
  priceDiff?: number;              // |weightedAvg - ktPrice|
  credit: boolean;
};
type MigGroup = {
  code: string;
  date: string;
  stockName: string;
  status: "ok" | "qtyMismatch" | "partialFail";
  ktTotalQty: number;
  fbTotalQty: number;
  actions: MigAction[];
  unmatchedKtOrders?: KtOrder[];
  unmatchedFallbacks?: Array<{docId: string; qty: number; price: number; sellSlot: string | null}>;
};

// 한 (code,date) 그룹의 매도 정본화 계획 산출 (write 없음)
function planSellMigrationGroup(
  code: string, date: string, stockName: string,
  ktOrders: KtOrder[], fbs: FbTrade[]
): MigGroup {
  const ktTotalQty = ktOrders.reduce((s, o) => s + o.qty, 0);
  const fbTotalQty = fbs.reduce((s, f) => s + f.qty, 0);
  const g: MigGroup = {code, date, stockName, status: "ok", ktTotalQty, fbTotalQty, actions: []};

  // 총량 불일치 → 자동 배정 보류 (사용자 검토)
  if (ktTotalQty !== fbTotalQty) {
    g.status = "qtyMismatch";
    g.unmatchedKtOrders = ktOrders;
    g.unmatchedFallbacks = fbs.map((f) => ({docId: f.docId, qty: f.qty, price: f.price, sellSlot: f.sellSlot}));
    return g;
  }

  const pool = [...fbs];
  const orders = [...ktOrders].sort((a, b) => b.qty - a.qty);
  for (const order of orders) {
    const subset = findExactSubset(pool, order.qty, order.price);
    if (!subset || subset.length === 0) {
      g.status = "partialFail";
      g.unmatchedKtOrders = g.unmatchedKtOrders || [];
      g.unmatchedKtOrders.push(order);
      continue;
    }
    // pool에서 subset 제거
    for (const s of subset) {
      const idx = pool.findIndex((p) => p.docId === s.docId);
      if (idx >= 0) pool.splice(idx, 1);
    }
    const fromDocIds = subset.map((s) => s.docId);
    const newDocId = `trade_kiwoom_${order.ord_no}_${code}`;
    if (subset.length === 1) {
      g.actions.push({
        type: "replace", ordNo: order.ord_no, newDocId, qty: order.qty, ktPrice: order.price,
        fromDocIds, sellSlot: subset[0].sellSlot, credit: order.credit,
      });
    } else {
      // 슬롯 집계 (split 승계)
      const slotMap = new Map<string, number>();
      let amt = 0;
      for (const s of subset) {
        amt += s.price * s.qty;
        for (const part of fbToSlotParts(s)) {
          slotMap.set(part.slot, (slotMap.get(part.slot) || 0) + part.qty);
        }
      }
      const split: SlotPart[] = Array.from(slotMap.entries())
        .map(([slot, qty]) => ({slot, qty}))
        .sort((a, b) => b.qty - a.qty);
      const wavg = Math.round(amt / order.qty);
      g.actions.push({
        type: "merge", ordNo: order.ord_no, newDocId, qty: order.qty, ktPrice: order.price,
        fromDocIds, sellSlotSplit: split, weightedAvg: wavg, priceDiff: Math.abs(wavg - order.price),
        credit: order.credit,
      });
    }
  }
  if (pool.length > 0) {
    g.status = g.status === "ok" ? "partialFail" : g.status;
    g.unmatchedFallbacks = pool.map((f) => ({docId: f.docId, qty: f.qty, price: f.price, sellSlot: f.sellSlot}));
  }
  return g;
}

// 키움 kt00007 + Firestore fallback 수집 → (code,date) 그룹 빌드 (dry-run/실행 공유)
async function buildSellMigrationGroups(
  config: KiwoomConfig, token: string, fromDash: string, toDash: string, stockNameFilter: string
): Promise<{groups: MigGroup[]; kwDates: number; kwFail: number}> {
  const fmt = (dash: string) => dash.replace(/-/g, "");

  const isFallback = (on: string): boolean =>
    !on || on.startsWith("sell_") || on.startsWith("buy_") ||
    on.startsWith("fb_") || on.startsWith("kt07_") || on.startsWith("kt15_");

  // Firestore fallback 매도 수집
  const tsnap = await db.collection("trades").where("type", "==", "sell").get();
  const fbByKey = new Map<string, FbTrade[]>();
  const nameByKey = new Map<string, string>();
  tsnap.docs.forEach((doc) => {
    const t = doc.data() as any;
    const date = String(t.date || "");
    if (date < fromDash || date > toDash) return;
    const stockName = String(t.stockName || "");
    if (stockNameFilter && !stockName.includes(stockNameFilter)) return;
    const orderNo = String(t.orderNo || "").trim();
    if (!isFallback(orderNo)) return;
    const code = String(t.code || "").replace(/^A/, "");
    const key = `${code}_${fmt(date)}`;
    if (!fbByKey.has(key)) fbByKey.set(key, []);
    fbByKey.get(key)!.push({
      docId: doc.id,
      qty: Number(t.quantity) || 0,
      price: Number(t.price) || 0,
      sellSlot: t.sellSlot || null,
      sellSlotSplit: Array.isArray(t.sellSlotSplit) ? t.sellSlotSplit : null,
      sellRound: t.sellRound != null ? Number(t.sellRound) : null,
      raw: {stockName, code, date},
    });
    nameByKey.set(key, stockName);
  });

  // 필요한 날짜만 kt00007 조회
  const neededDates = Array.from(new Set(Array.from(fbByKey.keys()).map((k) => k.split("_")[1]))).sort();
  const ktByKey = new Map<string, KtOrder[]>();
  let kwDates = 0; let kwFail = 0;
  for (const dt of neededDates) {
    try {
      const r7 = await fetch(`${config.baseUrl}/api/dostk/acnt`, {
        method: "POST",
        headers: {"Content-Type": "application/json; charset=utf-8", "authorization": `Bearer ${token}`, "api-id": "kt00007"},
        body: JSON.stringify({ord_dt: dt, qry_tp: "1", stk_bond_tp: "0", sell_tp: "0", stk_cd: "", fr_ord_no: "", dmst_stex_tp: "%"}),
      });
      const d7 = await r7.json() as any;
      let items7: any[] = [];
      for (const k of Object.keys(d7)) {
        if (Array.isArray(d7[k]) && d7[k].length > 0) {items7 = d7[k]; break;}
      }
      for (const item of items7) {
        const qty = parseInt(item.cntr_qty || "0");
        if (qty <= 0) continue;
        const ioTp = (item.io_tp_nm || "").trim();
        if (!ioTp.includes("매도")) continue;
        const code = cleanKiwoomField(item.stk_cd).replace(/^[A-Za-z]/, "");
        const ordNo = String(item.ord_no || "").trim();
        if (!code || !ordNo) continue;
        const price = parseInt(item.cntr_uv || "0");
        const crdTp = (item.crd_tp || "").trim();
        const credit = ioTp.includes("융자") || ioTp.includes("신용") || crdTp.includes("융자") || crdTp.includes("신용");
        const key = `${code}_${dt}`;
        if (!ktByKey.has(key)) ktByKey.set(key, []);
        // 같은 ord_no가 여러 체결로 나오면 합산(주문단위)
        const arr = ktByKey.get(key)!;
        const existing = arr.find((o) => o.ord_no === ordNo);
        if (existing) {
          const totAmt = existing.price * existing.qty + price * qty;
          existing.qty += qty;
          existing.price = Math.round(totAmt / existing.qty);
        } else {
          arr.push({ord_no: ordNo, qty, price, credit});
        }
      }
      kwDates++;
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      kwFail++;
    }
  }

  const groups: MigGroup[] = [];
  for (const [key, fbs] of fbByKey.entries()) {
    const [code, dt] = key.split("_");
    const dateDash = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
    const ktOrders = ktByKey.get(key) || [];
    groups.push(planSellMigrationGroup(code, dateDash, nameByKey.get(key) || "", ktOrders, fbs));
  }
  groups.sort((a, b) => (a.stockName).localeCompare(b.stockName) || a.date.localeCompare(b.date));
  return {groups, kwDates, kwFail};
}

/**
 * ════════════════════════════════════════════════════════════════
 *  diagSellMergePlan — 매도 정본화 마이그레이션 계획 (Read-Only, A안)
 *  docs/ARCHITECTURE_SOURCE_OF_TRUTH.md §5-1
 *
 *  kt00007 주문(ord_no)을 정본으로, fallback 매도 체결을 부분합 매칭하여
 *  - 1:1 → replace (sellSlot 승계)
 *  - N:1 → merge (sellSlotSplit로 분류 승계, 가격검증)
 *  실데이터 write 0건. 계획만 출력 → 검토 후 실행 endpoint로.
 *
 *  GET /diagSellMergePlan                    (최근 90일)
 *  GET /diagSellMergePlan?from=20260318&to=20260616
 *  GET /diagSellMergePlan?stockName=네이블
 *  GET /diagSellMergePlan?status=partialFail  (특정 상태만)
 * ════════════════════════════════════════════════════════════════
 */
export const diagSellMergePlan = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 540, memory: "512MB"})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      const startedAt = Date.now();
      try {
        const kstNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
        const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const toDash = (req.query.to as string) ? (req.query.to as string).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : fmt(kstNow);
        const fromDefault = new Date(kstNow.getTime() - 90 * 24 * 60 * 60 * 1000);
        const fromDash = (req.query.from as string) ? (req.query.from as string).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : fmt(fromDefault);
        const stockNameFilter = (req.query.stockName as string || "").trim();
        const statusFilter = (req.query.status as string || "").trim();

        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        const {groups, kwDates, kwFail} = await buildSellMigrationGroups(config, token, fromDash, toDash, stockNameFilter);

        const filtered = statusFilter ? groups.filter((g) => g.status === statusFilter) : groups;

        let replaceCnt = 0; let mergeCnt = 0; let mergedTradesIn = 0;
        const statusCount: Record<string, number> = {};
        let priceWarnings = 0;
        for (const g of groups) {
          statusCount[g.status] = (statusCount[g.status] || 0) + 1;
          for (const a of g.actions) {
            if (a.type === "replace") replaceCnt++;
            else {
              mergeCnt++;
              mergedTradesIn += a.fromDocIds.length;
              if ((a.priceDiff || 0) > 5) priceWarnings++;
            }
          }
        }

        res.json({
          success: true,
          summary: {
            dateRange: {from: fromDash, to: toDash},
            kiwoom: {datesQueried: kwDates, datesFailed: kwFail},
            groups: groups.length,
            statusCount,
            actions: {replace: replaceCnt, merge: mergeCnt, mergedFallbacksConsumed: mergedTradesIn},
            priceWarnings,
            elapsedMs: Date.now() - startedAt,
          },
          groups: filtered,
        });
      } catch (e: any) {
        console.error("[diagSellMergePlan] 실패:", e.message);
        res.status(500).json({success: false, error: e.message, elapsedMs: Date.now() - startedAt});
      }
    });
  });

/**
 * ════════════════════════════════════════════════════════════════
 *  migrateSellExecute — 매도 정본화 실제 실행 (A안, WRITE)
 *  docs/ARCHITECTURE_SOURCE_OF_TRUTH.md §5-1
 *
 *  diagSellMergePlan의 ok 그룹을 실제로 적용:
 *   - replace: trade_kiwoom_{ord_no}_{code} 생성(sellSlot 승계) + fallback 삭제
 *   - merge:   생성(sellSlotSplit 승계, sellSlot="split") + fallback들 삭제
 *  qtyMismatch/partialFail 그룹은 자동 스킵.
 *
 *  안전장치:
 *   - ?execute=true 없으면 거부 (기본 거부)
 *   - 삭제 전 원본을 trades_backup_premerge 에 백업
 *   - 멱등: 새 docId 이미 있으면 set 생략(삭제만 보장)
 *   - newDocId가 fromDocIds에 포함되면 삭제 제외(덮어쓰기)
 *   - 영향 종목 reconcile 자동 트리거
 *
 *  사용:
 *    GET /migrateSellExecute?stockName=네이블            (dry: execute 없음 → 거부 안내)
 *    GET /migrateSellExecute?stockName=네이블&execute=true
 *    GET /migrateSellExecute?execute=true               (전체 — 신중)
 * ════════════════════════════════════════════════════════════════
 */
export const migrateSellExecute = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 540, memory: "512MB"})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      const startedAt = Date.now();
      try {
        const kstNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
        const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const toDash = (req.query.to as string) ? (req.query.to as string).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : fmt(kstNow);
        const fromDefault = new Date(kstNow.getTime() - 90 * 24 * 60 * 60 * 1000);
        const fromDash = (req.query.from as string) ? (req.query.from as string).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : fmt(fromDefault);
        const stockNameFilter = (req.query.stockName as string || "").trim();
        const execute = (req.query.execute as string) === "true";

        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        const {groups} = await buildSellMigrationGroups(config, token, fromDash, toDash, stockNameFilter);

        const okGroups = groups.filter((g) => g.status === "ok");
        const skipped = groups.filter((g) => g.status !== "ok")
          .map((g) => ({stockName: g.stockName, date: g.date, status: g.status}));

        // 실행 계획 집계
        let replacePlanned = 0; let mergePlanned = 0; let fallbacksToDelete = 0;
        for (const g of okGroups) {
          for (const a of g.actions) {
            if (a.type === "replace") replacePlanned++; else mergePlanned++;
            fallbacksToDelete += a.fromDocIds.length;
          }
        }

        if (!execute) {
          res.json({
            success: true,
            dryRun: true,
            message: "execute=true 를 붙여야 실제 적용됩니다.",
            scope: {from: fromDash, to: toDash, stockName: stockNameFilter || "(전체)"},
            planned: {okGroups: okGroups.length, replace: replacePlanned, merge: mergePlanned, fallbacksToDelete},
            skipped,
            elapsedMs: Date.now() - startedAt,
          });
          return;
        }

        // ─── 실제 실행 ───
        const affectedStocks = new Set<string>();
        let created = 0; let deleted = 0; let backedUp = 0; let skippedIdempotent = 0;
        const errors: Array<{group: string; error: string}> = [];

        for (const g of okGroups) {
          for (const a of g.actions) {
            try {
              const newRef = db.collection("trades").doc(a.newDocId);
              const newSnap = await newRef.get();

              // 원본 첫 문서에서 메타 승계
              const srcRef = db.collection("trades").doc(a.fromDocIds[0]);
              const srcSnap = await srcRef.get();
              if (!srcSnap.exists) {
                // 이미 정본 docId가 있고 원본이 없으면 = 이미 마이그레이션됨 (멱등)
                skippedIdempotent++;
                continue;
              }
              const src = srcSnap.data() as any;

              const newDoc: any = {
                stockName: g.stockName,
                code: g.code,
                type: "sell",
                date: src.date || g.date,
                price: a.ktPrice,
                quantity: a.qty,
                orderNo: a.ordNo,
                isCreditTrade: a.credit,
                createdAt: src.createdAt || Date.now(),
                migratedFrom: a.fromDocIds,
                migratedAt: Date.now(),
              };
              if (src.sellRound != null) newDoc.sellRound = src.sellRound;
              if (src.time) newDoc.time = src.time;
              if (a.type === "replace") {
                if (a.sellSlot) newDoc.sellSlot = a.sellSlot;
              } else {
                newDoc.sellSlotSplit = a.sellSlotSplit;
                newDoc.sellSlot = "split";
              }

              const batch = db.batch();
              // 백업 + 삭제 (newDocId 자신은 삭제 제외)
              for (const fid of a.fromDocIds) {
                if (fid === a.newDocId) continue;
                const fref = db.collection("trades").doc(fid);
                const fsnap = await fref.get();
                if (fsnap.exists) {
                  batch.set(db.collection("trades_backup_premerge").doc(fid), {
                    ...fsnap.data(), _backupAt: Date.now(), _migrateTo: a.newDocId,
                  });
                  batch.delete(fref);
                  backedUp++; deleted++;
                }
              }
              // 새 정본 문서 생성 (멱등: 이미 있으면 메타만 갱신)
              if (newSnap.exists) {
                batch.set(newRef, newDoc, {merge: true});
                skippedIdempotent++;
              } else {
                batch.set(newRef, newDoc);
                created++;
              }
              await batch.commit();
              affectedStocks.add(g.stockName);
            } catch (e: any) {
              errors.push({group: `${g.stockName} ${g.date} ${a.ordNo}`, error: e.message});
            }
          }
        }

        // 영향 종목 reconcile
        const reconciled: Array<{name: string; updated?: boolean; error?: string}> = [];
        for (const name of affectedStocks) {
          try {
            const r = await reconcileStockPlans(name);
            reconciled.push({name, updated: r.updated});
          } catch (e: any) {
            reconciled.push({name, error: e.message});
          }
        }

        res.json({
          success: true,
          executed: true,
          scope: {from: fromDash, to: toDash, stockName: stockNameFilter || "(전체)"},
          result: {created, deleted, backedUp, skippedIdempotent, affectedStocks: affectedStocks.size},
          reconciled,
          skipped,
          errors,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (e: any) {
        console.error("[migrateSellExecute] 실패:", e.message);
        res.status(500).json({success: false, error: e.message, elapsedMs: Date.now() - startedAt});
      }
    });
  });

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

admin.initializeApp();
const db = admin.firestore();
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

  return stockList
    .filter((item: any) => parseInt(item.cur_qty || "0") > 0)
    .map((item: any) => ({
      name: (item.stk_nm || "").trim(),
      code: (item.stk_cd || "").trim(),
      quantity: parseInt(item.cur_qty || "0"),
      avgPrice: parseInt(item.buy_uv || "0"),
      currentPrice: parseInt(item.cur_prc || "0"),
      profitRate: parseFloat(item.pl_rt || "0"),
      profitAmount: parseInt(item.evltv_prft || "0"),
      totalBuyAmount: parseInt(item.pur_amt || "0"),
    }));
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
        date: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
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
          if (qty > 0) {
            allTrades.push({
              name: (item.stk_nm || "").trim(),
              code: (item.stk_cd || "").trim(),
              type: "sell",
              price: parseInt(item.cntr_pric || "0"),
              quantity: qty,
              date: dt,
              time: "",
              orderNo: `sell_${dt}_${item.stk_cd}`,
            });
          }
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
            console.log(`[ka10076] ${dt}: ${items.length}건 매수체결`);
            for (const item of items) {
              const name = (item.stk_nm || "").trim();
              const qty = parseInt(item.cntr_qty || item.qty || "0");
              const price = parseInt(item.cntr_uv || item.cntr_pric || item.ord_uv || "0");
              allTrades.push({
                name,
                code: (item.stk_cd || "").trim(),
                type: "buy",
                price,
                quantity: qty,
                date: dt,
                time: item.cntr_tm || item.ord_tm || "",
                orderNo: `buy_${dt}_${item.stk_cd}_${item.ord_no || ""}`,
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
              const name = (item.stk_nm || "").trim();
              const qty = parseInt(item.cntr_qty || item.qty || "0");
              const price = parseInt(item.cntr_pric || item.pric || item.buy_uv || "0");
              const dt = item.ord_dt || item.cntr_dt || item.trde_dt || "";
              if (name && qty > 0) {
                const formattedDate = dt.length === 8
                  ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`
                  : dt;
                allTrades.push({
                  name,
                  code: (item.stk_cd || "").trim(),
                  type: "buy",
                  price,
                  quantity: qty,
                  date: dt,
                  time: item.ord_tm || "",
                  orderNo: `buy_${dt}_${item.stk_cd}`,
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

  return allTrades;
}

// ─── 체결내역을 종목별 매수/매도 차수에 매핑 ───
function mapTradesToPlans(
  trades: any[],
  stockName: string,
  holdings: any
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
      });
    } else if (i === 0 && buyDates.length === 0 && holdings) {
      // 매수 내역 없지만 보유 중 → 1차 매수 체결로 설정
      // firstBuyQty = 현재보유 + 매도수량 (원래 매수량)
      buyPlans.push({
        level: 1,
        price: holdings.avgPrice || 0,
        quantity: firstBuyQty,
        filled: true,
        filledDate: "",
        filledQuantity: firstBuyQty,
        filledPrice: holdings.avgPrice || 0,
      });
    } else {
      // 미체결 차수: 이전 차수 기준 -10%
      const prevPrice: number = i > 0 && buyPlans[i - 1]
        ? (buyPlans[i - 1].price as number)
        : firstBuyPrice;
      buyPlans.push({
        level: i + 1,
        price: prevPrice > 0 ? Math.round(prevPrice * 0.9) : 0,
        quantity: firstBuyQty,
        filled: false,
        filledDate: "",
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

  // 매도 차수 매핑: 같은 날짜의 매도는 같은 차수로 묶음
  const sellByDate: Record<string, {totalQty: number; totalAmt: number; date: string}> = {};
  for (const s of sells) {
    const dt = s.date || "";
    if (!sellByDate[dt]) {
      sellByDate[dt] = {totalQty: 0, totalAmt: 0, date: dt};
    }
    sellByDate[dt].totalQty += s.quantity;
    sellByDate[dt].totalAmt += s.price * s.quantity;
  }

  const sellDates = Object.keys(sellByDate).sort();
  const sellCount = sellDates.length;

  // 수익 매도 계획 (5단계)
  const percents = [5, 10, 15, 20, 25];
  const sellPlans = percents.map((p, i) => {
    const sellDate = sellDates[i];
    const sellData = sellDate ? sellByDate[sellDate] : null;

    if (sellData) {
      const sellAvgPrice = Math.round(sellData.totalAmt / sellData.totalQty);
      const formattedDate = sellDate.length === 8
        ? `${sellDate.slice(0, 4)}-${sellDate.slice(4, 6)}-${sellDate.slice(6, 8)}`
        : sellDate;
      return {
        percent: p,
        price: sellAvgPrice,
        quantity: sellData.totalQty,
        filled: true,
        filledDate: formattedDate,
        filledQuantity: sellData.totalQty,
        filledPrice: sellAvgPrice,
      };
    }
    return {
      percent: p,
      price: avgPrice > 0 ? Math.round(avgPrice * (1 + p / 100)) : 0,
      quantity: totalQty > 0 ? Math.round(totalQty * 0.2) : 0,
      filled: false,
      filledDate: "",
    };
  });

  return {buyPlans, sellPlans, sellCount, firstBuyPrice, firstBuyQty};
}

// ─── Firestore에 동기화 ───
async function syncToFirestore(
  holdings: any[],
  trades: any[]
): Promise<{syncedStocks: number; syncedTrades: number; soldOutStocks: string[]}> {
  const now = Date.now();
  let syncedStocks = 0;
  let syncedTrades = 0;

  // 기존 종목 매핑 (종목명 → docId)
  const existingStocks: Record<string, string> = {};
  const stockDocs = await db.collection("stocks").get();
  stockDocs.forEach((doc) => {
    const data = doc.data();
    if (data.name) {
      existingStocks[data.name] = doc.id;
    }
  });

  // 잔고에서 보유수량 0인 종목은 전량매도로 처리하기 위해 분리
  const activeHoldings = holdings.filter((h) => (h.quantity || 0) > 0);
  const zeroHoldings = holdings.filter((h) => (h.quantity || 0) === 0);
  console.log(`[잔고] 보유 ${activeHoldings.length}종목, 보유0 ${zeroHoldings.length}종목: [${zeroHoldings.map((h: any) => h.name).join(", ")}]`);

  // 잔고 동기화 (보유 중인 종목만)
  for (const h of activeHoldings) {
    // 체결내역으로 매수/매도 차수 매핑
    const mapped = mapTradesToPlans(trades, h.name, h);

    if (h.name in existingStocks) {
      // 기존 종목 업데이트
      const existingDoc = await db.collection("stocks").doc(existingStocks[h.name]).get();
      const existingData = existingDoc.data();

      // 체결 내역이 있을 때만 buyPlans/sellPlans 업데이트
      // 체결 내역 없이 잔고만 조회한 경우 기존 계획 보존
      const hasTrades = trades.some((t) => t.name === h.name);
      const stockTrades = trades.filter((t) => t.name === h.name);
      const stockBuys = stockTrades.filter((t) => t.type === "buy");
      console.log(`[동기화] ${h.name}: hasTrades=${hasTrades}, 매수=${stockBuys.length}건, 매도=${stockTrades.length - stockBuys.length}건, mapped.firstBuyQty=${mapped.firstBuyQty}, holdings.qty=${h.quantity}`);

      const updateData: any = {
        currentPrice: h.currentPrice,
        updatedAt: now,
      };

      if (hasTrades) {
        // 체결 내역 기반으로 전체 업데이트
        updateData.avgPrice = h.avgPrice;
        updateData.totalQuantity = h.quantity;
        updateData.buyPlans = mapped.buyPlans;
        updateData.sellPlans = mapped.sellPlans;
        updateData.sellCount = mapped.sellCount;
        updateData.firstBuyPrice = mapped.firstBuyPrice;
        updateData.firstBuyQuantity = mapped.firstBuyQty;
      } else {
        // 매도 내역 없음 = 매도한 적 없는 종목: 현재 보유량 = 원래 매수량
        // firstBuyQuantity가 이미 올바르게 설정되어 있으면 보존
        if (!existingData?.firstBuyQuantity || existingData.firstBuyQuantity === 0) {
          updateData.firstBuyQuantity = h.quantity;
        }
        if (!existingData?.firstBuyPrice || existingData.firstBuyPrice === 0) {
          updateData.firstBuyPrice = h.avgPrice;
        }
        updateData.avgPrice = h.avgPrice;
        updateData.totalQuantity = h.quantity;
      }

      await db.collection("stocks").doc(existingStocks[h.name]).update(updateData);
    } else {
      // 새 종목 추가
      const docId = `stock_${now}_${syncedStocks}`;

      const maSells = [20, 60, 120].map((ma) => ({
        ma,
        price: 0,
        quantity: 0,
        filled: false,
      }));

      await db.collection("stocks").doc(docId).set({
        name: h.name,
        rule: "A",
        firstBuyPrice: mapped.firstBuyPrice,
        firstBuyQuantity: mapped.firstBuyQty,
        currentPrice: h.currentPrice,
        avgPrice: h.avgPrice,
        totalQuantity: h.quantity,
        buyPlans: mapped.buyPlans,
        sellPlans: mapped.sellPlans,
        maSells,
        sellCount: mapped.sellCount,
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

      await db.collection("stocks").doc(docId).update({
        totalQuantity: 0,
        currentPrice: 0,
        avgPrice: existingAvgBuyPrice,
        buyPlans: newBuyPlans,
        sellPlans: newSellPlans,
        sellCount: filledSellCount,
        updatedAt: now,
      });
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
  for (const t of trades) {
    const tradeId = `trade_kiwoom_${t.date}_${t.orderNo}_${t.code}`;
    const docRef = db.collection("trades").doc(tradeId);
    const doc = await docRef.get();

    if (!doc.exists) {
      const formattedDate = t.date
        ? `${t.date.slice(0, 4)}-${t.date.slice(4, 6)}-${t.date.slice(6, 8)}`
        : new Date().toISOString().slice(0, 10);

      await docRef.set({
        date: formattedDate,
        stockName: t.name,
        type: t.type,
        price: t.price,
        quantity: t.quantity,
        memo: `키움 자동동기화 (${t.time || ""})`,
        tags: ["#키움동기화"],
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

        // 잔고 + 체결내역 조회
        const [holdings, todayTrades, historyTrades] = await Promise.all([
          fetchHoldings(config, token),
          fetchTodayTrades(config, token),
          startDate ? fetchTradeHistory(config, token, startDate, endDate) : Promise.resolve([]),
        ]);
        const trades = [...historyTrades, ...todayTrades];

        // Firestore에 동기화
        const result = await syncToFirestore(holdings, trades);

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

/**
 * 장중 자동 동기화 (5분마다, 평일 9:00~15:30 KST)
 * Cloud Scheduler가 자동 호출
 */
export const kiwoomAutoSync = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .pubsub.schedule("every 5 minutes")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    const now = new Date();
    const kst = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
    const hour = kst.getHours();
    const min = kst.getMinutes();
    const day = kst.getDay();
    const timeNum = hour * 100 + min;

    // 평일 장중(09:00~15:30)만 실행
    if (day === 0 || day === 6 || timeNum < 900 || timeNum > 1530) {
      console.log(`장외 시간 (${hour}:${min}, 요일:${day}) - 스킵`);
      return;
    }

    try {
      const config = await getKiwoomConfig();
      const token = await getAccessToken(config);
      const holdings = await fetchHoldings(config, token);

      // 자동동기화: 현재가 + 잔고만 업데이트 (buyPlans/sellPlans 보존)
      const stockDocs = await db.collection("stocks").get();
      const nameToId: Record<string, string> = {};
      stockDocs.forEach((d) => {
        const data = d.data();
        if (data.name) nameToId[data.name] = d.id;
      });

      let updated = 0;
      for (const h of holdings) {
        const docId = nameToId[h.name];
        if (docId) {
          await db.collection("stocks").doc(docId).update({
            currentPrice: h.currentPrice,
            avgPrice: h.avgPrice,
            totalQuantity: h.quantity,
            updatedAt: Date.now(),
          });
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

      // 관심종목 현재가도 업데이트
      await updateWatchlistPrices(config, token);
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
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);
        const holdings = await fetchHoldings(config, token);

        // 현재가만 업데이트 (buyPlans/sellPlans 건드리지 않음)
        const now = Date.now();
        const stockDocs = await db.collection("stocks").get();
        const nameToId: Record<string, string> = {};
        stockDocs.forEach((doc) => {
          const data = doc.data();
          if (data.name) nameToId[data.name] = doc.id;
        });

        let updated = 0;
        for (const h of holdings) {
          const docId = nameToId[h.name];
          if (docId) {
            await db.collection("stocks").doc(docId).update({
              currentPrice: h.currentPrice,
              updatedAt: now,
            });
            updated++;
          }
        }

        await db.collection("settings").doc("lastSync").set({
          timestamp: now, stocks: updated, trades: 0,
        });

        res.json({success: true, updated, time: new Date().toISOString()});
      } catch (error: any) {
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
async function updateWatchlistPrices(config: KiwoomConfig, token: string): Promise<number> {
  const watchDocs = await db.collection("watchlist").get();
  if (watchDocs.empty) return 0;

  const items: {id: string; code: string; peakPrice: number; targetPercent: number; prevAlertLevel: number}[] = [];
  watchDocs.forEach((d) => {
    const data = d.data();
    if (data.code && data.status !== "bought") {
      items.push({
        id: d.id,
        code: data.code,
        peakPrice: data.peakPrice || 0,
        targetPercent: data.targetPercent || -50,
        prevAlertLevel: data.alertLevel || 0,
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
        console.log(`[관심종목 가격] ${item.code}: chart[0] keys=${Object.keys(chart[0]).join(",")}`);
        console.log(`[관심종목 가격] ${item.code}: chart[0]=${JSON.stringify(chart[0]).substring(0, 300)}`);
        if (chart.length > 1) {
          console.log(`[관심종목 가격] ${item.code}: chart[1]=${JSON.stringify(chart[1]).substring(0, 300)}`);
        }
        const curPrice = parseInt(chart[0].cur_prc || "0");
        const openPrice = parseInt(chart[0].open_pric || chart[0].strt_pric || "0");
        // 전일종가: 두 번째 행(전일)의 종가 또는 첫 행의 기준가
        const prevClose = chart.length > 1
          ? parseInt(chart[1].cur_prc || "0")
          : parseInt(chart[0].base_pric || chart[0].yday_prc || "0");
        console.log(`[관심종목 가격] ${item.code}: cur=${curPrice}, open=${openPrice}, prevClose=${prevClose}, chartLen=${chart.length}`);

        if (curPrice > 0) {
          const dropPercent = item.peakPrice > 0 ? ((curPrice - item.peakPrice) / item.peakPrice) * 100 : 0;
          const isYangbong = openPrice > 0 && curPrice > openPrice;

          let alertLevel: 0 | 1 | 2 | 3 = 0;
          let status = "watching";
          if (dropPercent <= -50 && isYangbong) { alertLevel = 3; status = "ready"; }
          else if (dropPercent <= -45) { alertLevel = 2; status = "approaching"; }
          else if (dropPercent <= -40) { alertLevel = 1; status = "approaching"; }

          await db.collection("watchlist").doc(item.id).update({
            currentPrice: curPrice,
            openPrice: openPrice,
            prevClose: prevClose || 0,
            status,
            alertLevel,
            updatedAt: Date.now(),
          });
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
    console.log(`[매수신호] 체크 시작 ${kst.getHours()}:${kst.getMinutes()}`);

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

      // 3. 매수 대기 종목 찾기 (현재가 <= 다음 매수가)
      const candidates: {name: string; code: string; nextBuyPrice: number; nextBuyLevel: number; currentPrice: number; quantity: number}[] = [];
      for (const [name, stock] of Object.entries(stocks)) {
        if (!stock.buyPlans || ((stock.totalQuantity || 0) === 0 && !(stock.buyPlans || []).some((b: any) => b.filled))) continue;
        const nextBuy = (stock.buyPlans || []).find((b: any) => !b.filled);
        if (!nextBuy || !stock.currentPrice || stock.currentPrice <= 0) continue;
        if (stock.currentPrice <= nextBuy.price) {
          candidates.push({
            name,
            code: stock.code || (holdings.find((h) => h.name === name) || {code: ""}).code || "",
            nextBuyPrice: nextBuy.price,
            nextBuyLevel: nextBuy.level,
            currentPrice: stock.currentPrice,
            quantity: nextBuy.quantity || stock.firstBuyQuantity || 0,
          });
        }
      }

      if (candidates.length === 0) {
        console.log("[매수신호] 매수 대기 종목 없음");
        return "매수 대기 종목 없음";
      }

      console.log(`[매수신호] 매수 대기 ${candidates.length}종목: ${candidates.map((c) => c.name).join(", ")}`);

      // 4. 시가 조회 (양봉 판단용)
      const codes = candidates.map((c) => c.code).filter(Boolean);
      const openPrices = await fetchOpenPrices(config, token, codes);

      // 5. 양봉 확인 (현재가 > 시가)
      const signals: typeof candidates = [];
      for (const c of candidates) {
        const openPrice = openPrices[c.code];
        if (openPrice && c.currentPrice > openPrice) {
          signals.push(c);
          console.log(`[매수신호] ${c.name}: 양봉 확인! 시가=${openPrice} → 현재가=${c.currentPrice} (${c.nextBuyLevel}차 매수가=${c.nextBuyPrice})`);
        } else {
          console.log(`[매수신호] ${c.name}: 음봉 (시가=${openPrice || "?"}, 현재가=${c.currentPrice}) - 스킵`);
        }
      }

      // 6. Firestore에 매수신호 상태 저장
      const now = Date.now();
      for (const c of candidates) {
        const openPrice = openPrices[c.code] || 0;
        const isYangbong = openPrice > 0 && c.currentPrice > openPrice;
        const docId = stocks[c.name]?.docId;
        if (docId) {
          await db.collection("stocks").doc(docId).update({
            buySignal: isYangbong ? "signal" : "waiting",
            buySignalAt: now,
            buySignalOpen: openPrice,
          });
        }
      }

      // 7. 텔레그램 알림 전송
      if (signals.length > 0) {
        const y = kst.getFullYear();
        const m = String(kst.getMonth() + 1).padStart(2, "0");
        const d = String(kst.getDate()).padStart(2, "0");
        const hh = kst.getHours();
        const mm = String(kst.getMinutes()).padStart(2, "0");
        let msg = `<b>🔴 태산매매법 매수신호!</b>\n`;
        msg += `<i>${y}-${m}-${d} ${hh}:${mm}</i>\n\n`;

        for (const s of signals) {
          const openPrice = openPrices[s.code] || 0;
          const yangbongRate = openPrice > 0 ? ((s.currentPrice - openPrice) / openPrice * 100).toFixed(1) : "?";
          msg += `<b>📌 ${s.name}</b>\n`;
          msg += `  ${s.nextBuyLevel}차 매수 | 매수가: ${s.nextBuyPrice.toLocaleString()}원\n`;
          msg += `  현재가: ${s.currentPrice.toLocaleString()}원\n`;
          msg += `  시가: ${openPrice.toLocaleString()}원 (양봉 +${yangbongRate}%)\n`;
          msg += `  수량: ${s.quantity.toLocaleString()}주\n\n`;
        }
        msg += `⏰ 종가배팅 준비하세요!`;

        const sent = await sendTelegram(msg);
        console.log(`[매수신호] 텔레그램 ${sent ? "전송 완료" : "전송 실패"}: ${signals.length}종목`);
      } else {
        console.log("[매수신호] 양봉 확인된 종목 없음 - 알림 없음");
      }

      // 매수 대기만 있고 양봉은 없는 경우에도 참고 알림
      if (signals.length === 0 && candidates.length > 0) {
        const y = kst.getFullYear();
        const m = String(kst.getMonth() + 1).padStart(2, "0");
        const d = String(kst.getDate()).padStart(2, "0");
        const hh = kst.getHours();
        const mm = String(kst.getMinutes()).padStart(2, "0");
        let msg = `<b>⏳ 태산매매법 매수 대기</b>\n`;
        msg += `<i>${y}-${m}-${d} ${hh}:${mm}</i>\n\n`;
        for (const c of candidates) {
          const openPrice = openPrices[c.code] || 0;
          msg += `📋 ${c.name} (${c.nextBuyLevel}차)\n`;
          msg += `  매수가: ${c.nextBuyPrice.toLocaleString()}원 | 현재: ${c.currentPrice.toLocaleString()}원\n`;
          msg += `  시가: ${openPrice.toLocaleString()}원 → 음봉 (매수 보류)\n\n`;
        }
        await sendTelegram(msg);
      }

    } catch (err: any) {
      console.error("[매수신호] 오류:", err.message);
      await sendTelegram(`⚠️ 매수신호 체크 오류: ${err.message}`);
      return `오류: ${err.message}`;
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
 * 매수신호 체크 + 텔레그램 알림
 * 평일 15:10 KST에 Cloud Scheduler가 호출
 */
export const buySignalCheck = functions
  .region("asia-northeast3")
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .pubsub.schedule("10 15 * * 1-5")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
    await runBuySignalCheck();
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

          // ka10099: 주식종목조회 (KOSPI + KOSDAQ)
          for (const marketCode of ["0", "10"]) {
            const apiRes = await fetch(`${config.baseUrl}/api/dostk/sise`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "authorization": `Bearer ${token}`,
                "api-id": "ka10099",
              },
              body: JSON.stringify({mkt_gb: marketCode}),
            });
            const data = await apiRes.json() as any;
            console.log(`[종목리스트] ka10099 mkt_gb=${marketCode}: keys=${Object.keys(data).join(",")}, sample=${JSON.stringify(data).substring(0, 300)}`);

            // 응답 구조에서 종목 리스트 추출
            const listKey = Object.keys(data).find((k) => Array.isArray(data[k]));
            if (listKey) {
              const items = data[listKey];
              const marketName = marketCode === "0" ? "KOSPI" : "KOSDAQ";
              for (const item of items) {
                const code = item.stk_cd || item.shcode || item.종목코드 || "";
                const name = item.stk_nm || item.hname || item.종목명 || "";
                if (code && name) {
                  await db.collection("stockCodes").doc(`stock_${code}`).set({
                    name, code, market: marketName,
                  });
                  totalCount++;
                }
              }
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

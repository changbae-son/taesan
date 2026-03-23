/**
 * 태산매매법 - Firebase Cloud Functions
 * 키움증권 REST API → Firestore 동기화
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

  // ka10072 (일별종목별실현손익) - 매도 내역 조회 (날짜별)
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
          sell_tp: "0",
          qry_tp: "0",
          stk_bond_tp: "1",
          dmst_stex_tp: "KRX",
        }),
      });
      const data = await res.json() as any;
      const items = data.dt_stk_div_rlzt_pl || [];
      const valid = items.filter((x: any) => (x.stk_nm || "").trim() !== "");

      if (valid.length > 0) {
        const formattedDate = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
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

  console.log(`매도 내역: ${allTrades.length}건`);

  // 매수 내역 조회: 여러 API 시도
  const buyTrades: any[] = [];

  // ka10076 (체결요청) - 날짜별 시도
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
          qry_tp: "0",
          sell_tp: "0",
          stex_tp: "1",
        }),
      });
      const data = await res.json() as any;

      // 배열 필드 탐색
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) {
          const items = data[key];
          const valid = items.filter((x: any) =>
            (x.stk_nm || "").trim() !== "" && parseInt(x.cntr_qty || "0") > 0
          );
          if (valid.length > 0) {
            const formattedDate = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
            console.log(`[ka10076] ${dt}: ${valid.length}건 체결 (필드: ${key})`);
            if (dt === dates[0]) {
              console.log(`[ka10076] 샘플:`, JSON.stringify(valid[0]).slice(0, 500));
            }
            for (const item of valid) {
              const qty = parseInt(item.cntr_qty || "0");
              const isSell = (item.trde_tp || item.io_tp_nm || "").includes("매도");
              buyTrades.push({
                name: (item.stk_nm || "").trim(),
                code: (item.stk_cd || "").trim(),
                type: isSell ? "sell" : "buy",
                price: parseInt(item.cntr_pric || item.cntr_uv || "0"),
                quantity: qty,
                date: dt,
                time: item.ord_tm || "",
                orderNo: item.ord_no || `${dt}_${item.stk_cd}`,
              });
            }
          }
        }
      }

      // 첫 날짜 전체 응답 로그
      if (dt === dates[0]) {
        console.log(`[ka10076] ${dt} code:${data.return_code} msg:${data.return_msg} keys:${Object.keys(data)}`);
        const cntr = data.cntr || [];
        if (cntr.length > 0) {
          console.log(`[ka10076] cntr[0]:`, JSON.stringify(cntr[0]).slice(0, 500));
        }
      }

      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      console.log(`${dt} ka10076 스킵:`, err);
    }
  }

  console.log(`ka10076 매수+매도: ${buyTrades.length}건`);

  // ka10076에서 가져온 데이터가 있으면 사용 (매수+매도 모두 포함)
  if (buyTrades.length > 0) {
    // ka10076이 매수+매도 모두 포함하므로 이걸 메인으로 사용
    return buyTrades;
  }

  // ka10072 매도만이라도 반환
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
  const firstBuyQty = firstBuy ? firstBuy.totalQty : (holdings?.quantity || 0);

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
      });
    } else if (i === 0 && buyDates.length === 0 && holdings) {
      // 매수 내역 없지만 보유 중 → 1차 매수 체결로 설정
      buyPlans.push({
        level: 1,
        price: holdings.avgPrice || 0,
        quantity: holdings.quantity || 0,
        filled: true,
        filledDate: "",
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
): Promise<{syncedStocks: number; syncedTrades: number}> {
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

  // 잔고 동기화
  for (const h of holdings) {
    // 체결내역으로 매수/매도 차수 매핑
    const mapped = mapTradesToPlans(trades, h.name, h);

    if (h.name in existingStocks) {
      // 기존 종목 업데이트 (체결내역 기반 차수 반영)
      await db.collection("stocks").doc(existingStocks[h.name]).update({
        currentPrice: h.currentPrice,
        avgPrice: h.avgPrice,
        totalQuantity: h.quantity,
        buyPlans: mapped.buyPlans,
        sellPlans: mapped.sellPlans,
        sellCount: mapped.sellCount,
        firstBuyPrice: mapped.firstBuyPrice,
        firstBuyQuantity: mapped.firstBuyQty,
        updatedAt: now,
      });
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

  // 동기화 기록 저장
  await db.collection("settings").doc("lastSync").set({
    timestamp: now,
    stocks: syncedStocks,
    trades: syncedTrades,
  });

  return {syncedStocks, syncedTrades};
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

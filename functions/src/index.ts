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

// ─── 체결 내역 조회 (ka10076 체결요청) ───
async function fetchTradeHistory(
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
        acctNo: config.accountNo.replace("-", ""),
      }),
    });

    const data = await res.json() as any;

    if (data.return_code && data.return_code !== "0") {
      console.log("체결내역 조회 실패 (무시):", data.return_msg);
      return [];
    }

    // 체결 내역이 있으면 파싱
    const trades = data.output || data.list || [];
    return Array.isArray(trades) ? trades.map((item: any) => ({
      name: (item.stk_nm || item.prdt_name || "").trim(),
      code: (item.stk_cd || item.pdno || "").trim(),
      type: (item.sll_buy_dvsn || "").includes("매도") ? "sell" : "buy",
      price: parseInt(item.ccld_prc || item.avg_prc || "0"),
      quantity: parseInt(item.ccld_qty || item.tot_qty || "0"),
      date: item.ord_dt || item.ccld_dt || "",
      time: item.ccld_tm || "",
      orderNo: item.odno || "",
    })) : [];
  } catch (err) {
    console.log("체결내역 조회 스킵:", err);
    return [];
  }
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
    if (h.name in existingStocks) {
      // 기존 종목 업데이트
      await db.collection("stocks").doc(existingStocks[h.name]).update({
        currentPrice: h.currentPrice,
        avgPrice: h.avgPrice,
        totalQuantity: h.quantity,
        updatedAt: now,
      });
    } else {
      // 새 종목 추가
      const docId = `stock_${now}_${syncedStocks}`;
      const buyPlans = [];
      for (let i = 0; i < 5; i++) {
        buyPlans.push({
          level: i + 1,
          price: i === 0 ? h.avgPrice : Math.round(h.avgPrice * Math.pow(0.9, i)),
          quantity: i === 0 ? h.quantity : h.quantity,
          filled: i === 0,
        });
      }

      const sellPlans = [5, 10, 15, 20, 25].map((p) => ({
        percent: p,
        price: Math.round(h.avgPrice * (1 + p / 100)),
        quantity: Math.round(h.quantity * 0.2),
        filled: false,
      }));

      const maSells = [20, 60, 120].map((ma) => ({
        ma,
        price: 0,
        quantity: 0,
        filled: false,
      }));

      await db.collection("stocks").doc(docId).set({
        name: h.name,
        rule: "A",
        firstBuyPrice: h.avgPrice,
        firstBuyQuantity: h.quantity,
        currentPrice: h.currentPrice,
        avgPrice: h.avgPrice,
        totalQuantity: h.quantity,
        buyPlans,
        sellPlans,
        maSells,
        sellCount: 0,
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
  .runWith({vpcConnector: "kiwoom-connector", vpcConnectorEgressSettings: "ALL_TRAFFIC", timeoutSeconds: 120})
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      try {
        const config = await getKiwoomConfig();
        const token = await getAccessToken(config);

        // 잔고 + 체결내역 조회
        const [holdings, trades] = await Promise.all([
          fetchHoldings(config, token),
          fetchTradeHistory(config, token),
        ]);

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

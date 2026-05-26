/**
 * JB Trader Web (jb-s-web) 전용 키움 브릿지
 *
 * 태산 Functions 인프라(VPC connector "kiwoom-connector" + 정적 IP 34.22.64.217)를
 * 그대로 재사용하면서, jb-s-web 프로젝트의 Firebase Auth 토큰을 검증해 본인만 호출 가능.
 *
 * 키 격리: 태산 키와 다른 KIWOOM_JB_APP_KEY/SECRET을 functions:secrets로 등록.
 * 데이터 격리: 이 파일은 jb-s-web Firestore에 직접 쓰지 않음 — 시세 값만 응답.
 *             jb-s-web 클라이언트가 받아서 자신의 Firestore에 저장.
 *
 * 별도 IP 분리가 필요해질 경우: jb-s-web 프로젝트에 자체 Functions 배포 후
 * jb-s-web .env의 VITE_JB_BRIDGE_URL만 새 도메인으로 바꾸면 됨.
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import fetch from "node-fetch";
import cors = require("cors");

const JB_PROJECT_ID = "jb-s-web";
const KIWOOM_BASE = "https://api.kiwoom.com";

const jbCors = cors({
  origin: [
    "https://jb-s-web.web.app",
    "https://jb-s-web.firebaseapp.com",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
  ],
  credentials: false,
});

/** jb-s-web 프로젝트의 ID 토큰을 검증하기 위한 이름있는 admin app */
function getJbAdmin(): admin.app.App {
  const existing = admin.apps.find((a) => a?.name === "jb");
  if (existing) return existing;
  return admin.initializeApp({projectId: JB_PROJECT_ID}, "jb");
}

async function verifyJbAuth(req: functions.https.Request): Promise<string> {
  const h = (req.headers.authorization as string) || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) throw new Error("missing authorization header");
  const decoded = await admin.auth(getJbAdmin()).verifyIdToken(m[1]);
  return decoded.uid;
}

/** 키움 토큰 캐시 (인스턴스 메모리, ~23h) */
let jbTokenCache: { token: string; exp: number } | null = null;

/**
 * 키움 키 우선순위:
 *   1순위: Firestore settings/kiwoom_jb (어디서든 갱신 가능)
 *   2순위: Secret Manager KIWOOM_JB_APP_KEY/SECRET (초기 부트스트랩용)
 */
async function loadJbKiwoomCreds(): Promise<{appKey: string; appSecret: string}> {
  try {
    const doc = await admin.firestore()
      .collection("settings").doc("kiwoom_jb").get();
    const cfg = doc.data();
    if (cfg?.appKey && cfg?.appSecret) {
      return {appKey: cfg.appKey, appSecret: cfg.appSecret};
    }
  } catch {
    /* fall through to Secret */
  }
  const appKey = process.env.KIWOOM_JB_APP_KEY;
  const appSecret = process.env.KIWOOM_JB_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error("키움 키 미설정 (Firestore settings/kiwoom_jb 또는 Secret 둘 다 비어있음)");
  }
  return {appKey, appSecret};
}

async function getJbKiwoomToken(): Promise<string> {
  if (jbTokenCache && jbTokenCache.exp > Date.now() + 60_000) {
    return jbTokenCache.token;
  }
  const {appKey, appSecret} = await loadJbKiwoomCreds();
  const res = await fetch(`${KIWOOM_BASE}/oauth2/token`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: appKey,
      secretkey: appSecret,
    }),
  });
  const data: any = await res.json();
  if (!data.token) {
    throw new Error(`jb 키움 토큰 발급 실패: ${JSON.stringify(data)}`);
  }
  jbTokenCache = {
    token: data.token,
    exp: data.expires_dt ?
      new Date(data.expires_dt).getTime() :
      Date.now() + 23 * 60 * 60 * 1000,
  };
  return jbTokenCache.token;
}

const numField = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return 0;
  const n = Number(v.replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
};

/**
 * jb-s-web → 종목 현재가 조회
 * POST /jbQuote
 * headers: Authorization: Bearer <jb-s-web Firebase ID Token>
 * body: { code: "005930" }
 */
export const jbQuote = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 30,
    secrets: ["KIWOOM_JB_APP_KEY", "KIWOOM_JB_APP_SECRET"],
  })
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST only"});
          return;
        }
        await verifyJbAuth(req);
        const code = (req.body?.code || "").toString();
        if (!/^\d{6}$/.test(code)) {
          res.status(400).json({error: "code must be 6 digits"});
          return;
        }
        const token = await getJbKiwoomToken();
        // 통합(KRX+NXT) 가격 조회: stk_cd 접미사 "_AL"
        // NXT 미지원 종목은 빈 응답 → 일반 코드로 폴백
        const callKa10001 = async (stkCd: string) => {
          const r = await fetch(`${KIWOOM_BASE}/api/dostk/stkinfo`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json;charset=UTF-8",
              "authorization": `Bearer ${token}`,
              "api-id": "ka10001",
            },
            body: JSON.stringify({stk_cd: stkCd}),
          });
          const d: any = await r.json();
          return d && d.cur_prc ? d : null;
        };
        let data = await callKa10001(code + "_AL");
        let source: "KRX+NXT" | "KRX" = "KRX+NXT";
        if (!data) {
          data = await callKa10001(code);
          source = "KRX";
        }
        if (!data) {
          res.status(502).json({error: "kiwoom 응답 없음"});
          return;
        }
        res.json({
          code,
          name: typeof data.stk_nm === "string" ? data.stk_nm : undefined,
          currentPrice: numField(data.cur_prc),
          changeRate: numField(data.flu_rt),
          tradingValue: numField(data.trde_prica),
          marketCap: numField(data.mac),
          source,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status =
          msg.includes("authorization") || msg.includes("token") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

/**
 * jb-s-web → S기법/S2기법 스크리너 결과 조회
 * GET /jbScreenerResults
 * headers: Authorization: Bearer <jb-s-web Firebase ID Token>
 *
 * Response: {
 *   alerts: [{ code, name, currentPrice, lowerBand, ma20, gap, level, types, ... }],
 *   eligibleCounts: { s: number, s2: number },
 *   lastCheckedAt: number | null
 * }
 */
export const jbScreenerResults = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "GET") {
          res.status(405).json({error: "GET only"});
          return;
        }
        await verifyJbAuth(req);

        const db = admin.firestore(); // taesan default app
        const [alertsSnap, lastCheckSnap, sEligibleSnap, s2EligibleSnap] = await Promise.all([
          db.collection("sScreener").doc("alerts").collection("items")
            .orderBy("gap", "asc").limit(200).get(),
          db.collection("sScreener").doc("lastCheck").get(),
          db.collection("sScreener").doc("sEligible").collection("stocks").get(),
          db.collection("sScreener").doc("s2Eligible").collection("stocks").get(),
        ]);

        const alerts = alertsSnap.docs.map((d) => d.data());
        const lastCheck = lastCheckSnap.data();

        res.json({
          alerts,
          eligibleCounts: {
            s: sEligibleSnap.size,
            s2: s2EligibleSnap.size,
          },
          lastCheckedAt: lastCheck?.checkedAt || null,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status =
          msg.includes("authorization") || msg.includes("token") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

/**
 * jb-s-web → S/S2 eligible 종목 전체 리스트
 * GET /jbScreenerEligible?type=S|S2
 * headers: Authorization: Bearer <jb-s-web Firebase ID Token>
 */
export const jbScreenerEligible = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "GET") {
          res.status(405).json({error: "GET only"});
          return;
        }
        await verifyJbAuth(req);

        const type = String(req.query.type || "").toUpperCase();
        if (type !== "S" && type !== "S2") {
          res.status(400).json({error: "type=S or S2 required"});
          return;
        }

        const db = admin.firestore();
        const collName = type === "S" ? "sEligible" : "s2Eligible";
        const [eligibleSnap, statusSnap] = await Promise.all([
          db.collection("sScreener").doc(collName).collection("stocks").get(),
          db.collection("sScreener").doc("checkStatus").collection("items").get(),
        ]);

        const statusMap = new Map<string, any>();
        statusSnap.docs.forEach((d) => statusMap.set(d.id, d.data()));

        const items = eligibleSnap.docs.map((d) => {
          const base = d.data() as any;
          const status = statusMap.get(d.id);
          if (status) {
            base.currentPrice = status.currentPrice;
            base.gap = status.gap;
            base.checkedAt = status.checkedAt;
          }
          return base;
        });

        // S는 시총 큰 순, S2는 거래대금 큰 순으로 정렬
        if (type === "S") {
          items.sort((a: any, b: any) => (b.marketCapEok || 0) - (a.marketCapEok || 0));
        } else {
          items.sort((a: any, b: any) => (b.bigVolTradeValueEok || 0) - (a.bigVolTradeValueEok || 0));
        }

        // S2 lookback 기준일 (오늘 - 150일 = 약 5달 전)
        const S2_LOOKBACK_DAYS = 150;
        const lookbackStartMs = Date.now() - S2_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
        const lookbackStart = new Date(lookbackStartMs).toISOString().slice(0, 10);

        res.json({
          type,
          count: items.length,
          items,
          lookbackDays: type === "S2" ? S2_LOOKBACK_DAYS : null,
          lookbackStart: type === "S2" ? lookbackStart : null,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status =
          msg.includes("authorization") || msg.includes("token") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

/**
 * S 스크리너 텔레그램 설정 검증 + 즉시 테스트 발송
 * GET /jbTelegramTest
 * 응답:
 *   stage: success | firestore_doc_missing | field_missing | telegram_api_failed | exception
 *   fields: settings/telegram_s 도큐먼트의 실제 필드 이름 (값은 노출 안함)
 *   telegramOk / telegramErrorCode / telegramErrorDescription: Telegram API의 응답
 */
export const jbTelegramTest = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        const doc = await admin.firestore()
          .collection("settings").doc("telegram_s").get();
        const cfg = doc.data();

        if (!cfg) {
          res.status(400).json({
            stage: "firestore_doc_missing",
            hasDoc: false,
            hint: "settings/telegram_s 도큐먼트 없음. 정확히 'telegram_s'로 만드세요.",
          });
          return;
        }

        const fields = Object.keys(cfg);
        const hasBotToken = typeof cfg.botToken === "string" &&
          cfg.botToken.length > 10;
        const hasChatId = cfg.chatId !== undefined && cfg.chatId !== null;
        const chatIdType = typeof cfg.chatId;
        const botTokenPreview = hasBotToken ?
          `${cfg.botToken.slice(0, 6)}...${cfg.botToken.slice(-4)}` :
          null;

        if (!hasBotToken || !hasChatId) {
          res.status(400).json({
            stage: "field_missing",
            hasDoc: true,
            fields,
            hasBotToken,
            hasChatId,
            chatIdType,
            hint: "필드명이 정확히 botToken, chatId 인지 (대소문자) 확인하세요.",
          });
          return;
        }

        const text = [
          "✅ <b>S 스크리너 텔레그램 테스트</b>",
          `시각: ${new Date().toLocaleString("ko-KR",
            {timeZone: "Asia/Seoul"})}`,
          "이 메시지가 보이면 설정이 정상 동작 중입니다.",
        ].join("\n");

        const tgRes = await fetch(
          "https://api.telegram.org/bot" + cfg.botToken + "/sendMessage", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
              chat_id: cfg.chatId,
              text,
              parse_mode: "HTML",
            }),
          });
        const data: any = await tgRes.json();

        res.json({
          stage: data.ok ? "success" : "telegram_api_failed",
          hasDoc: true,
          fields,
          botTokenPreview,
          chatIdType,
          chatIdPreview: String(cfg.chatId).slice(0, 4) + "...",
          telegramOk: data.ok === true,
          telegramErrorCode: data.error_code,
          telegramErrorDescription: data.description,
        });
      } catch (e: any) {
        res.status(500).json({
          stage: "exception",
          error: e?.message || String(e),
        });
      }
    });
  });

/**
 * jb-s-web → 텔레그램 발송 프록시
 * POST /jbSendTelegram
 * headers: Authorization: Bearer <jb-s-web Firebase ID Token>
 * body: { text: string (1~4000 chars) }
 *
 * 봇 토큰은 서버 settings/telegram_s에만 있고, 클라이언트는 text만 전달.
 */
export const jbSendTelegram = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 15})
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST only"});
          return;
        }
        await verifyJbAuth(req);

        const text = String(req.body?.text || "");
        if (!text || text.length > 4000) {
          res.status(400).json({error: "text required (1~4000 chars)"});
          return;
        }

        const doc = await admin.firestore()
          .collection("settings").doc("telegram_s").get();
        const cfg = doc.data();
        if (!cfg?.botToken || !cfg?.chatId) {
          res.status(500).json({
            error: "settings/telegram_s 미설정",
          });
          return;
        }

        const tgRes = await fetch(
          "https://api.telegram.org/bot" + cfg.botToken + "/sendMessage", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
              chat_id: cfg.chatId,
              text,
              parse_mode: "HTML",
              disable_web_page_preview: true,
            }),
          });
        const data: any = await tgRes.json();

        res.json({
          ok: data.ok === true,
          errorCode: data.error_code,
          description: data.description,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status =
          msg.includes("authorization") || msg.includes("token") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

function mask(v: string): string {
  if (!v || v.length < 8) return "***";
  return v.slice(0, 6) + "..." + v.slice(-4);
}

/**
 * jb-s-web → 키움 키 등록 상태 + 마스킹된 미리보기
 * GET /jbKiwoomKeysStatus
 * 응답: { source: "firestore"|"secret"|"none", appKeyPreview, appSecretPreview, updatedAt }
 */
export const jbKiwoomKeysStatus = functions
  .region("asia-northeast3")
  .runWith({
    timeoutSeconds: 15,
    secrets: ["KIWOOM_JB_APP_KEY", "KIWOOM_JB_APP_SECRET"],
  })
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "GET") {
          res.status(405).json({error: "GET only"});
          return;
        }
        await verifyJbAuth(req);

        let source: "firestore" | "secret" | "none" = "none";
        let appKey: string | undefined;
        let appSecret: string | undefined;
        let updatedAt: number | undefined;

        const doc = await admin.firestore()
          .collection("settings").doc("kiwoom_jb").get();
        const cfg = doc.data();
        if (cfg?.appKey && cfg?.appSecret) {
          source = "firestore";
          appKey = cfg.appKey;
          appSecret = cfg.appSecret;
          updatedAt = cfg.updatedAt;
        } else {
          appKey = process.env.KIWOOM_JB_APP_KEY;
          appSecret = process.env.KIWOOM_JB_APP_SECRET;
          if (appKey && appSecret) source = "secret";
        }

        res.json({
          source,
          appKeyPreview: appKey ? mask(appKey) : null,
          appSecretPreview: appSecret ? mask(appSecret) : null,
          updatedAt: updatedAt || null,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status = msg.includes("authorization") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

/**
 * jb-s-web → 키움 키 저장 (Firestore settings/kiwoom_jb)
 * POST /jbKiwoomKeysSet
 * body: { appKey: string, appSecret: string }
 * 저장 후 토큰 캐시 무효화 → 다음 호출부터 새 키로 토큰 발급
 */
export const jbKiwoomKeysSet = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 15})
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST only"});
          return;
        }
        await verifyJbAuth(req);

        const appKey = String(req.body?.appKey || "").trim();
        const appSecret = String(req.body?.appSecret || "").trim();
        if (appKey.length < 10 || appSecret.length < 10) {
          res.status(400).json({error: "appKey/appSecret 너무 짧음 (>=10자)"});
          return;
        }

        // 키움 OAuth로 즉시 검증 (잘못된 키는 저장 안 함)
        const verifyRes = await fetch(`${KIWOOM_BASE}/oauth2/token`, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            grant_type: "client_credentials",
            appkey: appKey,
            secretkey: appSecret,
          }),
        });
        const verifyData: any = await verifyRes.json();
        if (!verifyData.token) {
          res.status(400).json({
            error: "키움 인증 실패 — 키 값을 확인하세요",
            kiwoomResponse: verifyData,
          });
          return;
        }

        await admin.firestore()
          .collection("settings").doc("kiwoom_jb")
          .set({
            appKey,
            appSecret,
            updatedAt: Date.now(),
          });

        // 새 토큰을 캐시에 미리 넣어두기 (다음 호출부터 즉시 사용)
        jbTokenCache = {
          token: verifyData.token,
          exp: verifyData.expires_dt ?
            new Date(verifyData.expires_dt).getTime() :
            Date.now() + 23 * 60 * 60 * 1000,
        };

        res.json({
          ok: true,
          appKeyPreview: mask(appKey),
          appSecretPreview: mask(appSecret),
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status = msg.includes("authorization") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

/* ============================================================================
 * 스크리너 텔레그램 필터 — S / S2 별 ON/OFF
 *
 * Firestore: settings/telegram_s 도큐먼트 안에 enableS, enableS2 필드 (기본 둘 다 true).
 * sScreenerCheck 발송 직전에 시그널 type별로 체크해서 필터링.
 * ========================================================================= */

interface ScreenerFilters {
  enableS: boolean;
  enableS2: boolean;
}

async function loadScreenerFilters(): Promise<ScreenerFilters> {
  try {
    const doc = await admin.firestore()
      .collection("settings").doc("telegram_s").get();
    const cfg = doc.data();
    return {
      enableS: cfg?.enableS !== false,   // undefined/true → true
      enableS2: cfg?.enableS2 !== false, // undefined/true → true
    };
  } catch {
    return {enableS: true, enableS2: true};
  }
}

export const jbScreenerFilters = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 10})
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "GET") {
          res.status(405).json({error: "GET only"});
          return;
        }
        await verifyJbAuth(req);
        const filters = await loadScreenerFilters();
        res.json(filters);
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status = msg.includes("authorization") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

export const jbScreenerFiltersSet = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 10})
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST only"});
          return;
        }
        await verifyJbAuth(req);
        const enableS = req.body?.enableS !== false;
        const enableS2 = req.body?.enableS2 !== false;
        await admin.firestore().collection("settings").doc("telegram_s")
          .set({enableS, enableS2}, {merge: true}); // 다른 필드(botToken/chatId) 보존
        res.json({enableS, enableS2});
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status = msg.includes("authorization") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

// 시그널 types와 필터로 발송 여부 판단 (다른 모듈에서도 사용 가능)
export function shouldSendByFilter(
  types: string[],
  filters: ScreenerFilters,
): boolean {
  const isS = types.includes("S");
  const isS2 = types.includes("S2");
  // S만 있으면 enableS, S2만 있으면 enableS2, 둘 다면 둘 중 하나라도 on이면 발송
  if (isS && isS2) return filters.enableS || filters.enableS2;
  if (isS) return filters.enableS;
  if (isS2) return filters.enableS2;
  return true; // 알 수 없는 type은 통과
}

/* ============================================================================
 * jbOrder — 키움 매수/매도 발주
 *
 * ★ 격리 가드:
 *  - jb-s-web Auth 토큰 강제 (verifyJbAuth)
 *  - 계좌번호 화이트리스트 (JB_ALLOWED_ACCOUNTS)
 *  - jb 키움 키 (loadJbKiwoomCreds)만 사용
 *  - 모든 호출을 jbOrderAudit 컬렉션에 기록 (감사 추적)
 *
 * 이 함수는 절대 태산 계좌·태산 키·태산 Firestore 매매 컬렉션을 만지지 않음.
 * ========================================================================= */

const JB_ALLOWED_ACCOUNTS = ["64981611"]; // 하이픈 제거된 형태

function normalizeAccount(s: string): string {
  return String(s || "").replace(/[^0-9]/g, "");
}

export const jbOrder = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 30,
    secrets: ["KIWOOM_JB_APP_KEY", "KIWOOM_JB_APP_SECRET"],
  })
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      const auditBase: Record<string, unknown> = {
        method: req.method,
        ip: req.headers["x-forwarded-for"] || null,
        ua: req.headers["user-agent"] || null,
        createdAt: Date.now(),
      };
      try {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST only"});
          return;
        }
        const uid = await verifyJbAuth(req);
        auditBase.uid = uid;

        const body = req.body || {};
        const accountNoRaw = String(body.accountNo || "");
        const accountNo = normalizeAccount(accountNoRaw);
        const stockCode = String(body.stockCode || "");
        const side = body.side === "BUY" ? "BUY" : body.side === "SELL" ? "SELL" : "";
        const quantity = Number(body.quantity);
        const price = Number(body.price ?? 0);
        const mock = body.mock === true;

        auditBase.accountNoRaw = accountNoRaw;
        auditBase.accountNo = accountNo;
        auditBase.stockCode = stockCode;
        auditBase.side = side;
        auditBase.quantity = quantity;
        auditBase.price = price;
        auditBase.mock = mock;

        // [GUARD 1] 계좌 화이트리스트
        if (!JB_ALLOWED_ACCOUNTS.includes(accountNo)) {
          auditBase.rejected = "account_not_allowed";
          await admin.firestore().collection("jbOrderAudit").add(auditBase);
          res.status(403).json({
            error: `허용되지 않은 계좌: ${accountNoRaw}. ` +
              "jb-bridge는 jb 전용 계좌만 처리합니다.",
          });
          return;
        }

        // [GUARD 2] 유효성 검사
        if (!/^\d{6}$/.test(stockCode)) {
          auditBase.rejected = "invalid_stock_code";
          await admin.firestore().collection("jbOrderAudit").add(auditBase);
          res.status(400).json({error: "stockCode 6자리 숫자"});
          return;
        }
        if (!side) {
          auditBase.rejected = "invalid_side";
          await admin.firestore().collection("jbOrderAudit").add(auditBase);
          res.status(400).json({error: "side는 BUY 또는 SELL"});
          return;
        }
        if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1_000_000) {
          auditBase.rejected = "invalid_quantity";
          await admin.firestore().collection("jbOrderAudit").add(auditBase);
          res.status(400).json({error: "quantity는 1~1,000,000 정수"});
          return;
        }
        if (!Number.isFinite(price) || price < 0 || price > 100_000_000) {
          auditBase.rejected = "invalid_price";
          await admin.firestore().collection("jbOrderAudit").add(auditBase);
          res.status(400).json({error: "price는 0 이상"});
          return;
        }

        // [GUARD 3] 모의 모드 — 키움 호출 안 함
        if (mock) {
          auditBase.outcome = "mock";
          const fakeOrderId = `MOCK-${Date.now()}`;
          auditBase.orderId = fakeOrderId;
          await admin.firestore().collection("jbOrderAudit").add(auditBase);
          res.json({
            mode: "mock",
            ok: true,
            orderId: fakeOrderId,
            accountNo: accountNoRaw,
            stockCode,
            side,
            quantity,
            price,
            note: "모의 모드 — 실제 키움 호출 없음. 실주문은 mock=false로",
          });
          return;
        }

        // [GUARD 4] 실주문 — jb 키만 사용
        const token = await getJbKiwoomToken();
        const apiId = side === "BUY" ? "kt10000" : "kt10001";
        const tradeType = price === 0 ? "03" : "00"; // 03 시장가, 00 지정가
        const ordPrice = tradeType === "03" ? "" : String(price);

        const r = await fetch(`${KIWOOM_BASE}/api/dostk/ordr`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            "authorization": `Bearer ${token}`,
            "api-id": apiId,
          },
          body: JSON.stringify({
            dmst_stex_tp: "KRX",
            stk_cd: stockCode,
            ord_qty: String(quantity),
            ord_uv: ordPrice,
            trde_tp: tradeType,
            cond_uv: "",
          }),
        });
        const data: any = await r.json();

        const ok = data.return_code === 0 || data.return_code === "0";
        auditBase.outcome = ok ? "live_ok" : "live_failed";
        auditBase.orderId = data.ord_no || null;
        auditBase.kiwoomResponse = data;
        await admin.firestore().collection("jbOrderAudit").add(auditBase);

        res.json({
          mode: "live",
          ok,
          orderId: data.ord_no || null,
          returnCode: data.return_code,
          returnMsg: data.return_msg,
          kiwoomResponse: data,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        auditBase.outcome = "exception";
        auditBase.error = msg;
        try {
          await admin.firestore().collection("jbOrderAudit").add(auditBase);
        } catch {
          /* ignore audit failure */
        }
        const status = msg.includes("authorization") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

/**
 * jb-s-web → JB 계좌 보유종목 동기화 (Phase B-1)
 * POST /jbHoldingsSync
 * headers: Authorization: Bearer <jb-s-web Firebase ID Token>
 * body: {} (계좌는 키움 API 키에 바인딩되어 있음 = 64981611)
 *
 * Response: {
 *   accountNo: "64981611",
 *   asOf: <ms>,
 *   holdings: [{ code, name, quantity, avgPrice, currentPrice,
 *                profitRate, profitAmount, totalBuyAmount, isCreditTrade,
 *                positions: [{type, quantity, avgPrice}] }]
 * }
 *
 * 격리:
 *   1. jb-s-web ID Token 검증
 *   2. JB 전용 키 (settings/kiwoom_jb) 사용 → 64981611 계좌만 접근 가능
 *   3. taesan Firestore에 쓰지 않음 — 응답만 반환
 */
export const jbHoldingsSync = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 30,
    secrets: ["KIWOOM_JB_APP_KEY", "KIWOOM_JB_APP_SECRET"],
  })
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST only"});
          return;
        }
        const uid = await verifyJbAuth(req);
        const token = await getJbKiwoomToken();

        const r = await fetch(`${KIWOOM_BASE}/api/dostk/acnt`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "authorization": `Bearer ${token}`,
            "api-id": "kt00005",
          },
          body: JSON.stringify({dmst_stex_tp: "KRX"}),
        });
        const data: any = await r.json();

        if (data.return_code && data.return_code !== "0" && data.return_code !== 0) {
          res.status(502).json({
            error: `잔고조회 실패: ${data.return_msg || "unknown"}`,
            kiwoomResponse: data,
          });
          return;
        }

        const stockList: any[] = data.stk_cntr_remn || [];
        const num = (v: unknown): number => {
          if (typeof v === "number") return v;
          if (typeof v !== "string") return 0;
          const n = Number(v.replace(/[+,\s]/g, ""));
          return Number.isFinite(n) ? Math.abs(n) : 0;
        };
        const clean = (v: unknown): string => String(v || "").replace(/^\*+/, "").trim();
        // 키움 종목코드는 종종 'A042700'처럼 앞에 알파벳 1자 prefix → 숫자 6자리만 추출
        const cleanCode = (v: unknown): string => {
          const s = clean(v).replace(/^[A-Za-z]+/, "");
          return /^\d{6}$/.test(s) ? s : "";
        };

        const holdings = stockList
          .filter((it) => num(it.cur_qty) > 0 && cleanCode(it.stk_cd))
          .map((it) => {
            const rawName = String(it.stk_nm || "").trim();
            const rawCode = String(it.stk_cd || "").trim();
            return {
              code: cleanCode(it.stk_cd),
              name: clean(it.stk_nm),
              quantity: num(it.cur_qty),
              avgPrice: num(it.buy_uv),
              currentPrice: num(it.cur_prc),
              profitRate: parseFloat(String(it.pl_rt || "0").replace(/[+,\s]/g, "")) || 0,
              profitAmount: num(it.evltv_prft),
              totalBuyAmount: num(it.pur_amt),
              isCreditTrade: rawName.startsWith("*") || rawCode.startsWith("*"),
            };
          });

        // 같은 종목(코드) 통합: 현물+신용 합산
        const consolidatedMap = new Map<string, any>();
        for (const h of holdings) {
          const key = h.code || h.name;
          const ex = consolidatedMap.get(key);
          if (!ex) {
            consolidatedMap.set(key, {
              ...h,
              positions: [{type: h.isCreditTrade ? "credit" : "cash", quantity: h.quantity, avgPrice: h.avgPrice}],
            });
          } else {
            const newQty = ex.quantity + h.quantity;
            ex.avgPrice = newQty > 0 ? Math.round((ex.avgPrice * ex.quantity + h.avgPrice * h.quantity) / newQty) : 0;
            ex.quantity = newQty;
            ex.totalBuyAmount = (ex.totalBuyAmount || 0) + (h.totalBuyAmount || 0);
            ex.profitAmount = (ex.profitAmount || 0) + (h.profitAmount || 0);
            ex.positions.push({type: h.isCreditTrade ? "credit" : "cash", quantity: h.quantity, avgPrice: h.avgPrice});
            if (ex.totalBuyAmount > 0) {
              ex.profitRate = parseFloat(((ex.profitAmount / ex.totalBuyAmount) * 100).toFixed(2));
            }
            ex.isCreditTrade = ex.isCreditTrade || h.isCreditTrade;
          }
        }
        const consolidated = Array.from(consolidatedMap.values());

        res.json({
          accountNo: "64981611",
          asOf: Date.now(),
          uid,
          holdings: consolidated,
          rawCount: stockList.length,
          consolidatedCount: consolidated.length,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status = msg.includes("authorization") || msg.includes("token") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

/**
 * jb-s-web → JB 계좌 체결 내역 동기화 (Phase B-2)
 * POST /jbTradesSync
 * body: { dates: ["20260519", "20260518", ...] }  // 조회할 일자 리스트 (최대 30일)
 *
 * Response: {
 *   accountNo: "64981611",
 *   asOf: <ms>,
 *   trades: [{
 *     orderId: string,
 *     date: "YYYYMMDD",
 *     time: "HHMMSS",
 *     code: string,
 *     name: string,
 *     side: "BUY" | "SELL",
 *     price: number,
 *     quantity: number,
 *     amount: number,
 *     isCreditTrade: boolean,
 *   }],
 *   countByDate: { "20260519": 3, ... }
 * }
 */
export const jbTradesSync = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 60,
    secrets: ["KIWOOM_JB_APP_KEY", "KIWOOM_JB_APP_SECRET"],
  })
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST only"});
          return;
        }
        const uid = await verifyJbAuth(req);

        const dates: string[] = Array.isArray(req.body?.dates) ? req.body.dates : [];
        if (dates.length === 0) {
          // 기본: 오늘 (KST)
          const kst = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
          const y = kst.getFullYear();
          const m = String(kst.getMonth() + 1).padStart(2, "0");
          const d = String(kst.getDate()).padStart(2, "0");
          dates.push(`${y}${m}${d}`);
        }
        if (dates.length > 30) {
          res.status(400).json({error: "max 30 days"});
          return;
        }
        for (const d of dates) {
          if (!/^\d{8}$/.test(d)) {
            res.status(400).json({error: `invalid date: ${d}`});
            return;
          }
        }

        const token = await getJbKiwoomToken();
        const num = (v: unknown): number => {
          if (typeof v === "number") return v;
          if (typeof v !== "string") return 0;
          const n = Number(v.replace(/[+,\s]/g, ""));
          return Number.isFinite(n) ? Math.abs(n) : 0;
        };
        const clean = (v: unknown): string => String(v || "").replace(/^\*+/, "").trim();

        const allTrades: any[] = [];
        const countByDate: Record<string, number> = {};

        for (const dt of dates) {
          try {
            const r = await fetch(`${KIWOOM_BASE}/api/dostk/acnt`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "authorization": `Bearer ${token}`,
                "api-id": "kt00007",
              },
              body: JSON.stringify({
                ord_dt: dt,
                qry_tp: "1",      // 전체 (체결+미체결)
                stk_bond_tp: "0",
                sell_tp: "0",
                stk_cd: "",
                fr_ord_no: "",
                dmst_stex_tp: "%",
              }),
            });
            const data: any = await r.json();
            if (data.return_code && data.return_code !== 0 && data.return_code !== "0") {
              countByDate[dt] = 0;
              continue;
            }
            // 응답에서 배열 찾기
            let items: any[] = [];
            for (const k of Object.keys(data)) {
              if (Array.isArray(data[k]) && data[k].length > 0) {
                items = data[k];
                break;
              }
            }
            let dateCount = 0;
            for (const it of items) {
              const qty = num(it.cntr_qty);
              if (qty <= 0) continue;
              const ioTp = String(it.io_tp_nm || "").trim();
              const crdTp = String(it.crd_tp || "").trim();
              let side: "BUY" | "SELL" | null = null;
              if (ioTp.includes("매수")) side = "BUY";
              else if (ioTp.includes("매도")) side = "SELL";
              if (!side) continue;

              const isCredit = ioTp.includes("융자") || ioTp.includes("신용") ||
                crdTp.includes("융자") || crdTp.includes("신용");

              const code = clean(it.stk_cd).replace(/^[A-Za-z]/, "");
              const name = clean(it.stk_nm);
              if (!code || !/^\d{6}$/.test(code)) continue;

              const price = num(it.cntr_uv);
              const ordNo = String(it.ord_no || "").trim();
              const cntrNo = String(it.cntr_no || "").trim();
              const orderId = ordNo || cntrNo || `kt07_${dt}_${code}_${price}_${qty}_${side}`;

              allTrades.push({
                orderId,
                date: dt,
                time: String(it.ord_tm || it.cnfm_tm || ""),
                code,
                name,
                side,
                price,
                quantity: qty,
                amount: price * qty,
                isCreditTrade: isCredit,
              });
              dateCount++;
            }
            countByDate[dt] = dateCount;
            await new Promise((r) => setTimeout(r, 150));
          } catch {
            countByDate[dt] = 0;
          }
        }

        // 중복 제거 (orderId 기준)
        const dedupMap = new Map<string, any>();
        for (const t of allTrades) {
          if (!dedupMap.has(t.orderId)) dedupMap.set(t.orderId, t);
        }
        const trades = Array.from(dedupMap.values());

        res.json({
          accountNo: "64981611",
          asOf: Date.now(),
          uid,
          trades,
          countByDate,
          totalCount: trades.length,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status = msg.includes("authorization") || msg.includes("token") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

/**
 * jb-s-web → 오늘 알림 이력 조회 (또는 특정 날짜)
 * GET /jbScreenerHistory?date=YYYYMMDD (기본: 오늘 KST)
 * headers: Authorization: Bearer <jb-s-web Firebase ID Token>
 *
 * Response: {
 *   date: "YYYYMMDD",
 *   count: number,
 *   items: [{
 *     date, code, name, types, firstAlertAt, lastAlertAt,
 *     currentPrice, lowerBand, minGap, worstLevel, alertCount,
 *     marketCapEok?, bigVolDay?, bigVolTradeValueEok?
 *   }]
 * }
 */
export const jbScreenerHistory = functions
  .region("asia-northeast3")
  .runWith({timeoutSeconds: 30})
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "GET") {
          res.status(405).json({error: "GET only"});
          return;
        }
        await verifyJbAuth(req);

        let dateKey = String(req.query.date || "").replace(/[^0-9]/g, "");
        if (!dateKey || dateKey.length !== 8) {
          const kstNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Seoul"}));
          const yyyy = kstNow.getFullYear();
          const mm = String(kstNow.getMonth() + 1).padStart(2, "0");
          const dd = String(kstNow.getDate()).padStart(2, "0");
          dateKey = `${yyyy}${mm}${dd}`;
        }

        const db = admin.firestore();
        const snap = await db.collection("sScreener").doc("alertHistory").collection("items")
          .where("date", "==", dateKey)
          .get();

        const items = snap.docs.map((d) => d.data());
        // 최저 gap 오름차순 (가장 위험했던 종목 위에)
        items.sort((a: any, b: any) => (a.minGap ?? 999) - (b.minGap ?? 999));

        res.json({
          date: dateKey,
          count: items.length,
          items,
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status = msg.includes("authorization") || msg.includes("token") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

// ─── 이동평균선 계산 헬퍼 (ka10081 일봉) ───
// jbQuote와 동일하게 jb 키움 키 사용
async function calcMa20ForCode(token: string, code: string): Promise<number | null> {
  try {
    const closes: number[] = [];
    let contYn = "N";
    let nextKey = "";
    const MAX_PAGES = 2; // 20봉이면 1~2 페이지면 충분

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

      const r = await fetch(`${KIWOOM_BASE}/api/dostk/chart`, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({
          stk_cd: code,
          base_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
          upd_stkpc_tp: "1",
          qry_tp: "0",
        }),
      });
      const respContYn = r.headers.get("cont-yn") || r.headers.get("Cont-Yn") || "";
      const respNextKey = r.headers.get("next-key") || r.headers.get("Next-Key") || "";
      const data: any = await r.json();
      const chart: any[] = data.stk_dt_pole_chart_qry || data.stk_dt_pole_chart || [];
      for (const c of chart) {
        const close = parseInt(c.cur_prc || c.cls_prc || c.close || "0");
        if (close > 0) closes.push(close);
      }
      if (closes.length >= 20 || respContYn !== "Y" || !respNextKey) break;
      contYn = "Y";
      nextKey = respNextKey;
      await new Promise((rs) => setTimeout(rs, 200));
    }

    if (closes.length < 20) return null;
    const sum = closes.slice(0, 20).reduce((a, b) => a + b, 0);
    return Math.round(sum / 20);
  } catch (err) {
    console.log(`[ma20] ${code} 실패:`, err);
    return null;
  }
}

/**
 * jb-s-web → 보유 종목들의 20일 이동평균선(ma20) 일괄 계산
 * POST /jbMa20Bulk
 * body: { codes: ["005930", "108490", ...] }
 * Response: { results: [{ code, ma20 }] }
 *
 * 키움 일봉 API 추가 호출이 있으니 클라이언트는 하루 1번 + 사용자 트리거 정도로 제한 사용
 */
export const jbMa20Bulk = functions
  .region("asia-northeast3")
  .runWith({
    vpcConnector: "kiwoom-connector",
    vpcConnectorEgressSettings: "ALL_TRAFFIC",
    timeoutSeconds: 120,
    secrets: ["KIWOOM_JB_APP_KEY", "KIWOOM_JB_APP_SECRET"],
  })
  .https.onRequest((req, res) => {
    jbCors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST only"});
          return;
        }
        await verifyJbAuth(req);
        const codes: string[] = Array.isArray(req.body?.codes) ? req.body.codes : [];
        const valid = codes.filter((c) => /^\d{6}$/.test(c));
        if (valid.length === 0) {
          res.json({results: []});
          return;
        }
        const token = await getJbKiwoomToken();
        const results: Array<{code: string; ma20: number | null}> = [];
        for (const code of valid) {
          const ma20 = await calcMa20ForCode(token, code);
          results.push({code, ma20});
          // 키움 한도 보호 — 종목간 200ms 간격
          await new Promise((rs) => setTimeout(rs, 200));
        }
        res.json({results, asOf: Date.now()});
      } catch (e: any) {
        const msg = e?.message || String(e);
        const status = msg.includes("authorization") || msg.includes("token") ? 401 : 500;
        res.status(status).json({error: msg});
      }
    });
  });

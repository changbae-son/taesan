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
async function getJbKiwoomToken(): Promise<string> {
  if (jbTokenCache && jbTokenCache.exp > Date.now() + 60_000) {
    return jbTokenCache.token;
  }
  const appKey = process.env.KIWOOM_JB_APP_KEY;
  const appSecret = process.env.KIWOOM_JB_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error("KIWOOM_JB_APP_KEY/SECRET secret 미설정");
  }

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
        const r = await fetch(`${KIWOOM_BASE}/api/dostk/stkinfo`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            "authorization": `Bearer ${token}`,
            "api-id": "ka10001",
          },
          body: JSON.stringify({stk_cd: code}),
        });
        const data: any = await r.json();
        res.json({
          code,
          name: typeof data.stk_nm === "string" ? data.stk_nm : undefined,
          currentPrice: numField(data.cur_prc),
          changeRate: numField(data.flu_rt),
          tradingValue: numField(data.trde_prica),
          marketCap: numField(data.mac),
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

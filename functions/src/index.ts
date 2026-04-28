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
          const code72 = (item.stk_cd || "").trim();
          const price72 = parseInt(item.cntr_pric || "0");
          // ✅ F1 수정: ord_no 우선, 없으면 price+qty 복합키로 uniqueness 보장
          // (같은 날짜 같은 종목에 여러 체결이 있어도 collision 없음)
          const ordNo72 = String(item.ord_no || item.cntr_no || "").trim();
          const orderNo72 = ordNo72 || `sell_${dt}_${code72}_${price72}_${qty}`;
          // 🔍 진단 로그: ka10072 실제 응답 내용 확인
          console.log(
            `[ka10072-item] ${dt} ${code72}: qty=${qty} price=${price72} ` +
            `ord_no=${ordNo72 || "(없음)"} cntr_no=${String(item.cntr_no||"").trim()||"(없음)"} ` +
            `fields=${Object.keys(item).slice(0,10).join(",")}`
          );
          allTrades.push({
            name: (item.stk_nm || "").trim(),
            code: code72,
            type: "sell",
            price: price72,
            quantity: qty,
            date: dt,
            time: item.cntr_tm || "",
            orderNo: orderNo72,
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
              const name = (item.stk_nm || "").trim();
              const qty = parseInt(item.cntr_qty || item.qty || "0");
              if (qty <= 0) continue;
              const price = parseInt(item.cntr_uv || item.cntr_pric || item.ord_uv || "0");
              const code76 = (item.stk_cd || "").trim();
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
                const code7 = (item.stk_cd || "").trim();
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

        const rawCode = (item.stk_cd || "").trim();
        const code15 = rawCode.replace(/^[A-Za-z]/, "");
        const name15 = (item.stk_nm || "").trim();
        if (!name15 || !code15) continue;

        const trdeAmt = parseInt(item.trde_amt || "0");
        const price15 = qty > 0 && trdeAmt > 0 ? Math.round(trdeAmt / qty) : 0;
        const ordNo15 = (item.trde_no || "").trim();
        const type15 = isBuy ? "buy" : "sell";

        console.log(
          `[kt00015 p${pageNum}] ${rawDate} ${name15}(${code15}) ${type15} ` +
          `${qty}주 @${price15} trde_no=${ordNo15 || "(없음)"}`
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
        // 실 ord_no 로 교체
        console.log(
          `[dedup] 교체: ${t.code} ${t.date} ${t.type} ${t.price}@${t.quantity} ` +
          `fallback(${existing.orderNo}) → real(${t.orderNo})`
        );
        dedupMap.set(key, t);
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

  // 매도 차수 매핑: 개별 체결 건을 순차적으로 슬롯에 매핑
  // (날짜+시간 정렬은 위의 stockTrades.sort()에서 이미 처리됨)
  // 같은 날짜 여러 건도 각각 별도 슬롯으로 배정 (분할 매도 정확 반영)
  const sellCount = sells.length;

  // 수익 매도 계획 (5단계)
  const percents = [5, 10, 15, 20, 25];
  const sellPlans = percents.map((p, i) => {
    const sellTrade = sells[i]; // i번째 체결 → i번 슬롯 1:1 매핑

    if (sellTrade) {
      const dt = sellTrade.date || "";
      const formattedDate = dt.length === 8
        ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`
        : dt;
      return {
        percent: p,
        price: sellTrade.price,
        quantity: sellTrade.quantity,
        filled: true,
        filledDate: formattedDate,
        filledQuantity: sellTrade.quantity,
        filledPrice: sellTrade.price,
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
  trades: any[],
  config?: KiwoomConfig,
  token?: string
): Promise<{syncedStocks: number; syncedTrades: number; soldOutStocks: string[]}> {
  const now = Date.now();
  let syncedStocks = 0;
  let syncedTrades = 0;

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
    // 체결내역으로 매수/매도 차수 매핑
    const mapped = mapTradesToPlans(trades, h.name, h);

    // 종목코드 우선 매칭, 없으면 이름 매칭
    const existingDocId = (h.code && existingByCode[h.code]) || existingStocks[h.name];

    if (existingDocId) {
      // 기존 종목 업데이트
      const existingDoc = await db.collection("stocks").doc(existingDocId).get();
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

      await db.collection("stocks").doc(docId).set({
        name: h.name,
        code: h.code || "",
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

    if (!doc.exists) {
      const formattedDate = t.date
        ? `${t.date.slice(0, 4)}-${t.date.slice(4, 6)}-${t.date.slice(6, 8)}`
        : new Date().toISOString().slice(0, 10);

      await docRef.set({
        date: formattedDate,
        stockName: t.name,
        code: t.code || "",         // [B안] 쿼리 가능하도록 추가
        orderNo: orderKey,          // [B안] 쿼리 가능하도록 추가
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

    // 근접 알림: 당일 미발송 & 현재가 기준 ±3% 이내
    if (s.maAlertDate !== today && curPrice > 0) {
      const alerts: string[] = [];
      const check = (maVal: number, label: string) => {
        if (maVal <= 0) return;
        const gap = ((curPrice - maVal) / maVal) * 100;
        // 위에서 접근 (현재가가 MA보다 0~4% 위): 저항 가능성
        if (gap >= 0 && gap <= 4) {
          alerts.push(`📊 ${label}선 도달 (현재 +${gap.toFixed(1)}% → 저항 확인 필요)`);
        }
        // 아래에서 접근 (현재가가 MA보다 0~3% 아래): 이탈 가능성
        if (gap < 0 && gap >= -3) {
          alerts.push(`⚠️ ${label}선 하향 이탈 근접 (현재 ${gap.toFixed(1)}% → 손실 매도 검토)`);
        }
      };
      check(ma.ma20, "MA20");
      check(ma.ma60, "MA60");
      check(ma.ma120, "MA120");

      if (alerts.length > 0) {
        updates.maAlertDate = today;
        let msg = `<b>📈 이동평균선 근접 — ${s.name}</b>\n`;
        msg += `현재가: <b>${curPrice.toLocaleString()}원</b>\n`;
        msg += `MA20: ${ma.ma20 > 0 ? ma.ma20.toLocaleString() + "원" : "계산불가"}\n`;
        msg += `MA60: ${ma.ma60 > 0 ? ma.ma60.toLocaleString() + "원" : "계산불가"}\n`;
        msg += `MA120: ${ma.ma120 > 0 ? ma.ma120.toLocaleString() + "원" : "계산불가"}\n\n`;
        for (const a of alerts) msg += `${a}\n`;
        msg += `\n🔍 HTS 차트에서 저항/지지 여부를 직접 확인하세요.`;
        await sendTelegram(msg);
        console.log(`[MA알림] ${s.name} 텔레그램 발송: ${alerts.join(" | ")}`);
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

    // ─── 2. MA선 근접 알림 (당일 1회, 저장된 MA값 사용) ───
    if (s.maAlertDate !== today) {
      const maChecks = [
        {label: "MA20", val: (s.ma20 || 0) as number},
        {label: "MA60", val: (s.ma60 || 0) as number},
        {label: "MA120", val: (s.ma120 || 0) as number},
      ];

      const maAlerts: string[] = [];
      for (const m of maChecks) {
        if (m.val <= 0) continue;
        const gap = ((curPrice - m.val) / m.val) * 100;
        if (gap >= 0 && gap <= 4) {
          maAlerts.push(`📊 ${m.label}선 도달 (+${gap.toFixed(1)}% → 저항 확인 필요)`);
        } else if (gap < 0 && gap >= -3) {
          maAlerts.push(`⚠️ ${m.label}선 하향 이탈 근접 (${gap.toFixed(1)}% → 손실 매도 검토)`);
        }
      }

      if (maAlerts.length > 0) {
        updates.maAlertDate = today;

        let msg = `<b>📈 이동평균선 근접 — ${s.name}</b>\n`;
        msg += `현재가: <b>${curPrice.toLocaleString()}원</b>`;
        if (profitPct !== 0) {
          msg += ` (${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(1)}%)`;
        }
        msg += `\n\n`;
        for (const a of maAlerts) msg += `${a}\n`;
        msg += `\n🔍 HTS 차트에서 직접 확인 후 판단하세요.`;

        await sendTelegram(msg);
        console.log(`[MA알림] ${s.name}: ${maAlerts.join(" | ")}`);
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

    // 평일 장중(09:00~15:30)만 실행
    if (day === 0 || day === 6 || timeNum < 900 || timeNum > 1530) {
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
          const updateData: any = {
            currentPrice: h.currentPrice,
            avgPrice: h.avgPrice,
            totalQuantity: h.quantity,
            updatedAt: Date.now(),
          };
          // code 필드 마이그레이션
          if (h.code && !codeToId[h.code]) {
            updateData.code = h.code;
          }
          // ─── Rule B 저점 자동 추적 ───
          // rule='B' 종목: 현재가가 저장된 bottomPrice보다 낮으면 갱신
          const stockData = stockFullData[docId];
          if (stockData?.rule === "B") {
            const storedBottom = stockData.bottomPrice || 0;
            if (storedBottom === 0 || h.currentPrice < storedBottom) {
              updateData.bottomPrice = h.currentPrice;
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

      // 실시간 알림 체크: 23%+ 수익 / MA선 근접 (5분마다)
      const stockDataList = stockDocs.docs.map((d) => ({id: d.id, data: d.data()}));
      await checkRealtimeAlerts(stockDataList, holdingsMap);

      // 관심종목 현재가도 업데이트 (텔레그램 알림은 15:05~15:15에만)
      const isSignalTime = timeNum >= 1505 && timeNum <= 1515;
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

      // 3. 다음 매수가 계산 (실제 체결가 기준 - 태산매매법)
      // Rule A: 이전 매수가 대비 -10% / Rule B(매도3회+): 저점 대비 -10%
      const candidates: {name: string; code: string; nextBuyPrice: number; nextBuyLevel: number; currentPrice: number; quantity: number; docId: string; alreadySent: boolean}[] = [];
      for (const [name, stock] of Object.entries(stocks)) {
        // 매매완료(totalQuantity=0) 종목은 일반 매수신호 대상 제외
        // 단, 재진입 추적 ready 상태이면 별도 후보로 추가
        if (!stock.buyPlans || (stock.totalQuantity || 0) <= 0) {
          // 재진입 ready 상태 → 1차 매수 양봉 감지 대상
          if (
            stock.reentry?.enabled &&
            stock.reentry?.status === "ready" &&
            stock.code &&
            stock.currentPrice > 0
          ) {
            const alreadySent = stock.reentry?.signalSent === true;
            candidates.push({
              name,
              code: stock.code,
              nextBuyPrice: stock.reentry.targetPrice,
              nextBuyLevel: 1, // 재진입은 항상 1차
              currentPrice: stock.currentPrice,
              quantity: stock.firstBuyQuantity || 0,
              docId: stock.docId,
              alreadySent,
              isReentry: true, // 재진입 마크
            } as any);
          }
          continue;
        }
        const nextBuy = (stock.buyPlans || []).find((b: any) => !b.filled);
        if (!nextBuy || !stock.currentPrice || stock.currentPrice <= 0) continue;

        // 다음 매수가 계산 — Rule A / Rule B 분기
        const filledPlans = (stock.buyPlans || []).filter((b: any) => b.filled);
        const lastFilledPrice = filledPlans.length > 0
          ? (filledPlans[filledPlans.length - 1].filledPrice || filledPlans[filledPlans.length - 1].price || 0)
          : 0;

        let actualNextBuyPrice: number;
        if (stock.rule === "B" && (stock.bottomPrice || 0) > 0) {
          // Rule B: 저점 대비 -10%
          actualNextBuyPrice = Math.round(stock.bottomPrice * 0.9);
        } else {
          // Rule A: 이전 실제 매수가 대비 -10%
          actualNextBuyPrice = lastFilledPrice > 0
            ? Math.round(lastFilledPrice * 0.9)
            : nextBuy.price;
        }

        if (stock.currentPrice <= actualNextBuyPrice) {
          // 이미 해당 차수에 대해 첫 양봉 알림 발송했는지 확인
          const alreadySent = stock.buySignalSent === true && stock.buySignalLevel === nextBuy.level;
          candidates.push({
            name,
            code: stock.code || (holdings.find((h) => h.name === name) || {code: ""}).code || "",
            nextBuyPrice: actualNextBuyPrice,
            nextBuyLevel: nextBuy.level,
            currentPrice: stock.currentPrice,
            quantity: nextBuy.quantity || stock.firstBuyQuantity || 0,
            docId: stock.docId,
            alreadySent,
          });
        } else {
          // 현재가가 매수가 위로 올라오면 signalSent 리셋 (다음에 다시 떨어지면 새로 추적)
          if (stock.buySignalSent && stock.buySignalLevel === nextBuy.level && stock.docId) {
            await db.collection("stocks").doc(stock.docId).update({
              buySignalSent: false,
              buySignal: null,
            });
          }
        }
      }

      if (candidates.length === 0) {
        console.log("[매수신호] 매수 대기 종목 없음");
        // 매수 대기 아닌 종목들의 buySignal 상태 정리
        for (const [, stock] of Object.entries(stocks)) {
          if (stock.buySignal && stock.docId) {
            const nextBuy = (stock.buyPlans || []).find((b: any) => !b.filled);
            if (!nextBuy || stock.currentPrice > (nextBuy.price || 0)) {
              await db.collection("stocks").doc(stock.docId).update({buySignal: null});
            }
          }
        }
        return "매수 대기 종목 없음";
      }

      console.log(`[매수신호] 매수 대기 ${candidates.length}종목: ${candidates.map((c) => `${c.name}(${c.nextBuyLevel}차,sent=${c.alreadySent})`).join(", ")}`);

      // 4. 시가 조회 (양봉 판단용)
      const codes = candidates.map((c) => c.code).filter(Boolean);
      const openPrices = await fetchOpenPrices(config, token, codes);

      // 5. 양봉 확인 + 첫 양봉 판별
      const signals: (typeof candidates[0] & {openPrice: number})[] = [];
      const waitings: (typeof candidates[0] & {openPrice: number})[] = [];
      const now = Date.now();

      for (const c of candidates) {
        const openPrice = openPrices[c.code] || 0;
        const isYangbong = openPrice > 0 && c.currentPrice > openPrice;
        const isReentry = (c as any).isReentry === true;

        if (isYangbong && !c.alreadySent) {
          // 첫 양봉! 매수신호 발송
          signals.push({...c, openPrice});
          if (isReentry) {
            // 재진입 신호: reentry.signalSent 마크
            await db.collection("stocks").doc(c.docId).update({
              "reentry.signalSent": true,
              "reentry.signalDate": new Date().toISOString().slice(0, 10),
              buySignal: "signal",
              buySignalAt: now,
              buySignalOpen: openPrice,
            });
            console.log(`[재진입 매수신호] ${c.name}: 첫 양봉! 시가=${openPrice} → 현재가=${c.currentPrice} (목표 ${c.nextBuyPrice})`);
          } else {
            await db.collection("stocks").doc(c.docId).update({
              buySignal: "signal",
              buySignalAt: now,
              buySignalOpen: openPrice,
              buySignalSent: true,
              buySignalLevel: c.nextBuyLevel,
            });
            console.log(`[매수신호] ${c.name}: 첫 양봉 매수신호! 시가=${openPrice} → 현재가=${c.currentPrice} (${c.nextBuyLevel}차 매수가=${c.nextBuyPrice})`);
          }
        } else if (isYangbong && c.alreadySent) {
          // 이미 첫 양봉 알림 발송됨 - 상태만 유지
          await db.collection("stocks").doc(c.docId).update({
            buySignal: "signal",
            buySignalAt: now,
            buySignalOpen: openPrice,
          });
          console.log(`[매수신호] ${c.name}: 양봉이나 이미 알림 발송됨 - 스킵`);
        } else {
          // 음봉 - 대기 상태
          waitings.push({...c, openPrice});
          const updateData: any = {
            buySignal: "waiting",
            buySignalAt: now,
            buySignalOpen: openPrice,
          };
          if (isReentry) {
            updateData["reentry.signalSent"] = false;
          } else {
            updateData.buySignalSent = false; // 음봉이면 signalSent 리셋
          }
          await db.collection("stocks").doc(c.docId).update(updateData);
          console.log(`[매수신호] ${c.name}: 음봉 (시가=${openPrice}, 현재가=${c.currentPrice}) - signalSent 리셋`);
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

      // 대기 종목도 참고 알림 (첫 양봉 미발생 종목)
      if (waitings.length > 0 && signals.length === 0) {
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

  const trades = tradesSnap.docs.map((d) => ({id: d.id, ...(d.data() as any)}));

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

  // 매도 차수 갱신: 개별 체결을 순차 슬롯에 매핑 (manualOverride 보존)
  for (let i = 0; i < sortedSells.length; i++) {
    const t = sortedSells[i];
    const price = Number(t.price) || 0;
    const qty = Number(t.quantity) || 0;

    if (i < sellPlans.length) {
      const plan = sellPlans[i];
      if (plan.manualOverride) {
        // 수동 편집된 슬롯은 유지
        console.log(`[reconcile] ${stockName} sell${i + 1}차 manualOverride 보존 (${plan.filledDate} ${plan.filledPrice}원 ${plan.filledQuantity}주)`);
        continue;
      }
      sellPlans[i] = {
        ...plan,
        filled: true,
        filledDate: t.date,
        filledQuantity: qty,
        filledPrice: price,
      };
      sellFilledCount++;
    } else {
      exceedsSell++;
      console.log(
        `[reconcile] ${stockName} 매도 계획 초과: ${t.date} ${qty}주 @ ${price}원 ` +
          `(계획 ${sellPlans.length}차, 실제 ${i + 1}번째 체결)`
      );
    }
  }
  // ✅ 핵심: trades에 없는 sellPlans 차수도 unfilled 리셋 (manualOverride 제외)
  for (let i = sortedSells.length; i < sellPlans.length; i++) {
    if (sellPlans[i].filled && !sellPlans[i].manualOverride) {
      console.log(`[reconcile] ${stockName} sell${i + 1}차 unfilled 리셋 (trades에 없음, 기존 filledDate=${sellPlans[i].filledDate})`);
      sellPlans[i] = {
        ...sellPlans[i],
        filled: false,
        filledDate: "",
        filledQuantity: 0,
        filledPrice: 0,
      };
      sellFilledCount++;
    }
  }

  // 변경사항이 있을 때만 업데이트
  if (buyFilledCount > 0 || sellFilledCount > 0) {
    await stockDoc.ref.update({
      buyPlans,
      sellPlans,
      updatedAt: Date.now(),
    });
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

  return {updated: false, buyFilled: 0, sellFilled: 0, exceedsBuy, exceedsSell};
}

/**
 * Firestore 트리거: 신규 trade 문서 생성 시 자동 실행
 * - trade_kiwoom_* 만 처리 (사용자 수동 작성분은 매매일지만 남고 plan에 영향 없음)
 * - 해당 종목의 buyPlans / sellPlans filled 플래그 자동 갱신
 */
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
              buyPlansCount: (stock.buyPlans || []).length,
              sellPlansCount: (stock.sellPlans || []).length,
              buyPlans: stock.buyPlans,
              sellPlans: stock.sellPlans,
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

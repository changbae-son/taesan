# 룰B 저점(bottomPrice) 기준 — 확정 + 구현 체크리스트

작성: 2026-06-02 / **확정 갱신: 2026-06-03**
대상 검증 종목: 앱클론 (174900)

---

## ✅ 확정된 룰B 정의 (2026-06-03 사용자 확정)

```
저점(bottomPrice) = [1차 매수 전 기준 최고가 시점] ~ [3차 매도 시점] 구간의 최저가
다음 매수가 = 저점 × 0.9   (+ 그 가격대 양봉 시 매수 신호)
```

- **시작점**: **1차 매수 전 기준 최고가**(= 태산 매수 진입 기준이 된 고점 = `referencePeak`)
  - ⚠️ "1차 매수일부터"가 **아님**. 그 이전 기준 최고가 시점부터.
- **끝점**: **3차 매도 시점** → 그 시점에 저점 **freeze(확정)**
- 2차·3차 매수가 있었든, 3차 매도 후든 **기준 구간 동일**: 항상 `기준최고가 ~ 3차 매도`.
- 기준 최고가가 없으면(관심종목 미등록 종목) → **사용자가 직접 입력**.

### 앱클론 검증 (이 정의로 일치)
```
기준 최고가: 3/16 95,800
1차 매수: 5/21 39,700 × 25주
3차 매도: 5/26 (MA20 44,450)
구간 [3/16 ~ 5/26] 최저가 = 5/20 33,600  ← 기대값 일치
다음 매수가 = 33,600 × 0.9 = 30,240원
```

---

## ❌ 이전 분석 정정 (구버전 메모의 오판)

| 구버전 메모 주장 | 실제 (확정) |
|---|---|
| "차이 1: referencePeakDate 시작은 너무 과거 → 틀림" | **referencePeak 시작이 정답.** 시작점은 맞았음 |
| "저점 시작점을 마지막 매수일로 바꿔야" | **틀림.** 시작점 변경 불필요 |

→ 즉 `runRuleBTracker`의 **시작점 로직(referencePeak)은 유지**.
   진짜 고칠 것은 freeze / rule 자동활성 / 수동입력 / 차수별 룰 표시.

---

## 🔧 구현 체크리스트 (4건)

### [1] 3차 매도 시점 freeze — `functions/src/index.ts` runRuleBTracker
- 현재: cron이 매일 더 낮은 값으로 계속 갱신 (freeze 없음)
- 변경: **3차 매도 시점 이후에는 bottomPrice 갱신 중단**
  - 구간 끝 = 3차 매도일. 그 이후 일봉 저가는 저점 계산에서 제외.
  - 시작점 referencePeakDate 유지.

### [2] rule 자동 활성화 — `functions/src/index.ts` mapTradesToPlans
- 현재: `rule === "B"` 명시 안 되면 룰B 로직 미작동
- 변경: 매도 3회(`sellsSinceLastBuy >= 3`) + bottomPrice>0 충족 시 rule="B" 자동 전환 검토
  - (또는 UI에서 명시 전환 시에만 — 자동/수동 정책 구현 중 결정)

### [3] 기준 최고가 수동 입력 — `src/components/StockDetail.tsx`
- 관심종목 미등록 → `referencePeakPrice`/`referencePeakDate` 비어있음
- 변경: 룰B 패널에 기준 최고가 직접 입력 필드 추가
  - 입력 시 `bottomPriceSource='manual'` 계열로 표시

### [4] 차수별 룰 표시 (신규) — `src/types.ts` + 매수계획표
- `BuyPlan`에 `rule?: 'A' | 'B'` 필드 추가 (그 차수 산정 시점 룰)
- `recalcStock`/`mapTradesToPlans`에서 차수 계산 시 현재 룰 stamping
- 매수계획표 각 행에 배지: `룰A` / `룰B`
- 기존 데이터(필드 없음) → 종목 `rule`로 fallback 표시

---

## 검증 (구현 후)
- 앱클론: bottomPrice=33,600 / bottomPriceDate=2026-05-20 / 다음 매수가=30,240 확인
- 매수계획표에 차수별 룰 배지 정상 표시
- 빌드 → deploy → push

---

## ✅ 2026-06-05 추가 완료 — 차수별 룰 자동 판정 (commit 9c8de98)

### 확정 규칙 (사용자)
```
N차 rule = (N-1차 매수 직후 ~ N차 매수 직전) 매도 회수 >= 3 ? 'B' : 'A'
  · 1차 = 항상 'A' (진입)
  · 같은 날·같은 가격 부분체결 = 1회 (date+price 유니크)
  · 직전 차수 미체결 → 'A'
  · 종목 rule 버튼 무관 — 매도 회수(데이터)로 자동 판정
```

### 수정한 3곳 (동일 stageRuleFor 로직)
- `functions/src/index.ts` mapTradesToPlans — 헬퍼 + 체결/미체결 rule stamp + 매수가
- `functions/src/index.ts` reconcileStockPlans — 헬퍼 + 체결 rule stamp + 미체결 보정 차수별
- `src/hooks/useStocks.ts` recalcStock — 헬퍼 + 차수별 stamp + 매수가
  (프론트는 sellPlans+maSells filledDate/filledPrice로 매도 회수 카운트)

### 검증 (삼천당제약 A000250)
- L1=A / L2=B (1차후 4회매도) / L3=A (2차후 0회) / L4=A / L5=A ✓
- 3차 매수가 278,550 = 309,500×0.9 (룰A 직전매수가)

### 근본 원인 (해결됨)
- mapTradesToPlans 1091줄: 체결 매수를 무조건 rule="A" → 직전 매도 무시 (FIXED)
- reconcileStockPlans: 체결 차수 rule stamp 누락 → 옛 'A' 유지 (FIXED)
- recalcStock: 체결 bp.rule||'A', 미체결 종목 isRuleB 일괄 (FIXED)

---

## 🔲 집에서 이어서 점검할 것 (2026-06-05 기준)

1. **다른 보유종목 차수별 룰 일괄 검증**
   - diagRuleBStatus 또는 inspectStockTrades로 보유종목 buyPlans rule 확인
   - 특히 2차 이상 매수 + 매도 다수 종목 (앱클론, 네이블 등)
   - 키움 데이터받기 1회 → 전 종목 새 로직으로 rule 재stamp

2. **룰B 종목의 bottomPrice/referencePeak 저장 확인**
   - 삼천당제약: referencePeakPrice=None 상태였음 (화면 입력했으나 미저장 의심)
   - 룰B 차수의 매수가가 저점×0.9로 나오려면 bottomPrice 필요
   - 시작점(기준최고가) 저장 → ruleBTrackerNow 호출 → 저점 계산 흐름 점검

3. **흥구석유 avgPrice 키움 대조** (15,346 vs 키움 실제 평단)

4. **현금매수 누락 추가 점검** (kt00015 누락 → kt00007 보강 후)
   - diagPlansConsistency로 kiwoom>0 불일치 종목 재확인
   - 대동금속(251)/STX그린로지스(169) 화면 정확화 확인

---

## ✅ 2026-06-06 추가 완료

### 차수별 룰 자동 판정 (commit 9c8de98)
- N차 룰 = (N-1차 매수 직후 ~ N차 매수 직전) 매도 회수 >= 3 ? 'B' : 'A'
- 종목 rule 버튼 무관, 매도 회수(데이터)로 자동
- 3곳 동일 로직: mapTradesToPlans / reconcileStockPlans / recalcStock
- 검증: 삼천당제약 L1=A, L2=B(1차후4회), L3=A(2차후0회)
- 매매완료(보유0) 종목은 룰B 후보 제외 (commit da5604e — 에브리봇)

### 미분류 매도 라운드 필터 (commit b6522fb)
- 미분류 매도를 현재 보는 라운드(thisBuyDate~nextBuyDate) 기간 내 것만 표시
- 헤더에 (N차 라운드) 명시, 복기 라운드에서도 해당 라운드 미분류 노출
- 흥구석유 3차 라운드에 5/12(2차) 건 뜨던 문제 해결

### reconcile 매도 중복흡수 근본 차단 (commit 7712bfa)
- hardConsumedIds 도입: manualOverride/다중참조 슬롯 trade 완전 제외
- 단일참조+비수동만 부분분할 점유량 추적 (광전자 케이스 보존)
- 단일 슬롯 수동 수정 후 reconcile이 다른 슬롯 망가뜨리던 버그 차단
- 검증: 흥구석유 reconcile 반복해도 매핑 불변, 중복 0

### 데이터 정정 (Firestore)
- 흥구석유: 3차 현금매수 누락 보강 → 80주, 5/12 8주 +5% 분류, 5슬롯 정확
- 에브리봇: 4/24 데이트레이딩 매수 8주 제거 → 매매완료(0)

---

## 🔲 집에서 이어서 점검 (2026-06-06 갱신)

1. **앱클론/네이블 등 2차+ 매수 종목 차수별 룰 화면 확인** (Ctrl+Shift+R)
2. **삼천당제약 저점 342,000 vs 이미지 309,500 정확성** (일봉 저가 계산)
   - L3=A라 매수가엔 영향 없으나 향후 룰B 차수 진입 시 점검
3. **STX그린로지스 매수 19주 과다** (kiwoom 343 vs 매핑 324)
4. **흥구석유 avgPrice 15,346 키움 대조**

---

## ✅ 2026-06-09 — 방안 B: 매도 trade 라운드+슬롯 태깅 (근본 해결 완료)

### 문제 (흥구석유/기산텔레콤)
통합 sellPlans 5슬롯이 다회 라운드 매도를 못 담아, roundView(표시)와
consumedTradeIds(미분류 감지)가 불일치 → 같은 매도가 +5%/미분류 양쪽 중복.

### 해결: 1 매도 trade = 1 라운드 + 1 슬롯
- Trade에 sellRound(라운드) + sellSlot('+5%'|...|'MA20'|'unmapped')
- 매도일 직전 매수차수=라운드, 라운드평단 대비 수익률 band=슬롯

### commit
- Phase 1 (de65072): 태깅 인프라 computeSellTags + migrateSellTags
- Phase 2 (c7af2a7): 미분류 감지 태그 기반 + manualSellEdit sellSlot 동기화
- Phase 3 (e07ff19): roundView 슬롯 태그 기반 (가격구간 추측 제거)
- Phase 3.5 (08041d4): reconcile 신규 매도 자동 태깅

### featureFlag: tradeTagBasedMapping = true (활성)
- 롤백: false → 기존 consumedTradeIds 로직
- 백업: stocks_backup_pre-trade-tagging_2026-06-09T02-26-05

### 검증
- 기산텔레콤: 5/22→1차/+5%, 1차 미분류 0 (중복 해결)
- 흥구석유: 라운드별 정확 분리 (1차/2차/3차)
- 전종목 237 매도 태깅, reconcile 후 100% 유지

### 🔲 Phase 4 (선택, 미진행 — 리스크 있음)
레거시 consumedTradeIds 기반 로직 제거:
- reconcileStockPlans 매도 매핑(hardConsumedIds 등) 단순화
- sellPlans/maSells를 "태그된 trade 집계" 파생값으로
- ⚠️ featureFlag OFF 호환 깨짐 → 충분한 안정화 후 진행 권장
- 현재는 태그(신) + consumedTradeIds(구) 병행 유지 (안전)

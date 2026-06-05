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

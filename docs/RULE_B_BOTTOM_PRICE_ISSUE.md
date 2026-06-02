# 룰B 저점(bottomPrice) 기준 차이 분석 — 이어서 작업할 것

작성일: 2026-06-02
관련 commit: `42b9ee7` 기준 (이후 코드 미수정)
대상 종목: 앱클론 (174900)

---

## 🎯 문제 요약

룰B의 **저점(bottomPrice) 추적 기준**이 실제 태산매매법과 다름.
앱클론 사례로 검증됨.

### 앱클론 실제 데이터 (2026-06-02 기준)
```
1차 매수: 5/21  39,700원 × 25주
매도 3회 (= 3차 매도, 룰B 활성 조건):
  5/22  +5%   41,650원 × 5주
  5/26  +10%  43,550원 × 5주
  5/26  MA20  44,450원 × 5주   ← 3차 매도
잔여: 10주
rule: 미설정 (현재 null → 룰B 로직 미작동)
```

### 사용자(실제 태산매매법) 기준
```
3차 매도 시점(5/26) 기준
→ 5/26까지의 누적 최저가 = 5/20 33,600원
→ 2차 매수가 = 33,600 × 0.9 = 30,240원 이하에서 2차 매수
```

---

## 🔴 시스템 vs 실제 — 차이 3가지

### 차이 1: 저점 추적 시작 시점
현재 `runRuleBTracker` (functions/src/index.ts ~3998줄):
```javascript
// 시작점: referencePeakDate (없으면 createdAt 기준)
let fromYMD;
if (stockData.referencePeakDate) {
  fromYMD = stockData.referencePeakDate.replace(/-/g, "");
} else {
  const ts = Number(stockData.createdAt) || Date.now();
  fromYMD = new Date(ts).toISOString().slice(0, 10).replace(/-/g, "");
}
```

| 구분 | 저점 추적 시작 |
|---|---|
| 실제 태산매매법 | **마지막 매수일(1차 매수 5/21) 이후** |
| 시스템 (referencePeakDate) | 관심종목 최고점 날짜(3/16 95,800)부터 — 너무 과거 |
| 시스템 (createdAt) | 종목 등록일부터 |

→ 사용자는 5/20 33,600원(매수 후 저점)을 원하는데
  시스템은 referencePeakDate부터면 더 낮은 과거 저점을 잡거나,
  1차 매수 직전 저점은 놓침.

### 차이 2: 시간 컷오프(freeze) 없음
- 실제: **3차 매도 시점(5/26)에 저점 확정(freeze)** → ×0.9로 2차 매수가 고정
- 시스템: cron이 매일 실행되며 **계속 더 낮은 값으로 갱신** (freeze 없음)
```javascript
// bottomPrice 갱신: 더 낮은 값이거나 처음 — freeze 로직 없음
if (lowestLow !== Infinity && (currentBottom === 0 || lowestLow < currentBottom)) {
  update.bottomPrice = lowestLow;
}
```

### 차이 3: rule 필드 미설정
`mapTradesToPlans` (~1108줄):
```javascript
const isRuleB = ruleConfig?.rule === "B" &&
  (ruleConfig?.bottomPrice || 0) > 0 &&
  (ruleConfig?.sellsSinceLastBuy || 0) >= 3;
```
앱클론은 매도 3회로 sellsSinceLastBuy>=3 충족하지만
**rule 필드가 "B"가 아니라 룰B 로직 자체가 작동 안 함.**

---

## ❓ 확정 필요 (사용자 답변 대기 중)

저점 추적 정의를 확정해야 로직 수정 가능:

- **A안**: 저점 = 마지막 매수일 이후 ~ **3차 매도 시점**까지 최저가 (3차 매도 시 freeze)
- **B안**: 저점 = 마지막 매수일 이후 ~ **계속**(2차 매수 전까지 계속 갱신)
- **C안**: 다른 정의

---

## 🔧 수정 예정 파일 (확정 후)

1. `functions/src/index.ts`
   - `runRuleBTracker`: fromYMD를 마지막 매수일 기준으로 변경
   - freeze 로직 추가 (A안이면): 3차 매도 시점에 bottomPrice 확정
   - `mapTradesToPlans`: rule 자동 설정 또는 sellsSinceLastBuy 기반 활성화 검토

2. `src/components/StockDetail.tsx`
   - 룰B UI 패널에 저점 기준일/freeze 상태 표시

3. 검증
   - 앱클론으로 재확인: bottomPrice=33,600, 2차 매수가=30,240 나오는지

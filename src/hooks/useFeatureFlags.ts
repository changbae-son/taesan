import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

// 클라이언트가 읽는 Feature Flag 인터페이스
// 백엔드 featureFlags endpoint와 settings/featureFlags 문서를 통해 토글.
//
// 사용 예:
//   const flags = useFeatureFlags();
//   if (flags.creditPositionsEnabled) { ... 새 UI ... }
//
// flag off로 두면 새 UI는 숨겨지고 기존 동작 유지됨.
export interface FeatureFlags {
  creditPositionsEnabled?: boolean;
  creditTabEnabled?: boolean;
  creditMaturityAlertEnabled?: boolean;
  // 방안 B: 매도 trade 라운드+슬롯 태그 기반 매핑 (미분류 감지/슬롯 표시)
  tradeTagBasedMapping?: boolean;
}

export function useFeatureFlags(): FeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>({});

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'settings', 'featureFlags'), (snap) => {
      if (snap.exists()) {
        const data = snap.data() as Record<string, unknown>;
        setFlags({
          creditPositionsEnabled: data.creditPositionsEnabled === true,
          creditTabEnabled: data.creditTabEnabled === true,
          creditMaturityAlertEnabled: data.creditMaturityAlertEnabled === true,
          tradeTagBasedMapping: data.tradeTagBasedMapping === true,
        });
      } else {
        setFlags({});
      }
    }, (err) => {
      console.warn('featureFlags 구독 실패:', err);
    });
    return () => unsub();
  }, []);

  return flags;
}

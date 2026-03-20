import { useState, useEffect } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import styles from './KiwoomSettings.module.css';

// Cloud Functions 리전 URL
const FUNCTIONS_BASE = 'https://asia-northeast3-teasan-f4c17.cloudfunctions.net';

interface KiwoomConfig {
  appKey: string;
  appSecret: string;
  accountNo: string;
  htsId: string;
}

export default function KiwoomSettings() {
  const [config, setConfig] = useState<KiwoomConfig>({
    appKey: '',
    appSecret: '',
    accountNo: '',
    htsId: '',
  });
  const [saved, setSaved] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [syncMsg, setSyncMsg] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  // 설정 불러오기
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const docSnap = await getDoc(doc(db, 'settings', 'kiwoom'));
        if (docSnap.exists()) {
          const data = docSnap.data();
          setConfig({
            appKey: data.appKey || '',
            appSecret: data.appSecret || '',
            accountNo: data.accountNo || '',
            htsId: data.htsId || '',
          });
          setConfigured(!!data.appKey);
        }

        const syncSnap = await getDoc(doc(db, 'settings', 'lastSync'));
        if (syncSnap.exists()) {
          const syncData = syncSnap.data();
          if (syncData.timestamp) {
            setLastSync(new Date(syncData.timestamp).toLocaleString('ko-KR'));
          }
        }
      } catch (e) {
        console.error('설정 불러오기 실패:', e);
      }
    };
    loadConfig();
  }, []);

  // 설정 저장
  const handleSave = async () => {
    try {
      await setDoc(doc(db, 'settings', 'kiwoom'), {
        ...config,
        baseUrl: 'https://openapi.koreainvestment.com:9443',
        updatedAt: Date.now(),
      });
      setSaved(true);
      setConfigured(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error('저장 실패:', e);
    }
  };

  // 동기화 실행
  const handleSync = async () => {
    setSyncStatus('loading');
    setSyncMsg('키움 데이터 수신 중...');

    try {
      const res = await fetch(`${FUNCTIONS_BASE}/kiwoomSync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (data.success) {
        setSyncStatus('success');
        setSyncMsg(
          `동기화 완료! 종목 ${data.syncedStocks}개, 체결 ${data.syncedTrades}건 (${data.syncTime?.slice(11, 19) || ''})`
        );
        setLastSync(new Date().toLocaleString('ko-KR'));
      } else {
        setSyncStatus('error');
        setSyncMsg(data.error || '동기화 실패');
      }
    } catch (e: any) {
      setSyncStatus('error');
      setSyncMsg('Cloud Function 호출 실패. Firebase Blaze 요금제가 필요합니다.');
    }

    setTimeout(() => {
      setSyncStatus('idle');
      setSyncMsg('');
    }, 8000);
  };

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>키움증권 API 연동</h3>

      <div className={styles.infoBox}>
        <p><strong>연동 구조:</strong> 웹앱 → Firebase Cloud Functions(고정IP) → 키움 REST API → Firestore</p>
        <p>별도 프로그램 설치 없이 어디서든 동기화 가능합니다.</p>
      </div>

      {/* 상태 표시 */}
      <div className={styles.statusBar}>
        <span className={styles.statusDot} style={{ background: configured ? '#4caf50' : '#ccc' }} />
        <span>{configured ? 'API 설정 완료' : 'API 설정 필요'}</span>
        {lastSync && <span className={styles.lastSync}>마지막 동기화: {lastSync}</span>}
      </div>

      {/* 동기화 버튼 */}
      <button
        className={styles.syncBtn}
        onClick={handleSync}
        disabled={!configured || syncStatus === 'loading'}
      >
        {syncStatus === 'loading' ? '수신 중...' : '키움 데이터 받기'}
      </button>

      {syncMsg && (
        <div
          className={styles.syncMsg}
          style={{
            color: syncStatus === 'success' ? '#4caf50' : syncStatus === 'error' ? '#f44336' : '#666',
            background: syncStatus === 'success' ? '#e8f5e9' : syncStatus === 'error' ? '#ffebee' : '#f5f5f5',
          }}
        >
          {syncMsg}
        </div>
      )}

      {/* API 설정 폼 */}
      <div className={styles.formSection}>
        <h4>API 설정</h4>
        <p className={styles.guide}>
          키움증권 → 트레이딩 → Open API → REST API 신청 후 발급받은 키를 입력하세요.
        </p>

        <label className={styles.label}>
          APP Key
          <input
            className={styles.input}
            type="text"
            value={config.appKey}
            onChange={(e) => setConfig({ ...config, appKey: e.target.value })}
            placeholder="발급받은 APP Key"
          />
        </label>

        <label className={styles.label}>
          APP Secret
          <div className={styles.secretRow}>
            <input
              className={styles.input}
              type={showSecret ? 'text' : 'password'}
              value={config.appSecret}
              onChange={(e) => setConfig({ ...config, appSecret: e.target.value })}
              placeholder="발급받은 APP Secret"
            />
            <button
              className={styles.toggleBtn}
              onClick={() => setShowSecret(!showSecret)}
              type="button"
            >
              {showSecret ? '숨기기' : '보기'}
            </button>
          </div>
        </label>

        <label className={styles.label}>
          계좌번호
          <input
            className={styles.input}
            type="text"
            value={config.accountNo}
            onChange={(e) => setConfig({ ...config, accountNo: e.target.value })}
            placeholder="00000000-01 형식"
          />
        </label>

        <label className={styles.label}>
          HTS ID
          <input
            className={styles.input}
            type="text"
            value={config.htsId}
            onChange={(e) => setConfig({ ...config, htsId: e.target.value })}
            placeholder="키움 HTS 아이디"
          />
        </label>

        <button className={styles.saveBtn} onClick={handleSave}>
          설정 저장
        </button>
        {saved && <span className={styles.savedMsg}>저장됨</span>}
      </div>

      {/* 안내 */}
      <div className={styles.helpSection}>
        <h4>사용 방법</h4>
        <ol>
          <li>키움증권 홈페이지에서 REST API 사용 신청</li>
          <li>APP Key, Secret 발급 후 위에 입력</li>
          <li>Firebase Blaze(종량제) 요금제로 업그레이드</li>
          <li>"키움 데이터 받기" 버튼으로 동기화</li>
        </ol>
        <p className={styles.note}>
          * Firebase Blaze 요금제는 무료 한도 내에서는 비용이 발생하지 않습니다.
          <br />
          * Cloud Functions의 고정 IP가 키움에 등록되므로 IP 변경 걱정이 없습니다.
        </p>
      </div>
    </div>
  );
}

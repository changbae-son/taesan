import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import type { Stock, TabType, WatchItem } from '../types';
import styles from './Sidebar.module.css';

interface Props {
  stocks: Stock[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (name: string) => void;
  onTabChange: (tab: TabType) => void;
  synced: boolean;
  watchItems?: WatchItem[];
}

function getDotColor(stock: Stock): string {
  const plans = stock.buyPlans || [];
  const filledCount = plans.filter((b) => b.filled).length;
  if (filledCount === 0) return '#ccc';
  if (filledCount <= 2) return '#4caf50';
  if (filledCount === 3) return '#ff9800';
  return '#f44336';
}

function getStatus(stock: Stock): string {
  const plans = stock.buyPlans || [];
  const filledBuys = plans.filter((b) => b.filled).length;
  if (filledBuys === 0) return '관찰';
  if ((stock.totalQuantity || 0) === 0) return '완료';
  return '보유';
}

interface NearbyInfo {
  type: 'buy' | 'sell';
  gap: number;       // 괴리율 (%)
  absGap: number;    // 절대값
  urgency: 1 | 2 | 3; // 1=±3%, 2=±2%, 3=±1%
}

function getNearby(stock: Stock): NearbyInfo[] {
  const cp = stock.currentPrice || 0;
  if (cp === 0) return [];

  const result: NearbyInfo[] = [];
  const nextBuy = (stock.buyPlans || []).find((b) => !b.filled);
  const nextSell = (stock.sellPlans || []).find((s) => !s.filled);

  const check = (target: number, type: 'buy' | 'sell') => {
    if (!target) return;
    const gap = ((cp - target) / target) * 100;
    const absGap = Math.abs(gap);
    if (absGap <= 3) {
      const urgency: 1 | 2 | 3 = absGap <= 1 ? 3 : absGap <= 2 ? 2 : 1;
      result.push({ type, gap, absGap, urgency });
    }
  };

  if (nextBuy) check(nextBuy.price, 'buy');
  if (nextSell) check(nextSell.price, 'sell');
  return result;
}

interface SyncInfo {
  timestamp: number;
  stocks?: number;
  trades?: number;
}

function formatSyncTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const yy = String(d.getFullYear()).slice(2);
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${yy}.${mm}.${dd} ${h}:${m}`;
}

export default function Sidebar({ stocks, selectedId, onSelect, onAdd, onTabChange, synced, watchItems = [] }: Props) {
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [kiwoomStatus, setKiwoomStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [kiwoomMsg, setKiwoomMsg] = useState('');
  const [autoSync, setAutoSync] = useState<SyncInfo | null>(null);
  const [manualSync, setManualSync] = useState<SyncInfo | null>(null);

  useEffect(() => {
    const unsub1 = onSnapshot(doc(db, 'settings', 'lastAutoSync'), (snap) => {
      if (snap.exists()) setAutoSync(snap.data() as SyncInfo);
    });
    const unsub2 = onSnapshot(doc(db, 'settings', 'lastManualSync'), (snap) => {
      if (snap.exists()) setManualSync(snap.data() as SyncInfo);
    });
    return () => { unsub1(); unsub2(); };
  }, []);

  const handleKiwoomSync = async () => {
    setKiwoomStatus('loading');
    setKiwoomMsg('키움 데이터 수신 중...');
    try {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      // 최근 3개월 체결 내역 조회 (매수 내역 포함)
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const startDate = threeMonthsAgo.toISOString().slice(0, 10).replace(/-/g, '');
      const res = await fetch(
        'https://asia-northeast3-teasan-f4c17.cloudfunctions.net/kiwoomSync',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate: today }),
        }
      );
      const data = await res.json();
      if (data.success) {
        setKiwoomStatus('success');
        setKiwoomMsg(`동기화 완료! 종목 ${data.syncedStocks}개, 체결 ${data.syncedTrades}건`);
      } else {
        setKiwoomStatus('error');
        setKiwoomMsg(data.error || '동기화 실패');
      }
    } catch {
      setKiwoomStatus('error');
      setKiwoomMsg('키움 연동 설정이 필요합니다');
    }
    setTimeout(() => { setKiwoomStatus('idle'); setKiwoomMsg(''); }, 5000);
  };

  // 매매완료 종목 필터링 (보유수량 0 + 매수 체결 이력 있음)
  const activeStocks = stocks.filter(
    (s) => (s.totalQuantity || 0) > 0 || !(s.buyPlans || []).some((bp) => bp.filled)
  );
  const completedCount = stocks.length - activeStocks.length;

  const filtered = activeStocks.filter((s) =>
    (s.name || '').toLowerCase().includes(search.toLowerCase())
  );

  const totalStocks = activeStocks.length;
  const profitStocks = activeStocks.filter(
    (s) => s.avgPrice > 0 && s.currentPrice > s.avgPrice
  ).length;

  const handleAdd = () => {
    if (newName.trim()) {
      onAdd(newName.trim());
      setNewName('');
      setShowAdd(false);
    }
  };

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <h2 className={styles.title}>태산매매법</h2>
        <span
          className={styles.syncDot}
          style={{ background: synced ? '#4caf50' : '#ff9800' }}
          title={synced ? '동기화됨' : '동기화 중...'}
        />
      </div>

      <div className={styles.stats}>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>종목</span>
          <span className={styles.statValue}>{totalStocks}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>수익</span>
          <span className={styles.statValue} style={{ color: '#4caf50' }}>
            {profitStocks}
          </span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>손실</span>
          <span className={styles.statValue} style={{ color: '#f44336' }}>
            {totalStocks - profitStocks}
          </span>
        </div>
      </div>

      <input
        className={styles.search}
        placeholder="종목 검색..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className={styles.list}>
        {filtered.map((s) => {
          const nearbyList = getNearby(s);
          return (
            <div
              key={s.id}
              className={`${styles.item} ${selectedId === s.id ? styles.selected : ''} ${nearbyList.length > 0 ? styles.nearbyItem : ''}`}
              onClick={() => {
                onSelect(s.id);
                onTabChange('detail');
              }}
            >
              <span
                className={styles.dot}
                style={{ background: getDotColor(s) }}
              />
              <span className={styles.stockName}>{s.name}</span>
              {s.buySignal === 'signal' && (
                <span className={styles.signalBadge}>매수신호</span>
              )}
              {s.buySignal === 'waiting' && (
                <span className={styles.waitingBadge}>대기</span>
              )}
              {nearbyList.map((n, i) => (
                <span
                  key={i}
                  className={`${n.type === 'buy' ? styles.nearbyBuy : styles.nearbySell} ${
                    n.urgency === 3 ? styles.urgency3 : n.urgency === 2 ? styles.urgency2 : styles.urgency1
                  }`}
                >
                  {n.type === 'buy' ? '매수' : '매도'} {n.gap >= 0 ? '+' : ''}{n.gap.toFixed(1)}%
                </span>
              ))}
              <span className={styles.badge}>{getStatus(s)}</span>
            </div>
          );
        })}
      </div>

      {/* 관심종목 매수 근접 알림 */}
      {(() => {
        const nearWatch = watchItems.filter((w) => w.status === 'approaching' || w.status === 'ready');
        if (nearWatch.length === 0) return null;
        return (
          <div className={styles.watchAlert}>
            <div
              className={styles.watchAlertTitle}
              onClick={() => onTabChange('watchlist')}
            >
              관심종목 알림
              <span className={styles.watchAlertCount}>{nearWatch.length}</span>
            </div>
            {nearWatch.map((w) => {
              const drop = w.peakPrice > 0 ? ((w.currentPrice - w.peakPrice) / w.peakPrice * 100) : 0;
              return (
                <div
                  key={w.id}
                  className={`${styles.watchAlertItem} ${w.status === 'ready' ? styles.watchReady : styles.watchApproaching}`}
                  onClick={() => onTabChange('watchlist')}
                >
                  <span className={styles.watchName}>{w.name}</span>
                  <span className={styles.watchDrop}>{drop.toFixed(1)}%</span>
                  {w.status === 'ready' && <span className={styles.watchReadyBadge}>매수!</span>}
                </div>
              );
            })}
          </div>
        );
      })()}

      <div className={styles.syncStatus}>
        <div className={styles.syncRow}>
          <span className={styles.syncIcon}>⟳</span>
          <span className={styles.syncLabel}>자동</span>
          <span className={styles.syncTime}>{autoSync ? formatSyncTime(autoSync.timestamp) : '-'}</span>
          <span className={styles.syncDetail}>{autoSync?.stocks || 0}종목</span>
        </div>
        <div className={styles.syncRow}>
          <span className={styles.syncIcon}>⬇</span>
          <span className={styles.syncLabel}>수동</span>
          <span className={styles.syncTime}>{manualSync ? formatSyncTime(manualSync.timestamp) : '-'}</span>
          <span className={styles.syncDetail}>{manualSync?.stocks || 0}종목 {manualSync?.trades || 0}건</span>
        </div>
      </div>

      {completedCount > 0 && (
        <button
          className={styles.completedBtn}
          onClick={() => onTabChange('completed')}
        >
          매매완료 {completedCount}종목
        </button>
      )}

      <button
        className={styles.kiwoomBtn}
        onClick={handleKiwoomSync}
        disabled={kiwoomStatus === 'loading'}
      >
        {kiwoomStatus === 'loading' ? '수신 중...' : '키움 데이터 받기'}
      </button>
      {kiwoomMsg && (
        <div
          className={styles.kiwoomMsg}
          style={{
            color: kiwoomStatus === 'success' ? '#4caf50' : kiwoomStatus === 'error' ? '#f44336' : '#666',
          }}
        >
          {kiwoomMsg}
        </div>
      )}

      {showAdd ? (
        <div className={styles.addForm}>
          <input
            className={styles.addInput}
            placeholder="종목명 입력"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            autoFocus
          />
          <div className={styles.addButtons}>
            <button className={styles.addBtn} onClick={handleAdd}>
              추가
            </button>
            <button
              className={styles.cancelBtn}
              onClick={() => setShowAdd(false)}
            >
              취소
            </button>
          </div>
        </div>
      ) : (
        <button className={styles.addButton} onClick={() => setShowAdd(true)}>
          + 종목 추가
        </button>
      )}
    </div>
  );
}

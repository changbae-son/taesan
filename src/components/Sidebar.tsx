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

interface PrimaryAction {
  type: 'buy' | 'sell';
  urgency: 'now' | 'near';
  level: number;
  price: number;
  quantity: number;
  gap: number; // 현재가 대비 목표가 괴리율 ((현재가 - 목표가) / 목표가 * 100)
  isManualSell?: boolean;
  reason: 'signal' | 'waiting' | 'reached' | 'nearby';
}

// 태산 매매 규칙: 실행 우선순위에 따라 대표 액션 1개 반환
// 우선순위: (1) 매도 도달 > (2) 매수신호 > (3) 매수 도달 > (4) 매도 근접 > (5) 매수 근접 > (6) 매수대기
function getPrimaryAction(stock: Stock): PrimaryAction | null {
  const cp = stock.currentPrice || 0;
  if (cp === 0) return null;

  const buyPlans = stock.buyPlans || [];
  const sellPlans = stock.sellPlans || [];

  const nextBuyIdx = buyPlans.findIndex((b) => !b.filled);
  const nextSellIdx = sellPlans.findIndex((s) => !s.filled);
  const nextBuy = nextBuyIdx >= 0 ? buyPlans[nextBuyIdx] : null;
  const nextSell = nextSellIdx >= 0 ? sellPlans[nextSellIdx] : null;

  const buyGap = nextBuy && nextBuy.price > 0 ? ((cp - nextBuy.price) / nextBuy.price) * 100 : null;
  const sellGap = nextSell && nextSell.price > 0 ? ((cp - nextSell.price) / nextSell.price) * 100 : null;

  // 1. 매도 도달: 현금화 최우선
  if (nextSell && sellGap !== null && cp >= nextSell.price) {
    return {
      type: 'sell',
      urgency: 'now',
      level: nextSellIdx + 1,
      price: nextSell.price,
      quantity: nextSell.quantity,
      gap: sellGap,
      isManualSell: nextSell.percent >= 25,
      reason: 'reached',
    };
  }

  // 2. 매수신호 (태산 매매법 당일 매수 조건 충족)
  if (stock.buySignal === 'signal' && nextBuy && buyGap !== null) {
    return {
      type: 'buy',
      urgency: 'now',
      level: nextBuyIdx + 1,
      price: nextBuy.price,
      quantity: nextBuy.quantity,
      gap: buyGap,
      reason: 'signal',
    };
  }

  // 3. 매수 도달 (목표가 터치)
  if (nextBuy && buyGap !== null && cp <= nextBuy.price) {
    return {
      type: 'buy',
      urgency: 'now',
      level: nextBuyIdx + 1,
      price: nextBuy.price,
      quantity: nextBuy.quantity,
      gap: buyGap,
      reason: 'reached',
    };
  }

  // 4. 매도 근접 (±3% 이내)
  if (nextSell && sellGap !== null && Math.abs(sellGap) <= 3) {
    return {
      type: 'sell',
      urgency: 'near',
      level: nextSellIdx + 1,
      price: nextSell.price,
      quantity: nextSell.quantity,
      gap: sellGap,
      isManualSell: nextSell.percent >= 25,
      reason: 'nearby',
    };
  }

  // 5. 매수 근접 (±3% 이내)
  if (nextBuy && buyGap !== null && Math.abs(buyGap) <= 3) {
    return {
      type: 'buy',
      urgency: 'near',
      level: nextBuyIdx + 1,
      price: nextBuy.price,
      quantity: nextBuy.quantity,
      gap: buyGap,
      reason: 'nearby',
    };
  }

  // 6. 매수대기 (저점 터치 후 양봉 대기)
  if (stock.buySignal === 'waiting' && nextBuy && buyGap !== null) {
    return {
      type: 'buy',
      urgency: 'near',
      level: nextBuyIdx + 1,
      price: nextBuy.price,
      quantity: nextBuy.quantity,
      gap: buyGap,
      reason: 'waiting',
    };
  }

  return null;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}

function ProgressDots({ stock, small = false }: { stock: Stock; small?: boolean }) {
  const plans = (stock.buyPlans || []).slice(0, 5);
  if (plans.length === 0) return null;
  return (
    <span className={small ? styles.progressDotsSmall : styles.progressDots}>
      {plans.map((p, i) => (
        <span
          key={i}
          className={`${small ? styles.pdotSm : styles.pdot} ${p.filled ? (small ? styles.pdotSmFilled : styles.pdotFilled) : ''}`}
        />
      ))}
    </span>
  );
}

interface CardProps {
  stock: Stock;
  action: PrimaryAction | null;
  selected: boolean;
  onClick: () => void;
  compact: boolean;
}

function StockCard({ stock, action, selected, onClick, compact }: CardProps) {
  // 보유 대기 (idle): 1줄 컴팩트
  if (compact || !action) {
    return (
      <div
        className={`${styles.item} ${styles.itemCompact} ${selected ? styles.selected : ''}`}
        onClick={onClick}
      >
        <span className={styles.dot} style={{ background: getDotColor(stock) }} />
        <span className={styles.stockName}>
          {stock.name}
          {stock.code && <span className={styles.stockCode}>{stock.code}</span>}
        </span>
        <ProgressDots stock={stock} small />
        <span className={styles.badge}>{getStatus(stock)}</span>
      </div>
    );
  }

  // 지금 실행 / 근접 감시: 2줄 확장
  const itemClass =
    action.urgency === 'now'
      ? action.type === 'buy'
        ? styles.itemActionBuy
        : styles.itemActionSell
      : action.type === 'buy'
      ? styles.itemNearBuy
      : styles.itemNearSell;

  const absGap = Math.abs(action.gap);
  const gapClass =
    absGap <= 1 ? styles.gapUrgent : absGap <= 3 ? styles.gapClose : styles.gapFar;

  const badgeClass =
    action.type === 'buy'
      ? `${styles.primaryBadge} ${action.urgency === 'now' ? styles.primaryBuyNow : styles.primaryBuyNear}`
      : `${styles.primaryBadge} ${action.urgency === 'now' ? styles.primarySellNow : styles.primarySellNear}`;

  const badgeLabel =
    action.type === 'buy'
      ? action.urgency === 'now'
        ? action.reason === 'signal'
          ? '매수!'
          : '매수'
        : '매수근접'
      : action.urgency === 'now'
      ? '매도!'
      : '매도근접';

  return (
    <div
      className={`${styles.item} ${styles.itemExpanded} ${itemClass} ${selected ? styles.selected : ''}`}
      onClick={onClick}
    >
      <div className={styles.itemHeader}>
        <span className={styles.dot} style={{ background: getDotColor(stock) }} />
        <span className={styles.stockName}>
          {stock.name}
          {stock.code && <span className={styles.stockCode}>{stock.code}</span>}
        </span>
        <span className={badgeClass}>{badgeLabel}</span>
        {action.isManualSell && <span className={styles.manualTag}>수동</span>}
      </div>
      <div className={styles.itemInfo}>
        <ProgressDots stock={stock} />
        <span className={styles.nextActionText}>
          <b className={styles.levelText}>{action.level}차</b>{' '}
          <span className={action.type === 'buy' ? styles.priceBuy : styles.priceSell}>
            {fmt(action.price)}원
          </span>
          <span className={styles.qtyText}>× {action.quantity}주</span>
        </span>
        <span className={`${styles.gapBadge} ${gapClass}`}>
          {action.gap >= 0 ? '+' : ''}
          {action.gap.toFixed(1)}%
        </span>
      </div>
    </div>
  );
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
  const [showIdle, setShowIdle] = useState(false);
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

  // 이름 없는 빈 종목 + 매매완료 종목 필터링
  const activeStocks = stocks.filter(
    (s) => (s.name && s.name.trim()) && ((s.totalQuantity || 0) > 0 || !(s.buyPlans || []).some((bp) => bp.filled))
  );
  const completedCount = stocks.length - activeStocks.length;

  const filtered = activeStocks.filter((s) =>
    (s.name || '').toLowerCase().includes(search.toLowerCase())
  );

  // 실행 우선순위 분류
  type Entry = { stock: Stock; action: PrimaryAction | null };
  const actionList: Entry[] = [];
  const nearList: Entry[] = [];
  const idleList: Entry[] = [];
  filtered.forEach((s) => {
    const act = getPrimaryAction(s);
    const entry = { stock: s, action: act };
    if (!act) idleList.push(entry);
    else if (act.urgency === 'now') actionList.push(entry);
    else nearList.push(entry);
  });

  // 실행/근접 내부 정렬: 매도 우선(현금화), 그다음 괴리 작은 순
  const sortEntries = (a: Entry, b: Entry) => {
    const aA = a.action!;
    const bA = b.action!;
    if (aA.type !== bA.type) return aA.type === 'sell' ? -1 : 1;
    return Math.abs(aA.gap) - Math.abs(bA.gap);
  };
  actionList.sort(sortEntries);
  nearList.sort(sortEntries);

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

  const renderCard = (entry: Entry, compact: boolean) => (
    <StockCard
      key={entry.stock.id}
      stock={entry.stock}
      action={entry.action}
      selected={selectedId === entry.stock.id}
      onClick={() => {
        onSelect(entry.stock.id);
        onTabChange('detail');
      }}
      compact={compact}
    />
  );

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
          <span className={styles.statValue} style={{ color: '#d32f2f' }}>
            {profitStocks}
          </span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>손실</span>
          <span className={styles.statValue} style={{ color: '#1565c0' }}>
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
        {actionList.length > 0 && (
          <>
            <div className={`${styles.sectionHeader} ${styles.sectionAction}`}>
              <span className={styles.sectionIcon}>🔴</span>
              <span className={styles.sectionTitle}>지금 실행</span>
              <span className={styles.sectionCount}>{actionList.length}</span>
            </div>
            {actionList.map((e) => renderCard(e, false))}
          </>
        )}

        {nearList.length > 0 && (
          <>
            <div className={`${styles.sectionHeader} ${styles.sectionNear}`}>
              <span className={styles.sectionIcon}>🟡</span>
              <span className={styles.sectionTitle}>근접 감시</span>
              <span className={styles.sectionCount}>{nearList.length}</span>
            </div>
            {nearList.map((e) => renderCard(e, false))}
          </>
        )}

        {idleList.length > 0 && (
          <>
            <div
              className={`${styles.sectionHeader} ${styles.sectionIdle} ${styles.clickable}`}
              onClick={() => setShowIdle((v) => !v)}
            >
              <span className={styles.sectionIcon}>⚪</span>
              <span className={styles.sectionTitle}>보유 대기</span>
              <span className={styles.sectionCount}>{idleList.length}</span>
              <span className={styles.sectionToggle}>{showIdle ? '접기 ▲' : '펼치기 ▼'}</span>
            </div>
            {showIdle && idleList.map((e) => renderCard(e, true))}
          </>
        )}

        {filtered.length === 0 && (
          <div className={styles.emptyHint}>
            {search ? '검색 결과 없음' : '종목 없음'}
          </div>
        )}
      </div>

      {/* 관심종목 알림: 매수준비만 개별 표시, 나머지는 요약 */}
      {(() => {
        const readyItems = watchItems.filter((w) => w.status === 'ready');
        const approachingCount = watchItems.filter((w) => w.status === 'approaching').length;
        const watchingCount = watchItems.filter((w) => w.status === 'watching').length;
        if (readyItems.length === 0 && approachingCount === 0 && watchItems.length === 0) return null;
        return (
          <div className={styles.watchAlert}>
            <div
              className={styles.watchAlertTitle}
              onClick={() => onTabChange('watchlist')}
            >
              관심종목
              {readyItems.length > 0 && <span className={styles.watchAlertCount}>{readyItems.length}</span>}
            </div>
            {readyItems.map((w) => {
              const drop = w.peakPrice > 0 ? ((w.currentPrice - w.peakPrice) / w.peakPrice * 100) : 0;
              return (
                <div
                  key={w.id}
                  className={`${styles.watchAlertItem} ${styles.watchReady}`}
                  onClick={() => onTabChange('watchlist')}
                >
                  <span className={styles.watchName}>
                    {w.name}
                    {w.code && <span className={styles.stockCode}>{w.code}</span>}
                  </span>
                  <span className={styles.watchDrop}>{drop.toFixed(1)}%</span>
                  <span className={styles.watchReadyBadge}>매수!</span>
                </div>
              );
            })}
            <div
              className={styles.watchSummary}
              onClick={() => onTabChange('watchlist')}
            >
              {approachingCount > 0 && <span className={styles.summaryApproaching}>접근중 {approachingCount}</span>}
              {watchingCount > 0 && <span className={styles.summaryWatching}>감시중 {watchingCount}</span>}
            </div>
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

import { useState } from 'react';
import type { Stock, TabType } from '../types';
import styles from './Sidebar.module.css';

interface Props {
  stocks: Stock[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (name: string) => void;
  onTabChange: (tab: TabType) => void;
  synced: boolean;
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

export default function Sidebar({ stocks, selectedId, onSelect, onAdd, onTabChange, synced }: Props) {
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [kiwoomStatus, setKiwoomStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [kiwoomMsg, setKiwoomMsg] = useState('');

  const handleKiwoomSync = async () => {
    setKiwoomStatus('loading');
    setKiwoomMsg('키움 데이터 수신 중...');
    try {
      const res = await fetch('http://localhost:5000/sync');
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
      setKiwoomMsg('키움 서버 미연결 (PC에서 kiwoom_server.py 실행 필요)');
    }
    setTimeout(() => { setKiwoomStatus('idle'); setKiwoomMsg(''); }, 5000);
  };

  const filtered = stocks.filter((s) =>
    (s.name || '').toLowerCase().includes(search.toLowerCase())
  );

  const totalStocks = stocks.length;
  const profitStocks = stocks.filter(
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
        {filtered.map((s) => (
          <div
            key={s.id}
            className={`${styles.item} ${selectedId === s.id ? styles.selected : ''}`}
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
            <span className={styles.badge}>{getStatus(s)}</span>
          </div>
        ))}
      </div>

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

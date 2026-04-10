import { useState, useEffect, useRef } from 'react';
import type { WatchItem } from '../types';
import styles from './Watchlist.module.css';

interface StockSearchResult {
  name: string;
  code: string;
  market: string;
}

interface Props {
  items: WatchItem[];
  onAdd: (name: string, code: string, peakPrice: number) => Promise<string>;
  onRemove: (id: string) => void;
}

function getDropPercent(item: WatchItem): number {
  if (!item.peakPrice || !item.currentPrice) return 0;
  return ((item.currentPrice - item.peakPrice) / item.peakPrice) * 100;
}

function getStatusText(status: WatchItem['status']): string {
  switch (status) {
    case 'watching': return '감시중';
    case 'approaching': return '접근중';
    case 'ready': return '매수준비';
    case 'bought': return '매수완료';
  }
}

export default function Watchlist({ items, onAdd, onRemove }: Props) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [peakPrice, setPeakPrice] = useState('');
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 정적 종목 리스트 로드 (한 번만)
  const stockListRef = useRef<[string, string, string][]>([]);
  const [stockListLoaded, setStockListLoaded] = useState(false);

  useEffect(() => {
    fetch('/stock_codes.json')
      .then((r) => r.json())
      .then((data: [string, string, string][]) => {
        stockListRef.current = data;
        setStockListLoaded(true);
      })
      .catch(() => {});
  }, []);

  // 종목명 입력 시 로컬 검색
  useEffect(() => {
    if (!name.trim() || !stockListLoaded) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }

    const q = name.trim().toLowerCase();
    const exact: StockSearchResult[] = [];
    const startsWith: StockSearchResult[] = [];
    const includes: StockSearchResult[] = [];

    for (const [n, c, m] of stockListRef.current) {
      const nl = n.toLowerCase();
      if (nl === q) exact.push({ name: n, code: c, market: m });
      else if (nl.startsWith(q)) startsWith.push({ name: n, code: c, market: m });
      else if (nl.includes(q) || c.includes(name.trim())) includes.push({ name: n, code: c, market: m });
    }

    const results = [...exact, ...startsWith, ...includes].slice(0, 15);
    setSearchResults(results);
    setShowDropdown(results.length > 0);
  }, [name, stockListLoaded]);

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSelectStock = (result: StockSearchResult) => {
    setName(result.name);
    setCode(result.code);
    setShowDropdown(false);
  };

  const handleAdd = async () => {
    if (!name.trim() || !peakPrice) return;
    await onAdd(name.trim(), code.trim(), parseInt(peakPrice));
    setName('');
    setCode('');
    setPeakPrice('');
    setSearchResults([]);
  };

  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg('가격 업데이트 중...');
    try {
      const res = await fetch(
        'https://asia-northeast3-teasan-f4c17.cloudfunctions.net/watchlistRefresh',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      );
      const data = await res.json();
      if (data.success) {
        setRefreshMsg(`${data.updated}종목 가격 업데이트 완료`);
      } else {
        setRefreshMsg(data.error || '업데이트 실패');
      }
    } catch {
      setRefreshMsg('업데이트 실패');
    }
    setRefreshing(false);
    setTimeout(() => setRefreshMsg(''), 4000);
  };

  const watchingCount = items.filter((i) => i.status === 'watching').length;
  const approachingCount = items.filter((i) => i.status === 'approaching').length;
  const readyCount = items.filter((i) => i.status === 'ready').length;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          관심종목 감시
          <span className={styles.count}>{items.length}종목</span>
        </h2>
        <button
          className={styles.refreshBtn}
          onClick={handleRefresh}
          disabled={refreshing || items.length === 0}
        >
          {refreshing ? '업데이트 중...' : '현재가 업데이트'}
        </button>
      </div>
      {refreshMsg && (
        <div className={styles.refreshMsg}>{refreshMsg}</div>
      )}

      <div className={styles.addForm}>
        <div className={styles.nameWrap} ref={dropdownRef}>
          <input
            className={styles.nameInput}
            placeholder="종목명 검색"
            value={name}
            onChange={(e) => { setName(e.target.value); setCode(''); }}
            onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          {showDropdown && searchResults.length > 0 && (
            <div className={styles.dropdown}>
              {searchResults.map((r) => (
                <div
                  key={r.code}
                  className={styles.dropdownItem}
                  onClick={() => handleSelectStock(r)}
                >
                  <span className={styles.dropdownName}>{r.name}</span>
                  <span className={styles.dropdownCode}>{r.code}</span>
                  <span className={styles.dropdownMarket}>{r.market}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <input
          className={styles.codeInput}
          placeholder="종목코드"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          readOnly={!!code && searchResults.some(r => r.code === code)}
        />
        <input
          className={styles.priceInput}
          placeholder="최고점가격"
          type="number"
          value={peakPrice}
          onChange={(e) => setPeakPrice(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <button className={styles.addBtn} onClick={handleAdd}>추가</button>
      </div>

      {items.length > 0 && (
        <div className={styles.summary}>
          {watchingCount > 0 && (
            <span className={`${styles.summaryItem} ${styles.summaryWatching}`}>
              감시중 {watchingCount}
            </span>
          )}
          {approachingCount > 0 && (
            <span className={`${styles.summaryItem} ${styles.summaryApproaching}`}>
              접근중 {approachingCount}
            </span>
          )}
          {readyCount > 0 && (
            <span className={`${styles.summaryItem} ${styles.summaryReady}`}>
              매수준비 {readyCount}
            </span>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className={styles.empty}>
          관심종목을 추가해주세요.<br />
          매일 15:10에 자동으로 매수 조건을 체크합니다.
        </div>
      ) : (
        <div className={styles.grid}>
          {items.map((item) => {
            const drop = getDropPercent(item);
            const targetPrice = Math.round(item.peakPrice * (1 + item.targetPercent / 100));
            const dropProgress = item.peakPrice > 0
              ? Math.min(100, Math.abs(drop) / Math.abs(item.targetPercent) * 100)
              : 0;

            const cardClass = item.status === 'ready' ? styles.cardReady
              : item.status === 'approaching' ? styles.cardApproaching
              : item.status === 'bought' ? styles.cardBought
              : styles.cardWatching;

            const badgeClass = item.status === 'ready' ? styles.badgeReady
              : item.status === 'approaching' ? styles.badgeApproaching
              : item.status === 'bought' ? styles.badgeBought
              : styles.badgeWatching;

            const fillClass = dropProgress >= 100 ? styles.dropFillReady
              : dropProgress >= 80 ? styles.dropFillClose
              : styles.dropFillNormal;

            return (
              <div key={item.id} className={`${styles.card} ${cardClass}`}>
                <div className={styles.cardHeader}>
                  <div>
                    <span className={styles.stockName}>{item.name}</span>
                    {item.code && <span className={styles.stockCode}>{item.code}</span>}
                  </div>
                  <span className={`${styles.statusBadge} ${badgeClass}`}>
                    {getStatusText(item.status)}
                  </span>
                </div>

                <div className={styles.priceRow}>
                  <span className={styles.priceLabel}>최고점</span>
                  <span className={styles.priceValue}>{item.peakPrice.toLocaleString()}원</span>
                </div>
                <div className={styles.priceRow}>
                  <span className={styles.priceLabel}>어제종가</span>
                  <span className={styles.priceValue}>
                    {(item.prevClose || 0) > 0 ? `${item.prevClose.toLocaleString()}원` : '-'}
                  </span>
                </div>
                <div className={styles.priceRow}>
                  <span className={styles.priceLabel}>현재가</span>
                  <span className={styles.priceValue}>
                    {item.currentPrice > 0 ? `${item.currentPrice.toLocaleString()}원` : '-'}
                  </span>
                </div>
                <div className={styles.priceRow}>
                  <span className={styles.priceLabel}>하락률</span>
                  <span className={styles.priceValue} style={{ color: drop <= -45 ? '#c62828' : drop <= -35 ? '#e65100' : '#333' }}>
                    {item.currentPrice > 0 ? `${drop.toFixed(1)}%` : '-'}
                  </span>
                </div>

                <div className={styles.dropBar}>
                  <div
                    className={`${styles.dropFill} ${fillClass}`}
                    style={{ width: `${dropProgress}%` }}
                  />
                  <span className={styles.dropText}>
                    {dropProgress.toFixed(0)}% / 목표 {item.targetPercent}%
                  </span>
                </div>

                <div className={styles.targetRow}>
                  <span className={styles.targetLabel}>1차 매수 목표가</span>
                  <span className={styles.targetPrice}>{targetPrice.toLocaleString()}원</span>
                </div>

                <button
                  className={styles.deleteBtn}
                  onClick={() => onRemove(item.id)}
                >
                  삭제
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

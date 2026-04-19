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

type GroupKey = 'ready' | 'approaching' | 'watching';

export default function Watchlist({ items, onAdd, onRemove }: Props) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [peakPrice, setPeakPrice] = useState('');
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const peakPriceRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ watching: true });
  const [showAddForm, setShowAddForm] = useState(false);

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
    setHighlightIdx(-1);
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

  const [dupWarning, setDupWarning] = useState('');

  const handleSelectStock = (result: StockSearchResult) => {
    setName(result.name);
    setCode(result.code);
    setShowDropdown(false);
    setHighlightIdx(-1);

    // 중복 종목 체크
    const existing = items.find((item) => item.code === result.code);
    if (existing) {
      setDupWarning(`"${result.name}" 은(는) 이미 등록된 종목입니다.`);
    } else {
      setDupWarning('');
      // 종목 선택 후 최고점가격 입력으로 자동 포커스
      setTimeout(() => peakPriceRef.current?.focus(), 50);
    }
  };

  const handleAdd = async () => {
    if (!name.trim() || !peakPrice) return;
    // 추가 시에도 중복 체크
    if (code && items.some((item) => item.code === code)) {
      setDupWarning(`이미 등록된 종목입니다.`);
      return;
    }
    await onAdd(name.trim(), code.trim(), parseInt(peakPrice));
    setName('');
    setCode('');
    setPeakPrice('');
    setDupWarning('');
    setSearchResults([]);
    setShowAddForm(false);
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

  // 그룹별 분류 + 하락률 기준 정렬
  const grouped: Record<GroupKey, WatchItem[]> = { ready: [], approaching: [], watching: [] };
  for (const item of items) {
    const key = item.status === 'ready' ? 'ready'
      : item.status === 'approaching' ? 'approaching'
      : 'watching';
    grouped[key].push(item);
  }
  // 각 그룹 내에서 하락률이 큰(= -50%에 가까운) 순서로 정렬
  for (const key of Object.keys(grouped) as GroupKey[]) {
    grouped[key].sort((a, b) => getDropPercent(a) - getDropPercent(b));
  }

  const groupConfig: { key: GroupKey; label: string; icon: string; color: string }[] = [
    { key: 'ready', label: '매수준비', icon: '!', color: '#c62828' },
    { key: 'approaching', label: '접근중', icon: '!', color: '#e65100' },
    { key: 'watching', label: '감시중', icon: '', color: '#888' },
  ];

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className={styles.container}>
      {/* 헤더 */}
      <div className={styles.header}>
        <h2 className={styles.title}>관심종목 감시</h2>
        <div className={styles.headerActions}>
          <button
            className={styles.addToggleBtn}
            onClick={() => setShowAddForm(!showAddForm)}
          >
            {showAddForm ? '닫기' : '+ 종목추가'}
          </button>
          <button
            className={styles.refreshBtn}
            onClick={handleRefresh}
            disabled={refreshing || items.length === 0}
          >
            {refreshing ? '...' : '현재가 업데이트'}
          </button>
        </div>
      </div>

      {refreshMsg && <div className={styles.refreshMsg}>{refreshMsg}</div>}

      {/* 추가 폼 (접기/펼치기) */}
      {showAddForm && (
        <div className={styles.addForm}>
          <div className={styles.nameWrap} ref={dropdownRef}>
            <input
              className={styles.nameInput}
              placeholder="종목명 검색 (한글)"
              value={name}
              onChange={(e) => { setName(e.target.value); setCode(''); setDupWarning(''); }}
              onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
              onKeyDown={(e) => {
                if (showDropdown && searchResults.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setHighlightIdx((prev) => Math.min(prev + 1, searchResults.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setHighlightIdx((prev) => Math.max(prev - 1, 0));
                  } else if (e.key === 'Enter' && highlightIdx >= 0) {
                    e.preventDefault();
                    handleSelectStock(searchResults[highlightIdx]);
                  } else if (e.key === 'Escape') {
                    setShowDropdown(false);
                    setHighlightIdx(-1);
                  }
                } else if (e.key === 'Enter' && code) {
                  e.preventDefault();
                  peakPriceRef.current?.focus();
                }
              }}
              lang="ko"
              style={{ imeMode: 'active' } as React.CSSProperties}
              autoFocus
            />
            {showDropdown && searchResults.length > 0 && (
              <div className={styles.dropdown}>
                {searchResults.map((r, idx) => {
                  const isDup = items.some((item) => item.code === r.code);
                  return (
                    <div
                      key={r.code}
                      className={`${styles.dropdownItem} ${idx === highlightIdx ? styles.dropdownHighlight : ''} ${isDup ? styles.dropdownDup : ''}`}
                      onClick={() => handleSelectStock(r)}
                      onMouseEnter={() => setHighlightIdx(idx)}
                    >
                      <span className={styles.dropdownName}>{r.name}</span>
                      <span className={styles.dropdownCode}>{r.code}</span>
                      <span className={styles.dropdownMarket}>{r.market}</span>
                      {isDup && <span className={styles.dupBadge}>등록됨</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <input className={styles.codeInput} placeholder="종목코드" value={code} onChange={(e) => setCode(e.target.value)} readOnly={!!code && searchResults.some(r => r.code === code)} />
          <input ref={peakPriceRef} className={styles.priceInput} placeholder="최고점가격" type="number" value={peakPrice} onChange={(e) => setPeakPrice(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleAdd()} />
          <button className={styles.addBtn} onClick={handleAdd} disabled={!!dupWarning}>추가</button>
          {dupWarning && <div className={styles.dupWarning}>{dupWarning}</div>}
        </div>
      )}

      {/* 상단 요약 대시보드 */}
      <div className={styles.dashboard}>
        <div className={`${styles.dashItem} ${styles.dashTotal}`}>
          <span className={styles.dashNum}>{items.length}</span>
          <span className={styles.dashLabel}>전체</span>
        </div>
        <div className={`${styles.dashItem} ${styles.dashReady}`}>
          <span className={styles.dashNum}>{grouped.ready.length}</span>
          <span className={styles.dashLabel}>매수준비</span>
        </div>
        <div className={`${styles.dashItem} ${styles.dashApproaching}`}>
          <span className={styles.dashNum}>{grouped.approaching.length}</span>
          <span className={styles.dashLabel}>접근중</span>
        </div>
        <div className={`${styles.dashItem} ${styles.dashWatching}`}>
          <span className={styles.dashNum}>{grouped.watching.length}</span>
          <span className={styles.dashLabel}>감시중</span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className={styles.empty}>
          관심종목을 추가해주세요.<br />
          매일 15:10에 자동으로 매수 조건을 체크합니다.
        </div>
      ) : (
        <div className={styles.groups}>
          {groupConfig.map(({ key, label, color }) => {
            const group = grouped[key];
            if (group.length === 0) return null;
            const isCollapsed = collapsed[key] || false;

            return (
              <div key={key} className={styles.group}>
                <div
                  className={styles.groupHeader}
                  style={{ borderLeftColor: color }}
                  onClick={() => toggleCollapse(key)}
                >
                  <span className={styles.groupArrow}>{isCollapsed ? '>' : 'v'}</span>
                  <span className={styles.groupLabel} style={{ color }}>{label}</span>
                  <span className={styles.groupCount}>{group.length}</span>
                </div>

                {!isCollapsed && (
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th className={styles.thName}>종목명</th>
                        <th className={styles.thCandle}>봉</th>
                        <th className={styles.thNum}>최고점</th>
                        <th className={styles.thNum}>어제종가</th>
                        <th className={styles.thNum}>현재가</th>
                        <th className={styles.thNum}>하락률</th>
                        <th className={styles.thBar}>진행</th>
                        <th className={styles.thNum}>목표가</th>
                        <th className={styles.thAction}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.map((item) => {
                        const drop = getDropPercent(item);
                        const targetPrice = Math.round(item.peakPrice * (1 + item.targetPercent / 100));
                        const progress = item.peakPrice > 0
                          ? Math.min(100, Math.abs(drop) / Math.abs(item.targetPercent) * 100)
                          : 0;

                        const dropColor = drop <= -45 ? '#c62828' : drop <= -35 ? '#e65100' : '#666';
                        const barColor = progress >= 100 ? '#c62828' : progress >= 80 ? '#e65100' : '#4caf50';

                        const rowClass = item.status === 'ready' ? styles.rowReady
                          : item.status === 'approaching' ? styles.rowApproaching
                          : '';

                        const isYangbong = item.openPrice > 0 && item.currentPrice > item.openPrice;
                        const isUmbong = item.openPrice > 0 && item.currentPrice < item.openPrice;
                        const candleType = isYangbong ? 'yang' : isUmbong ? 'um' : 'doji';
                        // 시가 대비 변동률 (막대 크기 결정용, 최대 5% 기준)
                        const candleRate = item.openPrice > 0
                          ? ((item.currentPrice - item.openPrice) / item.openPrice) * 100
                          : 0;
                        const barWidth = Math.min(Math.abs(candleRate) / 5 * 100, 100);

                        return (
                          <tr key={item.id} className={rowClass}>
                            <td className={styles.tdName}>
                              <span className={styles.tName}>{item.name}</span>
                              {item.code && <span className={styles.tCode}>{item.code}</span>}
                            </td>
                            <td className={styles.tdCandle}>
                              {item.currentPrice > 0 && item.openPrice > 0 && (
                                <div className={styles.candleWrap}>
                                  <span className={`${styles.candleLabel} ${
                                    candleType === 'yang' ? styles.candleLabelYang
                                    : candleType === 'um' ? styles.candleLabelUm
                                    : styles.candleLabelDoji
                                  }`}>
                                    {candleType === 'yang' ? '양' : candleType === 'um' ? '음' : '-'}
                                  </span>
                                  <div className={styles.candleBar}>
                                    <div
                                      className={`${styles.candleBarFill} ${
                                        candleType === 'yang' ? styles.candleBarYang
                                        : candleType === 'um' ? styles.candleBarUm
                                        : styles.candleBarDoji
                                      }`}
                                      style={{ width: `${barWidth}%` }}
                                    />
                                  </div>
                                  <span className={styles.candleRate}>
                                    {candleRate >= 0 ? '+' : ''}{candleRate.toFixed(1)}%
                                  </span>
                                </div>
                              )}
                            </td>
                            <td className={styles.tdNum}>{item.peakPrice.toLocaleString()}</td>
                            <td className={styles.tdNum}>{(item.prevClose || 0) > 0 ? item.prevClose.toLocaleString() : '-'}</td>
                            <td className={styles.tdNum}>
                              <strong>{item.currentPrice > 0 ? item.currentPrice.toLocaleString() : '-'}</strong>
                            </td>
                            <td className={styles.tdNum} style={{ color: dropColor, fontWeight: 700 }}>
                              {item.currentPrice > 0 ? `${drop.toFixed(1)}%` : '-'}
                            </td>
                            <td className={styles.tdBar}>
                              <div className={styles.miniBar}>
                                <div
                                  className={styles.miniFill}
                                  style={{ width: `${progress}%`, background: barColor }}
                                />
                              </div>
                              <span className={styles.miniText}>{progress.toFixed(0)}%</span>
                            </td>
                            <td className={styles.tdNum} style={{ color: '#c62828', fontWeight: 600 }}>
                              {targetPrice.toLocaleString()}
                            </td>
                            <td className={styles.tdAction}>
                              <button className={styles.delBtn} onClick={() => onRemove(item.id)}>x</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

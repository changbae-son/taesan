import { useState } from 'react';
import type { Trade, Stock } from '../types';
import styles from './TradeJournal.module.css';

interface Props {
  trades: Trade[];
  stocks: Stock[];
  onAdd: (trade: Omit<Trade, 'id' | 'createdAt'>) => void;
  onUpdate: (trade: Trade) => void;
  onDelete: (id: string) => void;
}

const today = new Date().toISOString().slice(0, 10);

export default function TradeJournal({
  trades,
  stocks,
  onAdd,
  onUpdate,
  onDelete,
}: Props) {
  const [form, setForm] = useState({
    date: today,
    stockName: '',
    type: 'buy' as 'buy' | 'sell' | 'watch',
    price: 0,
    quantity: 0,
    memo: '',
    tagInput: '',
  });
  const [filterStock, setFilterStock] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [editId, setEditId] = useState<string | null>(null);

  const handleSubmit = () => {
    if (!form.stockName.trim()) return;
    const tags = form.tagInput
      .split(/[\s,]+/)
      .filter((t) => t.startsWith('#'))
      .map((t) => t.replace('#', ''));

    if (editId) {
      const original = trades.find((t) => t.id === editId);
      if (original) {
        onUpdate({
          ...original,
          date: form.date,
          stockName: form.stockName,
          type: form.type,
          price: form.price,
          quantity: form.quantity,
          memo: form.memo,
          tags,
        });
      }
      setEditId(null);
    } else {
      onAdd({
        date: form.date,
        stockName: form.stockName,
        type: form.type,
        price: form.price,
        quantity: form.quantity,
        memo: form.memo,
        tags,
      });
    }
    setForm({
      date: today,
      stockName: '',
      type: 'buy',
      price: 0,
      quantity: 0,
      memo: '',
      tagInput: '',
    });
  };

  const startEdit = (trade: Trade) => {
    setEditId(trade.id);
    setForm({
      date: trade.date,
      stockName: trade.stockName,
      type: trade.type,
      price: trade.price,
      quantity: trade.quantity,
      memo: trade.memo,
      tagInput: trade.tags.map((t) => `#${t}`).join(' '),
    });
  };

  // 필터링
  let filtered = trades;
  if (filterStock) {
    filtered = filtered.filter((t) =>
      t.stockName.includes(filterStock)
    );
  }
  if (filterTag) {
    filtered = filtered.filter((t) =>
      t.tags.some((tag) => tag.includes(filterTag.replace('#', '')))
    );
  }

  // 월별 그룹
  const grouped: Record<string, Trade[]> = {};
  filtered.forEach((t) => {
    const month = t.date.slice(0, 7);
    if (!grouped[month]) grouped[month] = [];
    grouped[month].push(t);
  });

  const typeLabel = { buy: '매수', sell: '매도', watch: '관찰' };
  const typeColor = { buy: '#4caf50', sell: '#f44336', watch: '#888' };

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>매매 일지</h2>

      {/* 작성 폼 */}
      <div className={styles.form}>
        <div className={styles.formRow}>
          <label>
            날짜
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </label>
          <label>
            종목명
            <input
              list="stock-names"
              value={form.stockName}
              onChange={(e) => setForm({ ...form, stockName: e.target.value })}
              placeholder="종목명 입력"
            />
            <datalist id="stock-names">
              {stocks.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
          </label>
          <label>
            구분
            <select
              value={form.type}
              onChange={(e) =>
                setForm({
                  ...form,
                  type: e.target.value as 'buy' | 'sell' | 'watch',
                })
              }
            >
              <option value="buy">매수</option>
              <option value="sell">매도</option>
              <option value="watch">관찰</option>
            </select>
          </label>
        </div>
        <div className={styles.formRow}>
          <label>
            가격
            <input
              type="number"
              value={form.price || ''}
              onChange={(e) =>
                setForm({ ...form, price: Number(e.target.value) })
              }
            />
          </label>
          <label>
            수량
            <input
              type="number"
              value={form.quantity || ''}
              onChange={(e) =>
                setForm({ ...form, quantity: Number(e.target.value) })
              }
            />
          </label>
          <label>
            태그
            <input
              value={form.tagInput}
              onChange={(e) => setForm({ ...form, tagInput: e.target.value })}
              placeholder="#대선주 #테마 #태산"
            />
          </label>
        </div>
        <label className={styles.memoLabel}>
          메모
          <textarea
            value={form.memo}
            onChange={(e) => setForm({ ...form, memo: e.target.value })}
            placeholder="매매 근거, 시장 상황 등..."
            rows={3}
          />
        </label>
        <button className={styles.submitBtn} onClick={handleSubmit}>
          {editId ? '수정 완료' : '일지 저장'}
        </button>
        {editId && (
          <button
            className={styles.cancelEditBtn}
            onClick={() => {
              setEditId(null);
              setForm({
                date: today,
                stockName: '',
                type: 'buy',
                price: 0,
                quantity: 0,
                memo: '',
                tagInput: '',
              });
            }}
          >
            취소
          </button>
        )}
      </div>

      {/* 필터 */}
      <div className={styles.filters}>
        <input
          className={styles.filterInput}
          placeholder="종목 필터"
          value={filterStock}
          onChange={(e) => setFilterStock(e.target.value)}
        />
        <input
          className={styles.filterInput}
          placeholder="태그 필터 (#태산)"
          value={filterTag}
          onChange={(e) => setFilterTag(e.target.value)}
        />
      </div>

      {/* 일지 목록 */}
      {Object.entries(grouped)
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, list]) => (
          <div key={month} className={styles.monthGroup}>
            <h3 className={styles.monthTitle}>{month}</h3>
            {list.map((trade) => (
              <div key={trade.id} className={styles.tradeCard}>
                <div className={styles.tradeHeader}>
                  <span className={styles.tradeDate}>{trade.date}</span>
                  <span
                    className={styles.tradeType}
                    style={{ color: typeColor[trade.type] }}
                  >
                    {typeLabel[trade.type]}
                  </span>
                  <span className={styles.tradeStock}>{trade.stockName}</span>
                  <span className={styles.tradePrice}>
                    {trade.price.toLocaleString()}원 × {trade.quantity}
                  </span>
                </div>
                {trade.memo && (
                  <p className={styles.tradeMemo}>{trade.memo}</p>
                )}
                {trade.tags.length > 0 && (
                  <div className={styles.tradeTags}>
                    {trade.tags.map((tag, i) => (
                      <span key={i} className={styles.tag}>
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className={styles.tradeActions}>
                  <button onClick={() => startEdit(trade)}>수정</button>
                  <button
                    onClick={() => {
                      if (confirm('삭제하시겠습니까?')) onDelete(trade.id);
                    }}
                  >
                    삭제
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}

      {filtered.length === 0 && (
        <p className={styles.empty}>매매 일지가 없습니다.</p>
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import StockList from './components/StockList';
import StockDetail from './components/StockDetail';
import TradeJournal from './components/TradeJournal';
import Dashboard from './components/Dashboard';
import { useStocks } from './hooks/useStocks';
import { useTrades } from './hooks/useTrades';
import { useSnapshots } from './hooks/useSnapshots';
import { useToast } from './hooks/useToast';
import type { TabType } from './types';
import './App.css';

export default function App() {
  const { stocks, loading, saveStock, addStock, removeStock } = useStocks();
  const { trades, addTrade, updateTrade, removeTrade } = useTrades();
  const { snapshots, addSnapshot } = useSnapshots();
  const { visible, message, showToast } = useToast();

  const [activeTab, setActiveTab] = useState<TabType>('list');
  const [selectedStockId, setSelectedStockId] = useState<string | null>(null);
  const [synced, setSynced] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const selectedStock = stocks.find((s) => s.id === selectedStockId) || null;

  useEffect(() => {
    setSynced(false);
    const t = setTimeout(() => setSynced(true), 800);
    return () => clearTimeout(t);
  }, [stocks, trades]);

  const handleSelectStock = (id: string) => {
    setSelectedStockId(id);
    setActiveTab('detail');
    setMobileMenuOpen(false);
  };

  const handleAddStock = async (name: string) => {
    const id = await addStock(name);
    setSelectedStockId(id);
    setActiveTab('detail');
    showToast('종목이 추가되었습니다');
  };

  const handleSaveStock = (stock: typeof stocks[0]) => {
    saveStock(stock);
    showToast();
  };

  const handleDeleteStock = (id: string) => {
    removeStock(id);
    setSelectedStockId(null);
    setActiveTab('list');
    showToast('종목이 삭제되었습니다');
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>데이터를 불러오는 중...</p>
      </div>
    );
  }

  return (
    <div className="app">
      <button
        className="mobile-menu-btn"
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
      >
        &#9776;
      </button>

      <div className={`sidebar-wrap ${mobileMenuOpen ? 'sidebar-open' : ''}`}>
        <Sidebar
          stocks={stocks}
          selectedId={selectedStockId}
          onSelect={handleSelectStock}
          onAdd={handleAddStock}
          onTabChange={(tab) => {
            setActiveTab(tab);
            setMobileMenuOpen(false);
          }}
          synced={synced}
        />
      </div>

      <div className="main">
        <div className="tabs">
          {(['list', 'detail', 'journal', 'dashboard'] as TabType[]).map(
            (tab) => (
              <button
                key={tab}
                className={`tab ${activeTab === tab ? 'tab-active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'list' && '전체 리스트'}
                {tab === 'detail' && '종목 상세'}
                {tab === 'journal' && '매매 일지'}
                {tab === 'dashboard' && '통계 대시보드'}
              </button>
            )
          )}
        </div>

        <div className="content">
          {activeTab === 'list' && (
            <StockList stocks={stocks} onSelect={handleSelectStock} />
          )}
          {activeTab === 'detail' &&
            (selectedStock ? (
              <StockDetail
                stock={selectedStock}
                snapshots={snapshots}
                onSave={handleSaveStock}
                onDelete={handleDeleteStock}
                onSnapshot={addSnapshot}
              />
            ) : (
              <div className="empty-state">
                <p>좌측에서 종목을 선택하세요</p>
              </div>
            ))}
          {activeTab === 'journal' && (
            <TradeJournal
              trades={trades}
              stocks={stocks}
              onAdd={addTrade}
              onUpdate={updateTrade}
              onDelete={removeTrade}
            />
          )}
          {activeTab === 'dashboard' && (
            <Dashboard
              stocks={stocks}
              trades={trades}
              snapshots={snapshots}
            />
          )}
        </div>
      </div>

      {visible && <div className="toast">{message}</div>}
    </div>
  );
}

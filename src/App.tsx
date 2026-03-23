import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import StockList from './components/StockList';
import StockDetail from './components/StockDetail';
import TradeJournal from './components/TradeJournal';
import Dashboard from './components/Dashboard';
import KiwoomSettings from './components/KiwoomSettings';
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

  const getTabFromHash = (): TabType => {
    const hash = window.location.hash.replace('#', '') || 'list';
    const validTabs: TabType[] = ['list', 'detail', 'journal', 'dashboard', 'kiwoom'];
    return validTabs.includes(hash as TabType) ? (hash as TabType) : 'list';
  };

  const [activeTab, setActiveTab] = useState<TabType>(getTabFromHash());
  const [selectedStockId, setSelectedStockId] = useState<string | null>(null);
  const [synced, setSynced] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const selectedStock = stocks.find((s) => s.id === selectedStockId) || null;

  // URL 해시 변경 시 탭 동기화 (뒤로가기 지원)
  useEffect(() => {
    const handleHashChange = () => {
      setActiveTab(getTabFromHash());
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // 탭 변경 시 URL 해시 업데이트
  const changeTab = (tab: TabType) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  useEffect(() => {
    setSynced(false);
    const t = setTimeout(() => setSynced(true), 800);
    return () => clearTimeout(t);
  }, [stocks, trades]);

  const handleSelectStock = (id: string) => {
    setSelectedStockId(id);
    changeTab('detail');
    setMobileMenuOpen(false);
  };

  const handleAddStock = async (name: string) => {
    const id = await addStock(name);
    setSelectedStockId(id);
    changeTab('detail');
    showToast('종목이 추가되었습니다');
  };

  const handleSaveStock = (stock: typeof stocks[0]) => {
    saveStock(stock);
    showToast();
  };

  const handleDeleteStock = (id: string) => {
    removeStock(id);
    setSelectedStockId(null);
    changeTab('list');
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
            changeTab(tab);
            setMobileMenuOpen(false);
          }}
          synced={synced}
        />
      </div>

      <div className="main">
        <div className="tabs">
          {(['list', 'detail', 'journal', 'dashboard', 'kiwoom'] as TabType[]).map(
            (tab) => (
              <button
                key={tab}
                className={`tab ${activeTab === tab ? 'tab-active' : ''}`}
                onClick={() => changeTab(tab)}
              >
                {tab === 'list' && '전체 리스트'}
                {tab === 'detail' && '종목 상세'}
                {tab === 'journal' && '매매 일지'}
                {tab === 'dashboard' && '통계 대시보드'}
                {tab === 'kiwoom' && '키움 연동'}
              </button>
            )
          )}
        </div>

        <div className="content">
          {activeTab === 'list' && (
            <StockList stocks={stocks} trades={trades} onSelect={handleSelectStock} />
          )}
          {activeTab === 'detail' &&
            (selectedStock ? (
              <StockDetail
                stock={selectedStock}
                trades={trades}
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
          {activeTab === 'kiwoom' && <KiwoomSettings />}
        </div>
      </div>

      {visible && <div className="toast">{message}</div>}
    </div>
  );
}

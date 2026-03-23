import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import type { Stock, Trade, Snapshot } from '../types';
import styles from './Dashboard.module.css';

interface Props {
  stocks: Stock[];
  trades: Trade[];
  snapshots: Snapshot[];
}

const COLORS = ['#4caf50', '#ff9800', '#f44336', '#4a90d9', '#9c27b0'];

export default function Dashboard({ stocks, trades, snapshots }: Props) {
  // KPI
  const totalStocks = stocks.length;
  const profitStocks = stocks.filter(
    (s) => s.avgPrice > 0 && s.currentPrice > s.avgPrice
  ).length;
  const lossStocks = stocks.filter(
    (s) => s.avgPrice > 0 && s.currentPrice <= s.avgPrice
  ).length;

  const avgProfit =
    stocks.filter((s) => s.avgPrice > 0).length > 0
      ? stocks
          .filter((s) => s.avgPrice > 0)
          .reduce(
            (sum, s) =>
              sum + ((s.currentPrice - s.avgPrice) / s.avgPrice) * 100,
            0
          ) / stocks.filter((s) => s.avgPrice > 0).length
      : 0;

  // 누적 실현 수익
  const realizedProfit = snapshots.reduce(
    (sum, s) => sum + s.profitPercent,
    0
  );

  // 차트1: 종목별 손익%
  const profitData = stocks
    .filter((s) => s.avgPrice > 0)
    .map((s) => ({
      name: s.name,
      profit: Number(
        (((s.currentPrice - s.avgPrice) / s.avgPrice) * 100).toFixed(2)
      ),
    }));

  // 차트2: 포트폴리오 수익 추이
  const portfolioData: { date: string; cumProfit: number }[] = [];
  let cumProfit = 0;
  const sortedSnaps = [...snapshots].sort((a, b) => a.createdAt - b.createdAt);
  sortedSnaps.forEach((s) => {
    cumProfit += s.profitPercent;
    portfolioData.push({
      date: s.date,
      cumProfit: Number(cumProfit.toFixed(2)),
    });
  });

  // 차트3: 차수별 진입 분포
  const levelCounts = [0, 0, 0, 0, 0];
  stocks.forEach((s) => {
    const filled = (s.buyPlans || []).filter((b) => b.filled).length;
    if (filled > 0 && filled <= 5) levelCounts[filled - 1]++;
  });
  const pieData = levelCounts.map((count, i) => ({
    name: `${i + 1}차`,
    value: count,
  }));

  // 매매 패턴 분석
  const ruleACount = stocks.filter((s) => s.rule === 'A').length;
  const ruleBCount = stocks.filter((s) => s.rule === 'B').length;

  // 태그 통계
  const tagCounts: Record<string, number> = {};
  trades.forEach((t) => {
    (t.tags || []).forEach((tag) => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  const topTags = Object.entries(tagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>통계 대시보드</h2>

      {/* KPI 카드 */}
      <div className={styles.kpiGrid}>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>총 투자 종목</span>
          <span className={styles.kpiValue}>{totalStocks}</span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>평균 수익률</span>
          <span
            className={styles.kpiValue}
            style={{ color: avgProfit >= 0 ? '#4caf50' : '#f44336' }}
          >
            {avgProfit.toFixed(2)}%
          </span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>수익 / 손실</span>
          <span className={styles.kpiValue}>
            <span style={{ color: '#4caf50' }}>{profitStocks}</span> /{' '}
            <span style={{ color: '#f44336' }}>{lossStocks}</span>
          </span>
        </div>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>누적 실현 수익</span>
          <span
            className={styles.kpiValue}
            style={{ color: realizedProfit >= 0 ? '#4caf50' : '#f44336' }}
          >
            {realizedProfit.toFixed(2)}%
          </span>
        </div>
      </div>

      {/* 차트1: 종목별 손익 */}
      {profitData.length > 0 && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>종목별 현재 손익%</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={profitData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" fontSize={12} />
              <YAxis
                fontSize={12}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                formatter={(v) => [`${Number(v).toFixed(2)}%`, '손익']}
              />
              <Bar dataKey="profit">
                {profitData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.profit >= 0 ? '#4caf50' : '#f44336'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 차트2: 포트폴리오 수익 추이 */}
      {portfolioData.length > 0 && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>포트폴리오 수익 추이</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={portfolioData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" fontSize={12} />
              <YAxis
                fontSize={12}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                formatter={(v) => [`${Number(v).toFixed(2)}%`, '누적 수익']}
              />
              <Line
                type="monotone"
                dataKey="cumProfit"
                stroke="#4a90d9"
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 차트3: 차수별 진입 분포 */}
      {pieData.some((d) => d.value > 0) && (
        <div className={styles.chartCard}>
          <h3 className={styles.chartTitle}>차수별 진입 분포</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={pieData.filter((d) => d.value > 0)}
                cx="50%"
                cy="50%"
                outerRadius={80}
                dataKey="value"
                label={(entry) => `${entry.name}: ${entry.value}`}
              >
                {pieData
                  .filter((d) => d.value > 0)
                  .map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
              </Pie>
              <Legend />
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 매매 패턴 분석 */}
      <div className={styles.chartCard}>
        <h3 className={styles.chartTitle}>매매 패턴 분석</h3>
        <div className={styles.patternGrid}>
          <div className={styles.patternItem}>
            <span className={styles.patternLabel}>룰A / 룰B 비율</span>
            <span className={styles.patternValue}>
              {ruleACount} / {ruleBCount}
            </span>
          </div>
          <div className={styles.patternItem}>
            <span className={styles.patternLabel}>총 매매 일지</span>
            <span className={styles.patternValue}>{trades.length}건</span>
          </div>
          <div className={styles.patternItem}>
            <span className={styles.patternLabel}>
              매수 / 매도 / 관찰
            </span>
            <span className={styles.patternValue}>
              {trades.filter((t) => t.type === 'buy').length} /{' '}
              {trades.filter((t) => t.type === 'sell').length} /{' '}
              {trades.filter((t) => t.type === 'watch').length}
            </span>
          </div>
        </div>
        {topTags.length > 0 && (
          <div className={styles.tagSection}>
            <span className={styles.patternLabel}>자주 사용한 태그</span>
            <div className={styles.tagList}>
              {topTags.map(([tag, count]) => (
                <span key={tag} className={styles.tagBadge}>
                  #{tag} ({count})
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

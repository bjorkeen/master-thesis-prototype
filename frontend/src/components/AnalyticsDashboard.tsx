/**
 * AnalyticsDashboard — experiment results and decision analytics.
 *
 * Data sources (fetched in parallel on mount):
 *   GET /api/decisions/stats → aggregate accuracy, cost, override metrics
 *   GET /api/decisions/log  → per-decision records for cost breakdown + override list
 */
import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { useApi } from '../hooks/useApi';
import type { DecisionStats, Decision } from '../types';

interface LogEntry extends Decision { anomaly_type?: string; }
interface LogResponse { decisions: LogEntry[]; total: number; }

const B = '#2A2B38';
const ACTION_COLOR: Record<string, string> = {
  auto_resolve:   '#3EBD8C',
  escalate:       '#E8913A',
  critical:       '#E5534B',
  send_to_human:  '#4C8BF5',
  critical_alert: '#E5534B',
};
const ACTION_LABEL: Record<string, string> = {
  auto_resolve: 'Auto', escalate: 'Escalate', critical: 'Critical',
  send_to_human: 'Human', critical_alert: 'Alert',
};

function fmtDuration(s?: number | null) {
  if (s == null) return '—';
  return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`;
}

// Shared chart tooltip style
const TIP_STYLE = { backgroundColor: '#16171E', border: `1px solid ${B}`, borderRadius: 8, fontSize: 12 };

// Top-row stat card
function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl p-5 flex flex-col gap-2" style={{ backgroundColor: '#16171E', border: `1px solid ${B}` }}>
      <p style={{ fontSize: '0.65rem', color: '#6B7A99', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</p>
      <p className="font-bold leading-none" style={{ fontSize: '2rem', color: color ?? '#E8E9F0' }}>{value}</p>
      {sub && <p className="text-xs" style={{ color: '#6B7A99' }}>{sub}</p>}
    </div>
  );
}

// Recharts bar chart wrapper with shared dark styling
function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-5" style={{ backgroundColor: '#16171E', border: `1px solid ${B}` }}>
      <p className="text-sm font-semibold mb-4">{title}</p>
      {children}
    </div>
  );
}

// ---- component ----
export function AnalyticsDashboard() {
  const { get } = useApi();
  const [stats,     setStats]     = useState<DecisionStats | null>(null);
  const [decisions, setDecisions] = useState<LogEntry[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      get<DecisionStats>('/api/decisions/stats'),
      get<LogResponse | LogEntry[]>('/api/decisions/log', { page: 1, page_size: 200 }),
    ])
      .then(([s, r]) => {
        setStats(s);
        setDecisions(Array.isArray(r) ? r : (r as LogResponse).decisions ?? []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [get]);

  // Chart 1: count of decisions per action type (from stats.by_action)
  // Guard: by_action may be undefined/null when no decisions exist yet
  const actionData = stats
    ? Object.entries(stats.by_action ?? {}).map(([action, count]) => ({
        action: ACTION_LABEL[action] ?? action, count,
        color: ACTION_COLOR[action] ?? '#4C8BF5',
      }))
    : [];

  // Chart 2: cost summed per final_action (computed from decision log records)
  const costByAction = decisions.reduce<Record<string, number>>((acc, d) => {
    if (d.cost != null) {
      const key = d.final_action ?? d.ai_recommendation;
      acc[key] = (acc[key] ?? 0) + d.cost;
    }
    return acc;
  }, {});
  const costData = Object.entries(costByAction).map(([action, cost]) => ({
    action: ACTION_LABEL[action] ?? action,
    cost: parseFloat(cost.toFixed(2)),
    color: ACTION_COLOR[action] ?? '#4C8BF5',
  }));

  // Override list: decisions where a human changed the AI's recommendation
  const overrides = decisions.filter(d => d.human_override_to);

  // Colour accuracy and cost thresholds
  const accColor = !stats ? '#E8E9F0'
    : stats.accuracy > 0.75 ? '#3EBD8C' : stats.accuracy > 0.5 ? '#E8913A' : '#E5534B';
  const costColor = !stats ? '#E8E9F0'
    : stats.total_cost < 50 ? '#3EBD8C' : stats.total_cost < 200 ? '#E8913A' : '#E5534B';

  const hasData = !loading && !error && stats != null && (stats.total_decisions ?? 0) > 0;

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: '#0E0F14', color: '#E8E9F0' }}>
      {/* Header */}
      <div className="px-6 py-4 border-b flex-shrink-0" style={{ borderColor: B, backgroundColor: '#16171E' }}>
        <h2 className="text-base font-semibold">Analytics Dashboard</h2>
        <p className="text-xs mt-0.5" style={{ color: '#6B7A99' }}>Decision accuracy, cost impact, and override analysis</p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-6">
        {loading && <Centered>Loading…</Centered>}
        {!loading && error && <Centered style={{ color: '#E5534B' }}>Error: {error}</Centered>}
        {!loading && !error && !hasData && (
          <Centered>No experiment data yet — run an experiment first.</Centered>
        )}

        {hasData && stats && (
          <div className="flex flex-col gap-6">

            {/* 3 top stat cards */}
            <div className="grid grid-cols-3 gap-4">
              <StatCard label="Accuracy"
                value={`${(stats.accuracy * 100).toFixed(1)}%`}
                sub={`${stats.correct_decisions} / ${stats.total_decisions} correct`}
                color={accColor} />
              <StatCard label="Total Cost"
                value={`€${stats.total_cost.toFixed(2)}`}
                sub={`${stats.total_decisions} decisions`}
                color={costColor} />
              <StatCard label="Avg Resolution"
                value={fmtDuration(stats.avg_resolution_time_s)}
                sub="per decision" />
            </div>

            {/* Chart 1: Decision distribution */}
            {actionData.length > 0 && (
              <ChartCard title="Decision Distribution">
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={actionData} margin={{ left: 0, right: 16, top: 4, bottom: 4 }}>
                    <XAxis dataKey="action" tick={{ fill: '#6B7A99', fontSize: 12 }}
                      axisLine={{ stroke: B }} tickLine={false} />
                    <YAxis tick={{ fill: '#6B7A99', fontSize: 11 }} axisLine={false}
                      tickLine={false} allowDecimals={false} />
                    <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} contentStyle={TIP_STYLE}
                      formatter={(v) => [v, 'decisions']} />
                    <Bar dataKey="count" maxBarSize={52} radius={[4, 4, 0, 0]}>
                      {actionData.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            )}

            {/* Chart 2: Cost breakdown by action */}
            {costData.length > 0 && (
              <ChartCard title="Cost Breakdown by Action">
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={costData} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                    <XAxis dataKey="action" tick={{ fill: '#6B7A99', fontSize: 12 }}
                      axisLine={{ stroke: B }} tickLine={false} />
                    <YAxis tick={{ fill: '#6B7A99', fontSize: 11 }} axisLine={false}
                      tickLine={false} tickFormatter={v => `€${v}`} />
                    <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} contentStyle={TIP_STYLE}
                      formatter={(v) => [`€${Number(v).toFixed(2)}`, 'cost']} />
                    <Bar dataKey="cost" maxBarSize={52} radius={[4, 4, 0, 0]}>
                      {costData.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            )}

            {/* Override statistics */}
            <div className="rounded-xl p-5" style={{ backgroundColor: '#16171E', border: `1px solid ${B}` }}>
              <div className="flex items-center gap-3 mb-4">
                <p className="text-sm font-semibold">Override Statistics</p>
                <span className="text-xs px-2.5 py-0.5 rounded-full"
                  style={{ backgroundColor: 'rgba(232,145,58,0.15)', color: '#E8913A' }}>
                  {stats.override_count} override{stats.override_count !== 1 ? 's' : ''}
                </span>
                <span className="text-xs" style={{ color: '#6B7A99' }}>
                  {(stats.override_rate * 100).toFixed(1)}% rate
                </span>
              </div>

              {overrides.length === 0
                ? <p className="text-sm" style={{ color: '#6B7080' }}>No human overrides recorded.</p>
                : overrides.slice(0, 5).map(d => (
                    <div key={d.decision_id} className="flex items-center gap-3 text-xs py-2"
                      style={{ borderTop: `1px solid ${B}` }}>
                      <span className="font-mono shrink-0" style={{ color: '#4A4D60' }}>{d.incident_id}</span>
                      <span style={{ color: ACTION_COLOR[d.ai_recommendation] }}>
                        {ACTION_LABEL[d.ai_recommendation] ?? d.ai_recommendation}
                      </span>
                      <span style={{ color: '#4A4D60' }}>→</span>
                      <span style={{ color: ACTION_COLOR[d.human_override_to ?? ''] ?? '#E8E9F0' }}>
                        {ACTION_LABEL[d.human_override_to ?? ''] ?? d.human_override_to}
                      </span>
                      {d.override_reason && (
                        <span className="flex-1 truncate italic" style={{ color: '#6B7A99' }}>
                          "{d.override_reason}"
                        </span>
                      )}
                    </div>
                  ))
              }
            </div>

          </div>
        )}
      </div>
    </div>
  );
}

function Centered({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="h-full flex items-center justify-center text-sm text-center px-8"
      style={{ color: '#6B7080', ...style }}>
      {children}
    </div>
  );
}

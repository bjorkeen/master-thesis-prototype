/**
 * ShapExplainer — horizontal bar chart showing why the AI made its recommendation.
 *
 * Data: GET /api/explain/{incidentId} → ML Service :8001 (via gateway)
 * Props: incidentId — the incident selected in IncidentQueue (null = no selection)
 *
 * Chart layout: layout="vertical" in Recharts makes bars run horizontally.
 *   - X-axis = SHAP value (numeric, can be negative)
 *   - Y-axis = feature names
 *   - Red bars extend RIGHT  → feature pushes TOWARD the predicted class
 *   - Blue bars extend LEFT  → feature pushes AWAY from the predicted class
 *   - ReferenceLine at x=0  → the natural dividing line between +/–
 */
import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Cell,
  ReferenceLine, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import type { ShapExplanation } from '../types';

// Internal shape after zipping the three parallel arrays from the API
interface ShapFeatureValue {
  feature: string;
  value: number;
  display: string;
}

export interface Props { incidentId: string | null; }

// Palette
const POS = '#E5534B';   // red  — positive SHAP (pushes toward class)
const NEG = '#4C8BF5';   // blue — negative SHAP (pushes away)
const B   = '#2A2B38';   // border colour

const REC_COLOR: Record<string, string> = {
  escalate: '#E8913A', critical: '#E5534B', auto_resolve: '#3EBD8C',
};

// ---- helpers ----

// Small labelled stat strip shown above the chart
function Chip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ borderLeft: `2px solid ${B}`, paddingLeft: 10 }}>
      <div className="text-xs" style={{ color: '#6B7A99' }}>{label}</div>
      <div className="text-sm font-semibold capitalize" style={{ color }}>{value}</div>
    </div>
  );
}

// Custom Y-axis tick — keeps long feature names readable
function YTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={11} fill="#B0B3C6">
      {payload?.value}
    </text>
  );
}

// ---- component ----
export function ShapExplainer({ incidentId }: Props) {
  const { get } = useApi();
  const [expl,    setExpl]    = useState<ShapExplanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // Fetch whenever the selected incident changes
  useEffect(() => {
    if (!incidentId) { setExpl(null); return; }
    setLoading(true); setError(null);
    get<ShapExplanation>(`/api/explain/${incidentId}`)
      .then(setExpl)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [incidentId, get]);

  // Zip the three parallel arrays the API returns into [{feature, value, display}]
  // then sort by |SHAP value| so the most impactful features appear at the top.
  const sorted: ShapFeatureValue[] = (() => {
    if (!expl) return [];
    const names  = expl.feature_names  ?? [];
    const values = expl.shap_values    ?? [];
    const featureVals = expl.feature_values ?? [];
    return values
      .map((v, i) => ({
        feature: names[i] ?? `feature_${i}`,
        value:   v,
        display: String(featureVals[i] ?? '—'),
      }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  })();

  // Recharts expects an array of plain objects
  const chartData = sorted.map(sv => ({
    name:    sv.feature.replace(/_/g, ' '),
    value:   sv.value,
    display: sv.display,
  }));

  // Give each bar 40 px of height so labels don't overlap
  const chartH = Math.max(200, chartData.length * 42);

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: '#0E0F14', color: '#E8E9F0' }}>

      {/* Header */}
      <div className="px-6 py-4 border-b flex-shrink-0" style={{ borderColor: B, backgroundColor: '#16171E' }}>
        <h2 className="text-base font-semibold">AI Explanation (SHAP)</h2>
        <p className="text-xs mt-0.5" style={{ color: '#6B7A99' }}>Feature contributions for the selected incident</p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-5">

        {/* Empty state */}
        {!incidentId && (
          <div className="h-full flex items-center justify-center text-sm text-center px-8" style={{ color: '#6B7080' }}>
            Select an incident from the queue to see its AI explanation.
          </div>
        )}

        {incidentId && loading && (
          <div className="h-full flex items-center justify-center text-sm" style={{ color: '#6B7080' }}>Loading explanation…</div>
        )}

        {incidentId && !loading && error && (
          <div className="h-full flex items-center justify-center text-sm" style={{ color: '#E5534B' }}>Error: {error}</div>
        )}

        {expl && !loading && (
          <>
            {/* Summary chips */}
            <div className="flex flex-wrap gap-5 mb-6">
              <Chip label="Predicted"  value={(expl.predicted_class ?? '—').replace(/_/g, ' ')}
                color={REC_COLOR[expl.predicted_class ?? ''] ?? '#4C8BF5'} />
              <Chip label="Explaining" value={(expl.explained_class ?? '—').replace(/_/g, ' ')}
                color="#B0B3C6" />
              <Chip label="Base value" value={expl.base_value != null ? expl.base_value.toFixed(3) : '—'}
                color="#B0B3C6" />
            </div>

            {/* Bar chart */}
            <div className="rounded-xl p-4 mb-5" style={{ backgroundColor: '#16171E', border: `1px solid ${B}` }}>
              {/* Legend */}
              <div className="flex gap-4 mb-3 text-xs" style={{ color: '#6B7A99' }}>
                <span><span style={{ color: POS }}>■</span> pushes toward class</span>
                <span><span style={{ color: NEG }}>■</span> pushes away</span>
              </div>

              {/*
                ResponsiveContainer fills the parent width automatically.
                layout="vertical" rotates the chart so bars run left↔right.
                XAxis type="number" carries the SHAP float values.
                YAxis type="category" carries the feature name strings.
                ReferenceLine x={0} draws the zero divider.
                Each bar is coloured via <Cell> based on whether value ≥ 0.
              */}
              <ResponsiveContainer width="100%" height={chartH}>
                <BarChart data={chartData} layout="vertical"
                  margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                  <XAxis type="number" tick={{ fill: '#6B7A99', fontSize: 11 }}
                    axisLine={{ stroke: B }} tickLine={false}
                    tickFormatter={v => v.toFixed(2)} />
                  <YAxis type="category" dataKey="name" width={140}
                    tick={<YTick />} axisLine={false} tickLine={false} />
                  <ReferenceLine x={0} stroke={B} strokeWidth={1.5} />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                    contentStyle={{ backgroundColor: '#16171E', border: `1px solid ${B}`, borderRadius: 8, fontSize: 12 }}
                    formatter={(val) => [Number(val).toFixed(4), 'SHAP value']}
                  />
                  <Bar dataKey="value" maxBarSize={22} radius={[0, 3, 3, 0]}>
                    {chartData.map((entry, i) => (
                      <Cell key={i} fill={entry.value >= 0 ? POS : NEG} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Feature value table */}
            <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${B}` }}>
              <table className="w-full text-sm">
                <thead style={{ backgroundColor: '#16171E' }}>
                  <tr>
                    {['Feature', 'Value', 'SHAP'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide"
                        style={{ color: '#6B7A99', borderBottom: `1px solid ${B}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((sv, i) => (
                    <tr key={i} style={{ borderBottom: i < sorted.length - 1 ? `1px solid ${B}` : 'none' }}>
                      <td className="px-4 py-2" style={{ color: '#E8E9F0' }}>{sv.feature.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-2 font-mono text-xs" style={{ color: '#B0B3C6' }}>{sv.display}</td>
                      <td className="px-4 py-2 font-mono text-xs tabular-nums"
                        style={{ color: sv.value >= 0 ? POS : NEG }}>
                        {sv.value >= 0 ? '+' : ''}{sv.value.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

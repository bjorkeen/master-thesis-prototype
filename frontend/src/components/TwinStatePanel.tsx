/**
 * TwinStatePanel — real-time Digital Twin pipeline metrics dashboard.
 * Data arrives via WebSocket (gateway polls Twin Service every 5 s).
 * Props: twinState — latest state object, connected — WebSocket liveness.
 */
import type { TwinState } from '../types';

interface Props { twinState: TwinState | null; connected: boolean; }

const B  = '#2A2B38';
const G  = '#3EBD8C';   // green
const OR = '#E8913A';   // orange
const RD = '#E5534B';   // red
const YL = '#F0C040';   // yellow

// Total SLA window assumed to be 30 minutes (1800 s).
// The Twin Service tracks remaining seconds; we compute % consumed.
const SLA_TOTAL_S = 1800;

// Format seconds as "Xm Ys"
function fmtSla(s: number): string {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  return `${m}m ${sec}s`;
}

// Clamp a value between 0–100 for progress bars
function clamp(v: number): number { return Math.min(100, Math.max(0, v)); }

// ---- sub-components ----

// Thin coloured progress bar
function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ height: 4, backgroundColor: '#2A2B38', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${clamp(pct)}%`, height: '100%', backgroundColor: color, borderRadius: 2,
                    transition: 'width 0.6s ease, background-color 0.4s ease' }} />
    </div>
  );
}

// Large metric card: title, big number, optional unit, progress bar
function MetricCard({ title, value, unit, barPct, barColor }: {
  title: string; value: string | number; unit?: string; barPct: number; barColor: string;
}) {
  return (
    <div className="rounded-xl p-5 flex flex-col gap-3"
      style={{ backgroundColor: '#16171E', border: `1px solid ${B}` }}>
      <p style={{ fontSize: '0.65rem', color: '#6B7A99', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {title}
      </p>
      <p className="font-bold leading-none" style={{ fontSize: '1.8rem', color: '#E8E9F0' }}>
        {value}
        {unit && <span style={{ fontSize: '0.85rem', color: '#6B7A99', marginLeft: 4 }}>{unit}</span>}
      </p>
      <Bar pct={barPct} color={barColor} />
    </div>
  );
}

// Small pill showing a count or label
function StatPill({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg px-4 py-3 gap-1"
      style={{ backgroundColor: '#16171E', border: `1px solid ${B}` }}>
      <span style={{ fontSize: '0.65rem', color: '#6B7A99', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      <span className="font-semibold text-sm" style={{ color: color ?? '#E8E9F0' }}>{value}</span>
    </div>
  );
}

// ---- main component ----
export function TwinStatePanel({ twinState: ts, connected }: Props) {
  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: '#0E0F14', color: '#E8E9F0' }}>

      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b flex-shrink-0"
        style={{ borderColor: B, backgroundColor: '#16171E' }}>
        <h2 className="text-base font-semibold">Digital Twin State</h2>
        <div className="flex-1" />
        {/* Live / disconnected indicator */}
        <span className="flex items-center gap-1.5 text-xs font-semibold"
          style={{ color: connected ? G : '#6B7080' }}>
          <span style={{ fontSize: '0.6rem' }}>{connected ? '●' : '○'}</span>
          {connected ? 'LIVE' : 'DISCONNECTED'}
        </span>
        {ts?.timestamp && (
          <span className="text-xs" style={{ color: '#4A4D60' }}>
            {new Date(ts.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-6">

        {/* Null state */}
        {!ts && (
          <div className="h-full flex items-center justify-center text-sm" style={{ color: '#6B7080' }}>
            Waiting for twin state data…
          </div>
        )}

        {ts && (
          <div className="flex flex-col gap-5">

            {/* 2×2 metric card grid */}
            <div className="grid grid-cols-2 gap-4">

              {/* Queue Depth — orange > 15, red > 25 */}
              <MetricCard
                title="Queue Depth"
                value={ts.queue_depth}
                barPct={(ts.queue_depth / 30) * 100}
                barColor={ts.queue_depth > 25 ? RD : ts.queue_depth > 15 ? OR : G}
              />

              {/* Throughput — always green, max reference 100/hr */}
              <MetricCard
                title="Throughput"
                value={ts.throughput_per_hour.toFixed(1)}
                unit="/hr"
                barPct={(ts.throughput_per_hour / 100) * 100}
                barColor={G}
              />

              {/* Analyst Load — green < 50%, orange 50-75%, red > 75% */}
              <MetricCard
                title="Analyst Load"
                value={ts.analyst_workload_pct.toFixed(0)}
                unit="%"
                barPct={ts.analyst_workload_pct}
                barColor={ts.analyst_workload_pct > 75 ? RD : ts.analyst_workload_pct > 50 ? OR : G}
              />

              {/* SLA Health — bar depletes as time runs out */}
              {(() => {
                const usedPct = clamp(100 - (ts.sla_remaining_s / SLA_TOTAL_S) * 100);
                const slaColor = usedPct > 80 ? RD : usedPct > 50 ? YL : G;
                return (
                  <MetricCard
                    title="SLA Health"
                    value={fmtSla(ts.sla_remaining_s)}
                    barPct={usedPct}
                    barColor={slaColor}
                  />
                );
              })()}
            </div>

            {/* Stat pills row */}
            <div className="grid grid-cols-4 gap-3">
              <StatPill label="Open"     value={ts.open_incidents}  />
              <StatPill label="Critical" value={ts.open_critical}   color={ts.open_critical  > 0 ? RD : undefined} />
              <StatPill label="Escalated"value={ts.open_escalated}  color={ts.open_escalated > 0 ? OR : undefined} />
              <StatPill label="Auto Rate"value={`${(ts.auto_resolve_rate * 100).toFixed(0)}%`} color={G} />
            </div>

          </div>
        )}
      </div>
    </div>
  );
}

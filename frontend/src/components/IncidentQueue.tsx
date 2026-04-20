/**
 * IncidentQueue — live table of decision log entries.
 * Data: GET /api/decisions/log → Decision Service :8003
 * Props: onSelect(incidentId) — called when a row is clicked.
 */
import { useEffect, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import type { Decision } from '../types';

// The log endpoint flattens incident_features into the top-level doc, but we
// also keep incident_features as a typed fallback for robustness.
interface IncidentFeatures {
  anomaly_type?: string;
  affected_records_pct?: number;
  data_source?: string;
  pipeline_stage?: string;
}

interface LogEntry extends Decision {
  // Top-level fields (flattened by the backend from incident_features)
  anomaly_type?: string;
  affected_records_pct?: number;
  data_source?: string;
  pipeline_stage?: string;
  // Nested original — used as fallback if top-level is missing
  incident_features?: IncidentFeatures;
}

interface LogResponse { decisions: LogEntry[]; total: number; }

export interface Props { onSelect?: (id: string) => void; }

// ---- pure helpers ----

// Row background tint by AI recommendation severity
const TINT: Record<string, string> = {
  critical:     'rgba(229,83,75,0.09)',
  escalate:     'rgba(232,145,58,0.09)',
  auto_resolve: 'rgba(62,189,140,0.06)',
};

// Dot / badge colours
const COLOR: Record<string, string> = {
  critical:     '#E5534B',
  escalate:     '#E8913A',
  auto_resolve: '#3EBD8C',
};

const LABEL: Record<string, string> = {
  auto_resolve: 'Auto', escalate: 'Escalate', critical: 'Critical',
};

const MODE_COLOR: Record<string, string> = {
  ai_only: '#4C8BF5', human_only: '#E8913A', hitl: '#3EBD8C',
};

/**
 * An incident is PENDING human review when:
 *  - human_action is null (analyst hasn't acted yet)
 *  - routing_action is not auto_resolve (AI didn't close it automatically)
 *  - mode is hitl or human_only (ai_only incidents are never pending)
 */
function isPending(entry: LogEntry): boolean {
  return (
    entry.human_action == null &&
    entry.routing_action !== 'auto_resolve' &&
    (entry.experiment_mode === 'hitl' || entry.experiment_mode === 'human_only')
  );
}

// Yellow "PENDING" pill shown instead of the action badge for unreviewed incidents
function PendingBadge() {
  return (
    <span style={{ color: '#E8913A', borderColor: '#E8913A', backgroundColor: 'rgba(232,145,58,0.15)' }}
      className="px-2 py-0.5 rounded text-xs font-semibold border whitespace-nowrap">
      PENDING
    </span>
  );
}

// Small coloured pill for the AI recommendation (used for decided/auto-resolved rows)
function Badge({ value }: { value: string }) {
  const c = COLOR[value] ?? '#4C8BF5';
  return (
    <span style={{ color: c, borderColor: c, backgroundColor: `${c}22` }}
      className="px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap">
      {LABEL[value] ?? value}
    </span>
  );
}

// Experiment mode indicator shown in the header
function ModePill({ mode }: { mode: string }) {
  const c = MODE_COLOR[mode] ?? '#6B7080';
  return (
    <span style={{ color: c, backgroundColor: `${c}20`, borderColor: c }}
      className="px-2.5 py-0.5 rounded-full text-xs font-semibold border">
      {mode.replace(/_/g, '-').toUpperCase()}
    </span>
  );
}

// Read a feature field: try top-level first (backend flattening), fall back to nested
function feat(entry: LogEntry, key: keyof IncidentFeatures): string | number | undefined {
  return (entry as unknown as Record<string, string | number | undefined>)[key]
    ?? entry.incident_features?.[key];
}

// ---- component ----
export function IncidentQueue({ onSelect }: Props) {
  const { get } = useApi();
  const [entries,    setEntries]    = useState<LogEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  function fetchEntries(showSpinner = false) {
    if (showSpinner) setRefreshing(true);
    get<LogResponse | LogEntry[]>('/api/decisions/log', { page: 1, page_size: 200 })
      .then(r => {
        setEntries(Array.isArray(r) ? r : (r as LogResponse).decisions ?? []);
        setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }

  // Initial load + poll every 5 s so the queue stays fresh during a batch run
  useEffect(() => {
    fetchEntries();
    const id = setInterval(() => fetchEntries(), 5000);
    return () => clearInterval(id);
  }, [get]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingCount = entries.filter(isPending).length;
  const mode         = entries[0]?.experiment_mode;

  function select(entry: LogEntry) {
    setSelectedId(entry.incident_id);
    onSelect?.(entry.incident_id);
  }

  const B = '#2A2B38';

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: '#0E0F14', color: '#E8E9F0' }}>

      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b flex-shrink-0"
        style={{ borderColor: B, backgroundColor: '#16171E' }}>
        <h2 className="text-base font-semibold">Incident Queue</h2>

        {/* Pending review counter */}
        {pendingCount > 0 && (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium"
            style={{ backgroundColor: 'rgba(232,145,58,0.15)', color: '#E8913A' }}>
            <AlertCircle size={11} />{pendingCount} need review
          </span>
        )}

        <div className="flex-1" />
        {mode && <ModePill mode={mode} />}

        {/* Manual refresh button */}
        <button onClick={() => fetchEntries(true)} title="Refresh"
          className="p-1.5 rounded-lg transition-colors"
          style={{ color: refreshing ? '#4C8BF5' : '#6B7A99' }}>
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* States */}
      {loading && (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: '#6B7080' }}>
          Loading…
        </div>
      )}
      {!loading && error && (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: '#E5534B' }}>
          Error: {error}
        </div>
      )}
      {!loading && !error && entries.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: '#6B7080' }}>
          No decisions logged — start an experiment and run incidents to populate the queue.
        </div>
      )}

      {/* Table */}
      {!loading && !error && entries.length > 0 && (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10" style={{ backgroundColor: '#16171E' }}>
              <tr>
                {['', 'Incident ID', 'Anomaly', 'Affected %', 'Source', 'Stage', 'Confidence', 'Status'].map((h, i) => (
                  <th key={i}
                    className="px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide whitespace-nowrap border-b"
                    style={{ color: '#6B7A99', borderColor: B }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => {
                const pending = isPending(entry);
                const sel     = selectedId === entry.incident_id;
                const tc      = { borderColor: B };

                // Feature values — top-level (flattened) with nested fallback
                const anomalyType       = feat(entry, 'anomaly_type') as string | undefined;
                const affectedPct       = feat(entry, 'affected_records_pct') as number | undefined;
                const dataSource        = feat(entry, 'data_source') as string | undefined;
                const pipelineStage     = feat(entry, 'pipeline_stage') as string | undefined;

                return (
                  <tr key={entry.decision_id} onClick={() => select(entry)}
                    className="cursor-pointer"
                    style={{
                      backgroundColor: sel
                        ? 'rgba(76,139,245,0.15)'
                        : pending
                        ? 'rgba(232,145,58,0.05)'   // subtle amber tint for pending rows
                        : TINT[entry.ai_recommendation],
                      outline:       sel ? '1px solid rgba(76,139,245,0.4)' : 'none',
                      outlineOffset: '-1px',
                    }}>

                    {/* Severity dot — amber for pending, else action colour */}
                    <td className="px-3 py-2.5 border-b w-8" style={tc}>
                      <span className="block w-2 h-2 rounded-full" style={{
                        backgroundColor: pending
                          ? '#E8913A'
                          : (COLOR[entry.ai_recommendation] ?? '#6B7080'),
                      }} />
                    </td>

                    {/* Incident ID */}
                    <td className="px-3 py-2.5 border-b font-mono text-xs max-w-36 truncate" style={tc}>
                      {entry.incident_id}
                    </td>

                    {/* Anomaly type */}
                    <td className="px-3 py-2.5 border-b" style={{ ...tc, color: '#B0B3C6' }}>
                      {anomalyType?.replace(/_/g, ' ') ?? '—'}
                    </td>

                    {/* Affected % */}
                    <td className="px-3 py-2.5 border-b text-right tabular-nums" style={{ ...tc, color: '#B0B3C6' }}>
                      {affectedPct != null ? `${Number(affectedPct).toFixed(1)}%` : '—'}
                    </td>

                    {/* Source */}
                    <td className="px-3 py-2.5 border-b" style={{ ...tc, color: '#B0B3C6' }}>
                      {dataSource?.replace(/_/g, ' ') ?? '—'}
                    </td>

                    {/* Stage */}
                    <td className="px-3 py-2.5 border-b" style={{ ...tc, color: '#B0B3C6' }}>
                      {pipelineStage ?? '—'}
                    </td>

                    {/* Confidence */}
                    <td className="px-3 py-2.5 border-b tabular-nums" style={{ ...tc, color: '#B0B3C6' }}>
                      {(entry.ai_confidence * 100).toFixed(0)}%
                    </td>

                    {/* Status badge — PENDING or action badge */}
                    <td className="px-3 py-2.5 border-b" style={tc}>
                      {pending
                        ? <PendingBadge />
                        : <Badge value={entry.ai_recommendation} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      {entries.length > 0 && (
        <div className="px-6 py-2 text-xs border-t flex items-center gap-3 flex-shrink-0"
          style={{ color: '#6B7A99', borderColor: B, backgroundColor: '#16171E' }}>
          <span>{entries.length} decision{entries.length !== 1 ? 's' : ''}</span>
          {pendingCount > 0 && (
            <span style={{ color: '#E8913A' }}>{pendingCount} pending review</span>
          )}
          {selectedId && (
            <span>Selected: <span className="font-mono" style={{ color: '#4C8BF5' }}>{selectedId}</span></span>
          )}
        </div>
      )}
    </div>
  );
}

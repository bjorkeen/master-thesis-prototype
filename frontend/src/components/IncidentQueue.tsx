/**
 * IncidentQueue — live table of decision log entries.
 * Data: GET /api/decisions/log → Decision Service :8003
 * Props: onSelect(incidentId) — called when a row is clicked.
 */
import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import type { Decision } from '../types';

// The log endpoint may embed incident feature fields alongside the decision
interface LogEntry extends Decision {
  anomaly_type?: string;
  affected_records_pct?: number;
  data_source?: string;
  pipeline_stage?: string;
}
interface LogResponse { decisions: LogEntry[]; total: number; }

export interface Props { onSelect?: (id: string) => void; }

// ---- pure helpers ----

// Row background tint by severity
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
  send_to_human: 'Human', critical_alert: 'Alert',
};

const MODE_COLOR: Record<string, string> = {
  ai_only: '#4C8BF5', human_only: '#E8913A', hitl: '#3EBD8C',
};

// Small coloured pill for the AI recommendation
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

// ---- component ----
export function IncidentQueue({ onSelect }: Props) {
  const { get } = useApi();   // destructure for a stable reference in useEffect deps
  const [entries,    setEntries]    = useState<LogEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    get<LogResponse | LogEntry[]>('/api/decisions/log', { page: 1, page_size: 50 })
      .then(r => setEntries(Array.isArray(r) ? r : (r as LogResponse).decisions ?? []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [get]);

  const escalated = entries.filter(e => e.ai_recommendation === 'escalate').length;
  const mode      = entries[0]?.experiment_mode;

  function select(entry: LogEntry) {
    setSelectedId(entry.incident_id);
    onSelect?.(entry.incident_id);
  }

  const B = '#2A2B38';   // border colour shorthand

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: '#0E0F14', color: '#E8E9F0' }}>

      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b flex-shrink-0"
        style={{ borderColor: B, backgroundColor: '#16171E' }}>
        <h2 className="text-base font-semibold">Incident Queue</h2>
        {escalated > 0 && (
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium"
            style={{ backgroundColor: 'rgba(232,145,58,0.15)', color: '#E8913A' }}>
            <AlertCircle size={11} />{escalated} need review
          </span>
        )}
        <div className="flex-1" />
        {mode && <ModePill mode={mode} />}
      </div>

      {/* States */}
      {loading && <div className="flex-1 flex items-center justify-center text-sm" style={{ color: '#6B7080' }}>Loading…</div>}
      {!loading && error && <div className="flex-1 flex items-center justify-center text-sm" style={{ color: '#E5534B' }}>Error: {error}</div>}
      {!loading && !error && entries.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: '#6B7080' }}>
          No decisions logged — start an experiment to populate the queue.
        </div>
      )}

      {/* Table */}
      {!loading && !error && entries.length > 0 && (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10" style={{ backgroundColor: '#16171E' }}>
              <tr>
                {['', 'Incident ID', 'Anomaly', 'Affected %', 'Source', 'Stage', 'Confidence', 'Action'].map((h, i) => (
                  <th key={i} className="px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide whitespace-nowrap border-b"
                    style={{ color: '#6B7A99', borderColor: B }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => {
                const sel = selectedId === entry.incident_id;
                const tc  = { borderColor: B };             // table cell border style
                return (
                  <tr key={entry.decision_id} onClick={() => select(entry)}
                    className="cursor-pointer"
                    style={{
                      backgroundColor: sel ? 'rgba(76,139,245,0.15)' : TINT[entry.ai_recommendation],
                      outline: sel ? '1px solid rgba(76,139,245,0.4)' : 'none',
                      outlineOffset: '-1px',
                    }}>
                    {/* Severity dot */}
                    <td className="px-3 py-2.5 border-b w-8" style={tc}>
                      <span className="block w-2 h-2 rounded-full"
                        style={{ backgroundColor: COLOR[entry.ai_recommendation] ?? '#6B7080' }} />
                    </td>
                    {/* Incident ID */}
                    <td className="px-3 py-2.5 border-b font-mono text-xs max-w-36 truncate" style={tc}>{entry.incident_id}</td>
                    {/* Anomaly type */}
                    <td className="px-3 py-2.5 border-b" style={{ ...tc, color: '#B0B3C6' }}>{entry.anomaly_type?.replace(/_/g, ' ') ?? '—'}</td>
                    {/* Affected % */}
                    <td className="px-3 py-2.5 border-b text-right tabular-nums" style={{ ...tc, color: '#B0B3C6' }}>
                      {entry.affected_records_pct != null ? `${entry.affected_records_pct.toFixed(1)}%` : '—'}
                    </td>
                    {/* Source */}
                    <td className="px-3 py-2.5 border-b" style={{ ...tc, color: '#B0B3C6' }}>{entry.data_source?.replace(/_/g, ' ') ?? '—'}</td>
                    {/* Stage */}
                    <td className="px-3 py-2.5 border-b" style={{ ...tc, color: '#B0B3C6' }}>{entry.pipeline_stage ?? '—'}</td>
                    {/* Confidence */}
                    <td className="px-3 py-2.5 border-b tabular-nums" style={{ ...tc, color: '#B0B3C6' }}>
                      {(entry.ai_confidence * 100).toFixed(0)}%
                    </td>
                    {/* Badge */}
                    <td className="px-3 py-2.5 border-b" style={tc}><Badge value={entry.ai_recommendation} /></td>
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
          {selectedId && <span>Selected: <span className="font-mono" style={{ color: '#4C8BF5' }}>{selectedId}</span></span>}
        </div>
      )}
    </div>
  );
}

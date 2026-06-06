/**
 * IncidentQueue — live table of decision log entries.
 * Data: GET /api/decisions/log → Decision Service :8003
 * Props: onSelect(incidentId) — called when a row is clicked.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Info, RefreshCw, X } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { DecisionPanel } from './DecisionPanel';
import { ShapExplainer } from './ShapExplainer';
import type { Decision, DecisionStats } from '../types';

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

export interface Props {
  onSelect?: (id: string) => void;
  /**
   * Whether an experiment is currently active. The decision log (and its run_id)
   * is kept on the backend after an experiment stops so results can still be
   * exported — so we cannot rely on run_id alone to know the queue is "done".
   * When this is false we clear the table and show an empty state instead of
   * lingering on the finished run's incidents. Defaults to true so the queue
   * behaves normally if the flag is ever omitted.
   */
  experimentActive?: boolean;
}

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

function ReviewedBadge() {
  return (
    <span style={{ color: '#6B7080', borderColor: '#6B7080', backgroundColor: 'rgba(107,112,128,0.12)' }}
      className="px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap">
      REVIEWED
    </span>
  );
}

// Small coloured pill — used for routing column and for decided rows (AI recommendation)
function Badge({ value }: { value: string }) {
  const c = COLOR[value] ?? '#4C8BF5';
  return (
    <span style={{ color: c, borderColor: c, backgroundColor: `${c}22` }}
      className="px-2 py-0.5 rounded text-xs font-semibold border whitespace-nowrap">
      {LABEL[value] ?? value.replace(/_/g, ' ')}
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

/** Column keys used for client-side sorting (null = dot column, not sortable). */
type SortColumn =
  | 'incident_id'
  | 'anomaly'
  | 'affected'
  | 'source'
  | 'stage'
  | 'confidence'
  | 'routing'
  | 'status';

// Plain-language hint shown when the user hovers the ⓘ icon next to a column header.
const COLUMN_TOOLTIPS: Record<SortColumn, string> = {
  incident_id: 'Unique identifier for this data quality incident',
  anomaly:     'What kind of data quality problem was detected: null_values, duplicates, schema_mismatch, outlier, referential_integrity, data_corruption',
  affected:    'What percentage of records in the dataset are affected — higher means more impactful',
  source:      'Where the data came from: crm, erp, api_feed, manual_entry, iot_stream, data_warehouse',
  stage:       'Where in the pipeline the anomaly was caught: ingestion, transformation, validation, loading, serving — later stages are more concerning',
  confidence:  'How certain the AI model is about its prediction, as a percentage — lower confidence means more uncertainty',
  routing:     'How the system routed this incident: Auto (high confidence), Escalate (uncertain), Critical (very uncertain or high risk)',
  status:      'Whether this incident has been reviewed — PENDING means it needs your action, REVIEWED means a decision was made',
};

// Small ⓘ icon + CSS-only hover tooltip. Lives inside the header next to the
// sortable label; its own click is swallowed so it never triggers sort.
function HeaderTooltip({ text }: { text: string }) {
  return (
    <span
      className="relative inline-flex items-center group ml-1.5 align-middle"
      onClick={(e) => e.stopPropagation()}
    >
      <Info size={11} style={{ color: '#6B7A99', opacity: 0.55 }} />
      <span
        className="hidden group-hover:block absolute left-1/2 -translate-x-1/2 top-full mt-2
                   px-3 py-2 rounded text-xs font-normal normal-case tracking-normal
                   pointer-events-none"
        style={{
          backgroundColor: '#1E1F2A',
          color: '#E8E9F0',
          border: '1px solid #2A2B38',
          maxWidth: 250,
          width: 'max-content',
          whiteSpace: 'normal',
          lineHeight: 1.4,
          zIndex: 50,
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}
      >
        {text}
      </span>
    </span>
  );
}

const ROUTING_ORDER: Record<string, number> = {
  auto_resolve: 0,
  escalate: 1,
  critical: 2,
};

/** Lower = appears first when sortDir === 'asc'. */
function statusSortKey(entry: LogEntry): number {
  if (isPending(entry)) return 0;
  if (entry.experiment_mode === 'human_only') return 1;
  return 2;
}

function compareEntries(a: LogEntry, b: LogEntry, col: SortColumn, dir: 'asc' | 'desc'): number {
  const inv = dir === 'asc' ? 1 : -1;
  const tie = (a.decision_id ?? '').localeCompare(b.decision_id ?? '');

  const str = (v: string | number | undefined) =>
    (v === undefined || v === null ? '' : String(v)).toLowerCase();

  let cmp = 0;
  switch (col) {
    case 'incident_id':
      cmp = a.incident_id.localeCompare(b.incident_id);
      break;
    case 'anomaly':
      cmp = str(feat(a, 'anomaly_type')).localeCompare(str(feat(b, 'anomaly_type')));
      break;
    case 'affected': {
      const na = Number(feat(a, 'affected_records_pct'));
      const nb = Number(feat(b, 'affected_records_pct'));
      cmp = (Number.isFinite(na) ? na : -1) - (Number.isFinite(nb) ? nb : -1);
      break;
    }
    case 'source':
      cmp = str(feat(a, 'data_source')).localeCompare(str(feat(b, 'data_source')));
      break;
    case 'stage':
      cmp = str(feat(a, 'pipeline_stage')).localeCompare(str(feat(b, 'pipeline_stage')));
      break;
    case 'confidence': {
      const ca = a.experiment_mode === 'human_only' || a.ai_confidence == null ? -1 : a.ai_confidence;
      const cb = b.experiment_mode === 'human_only' || b.ai_confidence == null ? -1 : b.ai_confidence;
      cmp = ca - cb;
      break;
    }
    case 'routing': {
      const ra = ROUTING_ORDER[a.routing_action] ?? 99;
      const rb = ROUTING_ORDER[b.routing_action] ?? 99;
      cmp = ra - rb;
      break;
    }
    case 'status':
      cmp = statusSortKey(a) - statusSortKey(b);
      break;
    default:
      cmp = 0;
  }
  if (cmp !== 0) return cmp * inv;
  return tie;
}

// ---- component ----
export function IncidentQueue({ onSelect, experimentActive = true }: Props) {
  const { get } = useApi();
  const [entries,    setEntries]    = useState<LogEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIncidentId, setExpandedIncidentId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDir,    setSortDir]    = useState<'asc' | 'desc'>('asc');

  function fetchEntries(showSpinner = false) {
    // No active experiment → empty the queue. The backend still holds the last
    // run's decisions (for export), so without this guard the queue would keep
    // showing the finished run's incidents after a (force) stop.
    if (experimentActive === false) {
      setEntries([]);
      setError(null);
      setLoading(false);
      setRefreshing(false);
      // Drop any inline expansion / row selection so a stale detail panel can't
      // linger once the table is cleared.
      setExpandedIncidentId(null);
      setSelectedId(null);
      return;
    }
    if (showSpinner) setRefreshing(true);
    get<DecisionStats>('/api/decisions/stats')
      .then((stats) => {
        if (!stats.run_id) {
          setEntries([]);
          return null;
        }
        return get<LogResponse | LogEntry[]>('/api/decisions/log', {
          page: 1, page_size: 1000, run_id: stats.run_id,
        });
      })
      .then((r) => {
        if (!r) return;
        setEntries(Array.isArray(r) ? r : (r as LogResponse).decisions ?? []);
        setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }

  // Initial load + poll every 5 s so the queue stays fresh during a batch run.
  // Re-runs when experimentActive flips so stopping a run empties the queue at
  // once (and starting a new one resumes polling).
  useEffect(() => {
    fetchEntries();
    const id = setInterval(() => fetchEntries(), 5000);
    return () => clearInterval(id);
  }, [get, experimentActive]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingCount = entries.filter(isPending).length;
  const mode         = entries[0]?.experiment_mode;

  // Progress tracking for HITL / human_only modes
  const reviewableEntries = entries.filter(e =>
    e.routing_action !== 'auto_resolve' &&
    (e.experiment_mode === 'hitl' || e.experiment_mode === 'human_only')
  );
  const reviewableCount = reviewableEntries.length;
  const reviewedCount   = reviewableCount - pendingCount;
  const reviewPct       = reviewableCount > 0 ? Math.round((reviewedCount / reviewableCount) * 100) : 0;
  const showProgress    = reviewableCount > 0;

  const sortedEntries = useMemo(() => {
    if (!sortColumn) return entries;
    return [...entries].sort((a, b) => compareEntries(a, b, sortColumn, sortDir));
  }, [entries, sortColumn, sortDir]);

  function toggleSort(col: SortColumn) {
    if (sortColumn === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortColumn(col);
      setSortDir('asc');
    }
  }

  // Clicking a row selects it (for the sidebar panels) and, in the human-review
  // modes, toggles the inline detail panel below the row. ai_only rows never
  // expand — there is nothing for a human to act on.
  function handleRowClick(entry: LogEntry) {
    setSelectedId(entry.incident_id);
    onSelect?.(entry.incident_id);

    const canExpand =
      entry.experiment_mode === 'hitl' || entry.experiment_mode === 'human_only';
    if (!canExpand) return;

    setExpandedIncidentId(prev =>
      prev === entry.incident_id ? null : entry.incident_id,
    );
  }

  // Called by the inline DecisionPanel after a successful Accept / Override:
  //  1. refresh the log so the acted row flips to REVIEWED
  //  2. auto-expand the next pending incident (in display order, wrapping round)
  function handleActionComplete(completedId: string) {
    const order = sortedEntries;
    const startIdx = order.findIndex(e => e.incident_id === completedId);

    let next: string | null = null;
    if (startIdx !== -1) {
      for (let i = 1; i <= order.length; i++) {
        const cand = order[(startIdx + i) % order.length];
        if (cand.incident_id !== completedId && isPending(cand)) {
          next = cand.incident_id;
          break;
        }
      }
    }

    setExpandedIncidentId(next);
    if (next) {
      setSelectedId(next);
      onSelect?.(next);
    }
    fetchEntries();   // update the just-acted row's badge to REVIEWED
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

      {/* Progress indicator — visible in HITL / human_only modes with pending incidents */}
      {showProgress && (
        <div className="px-6 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${B}`, backgroundColor: '#16171E' }}>
          <p className="text-xs mb-2" style={{ color: '#6B7A99' }}>
            Showing {reviewableCount} incident{reviewableCount !== 1 ? 's' : ''} requiring review
            {' · '}
            <span style={{ color: '#3EBD8C' }}>{reviewedCount} reviewed</span>
            {' · '}
            <span style={{ color: '#E8913A' }}>{pendingCount} remaining</span>
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-full overflow-hidden" style={{ height: 5, backgroundColor: '#0E0F14' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${reviewPct}%`, backgroundColor: '#3EBD8C' }}
              />
            </div>
            <span className="text-xs tabular-nums shrink-0" style={{ color: '#6B7A99' }}>{reviewPct}%</span>
          </div>
        </div>
      )}

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
        <div className="flex-1 flex items-center justify-center text-sm text-center px-8" style={{ color: '#6B7080' }}>
          {experimentActive === false
            ? 'No active experiment. Start one from the Experiment page to see incidents here.'
            : 'No incidents loaded. Start an experiment from the Experiment page to begin.'}
        </div>
      )}

      {/* Table */}
      {!loading && !error && entries.length > 0 && (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10" style={{ backgroundColor: '#16171E' }}>
              <tr>
                {(
                  [
                    { col: null as SortColumn | null, label: '' },
                    { col: 'incident_id', label: 'Incident ID' },
                    { col: 'anomaly', label: 'Anomaly' },
                    { col: 'affected', label: 'Affected %' },
                    { col: 'source', label: 'Source' },
                    { col: 'stage', label: 'Stage' },
                    { col: 'confidence', label: 'Confidence' },
                    { col: 'routing', label: 'Routing' },
                    { col: 'status', label: 'Status' },
                  ] as const
                ).map(({ col, label }) => (
                  <th
                    key={label || 'dot'}
                    className="px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide whitespace-nowrap border-b"
                    style={{
                      color: col && sortColumn === col ? '#4C8BF5' : '#6B7A99',
                      borderColor: B,
                    }}
                  >
                    {col ? (
                      <span className="inline-flex items-center">
                        <span
                          className="cursor-pointer select-none hover:brightness-125"
                          onClick={() => toggleSort(col)}
                          title={`Sort by ${label}`}
                        >
                          {label}
                          {sortColumn === col && (
                            <span className="ml-1 tabular-nums" aria-hidden>
                              {sortDir === 'asc' ? '↑' : '↓'}
                            </span>
                          )}
                        </span>
                        <HeaderTooltip text={COLUMN_TOOLTIPS[col]} />
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map(entry => {
                const pending = isPending(entry);
                const humanOnly = entry.experiment_mode === 'human_only';
                const sel     = selectedId === entry.incident_id;
                const expanded = expandedIncidentId === entry.incident_id;
                const canExpand =
                  entry.experiment_mode === 'hitl' || entry.experiment_mode === 'human_only';
                const tc      = { borderColor: B };
                const routing = entry.routing_action;

                // Feature values — top-level (flattened) with nested fallback
                const anomalyType       = feat(entry, 'anomaly_type') as string | undefined;
                const affectedPct       = feat(entry, 'affected_records_pct') as number | undefined;
                const dataSource        = feat(entry, 'data_source') as string | undefined;
                const pipelineStage     = feat(entry, 'pipeline_stage') as string | undefined;

                return (
                  <Fragment key={entry.decision_id}>
                  <tr onClick={() => handleRowClick(entry)}
                    className="cursor-pointer"
                    style={{
                      backgroundColor: expanded
                        ? 'rgba(76,139,245,0.22)'
                        : sel
                        ? 'rgba(76,139,245,0.15)'
                        : pending
                        ? (TINT[routing] ?? 'rgba(232,145,58,0.05)')
                        : humanOnly
                        ? 'rgba(107,112,128,0.05)'
                        : TINT[entry.ai_recommendation],
                      outline:       (sel || expanded) ? '1px solid rgba(76,139,245,0.4)' : 'none',
                      outlineOffset: '-1px',
                    }}>

                    {/* Severity dot — pending: colour by routing_action; else AI recommendation / neutral */}
                    <td className="px-3 py-2.5 border-b w-8" style={tc}>
                      <span
                        className="block w-2 h-2 rounded-full"
                        style={{
                          backgroundColor: pending
                            ? (COLOR[routing] ?? '#E8913A')
                            : humanOnly
                              ? '#6B7080'
                              : (COLOR[entry.ai_recommendation] ?? '#6B7080'),
                          boxShadow:
                            pending && routing === 'critical'
                              ? '0 0 6px rgba(229,83,75,0.85)'
                              : undefined,
                        }}
                      />
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
                      {humanOnly ? '—' : `${(entry.ai_confidence * 100).toFixed(0)}%`}
                    </td>

                    {/* Routing (system route — distinguishes escalate vs critical while pending) */}
                    <td className="px-3 py-2.5 border-b" style={tc}>
                      <Badge value={routing} />
                    </td>

                    {/* Status badge — PENDING or action badge */}
                    <td className="px-3 py-2.5 border-b" style={tc}>
                      {pending
                        ? <PendingBadge />
                        : humanOnly
                        ? <ReviewedBadge />
                        : <Badge value={entry.ai_recommendation} />}
                    </td>
                  </tr>

                  {/* Inline detail panel — everything the analyst needs to act,
                      rendered directly below the selected row (no tab switching). */}
                  {expanded && canExpand && (
                    <tr>
                      <td colSpan={9} style={{ padding: 0, borderBottom: `1px solid ${B}` }}>
                        <div
                          className="inline-detail-enter"
                          style={{
                            borderLeft: '3px solid #4C8BF5',
                            backgroundColor: '#1E1F2A',
                            padding: 18,
                          }}
                        >
                          {/* Mini header with collapse control. A row that has
                              already been acted on opens read-only (see BUG 2),
                              so it says "Viewing" rather than "Reviewing". */}
                          <div className="flex items-center mb-3">
                            <span className="text-xs font-medium" style={{ color: '#6B7A99' }}>
                              {isPending(entry) ? 'Reviewing' : 'Viewing'}{' '}
                              <span className="font-mono" style={{ color: '#4C8BF5' }}>
                                {entry.incident_id}
                              </span>
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); setExpandedIncidentId(null); }}
                              title="Collapse"
                              className="ml-auto p-1 rounded transition-colors"
                              style={{ color: '#6B7A99' }}
                            >
                              <X size={15} />
                            </button>
                          </div>

                          {/* HITL: SHAP (left) + Decision (right). Human-only: Decision only. */}
                          {entry.experiment_mode === 'hitl' ? (
                            <div className="flex gap-4" style={{ height: 560 }}>
                              <div style={{ flex: '0 0 45%', minWidth: 0, borderRadius: 10,
                                            overflow: 'hidden', border: `1px solid ${B}` }}>
                                <ShapExplainer incidentId={entry.incident_id} />
                              </div>
                              <div style={{ flex: '1 1 55%', minWidth: 0, borderRadius: 10,
                                            overflow: 'hidden', border: `1px solid ${B}` }}>
                                <DecisionPanel
                                  incidentId={entry.incident_id}
                                  onActionComplete={handleActionComplete}
                                  readOnly={!isPending(entry)}
                                />
                              </div>
                            </div>
                          ) : (
                            <div style={{ height: 460, borderRadius: 10,
                                          overflow: 'hidden', border: `1px solid ${B}` }}>
                              <DecisionPanel
                                incidentId={entry.incident_id}
                                onActionComplete={handleActionComplete}
                                readOnly={!isPending(entry)}
                              />
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
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
          <span>
            {entries.length} decision{entries.length !== 1 ? 's' : ''}
            {sortColumn && (
              <span className="ml-2" style={{ color: '#4C8BF5' }}>
                (sorted by {sortColumn.replace(/_/g, ' ')} {sortDir})
              </span>
            )}
          </span>
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

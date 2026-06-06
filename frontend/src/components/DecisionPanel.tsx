/**
 * DecisionPanel — human analyst action interface.
 *
 * Accept  → POST /api/decisions/{id}/override  (new_action = ai_recommendation)
 * Override→ POST /api/decisions/{id}/override  (new_action + override_reason)
 * Dismiss → local only
 */
import { useEffect, useState } from 'react';
import { CheckCircle, ArrowLeftRight, XCircle, AlertTriangle, Lock } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import type {
  Decision,
  DecisionStats,
  DecisionAction,
  OverrideDecisionRequest,
  OverrideDecisionResponse,
} from '../types';

interface LogEntry extends Decision { anomaly_type?: string; }
interface LogResponse { decisions: LogEntry[]; total: number; }
export interface Props {
  incidentId: string | null;
  /**
   * Optional callback fired after a successful Accept or Override.
   * Used by the inline IncidentQueue flow to collapse this row, refresh the
   * log, and auto-advance to the next pending incident. When omitted (e.g. the
   * standalone sidebar panel) the result card simply stays visible.
   */
  onActionComplete?: (incidentId: string) => void;
  /**
   * Force a read-only view (no Accept / Override / Dismiss). The inline queue
   * passes this for incidents that have already been reviewed so participants
   * can see what they decided without being able to change it (BUG 2). When
   * omitted, the panel decides for itself from the fetched decision: a decision
   * is only editable while it is still pending human review.
   */
  readOnly?: boolean;
}

// A decision can only be acted on while it is still pending human review:
// it was routed to a human (not auto-resolved) and no human_action exists yet.
// Everything else — already reviewed, auto-resolved, or ai_only — is read-only.
function isStillActionable(d: LogEntry): boolean {
  return (
    d.human_action == null &&
    d.routing_action !== 'auto_resolve' &&
    (d.experiment_mode === 'hitl' || d.experiment_mode === 'human_only')
  );
}

// Plain-English summary of what was already decided, for the read-only view.
function describeOutcome(d: LogEntry): { verb: string; action: string } {
  if (d.experiment_mode === 'ai_only') return { verb: 'AI decided', action: d.final_action };
  if (d.routing_action === 'auto_resolve') return { verb: 'Auto-resolved as', action: d.final_action };
  if (d.experiment_mode === 'human_only') return { verb: 'You decided', action: d.human_action ?? d.final_action };
  // HITL human review: distinguish accepting the AI from overriding it.
  if (d.human_override_to != null) return { verb: 'You overrode to', action: d.human_override_to };
  return { verb: 'You accepted', action: d.human_action ?? d.final_action };
}

const B = '#2A2B38';
const REC_COLOR: Record<DecisionAction, string> = {
  auto_resolve: '#3EBD8C', escalate: '#E8913A', critical: '#E5534B',
};
const REC_LABEL: Record<DecisionAction, string> = {
  auto_resolve: 'Auto Resolve', escalate: 'Escalate', critical: 'Critical',
};

export function DecisionPanel({ incidentId, onActionComplete, readOnly: readOnlyProp }: Props) {
  const { get, post } = useApi();
  const [decision,   setDecision]   = useState<LogEntry | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [showForm,   setShowForm]   = useState(false);
  const [newAction,  setNewAction]  = useState<DecisionAction>('escalate');
  const [reason,     setReason]     = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; costDelta?: number | null } | null>(null);

  useEffect(() => {
    if (!incidentId) { setDecision(null); setResult(null); setShowForm(false); return; }
    setLoading(true); setResult(null); setShowForm(false);
    get<DecisionStats>('/api/decisions/stats')
      .then((stats) => {
        if (!stats.run_id) return null;
        return get<LogResponse | LogEntry[]>('/api/decisions/log', {
          page: 1, page_size: 1000, run_id: stats.run_id,
        });
      })
      .then((r) => {
        if (!r) { setDecision(null); return; }
        const list = Array.isArray(r) ? r : (r as LogResponse).decisions ?? [];
        setDecision(list.find(d => d.incident_id === incidentId) ?? null);
      })
      .catch(() => setDecision(null))
      .finally(() => setLoading(false));
  }, [incidentId, get]);

  async function handleAccept() {
    if (!decision) return;
    setSubmitting(true);
    try {
      const payload: OverrideDecisionRequest = {
        new_action: decision.ai_recommendation,
        override_reason: 'Accepted AI recommendation',
      };
      const res = await post<OverrideDecisionResponse>(
        `/api/decisions/${decision.decision_id}/override`,
        payload,
      );
      setResult({
        ok: true,
        message: `Accepted: ${REC_LABEL[decision.ai_recommendation]}`,
        costDelta: res.cost_delta,
      });
      // Inline-queue flow: brief pause so the participant sees the confirmation
      // + cost delta, then hand off to advance to the next pending incident.
      if (onActionComplete && incidentId) {
        const id = incidentId;
        setTimeout(() => onActionComplete(id), 900);
      }
    } catch (e: unknown) {
      setResult({ ok: false, message: `Error: ${(e as Error).message}` });
    } finally { setSubmitting(false); }
  }

  async function handleOverride() {
    if (!decision) return;
    const isHumanOnly = decision.experiment_mode === 'human_only';
    const enteredReason = reason.trim();
    if (!isHumanOnly && enteredReason.length < 5) return;
    setSubmitting(true);
    try {
      const payload: OverrideDecisionRequest = {
        new_action: newAction,
        override_reason: enteredReason || 'Human-only analyst decision',
      };
      const res = await post<OverrideDecisionResponse>(
        `/api/decisions/${decision.decision_id}/override`,
        payload,
      );
      setResult({
        ok: true,
        message: `Overridden → ${REC_LABEL[newAction]}`,
        costDelta: res.cost_delta,
      });
      setShowForm(false);
      if (onActionComplete && incidentId) {
        const id = incidentId;
        setTimeout(() => onActionComplete(id), 900);
      }
    } catch (e: unknown) {
      setResult({ ok: false, message: `Error: ${(e as Error).message}` });
    } finally { setSubmitting(false); }
  }

  // Editable only while pending. An explicit readOnly prop (from the inline
  // queue) wins; otherwise fall back to inspecting the fetched decision so the
  // standalone sidebar panel is protected too.
  const readOnly = decision != null && (readOnlyProp ?? !isStillActionable(decision));

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: '#0E0F14', color: '#E8E9F0' }}>
      {/* Header */}
      <div className="px-6 py-4 border-b flex-shrink-0 flex items-start gap-3"
        style={{ borderColor: B, backgroundColor: '#16171E' }}>
        <div className="flex-1">
          <h2 className="text-base font-semibold">Decision Panel</h2>
          <p className="text-xs mt-0.5" style={{ color: '#6B7A99' }}>
            {readOnly
              ? 'This incident has already been reviewed — read only'
              : "Accept, override, or dismiss the AI's routing recommendation"}
          </p>
        </div>
        {readOnly && (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap"
            style={{ color: '#6B7A99', backgroundColor: 'rgba(107,112,128,0.12)', border: `1px solid ${B}` }}>
            <Lock size={11} /> Reviewed
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-6 flex flex-col gap-5">
        {/* Empty / loading / not-found states */}
        {!incidentId && <Centered>Select an incident from the Incident Queue to view AI recommendations.</Centered>}
        {incidentId && loading && <Centered>Loading…</Centered>}
        {incidentId && !loading && !decision && !result && (
          <Centered>No routing decision found for this incident — run POST /route first.</Centered>
        )}

        {/* Result card shown after any action */}
        {result && (
          <div className="rounded-xl p-5 flex items-start gap-3"
            style={{ backgroundColor: result.ok ? 'rgba(62,189,140,0.1)' : 'rgba(229,83,75,0.1)',
                     border: `1px solid ${result.ok ? '#3EBD8C' : '#E5534B'}` }}>
            {result.ok
              ? <CheckCircle size={20} style={{ color: '#3EBD8C', flexShrink: 0, marginTop: 1 }} />
              : <AlertTriangle size={20} style={{ color: '#E5534B', flexShrink: 0, marginTop: 1 }} />}
            <div>
              <p className="font-semibold text-sm">{result.message}</p>
              {result.costDelta != null && (
                <p className="text-xs mt-1" style={{ color: '#B0B3C6' }}>
                  Cost delta: <span className="font-mono font-semibold">€{result.costDelta.toFixed(2)}</span>
                </p>
              )}
            </div>
          </div>
        )}

        {/* Main decision UI */}
        {decision && !result && (
          <>
            {/* AI recommendation card */}
            <div className="rounded-xl p-5" style={{ backgroundColor: '#16171E', border: `1px solid ${B}` }}>
              <p className="text-xs mb-3" style={{ color: '#6B7A99' }}>
                Incident <span className="font-mono" style={{ color: '#E8E9F0' }}>{decision.incident_id}</span>
              </p>
              {decision.experiment_mode !== 'human_only' ? (
                <div className="flex items-center gap-3 mb-5">
                  <span className="text-xs font-medium uppercase tracking-wide" style={{ color: '#6B7A99' }}>AI recommends</span>
                  {/* Large badge — most prominent element on the panel */}
                  <span className="px-3 py-1 rounded-full text-sm font-bold"
                    style={{ backgroundColor: `${REC_COLOR[decision.ai_recommendation]}22`,
                             color: REC_COLOR[decision.ai_recommendation],
                             border: `1.5px solid ${REC_COLOR[decision.ai_recommendation]}` }}>
                    {REC_LABEL[decision.ai_recommendation] ?? decision.ai_recommendation}
                  </span>
                  <span className="text-xs tabular-nums" style={{ color: '#6B7A99' }}>
                    {(decision.ai_confidence * 100).toFixed(0)}% confidence
                  </span>
                </div>
              ) : (
                <p className="text-xs mb-5" style={{ color: '#6B7A99' }}>
                  Human-only mode: make your decision without AI recommendation cues.
                </p>
              )}

              {/* Action buttons: filled Accept is the primary CTA.
                  Hidden once the incident has been reviewed (BUG 2) so the
                  recorded decision cannot be changed. */}
              {!readOnly && (
                <div className="flex flex-wrap gap-3">
                  {decision.experiment_mode !== 'human_only' && (
                    <button onClick={handleAccept} disabled={submitting}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-opacity"
                      style={{ backgroundColor: '#3EBD8C', color: '#fff', opacity: submitting ? 0.5 : 1 }}>
                      <CheckCircle size={15} /> Accept
                    </button>
                  )}
                  <button onClick={() => setShowForm(f => !f)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold"
                    style={{ border: '1.5px solid #E8913A', color: '#E8913A', backgroundColor: 'rgba(232,145,58,0.1)' }}>
                    <ArrowLeftRight size={15} /> {decision.experiment_mode === 'human_only' ? 'Choose Action' : 'Override'}
                  </button>
                  <button onClick={() => setResult({ ok: true, message: 'Incident dismissed — no action taken.' })}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold"
                    style={{ border: `1.5px solid ${B}`, color: '#6B7A99' }}>
                    <XCircle size={15} /> Dismiss
                  </button>
                </div>
              )}

              {/* Read-only outcome — what was already decided for this incident */}
              {readOnly && (() => {
                const outcome = describeOutcome(decision);
                const action  = outcome.action as DecisionAction;
                const showReason =
                  decision.override_reason &&
                  decision.override_reason !== 'Accepted AI recommendation';
                return (
                  <div className="rounded-xl p-4" style={{ backgroundColor: '#0E0F14', border: `1px solid ${B}` }}>
                    <div className="flex items-center gap-3">
                      <span className="text-sm" style={{ color: '#B0B3C6' }}>{outcome.verb}</span>
                      <span className="px-3 py-1 rounded-full text-sm font-bold"
                        style={{ backgroundColor: `${REC_COLOR[action] ?? '#6B7A99'}22`,
                                 color: REC_COLOR[action] ?? '#B0B3C6',
                                 border: `1.5px solid ${REC_COLOR[action] ?? B}` }}>
                        {REC_LABEL[action] ?? outcome.action}
                      </span>
                    </div>
                    {showReason && (
                      <p className="text-xs mt-3" style={{ color: '#6B7A99' }}>
                        Reason: <span style={{ color: '#B0B3C6' }}>{decision.override_reason}</span>
                      </p>
                    )}
                    {decision.cost != null && (
                      <p className="text-xs mt-2" style={{ color: '#6B7A99' }}>
                        Cost: <span className="font-mono font-semibold" style={{ color: '#B0B3C6' }}>€{decision.cost.toFixed(2)}</span>
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Override form — toggled by Override button (never in read-only) */}
            {!readOnly && showForm && (
              <div className="rounded-xl p-5" style={{ backgroundColor: '#16171E', border: '1.5px solid #E8913A' }}>
                <p className="text-sm font-semibold mb-4" style={{ color: '#E8913A' }}>Override AI recommendation</p>

                <label className="block text-xs mb-1" style={{ color: '#6B7A99' }}>Change action to</label>
                <select value={newAction} onChange={e => setNewAction(e.target.value as DecisionAction)}
                  className="w-full rounded-lg px-3 py-2 text-sm mb-4 outline-none"
                  style={{ backgroundColor: '#0E0F14', border: `1px solid ${B}`, color: '#E8E9F0' }}>
                  {(['auto_resolve', 'escalate', 'critical'] as const).map(a => (
                    <option key={a} value={a}>{REC_LABEL[a]}</option>
                  ))}
                </select>

                <label className="block text-xs mb-1" style={{ color: '#6B7A99' }}>
                  Reason <span style={{ color: '#E5534B' }}>*</span> ({decision.experiment_mode === 'human_only' ? 'optional notes' : 'min 5 characters'})
                </label>
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
                  placeholder={decision.experiment_mode === 'human_only'
                    ? 'Optional note about your decision…'
                    : 'Explain why you are overriding the AI…'}
                  className="w-full rounded-lg px-3 py-2 text-sm mb-4 resize-none outline-none"
                  style={{ backgroundColor: '#0E0F14', border: `1px solid ${B}`, color: '#E8E9F0' }} />

                <button onClick={handleOverride}
                  disabled={submitting || (decision.experiment_mode !== 'human_only' && reason.trim().length < 5)}
                  className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-opacity"
                  style={{ backgroundColor: '#E8913A', color: '#fff',
                           opacity: (submitting || (decision.experiment_mode !== 'human_only' && reason.trim().length < 5)) ? 0.45 : 1 }}>
                  {submitting ? 'Submitting…' : decision.experiment_mode === 'human_only' ? 'Submit Decision' : 'Confirm Override'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Vertically centred muted text — used for empty / loading states
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-center px-8" style={{ color: '#6B7080' }}>
      {children}
    </div>
  );
}

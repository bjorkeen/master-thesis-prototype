/**
 * ExperimentControl — start/stop experiment runs and batch-process incidents.
 *
 * Flow:
 *   1. Select a mode (AI-Only / Human-Only / HITL)
 *   2. Click Start → POST /api/experiment/start
 *   3. Click "Load & Run Incidents" → fetches a stratified sample and
 *      processes each one through /api/route + /api/decisions
 *   4. Click Stop → POST /api/experiment/stop → results appear
 *   5. Export CSV → opens GET /api/experiment/export in a new tab
 *
 * Mode behaviour during batch run:
 *   ai_only    — all incidents auto-logged, no human review needed
 *   hitl       — auto_resolve → logged immediately; escalate/critical → queued for review
 *   human_only — all incidents queued for human review (nothing auto-logged)
 */
import { useState, useRef } from 'react';
import { Play, Square, Download, Zap, StopCircle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import type { ExperimentResults, RoutingResponse } from '../types';

type ExperimentMode = 'ai_only' | 'human_only' | 'hitl';

// Response from POST /experiment/start
interface RunInfo {
  run_id: string;
  mode: ExperimentMode;
  started_at: string;
}

// One incident as returned by GET /incidents/sample
interface SampledIncident {
  anomaly_type: string;
  affected_records_pct: number;
  data_source: string;
  pipeline_stage: string;
  historical_frequency: string;
  time_sensitivity: string;
  data_domain: string;
  ground_truth: string;
}

const B = '#2A2B38';
const PROTOCOL_INCIDENT_COUNT = 300;
const PROTOCOL_SAMPLE_SEED = 42;

const MODES: { key: ExperimentMode; label: string; color: string; desc: string }[] = [
  { key: 'ai_only',    label: 'AI-Only',    color: '#4C8BF5', desc: 'AI decides all incidents automatically' },
  { key: 'human_only', label: 'Human-Only', color: '#E8913A', desc: 'All incidents routed to human review'    },
  { key: 'hitl',       label: 'HITL',       color: '#3EBD8C', desc: 'AI auto-resolves clear cases; humans review ambiguous ones' },
];

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

function fmtDuration(s?: number | null): string {
  if (s == null) return '—';
  return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Single result stat cell
function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg p-4" style={{ backgroundColor: '#0E0F14', border: `1px solid ${B}` }}>
      <span style={{ fontSize: '0.65rem', color: '#6B7A99', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        {label}
      </span>
      <span className="font-bold text-lg" style={{ color: color ?? '#E8E9F0' }}>{value}</span>
    </div>
  );
}

// Horizontal progress bar
function ProgressBar({ done, total, color }: { done: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height: 6, backgroundColor: '#0E0F14' }}>
      <div className="h-full rounded-full transition-all duration-200"
        style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

// ---- component ----
export function ExperimentControl() {
  const { post, get } = useApi();

  // Experiment lifecycle state
  const [mode,    setMode]    = useState<ExperimentMode>('hitl');
  const [running, setRunning] = useState(false);
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const [results, setResults] = useState<ExperimentResults | null>(null);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // Batch runner state
  const [batchCount]        = useState(PROTOCOL_INCIDENT_COUNT);
  const [sampleSeed]        = useState(PROTOCOL_SAMPLE_SEED);
  const [batchDelay,        setBatchDelay]        = useState(100);
  const [batchRunning,      setBatchRunning]      = useState(false);
  const [batchDone,         setBatchDone]         = useState(0);
  const [batchTotal,        setBatchTotal]        = useState(0);
  const [batchAutoResolved, setBatchAutoResolved] = useState(0);
  const [batchPending,      setBatchPending]      = useState(0);
  const [batchLogFailures,  setBatchLogFailures]  = useState(0);
  const [batchComplete,     setBatchComplete]     = useState(false);
  const [batchError,        setBatchError]        = useState<string | null>(null);

  // Ref lets the cancel button stop the loop mid-run without stale closure issues
  const cancelRef = useRef(false);

  // ── Experiment start / stop ─────────────────────────────────────────────────

  async function handleStart() {
    setBusy(true); setError(null); setResults(null);
    setBatchDone(0); setBatchTotal(0); setBatchAutoResolved(0);
    setBatchPending(0); setBatchLogFailures(0); setBatchComplete(false); setBatchError(null);
    try {
      const info = await post<RunInfo>('/api/experiment/start', { mode });
      setRunInfo(info);
      setRunning(true);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  async function handleStop() {
    setBusy(true); setError(null);
    cancelRef.current = true;   // stop the batch loop if it's running
    try {
      await post('/api/experiment/stop');
      const res = await get<ExperimentResults>('/api/experiment/results');
      setResults(res);
      setRunning(false);
      setBatchRunning(false);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  // ── Batch runner ────────────────────────────────────────────────────────────

  async function handleLoadAndRun() {
    setBatchRunning(true); setBatchError(null); setBatchComplete(false);
    setBatchDone(0); setBatchAutoResolved(0); setBatchPending(0); setBatchLogFailures(0);
    cancelRef.current = false;

    let incidents: SampledIncident[] = [];

    // 1. Fetch the stratified sample from the backend
    try {
      const resp = await get<{ count: number; incidents: SampledIncident[] }>(
        '/api/incidents/sample', { count: batchCount, seed: sampleSeed }
      );
      incidents = resp.incidents;
    } catch (e: unknown) {
      setBatchError(`Failed to load incidents: ${(e as Error).message}`);
      setBatchRunning(false);
      return;
    }

    setBatchTotal(incidents.length);

    let autoResolved = 0;
    let pending      = 0;

    // 2. Process each incident sequentially
    for (let i = 0; i < incidents.length; i++) {
      if (cancelRef.current) break;

      const incident = incidents[i];
      const { ground_truth, ...features } = incident;
      const startMs = Date.now();

      let route: RoutingResponse;

      // Route the incident through the decision pipeline
      try {
        route = await post<RoutingResponse>('/api/route', features);
      } catch (e: unknown) {
        setBatchError(`Routing failed on incident ${i + 1}: ${(e as Error).message}`);
        break;
      }

      const resolution_time_s = (Date.now() - startMs) / 1000;

      /*
       * Log EVERY incident to the decision log so it appears in IncidentQueue.
       *
       * ai_only    → AI decided; human_action = ai_recommendation (closed)
       * hitl       → auto_resolve: fully closed; escalate/critical: human_action
       *              is null so the analyst sees it as PENDING in the queue
       * human_only → all incidents logged with human_action = null (PENDING)
       *
       * The analyst acts via DecisionPanel (Accept / Override), which updates
       * the existing row via POST /decisions/{id}/override.
       */
      const needsHuman =
        mode === 'human_only' ||
        (mode === 'hitl' && route.routing_decision !== 'auto_resolve');

      // human_action: set to ai_recommendation for ai_only (fully automated),
      // null for everything else (human review pending or not applicable).
      const human_action = mode === 'ai_only' ? route.ai_recommendation : null;

      const decisionPayload = {
        incident_id:       route.incident_id,
        experiment_mode:   mode,
        incident_features: features,
        ai_recommendation: route.ai_recommendation,
        ai_confidence:     route.ai_confidence,
        routing_action:    route.routing_decision,
        human_action,
        final_action:      route.routing_decision,
        ground_truth:      ground_truth,
        resolution_time_s: resolution_time_s,
      };

      // Retry once, then fail fast so experiment integrity is not silently compromised.
      let logged = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await post('/api/decisions', decisionPayload);
          logged = true;
          break;
        } catch {
          if (attempt === 1) await sleep(200);
        }
      }
      if (!logged) {
        setBatchLogFailures((v) => v + 1);
        setBatchError(`Decision logging failed on incident ${i + 1}; stopping to protect experiment integrity.`);
        break;
      }

      if (needsHuman) {
        pending++;
        setBatchPending(pending);
      } else {
        autoResolved++;
        setBatchAutoResolved(autoResolved);
      }

      setBatchDone(i + 1);

      // Small delay so the Twin state has time to update and progress feels natural
      if (batchDelay > 0) await sleep(batchDelay);
    }

    setBatchRunning(false);
    setBatchComplete(true);
  }

  // ── Derived values ──────────────────────────────────────────────────────────

  const activeMode = MODES.find(m => m.key === mode)!;
  const batchPct   = batchTotal > 0 ? Math.round((batchDone / batchTotal) * 100) : 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: '#0E0F14', color: '#E8E9F0' }}>

      {/* Header */}
      <div className="px-6 py-4 border-b flex-shrink-0" style={{ borderColor: B, backgroundColor: '#16171E' }}>
        <h2 className="text-base font-semibold">Experiment Control</h2>
        <p className="text-xs mt-0.5" style={{ color: '#6B7A99' }}>
          Compare AI-only, Human-only, and HITL decision modes
        </p>
      </div>

      <div className="flex-1 overflow-auto px-6 py-6 flex flex-col gap-6">

        {/* ── Mode selector ───────────────────────────────────────────────── */}
        <div>
          <p style={{ fontSize: '0.65rem', color: '#6B7A99', textTransform: 'uppercase',
                      letterSpacing: '0.08em', marginBottom: 10 }}>
            Experiment Mode
          </p>
          <div className="flex" style={{ border: `1px solid ${B}`, borderRadius: 10, overflow: 'hidden' }}>
            {MODES.map(({ key, label, color }, i) => {
              const active = mode === key;
              return (
                <button key={key} onClick={() => !running && setMode(key)}
                  disabled={running}
                  className="flex-1 py-2.5 text-sm font-semibold transition-all"
                  style={{
                    backgroundColor: active ? color : 'transparent',
                    color:           active ? '#fff' : '#6B7A99',
                    borderRight:     i < MODES.length - 1 ? `1px solid ${B}` : 'none',
                    cursor:          running ? 'not-allowed' : 'pointer',
                    opacity:         running && !active ? 0.4 : 1,
                  }}>
                  {label}
                </button>
              );
            })}
          </div>
          {/* Mode description */}
          <p className="text-xs mt-2" style={{ color: '#6B7A99' }}>
            {MODES.find(m => m.key === mode)?.desc}
          </p>
        </div>

        {/* ── Start / Stop button ─────────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          {!running ? (
            <button onClick={handleStart} disabled={busy}
              className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-opacity"
              style={{ backgroundColor: '#3EBD8C', color: '#fff', opacity: busy ? 0.5 : 1 }}>
              <Play size={16} fill="#fff" /> {busy ? 'Starting…' : 'Start Experiment'}
            </button>
          ) : (
            <button onClick={handleStop} disabled={busy}
              className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-opacity"
              style={{ backgroundColor: '#E5534B', color: '#fff', opacity: busy ? 0.5 : 1 }}>
              <Square size={16} fill="#fff" /> {busy ? 'Stopping…' : 'Stop Experiment'}
            </button>
          )}
          {error && <p className="text-xs" style={{ color: '#E5534B' }}>Error: {error}</p>}
        </div>

        {/* ── Run status card — shown while experiment is running ──────────── */}
        {running && runInfo && (
          <div className="rounded-xl p-5" style={{ backgroundColor: '#16171E', border: `1px solid ${activeMode.color}` }}>
            <div className="flex items-center gap-2 mb-4">
              <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: activeMode.color }} />
              <span className="text-sm font-semibold" style={{ color: activeMode.color }}>
                Experiment Running
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm mb-5">
              {[
                ['Run ID',  runInfo.run_id],
                ['Mode',    runInfo.mode.replace(/_/g, '-').toUpperCase()],
                ['Started', fmtTime(runInfo.started_at)],
              ].map(([label, value]) => (
                <div key={label as string} className="flex flex-col">
                  <dt style={{ fontSize: '0.65rem', color: '#6B7A99', textTransform: 'uppercase' }}>{label}</dt>
                  <dd className="font-mono text-xs mt-0.5" style={{ color: '#E8E9F0' }}>{value}</dd>
                </div>
              ))}
            </dl>

            {/* ── Batch runner controls ────────────────────────────────────── */}
            {!batchRunning && !batchComplete && (
              <div className="pt-4" style={{ borderTop: `1px solid ${B}` }}>
                <p className="text-xs font-semibold mb-3" style={{ color: '#E8E9F0' }}>
                  Load &amp; Run Incidents
                </p>

                {/* Count + delay controls */}
                <div className="flex items-end gap-4 mb-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs" style={{ color: '#6B7A99' }}>
                      Incident count
                    </label>
                    <input
                      type="number" min={1} max={3000} value={batchCount}
                      disabled
                      className="w-24 rounded-lg px-3 py-1.5 text-sm text-center outline-none"
                      style={{ backgroundColor: '#0E0F14', border: `1px solid ${B}`, color: '#E8E9F0', opacity: 0.75 }}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs" style={{ color: '#6B7A99' }}>
                      Sample seed
                    </label>
                    <input
                      type="number" min={0} value={sampleSeed}
                      disabled
                      className="w-28 rounded-lg px-3 py-1.5 text-sm text-center outline-none"
                      style={{ backgroundColor: '#0E0F14', border: `1px solid ${B}`, color: '#E8E9F0', opacity: 0.75 }}
                    />
                  </div>
                  <div className="flex flex-col gap-1 flex-1">
                    <label className="text-xs" style={{ color: '#6B7A99' }}>
                      Delay between incidents: <span style={{ color: '#E8E9F0' }}>{batchDelay}ms</span>
                    </label>
                    <input
                      type="range" min={0} max={500} step={50} value={batchDelay}
                      onChange={e => setBatchDelay(Number(e.target.value))}
                      className="w-full"
                      style={{ accentColor: activeMode.color }}
                    />
                    <div className="flex justify-between text-xs" style={{ color: '#4A4D60' }}>
                      <span>0ms</span><span>500ms</span>
                    </div>
                  </div>
                </div>

                {/* Mode-specific hint */}
                <p className="text-xs mb-3" style={{ color: '#6B7A99' }}>
                  {mode === 'ai_only'
                    ? 'All incidents will be processed and logged automatically.'
                    : mode === 'hitl'
                    ? 'Auto-resolve decisions are logged immediately. Escalated/critical incidents are queued for human review in the Incident Queue.'
                    : 'All incidents will be queued for human review. Check the Incident Queue to make decisions.'}
                </p>
                <p className="text-xs mb-3" style={{ color: '#4A4D60' }}>
                  Protocol lock: {batchCount} incidents, seed {sampleSeed}.
                </p>

                <button onClick={handleLoadAndRun}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold"
                  style={{ backgroundColor: activeMode.color, color: '#fff' }}>
                  <Zap size={15} fill="#fff" /> Load &amp; Run {batchCount} Incidents
                </button>
              </div>
            )}

            {/* ── Batch progress ───────────────────────────────────────────── */}
            {(batchRunning || batchComplete) && (
              <div className="pt-4" style={{ borderTop: `1px solid ${B}` }}>

                {/* Progress bar + percentage */}
                <div className="flex items-center gap-3 mb-2">
                  <ProgressBar done={batchDone} total={batchTotal} color={activeMode.color} />
                  <span className="text-xs tabular-nums shrink-0" style={{ color: '#6B7A99' }}>
                    {batchPct}%
                  </span>
                </div>

                {/* Status line */}
                {batchRunning && (
                  <p className="text-xs mb-3" style={{ color: '#B0B3C6' }}>
                    Processing incident{' '}
                    <span className="font-semibold tabular-nums" style={{ color: '#E8E9F0' }}>
                      {batchDone}
                    </span>
                    {' / '}
                    <span className="font-semibold" style={{ color: '#E8E9F0' }}>{batchTotal}</span>
                    …
                  </p>
                )}

                {/* Running counters */}
                <div className="flex gap-4 mb-3">
                  {mode !== 'human_only' && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#3EBD8C' }} />
                      <span style={{ color: '#3EBD8C' }}>
                        {batchAutoResolved} auto-resolved
                      </span>
                    </div>
                  )}
                  {mode !== 'ai_only' && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#E8913A' }} />
                      <span style={{ color: '#E8913A' }}>
                        {batchPending} awaiting review
                      </span>
                    </div>
                  )}
                  {batchLogFailures > 0 && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#E5534B' }} />
                      <span style={{ color: '#E5534B' }}>
                        {batchLogFailures} logging failure{batchLogFailures !== 1 ? 's' : ''}
                      </span>
                    </div>
                  )}
                </div>

                {/* Cancel button (only while running) */}
                {batchRunning && (
                  <button
                    onClick={() => { cancelRef.current = true; }}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg"
                    style={{ border: `1px solid ${B}`, color: '#6B7A99' }}>
                    <StopCircle size={12} /> Cancel
                  </button>
                )}

                {/* Completion summary */}
                {batchComplete && !batchRunning && (
                  <div className="rounded-lg p-3 mt-1"
                    style={{ backgroundColor: 'rgba(62,189,140,0.08)', border: '1px solid rgba(62,189,140,0.3)' }}>
                    <p className="text-xs font-semibold mb-1" style={{ color: '#3EBD8C' }}>
                      Batch complete — {batchDone} incident{batchDone !== 1 ? 's' : ''} processed
                    </p>
                    <p className="text-xs" style={{ color: '#B0B3C6' }}>
                      {mode === 'ai_only'
                        ? `${batchAutoResolved} decisions logged automatically.`
                        : mode === 'hitl'
                        ? `${batchAutoResolved} auto-resolved · ${batchPending} queued in Incident Queue`
                        : `${batchPending} incidents queued in Incident Queue for your review`}
                    </p>
                    {batchPending > 0 && (
                      <p className="text-xs mt-1" style={{ color: '#6B7A99' }}>
                        Switch to the Incident Queue panel to review and action them.
                      </p>
                    )}
                  </div>
                )}

                {/* Batch-level error */}
                {batchError && (
                  <p className="text-xs mt-2" style={{ color: '#E5534B' }}>
                    {batchError}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Results — shown after experiment is stopped ──────────────────── */}
        {results && (
          <div className="rounded-xl p-5" style={{ backgroundColor: '#16171E', border: `1px solid ${B}` }}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-semibold">Results — {results.mode.replace(/_/g, '-').toUpperCase()}</p>
              <button
                onClick={() => window.open('http://localhost:4000/api/experiment/export', '_blank')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
                style={{ backgroundColor: 'rgba(76,139,245,0.15)', color: '#4C8BF5', border: '1px solid #4C8BF5' }}>
                <Download size={12} /> Export CSV
              </button>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Stat label="Accuracy"    value={`${(results.accuracy * 100).toFixed(1)}%`}        color="#3EBD8C" />
              <Stat label="Total Cost"  value={`€${results.total_cost.toFixed(2)}`}              color="#E5534B" />
              <Stat label="Avg Time"    value={fmtDuration(results.avg_resolution_time_s)} />
              <Stat label="Incidents"   value={String(results.total_incidents)} />
              <Stat label="Overrides"   value={String(results.override_count)} />
              <Stat label="Override Rate" value={`${(results.override_rate * 100).toFixed(1)}%`} color="#E8913A" />
            </div>

            {results.completed_at && (
              <p className="text-xs mt-3" style={{ color: '#6B7A99' }}>
                Completed {fmtTime(results.completed_at)}
              </p>
            )}
          </div>
        )}

        {/* ── Empty state ─────────────────────────────────────────────────── */}
        {!running && !results && (
          <div className="flex-1 flex items-center justify-center text-sm text-center px-8"
            style={{ color: '#6B7080' }}>
            Select a mode and start an experiment to begin.
          </div>
        )}

      </div>
    </div>
  );
}

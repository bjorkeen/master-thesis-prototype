/**
 * ExperimentControl — start/stop experiment runs and view results.
 *
 * Flow:
 *   1. Select a mode (AI-Only / Human-Only / HITL)
 *   2. Click Start → POST /api/experiment/start
 *   3. Run the incident queue in another panel
 *   4. Click Stop  → POST /api/experiment/stop → results appear
 *   5. Export CSV  → opens GET /api/experiment/export in a new tab
 */
import { useState } from 'react';
import { Play, Square, Download } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import type { ExperimentResults } from '../types';

type ExperimentMode = 'ai_only' | 'human_only' | 'hitl';

// Response from POST /experiment/start
interface RunInfo {
  run_id: string;
  mode: ExperimentMode;
  started_at: string;
  total_incidents?: number;
}

const B = '#2A2B38';

const MODES: { key: ExperimentMode; label: string; color: string }[] = [
  { key: 'ai_only',    label: 'AI-Only',    color: '#4C8BF5' },
  { key: 'human_only', label: 'Human-Only', color: '#E8913A' },
  { key: 'hitl',       label: 'HITL',       color: '#3EBD8C' },
];

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

function fmtDuration(s?: number | null): string {
  if (s == null) return '—';
  return s >= 60 ? `${(s / 60).toFixed(1)}m` : `${s.toFixed(1)}s`;
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

// ---- component ----
export function ExperimentControl() {
  const { post, get } = useApi();
  const [mode,    setMode]    = useState<ExperimentMode>('hitl');
  const [running, setRunning] = useState(false);
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const [results, setResults] = useState<ExperimentResults | null>(null);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  async function handleStart() {
    setBusy(true); setError(null); setResults(null);
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
    try {
      // Stop returns partial results; fetch the full summary separately
      await post('/api/experiment/stop');
      const res = await get<ExperimentResults>('/api/experiment/results');
      setResults(res);
      setRunning(false);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  const activeMode = MODES.find(m => m.key === mode)!;

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

        {/* Mode selector — segmented control */}
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
        </div>

        {/* Start / Stop button */}
        <div>
          {!running ? (
            <button onClick={handleStart} disabled={busy}
              className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-opacity"
              style={{ backgroundColor: '#3EBD8C', color: '#fff', opacity: busy ? 0.5 : 1 }}>
              <Play size={16} fill="#fff" /> {busy ? 'Starting…' : '▶ Start Experiment'}
            </button>
          ) : (
            <button onClick={handleStop} disabled={busy}
              className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-opacity"
              style={{ backgroundColor: '#E5534B', color: '#fff', opacity: busy ? 0.5 : 1 }}>
              <Square size={16} fill="#fff" /> {busy ? 'Stopping…' : '■ Stop Experiment'}
            </button>
          )}
          {error && <p className="text-xs mt-2" style={{ color: '#E5534B' }}>Error: {error}</p>}
        </div>

        {/* Run status — shown while experiment is running */}
        {running && runInfo && (
          <div className="rounded-xl p-5" style={{ backgroundColor: '#16171E', border: `1px solid ${activeMode.color}` }}>
            <div className="flex items-center gap-2 mb-3">
              {/* Pulsing dot to signal activity */}
              <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: activeMode.color }} />
              <span className="text-sm font-semibold" style={{ color: activeMode.color }}>
                Experiment Running
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {[
                ['Run ID',   runInfo.run_id],
                ['Mode',     runInfo.mode.replace(/_/g, '-').toUpperCase()],
                ['Started',  fmtTime(runInfo.started_at)],
                ['Incidents', runInfo.total_incidents ?? '—'],
              ].map(([label, value]) => (
                <div key={label as string} className="flex flex-col">
                  <dt style={{ fontSize: '0.65rem', color: '#6B7A99', textTransform: 'uppercase' }}>{label}</dt>
                  <dd className="font-mono text-xs mt-0.5" style={{ color: '#E8E9F0' }}>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {/* Results — shown after experiment is stopped */}
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
              <Stat label="Accuracy"    value={`${(results.accuracy * 100).toFixed(1)}%`}          color="#3EBD8C" />
              <Stat label="Total Cost"  value={`€${results.total_cost.toFixed(2)}`}                color="#E5534B" />
              <Stat label="Avg Time"    value={fmtDuration(results.avg_resolution_time_s)} />
              <Stat label="Incidents"   value={String(results.total_incidents)} />
              <Stat label="Overrides"   value={String(results.override_count)} />
              <Stat label="Override Rate" value={`${(results.override_rate * 100).toFixed(1)}%`}   color="#E8913A" />
            </div>

            {results.completed_at && (
              <p className="text-xs mt-3" style={{ color: '#6B7A99' }}>
                Completed {fmtTime(results.completed_at)}
              </p>
            )}
          </div>
        )}

        {/* Empty state */}
        {!running && !results && (
          <div className="flex-1 flex items-center justify-center text-sm text-center px-8" style={{ color: '#6B7080' }}>
            Select a mode and start an experiment to begin.
          </div>
        )}

      </div>
    </div>
  );
}

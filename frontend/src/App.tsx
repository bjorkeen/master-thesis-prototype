/**
 * App.tsx — Root layout for HITL-CDT.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │  Sidebar (nav)  │  Main content area            │
 *   │                 │  (one of the 6 panels)        │
 *   └─────────────────────────────────────────────────┘
 *
 * Sidebar items are grouped into labelled sections matching the
 * participant's task flow: Setup → Review → Inspect → Analyze.
 * All 6 panels are always mounted; inactive ones are hidden with
 * display:none to preserve component state across navigation.
 */

import { useEffect, useMemo, useState } from 'react';
import { Wifi, WifiOff } from 'lucide-react';

import { useWebSocket } from './hooks/useWebSocket';
import { useApi } from './hooks/useApi';
import { IncidentQueue }     from './components/IncidentQueue';
import { ShapExplainer }     from './components/ShapExplainer';
import { DecisionPanel }     from './components/DecisionPanel';
import { TwinStatePanel }    from './components/TwinStatePanel';
import { AnalyticsDashboard} from './components/AnalyticsDashboard';
import { ExperimentControl } from './components/ExperimentControl';

// ---------------------------------------------------------------------------
// Navigation structure
// ---------------------------------------------------------------------------
export type PanelKey = 'queue' | 'shap' | 'decision' | 'twin' | 'analytics' | 'experiment';

type NavItem    = { key: PanelKey; label: string; emoji: string };
type NavSection = { label: string; items: NavItem[] };

// Ordered to match the participant task flow: setup first, analyze last.
const NAV_SECTIONS: NavSection[] = [
  {
    label: 'SETUP',
    items: [
      { key: 'experiment', label: 'Experiment',    emoji: '🧪' },
    ],
  },
  {
    label: 'REVIEW',
    items: [
      { key: 'queue',    label: 'Incident Queue', emoji: '📥' },
      { key: 'decision', label: 'Decision Panel', emoji: '📋' },
    ],
  },
  {
    label: 'INSPECT',
    items: [
      { key: 'shap', label: 'AI Explanation', emoji: '💡' },
      { key: 'twin', label: 'Digital Twin',   emoji: '🔄' },
    ],
  },
  {
    label: 'ANALYZE',
    items: [
      { key: 'analytics', label: 'Analytics', emoji: '📊' },
    ],
  },
];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  // Default to 'experiment' so participants land on the setup page first.
  const [activePanel, setActivePanel] = useState<PanelKey>('experiment');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const { twinState, connected } = useWebSocket();
  const { get } = useApi();
  const [experimentCtx, setExperimentCtx] = useState<{ mode: string; active: boolean } | null>(null);

  // Poll the gateway health endpoint to know if an experiment is currently active.
  // Used for: the green running dot on the sidebar, and the human_only panel lock.
  useEffect(() => {
    let mounted = true;
    async function pollCtx() {
      try {
        const health = await get<{ experiment_mode: string; experiment_active: boolean }>('/api/health');
        if (mounted) setExperimentCtx({ mode: health.experiment_mode, active: health.experiment_active });
      } catch {
        // Ignore transient API errors; UI can continue without mode lock.
      }
    }
    pollCtx();
    const id = setInterval(pollCtx, 5000);
    return () => { mounted = false; clearInterval(id); };
  }, [get]);

  // In human_only mode, hide AI Explanation and Analytics (they show AI outputs).
  const aiPanelsLocked = experimentCtx?.active && experimentCtx.mode === 'human_only';
  const lockedKeys = useMemo(
    () => aiPanelsLocked ? new Set<PanelKey>(['shap', 'analytics']) : new Set<PanelKey>(),
    [aiPanelsLocked]
  );

  useEffect(() => {
    if (aiPanelsLocked && (activePanel === 'shap' || activePanel === 'analytics')) {
      setActivePanel('queue');
    }
  }, [aiPanelsLocked, activePanel]);

  const experimentRunning = experimentCtx?.active ?? false;

  // All panels are always mounted; only the active one is visible.
  // This preserves component state (e.g. a running experiment) across navigation.
  function panelStyle(key: PanelKey): React.CSSProperties {
    return activePanel === key
      ? { display: 'flex', flexDirection: 'column', height: '100%' }
      : { display: 'none' };
  }

  return (
    <div className="flex h-screen" style={{ backgroundColor: '#0E0F14' }}>

      {/* ----------------------------------------------------------------- */}
      {/* Sidebar                                                            */}
      {/* ----------------------------------------------------------------- */}
      <aside
        className="w-56 flex-shrink-0 flex flex-col"
        style={{ backgroundColor: '#16171E', borderRight: '1px solid #2A2B38', color: '#E8E9F0' }}
      >
        {/* Logo / title */}
        <div className="px-5 py-5" style={{ borderBottom: '1px solid #2A2B38' }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#4C8BF5' }}>
            HITL-CDT
          </p>
          <p className="text-sm mt-0.5 leading-tight" style={{ color: '#B0B3C6' }}>
            Cognitive Digital Twin
          </p>
        </div>

        {/* Sectioned nav links */}
        <nav className="flex-1 py-2 px-2 overflow-y-auto">
          {NAV_SECTIONS.map(section => {
            const visibleItems = section.items.filter(({ key }) => !lockedKeys.has(key));
            if (visibleItems.length === 0) return null;
            return (
              <div key={section.label}>
                {/* Section label */}
                <p
                  className="text-xs uppercase tracking-wide mt-3 mb-1 px-3"
                  style={{ color: '#4A4D60', letterSpacing: '0.07em' }}
                >
                  {section.label}
                </p>

                {visibleItems.map(({ key, label, emoji }) => {
                  const active = activePanel === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setActivePanel(key)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
                      style={{
                        backgroundColor: active ? 'rgba(76,139,245,0.15)' : 'transparent',
                        color: active ? '#4C8BF5' : '#B0B3C6',
                      }}
                    >
                      <span className="text-base leading-none">{emoji}</span>
                      <span className="flex-1 text-left">{label}</span>
                      {/* Green pulse dot — visible only on Experiment when running */}
                      {key === 'experiment' && experimentRunning && (
                        <span
                          className="w-2 h-2 rounded-full animate-pulse"
                          style={{ backgroundColor: '#3EBD8C', flexShrink: 0 }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {aiPanelsLocked && (
          <div
            className="mx-3 mb-3 px-2.5 py-2 rounded-md text-[11px]"
            style={{ color: '#E8913A', backgroundColor: 'rgba(232,145,58,0.12)', border: '1px solid rgba(232,145,58,0.35)' }}
          >
            Human-only mode active: AI Explanation and Analytics panels are hidden.
          </div>
        )}

        {/* WebSocket status indicator */}
        <div
          className="px-4 py-3 flex items-center gap-2 text-xs"
          style={{ borderTop: '1px solid #2A2B38' }}
        >
          {connected
            ? <><Wifi size={13} style={{ color: '#3EBD8C' }} /><span style={{ color: '#3EBD8C' }}>Live</span></>
            : <><WifiOff size={13} style={{ color: '#6B7080' }} /><span style={{ color: '#6B7080' }}>Disconnected</span></>
          }
          <span className="ml-auto" style={{ color: '#4A4D60' }}>:4000</span>
        </div>
      </aside>

      {/* ----------------------------------------------------------------- */}
      {/* Main content — all panels stay mounted, inactive ones are hidden   */}
      {/* ----------------------------------------------------------------- */}
      <main className="flex-1 overflow-auto">
        <div style={panelStyle('queue')}>
          <IncidentQueue onSelect={setSelectedIncidentId} />
        </div>
        {!aiPanelsLocked && (
          <div style={panelStyle('shap')}>
            <ShapExplainer incidentId={selectedIncidentId} />
          </div>
        )}
        <div style={panelStyle('decision')}>
          <DecisionPanel incidentId={selectedIncidentId} />
        </div>
        <div style={panelStyle('twin')}>
          <TwinStatePanel twinState={twinState} connected={connected} />
        </div>
        {!aiPanelsLocked && (
          <div style={panelStyle('analytics')}>
            <AnalyticsDashboard />
          </div>
        )}
        <div style={panelStyle('experiment')}>
          {/* setActivePanel is passed so the CTA button inside can navigate to the queue */}
          <ExperimentControl setActivePanel={setActivePanel} />
        </div>
      </main>

    </div>
  );
}

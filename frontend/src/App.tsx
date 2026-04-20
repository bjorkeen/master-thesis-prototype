/**
 * App.tsx — Root layout for HITL-CDT.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │  Sidebar (nav)  │  Main content area            │
 *   │                 │  (one of the 6 panels)        │
 *   └─────────────────────────────────────────────────┘
 *
 * The sidebar links switch which panel is visible.
 * Twin state arrives via WebSocket and is passed down to panels that need it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Inbox,
  Brain,
  CheckSquare,
  Activity,
  BarChart2,
  FlaskConical,
  Wifi,
  WifiOff,
} from 'lucide-react';

import { useWebSocket } from './hooks/useWebSocket';
import { useApi } from './hooks/useApi';
import { IncidentQueue }     from './components/IncidentQueue';
import { ShapExplainer }     from './components/ShapExplainer';
import { DecisionPanel }     from './components/DecisionPanel';
import { TwinStatePanel }    from './components/TwinStatePanel';
import { AnalyticsDashboard} from './components/AnalyticsDashboard';
import { ExperimentControl } from './components/ExperimentControl';

// ---------------------------------------------------------------------------
// Sidebar navigation items
// ---------------------------------------------------------------------------
type PanelKey = 'queue' | 'shap' | 'decision' | 'twin' | 'analytics' | 'experiment';

const NAV_ITEMS: { key: PanelKey; label: string; Icon: React.ElementType }[] = [
  { key: 'queue',      label: 'Incident Queue',   Icon: Inbox        },
  { key: 'shap',       label: 'AI Explanation',   Icon: Brain        },
  { key: 'decision',   label: 'Decision Panel',   Icon: CheckSquare  },
  { key: 'twin',       label: 'Digital Twin',     Icon: Activity     },
  { key: 'analytics',  label: 'Analytics',        Icon: BarChart2    },
  { key: 'experiment', label: 'Experiment',       Icon: FlaskConical },
];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [activePanel, setActivePanel] = useState<PanelKey>('queue');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const { twinState, connected } = useWebSocket();
  const { get } = useApi();
  const [experimentCtx, setExperimentCtx] = useState<{ mode: string; active: boolean } | null>(null);

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

  const aiPanelsLocked = experimentCtx?.active && experimentCtx.mode === 'human_only';
  const visibleNavItems = useMemo(
    () => aiPanelsLocked
      ? NAV_ITEMS.filter(({ key }) => key !== 'shap' && key !== 'analytics')
      : NAV_ITEMS,
    [aiPanelsLocked]
  );

  useEffect(() => {
    if (aiPanelsLocked && (activePanel === 'shap' || activePanel === 'analytics')) {
      setActivePanel('queue');
    }
  }, [aiPanelsLocked, activePanel]);

  // All panels are always mounted; only the active one is visible.
  // This preserves component state (e.g. a running experiment) across navigation.
  function panelStyle(key: PanelKey): React.CSSProperties {
    return activePanel === key ? { display: 'flex', flexDirection: 'column', height: '100%' } : { display: 'none' };
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

        {/* Nav links */}
        <nav className="flex-1 py-4 space-y-0.5 px-2">
          {visibleNavItems.map(({ key, label, Icon }) => {
            const active = activePanel === key;
            return (
              <button
                key={key}
                onClick={() => setActivePanel(key)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
                style={{
                  backgroundColor: active ? 'rgba(76,139,245,0.15)' : 'transparent',
                  color: active ? '#4C8BF5' : '#B0B3C6',
                }}
              >
                <Icon size={16} />
                {label}
              </button>
            );
          })}
        </nav>

        {aiPanelsLocked && (
          <div className="mx-3 mb-3 px-2.5 py-2 rounded-md text-[11px]"
            style={{ color: '#E8913A', backgroundColor: 'rgba(232,145,58,0.12)', border: '1px solid rgba(232,145,58,0.35)' }}>
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
          <ExperimentControl />
        </div>
      </main>

    </div>
  );
}

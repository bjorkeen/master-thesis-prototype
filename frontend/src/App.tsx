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

import { useState } from 'react';
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

  // Render the active panel — pass selectedIncidentId down to panels that need it
  function renderPanel() {
    switch (activePanel) {
      case 'queue':      return <IncidentQueue onSelect={setSelectedIncidentId} />;
      case 'shap':       return <ShapExplainer />;
      case 'decision':   return <DecisionPanel />;
      case 'twin':       return <TwinStatePanel twinState={twinState} connected={connected} />;
      case 'analytics':  return <AnalyticsDashboard />;
      case 'experiment': return <ExperimentControl />;
    }
  }

  // Suppress unused-variable warning until ShapExplainer / DecisionPanel use it
  void selectedIncidentId;

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
          {NAV_ITEMS.map(({ key, label, Icon }) => {
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
      {/* Main content                                                       */}
      {/* ----------------------------------------------------------------- */}
      <main className="flex-1 overflow-auto">
        {renderPanel()}
      </main>

    </div>
  );
}

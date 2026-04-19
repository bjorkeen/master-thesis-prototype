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
  const { twinState, connected } = useWebSocket();

  // Render the active panel
  function renderPanel() {
    switch (activePanel) {
      case 'queue':      return <IncidentQueue />;
      case 'shap':       return <ShapExplainer />;
      case 'decision':   return <DecisionPanel />;
      case 'twin':       return <TwinStatePanel twinState={twinState} connected={connected} />;
      case 'analytics':  return <AnalyticsDashboard />;
      case 'experiment': return <ExperimentControl />;
    }
  }

  return (
    <div className="flex h-screen bg-gray-100 text-gray-900">

      {/* ----------------------------------------------------------------- */}
      {/* Sidebar                                                            */}
      {/* ----------------------------------------------------------------- */}
      <aside className="w-56 flex-shrink-0 bg-gray-900 text-gray-100 flex flex-col">

        {/* Logo / title */}
        <div className="px-5 py-5 border-b border-gray-700">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
            HITL-CDT
          </p>
          <p className="text-sm text-gray-300 mt-0.5 leading-tight">
            Cognitive Digital Twin
          </p>
        </div>

        {/* Nav links */}
        <nav className="flex-1 py-4 space-y-1 px-2">
          {NAV_ITEMS.map(({ key, label, Icon }) => {
            const active = activePanel === key;
            return (
              <button
                key={key}
                onClick={() => setActivePanel(key)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors
                  ${active
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                  }`}
              >
                <Icon size={16} />
                {label}
              </button>
            );
          })}
        </nav>

        {/* WebSocket status indicator at the bottom */}
        <div className="px-4 py-3 border-t border-gray-700 flex items-center gap-2 text-xs">
          {connected
            ? <><Wifi size={13} className="text-green-400" /><span className="text-green-400">Live</span></>
            : <><WifiOff size={13} className="text-gray-500" /><span className="text-gray-500">Disconnected</span></>
          }
          <span className="text-gray-600 ml-auto">:4000</span>
        </div>
      </aside>

      {/* ----------------------------------------------------------------- */}
      {/* Main content                                                       */}
      {/* ----------------------------------------------------------------- */}
      <main className="flex-1 overflow-auto bg-white rounded-tl-2xl shadow-inner">
        {renderPanel()}
      </main>

    </div>
  );
}

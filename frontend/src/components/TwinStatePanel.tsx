/**
 * TwinStatePanel — real-time view of Digital Twin pipeline metrics.
 * Updates automatically via WebSocket every 5 seconds.
 * (Placeholder — full implementation in Phase 3)
 */
import type { TwinState } from '../types';

interface Props {
  twinState: TwinState | null;
  connected: boolean;
}

export function TwinStatePanel({ twinState, connected }: Props) {
  return (
    <div className="flex flex-col h-full p-6">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-lg font-semibold text-gray-800">Digital Twin State</h2>
        {/* Live indicator dot */}
        <span
          className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-300'}`}
          title={connected ? 'Live' : 'Disconnected'}
        />
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Real-time pipeline metrics — refreshes every 5 s via WebSocket.
      </p>
      <div className="flex-1 flex items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-gray-50">
        {twinState ? (
          <pre className="text-xs text-gray-500">{JSON.stringify(twinState, null, 2)}</pre>
        ) : (
          <span className="text-gray-400 text-sm">— Waiting for twin state… —</span>
        )}
      </div>
    </div>
  );
}

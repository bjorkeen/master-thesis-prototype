/**
 * ExperimentControl — start / stop experiment runs, choose mode
 * (AI-only / Human-only / HITL), and export results as CSV.
 * (Placeholder — full implementation in Phase 3)
 */
export function ExperimentControl() {
  return (
    <div className="flex flex-col h-full p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-1">Experiment Control</h2>
      <p className="text-sm text-gray-500 mb-4">
        Start/stop runs, select mode (AI-only / Human-only / HITL), export CSV.
      </p>
      <div className="flex-1 flex items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-gray-50">
        <span className="text-gray-400 text-sm">— Mode selector and run controls will appear here —</span>
      </div>
    </div>
  );
}

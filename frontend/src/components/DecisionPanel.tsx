/**
 * DecisionPanel — shows the AI recommendation and lets the human analyst
 * accept, override, or add a reason before submitting the final decision.
 * (Placeholder — full implementation in Phase 3)
 */
export function DecisionPanel() {
  return (
    <div className="flex flex-col h-full p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-1">Decision Panel</h2>
      <p className="text-sm text-gray-500 mb-4">
        Review AI recommendation and submit human decision.
      </p>
      <div className="flex-1 flex items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-gray-50">
        <span className="text-gray-400 text-sm">— Accept / Override controls will appear here —</span>
      </div>
    </div>
  );
}

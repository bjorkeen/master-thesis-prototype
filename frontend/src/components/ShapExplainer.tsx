/**
 * ShapExplainer — waterfall chart showing which features drove the AI's
 * recommendation for the currently selected incident.
 * (Placeholder — full implementation in Phase 3)
 */
export function ShapExplainer() {
  return (
    <div className="flex flex-col h-full p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-1">AI Explanation (SHAP)</h2>
      <p className="text-sm text-gray-500 mb-4">
        Feature contributions for the selected incident.
      </p>
      <div className="flex-1 flex items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-gray-50">
        <span className="text-gray-400 text-sm">— SHAP waterfall chart will appear here —</span>
      </div>
    </div>
  );
}

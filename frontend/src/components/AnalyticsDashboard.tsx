/**
 * AnalyticsDashboard — accuracy, cost, and override-rate charts comparing
 * AI-only vs Human-only vs HITL runs using Recharts.
 * (Placeholder — full implementation in Phase 3)
 */
export function AnalyticsDashboard() {
  return (
    <div className="flex flex-col h-full p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-1">Analytics Dashboard</h2>
      <p className="text-sm text-gray-500 mb-4">
        Accuracy, cost, and override-rate across experiment modes.
      </p>
      <div className="flex-1 flex items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-gray-50">
        <span className="text-gray-400 text-sm">— Recharts graphs will appear here —</span>
      </div>
    </div>
  );
}

/**
 * types/index.ts — TypeScript interfaces for all API response shapes.
 *
 * These match the JSON that the Python services return.
 * If a field is optional (not always present) we mark it with `?`.
 */

// ---------------------------------------------------------------------------
// Incident — one data-quality incident fed into the system
// ---------------------------------------------------------------------------
export interface Incident {
  incident_id: string;
  anomaly_type: 'null_values' | 'duplicates' | 'schema_mismatch' | 'outlier' | 'referential_integrity' | 'data_corruption';
  affected_records_pct: number;      // 0.1 – 100.0
  data_source: 'crm' | 'erp' | 'api_feed' | 'manual_entry' | 'iot_stream' | 'data_warehouse';
  pipeline_stage: 'ingestion' | 'transformation' | 'validation' | 'loading' | 'serving';
  historical_frequency: 'first_occurrence' | 'rare' | 'occasional' | 'frequent' | 'chronic';
  time_sensitivity: 'low' | 'medium' | 'high' | 'critical';
  data_domain: 'finance' | 'marketing' | 'operations' | 'hr' | 'product' | 'compliance';
  confidence_score?: number;
  predicted_action?: 'auto_resolve' | 'escalate' | 'critical';
  ground_truth?: string;
  status: 'open' | 'resolved' | 'overridden';
  created_at: string;                // ISO timestamp string
  resolved_at?: string | null;
}

// ---------------------------------------------------------------------------
// Decision — one routing decision (AI recommendation + optional human action)
// Returned by GET /api/decisions/log
// ---------------------------------------------------------------------------
export interface Decision {
  decision_id: string;
  incident_id: string;
  run_id: string;
  experiment_mode: 'ai_only' | 'human_only' | 'hitl';
  ai_recommendation: 'auto_resolve' | 'escalate' | 'critical';
  ai_confidence: number;             // 0–1
  routing_action: 'auto_resolve' | 'escalate' | 'critical';
  human_action?: string | null;
  human_override_to?: string | null;
  override_reason?: string | null;
  final_action: string;
  ground_truth?: string | null;
  is_correct?: boolean | null;
  cost?: number | null;              // euros
  resolution_time_s?: number | null;
  decided_at: string;
}

export type DecisionAction = 'auto_resolve' | 'escalate' | 'critical';

// ---------------------------------------------------------------------------
// Override contract — POST /api/decisions/{id}/override
// ---------------------------------------------------------------------------
export interface OverrideDecisionRequest {
  new_action: DecisionAction;
  override_reason: string;
  ground_truth?: string;
}

export interface OverrideDecisionResponse {
  decision_id: string;
  old_action: DecisionAction;
  new_action: DecisionAction;
  override_reason: string;
  cost_delta?: number | null;
}

// ---------------------------------------------------------------------------
// TwinState — the real-time pipeline state from the Digital Twin service
// ---------------------------------------------------------------------------
export interface TwinState {
  open_incidents: number;
  open_critical: number;
  open_escalated: number;
  queue_depth: number;
  throughput_per_hour: number;
  analyst_workload_pct: number;      // 0–100
  sla_remaining_s: number;          // seconds until SLA breach
  sla_total_s: number;              // total SLA window in seconds
  auto_resolve_rate: number;        // 0–1 fraction
  snapshot_id?: number;
  timestamp?: string;
}

// SLA sub-response from GET /twin/sla
export interface SlaStatus {
  sla_remaining_s: number;
  sla_used_pct: number;
  risk_level: 'green' | 'yellow' | 'red';
}

// ---------------------------------------------------------------------------
// ShapExplanation — feature-level explanation for one incident
//
// GET /api/explain/{incident_id} returns three parallel arrays.
// The ShapExplainer component zips them into {feature, value, display} objects.
// ---------------------------------------------------------------------------
export interface ShapExplanation {
  incident_id: string;
  predicted_class: string;              // what the model predicted, e.g. "escalate"
  explained_class: string;             // which class SHAP values explain (usually same)
  base_value: number;                  // SHAP base value (expected model output)
  shap_values: number[];               // one float per feature
  feature_names: string[];             // parallel — feature identifiers
  feature_values: (string | number)[]; // parallel — actual values for this incident
}

// ---------------------------------------------------------------------------
// ExperimentResults — summary returned by GET /api/experiment/results
// and embedded in the POST /api/experiment/stop response
// ---------------------------------------------------------------------------
export interface ExperimentResults {
  run_id: string;
  mode: 'ai_only' | 'human_only' | 'hitl';
  total_incidents: number;
  correct_decisions: number;
  accuracy: number;
  total_cost: number;
  avg_cost_per_incident: number;
  avg_resolution_time_s?: number | null;
  override_count: number;
  override_rate: number;
  started_at: string;
  completed_at?: string | null;
  cost_breakdown: Record<string, { count: number; total_cost: number }>;
}

// ---------------------------------------------------------------------------
// DecisionStats — returned by GET /api/decisions/stats
//
// cost_breakdown is keyed by final_action (e.g. "auto_resolve", "escalate",
// "critical") and each entry holds the count and summed cost for that action.
// ---------------------------------------------------------------------------
export interface DecisionStats {
  run_id?: string;
  experiment_mode?: string;
  total_decisions: number;
  correct_decisions: number;
  accuracy: number;
  total_cost: number;
  avg_cost_per_incident: number;
  avg_resolution_time_s?: number | null;
  override_count: number;
  override_rate: number;
  cost_breakdown: Record<string, { count: number; total_cost: number }>;
}

// ---------------------------------------------------------------------------
// RoutingResponse — returned by POST /api/route (Decision Service)
// ---------------------------------------------------------------------------
export interface RoutingResponse {
  incident_id: string;
  routing_decision: 'auto_resolve' | 'escalate' | 'critical';
  ai_recommendation: 'auto_resolve' | 'escalate' | 'critical';
  ai_confidence: number;             // 0–1
  class_probabilities: Record<string, number>;  // e.g. { auto_resolve: 0.15, escalate: 0.72, critical: 0.13 }
  experiment_mode: string;
  thresholds_used: Record<string, number>;       // e.g. { auto_resolve: 0.85, critical: 0.50 }
  twin_context: TwinState;           // pipeline state snapshot at time of routing
  explanation: string;               // plain-English reason for the decision
}

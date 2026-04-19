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
// ---------------------------------------------------------------------------
export interface Decision {
  decision_id: string;
  incident_id: string;
  run_id: string;
  experiment_mode: 'ai_only' | 'human_only' | 'hitl';
  ai_recommendation: 'auto_resolve' | 'escalate' | 'critical';
  ai_confidence: number;             // 0–1
  routing_action: 'auto_resolve' | 'send_to_human' | 'critical_alert';
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
// The ML Service returns three parallel arrays; the component zips them.
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
// ExperimentResults — summary returned after /experiment/stop
// ---------------------------------------------------------------------------
export interface ExperimentResults {
  run_id: string;
  mode: 'ai_only' | 'human_only' | 'hitl';
  total_incidents: number;
  accuracy: number;
  total_cost: number;
  avg_resolution_time_s?: number | null;
  override_count: number;
  override_rate: number;
  started_at: string;
  completed_at?: string | null;
}

// ---------------------------------------------------------------------------
// Decision stats — returned by GET /decisions/stats
// ---------------------------------------------------------------------------
export interface DecisionStats {
  run_id?: string;
  total_decisions: number;
  correct_decisions: number;
  accuracy: number;
  total_cost: number;
  avg_resolution_time_s?: number | null;
  override_count: number;
  override_rate: number;
  by_action: Record<string, number>;  // e.g. { auto_resolve: 12, escalate: 5 }
}

// ---------------------------------------------------------------------------
// Routing response — returned by POST /decisions/route (via Decision Service)
// ---------------------------------------------------------------------------
export interface RoutingResponse {
  decision_id: string;
  incident_id: string;
  routing_action: 'auto_resolve' | 'send_to_human' | 'critical_alert';
  ai_recommendation: 'auto_resolve' | 'escalate' | 'critical';
  ai_confidence: number;
  confidence_threshold_used: number;
  explanation: string;
  shap?: ShapExplanation;
  sla_risk?: 'green' | 'yellow' | 'red';
}

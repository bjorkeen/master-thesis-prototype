# HITL-CDT: Human-in-the-Loop Cognitive Digital Twin

## Project Overview
This is a Master's thesis prototype for evaluating Human-in-the-Loop decision-making 
in a Cognitive Digital Twin architecture, applied to Data Quality Incident Management.

The system classifies data quality incidents into three categories:
- **auto_resolve** (routine, AI handles automatically)
- **escalate** (ambiguous, needs human review with AI recommendation + SHAP explanation)
- **critical** (urgent, immediate human attention)

Three experimental modes are compared: AI-only, Human-only, and HITL (collaborative).

## Architecture
- **Frontend**: React + TypeScript (Vite, Tailwind CSS, Recharts, Radix UI) on port 5173
- **API Gateway**: Node.js Express + Socket.io on port 4000
- **ML Service**: Python FastAPI on port 8001 (scikit-learn RandomForest + SHAP)
- **Twin Service**: Python FastAPI on port 8002 (pipeline state engine)
- **Decision Service**: Python FastAPI on port 8003 (routing logic + decision logging)
- **Database**: PostgreSQL on port 5432 (or SQLite fallback)

## Current Build Status
COMPLETED:
- data/generate_dataset.py — generates 3,000 synthetic incidents (60/30/10 distribution, ~32% ambiguity zone)
- data/train_model.py — trains RandomForest (200 trees, balanced weights), generates SHAP plots
- data/incidents.csv — 3,000 rows, 7 features + severity scores + ground truth labels
- data/rf_model.joblib — trained model (68.3% accuracy, macro F1=0.57)
- data/feature_encoder.joblib — OrdinalEncoder for 6 categorical features
- data/label_encoder.joblib — maps auto_resolve/critical/escalate to integers
- data/feature_names.json — ordered list of 7 feature column names
- config/routing_config.yaml — thresholds (auto≥0.85, critical<0.50), SLA boost schedule
- config/cost_model.yaml — asymmetric costs (missed_critical=100, false_escalation=10)
- services/ml-service/main.py — FastAPI :8001, endpoints: POST /predict, POST /predict/batch, POST /explain/features, GET /explain/{id}, GET /explain/global, GET /model/info, GET /health
- services/twin-service/main.py — FastAPI :8002, endpoints: GET /state, POST /state/event, GET /state/history, GET /sla, POST /simulate, POST /reset, GET /health
- services/decision-service/main.py — FastAPI :8003, endpoints: POST /route, POST /decisions, POST /decisions/{id}/override, GET /decisions/log, GET /decisions/stats, POST /experiment/start, POST /experiment/stop, GET /experiment/results, GET /experiment/export, GET /health

NOT YET BUILT:
- Database setup (PostgreSQL tables or SQLite fallback) — NEXT STEP
- gateway/ — Node.js Express + Socket.io API gateway on port 4000
- frontend/ — React SPA with components: IncidentQueue, ShapExplainer, DecisionPanel, TwinStatePanel, AnalyticsDashboard, ExperimentControl

## Key Design Parameters
- Dataset: 3,000 synthetic incidents (60% auto_resolve, 30% escalate, 10% critical)
- 7 features: anomaly_type, affected_records_pct, data_source, pipeline_stage, historical_frequency, time_sensitivity, data_domain
- Feature categories:
  - anomaly_type: null_values, duplicates, schema_mismatch, outlier, referential_integrity, data_corruption
  - data_source: crm, erp, api_feed, manual_entry, iot_stream, data_warehouse
  - pipeline_stage: ingestion, transformation, validation, loading, serving
  - historical_frequency: first_occurrence, rare, occasional, frequent, chronic
  - time_sensitivity: low, medium, high, critical
  - data_domain: finance, marketing, operations, hr, product, compliance
- affected_records_pct: continuous 0.1–100.0, Beta distribution (mean ~23%)
- ~32% of incidents in ambiguity zone (Gaussian noise σ=0.10)
- Ground truth via probabilistic scoring with domain multiplier + noise + percentile thresholds (T1=0.468, T2=0.609)
- ML model: RandomForest, 200 trees, class_weight='balanced', OrdinalEncoder for categoricals
- Model performance: auto_resolve F1=0.82, escalate F1=0.46, critical F1=0.43, macro F1=0.57
- SHAP: TreeExplainer, explains 'escalate' class by default (the ambiguous one humans review)
- Confidence thresholds: >0.85 = auto-resolve, <0.50 = critical, between = escalate
- SLA boost: thresholds tighten when SLA < 10min or < 5min remaining
- Cost model: correct_auto=€0, correct_escalate=€10, correct_critical=€15, false_escalation=€10, missed_escalation=€50, missed_critical=€100, human_misclassification=€30

## Project Structure
```
hitl-cdt/
├── data/                    # Dataset generation + ML training
│   ├── generate_dataset.py  # Creates incidents.csv (3,000 rows)
│   ├── train_model.py       # Trains RF + SHAP, saves artefacts
│   ├── incidents.csv        # Generated dataset
│   ├── rf_model.joblib      # Trained RandomForest model
│   ├── feature_encoder.joblib # OrdinalEncoder for categoricals
│   ├── label_encoder.joblib # LabelEncoder for target classes
│   ├── feature_names.json   # Ordered feature column names
│   ├── confusion_matrix.png # Model evaluation plot
│   ├── shap_summary.png     # Global SHAP beeswarm (escalate class)
│   └── shap_waterfall.png   # Single-incident waterfall
├── config/
│   ├── routing_config.yaml  # Thresholds, SLA boost, service URLs
│   └── cost_model.yaml      # Asymmetric operational cost values
├── services/
│   ├── ml-service/          # FastAPI :8001
│   │   ├── main.py          # 519 lines — predict + SHAP endpoints
│   │   └── requirements.txt
│   ├── twin-service/        # FastAPI :8002
│   │   ├── main.py          # 661 lines — state engine + SLA + simulate
│   │   └── requirements.txt
│   └── decision-service/    # FastAPI :8003
│       ├── main.py          # 938 lines — routing + logging + experiments
│       └── requirements.txt
├── gateway/                 # Node.js Express :4000 (NOT YET BUILT)
├── frontend/                # React + Vite :5173 (NOT YET BUILT)
├── CLAUDE.md                # This file
└── README.md
```

## Database Schema (to be created)
### incidents table
id (SERIAL PK), incident_id (VARCHAR UNIQUE), anomaly_type (VARCHAR), affected_records_pct (FLOAT),
data_source (VARCHAR), pipeline_stage (VARCHAR), historical_frequency (VARCHAR),
time_sensitivity (VARCHAR), data_domain (VARCHAR), confidence_score (FLOAT),
predicted_action (VARCHAR), ground_truth (VARCHAR), status (VARCHAR DEFAULT 'open'),
created_at (TIMESTAMP DEFAULT NOW), resolved_at (TIMESTAMP NULL)

### decisions table
id (SERIAL PK), decision_id (VARCHAR UNIQUE), incident_id (VARCHAR FK→incidents), 
run_id (VARCHAR), experiment_mode (VARCHAR), ai_recommendation (VARCHAR), 
ai_confidence (FLOAT), routing_action (VARCHAR), human_action (VARCHAR NULL),
human_override_to (VARCHAR NULL), override_reason (TEXT NULL), final_action (VARCHAR),
ground_truth (VARCHAR NULL), is_correct (BOOLEAN NULL), cost (FLOAT NULL),
resolution_time_s (FLOAT NULL), decided_at (TIMESTAMP DEFAULT NOW)

### twin_snapshots table
id (SERIAL PK), snapshot_id (INT), timestamp (TIMESTAMP), open_incidents (INT),
open_critical (INT), open_escalated (INT), queue_depth (INT),
throughput_per_hour (FLOAT), analyst_workload_pct (FLOAT),
sla_remaining_s (FLOAT), auto_resolve_rate (FLOAT)

### experiment_runs table
id (SERIAL PK), run_id (VARCHAR UNIQUE), mode (VARCHAR), total_incidents (INT),
accuracy (FLOAT), total_cost (FLOAT), avg_resolution_time_s (FLOAT NULL),
override_count (INT DEFAULT 0), override_rate (FLOAT DEFAULT 0),
started_at (TIMESTAMP), completed_at (TIMESTAMP NULL)

## API Endpoints Summary
### ML Service (:8001)
- POST /predict — input: 7 incident features → output: {predicted_class, confidence, class_probabilities}
- POST /predict/batch — input: list of incidents → output: list of predictions
- POST /explain/features — input: 7 features + explain_class → output: {shap_values, feature_names, base_value}
- GET /explain/{incident_id} — output: SHAP explanation (currently placeholder, needs DB)
- GET /explain/global — output: {feature_names, importances}
- GET /model/info — output: {model_type, n_estimators, classes, feature_names}
- GET /health — output: {status, model_loaded}

### Twin Service (:8002)
- GET /state — output: full PipelineState (open_incidents, queue_depth, workload, SLA, etc.)
- POST /state/event — input: {event_type: arrive|resolve, incident_id, severity} → updates state
- GET /state/history?limit=100 — output: list of StateSnapshot objects
- GET /sla — output: {sla_remaining_s, sla_used_pct, risk_level: green|yellow|red}
- POST /simulate — input: {additional_arrivals, additional_resolutions, severity_mix} → projected state
- POST /reset — resets all state to zero for new experiment
- GET /health — output: {status, snapshot_count}

### Decision Service (:8003)
- POST /route — THE MAIN ENDPOINT: takes incident features, calls ML+Twin, returns routing decision with explanation
- POST /decisions — logs a completed decision record with ground_truth, computes is_correct and cost
- POST /decisions/{id}/override — records human override, recalculates cost
- GET /decisions/log?page=1&page_size=20&mode=hitl&run_id=X — paginated decision history
- GET /decisions/stats?run_id=X — accuracy, cost, timing, override metrics
- POST /experiment/start — input: {mode, incident_count} → begins new run, resets Twin
- POST /experiment/stop — ends run, computes final ExperimentResults
- GET /experiment/results — returns ExperimentResults for last completed run
- GET /experiment/export?run_id=X — streams decision log as CSV download
- GET /health — output: {status, experiment_mode, experiment_active, decision_count}

## How Services Communicate
1. Frontend (React) → Gateway (:4000) via HTTP REST + WebSocket
2. Gateway → proxies to ML/Twin/Decision services
3. Decision Service (:8003) → ML Service (:8001) via async httpx (POST /predict)
4. Decision Service (:8003) → Twin Service (:8002) via async httpx (GET /state, POST /state/event)
5. Decision Service reads config/routing_config.yaml and config/cost_model.yaml on startup

## Important Notes for Claude Code
- I am a beginner. Please write complete files with detailed comments explaining each part.
- Always use simple, readable code. Avoid clever abstractions.
- When creating a new file, always show me how to run/test it.
- If using a new library, show the install command first.
- If you encounter an error, explain what it means in plain English before fixing it.
- For Python services, always include the FastAPI /docs endpoint reminder.
- For React components, use TypeScript, Tailwind CSS, and functional components with hooks.
- The services currently use in-memory storage. The database setup is the next step.
- When building the database layer, consider using SQLite as a simpler alternative to PostgreSQL if there are setup issues.

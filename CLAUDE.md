# HITL-CDT: Human-in-the-Loop Cognitive Digital Twin

## Project Overview

This is a Master's thesis prototype for evaluating Human-in-the-Loop decision-making
in a Cognitive Digital Twin architecture, applied to Data Quality Incident Management.

The system classifies data quality incidents into three categories:

- **auto-resolve** (routine, AI handles automatically)
- **escalate** (ambiguous, needs human review with AI recommendation + SHAP explanation)
- **critical** (urgent, immediate human attention)

Three experimental modes are compared: AI-only, Human-only, and HITL (collaborative).

## Architecture

- **Frontend**: React + TypeScript (Vite, Tailwind CSS, Recharts, Radix UI) on port 5173
- **API Gateway**: Node.js Express + Socket.io on port 4000
- **ML Service**: Python FastAPI on port 8001 (scikit-learn RandomForest + SHAP)
- **Twin Service**: Python FastAPI on port 8002 (pipeline state engine)
- **Decision Service**: Python FastAPI on port 8003 (routing logic + decision logging)
- **Database**: PostgreSQL on port 5432 (tables: incidents, decisions, twin_snapshots, experiment_runs)

## Key Design Parameters

- Dataset: 3,000 synthetic incidents (60% auto-resolve, 30% escalate, 10% critical)
- 7 features: anomaly_type, affected_records_pct, data_source, pipeline_stage, historical_frequency, time_sensitivity, data_domain
- ~25-30% of incidents in an ambiguity zone (near class boundaries)
- Ground truth via probabilistic scoring with Gaussian noise
- SHAP TreeExplainer for post-hoc explainability
- Confidence thresholds: >0.85 = auto-resolve, <0.50 = critical, between = escalate
- Cost model: missed critical = €100, missed escalate = €50, false escalation = €10

## Project Structure

hitl-cdt/
├── data/ # Dataset generation + ML training
│ ├── generate_dataset.py # Creates incidents.csv
│ ├── train_model.py # Trains RF + SHAP, saves rf_model.joblib
│ ├── incidents.csv # Generated dataset
│ └── rf_model.joblib # Trained model
├── config/
│ ├── routing_config.yaml # Decision routing thresholds
│ └── cost_model.yaml # Operational cost values
├── services/
│ ├── ml-service/ # FastAPI :8001
│ │ └── main.py
│ ├── twin-service/ # FastAPI :8002
│ │ └── main.py
│ └── decision-service/ # FastAPI :8003
│ └── main.py
├── gateway/ # Node.js Express :4000
│ ├── package.json
│ └── index.js
├── frontend/ # React + Vite :5173
│ ├── src/
│ │ ├── components/
│ │ │ ├── IncidentQueue.tsx
│ │ │ ├── ShapExplainer.tsx
│ │ │ ├── DecisionPanel.tsx
│ │ │ ├── TwinStatePanel.tsx
│ │ │ ├── AnalyticsDashboard.tsx
│ │ │ └── ExperimentControl.tsx
│ │ ├── hooks/
│ │ │ ├── useApi.ts
│ │ │ └── useWebSocket.ts
│ │ ├── store/
│ │ ├── types/
│ │ └── App.tsx
│ └── package.json
└── CLAUDE.md # This file

## Database Schema

### incidents table

id (SERIAL PK), incident_id (VARCHAR), anomaly_type (VARCHAR), affected_records_pct (FLOAT),
data_source (VARCHAR), pipeline_stage (VARCHAR), historical_frequency (VARCHAR),
time_sensitivity (VARCHAR), data_domain (VARCHAR), confidence_score (FLOAT),
predicted_action (VARCHAR), ground_truth (VARCHAR), status (VARCHAR),
created_at (TIMESTAMP), resolved_at (TIMESTAMP)

### decisions table

id (SERIAL PK), incident_id (VARCHAR FK), experiment_mode (VARCHAR),
ai_recommendation (VARCHAR), ai_confidence (FLOAT), routing_action (VARCHAR),
human_action (VARCHAR), human_override_to (VARCHAR), override_reason (TEXT),
final_action (VARCHAR), is_correct (BOOLEAN), resolution_time_s (FLOAT),
cost (FLOAT), decided_at (TIMESTAMP)

### twin_snapshots table

id (SERIAL PK), timestamp (TIMESTAMP), open_incidents (INT), open_critical (INT),
open_escalated (INT), queue_depth (INT), throughput_per_hour (FLOAT),
analyst_workload_pct (FLOAT), sla_remaining_s (FLOAT), auto_resolve_rate (FLOAT)

### experiment_runs table

id (SERIAL PK), run_id (VARCHAR), mode (VARCHAR), total_incidents (INT),
accuracy (FLOAT), avg_resolution_time (FLOAT), total_cost (FLOAT),
override_rate (FLOAT), started_at (TIMESTAMP), completed_at (TIMESTAMP)

## API Endpoints

### ML Service (:8001)

- POST /predict — input: incident features → output: {predicted_class, confidence, probabilities}
- POST /predict/batch — input: list of incidents → output: list of predictions
- GET /explain/{incident_id} — output: {shap_values, feature_names, base_value}
- GET /explain/global — output: global feature importance
- GET /model/info — output: model version, accuracy metrics

### Twin Service (:8002)

- GET /state — output: current pipeline state
- POST /state/event — input: {event_type: "arrive"|"resolve", incident_id} → updates state
- GET /state/history — output: historical snapshots
- POST /simulate — input: scenario params → output: projected state
- GET /sla — output: SLA countdown
- POST /reset — resets state for new experiment

### Decision Service (:8003)

- POST /route — input: incident features → calls ML + Twin → output: routing decision
- POST /decisions — input: decision record → logs to DB
- POST /decisions/{id}/override — input: {new_action, reason} → logs override
- GET /decisions/log — output: paginated decision history
- GET /decisions/stats — output: accuracy, cost, time metrics
- POST /experiment/start — input: {mode, incident_count} → begins experiment
- POST /experiment/stop — ends experiment, computes results
- GET /experiment/results — output: evaluation metrics
- GET /experiment/export — output: CSV download

## Important Notes for Claude Code

- I am a beginner. Please write complete files with detailed comments explaining each part.
- Always use simple, readable code. Avoid clever abstractions.
- When creating a new file, always show me how to run/test it.
- If using a new library, show the install command first.
- If you encounter an error, explain what it means in plain English before fixing it.
- For Python services, always include the FastAPI /docs endpoint reminder.
- For React components, use TypeScript, Tailwind CSS, and functional components with hooks.

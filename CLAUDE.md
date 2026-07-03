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
- **Frontend**: React + TypeScript (Vite, Tailwind CSS, Recharts, Lucide) on port 5173
- **API Gateway**: Node.js Express + Socket.io on port 4000
- **ML Service**: Python FastAPI on port 8001 (scikit-learn RandomForest + SHAP)
- **Twin Service**: Python FastAPI on port 8002 (pipeline state engine)
- **Decision Service**: Python FastAPI on port 8003 (routing logic + decision logging)
- **Storage**: In-memory (per service process) for prototype evaluation; SQLite schema ready at `data/hitl_cdt.db` via `data/db.py` + `data/create_tables.py` for production use

## Dependencies (where each manifest lives)
There are FOUR Python dependency surfaces and TWO Node ones. The data-script deps are
separate from the service deps — do not assume installing the services covers the data scripts.
- `data/requirements.txt` — **setup-time** deps for the data scripts: numpy, pandas, scikit-learn,
  shap, joblib, **matplotlib** (train_model.py plots), **sqlalchemy** (db.py / create_tables.py).
  matplotlib and sqlalchemy are NOT in any `services/*/requirements.txt`, so the data scripts
  (`generate_dataset.py`, `train_model.py`, `create_tables.py`) need this file installed.
  Optional `psycopg2-binary` (commented) only if `DATABASE_URL` points at PostgreSQL; db.py imports
  psycopg2 lazily and falls back to SQLite otherwise.
- `services/ml-service/requirements.txt` — fastapi, uvicorn, pandas, numpy, scikit-learn, joblib,
  shap, httpx, python-multipart (runtime model + SHAP serving; httpx used by GET /explain/{id}).
- `services/twin-service/requirements.txt` — fastapi, uvicorn, python-multipart only (pure state engine,
  no ML/DB deps).
- `services/decision-service/requirements.txt` — fastapi, uvicorn, httpx (calls ML+Twin), pyyaml
  (reads the configs), python-multipart. NOTE: the running services do NOT import `data/db.py`, so
  SQLAlchemy is NOT a service runtime dep — it is only needed by `create_tables.py` at setup.
- `gateway/package.json` — express, cors, http-proxy-middleware v3, socket.io (+ nodemon dev).
- `frontend/package.json` — react 19, vite, tailwind v4, recharts, lucide-react, socket.io-client, axios.

## Current Build Status
Phase 1-3 complete. Phase 4 (experiments + thesis write-up) in progress.

### Phase 1 — Data Science Foundation
- data/generate_dataset.py — generates 3,000 synthetic incidents (60/30/10 distribution, ~30.2% ambiguity zone — 907/3000)
- data/train_model.py — trains RandomForest (200 trees, balanced weights), generates SHAP plots; by-name categorical handling for pandas 2.x/py3.13
- data/incidents.csv — 3,000 rows, 7 features + severity scores + ground truth labels
- data/rf_model.joblib — committed thesis model (68.3% accuracy, macro F1=0.57); use as-is for replication — retraining yields non-bit-identical artefacts
- data/feature_encoder.joblib — OrdinalEncoder for 6 categorical features
- data/label_encoder.joblib — maps auto_resolve/critical/escalate to integers
- data/feature_names.json — ordered list of 7 feature column names
- config/routing_config.yaml — thresholds (auto≥0.85, critical<0.50), SLA boost schedule
- config/cost_model.yaml — asymmetric costs (missed_critical=100, false_escalation=10)

### Phase 2 — Python Microservices
- services/ml-service/main.py — FastAPI :8001, ~532 lines
- services/twin-service/main.py — FastAPI :8002, ~664 lines
- services/decision-service/main.py — FastAPI :8003, ~1323 lines

### Phase 3 — Database + Gateway + Frontend
- data/db.py — SQLite connection helper, table definitions, CRUD functions (schema ready; services use in-memory storage during experiments)
- data/create_tables.py — creates the 4 tables (incidents, decisions, twin_snapshots, experiment_runs)
- data/hitl_cdt.db — SQLite database file (schema defined; not used by services at runtime — in-memory storage is sufficient for the fixed-batch experimental protocol)
- gateway/index.js — Node.js Express :4000, http-proxy-middleware v3, Socket.io WebSocket
- frontend/src/App.tsx — root layout, sectioned sidebar nav (SETUP/REVIEW/INSPECT/ANALYZE) with emoji icons, default panel = 'experiment', exports PanelKey type, green pulse dot when experiment active; on experiment stop (active→inactive, detected via the 5s /api/health poll or the ExperimentControl onStopped push) it clears selectedIncidentId and passes experimentActive to IncidentQueue so the review UI resets
- frontend/src/components/IncidentQueue.tsx — sortable incident list (click column headers; ↑/↓), info-tooltip ⓘ on each header, routing-action column with colour-coded badges, progress bar (reviewed/remaining/%), status badges (PENDING/REVIEWED), expandable inline detail panel (SHAP + Decision) with auto-advance to next pending in SORTED order; reviewed rows expand READ-ONLY; empty state when no experiment is active (experimentActive=false clears the table)
- frontend/src/components/ShapExplainer.tsx — SHAP horizontal bar chart, feature table; fetches GET /api/explain/{incidentId} (used standalone in sidebar AND inline in IncidentQueue)
- frontend/src/components/DecisionPanel.tsx — AI recommendation + human override form; optional onActionComplete callback for the inline-queue flow; readOnly mode (prop OR self-determined via isStillActionable) shows a locked outcome card (no action buttons) for already-reviewed / auto-resolved / ai_only decisions
- frontend/src/components/TwinStatePanel.tsx — live pipeline state gauges via WebSocket; SLA Health bar uses sla_total_s from twin state (not hardcoded)
- frontend/src/components/AnalyticsDashboard.tsx — accuracy/cost/override charts (Recharts); polls /api/decisions/stats every 5s and zeroes when a new run starts
- frontend/src/components/ExperimentControl.tsx — mode selector (locked during run), start/stop/force-stop/export, routing breakdown cards, progress stats, CTA banner, 10s polling for reviewed count, mount-sync after page refresh, onStopped callback to parent
- frontend/src/hooks/useApi.ts — typed GET/POST wrapper around fetch
- frontend/src/hooks/useWebSocket.ts — Socket.io client, twin state subscription
- frontend/src/types/index.ts — TypeScript interfaces for all API response shapes

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
- ~30.2% of incidents in ambiguity zone (907 of 3,000; Gaussian noise σ=0.10; boolean-OR union in summary stat)
- Ground truth via probabilistic scoring with domain multiplier + noise + percentile thresholds (T1=0.468, T2=0.609)
- ML model: RandomForest, 200 trees, class_weight='balanced', OrdinalEncoder for categoricals
- Model performance: auto_resolve F1=0.82, escalate F1=0.46, critical F1=0.43, macro F1=0.57
- SHAP: TreeExplainer, explains 'escalate' class by default (the ambiguous one humans review)
- Base confidence thresholds: auto_resolve ≥ 0.85, critical < 0.50 (config/routing_config.yaml)
- HITL routing is CLASS-AWARE (not a flat 3-way confidence cut). `_apply_routing_logic` in the decision service applies, in order:
  1. ai_only mode → routing_decision = the AI's predicted class directly (confidence ignored)
  2. human_only mode → always `escalate` (every incident goes to a human; AI ignored)
  3. HITL + predicted class `critical` → `critical` (safety-first; a critical class is NEVER auto-resolved)
  4. HITL + predicted class `auto_resolve` → `auto_resolve` if confidence ≥ T_auto, else `escalate`
  5. HITL + predicted class `escalate` → `critical` if confidence < T_crit (high uncertainty), else `escalate`
- Active-open SLA correction (decision service /route): SLA-boost would otherwise tighten T_auto/T_crit as the twin's open_incidents climbs during the unattended batch sweep, starving auto-resolve. /route computes `active_open = open_incidents − pending_backlog` (pending_backlog = this run's not-yet-reviewed rows) and only lets the SLA drain the thresholds when active_open > 0; during the batch sweep active_open ≈ 0, so routing uses the base gates and each incident is judged on its own confidence.
- SLA boost schedule: thresholds tighten when SLA < 10 min (auto +10%, crit +5%) or < 5 min (auto +20%, crit +10%); auto capped at 0.999
- Cost model: correct_auto=€0, correct_escalate=€10, correct_critical=€15, false_escalation=€10, missed_escalation=€50, missed_critical=€100, human_misclassification=€30 (defined in cost_model.yaml; human_misclassification not currently referenced by _compute_cost)
- **Model artefacts (replication):** committed rf_model.joblib trained under sklearn 1.6.1; reproduces thesis results (AI-only accuracy 89.0%; HITL routing split 14/70/16 on seed-42 sample). Re-running train_model.py on pandas 2.x/py3.13/sklearn 1.9.x yields a functionally equivalent but not bit-identical model — routing split may shift (e.g. 14 → 12 auto-resolved). Use committed artefacts as-is for replication.

## Project Structure
```
hitl-cdt/
├── data/
│   ├── generate_dataset.py    # Creates incidents.csv (3,000 rows)
│   ├── train_model.py         # Trains RF + SHAP, saves artefacts
│   ├── db.py                  # SQLite helper — connection, CRUD
│   ├── create_tables.py       # Creates the 4 DB tables
│   ├── hitl_cdt.db            # Live SQLite database
│   ├── incidents.csv          # Generated dataset
│   ├── rf_model.joblib        # Trained RandomForest model
│   ├── feature_encoder.joblib # OrdinalEncoder for categoricals
│   ├── label_encoder.joblib   # LabelEncoder for target classes
│   ├── feature_names.json     # Ordered feature column names
│   ├── confusion_matrix.png   # Model evaluation plot
│   ├── shap_summary.png       # Global SHAP beeswarm (escalate class)
│   ├── shap_waterfall.png     # Single-incident waterfall
│   └── requirements.txt       # Setup-time deps for the scripts above (numpy, pandas, scikit-learn, shap, joblib, matplotlib, sqlalchemy)
├── config/
│   ├── routing_config.yaml    # Thresholds, SLA boost, service URLs
│   └── cost_model.yaml        # Asymmetric operational cost values
├── services/
│   ├── ml-service/            # FastAPI :8001
│   │   ├── main.py
│   │   └── requirements.txt
│   ├── twin-service/          # FastAPI :8002
│   │   ├── main.py
│   │   └── requirements.txt
│   └── decision-service/      # FastAPI :8003
│       ├── main.py
│       └── requirements.txt
├── gateway/
│   ├── index.js               # Express + Socket.io + proxy
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx            # Root layout + sidebar nav
│   │   ├── main.tsx
│   │   ├── index.css
│   │   ├── components/
│   │   │   ├── IncidentQueue.tsx
│   │   │   ├── ShapExplainer.tsx
│   │   │   ├── DecisionPanel.tsx
│   │   │   ├── TwinStatePanel.tsx
│   │   │   ├── AnalyticsDashboard.tsx
│   │   │   └── ExperimentControl.tsx
│   │   ├── hooks/
│   │   │   ├── useApi.ts
│   │   │   └── useWebSocket.ts
│   │   └── types/
│   │       └── index.ts
│   ├── package.json
│   └── vite.config.ts
├── .gitignore                 # Repo root: .DS_Store, .venv, node_modules, build/, .env, …
├── CLAUDE.md
└── README.md
```

Root **`.gitignore`** keeps Git clean (macOS metadata, Python caches and virtualenvs, Node `node_modules`, build outputs, local `.env`). **`frontend/.gitignore`** and **`gateway/.gitignore`** add package-specific rules (e.g. Vite `dist/`).

## Database Schema
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
- GET /explain/{incident_id} — output: {incident_id, predicted_class, explained_class, base_value, shap_values: number[], feature_names: string[], feature_values: (string|number)[]}
- GET /explain/global — output: {feature_names, importances}
- GET /model/info — output: {model_type, n_estimators, classes, feature_names}
- GET /health — output: {status, model_loaded}

### Twin Service (:8002)
- GET /state — output: full PipelineState (open_incidents, open_critical, open_escalated, queue_depth, throughput_per_hour, analyst_workload_pct, sla_remaining_s, sla_total_s, auto_resolve_rate)
- POST /state/event — input: {event_type: arrive|resolve, incident_id, severity} → updates state
- GET /state/history?limit=100 — output: list of StateSnapshot objects
- GET /sla — output: {sla_remaining_s, sla_used_pct, risk_level: green|yellow|red}
- POST /simulate — input: {additional_arrivals, additional_resolutions, severity_mix} → projected state
- POST /reset — resets all state to zero for new experiment
- GET /health — output: {status, snapshot_count}

### Decision Service (:8003)
- POST /route — THE MAIN ENDPOINT: takes incident features, calls ML+Twin, returns routing decision with explanation (requires active experiment). Twin `arrive` is sent only for `ai_only` or when the routed outcome is `auto_resolve`, so SLA does not drain during the unattended batch routing phase.
- POST /decisions — logs a decision row, computes is_correct/cost (requires active experiment + mode match). For pending rows (escalate/critical in HITL/human_only modes), sends a Twin `arrive` event via `_notify_twin_arrived` so queue depth and workload are accurate during the review phase.
- POST /decisions/{id}/override — records human decision update for the active run only; sets human_action + final_action, and sets human_override_to only when the new action differs from ai_recommendation. If the row was pending, sends a Twin `resolve` event using `routing_action` (not `final_action`) as the severity so counters match the original `arrive` event
- GET /decisions/incident/{incident_id} — returns the latest logged (flattened) decision for one incident_id; used by ML Service /explain/{incident_id} to fetch the exact routed feature set
- GET /decisions/log?page=1&page_size=20&mode=hitl&run_id=X — paginated decision history
- GET /decisions/stats?run_id=X — accuracy, cost, timing, override metrics; returns cost_breakdown (not by_action). In human_only mode override_count/override_rate are null and override_rate_applicable is false.
- POST /experiment/start — input: {mode, incident_count} → begins new run, resets Twin, and **wipes the in-memory `decision_log` + `decision_index`** (clean slate per run; export the previous run first if needed)
- POST /experiment/stop?force=false — ends run (sets `active=False`), computes final ExperimentResults. Returns 409 if incidents are still pending human review unless `?force=true` (force-reset / demo). **Keeps `experiment["run_id"]`** so post-stop analytics/export still resolve to the completed run; new writes are blocked by the `active=False` guard in /route, /decisions, and /decisions/{id}/override
- GET /experiment/results — returns ExperimentResults for last completed run
- GET /experiment/export?run_id=X&include_pending=false — streams decision log as CSV download (resolved rows only unless include_pending=true)
- GET /incidents/sample?count=100&seed=42 — stratified sample from data/incidents.csv (preserves 60/30/10 ratio); protocol lock enforces count (max_incidents_per_experiment=100) and seed (42)
- GET /health — output: {status, experiment_mode, experiment_active, decision_count}

## Gateway Proxy Path Rewriting
Each service has a different URL prefix, so each proxy uses its own pathRewrite:

| Frontend path | Strips | Forwarded to |
|---|---|---|
| /api/predict/**, /api/explain/**, /api/model/** | ^/api | :8001 /predict/…, /explain/…, /model/… |
| /api/twin/** | ^/api/twin | :8002 /state, /sla, /simulate, /reset |
| /api/decisions*, /api/experiment*, /api/route*, /api/incidents*, /api/health | ^/api | :8003 /decisions/…, /experiment/…, /route, /incidents/…, /health |

Note: `/api/config*` appears in the gateway pathFilter for forward-compatibility, but the Decision Service defines **no** `/config` endpoints.

Note: the decision proxy uses a `pathFilter` predicate (prefix checks via `path.startsWith`), not a glob array, so `/api/health` routes to the Decision Service. The gateway also serves its OWN `/health` (no `/api` prefix) for a gateway-level liveness check — these are two distinct paths. The ML and Twin proxies use glob `**` pathFilters.

Note: /api/twin/* must strip "/api/twin" (not just "/api") because the Twin Service
endpoints have no /twin prefix — they are /state, /sla, etc.

## How Services Communicate
1. Frontend (React) → Gateway (:4000) via HTTP REST + WebSocket
2. Gateway → proxies to ML/Twin/Decision services (http-proxy-middleware v3)
3. Gateway → polls Twin Service /state every 5 s, broadcasts via Socket.io to all clients
4. Decision Service (:8003) → ML Service (:8001) via async httpx (POST /predict)
5. Decision Service (:8003) → Twin Service (:8002) via async httpx (GET /state, POST /state/event)
6. Decision Service reads config/routing_config.yaml and config/cost_model.yaml on startup

## Twin Event Flow (Decision Service → Twin Service)
- `POST /route`: sends `arrive` event only for `ai_only` mode or when `routing_decision == 'auto_resolve'`
  (so SLA does not drain during unattended batch routing)
- `POST /decisions`: for pending rows (escalate/critical in HITL/human_only), calls `_notify_twin_arrived`
  to send an `arrive` event with `severity = routing_action`, so queue depth and workload reflect the
  backlog in real time as the batch is logged
- `POST /decisions/{id}/override` (when resolving a pending row): calls `_notify_twin_resolved` with
  `severity = doc["routing_action"]` (the original routing outcome, not the final overridden action)
  so the correct counter (open_critical or open_escalated) is decremented

## Frontend Architecture Notes
- All 6 panels are always mounted in App.tsx; inactive ones are hidden with `display: none`
  (not unmounted). This preserves component state — e.g. a running experiment survives
  navigation to another panel and back.
- App.tsx exports `PanelKey` type and accepts `setActivePanel` as a prop passed to ExperimentControl.
  The default active panel is `'experiment'` (not `'queue'`).
- Sidebar uses `NAV_SECTIONS` (not a flat array): four sections SETUP / REVIEW / INSPECT / ANALYZE,
  each with emoji-prefixed items. A green pulse dot appears next to "Experiment" when a run is active.
- In **human_only** mode while a run is active, App hides the AI-output panels: `aiPanelsLocked`
  removes `shap` (AI Explanation) and `analytics` from the sidebar and, if one is open, redirects to
  the queue — so participants in the human-only condition never see AI cues. A small amber banner in
  the sidebar explains the hidden panels.
- TwinStatePanel displays twin metrics computed in twin-service: SLA remaining = `3600 − open_incidents×90`
  (cost_per_incident = SLA_TOTAL/40, so 40 open = full SLA consumed); analyst workload % =
  `(open_escalated×0.05 + open_critical×0.10) / ANALYST_CAPACITY(1.0) × 100`; throughput/hr =
  `total_resolved / hours_since_first_arrival`. The SLA Health bar uses `sla_total_s` from state
  (`usedPct = 100 − sla_remaining_s/sla_total_s×100`) so the frontend never hardcodes the SLA window.
- ShapExplainer receives three parallel arrays from GET /explain/{id}:
  shap_values (number[]), feature_names (string[]), feature_values ((string|number)[]).
  The component zips them internally into {feature, value, display} objects for the chart.
- AnalyticsDashboard reads stats.cost_breakdown (not by_action) for the decision
  distribution chart. cost_breakdown is keyed by action with {count, total_cost} per entry.
- AnalyticsDashboard polls GET /api/decisions/stats every 5 s (with a mounted guard). Without the
  poll it would only fetch once on mount — and because all panels stay mounted in App.tsx, it would
  show stale data after a new experiment starts. Backend clean-slate-on-start (decision_log wiped)
  + this 5 s poll = analytics always reflects the CURRENT run and zeroes immediately on restart.
- ExperimentControl includes a batch incident runner: after starting an experiment, the
  user clicks "Load & Run Incidents" to fetch a stratified sample via GET /incidents/sample
  using the protocol-locked count/seed,
  then process each through /route + /decisions sequentially with a configurable delay.
  In HITL mode, auto_resolve decisions are logged immediately; escalate/critical are counted
  as pending for human review. IncidentQueue polls every 5s to stay current.
- ExperimentControl "Reviewed" count is computed by polling GET /decisions/log every 10 s and
  counting rows where `human_action != null AND routing_action != 'auto_resolve'`. This counts
  both accepts and overrides correctly. Do NOT use stats.override_count — that only counts
  disagreements (rows where human changed the AI recommendation). In human_only mode
  override_count/override_rate are null (override_rate_applicable: false) — not comparable to HITL.
- ExperimentControl restores state after page refresh via a mount-only useEffect that calls
  GET /api/health and GET /api/decisions/stats, then rehydrates running/runInfo/batchCounters
  from the backend if an experiment is active.
- Mode selector is wrapped in `opacity: 0.6 / pointerEvents: none` while running so the user
  cannot change mode mid-experiment.
- IncidentQueue shows a progress bar between the header and the list when `reviewableCount > 0`.
  `reviewableCount` = entries where `routing_action !== 'auto_resolve'` and mode is hitl/human_only.
  `reviewedCount = reviewableCount - pendingCount` (no extra API call; data already fetched).
- IncidentQueue columns are SORTABLE: clicking a header toggles asc/desc (↑/↓ marker) via
  `sortColumn`/`sortDir`, and the table renders `sortedEntries` (a useMemo over entries). Each header
  carries a small ⓘ `HeaderTooltip` with a plain-language hint. There is a colour-coded routing-action
  column (Auto green / Escalate orange / Critical red) plus a PENDING/REVIEWED status badge.
- IncidentQueue has an inline expandable detail panel (the participant review workflow — no tab
  switching). Clicking a row in hitl/human_only modes toggles `expandedIncidentId`, rendering a
  full-width `<tr><td colSpan={9}>` below it. ai_only rows do not expand. Layout by mode:
  hitl → two columns (ShapExplainer ~45% left, DecisionPanel ~55% right); human_only → DecisionPanel
  only. The detail area has a blue (#4C8BF5) left-border accent, #1E1F2A background, and an "X"
  collapse button. DecisionPanel and ShapExplainer are reused as-is (they self-fetch via incidentId).
  Already-REVIEWED rows still expand but open READ-ONLY (`readOnly={!isPending(entry)}`), and the
  mini-header says "Viewing" instead of "Reviewing".
- IncidentQueue takes an `experimentActive` prop from App. When false (no active run), `fetchEntries`
  clears the table and shows an empty state ("No active experiment …") — needed because the backend
  KEEPS the decision log + run_id after stop, so polling alone would otherwise show the finished run.
- DecisionPanel accepts an optional `onActionComplete(incidentId)` prop. After a successful Accept
  or Override it shows the result + cost delta for ~900 ms, then calls the callback. IncidentQueue's
  `handleActionComplete` then refreshes the log (badge flips to REVIEWED) and auto-expands the next
  pending incident in SORTED display order (scans `sortedEntries` from N+1, wraps round, collapses if
  none remain). When the prop is omitted (standalone sidebar DecisionPanel) behaviour is unchanged —
  the result card simply stays visible.
- DecisionPanel has a `readOnly` mode. The inline queue passes `readOnly={!isPending(entry)}`; when the
  prop is omitted the panel self-determines via `isStillActionable(decision)` (editable only while
  pending human review — routed to a human, not auto-resolved, human_action still null). In read-only
  it hides Accept/Override/Dismiss and renders a locked outcome card ("You accepted/overrode/decided …"
  + reason + recorded cost) with a 🔒 "Reviewed" pill. This protects ai_only and auto-resolved rows in
  the standalone sidebar panel too.
- Experiment reset on stop: App.tsx watches `experimentRunning` (from the 5s /api/health poll) and, on
  the active→inactive transition, sets `selectedIncidentId = null` (so DecisionPanel + ShapExplainer
  fall back to their empty states). ExperimentControl also calls an `onStopped` prop after both Stop
  and Force-Stop so App can optimistically flip `experimentCtx.active = false` immediately rather than
  waiting up to 5s for the poll. AnalyticsDashboard intentionally keeps showing the just-completed
  run's metrics until the NEXT start (run_id persists), then zeroes.
- ExperimentControl exposes a Force Stop control (two-click arm→confirm) that calls
  `POST /api/experiment/stop?force=true` + `POST /api/twin/reset` and clears local batch counters.
- The standalone sidebar Decision Panel and AI Explanation tabs still work independently; the inline
  versions are an ADDITIONAL access path, not a replacement.
- index.css defines the `inlineDetailReveal` keyframe (`.inline-detail-enter`) for the expand fade-in.
- TypeScript types in src/types/index.ts match the actual API response shapes:
  - RoutingResponse uses routing_decision (not routing_action), class_probabilities,
    thresholds_used, twin_context, experiment_mode
  - DecisionStats uses cost_breakdown: Record<string, {count, total_cost}> (not by_action)
  - Decision.routing_action uses 'auto_resolve'|'escalate'|'critical' (not send_to_human/critical_alert)
  - HITL routing in backend is class-aware safety-first (critical class is never auto-resolved)
  - ExperimentResults includes correct_decisions, avg_cost_per_incident, cost_breakdown,
    override_rate_applicable (false in human_only mode)

## Important Notes for Claude Code
- I am a beginner. Please write complete files with detailed comments explaining each part.
- Always use simple, readable code. Avoid clever abstractions.
- When creating a new file, always show me how to run/test it.
- If using a new library, show the install command first.
- If you encounter an error, explain what it means in plain English before fixing it.
- For Python services, always include the FastAPI /docs endpoint reminder.
- For React components, use TypeScript, Tailwind CSS, and functional components with hooks.

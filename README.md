# HITL-CDT: Human-in-the-Loop Cognitive Digital Twin

> A research prototype for evaluating Human-in-the-Loop decision-making in a Cognitive Digital Twin architecture, applied to **Data Quality Incident Management**.

**MSc Thesis** — Enterprise Software Systems Development  
**University of Macedonia**, Department of Applied Informatics  
**Author**: Gkanatsa Antonia (esd25004)  
**Supervisor**: Prof. Konstantinos Vergidis  

---

## Overview

This prototype implements and evaluates a framework that combines four research pillars:

- **Human-in-the-Loop AI** — structured human oversight and decision override capabilities
- **Decision Intelligence** — class-aware, confidence-gated routing and escalation logic
- **Cognitive Digital Twin** — a state-aware process model that provides operational context for decisions
- **Explainable AI (XAI)** — SHAP-based explanations that help humans understand AI recommendations

The system classifies data quality incidents into three categories:

| Action | Description | HITL routing (class-aware) |
|--------|-------------|----------------------------|
| **Auto-resolve** | Routine issue, AI handles automatically | AI predicts `auto_resolve` **and** confidence ≥ 0.85 |
| **Escalate** | Ambiguous, needs human review with AI recommendation + SHAP explanation | AI predicts `escalate` **and** confidence ≥ 0.50; **or** AI predicts `auto_resolve` but confidence < 0.85 |
| **Critical** | Urgent, requires immediate human attention | AI predicts `critical` at **any** confidence (safety-first); **or** AI predicts `escalate` **and** confidence < 0.50 |

> HITL routing is implemented in `_apply_routing_logic` (services/decision-service/main.py): the AI's **predicted class** is consulted first — a `critical` prediction is always routed critical and never auto-resolved — then confidence gates apply as in the table. **AI-only** mode uses the predicted class directly (thresholds ignored). **Human-only** mode routes every incident to `escalate` (AI ignored).

Three experimental modes are compared:
- **AI-only** — all incidents decided by the ML model automatically
- **Human-only** — all incidents go to human review (no AI recommendations shown)
- **HITL** — AI handles clear cases, escalates ambiguous ones to humans with explanations

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    React Frontend (:5173)                   │
│  Experiment · IncidentQueue · DecisionPanel · AIExplain     │
│  DigitalTwin · Analytics  (sectioned sidebar navigation)    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP + WebSocket
┌──────────────────────────┴────────────────────────────────┐
│                 Node.js API Gateway (:4000)               │
│              Express + Socket.io + Proxy                  │
└───────┬─────────────────┬─────────────────┬───────────────┘
        │                 │                 │
   ┌────┴────┐       ┌────┴────┐       ┌────┴────┐
   │ ML Svc  │       │ Twin    │       │Decision │
   │ :8001   │       │ Svc     │       │ Svc     │
   │         │       │ :8002   │       │ :8003   │
   │ FastAPI │       │ FastAPI │       │ FastAPI │
   │ sklearn │       │ State   │       │ Routing │
   │ SHAP    │       │ Engine  │       │ Logging │
   └────┬────┘       └────┬────┘       └────┬────┘
        │                 │                 │
        └─────────────────┴─────────────────┘
                          │
                    ┌─────┴──────┐
                    │  SQLite /  │
                    │ PostgreSQL │
                    └────────────┘
```

> **Note:** The prototype uses in-memory storage within each service for
> experimental sessions. The database schema is implemented
> (`data/create_tables.py`) and ready for production persistence, but
> in-memory operation is sufficient for the controlled experimental protocol
> where each session processes a fixed batch of incidents without service
> interruption.

---

## Project Structure

```
hitl-cdt/
├── data/
│   ├── generate_dataset.py         # Creates 3,000 synthetic incidents
│   ├── train_model.py              # Trains RandomForest + SHAP
│   ├── db.py                       # SQLite connection helper + CRUD
│   ├── create_tables.py            # Creates the 4 database tables
│   ├── hitl_cdt.db                 # Live SQLite database
│   ├── incidents.csv               # Generated dataset (60/30/10 split)
│   ├── rf_model.joblib             # Trained model artefact
│   ├── feature_encoder.joblib      # OrdinalEncoder for categorical features
│   ├── label_encoder.joblib        # LabelEncoder for target classes
│   ├── feature_names.json          # Ordered feature column names
│   ├── confusion_matrix.png        # Model evaluation plot
│   ├── shap_summary.png            # Global SHAP beeswarm plot
│   ├── shap_waterfall.png          # Single-incident SHAP waterfall
│   └── requirements.txt            # Setup-time deps for the scripts above (matplotlib, sqlalchemy, …)
├── config/
│   ├── routing_config.yaml         # Decision routing thresholds + SLA boost
│   └── cost_model.yaml             # Operational cost model (asymmetric penalties)
├── services/
│   ├── ml-service/                 # Python FastAPI — Port 8001
│   │   ├── main.py                 # Prediction + SHAP endpoints
│   │   └── requirements.txt
│   ├── twin-service/               # Python FastAPI — Port 8002
│   │   ├── main.py                 # Pipeline state engine + SLA
│   │   └── requirements.txt
│   └── decision-service/           # Python FastAPI — Port 8003
│       ├── main.py                 # Routing logic + decision logging + experiments
│       └── requirements.txt
├── gateway/
│   ├── index.js                    # Express + Socket.io + per-service proxy
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx                 # Root layout, sectioned sidebar, panel management
│   │   ├── components/
│   │   │   ├── IncidentQueue.tsx   # Incident list + progress bar + expandable inline detail panel
│   │   │   ├── ShapExplainer.tsx   # SHAP horizontal bar chart (standalone + inline)
│   │   │   ├── DecisionPanel.tsx   # AI recommendation + human override (standalone + inline)
│   │   │   ├── TwinStatePanel.tsx  # Live pipeline state gauges
│   │   │   ├── AnalyticsDashboard.tsx  # Accuracy/cost/override charts
│   │   │   └── ExperimentControl.tsx   # Mode selector, progress stats, routing breakdown, start/stop/export
│   │   ├── hooks/
│   │   │   ├── useApi.ts           # Typed fetch wrapper
│   │   │   └── useWebSocket.ts     # Socket.io twin state subscription
│   │   └── types/index.ts          # TypeScript interfaces for all API shapes
│   ├── package.json
│   └── vite.config.ts
├── logs/                           # Created by start.sh: per-service logs + pids.txt
│   ├── ml-service.log
│   ├── twin-service.log
│   ├── decision-service.log
│   ├── gateway.log
│   ├── frontend.log
│   └── pids.txt                    # PIDs of running services (used by stop.sh)
├── .vscode/
│   └── tasks.json                  # VS Code "Start All HITL-CDT Services" compound task
├── start.sh                        # One-command launcher (boots all 5 services + health checks)
├── stop.sh                         # Gracefully stops everything start.sh launched
├── .gitignore                      # Repo root: .DS_Store, .venv, node_modules, build/, .env, …
├── .gitattributes                  # Git attributes (line-ending / diff handling)
├── CLAUDE.md                       # AI assistant context file
└── README.md                       # This file
```

Root **`.gitignore`** excludes macOS `.DS_Store`, Python caches and virtualenvs, `node_modules`, build outputs, and local environment files from version control. **`frontend/.gitignore`** and **`gateway/.gitignore`** still apply inside those packages (for example Vite `dist/`).

## Quick Start

### Prerequisites
- Python 3.11+
- Node.js 20+
- (optional) PostgreSQL — only if you want to override the default SQLite backend via `DATABASE_URL`

### 0. Install dependencies (first time only)
```bash
# (recommended) create and activate a virtualenv first
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Data-pipeline scripts used in Step 1 (numpy, pandas, scikit-learn, shap,
# joblib, matplotlib, sqlalchemy). These are NOT covered by the service
# requirements, so install them explicitly.
pip install -r data/requirements.txt

# Runtime dependencies for each Python service (Step 2)
pip install -r services/ml-service/requirements.txt
pip install -r services/twin-service/requirements.txt
pip install -r services/decision-service/requirements.txt

# Node dependencies for the gateway (Step 3) and frontend (Step 4)
npm install --prefix gateway
npm install --prefix frontend
```

> **Why a separate `data/requirements.txt`?** `train_model.py` needs **matplotlib**
> and `create_tables.py` needs **SQLAlchemy** — neither is required by the running
> services, so they live with the data scripts rather than in `services/*/requirements.txt`.

### 1. Generate the dataset (first time only)
```bash
python data/generate_dataset.py   # → data/incidents.csv
python data/train_model.py        # → rf_model.joblib + SHAP plots (only if regenerating from scratch)
python data/create_tables.py      # → data/hitl_cdt.db
```

> **Replication:** The committed model artefacts in `data/` (`rf_model.joblib`, encoders, plots) are the exact model behind the thesis results. Use them as-is for replication — you do **not** need to re-run `train_model.py`. See [Model & Reproducibility](#model--reproducibility) below.

### 2. Start everything (recommended — one command)

The fastest way to launch all five services is the bundled `start.sh` script. It
boots the ML, Twin, and Decision services, the gateway, and the frontend, writes each
service's output to `logs/<service>.log`, polls every `/health` endpoint until the stack
is ready, and records PIDs in `logs/pids.txt`.

> **Note:** `start.sh` runs uvicorn from a `.venv/` virtual environment in the project
> root. Create it once with the commands shown in [Step 0](#0-install-dependencies-first-time-only)
> (`python -m venv .venv && source .venv/bin/activate`, then the `pip install` lines).

```bash
chmod +x start.sh stop.sh   # only needed the first time
./start.sh                  # launches all 5 services + runs health checks
./stop.sh                   # gracefully stops everything start.sh launched
```

Once it reports all services healthy:
- Frontend → http://localhost:5173
- API Gateway → http://localhost:4000
- Swagger docs → http://localhost:8001/docs, http://localhost:8002/docs, http://localhost:8003/docs

**VS Code users:** the workspace ships a `.vscode/tasks.json` with a compound task
**"Start All HITL-CDT Services"** that launches all five services in dedicated terminal
panels. Run it from the Command Palette (*Tasks: Run Build Task*) or press
`Cmd+Shift+B` (macOS) / `Ctrl+Shift+B` (Windows). Note these tasks run uvicorn with
`--reload`, so use `start.sh` (which omits `--reload`) for live participant sessions.

Prefer to start each service by hand (or need to see logs inline)? Use the manual steps
below instead.

### 2a. (Manual alternative) Start the Python services (3 terminals)
```bash
# Terminal 1 — ML Service
cd services/ml-service && uvicorn main:app --port 8001

# Terminal 2 — Twin Service
cd services/twin-service && uvicorn main:app --port 8002

# Terminal 3 — Decision Service
cd services/decision-service && uvicorn main:app --port 8003
```

> For live participant sessions, avoid `--reload` to prevent accidental in-memory state resets.

### 2b. (Manual alternative) Start the gateway
```bash
cd gateway && npm install && node index.js   # npm install only needed the first time
# → http://localhost:4000
```

### 2c. (Manual alternative) Start the frontend
```bash
cd frontend && npm install && npm run dev     # npm install only needed the first time
# → http://localhost:5173
```

### 3. Verify everything is running
```bash
curl http://localhost:4000/health       # gateway
curl http://localhost:8001/health       # ML service
curl http://localhost:8002/health       # twin service
curl http://localhost:8003/health       # decision service
```

### Swagger UI (service-level API docs)
- ML Service: http://localhost:8001/docs
- Twin Service: http://localhost:8002/docs
- Decision Service: http://localhost:8003/docs

### Test the full routing chain

`POST /route` requires an **active experiment run** — without one it returns
`409 Conflict` ("No active experiment run."). So start a run first, route an incident,
then stop the run:

```bash
# 1. Start an experiment (so /route is allowed)
curl -X POST http://localhost:4000/api/experiment/start \
  -H "Content-Type: application/json" \
  -d '{"mode": "hitl", "incident_count": 100}'

# 2. Route one incident through ML → Twin → Decision
curl -X POST http://localhost:4000/api/route \
  -H "Content-Type: application/json" \
  -d '{
    "anomaly_type": "schema_mismatch",
    "affected_records_pct": 42.0,
    "data_source": "iot_stream",
    "pipeline_stage": "serving",
    "historical_frequency": "first_occurrence",
    "time_sensitivity": "critical",
    "data_domain": "finance"
  }'

# 3. Stop the run when done (use ?force=true if any incidents are still pending)
curl -X POST "http://localhost:4000/api/experiment/stop?force=true"
```

---

## Key Design Parameters

| Parameter | Value | Source |
|-----------|-------|--------|
| Dataset size | 3,000 incidents | data/generate_dataset.py |
| Class distribution | 60% auto_resolve / 30% escalate / 10% critical | Thesis §3.3 |
| Ambiguity zone | ~30.2% of incidents (907 of 3,000) | Gaussian noise σ=0.10; boolean-OR union in generate_dataset.py summary |
| Features | 7 (6 categorical + 1 continuous) | Thesis §3.3.2 |
| ML model | RandomForest, 200 trees, balanced weights | data/train_model.py |
| HITL routing policy | Class-aware with confidence gates (critical safety-first, guarded auto-resolve) | services/decision-service/main.py |
| Base auto-resolve threshold | confidence ≥ 0.85 for auto_resolve class | config/routing_config.yaml |
| Base critical threshold | confidence < 0.50 may escalate to critical under class/uncertainty gates | config/routing_config.yaml |
| Missed critical cost | €100 | config/cost_model.yaml |
| False escalation cost | €10 | config/cost_model.yaml |
| Experiment incidents | 100 per run | Thesis §3.4 |

---

## Model & Reproducibility

The committed model artefacts in `data/` (`rf_model.joblib`, `feature_encoder.joblib`, `label_encoder.joblib`, …) were trained under the **original environment** (scikit-learn 1.6.1) and reproduce the thesis experimental results:

- **AI-only accuracy:** 89.0%
- **HITL routing split** (100 incidents, seed 42): 14 auto-resolved / 70 escalated / 16 critical

**For replication:** load and use these committed artefacts as-is. Do not re-run `data/train_model.py` unless you are deliberately regenerating the full pipeline from scratch.

Re-training on a newer stack (pandas 2.x / Python 3.13, scikit-learn 1.9.x) can produce a functionally equivalent but **not bit-identical** model; confidence scores may shift slightly and the HITL routing split can change (e.g. 14 → 12 auto-resolved). The current `train_model.py` includes by-name categorical-column handling required for pandas 2.x / Python 3.13, but that applies only when you choose to retrain.

---

## API Reference

### ML Service (:8001)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /predict | Classify one incident → class + confidence |
| POST | /predict/batch | Classify multiple incidents |
| POST | /explain/features | SHAP explanation from raw features |
| GET | /explain/{id} | SHAP explanation by incident ID |
| GET | /explain/global | Global feature importances |
| GET | /model/info | Model metadata |
| GET | /health | Liveness check |

### Twin Service (:8002)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /state | Current pipeline state |
| POST | /state/event | Process arrive/resolve event |
| GET | /state/history | Historical state snapshots |
| GET | /sla | SLA countdown + risk level |
| POST | /simulate | What-if scenario projection |
| POST | /reset | Reset state for new experiment |
| GET | /health | Liveness check |

### Decision Service (:8003)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /route | Route incident (calls ML + Twin) |
| POST | /decisions | Log a completed decision |
| POST | /decisions/{id}/override | Record human override |
| GET | /decisions/incident/{id} | Latest logged row (with features) for one incident ID |
| GET | /decisions/log | Paginated decision history |
| GET | /decisions/stats | Accuracy, cost, timing metrics |
| POST | /experiment/start | Begin experiment run (wipes the in-memory decision log — clean slate) |
| POST | /experiment/stop | End experiment, compute results (keeps `run_id` so post-stop reads still resolve). Returns 409 if incidents are still pending review unless `?force=true` |
| GET | /experiment/results | Final experiment metrics |
| GET | /experiment/export | Download decision log as CSV |
| GET | /incidents/sample | Stratified incident sample (protocol-locked `count` and `seed`) |
| GET | /health | Liveness check |

**Override endpoint contract (`POST /decisions/{id}/override`):**
- Request body: `{ "new_action": "auto_resolve|escalate|critical", "override_reason": "<text>", "ground_truth": "<optional>" }`
- Response body includes: `decision_id`, `old_action`, `new_action`, `override_reason`, `cost_delta`
- `cost_delta` = `cost(new_action) - cost(old_action)` (negative means the override reduced cost)
- When a pending decision is overridden, a Twin `resolve` event is sent using `routing_action` as the severity (matching the original `arrive` event severity), so queue counters decrement correctly.
- Experiment metrics and default CSV export include **resolved** decisions only (pending review rows are excluded unless `include_pending=true` is passed to export)
- `POST /route` and `POST /decisions` require an **active** experiment run
- `POST /experiment/stop` is blocked (409) while incidents remain pending human review; pass `?force=true` to skip the guard (force-reset / demo)
- Protocol lock: sampling is server-enforced to `max_incidents_per_experiment` (100) and `experiment_seed` (42) from `config/routing_config.yaml`
- **Active-open SLA correction:** `POST /route` derives `active_open = open_incidents − pending_backlog` and only lets the SLA-boost tighten the routing thresholds when `active_open > 0`. During the unattended batch sweep all open incidents are this run's not-yet-reviewed backlog, so `active_open ≈ 0` and routing uses the base 0.85/0.50 gates — each incident is judged on its own confidence rather than on how full the queue has become.
- **Clean slate per run:** `/experiment/start` clears the in-memory decision store, so historical runs are not queryable after a new run starts. Export the previous run's CSV (`/experiment/export`) before starting the next one if you need its data. The Analytics dashboard polls every 5 s and resets to the empty state automatically when a fresh run begins.

---

## Frontend UI

The React frontend has a **sectioned sidebar** navigation with emoji icons, organised into four workflow stages:

| Section | Panels | Purpose |
|---------|--------|---------|
| SETUP | 🧪 Experiment | Choose mode, run batch, view progress stats and routing breakdown |
| REVIEW | 📥 Incident Queue, 📋 Decision Panel | Review pending incidents, accept or override AI recommendations |
| INSPECT | 💡 AI Explanation, 🔄 Digital Twin | Understand SHAP feature contributions; monitor live pipeline state |
| ANALYZE | 📊 Analytics | Post-experiment accuracy, cost, and override charts |

The default landing panel is **Experiment**. A green pulse dot appears in the sidebar next to "Experiment" whenever a run is active. In **Human-only** mode the AI-output panels (💡 AI Explanation and 📊 Analytics) are hidden for the duration of the run, so participants in that condition never see AI cues.

All six panels stay mounted at all times (inactive ones are hidden with `display:none`) so a running experiment and its component state survive sidebar navigation.

**ExperimentControl highlights:**
- Mode selector is locked (greyed out) while a run is in progress
- After the batch completes, shows a "Go to queue →" CTA banner when human-review incidents remain
- Routing breakdown cards show how many incidents were auto-resolved / escalated / critical (mode-aware subtitles describe class-aware HITL routing, not flat confidence bands)
- "Reviewed" count polls `/api/decisions/log` every 10 s and counts rows where `human_action != null AND routing_action != 'auto_resolve'` (accepts and overrides both count)
- Page refresh during a live run restores all counters from backend state on mount
- Export CSV and Stop Experiment buttons are visible while a run is active; a **Force Stop** control (two-click arm → confirm) calls `/api/experiment/stop?force=true` + `/api/twin/reset` to reset mid-run
- On stop, an `onStopped` callback tells App to reset the review UI immediately (clears the selected incident; the Incident Queue empties) rather than waiting for the next health poll

**IncidentQueue highlights:**
- **Sortable columns** — click any header to sort (asc/desc, shown with ↑/↓); a small ⓘ icon on each header reveals a plain-language tooltip explaining the field
- Colour-coded **routing-action column** (Auto = green, Escalate = orange, Critical = red) plus a PENDING / REVIEWED status badge
- Progress bar between header and list shows reviewed / remaining / percentage for incidents requiring human review
- **Inline detail panel** — clicking a pending incident row (in HITL / Human-only modes) expands a detail section directly below it, so the participant reviews and acts without switching tabs. HITL shows the SHAP explanation (left) alongside the Decision Panel (right); Human-only shows just the Decision Panel. ai_only rows do not expand.
- After a successful Accept or Override, the row badge flips to REVIEWED and the **next pending incident auto-expands in the current sort order** — the participant flow becomes: see incident → see explanation → act → next opens, all in one view
- **Already-reviewed rows open read-only** — they still expand (and the SHAP explanation is still visible) but the panel shows the recorded outcome with a 🔒 "Reviewed" indicator and no action buttons, so past decisions can be inspected but not changed
- A small "X" button collapses the expanded panel without acting
- Empty state guides the user to start an experiment first; when a run is stopped the queue clears (it does not linger on the finished run's incidents)

---

## Thesis Context

This prototype is the practical artefact for a Design Science Research (DSR) thesis that tests three hypotheses:

- **H1**: HITL decision-making achieves higher decision effectiveness than AI-only in uncertain scenarios
- **H2**: Explainable AI outputs positively influence human trust and decision calibration
- **H3**: The CDT architecture supports structured human oversight without unacceptable latency

The live prototype computes resolved-decision metrics (accuracy, cost, resolution time, override rate) per run. Override rate is **not applicable** in human-only mode (the AI recommendation is never shown to participants; stats return `override_rate_applicable: false`).
Macro-F1, trust (Likert), and end-to-end latency are analyzed in the experimental data-analysis phase.

---

## License

This project is part of an academic thesis and is intended for research and educational purposes.

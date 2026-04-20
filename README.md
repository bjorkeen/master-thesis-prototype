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
- **Decision Intelligence** — confidence-based decision routing and escalation logic
- **Cognitive Digital Twin** — a state-aware process model that provides operational context for decisions
- **Explainable AI (XAI)** — SHAP-based explanations that help humans understand AI recommendations

The system classifies data quality incidents into three categories:

| Action | Description | Trigger |
|--------|-------------|---------|
| **Auto-resolve** | Routine issue, AI handles automatically | Confidence ≥ 0.85 |
| **Escalate** | Ambiguous, needs human review with AI recommendation + SHAP explanation | Confidence 0.50–0.85 |
| **Critical** | Urgent, requires immediate human attention | Confidence < 0.50 |

Three experimental modes are compared:
- **AI-only** — all incidents decided by the ML model automatically
- **Human-only** — all incidents go to human review (no AI recommendations shown)
- **HITL** — AI handles clear cases, escalates ambiguous ones to humans with explanations

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    React Frontend (:5173)                   │
│  IncidentQueue · ShapExplainer · DecisionPanel · TwinState  │
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
│   └── shap_waterfall.png          # Single-incident SHAP waterfall
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
│   │   ├── App.tsx                 # Root layout, sidebar, panel management
│   │   ├── components/
│   │   │   ├── IncidentQueue.tsx   # Incident list with status badges
│   │   │   ├── ShapExplainer.tsx   # SHAP horizontal bar chart
│   │   │   ├── DecisionPanel.tsx   # AI recommendation + human override
│   │   │   ├── TwinStatePanel.tsx  # Live pipeline state gauges
│   │   │   ├── AnalyticsDashboard.tsx  # Accuracy/cost/override charts
│   │   │   └── ExperimentControl.tsx   # Mode selector, start/stop, results
│   │   ├── hooks/
│   │   │   ├── useApi.ts           # Typed fetch wrapper
│   │   │   └── useWebSocket.ts     # Socket.io twin state subscription
│   │   └── types/index.ts          # TypeScript interfaces for all API shapes
│   ├── package.json
│   └── vite.config.ts
├── CLAUDE.md                       # AI assistant context file
└── README.md                       # This file
```

---

## Current Status

### ✅ Phase 1 — Data Science Foundation (Complete)
- [x] Synthetic dataset: 3,000 incidents, 7 features, 60/30/10 class distribution
- [x] ~32% ambiguity zone via Gaussian noise (σ=0.10)
- [x] RandomForest classifier (200 trees, balanced class weights)
- [x] Model performance: 68.3% overall accuracy (by design — ambiguity zone creates challenge)
- [x] SHAP TreeExplainer with summary + waterfall plots
- [x] Routing configuration (thresholds: auto≥0.85, critical<0.50, SLA boost)
- [x] Cost model (missed critical=€100, false escalation=€10)

### ✅ Phase 2 — Python Microservices (Complete)
- [x] ML Service (:8001) — predict, batch predict, SHAP explain, global importance
- [x] Twin Service (:8002) — state tracking, SLA countdown, what-if simulation, history
- [x] Decision Service (:8003) — 3-mode routing, decision logging, overrides, experiment lifecycle, CSV export
- [x] Database schema defined (SQLite with PostgreSQL fallback) — services currently use in-memory storage for prototype evaluation

### ✅ Phase 3 — Gateway + Frontend (Complete)
- [x] Node.js API Gateway (:4000) — Express, Socket.io, per-service path-rewriting proxy
- [x] React dashboard (:5173) — all 6 panels, persistent state across navigation
- [x] IncidentQueue — live incident list with status badges and selection
- [x] ShapExplainer — SHAP horizontal bar chart + feature table
- [x] DecisionPanel — AI recommendation display + human override form
- [x] TwinStatePanel — real-time pipeline gauges via WebSocket
- [x] AnalyticsDashboard — accuracy, cost, and override charts (Recharts)
- [x] ExperimentControl — mode selector, start/stop controls, results summary

### 🔄 Phase 4 — Experiments + Thesis Write-up (In Progress)
- [ ] Run AI-only / Human-only / HITL experiments with study participants
- [ ] Collect subjective trust ratings (Likert scale)
- [ ] Data analysis and thesis Chapter 6

---

## Quick Start

### Prerequisites
- Python 3.11+
- Node.js 20+

### 1. Generate the dataset (first time only)
```bash
python data/generate_dataset.py   # → data/incidents.csv
python data/train_model.py        # → rf_model.joblib + SHAP plots
python data/create_tables.py      # → data/hitl_cdt.db
```

### 2. Start the Python services (3 terminals)
```bash
# Terminal 1 — ML Service
cd services/ml-service && uvicorn main:app --port 8001

# Terminal 2 — Twin Service
cd services/twin-service && uvicorn main:app --port 8002

# Terminal 3 — Decision Service
cd services/decision-service && uvicorn main:app --port 8003
```

> For live participant sessions, avoid `--reload` to prevent accidental in-memory state resets.

### 3. Start the gateway
```bash
cd gateway && node index.js
# → http://localhost:4000
```

### 4. Start the frontend
```bash
cd frontend && npm install && npm run dev
# → http://localhost:5173
```

### 5. Verify everything is running
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
```bash
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
```

---

## Key Design Parameters

| Parameter | Value | Source |
|-----------|-------|--------|
| Dataset size | 3,000 incidents | data/generate_dataset.py |
| Class distribution | 60% auto_resolve / 30% escalate / 10% critical | Thesis §3.3 |
| Ambiguity zone | ~32% of incidents | Gaussian noise σ=0.10 |
| Features | 7 (6 categorical + 1 continuous) | Thesis §3.3.2 |
| ML model | RandomForest, 200 trees, balanced weights | data/train_model.py |
| HITL routing policy | Class-aware with confidence gates (critical safety-first, guarded auto-resolve) | services/decision-service/main.py |
| Base auto-resolve threshold | confidence ≥ 0.85 for auto_resolve class | config/routing_config.yaml |
| Base critical threshold | confidence < 0.50 may escalate to critical under class/uncertainty gates | config/routing_config.yaml |
| Missed critical cost | €100 | config/cost_model.yaml |
| False escalation cost | €10 | config/cost_model.yaml |
| Experiment incidents | 300 per run | Thesis §3.4 |

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
| POST | /experiment/start | Begin experiment run |
| POST | /experiment/stop | End experiment, compute results |
| GET | /experiment/results | Final experiment metrics |
| GET | /experiment/export | Download decision log as CSV |
| GET | /incidents/sample | Stratified incident sample (protocol-locked `count` and `seed`) |
| GET | /health | Liveness check |

**Override endpoint contract (`POST /decisions/{id}/override`):**
- Request body: `{ "new_action": "auto_resolve|escalate|critical", "override_reason": "<text>", "ground_truth": "<optional>" }`
- Response body includes: `decision_id`, `old_action`, `new_action`, `override_reason`, `cost_delta`
- `cost_delta` = `cost(new_action) - cost(old_action)` (negative means the override reduced cost)
- Experiment metrics and default CSV export include **resolved** decisions only (pending review rows are excluded unless `include_pending=true` is passed to export)
- `POST /route` and `POST /decisions` require an **active** experiment run
- Protocol lock: sampling is server-enforced to `max_incidents_per_experiment` and configured seed

---

## Thesis Context

This prototype is the practical artefact for a Design Science Research (DSR) thesis that tests three hypotheses:

- **H1**: HITL decision-making achieves higher decision effectiveness than AI-only in uncertain scenarios
- **H2**: Explainable AI outputs positively influence human trust and decision calibration
- **H3**: The CDT architecture supports structured human oversight without unacceptable latency

The live prototype computes resolved-decision metrics (accuracy, cost, resolution time, override rate) per run.
Macro-F1, trust (Likert), and end-to-end latency are analyzed in the experimental data-analysis phase.

---

## License

This project is part of an academic thesis and is intended for research and educational purposes.

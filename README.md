# HITL-CDT: Human-in-the-Loop Cognitive Digital Twin

> A research prototype for evaluating Human-in-the-Loop decision-making in a Cognitive Digital Twin architecture, applied to **Data Quality Incident Management**.

**MSc Thesis** — Enterprise Software Systems Development  
**University of Macedonia**, Department of Applied Informatics  
**Author**: Gkanatsa Antonia (esd25004)  
**Supervisor**: Prof. Konstantinos Vergidis  
**Co-funded by**: Deloitte

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
│                    React Frontend (:5173)                     │
│  IncidentQueue · ShapExplainer · DecisionPanel · TwinState   │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP + WebSocket
┌──────────────────────────┴──────────────────────────────────┐
│                 Node.js API Gateway (:4000)                   │
│              Express + Socket.io + Proxy                      │
└───────┬──────────────────┬──────────────────┬───────────────┘
        │                  │                  │
   ┌────┴────┐       ┌────┴────┐       ┌────┴────┐
   │ ML Svc  │       │ Twin    │       │Decision │
   │ :8001   │       │ Svc     │       │ Svc     │
   │         │       │ :8002   │       │ :8003   │
   │ FastAPI │       │ FastAPI │       │ FastAPI │
   │ sklearn │       │ State   │       │ Routing │
   │ SHAP    │       │ Engine  │       │ Logging │
   └────┬────┘       └────┬────┘       └────┬────┘
        │                  │                  │
        └──────────────────┴──────────────────┘
                           │
                    ┌──────┴──────┐
                    │ PostgreSQL  │
                    │   :5432     │
                    └─────────────┘
```

---

## Project Structure

```
hitl-cdt/
├── data/                           # Dataset generation + ML training
│   ├── generate_dataset.py         # Creates 3,000 synthetic incidents
│   ├── train_model.py              # Trains RandomForest + SHAP
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
├── gateway/                        # Node.js Express — Port 4000 (Phase 3)
├── frontend/                       # React + TypeScript — Port 5173 (Phase 3)
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
- [ ] Database setup (PostgreSQL / SQLite)

### ⬜ Phase 3 — Gateway + Frontend (Upcoming)
- [ ] Node.js API Gateway with Socket.io
- [ ] React dashboard (IncidentQueue, ShapExplainer, DecisionPanel, TwinStatePanel, AnalyticsDashboard, ExperimentControl)

### ⬜ Phase 4 — Integration + Experiments (Upcoming)
- [ ] End-to-end testing
- [ ] Run AI-only / Human-only / HITL experiments
- [ ] Data analysis and thesis Chapter 6

---

## Quick Start

### Prerequisites
- Python 3.11+
- Node.js 20+ (for gateway/frontend — Phase 3)
- PostgreSQL 16 or SQLite (for decision persistence)

### 1. Generate the dataset
```bash
cd hitl-cdt
python data/generate_dataset.py
# → Creates data/incidents.csv (3,000 rows)
```

### 2. Train the ML model
```bash
python data/train_model.py
# → Creates rf_model.joblib, feature_encoder.joblib, label_encoder.joblib
# → Generates SHAP plots (shap_summary.png, shap_waterfall.png)
```

### 3. Start the services
Open three terminals:

```bash
# Terminal 1: ML Service
cd services/ml-service
pip install -r requirements.txt
uvicorn main:app --port 8001 --reload

# Terminal 2: Twin Service
cd services/twin-service
pip install -r requirements.txt
uvicorn main:app --port 8002 --reload

# Terminal 3: Decision Service
cd services/decision-service
pip install -r requirements.txt
uvicorn main:app --port 8003 --reload
```

### 4. Test via Swagger UI
- ML Service docs: http://localhost:8001/docs
- Twin Service docs: http://localhost:8002/docs
- Decision Service docs: http://localhost:8003/docs

### 5. Test the full routing chain
```bash
curl -X POST http://localhost:8003/route \
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
| Auto-resolve threshold | confidence ≥ 0.85 | config/routing_config.yaml |
| Critical threshold | confidence < 0.50 | config/routing_config.yaml |
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
| GET | /decisions/log | Paginated decision history |
| GET | /decisions/stats | Accuracy, cost, timing metrics |
| POST | /experiment/start | Begin experiment run |
| POST | /experiment/stop | End experiment, compute results |
| GET | /experiment/results | Final experiment metrics |
| GET | /experiment/export | Download decision log as CSV |
| GET | /health | Liveness check |

---

## Thesis Context

This prototype is the practical artefact for a Design Science Research (DSR) thesis that tests three hypotheses:

- **H1**: HITL decision-making achieves higher decision effectiveness than AI-only in uncertain scenarios
- **H2**: Explainable AI outputs positively influence human trust and decision calibration
- **H3**: The CDT architecture supports structured human oversight without unacceptable latency

The evaluation compares the three modes on: decision accuracy (macro F1), resolution time, operational cost, perceived trust (Likert scale), and system latency.

---

## License

This project is part of an academic thesis and is intended for research and educational purposes.

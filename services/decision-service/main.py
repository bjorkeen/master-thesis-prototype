"""
Decision Service – HITL-CDT
============================
FastAPI service running on port 8003.

This is the "brain" of the system.  Every incident flows through here:
  1.  Caller submits incident features to POST /route
  2.  This service calls ML Service (:8001) to get an AI prediction
  3.  It calls Twin Service (:8002) to get the live pipeline state
  4.  It applies routing logic (HITL / AI-only / Human-only) and returns
      the routing decision
  5.  Decisions are logged in memory for evaluation and export

Three experiment modes control what "routing" means:
  ai_only    – AI decides everything; human never sees the incident
  human_only – AI prediction is ignored; all incidents go to human review
  hitl       – confidence > 0.85 → auto_resolve
                confidence < 0.50 → critical
                otherwise          → escalate (human reviews with AI hint)

Start from the project root:
    python3 -m uvicorn services.decision-service.main:app --port 8003 --reload

Or from inside services/decision-service/:
    python3 -m uvicorn main:app --port 8003 --reload

Visit http://localhost:8003/docs for the interactive Swagger UI.

IMPORTANT: ML Service (:8001) and Twin Service (:8002) must be running first.
"""

# ── Imports ───────────────────────────────────────────────────────────────────
import csv
import io
import os
import random
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# ── Paths ─────────────────────────────────────────────────────────────────────
# Walk up from services/decision-service/ to the project root
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_DIR   = PROJECT_ROOT / "config"

# ── App setup ─────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Decision Service – HITL-CDT",
    description=(
        "Routes incidents to auto-resolve / escalate / critical, "
        "logs decisions, and manages experiment runs. "
        "Visit /docs for the interactive Swagger UI."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Global configuration (loaded from YAML on startup) ────────────────────────
routing_cfg: dict = {}   # contents of config/routing_config.yaml
cost_cfg:    dict = {}   # contents of config/cost_model.yaml

# Convenience shortcuts populated after YAML load
ML_SERVICE_URL:   str   = "http://localhost:8001"
TWIN_SERVICE_URL: str   = "http://localhost:8002"
AUTO_THRESH:      float = 0.85
CRITICAL_THRESH:  float = 0.50

# ── In-memory stores ──────────────────────────────────────────────────────────
#
# In a production system these would go in a PostgreSQL database.
# For the prototype, plain Python lists are simpler and sufficient.
# All data is lost when the service restarts — acceptable for experiments.

# Every completed decision record is appended here
decision_log: List[dict] = []

# Lookup index: decision_id → index in decision_log
# Allows O(1) lookup for the override endpoint
decision_index: Dict[str, int] = {}

# Current experiment state
experiment: dict = {
    "active":       False,
    "run_id":       None,
    "mode":         "hitl",        # ai_only | human_only | hitl
    "started_at":   None,
    "stopped_at":   None,
    "incident_count": 0,
    "results":      None,          # filled by /experiment/stop
}


# ── Pydantic models ────────────────────────────────────────────────────────────

class IncidentFeatures(BaseModel):
    """The 7 raw features for one data quality incident."""
    anomaly_type:          str   = Field(..., example="schema_mismatch")
    affected_records_pct:  float = Field(..., ge=0, le=100, example=42.0)
    data_source:           str   = Field(..., example="iot_stream")
    pipeline_stage:        str   = Field(..., example="ingestion")
    historical_frequency:  str   = Field(..., example="occasional")
    time_sensitivity:      str   = Field(..., example="high")
    data_domain:           str   = Field(..., example="finance")


class RouteResponse(BaseModel):
    """What POST /route returns."""
    incident_id:       str   = Field(..., description="Auto-generated ID for this incident")
    routing_decision:  str   = Field(..., description="auto_resolve | escalate | critical")
    ai_recommendation: str   = Field(..., description="Raw class predicted by the ML model")
    ai_confidence:     float = Field(..., description="ML model's confidence (0–1)")
    class_probabilities: Dict[str, float] = Field(..., description="Full probability breakdown")
    experiment_mode:   str   = Field(..., description="Current experiment mode")
    thresholds_used:   Dict[str, float] = Field(...,
        description="auto_resolve and critical thresholds after SLA adjustment")
    twin_context: Dict[str, Any] = Field(...,
        description="Pipeline state at time of routing decision")
    explanation: str = Field(..., description="Plain-English reason for the routing decision")


class DecisionRecord(BaseModel):
    """
    Body for POST /decisions.
    Represents a fully resolved decision (after any human review has finished).
    """
    incident_id:      str
    experiment_mode:  str
    incident_features: Dict[str, Any]
    ai_recommendation: str
    ai_confidence:    float
    routing_action:   str  = Field(...,
        description="What the system routed the incident as")
    human_action:     Optional[str]  = Field(None,
        description="What the human actually did (None if no human involvement)")
    final_action:     str  = Field(...,
        description="The action that was actually taken (human_action if overridden, else routing_action)")
    ground_truth:     Optional[str]  = Field(None,
        description="True label from the dataset (if known at logging time)")
    resolution_time_s: Optional[float] = Field(None,
        description="Seconds from incident arrival to final resolution")


class DecisionResponse(BaseModel):
    """What POST /decisions returns."""
    decision_id:  str
    is_correct:   Optional[bool]
    cost:         Optional[float]
    message:      str


class OverrideRequest(BaseModel):
    """
    Body for POST /decisions/{id}/override.

    Contract:
      - new_action: the analyst's chosen action
      - override_reason: mandatory free-text rationale
      - ground_truth: optional true label (if known at override time)
    """
    new_action:    Literal["auto_resolve", "escalate", "critical"] = Field(...,
        description="The action the human chose instead of the AI's recommendation")
    override_reason: str = Field(..., min_length=1,
        description="Why the human disagreed with the AI recommendation")
    ground_truth:  Optional[str] = Field(None,
        description="True label if known — used to compute override cost")


class OverrideResponse(BaseModel):
    """
    Response for POST /decisions/{id}/override.

    Contract:
      - decision_id: updated decision row
      - old_action/new_action: action transition
      - override_reason: analyst rationale echoed back
      - cost_delta: cost(new_action) - cost(old_action)
    """
    decision_id:   str
    old_action:    str
    new_action:    str
    override_reason: str
    cost_delta:    Optional[float] = Field(None,
        description="Change in cost caused by the override (negative = override saved money)")


class ExperimentStartRequest(BaseModel):
    mode:           Literal["ai_only", "human_only", "hitl"] = Field("hitl",
        description="Which routing mode to use for this experiment run")
    incident_count: Optional[int] = Field(None, ge=1,
        description="Expected number of incidents (informational, not enforced)")


class ExperimentResults(BaseModel):
    run_id:               str
    mode:                 str
    total_incidents:      int
    correct_decisions:    int
    accuracy:             float
    total_cost:           float
    avg_cost_per_incident: float
    avg_resolution_time_s: Optional[float]
    override_count:       int
    override_rate:        float
    started_at:           str
    completed_at:         Optional[str]
    cost_breakdown:       Dict[str, Any]


class HealthResponse(BaseModel):
    status:          str
    experiment_mode: str
    experiment_active: bool
    decision_count:  int
    ml_service_url:  str
    twin_service_url: str


# ── Helpers ────────────────────────────────────────────────────────────────────

def _now() -> str:
    """Current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    """Generate a short unique ID (first 8 hex chars of a UUID4)."""
    return str(uuid.uuid4())[:8].upper()


def _compute_thresholds(sla_remaining_s: float) -> Dict[str, float]:
    """
    Return the effective routing thresholds after applying SLA boost.

    The routing_config.yaml defines boost schedules:
      < 10 min remaining → tighten auto_resolve by 10%, widen critical by 5%
      <  5 min remaining → tighten auto_resolve by 20%, widen critical by 10%

    "Tightening" auto_resolve means raising the bar — the model must be MORE
    confident before we let it auto-resolve.  Under SLA pressure we prefer to
    escalate rather than risk a missed critical.
    """
    base_auto     = AUTO_THRESH       # e.g. 0.85
    base_critical = CRITICAL_THRESH   # e.g. 0.50

    if not routing_cfg.get("sla_escalation_boost", False):
        return {"auto_resolve": base_auto, "critical": base_critical}

    schedule = routing_cfg.get("sla_boost_schedule", {})

    if sla_remaining_s < 300:    # < 5 minutes
        boost = schedule.get("minutes_remaining_5", {})
        auto_reduction = boost.get("auto_resolve_threshold_reduction", 0.20)
        crit_increase  = boost.get("critical_threshold_increase",      0.10)
        auto  = base_auto * (1 + auto_reduction)
        crit  = base_critical * (1 + crit_increase)
    elif sla_remaining_s < 600:  # < 10 minutes
        boost = schedule.get("minutes_remaining_10", {})
        auto_reduction = boost.get("auto_resolve_threshold_reduction", 0.10)
        crit_increase  = boost.get("critical_threshold_increase",      0.05)
        auto  = base_auto * (1 + auto_reduction)
        crit  = base_critical * (1 + crit_increase)
    else:
        auto, crit = base_auto, base_critical

    auto = max(0.0, min(0.999, auto))
    crit = max(0.0, min(0.999, crit))
    return {"auto_resolve": round(auto, 3), "critical": round(crit, 3)}


def _apply_routing_logic(
    mode: str,
    ai_recommendation: str,
    confidence: float,
    thresholds: Dict[str, float],
) -> tuple[str, str]:
    """
    Apply routing logic and return (routing_decision, explanation).

    mode:
      ai_only    – trust the AI class prediction directly
      human_only – always escalate so a human reviews every incident
      hitl       – use confidence thresholds to decide

    Returns a tuple of (routing_decision, plain-English explanation).
    """
    auto_thresh = thresholds["auto_resolve"]
    crit_thresh = thresholds["critical"]

    if mode == "ai_only":
        # The AI's predicted class IS the routing decision.
        # Confidence thresholds are ignored — the model decides everything.
        decision    = ai_recommendation
        explanation = (
            f"AI-only mode: using ML prediction directly "
            f"({ai_recommendation}, conf={confidence:.3f})."
        )

    elif mode == "human_only":
        # Ignore the AI; route every incident to a human analyst.
        decision    = "escalate"
        explanation = (
            f"Human-only mode: all incidents sent for human review "
            f"(AI suggested {ai_recommendation} but is ignored)."
        )

    else:
        # HITL mode: class-aware routing with confidence gates.
        #
        # Rationale:
        # - A critical AI class remains critical (safety-first).
        # - Auto-resolve is only allowed for high-confidence auto_resolve class.
        # - Escalate remains the default human-review path for ambiguity.
        if ai_recommendation == "critical":
            decision    = "critical"
            explanation = (
                f"HITL: AI class is critical (conf={confidence:.3f}) "
                f"→ route critical (safety-first)."
            )
        elif ai_recommendation == "auto_resolve":
            if confidence >= auto_thresh:
                decision    = "auto_resolve"
                explanation = (
                    f"HITL: auto_resolve class with confidence {confidence:.3f} ≥ {auto_thresh} "
                    f"→ auto-resolve."
                )
            else:
                decision    = "escalate"
                explanation = (
                    f"HITL: auto_resolve class but confidence {confidence:.3f} < {auto_thresh} "
                    f"→ escalate for human review."
                )
        else:
            if confidence < crit_thresh:
                decision    = "critical"
                explanation = (
                    f"HITL: escalate class but confidence {confidence:.3f} < {crit_thresh} "
                    f"→ critical (high uncertainty near SLA/cost risk)."
                )
            else:
                decision    = "escalate"
                explanation = (
                    f"HITL: escalate class with confidence {confidence:.3f} "
                    f"→ escalate for human review."
                )

    return decision, explanation


def _compute_cost(final_action: str, ground_truth: str) -> float:
    """
    Look up the cost of a (final_action, ground_truth) pair using the cost model.

    The cost model encodes the business consequences of each decision outcome.
    For example: missing a critical incident costs €100, but a false escalation
    costs only €10.

    This function returns 0.0 if ground_truth is unknown (None).
    """
    if not ground_truth:
        return 0.0

    # Correct decisions
    if final_action == ground_truth:
        if final_action == "auto_resolve":
            return float(cost_cfg.get("correct_auto_resolve", 0))
        elif final_action == "escalate":
            return float(cost_cfg.get("correct_escalation", 10))
        elif final_action == "critical":
            return float(cost_cfg.get("correct_critical", 15))

    # Wrong decisions — map to cost categories
    # missed_critical: ground truth was critical but we didn't treat it as such
    if ground_truth == "critical" and final_action != "critical":
        return float(cost_cfg.get("missed_critical", 100))

    # missed_escalation: ground truth needed review but we auto-resolved it
    if ground_truth == "escalate" and final_action == "auto_resolve":
        return float(cost_cfg.get("missed_escalation", 50))

    # false_escalation: ground truth was routine but we escalated or flagged critical
    if ground_truth == "auto_resolve" and final_action in ("escalate", "critical"):
        return float(cost_cfg.get("false_escalation", 10))

    # Any remaining mismatch (e.g. critical routed as escalate but GT=escalate
    # is already covered above; here we catch critical→escalate etc.)
    return float(cost_cfg.get("false_escalation", 10))


def _current_run_decisions() -> List[dict]:
    """Return only the decisions belonging to the current experiment run."""
    run_id = experiment.get("run_id")
    if not run_id:
        return decision_log   # no active run → return everything
    return [d for d in decision_log if d.get("run_id") == run_id]


def _flatten_doc(doc: dict) -> dict:
    """
    Merge incident_features fields into the top-level dict for JSON responses.

    The raw decision record stores features under a nested 'incident_features'
    key. This helper spreads them to the top level so the frontend can read
    anomaly_type, data_source, etc. directly from the log entry, while also
    keeping incident_features intact for callers that want the original shape.
    """
    flat = dict(doc)
    for k, v in (doc.get("incident_features") or {}).items():
        flat.setdefault(k, v)   # top-level wins if already present
    return flat


def _is_pending_human_review(doc: dict) -> bool:
    """
    Return True when a decision record is waiting for analyst action.
    """
    return (
        doc.get("human_action") is None
        and doc.get("routing_action") != "auto_resolve"
        and doc.get("experiment_mode") in {"hitl", "human_only"}
    )


async def _notify_twin_resolved(incident_id: str, severity: str) -> None:
    """
    Best-effort Twin notification that one incident is now fully resolved.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{TWIN_SERVICE_URL}/state/event",
                json={
                    "event_type": "resolve",
                    "incident_id": incident_id,
                    "severity": severity,
                },
            )
    except Exception:
        pass   # best-effort, don't block API responses


def _compute_stats(decisions: List[dict]) -> dict:
    """
    Aggregate accuracy, cost, resolution time, and override stats
    from a list of decision records.
    """
    total_logged = len(decisions)
    resolved = [d for d in decisions if not _is_pending_human_review(d)]
    pending_count = total_logged - len(resolved)
    total = len(resolved)
    if total == 0:
        return {
            "total_decisions": 0,
            "total_logged": total_logged,
            "pending_count": pending_count,
            "correct_decisions": 0,
            "accuracy": 0.0,
            "total_cost": 0.0,
            "avg_cost_per_incident": 0.0,
            "avg_resolution_time_s": None,
            "override_count": 0,
            "override_rate": 0.0,
            "cost_breakdown": {},
        }

    correct   = sum(1 for d in resolved if d.get("is_correct") is True)
    total_cost = sum(d.get("cost", 0.0) or 0.0 for d in resolved)
    overrides  = sum(1 for d in resolved if d.get("human_override_to") is not None)

    # Resolution times (only for decisions where it was recorded)
    times = [d["resolution_time_s"] for d in resolved if d.get("resolution_time_s")]
    avg_time = round(sum(times) / len(times), 2) if times else None

    # Cost breakdown by routing decision
    breakdown: Dict[str, dict] = {}
    for d in resolved:
        action = d.get("final_action", "unknown")
        if action not in breakdown:
            breakdown[action] = {"count": 0, "total_cost": 0.0}
        breakdown[action]["count"]      += 1
        breakdown[action]["total_cost"] += d.get("cost", 0.0) or 0.0

    return {
        "total_decisions":      total,
        "total_logged":         total_logged,
        "pending_count":        pending_count,
        "correct_decisions":    correct,
        "accuracy":             round(correct / total, 4) if total else 0.0,
        "total_cost":           round(total_cost, 2),
        "avg_cost_per_incident": round(total_cost / total, 2) if total else 0.0,
        "avg_resolution_time_s": avg_time,
        "override_count":       overrides,
        "override_rate":        round(overrides / total, 4) if total else 0.0,
        "cost_breakdown":       breakdown,
    }


# ── Startup: load config ───────────────────────────────────────────────────────

@app.on_event("startup")
async def load_config():
    """
    Read both YAML config files when the service starts.
    The values are stored in module-level dicts so every endpoint can read them.
    """
    global routing_cfg, cost_cfg, ML_SERVICE_URL, TWIN_SERVICE_URL
    global AUTO_THRESH, CRITICAL_THRESH

    routing_path = CONFIG_DIR / "routing_config.yaml"
    cost_path    = CONFIG_DIR / "cost_model.yaml"

    for path in (routing_path, cost_path):
        if not path.exists():
            raise RuntimeError(f"Config file not found: {path}")

    with open(routing_path) as f:
        routing_cfg = yaml.safe_load(f)

    with open(cost_path) as f:
        cost_cfg = yaml.safe_load(f)

    # Pull service URLs and thresholds out of the config for easy access
    ML_SERVICE_URL   = routing_cfg.get("ml_service_url",   "http://localhost:8001")
    TWIN_SERVICE_URL = routing_cfg.get("twin_service_url", "http://localhost:8002")
    AUTO_THRESH      = routing_cfg.get("auto_resolve_threshold", 0.85)
    CRITICAL_THRESH  = routing_cfg.get("critical_threshold",     0.50)

    print("=" * 60)
    print("Decision Service ready")
    print(f"  ML Service   → {ML_SERVICE_URL}")
    print(f"  Twin Service → {TWIN_SERVICE_URL}")
    print(f"  Thresholds   → auto≥{AUTO_THRESH}  critical<{CRITICAL_THRESH}")
    print(f"  Default mode → {routing_cfg.get('default_experiment_mode', 'hitl')}")
    print("  Swagger docs → http://localhost:8003/docs")
    print("=" * 60)

    # Set default experiment mode from config
    experiment["mode"] = routing_cfg.get("default_experiment_mode", "hitl")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health():
    return HealthResponse(
        status="healthy",
        experiment_mode=experiment["mode"],
        experiment_active=experiment["active"],
        decision_count=len(decision_log),
        ml_service_url=ML_SERVICE_URL,
        twin_service_url=TWIN_SERVICE_URL,
    )


# ── /route ─────────────────────────────────────────────────────────────────────

@app.post("/route", response_model=RouteResponse, tags=["Routing"])
async def route_incident(features: IncidentFeatures):
    """
    The main routing pipeline.  Call this once per incident.

    Steps:
      1.  Call ML Service → get AI prediction + confidence
      2.  Call Twin Service → get current pipeline state (for SLA boost + context)
      3.  Apply routing logic based on experiment mode
      4.  Optionally notify Twin Service of an arrival (ai_only, or HITL auto_resolve
          only — pending human-review paths do not inflate Twin SLA during batch runs)
      5.  Return routing decision with full context

    The frontend uses this to decide what to show the analyst:
      auto_resolve → incident is handled silently, no UI needed
      escalate     → show incident + AI recommendation + SHAP explanation
      critical     → alert the analyst immediately
    """
    if not experiment["active"]:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "No active experiment run. Call /experiment/start before routing incidents.",
        )

    # Use httpx as an async HTTP client.
    # timeout=10.0 means: give up if the other service takes >10 seconds to reply.
    async with httpx.AsyncClient(timeout=10.0) as client:

        # ── Step 1: Call ML Service ────────────────────────────────────────
        try:
            ml_response = await client.post(
                f"{ML_SERVICE_URL}/predict",
                json=features.model_dump(),
            )
            ml_response.raise_for_status()   # raises if status code is 4xx/5xx
            ml_data = ml_response.json()
        except httpx.ConnectError:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                f"Cannot reach ML Service at {ML_SERVICE_URL}. Is it running?",
            )
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                f"ML Service returned an error: {e.response.text}",
            )

        ai_recommendation  = ml_data["predicted_class"]
        ai_confidence      = ml_data["confidence"]
        class_probabilities = ml_data["class_probabilities"]

        # ── Step 2: Call Twin Service ──────────────────────────────────────
        try:
            twin_response = await client.get(f"{TWIN_SERVICE_URL}/state")
            twin_response.raise_for_status()
            twin_state = twin_response.json()
        except httpx.ConnectError:
            # Twin service is optional for routing; warn but don't fail
            twin_state = {"error": f"Twin Service unreachable at {TWIN_SERVICE_URL}"}
        except httpx.HTTPStatusError:
            twin_state = {"error": "Twin Service returned an error"}

        # ── Step 3: Apply routing logic ────────────────────────────────────
        sla_remaining   = twin_state.get("sla_remaining_s", float("inf"))
        thresholds      = _compute_thresholds(sla_remaining)

        routing_decision, explanation = _apply_routing_logic(
            mode=experiment["mode"],
            ai_recommendation=ai_recommendation,
            confidence=ai_confidence,
            thresholds=thresholds,
        )

        # Optional: HITL_CDT_DEBUG_SLA=1 — print SLA / thresholds / confidence per /route call.
        if os.environ.get("HITL_CDT_DEBUG_SLA", "").strip().lower() in ("1", "true", "yes"):
            print(
                f"SLA remaining: {twin_state.get('sla_remaining_s')}, "
                f"thresholds: {thresholds}, confidence: {ai_confidence}",
                flush=True,
            )

        # ── Step 4: Notify Twin Service that this incident has arrived ─────
        incident_id = f"INC-{_new_id()}"
        # Twin open_incidents drives SLA remaining (see Twin _compute_sla_remaining).
        # POST /decisions sends resolve for fully closed rows, but HITL/human_only
        # escalate/critical rows stay pending until an analyst overrides — so if we
        # always posted arrive here, fast batch runs would stack open incidents and
        # crush SLA thresholds (e.g. T_auto -> 0.999) before humans act.
        #
        # Post arrive only when Twin will see a matching resolve in the same turn
        # from POST /decisions (non-pending rows), or for ai_only where every row
        # is logged as resolved immediately after routing.
        should_notify_twin_arrive = (
            experiment["mode"] == "ai_only"
            or routing_decision == "auto_resolve"
        )
        if should_notify_twin_arrive:
            try:
                await client.post(
                    f"{TWIN_SERVICE_URL}/state/event",
                    json={
                        "event_type":  "arrive",
                        "incident_id": incident_id,
                        "severity":    routing_decision,
                    },
                )
            except Exception:
                pass   # Twin notification is best-effort; don't block routing

        # Increment per-run counter
        if experiment["active"]:
            experiment["incident_count"] += 1

    return RouteResponse(
        incident_id=incident_id,
        routing_decision=routing_decision,
        ai_recommendation=ai_recommendation,
        ai_confidence=round(ai_confidence, 4),
        class_probabilities={k: round(v, 4) for k, v in class_probabilities.items()},
        experiment_mode=experiment["mode"],
        thresholds_used=thresholds,
        twin_context=twin_state,
        explanation=explanation,
    )


# ── /decisions ─────────────────────────────────────────────────────────────────

@app.post("/decisions", response_model=DecisionResponse, tags=["Decisions"])
async def log_decision(record: DecisionRecord):
    """
    Log a completed decision to the audit trail.

    Call this after /route to persist one decision row.

    Usage by mode:
      - ai_only: human_action is set (AI is final decision-maker)
      - hitl/human_only pending review: human_action=None for incidents that
        still require analyst action
      - fully resolved rows: human_action/final_action reflect final outcome

    Computes is_correct and cost if ground_truth is provided.
    Notifies Twin Service only for fully resolved rows; pending review rows are
    resolved later via POST /decisions/{id}/override.
    """
    if not experiment["active"]:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "No active experiment run. Decisions can only be logged during an active run.",
        )
    if record.experiment_mode != experiment["mode"]:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Payload experiment_mode={record.experiment_mode} does not match active mode={experiment['mode']}.",
        )

    decision_id = _new_id()

    # Determine is_correct: did final_action match ground truth?
    is_correct: Optional[bool] = None
    if record.ground_truth:
        is_correct = record.final_action == record.ground_truth

    # Compute cost from the cost model
    cost = _compute_cost(record.final_action, record.ground_truth)

    # Build the full decision record
    doc = {
        "decision_id":         decision_id,
        "run_id":              experiment["run_id"],
        "incident_id":         record.incident_id,
        "experiment_mode":     experiment["mode"],
        "incident_features":   record.incident_features,
        "ai_recommendation":   record.ai_recommendation,
        "ai_confidence":       record.ai_confidence,
        "routing_action":      record.routing_action,
        "human_action":        record.human_action,
        "human_override_to":   None,       # filled by /decisions/{id}/override
        "override_reason":     None,
        "final_action":        record.final_action,
        "ground_truth":        record.ground_truth,
        "is_correct":          is_correct,
        "cost":                cost,
        "resolution_time_s":   record.resolution_time_s,
        "decided_at":          _now(),
    }

    # Store decision and build index for O(1) override lookup
    decision_index[decision_id] = len(decision_log)
    decision_log.append(doc)

    # Notify Twin only when this record is fully resolved (not pending review).
    if not _is_pending_human_review(doc):
        await _notify_twin_resolved(
            incident_id=record.incident_id,
            severity=record.final_action,
        )

    return DecisionResponse(
        decision_id=decision_id,
        is_correct=is_correct,
        cost=cost,
        message=f"Decision logged. Correct={is_correct}, Cost={cost}",
    )


@app.post("/decisions/{decision_id}/override", response_model=OverrideResponse, tags=["Decisions"])
async def override_decision(decision_id: str, override: OverrideRequest):
    """
    Record a human override of a previously logged decision.

    This is called when a human analyst disagrees with the AI routing
    and takes a different action (or explicitly accepts it via the same path).
    The decision record is updated in-place:
      - human_action       → set to the analyst's chosen action
      - human_override_to  → the action the human chose
      - override_reason    → why they disagreed
      - final_action       → updated to the human's choice
      - is_correct / cost  → recomputed if ground_truth is now known

    If the row was pending human review, this endpoint also marks the incident
    resolved in Twin Service.
    """
    if not experiment["active"]:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "No active experiment run. Overrides are only allowed during an active run.",
        )

    if decision_id not in decision_index:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Decision {decision_id} not found.",
        )

    idx = decision_index[decision_id]
    doc = decision_log[idx]
    if doc.get("run_id") != experiment.get("run_id"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Decision does not belong to the active run and cannot be modified.",
        )
    was_pending = _is_pending_human_review(doc)

    old_action = doc["final_action"]

    # Recompute cost with ground_truth (may now be known at override time)
    ground_truth = override.ground_truth or doc.get("ground_truth")
    new_cost     = _compute_cost(override.new_action, ground_truth)
    old_cost     = doc["cost"] or 0.0

    # Update the record in-place
    doc["human_action"]       = override.new_action
    doc["human_override_to"] = (
        override.new_action if override.new_action != doc.get("ai_recommendation") else None
    )
    doc["override_reason"]   = override.override_reason
    doc["final_action"]      = override.new_action
    doc["ground_truth"]      = ground_truth
    doc["is_correct"]        = (override.new_action == ground_truth) if ground_truth else None
    doc["cost"]              = new_cost

    # If this incident was pending human review, it is now fully resolved.
    if was_pending:
        await _notify_twin_resolved(
            incident_id=doc["incident_id"],
            severity=doc["final_action"],
        )

    return OverrideResponse(
        decision_id=decision_id,
        old_action=old_action,
        new_action=override.new_action,
        override_reason=override.override_reason,
        cost_delta=round(new_cost - old_cost, 2),
    )


@app.get("/decisions/incident/{incident_id}", tags=["Decisions"])
async def get_decision_by_incident(incident_id: str):
    """
    Return the latest logged decision for one incident_id.

    Used by ML Service (/explain/{incident_id}) to fetch the exact feature set
    that was routed for this incident, so SHAP explanations are incident-specific.
    """
    for doc in reversed(decision_log):
        if doc.get("incident_id") == incident_id:
            return _flatten_doc(doc)

    raise HTTPException(
        status.HTTP_404_NOT_FOUND,
        f"Incident {incident_id} not found in decision log.",
    )


@app.get("/decisions/log", tags=["Decisions"])
async def get_decision_log(
    page:      int = Query(1,   ge=1,    description="Page number (1-indexed)"),
    page_size: int = Query(20,  ge=1, le=1000, description="Records per page"),
    mode:      Optional[str] = Query(None, description="Filter by experiment mode"),
    run_id:    Optional[str] = Query(None, description="Filter by run ID"),
):
    """
    Paginated decision history.

    Optional filters:
      ?mode=hitl        – only decisions from HITL mode
      ?run_id=ABC12345  – only decisions from one experiment run
      ?page=2&page_size=50

    Returns the most recent decisions first.
    """
    # Build the filtered list
    filtered = decision_log
    if mode:
        filtered = [d for d in filtered if d.get("experiment_mode") == mode]
    if run_id:
        filtered = [d for d in filtered if d.get("run_id") == run_id]

    # Sort newest first
    filtered = list(reversed(filtered))

    total      = len(filtered)
    start      = (page - 1) * page_size
    end        = start + page_size
    # Flatten incident_features into each row so the frontend can read
    # anomaly_type, data_source, etc. as top-level fields.
    page_data  = [_flatten_doc(d) for d in filtered[start:end]]

    return {
        "total":     total,
        "page":      page,
        "page_size": page_size,
        "pages":     max(1, (total + page_size - 1) // page_size),
        "decisions": page_data,
    }


@app.get("/decisions/stats", tags=["Decisions"])
async def get_stats(run_id: Optional[str] = Query(None)):
    """
    Compute accuracy, cost, and timing metrics from logged decisions.

    If run_id is given, only decisions from that run are included.
    Otherwise, the current experiment run's decisions are used.
    """
    if run_id:
        decisions = [d for d in decision_log if d.get("run_id") == run_id]
    else:
        decisions = _current_run_decisions()

    stats = _compute_stats(decisions)
    stats["run_id"] = run_id or experiment.get("run_id")
    stats["experiment_mode"] = experiment["mode"]
    return stats


# ── /experiment ────────────────────────────────────────────────────────────────

@app.post("/experiment/start", tags=["Experiment"])
async def start_experiment(request: ExperimentStartRequest):
    """
    Begin a new experiment run.

    Sets the routing mode, generates a new run_id, and resets the
    Twin Service state so metrics start from zero.

    Call this before submitting incidents for a new experiment.
    """
    if experiment["active"]:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "An experiment is already active. Stop the current run before starting a new one.",
        )

    # Reset Twin Service state
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(f"{TWIN_SERVICE_URL}/reset")
    except Exception:
        pass   # warn but don't block experiment start

    run_id = _new_id()

    experiment["active"]         = True
    experiment["run_id"]         = run_id
    experiment["mode"]           = request.mode
    experiment["started_at"]     = _now()
    experiment["stopped_at"]     = None
    experiment["incident_count"] = 0
    experiment["results"]        = None

    return {
        "message":    f"Experiment {run_id} started in {request.mode} mode.",
        "run_id":     run_id,
        "mode":       request.mode,
        "started_at": experiment["started_at"],
    }


@app.post("/experiment/stop", tags=["Experiment"])
async def stop_experiment():
    """
    End the current experiment run and compute final evaluation metrics.

    After this call, /experiment/results will return the full summary.
    The decision log is preserved; you can still export it via /experiment/export.
    """
    if not experiment["active"]:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "No experiment is currently active. Call /experiment/start first.",
        )

    decisions = _current_run_decisions()
    pending_count = sum(1 for d in decisions if _is_pending_human_review(d))
    if pending_count > 0:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Cannot stop experiment: {pending_count} incident(s) are still pending human review.",
        )

    experiment["active"]     = False
    experiment["stopped_at"] = _now()

    # Compute final metrics
    stats     = _compute_stats(decisions)

    results = ExperimentResults(
        run_id=experiment["run_id"],
        mode=experiment["mode"],
        total_incidents=stats["total_decisions"],
        correct_decisions=stats["correct_decisions"],
        accuracy=stats["accuracy"],
        total_cost=stats["total_cost"],
        avg_cost_per_incident=stats["avg_cost_per_incident"],
        avg_resolution_time_s=stats["avg_resolution_time_s"],
        override_count=stats["override_count"],
        override_rate=stats["override_rate"],
        started_at=experiment["started_at"],
        completed_at=experiment["stopped_at"],
        cost_breakdown=stats["cost_breakdown"],
    )

    experiment["results"] = results.model_dump()

    # Freeze the run context after completion so post-stop calls cannot
    # accidentally append more rows to the finished run_id.
    experiment["run_id"] = None

    return {
        "message": f"Experiment {experiment['run_id']} stopped.",
        "results": experiment["results"],
    }


@app.get("/experiment/results", response_model=ExperimentResults, tags=["Experiment"])
async def get_results():
    """
    Return the final results of the most recently completed experiment run.

    Raises 404 if no experiment has been stopped yet.
    """
    if not experiment["results"]:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "No completed experiment results available. Run and stop an experiment first.",
        )
    return experiment["results"]


@app.get("/experiment/export", tags=["Experiment"])
async def export_decisions(
    run_id: Optional[str] = Query(None),
    include_pending: bool = Query(False, description="Include unresolved pending-review rows"),
):
    """
    Download the decision log as a CSV file.

    ?run_id=ABC12345 → only decisions from that run
    No run_id        → current experiment run's decisions

    The CSV is streamed directly — no temp file is created.
    Open in Excel, pandas, or any spreadsheet tool.

    Example:
        curl http://localhost:8003/experiment/export > decisions.csv
    """
    if run_id:
        decisions = [d for d in decision_log if d.get("run_id") == run_id]
    else:
        decisions = _current_run_decisions()

    if not include_pending:
        decisions = [d for d in decisions if not _is_pending_human_review(d)]

    if not decisions:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "No decisions found for export.",
        )

    # Define the CSV columns (flatten incident_features into the row)
    feature_cols = [
        "anomaly_type", "affected_records_pct", "data_source",
        "pipeline_stage", "historical_frequency", "time_sensitivity", "data_domain",
    ]
    columns = [
        "decision_id", "run_id", "incident_id", "experiment_mode",
        *feature_cols,
        "ai_recommendation", "ai_confidence", "routing_action",
        "human_action", "human_override_to", "override_reason",
        "final_action", "ground_truth", "is_correct", "cost",
        "resolution_time_s", "decided_at",
    ]

    # Build CSV in memory using io.StringIO (no temp files)
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()

    for d in decisions:
        # Flatten nested incident_features dict into the row
        features = d.get("incident_features", {})
        row = {
            **d,
            **{col: features.get(col, "") for col in feature_cols},
        }
        writer.writerow(row)

    output.seek(0)

    # StreamingResponse sends the CSV to the client without buffering it in RAM.
    # The Content-Disposition header makes browsers save it as a file.
    filename = f"decisions_{run_id or experiment.get('run_id', 'all')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ── /incidents ────────────────────────────────────────────────────────────────

@app.get("/incidents/sample", tags=["Incidents"])
async def sample_incidents(
    count: int = Query(100, ge=1, le=3000, description="Number of incidents to sample"),
    seed: Optional[int] = Query(
        None,
        description="Optional RNG seed for reproducible sampling across runs/participants",
    ),
):
    """
    Return a stratified random sample from the incident dataset.

    Reads data/incidents.csv and samples `count` rows while preserving the
    original 60 / 30 / 10 class distribution (auto_resolve / escalate / critical).

    Each returned incident contains the 7 feature fields plus ground_truth,
    ready to be POSTed to /route.
    """
    csv_path = PROJECT_ROOT / "data" / "incidents.csv"

    max_per_experiment = int(routing_cfg.get("max_incidents_per_experiment", 3000))
    protocol_seed = routing_cfg.get("experiment_seed")

    if count != max_per_experiment:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Protocol lock: count must be exactly {max_per_experiment}.",
        )

    if protocol_seed is not None:
        if seed is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Protocol lock: seed is required and must be {int(protocol_seed)}.",
            )
        if int(seed) != int(protocol_seed):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Protocol lock: seed must be {int(protocol_seed)}.",
            )

    if count > max_per_experiment:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Requested count={count} exceeds max_incidents_per_experiment={max_per_experiment}.",
        )

    if not csv_path.exists():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Dataset not found at {csv_path}. Run data/generate_dataset.py first.",
        )

    # ── Read all rows ──────────────────────────────────────────────────────────
    all_rows: List[dict] = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            all_rows.append(row)

    total = len(all_rows)
    if total == 0:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Dataset is empty.")

    rng = random.Random(seed) if seed is not None else random

    # ── Stratified sample: keep the same per-class proportions ────────────────
    by_label: Dict[str, List[dict]] = {}
    for row in all_rows:
        label = row.get("label", "unknown")
        by_label.setdefault(label, []).append(row)

    sampled: List[dict] = []
    for label, rows in by_label.items():
        # How many from this class, proportional to requested count
        n = round(count * len(rows) / total)
        n = min(n, len(rows))   # can't exceed what's available
        sampled.extend(rng.sample(rows, n))

    # Due to rounding, sampled may be slightly short — top up from the largest class
    while len(sampled) < count:
        largest = max(by_label, key=lambda lbl: len(by_label[lbl]))
        pool = [r for r in by_label[largest] if r not in sampled]
        if not pool:
            break
        sampled.append(rng.choice(pool))

    rng.shuffle(sampled)

    # ── Build response: 7 features + ground_truth only ────────────────────────
    FEATURE_COLS = [
        "anomaly_type", "affected_records_pct", "data_source",
        "pipeline_stage", "historical_frequency", "time_sensitivity",
        "data_domain",
    ]

    result = []
    for row in sampled[:count]:
        incident: Dict[str, Any] = {col: row[col] for col in FEATURE_COLS}
        incident["affected_records_pct"] = float(incident["affected_records_pct"])
        incident["ground_truth"] = row["label"]
        result.append(incident)

    return {"count": len(result), "incidents": result}


# ── Root ───────────────────────────────────────────────────────────────────────

@app.get("/", tags=["Info"])
async def root():
    return {
        "service": "Decision Service – HITL-CDT",
        "version": "1.0.0",
        "tip": "Visit /docs for the interactive Swagger UI",
        "current_mode":      experiment["mode"],
        "experiment_active": experiment["active"],
        "decision_count":    len(decision_log),
        "endpoints": {
            "GET  /health":                  "Liveness check",
            "POST /route":                   "Route one incident (calls ML + Twin)",
            "POST /decisions":               "Log a completed decision",
            "POST /decisions/{id}/override": "Record a human override",
            "GET  /decisions/incident/{id}": "Latest decision row for one incident_id",
            "GET  /decisions/log":           "Paginated decision history",
            "GET  /decisions/stats":         "Accuracy, cost, timing metrics",
            "POST /experiment/start":        "Begin a new experiment run",
            "POST /experiment/stop":         "End experiment and compute results",
            "GET  /experiment/results":      "Final experiment metrics",
            "GET  /experiment/export":       "Download decision log as CSV",
            "GET  /incidents/sample":        "Stratified sample from the dataset (optional seed)",
            "GET  /docs":                    "Swagger UI",
        },
    }

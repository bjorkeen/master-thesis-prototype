"""
Twin Service – HITL-CDT
=======================
FastAPI service running on port 8002.

What is a "Digital Twin"?
  A Digital Twin is a live software mirror of a real-world system.
  Here, the "real world" is the data pipeline that processes incidents.
  This service keeps track of how many incidents are open, how busy the
  analyst is, whether SLAs are at risk, etc.  Because this is a research
  prototype (not a real pipeline), the state is simulated in memory.

Endpoints:
  GET  /state          – current pipeline state
  POST /state/event    – notify the twin that something happened (incident arrived / resolved)
  GET  /state/history  – recent state snapshots (time series)
  GET  /sla            – SLA countdown and risk level
  POST /simulate       – project what the state would look like under a hypothetical scenario
  POST /reset          – wipe state back to zero (call before starting a new experiment)
  GET  /health         – liveness check

Start from the project root:
    python3 -m uvicorn services.twin-service.main:app --port 8002 --reload

Or from inside services/twin-service/:
    python3 -m uvicorn main:app --port 8002 --reload

Then visit http://localhost:8002/docs for the interactive Swagger UI.
"""

# ── Imports ───────────────────────────────────────────────────────────────────
import math
from collections import deque
from datetime import datetime, timezone
from typing import Deque, Dict, List, Literal, Optional

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── Constants ─────────────────────────────────────────────────────────────────

# How many state snapshots to keep in memory.
# A deque with maxlen automatically drops the oldest entry when full.
MAX_HISTORY = 500

# SLA window in seconds.
# In this simulation each "experiment run" is expected to process all
# incidents within this time budget.  The SLA countdown ticks down as
# incidents arrive and resets when incidents are resolved.
SLA_TOTAL_SECONDS = 3600.0  # 1 hour

# How many analyst hours per hour are available.
# 1.0 = one analyst working full-time.
# We use this to compute analyst_workload_pct:
#   each escalated/critical incident that needs human review
#   contributes some workload weight.
ANALYST_CAPACITY = 1.0

# Workload contribution per incident type (fraction of analyst capacity).
# auto_resolve incidents do NOT require analyst time.
WORKLOAD_PER_ESCALATED = 0.05   # 5% of one analyst-hour per escalated incident
WORKLOAD_PER_CRITICAL  = 0.10   # 10% per critical (takes more attention)

# ── Pydantic models (data shapes) ────────────────────────────────────────────

class PipelineState(BaseModel):
    """
    The full state of the simulated data pipeline at one point in time.
    Every field has a plain-English description so the frontend can display it.
    """
    # Total incidents that have arrived but not yet been fully resolved
    open_incidents: int = Field(...,
        description="Number of incidents currently open (arrived but not resolved)")

    # Subset of open_incidents that are classified as 'critical'
    open_critical: int = Field(...,
        description="Open incidents classified as critical (urgent, needs immediate attention)")

    # Subset of open_incidents that are classified as 'escalate'
    open_escalated: int = Field(...,
        description="Open incidents classified as escalate (ambiguous, needs human review)")

    # How many incidents are waiting to be processed (not yet routed)
    queue_depth: int = Field(...,
        description="Number of incidents waiting in the queue (not yet routed/processed)")

    # How many incidents have been fully resolved per hour (rolling rate)
    throughput_per_hour: float = Field(...,
        description="Resolution throughput: incidents resolved per hour (rolling estimate)")

    # How busy the analyst is as a percentage (0–100+, can exceed 100 if overloaded)
    analyst_workload_pct: float = Field(...,
        description="Analyst workload as % of capacity (>100 means overloaded)")

    # How many seconds remain before SLA breach
    sla_remaining_s: float = Field(...,
        description="Seconds remaining before SLA breach")
    sla_total_s: float = Field(...,
        description="Total SLA window in seconds (constant for this run)")

    # Fraction of all resolved incidents that were auto-resolved (no human needed)
    auto_resolve_rate: float = Field(...,
        description="Fraction of resolved incidents that were auto-resolved (0.0–1.0)")

    # When this state was recorded
    timestamp: str = Field(...,
        description="ISO-8601 timestamp when this snapshot was taken")


class StateSnapshot(PipelineState):
    """
    A PipelineState plus a sequential snapshot ID.
    Stored in the history list.
    """
    snapshot_id: int = Field(..., description="Auto-incrementing snapshot index")


class EventRequest(BaseModel):
    """
    Body for POST /state/event.

    event_type:
      'arrive'  – a new incident just entered the pipeline
      'resolve' – an incident was fully resolved and closed

    severity:
      The predicted/actual class of the incident.
      Used to update the right counters (open_critical, open_escalated, etc.)
    """
    event_type: Literal["arrive", "resolve"] = Field(...,
        description="'arrive' when a new incident enters, 'resolve' when one is closed")
    incident_id: str = Field(...,
        description="Unique identifier of the incident (e.g. INC-0042)")
    severity: Literal["auto_resolve", "escalate", "critical"] = Field(...,
        description="Predicted class of this incident")


class EventResponse(BaseModel):
    """What POST /state/event returns."""
    message: str
    new_state: PipelineState


class SLAResponse(BaseModel):
    """What GET /sla returns."""
    sla_remaining_s: float = Field(..., description="Seconds until SLA breach")
    sla_total_s: float = Field(..., description="Total SLA window in seconds")
    sla_used_pct: float = Field(..., description="Percentage of SLA window consumed (0–100)")
    risk_level: str = Field(...,
        description="'green' (<50% used), 'yellow' (50–80%), 'red' (>80%)")
    open_critical: int = Field(..., description="Number of unresolved critical incidents")
    message: str = Field(..., description="Human-readable SLA status message")


class SimulateRequest(BaseModel):
    """
    Body for POST /simulate.
    Lets the caller ask: "what would the state look like if N more incidents arrived
    and M were resolved, with a given mix of severities?"
    """
    additional_arrivals: int = Field(0, ge=0,
        description="How many additional incidents would arrive")
    additional_resolutions: int = Field(0, ge=0,
        description="How many additional incidents would be resolved")
    severity_mix: Dict[str, float] = Field(
        default={"auto_resolve": 0.6, "escalate": 0.3, "critical": 0.1},
        description="Fraction of arrivals per severity class (must sum to ~1.0)")


class SimulateResponse(BaseModel):
    """What POST /simulate returns."""
    current_state: PipelineState
    projected_state: PipelineState
    delta: Dict[str, float] = Field(...,
        description="Difference between projected and current values")


class HealthResponse(BaseModel):
    status: str
    snapshot_count: int


# ── App setup ─────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Twin Service – HITL-CDT",
    description=(
        "Simulates and tracks the state of the data quality pipeline. "
        "Visit /docs for the interactive Swagger UI."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Helper functions ──────────────────────────────────────────────────────────
# Defined BEFORE the module-level state initialisation below,
# because _initial_state() calls _now() at import time.

def _now() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


# ── In-memory state ───────────────────────────────────────────────────────────
#
# We keep one mutable dictionary as the "live" state of the twin.
# Every time the state changes we append a copy to `state_history`.
#
# Using a plain dict (not a Pydantic model) makes it easy to update
# individual fields without rebuilding the whole object.

def _initial_state() -> dict:
    """Return the pipeline state at time zero (empty pipeline, full SLA budget)."""
    return {
        "open_incidents":       0,
        "open_critical":        0,
        "open_escalated":       0,
        "queue_depth":          0,
        "throughput_per_hour":  0.0,
        "analyst_workload_pct": 0.0,
        "sla_remaining_s":      SLA_TOTAL_SECONDS,
        "sla_total_s":          SLA_TOTAL_SECONDS,
        "auto_resolve_rate":    0.0,
        "timestamp":            _now(),
    }

# Live state — mutated by /state/event and /reset
current_state: dict = _initial_state()

# History ring-buffer — capped at MAX_HISTORY entries
# deque is like a list but automatically drops old items when maxlen is reached
state_history: Deque[dict] = deque(maxlen=MAX_HISTORY)

# Counters used to compute derived metrics (throughput, auto_resolve_rate)
_total_arrived:      int = 0   # incidents that have ever arrived
_total_resolved:     int = 0   # incidents that have ever been resolved
_auto_resolved:      int = 0   # subset of resolved that were auto_resolve
_snapshot_counter:   int = 0   # monotonically increasing snapshot ID

# Tracks the arrival time of the first incident in the current window
# (used to compute rolling throughput)
_first_arrival_time: Optional[datetime] = None


def _clamp(value: float, lo: float, hi: float) -> float:
    """Keep a value within [lo, hi]. Prevents negative counts, etc."""
    return max(lo, min(hi, value))


def _compute_throughput() -> float:
    """
    Estimate incidents resolved per hour.

    Simple formula:
        throughput = total_resolved / hours_elapsed_since_first_arrival

    If nothing has been resolved yet, returns 0.
    """
    if _total_resolved == 0 or _first_arrival_time is None:
        return 0.0

    elapsed_seconds = (
        datetime.now(timezone.utc) - _first_arrival_time
    ).total_seconds()

    if elapsed_seconds < 1:
        return 0.0

    # Convert elapsed seconds to hours, then compute rate
    elapsed_hours = elapsed_seconds / 3600.0
    return round(_total_resolved / elapsed_hours, 2)


def _compute_analyst_workload(open_escalated: int, open_critical: int) -> float:
    """
    Estimate analyst workload as a percentage of capacity.

    Each open escalated incident uses WORKLOAD_PER_ESCALATED of analyst capacity.
    Each open critical incident uses WORKLOAD_PER_CRITICAL.
    Multiply by 100 to get a percentage.

    Example: 3 escalated + 2 critical
      = (3*0.05 + 2*0.10) / 1.0 * 100
      = (0.15 + 0.20) * 100
      = 35%
    """
    raw_workload = (
        open_escalated * WORKLOAD_PER_ESCALATED +
        open_critical  * WORKLOAD_PER_CRITICAL
    ) / ANALYST_CAPACITY

    return round(raw_workload * 100, 1)   # as a percentage


def _compute_sla_remaining(open_incidents: int) -> float:
    """
    Simulate SLA countdown.

    The idea: the SLA budget shrinks as the queue grows and time passes.
    Each open incident "costs" a small slice of the SLA budget.
    This is a simple linear model — good enough for a simulation.

    Formula:
        sla_remaining = SLA_TOTAL - (open_incidents * cost_per_incident)
    where cost_per_incident is chosen so that 20 open incidents = 50% SLA consumed.
    """
    cost_per_incident = SLA_TOTAL_SECONDS / 40.0   # 40 open = full SLA consumed
    remaining = SLA_TOTAL_SECONDS - (open_incidents * cost_per_incident)
    return round(_clamp(remaining, 0.0, SLA_TOTAL_SECONDS), 1)


def _compute_auto_resolve_rate() -> float:
    """
    Fraction of all resolved incidents that were auto-resolved.
    Returns 0.0 if nothing has been resolved yet.
    """
    if _total_resolved == 0:
        return 0.0
    return round(_auto_resolved / _total_resolved, 3)


def _take_snapshot():
    """
    Copy the current state into the history buffer.
    Called every time the state changes.
    """
    global _snapshot_counter
    _snapshot_counter += 1

    snapshot = {**current_state, "snapshot_id": _snapshot_counter}
    state_history.append(snapshot)


def _rebuild_derived_fields():
    """
    Recompute all derived metrics from the raw counters and store them
    back into current_state.

    Call this after updating open_incidents / open_critical / open_escalated.
    """
    current_state["throughput_per_hour"]  = _compute_throughput()
    current_state["analyst_workload_pct"] = _compute_analyst_workload(
        current_state["open_escalated"],
        current_state["open_critical"],
    )
    current_state["sla_remaining_s"]  = _compute_sla_remaining(
        current_state["open_incidents"]
    )
    current_state["auto_resolve_rate"] = _compute_auto_resolve_rate()
    current_state["timestamp"]         = _now()


# ── Startup: take an initial snapshot ─────────────────────────────────────────

@app.on_event("startup")
async def startup():
    """Store the initial (empty) state as snapshot #0 so history is never empty."""
    _take_snapshot()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health():
    """Liveness check. Also reports how many snapshots are stored."""
    return HealthResponse(
        status="healthy",
        snapshot_count=len(state_history),
    )


@app.get("/state", response_model=PipelineState, tags=["State"])
async def get_state():
    """
    Return the current pipeline state.

    The frontend calls this every few seconds to update the TwinStatePanel.
    """
    return PipelineState(**current_state)


@app.get("/state/history", response_model=List[StateSnapshot], tags=["State"])
async def get_history(limit: int = 100):
    """
    Return the most recent state snapshots (newest last).

    Use the `limit` query parameter to control how many entries you get.
    Example: GET /state/history?limit=50

    The frontend uses this to draw time-series charts in the AnalyticsDashboard.
    """
    if limit < 1 or limit > MAX_HISTORY:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"limit must be between 1 and {MAX_HISTORY}",
        )

    # Convert deque to list, take the last `limit` entries
    history_list = list(state_history)
    return [StateSnapshot(**snap) for snap in history_list[-limit:]]


@app.post("/state/event", response_model=EventResponse, tags=["State"])
async def post_event(event: EventRequest):
    """
    Notify the twin that something happened in the pipeline.

    Two event types:
      'arrive'  – a new incident entered the queue
      'resolve' – an incident was fully handled and closed

    The twin updates its counters and derived metrics, then stores a snapshot.

    Example – incident arrives:
        POST /state/event
        {"event_type": "arrive", "incident_id": "INC-0001", "severity": "critical"}

    Example – incident resolved:
        POST /state/event
        {"event_type": "resolve", "incident_id": "INC-0001", "severity": "critical"}
    """
    global _total_arrived, _total_resolved, _auto_resolved, _first_arrival_time

    if event.event_type == "arrive":
        # ── An incident just entered the pipeline ──────────────────────────
        _total_arrived += 1

        # Record when the first incident of this session arrived
        # (used for throughput calculation)
        if _first_arrival_time is None:
            _first_arrival_time = datetime.now(timezone.utc)

        # Increment the appropriate counter based on severity
        current_state["open_incidents"] += 1
        current_state["queue_depth"]    += 1   # it's waiting to be routed

        if event.severity == "critical":
            current_state["open_critical"] += 1
        elif event.severity == "escalate":
            current_state["open_escalated"] += 1
        # auto_resolve incidents don't need analyst time, so no special counter

        message = (
            f"Incident {event.incident_id} arrived "
            f"(severity={event.severity}, total_open={current_state['open_incidents']})"
        )

    elif event.event_type == "resolve":
        # ── An incident was resolved and closed ───────────────────────────
        _total_resolved += 1

        if event.severity == "auto_resolve":
            _auto_resolved += 1

        # Decrement the appropriate counters (floor at 0 to avoid negatives)
        current_state["open_incidents"] = max(0, current_state["open_incidents"] - 1)
        current_state["queue_depth"]    = max(0, current_state["queue_depth"]    - 1)

        if event.severity == "critical":
            current_state["open_critical"]   = max(0, current_state["open_critical"]   - 1)
        elif event.severity == "escalate":
            current_state["open_escalated"]  = max(0, current_state["open_escalated"]  - 1)

        message = (
            f"Incident {event.incident_id} resolved "
            f"(severity={event.severity}, total_open={current_state['open_incidents']})"
        )

    else:
        # This can't happen because Pydantic enforces the Literal type,
        # but it's good practice to have a fallback.
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown event_type: {event.event_type}",
        )

    # Recompute all derived fields after the counters changed
    _rebuild_derived_fields()

    # Store a snapshot of the new state
    _take_snapshot()

    return EventResponse(
        message=message,
        new_state=PipelineState(**current_state),
    )


@app.get("/sla", response_model=SLAResponse, tags=["SLA"])
async def get_sla():
    """
    Return SLA countdown information.

    The risk_level field tells the frontend what colour to use:
      green  – less than 50% of the SLA budget consumed (safe)
      yellow – 50–80% consumed (watch out)
      red    – more than 80% consumed (urgent)
    """
    remaining = current_state["sla_remaining_s"]
    used_pct  = round((1 - remaining / SLA_TOTAL_SECONDS) * 100, 1)
    open_crit = current_state["open_critical"]

    # Determine risk colour
    if used_pct < 50:
        risk_level = "green"
        message = "SLA on track."
    elif used_pct < 80:
        risk_level = "yellow"
        message = f"SLA at risk — {remaining:.0f}s remaining, {open_crit} critical open."
    else:
        risk_level = "red"
        message = f"SLA CRITICAL — only {remaining:.0f}s remaining, {open_crit} critical open!"

    return SLAResponse(
        sla_remaining_s=remaining,
        sla_total_s=SLA_TOTAL_SECONDS,
        sla_used_pct=used_pct,
        risk_level=risk_level,
        open_critical=open_crit,
        message=message,
    )


@app.post("/simulate", response_model=SimulateResponse, tags=["Simulation"])
async def simulate(scenario: SimulateRequest):
    """
    Project what the pipeline state would look like if a hypothetical
    scenario played out — without actually changing the live state.

    Use case: the frontend can show "if 20 more incidents arrive with the
    default severity mix, the analyst workload would jump to 75%".

    The severity_mix dict controls how the arrivals are distributed:
      {"auto_resolve": 0.6, "escalate": 0.3, "critical": 0.1}
    means 60% auto-resolve, 30% escalate, 10% critical.
    """
    mix = scenario.severity_mix
    arrivals   = scenario.additional_arrivals
    resolutions = scenario.additional_resolutions

    # Validate that the mix sums to approximately 1.0
    total_mix = sum(mix.values())
    if not (0.9 <= total_mix <= 1.1):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"severity_mix values must sum to ~1.0 (got {total_mix:.2f})",
        )

    # Start from the current state and apply the hypothetical changes
    proj_open_incidents  = current_state["open_incidents"]  + arrivals - resolutions
    proj_open_critical   = current_state["open_critical"]   + int(arrivals * mix.get("critical", 0))
    proj_open_escalated  = current_state["open_escalated"]  + int(arrivals * mix.get("escalate", 0))
    proj_queue_depth     = current_state["queue_depth"]     + arrivals - resolutions

    # Clamp all values to 0 (can't have negative open incidents)
    proj_open_incidents = max(0, proj_open_incidents)
    proj_open_critical  = max(0, proj_open_critical)
    proj_open_escalated = max(0, proj_open_escalated)
    proj_queue_depth    = max(0, proj_queue_depth)

    # Project the derived fields
    proj_workload = _compute_analyst_workload(proj_open_escalated, proj_open_critical)
    proj_sla      = _compute_sla_remaining(proj_open_incidents)

    # Projected auto_resolve_rate: assume the same rate holds
    proj_resolved_total = _total_resolved + resolutions
    proj_auto_resolved  = _auto_resolved  + int(resolutions * mix.get("auto_resolve", 0))
    proj_auto_rate = (
        round(proj_auto_resolved / proj_resolved_total, 3)
        if proj_resolved_total > 0 else 0.0
    )

    projected = PipelineState(
        open_incidents=proj_open_incidents,
        open_critical=proj_open_critical,
        open_escalated=proj_open_escalated,
        queue_depth=proj_queue_depth,
        throughput_per_hour=current_state["throughput_per_hour"],  # unchanged in projection
        analyst_workload_pct=proj_workload,
        sla_remaining_s=proj_sla,
        sla_total_s=SLA_TOTAL_SECONDS,
        auto_resolve_rate=proj_auto_rate,
        timestamp=_now(),
    )

    current = PipelineState(**current_state)

    # Compute the delta (projected minus current) for each numeric field
    delta = {
        "open_incidents":      projected.open_incidents      - current.open_incidents,
        "open_critical":       projected.open_critical       - current.open_critical,
        "open_escalated":      projected.open_escalated      - current.open_escalated,
        "queue_depth":         projected.queue_depth         - current.queue_depth,
        "analyst_workload_pct": projected.analyst_workload_pct - current.analyst_workload_pct,
        "sla_remaining_s":     projected.sla_remaining_s     - current.sla_remaining_s,
        "auto_resolve_rate":   projected.auto_resolve_rate   - current.auto_resolve_rate,
    }

    return SimulateResponse(
        current_state=current,
        projected_state=projected,
        delta=delta,
    )


@app.post("/reset", tags=["Control"])
async def reset():
    """
    Reset the twin state back to zero.

    Call this before starting a new experiment run so the metrics don't
    carry over from the previous run.
    """
    global current_state, _total_arrived, _total_resolved
    global _auto_resolved, _first_arrival_time, _snapshot_counter

    # Wipe all counters
    _total_arrived       = 0
    _total_resolved      = 0
    _auto_resolved       = 0
    _first_arrival_time  = None

    # Re-initialise state dict to defaults
    current_state = _initial_state()

    # Clear history — start fresh
    state_history.clear()
    _snapshot_counter = 0

    # Store the blank initial state as the first snapshot
    _take_snapshot()

    return {
        "message": "Twin state reset to initial values.",
        "state": current_state,
    }


@app.get("/", tags=["Info"])
async def root():
    """Service index – lists all endpoints."""
    return {
        "service": "Twin Service – HITL-CDT",
        "version": "1.0.0",
        "tip": "Visit /docs for the interactive Swagger UI",
        "endpoints": {
            "GET  /health":        "Liveness check",
            "GET  /state":         "Current pipeline state",
            "POST /state/event":   "Notify twin of arrive/resolve event",
            "GET  /state/history": "Recent state snapshots (time series)",
            "GET  /sla":           "SLA countdown and risk level",
            "POST /simulate":      "Project state under a hypothetical scenario",
            "POST /reset":         "Reset state for a new experiment",
            "GET  /docs":          "Swagger UI",
        },
    }

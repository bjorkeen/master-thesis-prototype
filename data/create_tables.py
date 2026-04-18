"""
create_tables.py — Creates all HITL-CDT database tables.

Run once (or whenever you want to reset the schema):
    cd master-thesis-prototype
    python data/create_tables.py

The script connects via db.py — it tries PostgreSQL first and falls back to
SQLite automatically. You will see a line telling you which backend is used.

Tables created:
    1. incidents       — one row per incoming data-quality incident
    2. decisions       — one row per routing decision (AI or human)
    3. twin_snapshots  — periodic snapshots of the Digital Twin pipeline state
    4. experiment_runs — one row per experimental run (AI-only / Human-only / HITL)
"""

import sys
import logging
from pathlib import Path

# --------------------------------------------------------------------------- #
# Make sure Python can find data/db.py when we run this from the repo root
# --------------------------------------------------------------------------- #
# Adds the repo root (parent of data/) to sys.path so `from data.db import ...`
# works whether you run the script from the repo root or from inside data/.
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import (
    Boolean,
    Column,
    Float,
    Integer,
    String,
    Text,
    TIMESTAMP,
    func,
    inspect,
)

from data.db import Base, engine, db_backend

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(message)s")

# =========================================================================== #
# ORM Model definitions
# Each class = one database table.
# =========================================================================== #

class Incident(Base):
    """
    One row per incoming data-quality incident fed into the system.

    The 7 feature columns (anomaly_type … data_domain) are the exact inputs
    the ML model uses. confidence_score and predicted_action are filled in
    after the ML service runs.
    """
    __tablename__ = "incidents"

    # Primary key — auto-incremented integer, managed by the DB
    id = Column(Integer, primary_key=True, autoincrement=True)

    # Human-readable unique identifier (e.g. "INC-20240418-001")
    incident_id = Column(String(64), unique=True, nullable=False)

    # --- The 7 ML features ---
    anomaly_type        = Column(String(64))   # null_values | duplicates | schema_mismatch | …
    affected_records_pct = Column(Float)        # 0.1 – 100.0
    data_source         = Column(String(64))   # crm | erp | api_feed | …
    pipeline_stage      = Column(String(64))   # ingestion | transformation | …
    historical_frequency = Column(String(64))  # first_occurrence | rare | …
    time_sensitivity    = Column(String(64))   # low | medium | high | critical
    data_domain         = Column(String(64))   # finance | marketing | …

    # --- ML output ---
    confidence_score = Column(Float)           # highest class probability (0–1)
    predicted_action = Column(String(32))      # auto_resolve | escalate | critical

    # --- Labels ---
    ground_truth = Column(String(32))          # true label (from dataset or human)
    status       = Column(String(32), default="open")  # open | resolved | overridden

    # --- Timestamps ---
    # server_default=func.now() means the DB sets this automatically on INSERT
    created_at  = Column(TIMESTAMP, server_default=func.now())
    resolved_at = Column(TIMESTAMP, nullable=True)


class Decision(Base):
    """
    One row per routing decision made by the system.

    A decision is created when the Decision Service processes an incident.
    If a human overrides the AI recommendation, the override columns are filled
    and cost is recalculated.
    """
    __tablename__ = "decisions"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    decision_id = Column(String(64), unique=True, nullable=False)

    # Foreign key to incidents — stored as a plain VARCHAR (no FK constraint so
    # SQLite and PostgreSQL both work without extra configuration)
    incident_id = Column(String(64), nullable=False)

    # Which experiment run this decision belongs to
    run_id          = Column(String(64))
    experiment_mode = Column(String(32))   # ai_only | human_only | hitl

    # AI recommendation
    ai_recommendation = Column(String(32))  # auto_resolve | escalate | critical
    ai_confidence     = Column(Float)

    # What the routing logic decided to do
    routing_action = Column(String(32))     # auto_resolve | send_to_human | critical_alert

    # Human decision (NULL when mode=ai_only or not yet reviewed)
    human_action      = Column(String(32), nullable=True)
    human_override_to = Column(String(32), nullable=True)  # what the human changed it to
    override_reason   = Column(Text,       nullable=True)

    # Final outcome
    final_action = Column(String(32))       # the action that was actually taken
    ground_truth = Column(String(32), nullable=True)
    is_correct   = Column(Boolean,   nullable=True)

    # Cost in euros (from cost_model.yaml)
    cost = Column(Float, nullable=True)

    # Seconds from incident creation to decision
    resolution_time_s = Column(Float, nullable=True)

    decided_at = Column(TIMESTAMP, server_default=func.now())


class TwinSnapshot(Base):
    """
    A point-in-time snapshot of the Digital Twin pipeline state.

    The Twin Service writes one of these every time /state/event is called
    or on a periodic tick. Stored so we can replay the pipeline history.
    """
    __tablename__ = "twin_snapshots"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    snapshot_id = Column(Integer)               # monotonically increasing counter

    timestamp = Column(TIMESTAMP, server_default=func.now())

    # Queue / workload metrics
    open_incidents   = Column(Integer)
    open_critical    = Column(Integer)
    open_escalated   = Column(Integer)
    queue_depth      = Column(Integer)

    # Performance metrics
    throughput_per_hour   = Column(Float)
    analyst_workload_pct  = Column(Float)   # 0–100 %

    # SLA
    sla_remaining_s   = Column(Float)       # seconds until SLA breach
    auto_resolve_rate = Column(Float)       # fraction auto-resolved (0–1)


class ExperimentRun(Base):
    """
    One row per complete experimental run.

    A run covers N incidents processed in one of the three modes.
    Aggregate metrics are computed when /experiment/stop is called.
    """
    __tablename__ = "experiment_runs"

    id     = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), unique=True, nullable=False)

    mode            = Column(String(32))   # ai_only | human_only | hitl
    total_incidents = Column(Integer)

    # Aggregate performance
    accuracy             = Column(Float)
    total_cost           = Column(Float)
    avg_resolution_time_s = Column(Float, nullable=True)

    # Human override metrics
    override_count = Column(Integer, default=0)
    override_rate  = Column(Float,   default=0.0)

    started_at   = Column(TIMESTAMP, server_default=func.now())
    completed_at = Column(TIMESTAMP, nullable=True)


# =========================================================================== #
# Main: create all tables
# =========================================================================== #

def create_all_tables():
    """
    Create every table defined above (if it doesn't already exist).

    SQLAlchemy's create_all uses IF NOT EXISTS semantics — safe to run
    multiple times without wiping data.
    """
    backend = db_backend()
    print(f"\n{'='*60}")
    print(f"  HITL-CDT — Database Setup")
    print(f"  Backend : {backend.upper()}")
    if backend == "sqlite":
        db_file = Path(__file__).parent / "hitl_cdt.db"
        print(f"  File    : {db_file}")
    else:
        print(f"  Host    : localhost:5432 / hitl_cdt")
    print(f"{'='*60}\n")

    # Get the list of tables already in the DB so we can say "already exists"
    inspector = inspect(engine)
    existing = set(inspector.get_table_names())

    # Create tables
    Base.metadata.create_all(bind=engine)

    # Report what happened for each table
    all_tables = [
        ("incidents",       "one row per data-quality incident"),
        ("decisions",       "one row per routing decision"),
        ("twin_snapshots",  "periodic Digital Twin state snapshots"),
        ("experiment_runs", "one row per experiment run (AI/Human/HITL)"),
    ]

    print("Table status:")
    for table_name, description in all_tables:
        if table_name in existing:
            status = "already existed — left untouched"
        else:
            status = "CREATED"
        print(f"  [{status:30s}]  {table_name}")
        print(f"                                      → {description}")

    print(f"\nAll done. {len(all_tables)} tables ready.\n")


if __name__ == "__main__":
    create_all_tables()

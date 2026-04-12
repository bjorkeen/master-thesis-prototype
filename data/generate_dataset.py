"""
generate_dataset.py
-------------------
Generates a synthetic dataset of 3,000 data quality incidents for training
and evaluating an AI triage/routing model.

Each incident is described by 7 features and assigned a ground-truth label
(auto_resolve | escalate | critical) via a probabilistic scoring function
with added Gaussian noise to create a realistic ambiguity zone.

Target label distribution:
  - auto_resolve : ~60%
  - escalate     : ~30%
  - critical     : ~10%

Fixed random seed (42) ensures full reproducibility.
"""

import os
import numpy as np
import pandas as pd

# ── Reproducibility ────────────────────────────────────────────────────────────
SEED = 42
rng = np.random.default_rng(SEED)          # modern NumPy RNG (preferred over np.random.seed)

# ── Dataset size ───────────────────────────────────────────────────────────────
N = 3_000

# ══════════════════════════════════════════════════════════════════════════════
# 1. FEATURE DEFINITIONS
#    Each categorical feature has a list of possible values and a corresponding
#    probability distribution that reflects realistic incident frequencies.
# ══════════════════════════════════════════════════════════════════════════════

# --- 1a. anomaly_type ----------------------------------------------------------
# The kind of data quality problem detected.
# Nulls/duplicates are most common; schema breaks rarer; corruption rarest.
ANOMALY_TYPES = ["null_values", "duplicates", "schema_mismatch",
                 "outlier", "referential_integrity", "data_corruption"]
ANOMALY_PROBS = [0.30, 0.25, 0.15, 0.15, 0.10, 0.05]

# Severity weight: how much each anomaly type contributes to a high severity
# score (0 = benign, 1 = maximally severe).
ANOMALY_SEVERITY = {
    "null_values":           0.3,
    "duplicates":            0.2,
    "schema_mismatch":       0.6,
    "outlier":               0.4,
    "referential_integrity": 0.7,
    "data_corruption":       0.9,
}

# --- 1b. affected_records_pct -------------------------------------------------
# Percentage of records impacted (continuous, 0–100).
# Sampled from a right-skewed Beta distribution: most incidents affect a small
# fraction of records, but the tail extends to 100 %.
#   Beta(alpha=1.5, beta=5) → mean ≈ 23 %, mode near 10 %
AFFECTED_PCT_ALPHA = 1.5
AFFECTED_PCT_BETA  = 5.0

# --- 1c. data_source ----------------------------------------------------------
# Upstream system that produced the data.
DATA_SOURCES = ["crm", "erp", "api_feed", "manual_entry", "iot_stream", "data_warehouse"]
SOURCE_PROBS  = [0.20, 0.20, 0.25, 0.15, 0.10, 0.10]

# How unreliable / error-prone each source tends to be (affects severity).
SOURCE_SEVERITY = {
    "crm":            0.3,
    "erp":            0.4,
    "api_feed":       0.5,
    "manual_entry":   0.8,   # human entry → highest error rate
    "iot_stream":     0.6,
    "data_warehouse": 0.2,   # usually well-governed
}

# --- 1d. pipeline_stage -------------------------------------------------------
# Where in the ETL/ELT pipeline the incident was caught.
# Catching problems earlier (ingestion) is cheaper to fix than catching them
# downstream (reporting/serving).
PIPELINE_STAGES = ["ingestion", "transformation", "validation", "loading", "serving"]
STAGE_PROBS     = [0.30, 0.25, 0.20, 0.15, 0.10]

STAGE_SEVERITY = {
    "ingestion":      0.3,   # caught early → lower blast radius
    "transformation": 0.5,
    "validation":     0.4,
    "loading":        0.6,
    "serving":        0.8,   # already reached consumers → highest impact
}

# --- 1e. historical_frequency -------------------------------------------------
# How often this type of incident has occurred before.
# Rare incidents are harder to triage automatically.
HIST_FREQ_BINS  = ["first_occurrence", "rare", "occasional", "frequent", "chronic"]
HIST_FREQ_PROBS = [0.10, 0.20, 0.35, 0.25, 0.10]

# Inverse severity: chronic issues are well-understood (low novelty → easier
# to auto-resolve); first occurrences are unpredictable (higher severity).
HIST_FREQ_SEVERITY = {
    "first_occurrence": 0.8,
    "rare":             0.6,
    "occasional":       0.4,
    "frequent":         0.3,
    "chronic":          0.2,
}

# --- 1f. time_sensitivity -----------------------------------------------------
# Business urgency of resolving the incident.
TIME_SENS_BINS  = ["low", "medium", "high", "critical"]
TIME_SENS_PROBS = [0.30, 0.40, 0.20, 0.10]

TIME_SENS_SEVERITY = {
    "low":      0.1,
    "medium":   0.4,
    "high":     0.7,
    "critical": 1.0,
}

# --- 1g. data_domain ----------------------------------------------------------
# Business domain the affected dataset belongs to.
# Finance/compliance data has higher regulatory stakes.
DATA_DOMAINS      = ["finance", "marketing", "operations", "hr", "product", "compliance"]
DOMAIN_PROBS      = [0.20, 0.20, 0.20, 0.15, 0.15, 0.10]

DOMAIN_SEVERITY = {
    "finance":    0.8,
    "marketing":  0.3,
    "operations": 0.5,
    "hr":         0.6,
    "product":    0.4,
    "compliance": 0.9,   # regulatory exposure → highest stakes
}

# ══════════════════════════════════════════════════════════════════════════════
# 2. SAMPLE RAW FEATURES
# ══════════════════════════════════════════════════════════════════════════════

print("Sampling features...")

anomaly_type       = rng.choice(ANOMALY_TYPES,        size=N, p=ANOMALY_PROBS)
affected_pct_raw   = rng.beta(AFFECTED_PCT_ALPHA, AFFECTED_PCT_BETA, size=N) * 100  # → [0, 100]
data_source        = rng.choice(DATA_SOURCES,         size=N, p=SOURCE_PROBS)
pipeline_stage     = rng.choice(PIPELINE_STAGES,      size=N, p=STAGE_PROBS)
historical_freq    = rng.choice(HIST_FREQ_BINS,       size=N, p=HIST_FREQ_PROBS)
time_sensitivity   = rng.choice(TIME_SENS_BINS,       size=N, p=TIME_SENS_PROBS)
data_domain        = rng.choice(DATA_DOMAINS,         size=N, p=DOMAIN_PROBS)

# Round affected_records_pct to 2 decimal places for readability
affected_records_pct = np.round(affected_pct_raw, 2)

# ══════════════════════════════════════════════════════════════════════════════
# 3. PROBABILISTIC SEVERITY SCORING FUNCTION
#
#    severity_score ∈ [0, 1] is a weighted linear combination of the per-feature
#    severity contributions.  The weights below reflect relative importance:
#
#      Feature                Weight   Rationale
#      ─────────────────────  ──────   ────────────────────────────────────────
#      anomaly_type            0.20    Nature of the defect
#      affected_records_pct    0.25    Scale of impact (normalised to [0,1])
#      data_source             0.10    Source reliability
#      pipeline_stage          0.15    Blast radius (how far downstream)
#      historical_frequency    0.10    Novelty / precedent
#      time_sensitivity        0.20    Business urgency
#      data_domain             0.00    (applied separately as a domain multiplier)
#
#    data_domain does not add linearly; instead it scales the total score by
#    [1.0, 1.2] to capture "same incident is worse in finance/compliance".
# ══════════════════════════════════════════════════════════════════════════════

print("Computing severity scores...")

# Map each categorical sample to its numeric severity value via vectorised lookup
v_anomaly  = np.vectorize(ANOMALY_SEVERITY.__getitem__)(anomaly_type)
v_source   = np.vectorize(SOURCE_SEVERITY.__getitem__)(data_source)
v_stage    = np.vectorize(STAGE_SEVERITY.__getitem__)(pipeline_stage)
v_hist     = np.vectorize(HIST_FREQ_SEVERITY.__getitem__)(historical_freq)
v_time     = np.vectorize(TIME_SENS_SEVERITY.__getitem__)(time_sensitivity)
v_domain   = np.vectorize(DOMAIN_SEVERITY.__getitem__)(data_domain)

# Normalise affected_records_pct from [0, 100] → [0, 1]
v_affected = affected_records_pct / 100.0

# Weighted sum (weights sum to 1.0 excluding domain multiplier)
W_ANOMALY  = 0.20
W_AFFECTED = 0.25
W_SOURCE   = 0.10
W_STAGE    = 0.15
W_HIST     = 0.10
W_TIME     = 0.20

base_score = (
    W_ANOMALY  * v_anomaly  +
    W_AFFECTED * v_affected +
    W_SOURCE   * v_source   +
    W_STAGE    * v_stage    +
    W_HIST     * v_hist     +
    W_TIME     * v_time
)

# Domain multiplier: maps domain severity [0.3, 0.9] → scale factor [1.0, 1.2]
# so that high-stakes domains amplify the score without dominating it.
domain_multiplier = 1.0 + 0.2 * v_domain   # range [1.06, 1.18] for our domains
severity_score_raw = base_score * domain_multiplier

# Clip to [0, 1] after multiplication (some scores may slightly exceed 1)
severity_score_raw = np.clip(severity_score_raw, 0.0, 1.0)

# ══════════════════════════════════════════════════════════════════════════════
# 4. ADD GAUSSIAN NOISE → AMBIGUITY ZONE
#
#    Real-world triage is noisy: the same features can yield different human
#    judgements.  We model this by adding zero-mean Gaussian noise to each
#    score, creating an "ambiguity zone" where label boundaries are fuzzy.
#
#    Noise std = 0.10 produces a ~25–30 % ambiguity band around each threshold.
# ══════════════════════════════════════════════════════════════════════════════

NOISE_STD = 0.10
noise = rng.normal(loc=0.0, scale=NOISE_STD, size=N)
severity_score = np.clip(severity_score_raw + noise, 0.0, 1.0)

# ══════════════════════════════════════════════════════════════════════════════
# 5. ASSIGN GROUND-TRUTH LABELS
#
#    Thresholds are chosen so the noisy score yields approximately:
#      auto_resolve : 60 %   (score < T_LOW)
#      escalate     : 30 %   (T_LOW ≤ score < T_HIGH)
#      critical     : 10 %   (score ≥ T_HIGH)
#
#    Thresholds are calibrated empirically against the score distribution.
# ══════════════════════════════════════════════════════════════════════════════

# Calibration: examine quantiles of severity_score to set thresholds
# that hit the desired marginal distribution.
T_LOW  = np.percentile(severity_score, 60)   # bottom 60 % → auto_resolve
T_HIGH = np.percentile(severity_score, 90)   # top 10 %    → critical

labels = np.where(
    severity_score < T_LOW,  "auto_resolve",
    np.where(severity_score < T_HIGH, "escalate", "critical")
)

# ══════════════════════════════════════════════════════════════════════════════
# 6. ASSEMBLE DATAFRAME
# ══════════════════════════════════════════════════════════════════════════════

df = pd.DataFrame({
    "anomaly_type":         anomaly_type,
    "affected_records_pct": affected_records_pct,
    "data_source":          data_source,
    "pipeline_stage":       pipeline_stage,
    "historical_frequency": historical_freq,
    "time_sensitivity":     time_sensitivity,
    "data_domain":          data_domain,
    # Intermediate columns kept for inspection / model debugging
    "severity_score_raw":   np.round(severity_score_raw, 4),
    "severity_score":       np.round(severity_score, 4),
    "label":                labels,
})

# ══════════════════════════════════════════════════════════════════════════════
# 7. SAVE TO CSV
# ══════════════════════════════════════════════════════════════════════════════

output_path = os.path.join(os.path.dirname(__file__), "incidents.csv")
df.to_csv(output_path, index=False)
print(f"\nDataset saved → {output_path}  ({N} rows)\n")

# ══════════════════════════════════════════════════════════════════════════════
# 8. SUMMARY STATISTICS
# ══════════════════════════════════════════════════════════════════════════════

print("=" * 60)
print("SUMMARY STATISTICS")
print("=" * 60)

print("\n── Label distribution ──────────────────────────────────────")
label_counts = df["label"].value_counts()
label_pct    = df["label"].value_counts(normalize=True) * 100
for lbl in ["auto_resolve", "escalate", "critical"]:
    print(f"  {lbl:<15}  {label_counts[lbl]:>5}  ({label_pct[lbl]:.1f} %)")

print("\n── Severity score (noisy) ──────────────────────────────────")
s = df["severity_score"].describe()
for stat in ["mean", "std", "min", "25%", "50%", "75%", "max"]:
    print(f"  {stat:<6}  {s[stat]:.4f}")

print(f"\n  Threshold T_LOW  (60th pct): {T_LOW:.4f}")
print(f"  Threshold T_HIGH (90th pct): {T_HIGH:.4f}")

print("\n── affected_records_pct ────────────────────────────────────")
a = df["affected_records_pct"].describe()
for stat in ["mean", "std", "min", "50%", "max"]:
    print(f"  {stat:<6}  {a[stat]:.2f}")

print("\n── Categorical feature distributions ───────────────────────")

def print_cat(col, name):
    print(f"\n  {name}:")
    vc = df[col].value_counts()
    for val, cnt in vc.items():
        print(f"    {val:<25}  {cnt:>5}  ({cnt/N*100:.1f} %)")

print_cat("anomaly_type",       "anomaly_type")
print_cat("data_source",        "data_source")
print_cat("pipeline_stage",     "pipeline_stage")
print_cat("historical_frequency","historical_frequency")
print_cat("time_sensitivity",   "time_sensitivity")
print_cat("data_domain",        "data_domain")

print("\n── Ambiguity zone estimate ─────────────────────────────────")
# Ambiguity zone: incidents whose raw score and noisy score straddle a threshold
crossed_low  = ((severity_score_raw < T_LOW)  != (severity_score < T_LOW)).sum()
crossed_high = ((severity_score_raw < T_HIGH) != (severity_score < T_HIGH)).sum()
ambiguous    = crossed_low + crossed_high
print(f"  Incidents that crossed a threshold due to noise: {ambiguous} ({ambiguous/N*100:.1f} %)")

print("\n" + "=" * 60)
print("Done.")

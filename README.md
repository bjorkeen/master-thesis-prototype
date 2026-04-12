# Master Thesis Prototype

AI-driven data quality incident triage system. Classifies incidents into three categories: **auto-resolve**, **escalate**, or **critical** based on synthetic incidents with programmatic severity scoring.

## Overview

This prototype demonstrates an ML approach to automating data quality incident routing:
- **3,000 synthetic incidents** with realistic feature distributions
- **Probabilistic severity scoring** combining anomaly type, scale, source, pipeline stage, frequency, urgency, and domain
- **~30% ambiguity zone** via Gaussian noise to simulate real-world label uncertainty
- **Stratified labels**: 60% auto-resolve, 30% escalate, 10% critical

## Project Structure

```
.
├── data/
│   ├── generate_dataset.py      # Generates 3k synthetic incidents → incidents.csv
│   └── incidents.csv            # Generated dataset (3000 rows, 10 cols)
├── CLAUDE.md                    # Project notes for Claude
├── README.md                    # This file
└── .gitignore
```

## Dataset Features

| Feature | Type | Notes |
|---------|------|-------|
| `anomaly_type` | categorical | null_values, duplicates, schema_mismatch, outlier, referential_integrity, data_corruption |
| `affected_records_pct` | continuous | % of records impacted (0–100, skewed) |
| `data_source` | categorical | crm, erp, api_feed, manual_entry, iot_stream, data_warehouse |
| `pipeline_stage` | categorical | ingestion, transformation, validation, loading, serving |
| `historical_frequency` | categorical | first_occurrence, rare, occasional, frequent, chronic |
| `time_sensitivity` | categorical | low, medium, high, critical |
| `data_domain` | categorical | finance, marketing, operations, hr, product, compliance |
| `severity_score_raw` | continuous | Raw severity (0–1) before noise |
| `severity_score` | continuous | Noisy severity (0–1) after Gaussian noise |
| `label` | categorical | Ground truth: auto_resolve, escalate, critical |

## Generating the Dataset

```bash
python3 data/generate_dataset.py
```

Output:
- `data/incidents.csv` — 3000 rows
- Console summary stats

## Development Setup

### Requirements
- Python 3.11+
- pandas, numpy

### Install

```bash
pip install pandas numpy
```

## Notes

- **Reproducibility**: Fixed seed (42) in `generate_dataset.py`
- **Ambiguity zone**: ~31.7% of incidents cross a label boundary due to noise
- **Severity function**: Weighted linear combination (weights: anomaly 0.20, affected_pct 0.25, source 0.10, stage 0.15, frequency 0.10, time 0.20) + domain multiplier
- **Domain multiplier**: High-stakes domains (finance, compliance) amplify severity scores by up to 1.2×

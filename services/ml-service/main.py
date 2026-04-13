"""
ML Service – HITL-CDT
=====================
FastAPI service running on port 8001.

Provides:
  POST /predict              – classify one incident (class + confidence + probabilities)
  POST /predict/batch        – classify a list of incidents
  GET  /explain/{incident_id}– SHAP explanation for a stored incident ID
  POST /explain/features     – SHAP explanation given raw feature values directly
  GET  /explain/global       – global feature importances from the forest
  GET  /model/info           – model metadata
  GET  /health               – liveness check
  GET  /docs                 – Swagger UI (built-in, free!)

Start the service from the project root:
    uvicorn services.ml-service.main:app --port 8001 --reload
  OR from inside services/ml-service/:
    uvicorn main:app --port 8001 --reload

The service expects these files to exist in data/ (created by data/train_model.py):
    data/rf_model.joblib
    data/feature_encoder.joblib
    data/label_encoder.joblib
    data/feature_names.json
"""

# ── Imports ───────────────────────────────────────────────────────────────────
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import joblib
import numpy as np
import pandas as pd
import shap
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── Logging setup ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
)
logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────
# Categorical columns that go through OrdinalEncoder (same order as training)
CATEGORICAL_COLS = [
    "anomaly_type",
    "data_source",
    "pipeline_stage",
    "historical_frequency",
    "time_sensitivity",
    "data_domain",
]

# All 7 feature columns in the exact order the model expects
FEATURE_COLS = [
    "anomaly_type",
    "affected_records_pct",
    "data_source",
    "pipeline_stage",
    "historical_frequency",
    "time_sensitivity",
    "data_domain",
]

# ── Pydantic models (request / response shapes) ───────────────────────────────

class IncidentFeatures(BaseModel):
    """
    The 7 input features for a single incident.
    All names must exactly match the columns in incidents.csv.
    """
    anomaly_type: str = Field(..., example="schema_mismatch",
        description="Type of data quality anomaly")
    affected_records_pct: float = Field(..., ge=0, le=100, example=42.0,
        description="Percentage of records affected (0–100)")
    data_source: str = Field(..., example="iot_stream",
        description="Origin system of the data")
    pipeline_stage: str = Field(..., example="ingestion",
        description="Pipeline stage where the issue occurred")
    historical_frequency: str = Field(..., example="occasional",
        description="How often this anomaly type has appeared before")
    time_sensitivity: str = Field(..., example="high",
        description="Urgency / time pressure of the data")
    data_domain: str = Field(..., example="finance",
        description="Business domain the data belongs to")


class PredictionResponse(BaseModel):
    """What /predict returns for one incident."""
    predicted_class: str = Field(...,
        description="One of: auto_resolve | escalate | critical")
    confidence: float = Field(...,
        description="Probability assigned to the predicted class (0–1)")
    class_probabilities: Dict[str, float] = Field(...,
        description="Probability for every class")


class BatchPredictionResponse(BaseModel):
    """What /predict/batch returns."""
    predictions: List[PredictionResponse]


class ExplanationResponse(BaseModel):
    """SHAP explanation for one incident and one class."""
    incident_id: Optional[str] = Field(None,
        description="ID of the incident being explained")
    predicted_class: str = Field(...,
        description="Predicted class for this incident")
    explained_class: str = Field(...,
        description="The class whose SHAP values are shown ('escalate' by default)")
    base_value: float = Field(...,
        description="Expected model output averaged over the training set")
    shap_values: List[float] = Field(...,
        description="SHAP contribution of each feature (positive = pushes toward this class)")
    feature_names: List[str] = Field(...,
        description="Feature names matching shap_values order")
    feature_values: List[Any] = Field(...,
        description="Raw (pre-encoding) feature values for this incident")


class GlobalImportanceResponse(BaseModel):
    """Feature importances from the trained forest."""
    feature_names: List[str]
    importances: List[float] = Field(...,
        description="Mean decrease in impurity per feature")


class ModelInfoResponse(BaseModel):
    """Metadata about the trained model."""
    model_type: str
    n_estimators: int
    max_depth: Optional[int]          # None when trees grow fully
    feature_names: List[str]
    classes: List[str]


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool


# ── App setup ─────────────────────────────────────────────────────────────────

app = FastAPI(
    title="ML Service – HITL-CDT",
    description=(
        "Classifies data quality incidents and provides SHAP explanations. "
        "Visit /docs for the interactive Swagger UI."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Global state (loaded once at startup) ─────────────────────────────────────

model          = None   # RandomForestClassifier
label_encoder  = None   # maps int → "auto_resolve" / "critical" / "escalate"
feature_encoder = None  # OrdinalEncoder for the 6 categorical columns
feature_names  = None   # ordered list of all 7 feature names
explainer      = None   # shap.TreeExplainer


# ── Helper: encode a DataFrame of raw feature values ─────────────────────────

def _encode_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Apply the OrdinalEncoder to the categorical columns, leave the numeric
    column (affected_records_pct) as-is, and return a DataFrame with the
    same column names the model was trained on.

    Returning a named DataFrame (not a plain numpy array) avoids a sklearn
    UserWarning about missing feature names at inference time.

    IMPORTANT: The OrdinalEncoder was fitted on only the 6 categorical columns
    (not all 7).  So we must select those columns first, encode them, then
    put the numeric column back in the right position.
    """
    # 1. Encode only the categorical columns
    cat_encoded = feature_encoder.transform(df[CATEGORICAL_COLS])

    # 2. Build the full encoded array in FEATURE_COLS order
    result = np.zeros((len(df), len(FEATURE_COLS)), dtype=float)
    for i, col in enumerate(FEATURE_COLS):
        if col in CATEGORICAL_COLS:
            cat_idx = CATEGORICAL_COLS.index(col)
            result[:, i] = cat_encoded[:, cat_idx]
        else:
            # numeric column goes in as-is
            result[:, i] = df[col].values

    # Return a DataFrame so sklearn sees the column names it was trained on
    return pd.DataFrame(result, columns=FEATURE_COLS)


# ── Startup: load artefacts ────────────────────────────────────────────────────

@app.on_event("startup")
async def load_model():
    """
    Load every artefact produced by data/train_model.py.
    The service will refuse to start if any file is missing.
    """
    global model, label_encoder, feature_encoder, feature_names, explainer

    # Walk up from this file to the project root (hitl-cdt/)
    # services/ml-service/main.py → ../../ = project root
    project_root = Path(__file__).resolve().parent.parent.parent
    data_dir = project_root / "data"

    logger.info("=" * 60)
    logger.info("Loading ML artefacts from: %s", data_dir)

    required_files = [
        data_dir / "rf_model.joblib",
        data_dir / "label_encoder.joblib",
        data_dir / "feature_encoder.joblib",
        data_dir / "feature_names.json",
    ]

    for path in required_files:
        if not path.exists():
            raise RuntimeError(
                f"Required artefact not found: {path}\n"
                "Run  python3 data/train_model.py  first."
            )

    model           = joblib.load(data_dir / "rf_model.joblib")
    label_encoder   = joblib.load(data_dir / "label_encoder.joblib")
    feature_encoder = joblib.load(data_dir / "feature_encoder.joblib")
    with open(data_dir / "feature_names.json") as f:
        feature_names = json.load(f)

    # TreeExplainer is exact and fast for RandomForest.
    # We initialise it once here so every request reuses the same object.
    explainer = shap.TreeExplainer(model)

    logger.info("  Model        : %s (%d trees)", type(model).__name__, model.n_estimators)
    logger.info("  Classes      : %s", list(label_encoder.classes_))
    logger.info("  Features (%d): %s", len(feature_names), feature_names)
    logger.info("  SHAP explainer ready")
    logger.info("=" * 60)
    logger.info("ML Service is ready.  Swagger docs → http://localhost:8001/docs")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    """Returns 'healthy' when the model is loaded, 'unhealthy' otherwise."""
    return HealthResponse(
        status="healthy" if model is not None else "unhealthy",
        model_loaded=model is not None,
    )


@app.get("/model/info", response_model=ModelInfoResponse, tags=["Model"])
async def get_model_info():
    """Metadata about the trained RandomForest (number of trees, features, classes)."""
    if model is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Model not loaded")

    return ModelInfoResponse(
        model_type="RandomForestClassifier",
        n_estimators=model.n_estimators,
        max_depth=model.max_depth,        # None when trees grow to full depth
        feature_names=feature_names,
        classes=list(label_encoder.classes_),
    )


@app.post("/predict", response_model=PredictionResponse, tags=["Prediction"])
async def predict(incident: IncidentFeatures):
    """
    Classify a single incident.

    Returns the predicted action (auto_resolve / escalate / critical),
    the model's confidence, and the full probability breakdown.
    """
    if model is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Model not loaded")

    try:
        df = pd.DataFrame([incident.model_dump()])
        X  = _encode_features(df)

        pred_idx   = model.predict(X)[0]
        proba      = model.predict_proba(X)[0]
        pred_label = label_encoder.inverse_transform([pred_idx])[0]
        confidence = float(proba[pred_idx])

        class_probabilities = {
            label_encoder.inverse_transform([i])[0]: float(p)
            for i, p in enumerate(proba)
        }

        logger.info("predict → %s  (conf=%.3f)", pred_label, confidence)
        return PredictionResponse(
            predicted_class=pred_label,
            confidence=confidence,
            class_probabilities=class_probabilities,
        )

    except Exception as exc:
        logger.exception("predict failed")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Prediction failed: {exc}")


@app.post("/predict/batch", response_model=BatchPredictionResponse, tags=["Prediction"])
async def predict_batch(incidents: List[IncidentFeatures]):
    """
    Classify a list of incidents in one call.

    More efficient than calling /predict N times because the model
    scores all rows in a single numpy operation.
    """
    if model is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Model not loaded")

    try:
        df   = pd.DataFrame([inc.model_dump() for inc in incidents])
        X    = _encode_features(df)
        preds = model.predict(X)
        probas = model.predict_proba(X)

        results = []
        for pred_idx, proba in zip(preds, probas):
            pred_label = label_encoder.inverse_transform([pred_idx])[0]
            results.append(PredictionResponse(
                predicted_class=pred_label,
                confidence=float(proba[pred_idx]),
                class_probabilities={
                    label_encoder.inverse_transform([i])[0]: float(p)
                    for i, p in enumerate(proba)
                },
            ))

        logger.info("predict/batch → %d incidents processed", len(results))
        return BatchPredictionResponse(predictions=results)

    except Exception as exc:
        logger.exception("predict/batch failed")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Batch prediction failed: {exc}")


@app.post("/explain/features", response_model=ExplanationResponse, tags=["Explainability"])
async def explain_features(incident: IncidentFeatures, explain_class: str = "escalate"):
    """
    Compute a SHAP explanation given raw feature values directly.

    explain_class: which class to explain ('auto_resolve', 'escalate', or 'critical').
    Defaults to 'escalate' because that is the ambiguous class humans review.

    The SHAP values tell you:
      - positive value → this feature pushed the prediction TOWARD explain_class
      - negative value → this feature pushed the prediction AWAY FROM explain_class
    """
    if model is None or explainer is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Model not loaded")

    classes = list(label_encoder.classes_)
    if explain_class not in classes:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"explain_class must be one of {classes}",
        )

    try:
        raw_dict = incident.model_dump()
        df = pd.DataFrame([raw_dict])
        X  = _encode_features(df)          # shape (1, 7)

        # Predict so we can report what the model actually decided
        pred_idx   = model.predict(X)[0]
        pred_label = label_encoder.inverse_transform([pred_idx])[0]

        # Compute SHAP values using the new Explanation API.
        # explainer(X) returns Explanation with .values shape (n_samples, n_features, n_classes)
        shap_exp = explainer(X)
        class_idx = classes.index(explain_class)

        # Extract values for the chosen class (shape: n_features,)
        sv   = shap_exp.values[0, :, class_idx].tolist()
        base = float(shap_exp.base_values[0, class_idx])

        logger.info(
            "explain/features → predict=%s  explain_class=%s  base=%.4f",
            pred_label, explain_class, base,
        )

        return ExplanationResponse(
            incident_id=None,
            predicted_class=pred_label,
            explained_class=explain_class,
            base_value=base,
            shap_values=sv,
            feature_names=feature_names,
            feature_values=list(raw_dict.values()),
        )

    except Exception as exc:
        logger.exception("explain/features failed")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Explanation failed: {exc}")


@app.get("/explain/{incident_id}", response_model=ExplanationResponse, tags=["Explainability"])
async def explain_by_id(incident_id: str, explain_class: str = "escalate"):
    """
    Placeholder for database-backed explanations.

    In the full system the Decision Service stores incidents in PostgreSQL
    and this endpoint would look them up by incident_id.  For now it returns
    a canned example so the frontend has something to render while the
    database integration is built.

    TODO: replace the sample_data block below with a real DB query:
        incident = db.query(Incident).filter_by(incident_id=incident_id).first()
    """
    if model is None or explainer is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Model not loaded")

    # ── Placeholder data ──────────────────────────────────────────────────────
    sample_data = {
        "anomaly_type": "schema_mismatch",
        "affected_records_pct": 42.0,
        "data_source": "iot_stream",
        "pipeline_stage": "ingestion",
        "historical_frequency": "occasional",
        "time_sensitivity": "high",
        "data_domain": "finance",
    }
    # ─────────────────────────────────────────────────────────────────────────

    classes = list(label_encoder.classes_)
    if explain_class not in classes:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"explain_class must be one of {classes}",
        )

    try:
        df = pd.DataFrame([sample_data])
        X  = _encode_features(df)

        pred_idx   = model.predict(X)[0]
        pred_label = label_encoder.inverse_transform([pred_idx])[0]

        shap_exp  = explainer(X)
        class_idx = classes.index(explain_class)
        sv   = shap_exp.values[0, :, class_idx].tolist()
        base = float(shap_exp.base_values[0, class_idx])

        logger.info("explain/%s → predict=%s  explain_class=%s", incident_id, pred_label, explain_class)

        return ExplanationResponse(
            incident_id=incident_id,
            predicted_class=pred_label,
            explained_class=explain_class,
            base_value=base,
            shap_values=sv,
            feature_names=feature_names,
            feature_values=list(sample_data.values()),
        )

    except Exception as exc:
        logger.exception("explain/%s failed", incident_id)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Explanation failed: {exc}")


@app.get("/explain/global", response_model=GlobalImportanceResponse, tags=["Explainability"])
async def global_importance():
    """
    Return the mean decrease in impurity (MDI) feature importance from the forest.

    This is a fast alternative to SHAP for a high-level view of which
    features drive decisions across all incidents.
    """
    if model is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Model not loaded")

    importances = model.feature_importances_.tolist()
    return GlobalImportanceResponse(
        feature_names=feature_names,
        importances=importances,
    )


@app.get("/", tags=["Info"])
async def root():
    """Service index – lists all available endpoints."""
    return {
        "service": "ML Service – HITL-CDT",
        "version": "1.0.0",
        "tip": "Visit /docs for the interactive Swagger UI",
        "endpoints": {
            "GET  /health":            "Liveness check",
            "GET  /model/info":        "Model metadata",
            "POST /predict":           "Classify one incident",
            "POST /predict/batch":     "Classify many incidents",
            "POST /explain/features":  "SHAP explanation from raw features",
            "GET  /explain/{id}":      "SHAP explanation for a stored incident",
            "GET  /explain/global":    "Global feature importances",
            "GET  /docs":              "Swagger UI",
        },
    }

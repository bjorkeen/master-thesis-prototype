"""
train_model.py
==============
Trains a RandomForest classifier on the synthetic incident dataset,
evaluates it, generates SHAP explainability plots, and saves all
artefacts that the ML service (services/ml-service/main.py) will load
at runtime.

Run this script once (and again whenever you regenerate incidents.csv):
    python3 data/train_model.py

Outputs written to data/:
    rf_model.joblib       – trained RandomForestClassifier
    feature_encoder.joblib – OrdinalEncoder fitted on the 7 input features
    label_encoder.joblib  – LabelEncoder that maps string labels ↔ integers
    feature_names.json    – ordered list of feature column names
    shap_summary.png      – beeswarm plot: which features matter most globally
    shap_waterfall.png    – waterfall plot: why one specific incident got its prediction
"""

# ── 1. Imports ────────────────────────────────────────────────────────────────
import json
import warnings
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")          # headless backend – no display needed
import matplotlib.pyplot as plt

from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import OrdinalEncoder, LabelEncoder
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix, ConfusionMatrixDisplay

import joblib
import shap

warnings.filterwarnings("ignore")   # keep output clean

# ── 2. Load data ───────────────────────────────────────────────────────────────
print("=" * 60)
print("STEP 1 – Loading dataset")
print("=" * 60)

DATA_DIR = "data"   # relative path; run this script from the project root

df = pd.read_csv(f"{DATA_DIR}/incidents.csv")
print(f"  Rows loaded  : {len(df):,}")
print(f"  Columns      : {df.columns.tolist()}")

# ── 3. Define features and target ─────────────────────────────────────────────
# IMPORTANT: we drop 'severity_score_raw' and 'severity_score' because they
# are intermediate scoring columns computed from the label itself.
# Using them would be "data leakage" – the model would look at the answer
# sheet while being tested and would appear unrealistically accurate.
FEATURE_COLS = [
    "anomaly_type",          # categorical – type of data quality problem
    "affected_records_pct",  # numeric    – % of records affected
    "data_source",           # categorical – origin system
    "pipeline_stage",        # categorical – where in the pipeline it occurred
    "historical_frequency",  # categorical – how often this issue appeared before
    "time_sensitivity",      # categorical – urgency label from the source system
    "data_domain",           # categorical – business domain
]

TARGET_COL = "label"   # 'auto_resolve' | 'escalate' | 'critical'

X = df[FEATURE_COLS].copy()
y = df[TARGET_COL].copy()

print(f"\n  Feature columns  : {FEATURE_COLS}")
print(f"  Target column    : {TARGET_COL}")
print(f"\n  Class distribution:")
for cls, cnt in y.value_counts().items():
    print(f"    {cls:<15} {cnt:>5}  ({cnt/len(y)*100:.1f}%)")

# ── 4. Encode categorical features ───────────────────────────────────────────
# WHY OrdinalEncoder (not OneHotEncoder)?
#   RandomForest decides splits by finding the best numeric threshold.
#   It doesn't care about the actual integer values – it just needs numbers.
#   Encoding 'api_feed'→0, 'crm'→1, etc. is perfectly fine for RF.
#   OneHotEncoder would expand 6 categories into 6 binary columns, tripling
#   the feature count with no accuracy benefit for tree-based models.
#   OrdinalEncoder keeps the feature space small and interpretable.

print("\n" + "=" * 60)
print("STEP 2 – Encoding features")
print("=" * 60)

# Identify categorical columns (everything except the numeric 'affected_records_pct')
CATEGORICAL_COLS = [c for c in FEATURE_COLS if X[c].dtype == object]
print(f"  Categorical features being encoded: {CATEGORICAL_COLS}")
print(f"  Numeric features left as-is       : ['affected_records_pct']")

# OrdinalEncoder maps each category to a stable integer.
# handle_unknown='use_encoded_value', unknown_value=-1 means:
#   if a new category appears at inference time, encode it as -1
#   instead of crashing.
feature_encoder = OrdinalEncoder(
    handle_unknown="use_encoded_value",
    unknown_value=-1,
)
X[CATEGORICAL_COLS] = feature_encoder.fit_transform(X[CATEGORICAL_COLS])

print("  Done. Sample of encoded X:")
print(X.head(3).to_string())

# Encode the target label: 'auto_resolve'→0, 'critical'→1, 'escalate'→2
# (LabelEncoder assigns integers in alphabetical order by default)
label_encoder = LabelEncoder()
y_encoded = label_encoder.fit_transform(y)
print(f"\n  Label mapping: {dict(zip(label_encoder.classes_, label_encoder.transform(label_encoder.classes_)))}")

# ── 5. Train / test split ─────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("STEP 3 – Train/test split  (80 / 20, stratified)")
print("=" * 60)

# stratify=y ensures each split keeps the same 60/30/10 class ratio.
X_train, X_test, y_train, y_test = train_test_split(
    X, y_encoded,
    test_size=0.20,
    random_state=42,
    stratify=y_encoded,
)

print(f"  Train size : {len(X_train):,}  ({len(X_train)/len(X)*100:.0f}%)")
print(f"  Test size  : {len(X_test):,}  ({len(X_test)/len(X)*100:.0f}%)")

# ── 6. Train the RandomForestClassifier ───────────────────────────────────────
print("\n" + "=" * 60)
print("STEP 4 – Training RandomForestClassifier")
print("=" * 60)

# Hyperparameter rationale:
#   n_estimators=200   – 200 trees gives stable, averaged predictions
#   max_depth=None     – let each tree grow until leaves are pure; RF's
#                        bagging prevents overfitting even with deep trees
#   min_samples_split=5  – a node must have ≥5 samples to be split further;
#                          reduces noise from very small splits
#   min_samples_leaf=2   – each leaf must contain ≥2 training samples;
#                          smooths predictions slightly
#   max_features='sqrt'  – at each split, consider sqrt(n_features) random
#                          features; standard RF practice, reduces correlation
#                          between trees
#   class_weight='balanced' – IMPORTANT: our dataset is imbalanced (60/30/10).
#                             This makes RF weight minority classes higher so
#                             'critical' incidents aren't ignored.
#   random_state=42     – reproducibility
#   n_jobs=-1           – use all CPU cores for speed

model = RandomForestClassifier(
    n_estimators=200,
    max_depth=None,
    min_samples_split=5,
    min_samples_leaf=2,
    max_features="sqrt",
    class_weight="balanced",
    random_state=42,
    n_jobs=-1,
)

print("  Training…")
model.fit(X_train, y_train)
print("  Training complete.")

# ── 7. Evaluate ───────────────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("STEP 5 – Evaluation on held-out test set")
print("=" * 60)

y_pred = model.predict(X_test)

# Decode integer predictions back to human-readable class names
y_test_labels = label_encoder.inverse_transform(y_test)
y_pred_labels = label_encoder.inverse_transform(y_pred)

print("\n--- Classification Report ---")
print(classification_report(
    y_test_labels,
    y_pred_labels,
    target_names=label_encoder.classes_,
    digits=3,
))

# Confusion matrix: rows = actual, columns = predicted
print("--- Confusion Matrix (rows=actual, cols=predicted) ---")
cm = confusion_matrix(y_test_labels, y_pred_labels, labels=label_encoder.classes_)
cm_df = pd.DataFrame(cm, index=label_encoder.classes_, columns=label_encoder.classes_)
print(cm_df.to_string())

# Save a readable confusion matrix plot
fig, ax = plt.subplots(figsize=(6, 5))
disp = ConfusionMatrixDisplay(confusion_matrix=cm, display_labels=label_encoder.classes_)
disp.plot(ax=ax, colorbar=False, cmap="Blues")
ax.set_title("Confusion Matrix – Test Set")
plt.tight_layout()
plt.savefig(f"{DATA_DIR}/confusion_matrix.png", dpi=150)
plt.close()
print(f"\n  Confusion matrix plot saved → {DATA_DIR}/confusion_matrix.png")

# Feature importances from the forest
print("\n--- Feature Importances (mean decrease in impurity) ---")
importances = model.feature_importances_
for name, imp in sorted(zip(FEATURE_COLS, importances), key=lambda x: -x[1]):
    bar = "█" * int(imp * 80)
    print(f"  {name:<25} {imp:.4f}  {bar}")

# ── 8. SHAP explainability ────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("STEP 6 – SHAP explainability")
print("=" * 60)

# TreeExplainer is the fast, exact explainer for tree-based models.
# It computes Shapley values: for each feature, how much did it push
# the prediction above/below the average prediction?
print("  Building TreeExplainer…")
explainer = shap.TreeExplainer(model)

# Compute SHAP values on the test set using the modern Explanation API.
# In SHAP ≥ 0.40 the preferred call is explainer(X) which returns an
# Explanation object with shape (n_samples, n_features, n_classes).
print("  Computing SHAP values on test set (may take ~30s)…")
X_test_arr = X_test.values if hasattr(X_test, "values") else X_test

# Use the new Explanation API – shape is (n_samples, n_features, n_classes)
shap_explanation = explainer(X_test_arr)   # Explanation object

ESCALATE_IDX = list(label_encoder.classes_).index("escalate")

# ── 8a. Global summary plot (beeswarm) ──────────────────────────────────────
# Shows which features have the highest impact across ALL predictions.
# Each dot = one sample; colour = feature value; x-axis = SHAP impact.
# We use the 'escalate' class (index 2) because that's the most nuanced one.

# Extract the Explanation for the escalate class: shape (n_samples, n_features)
escalate_exp = shap.Explanation(
    values=shap_explanation.values[:, :, ESCALATE_IDX],
    base_values=shap_explanation.base_values[:, ESCALATE_IDX],
    data=shap_explanation.data,
    feature_names=FEATURE_COLS,
)

plt.figure(figsize=(10, 6))
shap.summary_plot(escalate_exp, show=False, plot_type="dot")
plt.title("SHAP Summary – 'escalate' class")
plt.tight_layout()
plt.savefig(f"{DATA_DIR}/shap_summary.png", dpi=150, bbox_inches="tight")
plt.close()
print(f"  SHAP summary plot saved → {DATA_DIR}/shap_summary.png")

# ── 8b. Waterfall plot for one example incident ──────────────────────────────
# A waterfall plot explains a SINGLE prediction:
# "The base rate was X, then feature A pushed it up by Y, feature B down by Z…"
# We pick the first test-set incident whose actual label is 'escalate'.

escalate_indices = np.where(y_test == ESCALATE_IDX)[0]
example_idx = escalate_indices[0]   # index within X_test

print(f"\n  Waterfall example: test-set row {example_idx}")
print(f"    Actual label    : {label_encoder.inverse_transform([y_test[example_idx]])[0]}")
print(f"    Predicted label : {label_encoder.inverse_transform([model.predict(X_test.iloc[[example_idx]])[0]])[0]}")
print(f"    Feature values  :")
for col, val in zip(FEATURE_COLS, X_test.iloc[example_idx]):
    print(f"      {col:<25} = {val}")

# Build a single-row Explanation for the waterfall plot
single_exp = shap.Explanation(
    values=shap_explanation.values[example_idx, :, ESCALATE_IDX],
    base_values=shap_explanation.base_values[example_idx, ESCALATE_IDX],
    data=shap_explanation.data[example_idx],
    feature_names=FEATURE_COLS,
)

plt.figure(figsize=(10, 5))
shap.waterfall_plot(single_exp, show=False)
plt.title(f"SHAP Waterfall – row {example_idx} (class: escalate)")
plt.tight_layout()
plt.savefig(f"{DATA_DIR}/shap_waterfall.png", dpi=150, bbox_inches="tight")
plt.close()
print(f"  SHAP waterfall plot saved → {DATA_DIR}/shap_waterfall.png")

# ── 9. Save artefacts ─────────────────────────────────────────────────────────
print("\n" + "=" * 60)
print("STEP 7 – Saving artefacts")
print("=" * 60)

# The trained model
joblib.dump(model, f"{DATA_DIR}/rf_model.joblib")
print(f"  rf_model.joblib        → saved ({model.n_estimators} trees, {len(FEATURE_COLS)} features)")

# The OrdinalEncoder used to transform categorical input features.
# The ML service must apply the SAME encoder to new incidents before
# calling model.predict(), otherwise the numbers won't match.
joblib.dump(feature_encoder, f"{DATA_DIR}/feature_encoder.joblib")
print(f"  feature_encoder.joblib → saved (OrdinalEncoder for {CATEGORICAL_COLS})")

# The LabelEncoder for the target variable.
# Used to decode integer predictions back to 'auto_resolve' / 'escalate' / 'critical'.
joblib.dump(label_encoder, f"{DATA_DIR}/label_encoder.joblib")
print(f"  label_encoder.joblib   → saved (classes: {list(label_encoder.classes_)})")

# The ordered feature name list.
# Stored as JSON so other services (Node.js gateway, etc.) can also read it
# without needing Python.
with open(f"{DATA_DIR}/feature_names.json", "w") as f:
    json.dump(FEATURE_COLS, f, indent=2)
print(f"  feature_names.json     → saved ({FEATURE_COLS})")

# ── 10. Quick sanity-check: run one prediction end-to-end ─────────────────────
print("\n" + "=" * 60)
print("STEP 8 – End-to-end sanity check")
print("=" * 60)

sample = pd.DataFrame([{
    "anomaly_type": "schema_mismatch",
    "affected_records_pct": 78.5,
    "data_source": "iot_stream",
    "pipeline_stage": "ingestion",
    "historical_frequency": "first_occurrence",
    "time_sensitivity": "critical",
    "data_domain": "finance",
}])

sample[CATEGORICAL_COLS] = feature_encoder.transform(sample[CATEGORICAL_COLS])
pred_int = model.predict(sample)[0]
pred_proba = model.predict_proba(sample)[0]
pred_label = label_encoder.inverse_transform([pred_int])[0]

print(f"  Input    : schema_mismatch, 78.5% affected, iot_stream, ingestion,")
print(f"             first_occurrence, critical, finance")
print(f"  Predicted: {pred_label}")
print(f"  Probabilities:")
for cls, prob in zip(label_encoder.classes_, pred_proba):
    bar = "█" * int(prob * 40)
    print(f"    {cls:<15} {prob:.3f}  {bar}")

print("\n" + "=" * 60)
print("All done! Files written to data/")
print("=" * 60)

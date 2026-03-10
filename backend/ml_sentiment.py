"""
ML Sentiment Model — train ensemble (XGBoost, Logistic Regression, Random Forest) on options features.

Data sources:
1. EOD snapshots from SENTIMENT_DIR/eod/ (preferred when available)
2. Dhan rolling option API (backfill when EOD is insufficient)

Labels: Next-session Nifty direction (+1 up, -1 down, 0 flat) based on 0.3% threshold.
"""

import asyncio
import json
import logging
import os
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sentiment_features import ML_FEATURE_NAMES, compute_sentiment, extract_ml_features

logger = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))
SENTIMENT_DIR = os.path.join(os.getenv("SNAPSHOT_DIR", "/data/snapshots"), "sentiment")
MODEL_PATH = os.path.join(SENTIMENT_DIR, "ensemble_model.pkl")
SCALER_PATH = os.path.join(SENTIMENT_DIR, "feature_scaler.pkl")
MIN_TRAINING_DAYS = 60
LABEL_THRESHOLD_PCT = 0.3

_sentiment_model = None
_feature_scaler = None


def _load_eod_snapshots(index_name: str = "NIFTY") -> List[Tuple[date, dict]]:
    """Load EOD snapshots from disk. Returns [(date, gex_data), ...] sorted by date."""
    eod_dir = os.path.join(SENTIMENT_DIR, "eod")
    if not os.path.isdir(eod_dir):
        return []
    out = []
    for fname in os.listdir(eod_dir):
        if not fname.startswith(index_name + "_") or not fname.endswith(".json"):
            continue
        try:
            d = fname.replace(index_name + "_", "").replace(".json", "")
            dt = datetime.strptime(d, "%Y-%m-%d").date()
        except ValueError:
            continue
        path = os.path.join(eod_dir, fname)
        try:
            with open(path) as f:
                data = json.load(f)
            if data.get("strikes"):
                out.append((dt, data))
        except Exception as e:
            logger.warning(f"Failed to load EOD {fname}: {e}")
    out.sort(key=lambda x: x[0])
    return out


def _build_training_data_from_eod(
    snapshots: List[Tuple[date, dict]], index_name: str = "NIFTY"
) -> Tuple[List[List[float]], List[int]]:
    """Build X (features) and y (labels) from EOD snapshots.

    Label: +1 if next_day_close > today_close * 1.003
          -1 if next_day_close < today_close * 0.997
           0 otherwise
    """
    X, y = [], []
    prev_sentiment = {}
    for i in range(len(snapshots) - 1):
        d, data = snapshots[i]
        next_d, next_data = snapshots[i + 1]
        spot = float(data.get("spot") or 0)
        next_spot = float(next_data.get("spot") or 0)
        if spot <= 0 or next_spot <= 0:
            continue
        try:
            sent = compute_sentiment(
                data,
                index_name=index_name,
                prev_skew=prev_sentiment.get("skew"),
                prev_atm_iv=prev_sentiment.get("atm_iv"),
            )
            prev_sentiment["skew"] = sent["features"].get("iv_skew")
            prev_sentiment["atm_iv"] = sent["features"].get("atm_iv")
        except Exception as e:
            logger.warning(f"Sentiment compute error for {d}: {e}")
            continue
        feat = extract_ml_features(sent)
        X.append(feat)
        ret_pct = (next_spot - spot) / spot * 100
        if ret_pct >= LABEL_THRESHOLD_PCT:
            y.append(1)
        elif ret_pct <= -LABEL_THRESHOLD_PCT:
            y.append(-1)
        else:
            y.append(0)
    return X, y


async def _fetch_rolling_option_daily(
    security_id: int,
    from_date,
    to_date,
    strike: str,
    drv_type: str,
) -> Optional[Dict[date, dict]]:
    """Fetch rolling option for one strike/type, return {date: {spot, oi, iv}}."""
    from dhan_historical import fetch_rolling_option

    fd = from_date.strftime("%Y-%m-%d") if hasattr(from_date, "strftime") else str(from_date)
    td = to_date.strftime("%Y-%m-%d") if hasattr(to_date, "strftime") else str(to_date)
    data = await fetch_rolling_option(
        security_id=security_id,
        strike=strike,
        drv_option_type=drv_type,
        from_date=fd,
        to_date=td,
    )
    if not data or "data" not in data:
        return None
    side = data["data"].get("ce" if drv_type == "CALL" else "pe")
    if not side:
        return None
    timestamps = side.get("timestamp") or []
    spot_arr = side.get("spot") or []
    oi_arr = side.get("oi") or []
    iv_arr = side.get("iv") or []
    if not timestamps:
        return None
    by_date = defaultdict(list)
    for j, ts in enumerate(timestamps):
        dt = datetime.fromtimestamp(ts, tz=IST).date()
        s = float(spot_arr[j]) if j < len(spot_arr) else 0
        o = float(oi_arr[j]) if j < len(oi_arr) else 0
        v = float(iv_arr[j]) if j < len(iv_arr) else 0
        by_date[dt].append((s, o, v))
    out = {}
    for d, vals in by_date.items():
        last = vals[-1]
        out[d] = {"spot": last[0], "oi": last[1], "iv": last[2]}
    return out


# Strikes to fetch for Dhan backfill (ATM±2 gives better PCR, IV skew proxy)
_DHAN_BACKFILL_STRIKES = [
    ("ATM", "CALL"), ("ATM", "PUT"),
    ("ATM+1", "CALL"), ("ATM+1", "PUT"),
    ("ATM-1", "CALL"), ("ATM-1", "PUT"),
    ("ATM+2", "CALL"), ("ATM+2", "PUT"),
    ("ATM-2", "CALL"), ("ATM-2", "PUT"),
]


async def _build_training_data_from_dhan(
    from_date: date,
    to_date: date,
    index_name: str = "NIFTY",
) -> Tuple[List[List[float]], List[int]]:
    """Build X, y from Dhan rolling option. Uses ATM±2 strikes for PCR, IV skew, OI pressure."""
    from dhan_historical import chunk_date_range

    uid = {"NIFTY": 13, "BANKNIFTY": 25, "FINNIFTY": 27, "MIDCPNIFTY": 442}.get(
        index_name, 13
    )
    chunks = chunk_date_range(from_date, to_date, 30)
    # by_date[d] = { "spot": float, "call_oi": sum, "put_oi": sum, "atm_iv": float, "skew": float }
    by_date = defaultdict(lambda: {"spot": 0, "call_oi": 0, "put_oi": 0, "atm_ce_iv": 0, "atm_pe_iv": 0, "otm_put_iv": 0, "otm_call_iv": 0})
    for fd, td in chunks:
        for strike, drv_type in _DHAN_BACKFILL_STRIKES:
            data = await _fetch_rolling_option_daily(uid, fd, td, strike, drv_type)
            if not data:
                continue
            for d, v in data.items():
                s = by_date[d]
                if v.get("spot", 0) > 0:
                    s["spot"] = v["spot"]
                oi = v.get("oi", 0) or 0
                iv = v.get("iv", 0) or 0
                if drv_type == "CALL":
                    s["call_oi"] += oi
                    if strike == "ATM":
                        s["atm_ce_iv"] = iv
                    elif strike == "ATM+2":
                        s["otm_call_iv"] = iv
                else:
                    s["put_oi"] += oi
                    if strike == "ATM":
                        s["atm_pe_iv"] = iv
                    elif strike == "ATM-2":
                        s["otm_put_iv"] = iv
            await asyncio.sleep(4)
    dates = sorted([d for d, s in by_date.items() if s["spot"] > 0 and (s["call_oi"] > 0 or s["put_oi"] > 0)])
    if len(dates) < MIN_TRAINING_DAYS:
        return [], []
    X, y = [], []
    prev_call_oi = prev_put_oi = 0.0
    for i in range(len(dates) - 1):
        d = dates[i]
        next_d = dates[i + 1]
        s = by_date[d]
        s_next = by_date.get(next_d, {})
        spot = s.get("spot", 0)
        next_spot = s_next.get("spot", 0)
        if spot <= 0 or next_spot <= 0:
            continue
        call_oi = s.get("call_oi", 1) or 1
        put_oi = s.get("put_oi", 1) or 1
        pcr = put_oi / call_oi
        oi_pressure = (put_oi - prev_put_oi) - (call_oi - prev_call_oi)
        prev_call_oi, prev_put_oi = call_oi, put_oi
        atm_iv = (s.get("atm_ce_iv", 0) + s.get("atm_pe_iv", 0)) / 2
        skew = (s.get("otm_put_iv", 0) or 0) - (s.get("otm_call_iv", 0) or 0)
        feat = [
            pcr,
            oi_pressure,
            0.0,
            0.0,
            skew,
            atm_iv,
            0.0,
            0.0,
            0.0,
        ]
        if len(feat) < len(ML_FEATURE_NAMES):
            feat.extend([0.0] * (len(ML_FEATURE_NAMES) - len(feat)))
        X.append(feat[: len(ML_FEATURE_NAMES)])
        ret_pct = (next_spot - spot) / spot * 100
        if ret_pct >= LABEL_THRESHOLD_PCT:
            y.append(1)
        elif ret_pct <= -LABEL_THRESHOLD_PCT:
            y.append(-1)
        else:
            y.append(0)
    return X, y


def _train_ensemble(X: List[List[float]], y: List[int]) -> Tuple[Any, Any]:
    """Train XGBoost, Logistic Regression, Random Forest; return ensemble + scaler.

    Maps y from [-1,0,1] to [0,1,2] for sklearn compatibility.
    """
    import numpy as np
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import train_test_split
    from sklearn.preprocessing import StandardScaler
    from xgboost import XGBClassifier

    X_arr = np.array(X, dtype=np.float64)
    y_arr = np.array(y, dtype=np.int32)
    np.nan_to_num(X_arr, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    y_sklearn = y_arr + 1
    X_train, X_val, y_train, y_val = train_test_split(
        X_arr, y_sklearn, test_size=0.2, shuffle=False
    )
    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_val_s = scaler.transform(X_val)

    models = [
        ("xgb", XGBClassifier(n_estimators=100, max_depth=5, random_state=42)),
        ("lr", LogisticRegression(max_iter=500, random_state=42)),
        ("rf", RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)),
    ]
    weights = []
    preds = []
    for name, m in models:
        m.fit(X_train_s, y_train)
        acc = (m.predict(X_val_s) == y_val).mean()
        weights.append(acc)
        preds.append(m.predict_proba(X_val_s))
    total_w = sum(weights)
    weights = [w / total_w for w in weights]
    ensemble_proba = np.zeros_like(preds[0])
    for w, p in zip(weights, preds):
        ensemble_proba += w * p
    pred_class = np.argmax(ensemble_proba, axis=1)
    ensemble_acc = (pred_class == y_val).mean()
    logger.info(
        f"ML ensemble trained: val_acc={ensemble_acc:.3f}, weights={weights}, n_samples={len(X)}"
    )
    return (models, weights, scaler), scaler


def _save_model(ensemble: Tuple, scaler: Any) -> None:
    """Persist model and scaler to disk."""
    import pickle

    os.makedirs(SENTIMENT_DIR, exist_ok=True)
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(ensemble, f)
    with open(SCALER_PATH, "wb") as f:
        pickle.dump(scaler, f)
    logger.info(f"ML model saved to {MODEL_PATH}")


def load_model() -> bool:
    """Load model and scaler from disk. Returns True if loaded."""
    global _sentiment_model, _feature_scaler
    try:
        import pickle

        if os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH):
            with open(MODEL_PATH, "rb") as f:
                _sentiment_model = pickle.load(f)
            with open(SCALER_PATH, "rb") as f:
                _feature_scaler = pickle.load(f)
            logger.info("ML sentiment model loaded")
            return True
    except Exception as e:
        logger.warning(f"ML model load failed: {e}")
    return False


def predict(feature_vector: List[float]) -> Tuple[int, float]:
    """Predict direction (-1, 0, +1) and confidence (0-1). Returns (0, 0) if model not loaded."""
    global _sentiment_model, _feature_scaler
    if _sentiment_model is None or _feature_scaler is None:
        return 0, 0.0
    try:
        import numpy as np

        models, weights, _ = _sentiment_model
        X = np.array([feature_vector], dtype=np.float64)
        np.nan_to_num(X, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
        X_s = _feature_scaler.transform(X)
        proba = np.zeros(3)
        for w, m in zip(weights, [m for _, m in models]):
            p = m.predict_proba(X_s)[0]
            if p.shape[0] == 3:
                proba += w * p
            else:
                proba[0] += w * (p[0] if len(p) > 0 else 0)
                proba[1] += w * (p[1] if len(p) > 1 else 0)
                proba[2] += w * (p[2] if len(p) > 2 else 0)
        idx = int(np.argmax(proba))
        direction = idx - 1
        confidence = float(proba[idx])
        return direction, confidence
    except Exception as e:
        logger.warning(f"ML predict error: {e}")
        return 0, 0.0


async def train_and_save(index_name: str = "NIFTY") -> bool:
    """Build training data, train ensemble, save. Returns True on success."""
    snapshots = _load_eod_snapshots(index_name)
    X, y = [], []
    if len(snapshots) >= MIN_TRAINING_DAYS:
        X, y = _build_training_data_from_eod(snapshots, index_name)
        logger.info(f"EOD training data: {len(X)} samples from {len(snapshots)} snapshots")
    if len(X) < MIN_TRAINING_DAYS:
        to_date = date.today()
        from_date = to_date - timedelta(days=600)
        X, y = await _build_training_data_from_dhan(from_date, to_date, index_name)
        logger.info(f"Dhan rolling option training data: {len(X)} samples")
    if len(X) < MIN_TRAINING_DAYS:
        logger.warning(f"Insufficient data: {len(X)} < {MIN_TRAINING_DAYS}")
        return False
    ensemble, scaler = _train_ensemble(X, y)
    _save_model(ensemble, scaler)
    global _sentiment_model, _feature_scaler
    _sentiment_model = ensemble
    _feature_scaler = scaler
    return True

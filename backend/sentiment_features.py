"""
Sentiment Feature Engine — compute PCR, GEX, Max Pain, IV Skew, etc. from option chain data.

Input: gex_cache-style structure (spot, expiry, strikes with OI, IV, gamma, theta, previous_oi)
Output: features dict + overall score (-8 to +8) + signal label
"""

from datetime import date, datetime
from typing import Any, Dict, List, Optional

# LOT_SIZES from main — passed in or use default
DEFAULT_LOT_SIZES = {"NIFTY": 25, "BANKNIFTY": 15, "FINNIFTY": 40, "MIDCPNIFTY": 75}


def _f(v: Any, default: float = 0.0) -> float:
    try:
        x = float(v)
        return x if x == x else default  # NaN check
    except (TypeError, ValueError):
        return default


def compute_max_pain(strikes: List[dict], spot: float) -> tuple:
    """Compute max pain strike and distance from spot.

    total_pain(K) = sum over strikes > K of (strike - K) * call_OI
                  + sum over strikes < K of (K - strike) * put_OI
    """
    if not strikes:
        return 0.0, 0.0
    strike_prices = sorted(set(s.get("strike", 0) for s in strikes))
    min_pain = float("inf")
    max_pain_strike = strike_prices[0] if strike_prices else 0.0
    for k in strike_prices:
        pain = 0.0
        for s in strikes:
            st = _f(s.get("strike"))
            co = _f(s.get("call_oi"))
            po = _f(s.get("put_oi"))
            if st > k:
                pain += (st - k) * co
            elif st < k:
                pain += (k - st) * po
        if pain < min_pain:
            min_pain = pain
            max_pain_strike = k
    dist_pct = ((spot - max_pain_strike) / spot * 100) if spot > 0 else 0.0
    return max_pain_strike, dist_pct


def compute_pcr(strikes: List[dict]) -> tuple:
    """PCR by OI and by volume (if volume available)."""
    total_call_oi = sum(_f(s.get("call_oi")) for s in strikes)
    total_put_oi = sum(_f(s.get("put_oi")) for s in strikes)
    total_call_vol = sum(_f(s.get("call_volume", 0)) for s in strikes)
    total_put_vol = sum(_f(s.get("put_volume", 0)) for s in strikes)
    pcr_oi = total_put_oi / total_call_oi if total_call_oi > 0 else 1.0
    pcr_vol = total_put_vol / total_call_vol if total_call_vol > 0 else 1.0
    return pcr_oi, pcr_vol


def compute_oi_pressure(strikes: List[dict]) -> float:
    """Net OI change: put_oi_change - call_oi_change. Positive = put writers active = bullish."""
    total_call_chg = sum(_f(s.get("call_oi_change", 0)) for s in strikes)
    total_put_chg = sum(_f(s.get("put_oi_change", 0)) for s in strikes)
    return total_put_chg - total_call_chg


def compute_iv_skew(strikes: List[dict], spot: float) -> float:
    """OTM put IV - OTM call IV (~25 delta). Use strikes ~2% away from spot as proxy."""
    if not strikes or spot <= 0:
        return 0.0
    sorted_s = sorted(strikes, key=lambda x: _f(x.get("strike")))
    otm_put_iv = 0.0
    otm_call_iv = 0.0
    lower = spot * 0.98
    upper = spot * 1.02
    for s in sorted_s:
        st = _f(s.get("strike"))
        if st <= lower:
            otm_put_iv = _f(s.get("put_iv"))
        if st >= upper and otm_call_iv == 0:
            otm_call_iv = _f(s.get("call_iv"))
    if otm_put_iv == 0 or otm_call_iv == 0:
        # Fallback: use ATM ±1 strike
        for s in sorted_s:
            st = _f(s.get("strike"))
            if abs(st - spot) < 100:
                if otm_put_iv == 0:
                    otm_put_iv = _f(s.get("put_iv"))
                if otm_call_iv == 0:
                    otm_call_iv = _f(s.get("call_iv"))
    return otm_put_iv - otm_call_iv


def compute_strike_walls(strikes: List[dict], spot: float) -> dict:
    """Call wall (max OI above spot), Put wall (max OI below spot)."""
    call_wall = 0.0
    call_wall_oi = 0.0
    put_wall = 0.0
    put_wall_oi = 0.0
    for s in strikes:
        st = _f(s.get("strike"))
        co = _f(s.get("call_oi"))
        po = _f(s.get("put_oi"))
        if st > spot and co > call_wall_oi:
            call_wall_oi = co
            call_wall = st
        if st < spot and po > put_wall_oi:
            put_wall_oi = po
            put_wall = st
    above_spot = [x for x in strikes if _f(x.get("strike")) > spot]
    below_spot = [x for x in strikes if _f(x.get("strike")) < spot]
    avg_call_oi = sum(_f(x.get("call_oi")) for x in above_spot) / len(above_spot) if above_spot else 1.0
    avg_put_oi = sum(_f(x.get("put_oi")) for x in below_spot) / len(below_spot) if below_spot else 1.0
    call_strength = call_wall_oi / avg_call_oi if avg_call_oi > 0 else 0
    put_strength = put_wall_oi / avg_put_oi if avg_put_oi > 0 else 0
    return {
        "call_wall": call_wall,
        "put_wall": put_wall,
        "call_wall_oi": call_wall_oi,
        "put_wall_oi": put_wall_oi,
        "call_wall_strength": call_strength,
        "put_wall_strength": put_strength,
        "dist_to_resistance": ((call_wall - spot) / spot * 100) if spot > 0 and call_wall > 0 else 0,
        "dist_to_support": ((spot - put_wall) / spot * 100) if spot > 0 and put_wall > 0 else 0,
    }


def compute_charm_flow(strikes: List[dict], lot_size: int) -> float:
    """Charm flow proxy: sum(theta * OI * lot_size). Positive = upward drift expected."""
    total = 0.0
    for s in strikes:
        theta = _f(s.get("call_theta", 0)) * _f(s.get("call_oi")) + _f(s.get("put_theta", 0)) * _f(s.get("put_oi"))
        total += theta * lot_size
    return total


def compute_sentiment(
    gex_data: dict,
    index_name: str = "NIFTY",
    expiry: str = "",
    days_to_expiry: Optional[int] = None,
    prev_skew: Optional[float] = None,
    prev_atm_iv: Optional[float] = None,
) -> dict:
    """Compute full sentiment from gex_cache-style data.

    gex_data: {spot, expiry, strikes: [{strike, call_oi, put_oi, call_iv, put_iv, call_gex, put_gex, net_gex,
                call_theta?, put_theta?, previous_oi?, call_oi_change?, put_oi_change?}], flip_point, ...}
    """
    spot = _f(gex_data.get("spot"))
    strikes = gex_data.get("strikes") or []
    flip_point = gex_data.get("flip_point")
    lot_size = DEFAULT_LOT_SIZES.get(index_name, 25)

    # Enrich strikes with OI change if we have previous_oi
    for s in strikes:
        if "call_oi_change" not in s and "previous_call_oi" in s:
            s["call_oi_change"] = _f(s.get("call_oi")) - _f(s.get("previous_call_oi"))
        if "put_oi_change" not in s and "previous_put_oi" in s:
            s["put_oi_change"] = _f(s.get("put_oi")) - _f(s.get("previous_put_oi"))

    pcr_oi, pcr_vol = compute_pcr(strikes)
    max_pain_strike, max_pain_dist = compute_max_pain(strikes, spot)
    oi_pressure = compute_oi_pressure(strikes)
    skew = compute_iv_skew(strikes, spot)
    walls = compute_strike_walls(strikes, spot)
    charm = compute_charm_flow(strikes, lot_size)

    total_gex = sum(_f(s.get("net_gex")) for s in strikes)
    atm_iv = 0.0
    for s in strikes:
        if abs(_f(s.get("strike")) - spot) < 50:
            atm_iv = (_f(s.get("call_iv")) + _f(s.get("put_iv"))) / 2
            break

    skew_change = skew - prev_skew if prev_skew is not None else 0.0
    atm_iv_change = atm_iv - prev_atm_iv if prev_atm_iv is not None else 0.0

    # Scorecard: each feature -> +1 bullish, -1 bearish, 0 neutral
    score = 0

    # PCR_OI
    if pcr_oi > 1.1:
        score += 1
    elif pcr_oi < 0.8:
        score -= 1

    # OI Pressure
    if oi_pressure > 0:
        score += 1
    elif oi_pressure < 0:
        score -= 1

    # Max Pain distance (spot < max pain = upward pull = bullish)
    if max_pain_dist < 0:
        score += 1
    elif max_pain_dist > 0:
        score -= 1

    # GEX regime (positive = dealers long gamma = stabilizing = bullish for range)
    if total_gex > 0:
        score += 1
    elif total_gex < 0:
        score -= 1

    # IV Skew change (falling = fear unwinding = bullish)
    if skew_change < -0.1:
        score += 1
    elif skew_change > 0.1:
        score -= 1

    # ATM IV / vol proxy (low + falling = bullish)
    if atm_iv < 15 and atm_iv_change < 0:
        score += 1
    elif atm_iv > 20 and atm_iv_change > 0:
        score -= 1

    # Strike wall (strong put wall = bullish)
    if walls.get("put_wall_strength", 0) > 1.2:
        score += 1
    elif walls.get("call_wall_strength", 0) > 1.2:
        score -= 1

    # Charm flow
    if charm > 0:
        score += 1
    elif charm < 0:
        score -= 1

    # Clamp score
    score = max(-8, min(8, score))

    # Signal label
    if score >= 6:
        signal = "STRONG_BULLISH"
    elif score >= 3:
        signal = "BULLISH"
    elif score >= 1:
        signal = "MILD_BULLISH"
    elif score == 0:
        signal = "NEUTRAL"
    elif score >= -2:
        signal = "MILD_BEARISH"
    elif score >= -5:
        signal = "BEARISH"
    else:
        signal = "STRONG_BEARISH"

    return {
        "spot": round(spot, 2),
        "expiry": expiry or gex_data.get("expiry", ""),
        "days_to_expiry": days_to_expiry,
        "overall_signal": signal,
        "score": score,
        "features": {
            "pcr_oi": round(pcr_oi, 4),
            "pcr_volume": round(pcr_vol, 4),
            "oi_pressure": round(oi_pressure, 0),
            "max_pain_strike": max_pain_strike,
            "max_pain_distance_pct": round(max_pain_dist, 2),
            "total_gex": round(total_gex, 2),
            "iv_skew": round(skew, 4),
            "skew_change": round(skew_change, 4),
            "atm_iv": round(atm_iv, 2),
            "atm_iv_change": round(atm_iv_change, 2),
            "charm_flow": round(charm, 2),
        },
        "strike_map": {
            "call_wall": walls.get("call_wall"),
            "put_wall": walls.get("put_wall"),
            "gamma_flip": flip_point,
            "max_pain": max_pain_strike,
            "call_wall_strength": round(walls.get("call_wall_strength", 0), 2),
            "put_wall_strength": round(walls.get("put_wall_strength", 0), 2),
        },
    }


# Feature names for ML model (fixed order)
ML_FEATURE_NAMES = [
    "pcr_oi",
    "oi_pressure",
    "max_pain_distance_pct",
    "total_gex",
    "iv_skew",
    "atm_iv",
    "charm_flow",
    "put_wall_strength",
    "call_wall_strength",
]


def extract_ml_features(sentiment_result: dict) -> List[float]:
    """Extract feature vector for ML from sentiment compute_sentiment output."""
    f = sentiment_result.get("features", {})
    sm = sentiment_result.get("strike_map", {})
    out = []
    for name in ML_FEATURE_NAMES:
        if name in f:
            out.append(float(f[name]) if f[name] is not None else 0.0)
        elif name in sm:
            out.append(float(sm[name]) if sm[name] is not None else 0.0)
        else:
            out.append(0.0)
    return out

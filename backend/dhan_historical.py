"""
Dhan Historical API — fetch OHLCV and expired options data for ML training.

Endpoints:
- POST /charts/historical — daily OHLCV (Nifty futures/index)
- POST /charts/rollingoption — expired options OI, IV, volume, spot (30 days/call)
"""

import asyncio
import os
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

import httpx

DHAN_API_BASE = os.getenv("DHAN_API_BASE", "https://api.dhan.co/v2")
DHAN_TOKEN_OPTIONS = os.getenv("DHAN_TOKEN_OPTIONS", "")
DHAN_CLIENT_ID = os.getenv("DHAN_CLIENT_ID", "")

# Nifty futures security ID for historical (check Dhan instruments for exact ID)
# 13 = NIFTY underlying for options; for FUTIDX we may need a different ID
NIFTY_FUTIDX_SECURITY_ID = "13"  # Placeholder; verify from Dhan instruments
UNDERLYING_IDS = {
    "NIFTY": "13", "BANKNIFTY": "25", "FINNIFTY": "27", "MIDCPNIFTY": "442",
    "SENSEX": "51", "BANKEX": "69",
}


async def fetch_historical_ohlcv(
    security_id: str,
    exchange_segment: str = "NSE_FNO",
    instrument: str = "FUTIDX",
    from_date: str = "",
    to_date: str = "",
    include_oi: bool = True,
) -> Optional[Dict[str, Any]]:
    """Fetch daily OHLCV from Dhan /charts/historical.

    Args:
        security_id: Dhan security ID (e.g. Nifty FUTIDX)
        exchange_segment: NSE_FNO, NSE_EQ, etc.
        instrument: FUTIDX, EQUITY, etc.
        from_date: YYYY-MM-DD
        to_date: YYYY-MM-DD (non-inclusive)
        include_oi: Include open interest for F&O

    Returns:
        {"open": [...], "high": [...], "low": [...], "close": [...], "volume": [...], "timestamp": [...]}
        or None on error
    """
    if not DHAN_TOKEN_OPTIONS or not DHAN_CLIENT_ID:
        return None
    if not from_date or not to_date:
        return None

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{DHAN_API_BASE}/charts/historical",
                headers={
                    "access-token": DHAN_TOKEN_OPTIONS,
                    "client-id": DHAN_CLIENT_ID,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "securityId": security_id,
                    "exchangeSegment": exchange_segment,
                    "instrument": instrument,
                    "expiryCode": 0,
                    "oi": include_oi,
                    "fromDate": from_date,
                    "toDate": to_date,
                },
            )
            if not resp.is_success:
                return None
            data = resp.json()
            if "open" not in data or "close" not in data:
                return None
            return data
    except Exception:
        return None


async def fetch_rolling_option(
    security_id: int,
    strike: str = "ATM",
    drv_option_type: str = "CALL",
    from_date: str = "",
    to_date: str = "",
    expiry_flag: str = "WEEK",
    expiry_code: int = 1,
    interval: str = "1",
) -> Optional[Dict[str, Any]]:
    """Fetch expired options data from Dhan /charts/rollingoption.

    Args:
        security_id: Underlying ID (13 for NIFTY)
        strike: ATM, ATM+1, ATM-1, ... ATM±10 for index
        drv_option_type: CALL or PUT
        from_date: YYYY-MM-DD
        to_date: YYYY-MM-DD (max 30 days from from_date)
        expiry_flag: WEEK or MONTH
        expiry_code: 1 for nearest, etc.
        interval: 1, 5, 15, 25, 60 (minutes)

    Returns:
        {"data": {"ce": {...} or "pe": {...}}} with iv, oi, spot, open, high, low, close, volume, timestamp
    """
    if not DHAN_TOKEN_OPTIONS or not DHAN_CLIENT_ID:
        return None
    if not from_date or not to_date:
        return None

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{DHAN_API_BASE}/charts/rollingoption",
                headers={
                    "access-token": DHAN_TOKEN_OPTIONS,
                    "client-id": DHAN_CLIENT_ID,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "exchangeSegment": "NSE_FNO",
                    "interval": interval,
                    "securityId": security_id,
                    "instrument": "OPTIDX",
                    "expiryFlag": expiry_flag,
                    "expiryCode": expiry_code,
                    "strike": strike,
                    "drvOptionType": drv_option_type,
                    "requiredData": ["open", "high", "low", "close", "iv", "volume", "oi", "spot"],
                    "fromDate": from_date,
                    "toDate": to_date,
                },
            )
            if not resp.is_success:
                return None
            return resp.json()
    except Exception:
        return None


async def fetch_intraday_ohlcv(
    security_id: str,
    exchange_segment: str = "NSE_FNO",
    instrument: str = "FUTIDX",
    interval: str = "1",
    from_date: str = "",
    to_date: str = "",
    include_oi: bool = False,
) -> Optional[Dict[str, Any]]:
    """Fetch intraday OHLCV from Dhan /charts/intraday.

    Args:
        security_id: Dhan security ID (e.g. 13 for NIFTY index, 51714 for NIFTY MAR FUT)
        exchange_segment: NSE_FNO, IDX_I, etc.
        instrument: FUTIDX, INDEX, etc.
        interval: 1, 5, 15, 25, 60 (minutes)
        from_date: YYYY-MM-DD HH:MM:SS (e.g. "2024-09-11 09:15:00")
        to_date: YYYY-MM-DD HH:MM:SS (e.g. "2024-09-11 15:30:00")
        include_oi: Include open interest for F&O

    Returns:
        {"open": [...], "high": [...], "low": [...], "close": [...], "volume": [...], "timestamp": [...]}
        or None on error
    """
    if not DHAN_TOKEN_OPTIONS or not DHAN_CLIENT_ID:
        return None
    if not from_date or not to_date:
        return None

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{DHAN_API_BASE}/charts/intraday",
                headers={
                    "access-token": DHAN_TOKEN_OPTIONS,
                    "client-id": DHAN_CLIENT_ID,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "securityId": security_id,
                    "exchangeSegment": exchange_segment,
                    "instrument": instrument,
                    "interval": interval,
                    "oi": include_oi,
                    "fromDate": from_date,
                    "toDate": to_date,
                },
            )
            if not resp.is_success:
                return None
            data = resp.json()
            if "open" not in data or "close" not in data:
                return None
            return data
    except Exception:
        return None


BSE_INDICES = frozenset(("SENSEX", "BANKEX"))


async def fetch_index_ltp(index_name: str) -> Optional[float]:
    """Fetch live index LTP from Dhan marketfeed/ltp.
    NSE + BSE indices: Dhan uses IDX_I for both. Rate limit: 1 req/sec."""
    if not DHAN_TOKEN_OPTIONS or not DHAN_CLIENT_ID:
        return None
    security_id = UNDERLYING_IDS.get(index_name)
    if not security_id:
        return None
    segments = ["IDX_I"]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            for seg_key in segments:
                resp = await client.post(
                    f"{DHAN_API_BASE}/marketfeed/ltp",
                    headers={
                        "access-token": DHAN_TOKEN_OPTIONS,
                        "client-id": DHAN_CLIENT_ID,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    json={seg_key: [int(security_id)]},
                )
                if not resp.is_success:
                    continue
                data = resp.json()
                seg = data.get("data", {}).get(seg_key, {})
                item = seg.get(security_id, seg.get(str(security_id), {}))
                lp = item.get("last_price")
                if lp is not None:
                    return float(lp)
    except Exception:
        pass
    return None


def chunk_date_range(from_date: date, to_date: date, chunk_days: int = 30) -> List[tuple]:
    """Split date range into chunks of chunk_days for rolling option API (30 days max per call)."""
    chunks = []
    current = from_date
    while current < to_date:
        end = min(current + timedelta(days=chunk_days), to_date)
        chunks.append((current.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")))
        current = end
    return chunks

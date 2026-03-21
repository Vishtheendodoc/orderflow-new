"""
OrderFlow Engine - FastAPI Backend
Connects to Dhan WebSocket, classifies ticks, streams orderflow data.
Designed for 24/7 deployment: memory-bounded, daily reset at IST midnight.
"""

from dotenv import load_dotenv
load_dotenv()

import asyncio
import gc
import json
import math
import os
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta, date
from typing import Dict, List, Optional, Set, Tuple
import logging
try:
    import orjson as _json_lib
    def _dumps(obj: object) -> str:
        return _json_lib.dumps(obj).decode()
    def _loads(s: str) -> object:
        return _json_lib.loads(s)
except ImportError:
    import json as _json_lib
    _dumps = _json_lib.dumps
    _loads = _json_lib.loads

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import httpx
import websockets
import struct

from sentiment_features import compute_sentiment, extract_ml_features
from ml_sentiment import load_model as load_ml_model, predict as ml_predict
from dhan_historical import fetch_intraday_ohlcv, fetch_index_ltp

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="OrderFlow Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────
# Config — Dhan v2 API
# Docs: https://dhanhq.co/docs/v2/live-market-feed
# ─────────────────────────────────────────────
# Hardcoded fallbacks — override with .env for security
DHAN_CLIENT_ID = os.getenv("DHAN_CLIENT_ID", "1100244268")
DHAN_ACCESS_TOKEN = os.getenv("DHAN_ACCESS_TOKEN", "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzcyMjU1OTM1LCJpYXQiOjE3NzIxNjk1MzUsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTAwMjQ0MjY4In0.1bkhB7AsdQXILcSIwDirONJltfWDRpj_Q_0u18vI-DlL_V7hFqZ8KXBAttOe_sAIAntMegGdnxgc_Z4-_yzKJA")
DHAN_WS_URL = "wss://api-feed.dhan.co"  # ?version=2&token=...&clientId=...&authType=2
DHAN_API_BASE = "https://api.dhan.co/v2"

# Mutable settings (candle duration can be changed via API)
CANDLE_SECONDS = int(os.getenv("CANDLE_SECONDS", "60"))
IMBALANCE_RATIO = float(os.getenv("IMBALANCE_RATIO", "3.0"))
CANDLE_OPTIONS = [60, 300, 600, 900, 1800, 2700, 3600, 7200]  # seconds: 1,5,10,15,30,45,60,120 min

# Memory bounds — MCX trades 9AM-11:55PM IST (~895 min); NSE 9:15AM-3:30PM (~375 min)
MAX_CANDLES_PER_SYMBOL = int(os.getenv("MAX_CANDLES_PER_SYMBOL", "900"))  # MCX trades ~895 min/day; must cover full session
# Indices + index futures: keep all days on disk; higher limit for multi-day history (~30 session days)
MAX_CANDLES_INDEX_FUT = int(os.getenv("MAX_CANDLES_INDEX_FUT", "12000"))
# Candles kept in RAM per engine; closed candles are also written to disk immediately.
# Full history is loaded from disk on client request — so RAM usage stays flat.
MAX_CANDLES_IN_MEMORY = int(os.getenv("MAX_CANDLES_IN_MEMORY", "100"))  # keep enough in RAM to cover disk-unavailability window at startup
# Send only recent candles in live broadcasts; full history served via request_history WS msg
BROADCAST_CANDLES_LIMIT = int(os.getenv("BROADCAST_CANDLES_LIMIT", "5"))
# Persistent snapshot directory — mount a Render Disk at this path so data survives restarts
SNAPSHOT_DIR = os.getenv("SNAPSHOT_DIR", "/data/snapshots")
MAX_LEVELS_PER_CANDLE = int(os.getenv("MAX_LEVELS_PER_CANDLE", "150"))
MAX_ENGINES = int(os.getenv("MAX_ENGINES", "1000"))  # soft cap; all CSV instruments get engines
GC_INTERVAL_TICKS = int(os.getenv("GC_INTERVAL_TICKS", "10000"))  # Run gc every N ticks
# Minimum interval between broadcasts per symbol (seconds).
# Without this, every tick triggers a full JSON serialize + WS send, saturating the event loop
# and causing 5-10s lag queues. 0.1 = 10 updates/sec max; plenty for a footprint chart.
BATCH_INTERVAL = float(os.getenv("BATCH_INTERVAL", "0.02"))  # 20ms = 50 batches/sec for faster chart updates

# ── Liquidity Heatmap (200-level order book) ─────────────────────────────────
# Separate Dhan token — avoids rate-limiting the main feed token.
DHAN_TOKEN_DEPTH    = os.getenv("DHAN_TOKEN_DEPTH", "")
HEATMAP_SNAPSHOTS   = int(os.getenv("HEATMAP_SNAPSHOTS", "300"))   # max snapshots to return via API
# In-RAM cache size — keep small to reduce Render memory; full history lives on disk
HEATMAP_SNAPSHOTS_IN_RAM = int(os.getenv("HEATMAP_SNAPSHOTS_IN_RAM", "50"))
# Disk: append to JSONL; when file exceeds this many lines, truncate to keep last N
MAX_DEPTH_FILE_LINES = int(os.getenv("MAX_DEPTH_FILE_LINES", "500"))
DEPTH_DIR = os.path.join(SNAPSHOT_DIR, "depth")
HFT_DIR   = os.path.join(SNAPSHOT_DIR, "hft")
SENTIMENT_DIR = os.path.join(SNAPSHOT_DIR, "sentiment")

# ── Options GEX ──────────────────────────────────────────────────────────────
DHAN_TOKEN_OPTIONS  = os.getenv("DHAN_TOKEN_OPTIONS", "")
OPTIONS_POLL_SEC    = float(os.getenv("OPTIONS_POLL_SEC", "60"))          # poll every 60s → 1-min HFT candles
OPTIONS_POLL_GAP    = float(os.getenv("OPTIONS_POLL_GAP", "8"))          # seconds between each index (Dhan: 1 req/3s; 8s safer when market active)
# HFT flow formula thresholds (calibrate via /api/strike_calibration)
HFT_OI_CHG_PCT      = float(os.getenv("HFT_OI_CHG_PCT", "5"))             # significant OI change %
HFT_LTP_STABLE_PCT  = float(os.getenv("HFT_LTP_STABLE_PCT", "2"))        # LTP "stable" for Dark Pool
HFT_LTP_MOVE_PCT    = float(os.getenv("HFT_LTP_MOVE_PCT", "2"))          # meaningful LTP move
HFT_OI_CHG_MIN      = float(os.getenv("HFT_OI_CHG_MIN", "3"))             # min OI chg for short/write
HFT_CE_VOL_MIN      = int(os.getenv("HFT_CE_VOL_MIN", "100000"))          # min CE volume; NIFTY ~1L, FINNIFTY ~1K
HFT_PE_VOL_MIN      = int(os.getenv("HFT_PE_VOL_MIN", "100000"))          # min PE volume; index-specific
HFT_MFI_OVERBOUGHT  = float(os.getenv("HFT_MFI_OVERBOUGHT", "75"))        # MFI overbought (tuned 2026-03)
HFT_MFI_OVERSOLD    = float(os.getenv("HFT_MFI_OVERSOLD", "25"))         # MFI oversold (tuned 2026-03)
# Per-index HFT defaults (from calibration). Env overrides: HFT_OI_CHG_PCT_NIFTY, etc.
# BSE SENSEX/BANKEX use default params (not yet calibrated).
_HFT_DEFAULTS = {
    "NIFTY":      {"oi_chg_pct": 3.0, "ltp_stable": 1.6, "ce_vol": 100_000, "pe_vol": 100_000},
    "BANKNIFTY":  {"oi_chg_pct": 3.0, "ltp_stable": 1.0, "ce_vol": 62_742,  "pe_vol": 114_525},
    "FINNIFTY":   {"oi_chg_pct": 3.0, "ltp_stable": 1.0, "ce_vol": 1_000,   "pe_vol": 5_000},
    "MIDCPNIFTY": {"oi_chg_pct": 3.0, "ltp_stable": 1.0, "ce_vol": 10_800,  "pe_vol": 14_040},
    "SENSEX":     {"oi_chg_pct": 3.0, "ltp_stable": 1.0, "ce_vol": 50_000,  "pe_vol": 50_000},
    "BANKEX":     {"oi_chg_pct": 3.0, "ltp_stable": 1.0, "ce_vol": 50_000,  "pe_vol": 50_000},
}
# Underlying security IDs — NSE (IDX_I) + BSE (BSE_FNO)
UNDERLYING_IDS = {
    "NIFTY": "13", "BANKNIFTY": "25", "FINNIFTY": "27", "MIDCPNIFTY": "442",
    "SENSEX": "51", "BANKEX": "69",
}
# Underlying segment per Dhan API — NSE index options IDX_I, BSE index options BSE_FNO
UNDERLYING_SEG_MAP = {
    "SENSEX": "BSE_FNO", "BANKEX": "BSE_FNO",
}
# F&O lot sizes — NSE + BSE (update when SEBI/BSE revises)
LOT_SIZES = {
    "NIFTY": 25, "BANKNIFTY": 15, "FINNIFTY": 40, "MIDCPNIFTY": 75,
    "SENSEX": 10, "BANKEX": 15,
}

# ─────────────────────────────────────────────
# Data Structures
# ─────────────────────────────────────────────

@dataclass
class FootprintLevel:
    price: float
    buy_vol: float = 0.0
    sell_vol: float = 0.0

    @property
    def delta(self):
        return self.buy_vol - self.sell_vol

    @property
    def total_vol(self):
        return self.buy_vol + self.sell_vol

    @property
    def imbalance(self):
        if self.sell_vol > 0 and self.buy_vol / self.sell_vol >= IMBALANCE_RATIO:
            return "buy"
        if self.buy_vol > 0 and self.sell_vol / self.buy_vol >= IMBALANCE_RATIO:
            return "sell"
        return None


@dataclass
class FootprintCandle:
    open_time: int       # unix ms
    open: float = 0.0
    high: float = 0.0
    low: float = 999999.0
    close: float = 0.0
    buy_vol: float = 0.0
    sell_vol: float = 0.0
    levels: Dict[float, FootprintLevel] = field(default_factory=dict)
    closed: bool = False
    # GoCharting-style delta bars: delta min/max during candle
    delta_open: float = 0.0   # always 0 at candle start
    delta_min: float = 0.0    # min delta during candle (highest possible = 0)
    delta_max: float = 0.0    # max delta during candle (lowest possible = 0)
    # VR Trender: initiative (buy-initiated vs sell-initiated bar)
    initiative: Optional[str] = None  # "buy" | "sell" | None (neutral)
    # Open Interest
    oi: float = 0.0           # OI at close of candle (last tick's OI)
    oi_change: float = 0.0    # OI this candle − OI previous candle

    @property
    def delta(self):
        return self.buy_vol - self.sell_vol

    @property
    def cvd(self):
        return 0.0  # filled externally

    def to_dict(self):
        return {
            "open_time": self.open_time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "buy_vol": self.buy_vol,
            "sell_vol": self.sell_vol,
            "delta": self.delta,
            "delta_open": self.delta_open,
            "delta_min": self.delta_min,
            "delta_max": self.delta_max,
            "initiative": self.initiative,
            "levels": {
                str(p): {
                    "price": lv.price,
                    "buy_vol": lv.buy_vol,
                    "sell_vol": lv.sell_vol,
                    "delta": lv.delta,
                    "total_vol": lv.total_vol,
                    "imbalance": lv.imbalance,
                }
                for p, lv in sorted(self.levels.items(), reverse=True)
            },
            "closed": self.closed,
            "oi": self.oi,
            "oi_change": self.oi_change,
        }

    def to_dict_lite(self) -> dict:
        """Compact candle without price-level data.
        Used in live batch broadcasts — levels are 150× larger than candle summary
        and only needed for the footprint view (loaded separately via request_history)."""
        return {
            "open_time":  self.open_time,
            "open":       self.open,
            "high":       self.high,
            "low":        self.low,
            "close":      self.close,
            "buy_vol":    self.buy_vol,
            "sell_vol":   self.sell_vol,
            "delta":      self.delta,
            "initiative": self.initiative,
            "closed":     self.closed,
            "oi":         self.oi,
            "oi_change":  self.oi_change,
        }


# ─────────────────────────────────────────────
# OrderFlow Engine per symbol
# ─────────────────────────────────────────────

class OrderFlowEngine:
    def __init__(self, symbol: str, security_id: str):
        self.symbol = symbol
        self.security_id = security_id
        self.candles: List[FootprintCandle] = []
        # All closed candles for the current trading day — lite (no levels).
        # Never truncated, so early-session candles survive even if disk was unavailable.
        # Memory cost: ~200 bytes/candle × 900 candles × 450 symbols ≈ 81 MB — very manageable.
        self.day_candles: List[dict] = []
        self.current_candle: Optional[FootprintCandle] = None
        self.last_ltp: float = 0.0
        self.last_bid: float = 0.0
        self.last_ask: float = 0.0
        self.cvd: float = 0.0
        self.tick_count: int = 0
        self.prev_volume: float = 0.0  # For volume-delta logic (GoCharting-style)
        self.prev_total_buy: float = 0.0  # Cumulative buy from exchange
        self.prev_total_sell: float = 0.0  # Cumulative sell from exchange
        self.last_oi: float = 0.0          # OI at close of most recent completed candle

    def _candle_start(self, ts_ms: int) -> int:
        """Floor timestamp to candle boundary."""
        cs = CANDLE_SECONDS * 1000
        return int((ts_ms // cs) * cs)

    def process_tick(self, ltp: float, bid: float, ask: float, vol: float, ts_ms: int,
                     cumulative_volume: Optional[float] = None,
                     total_buy_qty: Optional[float] = None,
                     total_sell_qty: Optional[float] = None,
                     oi: Optional[float] = None):
        """
        Classify tick and update footprint.
        Uses TRADED volume only: volume-delta (cumulative_volume - prev) or LTQ.
        NOTE: Dhan's totalBuyQty/totalSellQty are ORDER BOOK (pending) quantities, NOT traded.
        We use tick rule on traded volume for correct BI/SI matching standard platforms.
        """
        buy_vol_add, sell_vol_add = 0.0, 0.0

        # Use TRADED volume only (volume-delta or LTQ). Ignore totalBuyQty/totalSellQty (order book).
        if cumulative_volume is not None and self.prev_volume > 0:
            delta_volume = cumulative_volume - self.prev_volume
            self.prev_volume = cumulative_volume
            # When price flat + no new trade: Dhan may send same cumulative_volume. Use 0, not LTQ.
            # LTQ fallback only when cumulative resets (delta<0) - avoid double-counting last trade.
            if delta_volume <= 0:
                delta_volume = 0.0
        else:
            delta_volume = vol
            if cumulative_volume is not None:
                self.prev_volume = cumulative_volume

        prev = self.last_ltp
        if delta_volume > 0 and prev is not None and prev > 0:
            if ltp > prev:
                buy_vol_add, sell_vol_add = delta_volume, 0.0
            elif ltp < prev:
                buy_vol_add, sell_vol_add = 0.0, delta_volume
            else:
                if bid and ask and bid != ask:
                    if ltp >= ask:
                        buy_vol_add, sell_vol_add = delta_volume, 0.0
                    elif ltp <= bid:
                        buy_vol_add, sell_vol_add = 0.0, delta_volume
                    else:
                        buy_vol_add = sell_vol_add = delta_volume / 2
                else:
                    buy_vol_add = sell_vol_add = delta_volume / 2
        else:
            if ltp > self.last_ltp:
                buy_vol_add, sell_vol_add = delta_volume, 0.0
            elif ltp < self.last_ltp:
                buy_vol_add, sell_vol_add = 0.0, delta_volume
            else:
                mid = (bid + ask) / 2 if bid and ask else ltp
                if ltp >= mid:
                    buy_vol_add, sell_vol_add = delta_volume, 0.0
                else:
                    buy_vol_add, sell_vol_add = 0.0, delta_volume

        candle_ts = self._candle_start(ts_ms)

        # Roll candle
        if self.current_candle is None or self.current_candle.open_time != candle_ts:
            if self.current_candle:
                # VR Trender: set initiative (buy/sell initiated) based on delta at close
                prev = self.current_candle
                if prev.delta > 0:
                    prev.initiative = "buy"
                elif prev.delta < 0:
                    prev.initiative = "sell"
                else:
                    prev.initiative = None
                prev.closed = True
                prev_dict = prev.to_dict()
                _append_candle_to_disk(self.symbol, prev_dict)  # persist immediately
                # Keep lite copy in day_candles (never evicted, covers full day in RAM)
                if not self.day_candles or self.day_candles[-1]["open_time"] != prev.open_time:
                    self.day_candles.append(prev.to_dict_lite())
                self.candles.append(prev)
                if len(self.candles) > MAX_CANDLES_IN_MEMORY:
                    self.candles = self.candles[-MAX_CANDLES_IN_MEMORY:]
                self.last_oi = prev.oi  # carry forward OI baseline for next candle
            self.current_candle = FootprintCandle(
                open_time=candle_ts,
                open=ltp,
                high=ltp,
                low=ltp,
                close=ltp,
                delta_open=0.0,
                delta_min=0.0,
                delta_max=0.0,
            )

        c = self.current_candle
        c.high = max(c.high, ltp)
        c.low = min(c.low, ltp)
        c.close = ltp

        # Update level (cap levels per candle to prevent memory bloat)
        rounded_price = round(ltp * 20) / 20  # 0.05 tick grid
        if rounded_price not in c.levels:
            if len(c.levels) >= MAX_LEVELS_PER_CANDLE:
                # Evict lowest price level to keep bounded
                min_p = min(c.levels.keys())
                del c.levels[min_p]
            c.levels[rounded_price] = FootprintLevel(price=rounded_price)
        lv = c.levels[rounded_price]

        lv.buy_vol += buy_vol_add
        lv.sell_vol += sell_vol_add
        c.buy_vol += buy_vol_add
        c.sell_vol += sell_vol_add
        self.cvd += buy_vol_add - sell_vol_add

        # GoCharting-style: track delta min/max during candle
        d = c.delta
        c.delta_min = min(c.delta_min, d)
        c.delta_max = max(c.delta_max, d)

        # Update OI on current candle
        if oi is not None and oi > 0:
            c.oi = oi
            c.oi_change = oi - self.last_oi

        self.last_ltp = ltp
        self.last_bid = bid
        self.last_ask = ask
        self.tick_count += 1

    def update_oi(self, oi: float):
        """Update OI on the current candle from a separate OI packet or REST poll."""
        if oi is None or oi <= 0:
            return
        c = self.current_candle
        if c:
            c.oi = oi
            c.oi_change = oi - self.last_oi

    def get_state(self, limit: Optional[int] = None) -> dict:
        """Return in-memory state (last MAX_CANDLES_IN_MEMORY closed + current).
        For full day history use load_history_from_disk + build_full_state."""
        all_candles = list(self.candles) if self.candles else []
        if limit is not None and len(all_candles) > limit:
            all_candles = all_candles[-limit:]
        candle_dicts = [c.to_dict() for c in all_candles]

        cvd_map = _session_cvd_map_from_engine(self)
        for cd in candle_dicts:
            cd["cvd"] = cvd_map.get(cd["open_time"], float(cd.get("delta", 0)))

        if self.current_candle:
            live = self.current_candle.to_dict()
            live["cvd"] = cvd_map.get(live["open_time"], float(live.get("delta", 0)))
            candle_dicts.append(live)

        ticker_cvd = float(candle_dicts[-1]["cvd"]) if candle_dicts else float(self.cvd)

        return {
            "symbol": self.symbol,
            "ltp": self.last_ltp,
            "bid": self.last_bid,
            "ask": self.last_ask,
            "cvd": ticker_cvd,
            "tick_count": self.tick_count,
            "candles": candle_dicts,
        }

    def get_state_live(self) -> dict:
        """Compact state for live tick broadcasts: last 5 closed + current candle only.
        Keeps WS payload tiny. Clients with full history merge these in."""
        return self.get_state(limit=BROADCAST_CANDLES_LIMIT)

    def get_state_lite(self) -> dict:
        """Ultra-compact state for batch broadcasts: last 1 closed + current candle,
        NO price-level data. Levels are 150× larger than candle summary and are only
        needed for the footprint chart — loaded on demand via request_history.

        With 450 symbols this keeps each batch message ≈200KB instead of 30MB+.
        """
        all_candles = list(self.candles)[-1:] if self.candles else []  # last closed only
        candle_dicts = [c.to_dict_lite() for c in all_candles]

        cvd_map = _session_cvd_map_from_engine(self)
        for cd in candle_dicts:
            cd["cvd"] = cvd_map.get(cd["open_time"], float(cd.get("delta", 0)))

        if self.current_candle:
            live = self.current_candle.to_dict_lite()
            live["cvd"] = cvd_map.get(live["open_time"], float(live.get("delta", 0)))
            candle_dicts.append(live)

        ticker_cvd = float(candle_dicts[-1]["cvd"]) if candle_dicts else float(self.cvd)

        return {
            "symbol":     self.symbol,
            "ltp":        self.last_ltp,
            "bid":        self.last_bid,
            "ask":        self.last_ask,
            "cvd":        ticker_cvd,
            "tick_count": self.tick_count,
            "candles":    candle_dicts,
        }


def _session_cvd_map_from_engine(engine: OrderFlowEngine) -> dict:
    """Per-bar session cumulative delta (IST day boundaries). Used for lite/partial get_state."""
    by_t: dict[int, dict] = {}
    for cd in engine.day_candles:
        by_t[cd["open_time"]] = cd
    for c in engine.candles:
        by_t[c.open_time] = c.to_dict()
    if engine.current_candle:
        cc = engine.current_candle
        by_t[cc.open_time] = cc.to_dict()
    ordered = sorted(by_t.values(), key=lambda x: x["open_time"])
    running = 0.0
    prev_d: Optional[str] = None
    out: dict[int, float] = {}
    for cd in ordered:
        dkey = _ist_date_str_from_ms(int(cd["open_time"]))
        if dkey != prev_d:
            running = 0.0
        prev_d = dkey
        running += float(cd.get("delta", cd.get("buy_vol", 0) - cd.get("sell_vol", 0)))
        out[int(cd["open_time"])] = running
    return out


# ─────────────────────────────────────────────
# Global state
# ─────────────────────────────────────────────

engines: Dict[str, OrderFlowEngine] = {}
connected_clients: Set[WebSocket] = set()
# symbol -> { "security_id": str, "exchange_segment": str }
subscribed_symbols: Dict[str, dict] = {}
_tick_counter: int = 0  # For periodic gc
_last_reset_date: Optional[str] = None  # IST date "YYYY-MM-DD" of last daily reset
# Dirty set: symbols updated since last batch broadcast
_dirty_symbols: Set[str] = set()
# Token expiry / reconnect state
_dhan_reconnect_delay: int = 5          # seconds; doubles on auth failure, resets on success
_dhan_token_event: asyncio.Event = asyncio.Event()  # set when token is updated via API

# ── Heatmap: rolling order-book snapshots ────────────────────────────────────
# symbol → deque of {ts, ltp, bids:[{p,q}], asks:[{p,q}]}
depth_snapshots: Dict[str, deque] = {}

# ── GEX cache ─────────────────────────────────────────────────────────────────
# index_name → {computed_at, spot, expiry, strikes:[...], flip_point, ...}
# gex_cache keyed by "{INDEX_NAME}:{YYYY-MM-DD}" so multiple expiries are cached independently
gex_cache: Dict[str, dict] = {}
# sentiment_cache keyed by index name; sentiment_history for time-series of scores
sentiment_cache: Dict[str, dict] = {}
sentiment_history: Dict[str, list] = defaultdict(list)
sentiment_prev: Dict[str, dict] = {}  # prev skew, prev atm_iv for change computation
_sentiment_eod_saved: Set[str] = set()  # "{index_name}:{YYYY-MM-DD}" already saved
SENTIMENT_MAX_HISTORY = 200
# expiry_list_cache keyed by index_name -> list of expiry date strings
expiry_list_cache: Dict[str, list] = {}

# ── Index live feed (IDX_I) for HFT chart ──────────────────────────────────────
# Index symbols (NSE + BSE) subscribed to Dhan WebSocket for tick-by-tick.
# Per https://dhanhq.co/docs/v2/live-market-feed/
INDEX_LIVE_SYMBOLS = [
    ("NIFTY", "13"),
    ("BANKNIFTY", "25"),
    ("FINNIFTY", "27"),
    ("MIDCPNIFTY", "442"),
    ("SENSEX", "51"),   # BSE
    ("BANKEX", "69"),   # BSE
]

# ── HFT Scanner ───────────────────────────────────────────────────────────────
# Accumulated per-minute option chain snapshots → time-series for the triple-pane chart.
# index_name → list[{t, ts, spot, mfi, flows}]
hft_scanner_history: Dict[str, list] = defaultdict(list)
# Previous snapshot per index, keyed by "{strike}_CE|PE" → {oi, ltp, iv}
hft_prev_data: Dict[str, dict] = {}
HFT_MAX_SNAPSHOTS = int(os.getenv("HFT_MAX_SNAPSHOTS", "900"))  # cover full MCX day (~895 min)


# ─────────────────────────────────────────────
# Daily reset (IST midnight) for 24/7 deployment
# ─────────────────────────────────────────────

IST = timezone(timedelta(hours=5, minutes=30))


def _ist_date_str() -> str:
    """Current date in IST as YYYY-MM-DD."""
    return datetime.now(IST).strftime("%Y-%m-%d")


def _do_daily_reset():
    """Reset all engines for new trading day. Clears candles, CVD, preserves subscriptions.
    On cold start (restart/redeploy): only clear RAM; do NOT delete disk — load_all_snapshots
    will restore from disk. On midnight crossing: wipe yesterday's disk files too.
    """
    global _last_reset_date
    today = _ist_date_str()
    if _last_reset_date == today:
        return
    is_midnight_crossing = _last_reset_date is not None  # Had a previous run, now new day
    _last_reset_date = today

    for eng in engines.values():
        eng.candles.clear()
        eng.day_candles.clear()
        eng.current_candle = None
        eng.cvd = 0.0
        eng.prev_volume = 0.0
        eng.prev_total_buy = 0.0
        eng.prev_total_sell = 0.0
    depth_snapshots.clear()
    _depth_append_count.clear()
    hft_scanner_history.clear()
    hft_prev_data.clear()
    _sentiment_eod_saved.clear()

    # Only wipe disk when crossing midnight — NOT on cold start (restart/redeploy)
    # On cold start we keep disk so load_all_snapshots can restore
    # Preserve index + index-future footprint data (NSE: NIFTY, BANKNIFTY; BSE: SENSEX, BANKEX, SENSEX50)
    INDEX_SYMBOLS = ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "SENSEX50")

    def _is_index_file(fname: str) -> bool:
        upper = fname.upper()
        return any(idx in upper for idx in INDEX_SYMBOLS)

    if is_midnight_crossing:
        if os.path.isdir(DEPTH_DIR):
            for fname in os.listdir(DEPTH_DIR):
                if fname.endswith(".depth.jsonl") and not _is_index_file(fname):
                    try:
                        os.remove(os.path.join(DEPTH_DIR, fname))
                    except Exception:
                        pass
        if os.path.isdir(HFT_DIR):
            for fname in os.listdir(HFT_DIR):
                if fname.endswith(".hft.jsonl") and not _is_index_file(fname):
                    try:
                        os.remove(os.path.join(HFT_DIR, fname))
                    except Exception:
                        pass
        if os.path.isdir(SNAPSHOT_DIR):
            for fname in os.listdir(SNAPSHOT_DIR):
                if (fname.endswith(".json") or fname.endswith(".jsonl")) and not _is_index_file(fname):
                    try:
                        os.remove(os.path.join(SNAPSHOT_DIR, fname))
                    except Exception:
                        pass
        logger.info(f"Daily reset at IST midnight. Date: {today}. Engines + disk cleared (index data preserved).")
    else:
        logger.info(f"Cold start. Date: {today}. Engines cleared; disk preserved for restore.")
    gc.collect()


async def _daily_reset_task():
    """Background task: check every 5 min if we crossed IST midnight, then reset."""
    while True:
        await asyncio.sleep(300)  # 5 min
        _do_daily_reset()


async def _post_mcx_cleanup_task():
    """After MCX closes at 11:55 PM IST, run gc more aggressively to prevent RAM buildup.
    Memory often spikes when market closes due to final tick burst and connection churn."""
    while True:
        await asyncio.sleep(60)  # check every minute
        now = datetime.now(IST)
        hour, minute = now.hour, now.minute
        # MCX closes 11:55 PM; we're in post-close window until midnight
        if (hour == 23 and minute >= 55) or (hour == 0 and minute < 5):
            gc.collect()
            logger.debug("Post-MCX gc.collect() run")


# ─────────────────────────────────────────────
# Disk persistence — survives Render spin-down/restart
# Mount a Render Disk at /data so these files outlive container restarts.
# ─────────────────────────────────────────────

def _ist_midnight_ms() -> int:
    """Unix ms for the start of today in IST (used to discard yesterday's snapshots)."""
    now = datetime.now(IST)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp() * 1000)


def _ist_midnight_ms_days_ago(days: int) -> int:
    """Start of calendar day in IST, `days` days before today (0 = today midnight)."""
    now = datetime.now(IST)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    midnight -= timedelta(days=days)
    return int(midnight.timestamp() * 1000)


def _ist_previous_session_midnight_ms() -> int:
    """IST midnight marking the start of the *previous equity session day* (Mon–Fri).
    Walks back from calendar yesterday, skipping Sat/Sun, so Monday lines up with Friday
    instead of Sunday. Does not know NSE holidays — rare bad range on long weekends.
    """
    now = datetime.now(IST).date()
    d = now - timedelta(days=1)
    while d.weekday() >= 5:  # 5=Sat, 6=Sun
        d -= timedelta(days=1)
    midnight = datetime(d.year, d.month, d.day, 0, 0, 0, 0, IST)
    return int(midnight.timestamp() * 1000)


def _hist_start_for_symbol(symbol: str) -> int:
    """History start (ms) for build_full_state and load_all_snapshots.
    Indices (spot NIFTY, BANKNIFTY, etc.) + index futures: 0 = keep all days. Others: today only."""
    if _is_index_or_index_fut(symbol):
        return 0
    return _ist_midnight_ms()


def _is_index_or_index_fut(symbol: str) -> bool:
    """Spot indices and index futures (NSE + BSE) — retain all days on disk."""
    u = (symbol or "").upper()
    return any(k in u for k in ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "SENSEX50"))


def _ist_date_str_from_ms(ms: int) -> str:
    """IST calendar date YYYY-MM-DD for candle open_time (ms), aligned with chart."""
    return datetime.fromtimestamp(ms / 1000.0, tz=IST).strftime("%Y-%m-%d")


# Retry queue for candle writes that failed due to disk being unavailable.
# Flushed by _disk_retry_task every 30s when disk becomes available.
_failed_disk_writes: list[tuple[str, dict]] = []


def _append_candle_to_disk(symbol: str, candle_dict: dict) -> None:
    """Append one closed candle as a JSON line to the symbol's JSONL file.
    Called on every candle close — data survives restarts even without periodic snapshots.
    On ENOENT (disk not yet mounted), queues the write for retry."""
    if not SNAPSHOT_DIR:
        return
    try:
        os.makedirs(SNAPSHOT_DIR, exist_ok=True)
        path = os.path.join(SNAPSHOT_DIR, f"{symbol}.jsonl")
        with open(path, "a") as fh:
            fh.write(_dumps(candle_dict) + "\n")
    except OSError as e:
        if e.errno == 2:  # ENOENT — disk not yet mounted; queue for retry
            _failed_disk_writes.append((symbol, candle_dict))
        else:
            logger.warning(f"Disk append failed [{symbol}]: {e}")
    except Exception as e:
        logger.warning(f"Disk append failed [{symbol}]: {e}")


def load_history_from_disk(symbol: str, limit: int = 9999) -> list:
    """Read closed candles for a symbol from disk.
    Reads ALL lines (no pre-truncation by line count) to avoid cutting off early-day candles
    when multi-day data accumulates in the JSONL (e.g. from Render restarts without midnight reset).
    Deduplicates by open_time. Callers should filter by today_start before using."""
    if not os.path.isdir(SNAPSHOT_DIR):
        return []
    jsonl_path = os.path.join(SNAPSHOT_DIR, f"{symbol}.jsonl")
    if os.path.exists(jsonl_path):
        by_time: dict[int, dict] = {}
        try:
            with open(jsonl_path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        c = _loads(line)
                        ot = c.get("open_time")
                        if ot is not None:
                            by_time[ot] = c
                    except Exception:
                        pass
        except Exception as e:
            logger.warning(f"JSONL read failed [{symbol}]: {e}")
            return []
        result = sorted(by_time.values(), key=lambda x: x.get("open_time", 0))
        # Apply limit AFTER deduplication so today's early candles are never skipped
        return result[-limit:] if limit < len(result) else result
    # Fallback: legacy JSON array snapshot
    json_path = os.path.join(SNAPSHOT_DIR, f"{symbol}.json")
    if os.path.exists(json_path):
        try:
            with open(json_path) as fh:
                data = json.load(fh)
            if not isinstance(data, list):
                return []
            by_time: dict[int, dict] = {}
            for c in data:
                ot = c.get("open_time")
                if ot is not None:
                    by_time[ot] = c
            result = sorted(by_time.values(), key=lambda x: x.get("open_time", 0))
            return result[-limit:] if limit < len(result) else result
        except Exception as e:
            logger.warning(f"JSON snapshot read failed [{symbol}]: {e}")
    return []


DHAN_INTRADAY_FALLBACK_MIN = int(os.getenv("DHAN_INTRADAY_FALLBACK_MIN", "60"))


async def build_full_state(symbol: str, engine) -> dict:
    """Assemble the full-day state for a symbol.

    Priority (later sources override earlier for the same open_time):
      1. engine.day_candles  — lite, ALL closed candles for today; guaranteed no gaps even if
                               disk was unavailable at startup.
      2. disk JSONL          — full candle with levels; overrides lite where available.
      3. engine.candles      — last MAX_CANDLES_IN_MEMORY with levels; overrides disk for recency.
      4. engine.current_candle — live (open) candle appended last.
      5. Dhan intraday      — when candles < DHAN_INTRADAY_FALLBACK_MIN, fetch from Dhan and merge.

    Deduplicates by open_time so history+live merge never produces double candles.
    """
    hist_start = _hist_start_for_symbol(symbol)
    by_time: dict[int, dict] = {}

    # 1. Seed with all today's lite candles (guaranteed complete, no early-session gaps)
    for c in engine.day_candles:
        ot = c.get("open_time", 0)
        if ot >= hist_start:
            by_time[ot] = c

    # 2. Override with disk candles (include levels for footprint chart)
    disk_limit = MAX_CANDLES_INDEX_FUT if _is_index_or_index_fut(symbol) else MAX_CANDLES_PER_SYMBOL
    for c in load_history_from_disk(symbol, limit=disk_limit):
        if c.get("open_time", 0) >= hist_start and c.get("closed", True):
            by_time[c["open_time"]] = c  # disk version has levels — prefer over lite

    # 3. Override with most-recent in-RAM candles (full levels, most accurate)
    for c in engine.candles:
        ct = c.to_dict()
        ot = ct.get("open_time", 0)
        if ot >= hist_start:
            by_time[ot] = ct

    # 4. Dhan intraday fallback when we have insufficient candles (e.g. after refresh, market open)
    # Skip for index (IDX_I) — index uses live feed + disk only, no Dhan history API
    if len(by_time) < DHAN_INTRADAY_FALLBACK_MIN:
        info = subscribed_symbols.get(symbol, {})
        exchange_segment = info.get("exchange_segment", "NSE_FNO")
        if exchange_segment in ("IDX_I", "BSE_IDX"):
            pass  # index: live feed + disk only
        else:
            security_id = info.get("security_id") or getattr(engine, "security_id", None)
            if security_id:
                today = _ist_date_str()
                from_date = f"{today} 09:15:00"
                to_date = f"{today} 15:30:00"
                sym_upper = symbol.upper()
                if "MCX" in exchange_segment or exchange_segment == "MCX_COMM":
                    instrument = "FUTCOM"
                    from_date = f"{today} 09:00:00"
                    to_date = f"{today} 23:55:00"
                else:
                    instrument = "FUTIDX" if any(k in sym_upper for k in ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX")) else "FUTSTK"
                data = await fetch_intraday_ohlcv(
                    security_id=str(security_id),
                    exchange_segment=exchange_segment,
                    instrument=instrument,
                    interval="1",
                    from_date=from_date,
                    to_date=to_date,
                )
                if data:
                    IST_OFFSET_SEC = 19800  # UTC+5:30 — chart expects IST-epoch
                    opens = data.get("open", [])
                    highs = data.get("high", [])
                    lows = data.get("low", [])
                    closes = data.get("close", [])
                    volumes = data.get("volume", [])
                    timestamps = data.get("timestamp", [])
                    for i in range(min(len(opens), len(closes), len(timestamps))):
                        ts = timestamps[i]
                        unix_sec = ts / 1000 if ts >= 1e12 else ts
                        open_time = int((unix_sec + IST_OFFSET_SEC) * 1000)
                        if open_time >= hist_start and open_time not in by_time:
                            by_time[open_time] = {
                                "open_time": open_time,
                                "open": float(opens[i]) if i < len(opens) else 0,
                                "high": float(highs[i]) if i < len(highs) else 0,
                                "low": float(lows[i]) if i < len(lows) else 0,
                                "close": float(closes[i]) if i < len(closes) else 0,
                                "volume": int(volumes[i]) if i < len(volumes) else 0,
                                "closed": True,
                                "delta": 0,
                                "buy_vol": 0,
                                "sell_vol": 0,
                            }

    candle_dicts = sorted(by_time.values(), key=lambda x: x["open_time"])

    # Session CVD — cumulative delta within each IST calendar day (resets at day boundary)
    prev_d: Optional[str] = None
    running = 0.0
    for cd in candle_dicts:
        d = _ist_date_str_from_ms(int(cd["open_time"]))
        if d != prev_d:
            running = 0.0
        prev_d = d
        running += float(cd.get("delta", cd.get("buy_vol", 0) - cd.get("sell_vol", 0)))
        cd["cvd"] = running

    ticker_cvd = running
    if engine.current_candle:
        live = engine.current_candle.to_dict()
        ot = live.get("open_time")
        if ot is not None and ot not in by_time:
            ld = _ist_date_str_from_ms(int(ot))
            if ld != prev_d:
                running = 0.0
            live["cvd"] = running + float(live.get("delta", 0))
            candle_dicts.append(live)
            ticker_cvd = float(live["cvd"])

    return {
        "symbol": symbol,
        "ltp": engine.last_ltp,
        "bid": engine.last_bid,
        "ask": engine.last_ask,
        "cvd": ticker_cvd,
        "tick_count": engine.tick_count,
        "candles": candle_dicts,
    }


def save_symbol_snapshot(symbol: str):
    """Periodic safety backup: write last in-memory candles to JSON for legacy load_all_snapshots.
    The primary persistence path is JSONL (written on every candle close)."""
    eng = engines.get(symbol)
    if not eng or not eng.candles:
        return
    if not SNAPSHOT_DIR:
        return
    try:
        os.makedirs(SNAPSHOT_DIR, exist_ok=True)
        if not os.path.isdir(SNAPSHOT_DIR):
            return  # disk mount not ready (e.g. Render disk briefly unavailable)
        path = os.path.join(SNAPSHOT_DIR, f"{symbol}.json")
        tmp  = path + ".tmp"
        candle_dicts = [c.to_dict() for c in eng.candles]
        with open(tmp, "w") as fh:
            json.dump(candle_dicts, fh)
        os.replace(tmp, path)
    except OSError as e:
        if e.errno == 2:  # ENOENT — disk mount path may be briefly unavailable (e.g. Render restart)
            pass  # skip log spam; _snapshot_task logs once if dir unavailable
        else:
            logger.warning(f"Snapshot save failed [{symbol}]: {e}")
    except Exception as e:
        logger.warning(f"Snapshot save failed [{symbol}]: {e}")


def load_all_snapshots():
    """
    On startup: restore today's candles from disk (JSONL preferred, JSON fallback).
    Only loads last MAX_CANDLES_IN_MEMORY candles into RAM per engine; computes CVD
    from the full day's history so the running total is accurate.
    """
    if not os.path.isdir(SNAPSHOT_DIR):
        logger.info("Snapshot dir not found — starting with empty history (no Render Disk mounted?)")
        return
    today_start = _ist_midnight_ms()
    loaded = 0

    # Collect all symbols present on disk (JSONL + JSON)
    disk_symbols: set[str] = set()
    for fname in os.listdir(SNAPSHOT_DIR):
        if fname.endswith(".jsonl"):
            disk_symbols.add(fname[:-6])
        elif fname.endswith(".json") and not fname.endswith(".tmp"):
            disk_symbols.add(fname[:-5])

    if not disk_symbols:
        logger.info("Snapshot dir is empty — starting fresh.")
        return

    for symbol in disk_symbols:
        if symbol not in engines:
            continue
        try:
            hist_start = _hist_start_for_symbol(symbol)
            disk_limit = MAX_CANDLES_INDEX_FUT if _is_index_or_index_fut(symbol) else MAX_CANDLES_PER_SYMBOL
            all_today = [
                c for c in load_history_from_disk(symbol, limit=disk_limit)
                if c.get("closed", True) and c.get("open_time", 0) >= hist_start
            ]

            # Compact JSONL on startup: index futures keep all days; others keep today-only to limit file growth.
            jsonl_path = os.path.join(SNAPSHOT_DIR, f"{symbol}.jsonl")
            if os.path.exists(jsonl_path) and all_today:
                tmp_path = jsonl_path + ".compact.tmp"
                try:
                    with open(tmp_path, "w") as fh:
                        for c in all_today:
                            fh.write(_dumps(c) + "\n")
                    os.replace(tmp_path, jsonl_path)
                except Exception as e:
                    logger.warning(f"JSONL compact failed [{symbol}]: {e}")

            if not all_today:
                continue

            # CVD from full history (accurate running total)
            full_cvd = sum(
                c.get("delta", c.get("buy_vol", 0) - c.get("sell_vol", 0))
                for c in all_today
            )

            # Only hydrate last MAX_CANDLES_IN_MEMORY into engine.candles
            recent_dicts = all_today[-MAX_CANDLES_IN_MEMORY:]
            restored: list[FootprintCandle] = []
            for cd in recent_dicts:
                c = FootprintCandle(
                    open_time  = cd["open_time"],
                    open       = cd["open"],
                    high       = cd["high"],
                    low        = cd["low"],
                    close      = cd["close"],
                    buy_vol    = cd.get("buy_vol", 0),
                    sell_vol   = cd.get("sell_vol", 0),
                    delta_open = cd.get("delta_open", 0),
                    delta_min  = cd.get("delta_min", 0),
                    delta_max  = cd.get("delta_max", 0),
                    initiative = cd.get("initiative"),
                    oi         = cd.get("oi", 0),
                    oi_change  = cd.get("oi_change", 0),
                    closed     = True,
                )
                for p_str, lv in cd.get("levels", {}).items():
                    p = float(p_str)
                    c.levels[p] = FootprintLevel(
                        price    = p,
                        buy_vol  = lv.get("buy_vol", 0),
                        sell_vol = lv.get("sell_vol", 0),
                    )
                restored.append(c)

            engines[symbol].candles  = restored
            engines[symbol].cvd      = full_cvd
            engines[symbol].last_oi  = restored[-1].oi if restored else 0.0
            # Restore full-day lite history so build_full_state has all candles
            # regardless of disk availability (early-session gaps are covered)
            engines[symbol].day_candles = [
                {
                    "open_time":  cd["open_time"],
                    "open":       cd["open"],
                    "high":       cd["high"],
                    "low":        cd["low"],
                    "close":      cd["close"],
                    "buy_vol":    cd.get("buy_vol", 0),
                    "sell_vol":   cd.get("sell_vol", 0),
                    "delta":      cd.get("delta", cd.get("buy_vol", 0) - cd.get("sell_vol", 0)),
                    "initiative": cd.get("initiative"),
                    "closed":     True,
                    "oi":         cd.get("oi", 0),
                    "oi_change":  cd.get("oi_change", 0),
                }
                for cd in all_today
            ]
            loaded += 1
            logger.info(f"  Restored {len(all_today)} candles for {symbol} (last {len(restored)} in RAM, CVD={full_cvd:.0f})")
        except Exception as e:
            logger.warning(f"Snapshot load failed [{symbol}]: {e}")

    logger.info(f"Snapshot restore complete: {loaded} symbols loaded from {SNAPSHOT_DIR}")


async def _disk_retry_task():
    """Retry candle writes that failed because the Render disk wasn't mounted yet.
    Runs every 30s. Once disk is available, flushes the queued writes to JSONL files.
    This recovers early-session candles (e.g. 9:15–9:47) that couldn't be written at startup."""
    while True:
        await asyncio.sleep(30)
        if not _failed_disk_writes:
            continue
        if not SNAPSHOT_DIR:
            continue
        try:
            os.makedirs(SNAPSHOT_DIR, exist_ok=True)
        except OSError:
            continue  # disk still unavailable
        if not os.path.isdir(SNAPSHOT_DIR):
            continue

        # Drain the queue atomically
        to_retry = list(_failed_disk_writes)
        _failed_disk_writes.clear()

        written = 0
        for symbol, candle_dict in to_retry:
            try:
                path = os.path.join(SNAPSHOT_DIR, f"{symbol}.jsonl")
                with open(path, "a") as fh:
                    fh.write(_dumps(candle_dict) + "\n")
                written += 1
            except Exception:
                _failed_disk_writes.append((symbol, candle_dict))  # re-queue on failure

        if written:
            logger.info(f"Disk retry: flushed {written}/{len(to_retry)} queued candle writes to disk")


async def _hft_disk_retry_task():
    """Retry HFT writes that failed because the Render disk wasn't mounted yet.
    Runs every 30s. Once HFT_DIR is available, flushes queued HFT snapshots."""
    while True:
        await asyncio.sleep(30)
        if not _failed_hft_writes:
            continue
        if not SNAPSHOT_DIR or not os.path.isdir(SNAPSHOT_DIR):
            continue
        try:
            os.makedirs(HFT_DIR, exist_ok=True)
        except OSError:
            continue
        if not os.path.isdir(HFT_DIR):
            continue

        to_retry = list(_failed_hft_writes)
        _failed_hft_writes.clear()

        written = 0
        for index_name, snap in to_retry:
            try:
                path = os.path.join(HFT_DIR, f"{index_name}.hft.jsonl")
                with open(path, "a") as fh:
                    fh.write(_dumps(snap) + "\n")
                written += 1
            except Exception:
                _failed_hft_writes.append((index_name, snap))

        if written:
            logger.info(f"HFT disk retry: flushed {written}/{len(to_retry)} queued snapshots")


async def _snapshot_task():
    """Background task: save all symbols to disk every 5 minutes.
    Waits 30s on startup for Render disk mount; skips cycle if SNAPSHOT_DIR unavailable."""
    await asyncio.sleep(30)  # let Render disk mount before first save
    while True:
        await asyncio.sleep(300)
        if not SNAPSHOT_DIR or not os.path.isdir(SNAPSHOT_DIR):
            try:
                os.makedirs(SNAPSHOT_DIR, exist_ok=True)
            except OSError:
                logger.warning("Snapshot dir unavailable, skipping periodic save (disk not mounted?)")
                continue
        syms = list(engines.keys())
        for sym in syms:
            save_symbol_snapshot(sym)
        if syms:
            logger.info(f"Periodic snapshot saved for {len(syms)} symbols")


# ─────────────────────────────────────────────
# Dhan WebSocket Feed
# ─────────────────────────────────────────────

def build_dhan_subscription(security_ids: List[str]) -> dict:
    """Build Dhan subscription packet. RequestCode 17 = Quote (Volume, BuyQty, SellQty)."""
    instruments = [
        {"ExchangeSegment": "NSE_FO", "SecurityId": sid}
        for sid in security_ids
    ]
    return {
        "RequestCode": 17,  # Quote packet: Volume, TotalBuyQty, TotalSellQty (not 15=Ticker)
        "InstrumentCount": len(instruments),
        "InstrumentList": instruments,
    }


# ─────────────────────────────────────────────
# Liquidity Heatmap — 200-level depth WebSocket
# wss://full-depth-api.dhan.co/twohundreddepth?token=...&clientId=...&authType=2
# ─────────────────────────────────────────────

DHAN_DEPTH_WS_BASE = os.getenv(
    "DHAN_DEPTH_WS_BASE", "wss://full-depth-api.dhan.co/twohundreddepth"
)


def _index_future_symbols() -> Dict[str, str]:
    """Return {symbol: security_id} for NIFTY/BANKNIFTY/FINNIFTY index futures."""
    result = {}
    for sym, info in subscribed_symbols.items():
        for idx in UNDERLYING_IDS:
            if idx in sym.upper() and "FUT" in sym.upper():
                result[sym] = info.get("security_id", "")
                break
    return result


def _sid_to_symbol(sid: str) -> Optional[str]:
    """Reverse-lookup symbol from security_id."""
    for sym, info in subscribed_symbols.items():
        if str(info.get("security_id", "")) == str(sid):
            return sym
    return None


# Per-symbol append counter for periodic disk truncation
_depth_append_count: Dict[str, int] = {}


def _append_depth_to_disk(symbol: str, snap: dict) -> None:
    """Append one depth snapshot to disk (JSONL). Truncate periodically to cap file size."""
    if not SNAPSHOT_DIR:
        return
    try:
        os.makedirs(DEPTH_DIR, exist_ok=True)
        path = os.path.join(DEPTH_DIR, f"{symbol}.depth.jsonl")
        with open(path, "a") as fh:
            fh.write(_dumps(snap) + "\n")

        # Every 100 appends, truncate if file exceeds MAX_DEPTH_FILE_LINES
        _depth_append_count[symbol] = _depth_append_count.get(symbol, 0) + 1
        if _depth_append_count[symbol] >= 100:
            _depth_append_count[symbol] = 0
            try:
                with open(path, "r") as fh:
                    lines = fh.readlines()
                if len(lines) > MAX_DEPTH_FILE_LINES:
                    keep = lines[-MAX_DEPTH_FILE_LINES:]
                    with open(path, "w") as fh:
                        fh.writelines(keep)
                    logger.debug(f"Depth file truncated [{symbol}] to {len(keep)} lines")
            except Exception as e:
                logger.warning(f"Depth truncate failed [{symbol}]: {e}")
    except Exception as e:
        logger.warning(f"Depth disk append failed [{symbol}]: {e}")


def _load_depth_from_disk(symbol: str, n: int) -> list:
    """Load last n depth snapshots from disk. Returns [] if no file or error."""
    path = os.path.join(DEPTH_DIR, f"{symbol}.depth.jsonl")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r") as fh:
            lines = fh.readlines()
        if not lines:
            return []
        lines = lines[-n:] if len(lines) > n else lines
        return [_loads(l) for l in lines if l.strip()]
    except Exception as e:
        logger.warning(f"Depth disk load failed [{symbol}]: {e}")
        return []


# Retry queue for HFT writes that failed due to disk being unavailable at startup
_failed_hft_writes: list[tuple[str, dict]] = []


def _append_hft_to_disk(index_name: str, snap: dict) -> None:
    """Append one HFT snapshot to its JSONL file. On ENOENT, queue for retry."""
    try:
        os.makedirs(HFT_DIR, exist_ok=True)
        path = os.path.join(HFT_DIR, f"{index_name}.hft.jsonl")
        with open(path, "a") as fh:
            fh.write(_dumps(snap) + "\n")
    except OSError as e:
        if e.errno == 2:  # ENOENT — disk not yet mounted; queue for retry
            _failed_hft_writes.append((index_name, snap))
        else:
            logger.warning(f"HFT disk append failed [{index_name}]: {e}")
    except Exception as e:
        logger.warning(f"HFT disk append failed [{index_name}]: {e}")


def _load_hft_from_disk(index_name: str) -> list:
    """Load today's HFT snapshots from disk.
    Reads ALL lines (no pre-truncation) and filters to today's data only.
    Returns [] on missing file or error."""
    path = os.path.join(HFT_DIR, f"{index_name}.hft.jsonl")
    if not os.path.exists(path):
        return []
    today_start_s = _ist_midnight_ms() / 1000  # HFT snaps use Unix seconds
    try:
        snaps = []
        with open(path, "r") as fh:
            for ln in fh:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    s = _loads(ln)
                    # Filter to today only (prevents multi-day accumulation cutoff)
                    # Snapshot uses "ts" (Unix seconds), not "timestamp"/"time"
                    ts = s.get("ts", s.get("timestamp", s.get("time", 0)))
                    if ts >= today_start_s:
                        snaps.append(s)
                except Exception:
                    pass
        # Dedupe by minute (keep last) — avoids double bars when merged snap was appended
        by_minute: dict[int, dict] = {}
        for s in snaps:
            by_minute[s.get("ts", 0) // 60] = s
        result = sorted(by_minute.values(), key=lambda x: x.get("ts", 0))
        return result[-HFT_MAX_SNAPSHOTS:] if len(result) > HFT_MAX_SNAPSHOTS else result
    except Exception as e:
        logger.warning(f"HFT disk load failed [{index_name}]: {e}")
        return []


def load_hft_from_disk() -> None:
    """Restore all index HFT histories from disk on cold start."""
    if not os.path.isdir(HFT_DIR):
        return
    loaded = 0
    for fname in os.listdir(HFT_DIR):
        if not fname.endswith(".hft.jsonl"):
            continue
        idx = fname[: -len(".hft.jsonl")]
        snaps = _load_hft_from_disk(idx)
        if snaps:
            hft_scanner_history[idx] = snaps
            loaded += 1
    if loaded:
        logger.info(f"HFT history restored from disk: {loaded} indices")


def _parse_binary_depth(raw: bytes, symbol: str) -> None:
    """Parse 200-level binary depth packet from Dhan full-depth feed.

    Per Dhan docs:
      Response Header (12 bytes, 1-indexed so 0-indexed = 0–11):
        bytes 0–1  : int16  message length
        byte  2    : byte   feed response code (41=Bid, 51=Ask, 50=disconnect)
        byte  3    : byte   exchange segment
        bytes 4–7  : int32  security ID
        bytes 8–11 : uint32 number of rows

      Depth payload: num_rows × 16 bytes each
        bytes 0–7  : float64  price
        bytes 8–11 : uint32   quantity
        bytes 12–15: uint32   number of orders

    Bid and Ask packets are stacked; we accumulate until we have both then snapshot.
    """
    pending_bids: list = []
    pending_asks: list = []
    pos = 0
    while pos + 12 <= len(raw):
        msg_len  = struct.unpack_from("<H", raw, pos)[0]
        code     = struct.unpack_from("<B", raw, pos + 2)[0]
        num_rows = struct.unpack_from("<I", raw, pos + 8)[0]
        payload_start = pos + 12
        levels = []
        for i in range(num_rows):
            off = payload_start + i * 16
            if off + 16 > len(raw):
                break
            price  = struct.unpack_from("<d", raw, off)[0]      # float64
            qty    = struct.unpack_from("<I", raw, off + 8)[0]  # uint32
            if price > 0:
                levels.append({"p": round(price, 2), "q": qty})
        if code == 41:   # Bid
            pending_bids = levels
        elif code == 51:  # Ask
            pending_asks = levels
        # Advance; if msg_len == 0 (malformed), stop
        step = msg_len if msg_len >= 12 else (12 + num_rows * 16)
        pos += step
        if step == 0:
            break

    if pending_bids or pending_asks:
        if symbol not in depth_snapshots:
            depth_snapshots[symbol] = deque(maxlen=HEATMAP_SNAPSHOTS_IN_RAM)
        engine = engines.get(symbol)
        snap = {
            "ts":   int(time.time() * 1000),
            "ltp":  engine.last_ltp if engine else 0,
            "bids": pending_bids,
            "asks": pending_asks,
        }
        depth_snapshots[symbol].append(snap)
        _append_depth_to_disk(symbol, snap)


async def _depth_ws_single(sym: str, sid: str, seg: str):
    """Maintain one 200-level depth WS connection for a single symbol.
    Per Dhan docs: only 1 instrument per 200-level connection, RequestCode 23.
    """
    retry_delay = 5
    ws_url = (
        f"{DHAN_DEPTH_WS_BASE}"
        f"?token={DHAN_TOKEN_DEPTH}"
        f"&clientId={DHAN_CLIENT_ID}"
        f"&authType=2"
    )
    while True:
        try:
            async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
                retry_delay = 5
                # 200-level subscribe: single-instrument format (no InstrumentList)
                await ws.send(_dumps({
                    "RequestCode": 23,
                    "ExchangeSegment": seg,
                    "SecurityId": str(sid),
                }))
                logger.info(f"Depth WS [{sym}] connected (200-level)")
                async for raw in ws:
                    if isinstance(raw, (bytes, bytearray)) and len(raw) >= 12:
                        _parse_binary_depth(raw, sym)
        except (websockets.exceptions.ConnectionClosedError,
                websockets.exceptions.ConnectionClosedOK):
            # Normal / expected close (e.g. server-side idle timeout, no close frame)
            logger.info(f"Depth WS [{sym}] closed — reconnecting in {retry_delay}s")
            await asyncio.sleep(retry_delay)
            retry_delay = 5  # reset after expected close
        except Exception as e:
            logger.warning(f"Depth WS [{sym}] error: {e} — retry in {retry_delay}s")
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 120)


async def depth_poller_task():
    """Launch one 200-level depth WS task per index-future symbol.
    Per Dhan docs, 200-level depth allows only 1 instrument per connection.
    """
    if not DHAN_TOKEN_DEPTH:
        logger.info("DHAN_TOKEN_DEPTH not set — 200-level depth feed inactive")
        return

    # Wait until index futures are subscribed
    while True:
        syms = _index_future_symbols()
        if syms:
            break
        await asyncio.sleep(30)

    # Normalise segment: depth feed uses NSE_FNO (same as market-quote)
    SEG_MAP = {"NSE_FO": "NSE_FNO"}
    tasks = {}
    while True:
        syms = _index_future_symbols()
        for sym, sid in syms.items():
            if sym not in tasks or tasks[sym].done():
                seg = subscribed_symbols.get(sym, {}).get("exchange_segment", "NSE_FNO")
                seg = SEG_MAP.get(seg, seg)
                tasks[sym] = asyncio.create_task(_depth_ws_single(sym, sid, seg))
                logger.info(f"Depth WS task started for {sym}")
        await asyncio.sleep(60)  # check every 60s for new index futures


# ─────────────────────────────────────────────
# Options GEX — options chain poller
# Dhan docs: https://dhanhq.co/docs/v2/option-chain/
# Rate limit: 1 unique request per 3 seconds
# ─────────────────────────────────────────────

# UnderlyingSeg for index options — IDX_I (NSE), BSE_FNO (BSE indices)
UNDERLYING_SEG = "IDX_I"

def _find_gex_flip(strikes: list, spot: float) -> Optional[float]:
    """Cumulative GEX from lowest strike upward; return strike where sign flips near spot."""
    sorted_s = sorted(strikes, key=lambda x: x["strike"])
    cum = 0.0
    flip = None
    for row in sorted_s:
        prev, cum = cum, cum + row["net_gex"]
        if prev != 0 and prev * cum < 0:
            if flip is None or abs(row["strike"] - spot) < abs(flip - spot):
                flip = row["strike"]
    return flip


def _get_hft_thresholds(index_name: str) -> dict:
    """Return HFT thresholds for the given index. Per-index env overrides, else defaults."""
    d = _HFT_DEFAULTS.get(index_name, {"oi_chg_pct": 3.0, "ltp_stable": 1.0, "ce_vol": 50_000, "pe_vol": 50_000})
    return {
        "oi_chg_pct":   float(os.getenv(f"HFT_OI_CHG_PCT_{index_name}", os.getenv("HFT_OI_CHG_PCT", str(d["oi_chg_pct"])))),
        "ltp_stable":   float(os.getenv(f"HFT_LTP_STABLE_PCT_{index_name}", os.getenv("HFT_LTP_STABLE_PCT", str(d["ltp_stable"])))),
        "ltp_move":     float(os.getenv("HFT_LTP_MOVE_PCT", "2")),
        "oi_chg_min":   float(os.getenv("HFT_OI_CHG_MIN", "3")),
        "ce_vol_min":   int(os.getenv(f"HFT_CE_VOL_MIN_{index_name}", os.getenv("HFT_CE_VOL_MIN", str(d["ce_vol"])))),
        "pe_vol_min":   int(os.getenv(f"HFT_PE_VOL_MIN_{index_name}", os.getenv("HFT_PE_VOL_MIN", str(d["pe_vol"])))),
    }


def _compute_hft_snapshot(index_name: str, spot: float, oc: dict) -> None:
    """Derive one time-series entry for the HFT scanner chart from a raw option-chain snapshot.

    Computes:
      • per-strike OI / LTP / IV changes vs the previous call
      • a simple Money Flow Index (MFI) across all ATM ±5 strikes
      • flow classification into eight named buckets (matching the Streamlit colour scheme)

    Appended to hft_scanner_history[index_name] (capped at HFT_MAX_SNAPSHOTS).
    """
    prev   = hft_prev_data.get(index_name, {})
    strikes_data = []

    for strike_str, sides in oc.items():
        try:
            strike = float(strike_str)
        except ValueError:
            continue

        ce = sides.get("ce") or {}
        pe = sides.get("pe") or {}

        def _f(d, key):
            return float(d.get(key) or 0)

        ce_oi  = _f(ce, "oi");           pe_oi  = _f(pe, "oi")
        ce_ltp = _f(ce, "last_price");   pe_ltp = _f(pe, "last_price")
        ce_iv  = _f(ce, "implied_volatility"); pe_iv = _f(pe, "implied_volatility")
        ce_vol = _f(ce, "volume");       pe_vol = _f(pe, "volume")
        ce_g = ce.get("greeks") or {}
        pe_g = pe.get("greeks") or {}
        ce_delta = _f(ce_g, "delta");  pe_delta = _f(pe_g, "delta")
        ce_gamma = _f(ce_g, "gamma");  pe_gamma = _f(pe_g, "gamma")
        ce_theta = _f(ce_g, "theta");   pe_theta = _f(pe_g, "theta")
        ce_vega  = _f(ce_g, "vega");    pe_vega  = _f(pe_g, "vega")

        pk_ce = f"{strike}_CE";  pk_pe = f"{strike}_PE"
        pc = prev.get(pk_ce, {}); pp = prev.get(pk_pe, {})

        def _chg(cur, p_val):
            return (cur - p_val) / (p_val or 1) * 100 if p_val else 0

        strikes_data.append({
            "strike":      strike,
            "CE_OI":       ce_oi,  "CE_LTP":  ce_ltp, "CE_IV":  ce_iv,  "CE_VOL": ce_vol,
            "CE_DELTA":    ce_delta, "CE_GAMMA": ce_gamma, "CE_THETA": ce_theta, "CE_VEGA": ce_vega,
            "CE_OI_CHG":   _chg(ce_oi,  pc.get("oi",  ce_oi)),
            "CE_LTP_CHG":  _chg(ce_ltp, pc.get("ltp", ce_ltp)),
            "CE_IV_CHG":   _chg(ce_iv,  pc.get("iv",  ce_iv)),
            "PE_OI":       pe_oi,  "PE_LTP":  pe_ltp, "PE_IV":  pe_iv,  "PE_VOL": pe_vol,
            "PE_DELTA":    pe_delta, "PE_GAMMA": pe_gamma, "PE_THETA": pe_theta, "PE_VEGA": pe_vega,
            "PE_OI_CHG":   _chg(pe_oi,  pp.get("oi",  pe_oi)),
            "PE_LTP_CHG":  _chg(pe_ltp, pp.get("ltp", pe_ltp)),
            "PE_IV_CHG":   _chg(pe_iv,  pp.get("iv",  pe_iv)),
        })

    if not strikes_data:
        return

    # ── Money Flow Index (across all strikes, single-snapshot approximation) ──
    mf_pos = mf_neg = 0.0
    for s in strikes_data:
        ce_mf = s["CE_LTP"] * s["CE_VOL"]
        pe_mf = s["PE_LTP"] * s["PE_VOL"]
        if s["CE_LTP_CHG"] > 0:  mf_pos += ce_mf
        elif s["CE_LTP_CHG"] < 0: mf_neg += ce_mf
        if s["PE_LTP_CHG"] > 0:  mf_pos += pe_mf
        elif s["PE_LTP_CHG"] < 0: mf_neg += pe_mf
    mfi = 100 - (100 / (1 + mf_pos / (mf_neg + 1)))

    # ── ATM ±5 strikes filter ─────────────────────────────────────────────────
    sorted_s = sorted(set(s["strike"] for s in strikes_data))
    interval = 50.0
    if len(sorted_s) >= 2:
        diffs = [sorted_s[i + 1] - sorted_s[i] for i in range(len(sorted_s) - 1)]
        interval = min(diffs) or 50.0
    nearby = [s for s in strikes_data if abs(s["strike"] - spot) <= 5 * interval]

    th = _get_hft_thresholds(index_name)
    oi_chg_pct = th["oi_chg_pct"]
    ltp_stable = th["ltp_stable"]
    ltp_move = th["ltp_move"]
    oi_chg_min = th["oi_chg_min"]
    ce_vol_min = th["ce_vol_min"]
    pe_vol_min = th["pe_vol_min"]

    # ── Flow classification ───────────────────────────────────────────────────
    flows: dict = {
        "Aggressive Call Buy":  0.0,
        "Heavy Call Short":     0.0,
        "Aggressive Put Buy":   0.0,
        "Heavy Put Write":      0.0,
        "Dark Pool CE":         0.0,
        "Dark Pool PE":         0.0,
        "Call Short":           0.0,
        "Put Write":            0.0,
    }
    strike_flows: dict = {}  # strike -> { flow_name: value } for Phase 2 strike-level OI

    for s in nearby:
        strike = s["strike"]
        ce_act = s["CE_OI"] * s["CE_LTP"]
        pe_act = s["PE_OI"] * s["PE_LTP"]

        if ce_act > 0:
            if s["CE_OI_CHG"] > oi_chg_pct and abs(s["CE_LTP_CHG"]) < ltp_stable and s["CE_VOL"] > ce_vol_min:
                flows["Dark Pool CE"] += ce_act
                strike_flows.setdefault(strike, {})["Dark Pool CE"] = strike_flows.get(strike, {}).get("Dark Pool CE", 0) + ce_act
            elif s["CE_LTP_CHG"] > ltp_move and mfi > HFT_MFI_OVERBOUGHT and s["CE_VOL"] > ce_vol_min:
                flows["Aggressive Call Buy"] += ce_act
                strike_flows.setdefault(strike, {})["Aggressive Call Buy"] = strike_flows.get(strike, {}).get("Aggressive Call Buy", 0) + ce_act
            elif s["CE_OI_CHG"] > oi_chg_pct and s["CE_LTP_CHG"] < -ltp_move and mfi < HFT_MFI_OVERSOLD:
                flows["Heavy Call Short"] += ce_act
                strike_flows.setdefault(strike, {})["Heavy Call Short"] = strike_flows.get(strike, {}).get("Heavy Call Short", 0) + ce_act
            elif s["CE_LTP_CHG"] < -1 and s["CE_OI_CHG"] > oi_chg_min:
                flows["Call Short"] += ce_act
                strike_flows.setdefault(strike, {})["Call Short"] = strike_flows.get(strike, {}).get("Call Short", 0) + ce_act

        if pe_act > 0:
            if s["PE_OI_CHG"] > oi_chg_pct and abs(s["PE_LTP_CHG"]) < ltp_stable and s["PE_VOL"] > pe_vol_min:
                flows["Dark Pool PE"] += pe_act
                strike_flows.setdefault(strike, {})["Dark Pool PE"] = strike_flows.get(strike, {}).get("Dark Pool PE", 0) + pe_act
            elif s["PE_LTP_CHG"] > ltp_move and mfi < HFT_MFI_OVERSOLD and s["PE_VOL"] > pe_vol_min:
                flows["Aggressive Put Buy"] += pe_act
                strike_flows.setdefault(strike, {})["Aggressive Put Buy"] = strike_flows.get(strike, {}).get("Aggressive Put Buy", 0) + pe_act
            elif s["PE_OI_CHG"] > oi_chg_pct and s["PE_LTP_CHG"] < -ltp_move and mfi > HFT_MFI_OVERBOUGHT:
                flows["Heavy Put Write"] += pe_act
                strike_flows.setdefault(strike, {})["Heavy Put Write"] = strike_flows.get(strike, {}).get("Heavy Put Write", 0) + pe_act
            elif s["PE_LTP_CHG"] < -1 and s["PE_OI_CHG"] > oi_chg_min:
                flows["Put Write"] += pe_act
                strike_flows.setdefault(strike, {})["Put Write"] = strike_flows.get(strike, {}).get("Put Write", 0) + pe_act

    # ── Store snapshot (incl. raw OI/LTP for strike-level comparison without flow criteria) ──
    now_ts   = int(time.time())
    minute_ts = (now_ts // 60) * 60  # align to minute boundary for candle sync
    now_ist  = datetime.now(IST)
    strike_flows_ser = {str(k): {fk: round(fv, 2) for fk, fv in v.items() if fv > 0} for k, v in strike_flows.items() if v}
    strikes_raw_ser = {
        str(s["strike"]): {
            "ce_oi": round(s["CE_OI"], 2), "pe_oi": round(s["PE_OI"], 2),
            "ce_ltp": round(s["CE_LTP"], 2), "pe_ltp": round(s["PE_LTP"], 2),
            "ce_iv": round(s["CE_IV"], 4), "pe_iv": round(s["PE_IV"], 4),
            "ce_vol": round(s["CE_VOL"], 0), "pe_vol": round(s["PE_VOL"], 0),
            "ce_delta": round(s["CE_DELTA"], 4), "pe_delta": round(s["PE_DELTA"], 4),
            "ce_gamma": round(s["CE_GAMMA"], 6), "pe_gamma": round(s["PE_GAMMA"], 6),
            "ce_theta": round(s["CE_THETA"], 2), "pe_theta": round(s["PE_THETA"], 2),
            "ce_vega": round(s["CE_VEGA"], 2), "pe_vega": round(s["PE_VEGA"], 2),
            "ce_oi_chg": round(s["CE_OI_CHG"], 2), "pe_oi_chg": round(s["PE_OI_CHG"], 2),
            "ce_ltp_chg": round(s["CE_LTP_CHG"], 2), "pe_ltp_chg": round(s["PE_LTP_CHG"], 2),
        }
        for s in nearby
    }
    snap = {
        "t":    now_ist.strftime("%H:%M"),
        "ts":   minute_ts,
        "spot": round(spot, 2),
        "mfi":  round(mfi, 2),
        "flows": {k: round(v, 2) for k, v in flows.items() if v > 0},
        "strike_flows": strike_flows_ser,
        "strikes_raw": strikes_raw_ser,
    }
    history = hft_scanner_history[index_name]
    # Merge in place if we already have a snap for this minute (avoids duplicate bars
    # and "different color appearing" when a second poll lands in same minute)
    if history and (history[-1]["ts"] // 60) == (minute_ts // 60):
        last = history[-1]
        last["spot"] = snap["spot"]
        last["mfi"]  = snap["mfi"]
        for k, v in snap["flows"].items():
            last["flows"][k] = last["flows"].get(k, 0) + v
        for sk, sv in snap.get("strike_flows", {}).items():
            if sk not in last.setdefault("strike_flows", {}):
                last["strike_flows"][sk] = {}
            for fk, fv in sv.items():
                last["strike_flows"][sk][fk] = last["strike_flows"][sk].get(fk, 0) + fv
        if snap.get("strikes_raw"):
            last["strikes_raw"] = snap["strikes_raw"]  # latest raw data for this minute
        last["t"] = snap["t"]
        _append_hft_to_disk(index_name, last)  # persist merged
    else:
        history.append(snap)
        if len(history) > HFT_MAX_SNAPSHOTS:
            hft_scanner_history[index_name] = history[-HFT_MAX_SNAPSHOTS:]
        _append_hft_to_disk(index_name, snap)

    # ── Update prev-data for next cycle's change computation ─────────────────
    new_prev: dict = {}
    for s in strikes_data:
        new_prev[f"{s['strike']}_CE"] = {"oi": s["CE_OI"], "ltp": s["CE_LTP"], "iv": s["CE_IV"]}
        new_prev[f"{s['strike']}_PE"] = {"oi": s["PE_OI"], "ltp": s["PE_LTP"], "iv": s["PE_IV"]}
    hft_prev_data[index_name] = new_prev


async def _fetch_gex_once(index_name: str, underlying_scrip: str, expiry: str) -> bool:
    """Fetch options chain from Dhan REST API and compute GEX for one index.

    Correct request body per Dhan v2 docs:
        {"UnderlyingScrip": 13, "UnderlyingSeg": "IDX_I", "Expiry": "2024-10-31"}

    Response: data.last_price = spot, data.oc = {strike_str: {ce:{...}, pe:{...}}}
    Greeks (including gamma) are provided directly — no Black-Scholes needed.

    Returns True on success, False on rate-limit / error (caller backs off).
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            for attempt in range(2):  # retry once on 429
                resp = await client.post(
                    f"{DHAN_API_BASE}/optionchain",
                    headers={
                        "access-token": DHAN_TOKEN_OPTIONS,
                        "client-id":    DHAN_CLIENT_ID,
                        "Content-Type": "application/json",
                        "Accept":       "application/json",
                    },
                    json={
                        "UnderlyingScrip": int(underlying_scrip),  # must be int
                        "UnderlyingSeg":   UNDERLYING_SEG_MAP.get(index_name, UNDERLYING_SEG),
                        "Expiry":          expiry,                  # "YYYY-MM-DD"
                    },
                )
                if resp.status_code == 429:
                    if attempt == 0:
                        logger.warning(f"Options chain 429 [{index_name}] — retrying after 10s")
                        await asyncio.sleep(10)
                        continue
                    logger.warning(f"Options chain 429 [{index_name}] — rate limited, backing off")
                    return False
                break
            if not resp.is_success:   # httpx attr (not requests' .ok)
                logger.warning(
                    f"Options chain {resp.status_code} [{index_name}] "
                    f"expiry={expiry} | {resp.text[:300]}"
                )
                return False
            data = resp.json()

        if data.get("status") != "success":
            logger.warning(f"Options chain non-success [{index_name}]: {data}")
            return False

        chain = data.get("data", {})
        spot  = float(chain.get("last_price", 0) or 0)
        if spot <= 0:
            logger.debug(f"GEX [{index_name}]: spot missing in response")
            return False

        # data.oc is a dict: {"25650.000000": {"ce": {...}, "pe": {...}}, ...}
        oc = chain.get("oc", {})
        if not oc:
            logger.debug(f"GEX [{index_name}]: empty oc in response")
            return False

        lot_size = LOT_SIZES.get(index_name, 25)
        results  = []

        for strike_str, sides in oc.items():
            try:
                strike = float(strike_str)
            except ValueError:
                continue

            ce = sides.get("ce", {}) or {}
            pe = sides.get("pe", {}) or {}

            call_oi    = float(ce.get("oi", 0) or 0)
            put_oi     = float(pe.get("oi", 0) or 0)
            prev_call_oi = float(ce.get("previous_oi", 0) or 0)
            prev_put_oi  = float(pe.get("previous_oi", 0) or 0)
            # Dhan provides greeks directly — use them instead of Black-Scholes
            ce_greeks = ce.get("greeks") or {}
            pe_greeks = pe.get("greeks") or {}
            call_gamma = float(ce_greeks.get("gamma", 0) or 0)
            put_gamma  = float(pe_greeks.get("gamma", 0) or 0)
            call_theta = float(ce_greeks.get("theta", 0) or 0)
            put_theta  = float(pe_greeks.get("theta", 0) or 0)

            # Dealer GEX: long calls (+γ), short puts (−γ)
            # GEX = gamma × OI × lot_size × spot² / 100
            call_gex = call_gamma * call_oi * lot_size * spot ** 2 / 100
            put_gex  = put_gamma  * put_oi  * lot_size * spot ** 2 / 100
            net_gex  = call_gex - put_gex

            results.append({
                "strike":   strike,
                "call_oi":  call_oi,
                "put_oi":   put_oi,
                "previous_call_oi": prev_call_oi,
                "previous_put_oi":  prev_put_oi,
                "call_oi_change":  call_oi - prev_call_oi,
                "put_oi_change":   put_oi - prev_put_oi,
                "call_volume":     float(ce.get("volume", 0) or 0),
                "put_volume":      float(pe.get("volume", 0) or 0),
                "call_iv":  float(ce.get("implied_volatility", 0) or 0),
                "put_iv":   float(pe.get("implied_volatility", 0) or 0),
                "call_theta": call_theta,
                "put_theta":  put_theta,
                "call_gex": round(call_gex, 2),
                "put_gex":  round(put_gex, 2),
                "net_gex":  round(net_gex, 2),
            })

        # Also accumulate HFT scanner time-series (piggybacks the same API call)
        _compute_hft_snapshot(index_name, spot, oc)

        results.sort(key=lambda x: x["strike"])
        flip = _find_gex_flip(results, spot)

        cache_key = f"{index_name}:{expiry}"
        gex_cache[cache_key] = {
            "computed_at":    int(time.time() * 1000),
            "index":          index_name,
            "spot":           spot,
            "expiry":         expiry,
            "lot_size":       lot_size,
            "strikes":        results,
            "flip_point":     flip,
            "total_call_gex": round(sum(r["call_gex"] for r in results), 2),
            "total_put_gex":  round(sum(r["put_gex"]  for r in results), 2),
        }
        logger.info(f"GEX [{index_name}:{expiry}] updated: spot={spot}, strikes={len(results)}, flip={flip}")
        return True

    except Exception as e:
        logger.warning(f"Options poll error [{index_name}]: {e}")
        return False


def _compute_and_store_sentiment(index_name: str, cache_key: str) -> None:
    """Compute sentiment from gex_cache and store in sentiment_cache + sentiment_history."""
    data = gex_cache.get(cache_key)
    if not data or not data.get("strikes"):
        return
    prev = sentiment_prev.get(index_name, {})
    try:
        today = date.today()
        exp_date = None
        if data.get("expiry"):
            try:
                exp_date = datetime.strptime(data["expiry"], "%Y-%m-%d").date()
            except ValueError:
                pass
        days_left = (exp_date - today).days if exp_date else None

        out = compute_sentiment(
            data,
            index_name=index_name,
            expiry=data.get("expiry", ""),
            days_to_expiry=days_left,
            prev_skew=prev.get("skew"),
            prev_atm_iv=prev.get("atm_iv"),
        )
        out["computed_at"] = int(time.time() * 1000)
        sentiment_cache[index_name] = out

        # Append to history for time-series
        hist = sentiment_history[index_name]
        hist.append({"ts": out["computed_at"], "score": out["score"], "signal": out["overall_signal"]})
        if len(hist) > SENTIMENT_MAX_HISTORY:
            sentiment_history[index_name] = hist[-SENTIMENT_MAX_HISTORY:]

        # Store prev for next cycle
        sentiment_prev[index_name] = {
            "skew": out["features"].get("iv_skew"),
            "atm_iv": out["features"].get("atm_iv"),
        }
        ml_dir, ml_conf = ml_predict(extract_ml_features(out))
        out["ml_direction"] = ml_dir
        out["ml_confidence"] = round(ml_conf, 3)
    except Exception as e:
        logger.warning(f"Sentiment compute error [{index_name}]: {e}")


def _save_sentiment_eod(index_name: str, cache_key: str) -> None:
    """Save EOD snapshot to disk for ML training."""
    if not SNAPSHOT_DIR:
        return
    data = gex_cache.get(cache_key)
    if not data:
        return
    try:
        os.makedirs(SENTIMENT_DIR, exist_ok=True)
        eod_dir = os.path.join(SENTIMENT_DIR, "eod")
        os.makedirs(eod_dir, exist_ok=True)
        today = date.today().strftime("%Y-%m-%d")
        path = os.path.join(eod_dir, f"{index_name}_{today}.json")
        with open(path, "w") as fh:
            fh.write(_dumps(data))
    except Exception as e:
        logger.warning(f"Sentiment EOD save error [{index_name}]: {e}")


async def options_poller_task():
    """Background: poll Dhan options chain and recompute GEX.

    Rate limit per Dhan docs: 1 unique request per 3 seconds.
    We use 5 s gap between each index (safe margin) and OPTIONS_POLL_SEC between full cycles.
    On 429 → skip remaining indices this cycle and add an extra cool-down.
    """
    if not DHAN_TOKEN_OPTIONS:
        logger.info("DHAN_TOKEN_OPTIONS not set — options/GEX poller inactive")
        return
    gap = OPTIONS_POLL_GAP
    logger.info(f"Starting options/GEX poller (cycle={OPTIONS_POLL_SEC}s, gap={gap}s/index)…")
    # Pre-fetch expiry lists so the frontend dropdown is populated immediately
    for idx_name in UNDERLYING_IDS:
        await _fetch_expiry_list(idx_name)
        await asyncio.sleep(gap)
    while True:
        rate_limited = False
        now_ist = datetime.now(IST)
        today_str = now_ist.strftime("%Y-%m-%d")
        is_eod = now_ist.hour >= 15 and now_ist.minute >= 25  # NSE closes 15:30
        for idx_name, uid in UNDERLYING_IDS.items():
            expiry = await _default_expiry_from_api(idx_name)
            if not expiry:
                continue  # skip if no expiries (token not set or API error)
            ok = await _fetch_gex_once(idx_name, uid, expiry)
            if not ok:
                rate_limited = True
                logger.warning(f"Options poll failed [{idx_name}] — backing off (possible 429 rate limit when market active)")
                break
            cache_key = f"{idx_name}:{expiry}"
            _compute_and_store_sentiment(idx_name, cache_key)
            if is_eod:
                eod_key = f"{idx_name}:{today_str}"
                if eod_key not in _sentiment_eod_saved:
                    _save_sentiment_eod(idx_name, cache_key)
                    _sentiment_eod_saved.add(eod_key)
            await asyncio.sleep(gap)

        # On rate limit, add 2 min cooldown to avoid hammering Dhan when market is busy
        # Otherwise sleep so total cycle ≈ OPTIONS_POLL_SEC (one HFT bar per minute)
        extra = 120 if rate_limited else 0
        cycle_sleep = max(5, OPTIONS_POLL_SEC - len(UNDERLYING_IDS) * gap)
        await asyncio.sleep(cycle_sleep + extra)


def _is_auth_error(exc: Exception) -> bool:
    """Return True if the exception looks like a token rejection (401/403/invalid token)."""
    s = str(exc)
    for marker in ("401", "403", "unauthorized", "forbidden", "invalid token",
                   "token expired", "authentication failed", "rejected"):
        if marker in s.lower():
            return True
    # websockets raises InvalidStatusCode; check status_code attribute
    code = getattr(exc, "status_code", getattr(exc, "status", None))
    return code in (401, 403)


async def dhan_feed_task():
    """Background task: connect to Dhan feed and process ticks.

    Reconnect strategy:
    - Network / server errors  → retry after 5 s (fixed)
    - Auth failure (401/403)   → exponential backoff (5 s → 10 → 20 → … → 1800 s max)
                                  immediately wakes up when token is updated via POST /api/token
    """
    global _dhan_reconnect_delay
    logger.info("Starting Dhan feed task...")

    while True:
        if not subscribed_symbols:
            await asyncio.sleep(2)
            continue

        if not DHAN_ACCESS_TOKEN or not DHAN_CLIENT_ID:
            logger.warning("Dhan credentials not set. Running in DEMO mode.")
            await demo_feed_task()
            return

        url = f"{DHAN_WS_URL}?version=2&token={DHAN_ACCESS_TOKEN}&clientId={DHAN_CLIENT_ID}&authType=2"

        try:
            async with websockets.connect(url, ping_interval=20) as ws:
                _dhan_reconnect_delay = 5          # reset backoff on successful connect
                logger.info("Connected to Dhan WebSocket (v2)")

                instruments = [
                    {"ExchangeSegment": info.get("exchange_segment", "NSE_FO"),
                     "SecurityId": info.get("security_id")}
                    for info in subscribed_symbols.values()
                ]
                for i in range(0, len(instruments), 100):
                    batch = instruments[i : i + 100]
                    await ws.send(_dumps({
                        "RequestCode": 17,
                        "InstrumentCount": len(batch),
                        "InstrumentList": batch,
                    }))
                    await asyncio.sleep(0.1)

                async for raw in ws:
                    try:
                        if isinstance(raw, (bytes, bytearray)):
                            parsed = parse_dhan_binary(raw)
                            if parsed:
                                await handle_dhan_tick(parsed)
                        else:
                            try:
                                await handle_dhan_tick(_loads(raw))
                            except Exception:
                                pass
                    except Exception as e:
                        logger.error(f"Tick parse error: {e}")

        except Exception as e:
            if _is_auth_error(e):
                logger.error(
                    f"⚠️  Dhan token REJECTED ({e}) — token likely expired.\n"
                    f"    Update via POST /api/token or set DHAN_ACCESS_TOKEN env var.\n"
                    f"    Backing off {_dhan_reconnect_delay}s before next attempt."
                )
                # Wait up to _dhan_reconnect_delay seconds, but wake immediately on token update
                _dhan_token_event.clear()
                try:
                    await asyncio.wait_for(_dhan_token_event.wait(), timeout=_dhan_reconnect_delay)
                    logger.info("Token updated via API — reconnecting now.")
                    _dhan_reconnect_delay = 5      # reset after manual token update
                except asyncio.TimeoutError:
                    _dhan_reconnect_delay = min(_dhan_reconnect_delay * 2, 1800)
            else:
                logger.error(f"Dhan WS error: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5)


def parse_dhan_binary(raw: bytes) -> Optional[dict]:
    """Parse minimal Dhan binary feed packets for ticker and quote.

    Returns a dict similar to Dhan v2 JSON 'data' payload:
    { 'securityId': '...', 'LTP': ..., 'BidPrice': ..., 'AskPrice': ..., 'volume': ..., 'timestamp': ... }
    """
    try:
        # Need at least 8 bytes for header
        if len(raw) < 8:
            return None
        # Header: byte0 = feed response code (uint8)
        # bytes1-2 = message length (uint16 little endian)
        # byte3 = exchange segment (uint8)
        # bytes4-7 = security id (int32 little endian)
        feed_code = struct.unpack_from("<B", raw, 0)[0]
        msg_len = struct.unpack_from("<H", raw, 1)[0]
        exch_seg = struct.unpack_from("<B", raw, 3)[0]
        security_id = struct.unpack_from("<I", raw, 4)[0]

        # Ticker packet (code 2): next 4 bytes float32 LTP, next 4 bytes int32 timestamp
        if feed_code == 2 and len(raw) >= 8 + 8:
            ltp = struct.unpack_from("<f", raw, 8)[0]
            ts = struct.unpack_from("<I", raw, 12)[0]
            return {
                "type": "ticker",
                "data": {
                    "securityId": str(security_id),
                    "LTP": float(ltp),
                    "timestamp": int(ts) * 1000 if ts and ts < 1e12 else int(ts),
                },
            }

        # Quote packet (code 4): LTP, LTQ, LTT, ATP, Volume, SellQty, BuyQty, Open, Close, High, Low
        # Per Dhan docs: Quote packet = 8-byte header + 42-byte payload (total 50 bytes). NO OI here.
        # OI is sent as a SEPARATE packet (code 5).
        if feed_code == 4 and len(raw) >= 50:
            offset = 8
            ltp = struct.unpack_from("<f", raw, offset)[0]; offset += 4
            ltq = struct.unpack_from("<h", raw, offset)[0]; offset += 2  # int16
            ltt = struct.unpack_from("<I", raw, offset)[0]; offset += 4
            atp = struct.unpack_from("<f", raw, offset)[0]; offset += 4
            volume = struct.unpack_from("<I", raw, offset)[0]; offset += 4
            total_sell_qty = struct.unpack_from("<I", raw, offset)[0]; offset += 4
            total_buy_qty = struct.unpack_from("<I", raw, offset)[0]; offset += 4
            day_open = struct.unpack_from("<f", raw, offset)[0]; offset += 4
            day_close = struct.unpack_from("<f", raw, offset)[0]; offset += 4
            day_high = struct.unpack_from("<f", raw, offset)[0]; offset += 4
            day_low = struct.unpack_from("<f", raw, offset)[0]

            return {
                "type": "quote",
                "data": {
                    "securityId": str(security_id),
                    "LTP": float(ltp),
                    "LastTradedQty": int(ltq),
                    "LastTradeTime": int(ltt) * 1000 if ltt and ltt < 1e12 else int(ltt),
                    "ATP": float(atp),
                    "volume": int(volume),
                    "totalSellQty": int(total_sell_qty),
                    "totalBuyQty": int(total_buy_qty),
                    "DayOpen": float(day_open),
                    "DayClose": float(day_close),
                    "DayHigh": float(day_high),
                    "DayLow": float(day_low),
                    "openInterest": None,  # OI comes via code 5 packet
                },
            }

        # OI packet (code 5): sent separately when subscribing Quote (code 17)
        # Per Dhan docs: 8-byte header + 4 bytes int32 OI
        if feed_code == 5 and len(raw) >= 12:
            raw_oi = struct.unpack_from("<I", raw, 8)[0]
            oi = float(raw_oi) if 0 < raw_oi <= 500_000_000 else None
            return {
                "type": "oi",
                "data": {
                    "securityId": str(security_id),
                    "openInterest": oi,
                },
            }

        # Other feed codes not handled here
        return None
    except Exception as e:
        logger.error(f"Binary parse error: {e}")
        return None


async def handle_dhan_tick(msg: dict):
    """Parse Dhan tick message and feed into engines.
    Handles type 'quote', 'ticker', and 'oi' (separate OI packet from Dhan code 5).
    """
    msg_type = msg.get("type", "")
    data = msg.get("data", msg)
    sid = str(data.get("securityId", data.get("SecurityId", "")))

    if not sid:
        return

    # Find symbol for this security_id
    symbol = None
    for sym, info in subscribed_symbols.items():
        if str(info.get("security_id", "")) == sid:
            symbol = sym
            break

    if not symbol or symbol not in engines:
        return

    # OI-only packet: update OI and mark dirty; batch broadcaster will send update
    if msg_type == "oi":
        oi_val = data.get("openInterest")
        if oi_val is not None:
            engines[symbol].update_oi(float(oi_val))
            _dirty_symbols.add(symbol)
        return

    ltp = float(data.get("LTP", data.get("ltp", 0)))
    bid = float(data.get("BidPrice", data.get("bidPrice", 0)))
    ask = float(data.get("AskPrice", data.get("askPrice", 0)))
    ltq = float(data.get("LastTradedQty", data.get("LTQ", 1)))
    cumulative_vol = data.get("volume", data.get("Volume"))
    if cumulative_vol is not None:
        cumulative_vol = float(cumulative_vol)
    total_buy = data.get("totalBuyQty", data.get("total_buy_quantity"))
    total_sell = data.get("totalSellQty", data.get("total_sell_quantity"))
    if total_buy is not None:
        total_buy = float(total_buy)
    if total_sell is not None:
        total_sell = float(total_sell)
    ts = int(data.get("timestamp", data.get("LastTradeTime", time.time() * 1000)))

    if ltp <= 0:
        return

    oi = data.get("openInterest")
    if oi is not None:
        oi = float(oi)

    engines[symbol].process_tick(ltp, bid, ask, ltq, ts,
                                 cumulative_volume=cumulative_vol,
                                 total_buy_qty=total_buy,
                                 total_sell_qty=total_sell,
                                 oi=oi)

    # Mark symbol dirty; batch_broadcaster_task sends one combined msg every BATCH_INTERVAL
    _dirty_symbols.add(symbol)

    # Periodic gc to prevent memory drift over 24h
    global _tick_counter
    _tick_counter += 1
    if _tick_counter % GC_INTERVAL_TICKS == 0:
        gc.collect()


async def demo_feed_task():
    """Generate synthetic ticks for demo/testing when no credentials."""
    import random

    logger.info("Running in DEMO mode with synthetic data")
    _base_prices = {"NIFTY": 24500.0, "BANKNIFTY": 52000.0, "FINNIFTY": 21500.0, "MIDCPNIFTY": 12500.0}
    prices = {}
    _cycle = 0

    while True:
        syms = list(engines.keys())
        if not syms:
            await asyncio.sleep(1)
            continue
        # Rotate: update ~40 symbols per cycle to avoid overwhelming clients
        batch = 40
        start = (_cycle * batch) % len(syms)
        subset = [syms[(start + i) % len(syms)] for i in range(min(batch, len(syms)))]
        _cycle += 1

        for symbol in subset:
            if symbol not in prices:
                base = next((b for b in _base_prices if b in symbol.upper()), None)
                prices[symbol] = _base_prices.get(base, 1000.0)

            ltp = prices[symbol] + random.gauss(0, 5)
            ltp = round(ltp * 20) / 20
            prices[symbol] = ltp
            bid, ask = ltp - 0.5, ltp + 0.5
            vol = random.randint(50, 500)
            ts = int(time.time() * 1000)
            engines[symbol].process_tick(ltp, bid, ask, vol, ts)
            _dirty_symbols.add(symbol)

        await asyncio.sleep(0.25)


async def batch_broadcaster_task():
    """Send one batched WebSocket message every BATCH_INTERVAL containing all updated symbols.
    Replaces per-symbol broadcast_state calls — collapses thousands of individual sends/sec
    into ~20 messages/sec per client regardless of how many symbols are ticking simultaneously.
    """
    while True:
        await asyncio.sleep(BATCH_INTERVAL)
        if not connected_clients or not _dirty_symbols:
            continue

        # Drain dirty set atomically
        to_send = _dirty_symbols.copy()
        _dirty_symbols.clear()

        # Build batch payload: symbol → lite state (no levels; ~200KB total vs 30MB+ with levels)
        batch_data = {}
        for sym in to_send:
            if sym in engines:
                batch_data[sym] = engines[sym].get_state_lite()

        if not batch_data:
            continue

        msg = _dumps({"type": "batch", "data": batch_data})

        dead = set()
        for ws in connected_clients:
            try:
                await ws.send_text(msg)
            except Exception:
                dead.add(ws)
        connected_clients.difference_update(dead)


# ─────────────────────────────────────────────
# REST Endpoints
# ─────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "symbols": list(engines.keys()),
        "demo": not bool(DHAN_ACCESS_TOKEN),
        "reset_date": _last_reset_date,
        "clients": len(connected_clients),
        "reconnect_backoff_sec": _dhan_reconnect_delay,
    }


@app.get("/api/disk")
def disk_info():
    """Show what's stored on the Render Disk — useful for verifying data persistence."""
    if not os.path.isdir(SNAPSHOT_DIR):
        return {"mounted": False, "path": SNAPSHOT_DIR, "files": []}
    files = []
    total_bytes = 0
    for fname in sorted(os.listdir(SNAPSHOT_DIR)):
        if not (fname.endswith(".jsonl") or fname.endswith(".json")):
            continue
        fpath = os.path.join(SNAPSHOT_DIR, fname)
        try:
            size = os.path.getsize(fpath)
            total_bytes += size
            # Count lines (= candles) for JSONL files
            candle_count = None
            if fname.endswith(".jsonl"):
                with open(fpath) as fh:
                    candle_count = sum(1 for ln in fh if ln.strip())
            files.append({
                "file": fname,
                "size_kb": round(size / 1024, 1),
                "candles": candle_count,
            })
        except Exception:
            pass
    return {
        "mounted": True,
        "path": SNAPSHOT_DIR,
        "total_files": len(files),
        "total_size_kb": round(total_bytes / 1024, 1),
        "files": files,
    }


@app.get("/api/disk/dates")
def disk_dates():
    """Report date range per symbol (first/last candle IST date). Use to verify e.g. 19th March data."""
    if not os.path.isdir(SNAPSHOT_DIR):
        return {"mounted": False, "path": SNAPSHOT_DIR, "symbols": []}
    symbols = []
    for fname in sorted(os.listdir(SNAPSHOT_DIR)):
        if not fname.endswith(".jsonl") or fname.endswith(".depth.jsonl"):
            continue
        symbol = fname.replace(".jsonl", "")
        fpath = os.path.join(SNAPSHOT_DIR, fname)
        first_date = last_date = None
        count = 0
        try:
            with open(fpath) as fh:
                for ln in fh:
                    ln = ln.strip()
                    if not ln:
                        continue
                    c = _loads(ln)
                    ot = c.get("open_time")
                    if ot is None:
                        continue
                    count += 1
                    d = _ist_date_str_from_ms(int(ot))
                    if first_date is None:
                        first_date = d
                    last_date = d
        except Exception:
            pass
        if first_date and last_date:
            symbols.append({"symbol": symbol, "first_date": first_date, "last_date": last_date, "candles": count})
    return {"mounted": True, "path": SNAPSHOT_DIR, "symbols": symbols}


@app.get("/api/settings")
def get_settings():
    return {"candle_seconds": CANDLE_SECONDS, "candle_options": CANDLE_OPTIONS}


def _resolve_depth_symbol(symbol: str) -> Optional[str]:
    """Resolve to a concrete symbol key (for partial match like NIFTY -> NIFTY25MARFUT)."""
    symbol = symbol.upper()
    if symbol in depth_snapshots:
        return symbol
    for key in depth_snapshots:
        if symbol in key.upper():
            return key
    # Try disk: any .depth.jsonl file whose name contains symbol
    if os.path.isdir(DEPTH_DIR):
        for fname in os.listdir(DEPTH_DIR):
            if fname.endswith(".depth.jsonl") and symbol in fname.upper():
                return fname.replace(".depth.jsonl", "")
    return None


@app.get("/api/heatmap/{symbol}")
def get_heatmap(symbol: str, n: int = 300):
    """Return last *n* depth snapshots for the given index-future symbol.
    Uses in-RAM cache when n <= cache size; otherwise pulls from disk to save RAM.
    """
    resolved = _resolve_depth_symbol(symbol)
    if not resolved:
        return {"symbol": symbol.upper(), "snapshots": []}
    snaps = depth_snapshots.get(resolved)
    n = min(n, HEATMAP_SNAPSHOTS)
    if snaps and n <= len(snaps):
        return {"symbol": resolved, "snapshots": list(snaps)[-n:]}
    # Pull from disk when n > RAM cache or no in-memory data
    from_disk = _load_depth_from_disk(resolved, n)
    if from_disk:
        return {"symbol": resolved, "snapshots": from_disk}
    if snaps:
        return {"symbol": resolved, "snapshots": list(snaps)[-n:]}
    return {"symbol": resolved, "snapshots": []}


def _resolve_index(symbol: str) -> Optional[str]:
    """Return canonical index name. Check longer names first (BANKNIFTY before NIFTY, BANKEX before SENSEX)."""
    s = symbol.upper()
    for idx_name in ("BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTY", "BANKEX", "SENSEX50", "SENSEX"):
        if idx_name in s:
            return idx_name
    return None


async def _fetch_expiry_list(index_name: str) -> list:
    """Fetch available expiry dates for an index from Dhan and cache them."""
    if not DHAN_TOKEN_OPTIONS:
        return []
    uid = UNDERLYING_IDS.get(index_name, "")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            seg = UNDERLYING_SEG_MAP.get(index_name, UNDERLYING_SEG)
            resp = await client.post(
                f"{DHAN_API_BASE}/optionchain/expirylist",
                headers={
                    "access-token": DHAN_TOKEN_OPTIONS,
                    "client-id":    DHAN_CLIENT_ID,
                    "Content-Type": "application/json",
                    "Accept":       "application/json",
                },
                json={"UnderlyingScrip": int(uid), "UnderlyingSeg": seg},
            )
            if not resp.is_success:
                logger.warning(f"Expiry list {resp.status_code} [{index_name}]: {resp.text[:200]}")
                return []
            data = resp.json()
        expiries = data.get("data", [])
        if expiries:
            expiry_list_cache[index_name] = expiries
            logger.info(f"Expiry list [{index_name}]: {len(expiries)} dates")
        return expiries
    except Exception as e:
        logger.warning(f"Expiry list error [{index_name}]: {e}")
        return []


async def _default_expiry_from_api(index_name: str) -> str:
    """Get default expiry for an index by fetching from Dhan API.
    Returns first expiry date >= today, or first in list if none in future.
    """
    expiries = expiry_list_cache.get(index_name)
    if not expiries:
        expiries = await _fetch_expiry_list(index_name)
    if not expiries:
        return ""  # fallback: caller must handle
    today_str = date.today().strftime("%Y-%m-%d")
    for exp in expiries:
        if exp >= today_str:
            return exp
    return expiries[0]  # all past — use nearest (first)


@app.get("/api/gex/{symbol}/expiries")
async def get_expiries(symbol: str):
    """Return available option expiry dates for a NIFTY/BANKNIFTY index.
    Refreshes from Dhan each call (cached for 5 min server-side).
    """
    idx = _resolve_index(symbol)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {symbol}"}, 400)

    cached = expiry_list_cache.get(idx)
    if cached:
        return {"index": idx, "expiries": cached}

    expiries = await _fetch_expiry_list(idx)
    if not expiries:
        return JSONResponse({"error": "Could not fetch expiries — check DHAN_TOKEN_OPTIONS"}, 202)
    return {"index": idx, "expiries": expiries}


@app.get("/api/gex/{symbol}")
async def get_gex(symbol: str, expiry: str = ""):
    """Return GEX data for a NIFTY / BANKNIFTY index.
    Optional query param: ?expiry=YYYY-MM-DD  (defaults to nearest weekly expiry).
    If the requested expiry is not in cache yet, fetches it on-demand.
    """
    idx = _resolve_index(symbol)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {symbol}"}, 400)

    target_expiry = expiry.strip() or await _default_expiry_from_api(idx)
    if not target_expiry:
        return JSONResponse({"error": "Could not fetch expiry list — check DHAN_TOKEN_OPTIONS"}, 202)
    cache_key = f"{idx}:{target_expiry}"

    data = gex_cache.get(cache_key)
    if data:
        return data

    # Not in cache — fetch on-demand (user selected a different expiry)
    if DHAN_TOKEN_OPTIONS:
        ok = await _fetch_gex_once(idx, UNDERLYING_IDS[idx], target_expiry)
        if ok:
            return gex_cache.get(cache_key, {})

    return JSONResponse({"error": "GEX data not available — check DHAN_TOKEN_OPTIONS"}, 202)


@app.get("/api/gex")
def list_gex():
    """Return GEX for all cached index:expiry combinations."""
    return {k: v for k, v in gex_cache.items()}


@app.get("/api/sentiment/{symbol}")
async def get_sentiment(symbol: str):
    """Return Nifty options sentiment: scorecard, strike map, overall signal.

    Requires DHAN_TOKEN_OPTIONS. Data comes from options chain poll.
    """
    idx = _resolve_index(symbol)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {symbol}"}, 400)
    data = sentiment_cache.get(idx)
    if data:
        return data
    # Try to compute on-demand from gex_cache
    expiry = await _default_expiry_from_api(idx)
    if expiry:
        cache_key = f"{idx}:{expiry}"
        gex_data = gex_cache.get(cache_key)
        if gex_data:
            _compute_and_store_sentiment(idx, cache_key)
            return sentiment_cache.get(idx, {})
    token_hint = "" if DHAN_TOKEN_OPTIONS else " — set DHAN_TOKEN_OPTIONS to enable"
    return JSONResponse(
        {"error": f"No sentiment data yet{token_hint}"},
        status_code=202,
    )


@app.get("/api/sentiment/{symbol}/history")
def get_sentiment_history(symbol: str):
    """Return time-series of sentiment scores for charting."""
    idx = _resolve_index(symbol)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {symbol}"}, 400)
    return {"symbol": idx, "series": sentiment_history.get(idx, [])}


@app.get("/api/sentiment/status")
def get_sentiment_status():
    """Return poller status and last update time per index."""
    status = {}
    for idx in UNDERLYING_IDS:
        data = sentiment_cache.get(idx)
        if data:
            status[idx] = {"last_update": data.get("computed_at"), "score": data.get("score")}
    return {"indices": status}


@app.post("/api/sentiment/train")
async def train_sentiment_ml(index: str = "NIFTY"):
    """Trigger ML model training. Uses EOD snapshots or Dhan rolling option. Runs async."""
    from ml_sentiment import train_and_save
    ok = await train_and_save(index)
    return {"ok": ok, "index": index}


def _recompute_flows_from_strikes_raw(series: list, index_name: str, conviction: str) -> list:
    """Re-compute flows from strikes_raw using percentile-derived thresholds.
    conviction: 'high' | 'medium'. Returns series with updated flows per snap.
    """
    snaps_with_raw = [s for s in series if (s.get("strikes_raw") or {}) and any(
        (r.get("ce_ltp_chg") is not None or r.get("pe_ltp_chg") is not None)
        for r in (s.get("strikes_raw") or {}).values()
    )]
    if len(snaps_with_raw) < 10:
        return series

    ce_oi_chg, pe_oi_chg = [], []
    ce_ltp_chg, pe_ltp_chg = [], []
    abs_ltp_chg = []
    ce_vol, pe_vol = [], []
    for snap in snaps_with_raw:
        for r in (snap.get("strikes_raw") or {}).values():
            co = r.get("ce_oi_chg")
            po = r.get("pe_oi_chg")
            if co is not None:
                ce_oi_chg.append(co)
            if po is not None:
                pe_oi_chg.append(po)
            cl = r.get("ce_ltp_chg")
            pl = r.get("pe_ltp_chg")
            if cl is not None:
                ce_ltp_chg.append(cl)
                abs_ltp_chg.append(abs(cl))
            if pl is not None:
                pe_ltp_chg.append(pl)
                abs_ltp_chg.append(abs(pl))
            cv = r.get("ce_vol")
            pv = r.get("pe_vol")
            if cv is not None:
                ce_vol.append(cv)
            if pv is not None:
                pe_vol.append(pv)

    def _p(arr: list, p: float) -> float:
        arr = [x for x in arr if x is not None and not (isinstance(x, float) and math.isnan(x))]
        return _percentile(arr, p) if arr else 0.0

    is_high = conviction == "high"
    oi_p = 98 if (is_high and index_name == "MIDCPNIFTY") else (90 if is_high else 75)
    oi_chg_pct = max(_p(ce_oi_chg, oi_p), _p(pe_oi_chg, oi_p), 2.0)
    oi_chg_min = _p(ce_oi_chg + pe_oi_chg, 75 if is_high else 50) or 2.0
    ltp_stable_p75 = _p(abs_ltp_chg, 75) if abs_ltp_chg else 1.0
    ltp_stable_p90 = _p(abs_ltp_chg, 90) if abs_ltp_chg else 1.5
    ltp_stable = max(ltp_stable_p75 if is_high else ltp_stable_p90, 1.0)
    ltp_move = max(_p(abs_ltp_chg, 75 if is_high else 50), 1.0)
    ce_vol_p75 = _p(ce_vol, 75)
    pe_vol_p75 = _p(pe_vol, 75)
    ce_vol_p50 = _p(ce_vol, 50)
    pe_vol_p50 = _p(pe_vol, 50)
    ce_vol_p10 = _p(ce_vol, 10)
    pe_vol_p10 = _p(pe_vol, 10)
    ce_vol_min = ce_vol_p75 if is_high else ce_vol_p50
    pe_vol_min = pe_vol_p75 if is_high else pe_vol_p50
    if ce_vol_p75 > 500_000:
        ce_vol_min = min(ce_vol_min, 100_000) if ce_vol_min else min(ce_vol_p10, 100_000)
    if pe_vol_p75 > 500_000:
        pe_vol_min = min(pe_vol_min, 100_000) if pe_vol_min else min(pe_vol_p10, 100_000)
    ce_vol_min = max(ce_vol_min or 0, 100)
    pe_vol_min = max(pe_vol_min or 0, 100)

    out = []
    for snap in series:
        raw = snap.get("strikes_raw") or {}
        if not raw:
            out.append(snap)
            continue
        mfi = snap.get("mfi") or 0
        flows = {
            "Aggressive Call Buy": 0.0, "Heavy Call Short": 0.0, "Aggressive Put Buy": 0.0,
            "Heavy Put Write": 0.0, "Dark Pool CE": 0.0, "Dark Pool PE": 0.0,
            "Call Short": 0.0, "Put Write": 0.0,
        }
        for _sk, r in raw.items():
            ce_oi = float(r.get("ce_oi") or 0)
            pe_oi = float(r.get("pe_oi") or 0)
            ce_ltp = float(r.get("ce_ltp") or 0)
            pe_ltp = float(r.get("pe_ltp") or 0)
            ce_act = ce_oi * ce_ltp
            pe_act = pe_oi * pe_ltp
            co_chg = float(r.get("ce_oi_chg") or 0)
            po_chg = float(r.get("pe_oi_chg") or 0)
            cl_chg = float(r.get("ce_ltp_chg") or 0)
            pl_chg = float(r.get("pe_ltp_chg") or 0)
            cv = float(r.get("ce_vol") or 0)
            pv = float(r.get("pe_vol") or 0)

            if ce_act > 0:
                if co_chg > oi_chg_pct and abs(cl_chg) < ltp_stable and cv > ce_vol_min:
                    flows["Dark Pool CE"] += ce_act
                elif cl_chg > ltp_move and mfi > HFT_MFI_OVERBOUGHT and cv > ce_vol_min:
                    flows["Aggressive Call Buy"] += ce_act
                elif co_chg > oi_chg_pct and cl_chg < -ltp_move and mfi < HFT_MFI_OVERSOLD:
                    flows["Heavy Call Short"] += ce_act
                elif cl_chg < -1 and co_chg > oi_chg_min:
                    flows["Call Short"] += ce_act

            if pe_act > 0:
                if po_chg > oi_chg_pct and abs(pl_chg) < ltp_stable and pv > pe_vol_min:
                    flows["Dark Pool PE"] += pe_act
                elif pl_chg > ltp_move and mfi < HFT_MFI_OVERSOLD and pv > pe_vol_min:
                    flows["Aggressive Put Buy"] += pe_act
                elif po_chg > oi_chg_pct and pl_chg < -ltp_move and mfi > HFT_MFI_OVERBOUGHT:
                    flows["Heavy Put Write"] += pe_act
                elif pl_chg < -1 and po_chg > oi_chg_min:
                    flows["Put Write"] += pe_act

        new_snap = {**snap, "flows": {k: round(v, 2) for k, v in flows.items() if v > 0}}
        out.append(new_snap)
    return out


@app.get("/api/hft_scanner/{symbol}")
async def get_hft_scanner(symbol: str, conviction: str = ""):
    """Return HFT scanner time-series for a NIFTY / BANKNIFTY index.

    Query: ?conviction=medium|high — re-compute flows from percentiles. Omit for stored flows.
    Response: { symbol, spot, updated_at, series: [{t, ts, spot, mfi, flows}] }
    """
    idx = _resolve_index(symbol)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {symbol}"}, status_code=400)

    history = list(hft_scanner_history.get(idx, []))
    if not history:
        history = _load_hft_from_disk(idx)
        if history:
            hft_scanner_history[idx] = history
    if not history:
        token_hint = "" if DHAN_TOKEN_OPTIONS else " — set DHAN_TOKEN_OPTIONS to enable"
        return JSONResponse(
            {"symbol": idx, "series": [], "error": f"No HFT scanner data yet{token_hint}"},
            status_code=202,
        )

    if conviction and conviction in ("medium", "high"):
        history = _recompute_flows_from_strikes_raw(history, idx, conviction)

    last = history[-1]
    return {
        "symbol":     idx,
        "spot":       last["spot"],
        "updated_at": last["ts"],
        "series":     history,
    }


@app.get("/api/index_candles/{index}")
async def get_index_candles(index: str):
    """Return 1m index candles (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) from Dhan intraday.
    Spans previous session + today so charts show yesterday after midnight / on Monday.
    Used by HFT chart for price display — index spot, not futures.
    Response: { candles: [{open_time, open, high, low, close, ...}] }
    """
    idx = _resolve_index(index)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {index}"}, status_code=400)

    security_id = UNDERLYING_IDS.get(idx)
    if not security_id:
        return JSONResponse({"error": f"No security ID for {idx}"}, status_code=400)

    today = datetime.now(IST).date()
    y = today - timedelta(days=1)
    while y.weekday() >= 5:
        y -= timedelta(days=1)
    from_date = f"{y} 09:15:00"
    to_date = f"{today} 15:30:00"

    # NSE indices: IDX_I; BSE SENSEX/BANKEX: BSE_IDX
    candle_seg = "BSE_IDX" if idx in UNDERLYING_SEG_MAP else "IDX_I"
    data = await fetch_intraday_ohlcv(
        security_id=security_id,
        exchange_segment=candle_seg,
        instrument="INDEX",
        interval="1",
        from_date=from_date,
        to_date=to_date,
    )
    if not data:
        return JSONResponse(
            {"error": "Could not fetch index candles — check DHAN_TOKEN_OPTIONS"},
            status_code=202,
        )

    # Convert Dhan format (arrays) to our candle format (list of dicts)
    # Dhan returns Unix seconds; chart expects IST-epoch (Unix + 19800) for correct IST display
    IST_OFFSET_SEC = 19800  # UTC+5:30
    opens = data.get("open", [])
    highs = data.get("high", [])
    lows = data.get("low", [])
    closes = data.get("close", [])
    volumes = data.get("volume", [])
    timestamps = data.get("timestamp", [])

    candles = []
    for i in range(min(len(opens), len(closes), len(timestamps))):
        ts = timestamps[i]
        unix_sec = ts / 1000 if ts >= 1e12 else ts
        open_time = int((unix_sec + IST_OFFSET_SEC) * 1000)  # IST-epoch ms for chart
        candles.append({
            "open_time": open_time,
            "open": float(opens[i]) if i < len(opens) else 0,
            "high": float(highs[i]) if i < len(highs) else 0,
            "low": float(lows[i]) if i < len(lows) else 0,
            "close": float(closes[i]) if i < len(closes) else 0,
            "volume": int(volumes[i]) if i < len(volumes) else 0,
            "closed": True,
        })
    candles.sort(key=lambda c: c["open_time"])
    return {"candles": candles}


@app.get("/api/index_ltp/{index}")
async def get_index_ltp(index: str):
    """Return live index LTP (NIFTY, BANKNIFTY, etc.) from Dhan marketfeed.
    Rate limit: 1 req/sec. Used for HFT chart live candle updates."""
    idx = _resolve_index(index)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {index}"}, status_code=400)
    ltp = await fetch_index_ltp(idx)
    if ltp is None:
        return JSONResponse(
            {"error": "Could not fetch index LTP — check DHAN_TOKEN_OPTIONS"},
            status_code=202,
        )
    return {"index": idx, "ltp": ltp}


# Flow types: bullish (positive score) vs bearish (negative score)
# Put writing = bullish; call writing = bearish
_STRIKE_BULLISH_FLOWS = {"Aggressive Call Buy", "Dark Pool CE", "Heavy Put Write", "Put Write"}
_STRIKE_BEARISH_FLOWS = {"Aggressive Put Buy", "Dark Pool PE", "Call Short", "Heavy Call Short"}


def _aggregate_flows(snapshots: list) -> dict:
    """Sum flows across snapshots. Returns dict of flow_name -> total."""
    out: dict = {}
    for snap in snapshots:
        for k, v in (snap.get("flows") or {}).items():
            out[k] = out.get(k, 0) + v
    return out


def _aggregate_flow_dicts(dicts: list) -> dict:
    """Sum flow values across list of flow dicts. For per-strike aggregation."""
    out: dict = {}
    for d in dicts:
        for k, v in (d or {}).items():
            out[k] = out.get(k, 0) + v
    return out


def _flow_score(flows: dict) -> float:
    """Bullish positive, bearish negative. Normalized by total magnitude."""
    bull = sum(flows.get(k, 0) for k in _STRIKE_BULLISH_FLOWS)
    bear = sum(flows.get(k, 0) for k in _STRIKE_BEARISH_FLOWS)
    total = bull + bear
    if total <= 0:
        return 0.0
    return (bull - bear) / total  # -1 to +1


_STRIKE_ANALYSIS_WINDOWS = (1, 3, 5, 10, 15, 20, 25, 30)


def _raw_oi_ind(chg: float) -> str:
    """Derive bullish/bearish from raw OI change. CE OI up = bullish, PE OI up = bearish."""
    if chg > 0.5:
        return "bullish"
    if chg < -0.5:
        return "bearish"
    return "neutral"


@app.get("/api/strike_analysis_timeseries/{symbol}")
async def get_strike_analysis_timeseries(symbol: str, window: int = 30):
    """Time-series strike data from HFT snapshots (raw OI/LTP/Greeks only, no flow).

    Query: ?window=1|3|5|10|15|20|25|30 (default 30)
    Returns per-minute strikes with CE left, PE right, OI change, Greeks, bullish/bearish.
    """
    if window not in _STRIKE_ANALYSIS_WINDOWS:
        window = 30
    idx = _resolve_index(symbol)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {symbol}"}, status_code=400)

    history = list(hft_scanner_history.get(idx, []))
    if not history:
        history = _load_hft_from_disk(idx)
        if history:
            hft_scanner_history[idx] = history

    has_raw = any((s.get("strikes_raw") or {}) for s in history)
    if DHAN_TOKEN_OPTIONS and (not history or not has_raw):
        expiry = await _default_expiry_from_api(idx)
        if expiry:
            uid = UNDERLYING_IDS.get(idx)
            if uid:
                ok = await _fetch_gex_once(idx, uid, expiry)
                if ok:
                    await asyncio.sleep(4)
                    await _fetch_gex_once(idx, uid, expiry)
                history = list(hft_scanner_history.get(idx, []))
                if not history:
                    history = _load_hft_from_disk(idx)
                    if history:
                        hft_scanner_history[idx] = history

    if not history:
        token_hint = "" if DHAN_TOKEN_OPTIONS else " — set DHAN_TOKEN_OPTIONS to enable"
        return JSONResponse(
            {"symbol": idx, "error": f"No options chain data yet{token_hint}"},
            status_code=202,
        )

    snaps = history[-window:] if len(history) >= window else history
    series_out: list = []

    def _strike_sort_key(x):
        try:
            return float(x)
        except (ValueError, TypeError):
            return 0.0

    prev_raw_map: dict = {}
    for snap in snaps:
        raw = snap.get("strikes_raw") or {}
        if not raw:
            continue
        strikes_list: list = []
        for sk in sorted(raw.keys(), key=_strike_sort_key):
            r = raw[sk]
            ce_oi = r.get("ce_oi") or 0
            pe_oi = r.get("pe_oi") or 0
            prev = prev_raw_map.get(sk, {})
            ce_oi_prev = prev.get("ce_oi") or 0
            pe_oi_prev = prev.get("pe_oi") or 0
            ce_chg = r.get("ce_oi_chg")
            if ce_chg is None and ce_oi_prev:
                ce_chg = (ce_oi - ce_oi_prev) / ce_oi_prev * 100
            ce_chg = ce_chg or 0
            pe_chg = r.get("pe_oi_chg")
            if pe_chg is None and pe_oi_prev:
                pe_chg = (pe_oi - pe_oi_prev) / pe_oi_prev * 100
            pe_chg = pe_chg or 0
            prev_raw_map[sk] = r
            strikes_list.append({
                "strike":   float(sk),
                "ce_oi":    r.get("ce_oi") or 0,
                "pe_oi":    r.get("pe_oi") or 0,
                "ce_ltp":   r.get("ce_ltp") or 0,
                "pe_ltp":   r.get("pe_ltp") or 0,
                "ce_iv":    r.get("ce_iv") or 0,
                "pe_iv":    r.get("pe_iv") or 0,
                "ce_delta": r.get("ce_delta") or 0,
                "pe_delta": r.get("pe_delta") or 0,
                "ce_gamma": r.get("ce_gamma") or 0,
                "pe_gamma": r.get("pe_gamma") or 0,
                "ce_theta": r.get("ce_theta") or 0,
                "pe_theta": r.get("pe_theta") or 0,
                "ce_vega":  r.get("ce_vega") or 0,
                "pe_vega":  r.get("pe_vega") or 0,
                "ce_oi_chg": ce_chg,
                "pe_oi_chg": pe_chg,
                "ce_ind":   _raw_oi_ind(ce_chg),
                "pe_ind":   _raw_oi_ind(pe_chg),
            })
        series_out.append({
            "ts":      snap.get("ts", 0),
            "t":       snap.get("t", ""),
            "spot":    snap.get("spot", 0),
            "strikes": strikes_list,
        })

    return {
        "symbol": idx,
        "spot":   snaps[-1]["spot"] if snaps else 0,
        "series": series_out,
    }


def _percentile(vals: list, p: float) -> float:
    """Return pth percentile (0-100). Uses linear interpolation."""
    if not vals:
        return 0.0
    vals = sorted(v for v in vals if v is not None and not (isinstance(v, float) and math.isnan(v)))
    if not vals:
        return 0.0
    k = (len(vals) - 1) * p / 100
    f = int(math.floor(k))
    c = int(math.ceil(k))
    if f == c:
        return float(vals[f])
    return float(vals[f]) + (k - f) * (vals[c] - vals[f])


@app.get("/api/strike_calibration/{symbol}")
async def get_strike_calibration(symbol: str, window: int = 120):
    """Calibration from HFT snapshots on disk/RAM. Returns percentiles and suggested cutoffs.

    Query: ?window=60|120|240 (default 120 = last 2 hours)
    Use the suggested cutoffs to refine HFT flow formula parameters.
    """
    idx = _resolve_index(symbol)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {symbol}"}, status_code=400)

    history = list(hft_scanner_history.get(idx, []))
    if not history:
        history = _load_hft_from_disk(idx)
        if history:
            hft_scanner_history[idx] = history

    if not history:
        return JSONResponse(
            {"symbol": idx, "error": "No HFT data on disk. Run options poller to collect data."},
            status_code=202,
        )

    snaps = history[-min(window, len(history)):]
    ce_oi_chg: list = []
    pe_oi_chg: list = []
    ce_ltp_chg: list = []
    pe_ltp_chg: list = []
    ce_vol: list = []
    pe_vol: list = []

    prev_raw: dict = {}
    for snap in snaps:
        raw = snap.get("strikes_raw") or {}
        for sk, r in raw.items():
            ce_oi_chg.append(r.get("ce_oi_chg"))
            pe_oi_chg.append(r.get("pe_oi_chg"))
            ce_vol.append(r.get("ce_vol"))
            pe_vol.append(r.get("pe_vol"))
            prev = prev_raw.get(sk, {})
            ce_ltp, pe_ltp = r.get("ce_ltp") or 0, r.get("pe_ltp") or 0
            ce_ltp_prev, pe_ltp_prev = prev.get("ce_ltp") or 0, prev.get("pe_ltp") or 0
            if ce_ltp_prev:
                ce_ltp_chg.append((ce_ltp - ce_ltp_prev) / ce_ltp_prev * 100)
            if pe_ltp_prev:
                pe_ltp_chg.append((pe_ltp - pe_ltp_prev) / pe_ltp_prev * 100)
            prev_raw[sk] = r

    def _stats(arr: list, exclude_zero: bool = False, p10: bool = False) -> dict:
        arr = [x for x in arr if x is not None and not (isinstance(x, float) and math.isnan(x))]
        if exclude_zero:
            arr = [x for x in arr if abs(x) > 0.01]
        if not arr:
            return {"n": 0, "min": 0, "p10": 0, "p25": 0, "p50": 0, "p75": 0, "p90": 0, "max": 0}
        out = {
            "n": len(arr),
            "min": round(min(arr), 2),
            "p25": round(_percentile(arr, 25), 2),
            "p50": round(_percentile(arr, 50), 2),
            "p75": round(_percentile(arr, 75), 2),
            "p90": round(_percentile(arr, 90), 2),
            "max": round(max(arr), 2),
        }
        if p10:
            out["p10"] = round(_percentile(arr, 10), 0) if arr else 0
        return out

    ce_oi_st = _stats(ce_oi_chg, exclude_zero=True)
    pe_oi_st = _stats(pe_oi_chg, exclude_zero=True)
    ce_ltp_st = _stats(ce_ltp_chg)
    pe_ltp_st = _stats(pe_ltp_chg)
    ce_vol_st = _stats(ce_vol, p10=True)
    pe_vol_st = _stats(pe_vol, p10=True)

    # OI_CHG: use p75 of non-zero values; never return 0 (min 3.0)
    oi_chg_p75 = (ce_oi_st["p75"] + pe_oi_st["p75"]) / 2 if (ce_oi_st["n"] or pe_oi_st["n"]) else 0
    hft_oi_chg = round(max(oi_chg_p75, 3.0), 1)

    # LTP_STABLE: use p25 of abs(LTP_CHG); fallback 1.5
    ltp_p25 = max(abs(ce_ltp_st.get("p25", 0)), abs(pe_ltp_st.get("p25", 0)))
    hft_ltp_stable = round(max(ltp_p25, 1.0), 1) if (ce_ltp_st["n"] or pe_ltp_st["n"]) else 1.5

    # VOL: index-specific. Dhan = cumulative daily; p25 can be millions for NIFTY. Use p10 when < 500K.
    _vol_defaults = {"NIFTY": (100_000, 100_000), "BANKNIFTY": (20_000, 20_000), "FINNIFTY": (1_000, 5_000), "MIDCPNIFTY": (10_000, 50_000)}
    def_ce, def_pe = _vol_defaults.get(idx, (50_000, 50_000))
    ce_arr = [x for x in ce_vol if x is not None]
    pe_arr = [x for x in pe_vol if x is not None]
    ce_p10 = _percentile(ce_arr, 10) if ce_arr else 0
    pe_p10 = _percentile(pe_arr, 10) if pe_arr else 0
    hft_ce_vol = int(min(ce_p10, 500_000)) if ce_p10 and ce_p10 < 500_000 else def_ce
    hft_pe_vol = int(min(pe_p10, 500_000)) if pe_p10 and pe_p10 < 500_000 else def_pe
    hft_ce_vol = max(hft_ce_vol, 500)
    hft_pe_vol = max(hft_pe_vol, 500)

    return {
        "symbol": idx,
        "snapshots_used": sum(1 for snap in snaps if (snap.get("strikes_raw") or {})),
        "stats": {
            "ce_oi_chg": ce_oi_st,
            "pe_oi_chg": pe_oi_st,
            "ce_ltp_chg": ce_ltp_st,
            "pe_ltp_chg": pe_ltp_st,
            "ce_vol": ce_vol_st,
            "pe_vol": pe_vol_st,
        },
        "suggested_cutoffs": {
            "HFT_OI_CHG_PCT": hft_oi_chg,
            "HFT_LTP_STABLE_PCT": hft_ltp_stable,
            "HFT_CE_VOL_MIN": hft_ce_vol,
            "HFT_PE_VOL_MIN": hft_pe_vol,
        },
        "copy_paste": (
            f"# Suggested from {idx} calibration (n={ce_oi_st['n']}+{pe_oi_st['n']} OI samples)\n"
            f"# VOL: NIFTY ~lakhs/min; Dhan returns cumulative daily — 1L = 100000\n"
            f"HFT_OI_CHG_PCT={hft_oi_chg}\n"
            f"HFT_LTP_STABLE_PCT={hft_ltp_stable}\n"
            f"HFT_CE_VOL_MIN={hft_ce_vol}\n"
            f"HFT_PE_VOL_MIN={hft_pe_vol}\n"
        ),
    }


@app.get("/api/strike_analysis/{symbol}")
async def get_strike_analysis(symbol: str, window: int = 5):
    """Compare current vs previous N-minute options flow for bullish/bearish indication.

    Query: ?window=5|10|15|20|25|30 (default 5)
    Uses HFT scanner history. Returns aggregated flows, score (-1 to +1), and per-strike data.
    """
    if window not in _STRIKE_ANALYSIS_WINDOWS:
        window = 5
    idx = _resolve_index(symbol)
    if not idx:
        return JSONResponse({"error": f"Unknown index: {symbol}"}, status_code=400)

    history = list(hft_scanner_history.get(idx, []))
    if not history:
        history = _load_hft_from_disk(idx)
        if history:
            hft_scanner_history[idx] = history

    # On-demand fetch from Dhan options API when no history or no strike-level data
    has_strike_flows = any((s.get("strike_flows") or {}) for s in history)
    if DHAN_TOKEN_OPTIONS and (not history or not has_strike_flows):
        expiry = await _default_expiry_from_api(idx)
        if expiry:
            uid = UNDERLYING_IDS.get(idx)
            if uid:
                ok = await _fetch_gex_once(idx, uid, expiry)
                if ok:
                    await asyncio.sleep(4)  # Dhan rate limit ~1 req/3s
                    await _fetch_gex_once(idx, uid, expiry)
                history = list(hft_scanner_history.get(idx, []))
                if not history:
                    history = _load_hft_from_disk(idx)
                    if history:
                        hft_scanner_history[idx] = history

    if not history:
        token_hint = "" if DHAN_TOKEN_OPTIONS else " — set DHAN_TOKEN_OPTIONS to enable"
        return JSONResponse(
            {"symbol": idx, "error": f"No options chain data yet{token_hint}"},
            status_code=202,
        )

    n = min(window, len(history))
    if n == 0:
        return {"symbol": idx, "window_minutes": window, "current": {}, "previous": {}, "delta": {}, "score": 0, "indication": "neutral", "strikes": []}

    current_snaps = history[-n:]
    previous_snaps = history[-2 * n : -n] if len(history) >= 2 * n else []

    current_flows = _aggregate_flows(current_snaps)
    previous_flows = _aggregate_flows(previous_snaps)

    delta = {}
    all_keys = set(current_flows) | set(previous_flows)
    for k in all_keys:
        d = current_flows.get(k, 0) - previous_flows.get(k, 0)
        if d != 0:
            delta[k] = round(d, 2)

    score_current = _flow_score(current_flows)
    score_previous = _flow_score(previous_flows)
    score_delta = score_current - score_previous
    score = max(-1.0, min(1.0, score_delta))

    if score > 0.1:
        indication = "bullish"
    elif score < -0.1:
        indication = "bearish"
    else:
        indication = "neutral"

    # ── Phase 2: per-strike bullish/bearish (flow-based or raw OI fallback) ─────
    strikes_out: list = []
    all_strike_keys: set = set()
    for snap in current_snaps + previous_snaps:
        all_strike_keys.update((snap.get("strike_flows") or {}).keys())
        all_strike_keys.update((snap.get("strikes_raw") or {}).keys())
    def _strike_sort_key(x):
        try:
            return float(x)
        except (ValueError, TypeError):
            return 0.0

    for sk in sorted(all_strike_keys, key=_strike_sort_key):
        cur_raw = (current_snaps[-1].get("strikes_raw") or {}).get(sk, {}) if current_snaps else {}
        prev_raw = (previous_snaps[-1].get("strikes_raw") or {}).get(sk, {}) if previous_snaps else {}
        # 1) Try flow-based (strike_flows)
        cur_dicts = [s.get("strike_flows", {}).get(sk, {}) for s in current_snaps]
        prev_dicts = [s.get("strike_flows", {}).get(sk, {}) for s in previous_snaps]
        cur_f = _aggregate_flow_dicts(cur_dicts)
        prev_f = _aggregate_flow_dicts(prev_dicts)
        use_flows = bool(cur_f or prev_f)

        if use_flows:
            sc_cur = _flow_score(cur_f)
            sc_prev = _flow_score(prev_f)
            sc_d = sc_cur - sc_prev
            sc = max(-1.0, min(1.0, sc_d))
            strike_delta = {k: round(cur_f.get(k, 0) - prev_f.get(k, 0), 2) for k in set(cur_f) | set(prev_f) if cur_f.get(k, 0) != prev_f.get(k, 0)}
            source = "flow"
        else:
            # 2) Fallback: raw OI change (CE_OI up = bullish, PE_OI up = bearish)
            if not cur_raw and not prev_raw:
                continue
            ce_oi_cur = cur_raw.get("ce_oi", 0) or 0
            pe_oi_cur = cur_raw.get("pe_oi", 0) or 0
            ce_oi_prev = prev_raw.get("ce_oi", 0) or 0
            pe_oi_prev = prev_raw.get("pe_oi", 0) or 0
            if not prev_raw or (ce_oi_prev == 0 and pe_oi_prev == 0):
                sc = 0.0
                ce_chg = pe_chg = 0.0
            else:
                ce_chg = (ce_oi_cur - ce_oi_prev) / (ce_oi_prev or 1) * 100 if ce_oi_prev else 0
                pe_chg = (pe_oi_cur - pe_oi_prev) / (pe_oi_prev or 1) * 100 if pe_oi_prev else 0
                raw_mag = max(abs(ce_chg) + abs(pe_chg), 1)
                sc = max(-1.0, min(1.0, (ce_chg - pe_chg) / raw_mag))
            strike_delta = {"ce_oi_chg": round(ce_chg, 2), "pe_oi_chg": round(pe_chg, 2)}
            source = "raw"

        if sc > 0.1:
            ind = "bullish"
        elif sc < -0.1:
            ind = "bearish"
        else:
            ind = "neutral"

        strikes_out.append({
            "strike":     float(sk),
            "current":    {k: round(v, 2) for k, v in cur_f.items()} if use_flows else {"ce_oi": round(cur_raw.get("ce_oi") or 0, 2), "pe_oi": round(cur_raw.get("pe_oi") or 0, 2)},
            "previous":   {k: round(v, 2) for k, v in prev_f.items()} if use_flows else {"ce_oi": round(prev_raw.get("ce_oi") or 0, 2), "pe_oi": round(prev_raw.get("pe_oi") or 0, 2)},
            "delta":      strike_delta,
            "score":     round(sc, 3),
            "indication": ind,
            "source":    source,
        })

    return {
        "symbol":          idx,
        "window_minutes":  window,
        "current":         {k: round(v, 2) for k, v in current_flows.items()},
        "previous":        {k: round(v, 2) for k, v in previous_flows.items()},
        "delta":           delta,
        "score":           round(score, 3),
        "score_current":   round(score_current, 3),
        "score_previous":  round(score_previous, 3),
        "indication":      indication,
        "spot":            current_snaps[-1]["spot"] if current_snaps else 0,
        "strikes":         strikes_out,
    }


@app.post("/api/token")
async def update_token(payload: dict):
    """Update Dhan access token at runtime — no restart needed.
    Payload: { "access_token": "<new JWT>" }
    Immediately wakes the feed task so it reconnects with the new token.
    """
    global DHAN_ACCESS_TOKEN
    token = (payload.get("access_token") or "").strip()
    if not token:
        raise HTTPException(400, "access_token required")
    DHAN_ACCESS_TOKEN = token
    _dhan_token_event.set()   # wake feed task immediately (cancels backoff sleep)
    logger.info("Dhan access token updated via API. Feed task will reconnect.")
    return {"status": "ok", "message": "Token updated. WebSocket reconnecting."}


@app.post("/api/settings")
async def update_settings(payload: dict):
    """Update candle duration. Payload: { candle_seconds: 60 }"""
    global CANDLE_SECONDS
    sec = int(payload.get("candle_seconds", CANDLE_SECONDS))
    if sec not in CANDLE_OPTIONS:
        raise HTTPException(400, f"candle_seconds must be one of {CANDLE_OPTIONS}")
    CANDLE_SECONDS = sec
    # Reset all engines so new candle boundaries take effect
    for eng in engines.values():
        eng.candles.clear()
        eng.day_candles.clear()
        eng.current_candle = None
    logger.info(f"Candle duration set to {sec} min")
    return {"candle_seconds": CANDLE_SECONDS}


def _resolve_exchange_segment(payload: dict) -> str:
    """Resolve Dhan exchange_segment from payload. Dhan v2: NSE_FO, MCX_COMM, BSE_IDX, etc."""
    seg = payload.get("exchange_segment") or payload.get("segment", "")
    exch = (payload.get("exchange") or "").upper()
    instr = (payload.get("instrument") or "").upper()
    if seg and seg not in ("M", "D", "I", ""):
        return str(seg)
    if exch == "MCX":
        return "MCX_COMM"
    if exch == "BSE" and (seg == "I" or instr == "INDEX"):
        return "BSE_IDX"
    if exch == "BSE":
        return "BSE_FNO"
    return "NSE_FO"


@app.post("/api/subscribe")
async def subscribe(payload: dict):
    """Subscribe to a symbol. payload: {symbol, security_id, exchange_segment, exchange, segment}"""
    symbol = payload.get("symbol", "").upper()
    security_id = str(payload.get("security_id", ""))
    exchange_segment = _resolve_exchange_segment(payload)

    if not symbol or not security_id:
        raise HTTPException(400, "symbol and security_id required")
    if symbol not in engines and len(engines) >= MAX_ENGINES:
        raise HTTPException(503, f"Max symbols ({MAX_ENGINES}) reached. Unsubscribe unused symbols.")
    subscribed_symbols[symbol] = {"security_id": security_id, "exchange_segment": exchange_segment}
    if symbol not in engines:
        engines[symbol] = OrderFlowEngine(symbol, security_id)

    logger.info(f"Subscribed: {symbol} ({security_id})")
    return {"status": "subscribed", "symbol": symbol}


@app.delete("/api/subscribe/{symbol}")
async def unsubscribe(symbol: str):
    symbol = symbol.upper()
    subscribed_symbols.pop(symbol, None)
    engines.pop(symbol, None)
    return {"status": "unsubscribed", "symbol": symbol}


@app.get("/api/symbols")
def get_symbols(q: str = "", exchange: str = ""):
    """Return instruments from stock_list.csv, optionally filtered."""
    import csv
    csv_path = os.path.join(os.path.dirname(__file__), "stock_list.csv")
    if not os.path.exists(csv_path):
        return []
    results = []
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if q and q.upper() not in row.get("symbol", "").upper():
                continue
            if exchange and row.get("exchange", "").upper() != exchange.upper():
                continue
            results.append({
                "symbol": row["symbol"],
                "security_id": row["security_id"],
                "exchange": row.get("exchange", "NSE"),
                "segment": row.get("segment", "D"),
                "instrument": row.get("instrument", "FUTSTK"),
            })
    return results


@app.get("/api/state/{symbol}")
async def get_state(symbol: str):
    """Return full-day state from disk + live candle so early-hours data is preserved.
    Fetches from Dhan intraday when candles < threshold (e.g. after refresh)."""
    symbol = symbol.upper()
    if symbol not in engines:
        raise HTTPException(404, "Symbol not subscribed")
    return await build_full_state(symbol, engines[symbol])


# ─────────────────────────────────────────────
# WebSocket endpoint for frontend
# ─────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    logger.info(f"Client connected. Total: {len(connected_clients)}")

    try:
        # On connect: send lite state for all engines in one small batch message.
        # No price levels — keeps initial payload ≈200KB instead of 30MB+.
        # Full history (with levels) is loaded on demand via request_history.
        initial_batch = {}
        for symbol, engine in list(engines.items()):
            if not engine.candles and engine.current_candle is None:
                continue
            initial_batch[symbol] = engine.get_state_lite()
        if initial_batch:
            await ws.send_text(_dumps({"type": "batch", "data": initial_batch}))

        while True:
            msg = await ws.receive_text()
            try:
                data = _loads(msg)
            except Exception:
                continue

            msg_type = data.get("type")

            if msg_type == "ping":
                await ws.send_text(_dumps({"type": "pong"}))

            elif msg_type == "set_viewing":
                pass  # No-op: batch broadcaster sends all symbols to all clients

            elif msg_type == "request_history":
                # Client asks for full-day disk history for one symbol.
                # Response: {"type": "history", "data": {symbol, ltp, cvd, candles:[400]}}
                symbol = str(data.get("symbol", "")).upper()
                if symbol in engines:
                    try:
                        state = await build_full_state(symbol, engines[symbol])
                        await ws.send_text(_dumps({"type": "history", "data": state}))
                    except Exception as e:
                        logger.warning(f"History request failed [{symbol}]: {e}")

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"WebSocket error: {e}")
    finally:
        connected_clients.discard(ws)
        logger.info(f"Client disconnected. Total: {len(connected_clients)}")


# ─────────────────────────────────────────────
# Startup
# ─────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    # Auto-subscribe instruments from stock_list.csv for NSE FNO and MCX
    def auto_subscribe_from_csv():
        csv_path = os.path.join(os.path.dirname(__file__), "stock_list.csv")
        if not os.path.exists(csv_path):
            logger.warning("stock_list.csv not found; skipping auto-subscribe")
            return
        import csv as _csv

        # Priority: index futures first (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX),
        # then NSE stock futures, then MCX commodities.
        # This ensures the most-watched instruments claim the engine slots first.
        INDEX_KEYWORDS = ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX")
        priority_0: list[tuple] = []   # index futures
        priority_1: list[tuple] = []   # NSE stock futures
        priority_2: list[tuple] = []   # MCX commodities

        try:
            with open(csv_path, newline="") as f:
                reader = _csv.DictReader(f)
                for row in reader:
                    exch = (row.get("exchange") or "").strip().upper()
                    instr = (row.get("instrument") or "").strip().upper()
                    security_id = str(row.get("security_id", "")).strip()
                    symbol = (row.get("symbol") or "").strip().upper()

                    if not security_id or not symbol:
                        continue

                    seg_name = None
                    if exch == "MCX":
                        seg_name = "MCX_COMM"
                    elif exch == "BSE" and ("FUT" in instr or "FUTIDX" in instr):
                        seg_name = "BSE_FNO"
                    elif exch == "NSE" and (
                        "FUT" in instr or "FUTIDX" in instr or "FUTSTK" in instr
                        or row.get("segment", "").upper() == "D"
                    ):
                        seg_name = "NSE_FNO"

                    if not seg_name:
                        continue

                    entry = (symbol, security_id, seg_name)
                    if seg_name == "NSE_FNO" and any(kw in symbol for kw in INDEX_KEYWORDS):
                        priority_0.append(entry)
                    elif seg_name == "BSE_FNO":
                        priority_0.append(entry)  # BSE index futures (SENSEX, BANKEX, SENSEX50)
                    elif seg_name == "NSE_FNO":
                        priority_1.append(entry)
                    else:
                        priority_2.append(entry)

            ordered = priority_0 + priority_1 + priority_2
            count = 0
            for symbol, security_id, seg_name in ordered:
                subscribed_symbols[symbol] = {
                    "security_id": security_id,
                    "exchange_segment": seg_name,
                }
                if symbol not in engines:
                    engines[symbol] = OrderFlowEngine(symbol, security_id)
                    count += 1

            logger.info(
                f"Auto-subscribed all {count} instruments from CSV "
                f"({len(priority_0)} index/BSE futures, {len(priority_1)} NSE stock futures, "
                f"{len(priority_2)} MCX). Each engine holds ≤{MAX_CANDLES_IN_MEMORY} candles in RAM; "
                f"full history is read from disk on demand."
            )
        except Exception as e:
            logger.error(f"Auto-subscribe failed: {e}")

    def _init_index_subscriptions():
        """Subscribe to index live feed: IDX_I (NSE), BSE_IDX (BSE SENSEX/BANKEX)."""
        BSE_INDICES = ("SENSEX", "BANKEX")
        for symbol, security_id in INDEX_LIVE_SYMBOLS:
            seg = "BSE_IDX" if symbol in BSE_INDICES else "IDX_I"
            subscribed_symbols[symbol] = {"security_id": security_id, "exchange_segment": seg}
            if symbol not in engines:
                engines[symbol] = OrderFlowEngine(symbol, security_id)
        logger.info(f"Index live feed: subscribed {[s for s, _ in INDEX_LIVE_SYMBOLS]}")

    _init_index_subscriptions()
    auto_subscribe_from_csv()
    _do_daily_reset()       # sets _last_reset_date = today; clears stale state
    load_all_snapshots()    # restore today's candles from disk (no-op if no disk mounted)
    load_hft_from_disk()    # restore today's HFT scanner history from disk
    load_ml_model()        # load sentiment ML model if trained
    asyncio.create_task(dhan_feed_task())
    asyncio.create_task(_daily_reset_task())
    asyncio.create_task(_post_mcx_cleanup_task())
    asyncio.create_task(_snapshot_task())
    asyncio.create_task(_disk_retry_task())
    asyncio.create_task(_hft_disk_retry_task())
    asyncio.create_task(depth_poller_task())
    asyncio.create_task(options_poller_task())
    asyncio.create_task(batch_broadcaster_task())
    logger.info("OrderFlow Engine started (daily reset at IST midnight, disk snapshots every 5 min)")


# Serve frontend build (for production deployment)
try:
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
except Exception:
    pass  # frontend served separately in dev

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
from typing import Dict, List, Optional, Set
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import httpx
import websockets
import struct

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
MAX_CANDLES_PER_SYMBOL = int(os.getenv("MAX_CANDLES_PER_SYMBOL", "1000"))
# Send full stored history to every client on connect/broadcast
BROADCAST_CANDLES_LIMIT = int(os.getenv("BROADCAST_CANDLES_LIMIT", "1000"))
# Persistent snapshot directory — mount a Render Disk at this path so data survives restarts
SNAPSHOT_DIR = os.getenv("SNAPSHOT_DIR", "/data/snapshots")
MAX_LEVELS_PER_CANDLE = int(os.getenv("MAX_LEVELS_PER_CANDLE", "500"))
MAX_ENGINES = int(os.getenv("MAX_ENGINES", "1000"))  # No trim: all instruments from CSV
GC_INTERVAL_TICKS = int(os.getenv("GC_INTERVAL_TICKS", "10000"))  # Run gc every N ticks
# Minimum interval between broadcasts per symbol (seconds).
# Without this, every tick triggers a full JSON serialize + WS send, saturating the event loop
# and causing 5-10s lag queues. 0.1 = 10 updates/sec max; plenty for a footprint chart.
BROADCAST_MIN_INTERVAL = float(os.getenv("BROADCAST_MIN_INTERVAL", "0.1"))

# ── Liquidity Heatmap (200-level order book) ─────────────────────────────────
# Separate Dhan token — avoids rate-limiting the main feed token.
DHAN_TOKEN_DEPTH    = os.getenv("DHAN_TOKEN_DEPTH", "")
HEATMAP_SNAPSHOTS   = int(os.getenv("HEATMAP_SNAPSHOTS", "300"))   # rolling snapshots per symbol (300 = 5 min)

# ── Options GEX ──────────────────────────────────────────────────────────────
DHAN_TOKEN_OPTIONS  = os.getenv("DHAN_TOKEN_OPTIONS", "")
OPTIONS_POLL_SEC    = float(os.getenv("OPTIONS_POLL_SEC", "300"))         # poll every 5 min (4 indices × 300s = well within rate limit)
# ── OI poller (Dhan Market Quote API) ───────────────────────────────────────
# WebSocket tick feed may not include OI; REST /marketfeed/quote returns OI for derivatives.
OI_POLL_SEC = float(os.getenv("OI_POLL_SEC", "10"))   # poll OI every 10s (rate limit 1 req/sec)
# Underlying security IDs (NSE index) used for options chain
UNDERLYING_IDS = {
    "NIFTY":      "13",
    "BANKNIFTY":  "25",
    "FINNIFTY":   "27",
    "MIDCPNIFTY": "442",
}
# F&O lot sizes (shares per lot) — update when SEBI revises
LOT_SIZES = {
    "NIFTY": 25, "BANKNIFTY": 15, "FINNIFTY": 40, "MIDCPNIFTY": 75,
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


# ─────────────────────────────────────────────
# OrderFlow Engine per symbol
# ─────────────────────────────────────────────

class OrderFlowEngine:
    def __init__(self, symbol: str, security_id: str):
        self.symbol = symbol
        self.security_id = security_id
        self.candles: List[FootprintCandle] = []
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
                self.candles.append(prev)
                if len(self.candles) > MAX_CANDLES_PER_SYMBOL:
                    self.candles = self.candles[-MAX_CANDLES_PER_SYMBOL:]
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

    def update_oi(self, oi: float):
        """Update OI on current candle from REST quote API (e.g. Dhan /marketfeed/quote)."""
        if oi is None or oi <= 0:
            return
        c = self.current_candle
        if c:
            c.oi = oi
            c.oi_change = oi - self.last_oi

    def get_state(self, limit: Optional[int] = None) -> dict:
        """Return current state for broadcast. limit caps candles sent (avoids WebSocket payload limits)."""
        all_candles = list(self.candles) if self.candles else []
        if limit is not None and len(all_candles) > limit:
            all_candles = all_candles[-limit:]
        candle_dicts = [c.to_dict() for c in all_candles]

        # Add CVD (running)
        running = 0.0
        for cd in candle_dicts:
            running += cd["delta"]
            cd["cvd"] = running

        if self.current_candle:
            live = self.current_candle.to_dict()
            live["cvd"] = running + live["delta"]
            candle_dicts.append(live)

        return {
            "symbol": self.symbol,
            "ltp": self.last_ltp,
            "bid": self.last_bid,
            "ask": self.last_ask,
            "cvd": self.cvd,
            "tick_count": self.tick_count,
            "candles": candle_dicts,
        }


# ─────────────────────────────────────────────
# Global state
# ─────────────────────────────────────────────

engines: Dict[str, OrderFlowEngine] = {}
connected_clients: Set[WebSocket] = set()
# symbol -> { "security_id": str, "exchange_segment": str }
subscribed_symbols: Dict[str, dict] = {}
_tick_counter: int = 0  # For periodic gc
_last_reset_date: Optional[str] = None  # IST date "YYYY-MM-DD" of last daily reset
# Rate-limiter: last time each symbol was broadcast (monotonic seconds)
_last_broadcast: Dict[str, float] = {}
# Token expiry / reconnect state
_dhan_reconnect_delay: int = 5          # seconds; doubles on auth failure, resets on success
_dhan_token_event: asyncio.Event = asyncio.Event()  # set when token is updated via API
_dhan_ws = None  # Current Dhan WebSocket connection (for re-subscribing when batch-add)

# ── Heatmap: rolling order-book snapshots ────────────────────────────────────
# symbol → deque of {ts, ltp, bids:[{p,q}], asks:[{p,q}]}
depth_snapshots: Dict[str, deque] = {}

# ── GEX cache ─────────────────────────────────────────────────────────────────
# index_name → {computed_at, spot, expiry, strikes:[...], flip_point, ...}
# gex_cache keyed by "{INDEX_NAME}:{YYYY-MM-DD}" so multiple expiries are cached independently
gex_cache: Dict[str, dict] = {}
# expiry_list_cache keyed by index_name -> list of expiry date strings
expiry_list_cache: Dict[str, list] = {}


# ─────────────────────────────────────────────
# Daily reset (IST midnight) for 24/7 deployment
# ─────────────────────────────────────────────

IST = timezone(timedelta(hours=5, minutes=30))


def _ist_date_str() -> str:
    """Current date in IST as YYYY-MM-DD."""
    return datetime.now(IST).strftime("%Y-%m-%d")


def _do_daily_reset():
    """Reset all engines for new trading day. Clears candles, CVD, preserves subscriptions.
    Only clears when we cross IST midnight. On startup (_last_reset_date is None), we skip
    clear/delete so load_all_snapshots can restore from disk."""
    global _last_reset_date
    today = _ist_date_str()
    if _last_reset_date == today:
        return
    # Only clear/delete when we actually crossed midnight (not on first run)
    if _last_reset_date is not None:
        for eng in engines.values():
            eng.candles.clear()
            eng.current_candle = None
            eng.cvd = 0.0
            eng.prev_volume = 0.0
            eng.prev_total_buy = 0.0
            eng.prev_total_sell = 0.0
        # Wipe yesterday's snapshot files so they don't get reloaded
        if os.path.isdir(SNAPSHOT_DIR):
            for fname in os.listdir(SNAPSHOT_DIR):
                if fname.endswith(".json"):
                    try:
                        os.remove(os.path.join(SNAPSHOT_DIR, fname))
                    except Exception:
                        pass
        gc.collect()
        logger.info(f"Daily reset at IST midnight. Date: {today}. Engines + snapshots cleared.")
    _last_reset_date = today


async def _daily_reset_task():
    """Background task: check every 5 min if we crossed IST midnight, then reset."""
    while True:
        await asyncio.sleep(300)  # 5 min
        _do_daily_reset()


# ─────────────────────────────────────────────
# Disk persistence — survives Render spin-down/restart
# Mount a Render Disk at /data so these files outlive container restarts.
# ─────────────────────────────────────────────

def _ist_midnight_ms() -> int:
    """Unix ms for the start of today in IST (used to discard yesterday's snapshots)."""
    now = datetime.now(IST)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp() * 1000)


def save_symbol_snapshot(symbol: str):
    """Atomically write the closed candles for one symbol to a JSON file on disk."""
    eng = engines.get(symbol)
    if not eng or not eng.candles:
        return
    try:
        os.makedirs(SNAPSHOT_DIR, exist_ok=True)
        path = os.path.join(SNAPSHOT_DIR, f"{symbol}.json")
        tmp  = path + ".tmp"
        candle_dicts = [c.to_dict() for c in eng.candles]
        with open(tmp, "w") as fh:
            json.dump(candle_dicts, fh)
        os.replace(tmp, path)   # atomic rename — never leaves a half-written file
    except Exception as e:
        logger.warning(f"Snapshot save failed [{symbol}]: {e}")


def load_all_snapshots():
    """
    On startup: restore today's closed candles from disk into the already-created engines.
    Call this AFTER auto_subscribe (engines exist) and AFTER _do_daily_reset (CVD/prev cleared).
    Candles older than today's IST midnight are silently discarded.
    """
    if not os.path.isdir(SNAPSHOT_DIR):
        logger.info("Snapshot dir not found — starting with empty history (no Render Disk mounted?)")
        return
    today_start = _ist_midnight_ms()
    loaded = 0
    files = [f for f in os.listdir(SNAPSHOT_DIR) if f.endswith(".json")]
    if not files:
        logger.info(f"No snapshot files in {SNAPSHOT_DIR} — run from market open (9:15 IST) to accumulate data")
    for fname in files:
        symbol = fname[:-5]
        if symbol not in engines:
            continue
        path = os.path.join(SNAPSHOT_DIR, fname)
        try:
            with open(path) as fh:
                candle_dicts = json.load(fh)
            restored = []
            for cd in candle_dicts:
                if not cd.get("closed"):
                    continue                        # skip any open candle — it'll be rebuilt live
                if cd.get("open_time", 0) < today_start:
                    continue                        # discard yesterday's candles
                c = FootprintCandle(
                    open_time   = cd["open_time"],
                    open        = cd["open"],
                    high        = cd["high"],
                    low         = cd["low"],
                    close       = cd["close"],
                    buy_vol     = cd.get("buy_vol", 0),
                    sell_vol    = cd.get("sell_vol", 0),
                    delta_open  = cd.get("delta_open", 0),
                    delta_min   = cd.get("delta_min", 0),
                    delta_max   = cd.get("delta_max", 0),
                    initiative  = cd.get("initiative"),
                    oi          = cd.get("oi", 0),
                    oi_change   = cd.get("oi_change", 0),
                    closed      = True,
                )
                for p_str, lv in cd.get("levels", {}).items():
                    p = float(p_str)
                    c.levels[p] = FootprintLevel(
                        price     = p,
                        buy_vol   = lv.get("buy_vol", 0),
                        sell_vol  = lv.get("sell_vol", 0),
                    )
                restored.append(c)
            if restored:
                restored = restored[-MAX_CANDLES_PER_SYMBOL:]
                engines[symbol].candles = restored
                engines[symbol].cvd     = sum(c.delta for c in restored)
                loaded += 1
                logger.info(f"  Restored {len(restored)} candles for {symbol}")
        except Exception as e:
            logger.warning(f"Snapshot load failed [{symbol}]: {e}")
    logger.info(f"Snapshot restore complete: {loaded} symbols loaded from {SNAPSHOT_DIR}")
    if loaded == 0 and files:
        logger.info("No symbols matched engines — check that stock_list.csv includes symbols with snapshot files")


async def _snapshot_task():
    """Background task: save all symbols to disk. First save after 60s, then every 5 min."""
    await asyncio.sleep(60)   # First snapshot after 1 min (persist data quickly after startup)
    while True:
        syms = list(engines.keys())
        for sym in syms:
            save_symbol_snapshot(sym)
        if syms:
            logger.info(f"Periodic snapshot saved for {len(syms)} symbols")
        await asyncio.sleep(300)


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


def _parse_depth_message(msg) -> Optional[dict]:
    """
    Parse one depth message from the 200-level WebSocket.

    Dhan sends JSON messages.  Two observed shapes:
      Shape A (full depth list):
        {
          "type": "depth",
          "securityId": "49081",
          "ltp": 24520.0,
          "bids": [{"price": 24519, "quantity": 150}, ...],   # up to 200 levels
          "asks": [{"price": 24521, "quantity": 100}, ...]
        }
      Shape B (flat keys):
        {
          "securityId": "49081",
          "LTP": 24520.0,
          "buyDepth": [{"price": 24519, "quantity": 150}, ...],
          "sellDepth": [{"price": 24521, "quantity": 100}, ...]
        }
    We try both shapes.
    """
    if isinstance(msg, (bytes, bytearray)):
        try:
            msg = json.loads(msg.decode())
        except Exception:
            return None

    if isinstance(msg, str):
        try:
            msg = json.loads(msg)
        except Exception:
            return None

    if not isinstance(msg, dict):
        return None

    sec_id = str(msg.get("securityId", msg.get("security_id", msg.get("SecurityId", ""))))
    if not sec_id:
        return None

    ltp = float(msg.get("ltp", msg.get("LTP", msg.get("last_price", 0))) or 0)

    raw_bids = msg.get("bids", msg.get("buyDepth",  msg.get("BuyDepth",  [])))
    raw_asks = msg.get("asks", msg.get("sellDepth", msg.get("SellDepth", [])))

    def norm(levels):
        out = []
        for lv in levels:
            p = float(lv.get("price", lv.get("Price", 0)) or 0)
            q = int(lv.get("quantity", lv.get("Quantity", lv.get("qty", 0))) or 0)
            if p > 0:
                out.append({"p": round(p, 2), "q": q})
        return out

    return {
        "sec_id": sec_id,
        "ltp":    ltp,
        "bids":   norm(raw_bids),
        "asks":   norm(raw_asks),
    }


async def oi_poller_task():
    """Poll Dhan /marketfeed/quote for OI (Open Interest). WebSocket tick feed often omits OI;
    REST Quote API returns oi for derivatives. Docs: https://dhanhq.co/docs/v2/market-quote/"""
    if not DHAN_ACCESS_TOKEN or not DHAN_CLIENT_ID:
        return
    logger.info(f"Starting OI poller (interval={OI_POLL_SEC}s, Dhan /marketfeed/quote)")
    url = f"{DHAN_API_BASE}/marketfeed/quote"
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "access-token": DHAN_ACCESS_TOKEN,
        "client-id": DHAN_CLIENT_ID,
    }
    while True:
        await asyncio.sleep(OI_POLL_SEC)
        if not subscribed_symbols:
            continue
        # Group by exchange_segment. Dhan Market Quote API uses NSE_FNO (not NSE_FO).
        by_seg = defaultdict(list)
        sid_to_symbol = {}
        SEG_NORMALIZE = {"NSE_FO": "NSE_FNO"}  # Dhan REST API expects NSE_FNO
        for symbol, info in subscribed_symbols.items():
            seg = info.get("exchange_segment", "NSE_FO")
            seg = SEG_NORMALIZE.get(seg, seg)
            sid = str(info.get("security_id", ""))
            if sid and symbol in engines:
                by_seg[seg].append(sid)
                sid_to_symbol[sid] = symbol
        if not by_seg:
            continue
        async with httpx.AsyncClient(timeout=15.0) as client:
            for seg, sids in by_seg.items():
                try:
                    body = {seg: [int(s) for s in sids if s.isdigit()]}
                    if not body[seg]:
                        continue
                    resp = await client.post(url, headers=headers, json=body)
                    if resp.status_code != 200:
                        continue
                    data = resp.json()
                    seg_data = (data.get("data") or {}).get(seg) or {}
                    updated = []
                    for sid_str, quote in seg_data.items():
                        oi_val = quote.get("oi")
                        symbol = sid_to_symbol.get(sid_str) if isinstance(sid_str, str) else sid_to_symbol.get(str(sid_str))
                        if oi_val is not None and symbol:
                            engine = engines.get(symbol)
                            if engine:
                                try:
                                    oi = float(oi_val)
                                    if oi > 0:
                                        engine.update_oi(oi)
                                        updated.append(symbol)
                                except (TypeError, ValueError):
                                    pass
                    for sym in updated:
                        now = time.monotonic()
                        if now - _last_broadcast.get(sym, 0) >= BROADCAST_MIN_INTERVAL:
                            _last_broadcast[sym] = now
                            await broadcast_state(sym)
                except Exception as e:
                    logger.warning(f"OI poll error [{seg}]: {e}")
                await asyncio.sleep(1.1)   # Dhan rate limit: 1 req/sec


async def depth_poller_task():
    """
    Connect to Dhan 200-level depth WebSocket, subscribe to all index futures,
    and stream order-book snapshots into depth_snapshots.
    Reconnects automatically on disconnection.
    """
    if not DHAN_TOKEN_DEPTH:
        logger.info("DHAN_TOKEN_DEPTH not set — 200-level depth feed inactive")
        return

    logger.info("Starting 200-level depth WebSocket feed…")
    retry_delay = 5

    while True:
        syms = _index_future_symbols()
        if not syms:
            logger.info("Depth WS: no index futures subscribed yet — retrying in 30s")
            await asyncio.sleep(30)
            continue

        ws_url = (
            f"{DHAN_DEPTH_WS_BASE}"
            f"?token={DHAN_TOKEN_DEPTH}"
            f"&clientId={DHAN_CLIENT_ID}"
            f"&authType=2"
        )

        try:
            async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
                logger.info(f"Depth WS connected — subscribing {len(syms)} instruments")
                retry_delay = 5  # reset on success

                # Build subscription message (same JSON schema as main feed)
                instruments = [
                    {
                        "ExchangeSegment": subscribed_symbols.get(sym, {}).get(
                            "exchange_segment", "NSE_FO"
                        ),
                        "SecurityId": sid,
                    }
                    for sym, sid in syms.items()
                ]
                sub_msg = {
                    "RequestCode": 21,        # Full market depth (Dhan code for depth)
                    "InstrumentCount": len(instruments),
                    "InstrumentList": instruments,
                }
                await ws.send(json.dumps(sub_msg))

                async for raw in ws:
                    parsed = _parse_depth_message(raw)
                    if not parsed:
                        continue

                    symbol = _sid_to_symbol(parsed["sec_id"])
                    if not symbol:
                        continue

                    if symbol not in depth_snapshots:
                        depth_snapshots[symbol] = deque(maxlen=HEATMAP_SNAPSHOTS)
                    depth_snapshots[symbol].append({
                        "ts":   int(time.time() * 1000),
                        "ltp":  parsed["ltp"],
                        "bids": parsed["bids"],
                        "asks": parsed["asks"],
                    })

        except Exception as e:
            logger.warning(f"Depth WS error: {e} — reconnecting in {retry_delay}s")
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 120)


# ─────────────────────────────────────────────
# Options GEX — options chain poller
# Dhan docs: https://dhanhq.co/docs/v2/option-chain/
# Rate limit: 1 unique request per 3 seconds
# ─────────────────────────────────────────────

# UnderlyingSeg for index options — "IDX_I" per Dhan annexure
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


async def _fetch_gex_once(index_name: str, underlying_scrip: str, expiry: str) -> bool:
    """Fetch options chain from Dhan REST API and compute GEX for one index.

    Correct request body per Dhan v2 docs:
        {"UnderlyingScrip": 13, "UnderlyingSeg": "IDX_I", "Expiry": "2024-10-31"}

    Response: data.last_price = spot, data.oc = {strike_str: {ce:{...}, pe:{...}}}
    Greeks (including gamma) are provided directly — no Black-Scholes needed.

    Returns True on success, False on rate-limit / error (caller backs off).
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
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
                    "UnderlyingSeg":   UNDERLYING_SEG,          # "IDX_I" for indices
                    "Expiry":          expiry,                  # "YYYY-MM-DD"
                },
            )
            if resp.status_code == 429:
                logger.warning(f"Options chain 429 [{index_name}] — rate limited, backing off")
                return False
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
            # Dhan provides greeks directly — use them instead of Black-Scholes
            call_gamma = float((ce.get("greeks") or {}).get("gamma", 0) or 0)
            put_gamma  = float((pe.get("greeks") or {}).get("gamma", 0) or 0)

            # Dealer GEX: long calls (+γ), short puts (−γ)
            # GEX = gamma × OI × lot_size × spot² / 100
            call_gex = call_gamma * call_oi * lot_size * spot ** 2 / 100
            put_gex  = put_gamma  * put_oi  * lot_size * spot ** 2 / 100
            net_gex  = call_gex - put_gex

            results.append({
                "strike":   strike,
                "call_oi":  call_oi,
                "put_oi":   put_oi,
                "call_iv":  float(ce.get("implied_volatility", 0) or 0),
                "put_iv":   float(pe.get("implied_volatility", 0) or 0),
                "call_gex": round(call_gex, 2),
                "put_gex":  round(put_gex, 2),
                "net_gex":  round(net_gex, 2),
            })

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


async def options_poller_task():
    """Background: poll Dhan options chain and recompute GEX.

    Rate limit per Dhan docs: 1 unique request per 3 seconds.
    We use 5 s gap between each index (safe margin) and OPTIONS_POLL_SEC between full cycles.
    On 429 → skip remaining indices this cycle and add an extra cool-down.
    """
    if not DHAN_TOKEN_OPTIONS:
        logger.info("DHAN_TOKEN_OPTIONS not set — options/GEX poller inactive")
        return
    logger.info(f"Starting options/GEX poller (cycle={OPTIONS_POLL_SEC}s, gap=5s/index)…")
    # Pre-fetch expiry lists so the frontend dropdown is populated immediately
    for idx_name in UNDERLYING_IDS:
        await _fetch_expiry_list(idx_name)
        await asyncio.sleep(5)
    while True:
        rate_limited = False
        for idx_name, uid in UNDERLYING_IDS.items():
            expiry = await _default_expiry_from_api(idx_name)
            if not expiry:
                continue  # skip if no expiries (token not set or API error)
            ok = await _fetch_gex_once(idx_name, uid, expiry)
            if not ok:
                rate_limited = True
                break                   # abort remaining indices this cycle
            await asyncio.sleep(5)      # 5 s between requests > Dhan's 3 s minimum

        extra = OPTIONS_POLL_SEC if rate_limited else 0
        await asyncio.sleep(OPTIONS_POLL_SEC + extra)


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
                global _dhan_ws
                _dhan_ws = ws
                _dhan_reconnect_delay = 5          # reset backoff on successful connect
                logger.info("Connected to Dhan WebSocket (v2)")

                instruments = [
                    {"ExchangeSegment": info.get("exchange_segment", "NSE_FO"),
                     "SecurityId": info.get("security_id")}
                    for info in subscribed_symbols.values()
                ]
                for i in range(0, len(instruments), 100):
                    batch = instruments[i : i + 100]
                    await ws.send(json.dumps({
                        "RequestCode": 17,
                        "InstrumentCount": len(batch),
                        "InstrumentList": batch,
                    }))
                    await asyncio.sleep(0.1)

                try:
                    async for raw in ws:
                        try:
                            if isinstance(raw, (bytes, bytearray)):
                                parsed = parse_dhan_binary(raw)
                                if parsed:
                                    await handle_dhan_tick(parsed)
                            else:
                                try:
                                    await handle_dhan_tick(json.loads(raw))
                                except Exception:
                                    pass
                        except Exception as e:
                            logger.error(f"Tick parse error: {e}")
                finally:
                    _dhan_ws = None

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

        # Quote packet (code 4): fields described in docs (LTP, LTQ, LTT, ATP, Volume, SellQty, BuyQty, DayOpen, DayClose, DayHigh, DayLow)
        if feed_code == 4 and len(raw) >= 8 + 50:
            offset = 8
            ltp = struct.unpack_from("<f", raw, offset)[0]
            offset += 4
            ltq = struct.unpack_from("<h", raw, offset)[0]  # int16
            offset += 2
            ltt = struct.unpack_from("<I", raw, offset)[0]
            offset += 4
            atp = struct.unpack_from("<f", raw, offset)[0]
            offset += 4
            volume = struct.unpack_from("<I", raw, offset)[0]
            offset += 4
            total_sell_qty = struct.unpack_from("<I", raw, offset)[0]
            offset += 4
            total_buy_qty = struct.unpack_from("<I", raw, offset)[0]
            offset += 4
            day_open = struct.unpack_from("<f", raw, offset)[0]
            offset += 4
            day_close = struct.unpack_from("<f", raw, offset)[0]
            offset += 4
            day_high = struct.unpack_from("<f", raw, offset)[0]
            offset += 4
            day_low = struct.unpack_from("<f", raw, offset)[0]

            # OI field appears right after DayLow (offset 50) when packet is long enough
            oi = None
            if len(raw) >= 54:   # 50 (after header+data) + 4 bytes OI
                raw_oi = struct.unpack_from("<I", raw, 50)[0]
                if 0 < raw_oi <= 100_000_000:   # sanity: 0–100M is realistic for Indian markets
                    oi = float(raw_oi)

            # Build a normalized dict
            return {
                "type": "quote",
                "data": {
                    "securityId": str(security_id),
                    "LTP": float(ltp),
                    "LastTradedQty": int(ltq),
                    # LTT from Dhan is Unix epoch SECONDS. Convert to ms for JS Date.
                    "LastTradeTime": int(ltt) * 1000 if ltt and ltt < 1e12 else int(ltt),
                    "ATP": float(atp),
                    "volume": int(volume),
                    "totalSellQty": int(total_sell_qty),
                    "totalBuyQty": int(total_buy_qty),
                    "DayOpen": float(day_open),
                    "DayClose": float(day_close),
                    "DayHigh": float(day_high),
                    "DayLow": float(day_low),
                    "openInterest": oi,
                },
            }

        # Other feed codes not handled here
        return None
    except Exception as e:
        logger.error(f"Binary parse error: {e}")
        return None


async def handle_dhan_tick(msg: dict):
    """Parse Dhan tick message and feed into engines."""
    # Dhan v2 tick format
    # { "type": "ticker", "data": { "securityId": "...", "LTP": 0, "BidPrice": 0, "AskPrice": 0, "volume": 0, ... } }
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

    # Rate-limit broadcasts per symbol to avoid event-loop saturation.
    # All ticks are processed in memory; clients receive latest state at most
    # every BROADCAST_MIN_INTERVAL seconds (default 100 ms = 10 updates/sec).
    now = time.monotonic()
    if now - _last_broadcast.get(symbol, 0) >= BROADCAST_MIN_INTERVAL:
        _last_broadcast[symbol] = now
        await broadcast_state(symbol)

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
            now = time.monotonic()
            if now - _last_broadcast.get(symbol, 0) >= BROADCAST_MIN_INTERVAL:
                _last_broadcast[symbol] = now
                await broadcast_state(symbol)

        await asyncio.sleep(0.25)


async def broadcast_state(symbol: str):
    """Push updated state to all connected WebSocket clients. Caps candles to avoid payload limits."""
    if symbol not in engines:
        return
    state = engines[symbol].get_state(limit=BROADCAST_CANDLES_LIMIT)
    msg = json.dumps({"type": "orderflow", "data": state})

    dead = set()
    for ws in list(connected_clients):  # copy to avoid "Set changed size during iteration"
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


@app.get("/api/settings")
def get_settings():
    return {"candle_seconds": CANDLE_SECONDS, "candle_options": CANDLE_OPTIONS}


@app.get("/api/heatmap/{symbol}")
def get_heatmap(symbol: str, n: int = 300):
    """Return last *n* depth snapshots for the given index-future symbol.
    Used by the Liquidity Heatmap canvas component on the frontend.
    """
    symbol = symbol.upper()
    # Allow partial match: "NIFTY" matches "NIFTY25MARFUT" etc.
    snaps = depth_snapshots.get(symbol)
    if snaps is None:
        for key in depth_snapshots:
            if symbol in key.upper():
                snaps = depth_snapshots[key]
                break
    if not snaps:
        return {"symbol": symbol, "snapshots": []}
    return {"symbol": symbol, "snapshots": list(snaps)[-n:]}


def _resolve_index(symbol: str) -> Optional[str]:
    """Return canonical index name. Check longer names first (BANKNIFTY before NIFTY)."""
    s = symbol.upper()
    for idx_name in ("BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTY"):
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
            resp = await client.post(
                f"{DHAN_API_BASE}/optionchain/expirylist",
                headers={
                    "access-token": DHAN_TOKEN_OPTIONS,
                    "client-id":    DHAN_CLIENT_ID,
                    "Content-Type": "application/json",
                    "Accept":       "application/json",
                },
                json={"UnderlyingScrip": int(uid), "UnderlyingSeg": UNDERLYING_SEG},
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
        eng.current_candle = None
    logger.info(f"Candle duration set to {sec} min")
    return {"candle_seconds": CANDLE_SECONDS}


def _resolve_exchange_segment(payload: dict) -> str:
    """Resolve Dhan exchange_segment from payload. Dhan v2: NSE_FO, MCX_COMM, etc."""
    seg = payload.get("exchange_segment") or payload.get("segment", "")
    exch = (payload.get("exchange") or "").upper()
    if seg and seg not in ("M", "D", ""):
        return str(seg)
    if exch == "MCX":
        return "MCX_COMM"
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


@app.post("/api/subscribe/batch")
async def subscribe_batch(payload: dict):
    """Subscribe to multiple symbols. payload: { instruments: [{symbol, security_id, exchange?, segment?}, ...] }"""
    instruments = payload.get("instruments", [])
    if not isinstance(instruments, list):
        raise HTTPException(400, "instruments must be an array")
    added = []
    new_instruments_for_dhan = []  # {ExchangeSegment, SecurityId} for Dhan re-subscribe
    for item in instruments:
        if not isinstance(item, dict):
            continue
        symbol = (item.get("symbol") or "").upper()
        security_id = str(item.get("security_id", ""))
        if not symbol or not security_id:
            continue
        if symbol not in engines and len(engines) >= MAX_ENGINES:
            logger.warning(f"Batch subscribe: max symbols ({MAX_ENGINES}) reached, skipping {symbol}")
            continue
        exchange_segment = _resolve_exchange_segment(item)
        subscribed_symbols[symbol] = {"security_id": security_id, "exchange_segment": exchange_segment}
        if symbol not in engines:
            engines[symbol] = OrderFlowEngine(symbol, security_id)
            added.append(symbol)
            new_instruments_for_dhan.append({"ExchangeSegment": exchange_segment, "SecurityId": security_id})
    if added:
        logger.info(f"Batch subscribe: added {len(added)} instruments (total {len(engines)})")
        # Re-subscribe to Dhan for new symbols if connection is active
        if new_instruments_for_dhan and _dhan_ws is not None:
            try:
                for i in range(0, len(new_instruments_for_dhan), 100):
                    batch = new_instruments_for_dhan[i : i + 100]
                    await _dhan_ws.send(json.dumps({
                        "RequestCode": 17,
                        "InstrumentCount": len(batch),
                        "InstrumentList": batch,
                    }))
                    await asyncio.sleep(0.05)
                logger.info(f"Dhan re-subscribed to {len(new_instruments_for_dhan)} new instruments")
            except Exception as e:
                logger.warning(f"Dhan re-subscribe failed (will retry on next connect): {e}")
    return {"status": "ok", "subscribed": len(added), "total": len(engines)}


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
def get_state(symbol: str):
    symbol = symbol.upper()
    if symbol not in engines:
        raise HTTPException(404, "Symbol not subscribed")
    return engines[symbol].get_state()


# ─────────────────────────────────────────────
# WebSocket endpoint for frontend
# ─────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    logger.info(f"Client connected. Total: {len(connected_clients)}")

    try:
        # Send current state on connect (cap candles, small delay between sends to avoid overwhelming client)
        for symbol, engine in engines.items():
            state = engine.get_state(limit=BROADCAST_CANDLES_LIMIT)
            await ws.send_text(json.dumps({"type": "orderflow", "data": state}))
            await asyncio.sleep(0.02)  # 20ms between messages so client can process

        while True:
            # Keep alive / handle client messages
            msg = await ws.receive_text()
            data = json.loads(msg)
            if data.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))

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

        count = 0
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

                    # We only auto-subscribe NSE FNO and MCX as requested
                    # Dhan v2 Annexure: MCX_COMM = MCX Commodity (futures)
                    seg_name = None
                    if exch == "MCX":
                        seg_name = "MCX_COMM"
                    elif exch == "NSE" and ("FUT" in instr or "FUTIDX" in instr or "FUTSTK" in instr or row.get("segment","").upper()=="D"):
                        seg_name = "NSE_FNO"

                    if seg_name:
                        # store segment name (will be resolved to MarketFeed constant at runtime)
                        subscribed_symbols[symbol] = {"security_id": security_id, "exchange_segment": seg_name}
                        if symbol not in engines:
                            engines[symbol] = OrderFlowEngine(symbol, security_id)
                        count += 1
            logger.info(f"Auto-subscribed {count} instruments (NSE_FNO/MCX) from stock_list.csv")
        except Exception as e:
            logger.error(f"Auto-subscribe failed: {e}")

    auto_subscribe_from_csv()
    _do_daily_reset()       # sets _last_reset_date = today; clears stale state
    # Retry snapshot load (Render disk mount can be delayed a few seconds)
    for attempt in range(2):
        if os.path.isdir(SNAPSHOT_DIR):
            load_all_snapshots()
            break
        if attempt == 0:
            logger.info("Snapshot dir not found, retrying in 5s (disk mount may be delayed)...")
            await asyncio.sleep(5)
    else:
        logger.info("Snapshot dir not found after retry — starting with empty history (ensure Render Disk is mounted at /data)")
    asyncio.create_task(dhan_feed_task())
    asyncio.create_task(_daily_reset_task())
    asyncio.create_task(_snapshot_task())
    asyncio.create_task(oi_poller_task())
    asyncio.create_task(depth_poller_task())
    asyncio.create_task(options_poller_task())
    logger.info("OrderFlow Engine started (daily reset at IST midnight, disk snapshots every 5 min)")


# Serve frontend build (for production deployment)
try:
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
except Exception:
    pass  # frontend served separately in dev

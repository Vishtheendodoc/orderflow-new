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
import os
import time
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Set
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
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

# Memory bounds for 24/7 deployment (500 = full trading day ~375 for 1-min)
MAX_CANDLES_PER_SYMBOL = int(os.getenv("MAX_CANDLES_PER_SYMBOL", "500"))
# Cap candles sent over WebSocket to avoid payload size limits (some clients fail with huge messages)
BROADCAST_CANDLES_LIMIT = int(os.getenv("BROADCAST_CANDLES_LIMIT", "50"))
MAX_LEVELS_PER_CANDLE = int(os.getenv("MAX_LEVELS_PER_CANDLE", "500"))
MAX_ENGINES = int(os.getenv("MAX_ENGINES", "1000"))  # No trim: all instruments from CSV
GC_INTERVAL_TICKS = int(os.getenv("GC_INTERVAL_TICKS", "10000"))  # Run gc every N ticks
# Minimum interval between broadcasts per symbol (seconds).
# Without this, every tick triggers a full JSON serialize + WS send, saturating the event loop
# and causing 5-10s lag queues. 0.1 = 10 updates/sec max; plenty for a footprint chart.
BROADCAST_MIN_INTERVAL = float(os.getenv("BROADCAST_MIN_INTERVAL", "0.1"))

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

    def _candle_start(self, ts_ms: int) -> int:
        """Floor timestamp to candle boundary."""
        cs = CANDLE_SECONDS * 1000
        return int((ts_ms // cs) * cs)

    def process_tick(self, ltp: float, bid: float, ask: float, vol: float, ts_ms: int,
                     cumulative_volume: Optional[float] = None,
                     total_buy_qty: Optional[float] = None,
                     total_sell_qty: Optional[float] = None):
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

        self.last_ltp = ltp
        self.last_bid = bid
        self.last_ask = ask
        self.tick_count += 1

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


# ─────────────────────────────────────────────
# Daily reset (IST midnight) for 24/7 deployment
# ─────────────────────────────────────────────

IST = timezone(timedelta(hours=5, minutes=30))


def _ist_date_str() -> str:
    """Current date in IST as YYYY-MM-DD."""
    return datetime.now(IST).strftime("%Y-%m-%d")


def _do_daily_reset():
    """Reset all engines for new trading day. Clears candles, CVD, preserves subscriptions."""
    global _last_reset_date
    today = _ist_date_str()
    if _last_reset_date == today:
        return
    _last_reset_date = today
    for eng in engines.values():
        eng.candles.clear()
        eng.current_candle = None
        eng.cvd = 0.0
        eng.prev_volume = 0.0
        eng.prev_total_buy = 0.0
        eng.prev_total_sell = 0.0
    gc.collect()
    logger.info(f"Daily reset at IST midnight. Date: {today}. Engines cleared.")


async def _daily_reset_task():
    """Background task: check every 5 min if we crossed IST midnight, then reset."""
    while True:
        await asyncio.sleep(300)  # 5 min
        _do_daily_reset()


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


async def dhan_feed_task():
    """Background task: connect to Dhan feed and process ticks."""
    logger.info("Starting Dhan feed task...")

    while True:
        if not subscribed_symbols:
            await asyncio.sleep(2)
            continue

        if not DHAN_ACCESS_TOKEN or not DHAN_CLIENT_ID:
            logger.warning("Dhan credentials not set. Running in DEMO mode.")
            await demo_feed_task()
            return

        # Use raw websocket (dhanhq client conflicts with FastAPI's asyncio event loop)
        url = f"{DHAN_WS_URL}?version=2&token={DHAN_ACCESS_TOKEN}&clientId={DHAN_CLIENT_ID}&authType=2"

        try:
            async with websockets.connect(url, ping_interval=20) as ws:
                logger.info("Connected to Dhan WebSocket (v2)")

                # Build subscription objects using stored exchange_segment
                instruments = []
                for sym, info in subscribed_symbols.items():
                    instruments.append({"ExchangeSegment": info.get("exchange_segment", "NSE_FO"), "SecurityId": info.get("security_id")})

                # If there are >0 instruments, send subscription (split into batches of 100 if needed)
                for i in range(0, len(instruments), 100):
                    batch = instruments[i : i + 100]
                    packet = {
                        "RequestCode": 17,  # Quote: Volume, TotalBuyQty, TotalSellQty
                        "InstrumentCount": len(batch),
                        "InstrumentList": batch,
                    }
                    await ws.send(json.dumps(packet))
                    await asyncio.sleep(0.1)

                async for raw in ws:
                    try:
                        # Dhan sends binary market packets. Handle bytes and text both.
                        if isinstance(raw, (bytes, bytearray)):
                            parsed = parse_dhan_binary(raw)
                            if parsed:
                                await handle_dhan_tick(parsed)
                        else:
                            # Some informational messages may arrive as text/JSON
                            try:
                                msg = json.loads(raw)
                                await handle_dhan_tick(msg)
                            except Exception:
                                pass
                    except Exception as e:
                        logger.error(f"Tick parse error: {e}")

        except Exception as e:
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

    engines[symbol].process_tick(ltp, bid, ask, ltq, ts,
                                 cumulative_volume=cumulative_vol,
                                 total_buy_qty=total_buy,
                                 total_sell_qty=total_sell)

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
    }


@app.get("/api/settings")
def get_settings():
    return {"candle_seconds": CANDLE_SECONDS, "candle_options": CANDLE_OPTIONS}


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
    _do_daily_reset()  # Reset on startup (handles deploy across midnight)
    asyncio.create_task(dhan_feed_task())
    asyncio.create_task(_daily_reset_task())
    logger.info("OrderFlow Engine started (daily reset at IST midnight, memory-bounded)")


# Serve frontend build (for production deployment)
try:
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
except Exception:
    pass  # frontend served separately in dev

"""
OrderFlow Engine - FastAPI Backend
Connects to Dhan WebSocket, classifies ticks, streams orderflow data.
"""

import asyncio
import json
import os
import time
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Set
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import httpx
import websockets

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
# Config
# ─────────────────────────────────────────────
DHAN_CLIENT_ID = os.getenv("DHAN_CLIENT_ID", "")
DHAN_ACCESS_TOKEN = os.getenv("DHAN_ACCESS_TOKEN", "")
DHAN_WS_URL = "wss://api-feed.dhan.co"
DHAN_API_BASE = "https://api.dhan.co"

CANDLE_SECONDS = int(os.getenv("CANDLE_SECONDS", "60"))  # 1-min footprint by default
IMBALANCE_RATIO = float(os.getenv("IMBALANCE_RATIO", "3.0"))

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

    def _candle_start(self, ts_ms: int) -> int:
        """Floor timestamp to candle boundary."""
        cs = CANDLE_SECONDS * 1000
        return (ts_ms // cs) * cs

    def process_tick(self, ltp: float, bid: float, ask: float, vol: float, ts_ms: int):
        """Classify tick and update footprint."""
        # Tick rule: compare to last trade
        if ltp > self.last_ltp:
            side = "buy"
        elif ltp < self.last_ltp:
            side = "sell"
        else:
            # Lee-Ready: compare to mid
            mid = (bid + ask) / 2 if bid and ask else ltp
            side = "buy" if ltp >= mid else "sell"

        candle_ts = self._candle_start(ts_ms)

        # Roll candle
        if self.current_candle is None or self.current_candle.open_time != candle_ts:
            if self.current_candle:
                self.current_candle.closed = True
                self.candles.append(self.current_candle)
                if len(self.candles) > 200:
                    self.candles = self.candles[-200:]
            self.current_candle = FootprintCandle(
                open_time=candle_ts,
                open=ltp,
                high=ltp,
                low=ltp,
                close=ltp,
            )

        c = self.current_candle
        c.high = max(c.high, ltp)
        c.low = min(c.low, ltp)
        c.close = ltp

        # Update level
        rounded_price = round(ltp * 20) / 20  # 0.05 tick grid
        if rounded_price not in c.levels:
            c.levels[rounded_price] = FootprintLevel(price=rounded_price)
        lv = c.levels[rounded_price]

        if side == "buy":
            lv.buy_vol += vol
            c.buy_vol += vol
            self.cvd += vol
        else:
            lv.sell_vol += vol
            c.sell_vol += vol
            self.cvd -= vol

        self.last_ltp = ltp
        self.last_bid = bid
        self.last_ask = ask
        self.tick_count += 1

    def get_state(self) -> dict:
        """Return current state for broadcast."""
        all_candles = self.candles[-50:] if self.candles else []
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
subscribed_symbols: Dict[str, str] = {}  # symbol -> security_id


# ─────────────────────────────────────────────
# Dhan WebSocket Feed
# ─────────────────────────────────────────────

def build_dhan_subscription(security_ids: List[str]) -> dict:
    """Build Dhan subscription packet."""
    instruments = [
        {"ExchangeSegment": "NSE_FO", "SecurityId": sid}
        for sid in security_ids
    ]
    return {
        "LoginReq": {
            "MsgCode": 11,
            "ClientId": DHAN_CLIENT_ID,
            "Token": DHAN_ACCESS_TOKEN,
        },
        "Subscription": {
            "MsgCode": 21,
            "Data": instruments,
        }
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

        try:
            async with websockets.connect(
                DHAN_WS_URL,
                extra_headers={"Authorization": f"Bearer {DHAN_ACCESS_TOKEN}"},
                ping_interval=20,
            ) as ws:
                logger.info("Connected to Dhan WebSocket")

                # Auth + subscribe
                sub = build_dhan_subscription(list(subscribed_symbols.values()))
                await ws.send(json.dumps(sub["LoginReq"]))
                await asyncio.sleep(1)
                await ws.send(json.dumps(sub["Subscription"]))

                async for raw in ws:
                    try:
                        msg = json.loads(raw) if isinstance(raw, str) else raw
                        await handle_dhan_tick(msg)
                    except Exception as e:
                        logger.error(f"Tick parse error: {e}")

        except Exception as e:
            logger.error(f"Dhan WS error: {e}. Reconnecting in 5s...")
            await asyncio.sleep(5)


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
    for sym, sec_id in subscribed_symbols.items():
        if sec_id == sid:
            symbol = sym
            break

    if not symbol or symbol not in engines:
        return

    ltp = float(data.get("LTP", data.get("ltp", 0)))
    bid = float(data.get("BidPrice", data.get("bidPrice", 0)))
    ask = float(data.get("AskPrice", data.get("askPrice", 0)))
    vol = float(data.get("volume", data.get("Volume", 1)))
    ts = int(data.get("timestamp", time.time() * 1000))

    if ltp <= 0:
        return

    engines[symbol].process_tick(ltp, bid, ask, vol, ts)
    await broadcast_state(symbol)


async def demo_feed_task():
    """Generate synthetic ticks for demo/testing when no credentials."""
    import random
    import math

    logger.info("Running in DEMO mode with synthetic data")
    prices = {"NIFTY25MARFUT": 22500.0, "BANKNIFTY25MARFUT": 48000.0}

    while True:
        for symbol, base in prices.items():
            if symbol not in engines:
                continue

            # Simulate random walk
            ltp = prices[symbol] + random.gauss(0, 5)
            ltp = round(ltp * 20) / 20
            prices[symbol] = ltp

            bid = ltp - 0.5
            ask = ltp + 0.5
            vol = random.randint(50, 500)
            ts = int(time.time() * 1000)

            engines[symbol].process_tick(ltp, bid, ask, vol, ts)
            await broadcast_state(symbol)

        await asyncio.sleep(0.3)


async def broadcast_state(symbol: str):
    """Push updated state to all connected WebSocket clients."""
    if symbol not in engines:
        return
    state = engines[symbol].get_state()
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
    return {"status": "ok", "symbols": list(engines.keys()), "demo": not bool(DHAN_ACCESS_TOKEN)}


@app.post("/api/subscribe")
async def subscribe(payload: dict):
    """Subscribe to a symbol. payload: {symbol, security_id, exchange_segment}"""
    symbol = payload.get("symbol", "").upper()
    security_id = str(payload.get("security_id", ""))

    if not symbol or not security_id:
        raise HTTPException(400, "symbol and security_id required")

    subscribed_symbols[symbol] = security_id
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
        # Send current state on connect
        for symbol, engine in engines.items():
            state = engine.get_state()
            await ws.send_text(json.dumps({"type": "orderflow", "data": state}))

        while True:
            # Keep alive / handle client messages
            msg = await ws.receive_text()
            data = json.loads(msg)
            if data.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        connected_clients.discard(ws)
        logger.info(f"Client disconnected. Total: {len(connected_clients)}")


# ─────────────────────────────────────────────
# Startup
# ─────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    asyncio.create_task(dhan_feed_task())
    logger.info("OrderFlow Engine started")


# Serve frontend build (for production deployment)
try:
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
except Exception:
    pass  # frontend served separately in dev

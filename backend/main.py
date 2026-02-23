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
# symbol -> { "security_id": str, "exchange_segment": str }
subscribed_symbols: Dict[str, dict] = {}


# ─────────────────────────────────────────────
# Dhan WebSocket Feed
# ─────────────────────────────────────────────

def build_dhan_subscription(security_ids: List[str]) -> dict:
    """Build Dhan subscription packet."""
    # Build subscription per Dhan v2 JSON subscribe format (RequestCode 15)
    instruments = [
        {"ExchangeSegment": "NSE_FO", "SecurityId": sid}
        for sid in security_ids
    ]
    return {
        "RequestCode": 15,
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

        # Prefer official dhanhq client if available (simpler and robust)
        try:
            from dhanhq import DhanContext, MarketFeed  # type: ignore

            logger.info("Using official dhanhq MarketFeed client")
            # Build instruments list expected by MarketFeed: (ExchangeSegmentConst, "security_id", MarketFeed.Quote)
            dhan_ctx = DhanContext(DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN)
            instruments = []
            for sym, info in subscribed_symbols.items():
                sec = str(info.get("security_id", ""))
                seg = info.get("exchange_segment", "NSE_FO")
                # Try to resolve segment constant from MarketFeed class
                try:
                    seg_const = getattr(MarketFeed, seg)
                except Exception:
                    seg_const = seg
                instruments.append((seg_const, sec, MarketFeed.Quote))

            if not instruments:
                await asyncio.sleep(1)
                continue

            # Batch-subscribe via official client to respect 100 instruments/msg limit
            import threading

            # Start MarketFeed with the first batch (or empty list)
            first_batch = instruments[:100]
            remaining = instruments[100:]
            mf = MarketFeed(dhan_ctx, first_batch, "v2")

            # run_forever is blocking — run it in a background thread so we can subscribe more batches
            def _mf_runner():
                try:
                    mf.run_forever()
                except Exception as e:
                    logger.error(f"MarketFeed runner exception: {e}")

            t = threading.Thread(target=_mf_runner, daemon=True)
            t.start()

            # Wait briefly for connection to establish
            await asyncio.sleep(1.0)

            # Subscribe remaining instruments in 100-item batches
            try:
                for i in range(0, len(remaining), 100):
                    batch = remaining[i : i + 100]
                    try:
                        mf.subscribe_symbols(batch)
                        logger.info(f"MarketFeed subscribed batch of {len(batch)} instruments")
                    except Exception as e:
                        logger.warning(f"MarketFeed subscribe batch failed: {e}")
                    await asyncio.sleep(0.12)
            except Exception as e:
                logger.warning(f"Error while batch-subscribing via MarketFeed: {e}")

            # Continuously read data from MarketFeed (non-blocking)
            try:
                while True:
                    try:
                        resp = mf.get_data()
                        if resp:
                            await handle_dhan_tick(resp)
                    except Exception as e:
                        logger.error(f"Error handling MarketFeed message: {e}")
                    await asyncio.sleep(0.01)
            except Exception as e:
                logger.error(f"MarketFeed main loop error: {e}. Reconnecting in 5s...")
                await asyncio.sleep(5)

        except Exception as client_err:
            # If official client not available or fails, fallback to raw websocket + binary parser
            logger.warning(f"dhanhq client unavailable or failed ({client_err}). Falling back to raw websocket.")
            # Use query parameters as required by Dhan v2 (version, token, clientId, authType)
            url = f"{DHAN_WS_URL}?version=2&token={DHAN_ACCESS_TOKEN}&clientId={DHAN_CLIENT_ID}&authType=2"

            try:
                async with websockets.connect(url, ping_interval=20) as ws:
                    logger.info("Connected to Dhan WebSocket (v2) [fallback]")

                    # Build subscription objects using stored exchange_segment
                    instruments = []
                    for sym, info in subscribed_symbols.items():
                        instruments.append({"ExchangeSegment": info.get("exchange_segment", "NSE_FO"), "SecurityId": info.get("security_id")})

                    # If there are >0 instruments, send subscription (split into batches of 100 if needed)
                    for i in range(0, len(instruments), 100):
                        batch = instruments[i : i + 100]
                        packet = {
                            "RequestCode": 15,
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
                                    # ignore unexpected text frames
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
    exchange_segment = payload.get("exchange_segment", payload.get("segment", "NSE_FO"))

    if not symbol or not security_id:
        raise HTTPException(400, "symbol and security_id required")
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
                    seg_name = None
                    if exch == "MCX":
                        seg_name = "MCX"
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
    asyncio.create_task(dhan_feed_task())
    logger.info("OrderFlow Engine started")


# Serve frontend build (for production deployment)
try:
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
except Exception:
    pass  # frontend served separately in dev

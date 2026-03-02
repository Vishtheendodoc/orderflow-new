import { useState, useEffect, useRef, useCallback, useMemo, Component } from "react";
import OrderflowChart from "./OrderflowChart";
import FootprintChart from "./FootprintChart";
import LiquidityHeatmap from "./LiquidityHeatmap";
import GexChart from "./GexChart";

class ErrorBoundary extends Component {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return <div className="fp-empty" style={{ padding: 24 }}>Footprint error. Try switching to Chart view.</div>;
    }
    return this.props.children;
  }
}

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${window.location.host}/ws`;
const API_URL = import.meta.env.VITE_API_URL || "";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n, d = 2) => Number(n).toFixed(d);
/* Only >= 1000 use K; 100–999 show as full number. Works for negatives too. */
const fmtVol = (v) => {
  const n = Math.abs(Number(v));
  if (n >= 1e6) return (Number(v) / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (Number(v) / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(Number(v)));
};
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/** Normalize timestamp to ms (backend may send seconds). */
function toMs(t) {
  if (t == null) return 0;
  return t < 1e12 ? t * 1000 : t;
}

/**
 * Market open offsets from midnight IST (Dhan timestamps are IST-epoch).
 * NSE / BSE equity & F&O : 9:15 AM
 * MCX commodities        : 9:00 AM
 */
const MARKET_OPEN_BY_EXCHANGE = {
  NSE: (9 * 60 + 15) * 60 * 1000,  // 9:15 AM
  BSE: (9 * 60 + 15) * 60 * 1000,  // 9:15 AM
  MCX: (9 * 60 +  0) * 60 * 1000,  // 9:00 AM
};
const DEFAULT_MARKET_OPEN_MS = MARKET_OPEN_BY_EXCHANGE.NSE;

/** Return the market-open offset (ms from midnight IST) for a given exchange string. */
function marketOpenMs(exchange) {
  return MARKET_OPEN_BY_EXCHANGE[String(exchange).toUpperCase()] ?? DEFAULT_MARKET_OPEN_MS;
}

/**
 * Aggregate 1-min candles into N-min candles.
 * Bucket boundaries are anchored to the market open of the same day so that
 * e.g. 30m always starts at 9:15, 9:45, 10:15 … (NSE) or 9:00, 9:30 … (MCX).
 */
function aggregateCandles(candles, targetMinutes, openOffsetMs = DEFAULT_MARKET_OPEN_MS) {
  if (!candles?.length || targetMinutes <= 1) return candles ?? [];
  const sorted = [...candles].sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
  const bucketMs = targetMinutes * 60 * 1000;
  const groups = {};
  sorted.forEach((c) => {
    const t          = toMs(c.open_time);
    const dayStart   = Math.floor(t / 86400000) * 86400000;
    const marketOpen = dayStart + openOffsetMs;
    // Align bucket to market open, not to midnight
    const bucket     = marketOpen + Math.floor((t - marketOpen) / bucketMs) * bucketMs;
    if (!groups[bucket]) groups[bucket] = [];
    groups[bucket].push(c);
  });
  let runningCvd = 0;
  return Object.entries(groups)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([bucket, arr]) => {
      arr.sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
      const first = arr[0];
      const last = arr[arr.length - 1];
      const merged = {
        open_time: parseInt(bucket, 10),
        open: first.open,
        high: Math.max(...arr.map((x) => x.high ?? x.close ?? 0)),
        low: Math.min(...arr.map((x) => x.low ?? x.open ?? 999999)),
        close: last.close,
        buy_vol: 0,
        sell_vol: 0,
        levels: {},
        closed: last.closed,
        initiative: null,
      };
      arr.forEach((c) => {
        merged.buy_vol += c.buy_vol ?? 0;
        merged.sell_vol += c.sell_vol ?? 0;
        Object.entries(c.levels || {}).forEach(([p, lv]) => {
          const price = Number(p);
          const bv = lv.buy_vol ?? lv.buyVol ?? 0;
          const sv = lv.sell_vol ?? lv.sellVol ?? 0;
          if (!merged.levels[price]) merged.levels[price] = { price, buy_vol: 0, sell_vol: 0 };
          merged.levels[price].buy_vol += bv;
          merged.levels[price].sell_vol += sv;
          merged.levels[price].total_vol = merged.levels[price].buy_vol + merged.levels[price].sell_vol;
        });
      });
      merged.delta = merged.buy_vol - merged.sell_vol;
      runningCvd += merged.delta;
      merged.cvd = runningCvd;
      merged.initiative = merged.delta > 0 ? "buy" : merged.delta < 0 ? "sell" : null;
      return merged;
    });
}

function getDeltaColor(delta, maxAbs) {
  const ratio = maxAbs > 0 ? clamp(Math.abs(delta) / maxAbs, 0, 1) : 0;
  const alpha = 0.15 + ratio * 0.75;
  return delta >= 0
    ? `rgba(0,210,110,${alpha})`
    : `rgba(255,70,70,${alpha})`;
}

function getImbalanceStyle(imbalance) {
  if (imbalance === "buy") return { borderLeft: "2px solid #00d26e", background: "rgba(0,210,110,0.08)" };
  if (imbalance === "sell") return { borderLeft: "2px solid #ff4646", background: "rgba(255,70,70,0.08)" };
  return {};
}

// ─── Components ───────────────────────────────────────────────────────────────

function DeltaBar({ delta, maxAbs }) {
  const ratio = maxAbs > 0 ? clamp(Math.abs(delta) / maxAbs, 0, 1) : 0;
  const w = (ratio * 100).toFixed(1) + "%";
  const color = delta >= 0 ? "#00d26e" : "#ff4646";
  const positive = delta >= 0;
  return (
    <div className="delta-bar-wrap">
      <div className="delta-bar-bg">
        <div
          className="delta-bar-fill"
          style={{
            width: w,
            background: color,
            marginLeft: positive ? "50%" : undefined,
            marginRight: !positive ? "50%" : undefined,
            float: positive ? "left" : "right",
          }}
        />
      </div>
      <span className="delta-val" style={{ color }}>{delta >= 0 ? "+" : ""}{fmtVol(delta)}</span>
    </div>
  );
}

function CVDLine({ candles }) {
  const cvds = candles.map((c) => c.cvd);
  if (!cvds.length) return null;
  const min = Math.min(...cvds);
  const max = Math.max(...cvds);
  const range = max - min || 1;
  const W = 300, H = 60;
  const pts = cvds.map((v, i) => {
    const x = (i / (cvds.length - 1 || 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  const lastCvd = cvds[cvds.length - 1];
  const color = lastCvd >= 0 ? "#00d26e" : "#ff4646";
  return (
    <div className="cvd-chart">
      <div className="cvd-header">
        <span>CVD</span>
        <span style={{ color }}>{lastCvd >= 0 ? "+" : ""}{fmtVol(lastCvd)}</span>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <linearGradient id="cvdgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="#333" strokeWidth="1" strokeDasharray="3,3" />
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    </div>
  );
}

function DeltaCvdBox({ delta, cvd, isDelta }) {
  const isPos = (isDelta ? delta : cvd) >= 0;
  const val = isDelta ? delta : cvd;
  return (
    <div className={`delta-cvd-box ${isPos ? "pos" : "neg"}`}>
      {val >= 0 ? "+" : ""}{fmtVol(val)}
    </div>
  );
}

function VolBox({ vol }) {
  return (
    <div className="delta-cvd-box vol">
      {fmtVol(vol ?? 0)}
    </div>
  );
}

function DeltaCvdBoxRow({ candles }) {
  if (!candles?.length) return null;
  return (
    <div className="delta-cvd-box-row">
      <div className="dcbr-section">
        <div className="dcbr-label">Tick Delta</div>
        <div className="dcbr-boxes">
          {candles.map((c) => (
            <DeltaCvdBox key={c.open_time} delta={c.delta ?? 0} cvd={0} isDelta={true} />
          ))}
        </div>
      </div>
      <div className="dcbr-section">
        <div className="dcbr-label">Cumulative Delta</div>
        <div className="dcbr-boxes">
          {candles.map((c) => (
            <DeltaCvdBox key={c.open_time} delta={0} cvd={c.cvd ?? 0} isDelta={false} />
          ))}
        </div>
      </div>
      <div className="dcbr-section">
        <div className="dcbr-label">Total Volume</div>
        <div className="dcbr-boxes">
          {candles.map((c) => (
            <VolBox key={c.open_time} vol={(c.buy_vol ?? 0) + (c.sell_vol ?? 0)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function FootprintCandle({ candle, maxDelta, isLive, cvd }) {
  const levels = Object.values(candle.levels || {}).sort((a, b) => b.price - a.price);
  const maxLevelVol = Math.max(...levels.map((l) => l.total_vol), 1);
  // VR Trender: initiative (buy/sell initiated) styling
  const initiative = candle.initiative;
  const initiativeClass = initiative === "buy" ? "fp-init-buy" : initiative === "sell" ? "fp-init-sell" : "";

  return (
    <div className={`fp-candle-wrap ${isLive ? "fp-live" : ""}`}>
      <div className={`fp-candle ${isLive ? "fp-candle-live" : ""} ${initiativeClass}`}>
        <div className="fp-candle-header">
          <span className="fp-time">
            {new Date(toMs(candle.open_time)).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}
            {isLive && <span className="live-dot" />}
          </span>
          <span className={`fp-delta ${candle.delta >= 0 ? "pos" : "neg"}`} title={`Δ min: ${candle.delta_min ?? 0} max: ${candle.delta_max ?? 0}`}>
            Δ {candle.delta >= 0 ? "+" : ""}{fmtVol(candle.delta)}
          </span>
          <span className="fp-vol">{fmtVol(candle.buy_vol + candle.sell_vol)}</span>
        </div>
        <DeltaBar delta={candle.delta} maxAbs={maxDelta} />
        <div className="fp-levels">
        {levels.map((lv) => {
          const volRatio = lv.total_vol / maxLevelVol;
          return (
            <div
              key={lv.price}
              className="fp-level"
              style={{
                background: `rgba(255,255,255,${volRatio * 0.04})`,
                ...getImbalanceStyle(lv.imbalance),
              }}
            >
              <span className="lv-sell">{fmtVol(lv.sell_vol)}</span>
              <span className="lv-price">{fmt(lv.price)}</span>
              <span className="lv-buy">{fmtVol(lv.buy_vol)}</span>
            </div>
          );
        })}
        </div>
      </div>
      <div className="fp-delta-cvd-boxes">
        <div className="fp-box-row">
          <span className="fp-box-label">Δ</span>
          <DeltaCvdBox delta={candle.delta} cvd={0} isDelta={true} />
        </div>
        <div className="fp-box-row">
          <span className="fp-box-label">CVD</span>
          <DeltaCvdBox delta={0} cvd={candle.cvd ?? 0} isDelta={false} />
        </div>
        <div className="fp-box-row">
          <span className="fp-box-label">Vol</span>
          <VolBox vol={(candle.buy_vol ?? 0) + (candle.sell_vol ?? 0)} />
        </div>
      </div>
    </div>
  );
}

// ─── CSV Instrument Loader ────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const vals = line.split(",");
    return headers.reduce((obj, h, i) => ({ ...obj, [h.trim()]: (vals[i] || "").trim() }), {});
  });
}

// Extract base name (strip expiry month/year suffix like "MAR FUT", "FEB FUT", "APR FUT")
function getBaseName(symbol) {
  return String(symbol).replace(/\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+FUT$/i, "").trim();
}

// Return expiry month for matching/sorting: "FEB", "APR", etc. "CURR" only if no match.
function getExpiry(symbol) {
  const s = String(symbol).trim().replace(/\r/g, "");
  const m = s.match(/\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+FUT$/i);
  return m ? m[1].toUpperCase() : "CURR";
}

// Display label for expiry pill: "FEB FUT" etc.
function getExpiryLabel(symbol) {
  const exp = getExpiry(symbol);
  return exp === "CURR" ? (symbol || "CURR") : `${exp} FUT`;
}

const EXPIRY_ORDER = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const POPULAR_INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"];

function SubscribePanel({ onSubscribe, activeSymbols }) {
  const [allInstruments, setAllInstruments] = useState([]);
  const [search, setSearch] = useState("");
  const [exchangeFilter, setExchangeFilter] = useState("ALL");
  const [selectedExpiry, setSelectedExpiry] = useState({}); // baseName -> expiry
  const [loading, setLoading] = useState(true);
  const searchRef = useRef(null);

  useEffect(() => {
    fetch("/stock_list.csv")
      .then((r) => r.text())
      .then((text) => {
        const rows = parseCSV(text);
        setAllInstruments(rows);

        // Default each base to first expiry found (closest = lowest alphabetically in context)
        const defaults = {};
        rows.forEach((r) => {
          const base = getBaseName(r.symbol);
          const exp = getExpiry(r.symbol);
          if (!defaults[base]) defaults[base] = exp;
          else {
            // prefer earlier expiry
            if (EXPIRY_ORDER.indexOf(exp) < EXPIRY_ORDER.indexOf(defaults[base]))
              defaults[base] = exp;
          }
        });
        setSelectedExpiry(defaults);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const subscribe = async (instrument) => {
    await fetch(`${API_URL}/api/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: instrument.symbol,
        security_id: instrument.security_id,
        exchange: instrument.exchange,
        segment: instrument.segment,
      }),
    });
    onSubscribe(instrument.symbol, instrument.exchange);
  };

  // Group by base name, filter, search
  const exchanges = ["ALL", ...Array.from(new Set(allInstruments.map((r) => r.exchange))).sort()];

  const filtered = allInstruments.filter((r) => {
    if (exchangeFilter !== "ALL" && r.exchange !== exchangeFilter) return false;
    const q = search.trim().toUpperCase();
    if (q && !r.symbol.toUpperCase().includes(q)) return false;
    return true;
  });

  // Group by base name
  const grouped = {};
  filtered.forEach((r) => {
    const base = getBaseName(r.symbol);
    if (!grouped[base]) grouped[base] = { base, rows: [], exchange: r.exchange, instrument: r.instrument };
    grouped[base].rows.push(r);
  });

  // Sort each group's expiries
  Object.values(grouped).forEach((g) => {
    g.rows.sort((a, b) =>
      EXPIRY_ORDER.indexOf(getExpiry(a.symbol)) - EXPIRY_ORDER.indexOf(getExpiry(b.symbol))
    );
  });

  const groups = Object.values(grouped).sort((a, b) => {
    const aPopular = POPULAR_INDICES.indexOf(a.base);
    const bPopular = POPULAR_INDICES.indexOf(b.base);
    if (aPopular >= 0 && bPopular >= 0) return aPopular - bPopular;
    if (aPopular >= 0) return -1;
    if (bPopular >= 0) return 1;
    return a.base.localeCompare(b.base);
  });

  // Determine which symbols are active (any expiry of base)
  const activeBaseNames = new Set(
    activeSymbols.map((s) => getBaseName(s))
  );

  return (
    <div className="subscribe-panel">
      <div className="panel-title">INSTRUMENTS</div>

      {/* Search */}
      <div className="search-wrap">
        <span className="search-icon">⌕</span>
        <input
          ref={searchRef}
          className="search-input"
          placeholder="Search symbol..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {search && (
          <button className="search-clear" onClick={() => setSearch("")}>×</button>
        )}
      </div>

      {/* Exchange filter */}
      <div className="exchange-tabs">
        {exchanges.map((ex) => (
          <button
            key={ex}
            className={`ex-tab ${exchangeFilter === ex ? "active" : ""}`}
            onClick={() => setExchangeFilter(ex)}
          >
            {ex}
          </button>
        ))}
      </div>

      {/* Instrument list */}
      <div className="instrument-list">
        {loading && <div className="inst-loading">Loading...</div>}
        {!loading && groups.length === 0 && (
          <div className="inst-empty">No results for "{search}"</div>
        )}
        {!loading && groups.some((g) => POPULAR_INDICES.includes(g.base)) && (
          <div className="inst-section-label">Popular indices</div>
        )}
        {groups.map((g) => {
          const expiries = g.rows.map(getExpiry);
          const curExp = selectedExpiry[g.base] || expiries[0];
          const selectedRow = g.rows.find((r) => getExpiry(r.symbol) === curExp) || g.rows[0];
          const isActive = activeBaseNames.has(g.base) || activeSymbols.includes(selectedRow?.symbol);
          // Display full symbol (security + expiry) e.g. "GOLD FEB FUT" instead of just "GOLD"
          const displayName = selectedRow?.symbol || `${g.base} ${curExp}`;

          return (
            <div key={g.base} className={`inst-row ${isActive ? "inst-active" : ""}`}>
              <div className="inst-main">
                <div className="inst-info">
                  <span className="inst-name" title={displayName}>{displayName}</span>
                  <span className={`inst-badge ${g.exchange.toLowerCase()}`}>{g.exchange}</span>
                </div>
                <div className="inst-actions">
                  {/* Expiry selector */}
                  <div className="expiry-pills">
                    {g.rows.map((r) => {
                      const exp = getExpiry(r.symbol);
                      return (
                        <button
                          key={r.symbol}
                          className={`expiry-pill ${curExp === exp ? "sel" : ""}`}
                          onClick={() =>
                            setSelectedExpiry((prev) => ({ ...prev, [g.base]: exp }))
                          }
                          title={r.symbol}
                        >
                          {getExpiryLabel(r.symbol)}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="inst-add-btn"
                    onClick={() => selectedRow && subscribe(selectedRow)}
                    title={`Add ${selectedRow?.symbol}`}
                  >
                    {isActive ? "✓" : "+"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InstrumentSelector({ symbols, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return [...symbols].sort((a, b) => a.localeCompare(b));
    return symbols.filter((s) => s.toUpperCase().includes(q)).sort((a, b) => a.localeCompare(b));
  }, [symbols, search]);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  return (
    <div className="instrument-selector">
      <button
        type="button"
        className="inst-select-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Select instrument"
      >
        <span className="inst-select-value">{value || "Select instrument"}</span>
        <span className="inst-select-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <>
          <div className="inst-select-backdrop" onClick={() => setOpen(false)} />
          <div className="inst-select-dropdown" ref={listRef}>
            <input
              ref={inputRef}
              type="text"
              className="inst-select-search"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
            />
            <div className="inst-select-list">
              {filtered.length === 0 ? (
                <div className="inst-select-empty">No instruments</div>
              ) : (
                filtered.map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    className={`inst-select-option ${value === sym ? "active" : ""}`}
                    onClick={() => {
                      onChange(sym);
                      setOpen(false);
                    }}
                  >
                    {sym}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TickerBar({ symbol, ltp, bid, ask, cvd, tickCount, totalVol, isDemo }) {
  const spread = ask - bid;
  return (
    <div className="ticker-bar">
      <div className="ticker-symbol">{symbol}</div>
      <div className="ticker-ltp">{fmt(ltp)}</div>
      <div className="ticker-detail">
        <span>Bid <b>{fmt(bid)}</b></span>
        <span>Ask <b>{fmt(ask)}</b></span>
        <span>Spread <b>{fmt(spread, 2)}</b></span>
        <span className={cvd >= 0 ? "pos" : "neg"}>CVD <b>{cvd >= 0 ? "+" : ""}{fmtVol(cvd)}</b></span>
        <span>Vol <b>{fmtVol(totalVol ?? 0)}</b></span>
        <span>Ticks <b>{tickCount}</b></span>
        {isDemo && <span className="demo-badge">DEMO</span>}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  /* ── detect ?symbol=X&view=fp URL params (opened by the ⧉ new-tab button) ── */
  const urlParams   = new URLSearchParams(window.location.search);
  const urlSymbol   = urlParams.get("symbol");   // e.g. "NIFTY MAR FUT"
  const urlView     = urlParams.get("view");     // "fp" or null
  const isFpTab     = !!(urlSymbol && urlView === "fp");

  const [flows, setFlows] = useState({}); // symbol -> state
  const [activeSymbol, setActiveSymbol] = useState(urlSymbol || null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [isDemo, setIsDemo] = useState(false);
  const [activeSymbols, setActiveSymbols] = useState(urlSymbol ? [urlSymbol] : []);
  const [symbolExchangeMap, setSymbolExchangeMap] = useState({}); // symbol -> exchange
  const [allSymbols, setAllSymbols] = useState([]); // all symbols available on backend
  const wsRef = useRef(null);
  const pingRef = useRef(null);
  const lastMsgRef = useRef(Date.now());
  const staleTimerRef = useRef(null);
  /* ── Feature toggles ── */
  const [features, setFeatures] = useState({ showOI: true, showVWAP: true, showVP: true });
  const [featMenuOpen, setFeatMenuOpen] = useState(false);
  const featMenuRef = useRef(null);
  /* close dropdown on outside click */
  useEffect(() => {
    if (!featMenuOpen) return;
    const handler = (e) => {
      if (featMenuRef.current?.contains(e.target)) return;
      setFeatMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler, { passive: true });
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [featMenuOpen]);

  // Fetch backend instrument list once on mount (dropdown population only — no subscribe API calls)
  useEffect(() => {
    const base = API_URL || window.location.origin;
    fetch(`${base}/api/symbols`)
      .then((r) => r.json())
      .then((list) => {
        if (Array.isArray(list)) {
          setAllSymbols(list.map((i) => i.symbol || i).filter(Boolean));
          const map = {};
          list.forEach((i) => { if (i.symbol) map[i.symbol] = i.exchange || "NSE"; });
          setSymbolExchangeMap((prev) => ({ ...map, ...prev }));
        }
      })
      .catch(() => {});
    fetch(`${base}/api/health`)
      .then((r) => r.json())
      .then((d) => setIsDemo(d.demo))
      .catch(() => {});
  }, []);

  const connect = useCallback(() => {
    // Close any stale socket first
    clearInterval(staleTimerRef.current);
    staleTimerRef.current = null;
    if (wsRef.current) {
      try {
        const old = wsRef.current;
        old.onopen = null; old.onmessage = null; old.onclose = null; old.onerror = null;
        old.close();
      } catch (_) {}
      wsRef.current = null;
    }

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      lastMsgRef.current = Date.now();
      setWsStatus("connected");
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 15000);
      // Force reconnect if no data for 50s (handles silent proxy/server drops)
      staleTimerRef.current = setInterval(() => {
        if (Date.now() - lastMsgRef.current > 50000) ws.close();
      }, 15000);
    };

    ws.onmessage = (e) => {
      lastMsgRef.current = Date.now();
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "orderflow") {
          const d = msg.data;
          setFlows((prev) => ({ ...prev, [d.symbol]: d }));
          setActiveSymbol((cur) => cur || d.symbol);
          setActiveSymbols((prev) =>
            prev.includes(d.symbol) ? prev : [...prev, d.symbol]
          );
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      setWsStatus("reconnecting");
      clearInterval(pingRef.current);
      clearInterval(staleTimerRef.current);
      staleTimerRef.current = null;
      wsRef.current = null;
      setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearInterval(pingRef.current);
      clearInterval(staleTimerRef.current);
      try { wsRef.current?.close(); } catch (_) {}
    };
  }, [connect]);

  const flow = activeSymbol ? flows[activeSymbol] : null;
  const candles = flow?.candles || [];
  const maxDelta = Math.max(...candles.map((c) => Math.abs(c.delta)), 1);
  const closedCandles = candles.filter((c) => c.closed);
  const liveCandle = candles.find((c) => !c.closed);
  const [viewMode, setViewMode] = useState("chart"); // "chart" | "footprint" | "heatmap" | "gex"

  // True when the active symbol is a NIFTY / BANKNIFTY / FINNIFTY index future
  const isIndexFuture = useMemo(() => {
    const s = (activeSymbol || "").toUpperCase();
    return ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].some(n => s.includes(n));
  }, [activeSymbol]);
  const [timeFrameMinutes, setTimeFrameMinutes] = useState(1); // TradingView-style: 1,5,10,15,30,45,60,120
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer

  const CANDLE_MINUTES = [1, 5, 10, 15, 30, 45, 60, 120];


  // Derive the correct market-open offset for the active symbol's exchange
  const activeExchange     = activeSymbol ? (symbolExchangeMap[activeSymbol] ?? "NSE") : "NSE";
  const activeMarketOpenMs = marketOpenMs(activeExchange);

  // Client-side aggregation: bucket boundaries anchored to the correct market open
  const displayCandles = useMemo(
    () => aggregateCandles(candles, timeFrameMinutes, activeMarketOpenMs),
    [candles, timeFrameMinutes, activeMarketOpenMs]
  );

  /* ── dedicated full-screen footprint tab (opened via ⧉) ── */
  if (isFpTab) {
    return (
      <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "#f0f2f8" }}>
        <ErrorBoundary>
          <FootprintChart candles={displayCandles} symbol={urlSymbol} timeFrameMinutes={timeFrameMinutes} />
        </ErrorBoundary>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        {/* Hamburger — visible only on mobile */}
        <button
          className="menu-btn"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label="Toggle instruments panel"
        >
          {sidebarOpen ? "✕" : "☰"}
        </button>
        <div className="logo">
          <span className="logo-mark">⬡</span>
          <span className="logo-text">ORDERFLOW</span>
          <span className="logo-sub logo-sub-desktop">ENGINE</span>
        </div>
        <div className="header-center">
          {Object.keys(flows).map((sym) => (
            <button
              key={sym}
              className={`tab ${activeSymbol === sym ? "tab-active" : ""}`}
              onClick={() => { setActiveSymbol(sym); setSidebarOpen(false); }}
            >
              {sym}
            </button>
          ))}
          {/* Show placeholder when no data yet */}
          {Object.keys(flows).length === 0 && wsStatus === "connected" && (
            <span style={{ fontSize: 12, opacity: 0.5, padding: "0 8px" }}>Loading data…</span>
          )}
        </div>
        <div className={`ws-indicator ${wsStatus}`}>
          <span className="ws-dot" />
          <span className="ws-label">{wsStatus.toUpperCase()}</span>
        </div>
      </header>

      <div className="main-layout">
        {/* Mobile backdrop */}
        {sidebarOpen && (
          <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Sidebar */}
        <aside className={`sidebar${sidebarOpen ? " sidebar-open" : ""}`}>
          <SubscribePanel
            onSubscribe={(sym, exchange) => {
              setActiveSymbols((prev) => prev.includes(sym) ? prev : [...prev, sym]);
              setSymbolExchangeMap((prev) => ({ ...prev, [sym]: exchange }));
              setActiveSymbol(sym);
              setSidebarOpen(false); // auto-close on mobile after subscribing
            }}
            activeSymbols={activeSymbols}
          />
          {flow && (
            <CVDLine candles={candles} />
          )}
        </aside>

        {/* Main canvas */}
        <main className="canvas">
          {flow ? (
            <>
              <div className="chart-toolbar">
                <InstrumentSelector
                  symbols={[...new Set([...allSymbols, ...Object.keys(flows)])].sort()}
                  value={activeSymbol}
                  onChange={setActiveSymbol}
                />
                {/* Features dropdown — next to instrument selector, above chart */}
                <div className="feat-menu-wrap" ref={featMenuRef}>
                  <button
                    className={`cd-btn feat-btn${featMenuOpen ? " active" : ""}`}
                    onClick={() => setFeatMenuOpen((o) => !o)}
                    title="Toggle chart features"
                  >
                    ⚙ Features
                  </button>
                  {featMenuOpen && (
                    <div className="feat-dropdown">
                      <div className="feat-dropdown-title">Chart Features</div>
                      {[
                        { key: "showOI",   label: "Open Interest (OI)" },
                        { key: "showVWAP", label: "VWAP (session)" },
                        { key: "showVP",   label: "Volume Profile (VPOC / VAH / VAL)" },
                      ].map(({ key, label }) => (
                        <label key={key} className="feat-row">
                          <input
                            type="checkbox"
                            checked={features[key] ?? true}
                            onChange={(e) => setFeatures((f) => ({ ...f, [key]: e.target.checked }))}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {/* TickerBar removed — data visible in chart header */}
              {/* View toggle */}
              <div className="view-toggle">
                <button
                  className={`vt-btn ${viewMode === "chart" ? "active" : ""}`}
                  onClick={() => setViewMode("chart")}
                >
                  Chart
                </button>
                <button
                  className={`vt-btn ${viewMode === "footprint" ? "active" : ""}`}
                  onClick={() => setViewMode("footprint")}
                >
                  Footprint
                </button>
                {isIndexFuture && (
                  <button
                    className={`vt-btn ${viewMode === "heatmap" ? "active" : ""}`}
                    onClick={() => setViewMode("heatmap")}
                    title="Liquidity Heatmap — 200-level order book (DHAN_TOKEN_DEPTH required)"
                  >
                    Heatmap
                  </button>
                )}
                {isIndexFuture && (
                  <button
                    className={`vt-btn ${viewMode === "gex" ? "active" : ""}`}
                    onClick={() => setViewMode("gex")}
                    title="Gamma Exposure — dealer GEX by strike (DHAN_TOKEN_OPTIONS required)"
                  >
                    GEX
                  </button>
                )}
              </div>
              {/* Timeframe selector + Feature toggles */}
              <div className="candle-duration-bar">
                <span className="cd-label">Interval:</span>
                {CANDLE_MINUTES.map((m) => (
                  <button
                    key={m}
                    className={`cd-btn ${timeFrameMinutes === m ? "active" : ""}`}
                    onClick={() => setTimeFrameMinutes(m)}
                  >
                    {m}m
                  </button>
                ))}
              </div>
              {viewMode === "chart" ? (
                <div className="chart-view-wrap">
                  <OrderflowChart
                    candles={displayCandles}
                    symbol={flow.symbol}
                    features={features}
                  />
                </div>
              ) : viewMode === "footprint" ? (
                <ErrorBoundary>
                  <FootprintChart candles={displayCandles} symbol={flow.symbol} timeFrameMinutes={timeFrameMinutes} features={features} />
                </ErrorBoundary>
              ) : viewMode === "heatmap" ? (
                <div className="heatmap-view-wrap">
                  <LiquidityHeatmap
                    symbol={activeSymbol}
                    apiBase={API_URL || window.location.origin}
                  />
                </div>
              ) : viewMode === "gex" ? (
                <div className="heatmap-view-wrap">
                  <GexChart
                    symbol={activeSymbol}
                    apiBase={API_URL || window.location.origin}
                  />
                </div>
              ) : null}
            </>
          ) : (activeSymbol || allSymbols.length > 0) && !flows[activeSymbol] ? (
            <>
              <div className="chart-toolbar">
                <InstrumentSelector
                  symbols={[...new Set([...allSymbols, ...Object.keys(flows)])].sort()}
                  value={activeSymbol}
                  onChange={setActiveSymbol}
                />
              </div>
              <div className="empty-state loading-state">
                <div className="empty-icon">⬡</div>
                <div>{activeSymbol ? `Loading ${activeSymbol}…` : "Select an instrument above"}</div>
                <div className="empty-sub">Use the dropdown to pick any instrument</div>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">⬡</div>
              <div>Subscribe to an instrument to begin</div>
              <div className="empty-sub">Live Dhan feed · Delta · CVD · Buy/Sell initiated</div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

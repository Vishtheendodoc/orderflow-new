import { useState, useEffect, useRef, useCallback, useMemo } from "react";

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${window.location.host}/ws`;
const API_URL = import.meta.env.VITE_API_URL || "";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n, d = 2) => Number(n).toFixed(d);
const fmtVol = (v) => v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v));
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

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

function FootprintCandle({ candle, maxDelta, isLive }) {
  const levels = Object.values(candle.levels || {}).sort((a, b) => b.price - a.price);
  const maxLevelVol = Math.max(...levels.map((l) => l.total_vol), 1);

  return (
    <div className={`fp-candle ${isLive ? "fp-candle-live" : ""}`}>
      <div className="fp-candle-header">
        <span className="fp-time">
          {new Date(candle.open_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
          {isLive && <span className="live-dot" />}
        </span>
        <span className={`fp-delta ${candle.delta >= 0 ? "pos" : "neg"}`}>
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

function getExpiry(symbol) {
  const m = String(symbol).match(/\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+FUT$/i);
  return m ? m[1].toUpperCase() : "CURR";
}

const EXPIRY_ORDER = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

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
    onSubscribe(instrument.symbol);
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

  const groups = Object.values(grouped).sort((a, b) => a.base.localeCompare(b.base));

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
        {groups.map((g) => {
          const expiries = g.rows.map(getExpiry);
          const curExp = selectedExpiry[g.base] || expiries[0];
          const selectedRow = g.rows.find((r) => getExpiry(r.symbol) === curExp) || g.rows[0];
          const isActive = activeBaseNames.has(g.base) || activeSymbols.includes(selectedRow?.symbol);

          return (
            <div key={g.base} className={`inst-row ${isActive ? "inst-active" : ""}`}>
              <div className="inst-main">
                <div className="inst-info">
                  <span className="inst-name">{g.base}</span>
                  <span className={`inst-badge ${g.exchange.toLowerCase()}`}>{g.exchange}</span>
                </div>
                <div className="inst-actions">
                  {/* Expiry selector */}
                  <div className="expiry-pills">
                    {expiries.map((exp) => (
                      <button
                        key={exp}
                        className={`expiry-pill ${curExp === exp ? "sel" : ""}`}
                        onClick={() =>
                          setSelectedExpiry((prev) => ({ ...prev, [g.base]: exp }))
                        }
                      >
                        {exp}
                      </button>
                    ))}
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

function TickerBar({ symbol, ltp, bid, ask, cvd, tickCount, isDemo }) {
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
        <span>Ticks <b>{tickCount}</b></span>
        {isDemo && <span className="demo-badge">DEMO</span>}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [flows, setFlows] = useState({}); // symbol -> state
  const [activeSymbol, setActiveSymbol] = useState(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [isDemo, setIsDemo] = useState(false);
  const [activeSymbols, setActiveSymbols] = useState([]);
  const wsRef = useRef(null);
  const pingRef = useRef(null);

  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((r) => r.json())
      .then((d) => setIsDemo(d.demo))
      .catch(() => {});
  }, []);

  const connect = useCallback(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("connected");
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 15000);
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "orderflow") {
        const d = msg.data;
        setFlows((prev) => ({ ...prev, [d.symbol]: d }));
        setActiveSymbol((cur) => cur || d.symbol);
        setActiveSymbols((prev) =>
          prev.includes(d.symbol) ? prev : [...prev, d.symbol]
        );
      }
    };

    ws.onclose = () => {
      setWsStatus("reconnecting");
      clearInterval(pingRef.current);
      setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearInterval(pingRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const flow = activeSymbol ? flows[activeSymbol] : null;
  const candles = flow?.candles || [];
  const maxDelta = Math.max(...candles.map((c) => Math.abs(c.delta)), 1);
  const closedCandles = candles.filter((c) => c.closed);
  const liveCandle = candles.find((c) => !c.closed);

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="logo">
          <span className="logo-mark">⬡</span>
          <span className="logo-text">ORDERFLOW</span>
          <span className="logo-sub">ENGINE</span>
        </div>
        <div className="header-center">
          {Object.keys(flows).map((sym) => (
            <button
              key={sym}
              className={`tab ${activeSymbol === sym ? "tab-active" : ""}`}
              onClick={() => setActiveSymbol(sym)}
            >
              {sym}
            </button>
          ))}
        </div>
        <div className={`ws-indicator ${wsStatus}`}>
          <span className="ws-dot" />
          {wsStatus.toUpperCase()}
        </div>
      </header>

      <div className="main-layout">
        {/* Sidebar */}
        <aside className="sidebar">
          <SubscribePanel
            onSubscribe={(sym) => {
              setActiveSymbols((prev) => prev.includes(sym) ? prev : [...prev, sym]);
              setActiveSymbol(sym);
            }}
            activeSymbols={activeSymbols}
          />
          {flow && (
            <CVDLine candles={candles} />
          )}
          <div className="legend">
            <div className="legend-title">LEGEND</div>
            <div className="legend-row"><span className="leg-buy">■</span> Buy aggressor</div>
            <div className="legend-row"><span className="leg-sell">■</span> Sell aggressor</div>
            <div className="legend-row"><span className="leg-imb-b">▌</span> Buy imbalance (3×)</div>
            <div className="legend-row"><span className="leg-imb-s">▌</span> Sell imbalance (3×)</div>
          </div>
        </aside>

        {/* Main canvas */}
        <main className="canvas">
          {flow ? (
            <>
              <TickerBar
                symbol={flow.symbol}
                ltp={flow.ltp}
                bid={flow.bid}
                ask={flow.ask}
                cvd={flow.cvd}
                tickCount={flow.tick_count}
                isDemo={isDemo}
              />
              <div className="fp-scroll-wrap">
                <div className="fp-row">
                  {closedCandles.slice(-20).map((c) => (
                    <FootprintCandle key={c.open_time} candle={c} maxDelta={maxDelta} isLive={false} />
                  ))}
                  {liveCandle && (
                    <FootprintCandle candle={liveCandle} maxDelta={maxDelta} isLive={true} />
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">⬡</div>
              <div>Subscribe to an instrument to begin</div>
              <div className="empty-sub">Real-time footprint + delta + CVD</div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

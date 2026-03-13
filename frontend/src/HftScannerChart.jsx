/**
 * HftScannerChart
 *
 * Two-pane TradingView-style chart:
 *   Top  (~35%) — Price candlestick chart (from orderflow candles prop)
 *   Bottom (~65%) — Stacked institutional flow bars (from HFT scanner API)
 *
 * Features:
 *  • IST timestamps (UTC +05:30)
 *  • Synchronized scroll / zoom between both panes
 *  • Timeframe selector: 1m / 5m / 15m / 1h (client-side aggregation)
 *  • Per-flow-type visibility toggles
 *  • Disk-backed history on backend; fetched on mount and every POLL_MS
 */

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { createChart } from "lightweight-charts";

const POLL_MS    = 30_000;  // poll every 30s so HFT bars appear sooner after backend write
const IST_OFFSET = 19800;   // UTC+5:30 in seconds

/* ── helpers ─────────────────────────────────────────────────────────────── */
const _pad = (n) => String(n).padStart(2, "0");

/**
 * Both panes use Dhan IST-epoch seconds as the chart-time value — identical to
 * OrderflowChart.  IST-epoch = Unix + 19800, so reading getUTCHours() on an
 * IST-epoch Date directly surfaces the correct IST wall-clock digit without
 * any extra offset addition.
 */
const fmtIST = (istEpochSec) => {
  const d = new Date((typeof istEpochSec === "number" ? istEpochSec : 0) * 1000);
  return `${_pad(d.getUTCHours())}:${_pad(d.getUTCMinutes())}`;
};

/**
 * Convert a raw UTC Unix-second (snap.ts from backend) to an IST-epoch second
 * floored to the nearest minute, so it aligns with candle open_time / 1000
 * (which is already IST-epoch at the minute boundary).
 */
const toChartTime = (utcSec) => Math.floor(utcSec / 60) * 60 + IST_OFFSET;

const fmtFlow = (v) => {
  const n = Math.abs(Number(v));
  if (n >= 1e9) return (Number(v) / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (Number(v) / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (Number(v) / 1e3).toFixed(0) + "K";
  return String(Math.round(Number(v)));
};

/* ── flow colours ────────────────────────────────────────────────────────── */
const FLOW_COLORS = {
  "Aggressive Call Buy": "#059669",
  "Heavy Put Write":     "#10b981",
  "Put Write":           "#6ee7b7",
  "Dark Pool CE":        "#0ea5e9",   // sky blue — bullish, distinct from PE
  "Dark Pool PE":        "#f97316",   // orange — bearish, high contrast
  "Call Short":          "#fca5a5",
  "Heavy Call Short":    "#ef4444",
  "Aggressive Put Buy":  "#dc2626",
};

const STACK_ORDER = [
  "Aggressive Call Buy",
  "Heavy Put Write",
  "Put Write",
  "Dark Pool CE",
  "Dark Pool PE",
  "Call Short",
  "Heavy Call Short",
  "Aggressive Put Buy",
];

/* ── timeframe config ────────────────────────────────────────────────────── */
const TIMEFRAMES = [
  { label: "1m",  minutes: 1  },
  { label: "5m",  minutes: 5  },
  { label: "15m", minutes: 15 },
  { label: "1h",  minutes: 60 },
];

/** Aggregate 1m candles into N-min candles. Always runs (even for 1m) to deduplicate
 *  by minute and ensure strictly increasing times — duplicate times crash lightweight-charts. */
function aggregateCandlesForHft(candles, tfMin) {
  if (!candles?.length) return [];
  const secPerBucket = Math.max(1, tfMin) * 60;
  const buckets = {};
  for (const c of candles) {
    const tSec = Math.floor((c.open_time || 0) / 1000);
    const bucket = Math.floor(tSec / secPerBucket) * secPerBucket;
    if (!buckets[bucket]) {
      buckets[bucket] = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      const b = buckets[bucket];
      b.high = Math.max(b.high ?? 0, c.high ?? 0);
      b.low = Math.min(b.low ?? 1e9, c.low ?? 1e9);
      b.close = c.close ?? b.close;
    }
  }
  return Object.values(buckets).sort((a, b) => a.time - b.time);
}

/**
 * Aggregate raw HFT snapshots into timeframe buckets.
 * Keeps the LAST snapshot per bucket (not merge) so we avoid "different color bar
 * appearing" when a second poll lands in the same minute — one bar per minute, stable.
 */
function aggregateHFT(series, tfMin) {
  if (!series?.length) return series;
  const buckets = {};
  const secPerBucket = Math.max(1, tfMin) * 60;
  for (const snap of series) {
    const bucketTs = Math.floor(snap.ts / secPerBucket) * secPerBucket;
    buckets[bucketTs] = {
      t:     snap.t,
      ts:    bucketTs,
      spot:  snap.spot,
      mfi:   snap.mfi,
      flows: { ...(snap.flows || {}) },
    };
  }
  return Object.values(buckets).sort((a, b) => a.ts - b.ts);
}

/* ── shared chart options ────────────────────────────────────────────────── */
function makeChartOptions(height) {
  return {
    layout: {
      background: { color: "transparent" },
      textColor:  "#64748b",
      fontFamily: "JetBrains Mono, monospace",
      fontSize:   11,
    },
    localization: {
      timeFormatter: (t) => fmtIST(typeof t === "number" ? t : 0),
    },
    grid: {
      vertLines: { color: "rgba(0,0,0,0.06)" },
      horzLines: { color: "rgba(0,0,0,0.06)" },
    },
    rightPriceScale: {
      borderColor: "rgba(0,0,0,0.06)",
      autoScale:   true,
    },
    timeScale: {
      borderColor:       "rgba(0,0,0,0.06)",
      timeVisible:       true,
      secondsVisible:    false,
      tickMarkFormatter: (t) => fmtIST(typeof t === "number" ? t : 0),
    },
    crosshair: {
      vertLine: {
        color: "rgba(2,132,199,0.8)",
        width: 1,
        labelVisible: true,
        labelBackgroundColor: "rgba(2,132,199,0.9)",
      },
      horzLine: {
        color: "rgba(2,132,199,0.8)",
        width: 1,
        labelVisible: true,
        labelBackgroundColor: "rgba(2,132,199,0.9)",
      },
    },
    height,
    handleScroll:  true,
    handleScale:   true,
  };
}

function resolveIdx(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.includes("BANKNIFTY"))  return "BANKNIFTY";
  if (s.includes("FINNIFTY"))   return "FINNIFTY";
  if (s.includes("MIDCPNIFTY")) return "MIDCPNIFTY";
  if (s.includes("NIFTY"))      return "NIFTY";
  return s;
}

const PRICE_PANE_MIN = 15;   // % of chart area
const PRICE_PANE_MAX = 75;
const PRICE_PANE_DEF = 50;   // 50% candles / 50% HFT — reduces HFT bar height

/* ═══════════════════════════════════════════════════════════════════════════
   COMPONENT
═══════════════════════════════════════════════════════════════════════════ */
export default function HftScannerChart({ symbol, apiBase, candles = [], livePrice }) {
  const chartContainerRef = useRef(null);
  const chartRef          = useRef(null);
  const candleSeriesRef   = useRef(null);
  const flowSeriesRefs    = useRef({});
  const hasInitialFit     = useRef(false);
  const rawSeriesRef      = useRef([]);

  const isDraggingRef    = useRef(false);
  const dragStartYRef    = useRef(0);
  const dragStartHRef    = useRef(PRICE_PANE_DEF);

  const [isFullscreen,  setIsFullscreen]  = useState(false);
  const [snapCount,     setSnapCount]     = useState(0);
  const [spotPrice,     setSpotPrice]     = useState(null);
  const [dominantFlow,  setDominantFlow]  = useState(null);
  const [statusMsg,     setStatusMsg]     = useState("waiting…");
  const [tfMin,         setTfMin]         = useState(1);
  const [conviction,    setConviction]   = useState(() => {
    try {
      const s = localStorage.getItem("hft_conviction");
      return s === "medium" || s === "high" ? s : "high";
    } catch {
      return "high";
    }
  });
  const [visibleFlows,  setVisibleFlows]  = useState(() => new Set(STACK_ORDER));
  const [pricePaneH,    setPricePaneH]    = useState(PRICE_PANE_DEF); // % height

  const visibleFlowsRef = useRef(visibleFlows);
  useEffect(() => { visibleFlowsRef.current = visibleFlows; }, [visibleFlows]);

  useEffect(() => {
    try {
      localStorage.setItem("hft_conviction", conviction);
    } catch (_) {}
  }, [conviction]);

  /* ── Effect 1: create single chart with candlestick + flow histogram ──── */
  /* Same chart = shared time axis; candles and HFT bars align by design. */
  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      ...makeChartOptions(el.clientHeight || 500),
      width: el.clientWidth || 600,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor:          "#22c55e",
      downColor:        "#ef4444",
      borderUpColor:    "#22c55e",
      borderDownColor:  "#ef4444",
      wickUpColor:      "#22c55e",
      wickDownColor:    "#ef4444",
      lastValueVisible: true,
      priceLineVisible: true,   // horizontal line at current price
      priceScaleId:     "right",
    });

    const refs = {};
    [...STACK_ORDER].reverse().forEach((flowType) => {
      refs[flowType] = chart.addHistogramSeries({
        color:            FLOW_COLORS[flowType],
        priceScaleId:     "hft",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat:      { type: "custom", minMove: 1, formatter: fmtFlow },
      });
    });

    chartRef.current       = chart;
    candleSeriesRef.current = candleSeries;
    flowSeriesRefs.current = refs;

    const ro = new ResizeObserver(() => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width:  chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current       = null;
      candleSeriesRef.current = null;
      flowSeriesRefs.current = {};
    };
  }, []);

  /* ── Scale margins: candles top (pricePaneH%), flow bottom; +0.15 top margin
     on HFT scale compresses bar height ─────────────────────────────────────── */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const pct = Math.max(PRICE_PANE_MIN / 100, Math.min(PRICE_PANE_MAX / 100, pricePaneH / 100));
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: 0.92 - pct } });
    chart.priceScale("hft").applyOptions({ scaleMargins: { top: Math.min(0.85, pct + 0.15), bottom: 0.02 } });
  }, [pricePaneH]);

  /* ── Effect 2: push candles into price chart (aggregated by tfMin) ──────── */
  const lastCandleDataRef = useRef(null);
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !candles?.length) return;
    const filtered = candles.filter((c) => c.open_time && (c.open != null || c.close != null));
    const merged = aggregateCandlesForHft(filtered, tfMin);
    const data = merged.map((c) => {
      const o = c.open ?? c.close ?? 0;
      const cl = c.close ?? c.open ?? 0;
      return {
        time:  c.time ?? Math.floor((c.open_time || 0) / 1000),
        open:  o,
        high:  (c.high ?? Math.max(o, cl)) || cl,
        low:   (c.low ?? Math.min(o, cl)) || o,
        close: cl,
      };
    }).filter((c) => c.high > 0 && c.low > 0 && c.low < 1e8).sort((a, b) => a.time - b.time);
    if (data.length) {
      lastCandleDataRef.current = data[data.length - 1];
      try { series.setData(data); } catch (_) {}
      if (!hasInitialFit.current) {
        hasInitialFit.current = true;
        chartRef.current?.timeScale().fitContent();
      }
    }
  }, [candles, tfMin]);

  /* ── Effect 2b: live tick update — update last bar with livePrice when it changes ──────── */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || livePrice == null || !Number.isFinite(livePrice) || !lastCandleDataRef.current) return;
    const last = lastCandleDataRef.current;
    const lp = Number(livePrice);
    const updated = {
      time:  last.time,
      open:  last.open,
      high:  Math.max(last.high ?? lp, lp),
      low:   Math.min(last.low ?? lp, lp),
      close: lp,
    };
    lastCandleDataRef.current = updated;
    try { series.update(updated); } catch (_) {}
  }, [livePrice]);

  /* ── Effect 3: clear stale HFT flow data on symbol change ──────────────── */
  useEffect(() => {
    hasInitialFit.current = false;
    rawSeriesRef.current  = [];
    setSnapCount(0);
    setSpotPrice(null);
    setDominantFlow(null);
    setStatusMsg("waiting…");
    Object.values(flowSeriesRefs.current).forEach((s) => {
      try { s?.setData([]); } catch (_) {}
    });
  }, [symbol]);

  /* Reset fit when timeframe changes so chart re-fits to new bar count */
  useEffect(() => {
    hasInitialFit.current = false;
  }, [tfMin]);

  /* ── applyVisibility: recompute cumulative sums for visible flows ─────── */
  const applyVisibility = useCallback((series, visible) => {
    const refs = flowSeriesRefs.current;
    if (!series?.length || !Object.keys(refs).length) return;

    const dataByType = {};
    STACK_ORDER.forEach((ft) => { dataByType[ft] = []; });

    series.forEach((snap) => {
      const t = toChartTime(snap.ts);
      let cumSum = 0;
      STACK_ORDER.forEach((flowType) => {
        if (visible.has(flowType)) {
          cumSum += snap.flows?.[flowType] ?? 0;
          dataByType[flowType].push({ time: t, value: cumSum });
        }
      });
    });

    STACK_ORDER.forEach((flowType) => {
      refs[flowType]?.setData(visible.has(flowType) ? dataByType[flowType] : []);
    });
  }, []);

  /* ── updateChart: push new data + stats ──────────────────────────────── */
  const updateChart = useCallback((rawSeries, tfMinVal, visible) => {
    const chart = chartRef.current;
    if (!chart || !rawSeries?.length) return;

    const series = aggregateHFT(rawSeries, tfMinVal);
    rawSeriesRef.current = rawSeries;

    applyVisibility(series, visible);

    if (!hasInitialFit.current && series.length > 0) {
      hasInitialFit.current = true;
      chart.timeScale().fitContent();
    }

    const lastSnap = series[series.length - 1];
    if (lastSnap?.flows) {
      const top = Object.entries(lastSnap.flows)
        .filter(([k]) => visible.has(k))
        .sort((a, b) => b[1] - a[1])[0];
      setDominantFlow(top ? top[0] : null);
    }
    setSnapCount(series.length);
  }, [applyVisibility]);

  /* ── fetch ────────────────────────────────────────────────────────────── */
  const tfMinRef = useRef(tfMin);
  useEffect(() => { tfMinRef.current = tfMin; }, [tfMin]);

  const fetchData = useCallback(async () => {
    if (!symbol || !apiBase) return;
    const idx = resolveIdx(symbol);
    const qs = conviction ? `?conviction=${encodeURIComponent(conviction)}` : "";
    try {
      const res  = await fetch(`${apiBase}/api/hft_scanner/${encodeURIComponent(idx)}${qs}`);
      const json = await res.json();
      if (json.error && !json.series?.length) {
        setStatusMsg(json.error);
        return;
      }
      setStatusMsg("");
      setSpotPrice(json.spot ?? null);
      updateChart(json.series || [], tfMinRef.current, visibleFlowsRef.current);
    } catch {
      setStatusMsg("fetch error");
    }
  }, [symbol, apiBase, conviction, updateChart]);

  /* ── Polling ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  /* ── Re-render when visibility or timeframe changes ──────────────────── */
  useEffect(() => {
    if (!rawSeriesRef.current.length) return;
    const series = aggregateHFT(rawSeriesRef.current, tfMin);
    applyVisibility(series, visibleFlows);
    const lastSnap = series[series.length - 1];
    if (lastSnap?.flows) {
      const top = Object.entries(lastSnap.flows)
        .filter(([k]) => visibleFlows.has(k))
        .sort((a, b) => b[1] - a[1])[0];
      setDominantFlow(top ? top[0] : null);
    }
    setSnapCount(series.length);
  }, [visibleFlows, tfMin, applyVisibility]);

  const handleFit = useCallback(() => {
    chartRef.current?.timeScale().fitContent();
  }, []);

  /* ── Drag handle: resize price pane height ───────────────────────────── */
  const handleDragStart = useCallback((e) => {
    isDraggingRef.current   = true;
    dragStartYRef.current   = e.clientY;
    dragStartHRef.current   = pricePaneH;
    e.preventDefault();

    const totalH = chartContainerRef.current?.clientHeight || 500;

    const onMove = (ev) => {
      if (!isDraggingRef.current) return;
      const delta   = ev.clientY - dragStartYRef.current;
      const deltaPct = (delta / totalH) * 100;
      setPricePaneH(Math.min(PRICE_PANE_MAX,
                    Math.max(PRICE_PANE_MIN, dragStartHRef.current + deltaPct)));
    };
    const onUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [pricePaneH]);

  /* ── derived ─────────────────────────────────────────────────────────── */
  const dominantColor = dominantFlow ? FLOW_COLORS[dominantFlow] : "#64748b";

  const quickBtnStyle = useMemo(() => ({
    padding:      "2px 8px",
    border:       "1px solid rgba(0,0,0,0.15)",
    borderRadius: 3,
    background:   "transparent",
    color:        "#475569",
    fontFamily:   "JetBrains Mono, monospace",
    fontSize:     10,
    cursor:       "pointer",
    fontWeight:   600,
  }), []);

  return (
    <div className={`orderflow-chart${isFullscreen ? " of-fullscreen" : ""}`}>

      {/* ── Header ── */}
      <div className="chart-header">
        <span className="chart-title">{resolveIdx(symbol)} — Institutional Flow</span>

        <div className="chart-actions">
          {/* Conviction toggle */}
          <span style={{ marginRight: 6, fontSize: 10, color: "#64748b" }}>Conviction:</span>
          {["medium", "high"].map((c) => (
            <button
              key={c}
              type="button"
              className="chart-fit-btn"
              onClick={() => setConviction(c)}
              style={{
                fontWeight:  conviction === c ? 700 : 400,
                color:      conviction === c ? "#0ea5e9" : undefined,
                borderColor: conviction === c ? "#0ea5e9" : undefined,
              }}
            >
              {c === "medium" ? "Medium" : "High"}
            </button>
          ))}
          <span style={{ width: 12, display: "inline-block" }} />
          {/* Timeframe buttons */}
          {TIMEFRAMES.map(({ label, minutes }) => (
            <button
              key={label}
              type="button"
              className="chart-fit-btn"
              onClick={() => setTfMin(minutes)}
              style={{
                fontWeight:      tfMin === minutes ? 700 : 400,
                color:           tfMin === minutes ? "#0ea5e9" : undefined,
                borderColor:     tfMin === minutes ? "#0ea5e9" : undefined,
              }}
            >
              {label}
            </button>
          ))}
          <button type="button" className="chart-fit-btn" onClick={handleFit}>
            Fit [A]
          </button>
          <button
            type="button"
            className="chart-fit-btn"
            onClick={() => setIsFullscreen((f) => !f)}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? "⊡" : "⊞"}
          </button>
        </div>

        <div className="chart-stats">
          {spotPrice != null && (
            <>
              <span>Spot ₹{spotPrice.toFixed(0)}</span>
              <span className="chart-sep">|</span>
            </>
          )}
          {dominantFlow ? (
            <span style={{ color: dominantColor, fontWeight: 700 }}>
              {dominantFlow}
            </span>
          ) : (
            <span style={{ opacity: 0.55 }}>{statusMsg || `${snapCount} bars`}</span>
          )}
          {dominantFlow && snapCount > 0 && (
            <>
              <span className="chart-sep">|</span>
              <span>{snapCount} bars</span>
            </>
          )}
        </div>
      </div>

      {/* ── Flow type visibility toggles ── */}
      <div style={{
        display:      "flex",
        flexWrap:     "wrap",
        alignItems:   "center",
        gap:          "4px 8px",
        padding:      "4px 10px",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        fontSize:     10,
        fontFamily:   "JetBrains Mono, monospace",
        userSelect:   "none",
      }}>
        <button onClick={() => setVisibleFlows(new Set(STACK_ORDER))} style={quickBtnStyle} title="Show all">All</button>
        <button onClick={() => setVisibleFlows(new Set())}            style={quickBtnStyle} title="Hide all">None</button>
        <span style={{ width: 1, height: 14, background: "rgba(0,0,0,0.10)", margin: "0 2px" }} />

        {STACK_ORDER.map((label) => {
          const active = visibleFlows.has(label);
          const color  = FLOW_COLORS[label];
          return (
            <button
              key={label}
              onClick={() =>
                setVisibleFlows((prev) => {
                  const next = new Set(prev);
                  next.has(label) ? next.delete(label) : next.add(label);
                  return next;
                })
              }
              title={active ? `Hide "${label}"` : `Show "${label}"`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 3,
                padding: "2px 7px",
                border: `1px solid ${active ? color : "rgba(0,0,0,0.12)"}`,
                borderRadius: 3,
                background:   active ? `${color}18` : "transparent",
                color:        active ? color : "#94a3b8",
                fontFamily:   "JetBrains Mono, monospace",
                fontSize:     10,
                fontWeight:   active ? 700 : 400,
                cursor:       "pointer",
                textDecoration: active ? "none" : "line-through",
                transition:   "all 0.15s",
                whiteSpace:   "nowrap",
              }}
            >
              <span style={{
                display: "inline-block", width: 8, height: 8, borderRadius: 2,
                background: active ? color : "#cbd5e1", flexShrink: 0,
              }} />
              {label}
            </button>
          );
        })}
      </div>

      {/* ── Single chart: candles + HFT flow (same chart, separate price scales) ── */}
      <div
        ref={chartContainerRef}
        style={{ flex: "1 1 300px", minHeight: 300, overflow: "hidden" }}
      />

      {/* Drag handle: resize candle vs flow split */}
      <div
        onMouseDown={handleDragStart}
        title="Drag to resize"
        style={{
          flex:       "0 0 5px",
          background: "rgba(0,0,0,0.06)",
          cursor:     "row-resize",
          display:    "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ width: 32, height: 2, borderRadius: 1, background: "rgba(0,0,0,0.18)" }} />
      </div>
    </div>
  );
}

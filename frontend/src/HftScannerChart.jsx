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

const POLL_MS    = 65_000;  // slightly over 60s to avoid racing the backend write
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
  "Dark Pool CE":        "#818cf8",
  "Dark Pool PE":        "#a78bfa",
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

/**
 * Aggregate raw HFT snapshots into timeframe buckets.
 * Always runs (even for 1m) to deduplicate multiple snaps that may share the
 * same minute due to polling jitter — duplicate times would crash lightweight-charts.
 */
function aggregateHFT(series, tfMin) {
  if (!series?.length) return series;
  const buckets = {};
  const secPerBucket = Math.max(1, tfMin) * 60;
  for (const snap of series) {
    const bucketTs = Math.floor(snap.ts / secPerBucket) * secPerBucket;
    if (!buckets[bucketTs]) {
      buckets[bucketTs] = {
        t:     snap.t,
        ts:    bucketTs,
        spot:  snap.spot,
        mfi:   snap.mfi,
        flows: { ...snap.flows },
      };
    } else {
      const b = buckets[bucketTs];
      b.spot = snap.spot; // last spot in bucket = close
      for (const [k, v] of Object.entries(snap.flows || {})) {
        b.flows[k] = (b.flows[k] || 0) + v;
      }
    }
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
      vertLine: { color: "rgba(2,132,199,0.5)", width: 1 },
      horzLine: { color: "rgba(2,132,199,0.5)", width: 1 },
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
const PRICE_PANE_DEF = 30;

/* ═══════════════════════════════════════════════════════════════════════════
   COMPONENT
═══════════════════════════════════════════════════════════════════════════ */
export default function HftScannerChart({ symbol, apiBase, candles = [] }) {
  const priceContainerRef = useRef(null);
  const flowContainerRef  = useRef(null);
  const priceChartRef     = useRef(null);
  const flowChartRef      = useRef(null);
  const candleSeriesRef   = useRef(null);
  const flowSeriesRefs    = useRef({});
  const hasInitialFit     = useRef(false);
  const rawSeriesRef      = useRef([]);
  const syncingRef        = useRef(false); // prevent scroll-sync feedback loop

  // Drag state for the resize handle
  const isDraggingRef    = useRef(false);
  const dragStartYRef    = useRef(0);
  const dragStartHRef    = useRef(PRICE_PANE_DEF);

  const [isFullscreen,  setIsFullscreen]  = useState(false);
  const [snapCount,     setSnapCount]     = useState(0);
  const [spotPrice,     setSpotPrice]     = useState(null);
  const [dominantFlow,  setDominantFlow]  = useState(null);
  const [statusMsg,     setStatusMsg]     = useState("waiting…");
  const [tfMin,         setTfMin]         = useState(1);
  const [visibleFlows,  setVisibleFlows]  = useState(() => new Set(STACK_ORDER));
  const [pricePaneH,    setPricePaneH]    = useState(PRICE_PANE_DEF); // % height

  const visibleFlowsRef = useRef(visibleFlows);
  useEffect(() => { visibleFlowsRef.current = visibleFlows; }, [visibleFlows]);

  /* ── Effect 1: create / destroy both charts ───────────────────────────── */
  useEffect(() => {
    const priceEl = priceContainerRef.current;
    const flowEl  = flowContainerRef.current;
    if (!priceEl || !flowEl) return;

    const priceH = priceEl.clientHeight || 200;
    const flowH  = flowEl.clientHeight  || 320;

    // ── Price chart ──
    const priceChart = createChart(priceEl, {
      ...makeChartOptions(priceH),
      width: priceEl.clientWidth || 600,
    });
    const candleSeries = priceChart.addCandlestickSeries({
      upColor:          "#22c55e",
      downColor:        "#ef4444",
      borderUpColor:    "#22c55e",
      borderDownColor:  "#ef4444",
      wickUpColor:      "#22c55e",
      wickDownColor:    "#ef4444",
      lastValueVisible: true,
      priceLineVisible: false,
    });
    priceChartRef.current    = priceChart;
    candleSeriesRef.current  = candleSeries;

    // ── Flow chart ──
    const flowChart = createChart(flowEl, {
      ...makeChartOptions(flowH),
      width: flowEl.clientWidth || 600,
    });
    const refs = {};
    [...STACK_ORDER].reverse().forEach((flowType) => {
      refs[flowType] = flowChart.addHistogramSeries({
        color:            FLOW_COLORS[flowType],
        priceScaleId:     "right",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: { type: "custom", minMove: 1, formatter: fmtFlow },
      });
    });
    flowChartRef.current   = flowChart;
    flowSeriesRefs.current = refs;

    // ── TIME-RANGE sync: use absolute time values so bars align by candle time,
    //    not by bar index.  Both panes share the same UTC time axis so the same
    //    {from, to} range is valid for both charts.
    const syncFromPrice = (range) => {
      if (syncingRef.current || !range) return;
      syncingRef.current = true;
      try { flowChart.timeScale().setVisibleRange(range); } catch (_) {}
      syncingRef.current = false;
    };
    const syncFromFlow = (range) => {
      if (syncingRef.current || !range) return;
      syncingRef.current = true;
      try { priceChart.timeScale().setVisibleRange(range); } catch (_) {}
      syncingRef.current = false;
    };
    priceChart.timeScale().subscribeVisibleTimeRangeChange(syncFromPrice);
    flowChart.timeScale().subscribeVisibleTimeRangeChange(syncFromFlow);

    // ── Resize observer ──
    const ro = new ResizeObserver(() => {
      if (priceChartRef.current && priceContainerRef.current) {
        priceChartRef.current.applyOptions({
          width:  priceContainerRef.current.clientWidth,
          height: priceContainerRef.current.clientHeight,
        });
      }
      if (flowChartRef.current && flowContainerRef.current) {
        flowChartRef.current.applyOptions({
          width:  flowContainerRef.current.clientWidth,
          height: flowContainerRef.current.clientHeight,
        });
      }
    });
    ro.observe(priceEl);
    ro.observe(flowEl);

    return () => {
      ro.disconnect();
      try { priceChart.timeScale().unsubscribeVisibleTimeRangeChange(syncFromPrice); } catch (_) {}
      try { flowChart.timeScale().unsubscribeVisibleTimeRangeChange(syncFromFlow); } catch (_) {}
      priceChart.remove();
      flowChart.remove();
      priceChartRef.current   = null;
      flowChartRef.current    = null;
      candleSeriesRef.current = null;
      flowSeriesRefs.current  = {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Effect 2: push orderflow candles into price chart ─────────────────── */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !candles?.length) return;
    const data = candles
      .filter((c) => c.open_time && c.open && c.high && c.low && c.close)
      .map((c) => ({
        // open_time is Dhan IST-epoch milliseconds.  Dividing by 1000 gives
        // IST-epoch seconds — the same unit toChartTime() produces for flow
        // bars, so both panes share an identical time axis.
        time:  Math.floor(c.open_time / 1000),
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
      }))
      .sort((a, b) => a.time - b.time);
    if (data.length) {
      try { series.setData(data); } catch (_) {}
      // After candles are written, sync the price pane to whatever time window the flow
      // chart is already showing.  This handles the race where flow data arrives first
      // (updateChart runs before Effect 2), leaving the price chart with a stale/null
      // range.  If the flow chart isn't fitted yet we just fit all candles.
      setTimeout(() => {
        const flowRange = flowChartRef.current?.timeScale().getVisibleRange();
        if (flowRange) {
          try { priceChartRef.current?.timeScale().setVisibleRange(flowRange); } catch (_) {}
        } else {
          priceChartRef.current?.timeScale().fitContent();
        }
      }, 0);
    }
  }, [candles]);

  /* ── Effect 3: clear stale HFT flow data on symbol change ──────────────── */
  /* NOTE: do NOT clear candleSeriesRef here — Effect 2 ([candles]) already handles
     candle data. Clearing here would run AFTER Effect 2 on initial mount and wipe
     the price chart blank before the user sees anything.                         */
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

  /* ── applyVisibility: recompute cumulative sums for visible flows ─────── */
  const applyVisibility = useCallback((series, visible) => {
    const refs = flowSeriesRefs.current;
    if (!series?.length || !Object.keys(refs).length) return;

    const dataByType = {};
    STACK_ORDER.forEach((ft) => { dataByType[ft] = []; });

    series.forEach((snap) => {
      let cumSum = 0;
      STACK_ORDER.forEach((flowType) => {
        if (visible.has(flowType)) {
          cumSum += snap.flows?.[flowType] ?? 0;
          dataByType[flowType].push({ time: toChartTime(snap.ts), value: cumSum });
        }
      });
    });

    STACK_ORDER.forEach((flowType) => {
      refs[flowType]?.setData(dataByType[flowType]);
    });
  }, []);

  /* ── updateChart: push new data + stats ──────────────────────────────── */
  const updateChart = useCallback((rawSeries, tfMinVal, visible) => {
    const chart = flowChartRef.current;
    if (!chart || !rawSeries?.length) return;

    const series = aggregateHFT(rawSeries, tfMinVal);
    rawSeriesRef.current = rawSeries;

    applyVisibility(series, visible);

    if (!hasInitialFit.current && series.length > 0) {
      hasInitialFit.current = true;
      // Fit the flow chart first, then after one JS tick (so layout settles),
      // copy its visible time range to the price chart.
      chart.timeScale().fitContent();
      // 50 ms gives the chart layout time to commit the fit before we read
      // getVisibleRange(); 0 ms is too short and often returns null.
      setTimeout(() => {
        const range = chart.timeScale().getVisibleRange();
        if (range) {
          try { priceChartRef.current?.timeScale().setVisibleRange(range); } catch (_) {}
        } else {
          priceChartRef.current?.timeScale().fitContent();
        }
      }, 50);
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
    try {
      const res  = await fetch(`${apiBase}/api/hft_scanner/${encodeURIComponent(idx)}`);
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
  }, [symbol, apiBase, updateChart]);

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
    flowChartRef.current?.timeScale().fitContent();
    setTimeout(() => {
      const range = flowChartRef.current?.timeScale().getVisibleRange();
      if (range) {
        try { priceChartRef.current?.timeScale().setVisibleRange(range); } catch (_) {}
      } else {
        priceChartRef.current?.timeScale().fitContent();
      }
    }, 50);
  }, []);

  /* ── Drag handle: resize price pane height ───────────────────────────── */
  const handleDragStart = useCallback((e) => {
    isDraggingRef.current   = true;
    dragStartYRef.current   = e.clientY;
    dragStartHRef.current   = pricePaneH;
    e.preventDefault();

    const container = e.currentTarget.closest(".of-hft-pane-area");
    const totalH    = container ? container.clientHeight : 500;

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

      {/* ── Two-pane chart area ── */}
      <div className="of-hft-pane-area" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>

        {/* Top: Price candle chart */}
        <div
          ref={priceContainerRef}
          style={{ flex: `0 0 ${pricePaneH}%`, minHeight: 0, overflow: "hidden" }}
        />

        {/* Drag handle */}
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

        {/* Bottom: HFT flow histogram */}
        <div
          ref={flowContainerRef}
          style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        />

      </div>
    </div>
  );
}

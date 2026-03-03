/**
 * HftScannerChart
 *
 * TradingView-style chart (lightweight-charts) showing ONLY the stacked
 * institutional flow bars — same look, header, Fit button, fullscreen toggle,
 * zoom / pan / crosshair as OrderflowChart.
 *
 * Stacking trick: multiple HistogramSeries are added in REVERSE cumulative
 * order.  Each series i holds the cumulative sum of flow types 0…i.  Because
 * series added later are rendered on top, the visual result is a proper
 * colour-stacked bar — only the "delta" between consecutive cumulative values
 * shows through in each colour.
 *
 * Data: GET /api/hft_scanner/{index}  polled every POLL_MS ms.
 */

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { createChart } from "lightweight-charts";

const POLL_MS = 60_000;

/* ── helpers (same as OrderflowChart) ─────────────────────────────────────── */
const _pad   = (n) => String(n).padStart(2, "0");
const fmtIST = (utcSec) => {
  const d = new Date(utcSec * 1000);
  return `${_pad(d.getUTCHours())}:${_pad(d.getUTCMinutes())}`;
};
const fmtFlow = (v) => {
  const n = Math.abs(Number(v));
  if (n >= 1e9) return (Number(v) / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (Number(v) / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (Number(v) / 1e3).toFixed(0) + "K";
  return String(Math.round(Number(v)));
};

/* ── flow colours (matches Streamlit palette) ──────────────────────────────── */
const FLOW_COLORS = {
  "Aggressive Call Buy": "#059669",  // emerald — strongest bullish signal
  "Heavy Put Write":     "#10b981",  // green — writing puts (bullish)
  "Put Write":           "#6ee7b7",  // light green — mild put write
  "Dark Pool CE":        "#818cf8",  // indigo — stealth call
  "Dark Pool PE":        "#a78bfa",  // violet — stealth put
  "Call Short":          "#fca5a5",  // light red — mild call short
  "Heavy Call Short":    "#ef4444",  // red — aggressive call short
  "Aggressive Put Buy":  "#dc2626",  // dark red — strongest bearish signal
};

/**
 * Drawing / cumulative-sum order.
 * STACK_ORDER[0] gets the SMALLEST cumulative value → drawn LAST → sits on top visually.
 * STACK_ORDER[last] gets the LARGEST cumulative value → drawn FIRST → sits at bottom.
 */
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

/* ── lightweight-charts config (identical to OrderflowChart) ───────────────── */
const CHART_OPTIONS = {
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
    scaleMargins: { top: 0.05, bottom: 0.02 },
  },
  timeScale: {
    borderColor:      "rgba(0,0,0,0.06)",
    timeVisible:      true,
    secondsVisible:   false,
    tickMarkFormatter: (t) => fmtIST(typeof t === "number" ? t : 0),
  },
  crosshair: {
    vertLine: { color: "rgba(2,132,199,0.5)", width: 1 },
    horzLine: { color: "rgba(2,132,199,0.5)", width: 1 },
  },
};

function resolveIdx(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.includes("BANKNIFTY"))  return "BANKNIFTY";
  if (s.includes("FINNIFTY"))   return "FINNIFTY";
  if (s.includes("MIDCPNIFTY")) return "MIDCPNIFTY";
  if (s.includes("NIFTY"))      return "NIFTY";
  return s;
}

/* ═══════════════════════════════════════════════════════════════════════════
   COMPONENT
═══════════════════════════════════════════════════════════════════════════ */
export default function HftScannerChart({ symbol, apiBase }) {
  const containerRef    = useRef(null);
  const chartRef        = useRef(null);
  const seriesRefs      = useRef({});   // flowType → IHistogramSeriesApi
  const hasInitialFit   = useRef(false);
  const rawSeriesRef    = useRef([]);   // last fetched series, for re-applying visibility

  const [isFullscreen,  setIsFullscreen]  = useState(false);
  const [snapCount,     setSnapCount]     = useState(0);
  const [spotPrice,     setSpotPrice]     = useState(null);
  const [dominantFlow,  setDominantFlow]  = useState(null);
  const [statusMsg,     setStatusMsg]     = useState("waiting…");

  /* all flow types visible by default */
  const [visibleFlows, setVisibleFlows] = useState(() => new Set(STACK_ORDER));

  /* ── Effect 1: create / destroy chart ──────────────────────────────────── */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      ...CHART_OPTIONS,
      width:  el.clientWidth  || 600,
      height: el.clientHeight || 400,
    });

    /**
     * Add HistogramSeries in REVERSE STACK_ORDER so the series with the
     * LARGEST cumulative value is added first (drawn at the back / bottom)
     * and the one with the SMALLEST cumulative value is added last (drawn
     * in front / top).  Combined with the cumulative-sum data trick this
     * produces proper colour-stacked bars without any canvas hacks.
     */
    const refs = {};
    [...STACK_ORDER].reverse().forEach((flowType) => {
      refs[flowType] = chart.addHistogramSeries({
        color:             FLOW_COLORS[flowType],
        priceScaleId:      "right",
        lastValueVisible:  false,
        priceLineVisible:  false,
        priceFormat: {
          type:      "custom",
          minMove:   1,
          formatter: fmtFlow,
        },
      });
    });

    chartRef.current   = chart;
    seriesRefs.current = refs;

    /* Resize observer — keeps chart in sync with its container */
    const ro = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({
          width:  containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current   = null;
      seriesRefs.current = {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Effect 2: clear stale data when symbol changes ────────────────────── */
  useEffect(() => {
    hasInitialFit.current = false;
    setSnapCount(0);
    setSpotPrice(null);
    setDominantFlow(null);
    setStatusMsg("waiting…");
    Object.values(seriesRefs.current).forEach((s) => {
      try { s?.setData([]); } catch (_) {}
    });
  }, [symbol]);

  /**
   * Core render: re-computes cumulative sums for ONLY the visible flow types
   * and pushes data to each series.  Hidden series receive empty arrays so
   * they disappear while visible neighbours remain correctly stacked.
   *
   * Called both after a fresh fetch AND whenever the user toggles visibility.
   */
  const applyVisibility = useCallback((series, visible) => {
    const refs = seriesRefs.current;
    if (!series?.length || !Object.keys(refs).length) return;

    // Per-type data arrays (populated only for visible types)
    const dataByType = {};
    STACK_ORDER.forEach((ft) => { dataByType[ft] = []; });

    series.forEach((snap) => {
      let cumSum = 0;
      STACK_ORDER.forEach((flowType) => {
        if (visible.has(flowType)) {
          cumSum += snap.flows?.[flowType] ?? 0;
          dataByType[flowType].push({ time: snap.ts, value: cumSum });
        }
        // Hidden types keep an empty array → series will be cleared below
      });
    });

    STACK_ORDER.forEach((flowType) => {
      refs[flowType]?.setData(dataByType[flowType]);
    });
  }, []);

  /* ── push fresh data into the chart ────────────────────────────────────── */
  const updateChart = useCallback((series, visible) => {
    const chart = chartRef.current;
    if (!chart || !series?.length) return;

    rawSeriesRef.current = series;   // store for re-use when visibility changes
    applyVisibility(series, visible);

    if (!hasInitialFit.current && series.length > 0) {
      hasInitialFit.current = true;
      chart.timeScale().fitContent();
    }

    /* Header stats — dominant VISIBLE flow in the latest snapshot */
    const lastSnap = series[series.length - 1];
    if (lastSnap?.flows) {
      const top = Object.entries(lastSnap.flows)
        .filter(([k]) => visible.has(k))
        .sort((a, b) => b[1] - a[1])[0];
      setDominantFlow(top ? top[0] : null);
    }
  }, [applyVisibility]);

  /* ── fetch ─────────────────────────────────────────────────────────────── */
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
      setSnapCount(json.series?.length ?? 0);
      setSpotPrice(json.spot ?? null);
      // Pass current visibleFlows at call time via ref to avoid stale closure
      updateChart(json.series, visibleFlowsRef.current);
    } catch {
      setStatusMsg("fetch error");
    }
  }, [symbol, apiBase, updateChart]);

  /* Keep a ref in sync so fetchData never captures a stale visibleFlows */
  const visibleFlowsRef = useRef(visibleFlows);
  useEffect(() => { visibleFlowsRef.current = visibleFlows; }, [visibleFlows]);

  /* ── re-render whenever visibility toggles (no re-fetch needed) ─────────── */
  useEffect(() => {
    if (rawSeriesRef.current.length) {
      applyVisibility(rawSeriesRef.current, visibleFlows);
      /* update dominant-flow stat for new visible set */
      const lastSnap = rawSeriesRef.current[rawSeriesRef.current.length - 1];
      if (lastSnap?.flows) {
        const top = Object.entries(lastSnap.flows)
          .filter(([k]) => visibleFlows.has(k))
          .sort((a, b) => b[1] - a[1])[0];
        setDominantFlow(top ? top[0] : null);
      }
    }
  }, [visibleFlows, applyVisibility]);

  /* ── polling ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const handleFit = useCallback(() => {
    chartRef.current?.timeScale().fitContent();
  }, []);

  /* ── derived header values ──────────────────────────────────────────────── */
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

      {/* ── Header (identical structure to OrderflowChart) ── */}
      <div className="chart-header">
        <span className="chart-title">{resolveIdx(symbol)} — Institutional Flow</span>

        <div className="chart-actions">
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
            <span style={{ opacity: 0.55 }}>{statusMsg || `${snapCount} snapshots`}</span>
          )}
          {dominantFlow && snapCount > 0 && (
            <>
              <span className="chart-sep">|</span>
              <span>{snapCount} snapshots</span>
            </>
          )}
        </div>
      </div>

      {/* ── Legend / visibility toggles ── */}
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
        {/* All / None quick-selects */}
        <button
          onClick={() => setVisibleFlows(new Set(STACK_ORDER))}
          style={quickBtnStyle}
          title="Show all flow types"
        >
          All
        </button>
        <button
          onClick={() => setVisibleFlows(new Set())}
          style={quickBtnStyle}
          title="Hide all flow types"
        >
          None
        </button>

        <span style={{ width: 1, height: 14, background: "rgba(0,0,0,0.10)", margin: "0 2px" }} />

        {/* One toggle pill per flow type */}
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
                display:       "inline-flex",
                alignItems:    "center",
                gap:           3,
                padding:       "2px 7px",
                border:        `1px solid ${active ? color : "rgba(0,0,0,0.12)"}`,
                borderRadius:  3,
                background:    active ? `${color}18` : "transparent",
                color:         active ? color : "#94a3b8",
                fontFamily:    "JetBrains Mono, monospace",
                fontSize:      10,
                fontWeight:    active ? 700 : 400,
                cursor:        "pointer",
                textDecoration: active ? "none" : "line-through",
                transition:    "all 0.15s",
                whiteSpace:    "nowrap",
              }}
            >
              <span style={{
                display:      "inline-block",
                width:        8,
                height:       8,
                borderRadius: 2,
                background:   active ? color : "#cbd5e1",
                flexShrink:   0,
              }} />
              {label}
            </button>
          );
        })}
      </div>

      {/* ── Chart pane — fills remaining height, same class as OrderflowChart ── */}
      <div ref={containerRef} className="chart-pane chart-pane-price" />

    </div>
  );
}

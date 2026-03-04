/**
 * OrderflowChart v3
 *
 * - Single lightweight-charts price chart (candlestick).
 * - Canvas-based delta panel below the chart: Tick Δ / CVD / Volume boxes
 *   drawn at the EXACT pixel X of each candle via timeScale().timeToCoordinate().
 * - Fullscreen toggle (CSS overlay, ResizeObserver keeps chart in sync).
 * - No separate delta lightweight-chart; no onVisibleRangeChange prop needed.
 */
import { useEffect, useRef, useCallback, useState } from "react";
import { createChart } from "lightweight-charts";

/* ── helpers ── */
const fmtVol = (v) => {
  const n = Math.abs(Number(v));
  if (n >= 1e6) return (Number(v) / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (Number(v) / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(Number(v)));
};

const toMs   = (t) => (t != null && t < 1e12 ? t * 1000 : t);
const _pad   = (n) => String(n).padStart(2, "0");

/**
 * Dhan LTT timestamps are IST-epoch (their zero = IST midnight Jan 1 1970).
 * Reading them directly as UTC therefore surfaces the correct IST wall-clock digits.
 */
const fmtIST = (utcSec) => {
  const d = new Date(utcSec * 1000);
  return `${_pad(d.getUTCHours())}:${_pad(d.getUTCMinutes())}`;
};

const CHART_OPTIONS = {
  layout: {
    background: { color: "transparent" },
    textColor: "#64748b",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 11,
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
    autoScale: true,
    scaleMargins: { top: 0.08, bottom: 0.08 },
  },
  timeScale: {
    borderColor: "rgba(0,0,0,0.06)",
    timeVisible: true,
    secondsVisible: false,
    tickMarkFormatter: (t) => fmtIST(typeof t === "number" ? t : 0),
  },
  crosshair: {
    vertLine: { color: "rgba(2,132,199,0.5)", width: 1 },
    horzLine: { color: "rgba(2,132,199,0.5)", width: 1 },
  },
};

/** Return true when a candle has a usable price (filters out zero-LTP / sentinel values) */
function hasValidPrice(c) {
  const o = c.open, h = c.high, l = c.low, cl = c.close;
  return (
    o  > 0 && !isNaN(o)  &&
    cl > 0 && !isNaN(cl) &&
    h  > 0 && !isNaN(h)  &&
    l  > 0 && !isNaN(l)  &&
    l  < 1e8                   // guard against backend's 999999 sentinel
  );
}

/** Clamp a candle's high/low to be consistent with its open/close */
function sanitiseOHLC(c) {
  const lo  = Math.min(c.open, c.close);
  const hi  = Math.max(c.open, c.close);
  return {
    ...c,
    high: c.high > 0 && c.high < 1e8 ? Math.max(c.high, hi) : hi,
    low:  c.low  > 0 && c.low  < 1e8 ? Math.min(c.low,  lo) : lo,
  };
}

/** Merge sorted candles that share the same chart-time bucket */
function buildMerged(candles, toChartTime) {
  if (!candles?.length) return [];
  const sorted = [...candles]
    .filter(hasValidPrice)                                       // drop zero/sentinel candles
    .sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
  const byTime = new Map();
  sorted.forEach((c) => {
    const t    = toChartTime(c.open_time);
    const prev = byTime.get(t);
    if (!prev) {
      byTime.set(t, { ...sanitiseOHLC(c), chartTime: t });
    } else {
      prev.high     = Math.max(prev.high, c.high > 0 && c.high < 1e8 ? c.high : c.close);
      prev.low      = Math.min(prev.low,  c.low  > 0 && c.low  < 1e8 ? c.low  : c.open);
      prev.close    = c.close    ?? prev.close;
      prev.delta    = (prev.delta    ?? 0) + (c.delta    ?? 0);
      prev.buy_vol  = (prev.buy_vol  ?? 0) + (c.buy_vol  ?? 0);
      prev.sell_vol = (prev.sell_vol ?? 0) + (c.sell_vol ?? 0);
      // OI: take the latest (last candle's value), not sum
      if ((c.oi ?? 0) > 0) { prev.oi = c.oi; prev.oi_change = (prev.oi_change ?? 0) + (c.oi_change ?? 0); }
    }
  });
  return Array.from(byTime.values()).sort((a, b) => a.chartTime - b.chartTime);
}

/* Width (px) of the fixed row-label column inside the delta panel */
const LABEL_COL_W = 42;
/* Height (px) per row in the delta panel */
const ROW_H_PX = 24;

/* ── HFT overlay constants ─────────────────────────────────────────────── */
const HFT_FLOW_COLORS = {
  "Aggressive Call Buy": "#059669",
  "Heavy Put Write":     "#10b981",
  "Put Write":           "#6ee7b7",
  "Dark Pool CE":        "#818cf8",
  "Dark Pool PE":        "#a78bfa",
  "Call Short":          "#fca5a5",
  "Heavy Call Short":    "#ef4444",
  "Aggressive Put Buy":  "#dc2626",
};
const HFT_STACK_ORDER = [
  "Aggressive Call Buy", "Heavy Put Write", "Put Write",
  "Dark Pool CE", "Dark Pool PE",
  "Call Short", "Heavy Call Short", "Aggressive Put Buy",
];
const fmtFlow = (v) => {
  const n = Math.abs(Number(v));
  if (n >= 1e9) return (Number(v) / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (Number(v) / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (Number(v) / 1e3).toFixed(0) + "K";
  return String(Math.round(Number(v)));
};
const HFT_PANE_MIN = 60;
const HFT_PANE_MAX = 400;
const HFT_PANE_DEFAULT = 150;

/* ════════════════════════════════════════════════════════
   COMPONENT
════════════════════════════════════════════════════════ */
export default function OrderflowChart({ candles, symbol, features = {}, hftSeries = [] }) {
  const showOI  = features.showOI  ?? true;
  const showHFT = features.showHFT ?? false;

  const priceContainerRef = useRef(null);
  const priceChartRef     = useRef(null);
  const priceSeriesRef    = useRef(null);
  const deltaCanvasRef    = useRef(null);
  const mergedRef         = useRef([]);
  const rafRef            = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ── HFT overlay ─────────────────────────────────────────────────────────
  const hftContainerRef  = useRef(null);
  const hftChartRef      = useRef(null);
  const hftFlowRefs      = useRef({});   // flowType → IHistogramSeriesApi
  const hftSyncingRef    = useRef(false);
  const [hftPaneH, setHftPaneH] = useState(HFT_PANE_DEFAULT);
  const isDraggingRef    = useRef(false);
  const dragStartYRef    = useRef(0);
  const dragStartHRef    = useRef(0);

  const toChartTime = useCallback(
    (openTime) => Math.floor(toMs(openTime) / 1000),
    []
  );

  /* ── Draw the canvas delta panel ── */
  const drawDeltaPanel = useCallback(() => {
    const canvas = deltaCanvasRef.current;
    const chart  = priceChartRef.current;
    const merged = mergedRef.current;
    if (!canvas || !chart || !merged.length) return;

    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.clientWidth;
    const H   = canvas.clientHeight;
    if (!W || !H) return;

    const tw = Math.round(W * dpr);
    const th = Math.round(H * dpr);
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width  = tw;
      canvas.height = th;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const ts      = chart.timeScale();
    const numRows = showOI ? 4 : 3;
    const ROW_H   = H / numRows;

    /* Running CVD per bar */
    let runCvd = 0;
    const cvdArr = merged.map((c) => { runCvd += c.delta ?? 0; return runCvd; });

    const range = ts.getVisibleLogicalRange();
    const iFrom = range ? Math.max(0, Math.floor(range.from)) : 0;
    const iTo   = range ? Math.min(merged.length - 1, Math.ceil(range.to)) : merged.length - 1;

    let halfW = 18;
    for (let k = iFrom; k < Math.min(iTo, iFrom + 8); k++) {
      const xa = ts.timeToCoordinate(merged[k].chartTime);
      const xb = ts.timeToCoordinate(merged[k + 1]?.chartTime);
      if (xa != null && xb != null && xb > xa) { halfW = (xb - xa) * 0.42; break; }
    }
    halfW = Math.max(halfW, 5);

    const fontSize = Math.max(Math.min(Math.floor(ROW_H * 0.46), 10), 7);
    ctx.font         = `bold ${fontSize}px "JetBrains Mono", monospace`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    /* row dividers */
    ctx.strokeStyle = "rgba(0,0,0,0.07)"; ctx.lineWidth = 0.5;
    for (let r = 1; r < numRows; r++) {
      ctx.beginPath(); ctx.moveTo(0, ROW_H * r); ctx.lineTo(W, ROW_H * r); ctx.stroke();
    }

    for (let i = iFrom; i <= iTo; i++) {
      const c      = merged[i];
      const chartX = ts.timeToCoordinate(c.chartTime);
      if (chartX == null) continue;

      const cx = chartX - LABEL_COL_W;
      const bx = cx - halfW + 1;
      const bw = halfW * 2 - 2;
      if (bx + bw < 0 || bx > W) continue;

      const delta    = c.delta ?? 0;
      const cvd      = cvdArr[i];
      const vol      = (c.buy_vol ?? 0) + (c.sell_vol ?? 0);
      const oi       = c.oi ?? 0;
      const oiChange = c.oi_change ?? 0;

      /* Row 0: Tick Delta — strongest signal, highest contrast */
      ctx.fillStyle = delta >= 0 ? "rgba(0,210,110,0.28)" : "rgba(255,60,60,0.28)";
      ctx.fillRect(bx, 2, bw, ROW_H - 4);
      ctx.fillStyle = delta >= 0 ? "#00f088" : "#ff5050";
      ctx.fillText(fmtVol(delta), cx, ROW_H * 0.5);

      /* Row 1: CVD — cumulative; slightly softer than delta */
      ctx.fillStyle = cvd >= 0 ? "rgba(0,210,110,0.20)" : "rgba(255,60,60,0.20)";
      ctx.fillRect(bx, ROW_H + 2, bw, ROW_H - 4);
      ctx.fillStyle = cvd >= 0 ? "#00d26e" : "#ff6464";
      ctx.fillText(fmtVol(cvd), cx, ROW_H * 1.5);

      /* Row 2: Volume — neutral grey, brighter text for legibility */
      ctx.fillStyle = "rgba(120,140,165,0.28)";
      ctx.fillRect(bx, ROW_H * 2 + 2, bw, ROW_H - 4);
      ctx.fillStyle = "#cdd5e0";
      ctx.fillText(fmtVol(vol), cx, ROW_H * 2.5);

      /* Row 3: OI — symmetric opacity pos/neg */
      if (showOI) {
        ctx.fillStyle = oiChange >= 0 ? "rgba(0,210,110,0.18)" : "rgba(255,60,60,0.22)";
        ctx.fillRect(bx, ROW_H * 3 + 2, bw, ROW_H - 4);
        ctx.fillStyle = oiChange >= 0 ? "#00cc88" : "#ff6060";
        ctx.fillText(oi > 0 ? fmtVol(oi) : "—", cx, ROW_H * 3.5);
      }
    }
  }, [showOI]);

  const scheduleDrawDelta = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(drawDeltaPanel);
  }, [drawDeltaPanel]);

  /* ── Effect 1: create / destroy chart (only on mount / unmount) ── */
  useEffect(() => {
    const priceEl = priceContainerRef.current;
    if (!priceEl) return;

    const priceChart = createChart(priceEl, {
      ...CHART_OPTIONS,
      width:  priceEl.clientWidth  || 600,
      height: priceEl.clientHeight || 300,
    });

    const priceSeries = priceChart.addCandlestickSeries({
      upColor:         "#059669",
      downColor:       "#dc2626",
      borderUpColor:   "#059669",
      borderDownColor: "#dc2626",
      priceScaleId:    "right",
    });
    /* Ensure the right price scale always auto-fits visible bars */
    priceChart.priceScale("right").applyOptions({ autoScale: true });

    priceChartRef.current  = priceChart;
    priceSeriesRef.current = priceSeries;

    /* Redraw delta panel whenever the user scrolls/zooms.
       subscribeVisibleLogicalRangeChange returns an unsubscribe fn in lw-charts v4+
       and undefined in v3 — guard with optional chaining in cleanup. */
    const tsScale = priceChart.timeScale();
    tsScale.subscribeVisibleLogicalRangeChange(scheduleDrawDelta);

    /* Resize both chart and canvas whenever the container changes size */
    const ro = new ResizeObserver(() => {
      const el = priceContainerRef.current;
      if (priceChartRef.current && el) {
        priceChartRef.current.applyOptions({
          width:  el.clientWidth,
          height: el.clientHeight,
        });
      }
      scheduleDrawDelta();
    });
    ro.observe(priceEl);
    if (deltaCanvasRef.current) ro.observe(deltaCanvasRef.current);

    return () => {
      /* Use the stored reference for unsubscribe (works on both v3 and v4) */
      try { tsScale.unsubscribeVisibleLogicalRangeChange(scheduleDrawDelta); } catch (_) {}
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      priceChart.remove();
      priceChartRef.current  = null;
      priceSeriesRef.current = null;
    };
  }, [scheduleDrawDelta]);

  /* ── Effect 2: push data whenever candles change ── */
  const hasInitialFit = useRef(false);
  useEffect(() => {
    if (!priceSeriesRef.current || !candles?.length) return;

    const merged = buildMerged(candles, toChartTime);
    mergedRef.current = merged;

    priceSeriesRef.current.setData(
      merged.map((c) => ({
        time:  c.chartTime,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
      }))
    );

    if (!hasInitialFit.current && merged.length > 0) {
      hasInitialFit.current = true;
      /* fitContent fires subscribeVisibleLogicalRangeChange → scheduleDrawDelta */
      priceChartRef.current?.timeScale().fitContent();
    } else {
      /* Live update: range unchanged, subscription won't fire — redraw manually */
      scheduleDrawDelta();
    }
  }, [candles, toChartTime, scheduleDrawDelta]);

  /* Reset fit flag on fresh mount */
  useEffect(() => { hasInitialFit.current = false; }, []);

  /* ── HFT chart: create / destroy when showHFT toggles ─────────────────── */
  useEffect(() => {
    if (!showHFT) return;
    const el = hftContainerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout:   { background: { color: "transparent" }, textColor: "#64748b", fontFamily: "JetBrains Mono, monospace", fontSize: 10 },
      grid:     { vertLines: { color: "rgba(0,0,0,0.05)" }, horzLines: { color: "rgba(0,0,0,0.05)" } },
      rightPriceScale: { borderColor: "rgba(0,0,0,0.06)", autoScale: true, scaleMargins: { top: 0.05, bottom: 0.02 } },
      timeScale: { visible: false },  // hide — synced with price chart
      crosshair: { vertLine: { color: "rgba(2,132,199,0.4)", width: 1 }, horzLine: { visible: false } },
      width:  el.clientWidth  || 600,
      height: el.clientHeight || HFT_PANE_DEFAULT,
      handleScroll: false,
      handleScale:  false,
    });

    const refs = {};
    [...HFT_STACK_ORDER].reverse().forEach((ft) => {
      refs[ft] = chart.addHistogramSeries({
        color:            HFT_FLOW_COLORS[ft],
        priceScaleId:     "right",
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat:      { type: "custom", minMove: 1, formatter: fmtFlow },
      });
    });
    hftChartRef.current    = chart;
    hftFlowRefs.current    = refs;

    // Sync time range with price chart
    const priceChart = priceChartRef.current;
    const onPriceRange = (range) => {
      if (hftSyncingRef.current || !range) return;
      hftSyncingRef.current = true;
      chart.timeScale().setVisibleLogicalRange(range);
      hftSyncingRef.current = false;
    };
    const onHFTRange = (range) => {
      if (hftSyncingRef.current || !range) return;
      hftSyncingRef.current = true;
      priceChart?.timeScale().setVisibleLogicalRange(range);
      hftSyncingRef.current = false;
    };
    priceChart?.timeScale().subscribeVisibleLogicalRangeChange(onPriceRange);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onHFTRange);

    // Copy current visible range immediately
    const cur = priceChart?.timeScale().getVisibleLogicalRange();
    if (cur) chart.timeScale().setVisibleLogicalRange(cur);

    const ro = new ResizeObserver(() => {
      if (hftChartRef.current && hftContainerRef.current) {
        hftChartRef.current.applyOptions({
          width:  hftContainerRef.current.clientWidth,
          height: hftContainerRef.current.clientHeight,
        });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      try { priceChart?.timeScale().unsubscribeVisibleLogicalRangeChange(onPriceRange); } catch (_) {}
      chart.remove();
      hftChartRef.current = null;
      hftFlowRefs.current = {};
    };
  }, [showHFT]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── HFT chart: update series data when hftSeries prop changes ─────────── */
  useEffect(() => {
    if (!showHFT || !hftSeries?.length) return;
    const refs = hftFlowRefs.current;
    if (!Object.keys(refs).length) return;

    const dataByType = {};
    HFT_STACK_ORDER.forEach((ft) => { dataByType[ft] = []; });
    hftSeries.forEach((snap) => {
      let cumSum = 0;
      HFT_STACK_ORDER.forEach((ft) => {
        cumSum += snap.flows?.[ft] ?? 0;
        dataByType[ft].push({ time: snap.ts, value: cumSum });
      });
    });
    HFT_STACK_ORDER.forEach((ft) => { refs[ft]?.setData(dataByType[ft]); });

    // Fit HFT range to match price chart
    const cur = priceChartRef.current?.timeScale().getVisibleLogicalRange();
    if (cur) hftChartRef.current?.timeScale().setVisibleLogicalRange(cur);
  }, [hftSeries, showHFT]);

  /* ── Drag handle: resize HFT pane ────────────────────────────────────── */
  const handleDragStart = useCallback((e) => {
    isDraggingRef.current = true;
    dragStartYRef.current = e.clientY;
    dragStartHRef.current = hftPaneH;
    e.preventDefault();

    const onMove = (ev) => {
      if (!isDraggingRef.current) return;
      const diff = ev.clientY - dragStartYRef.current; // drag down = bigger pane
      setHftPaneH(Math.max(HFT_PANE_MIN, Math.min(HFT_PANE_MAX, dragStartHRef.current + diff)));
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [hftPaneH]);

  const handleFit = useCallback(() => {
    priceChartRef.current?.timeScale().fitContent();
  }, []);

  if (!candles?.length) return null;

  /* Header stats — computed from latest merged state */
  const merged     = mergedRef.current;
  const lastCandle = merged[merged.length - 1];
  const lastDelta  = lastCandle?.delta ?? 0;
  let totalCvd = 0, totalVol = 0;
  merged.forEach((c) => {
    totalCvd += c.delta ?? 0;
    totalVol += (c.buy_vol ?? 0) + (c.sell_vol ?? 0);
  });

  return (
    <div className={`orderflow-chart${isFullscreen ? " of-fullscreen" : ""}`}>
      {/* ── Header ── */}
      <div className="chart-header">
        <span className="chart-title">{symbol} — Price</span>
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
          <span className={lastDelta >= 0 ? "pos" : "neg"}>
            Δ {lastDelta >= 0 ? "+" : ""}{fmtVol(lastDelta)}
          </span>
          <span className="chart-sep">|</span>
          <span className={totalCvd >= 0 ? "pos" : "neg"}>
            CVD {totalCvd >= 0 ? "+" : ""}{fmtVol(totalCvd)}
          </span>
          <span className="chart-sep">|</span>
          <span>Vol {fmtVol(totalVol)}</span>
        </div>
      </div>

      {/* ── Price chart ── */}
      <div ref={priceContainerRef} className="chart-pane chart-pane-price" />

      {/* ── HFT overlay pane (between price chart and delta panel) ── */}
      {showHFT && (
        <>
          {/* Drag handle */}
          <div
            onMouseDown={handleDragStart}
            title="Drag to resize HFT panel"
            style={{
              height:     6,
              cursor:     "row-resize",
              background: "rgba(0,0,0,0.07)",
              display:    "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              userSelect: "none",
            }}
          >
            <span style={{ width: 32, height: 2, borderRadius: 1, background: "rgba(0,0,0,0.25)", display: "block" }} />
          </div>
          {/* HFT bars */}
          <div
            ref={hftContainerRef}
            style={{ height: hftPaneH, flexShrink: 0, position: "relative" }}
          >
            {/* Legend strip */}
            <div style={{
              position: "absolute", top: 0, left: 0, right: 0, zIndex: 1,
              display: "flex", flexWrap: "wrap", gap: "2px 6px",
              padding: "2px 6px",
              background: "rgba(255,255,255,0.75)",
              fontSize: 9, fontFamily: "JetBrains Mono, monospace",
              pointerEvents: "none",
            }}>
              {HFT_STACK_ORDER.map((ft) => (
                <span key={ft} style={{ color: HFT_FLOW_COLORS[ft], fontWeight: 700 }}>
                  ■ {ft}
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Delta panel: fixed label column + pixel-aligned canvas ── */}
      <div className="delta-panel" style={{ height: (showOI ? 4 : 3) * ROW_H_PX }}>
        <div className="delta-panel-labels">
          <div>TICK Δ</div>
          <div>CVD</div>
          <div>VOL</div>
          {showOI && <div>OI</div>}
        </div>
        <canvas ref={deltaCanvasRef} className="delta-panel-canvas" />
      </div>
    </div>
  );
}

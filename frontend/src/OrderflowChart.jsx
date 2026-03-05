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
  "Dark Pool CE":        "#0ea5e9",   // sky blue — bullish, distinct from PE
  "Dark Pool PE":        "#f97316",   // orange — bearish, high contrast
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
const HFT_PANE_MIN = 0.2;   // min fraction of chart for HFT (20%)
const HFT_PANE_MAX = 0.55;  // max fraction (55%)
const HFT_PANE_DEFAULT = 0.35;  // default 35% for HFT strip

/** Aggregate HFT snaps into N-min buckets to match chart timeframe. */
function aggregateHftForOverlay(series, targetMinutes) {
  if (!series?.length || targetMinutes <= 1) return series;
  const secPerBucket = targetMinutes * 60;
  const buckets = {};
  for (const snap of series) {
    const bucketTs = Math.floor(snap.ts / secPerBucket) * secPerBucket;
    if (!buckets[bucketTs]) {
      buckets[bucketTs] = { ts: bucketTs, flows: { ...(snap.flows || {}) } };
    } else {
      for (const [k, v] of Object.entries(snap.flows || {})) {
        buckets[bucketTs].flows[k] = (buckets[bucketTs].flows[k] || 0) + v;
      }
    }
  }
  return Object.values(buckets).sort((a, b) => a.ts - b.ts);
}

/* ════════════════════════════════════════════════════════
   COMPONENT
════════════════════════════════════════════════════════ */
export default function OrderflowChart({ candles, symbol, features = {}, isIndexFuture = false, hftSeries = [], timeFrameMinutes = 1 }) {
  const showOI  = features.showOI  ?? true;
  const showHFT = features.showHFT ?? false;
  const showHftOverlay = showHFT && isIndexFuture;

  const priceContainerRef = useRef(null);
  const priceChartRef     = useRef(null);
  const priceSeriesRef    = useRef(null);
  const deltaCanvasRef    = useRef(null);
  const mergedRef         = useRef([]);
  const rafRef            = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ── HFT overlay (same chart, separate price scale) ───────────────────────
  const hftFlowRefs      = useRef({});   // flowType → IHistogramSeriesApi
  const [hftPaneH, setHftPaneH] = useState(HFT_PANE_DEFAULT);  // fraction 0.2–0.55
  const [hftVisibleFlows, setHftVisibleFlows] = useState(() => new Set(HFT_STACK_ORDER));
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

  /* ── HFT overlay: add/remove histogram series on SAME chart when showHftOverlay toggles ── */
  /* Single chart = perfect alignment; no sync logic needed. */
  useEffect(() => {
    const chart = priceChartRef.current;
    if (!chart) return;

    if (showHftOverlay) {
      const refs = {};
      [...HFT_STACK_ORDER].reverse().forEach((ft) => {
        refs[ft] = chart.addHistogramSeries({
          color:            HFT_FLOW_COLORS[ft],
          priceScaleId:     "hft",
          lastValueVisible: false,
          priceLineVisible: false,
          priceFormat:      { type: "custom", minMove: 1, formatter: fmtFlow },
        });
      });
      hftFlowRefs.current = refs;
    } else {
      Object.values(hftFlowRefs.current).forEach((s) => { try { chart.removeSeries(s); } catch (_) {} });
      hftFlowRefs.current = {};
    }
  }, [showHftOverlay]);

  /* ── HFT scale margins: candles top, HFT bottom; hftPaneH = fraction for HFT ── */
  useEffect(() => {
    const chart = priceChartRef.current;
    if (!chart) return;
    if (showHftOverlay) {
      const hftFrac = Math.max(HFT_PANE_MIN, Math.min(HFT_PANE_MAX, hftPaneH));
      chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: hftFrac } });
      chart.priceScale("hft").applyOptions({ scaleMargins: { top: 1 - hftFrac, bottom: 0.02 } });
    } else {
      chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
    }
  }, [showHftOverlay, hftPaneH]);

  /* ── HFT overlay: update series data when hftSeries or visibility changes ── */
  useEffect(() => {
    if (!showHftOverlay || !hftSeries?.length) return;
    const refs = hftFlowRefs.current;
    if (!Object.keys(refs).length) return;

    const aggregated = aggregateHftForOverlay(hftSeries, timeFrameMinutes);
    const visible = hftVisibleFlows;

    const dataByType = {};
    HFT_STACK_ORDER.forEach((ft) => { dataByType[ft] = {}; });

    mergedRef.current.forEach(({ chartTime: t }) => {
      HFT_STACK_ORDER.forEach((ft) => { dataByType[ft][t] = 0; });
    });

    aggregated.forEach((snap) => {
      const chartTime = snap.ts + 19800;
      let cumSum = 0;
      HFT_STACK_ORDER.forEach((ft) => {
        if (visible.has(ft)) {
          cumSum += snap.flows?.[ft] ?? 0;
          dataByType[ft][chartTime] = cumSum;
        }
      });
    });

    HFT_STACK_ORDER.forEach((ft) => {
      const sorted = visible.has(ft)
        ? Object.entries(dataByType[ft])
            .map(([t, v]) => ({ time: Number(t), value: v }))
            .sort((a, b) => a.time - b.time)
        : [];
      refs[ft]?.setData(sorted);
    });
  }, [hftSeries, showHftOverlay, timeFrameMinutes, hftVisibleFlows]);

  /* ── Drag handle: resize HFT strip (adjusts scaleMargins) ─────────────── */
  const handleDragStart = useCallback((e) => {
    isDraggingRef.current = true;
    dragStartYRef.current = e.clientY;
    dragStartHRef.current = hftPaneH;
    e.preventDefault();

    const onMove = (ev) => {
      if (!isDraggingRef.current) return;
      const chartH = priceContainerRef.current?.clientHeight || 400;
      const deltaFrac = (ev.clientY - dragStartYRef.current) / chartH;
      setHftPaneH(Math.max(HFT_PANE_MIN, Math.min(HFT_PANE_MAX, dragStartHRef.current + deltaFrac)));
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

      {/* ── Single chart: candlesticks + HFT bars (same chart, separate price scales) ── */}
      {showHftOverlay && (
        <div style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px",
          padding: "4px 8px", borderBottom: "1px solid rgba(0,0,0,0.06)",
          fontSize: 10, fontFamily: "JetBrains Mono, monospace", userSelect: "none",
        }}>
          <button type="button" className="chart-fit-btn" onClick={() => setHftVisibleFlows(new Set(HFT_STACK_ORDER))}>All</button>
          <button type="button" className="chart-fit-btn" onClick={() => setHftVisibleFlows(new Set())}>None</button>
          <span style={{ width: 1, height: 14, background: "rgba(0,0,0,0.1)", margin: "0 2px" }} />
          {HFT_STACK_ORDER.map((ft) => {
            const active = hftVisibleFlows.has(ft);
            const color = HFT_FLOW_COLORS[ft];
            return (
              <button
                key={ft}
                type="button"
                onClick={() => setHftVisibleFlows((prev) => {
                  const next = new Set(prev);
                  next.has(ft) ? next.delete(ft) : next.add(ft);
                  return next;
                })}
                title={active ? `Hide ${ft}` : `Show ${ft}`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 3,
                  padding: "2px 7px", border: `1px solid ${active ? color : "rgba(0,0,0,0.12)"}`,
                  borderRadius: 3, background: active ? `${color}18` : "transparent",
                  color: active ? color : "#94a3b8", fontFamily: "JetBrains Mono, monospace",
                  fontSize: 10, fontWeight: active ? 700 : 400, cursor: "pointer",
                  textDecoration: active ? "none" : "line-through",
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 2, background: active ? color : "#cbd5e1" }} />
                {ft}
              </button>
            );
          })}
        </div>
      )}
      <div ref={priceContainerRef} className="chart-pane chart-pane-price" style={{ position: "relative" }} />

      {showHftOverlay && (
        <div
          onMouseDown={handleDragStart}
          title="Drag to resize HFT strip"
          style={{
            height: 6, cursor: "row-resize", background: "rgba(0,0,0,0.07)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, userSelect: "none",
          }}
        >
          <span style={{ width: 32, height: 2, borderRadius: 1, background: "rgba(0,0,0,0.25)", display: "block" }} />
        </div>
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

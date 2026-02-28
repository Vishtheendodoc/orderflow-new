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
  const n = Number(v);
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
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
    }
  });
  return Array.from(byTime.values()).sort((a, b) => a.chartTime - b.chartTime);
}

/* Width (px) of the fixed row-label column inside the delta panel */
const LABEL_COL_W = 42;
/* Height (px) of the delta panel */
const DELTA_PANEL_H = 72;

/* ════════════════════════════════════════════════════════
   COMPONENT
════════════════════════════════════════════════════════ */
export default function OrderflowChart({ candles, symbol }) {
  const priceContainerRef = useRef(null);
  const priceChartRef     = useRef(null);
  const priceSeriesRef    = useRef(null);
  const deltaCanvasRef    = useRef(null);
  const mergedRef         = useRef([]);
  const rafRef            = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

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

    /* Resize backing store only when needed (avoids flicker) */
    const tw = Math.round(W * dpr);
    const th = Math.round(H * dpr);
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width  = tw;
      canvas.height = th;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const ts    = chart.timeScale();
    const ROW_H = H / 3;

    /* Running CVD per bar */
    let runCvd = 0;
    const cvdArr = merged.map((c) => { runCvd += c.delta ?? 0; return runCvd; });

    /* Visible logical index range */
    const range = ts.getVisibleLogicalRange();
    const iFrom = range ? Math.max(0, Math.floor(range.from)) : 0;
    const iTo   = range ? Math.min(merged.length - 1, Math.ceil(range.to)) : merged.length - 1;

    /* Estimate half-bar-width from the spacing between two adjacent visible bars */
    let halfW = 18;
    for (let k = iFrom; k < Math.min(iTo, iFrom + 8); k++) {
      const xa = ts.timeToCoordinate(merged[k].chartTime);
      const xb = ts.timeToCoordinate(merged[k + 1]?.chartTime);
      if (xa != null && xb != null && xb > xa) {
        halfW = (xb - xa) * 0.42;
        break;
      }
    }
    halfW = Math.max(halfW, 5);

    const fontSize = Math.max(Math.min(Math.floor(ROW_H * 0.46), 10), 7);
    ctx.font         = `bold ${fontSize}px "JetBrains Mono", monospace`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    for (let i = iFrom; i <= iTo; i++) {
      const c      = merged[i];
      const chartX = ts.timeToCoordinate(c.chartTime);
      if (chartX == null) continue;

      /* Translate from chart-space to canvas-space (canvas starts after label col) */
      const cx = chartX - LABEL_COL_W;
      const bx = cx - halfW + 1;
      const bw = halfW * 2 - 2;
      if (bx + bw < 0 || bx > W) continue;

      const delta = c.delta ?? 0;
      const cvd   = cvdArr[i];
      const vol   = (c.buy_vol ?? 0) + (c.sell_vol ?? 0);

      /* ── Row 0: Tick Delta ── */
      ctx.fillStyle = delta >= 0 ? "rgba(7, 156, 84, 0.62)" : "rgba(255, 70, 70, 0.6)";
      ctx.fillRect(bx, 2, bw, ROW_H - 4);
      ctx.fillStyle = delta >= 0 ? "#00d26e" : "#ff4646";
      ctx.fillText(fmtVol(delta), cx, ROW_H * 0.5);

      /* ── Row 1: Cumulative Delta (CVD) ── */
      ctx.fillStyle = cvd >= 0 ? "rgba(7, 156, 84, 0.62)" : "rgba(255, 70, 70, 0.6)";
      ctx.fillRect(bx, ROW_H + 2, bw, ROW_H - 4);
      ctx.fillStyle = cvd >= 0 ? "#00d26e" : "#ff4646";
      ctx.fillText(fmtVol(cvd), cx, ROW_H * 1.5);

      /* ── Row 2: Total Volume ── */
      ctx.fillStyle = "rgba(184, 191, 201, 0.8)";
      ctx.fillRect(bx, ROW_H * 2 + 2, bw, ROW_H - 4);
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(fmtVol(vol), cx, ROW_H * 2.5);
    }
  }, []);

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

      {/* ── Delta panel: fixed label column + pixel-aligned canvas ── */}
      <div className="delta-panel">
        <div className="delta-panel-labels">
          <div>TICK Δ</div>
          <div>CVD</div>
          <div>VOL</div>
        </div>
        <canvas ref={deltaCanvasRef} className="delta-panel-canvas" />
      </div>
    </div>
  );
}

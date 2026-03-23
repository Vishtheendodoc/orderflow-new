/**
 * IntentChart — Intent Map Score (IMS) tab.
 * Candlesticks + regime background, intent bars, trap markers, IMS row, cumulative IMS curve.
 */
import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { createChart } from "lightweight-charts";
import { computeIMS, computeRegime, detectTrap } from "./utils/intentMapScore";

const toMs = (t) => (t != null && t < 1e12 ? t * 1000 : t);
const _pad = (n) => String(n).padStart(2, "0");

const istDateKeyMs = (ms) => {
  const d = new Date(toMs(ms));
  return `${d.getUTCFullYear()}-${_pad(d.getUTCMonth() + 1)}-${_pad(d.getUTCDate())}`;
};

const fmtIST = (utcSec) => {
  const d = new Date(utcSec * 1000);
  return `${_pad(d.getUTCHours())}:${_pad(d.getUTCMinutes())}`;
};

const fmtVol = (v) => {
  const n = Math.abs(Number(v));
  if (n >= 1e6) return (Number(v) / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (Number(v) / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(Number(v)));
};

const CHART_OPTIONS = {
  layout: { background: { color: "transparent" }, textColor: "#64748b", fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
  localization: { timeFormatter: (t) => fmtIST(typeof t === "number" ? t : 0) },
  grid: { vertLines: { color: "rgba(0,0,0,0.06)" }, horzLines: { color: "rgba(0,0,0,0.06)" } },
  rightPriceScale: { borderColor: "rgba(0,0,0,0.06)", autoScale: true, scaleMargins: { top: 0.08, bottom: 0.08 } },
  timeScale: { borderColor: "rgba(0,0,0,0.06)", timeVisible: true, secondsVisible: false, tickMarkFormatter: (t) => fmtIST(typeof t === "number" ? t : 0) },
  crosshair: { vertLine: { color: "rgba(2,132,199,0.5)", width: 1 }, horzLine: { color: "rgba(2,132,199,0.5)", width: 1 } },
};

function hasValidPrice(c) {
  const o = c.open, h = c.high, l = c.low, cl = c.close;
  return o > 0 && !isNaN(o) && cl > 0 && !isNaN(cl) && h > 0 && !isNaN(h) && l > 0 && !isNaN(l) && l < 1e8;
}

function buildBars(candles) {
  if (!candles?.length) return [];
  const sorted = [...candles]
    .filter(hasValidPrice)
    .sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
  return sorted.map((c) => ({
    ...c,
    chartTime: Math.floor(toMs(c.open_time) / 1000),
  }));
}

const LABEL_COL_W = 42;
const ROW_H_PX = 22;

const REGIME_LABELS = { initiative_buy: "IB", responsive_sell: "RS", absorption: "Abs", neutral: "—" };
const REGIME_COLORS = { initiative_buy: "rgba(5,150,105,0.25)", responsive_sell: "rgba(220,38,38,0.25)", absorption: "rgba(148,163,184,0.2)", neutral: "transparent" };

export default function IntentChart({
  candles,
  symbol,
  timeFrameMinutes = 1,
  features = {},
}) {
  const showOI = features.showOI ?? true;
  const showIntentBar = features.showIntentBar ?? true;
  const showIMSTint = features.showIMSTint ?? false;
  const showCumIMS = features.showCumIMS ?? false;
  const showRegime = features.showRegime ?? true;
  const showTrap = features.showTrap ?? true;
  const imsWeights = features.imsWeights ?? { w1: 0.2, w2: 0.2, w3: 0.2, w4: 0.2, w5: 0.2 };

  const priceContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const stripCanvasRef = useRef(null);
  const regimeOverlayRef = useRef(null);
  const mergedRef = useRef([]);
  const rafRef = useRef(null);

  const toChartTime = useCallback((openTime) => Math.floor(toMs(openTime) / 1000), []);

  const barsWithIMS = useMemo(() => {
    const bars = buildBars(candles ?? []);
    if (!bars.length) return [];
    let runCvd = 0;
    let prevDay = null;
    bars.forEach((b) => {
      const day = istDateKeyMs(b.open_time);
      if (prevDay != null && day !== prevDay) runCvd = 0;
      prevDay = day;
      runCvd += b.delta ?? (b.buy_vol ?? 0) - (b.sell_vol ?? 0);
      b.cvd = runCvd;
    });
    computeIMS(bars, { weights: imsWeights });
    computeRegime(bars);
    detectTrap(bars);
    return bars;
  }, [candles, imsWeights]);

  const drawStrip = useCallback(() => {
    const canvas = stripCanvasRef.current;
    const chart = chartRef.current;
    const merged = mergedRef.current;
    if (!canvas || !chart || !merged.length) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;

    const tw = Math.round(W * dpr);
    const th = Math.round(H * dpr);
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const ts = chart.timeScale();
    const numRows = showOI ? 6 : 5;
    const ROW_H = H / numRows;
    const range = ts.getVisibleLogicalRange();
    const iFrom = range ? Math.max(0, Math.floor(range.from)) : 0;
    const iTo = range ? Math.min(merged.length - 1, Math.ceil(range.to)) : merged.length - 1;

    const coord = (i) => ts.logicalToCoordinate(i);

    ctx.font = `600 10px JetBrains Mono, monospace`;
    ctx.textBaseline = "middle";
    const labels = ["Δ", "CVD", "VOL", "IMS", "Reg"];
    if (showOI) labels.push("OI");
    labels.forEach((l, r) => {
      ctx.fillStyle = "#64748b";
      ctx.textAlign = "right";
      ctx.fillText(l, LABEL_COL_W - 6, (r + 0.5) * ROW_H);
    });

    const maxAbsDelta = Math.max(1, ...merged.slice(iFrom, iTo + 1).map((c) => Math.abs(c.delta ?? 0)));
    const maxAbsCvd = Math.max(1, ...merged.slice(iFrom, iTo + 1).map((c) => Math.abs(c.cvd ?? 0)));

    for (let k = iFrom; k <= iTo; k++) {
      const c = merged[k];
      const cx = coord(k);
      if (cx < LABEL_COL_W || cx > W - 8) continue;

      const delta = c.delta ?? 0;
      const cvd = c.cvd ?? 0;
      const vol = (c.buy_vol ?? 0) + (c.sell_vol ?? 0);
      const ims = c.ims ?? 0;
      const regime = c.regime ?? "neutral";
      const trap = c.trap ?? null;

      ctx.textAlign = "center";

      // Delta
      ctx.fillStyle = delta >= 0 ? "#047857" : "#b91c1c";
      ctx.fillText(fmtVol(delta), cx, ROW_H * 0.5);

      // CVD
      ctx.fillStyle = cvd >= 0 ? "#047857" : "#b91c1c";
      ctx.fillText(fmtVol(cvd), cx, ROW_H * 1.5);

      // VOL
      ctx.fillStyle = "#475569";
      ctx.fillText(fmtVol(vol), cx, ROW_H * 2.5);

      // IMS (with optional intent bar)
      const halfW = 18;
      if (showIntentBar && Math.abs(ims) > 0.05) {
        const barW = 4;
        const barH = Math.min(ROW_H - 4, Math.abs(ims) * (ROW_H - 4));
        ctx.fillStyle = ims >= 0 ? "rgba(5,150,105,0.7)" : "rgba(220,38,38,0.7)";
        ctx.fillRect(cx - barW / 2, ROW_H * 3 + (ROW_H - barH) / 2, barW, barH);
      }
      ctx.fillStyle = ims >= 0 ? "#047857" : "#b91c1c";
      ctx.fillText(ims.toFixed(2), cx, ROW_H * 3.5);

      // Regime (with background tint)
      if (showRegime) {
        if (showIMSTint && REGIME_COLORS[regime]) {
          ctx.fillStyle = REGIME_COLORS[regime];
          ctx.fillRect(cx - halfW, ROW_H * 4, halfW * 2, ROW_H);
        }
        ctx.fillStyle = "#334155";
        ctx.fillText(REGIME_LABELS[regime] ?? "—", cx, ROW_H * 4.5);
        if (trap && showTrap) {
          ctx.font = "900 10px monospace";
          ctx.fillStyle = trap === "trapped_buyers" ? "#dc2626" : "#059669";
          ctx.fillText(trap === "trapped_buyers" ? "▼" : "▲", cx, ROW_H * 4.5 - 2);
          ctx.font = "600 10px JetBrains Mono, monospace";
        }
      }

      if (showOI) {
        ctx.fillStyle = (c.oi_change ?? 0) >= 0 ? "#047857" : "#b91c1c";
        ctx.fillText(c.oi > 0 ? fmtVol(c.oi) : "—", cx, ROW_H * 5.5);
      }
    }
  }, [showOI, showIntentBar, showIMSTint, showRegime, showTrap]);

  const drawRegimeOverlay = useCallback(() => {
    const canvas = regimeOverlayRef.current;
    const chart = chartRef.current;
    const merged = mergedRef.current;
    if (!canvas || !chart || !merged.length || !showRegime) return;

    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    const iFrom = range ? Math.max(0, Math.floor(range.from)) : 0;
    const iTo = range ? Math.min(merged.length - 1, Math.ceil(range.to)) : merged.length - 1;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;

    const tw = Math.round(W * dpr);
    const th = Math.round(H * dpr);
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const coord = (i) => ts.logicalToCoordinate(i);
    for (let k = iFrom; k <= iTo; k++) {
      const regime = merged[k]?.regime ?? "neutral";
      const color = REGIME_COLORS[regime];
      if (!color || color === "transparent") continue;
      const x1 = coord(k);
      const x2 = k < merged.length - 1 ? coord(k + 1) : coord(k) + 20;
      if (x2 <= x1) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x1, 0, x2 - x1, H);
    }
  }, [showRegime]);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawStrip();
      drawRegimeOverlay();
    });
  }, [drawStrip, drawRegimeOverlay]);

  useEffect(() => {
    mergedRef.current = barsWithIMS;
  }, [barsWithIMS]);

  useEffect(() => {
    const priceEl = priceContainerRef.current;
    if (!priceEl || !barsWithIMS.length) return;

    const chart = createChart(priceEl, { ...CHART_OPTIONS, width: priceEl.clientWidth, height: priceEl.clientHeight });
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#059669",
      downColor: "#dc2626",
      borderUpColor: "#059669",
      borderDownColor: "#dc2626",
    });

    candleSeries.setData(barsWithIMS.map((c) => ({ time: c.chartTime, open: c.open, high: c.high, low: c.low, close: c.close })));

    const traps = barsWithIMS
      .filter((b) => b.trap)
      .map((b) => ({
        time: b.chartTime,
        position: b.trap === "trapped_buyers" ? "belowBar" : "aboveBar",
        color: b.trap === "trapped_buyers" ? "#dc2626" : "#059669",
        shape: "arrowDown",
        text: b.trap === "trapped_buyers" ? "T" : "T",
      }));
    candleSeries.setMarkers(traps);

    chart.timeScale().fitContent();
    chartRef.current = chart;
    seriesRef.current = candleSeries;

    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleDraw);
    scheduleDraw();

    const ro = new ResizeObserver(() => {
      if (chartRef.current && priceEl) {
        chartRef.current.applyOptions({ width: priceEl.clientWidth, height: priceEl.clientHeight });
      }
      scheduleDraw();
    });
    ro.observe(priceEl);

    return () => {
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleDraw);
      } catch (_) {}
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [barsWithIMS, scheduleDraw]);

  useEffect(() => {
    if (!seriesRef.current || !barsWithIMS.length) return;
    seriesRef.current.setData(barsWithIMS.map((c) => ({ time: c.chartTime, open: c.open, high: c.high, low: c.low, close: c.close })));
    const traps = barsWithIMS
      .filter((b) => b.trap && showTrap)
      .map((b) => ({
        time: b.chartTime,
        position: b.trap === "trapped_buyers" ? "belowBar" : "aboveBar",
        color: b.trap === "trapped_buyers" ? "#dc2626" : "#059669",
        shape: "arrowDown",
        text: "T",
      }));
    seriesRef.current.setMarkers(traps);
    scheduleDraw();
  }, [barsWithIMS, showTrap, scheduleDraw]);

  const cumImsData = useMemo(() => {
    let run = 0;
    let prevDay = null;
    return barsWithIMS.map((b) => {
      const day = istDateKeyMs(b.open_time);
      if (prevDay != null && day !== prevDay) run = 0;
      prevDay = day;
      run += b.ims ?? 0;
      return { ...b, cumIms: run };
    });
  }, [barsWithIMS]);

  if (!candles?.length) {
    return (
      <div className="intent-chart-empty" style={{ padding: 48, textAlign: "center", color: "#64748b" }}>
        <p>Waiting for data…</p>
        <p style={{ fontSize: 12 }}>Select a symbol and wait for candles to load.</p>
      </div>
    );
  }

  const last = barsWithIMS[barsWithIMS.length - 1];
  const cumImsMax = Math.max(1, ...cumImsData.map((d) => Math.abs(d.cumIms)));
  const cumImsMin = -cumImsMax;

  return (
    <div className="intent-chart-wrap" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 320 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, color: "#1e293b" }}>{symbol}</span>
        <span style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b" }}>{timeFrameMinutes}m</span>
        <span style={{ fontFamily: "monospace", fontWeight: 600, color: "#334155" }}>
          {last?.close != null ? last.close.toFixed(2) : "—"}
        </span>
        <span style={{ fontSize: 11, color: "#64748b", marginLeft: "auto" }}>
          IMS: {last?.ims != null ? last.ims.toFixed(2) : "—"} | Regime: {REGIME_LABELS[last?.regime] ?? "—"}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 200, position: "relative" }}>
        <div ref={priceContainerRef} style={{ position: "absolute", inset: 0 }} />
        <canvas
          ref={regimeOverlayRef}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
          width={10}
          height={10}
        />
      </div>

      <div style={{ flexShrink: 0, height: (showOI ? 6 : 5) * ROW_H_PX, borderTop: "1px solid #e2e8f0" }}>
        <canvas ref={stripCanvasRef} width={10} height={(showOI ? 6 : 5) * ROW_H_PX} style={{ width: "100%", height: "100%", display: "block" }} />
      </div>

      {showCumIMS && cumImsData.length > 0 && (
        <div className="cum-ims-panel" style={{ height: 80, borderTop: "1px solid #e2e8f0", padding: "4px 8px" }}>
          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 2 }}>Cumulative IMS (session)</div>
          <svg width="100%" height={56} preserveAspectRatio="none" style={{ display: "block" }} viewBox="0 0 400 56">
            <defs>
              <linearGradient id="cumImsGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#059669" stopOpacity="0.5" />
                <stop offset="0.5" stopColor="transparent" />
                <stop offset="1" stopColor="#dc2626" stopOpacity="0.5" />
              </linearGradient>
            </defs>
            <polygon
              fill="url(#cumImsGrad)"
              stroke="#64748b"
              strokeWidth="1"
              points={[
                "0,56",
                ...cumImsData.map((d, i) => {
                  const x = (cumImsData.length > 1 ? i / (cumImsData.length - 1) : 0) * 400;
                  const y = 52 - ((d.cumIms - cumImsMin) / (cumImsMax - cumImsMin || 1)) * 48;
                  return `${x},${Math.max(2, Math.min(50, y))}`;
                }),
                "400,56"
              ].join(" ")}
            />
          </svg>
        </div>
      )}
    </div>
  );
}

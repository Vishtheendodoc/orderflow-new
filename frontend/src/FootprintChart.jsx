/**
 * FootprintChart.jsx — v7
 *
 * Key fixes:
 *  1. Auto-scroll ONLY on new candle appended, NOT on every render/data update.
 *     While user is panning, chart stays put completely.
 *  2. Price axis — major price levels only (sparse labels on right), not every print level
 *  3. Candle body = 4px wide stripe only. Wick = 1px line.
 *  4. Numbers have full left/right space, no overlap with body
 *  5. Price shown on left edge of each level row (like reference image)
 *  6. Row height expands so numbers are legible at all zoom levels
 */

import { useMemo, useRef, useEffect, useCallback, useState } from "react";

/* ─── palette ─── */
const C = {
  bg:       "#f9fafc",
  bgPanel:  "#f4f5f8",
  grid:     "#eaecf2",
  gridTick: "#d8dce8",
  border:   "#dde1ea",
  buy:      "#00695c",   // Teal 700 – imbalance highlight (~5.9:1 on white)
  buyMid:   "#00897b",   // Teal 600 – regular volume  (~4.2:1 on white)
  buyHL:    "rgba(0,137,123,0.18)",
  buyLine:  "rgba(0,137,123,0.50)",
  sell:     "#c62828",   // Red 800  – imbalance highlight (~5.3:1 on white)
  sellMid:  "#e53935",   // Red 600  – regular volume  (~4.1:1 on white)
  sellHL:   "rgba(229,57,53,0.18)",
  sellLine: "rgba(229,57,53,0.50)",
  bodyBull: "rgba(0,137,123,0.65)",
  brdBull:  "#00897b",
  bodyBear: "rgba(198,40,40,0.65)",
  brdBear:  "#c62828",
  textDark: "#1a2035",
  textMid:  "#6870a0",
  textDim:  "#a8b0c8",
  curBg:    "rgba(155,125,255,0.07)",
  daySep:   "rgba(90, 96, 130, 0.72)",  // IST session boundary (between calendar days)
};

const MONO = "'JetBrains Mono','Fira Mono','Consolas',monospace";
const SANS = "'IBM Plex Sans','Segoe UI',sans-serif";
const GAP         = 2;
const NZW  = 80; // default numbers-zone width – shadowed per-device inside component
const PS_W     = 60;   // price scale width
const LABEL_W  = 52;   // bottom strip label column width (chart must start here to align)
const HDR_H    = 48;
const TIME_H   = 24;
const BOT_H    = 68;
const W_MIN    = 8;    // minimum candle width (pinch can go this tight)
const W_MAX    = 180;
const BODY_HALF = 3;   // body is 6px wide total
const ROW_MIN  = 16;   // minimum px per row when computing level cap (fewer rows = more space each)
const ROW_PREF = 18;   // preferred
const ROW_MAX  = 28;
const RPAD = 30;  // space after last candle (shadowed inside component for mobile)
/** Upper bound aligned with backend MAX_LEVELS_PER_CANDLE (display merge target). */
const MAX_FOOTPRINT_DATA_LEVELS = 150;
const MIN_FOOTPRINT_DISPLAY_ROWS = 8;
/** Min vertical gap between footprint number rows (font + padding) in px. */
const FOOTPRINT_ROW_PAD_PX = 6;
/* ─── helpers ─── */
/* Only >= 1000 use K; 100–999 show as full number */
const fmtV = v => {
  const n = Math.abs(+v);
  if (n >= 1e6) return (+v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (+v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(+v));
};
const fmt2  = v => (+v).toFixed(2);
const fmtP  = v => {
  // for price axis: show integer if whole number, else .2f
  const n = +v;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};
const sgn   = v => v >= 0 ? "+" : "";
/** Normalize to ms (backend may send seconds). */
const toMs = t => (t != null && t < 1e12 ? t * 1000 : t);

const _MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/**
 * Dhan LTT timestamps are already in IST epoch (their clock epoch starts at IST midnight,
 * not UTC midnight). Reading them as UTC therefore gives the correct IST wall-clock time —
 * no +5:30 offset needed.
 */
const _ist = (ms) => new Date(toMs(ms));
const _pad = n => String(n).padStart(2, "0");

/** Format as IST "HH:MM" or "DD MMM HH:MM" — no browser locale needed. */
const toIST = (ms, withDate = false) => {
  if (!ms) return "--";
  const d = _ist(ms);
  const time = `${_pad(d.getUTCHours())}:${_pad(d.getUTCMinutes())}`;
  if (!withDate) return time;
  return `${_pad(d.getUTCDate())} ${_MON[d.getUTCMonth()]} ${time}`;
};
/** IST date string "DD MMM" for start-of-day labels. */
const toISTDate = (ms) => {
  if (!ms) return "";
  const d = _ist(ms);
  return `${_pad(d.getUTCDate())} ${_MON[d.getUTCMonth()]}`;
};
/** True if bar at i is first of the day in IST. */
const isFirstBarOfDayIST = (bars, i) => {
  if (!bars.length || i < 0) return false;
  if (i === 0) return true;
  const a = toISTDate(bars[i].open_time);
  const b = toISTDate(bars[i - 1].open_time);
  return a !== b;
};

/** Volume-at-price → VPOC + 70% value area (VAH, VAL) for a slice of footprint bars. */
function computeProfileValueArea(bars) {
  if (!bars?.length) return null;
  const profile = new Map();
  for (const b of bars) {
    for (const lv of Object.values(b.levels || {})) {
      const vol = (lv.buy_vol || 0) + (lv.sell_vol || 0);
      if (vol > 0) profile.set(lv.price, (profile.get(lv.price) || 0) + vol);
    }
  }
  if (profile.size === 0) return null;
  let vpoc = 0, maxVol = 0;
  for (const [p, v] of profile) {
    if (v > maxVol) { maxVol = v; vpoc = p; }
  }
  const totalVol = [...profile.values()].reduce((s, v) => s + v, 0);
  if (totalVol <= 0) return null;
  const vaTarget = totalVol * 0.70;
  const byVolDesc = [...profile.entries()].sort((a, b) => b[1] - a[1]);
  const vaSet = new Set();
  let cumVA = 0;
  for (const [p, v] of byVolDesc) {
    vaSet.add(p); cumVA += v;
    if (cumVA >= vaTarget) break;
  }
  const vaPrices = [...vaSet].sort((a, b) => a - b);
  return {
    vpoc,
    vah: vaPrices[vaPrices.length - 1],
    val: vaPrices[0],
  };
}

/** Inclusive [start, end] indices, one range per IST calendar day. */
function istDayIndexRanges(bars) {
  if (!bars?.length) return [];
  const ranges = [];
  let s = 0;
  for (let i = 1; i <= bars.length; i++) {
    if (i === bars.length || toISTDate(bars[i].open_time) !== toISTDate(bars[i - 1].open_time)) {
      ranges.push([s, i - 1]);
      s = i;
    }
  }
  return ranges;
}

/* round to nearest tick */
const snapTick = (v, tick) => Math.round(v / tick) * tick;

/* ─── processCandles ───
 * Full native levels per bar (no row cap). Viewport bucketing happens at draw time.
 */
function processCandles(candles) {
  if (!candles?.length) return { bars: [], priceMin: 0, priceMax: 1, priceRange: 1, tickSize: 0.5 };

  // detect tick size
  let tickSize = 0.5;
  for (const c of candles) {
    const lvs = Object.values(c.levels || {})
      .filter(l => l.price != null)
      .map(l => +l.price)
      .sort((a, b) => a - b);
    if (lvs.length >= 2) {
      const diffs = [];
      for (let i = 1; i < Math.min(lvs.length, 6); i++)
        diffs.push(+(lvs[i] - lvs[i - 1]).toFixed(6));
      tickSize = Math.min(...diffs.filter(d => d > 0));
      if (tickSize > 0) break;
    }
  }
  if (!tickSize || tickSize <= 0) tickSize = 0.5;

  const allP = candles.flatMap(c => [c.low, c.high]).filter(isFinite);
  let pMin = Math.min(...allP), pMax = Math.max(...allP);
  // extend by 3 ticks each side so rows show above/below extremes
  const pad = tickSize * 4;
  pMin = snapTick(pMin - pad, tickSize);
  pMax = snapTick(pMax + pad, tickSize);

  const bars = candles.map(c => {
    const lvs = Object.values(c.levels || {})
      .filter(l => l.price != null)
      .sort((a, b) => b.price - a.price);
    const tBuy  = lvs.reduce((s, l) => s + (l.buy_vol  || 0), 0);
    const tSell = lvs.reduce((s, l) => s + (l.sell_vol || 0), 0);
    const avgB  = lvs.length ? tBuy  / lvs.length : 0;
    const avgS  = lvs.length ? tSell / lvs.length : 0;
    const maxV  = lvs.reduce((m, l) => Math.max(m, (l.buy_vol || 0) + (l.sell_vol || 0)), 1);
    let levels = lvs.map(lv => ({
      ...lv,
      highBuy:  avgB > 0 && (lv.buy_vol  || 0) >= avgB * 2 && (lv.buy_vol  || 0) > (lv.sell_vol || 0),
      highSell: avgS > 0 && (lv.sell_vol || 0) >= avgS * 2 && (lv.sell_vol || 0) > (lv.buy_vol  || 0),
      volRatio: ((lv.buy_vol || 0) + (lv.sell_vol || 0)) / maxV,
    }));
    return { ...c, levels };
  });

  const priceRange = pMax - pMin;

  bars.forEach(b => {
    const tBuy  = b.levels.reduce((s, l) => s + (l.buy_vol || 0), 0);
    const tSell = b.levels.reduce((s, l) => s + (l.sell_vol || 0), 0);
    b.buy_vol  = b.buy_vol  ?? tBuy;
    b.sell_vol = b.sell_vol ?? tSell;
    b.delta    = b.delta    ?? (tBuy - tSell);
    b.cvd      = b.cvd      ?? 0;
  });

  return { bars, priceMin: pMin, priceMax: pMax, priceRange, tickSize };
}

/** Recompute imbalance / volRatio after merging footprint levels. */
function reapplyLevelStats(levels) {
  if (!levels?.length) return [];
  const tBuy  = levels.reduce((s, l) => s + (l.buy_vol  || 0), 0);
  const tSell = levels.reduce((s, l) => s + (l.sell_vol || 0), 0);
  const avgB  = levels.length ? tBuy  / levels.length : 0;
  const avgS  = levels.length ? tSell / levels.length : 0;
  const maxV  = levels.reduce((m, l) => Math.max(m, (l.buy_vol || 0) + (l.sell_vol || 0)), 1);
  return levels.map(lv => ({
    ...lv,
    highBuy:  avgB > 0 && (lv.buy_vol  || 0) >= avgB * 2 && (lv.buy_vol  || 0) > (lv.sell_vol || 0),
    highSell: avgS > 0 && (lv.sell_vol || 0) >= avgS * 2 && (lv.sell_vol || 0) > (lv.buy_vol || 0),
    volRatio: ((lv.buy_vol || 0) + (lv.sell_vol || 0)) / maxV,
  }));
}

/**
 * Merge levels for the current viewport so vertical spacing in px stays >= minRowPx,
 * and row count stays <= targetCap (resize + vertical zoom via vr).
 */
function bucketLevelsForViewport(rawLevels, ts, vr, H, fontSz) {
  if (!rawLevels?.length || ts <= 0 || vr <= 0 || H <= 0) {
    return reapplyLevelStats(rawLevels || []);
  }
  const minRowPx = Math.max(12, fontSz + FOOTPRINT_ROW_PAD_PX);
  const targetCap = Math.max(
    MIN_FOOTPRINT_DISPLAY_ROWS,
    Math.min(MAX_FOOTPRINT_DATA_LEVELS, Math.floor(H / minRowPx)),
  );
  const minPriceStep = (minRowPx * vr) / H;
  const sorted = [...rawLevels]
    .filter(l => l.price != null && isFinite(l.price))
    .sort((a, b) => b.price - a.price);
  if (!sorted.length) return [];
  const lo = Math.min(...sorted.map(l => l.price));
  const hi = Math.max(...sorted.map(l => l.price));
  const span = Math.max(hi - lo, ts);
  let bucketStep = Math.max(ts, minPriceStep, span / targetCap);
  let merged;
  for (let guard = 0; guard < 14; guard++) {
    const buckets = new Map();
    for (const lv of sorted) {
      const rp = snapTick(lv.price, bucketStep);
      const key = rp.toFixed(6);
      if (!buckets.has(key)) {
        buckets.set(key, { buy_vol: 0, sell_vol: 0, n: 0, sumP: 0 });
      }
      const b = buckets.get(key);
      b.buy_vol += lv.buy_vol ?? 0;
      b.sell_vol += lv.sell_vol ?? 0;
      b.n += 1;
      b.sumP += lv.price;
    }
    merged = Array.from(buckets.values())
      .map((bk) => ({
        price: bk.n ? bk.sumP / bk.n : snapTick(lo, bucketStep),
        buy_vol: bk.buy_vol,
        sell_vol: bk.sell_vol,
      }))
      .sort((a, b) => b.price - a.price);
    if (merged.length <= targetCap) break;
    bucketStep *= 1.2;
  }
  return reapplyLevelStats(merged);
}

import { computeLTP, computeMII, computeVPT, computeVZP, computeContextEvents, computeDA, computeOID, computeRangeExpansion, computeInitiatorFlow, computeInitiatorFlowWithDepth, REX_LOOKBACK, REX_MULT, IFI_THRESHOLD, IFID_THRESHOLD, SIGNAL_THRESHOLD, LTP_THRESHOLD, VZP_THRESHOLD, DA_THRESHOLD, OID_THRESHOLD, OID_CONTRARIAN } from "./utils/orderflowIndicators";

function _median(arr) {
  if (!arr?.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ════════════════════════════════════════════
   COMPONENT
════════════════════════════════════════════ */
export default function FootprintChart({ candles, symbol = "NIFTY", timeFrameMinutes = 1, features = {}, hftSeries, apiBase }) {
  const showOI   = features.showOI   ?? true;
  const showVWAP = features.showVWAP ?? true;
  const showVP   = features.showVP   ?? true;
  const showLTP  = features.showLTP ?? false;
  const showMII  = features.showMII ?? false;
  const showVPT  = features.showVPT ?? false;
  const showVZP  = features.showVZP ?? false;
  const showDA  = features.showDA ?? false;
  const showOID = features.showOID ?? false;
  const showREX = features.showREX ?? false;
  const showIFI = features.showIFI ?? false;
  const showIFID = features.showIFID ?? false;
  const showContextEvents = features.showContextEvents ?? false;
  const filterByVolume = features.filterByVolume ?? false;
  /* compact layout for narrow/mobile screens */
  const isMobile   = typeof window !== "undefined" && window.innerWidth <= 768;
  const HDR_H_EFF  = isMobile ? 36 : HDR_H;
  const TIME_H_EFF = isMobile ? 18 : TIME_H;
  const numBotRows = (showOI ? 4 : 3) + (showLTP ? 1 : 0) + (showMII ? 1 : 0) + (showVPT ? 1 : 0) + (showVZP ? 1 : 0) + (showDA ? 1 : 0) + (showOID ? 1 : 0) + (showREX ? 1 : 0) + (showIFI ? 1 : 0) + (showIFID ? 1 : 0) + (showContextEvents ? 1 : 0);
  const extraRows = (showLTP ? 1 : 0) + (showMII ? 1 : 0) + (showVPT ? 1 : 0) + (showVZP ? 1 : 0) + (showDA ? 1 : 0) + (showOID ? 1 : 0) + (showREX ? 1 : 0) + (showIFI ? 1 : 0) + (showIFID ? 1 : 0) + (showContextEvents ? 1 : 0);
  const BOT_H_EFF  = showOI
    ? (extraRows > 0 ? (isMobile ? 68 + extraRows * 18 : 90 + extraRows * 22) : (isMobile ? 68 : 90))
    : (extraRows > 0 ? (isMobile ? 52 + extraRows * 18 : BOT_H + extraRows * 22) : (isMobile ? 52 : BOT_H));
  // eslint-disable-next-line no-shadow
  const NZW  = isMobile ? 40 : 80;  // numbers-zone width per candle slot (20px/40px per side)
  // eslint-disable-next-line no-shadow
  const RPAD = isMobile ? 12 : 30;  // padding after last candle

  const rootRef      = useRef(null);
  const containerRef = useRef(null);
  const canvasRef    = useRef(null);
  const psRef        = useRef(null);
  const timeRef      = useRef(null);
  const botCanvasRef = useRef(null);

  /* chart state */
  const candleWRef   = useRef(isMobile ? 14 : 32);
  const priceScaleRef = useRef(1.0); // 1.0 = auto-fit visible candles; >1 = zoomed out; <1 = zoomed in
  const priceOffRef  = useRef(0);
  const panRef       = useRef(0);

  /* scroll-to-latest control:
     - followLatest = true  → auto-scroll to newest candle
     - followLatest = false → user is manually browsing, hands off
     Reset to true only when user presses A/Fit or new bar count changes */
  const followLatest  = useRef(true);
  const prevBarCount  = useRef(0);

  const dragging       = useRef(false);
  const dragX          = useRef(0);
  const dragY          = useRef(0);
  const panStart       = useRef(0);
  const priceOffStart  = useRef(0);
  /* pinch-to-zoom */
  const activePointers = useRef(new Map()); // pointerId → {x,y}
  const pinchDist0     = useRef(0);
  const pinchCW0       = useRef(32);
  /* true once user manually changes candle width; suppresses auto-fit reset */
  const userZoomedW    = useRef(false);
  const psDragY0   = useRef(null);
  const psScale0   = useRef(1.0); // price scale factor at start of drag
  const rafId     = useRef(null);
  const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;

  const [hdrData,   setHdrData ] = useState(null);
  const [hoverBar,  setHoverBar] = useState(null);
  const [hoverPrice, setHoverPrice] = useState(null);
  const [isFS,      setIsFS    ] = useState(false);
  const [showLines, setShowLines] = useState(false);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const showLinesRef = useRef(false);
  useEffect(() => { showLinesRef.current = showLines; }, [showLines]);
  useEffect(() => { followLatest.current = isFollowingLatest; }, [isFollowingLatest]);

  const { bars, priceMin, priceMax, priceRange, tickSize } =
    useMemo(() => processCandles(candles), [candles]);

  const ltpSeries = useMemo(
    () => (showLTP ? computeLTP(candles, hftSeries, symbol) : []),
    [showLTP, candles, hftSeries, symbol]
  );

  const miiSeries = useMemo(
    () => (showMII ? computeMII(candles) : []),
    [showMII, candles]
  );

  const vptSeries = useMemo(
    () => (showVPT ? computeVPT(candles) : []),
    [showVPT, candles]
  );

  const vzpSeries = useMemo(
    () => (showVZP ? computeVZP(candles) : []),
    [showVZP, candles]
  );

  const contextEventsSeries = useMemo(
    () => (showContextEvents ? computeContextEvents(candles) : []),
    [showContextEvents, candles]
  );

  const daSeries = useMemo(
    () => (showDA ? computeDA(candles) : []),
    [showDA, candles]
  );

  const oidSeries = useMemo(
    () => (showOID ? computeOID(candles) : []),
    [showOID, candles]
  );

  const rexSeries = useMemo(
    () => (showREX ? computeRangeExpansion(candles, REX_LOOKBACK, REX_MULT) : []),
    [showREX, candles]
  );
  const ifiSeries = useMemo(
    () => (showIFI ? computeInitiatorFlow(candles) : []),
    [showIFI, candles]
  );

  const [depthSnapshots, setDepthSnapshots] = useState([]);
  const isIndexFuture = useMemo(() => {
    const s = String(symbol || "").toUpperCase();
    return ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].some((n) => s.includes(n));
  }, [symbol]);
  useEffect(() => {
    if (!showIFID || !isIndexFuture || !symbol) {
      setDepthSnapshots([]);
      return;
    }
    const base = apiBase || (typeof window !== "undefined" ? window.location.origin : "");
    const fetchDepth = async () => {
      try {
        const res = await fetch(`${base}/api/heatmap/${encodeURIComponent(symbol)}?n=500`);
        if (!res.ok) return;
        const d = await res.json();
        setDepthSnapshots(d?.snapshots || []);
      } catch (_) {}
    };
    fetchDepth();
    const id = setInterval(fetchDepth, 3000);
    return () => clearInterval(id);
  }, [showIFID, isIndexFuture, symbol, apiBase]);

  const ifidSeries = useMemo(
    () => (showIFID && candles?.length ? computeInitiatorFlowWithDepth(candles, depthSnapshots, 0.7) : []),
    [showIFID, candles, depthSnapshots]
  );

  const barsRef     = useRef(bars);
  const ltpSeriesRef = useRef(ltpSeries);
  const miiSeriesRef = useRef(miiSeries);
  const vptSeriesRef = useRef(vptSeries);
  const vzpSeriesRef = useRef(vzpSeries);
  const contextEventsSeriesRef = useRef(contextEventsSeries);
  const daSeriesRef = useRef(daSeries);
  const oidSeriesRef = useRef(oidSeries);
  const rexSeriesRef = useRef(rexSeries);
  const ifiSeriesRef = useRef(ifiSeries);
  const ifidSeriesRef = useRef(ifidSeries);
  const pMinRef     = useRef(priceMin);
  const pMaxRef     = useRef(priceMax);
  const pRanRef     = useRef(priceRange);
  const tickRef     = useRef(tickSize);
  useEffect(() => {
    const newCount = bars.length;
    const oldCount = prevBarCount.current;

    // New candle appended → snap back to latest
    if (newCount > oldCount) {
      followLatest.current = true;
      setIsFollowingLatest(true);
    }
    prevBarCount.current = newCount;

    barsRef.current = bars;
    pMinRef.current = priceMin;
    pMaxRef.current = priceMax;
    pRanRef.current = priceRange;
    tickRef.current = tickSize;
    ltpSeriesRef.current = ltpSeries;
    miiSeriesRef.current = miiSeries;
    vptSeriesRef.current = vptSeries;
    daSeriesRef.current = daSeries;
    oidSeriesRef.current = oidSeries;
    rexSeriesRef.current = rexSeries;
    ifiSeriesRef.current = ifiSeries;
    ifidSeriesRef.current = ifidSeries;
    vzpSeriesRef.current = vzpSeries;
    contextEventsSeriesRef.current = contextEventsSeries;
  }, [bars, priceMin, priceMax, priceRange, tickSize, ltpSeries, miiSeries, vptSeries, vzpSeries, contextEventsSeries, ifiSeries, ifidSeries]);

  useEffect(() => {
    if (!bars.length) return;
    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : null;
    setHdrData({ last, chg: prev ? ((last.close - prev.close) / prev.close) * 100 : 0 });
  }, [bars]);

  /* ── price helpers ── */

  /**
   * getAutoScaleRange — derives visible price range from the candles
   * currently in view (based on pan + candle width). This gives TradingView-style
   * auto-scale: candles always fill the vertical space when priceScaleRef = 1.
   */
  const getAutoScaleRange = useCallback(() => {
    const bs = barsRef.current;
    if (!bs.length) return { lo: 0, hi: 1 };
    const cw    = candleWRef.current;
    const slotW = cw + NZW + GAP;
    const W     = (containerRef.current?.clientWidth || 800) - PS_W - LABEL_W;
    const pan   = panRef.current;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < bs.length; i++) {
      const x = i * slotW - pan;
      if (x + slotW < 0 || x > W) continue;
      const b = bs[i];
      if (b.low  != null && isFinite(b.low))  lo = Math.min(lo, b.low);
      if (b.high != null && isFinite(b.high)) hi = Math.max(hi, b.high);
    }
    if (!isFinite(lo) || !isFinite(hi)) { lo = pMinRef.current; hi = pMaxRef.current; }
    const ts  = tickRef.current || 0.5;
    const pad = Math.max(ts * 3, (hi - lo) * 0.06);
    return { lo: lo - pad, hi: hi + pad };
  }, []);

  /** Visible price range = auto-scale base × priceScaleFactor */
  const getVisRange = useCallback(() => {
    const { lo, hi } = getAutoScaleRange();
    const base = Math.max(hi - lo, tickRef.current || 0.5);
    return base * Math.max(0.05, priceScaleRef.current);
  }, [getAutoScaleRange]);

  /** Bottom of visible price range, centred on auto-scale mid + manual offset */
  const getVisPMin = useCallback(() => {
    const { lo, hi } = getAutoScaleRange();
    const center = (lo + hi) / 2 + priceOffRef.current;
    const vr = getVisRange();
    return center - vr / 2;
  }, [getAutoScaleRange, getVisRange]);

  const p2y = useCallback((price, h) => {
    const vr = getVisRange(), vm = getVisPMin();
    if (!isFinite(price) || vr <= 0) return h / 2;
    return (1 - (price - vm) / vr) * h;
  }, [getVisRange, getVisPMin]);

  const getMaxPan = useCallback(() => {
    const cw       = candleWRef.current;
    const slotW    = cw + NZW + GAP;
    const chartW   = barsRef.current.length * slotW - GAP + RPAD;
    const wrapW    = (containerRef.current?.clientWidth || 800) - PS_W - LABEL_W;
    return Math.max(0, chartW - wrapW);
  }, []);

  const getCanvasH = useCallback(() => {
    const tot = containerRef.current?.clientHeight || 600;
    return Math.max(100, tot - TIME_H_EFF - BOT_H_EFF);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ══════════════════════════════════════════════════════
     MAIN DRAW
  ══════════════════════════════════════════════════════ */
  const draw = useCallback(() => {
    const cv = canvasRef.current, ct = containerRef.current;
    if (!cv || !ct) return;

    /* follow latest candle only if flag is set */
    if (followLatest.current) {
      panRef.current = getMaxPan();
    }

    const ctx = cv.getContext("2d");
    const W   = ct.clientWidth - PS_W - LABEL_W;
    const H   = getCanvasH();
    const bs     = barsRef.current;
    const cw     = candleWRef.current;
    const slotW  = cw + NZW + GAP;
    const nzHalf = Math.floor(NZW / 2); // sell zone LEFT of candle, buy zone RIGHT
    const pan    = panRef.current;
    const ts     = tickRef.current;

    if (W <= 0 || H <= 0 || !bs.length) return;

    cv.style.width  = W + "px";
    cv.style.height = H + "px";
    cv.width  = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    const vr = getVisRange(), vm = getVisPMin();

    /* row height: auto-adjust for current visible range */
    const pxPerTick = ts > 0 ? H * ts / vr : ROW_PREF;
    const LEVEL_H   = Math.max(8, Math.min(ROW_MAX, pxPerTick));
    const FONT_SZ   = isMobile
      ? Math.max(8,  Math.min(12, Math.floor(LEVEL_H * 0.62)))
      : Math.max(10, Math.min(14, Math.floor(LEVEL_H * 0.72)));

    /** Footprint LOD: bucket raw levels to canvas + zoom (vr) so labels don't overlap. */
    const getDisplayLevels = (levels) => bucketLevelsForViewport(levels, ts, vr, H, FONT_SZ);

    /* imbalance lines collection (for Lines toggle only) */
    const buyLinePrices  = new Set();
    const sellLinePrices = new Set();

    /* ── PASS 1: row backgrounds (no grid lines) ── */
    ctx.font = `600 ${FONT_SZ}px ${MONO}`;
    ctx.textBaseline = "middle";

    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      const x = i * slotW - pan;
      if (x + cw + NZW < 0 || x > W) continue;

      const bull = (b.close ?? b.open ?? 0) >= (b.open ?? b.close ?? 0);

      /* current candle tint */
      if (i === bs.length - 1) {
        ctx.fillStyle = C.curBg;
        ctx.fillRect(x, 0, slotW - GAP, H);
      }

      ctx.save();
      const cx0 = x + nzHalf;
      ctx.beginPath(); ctx.rect(cx0, 0, cw, H); ctx.clip();

      for (const lv of getDisplayLevels(b.levels)) {
        const ly   = p2y(lv.price, H);
        const rowY = ly - LEVEL_H / 2;
        if (rowY > H || rowY + LEVEL_H < 0) continue;

        if (showLinesRef.current) {
          if (lv.highBuy) buyLinePrices.add(lv.price);
          if (lv.highSell) sellLinePrices.add(lv.price);
        }
      }
      ctx.restore();
    }

    /* ── PASS 2: imbalance lines ── */
    if (showLinesRef.current) {
      ctx.setLineDash([5, 4]);
      buyLinePrices.forEach(price => {
        const py = Math.round(p2y(price, H)) + 0.5;
        ctx.strokeStyle = C.buyLine; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
      });
      sellLinePrices.forEach(price => {
        const py = Math.round(p2y(price, H)) + 0.5;
        ctx.strokeStyle = C.sellLine; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
      });
      ctx.setLineDash([]);
    }

    /* ── PASS 3: wicks + narrow bodies ── */
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      const x  = i * slotW - pan;
      const cx = x + nzHalf; // candle body starts after left sell-zone
      if (cx + cw < 0 || cx > W) continue;

      const open  = b.open  ?? b.close ?? 0;
      const close = b.close ?? b.open  ?? 0;
      const high  = b.high  ?? Math.max(open, close);
      const low   = b.low   ?? Math.min(open, close);
      const bull  = close >= open;

      const openY  = p2y(open,  H);
      const closeY = p2y(close, H);
      const highY  = p2y(high,  H);
      const lowY   = p2y(low,   H);
      const midX   = Math.round(cx + cw / 2); // centered on candle body
      const bodyT  = Math.min(openY, closeY);
      const bodyH  = Math.max(1, Math.abs(closeY - openY));

      /* 1px wick */
      ctx.strokeStyle = bull ? C.brdBull : C.brdBear;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(midX + 0.5, highY);
      ctx.lineTo(midX + 0.5, lowY);
      ctx.stroke();

      /* narrow body (BODY_HALF px each side) */
      const bx = midX - BODY_HALF;
      ctx.fillStyle   = bull ? C.bodyBull : C.bodyBear;
      ctx.strokeStyle = bull ? C.brdBull  : C.brdBear;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(bx, bodyT, BODY_HALF * 2, Math.max(bodyH, 1));
      ctx.fill(); ctx.stroke();
    }

    /* ── PASS 3.5: vertical session separators at IST day boundaries (in gutter between candles) ── */
    ctx.save();
    ctx.strokeStyle = C.daySep;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (let i = 1; i < bs.length; i++) {
      if (!isFirstBarOfDayIST(bs, i)) continue;
      const xSep = i * slotW - pan - GAP / 2;
      if (xSep < -2 || xSep > W + 2) continue;
      const x = Math.round(xSep) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    /* ── PASS 4: sell RIGHT of sell-zone (left of candle), buy LEFT of buy-zone (right of candle) ── */
    ctx.textBaseline = "middle";
    const numPad = 2; // gap between number text and candle edge

    for (let i = 0; i < bs.length; i++) {
      const b  = bs[i];
      const x  = i * slotW - pan;
      const cx = x + nzHalf;
      if (x + slotW < 0 || x > W) continue;

      ctx.save();
      // clip to full slot (sell zone + candle + buy zone)
      ctx.beginPath(); ctx.rect(x, 0, slotW - GAP, H); ctx.clip();

      for (const lv of getDisplayLevels(b.levels)) {
        const ly = p2y(lv.price, H);
        if (ly < -2 || ly > H + 2) continue;

        const sellTxt = fmtV(lv.sell_vol || 0);
        const buyTxt  = fmtV(lv.buy_vol  || 0);

        // auto-scale font to fit within nzHalf
        let fontSize = FONT_SZ;
        ctx.font = `600 ${fontSize}px ${MONO}`;
        const maxW = nzHalf - numPad;
        const sw = ctx.measureText(sellTxt).width;
        const bw = ctx.measureText(buyTxt).width;
        if (Math.max(sw, bw) > maxW && fontSize > 7) {
          fontSize = Math.max(7, Math.floor(maxW / Math.max(sw, bw) * fontSize));
          ctx.font = `600 ${fontSize}px ${MONO}`;
        }

        const isImb  = lv.highBuy || lv.highSell;
        const boxH   = fontSize + 2;

        // sell: right-aligned, flush against left edge of candle body
        ctx.fillStyle = lv.highSell ? C.sell : C.sellMid;
        ctx.textAlign = "right";
        ctx.fillText(sellTxt, cx - numPad, ly);

        // buy: left-aligned, flush against right edge of candle body
        ctx.fillStyle = lv.highBuy ? C.buy : C.buyMid;
        ctx.textAlign = "left";
        ctx.fillText(buyTxt, cx + cw + numPad, ly);

        if (isImb) {
          const sellDrawX = cx - numPad - ctx.measureText(sellTxt).width;
          const buyDrawX  = cx + cw + numPad + ctx.measureText(buyTxt).width;
          ctx.strokeStyle = lv.highBuy ? C.buy : C.sell;
          ctx.lineWidth = 1;
          ctx.strokeRect(sellDrawX - 1, ly - boxH / 2, buyDrawX - sellDrawX + 2, boxH);
        }
      }
      ctx.restore();
    }

    /* ── current last-price track line (always visible) ── */
    const lastBar = bs[bs.length - 1];
    if (lastBar) {
      const lp = lastBar.close ?? lastBar.open ?? 0;
      const ly = p2y(lp, H);
      if (ly >= 0 && ly <= H) {
        const bull = lp >= (lastBar.open ?? lp);
        ctx.save();
        ctx.strokeStyle = bull ? C.buy : C.sell;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.75;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(ly) + 0.5);
        ctx.lineTo(W, Math.round(ly) + 0.5);
        ctx.stroke();
        ctx.restore();
      }
    }

    /* horizontal price-level crosshair on hover */
    if (hoverPrice != null && isFinite(hoverPrice)) {
      const py = p2y(hoverPrice, H);
      if (py >= 0 && py <= H) {
        ctx.strokeStyle = "rgba(100,120,180,0.85)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, Math.round(py) + 0.5); ctx.lineTo(W, Math.round(py) + 0.5); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    /* ── PASS 5: Session VWAP (resets each IST day; no line across overnight gap) ── */
    if (showVWAP && bs.length > 0) {
      let cumPV = 0, cumV = 0;
      let labelY = null;
      ctx.save();
      ctx.strokeStyle = "#f39c12";
      ctx.lineWidth   = 1.5;
      ctx.globalAlpha = 0.90;
      ctx.setLineDash([]);
      ctx.beginPath();
      let wStarted = false;
      for (let i = 0; i < bs.length; i++) {
        if (isFirstBarOfDayIST(bs, i)) {
          cumPV = 0;
          cumV = 0;
          wStarted = false;
        }
        const b   = bs[i];
        const vol = (b.buy_vol || 0) + (b.sell_vol || 0);
        const tp  = ((b.high || b.close || 0) + (b.low || b.close || 0) + (b.close || 0)) / 3;
        if (vol > 0 && tp > 0) { cumPV += tp * vol; cumV += vol; }
        const vwap = cumV > 0 ? cumPV / cumV : 0;
        if (vwap <= 0) continue;
        const cx = i * slotW - pan + nzHalf;
        const midX = cx + cw / 2;
        const y    = p2y(vwap, H);
        if (!wStarted) { ctx.moveTo(midX, y); wStarted = true; }
        else ctx.lineTo(midX, y);
        labelY = y;
      }
      ctx.stroke();
      if (cumV > 0 && labelY != null && labelY >= 4 && labelY <= H - 4) {
        ctx.fillStyle = "#f39c12";
        ctx.font = `700 8px ${MONO}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText("VWAP", 4, labelY - 8);
      }
      ctx.restore();
    }

    /* ── PASS 6: Volume Profile histogram (VPOC / VAH / VAL) ── */
    if (showVP && bs.length > 0) {
      /* aggregate all closed + open levels → price → total volume */
      const profile = new Map();
      for (const b of bs) {
        for (const lv of Object.values(b.levels || {})) {
          const vol = (lv.buy_vol || 0) + (lv.sell_vol || 0);
          if (vol > 0) profile.set(lv.price, (profile.get(lv.price) || 0) + vol);
        }
      }
      if (profile.size > 0) {
        /* VPOC + value-area set for full-chart histogram tint only */
        let vpoc = 0, maxVol = 0;
        for (const [p, v] of profile) { if (v > maxVol) { maxVol = v; vpoc = p; } }

        const totalVol  = [...profile.values()].reduce((s, v) => s + v, 0);
        const vaTarget  = totalVol * 0.70;
        const byVolDesc = [...profile.entries()].sort((a, b) => b[1] - a[1]);
        const vaSet = new Set();
        let cumVA = 0;
        for (const [p, v] of byVolDesc) {
          vaSet.add(p); cumVA += v;
          if (cumVA >= vaTarget) break;
        }

        const VP_W  = Math.min(isMobile ? 36 : 68, W * 0.12);
        const barH  = Math.max(1, pxPerTick - 0.5);

        ctx.save();
        /* histogram bars — right-aligned, semi-transparent overlay (whole visible range) */
        for (const [p, vol] of profile) {
          const y = p2y(p, H);
          if (y < -2 || y > H + 2) continue;
          const barW = (vol / maxVol) * VP_W;
          ctx.fillStyle = (p === vpoc) ? "rgba(255,193,7,0.88)"
            : vaSet.has(p)             ? "rgba(100,149,237,0.50)"
                                       : "rgba(100,149,237,0.16)";
          ctx.fillRect(W - barW, y - barH / 2, barW, Math.max(1, barH));
        }

        /* VAH / VAL: one pair per IST session, drawn only across that day’s candles */
        const dayRanges = istDayIndexRanges(bs);
        for (let di = 0; di < dayRanges.length; di++) {
          const [a, b] = dayRanges[di];
          const slice = bs.slice(a, b + 1);
          const va = computeProfileValueArea(slice);
          if (!va || va.vah == null || va.val == null) continue;

          let x0 = a * slotW - pan;
          let x1 = b * slotW - pan + slotW - GAP;
          x0 = Math.max(0, Math.min(W, x0));
          x1 = Math.max(0, Math.min(W, x1));
          if (x1 - x0 < 2) continue;

          const vahY = Math.round(p2y(va.vah, H)) + 0.5;
          const valY = Math.round(p2y(va.val, H)) + 0.5;

          ctx.strokeStyle = "rgba(100,149,237,0.82)";
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 3]);
          ctx.beginPath(); ctx.moveTo(x0, vahY); ctx.lineTo(x1, vahY); ctx.stroke();
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(x0, valY); ctx.lineTo(x1, valY); ctx.stroke();
          ctx.setLineDash([]);

          const lx = x0 + 4;
          const segW = x1 - x0;
          const dayTag = toISTDate(bs[a].open_time);
          ctx.font = `700 7px ${MONO}`;
          ctx.textBaseline = "middle";
          ctx.textAlign = "left";
          if (segW > 44 && vahY >= 10 && vahY <= H - 10) {
            ctx.fillStyle = "rgba(100,149,237,0.95)";
            ctx.fillText(di === dayRanges.length - 1 ? "VAH" : `VAH ${dayTag}`, lx, vahY - 8);
          }
          if (segW > 44 && valY >= 10 && valY <= H - 10) {
            ctx.fillStyle = "rgba(100,149,237,0.95)";
            ctx.fillText(di === dayRanges.length - 1 ? "VAL" : `VAL ${dayTag}`, lx, valY + 8);
          }
        }

        ctx.restore();
      }
    }

    /* ── PASS 7: LTP, MII, VPT, VZP, DA, OID signal arrows ── */
    const ltpArr = showLTP ? ltpSeriesRef.current : [];
    const miiArr = showMII ? miiSeriesRef.current : [];
    const vptArr = showVPT ? vptSeriesRef.current : [];
    const vzpArr = showVZP ? vzpSeriesRef.current : [];
    const daArr = showDA ? daSeriesRef.current : [];
    const oidArr = showOID ? oidSeriesRef.current : [];
    const rexArr = showREX ? rexSeriesRef.current : [];
    const ifiArr = showIFI ? ifiSeriesRef.current : [];
    const ifidArr = showIFID ? ifidSeriesRef.current : [];
    const ctxEventsArr = showContextEvents ? contextEventsSeriesRef.current : [];
    const arrowSize = 8;
    const arrowOffset = 6;
    const thLtp = LTP_THRESHOLD;
    const thMii = SIGNAL_THRESHOLD;
    const thVpt = SIGNAL_THRESHOLD;
    const thVzp = VZP_THRESHOLD;
    const thDa = DA_THRESHOLD;
    const thOid = OID_THRESHOLD;
    const allBars = barsRef.current;
    const sessionMedianVol = allBars.length
      ? _median(allBars.map(b => (b.buy_vol ?? 0) + (b.sell_vol ?? 0)))
      : 0;
    const deltaThreshold = allBars.length
      ? _median(allBars.map(b => Math.abs(b.delta ?? 0)))
      : 0;
    if ((showLTP && ltpArr.length) || (showMII && miiArr.length) || (showVPT && vptArr.length) || (showVZP && vzpArr.length) || (showDA && daArr.length) || (showOID && oidArr.length) || (showREX && rexArr.length) || (showIFI && ifiArr.length) || (showIFID && ifidArr.length) || (showContextEvents && ctxEventsArr.length)) {
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        const vol = (b.buy_vol ?? 0) + (b.sell_vol ?? 0);
        const absDelta = Math.abs(b.delta ?? 0);
        const passFilter = !filterByVolume || vol > sessionMedianVol || absDelta > deltaThreshold;
        const ltp = ltpArr[i]?.ltp;
        const mii = miiArr[i]?.mii;
        const vpt = vptArr[i]?.vpt;
        const vzpVal = vzpArr[i];
        const vzpRaw = vzpVal?.vzpRaw ?? vzpVal?.vzp;
        const hasLtp = showLTP && ltp != null && (ltp > thLtp || ltp < -thLtp);
        const hasMii = showMII && mii != null && (mii > thMii || mii < -thMii);
        const hasVpt = showVPT && vpt != null && (vpt > thVpt || vpt < -thVpt);
        const hasVzp = showVZP && vzpRaw != null && (vzpRaw > thVzp || vzpRaw < -thVzp);
        const da = daArr[i]?.da;
        const oid = oidArr[i]?.oid;
        const hasDa = showDA && da != null && (da > thDa || da < -thDa);
        const hasOid = showOID && oid != null && (oid > thOid || oid < -thOid);
        const rex = rexArr[i]?.rex;
        const hasRex = showREX && rex != null && rex !== 0;
        const ifiVal = ifiArr[i]?.ifi ?? ifiArr[i]?.ifiRaw;
        const hasIFI = showIFI && ifiVal != null && Math.abs(ifiVal) > IFI_THRESHOLD;
        const ifidVal = ifidArr[i]?.ifi ?? ifidArr[i]?.ifiRaw;
        const hasIFID = showIFID && ifidVal != null && Math.abs(ifidVal) > IFID_THRESHOLD;
        const ctxEv = ctxEventsArr[i]?.event;
        const hasCtxEv = showContextEvents && ctxEv != null;
        if (!hasLtp && !hasMii && !hasVpt && !hasVzp && !hasDa && !hasOid && !hasRex && !hasIFI && !hasIFID && !hasCtxEv) continue;
        if (!passFilter && !hasCtxEv) continue;
        const x  = i * slotW - pan;
        const cx = x + nzHalf;
        if (cx + cw < 0 || cx > W) continue;

        const high = b.high ?? Math.max(b.open ?? 0, b.close ?? 0);
        const low  = b.low  ?? Math.min(b.open ?? 0, b.close ?? 0);
        const baseMidX = Math.round(cx + cw / 2);
        const highY = p2y(high, H);
        const lowY  = p2y(low, H);

        /* LTP = darker shades, MII = lighter shades */
        const drawArrow = (ax, val, isUp, isLtp) => {
          const colors = isLtp ? { up: "#00695c", down: "#c62828" } : { up: "#4ade80", down: "#f87171" };
          ctx.fillStyle = isUp ? colors.up : colors.down;
          ctx.beginPath();
          if (isUp) {
            const ay = highY - arrowSize - 2;
            ctx.moveTo(ax, ay - arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          } else {
            const ay = lowY + arrowSize + 2;
            ctx.moveTo(ax, ay + arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          }
          ctx.closePath();
          ctx.fill();
        };

        const drawVptArrow = (ax, val, isUp) => {
          const colors = { up: "#7c3aed", down: "#6d28d9" };
          ctx.fillStyle = isUp ? colors.up : colors.down;
          ctx.beginPath();
          if (isUp) {
            const ay = highY - arrowSize - 2;
            ctx.moveTo(ax, ay - arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          } else {
            const ay = lowY + arrowSize + 2;
            ctx.moveTo(ax, ay + arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          }
          ctx.closePath();
          ctx.fill();
        };

        const drawVzpArrow = (ax, val, isUp) => {
          const colors = { up: "#d97706", down: "#b45309" };
          ctx.fillStyle = isUp ? colors.up : colors.down;
          ctx.beginPath();
          if (isUp) {
            const ay = highY - arrowSize - 2;
            ctx.moveTo(ax, ay - arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          } else {
            const ay = lowY + arrowSize + 2;
            ctx.moveTo(ax, ay + arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          }
          ctx.closePath();
          ctx.fill();
        };

        const drawDaArrow = (ax, val, isUp) => {
          const colors = { up: "#0d9488", down: "#be123c" };
          ctx.fillStyle = isUp ? colors.up : colors.down;
          ctx.beginPath();
          if (isUp) {
            const ay = highY - arrowSize - 2;
            ctx.moveTo(ax, ay - arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          } else {
            const ay = lowY + arrowSize + 2;
            ctx.moveTo(ax, ay + arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          }
          ctx.closePath();
          ctx.fill();
        };

        const drawOidArrow = (ax, val, isUp) => {
          const colors = { up: "#0891b2", down: "#b91c1c" };
          ctx.fillStyle = isUp ? colors.up : colors.down;
          ctx.beginPath();
          if (isUp) {
            const ay = highY - arrowSize - 2;
            ctx.moveTo(ax, ay - arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          } else {
            const ay = lowY + arrowSize + 2;
            ctx.moveTo(ax, ay + arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          }
          ctx.closePath();
          ctx.fill();
        };

        const drawRexArrow = (ax, isUp) => {
          const colors = { up: "#059669", down: "#dc2626" };
          ctx.fillStyle = isUp ? colors.up : colors.down;
          ctx.beginPath();
          if (isUp) {
            const ay = highY - arrowSize - 2;
            ctx.moveTo(ax, ay - arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          } else {
            const ay = lowY + arrowSize + 2;
            ctx.moveTo(ax, ay + arrowSize);
            ctx.lineTo(ax - arrowSize / 2, ay);
            ctx.lineTo(ax + arrowSize / 2, ay);
          }
          ctx.closePath();
          ctx.fill();
        };

        const drawContextEvent = (ctx2, ax, hY, lY, eventType, size) => {
          const s = size || 8;
          if (eventType === "REVERSAL_TOP" || eventType === "RALLY_END") {
            ctx2.fillStyle = eventType === "REVERSAL_TOP" ? "#c62828" : "#e65100";
            const ay = hY - s - 2;
            ctx2.beginPath();
            if (eventType === "REVERSAL_TOP") {
              ctx2.moveTo(ax, ay - s);
              ctx2.lineTo(ax - s / 2, ay);
              ctx2.lineTo(ax + s / 2, ay);
            } else {
              ctx2.moveTo(ax, ay - s / 2);
              ctx2.lineTo(ax + s / 2, ay);
              ctx2.lineTo(ax, ay + s / 2);
              ctx2.lineTo(ax - s / 2, ay);
            }
            ctx2.closePath();
            ctx2.fill();
          } else {
            ctx2.fillStyle = "#2e7d32";
            const ay = lY + s + 2;
            ctx2.beginPath();
            ctx2.moveTo(ax, ay + s);
            ctx2.lineTo(ax - s / 2, ay);
            ctx2.lineTo(ax + s / 2, ay);
            ctx2.closePath();
            ctx2.fill();
          }
        };
        const vzpIsUp = vzpRaw != null && vzpRaw < -thVzp;
        if (hasLtp && hasMii && hasVpt && hasVzp) {
          drawArrow(baseMidX - arrowOffset * 1.5, ltp, ltp > thLtp, true);
          drawArrow(baseMidX - arrowOffset / 2, mii, mii > thMii, false);
          drawVptArrow(baseMidX + arrowOffset / 2, vpt, vpt > thVpt);
          drawVzpArrow(baseMidX + arrowOffset * 1.5, vzpRaw, vzpIsUp);
        } else if (hasLtp && hasMii && hasVpt) {
          drawArrow(baseMidX - arrowOffset, ltp, ltp > thLtp, true);
          drawArrow(baseMidX + arrowOffset, mii, mii > thMii, false);
          drawVptArrow(baseMidX, vpt, vpt > thVpt);
        } else if (hasLtp && hasMii && hasVzp) {
          drawArrow(baseMidX - arrowOffset, ltp, ltp > thLtp, true);
          drawArrow(baseMidX, mii, mii > thMii, false);
          drawVzpArrow(baseMidX + arrowOffset, vzpRaw, vzpIsUp);
        } else if (hasLtp && hasMii) {
          drawArrow(baseMidX - arrowOffset, ltp, ltp > thLtp, true);
          drawArrow(baseMidX + arrowOffset, mii, mii > thMii, false);
        } else if (hasLtp && hasVpt && hasVzp) {
          drawArrow(baseMidX - arrowOffset, ltp, ltp > thLtp, true);
          drawVptArrow(baseMidX, vpt, vpt > thVpt);
          drawVzpArrow(baseMidX + arrowOffset, vzpRaw, vzpIsUp);
        } else if (hasLtp && hasVpt) {
          drawArrow(baseMidX - arrowOffset, ltp, ltp > thLtp, true);
          drawVptArrow(baseMidX + arrowOffset, vpt, vpt > thVpt);
        } else if (hasLtp && hasVzp) {
          drawArrow(baseMidX - arrowOffset, ltp, ltp > thLtp, true);
          drawVzpArrow(baseMidX + arrowOffset, vzpRaw, vzpIsUp);
        } else if (hasMii && hasVpt && hasVzp) {
          drawArrow(baseMidX - arrowOffset, mii, mii > thMii, false);
          drawVptArrow(baseMidX, vpt, vpt > thVpt);
          drawVzpArrow(baseMidX + arrowOffset, vzpRaw, vzpIsUp);
        } else if (hasMii && hasVpt) {
          drawArrow(baseMidX - arrowOffset, mii, mii > thMii, false);
          drawVptArrow(baseMidX + arrowOffset, vpt, vpt > thVpt);
        } else if (hasMii && hasVzp) {
          drawArrow(baseMidX - arrowOffset, mii, mii > thMii, false);
          drawVzpArrow(baseMidX + arrowOffset, vzpRaw, vzpIsUp);
        } else if (hasVpt && hasVzp) {
          drawVptArrow(baseMidX - arrowOffset, vpt, vpt > thVpt);
          drawVzpArrow(baseMidX + arrowOffset, vzpRaw, vzpIsUp);
        } else if (hasLtp) {
          drawArrow(baseMidX, ltp, ltp > thLtp, true);
        } else if (hasMii) {
          drawArrow(baseMidX, mii, mii > thMii, false);
        } else if (hasVpt) {
          drawVptArrow(baseMidX, vpt, vpt > thVpt);
        } else if (hasVzp) {
          drawVzpArrow(baseMidX, vzpRaw, vzpIsUp);
        } else if (hasDa) {
          drawDaArrow(baseMidX, da, da > thDa);
        } else if (hasOid) {
          const oidUp = OID_CONTRARIAN ? oid < -thOid : oid > thOid;
          drawOidArrow(baseMidX, oid, oidUp);
        } else if (hasRex) {
          drawRexArrow(baseMidX, rex > 0);
        } else if (hasIFI) {
          drawRexArrow(baseMidX, ifiVal > 0);
        } else if (hasIFID) {
          drawRexArrow(baseMidX, ifidVal > 0);
        }
        if (hasCtxEv) {
          const offset = (hasLtp || hasMii || hasVpt || hasVzp || hasDa || hasOid || hasRex || hasIFI || hasIFID) ? arrowOffset : 0;
          drawContextEvent(ctx, baseMidX + offset, highY, lowY, ctxEv, arrowSize);
        }
      }
    }

    /* price scale + time (pass hoverPrice so Y-axis shows price at crosshair level) */
    _drawPS(H, ts, hoverPrice);
    _drawTime();
    _drawBot();
  }, [dpr, getCanvasH, getVisRange, getVisPMin, p2y, getMaxPan, hoverBar, hoverPrice,
      showVWAP, showVP, showLTP, showMII, showVPT, showVZP, showDA, showOID, showREX, showIFI, showIFID, showContextEvents, filterByVolume, isMobile]);

  /* ── price scale: TradingView-style levels + hover price at crosshair ── */
  const PS_LABEL_MIN_PX = 40;
  const _drawPS = useCallback((H, ts, crosshairPrice) => {
    const psEl = psRef.current;
    if (!psEl) return;
    psEl.querySelectorAll(".fp-tick").forEach(e => e.remove());

    const vr = getVisRange(), vm = getVisPMin();
    if (vr <= 0 || ts <= 0) return;

    const maxLabels = Math.max(5, Math.floor(H / PS_LABEL_MIN_PX));
    const stepCount = maxLabels - 1;
    const priceStep = stepCount > 0 ? vr / stepCount : vr;
    const niceStep = Math.max(ts, snapTick(priceStep, ts));
    const startP = Math.ceil(vm / niceStep) * niceStep;

    for (let p = startP; p <= vm + vr + ts * 0.5; p = +(p + niceStep).toFixed(8)) {
      if (p < vm - ts * 0.5) continue;
      const py = p2y(p, H);
      if (py < 2 || py > H - 2) continue;

      const el = document.createElement("div");
      el.className = "fp-tick";
      el.style.cssText = `
        position:absolute;right:0;top:${py}px;transform:translateY(-50%);
        width:100%;display:flex;align-items:center;padding:0 4px;pointer-events:none;`;
      el.innerHTML = `
        <div style="width:4px;height:1px;background:#c8cdd8;margin-right:3px;flex-shrink:0"></div>
        <span style="font-family:${MONO};font-size:9px;color:#6870a0;white-space:nowrap;letter-spacing:-.01em">${fmtP(p)}</span>`;
      psEl.appendChild(el);
    }

    /* crosshair price label on Y-axis at hover level */
    if (crosshairPrice != null && isFinite(crosshairPrice)) {
      const py = p2y(crosshairPrice, H);
      if (py >= 2 && py <= H - 2) {
        const el = document.createElement("div");
        el.className = "fp-tick fp-crosshair-price";
        el.style.cssText = `
          position:absolute;right:0;top:${py}px;transform:translateY(-50%);
          width:100%;display:flex;align-items:center;padding:0 4px;pointer-events:none;
          z-index:10;`;
        el.innerHTML = `
          <div style="width:6px;height:1px;background:rgba(100,120,180,0.9);margin-right:2px;flex-shrink:0"></div>
          <span style="font-family:${MONO};font-size:10px;font-weight:700;color:#4a5568;white-space:nowrap;background:rgba(255,255,255,0.95);padding:1px 4px;border-radius:2px;box-shadow:0 0 0 1px rgba(100,120,180,0.4)">${fmtP(crosshairPrice)}</span>`;
        psEl.appendChild(el);
      }
    }

    /* last price badge */
    const last  = barsRef.current[barsRef.current.length - 1];
    const badge = psEl.querySelector(".fp-last");
    if (last && badge) {
      badge.style.top        = p2y(last.close, H) + "px";
      badge.style.background = last.close >= last.open ? C.buy : C.sell;
      const sp = badge.querySelector("span");
      if (sp) sp.textContent = fmtP(last.close);
    }
  }, [getVisRange, getVisPMin, p2y]);

  /* ── time axis: IST; date only at beginning of day ── */
  const _drawTime = useCallback(() => {
    const el = timeRef.current; if (!el) return;
    el.innerHTML = "";
    const bs = barsRef.current, cw = candleWRef.current, pan = panRef.current;
    if (!bs.length) return;
    const slotW  = cw + NZW + GAP;
    const nzH    = Math.floor(NZW / 2);
    const W = (containerRef.current?.clientWidth || 800) - PS_W - LABEL_W;
    const minGap = 60;
    const step = Math.max(1, Math.ceil(minGap / slotW));
    for (let k = 0; k < bs.length; k += step) {
      const i    = Math.min(k, bs.length - 1);
      const left = i * slotW + nzH + cw / 2 - pan; // centre of candle body
      if (left < 0 || left > W) continue;
      const showDate = isFirstBarOfDayIST(bs, i);
      const lbl = document.createElement("div");
      lbl.style.cssText = `
        position:absolute;left:${left}px;top:0;bottom:0;
        display:flex;align-items:center;transform:translateX(-50%);pointer-events:none;
        font-family:${MONO};font-size:9px;color:${C.textDim};white-space:nowrap;`;
      lbl.textContent = showDate ? `${toISTDate(bs[i].open_time)} ${toIST(bs[i].open_time, false)}` : toIST(bs[i].open_time, false);
      el.appendChild(lbl);
    }
    for (let i = 1; i < bs.length; i++) {
      if (!isFirstBarOfDayIST(bs, i)) continue;
      const xSep = i * slotW - pan - GAP / 2;
      if (xSep < 0 || xSep > W) continue;
      const rule = document.createElement("div");
      rule.style.cssText = `
        position:absolute;left:${xSep}px;top:0;bottom:0;width:0;
        border-left:1px dashed ${C.daySep};transform:translateX(-50%);
        pointer-events:none;opacity:0.92;`;
      el.appendChild(rule);
    }
  }, []);

  /* ── bottom strip: same width as chart (W), aligned with candles ── */
  const _drawBot = useCallback(() => {
    const cv = botCanvasRef.current, ct = containerRef.current;
    if (!cv || !ct) return;
    const W   = ct.clientWidth - PS_W - LABEL_W;
    const H   = BOT_H_EFF;
    const bs  = barsRef.current;
    const cw  = candleWRef.current;
    const pan = panRef.current;

    cv.style.width  = W + "px";
    cv.style.height = H + "px";
    cv.width  = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);

    const numRows = numBotRows;
    const ROW_H   = Math.floor(H / numRows);
    /* row dividers */
    ctx.strokeStyle = C.border; ctx.lineWidth = 0.5;
    for (let r = 1; r < numRows; r++) {
      ctx.beginPath(); ctx.moveTo(0, ROW_H * r); ctx.lineTo(W, ROW_H * r); ctx.stroke();
    }

    const rowYs = Array.from({ length: numRows }, (_, r) => ROW_H * (r + 0.5));
    const ltpArr = ltpSeriesRef.current;
    const miiArr = miiSeriesRef.current;
    const vptArr = vptSeriesRef.current;
    const vzpArr = vzpSeriesRef.current;
    const daArr = daSeriesRef.current;
    const oidArr = oidSeriesRef.current;
    const rexArr = rexSeriesRef.current;
    const ifiArr = ifiSeriesRef.current;
    const ifidArr = ifidSeriesRef.current;
    const ctxEventsArr = contextEventsSeriesRef.current;
    ctx.font = `600 9.5px ${MONO}`;
    ctx.textBaseline = "middle";

    const slotW  = cw + NZW + GAP;
    const nzHBot = Math.floor(NZW / 2);

    ctx.save();
    ctx.strokeStyle = C.daySep;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (let i = 1; i < bs.length; i++) {
      if (!isFirstBarOfDayIST(bs, i)) continue;
      const xSep = i * slotW - pan - GAP / 2;
      if (xSep < -2 || xSep > W + 2) continue;
      const x = Math.round(xSep) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    for (let i = 0; i < bs.length; i++) {
      const b  = bs[i];
      const x  = i * slotW - pan;
      const cx = x + nzHBot;
      if (cx + cw < 0 || cx > W) continue;

      /* current candle tint */
      if (i === bs.length - 1) {
        ctx.fillStyle = C.curBg;
        ctx.fillRect(cx, 0, cw, H);
      }
      if (barsRef.current[i] === hoverBar) {
        ctx.fillStyle = "rgba(155,125,255,0.10)";
        ctx.fillRect(cx, 0, cw, H);
      }

      const delta    = b.delta ?? 0;
      const cvd      = b.cvd   ?? 0;
      const vol      = (b.buy_vol || 0) + (b.sell_vol || 0);
      const oi       = b.oi       ?? 0;
      const oiChange = b.oi_change ?? 0;
      const midX     = cx + cw / 2;

      ctx.textAlign = "center";
      ctx.fillStyle = delta >= 0 ? C.buy : C.sell;
      ctx.fillText(fmtV(delta), midX, rowYs[0]);
      ctx.fillStyle = cvd >= 0 ? C.buy : C.sell;
      ctx.fillText(fmtV(cvd),   midX, rowYs[1]);
      ctx.fillStyle = C.textMid;
      ctx.fillText(fmtV(vol),   midX, rowYs[2]);
      if (showOI) {
        ctx.fillStyle = oiChange >= 0 ? C.buy : C.sell;
        ctx.fillText(oi > 0 ? fmtV(oi) : "—", midX, rowYs[3]);
      }
      const baseIdx = (showOI ? 4 : 3);
      if (showLTP && ltpArr[i] != null) {
        const ltp = ltpArr[i].ltp;
        ctx.fillStyle = ltp >= 0 ? C.buy : C.sell;
        ctx.fillText(ltp.toFixed(2), midX, rowYs[baseIdx]);
      }
      if (showMII && miiArr[i] != null) {
        const mii = miiArr[i].mii;
        ctx.fillStyle = mii >= 0 ? C.buy : C.sell;
        ctx.fillText(mii.toFixed(2), midX, rowYs[baseIdx + (showLTP ? 1 : 0)]);
      }
      if (showVPT && vptArr[i] != null) {
        const vpt = vptArr[i].vpt;
        ctx.fillStyle = vpt >= 0 ? "#7c3aed" : "#6d28d9";
        const vptRowIdx = (showVZP || showDA || showOID || showREX || showIFI || showIFID || showContextEvents) ? baseIdx + (showLTP ? 1 : 0) + (showMII ? 1 : 0) : numRows - 1;
        ctx.fillText(vpt.toFixed(2), midX, rowYs[vptRowIdx]);
      }
      if (showVZP && vzpArr[i] != null) {
        const vzpVal = vzpArr[i];
        const vzp = vzpVal.vzpRaw ?? vzpVal.vzp;
        ctx.fillStyle = vzp >= 0 ? "#d97706" : "#b45309";
        const vzpRowIdx = (showDA || showOID || showREX || showIFI || showIFID || showContextEvents) ? baseIdx + (showLTP ? 1 : 0) + (showMII ? 1 : 0) + (showVPT ? 1 : 0) : numRows - 1;
        ctx.fillText(vzp != null ? vzp.toFixed(2) : "—", midX, rowYs[vzpRowIdx]);
      }
      if (showDA && daArr[i] != null) {
        const da = daArr[i].da;
        ctx.fillStyle = da >= 0 ? "#0d9488" : "#be123c";
        const daRowIdx = (showOID || showREX || showIFI || showIFID || showContextEvents) ? baseIdx + (showLTP ? 1 : 0) + (showMII ? 1 : 0) + (showVPT ? 1 : 0) + (showVZP ? 1 : 0) : numRows - 1;
        ctx.fillText(da != null ? da.toFixed(2) : "—", midX, rowYs[daRowIdx]);
      }
      if (showOID && oidArr[i] != null) {
        const oid = oidArr[i].oid;
        const oidBullish = OID_CONTRARIAN ? oid < 0 : oid > 0;
        ctx.fillStyle = oidBullish ? "#0891b2" : "#b91c1c";
        const oidRowIdx = (showREX || showIFI || showIFID || showContextEvents) ? baseIdx + (showLTP ? 1 : 0) + (showMII ? 1 : 0) + (showVPT ? 1 : 0) + (showVZP ? 1 : 0) + (showDA ? 1 : 0) : numRows - 1;
        ctx.fillText(oid != null ? oid.toFixed(2) : "—", midX, rowYs[oidRowIdx]);
      }
      if (showREX && rexArr[i] != null) {
        const rex = rexArr[i].rex;
        ctx.fillStyle = rex > 0 ? "#059669" : rex < 0 ? "#dc2626" : C.textDim;
        const rexRowIdx = showIFI || showIFID || showContextEvents ? baseIdx + (showLTP ? 1 : 0) + (showMII ? 1 : 0) + (showVPT ? 1 : 0) + (showVZP ? 1 : 0) + (showDA ? 1 : 0) + (showOID ? 1 : 0) : numRows - 1;
        ctx.fillText(rex !== 0 ? (rex > 0 ? "↑" : "↓") : "—", midX, rowYs[rexRowIdx]);
      }
      if (showIFI && ifiArr[i] != null) {
        const ifi = ifiArr[i].ifi ?? ifiArr[i].ifiRaw ?? 0;
        const hasIfiSig = Math.abs(ifi) > IFI_THRESHOLD;
        ctx.fillStyle = hasIfiSig ? (ifi > 0 ? "#059669" : "#dc2626") : C.textDim;
        const ifiRowIdx = showIFID || showContextEvents ? baseIdx + (showLTP ? 1 : 0) + (showMII ? 1 : 0) + (showVPT ? 1 : 0) + (showVZP ? 1 : 0) + (showDA ? 1 : 0) + (showOID ? 1 : 0) + (showREX ? 1 : 0) : numRows - 1;
        ctx.fillText(hasIfiSig ? (ifi > 0 ? "↑" : "↓") : "—", midX, rowYs[ifiRowIdx]);
      }
      if (showIFID && ifidArr[i] != null) {
        const ifid = ifidArr[i].ifi ?? ifidArr[i].ifiRaw ?? 0;
        const hasIfidSig = Math.abs(ifid) > IFID_THRESHOLD;
        ctx.fillStyle = hasIfidSig ? (ifid > 0 ? "#059669" : "#dc2626") : C.textDim;
        const ifidRowIdx = showContextEvents ? baseIdx + (showLTP ? 1 : 0) + (showMII ? 1 : 0) + (showVPT ? 1 : 0) + (showVZP ? 1 : 0) + (showDA ? 1 : 0) + (showOID ? 1 : 0) + (showREX ? 1 : 0) + (showIFI ? 1 : 0) : numRows - 1;
        ctx.fillText(hasIfidSig ? (ifid > 0 ? "↑" : "↓") : "—", midX, rowYs[ifidRowIdx]);
      }
      if (showContextEvents && ctxEventsArr[i]?.event != null) {
        const ev = ctxEventsArr[i].event;
        const short = ev === "REVERSAL_TOP" ? "Rev↑" : ev === "RALLY_END" ? "REnd" : ev === "RALLY_START" ? "RStart" : "Rev↓";
        ctx.fillStyle = ev === "REVERSAL_TOP" || ev === "RALLY_END" ? "#c62828" : "#2e7d32";
        ctx.fillText(short, midX, rowYs[numRows - 1]);
      }
    }
  }, [dpr, hoverBar, showOI, showLTP, showMII, showVPT, showVZP, showDA, showOID, showREX, showIFI, showIFID, showContextEvents, numBotRows]);

  const scheduleDraw = useCallback(() => {
    if (rafId.current) cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => { rafId.current = null; draw(); });
  }, [draw]);

  /* fit: reset candle width + price scale so all candles fill screen */
  const handleFit = useCallback(() => {
    const bs = barsRef.current;
    if (!bs.length || !containerRef.current) return;
    userZoomedW.current = false; // allow auto-fit again
    const wrapW = (containerRef.current.clientWidth || 800) - PS_W - LABEL_W;
    const slotBase = NZW + GAP;
    const w = (wrapW + GAP - RPAD) / bs.length - slotBase;
    candleWRef.current = Math.round(Math.max(W_MIN, Math.min(W_MAX, w)));
    priceScaleRef.current = 1.0;
    priceOffRef.current   = 0;
    followLatest.current  = true;
    scheduleDraw();
  }, [scheduleDraw]);

  /* reset user zoom flag when chart instrument/timeframe changes (new chart → re-fit) */
  useEffect(() => { userZoomedW.current = false; }, [symbol, timeFrameMinutes]);

  /* initial fit on data change; skips candle-width reset if user has manually zoomed */
  useEffect(() => {
    if (!bars.length || !containerRef.current) return;
    if (!userZoomedW.current) {
      const wrapW = (containerRef.current.clientWidth || 800) - PS_W - LABEL_W;
      const slotBase = NZW + GAP;
      const w = (wrapW + GAP - RPAD) / bars.length - slotBase;
      candleWRef.current = Math.round(Math.max(W_MIN, Math.min(W_MAX, w)));
    }
    scheduleDraw();
  }, [bars, scheduleDraw]);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const updateHeight = () => { scheduleDraw(); };
    updateHeight();
    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scheduleDraw]);

  /* canvas pointer — single-finger drag + two-finger pinch zoom */
  useEffect(() => {
    const cv  = canvasRef.current; if (!cv) return;
    const pts = activePointers.current;

    const onDown = e => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cv.setPointerCapture?.(e.pointerId);

      if (pts.size === 1) {
        // single-finger: start horizontal + vertical drag
        dragging.current      = true;
        dragX.current         = e.clientX;
        dragY.current         = e.clientY;
        panStart.current      = panRef.current;
        priceOffStart.current = priceOffRef.current;
        followLatest.current  = false;
        cv.style.cursor       = "grabbing";
      } else if (pts.size === 2) {
        // second finger landed → switch to pinch; cancel the drag
        dragging.current  = false;
        cv.style.cursor   = "crosshair";
        const [a, b]      = [...pts.values()];
        pinchDist0.current = Math.hypot(b.x - a.x, b.y - a.y);
        pinchCW0.current   = candleWRef.current;
      }
    };

    const onMove = e => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pts.size >= 2) {
        // ── pinch zoom: adjust candle width ──
        const [a, b] = [...pts.values()];
        const dist   = Math.hypot(b.x - a.x, b.y - a.y);
        if (pinchDist0.current > 0) {
          userZoomedW.current = true;
          candleWRef.current = Math.max(W_MIN, Math.min(W_MAX,
            pinchCW0.current * (dist / pinchDist0.current)));
          scheduleDraw();
        }
        return;
      }

      if (dragging.current) {
        // ── single-finger drag: pan horizontally + vertically ──
        panRef.current = Math.max(0, Math.min(getMaxPan(),
          panStart.current - (e.clientX - dragX.current)));
        const h = getCanvasH(), vr = getVisRange();
        if (h > 0 && vr > 0) {
          const dy = e.clientY - dragY.current;
          // +dy: drag down → see higher prices (natural "grab-and-move" feel)
          priceOffRef.current = priceOffStart.current + dy * (vr / h);
        }
        scheduleDraw();
        return;
      }

      // ── no drag: hover crosshair ──
      const rect  = cv.getBoundingClientRect();
      const mx    = e.clientX - rect.left + panRef.current;
      const my    = e.clientY - rect.top;
      const slotW = candleWRef.current + NZW + GAP;
      const idx   = Math.floor(mx / slotW);
      const bs    = barsRef.current;
      setHoverBar(idx >= 0 && idx < bs.length ? bs[idx] : null);
      const H = getCanvasH();
      if (H > 0) {
        const vr = getVisRange(), vm = getVisPMin();
        setHoverPrice(isFinite(vm + vr * (1 - my / H)) ? vm + vr * (1 - my / H) : null);
      } else setHoverPrice(null);
    };

    const onUp = e => {
      pts.delete(e.pointerId);
      if (pts.size === 0) {
        dragging.current   = false;
        pinchDist0.current = 0;
        cv.style.cursor    = "crosshair";
      } else if (pts.size === 1) {
        // One finger lifted during pinch — reset; don't resume drag immediately
        pinchDist0.current = 0;
        dragging.current   = false;
      }
    };

    const onLeave = () => { setHoverBar(null); setHoverPrice(null); };

    cv.addEventListener("pointerdown",   onDown);
    cv.addEventListener("pointermove",   onMove);
    cv.addEventListener("pointerup",     onUp);
    cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("pointerleave",  onLeave);
    return () => {
      cv.removeEventListener("pointerdown",   onDown);
      cv.removeEventListener("pointermove",   onMove);
      cv.removeEventListener("pointerup",     onUp);
      cv.removeEventListener("pointercancel", onUp);
      cv.removeEventListener("pointerleave",  onLeave);
    };
  }, [getMaxPan, getCanvasH, getVisRange, getVisPMin, scheduleDraw]);

  /* canvas wheel */
  useEffect(() => {
    const el = canvasRef.current; if (!el) return;
    const onWheel = e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        userZoomedW.current = true;
        candleWRef.current = Math.max(W_MIN, Math.min(W_MAX, candleWRef.current + (e.deltaY > 0 ? -5 : 5)));
      } else if (e.shiftKey) {
        // shift+scroll on chart = price scale (down=zoom out/shrink, up=zoom in/expand)
        const f = e.deltaY > 0 ? 1.1 : 1 / 1.1;
        priceScaleRef.current = Math.max(0.2, Math.min(10, priceScaleRef.current * f));
      } else {
        followLatest.current = false;
        panRef.current = Math.max(0, Math.min(getMaxPan(), panRef.current + e.deltaY * 0.8));
      }
      scheduleDraw();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [getMaxPan, scheduleDraw]);

  /* price scale: scroll down = zoom out (shrink rows); drag down = zoom out (TradingView style) */
  useEffect(() => {
    const psEl = psRef.current; if (!psEl) return;
    const onWheel = e => {
      e.preventDefault();
      if (e.shiftKey) {
        userZoomedW.current = true;
        candleWRef.current = Math.max(W_MIN, Math.min(W_MAX, candleWRef.current + (e.deltaY > 0 ? -4 : 4)));
      } else {
        // scroll down = zoom out (prices shrink, more range visible)
        const f = e.deltaY > 0 ? 1.1 : 1 / 1.1;
        priceScaleRef.current = Math.max(0.2, Math.min(10, priceScaleRef.current * f));
      }
      scheduleDraw();
    };
    const onDown  = e => { psDragY0.current = e.clientY; psScale0.current = priceScaleRef.current; psEl.setPointerCapture?.(e.pointerId); };
    const onMove  = e => {
      if (psDragY0.current === null) return;
      // drag down = zoom out, drag up = zoom in
      const dy = e.clientY - psDragY0.current;
      const f  = Math.pow(1.003, dy);
      priceScaleRef.current = Math.max(0.2, Math.min(10, psScale0.current * f));
      scheduleDraw();
    };
    const onUp    = () => { psDragY0.current = null; };
    const onLeave = () => { psDragY0.current = null; };
    psEl.addEventListener("wheel",        onWheel, { passive: false });
    psEl.addEventListener("pointerdown",  onDown);
    psEl.addEventListener("pointermove",  onMove);
    psEl.addEventListener("pointerup",    onUp);
    psEl.addEventListener("pointerleave", onLeave);
    return () => {
      psEl.removeEventListener("wheel",        onWheel);
      psEl.removeEventListener("pointerdown",  onDown);
      psEl.removeEventListener("pointermove",  onMove);
      psEl.removeEventListener("pointerup",    onUp);
      psEl.removeEventListener("pointerleave", onLeave);
    };
  }, [scheduleDraw]);

  /* time axis: scroll wheel OR horizontal drag adjusts candle width (horizontal zoom) */
  useEffect(() => {
    const el = timeRef.current; if (!el) return;
    let dragStartX = null, dragStartCW = 32;

    const onWheel = e => {
      e.preventDefault();
      userZoomedW.current = true;
      candleWRef.current = Math.max(W_MIN, Math.min(W_MAX,
        candleWRef.current + (e.deltaY > 0 ? -1 : 1)));
      scheduleDraw();
    };
    const onDown = e => {
      dragStartX  = e.clientX;
      dragStartCW = candleWRef.current;
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = e => {
      if (dragStartX === null) return;
      // drag right → wider candles; drag left → narrower candles
      const dx = e.clientX - dragStartX;
      userZoomedW.current = true;
      candleWRef.current = Math.max(W_MIN, Math.min(W_MAX, dragStartCW + dx * 0.15));
      scheduleDraw();
    };
    const onUp = () => { dragStartX = null; };

    el.addEventListener("wheel",        onWheel, { passive: false });
    el.addEventListener("pointerdown",  onDown);
    el.addEventListener("pointermove",  onMove);
    el.addEventListener("pointerup",    onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("wheel",        onWheel);
      el.removeEventListener("pointerdown",  onDown);
      el.removeEventListener("pointermove",  onMove);
      el.removeEventListener("pointerup",    onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [scheduleDraw]);

  /* fullscreen — native where supported, CSS overlay fallback for iOS Safari */
  const toggleFS = useCallback(() => {
    const el = rootRef.current; if (!el) return;
    if (document.fullscreenEnabled) {
      // Desktop / Android Chrome: use native fullscreen API
      if (!document.fullscreenElement) el.requestFullscreen?.();
      else document.exitFullscreen?.();
    } else {
      // iOS Safari: no fullscreenEnabled — toggle CSS overlay instead
      setIsFS(fs => !fs);
      scheduleDraw();
    }
  }, [scheduleDraw]);
  useEffect(() => {
    // Syncs isFS when native fullscreen is entered/exited (not triggered on iOS)
    const cb = () => { setIsFS(!!document.fullscreenElement); scheduleDraw(); };
    document.addEventListener("fullscreenchange",       cb);
    document.addEventListener("webkitfullscreenchange", cb);
    return () => {
      document.removeEventListener("fullscreenchange",       cb);
      document.removeEventListener("webkitfullscreenchange", cb);
    };
  }, [scheduleDraw]);

  /* keyboard */
  useEffect(() => {
    const onKey = e => {
      if (e.key === "a" || e.key === "A") {
        followLatest.current = true;
        handleFit();
      }
      if (e.key === "f" || e.key === "F") toggleFS();
      if (e.key === "l" || e.key === "L") setShowLines(v => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleFit, toggleFS]);

  useEffect(() => { scheduleDraw(); }, [showLines, scheduleDraw]);
  useEffect(() => { scheduleDraw(); }, [hoverBar, hoverPrice, scheduleDraw]);

  /* ── empty state ── */
  if (!bars.length) return (
    <div style={{ background: C.bg, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 40, fontFamily: SANS, color: C.textMid, display: "flex", flexDirection: "column", alignItems: "center", gap: 10, minHeight: 340, justifyContent: "center" }}>
      <span style={{ fontSize: 32 }}>📊</span>
      <strong style={{ color: C.textDark }}>{symbol} — Footprint Chart</strong>
      <span style={{ fontSize: 13 }}>Waiting for data…</span>
    </div>
  );

  const last = hdrData?.last ?? bars[bars.length - 1];
  const chg  = hdrData?.chg  ?? 0;

  /* ════════════════ RENDER ════════════════ */
  return (
    <div ref={rootRef} style={{
      display: "flex", flexDirection: "column",
      /* When fullscreen: fixed overlay fills entire viewport (works on iOS Safari too) */
      ...(isFS
        ? { position: "fixed", inset: 0, width: "100%", height: "100%", zIndex: 9999 }
        : { width: "100%", flex: 1, minHeight: 0 }
      ),
      background: C.bgPanel,
      border: isFS ? "none" : `1.5px solid ${C.border}`,
      borderRadius: isFS ? 0 : 10, overflow: "hidden",
      fontFamily: SANS, userSelect: "none",
      boxShadow: isFS ? "none" : "0 2px 20px rgba(0,0,0,0.09)",
    }}>

      {/* ── HEADER ── */}
      <div style={{
        display: "flex", flexDirection: "column",
        background: "#fff", borderBottom: `1.5px solid ${C.border}`,
        flexShrink: 0, boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
      }}>
        {/* Row 1: info left | action buttons right */}
        <div style={{
          display: "flex", alignItems: "center", gap: isMobile ? 6 : 10,
          padding: isMobile ? "4px 8px" : "0 14px",
          height: isMobile ? 32 : HDR_H_EFF, minHeight: isMobile ? 32 : HDR_H_EFF,
        }}>
          {/* ── info ── */}
          <span style={{ fontSize: isMobile ? 11 : 13, fontWeight: 700, color: C.textDark, letterSpacing: ".04em", whiteSpace: "nowrap" }}>{symbol}</span>
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.textDim, whiteSpace: "nowrap" }}>{timeFrameMinutes}m</span>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.buy, display: "inline-block", flexShrink: 0, animation: "fp-pulse 1.6s ease-in-out infinite" }} />
          <span style={{ fontFamily: MONO, fontSize: isMobile ? 10 : 11, fontWeight: 700, color: C.textDark, whiteSpace: "nowrap" }}>{fmt2(last.close ?? 0)}</span>
          <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, color: "#fff", background: chg >= 0 ? C.buy : C.sell, flexShrink: 0 }}>
            {chg >= 0 ? "+" : ""}{chg.toFixed(2)}%
          </span>

          <div style={{ flex: 1 }} />

          {/* ── action buttons – always visible ── */}
          {!followLatest.current && (
            <button
              onClick={() => { followLatest.current = true; scheduleDraw(); }}
              style={{ ...btnStyle, borderColor: C.buy, color: C.buy, fontSize: 9, padding: isMobile ? "3px 6px" : "2px 8px", minWidth: isMobile ? 36 : undefined }}
            >▶</button>
          )}
          <button
            onClick={() => setShowLines(v => !v)}
            title="Toggle imbalance lines"
            style={{ ...btnStyle, background: showLines ? "rgba(38,166,154,0.10)" : "none", borderColor: showLines ? C.buy : C.border, color: showLines ? C.buy : C.textMid, padding: isMobile ? "3px 7px" : "2px 8px", minWidth: isMobile ? 36 : undefined }}
          >⟷</button>
          <button onClick={handleFit} title="Fit all candles [A]"
            style={{ ...btnStyle, padding: isMobile ? "3px 7px" : "2px 8px", minWidth: isMobile ? 36 : undefined }}
          >{isMobile ? "⊡" : "Fit"}</button>
          <button onClick={toggleFS} title="Fullscreen"
            style={{ ...btnStyle, fontSize: isMobile ? 15 : 13, padding: isMobile ? "2px 7px" : "2px 7px", minWidth: isMobile ? 36 : undefined }}
          >{isFS ? "⊠" : "⛶"}</button>
          <button
            title="Open full screen in new tab"
            onClick={() => window.open(`${window.location.origin}/?symbol=${encodeURIComponent(symbol)}&view=fp`, "_blank")}
            style={{ ...btnStyle, fontSize: isMobile ? 14 : 12, padding: isMobile ? "2px 7px" : "2px 7px", minWidth: isMobile ? 36 : undefined }}
          >⧉</button>
        </div>

        {/* Row 2: hover info (desktop only — touch devices don't hover) */}
        {!isMobile && (hoverBar || hoverPrice != null) && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 14px 4px", flexShrink: 0 }}>
            {hoverPrice != null && (
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: C.textDark }}>
                {fmtP(hoverPrice)}
              </span>
            )}
            {hoverBar && (
              <>
                <span style={{ fontFamily: MONO, fontSize: 9, color: C.textDim }}>{toIST(hoverBar.open_time)}</span>
                <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: (hoverBar.delta ?? 0) >= 0 ? C.buy : C.sell }}>
                  Δ{sgn(hoverBar.delta ?? 0)}{fmtV(hoverBar.delta ?? 0)}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 9, color: C.textDim }}>
                  Vol {fmtV((hoverBar.buy_vol || 0) + (hoverBar.sell_vol || 0))}
                </span>
                {showLTP && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const ltpVal = barIdx >= 0 ? ltpSeriesRef.current[barIdx]?.ltp : null;
                  return ltpVal != null && Math.abs(ltpVal) > LTP_THRESHOLD ? (
                    <span
                      title={`LTP > ${LTP_THRESHOLD}: Bullish trap for shorts | LTP < -${LTP_THRESHOLD}: Bull trap`}
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: ltpVal >= 0 ? C.buy : C.sell }}
                    >
                      LTP {ltpVal.toFixed(2)}
                    </span>
                  ) : null;
                })()}
                {showMII && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const miiVal = barIdx >= 0 ? miiSeriesRef.current[barIdx]?.mii : null;
                  return miiVal != null && Math.abs(miiVal) > SIGNAL_THRESHOLD ? (
                    <span
                      title={`MII > ${SIGNAL_THRESHOLD}: Buying ignition | MII < -${SIGNAL_THRESHOLD}: Selling ignition`}
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: miiVal >= 0 ? C.buy : C.sell }}
                    >
                      MII {miiVal.toFixed(2)}
                    </span>
                  ) : null;
                })()}
                {showVPT && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const vptVal = barIdx >= 0 ? vptSeriesRef.current[barIdx]?.vpt : null;
                  return vptVal != null && Math.abs(vptVal) > SIGNAL_THRESHOLD ? (
                    <span
                      title={`VPT > ${SIGNAL_THRESHOLD}: Volume skewed up | VPT < -${SIGNAL_THRESHOLD}: Volume skewed down`}
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: vptVal >= 0 ? "#7c3aed" : "#6d28d9" }}
                    >
                      VPT {vptVal.toFixed(2)}
                    </span>
                  ) : null;
                })()}
                {showVZP && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const vzpVal = barIdx >= 0 ? vzpSeriesRef.current[barIdx] : null;
                  const vzp = vzpVal?.vzpRaw ?? vzpVal?.vzp;
                  return vzp != null && Math.abs(vzp) > VZP_THRESHOLD ? (
                    <span
                      title={`VZP predicts next bar direction. VZP > ${VZP_THRESHOLD}: Ask zone heavy (bearish) | VZP < -${VZP_THRESHOLD}: Bid zone heavy (bullish)`}
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: vzp >= 0 ? "#d97706" : "#b45309" }}
                    >
                      VZP {vzp.toFixed(2)}
                    </span>
                  ) : null;
                })()}
                {showDA && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const daVal = barIdx >= 0 ? daSeriesRef.current[barIdx]?.da : null;
                  return daVal != null && Math.abs(daVal) > DA_THRESHOLD ? (
                    <span
                      title={`DA > ${DA_THRESHOLD}: Flow accelerating bullish | DA < -${DA_THRESHOLD}: Flow accelerating bearish`}
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: daVal >= 0 ? "#0d9488" : "#be123c" }}
                    >
                      DA {daVal.toFixed(2)}
                    </span>
                  ) : null;
                })()}
                {showOID && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const oidVal = barIdx >= 0 ? oidSeriesRef.current[barIdx]?.oid : null;
                  const oidUp = oidVal != null && OID_CONTRARIAN ? oidVal < -OID_THRESHOLD : oidVal != null && oidVal > OID_THRESHOLD;
                  return oidVal != null && Math.abs(oidVal) > OID_THRESHOLD ? (
                    <span
                      title={OID_CONTRARIAN ? `OID contrarian: OID < -${OID_THRESHOLD} = expect up | OID > ${OID_THRESHOLD} = expect down` : `OID > ${OID_THRESHOLD}: confluence (bullish) | OID < -${OID_THRESHOLD}: divergence (bearish)`}
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: oidUp ? "#0891b2" : "#b91c1c" }}
                    >
                      OID {oidVal.toFixed(2)}
                    </span>
                  ) : null;
                })()}
                {showREX && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const rexVal = barIdx >= 0 ? rexSeriesRef.current[barIdx]?.rex : null;
                  return rexVal != null && rexVal !== 0 ? (
                    <span
                      title="Range Expansion: bar range ≥ 1.8× avg. Green bar + expansion → expect down. Red bar + expansion → expect up."
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: rexVal > 0 ? "#059669" : "#dc2626" }}
                    >
                      REX {rexVal > 0 ? "↑" : "↓"}
                    </span>
                  ) : null;
                })()}
                {showIFI && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const ifiVal = barIdx >= 0 ? (ifiSeriesRef.current[barIdx]?.ifi ?? ifiSeriesRef.current[barIdx]?.ifiRaw) : null;
                  return ifiVal != null && Math.abs(ifiVal) > IFI_THRESHOLD ? (
                    <span
                      title="Initiator Flow: bid vs ask zone volume (open/close mid). Bid heavy → expect up. Ask heavy → expect down."
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: ifiVal > 0 ? "#059669" : "#dc2626" }}
                    >
                      IFI {ifiVal > 0 ? "↑" : "↓"}
                    </span>
                  ) : null;
                })()}
                {showIFID && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const ifidVal = barIdx >= 0 ? (ifidSeriesRef.current[barIdx]?.ifi ?? ifidSeriesRef.current[barIdx]?.ifiRaw) : null;
                  return ifidVal != null && Math.abs(ifidVal) > IFID_THRESHOLD ? (
                    <span
                      title="IFI+Depth: footprint zone pressure + 200-level order book imbalance. Bid heavy → expect up."
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: ifidVal > 0 ? "#059669" : "#dc2626" }}
                    >
                      IFID {ifidVal > 0 ? "↑" : "↓"}
                    </span>
                  ) : null;
                })()}
                {showContextEvents && (() => {
                  const barIdx = bars.indexOf(hoverBar);
                  const ev = barIdx >= 0 ? contextEventsSeriesRef.current[barIdx] : null;
                  return ev?.event != null ? (
                    <span
                      title={`${ev.event}: confidence ${ev.confidence?.toFixed(2) ?? "—"}. Predicts next bar direction.`}
                      style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: ev.event === "REVERSAL_TOP" || ev.event === "RALLY_END" ? "#c62828" : "#2e7d32" }}
                    >
                      {ev.event === "REVERSAL_TOP" ? "Rev↑" : ev.event === "RALLY_END" ? "REnd" : ev.event === "RALLY_START" ? "RStart" : "Rev↓"}
                    </span>
                  ) : null;
                })()}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── BODY ── */}
      <div ref={containerRef} style={{ display: "flex", flex: 1, flexDirection: "column", overflow: "hidden", minHeight: 0 }}>

        {/* canvas + price scale (marginLeft so chart aligns with bottom strip values) */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0, marginLeft: LABEL_W }}>
          <div style={{ flex: 1, overflow: "hidden", position: "relative", cursor: "crosshair",
                        touchAction: "none" /* prevent browser scroll/zoom intercepting chart gestures */ }}>
            <canvas ref={canvasRef} style={{ display: "block", touchAction: "none" }} />
          </div>

          {/* price scale */}
          <div ref={psRef} style={{
            width: PS_W, flexShrink: 0,
            background: "#f4f5f8",
            borderLeft: `1.5px solid ${C.border}`,
            position: "relative", overflow: "hidden",
            cursor: "ns-resize",
            touchAction: "none",
          }}>
            <div style={{
              position: "absolute", top: 0, left: 0, right: 0, textAlign: "center",
              fontFamily: MONO, fontSize: 8, color: "#c0c8d8", padding: "2px 0",
              background: "linear-gradient(to bottom,#f4f5f8,transparent)",
              pointerEvents: "none", zIndex: 5,
            }}>↓ zoom out · ↑ zoom in</div>

            {/* last price badge */}
            <div className="fp-last" style={{
              position: "absolute", left: 0, right: 0, top: "50%",
              display: "flex", alignItems: "center",
              padding: "2px 5px", zIndex: 10,
              transform: "translateY(-50%)",
              pointerEvents: "none",
              background: C.buy, borderRadius: 3,
            }}>
              <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: "#fff", whiteSpace: "nowrap" }}>—</span>
            </div>
          </div>
        </div>

        {/* time axis (align with chart) */}
        <div ref={timeRef} style={{
          height: TIME_H_EFF, background: "#f4f5f8",
          borderTop: `1.5px solid ${C.border}`,
          position: "relative", overflow: "hidden",
          flexShrink: 0, marginLeft: LABEL_W, marginRight: PS_W,
          touchAction: "none",
          cursor: "ew-resize",
        }} />

        {/* ── BOTTOM STRIP ── */}
        <div style={{
          height: BOT_H_EFF, background: "#fff",
          borderTop: `1.5px solid ${C.border}`,
          flexShrink: 0, overflow: "hidden",
          position: "relative",
          boxShadow: "0 -1px 6px rgba(0,0,0,0.04)",
          display: "flex",
        }}>
          {/* static left labels */}
          <div style={{
            width: 52, flexShrink: 0,
            display: "flex", flexDirection: "column",
            justifyContent: "space-around",
            padding: "4px 5px",
            borderRight: `1px solid ${C.border}`,
            background: "#fff",
            zIndex: 2,
          }}>
            {[
              { label: "TICK Δ", color: C.textDim },
              { label: "CVD",    color: C.textDim },
              { label: "VOL",    color: C.textDim },
              ...(showOI ? [{ label: "OI", color: C.textDim }] : []),
              ...(showLTP ? [{ label: "LTP", color: C.textDim }] : []),
              ...(showMII ? [{ label: "MII", color: C.textDim }] : []),
              ...(showVPT ? [{ label: "VPT", color: C.textDim }] : []),
              ...(showVZP ? [{ label: "VZP", color: C.textDim }] : []),
              ...(showDA ? [{ label: "DA", color: C.textDim }] : []),
              ...(showOID ? [{ label: "OID", color: C.textDim }] : []),
              ...(showREX ? [{ label: "REX", color: C.textDim }] : []),
              ...(showIFI ? [{ label: "IFI", color: C.textDim }] : []),
              ...(showIFID ? [{ label: "IFID", color: C.textDim }] : []),
              ...(showContextEvents ? [{ label: "CAE", color: C.textDim }] : []),
            ].map(({ label, color }) => (
              <span key={label} style={{
                fontSize: 8, color, fontWeight: 700,
                letterSpacing: ".04em", fontFamily: MONO,
                display: "flex", alignItems: "center", flex: 1,
              }}>{label}</span>
            ))}
          </div>
          {/* canvas-drawn values (offset by label width) */}
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            <canvas ref={botCanvasRef} style={{ position: "absolute", top: 0, left: 0, display: "block" }} />
          </div>
        </div>
      </div>

      <style>{`@keyframes fp-pulse{0%,100%{opacity:1}50%{opacity:.15}}`}</style>
    </div>
  );
}

const btnStyle = {
  background: "none", border: "1.5px solid #dde1ea", color: "#6870a0",
  fontSize: 10, padding: "2px 8px", borderRadius: 5, cursor: "pointer",
  fontFamily: "'IBM Plex Sans','Segoe UI',sans-serif", fontWeight: 500,
  transition: "background .12s, border-color .12s",
};
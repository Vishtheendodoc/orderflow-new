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
  buy:      "#26a69a",
  buyMid:   "rgba(38,166,154,0.72)",
  buyHL:    "rgba(38,166,154,0.18)",
  buyLine:  "rgba(38,166,154,0.50)",
  sell:     "#ef5350",
  sellMid:  "rgba(239,83,80,0.72)",
  sellHL:   "rgba(239,83,80,0.18)",
  sellLine: "rgba(239,83,80,0.50)",
  bodyBull: "rgba(38,166,154,0.65)",
  brdBull:  "#26a69a",
  bodyBear: "rgba(239,83,80,0.65)",
  brdBear:  "#ef5350",
  textDark: "#1a2035",
  textMid:  "#6870a0",
  textDim:  "#a8b0c8",
  curBg:    "rgba(155,125,255,0.07)",
};

const MONO = "'JetBrains Mono','Fira Mono','Consolas',monospace";
const SANS = "'IBM Plex Sans','Segoe UI',sans-serif";
const GAP         = 2;
const NUM_ZONE_W  = 52; // fixed width for sell/buy numbers (keeps distance from candle independent of zoom)
const PS_W     = 80;   // price scale width
const LABEL_W  = 52;   // bottom strip label column width (chart must start here to align)
const HDR_H    = 48;
const TIME_H   = 24;
const BOT_H    = 68;
const W_MIN    = 18;   // narrower candles; numbers in fixed zone to the right
const W_MAX    = 180;
const BODY_HALF = 3;   // body is 6px wide total
const ROW_MIN  = 16;   // minimum px per row when computing level cap (fewer rows = more space each)
const ROW_PREF = 18;   // preferred
const ROW_MAX  = 28;
const RIGHT_PAD = 60;  // space after last candle
const MAX_LEVELS_DISPLAY = 26;  // max rows; capped by floor(chartH/ROW_MIN) for auto-adjust
const MAX_LEVELS_FALLBACK = 16; // when chart height unknown, keep view readable

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

/* round to nearest tick */
const snapTick = (v, tick) => Math.round(v / tick) * tick;

/* ─── processCandles ───
 * maxLevelsCap: optional; max rows per candle (for high-priced / higher TF). Uses floor(chartH/ROW_MIN) when passed.
 */
function processCandles(candles, maxLevelsCap) {
  if (!candles?.length) return { bars: [], priceMin: 0, priceMax: 1, priceRange: 1, tickSize: 0.5 };
  const cap = maxLevelsCap != null && maxLevelsCap > 0
    ? Math.max(12, Math.min(MAX_LEVELS_DISPLAY, maxLevelsCap))
    : MAX_LEVELS_FALLBACK;

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
  const maxLevels = Math.max(0, ...bars.map(b => b.levels.length));

  if (maxLevels > cap && priceRange > 0) {
    const bucketStep = Math.max(tickSize, priceRange / cap);
    bars.forEach(bar => {
      const lvs = bar.levels;
      if (lvs.length <= cap) return;
      const buckets = new Map();
      lvs.forEach(lv => {
        const p = lv.price;
        const bi = Math.min(cap - 1, Math.floor((p - pMin) / bucketStep));
        if (!buckets.has(bi)) buckets.set(bi, { priceSum: 0, priceCount: 0, buy_vol: 0, sell_vol: 0 });
        const b = buckets.get(bi);
        b.buy_vol += lv.buy_vol ?? 0;
        b.sell_vol += lv.sell_vol ?? 0;
        b.priceSum += p;
        b.priceCount += 1;
      });
      const merged = Array.from(buckets.entries())
        .sort((a, b) => (b[1].priceSum / b[1].priceCount) - (a[1].priceSum / a[1].priceCount))
        .map(([, b]) => ({ price: b.priceCount ? b.priceSum / b.priceCount : 0, buy_vol: b.buy_vol, sell_vol: b.sell_vol }));
      const tBuy = merged.reduce((s, l) => s + (l.buy_vol || 0), 0);
      const tSell = merged.reduce((s, l) => s + (l.sell_vol || 0), 0);
      const avgB = merged.length ? tBuy / merged.length : 0;
      const avgS = merged.length ? tSell / merged.length : 0;
      const maxV = merged.reduce((m, l) => Math.max(m, (l.buy_vol || 0) + (l.sell_vol || 0)), 1);
      bar.levels = merged.map(lv => ({
        ...lv,
        highBuy:  avgB > 0 && (lv.buy_vol || 0) >= avgB * 2 && (lv.buy_vol || 0) > (lv.sell_vol || 0),
        highSell: avgS > 0 && (lv.sell_vol || 0) >= avgS * 2 && (lv.sell_vol || 0) > (lv.buy_vol || 0),
        volRatio: ((lv.buy_vol || 0) + (lv.sell_vol || 0)) / maxV,
      }));
    });
  }

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

/* ════════════════════════════════════════════
   COMPONENT
════════════════════════════════════════════ */
export default function FootprintChart({ candles, symbol = "NIFTY", timeFrameMinutes = 1 }) {
  /* compact layout for narrow/mobile screens */
  const isMobile   = typeof window !== "undefined" && window.innerWidth <= 768;
  const HDR_H_EFF  = isMobile ? 36 : HDR_H;
  const TIME_H_EFF = isMobile ? 18 : TIME_H;
  const BOT_H_EFF  = isMobile ? 52 : BOT_H;

  const rootRef      = useRef(null);
  const containerRef = useRef(null);
  const canvasRef    = useRef(null);
  const psRef        = useRef(null);
  const timeRef      = useRef(null);
  const botCanvasRef = useRef(null);

  /* chart state */
  const candleWRef   = useRef(32);
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
  const [chartAreaHeight, setChartAreaHeight] = useState(0);
  const showLinesRef = useRef(false);
  useEffect(() => { showLinesRef.current = showLines; }, [showLines]);
  useEffect(() => { followLatest.current = isFollowingLatest; }, [isFollowingLatest]);

  const maxLevelsCap = chartAreaHeight > 0
    ? Math.max(12, Math.min(MAX_LEVELS_DISPLAY, Math.floor(chartAreaHeight / ROW_MIN)))
    : MAX_LEVELS_FALLBACK;

  const { bars, priceMin, priceMax, priceRange, tickSize } =
    useMemo(() => processCandles(candles, maxLevelsCap), [candles, maxLevelsCap]);

  const barsRef     = useRef(bars);
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
  }, [bars, priceMin, priceMax, priceRange, tickSize]);

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
    const slotW = cw + NUM_ZONE_W + GAP;
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
    const slotW    = cw + NUM_ZONE_W + GAP;
    const chartW   = barsRef.current.length * slotW - GAP + RIGHT_PAD;
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
    const slotW  = cw + NUM_ZONE_W + GAP;
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
    const FONT_SZ   = Math.max(9, Math.min(13, Math.floor(LEVEL_H * 0.65)));

    /**
     * Dynamic aggregation: when zoomed out (pxPerTick < ROW_MIN), bucket price levels
     * into coarser ticks so numbers don't overlap and volumes aggregate to price.
     */
    const getDisplayLevels = (levels) => {
      if (pxPerTick >= ROW_MIN || ts <= 0 || !levels.length) return levels;
      const factor  = Math.ceil(ROW_MIN / pxPerTick);
      const coarseT = ts * factor;
      const buckets = new Map();
      for (const lv of levels) {
        const rounded = snapTick(lv.price, coarseT);
        const key = rounded.toFixed(6);
        if (!buckets.has(key)) buckets.set(key, { price: rounded, buy_vol: 0, sell_vol: 0 });
        const bk = buckets.get(key);
        bk.buy_vol  += lv.buy_vol  || 0;
        bk.sell_vol += lv.sell_vol || 0;
      }
      const merged = Array.from(buckets.values()).sort((a, b) => b.price - a.price);
      const tBuy  = merged.reduce((s, l) => s + l.buy_vol,  0);
      const tSell = merged.reduce((s, l) => s + l.sell_vol, 0);
      const avgB  = merged.length ? tBuy  / merged.length : 0;
      const avgS  = merged.length ? tSell / merged.length : 0;
      const maxV  = merged.reduce((m, l) => Math.max(m, l.buy_vol + l.sell_vol), 1);
      return merged.map(lv => ({
        ...lv,
        highBuy:  avgB > 0 && lv.buy_vol  >= avgB * 2 && lv.buy_vol  > lv.sell_vol,
        highSell: avgS > 0 && lv.sell_vol >= avgS * 2 && lv.sell_vol > lv.buy_vol,
        volRatio: (lv.buy_vol + lv.sell_vol) / maxV,
      }));
    };

    /* imbalance lines collection (for Lines toggle only) */
    const buyLinePrices  = new Set();
    const sellLinePrices = new Set();

    /* ── PASS 1: row backgrounds (no grid lines) ── */
    ctx.font = `600 ${FONT_SZ}px ${MONO}`;
    ctx.textBaseline = "middle";

    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      const x = i * slotW - pan;
      if (x + cw + NUM_ZONE_W < 0 || x > W) continue;

      const bull = (b.close ?? b.open ?? 0) >= (b.open ?? b.close ?? 0);

      /* current candle tint */
      if (i === bs.length - 1) {
        ctx.fillStyle = C.curBg;
        ctx.fillRect(x - 1, 0, cw + NUM_ZONE_W + 2, H);
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(x, 0, cw, H); ctx.clip();

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
      const x = i * slotW - pan;
      if (x + cw < 0 || x > W) continue;

      const open  = b.open  ?? b.close ?? 0;
      const close = b.close ?? b.open  ?? 0;
      const high  = b.high  ?? Math.max(open, close);
      const low   = b.low   ?? Math.min(open, close);
      const bull  = close >= open;

      const openY  = p2y(open,  H);
      const closeY = p2y(close, H);
      const highY  = p2y(high,  H);
      const lowY   = p2y(low,   H);
      const midX   = Math.round(x + cw / 2);
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

    /* ── PASS 4: numbers in fixed zone; reduced spacing; auto-adjust font to avoid overlap ── */
    ctx.textBaseline = "middle";
    const numZonePad = 1;
    const minGap     = 3;
    const availableW = NUM_ZONE_W - 2 * numZonePad;

    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      const x = i * slotW - pan;
      const numZoneStart = x + cw;
      if (numZoneStart + NUM_ZONE_W < 0 || x > W) continue;

      ctx.save();
      ctx.beginPath(); ctx.rect(numZoneStart, 0, NUM_ZONE_W, H); ctx.clip();

      for (const lv of getDisplayLevels(b.levels)) {
        const ly = p2y(lv.price, H);
        if (ly < -2 || ly > H + 2) continue;

        const sellTxt = fmtV(lv.sell_vol || 0);
        const buyTxt  = fmtV(lv.buy_vol || 0);
        let fontSize = FONT_SZ;
        ctx.font = `600 ${fontSize}px ${MONO}`;
        let sellW = ctx.measureText(sellTxt).width;
        let buyW  = ctx.measureText(buyTxt).width;
        if (sellW + buyW + minGap > availableW && fontSize > 8) {
          fontSize = Math.max(8, Math.floor(availableW / (sellW + buyW + minGap) * fontSize));
          ctx.font = `600 ${fontSize}px ${MONO}`;
          sellW = ctx.measureText(sellTxt).width;
          buyW  = ctx.measureText(buyTxt).width;
        }
        const sellX = numZoneStart + numZonePad;
        const buyX  = numZoneStart + NUM_ZONE_W - numZonePad;
        const isImb = lv.highBuy || lv.highSell;
        const boxPad = 1;
        const boxH   = fontSize + 2;

        ctx.fillStyle = lv.highSell ? C.sell : C.sellMid;
        ctx.textAlign = "left";
        ctx.fillText(sellTxt, sellX, ly);

        ctx.fillStyle = lv.highBuy ? C.buy : C.buyMid;
        ctx.textAlign = "right";
        ctx.fillText(buyTxt, buyX, ly);

        if (isImb) {
          const boxL = sellX - boxPad;
          const boxR = buyX + boxPad;
          const boxY = ly - boxH / 2;
          ctx.strokeStyle = lv.highBuy ? C.buy : C.sell;
          ctx.lineWidth = 1;
          ctx.strokeRect(boxL, boxY, boxR - boxL, boxH);
        }
      }
      ctx.restore();
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

    /* price scale + time (pass hoverPrice so Y-axis shows price at crosshair level) */
    _drawPS(H, ts, hoverPrice);
    _drawTime();
    _drawBot();
  }, [dpr, getCanvasH, getVisRange, getVisPMin, p2y, getMaxPan, hoverBar, hoverPrice]);

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
    const slotW = cw + NUM_ZONE_W + GAP;
    const W = (containerRef.current?.clientWidth || 800) - PS_W - LABEL_W;
    const minGap = 60;
    const step = Math.max(1, Math.ceil(minGap / slotW));
    for (let k = 0; k < bs.length; k += step) {
      const i    = Math.min(k, bs.length - 1);
      const left = i * slotW + cw / 2 - pan;
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

    const ROW_H = Math.floor(H / 3);
    /* row dividers */
    ctx.strokeStyle = C.border; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, ROW_H);     ctx.lineTo(W, ROW_H);     ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, ROW_H * 2); ctx.lineTo(W, ROW_H * 2); ctx.stroke();

    const rowYs = [ROW_H * 0.5, ROW_H * 1.5, ROW_H * 2.5];
    ctx.font = `600 9.5px ${MONO}`;
    ctx.textBaseline = "middle";

    const slotW = cw + NUM_ZONE_W + GAP;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      const x = i * slotW - pan;
      if (x + cw < 0 || x > W) continue;

      /* current candle tint */
      if (i === bs.length - 1) {
        ctx.fillStyle = C.curBg;
        ctx.fillRect(x, 0, cw, H);
      }
      if (barsRef.current[i] === hoverBar) {
        ctx.fillStyle = "rgba(155,125,255,0.10)";
        ctx.fillRect(x, 0, cw, H);
      }

      const delta = b.delta ?? 0;
      const cvd   = b.cvd   ?? 0;
      const vol   = (b.buy_vol || 0) + (b.sell_vol || 0);
      const midX  = x + cw / 2;

      ctx.textAlign = "center";
      ctx.fillStyle = delta >= 0 ? C.buy : C.sell;
      ctx.fillText(fmtV(delta), midX, rowYs[0]);
      ctx.fillStyle = cvd >= 0 ? C.buy : C.sell;
      ctx.fillText(fmtV(cvd),   midX, rowYs[1]);
      ctx.fillStyle = C.textMid;
      ctx.fillText(fmtV(vol),   midX, rowYs[2]);
    }
  }, [dpr, hoverBar]);

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
    const slotBase = NUM_ZONE_W + GAP;
    const w = (wrapW + GAP - RIGHT_PAD) / bs.length - slotBase;
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
      const slotBase = NUM_ZONE_W + GAP;
      const w = (wrapW + GAP - RIGHT_PAD) / bars.length - slotBase;
      candleWRef.current = Math.round(Math.max(W_MIN, Math.min(W_MAX, w)));
    }
    scheduleDraw();
  }, [bars, scheduleDraw]);

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const updateHeight = () => {
      const tot = el.clientHeight || 0;
      const h = Math.max(100, tot - TIME_H_EFF - BOT_H_EFF);
      setChartAreaHeight((prev) => (prev !== h ? h : prev));
      scheduleDraw();
    };
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
      const slotW = candleWRef.current + NUM_ZONE_W + GAP;
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
        candleWRef.current + (e.deltaY > 0 ? -3 : 3)));
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
      candleWRef.current = Math.max(W_MIN, Math.min(W_MAX, dragStartCW + dx * 0.4));
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
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        padding: isMobile ? "0 8px" : "0 14px", height: HDR_H_EFF, minHeight: HDR_H_EFF,
        background: "#fff", borderBottom: `1.5px solid ${C.border}`,
        flexShrink: 0, boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.textDark, letterSpacing: ".04em" }}>{symbol}</span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.textDim }}>FP · {timeFrameMinutes}m</span>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.buy, display: "inline-block", animation: "fp-pulse 1.6s ease-in-out infinite" }} />

        {[["O", last.open], ["H", last.high], ["L", last.low], ["C", last.close]].map(([k, v]) => (
          <div key={k} style={{ display: "flex", gap: 3, alignItems: "baseline" }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: C.textDim }}>{k}</span>
            <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: C.textDark }}>{fmt2(v ?? 0)}</span>
          </div>
        ))}

        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, color: "#fff", background: chg >= 0 ? C.buy : C.sell }}>
          {chg >= 0 ? "+" : ""}{chg.toFixed(2)}%
        </span>

        {(hoverBar || hoverPrice != null) && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {hoverPrice != null && (
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: C.textDark }}>
                Price {fmtP(hoverPrice)}
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
              </>
            )}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* follow latest indicator */}
        {!followLatest.current && (
          <button
            onClick={() => { followLatest.current = true; scheduleDraw(); }}
            style={{ ...btnStyle, borderColor: C.buy, color: C.buy, fontSize: 9 }}
          >
            ▶ Latest
          </button>
        )}

        <button
          onClick={() => setShowLines(v => !v)}
          title="Toggle imbalance lines (L)"
          style={{ ...btnStyle, background: showLines ? "rgba(38,166,154,0.10)" : "none", borderColor: showLines ? C.buy : C.border, color: showLines ? C.buy : C.textMid }}
        >⟷ Lines</button>

        <button onClick={handleFit} style={btnStyle}>Fit [A]</button>
        <button onClick={toggleFS} style={{ ...btnStyle, fontSize: 13, padding: "2px 7px" }}>{isFS ? "⊠" : "⛶"}</button>
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
#!/usr/bin/env node
/**
 * NIFTY MAR FUT Indicator Discovery
 * Tests novel indicator ideas to find >70% accuracy (min 20 signals).
 * Usage: node scripts/discover-nifty-indicator.js
 */

const API_BASE = process.env.API_URL || "https://orderflow-backend-3gwk.onrender.com";
const FETCH_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 60000;
const MIN_SIGNALS = 20;
const TARGET_ACC = 70;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchState(symbol) {
  const url = `${API_BASE.replace(/\/$/, "")}/api/state/${encodeURIComponent(symbol)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 404 || !res.ok) return null;
    const data = await res.json();
    if (!data?.candles?.length) return null;
    return data.candles.filter((c) => c.closed !== false);
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function aggregateCandles(candles, tfMin) {
  if (!candles?.length) return [];
  const secPerBucket = Math.max(1, tfMin) * 60;
  const buckets = {};
  for (const c of candles) {
    const tSec = Math.floor((c.open_time || c.chartTime * 1000 || 0) / 1000);
    const bucket = Math.floor(tSec / secPerBucket) * secPerBucket;
    const buyVol = c.buy_vol ?? 0;
    const sellVol = c.sell_vol ?? 0;
    const delta = c.delta ?? (buyVol - sellVol);
    const oiChg = c.oi_change ?? 0;
    if (!buckets[bucket]) {
      buckets[bucket] = {
        open_time: bucket * 1000,
        open: c.open ?? c.close ?? 0,
        high: c.high ?? Math.max(c.open ?? 0, c.close ?? 0),
        low: c.low ?? Math.min(c.open ?? 1e9, c.close ?? 1e9),
        close: c.close ?? c.open ?? 0,
        buy_vol: buyVol,
        sell_vol: sellVol,
        delta,
        oi_change: oiChg,
      };
    } else {
      const b = buckets[bucket];
      b.high = Math.max(b.high ?? 0, c.high ?? 0);
      b.low = Math.min(b.low ?? 1e9, c.low ?? 1e9);
      b.close = c.close ?? b.close;
      b.buy_vol = (b.buy_vol ?? 0) + buyVol;
      b.sell_vol = (b.sell_vol ?? 0) + sellVol;
      b.delta = (b.delta ?? 0) + delta;
      b.oi_change = (b.oi_change ?? 0) + oiChg;
    }
  }
  return Object.values(buckets).sort((a, b) => a.open_time - b.open_time);
}

function nextBarDirection(candles, i) {
  if (i + 1 >= candles.length) return null;
  const next = candles[i + 1];
  const open = next.open ?? next.close ?? 0;
  const close = next.close ?? next.open ?? 0;
  const chg = close - open;
  if (chg > 0) return 1;
  if (chg < 0) return -1;
  return 0;
}

function getDelta(c) {
  return c.delta ?? (c.buy_vol ?? 0) - (c.sell_vol ?? 0);
}

function getClose(c) {
  return c.close ?? c.open ?? 0;
}

function getOpen(c) {
  return c.open ?? c.close ?? 0;
}

// ─── Novel indicator ideas ───

/** 1. Consecutive same-direction bars reversal: after N bars same dir, predict opposite */
function evalConsecutiveReversal(candles, n = 4) {
  let signals = 0, correct = 0;
  for (let i = n; i < candles.length - 1; i++) {
    let sameDir = true;
    const firstDir = getClose(candles[i - n]) > getOpen(candles[i - n]) ? 1 : -1;
    for (let j = i - n + 1; j <= i; j++) {
      const d = getClose(candles[j]) > getOpen(candles[j]) ? 1 : getClose(candles[j]) < getOpen(candles[j]) ? -1 : 0;
      if (d !== firstDir || d === 0) { sameDir = false; break; }
    }
    if (!sameDir) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = -firstDir;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 2. Delta flip: delta crosses zero (sign change) - predict continuation of new sign */
function evalDeltaFlip(candles) {
  let signals = 0, correct = 0;
  for (let i = 1; i < candles.length - 1; i++) {
    const d0 = getDelta(candles[i - 1]);
    const d1 = getDelta(candles[i]);
    if (d0 * d1 >= 0) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = d1 > 0 ? 1 : -1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 3. Delta extreme + price reversal: delta at z>2, price just reversed */
function evalDeltaExtremeReversal(candles, lookback = 15, zTh = 2) {
  let signals = 0, correct = 0;
  const eps = 1e-8;
  for (let i = lookback; i < candles.length - 1; i++) {
    const deltas = [];
    for (let j = i - lookback; j <= i; j++) deltas.push(getDelta(candles[j]));
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const std = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / deltas.length));
    const z = (deltas[lookback] - mean) / std;
    if (Math.abs(z) < zTh) continue;
    const prevClose = getClose(candles[i - 1]);
    const currClose = getClose(candles[i]);
    const prevOpen = getOpen(candles[i - 1]);
    const currOpen = getOpen(candles[i]);
    const prevDir = prevClose > prevOpen ? 1 : prevClose < prevOpen ? -1 : 0;
    const currDir = currClose > currOpen ? 1 : currClose < currOpen ? -1 : 0;
    if (prevDir === 0 || currDir === 0 || prevDir === currDir) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = currDir;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 4. Delta + OI alignment: both same sign, strong - predict continuation */
function evalDeltaOIAlign(candles, deltaTh = 5000, oiTh = 50) {
  let signals = 0, correct = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    const c = candles[i];
    const delta = getDelta(c);
    const oiChg = c.oi_change ?? 0;
    if (Math.abs(delta) < deltaTh || Math.abs(oiChg) < oiTh) continue;
    if (delta * oiChg <= 0) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = delta > 0 ? 1 : -1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 5. Volume spike + delta: vol > 2*rolling mean, delta strong */
function evalVolumeSpikeDelta(candles, lookback = 20, volMult = 2, deltaZTh = 1) {
  let signals = 0, correct = 0;
  const eps = 1e-8;
  for (let i = lookback; i < candles.length - 1; i++) {
    const vols = [];
    const deltas = [];
    for (let j = i - lookback; j <= i; j++) {
      const c = candles[j];
      vols.push((c.buy_vol ?? 0) + (c.sell_vol ?? 0));
      deltas.push(getDelta(c));
    }
    const avgVol = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1) || eps;
    const currVol = vols[vols.length - 1];
    if (currVol < volMult * avgVol) continue;
    const dMean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const dStd = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - dMean) ** 2, 0) / deltas.length));
    const dZ = (deltas[deltas.length - 1] - dMean) / dStd;
    if (Math.abs(dZ) < deltaZTh) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = dZ > 0 ? 1 : -1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 6. Price at N-bar high/low: close at high of last N bars - predict pullback */
function evalPriceAtExtreme(candles, n = 10, predictReversal = true) {
  let signals = 0, correct = 0;
  for (let i = n; i < candles.length - 1; i++) {
    const closes = [];
    for (let j = i - n; j <= i; j++) closes.push(getClose(candles[j]));
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    const curr = getClose(candles[i]);
    const atHigh = curr >= high * 0.999;
    const atLow = curr <= low * 1.001;
    if (!atHigh && !atLow) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = atHigh ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 7. Delta divergence: price up 3 bars, delta down 3 bars - predict price follows delta */
function evalDeltaPriceDivergence(candles, n = 3) {
  let signals = 0, correct = 0;
  for (let i = n; i < candles.length - 1; i++) {
    let priceUp = 0, priceDown = 0, deltaUp = 0, deltaDown = 0;
    for (let j = i - n; j < i; j++) {
      const pChg = getClose(candles[j + 1]) - getClose(candles[j]);
      const dChg = getDelta(candles[j + 1]) - getDelta(candles[j]);
      if (pChg > 0) priceUp++; else if (pChg < 0) priceDown++;
      if (dChg > 0) deltaUp++; else if (dChg < 0) deltaDown++;
    }
    const priceUpTrend = priceUp > priceDown;
    const deltaDownTrend = deltaDown > deltaUp;
    if (!(priceUpTrend && deltaDownTrend) && !(!priceUpTrend && !deltaDownTrend && deltaUp > deltaDown)) continue;
    const bearishDiv = priceUpTrend && deltaDownTrend;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = bearishDiv ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 8. Strict delta exhaustion: z>2.5, reverting */
function evalDeltaExhaustionStrict(candles, lookback = 20, zTh = 2.5) {
  let signals = 0, correct = 0;
  const eps = 1e-8;
  for (let i = lookback; i < candles.length - 1; i++) {
    const deltas = [];
    for (let j = i - lookback; j <= i; j++) deltas.push(getDelta(candles[j]));
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const std = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / deltas.length));
    const deltaZ = (deltas[lookback] - mean) / std;
    const prevDelta = deltas[lookback - 1];
    const currDelta = deltas[lookback];
    const reverting = Math.abs(deltaZ) > zTh && (currDelta - prevDelta) * deltaZ < 0;
    if (!reverting) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = currDelta > 0 ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 9. Delta acceleration extreme: strong DA, predict continuation */
function evalDAExtreme(candles, th = 0.6) {
  let signals = 0, correct = 0;
  const eps = 1e-8;
  for (let i = 1; i < candles.length - 1; i++) {
    const delta = getDelta(candles[i]);
    const prevDelta = getDelta(candles[i - 1]);
    const daRaw = Math.abs(prevDelta) + eps > 0 ? (delta - prevDelta) / (Math.abs(prevDelta) + eps) : 0;
    const da = Math.tanh(daRaw * 0.5);
    if (Math.abs(da) < th) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = da > 0 ? 1 : -1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 10. LTP + Delta both strong same direction */
function evalLTPDeltaAlign(candles, ltpTh = 0.4, deltaZTh = 1.2) {
  let signals = 0, correct = 0;
  const eps = 1e-8;
  const W = 5;
  for (let i = W; i < candles.length - 1; i++) {
    const c = candles[i];
    const buyVol = c.buy_vol ?? 0;
    const sellVol = c.sell_vol ?? 0;
    const totalVol = buyVol + sellVol;
    const delta = getDelta(c);
    const open = getOpen(c);
    const close = getClose(c);
    const priceChange = Math.abs(close - open) + eps;
    const dp = (buyVol - sellVol) / (totalVol + eps);
    const asRaw = Math.abs(delta) / priceChange;
    const asSign = delta >= 0 ? -1 : 1;
    let ddNorm = 0;
    const pChg = [], dChg = [];
    for (let j = i - W + 1; j < i; j++) {
      const p0 = getClose(candles[j]);
      const p1 = getClose(candles[j + 1]);
      const d0 = getDelta(candles[j]);
      const d1 = getDelta(candles[j + 1]);
      pChg.push(p1 - p0);
      dChg.push(d1 - d0);
    }
    const n = pChg.length;
    const mx = pChg.reduce((a, b) => a + b, 0) / n;
    const my = dChg.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let k = 0; k < n; k++) {
      const dx = pChg[k] - mx, dy = dChg[k] - my;
      num += dx * dy;
      dx2 += dx * dx;
      dy2 += dy * dy;
    }
    const den = Math.sqrt(dx2 * dy2);
    const corr = den > 0 ? num / den : 0;
    ddNorm = Math.max(-1, Math.min(1, -corr));
    const asNorm = asSign * Math.min(1, asRaw / 1);
    const ltp = 0.28 * dp + 0.32 * asNorm + 0.25 * ddNorm;
    if (Math.abs(ltp) < ltpTh) continue;
    const deltas = candles.slice(Math.max(0, i - 20), i + 1).map((x) => getDelta(x));
    const dMean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const dStd = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - dMean) ** 2, 0) / deltas.length));
    const dZ = (delta - dMean) / dStd;
    if (Math.abs(dZ) < deltaZTh) continue;
    if (ltp * dZ < 0) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = ltp > 0 ? 1 : -1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 11. Consensus 4+ with very strict trend */
function trendStrength(candles, i, lookback = 5) {
  if (i < lookback) return 0;
  const closes = [];
  for (let j = i - lookback; j <= i; j++) closes.push(getClose(candles[j]));
  const chg = closes[lookback] - closes[0];
  let atr = 0;
  for (let j = i - lookback + 1; j <= i; j++) {
    const h = candles[j].high ?? Math.max(getOpen(candles[j]), getClose(candles[j]));
    const l = candles[j].low ?? Math.min(getOpen(candles[j]), getClose(candles[j]));
    atr += h - l;
  }
  atr = atr / lookback || 1e-8;
  return chg / atr;
}

function computeLTP(candles) {
  if (!candles?.length) return [];
  const eps = 1e-6;
  const W = 5;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const buyVol = c.buy_vol ?? 0;
    const sellVol = c.sell_vol ?? 0;
    const totalVol = buyVol + sellVol;
    const delta = getDelta(c);
    const open = getOpen(c);
    const close = getClose(c);
    const priceChange = Math.abs(close - open) + eps;
    const dp = (buyVol - sellVol) / (totalVol + eps);
    const asRaw = Math.abs(delta) / priceChange;
    const asSign = delta >= 0 ? -1 : 1;
    let ddNorm = 0;
    if (i >= W - 1) {
      const pChg = [], dChg = [];
      for (let j = i - W + 1; j < i; j++) {
        pChg.push(getClose(candles[j + 1]) - getClose(candles[j]));
        dChg.push(getDelta(candles[j + 1]) - getDelta(candles[j]));
      }
      const n = pChg.length;
      const mx = pChg.reduce((a, b) => a + b, 0) / n;
      const my = dChg.reduce((a, b) => a + b, 0) / n;
      let num = 0, dx2 = 0, dy2 = 0;
      for (let k = 0; k < n; k++) {
        const dx = pChg[k] - mx, dy = dChg[k] - my;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
      }
      const den = Math.sqrt(dx2 * dy2);
      ddNorm = Math.max(-1, Math.min(1, -(den > 0 ? num / den : 0)));
    }
    const asNorm = asSign * Math.min(1, asRaw);
    out.push({ ltp: 0.28 * dp + 0.32 * asNorm + 0.25 * ddNorm });
  }
  return out;
}

function computeMII(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const deltas = candles.map(getDelta);
  const ema2 = (s, p) => {
    const a = 2 / (p + 1);
    const out = [];
    let ema = s[0];
    for (let i = 0; i < s.length; i++) {
      ema = a * s[i] + (1 - a) * (i > 0 ? ema : s[i]);
      out.push(ema);
    }
    return out;
  };
  const e2 = ema2(deltas, 2);
  const e5 = ema2(deltas, 5);
  const vols = candles.map((c) => (c.buy_vol ?? 0) + (c.sell_vol ?? 0));
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const vol = vols[i];
    const delta = deltas[i];
    const c = candles[i];
    const open = getOpen(c);
    const close = getClose(c);
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const range = Math.max(eps, high - low);
    const start = Math.max(0, i - 19);
    const slice = vols.slice(start, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    const std = Math.max(eps, Math.sqrt(slice.reduce((s, v) => s + (v - avg) ** 2, 0) / slice.length));
    const ve = (vol - avg) / std;
    const da = e2[i] - e5[i];
    const daStd = Math.max(1, Math.sqrt(deltas.reduce((s, d) => s + d * d, 0) / deltas.length));
    const daNorm = Math.tanh(da / daStd);
    const pe = Math.abs(close - open) / range;
    const peNorm = (2 * pe - 1) * (close >= open ? 1 : -1);
    const veNorm = Math.tanh(ve / 2) * (delta >= 0 ? 1 : -1);
    out.push({ mii: 0.45 * daNorm + 0.3 * veNorm + 0.25 * peNorm });
  }
  return out;
}

function computeDA(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const delta = getDelta(candles[i]);
    const prevDelta = i > 0 ? getDelta(candles[i - 1]) : delta;
    const daRaw = Math.abs(prevDelta) + eps > 0 ? (delta - prevDelta) / (Math.abs(prevDelta) + eps) : 0;
    out.push({ da: Math.tanh(daRaw * 0.5) });
  }
  return out;
}

function computeOID(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const delta = getDelta(c);
    const oiChg = c.oi_change ?? 0;
    const signOi = oiChg > eps ? 1 : oiChg < -eps ? -1 : 0;
    const signDelta = delta > eps ? 1 : delta < -eps ? -1 : 0;
    const signProduct = signOi * signDelta;
    const mag = Math.min(1, (Math.abs(oiChg) / 100 + Math.abs(delta) / 10000) * 0.5);
    const oidRaw = signProduct * (mag > 0 ? mag : 0.5);
    out.push({ oid: Math.max(-1, Math.min(1, oidRaw)) });
  }
  return out;
}

function computeCAE(candles) {
  if (!candles?.length) return [];
  const PREV3_UP = 8, PREV3_DOWN = -8, PREV2_UP = 8, PREV2_FLAT = -1;
  const VZP_REV_TOP = 0.25, VZP_RALLY_END = 0.22, VZP_RALLY_START = 0.25, VZP_REV_BOTTOM = 0.22;
  const out = [];
  const bearishEvents = new Set(["REVERSAL_TOP", "RALLY_END"]);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = getOpen(c);
    const close = getClose(c);
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const mid = (high + low) / 2;
    const delta = getDelta(c);
    let bidVol = 0, askVol = 0;
    const lvs = Object.values(c.levels || {});
    if (lvs.length > 0) {
      for (const lv of lvs) {
        const p = lv.price ?? 0;
        const vol = (lv.buy_vol ?? 0) + (lv.sell_vol ?? 0) || (lv.total_vol ?? 0);
        if (vol > 0 && isFinite(p)) {
          if (p < mid) bidVol += vol;
          else if (p > mid) askVol += vol;
        }
      }
    }
    const totalVol = bidVol + askVol;
    const vzpRaw = totalVol > 1e-8 ? (askVol - bidVol) / totalVol : (delta !== 0 ? -Math.sign(delta) : 0);
    let prev3Chg = 0, prev2Chg = 0;
    if (i >= 3) {
      for (let j = i - 3; j < i; j++)
        prev3Chg += getClose(candles[j]) - getOpen(candles[j]);
    }
    if (i >= 2) {
      for (let j = i - 2; j < i; j++)
        prev2Chg += getClose(candles[j]) - getOpen(candles[j]);
    }
    let event = null;
    if (prev3Chg > PREV3_UP && vzpRaw > VZP_REV_TOP) event = "REVERSAL_TOP";
    else if (prev2Chg > PREV2_UP && vzpRaw > VZP_RALLY_END) event = "RALLY_END";
    else if (prev2Chg < PREV2_FLAT && vzpRaw < -VZP_RALLY_START) event = "RALLY_START";
    else if (prev3Chg < PREV3_DOWN && vzpRaw < -VZP_REV_BOTTOM) event = "REVERSAL_BOTTOM";
    out.push({ event });
  }
  return out;
}

function computeVPT(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const raw = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = getOpen(c);
    const close = getClose(c);
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const range = Math.max(eps, high - low);
    const mid = (high + low) / 2;
    let vpc = mid;
    const lvs = Object.values(c.levels || {});
    if (lvs.length > 0) {
      let sumPv = 0, totalVol = 0;
      for (const lv of lvs) {
        const p = lv.price ?? 0;
        const vol = (lv.buy_vol ?? 0) + (lv.sell_vol ?? 0) || (lv.total_vol ?? 0);
        if (vol > 0 && isFinite(p)) { sumPv += p * vol; totalVol += vol; }
      }
      if (totalVol > 0) vpc = sumPv / totalVol;
    }
    raw.push({ vptRaw: range > 0 ? (vpc - mid) / range : 0 });
  }
  const vptMax = Math.max(0.01, ...raw.map((r) => Math.abs(r.vptRaw)));
  return raw.map((r) => ({ vpt: Math.max(-1, Math.min(1, r.vptRaw / vptMax)) }));
}

function computeVZP(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = getOpen(c);
    const close = getClose(c);
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const mid = (high + low) / 2;
    const delta = getDelta(c);
    let bidVol = 0, askVol = 0;
    const lvs = Object.values(c.levels || {});
    if (lvs.length > 0) {
      for (const lv of lvs) {
        const p = lv.price ?? 0;
        const vol = (lv.buy_vol ?? 0) + (lv.sell_vol ?? 0) || (lv.total_vol ?? 0);
        if (vol > 0 && isFinite(p)) {
          if (p < mid) bidVol += vol;
          else if (p > mid) askVol += vol;
        }
      }
    }
    const totalVol = bidVol + askVol;
    out.push({ vzpRaw: totalVol > eps ? (askVol - bidVol) / totalVol : (delta !== 0 ? -Math.sign(delta) : 0) });
  }
  return out;
}

const LTP_TH = 0.3;
const MII_TH = 0.4;
const VPT_TH = 0.4;
const VZP_TH = 0.2;
const DA_TH = 0.2;
const OID_TH = 0.35;
const OID_CONTRARIAN = true;

function evalStrictConsensus(ltp, mii, vpt, vzp, da, oid, cae, candles, minAgree) {
  let signals = 0, correct = 0;
  const bearishEvents = new Set(["REVERSAL_TOP", "RALLY_END"]);
  for (let i = 0; i < candles.length - 1; i++) {
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    const votes = [];
    if (ltp[i]?.ltp != null && Math.abs(ltp[i].ltp) > LTP_TH) votes.push(ltp[i].ltp > 0 ? 1 : -1);
    if (mii[i]?.mii != null && Math.abs(mii[i].mii) > MII_TH) votes.push(mii[i].mii > 0 ? 1 : -1);
    if (vpt[i]?.vpt != null && Math.abs(vpt[i].vpt) > VPT_TH) votes.push(vpt[i].vpt > 0 ? 1 : -1);
    if (vzp[i]?.vzpRaw != null && Math.abs(vzp[i].vzpRaw) > VZP_TH) votes.push(vzp[i].vzpRaw > 0 ? -1 : 1);
    if (da[i]?.da != null && Math.abs(da[i].da) > DA_TH) votes.push(da[i].da > 0 ? 1 : -1);
    if (oid[i]?.oid != null && Math.abs(oid[i].oid) > OID_TH) votes.push(OID_CONTRARIAN ? (oid[i].oid > 0 ? -1 : 1) : (oid[i].oid > 0 ? 1 : -1));
    if (cae[i]?.event) votes.push(bearishEvents.has(cae[i].event) ? -1 : 1);
    if (votes.length < minAgree) continue;
    const up = votes.filter((v) => v === 1).length;
    const down = votes.filter((v) => v === -1).length;
    const agreed = up >= minAgree ? 1 : down >= minAgree ? -1 : 0;
    if (agreed === 0) continue;
    signals++;
    if (dir === agreed) correct++;
  }
  return { signals, correct };
}

function evalWithTrendFilter(ltp, mii, vpt, vzp, da, oid, cae, candles, minAgree, trendTh) {
  let signals = 0, correct = 0;
  const bearishEvents = new Set(["REVERSAL_TOP", "RALLY_END"]);
  for (let i = 0; i < candles.length - 1; i++) {
    if (Math.abs(trendStrength(candles, i)) < trendTh) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    const votes = [];
    if (ltp[i]?.ltp != null && Math.abs(ltp[i].ltp) > LTP_TH) votes.push(ltp[i].ltp > 0 ? 1 : -1);
    if (mii[i]?.mii != null && Math.abs(mii[i].mii) > MII_TH) votes.push(mii[i].mii > 0 ? 1 : -1);
    if (vpt[i]?.vpt != null && Math.abs(vpt[i].vpt) > VPT_TH) votes.push(vpt[i].vpt > 0 ? 1 : -1);
    if (vzp[i]?.vzpRaw != null && Math.abs(vzp[i].vzpRaw) > VZP_TH) votes.push(vzp[i].vzpRaw > 0 ? -1 : 1);
    if (da[i]?.da != null && Math.abs(da[i].da) > DA_TH) votes.push(da[i].da > 0 ? 1 : -1);
    if (oid[i]?.oid != null && Math.abs(oid[i].oid) > OID_TH) votes.push(OID_CONTRARIAN ? (oid[i].oid > 0 ? -1 : 1) : (oid[i].oid > 0 ? 1 : -1));
    if (cae[i]?.event) votes.push(bearishEvents.has(cae[i].event) ? -1 : 1);
    if (votes.length < minAgree) continue;
    const up = votes.filter((v) => v === 1).length;
    const down = votes.filter((v) => v === -1).length;
    const agreed = up >= minAgree ? 1 : down >= minAgree ? -1 : 0;
    if (agreed === 0) continue;
    signals++;
    if (dir === agreed) correct++;
  }
  return { signals, correct };
}

/** 12. Consensus 5+ with strict trend > 1.0 */
function evalConsensus5StrictTrend(candles) {
  const ltp = computeLTP(candles);
  const mii = computeMII(candles);
  const vpt = computeVPT(candles);
  const vzp = computeVZP(candles);
  const da = computeDA(candles);
  const oid = computeOID(candles);
  const cae = computeCAE(candles);
  return evalWithTrendFilter(ltp, mii, vpt, vzp, da, oid, cae, candles, 5, 1.0);
}

/** 13. Consecutive bars + delta confirmation */
function evalConsecutiveDeltaConfirm(candles, n = 3) {
  let signals = 0, correct = 0;
  for (let i = n; i < candles.length - 1; i++) {
    let sameDir = true;
    const firstDir = getClose(candles[i - n]) > getOpen(candles[i - n]) ? 1 : -1;
    for (let j = i - n + 1; j <= i; j++) {
      const d = getClose(candles[j]) > getOpen(candles[j]) ? 1 : getClose(candles[j]) < getOpen(candles[j]) ? -1 : 0;
      if (d !== firstDir || d === 0) { sameDir = false; break; }
    }
    if (!sameDir) continue;
    const delta = getDelta(candles[i]);
    if (delta * firstDir <= 0) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    if (dir === firstDir) correct++;
  }
  return { signals, correct };
}

/** 14. OI + Delta contrarian: OI up + Delta up = bearish (short covering) */
function evalOIDeltaContrarian(candles, oiTh = 30, deltaTh = 3000) {
  let signals = 0, correct = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    const c = candles[i];
    const delta = getDelta(c);
    const oiChg = c.oi_change ?? 0;
    if (Math.abs(oiChg) < oiTh || Math.abs(delta) < deltaTh) continue;
    if (oiChg * delta <= 0) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = delta > 0 ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 15. Cumulative delta reversal */
function evalCumDeltaReversal(candles, lookback = 10, pctTh = 0.7) {
  let signals = 0, correct = 0;
  for (let i = lookback; i < candles.length - 1; i++) {
    const cumDeltas = [];
    let cum = 0;
    for (let j = i - lookback; j <= i; j++) {
      cum += getDelta(candles[j]);
      cumDeltas.push(cum);
    }
    const maxCum = Math.max(...cumDeltas);
    const minCum = Math.min(...cumDeltas);
    const range = maxCum - minCum;
    if (range < 1) continue;
    const currCum = cumDeltas[cumDeltas.length - 1];
    const atTop = currCum >= maxCum - range * (1 - pctTh);
    const atBottom = currCum <= minCum + range * (1 - pctTh);
    if (!atTop && !atBottom) continue;
    const prevCum = cumDeltas[cumDeltas.length - 2];
    const reverting = (atTop && currCum < prevCum) || (atBottom && currCum > prevCum);
    if (!reverting) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = atTop ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 16. Triple confirmation: LTP + MII + DA all agree */
function evalTripleConfirm(candles, th = 0.35) {
  const ltp = computeLTP(candles);
  const mii = computeMII(candles);
  const da = computeDA(candles);
  let signals = 0, correct = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    const l = ltp[i]?.ltp ?? 0;
    const m = mii[i]?.mii ?? 0;
    const d = da[i]?.da ?? 0;
    if (Math.abs(l) < th || Math.abs(m) < th || Math.abs(d) < th) continue;
    if (l * m <= 0 || m * d <= 0 || l * d <= 0) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = l > 0 ? 1 : -1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 17. Parameter sweep: DA extreme with various thresholds */
function evalDAExtremeSweep(candles, th) {
  return evalDAExtreme(candles, th);
}

/** 18. Delta flip + volume filter */
function evalDeltaFlipVolume(candles, volMult = 1.5) {
  let signals = 0, correct = 0;
  const lookback = 20;
  for (let i = 1; i < candles.length - 1; i++) {
    const d0 = getDelta(candles[i - 1]);
    const d1 = getDelta(candles[i]);
    if (d0 * d1 >= 0) continue;
    if (i < lookback) continue;
    const vols = [];
    for (let j = i - lookback; j < i; j++) {
      vols.push((candles[j].buy_vol ?? 0) + (candles[j].sell_vol ?? 0));
    }
    const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length || 1;
    const currVol = (candles[i].buy_vol ?? 0) + (candles[i].sell_vol ?? 0);
    if (currVol < volMult * avgVol) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = d1 > 0 ? 1 : -1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 19. Price momentum exhaustion: 5-bar ROC extreme */
function evalMomentumExhaustion(candles, n = 5, rocTh = 0.003) {
  let signals = 0, correct = 0;
  for (let i = n; i < candles.length - 1; i++) {
    const roc = (getClose(candles[i]) - getClose(candles[i - n])) / (getClose(candles[i - n]) || 1e-8);
    if (Math.abs(roc) < rocTh) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = roc > 0 ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 20. Strict LTP only (high threshold) */
function evalLTPStrict(candles, th = 0.5) {
  const ltp = computeLTP(candles);
  let signals = 0, correct = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    const l = ltp[i]?.ltp ?? 0;
    if (Math.abs(l) < th) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = l > 0 ? 1 : -1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 21. OI Delta Contrarian with param sweep */
function evalOIDeltaContrarianSweep(candles, oiTh, deltaTh) {
  return evalOIDeltaContrarian(candles, oiTh, deltaTh);
}

/** 22. Price at extreme + OI contrarian filter */
function evalPriceExtremeOIContrarian(candles, n = 10, oiTh = 40) {
  let signals = 0, correct = 0;
  for (let i = n; i < candles.length - 1; i++) {
    const closes = [];
    for (let j = i - n; j <= i; j++) closes.push(getClose(candles[j]));
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    const curr = getClose(candles[i]);
    const atHigh = curr >= high * 0.999;
    const atLow = curr <= low * 1.001;
    if (!atHigh && !atLow) continue;
    const c = candles[i];
    const delta = getDelta(c);
    const oiChg = c.oi_change ?? 0;
    if (Math.abs(oiChg) < oiTh) continue;
    if (delta * oiChg <= 0) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = delta > 0 ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 23. Consecutive reversal + OI filter */
function evalConsecutiveOIFilter(candles, n = 3, oiTh = 20) {
  let signals = 0, correct = 0;
  for (let i = n; i < candles.length - 1; i++) {
    let sameDir = true;
    const firstDir = getClose(candles[i - n]) > getOpen(candles[i - n]) ? 1 : -1;
    for (let j = i - n + 1; j <= i; j++) {
      const d = getClose(candles[j]) > getOpen(candles[j]) ? 1 : getClose(candles[j]) < getOpen(candles[j]) ? -1 : 0;
      if (d !== firstDir || d === 0) { sameDir = false; break; }
    }
    if (!sameDir) continue;
    const oiChg = Math.abs(candles[i].oi_change ?? 0);
    if (oiChg < oiTh) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = -firstDir;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 24. Delta-OI divergence: OI rising, delta falling = bearish */
function evalDeltaOIDivergence(candles, n = 3) {
  let signals = 0, correct = 0;
  for (let i = n; i < candles.length - 1; i++) {
    let oiUp = 0, oiDown = 0, deltaUp = 0, deltaDown = 0;
    for (let j = i - n; j < i; j++) {
      const oiChg = (candles[j + 1].oi_change ?? 0) - (candles[j].oi_change ?? 0);
      const dChg = getDelta(candles[j + 1]) - getDelta(candles[j]);
      if (oiChg > 0) oiUp++; else if (oiChg < 0) oiDown++;
      if (dChg > 0) deltaUp++; else if (dChg < 0) deltaDown++;
    }
    const oiRising = oiUp > oiDown;
    const deltaFalling = deltaDown > deltaUp;
    const bearish = oiRising && deltaFalling;
    const oiFalling = oiDown > oiUp;
    const deltaRising = deltaUp > deltaDown;
    const bullish = oiFalling && deltaRising;
    if (!bearish && !bullish) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = bearish ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 25. Bar range expansion: range > 1.5x avg, predict reversal */
function evalRangeExpansionReversal(candles, lookback = 10, mult = 1.5) {
  let signals = 0, correct = 0;
  for (let i = lookback; i < candles.length - 1; i++) {
    const ranges = [];
    for (let j = i - lookback; j < i; j++) {
      const h = candles[j].high ?? Math.max(getOpen(candles[j]), getClose(candles[j]));
      const l = candles[j].low ?? Math.min(getOpen(candles[j]), getClose(candles[j]));
      ranges.push(h - l);
    }
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length || 1e-8;
    const currH = candles[i].high ?? Math.max(getOpen(candles[i]), getClose(candles[i]));
    const currL = candles[i].low ?? Math.min(getOpen(candles[i]), getClose(candles[i]));
    const currRange = currH - currL;
    if (currRange < mult * avgRange) continue;
    const barDir = getClose(candles[i]) > getOpen(candles[i]) ? 1 : -1;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = -barDir;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 26. Delta 2-bar flip: delta sign changed in last 2 bars */
function evalDelta2BarFlip(candles) {
  let signals = 0, correct = 0;
  for (let i = 2; i < candles.length - 1; i++) {
    const d0 = getDelta(candles[i - 2]);
    const d1 = getDelta(candles[i - 1]);
    const d2 = getDelta(candles[i]);
    if (d0 * d2 >= 0) continue;
    if ((d1 - d0) * (d2 - d1) >= 0) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = d2 > 0 ? 1 : -1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 27. Close position in bar: close in top/bottom 20% of range */
function evalClosePositionReversal(candles, pct = 0.2) {
  let signals = 0, correct = 0;
  for (let i = 0; i < candles.length - 1; i++) {
    const c = candles[i];
    const open = getOpen(c);
    const close = getClose(c);
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const range = high - low;
    if (range < 1e-8) continue;
    const pos = (close - low) / range;
    const atTop = pos >= 1 - pct;
    const atBottom = pos <= pct;
    if (!atTop && !atBottom) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = atTop ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 28. OI Delta Contrarian strict: higher thresholds */
function evalOIDeltaContrarianStrict(candles, oiTh, deltaTh) {
  return evalOIDeltaContrarian(candles, oiTh, deltaTh);
}

/** 29. Range expansion + delta same direction as bar (exhaustion) */
function evalRangeExpansionDeltaConfirm(candles, lookback = 10, mult = 1.8) {
  let signals = 0, correct = 0;
  for (let i = lookback; i < candles.length - 1; i++) {
    const ranges = [];
    for (let j = i - lookback; j < i; j++) {
      const h = candles[j].high ?? Math.max(getOpen(candles[j]), getClose(candles[j]));
      const l = candles[j].low ?? Math.min(getOpen(candles[j]), getClose(candles[j]));
      ranges.push(h - l);
    }
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length || 1e-8;
    const currH = candles[i].high ?? Math.max(getOpen(candles[i]), getClose(candles[i]));
    const currL = candles[i].low ?? Math.min(getOpen(candles[i]), getClose(candles[i]));
    const currRange = currH - currL;
    if (currRange < mult * avgRange) continue;
    const barDir = getClose(candles[i]) > getOpen(candles[i]) ? 1 : -1;
    const delta = getDelta(candles[i]);
    if (delta * barDir <= 0) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = -barDir;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 30. OI Contrarian + Range expansion filter */
function evalOIContrarianRangeFilter(candles, oiTh = 30, deltaTh = 3000, rangeMult = 1.3) {
  let signals = 0, correct = 0;
  const lookback = 10;
  for (let i = lookback; i < candles.length - 1; i++) {
    const c = candles[i];
    const delta = getDelta(c);
    const oiChg = c.oi_change ?? 0;
    if (Math.abs(oiChg) < oiTh || Math.abs(delta) < deltaTh) continue;
    if (oiChg * delta <= 0) continue;
    const ranges = [];
    for (let j = i - lookback; j < i; j++) {
      const h = candles[j].high ?? Math.max(getOpen(candles[j]), getClose(candles[j]));
      const l = candles[j].low ?? Math.min(getOpen(candles[j]), getClose(candles[j]));
      ranges.push(h - l);
    }
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length || 1e-8;
    const currH = c.high ?? Math.max(getOpen(c), getClose(c));
    const currL = c.low ?? Math.min(getOpen(c), getClose(c));
    if ((currH - currL) < rangeMult * avgRange) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = delta > 0 ? -1 : 1;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

/** 31. Consecutive 3 reversal + range expansion */
function evalConsecutiveRangeFilter(candles, n = 3, rangeMult = 1.5) {
  let signals = 0, correct = 0;
  const lookback = 10;
  for (let i = Math.max(n, lookback); i < candles.length - 1; i++) {
    let sameDir = true;
    const firstDir = getClose(candles[i - n]) > getOpen(candles[i - n]) ? 1 : -1;
    for (let j = i - n + 1; j <= i; j++) {
      const d = getClose(candles[j]) > getOpen(candles[j]) ? 1 : getClose(candles[j]) < getOpen(candles[j]) ? -1 : 0;
      if (d !== firstDir || d === 0) { sameDir = false; break; }
    }
    if (!sameDir) continue;
    const ranges = [];
    for (let j = i - lookback; j < i; j++) {
      const h = candles[j].high ?? Math.max(getOpen(candles[j]), getClose(candles[j]));
      const l = candles[j].low ?? Math.min(getOpen(candles[j]), getClose(candles[j]));
      ranges.push(h - l);
    }
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length || 1e-8;
    const currH = candles[i].high ?? Math.max(getOpen(candles[i]), getClose(candles[i]));
    const currL = candles[i].low ?? Math.min(getOpen(candles[i]), getClose(candles[i]));
    if ((currH - currL) < rangeMult * avgRange) continue;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    signals++;
    const expected = -firstDir;
    if (dir === expected) correct++;
  }
  return { signals, correct };
}

async function main() {
  console.error("Fetching NIFTY MAR FUT data...");
  const candles = await fetchState("NIFTY MAR FUT");
  await sleep(FETCH_DELAY_MS);
  if (!candles?.length || candles.length < 50) {
    console.error("Insufficient data.");
    process.exit(1);
  }
  console.error(`Loaded ${candles.length} 1m candles.\n`);

  const strategies = [
    ["Consecutive 3 Reversal", (c) => evalConsecutiveReversal(c, 3)],
    ["Consecutive 4 Reversal", (c) => evalConsecutiveReversal(c, 4)],
    ["Consecutive 5 Reversal", (c) => evalConsecutiveReversal(c, 5)],
    ["Delta Flip", (c) => evalDeltaFlip(c)],
    ["Delta Flip + Vol 1.5x", (c) => evalDeltaFlipVolume(c, 1.5)],
    ["Delta Flip + Vol 2x", (c) => evalDeltaFlipVolume(c, 2)],
    ["Delta Extreme Reversal z2", (c) => evalDeltaExtremeReversal(c, 15, 2)],
    ["Delta Extreme Reversal z2.5", (c) => evalDeltaExtremeReversal(c, 15, 2.5)],
    ["Delta Exhaustion z2.5", (c) => evalDeltaExhaustionStrict(c, 20, 2.5)],
    ["Delta Exhaustion z3", (c) => evalDeltaExhaustionStrict(c, 20, 3)],
    ["DA Extreme 0.5", (c) => evalDAExtreme(c, 0.5)],
    ["DA Extreme 0.6", (c) => evalDAExtreme(c, 0.6)],
    ["DA Extreme 0.7", (c) => evalDAExtreme(c, 0.7)],
    ["DA Extreme 0.8", (c) => evalDAExtreme(c, 0.8)],
    ["Price at Extreme n8", (c) => evalPriceAtExtreme(c, 8)],
    ["Price at Extreme n12", (c) => evalPriceAtExtreme(c, 12)],
    ["Volume Spike Delta", (c) => evalVolumeSpikeDelta(c, 20, 2, 1)],
    ["Volume Spike Delta 2.5x", (c) => evalVolumeSpikeDelta(c, 20, 2.5, 1.2)],
    ["OI Delta Contrarian", (c) => evalOIDeltaContrarian(c, 30, 3000)],
    ["Cum Delta Reversal 0.7", (c) => evalCumDeltaReversal(c, 10, 0.7)],
    ["Cum Delta Reversal 0.8", (c) => evalCumDeltaReversal(c, 10, 0.8)],
    ["Triple Confirm 0.35", (c) => evalTripleConfirm(c, 0.35)],
    ["Triple Confirm 0.4", (c) => evalTripleConfirm(c, 0.4)],
    ["LTP Strict 0.5", (c) => evalLTPStrict(c, 0.5)],
    ["LTP Strict 0.55", (c) => evalLTPStrict(c, 0.55)],
    ["LTP Strict 0.6", (c) => evalLTPStrict(c, 0.6)],
    ["Momentum Exhaustion 0.3%", (c) => evalMomentumExhaustion(c, 5, 0.003)],
    ["Momentum Exhaustion 0.5%", (c) => evalMomentumExhaustion(c, 5, 0.005)],
    ["Consecutive + Delta Confirm", (c) => evalConsecutiveDeltaConfirm(c, 3)],
    ["Consensus 5 + Trend 1.0", (c) => evalConsensus5StrictTrend(c)],
    ["OI Contrarian oi50 d5k", (c) => evalOIDeltaContrarianSweep(c, 50, 5000)],
    ["OI Contrarian oi40 d4k", (c) => evalOIDeltaContrarianSweep(c, 40, 4000)],
    ["OI Contrarian oi60 d6k", (c) => evalOIDeltaContrarianSweep(c, 60, 6000)],
    ["OI Contrarian oi80 d8k", (c) => evalOIDeltaContrarianSweep(c, 80, 8000)],
    ["Price Extreme + OI Contrarian", (c) => evalPriceExtremeOIContrarian(c, 10, 40)],
    ["Consecutive 3 + OI filter 20", (c) => evalConsecutiveOIFilter(c, 3, 20)],
    ["Consecutive 3 + OI filter 30", (c) => evalConsecutiveOIFilter(c, 3, 30)],
    ["Consecutive 4 + OI filter 20", (c) => evalConsecutiveOIFilter(c, 4, 20)],
    ["Delta-OI Divergence n3", (c) => evalDeltaOIDivergence(c, 3)],
    ["Delta-OI Divergence n5", (c) => evalDeltaOIDivergence(c, 5)],
    ["Range Expansion 1.5x", (c) => evalRangeExpansionReversal(c, 10, 1.5)],
    ["Range Expansion 1.8x", (c) => evalRangeExpansionReversal(c, 10, 1.8)],
    ["Range Expansion 2.0x", (c) => evalRangeExpansionReversal(c, 10, 2.0)],
    ["Range Expansion 2.2x", (c) => evalRangeExpansionReversal(c, 10, 2.2)],
    ["Range Expansion 1.8x lb5", (c) => evalRangeExpansionReversal(c, 5, 1.8)],
    ["Range Expansion 1.8x lb15", (c) => evalRangeExpansionReversal(c, 15, 1.8)],
    ["Delta 2-Bar Flip", (c) => evalDelta2BarFlip(c)],
    ["Close Position 20%", (c) => evalClosePositionReversal(c, 0.2)],
    ["Close Position 15%", (c) => evalClosePositionReversal(c, 0.15)],
    ["Close Position 25%", (c) => evalClosePositionReversal(c, 0.25)],
    ["Range Exp + Delta Confirm 1.8", (c) => evalRangeExpansionDeltaConfirm(c, 10, 1.8)],
    ["Range Exp + Delta Confirm 2.0", (c) => evalRangeExpansionDeltaConfirm(c, 10, 2.0)],
    ["OI Contrarian + Range 1.3x", (c) => evalOIContrarianRangeFilter(c, 30, 3000, 1.3)],
    ["OI Contrarian + Range 1.5x", (c) => evalOIContrarianRangeFilter(c, 30, 3000, 1.5)],
    ["Consecutive 3 + Range 1.5x", (c) => evalConsecutiveRangeFilter(c, 3, 1.5)],
    ["Consecutive 3 + Range 1.8x", (c) => evalConsecutiveRangeFilter(c, 3, 1.8)],
  ];

  const results = [];
  for (const [name, fn] of strategies) {
    const r = fn(candles);
    const acc = r.signals > 0 ? (r.correct / r.signals) * 100 : 0;
    results.push({ name, signals: r.signals, correct: r.correct, accuracy: acc });
  }

  const c5 = aggregateCandles(candles, 5);
  const strategies5m = [
    ["Consecutive 3 Reversal 5m", (c) => evalConsecutiveReversal(c, 3)],
    ["Consecutive 4 Reversal 5m", (c) => evalConsecutiveReversal(c, 4)],
    ["Delta Flip 5m", (c) => evalDeltaFlip(c)],
    ["DA Extreme 0.6 5m", (c) => evalDAExtreme(c, 0.6)],
    ["DA Extreme 0.7 5m", (c) => evalDAExtreme(c, 0.7)],
    ["Price at Extreme n5 5m", (c) => evalPriceAtExtreme(c, 5)],
    ["Range Expansion 1.5x 5m", (c) => evalRangeExpansionReversal(c, 5, 1.5)],
    ["Range Expansion 1.8x 5m", (c) => evalRangeExpansionReversal(c, 5, 1.8)],
    ["Range Expansion 2.0x 5m", (c) => evalRangeExpansionReversal(c, 5, 2.0)],
    ["OI Contrarian 5m", (c) => evalOIDeltaContrarian(c, 30, 3000)],
    ["OI Contrarian oi50 d5k 5m", (c) => evalOIDeltaContrarian(c, 50, 5000)],
    ["OI Contrarian + Range 1.3x 5m", (c) => evalOIContrarianRangeFilter(c, 30, 3000, 1.3)],
  ];
  for (const [name, fn] of strategies5m) {
    const r = fn(c5);
    const acc = r.signals > 0 ? (r.correct / r.signals) * 100 : 0;
    results.push({ name, signals: r.signals, correct: r.correct, accuracy: acc });
  }

  console.log("=== NIFTY MAR FUT Indicator Discovery ===\n");
  console.log("Strategy                          | Signals | Accuracy");
  console.log("-".repeat(55));
  for (const r of results) {
    const ok = r.signals >= MIN_SIGNALS ? "" : " (low sig)";
    const hit = r.accuracy >= TARGET_ACC && r.signals >= MIN_SIGNALS ? " ***" : "";
    console.log(`${r.name.padEnd(34)} | ${String(r.signals).padStart(7)} | ${r.accuracy.toFixed(1)}%${ok}${hit}`);
  }

  const hits = results.filter((r) => r.accuracy >= TARGET_ACC && r.signals >= MIN_SIGNALS);
  if (hits.length > 0) {
    console.log(`\n*** >${TARGET_ACC}% ACHIEVED (min ${MIN_SIGNALS} sig) ***`);
    hits.forEach((r) => console.log(`  ${r.name}: ${r.accuracy.toFixed(1)}%, ${r.signals} signals`));
  } else {
    const best = results.reduce((a, b) =>
      (b.signals >= MIN_SIGNALS && b.accuracy > a.accuracy) ? b : a,
      { accuracy: 0, name: "none", signals: 0 }
    );
    console.log(`\nBest (min ${MIN_SIGNALS} sig): ${best.name} = ${best.accuracy.toFixed(1)}%, ${best.signals} signals`);
    console.log(`Target ${TARGET_ACC}% not reached. Try more indicator ideas or relax target.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

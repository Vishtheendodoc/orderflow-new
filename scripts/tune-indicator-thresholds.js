#!/usr/bin/env node
/**
 * Footprint Indicator Threshold Tuning
 * Sweeps LTP, MII, VPT, VZP thresholds on today's March future data and reports best accuracy.
 *
 * Usage: node scripts/tune-indicator-thresholds.js
 */

const API_BASE = process.env.API_URL || "https://orderflow-backend-3gwk.onrender.com";
const FETCH_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 60000;

const SYMBOLS = [
  "NIFTY MAR FUT", "BANKNIFTY MAR FUT", "FINNIFTY MAR FUT", "MIDCPNIFTY MAR FUT",
  "RELIANCE MAR FUT", "INFY MAR FUT", "TCS MAR FUT", "HDFCBANK MAR FUT",
  "ICICIBANK MAR FUT", "BHARTIARTL MAR FUT", "ITC MAR FUT", "KOTAKBANK MAR FUT",
  "SBIN MAR FUT", "LT MAR FUT",
];

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
    return data;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// Self-contained: replicate evalIndicator and compute functions from analyze-indicators-mar-fut
function _pearsonCorr(x, y) {
  if (!x?.length || x.length !== y.length) return 0;
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den > 0 ? num / den : 0;
}

function _ema(series, period) {
  const alpha = 2 / (period + 1);
  const out = [];
  let ema = series[0];
  for (let i = 0; i < series.length; i++) {
    ema = alpha * series[i] + (1 - alpha) * (i > 0 ? ema : series[i]);
    out.push(ema);
  }
  return out;
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

function evalIndicator(series, candles, threshold, useRaw = false) {
  let signals = 0;
  let correct = 0;
  for (let i = 0; i < series.length - 1; i++) {
    const val = useRaw ? series[i].vzpRaw : (series[i].ltp ?? series[i].mii ?? series[i].vpt ?? series[i].vzp ?? 0);
    if (Math.abs(val) <= threshold) continue;
    signals++;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    const expectedDir = val > 0 ? 1 : -1;
    if (dir === expectedDir) correct++;
  }
  return { signals, correct };
}

// Full computeLTP (no HFT)
function computeLTP(candles, symbol) {
  if (!candles?.length) return [];
  const eps = 1e-6;
  const W = 5;
  const raw = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const buyVol = c.buy_vol ?? 0;
    const sellVol = c.sell_vol ?? 0;
    const totalVol = buyVol + sellVol;
    const delta = c.delta ?? buyVol - sellVol;
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const priceChange = Math.abs(close - open) + eps;
    const dp = (buyVol - sellVol) / (totalVol + eps);
    const asRaw = Math.abs(delta) / priceChange;
    const asSign = delta >= 0 ? -1 : 1;
    let ddNorm = 0;
    if (i >= W - 1) {
      const pChg = [];
      const dChg = [];
      for (let j = i - W + 1; j < i; j++) {
        const p0 = candles[j].close ?? candles[j].open ?? 0;
        const p1 = candles[j + 1].close ?? candles[j + 1].open ?? 0;
        const d0 = candles[j].delta ?? (candles[j].buy_vol ?? 0) - (candles[j].sell_vol ?? 0);
        const d1 = candles[j + 1].delta ?? (candles[j + 1].buy_vol ?? 0) - (candles[j + 1].sell_vol ?? 0);
        pChg.push(p1 - p0);
        dChg.push(d1 - d0);
      }
      ddNorm = Math.max(-1, Math.min(1, -_pearsonCorr(pChg, dChg)));
    }
    raw.push({ dp, asRaw, asSign, ddNorm, owpRaw: 0 });
  }
  const asMax = Math.max(1, ...raw.map((r) => r.asRaw));
  const asLogMax = Math.log(1 + asMax);
  const ltpValues = [];
  let emaDp = 0;
  const alphaDp = 2 / 4;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const asNorm = asLogMax > 0 ? (Math.log(1 + r.asRaw) / asLogMax) * r.asSign : 0;
    emaDp = alphaDp * r.dp + (1 - alphaDp) * (i > 0 ? emaDp : r.dp);
    ltpValues.push({ ltp: 0.28 * emaDp + 0.32 * asNorm + 0.25 * r.ddNorm });
  }
  return ltpValues;
}

function computeMII(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const deltas = candles.map((c) => c.delta ?? (c.buy_vol ?? 0) - (c.sell_vol ?? 0));
  const ema2 = _ema(deltas, 2);
  const ema5 = _ema(deltas, 5);
  const vols = candles.map((c) => (c.buy_vol ?? 0) + (c.sell_vol ?? 0));
  const avgVol20 = [];
  const stdVol20 = [];
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - 19);
    const slice = vols.slice(start, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((s, v) => s + (v - avg) ** 2, 0) / slice.length;
    avgVol20.push(avg);
    stdVol20.push(Math.max(eps, Math.sqrt(variance)));
  }
  const raw = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const vol = vols[i];
    const delta = deltas[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const range = Math.max(eps, high - low);
    const da = ema2[i] - ema5[i];
    const ve = stdVol20[i] > 0 ? (vol - avgVol20[i]) / stdVol20[i] : 0;
    const pe = Math.abs(close - open) / range;
    raw.push({ da, ve, pe, delta, priceChange: close - open });
  }
  const daStd = Math.max(1, Math.sqrt(raw.reduce((s, v) => s + v.da * v.da, 0) / raw.length));
  return raw.map((v) => {
    const daNorm = Math.tanh(v.da / daStd);
    const veNorm = Math.tanh(v.ve / 2) * (v.delta >= 0 ? 1 : -1);
    const peNorm = (2 * v.pe - 1) * (v.priceChange >= 0 ? 1 : -1);
    return { mii: 0.45 * daNorm + 0.3 * veNorm + 0.25 * peNorm };
  });
}

function computeVPT(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const raw = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const range = Math.max(eps, high - low);
    const mid = (high + low) / 2;
    let vpc = mid;
    let totalVol = 0;
    const lvs = Object.values(c.levels || {});
    if (lvs.length > 0) {
      let sumPv = 0;
      for (const lv of lvs) {
        const p = lv.price ?? 0;
        const vol = (lv.buy_vol ?? 0) + (lv.sell_vol ?? 0) || (lv.total_vol ?? 0);
        if (vol > 0 && isFinite(p)) {
          sumPv += p * vol;
          totalVol += vol;
        }
      }
      if (totalVol > 0) vpc = sumPv / totalVol;
    } else {
      totalVol = (c.buy_vol ?? 0) + (c.sell_vol ?? 0);
      if (totalVol > 0) vpc = (open + close) / 2;
    }
    const vptRaw = range > 0 ? (vpc - mid) / range : 0;
    raw.push({ vptRaw });
  }
  const vptMax = Math.max(0.01, ...raw.map((r) => Math.abs(r.vptRaw)));
  return raw.map((r) => ({ vpt: Math.max(-1, Math.min(1, r.vptRaw / vptMax)) }));
}

function computeVZP(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const raw = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const mid = (high + low) / 2;
    const delta = c.delta ?? (c.buy_vol ?? 0) - (c.sell_vol ?? 0);
    let bidVol = 0;
    let askVol = 0;
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
    const vzpRaw = totalVol > eps ? (askVol - bidVol) / totalVol : (delta !== 0 ? -Math.sign(delta) : 0);
    raw.push({ vzpRaw });
  }
  return raw;
}

const LTP_GRID = [0.2, 0.25, 0.3, 0.35, 0.4];
const MII_GRID = [0.3, 0.35, 0.4, 0.45, 0.5];
const VPT_GRID = [0.3, 0.35, 0.4, 0.45, 0.5];
const VZP_GRID = [0.15, 0.18, 0.2, 0.22, 0.25];

async function main() {
  console.error("Fetching today's March future data...");
  const allCandles = [];
  for (const symbol of SYMBOLS) {
    try {
      const state = await fetchState(symbol);
      await sleep(FETCH_DELAY_MS);
      if (state?.candles?.length) {
        const candles = state.candles.filter((c) => c.closed !== false);
        if (candles.length >= 2) {
          allCandles.push({ symbol, candles });
        }
      }
    } catch (e) {
      console.error(`  Skip ${symbol}: ${e.message}`);
    }
  }

  if (allCandles.length === 0) {
    console.error("No data. Check API and market hours.");
    process.exit(1);
  }

  const totalCandles = allCandles.reduce((s, x) => s + x.candles.length, 0);
  console.error(`Loaded ${allCandles.length} symbols, ${totalCandles} candles total.\n`);

  const best = { ltp: { th: 0, acc: 0, sig: 0 }, mii: { th: 0, acc: 0, sig: 0 }, vpt: { th: 0, acc: 0, sig: 0 }, vzp: { th: 0, acc: 0, sig: 0 } };

  for (const th of LTP_GRID) {
    let totalS = 0, totalC = 0;
    for (const { candles } of allCandles) {
      const ltp = computeLTP(candles, "");
      const e = evalIndicator(ltp, candles, th);
      totalS += e.signals;
      totalC += e.correct;
    }
    const acc = totalS > 0 ? (totalC / totalS) * 100 : 0;
    if (totalS >= 30 && acc > best.ltp.acc) {
      best.ltp = { th, acc, sig: totalS };
    }
  }

  for (const th of MII_GRID) {
    let totalS = 0, totalC = 0;
    for (const { candles } of allCandles) {
      const mii = computeMII(candles);
      const e = evalIndicator(mii, candles, th);
      totalS += e.signals;
      totalC += e.correct;
    }
    const acc = totalS > 0 ? (totalC / totalS) * 100 : 0;
    if (totalS >= 30 && acc > best.mii.acc) {
      best.mii = { th, acc, sig: totalS };
    }
  }

  for (const th of VPT_GRID) {
    let totalS = 0, totalC = 0;
    for (const { candles } of allCandles) {
      const vpt = computeVPT(candles);
      const e = evalIndicator(vpt, candles, th);
      totalS += e.signals;
      totalC += e.correct;
    }
    const acc = totalS > 0 ? (totalC / totalS) * 100 : 0;
    if (totalS >= 30 && acc > best.vpt.acc) {
      best.vpt = { th, acc, sig: totalS };
    }
  }

  for (const th of VZP_GRID) {
    let totalS = 0, totalC = 0;
    for (const { candles } of allCandles) {
      const vzp = computeVZP(candles);
      const e = evalIndicator(vzp, candles, th, true);
      totalS += e.signals;
      totalC += e.correct;
    }
    const acc = totalS > 0 ? (totalC / totalS) * 100 : 0;
    if (totalS >= 30 && acc > best.vzp.acc) {
      best.vzp = { th, acc, sig: totalS };
    }
  }

  console.log("=== Footprint Indicator Threshold Tuning (Today's Data) ===\n");
  console.log("Best threshold per indicator (min 30 signals):\n");
  console.log(`LTP:  th=${best.ltp.th}  accuracy=${best.ltp.acc.toFixed(1)}%  signals=${best.ltp.sig}`);
  console.log(`MII:  th=${best.mii.th}  accuracy=${best.mii.acc.toFixed(1)}%  signals=${best.mii.sig}`);
  console.log(`VPT:  th=${best.vpt.th}  accuracy=${best.vpt.acc.toFixed(1)}%  signals=${best.vpt.sig}`);
  console.log(`VZP:  th=${best.vzp.th}  accuracy=${best.vzp.acc.toFixed(1)}%  signals=${best.vzp.sig}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

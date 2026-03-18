#!/usr/bin/env node
/**
 * Initiator Flow Indicator Discovery
 * Identifies initiator buying/selling using orderflow + HFT + depth.
 * Sweeps thresholds for max accuracy.
 *
 * Usage: node scripts/discover-initiator-indicator.js [symbol]
 *   Default: NIFTY MAR FUT (with HFT for NIFTY)
 */

const API_BASE = process.env.API_URL || "https://orderflow-backend-3gwk.onrender.com";
const FETCH_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 60000;
const MIN_SIGNALS = 20;
const IST_OFFSET = 19800;

const SYMBOL = process.argv[2] || "NIFTY MAR FUT";
const INDEX = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].find((n) =>
  String(SYMBOL).toUpperCase().includes(n)
) || "NIFTY";

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
    return data?.candles?.filter((c) => c.closed !== false) || null;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function fetchHft(index) {
  const url = `${API_BASE.replace(/\/$/, "")}/api/hft_scanner/${index}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    return data?.series || [];
  } catch (e) {
    clearTimeout(timeout);
    return [];
  }
}

async function fetchDepth(symbol) {
  const url = `${API_BASE.replace(/\/$/, "")}/api/heatmap/${encodeURIComponent(symbol)}?n=500`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    return data?.snapshots || [];
  } catch (e) {
    clearTimeout(timeout);
    return [];
  }
}

function nextBarDirection(candles, i, lookahead = 1) {
  const idx = i + lookahead;
  if (idx >= candles.length) return null;
  const next = candles[idx];
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

/** Build HFT by minute for candle alignment */
function buildHftByMin(hftSeries) {
  const byMin = new Map();
  if (!hftSeries?.length) return byMin;
  for (const h of hftSeries) {
    const ts = h.ts != null ? h.ts : 0;
    const minKey = Math.floor((ts + IST_OFFSET) / 60) * 60;
    const flows = h.flows || {};
    const putWrite = (flows["Heavy Put Write"] || 0) + (flows["Put Write"] || 0);
    const callShort = (flows["Call Short"] || 0) + (flows["Heavy Call Short"] || 0);
    const aggCallBuy = flows["Aggressive Call Buy"] || 0;
    const aggPutBuy = flows["Aggressive Put Buy"] || 0;
    const darkCE = flows["Dark Pool CE"] || 0;
    const darkPE = flows["Dark Pool PE"] || 0;
    const owp = putWrite - callShort;
    const aggNet = aggCallBuy - aggPutBuy;
    const darkNet = darkCE - darkPE;
    const existing = byMin.get(minKey) || { owp: 0, aggNet: 0, darkNet: 0, putWrite: 0, callShort: 0 };
    existing.owp = (existing.owp || 0) + owp;
    existing.aggNet = (existing.aggNet || 0) + aggNet;
    existing.darkNet = (existing.darkNet || 0) + darkNet;
    existing.putWrite = (existing.putWrite || 0) + putWrite;
    existing.callShort = (existing.callShort || 0) + callShort;
    byMin.set(minKey, existing);
  }
  return byMin;
}

/** Get candle minute key (IST) */
function candleMinKey(c) {
  const t = c.open_time != null ? c.open_time : (c.chartTime != null ? c.chartTime * 1000 : 0);
  const sec = Math.floor((t + IST_OFFSET * 1000) / 1000);
  return Math.floor(sec / 60) * 60;
}

/** IFI variant 1: Delta-only (orderflow initiator) */
function computeIFI_Delta(candles, th) {
  const eps = 1e-8;
  const out = [];
  const deltas = candles.map(getDelta);
  const vols = candles.map((c) => (c.buy_vol ?? 0) + (c.sell_vol ?? 0));
  const meanD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const stdD = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - meanD) ** 2, 0) / deltas.length));
  for (let i = 0; i < candles.length; i++) {
    const delta = getDelta(candles[i]);
    const vol = vols[i] || eps;
    const dp = vol > 0 ? (delta / vol) : 0;
    const dZ = stdD > 0 ? (delta - meanD) / stdD : 0;
    const ifi = Math.tanh(dp * 2) * 0.5 + Math.tanh(dZ * 0.3) * 0.5;
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 2: Delta + level imbalance */
function computeIFI_DeltaLevels(candles, th) {
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const delta = getDelta(c);
    const vol = (c.buy_vol ?? 0) + (c.sell_vol ?? 0) || eps;
    const dp = delta / vol;
    let levelImb = 0;
    const lvs = Object.values(c.levels || {});
    if (lvs.length > 0) {
      let buyL = 0, sellL = 0;
      for (const lv of lvs) {
        buyL += lv.buy_vol ?? 0;
        sellL += lv.sell_vol ?? 0;
      }
      const tot = buyL + sellL || eps;
      levelImb = (buyL - sellL) / tot;
    } else {
      levelImb = dp;
    }
    const ifi = 0.6 * Math.tanh(dp * 2) + 0.4 * Math.tanh(levelImb * 2);
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 3: Delta + HFT OWP */
function computeIFI_DeltaHFT(candles, hftByMin) {
  const eps = 1e-8;
  const out = [];
  const deltas = candles.map(getDelta);
  const meanD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const stdD = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - meanD) ** 2, 0) / deltas.length));
  const owpVals = [];
  for (let i = 0; i < candles.length; i++) {
    const minKey = candleMinKey(candles[i]);
    const h = hftByMin.get(minKey);
    owpVals.push(h?.owp ?? 0);
  }
  const meanO = owpVals.reduce((a, b) => a + b, 0) / owpVals.length;
  const stdO = Math.max(1, Math.sqrt(owpVals.reduce((s, o) => s + (o - meanO) ** 2, 0) / owpVals.length));
  for (let i = 0; i < candles.length; i++) {
    const delta = getDelta(candles[i]);
    const dZ = stdD > 0 ? (delta - meanD) / stdD : 0;
    const owp = owpVals[i];
    const oNorm = stdO > 0 ? -Math.tanh((owp - meanO) / stdO) : 0;
    const ifi = 0.7 * Math.tanh(dZ * 0.4) + 0.3 * oNorm;
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 4: Delta + HFT Aggressive Net */
function computeIFI_DeltaHftAgg(candles, hftByMin) {
  const eps = 1e-8;
  const out = [];
  const deltas = candles.map(getDelta);
  const meanD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const stdD = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - meanD) ** 2, 0) / deltas.length));
  const aggVals = [];
  for (let i = 0; i < candles.length; i++) {
    const minKey = candleMinKey(candles[i]);
    const h = hftByMin.get(minKey);
    aggVals.push(h?.aggNet ?? 0);
  }
  const meanA = aggVals.reduce((a, b) => a + b, 0) / aggVals.length;
  const stdA = Math.max(1, Math.sqrt(aggVals.reduce((s, a) => s + (a - meanA) ** 2, 0) / aggVals.length));
  for (let i = 0; i < candles.length; i++) {
    const delta = getDelta(candles[i]);
    const dZ = stdD > 0 ? (delta - meanD) / stdD : 0;
    const agg = aggVals[i];
    const aNorm = stdA > 0 ? Math.tanh((agg - meanA) / stdA) : 0;
    const ifi = 0.6 * Math.tanh(dZ * 0.4) + 0.4 * aNorm;
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 5: Absorption/Distribution — initiator opposite to price = reversal */
function computeIFI_Absorption(candles, dpMin = 0.15) {
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const delta = getDelta(c);
    const vol = (c.buy_vol ?? 0) + (c.sell_vol ?? 0) || eps;
    const dp = delta / vol;
    const barDir = close > open ? 1 : close < open ? -1 : 0;
    let ifi = 0;
    if (barDir !== 0 && Math.abs(dp) > dpMin) {
      if (barDir === -1 && dp > 0) ifi = 1;
      else if (barDir === 1 && dp < 0) ifi = -1;
    }
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 6: Delta momentum — change in delta (initiator acceleration) */
function computeIFI_DeltaMomentum(candles, lookback = 2) {
  const eps = 1e-8;
  const out = [];
  const deltas = candles.map(getDelta);
  const vols = candles.map((c) => (c.buy_vol ?? 0) + (c.sell_vol ?? 0));
  for (let i = 0; i < candles.length; i++) {
    let mom = 0;
    if (i >= lookback) {
      const d0 = deltas[i - lookback];
      const d1 = deltas[i];
      mom = d1 - d0;
      const vol = vols[i] || eps;
      mom = vol > 0 ? mom / vol : 0;
    }
    const ifi = Math.tanh(mom * 3);
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 7: Delta + bar direction confluence (initiator agrees with price) */
function computeIFI_Confluence(candles) {
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const delta = getDelta(c);
    const vol = (c.buy_vol ?? 0) + (c.sell_vol ?? 0) || eps;
    const dp = delta / vol;
    const barDir = close > open ? 1 : close < open ? -1 : 0;
    const ifi = barDir !== 0 && dp * barDir > 0 ? Math.sign(dp) * (0.5 + Math.min(0.5, Math.abs(dp))) : dp;
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 8: VZP-style from levels (ask zone - bid zone). -vzp = bullish when bid heavy */
function computeIFI_VZPStyle(candles) {
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = c.high ?? Math.max(c.open ?? 0, c.close ?? 0);
    const low = c.low ?? Math.min(c.open ?? 1e9, c.close ?? 1e9);
    const mid = (high + low) / 2;
    const delta = getDelta(c);
    let askVol = 0, bidVol = 0;
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
    const tot = bidVol + askVol || eps;
    const vzp = (askVol - bidVol) / tot;
    const ifi = lvs.length > 0 ? -vzp : -Math.sign(delta) * Math.min(1, Math.abs(delta) / 1000);
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 8b: VZP using open/close mid */
function computeIFI_VZPOpenClose(candles) {
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const mid = (open + close) / 2;
    const delta = getDelta(c);
    let askVol = 0, bidVol = 0;
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
    const tot = bidVol + askVol || eps;
    const vzp = (askVol - bidVol) / tot;
    const ifi = lvs.length > 0 ? -vzp : -Math.sign(delta) * Math.min(1, Math.abs(delta) / 1000);
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 8c: VZP using VWAP (volume-weighted avg price) as split */
function computeIFI_VZPVWAP(candles) {
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const delta = getDelta(c);
    let sumPv = 0, totalVol = 0, askVol = 0, bidVol = 0;
    const lvs = Object.values(c.levels || {});
    if (lvs.length > 0) {
      for (const lv of lvs) {
        const p = lv.price ?? 0;
        const vol = (lv.buy_vol ?? 0) + (lv.sell_vol ?? 0) || (lv.total_vol ?? 0);
        if (vol > 0 && isFinite(p)) {
          sumPv += p * vol;
          totalVol += vol;
        }
      }
      const vwap = totalVol > eps ? sumPv / totalVol : (c.high + c.low) / 2;
      for (const lv of lvs) {
        const p = lv.price ?? 0;
        const vol = (lv.buy_vol ?? 0) + (lv.sell_vol ?? 0) || (lv.total_vol ?? 0);
        if (vol > 0 && isFinite(p)) {
          if (p < vwap) bidVol += vol;
          else if (p > vwap) askVol += vol;
        }
      }
    }
    const tot = bidVol + askVol || eps;
    const vzp = (askVol - bidVol) / tot;
    const ifi = lvs.length > 0 ? -vzp : -Math.sign(delta) * Math.min(1, Math.abs(delta) / 1000);
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 8d: VZP OpenClose + HFT */
function computeIFI_VZPOpenCloseHFT(candles, hftByMin, wVzp = 0.7) {
  const eps = 1e-8;
  const out = [];
  const owpVals = candles.map((c) => {
    const minKey = candleMinKey(c);
    const h = hftByMin.get(minKey);
    return h?.owp ?? 0;
  });
  const meanO = owpVals.reduce((a, b) => a + b, 0) / owpVals.length;
  const stdO = Math.max(1, Math.sqrt(owpVals.reduce((s, o) => s + (o - meanO) ** 2, 0) / owpVals.length));
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const mid = (open + close) / 2;
    const delta = getDelta(c);
    let askVol = 0, bidVol = 0;
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
    const tot = bidVol + askVol || eps;
    const vzp = (askVol - bidVol) / tot;
    const oNorm = stdO > 0 ? -Math.tanh((owpVals[i] - meanO) / stdO) : 0;
    const ifi = lvs.length > 0 ? -wVzp * vzp + (1 - wVzp) * oNorm : oNorm;
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 8e: VZP OpenClose + Delta */
function computeIFI_VZPOpenCloseDelta(candles, wVzp = 0.7) {
  const eps = 1e-8;
  const out = [];
  const deltas = candles.map(getDelta);
  const meanD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const stdD = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - meanD) ** 2, 0) / deltas.length));
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const mid = (open + close) / 2;
    const delta = getDelta(c);
    let askVol = 0, bidVol = 0;
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
    const tot = bidVol + askVol || eps;
    const vzp = (askVol - bidVol) / tot;
    const dZ = stdD > 0 ? (delta - meanD) / stdD : 0;
    const dNorm = Math.tanh(dZ * 0.3);
    const ifi = lvs.length > 0 ? -wVzp * vzp + (1 - wVzp) * dNorm : dNorm;
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 10: VZP + Delta weighted */
function computeIFI_VZPDelta(candles, wVzp = 0.6) {
  const eps = 1e-8;
  const out = [];
  const deltas = candles.map(getDelta);
  const meanD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const stdD = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - meanD) ** 2, 0) / deltas.length));
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = c.high ?? Math.max(c.open ?? 0, c.close ?? 0);
    const low = c.low ?? Math.min(c.open ?? 1e9, c.close ?? 1e9);
    const mid = (high + low) / 2;
    const delta = getDelta(c);
    let askVol = 0, bidVol = 0;
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
    const tot = bidVol + askVol || eps;
    const vzp = lvs.length > 0 ? (askVol - bidVol) / tot : 0;
    const dZ = stdD > 0 ? (delta - meanD) / stdD : 0;
    const dNorm = Math.tanh(dZ * 0.3);
    const ifi = lvs.length > 0
      ? -wVzp * vzp + (1 - wVzp) * dNorm
      : dNorm;
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 11: VZP + HFT OWP */
function computeIFI_VZPHFT(candles, hftByMin, wVzp = 0.6) {
  const eps = 1e-8;
  const out = [];
  const owpVals = candles.map((c) => {
    const minKey = candleMinKey(c);
    const h = hftByMin.get(minKey);
    return h?.owp ?? 0;
  });
  const meanO = owpVals.reduce((a, b) => a + b, 0) / owpVals.length;
  const stdO = Math.max(1, Math.sqrt(owpVals.reduce((s, o) => s + (o - meanO) ** 2, 0) / owpVals.length));
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = c.high ?? Math.max(c.open ?? 0, c.close ?? 0);
    const low = c.low ?? Math.min(c.open ?? 1e9, c.close ?? 1e9);
    const mid = (high + low) / 2;
    const delta = getDelta(c);
    let askVol = 0, bidVol = 0;
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
    const tot = bidVol + askVol || eps;
    const vzp = lvs.length > 0 ? (askVol - bidVol) / tot : 0;
    const oNorm = stdO > 0 ? -Math.tanh((owpVals[i] - meanO) / stdO) : 0;
    const ifi = lvs.length > 0
      ? -wVzp * vzp + (1 - wVzp) * oNorm
      : oNorm;
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** IFI variant 9: Full composite - Delta + Levels + HFT */
function computeIFI_Full(candles, hftByMin) {
  const eps = 1e-8;
  const out = [];
  const deltas = candles.map(getDelta);
  const meanD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const stdD = Math.max(eps, Math.sqrt(deltas.reduce((s, d) => s + (d - meanD) ** 2, 0) / deltas.length));
  const owpVals = [];
  const aggVals = [];
  for (let i = 0; i < candles.length; i++) {
    const minKey = candleMinKey(candles[i]);
    const h = hftByMin.get(minKey);
    owpVals.push(h?.owp ?? 0);
    aggVals.push(h?.aggNet ?? 0);
  }
  const meanO = owpVals.reduce((a, b) => a + b, 0) / owpVals.length;
  const stdO = Math.max(1, Math.sqrt(owpVals.reduce((s, o) => s + (o - meanO) ** 2, 0) / owpVals.length));
  const meanA = aggVals.reduce((a, b) => a + b, 0) / aggVals.length;
  const stdA = Math.max(1, Math.sqrt(aggVals.reduce((s, a) => s + (a - meanA) ** 2, 0) / aggVals.length));
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const delta = getDelta(c);
    const vol = (c.buy_vol ?? 0) + (c.sell_vol ?? 0) || eps;
    const dp = delta / vol;
    let levelImb = dp;
    const lvs = Object.values(c.levels || {});
    if (lvs.length > 0) {
      let buyL = 0, sellL = 0;
      for (const lv of lvs) {
        buyL += lv.buy_vol ?? 0;
        sellL += lv.sell_vol ?? 0;
      }
      const tot = buyL + sellL || eps;
      levelImb = (buyL - sellL) / tot;
    }
    const dZ = stdD > 0 ? (delta - meanD) / stdD : 0;
    const oNorm = stdO > 0 ? -Math.tanh((owpVals[i] - meanO) / stdO) : 0;
    const aNorm = stdA > 0 ? Math.tanh((aggVals[i] - meanA) / stdA) : 0;
    const ifi = 0.4 * Math.tanh(dZ * 0.4) + 0.2 * Math.tanh(levelImb * 2) + 0.2 * oNorm + 0.2 * aNorm;
    out.push({ ifi, raw: ifi });
  }
  return out;
}

/** Evaluate IFI with threshold sweep */
function evalIFI(ifiSeries, candles, threshold, lookahead = 1) {
  let worked = 0, opposite = 0, flat = 0;
  for (let i = 0; i < candles.length - lookahead; i++) {
    const val = ifiSeries[i]?.ifi ?? ifiSeries[i]?.raw ?? 0;
    if (Math.abs(val) <= threshold) continue;
    const dir = nextBarDirection(candles, i, lookahead);
    if (dir === null) continue;
    const expectedDir = val > 0 ? 1 : -1;
    if (dir === 0) flat++;
    else if (dir === expectedDir) worked++;
    else opposite++;
  }
  const signals = worked + opposite;
  const accuracy = signals > 0 ? (worked / signals) * 100 : 0;
  return { signals, worked, opposite, flat, accuracy };
}

/** Sweep threshold for max accuracy */
function sweepThreshold(ifiSeries, candles, thMin = 0.1, thMax = 0.9, step = 0.02, lookahead = 1) {
  let best = { th: 0.5, acc: 0, signals: 0, worked: 0, opposite: 0, flat: 0 };
  for (let th = thMin; th <= thMax; th += step) {
    const r = evalIFI(ifiSeries, candles, th, lookahead);
    if (r.signals >= MIN_SIGNALS && r.accuracy > best.acc) {
      best = { th, acc: r.accuracy, signals: r.signals, worked: r.worked, opposite: r.opposite, flat: r.flat };
    }
  }
  return best;
}


async function main() {
  console.error(`Fetching data for ${SYMBOL}...`);
  const candles = await fetchState(SYMBOL);
  await sleep(FETCH_DELAY_MS);
  const hftSeries = await fetchHft(INDEX);
  await sleep(FETCH_DELAY_MS);

  if (!candles?.length || candles.length < 30) {
    console.error("Insufficient candle data.");
    process.exit(1);
  }

  const hftByMin = buildHftByMin(hftSeries);
  console.error(`Loaded ${candles.length} candles, ${hftSeries.length} HFT snaps.\n`);

  const variants = [
    { name: "IFI VZP OpenClose", fn: () => computeIFI_VZPOpenClose(candles), lookahead: 1, step: 0.01 },
    { name: "IFI VZP OpenClose+HFT 0.7", fn: () => computeIFI_VZPOpenCloseHFT(candles, hftByMin, 0.7), lookahead: 1 },
    { name: "IFI VZP OpenClose+HFT 0.8", fn: () => computeIFI_VZPOpenCloseHFT(candles, hftByMin, 0.8), lookahead: 1 },
    { name: "IFI VZP-style", fn: () => computeIFI_VZPStyle(candles), lookahead: 1 },
    { name: "IFI VZP VWAP", fn: () => computeIFI_VZPVWAP(candles), lookahead: 1 },
    { name: "IFI VZP+Delta 0.7", fn: () => computeIFI_VZPDelta(candles, 0.7), lookahead: 1 },
    { name: "IFI VZP+HFT 0.7", fn: () => computeIFI_VZPHFT(candles, hftByMin, 0.7), lookahead: 1 },
    { name: "IFI Delta+Levels", fn: () => computeIFI_DeltaLevels(candles), lookahead: 1 },
    { name: "IFI Full (D+L+HFT)", fn: () => computeIFI_Full(candles, hftByMin), lookahead: 1 },
  ];

  console.log(`=== Initiator Flow Indicator Discovery (${SYMBOL}) ===\n`);
  console.log("Variant                         | Best Th | Signals | Accuracy | W / O / F");
  console.log("-".repeat(72));

  let bestOverall = { name: "", th: 0, acc: 0, signals: 0 };

  for (const v of variants) {
    const series = v.fn();
    const la = v.lookahead ?? 1;
    const step = v.step ?? 0.02;
    const best = sweepThreshold(series, candles, 0.1, 0.95, step, la);
    const ok = best.signals >= MIN_SIGNALS ? "" : " (low sig)";
    console.log(
      `${v.name.padEnd(30)} | ${best.th.toFixed(2).padStart(6)} | ${String(best.signals).padStart(7)} | ${best.acc.toFixed(1)}%${ok.padEnd(9)} | ${best.worked}/${best.opposite}/${best.flat}`
    );
    if (best.signals >= MIN_SIGNALS && best.acc > bestOverall.acc) {
      bestOverall = { name: v.name, th: best.th, acc: best.acc, signals: best.signals };
    }
  }

  console.log("\n" + "-".repeat(70));
  if (bestOverall.acc > 0) {
    console.log(`Best: ${bestOverall.name} @ th=${bestOverall.th.toFixed(2)} → ${bestOverall.acc.toFixed(1)}% (${bestOverall.signals} signals)`);
  } else {
    console.log("No variant reached min 20 signals. Try different symbol or more data.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

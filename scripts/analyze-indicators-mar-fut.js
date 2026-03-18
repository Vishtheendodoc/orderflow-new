#!/usr/bin/env node
/**
 * Multi-Symbol March Future Indicator Analysis
 * Fetches today's footprint data from Render, evaluates LTP, MII, VPT, VZP, Context Events,
 * and outputs a performance report (per-symbol and aggregate).
 *
 * Usage:
 *   node scripts/analyze-indicators-mar-fut.js
 *   API_URL=https://orderflow-backend-3gwk.onrender.com node scripts/analyze-indicators-mar-fut.js
 */

const API_BASE = process.env.API_URL || "https://orderflow-backend-3gwk.onrender.com";
const FETCH_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 60000;

const LTP_THRESHOLD = 0.3;
const MII_THRESHOLD = 0.4;
const VPT_THRESHOLD = 0.4;
const VZP_THRESHOLD = 0.2;

const TIER1 = [
  "NIFTY MAR FUT",
  "BANKNIFTY MAR FUT",
  "FINNIFTY MAR FUT",
  "MIDCPNIFTY MAR FUT",
];

const TIER2 = [
  "RELIANCE MAR FUT",
  "INFY MAR FUT",
  "TCS MAR FUT",
  "HDFCBANK MAR FUT",
  "ICICIBANK MAR FUT",
  "BHARTIARTL MAR FUT",
  "ITC MAR FUT",
  "KOTAKBANK MAR FUT",
  "SBIN MAR FUT",
  "LT MAR FUT",
];

const SYMBOLS = process.env.SYMBOLS
  ? process.env.SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
  : [...TIER1, ...TIER2];

/** When set, evaluate combined mode: signal only when 2+ indicators agree on direction */
const COMBINED_MODE = process.env.COMBINED_INDICATORS === "1" || process.env.COMBINED_INDICATORS === "true";

/** Symbols to exclude from aggregate (e.g. EXCLUDE_SYMBOLS=ITC MAR FUT,ICICIBANK MAR FUT,FINNIFTY MAR FUT) */
const EXCLUDE_SYMBOLS = process.env.EXCLUDE_SYMBOLS
  ? new Set(process.env.EXCLUDE_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean))
  : null;

// ─── Indicator logic (replicated from orderflowIndicators.js) ───

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

function computeLTP(candles, hftSeries, symbol) {
  if (!candles?.length) return [];
  const s = String(symbol || "").toUpperCase();
  const isIndex = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].some((n) => s.includes(n));
  const firstPrice = candles[0]?.close ?? candles[0]?.open ?? 1000;
  const tickSize = firstPrice > 5000 ? 0.05 : firstPrice > 100 ? 0.25 : 0.01;
  const eps = tickSize * 2;

  const IST_OFFSET = 19800;
  const hftByMin = new Map();
  if (isIndex && hftSeries?.length) {
    hftSeries.forEach((h) => {
      const ts = h.ts != null ? h.ts : 0;
      const minKey = Math.floor((ts + IST_OFFSET) / 60) * 60;
      const flows = h.flows || {};
      const putWrite = (flows["Heavy Put Write"] || 0) + (flows["Put Write"] || 0);
      const callWrite = (flows["Call Short"] || 0) + (flows["Heavy Call Short"] || 0);
      const owp = putWrite - callWrite;
      hftByMin.set(minKey, (hftByMin.get(minKey) || 0) + owp);
    });
  }

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
    const priceChange = Math.abs(close - open);

    const dp = (buyVol - sellVol) / (totalVol + eps);
    const asRaw = Math.abs(delta) / (priceChange + eps);
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
      const corr = _pearsonCorr(pChg, dChg);
      ddNorm = Math.max(-1, Math.min(1, -corr));
    }

    let owpRaw = 0;
    if (isIndex) {
      const openTime = c.open_time != null ? (c.open_time < 1e12 ? c.open_time * 1000 : c.open_time) : (c.chartTime != null ? c.chartTime * 1000 : 0);
      const minKey = Math.floor(openTime / 60000) * 60;
      owpRaw = hftByMin.get(minKey) ?? 0;
    }

    raw.push({ open_time: c.open_time ?? (c.chartTime != null ? c.chartTime * 1000 : 0), chartTime: c.chartTime, dp, asRaw, asSign, ddNorm, owpRaw });
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
    ltpValues.push({
      open_time: r.open_time,
      chartTime: r.chartTime,
      dp: emaDp,
      asNorm,
      ddNorm: r.ddNorm,
      owpRaw: r.owpRaw,
    });
  }

  const owpVals = ltpValues.map((v) => v.owpRaw).filter((x) => x !== 0);
  let owpStd = 1;
  if (owpVals.length > 1) {
    const mean = owpVals.reduce((a, b) => a + b, 0) / owpVals.length;
    const variance = owpVals.reduce((s, x) => s + (x - mean) ** 2, 0) / owpVals.length;
    owpStd = Math.max(1, Math.sqrt(variance));
  }

  return ltpValues.map((v) => {
    const owpNorm = owpStd > 0 ? Math.tanh(v.owpRaw / owpStd) : 0;
    const ltp = 0.28 * v.dp + 0.32 * v.asNorm + 0.25 * v.ddNorm + 0.15 * owpNorm;
    return { ...v, ltp };
  });
}

function computeMII(candles) {
  if (!candles?.length) return [];
  const W_VE = 20;
  const eps = 1e-8;

  const deltas = candles.map((c) => c.delta ?? (c.buy_vol ?? 0) - (c.sell_vol ?? 0));
  const ema2 = _ema(deltas, 2);
  const ema5 = _ema(deltas, 5);

  const vols = candles.map((c) => (c.buy_vol ?? 0) + (c.sell_vol ?? 0));
  const avgVol20 = [];
  const stdVol20 = [];
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - W_VE + 1);
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

    raw.push({ open_time: c.open_time, chartTime: c.chartTime, da, ve, pe, delta, priceChange: close - open });
  }

  const daStd = Math.max(1, Math.sqrt(raw.reduce((s, v) => s + v.da * v.da, 0) / raw.length));

  return raw.map((v) => {
    const daNorm = Math.tanh(v.da / daStd);
    const veNorm = Math.tanh(v.ve / 2) * (v.delta >= 0 ? 1 : -1);
    const peNorm = (2 * v.pe - 1) * (v.priceChange >= 0 ? 1 : -1);
    const mii = 0.45 * daNorm + 0.3 * veNorm + 0.25 * peNorm;
    return { ...v, mii };
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
      if (totalVol > 0) {
        vpc = (open + close) / 2;
      }
    }

    const vptRaw = range > 0 ? (vpc - mid) / range : 0;
    raw.push({ open_time: c.open_time, chartTime: c.chartTime, vptRaw, close, open, range });
  }

  const vptMax = Math.max(0.01, ...raw.map((r) => Math.abs(r.vptRaw)));
  return raw.map((r) => {
    const vpt = Math.max(-1, Math.min(1, r.vptRaw / vptMax));
    return { ...r, vpt };
  });
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
    let vzpRaw;
    if (totalVol > eps) {
      vzpRaw = (askVol - bidVol) / totalVol;
    } else {
      vzpRaw = delta !== 0 ? -Math.sign(delta) : 0;
    }

    raw.push({ open_time: c.open_time, chartTime: c.chartTime, vzpRaw });
  }

  const vzpMax = Math.max(0.01, ...raw.map((r) => Math.abs(r.vzpRaw)));
  return raw.map((r) => {
    const vzp = Math.max(-1, Math.min(1, r.vzpRaw / vzpMax));
    return { ...r, vzp, vzpRaw: r.vzpRaw };
  });
}

function computeContextEvents(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  // Tuned on March futures: stricter trend + VZP for higher accuracy
  const PREV3_UP = 8;
  const PREV3_DOWN = -8;
  const PREV2_UP = 8;
  const PREV2_FLAT = -1;
  const VZP_REV_TOP = 0.25;
  const VZP_RALLY_END = 0.22;
  const VZP_RALLY_START = 0.25;
  const VZP_REV_BOTTOM = 0.22;

  const out = [];
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

    let prev3Chg = 0;
    let prev2Chg = 0;
    if (i >= 3) {
      for (let j = i - 3; j < i; j++) {
        prev3Chg += (candles[j].close ?? candles[j].open ?? 0) - (candles[j].open ?? candles[j].close ?? 0);
      }
    }
    if (i >= 2) {
      for (let j = i - 2; j < i; j++) {
        prev2Chg += (candles[j].close ?? candles[j].open ?? 0) - (candles[j].open ?? candles[j].close ?? 0);
      }
    }

    let event = null;
    let confidence = 0;

    if (prev3Chg > PREV3_UP && vzpRaw > VZP_REV_TOP) {
      event = "REVERSAL_TOP";
      confidence = vzpRaw;
    } else if (prev2Chg > PREV2_UP && vzpRaw > VZP_RALLY_END) {
      event = "RALLY_END";
      confidence = vzpRaw;
    } else if (prev2Chg < PREV2_FLAT && vzpRaw < -VZP_RALLY_START) {
      event = "RALLY_START";
      confidence = -vzpRaw;
    } else if (prev3Chg < PREV3_DOWN && vzpRaw < -VZP_REV_BOTTOM) {
      event = "REVERSAL_BOTTOM";
      confidence = -vzpRaw;
    }

    out.push({
      open_time: c.open_time,
      chartTime: c.chartTime,
      event,
      confidence,
    });
  }
  return out;
}

// ─── Evaluation ───

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

function evalContextEvents(events, candles) {
  let signals = 0;
  let correct = 0;
  const bearishEvents = new Set(["REVERSAL_TOP", "RALLY_END"]);
  const bullishEvents = new Set(["RALLY_START", "REVERSAL_BOTTOM"]);
  for (let i = 0; i < events.length - 1; i++) {
    const ev = events[i].event;
    if (!ev) continue;
    signals++;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    const expectedDir = bearishEvents.has(ev) ? -1 : 1;
    if (dir === expectedDir) correct++;
  }
  return { signals, correct };
}

/** Combined: signal when 2+ indicators agree on direction at same bar */
function evalCombined(ltp, mii, vpt, vzp, cae, candles) {
  let signals = 0;
  let correct = 0;
  const bearishEvents = new Set(["REVERSAL_TOP", "RALLY_END"]);
  const bullishEvents = new Set(["RALLY_START", "REVERSAL_BOTTOM"]);
  for (let i = 0; i < candles.length - 1; i++) {
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    const votes = [];
    const vLtp = ltp[i]?.ltp;
    if (vLtp != null && Math.abs(vLtp) > LTP_THRESHOLD) votes.push(vLtp > 0 ? 1 : -1);
    const vMii = mii[i]?.mii;
    if (vMii != null && Math.abs(vMii) > MII_THRESHOLD) votes.push(vMii > 0 ? 1 : -1);
    const vVpt = vpt[i]?.vpt;
    if (vVpt != null && Math.abs(vVpt) > VPT_THRESHOLD) votes.push(vVpt > 0 ? 1 : -1);
    const vVzp = vzp[i]?.vzpRaw;
    if (vVzp != null && Math.abs(vVzp) > VZP_THRESHOLD) votes.push(vVzp > 0 ? -1 : 1); // VZP: pos=bearish
    const ev = cae[i]?.event;
    if (ev) votes.push(bearishEvents.has(ev) ? -1 : 1);
    if (votes.length < 2) continue;
    const up = votes.filter((v) => v === 1).length;
    const down = votes.filter((v) => v === -1).length;
    const agreed = up >= 2 ? 1 : down >= 2 ? -1 : 0;
    if (agreed === 0) continue;
    signals++;
    if (dir === agreed) correct++;
  }
  return { signals, correct };
}

// ─── Fetch & Run ───

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
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.candles?.length) return null;
    return data;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function analyzeSymbol(symbol, state) {
  const candles = state.candles.filter((c) => c.closed !== false);
  if (candles.length < 2) return null;

  const ltp = computeLTP(candles, [], symbol);
  const mii = computeMII(candles);
  const vpt = computeVPT(candles);
  const vzp = computeVZP(candles);
  const cae = computeContextEvents(candles);

  const ltpEval = evalIndicator(ltp, candles, LTP_THRESHOLD);
  const miiEval = evalIndicator(mii, candles, MII_THRESHOLD);
  const vptEval = evalIndicator(vpt, candles, VPT_THRESHOLD);
  const vzpEval = evalIndicator(vzp, candles, VZP_THRESHOLD, true);
  const caeEval = evalContextEvents(cae, candles);
  const combinedEval = COMBINED_MODE ? evalCombined(ltp, mii, vpt, vzp, cae, candles) : null;

  const fmt = (e) => (e.signals > 0 ? `${e.signals}/${((e.correct / e.signals) * 100).toFixed(1)}` : "0/-");

  return {
    symbol,
    candles: candles.length,
    ltp: fmt(ltpEval),
    mii: fmt(miiEval),
    vpt: fmt(vptEval),
    vzp: fmt(vzpEval),
    cae: fmt(caeEval),
    combined: combinedEval ? fmt(combinedEval) : null,
    raw: {
      ltp: ltpEval,
      mii: miiEval,
      vpt: vptEval,
      vzp: vzpEval,
      cae: caeEval,
      combined: combinedEval,
    },
  };
}

function formatTable(rows, dateStr) {
  const pad = (s, w) => String(s).padEnd(w);
  const wSym = Math.max(20, ...rows.map((r) => r.symbol.length));
  const hasCombined = rows.some((r) => r.combined != null);
  const combinedCol = hasCombined ? ` | ${pad("Combined(2+)", 14)}` : "";
  const header = `${pad("Symbol", wSym)} | ${pad("Candles", 7)} | ${pad("LTP (sig/acc%)", 14)} | ${pad("MII (sig/acc%)", 14)} | ${pad("VPT (sig/acc%)", 14)} | ${pad("VZP (sig/acc%)", 14)} | ${pad("CAE (sig/acc%)", 14)}${combinedCol}`;
  const sep = "-".repeat(header.length);
  const lines = [
    `=== Indicator Performance: March Futures (${dateStr}) ===`,
    hasCombined ? "(Combined = 2+ indicators agree on direction)" : "",
    "",
    header,
    sep,
    ...rows.map((r) => {
      const base = `${pad(r.symbol, wSym)} | ${pad(r.candles, 7)} | ${pad(r.ltp, 14)} | ${pad(r.mii, 14)} | ${pad(r.vpt, 14)} | ${pad(r.vzp, 14)} | ${pad(r.cae, 14)}`;
      return hasCombined ? `${base} | ${pad(r.combined ?? "-", 14)}` : base;
    }),
  ];

  if (rows.length > 1) {
    const n = rows.length;
    const avgLtp = rows.reduce((s, r) => s + (r.raw.ltp.signals > 0 ? (r.raw.ltp.correct / r.raw.ltp.signals) * 100 : 0), 0) / n;
    const avgMii = rows.reduce((s, r) => s + (r.raw.mii.signals > 0 ? (r.raw.mii.correct / r.raw.mii.signals) * 100 : 0), 0) / n;
    const avgVpt = rows.reduce((s, r) => s + (r.raw.vpt.signals > 0 ? (r.raw.vpt.correct / r.raw.vpt.signals) * 100 : 0), 0) / n;
    const avgVzp = rows.reduce((s, r) => s + (r.raw.vzp.signals > 0 ? (r.raw.vzp.correct / r.raw.vzp.signals) * 100 : 0), 0) / n;
    const avgCae = rows.reduce((s, r) => s + (r.raw.cae.signals > 0 ? (r.raw.cae.correct / r.raw.cae.signals) * 100 : 0), 0) / n;
    const avgCombined = hasCombined
      ? rows.reduce((s, r) => s + (r.raw.combined?.signals > 0 ? (r.raw.combined.correct / r.raw.combined.signals) * 100 : 0), 0) / n
      : 0;
    lines.push(sep);
    const aggBase = `${pad(`AGGREGATE (${n} symbols)`, wSym)} | ${pad("-", 7)} | ${pad(`avg LTP ${avgLtp.toFixed(1)}%`, 14)} | ${pad(`avg MII ${avgMii.toFixed(1)}%`, 14)} | ${pad(`avg VPT ${avgVpt.toFixed(1)}%`, 14)} | ${pad(`avg VZP ${avgVzp.toFixed(1)}%`, 14)} | ${pad(`avg CAE ${avgCae.toFixed(1)}%`, 14)}`;
    lines.push(hasCombined ? `${aggBase} | ${pad(`avg Combined ${avgCombined.toFixed(1)}%`, 14)}` : aggBase);
    if (EXCLUDE_SYMBOLS && EXCLUDE_SYMBOLS.size > 0) {
      const filtered = rows.filter((r) => !EXCLUDE_SYMBOLS.has(r.symbol));
      if (filtered.length > 0 && filtered.length < rows.length) {
        const nf = filtered.length;
        const avgLtpF = filtered.reduce((s, r) => s + (r.raw.ltp.signals > 0 ? (r.raw.ltp.correct / r.raw.ltp.signals) * 100 : 0), 0) / nf;
        const avgMiiF = filtered.reduce((s, r) => s + (r.raw.mii.signals > 0 ? (r.raw.mii.correct / r.raw.mii.signals) * 100 : 0), 0) / nf;
        const avgVptF = filtered.reduce((s, r) => s + (r.raw.vpt.signals > 0 ? (r.raw.vpt.correct / r.raw.vpt.signals) * 100 : 0), 0) / nf;
        const avgVzpF = filtered.reduce((s, r) => s + (r.raw.vzp.signals > 0 ? (r.raw.vzp.correct / r.raw.vzp.signals) * 100 : 0), 0) / nf;
        const avgCaeF = filtered.reduce((s, r) => s + (r.raw.cae.signals > 0 ? (r.raw.cae.correct / r.raw.cae.signals) * 100 : 0), 0) / nf;
        const avgCombinedF = hasCombined ? filtered.reduce((s, r) => s + (r.raw.combined?.signals > 0 ? (r.raw.combined.correct / r.raw.combined.signals) * 100 : 0), 0) / nf : 0;
        lines.push(sep);
        const aggF = `${pad(`AGGREGATE (${nf} excl)`, wSym)} | ${pad("-", 7)} | ${pad(`avg LTP ${avgLtpF.toFixed(1)}%`, 14)} | ${pad(`avg MII ${avgMiiF.toFixed(1)}%`, 14)} | ${pad(`avg VPT ${avgVptF.toFixed(1)}%`, 14)} | ${pad(`avg VZP ${avgVzpF.toFixed(1)}%`, 14)} | ${pad(`avg CAE ${avgCaeF.toFixed(1)}%`, 14)}`;
        lines.push(hasCombined ? `${aggF} | ${pad(`avg Combined ${avgCombinedF.toFixed(1)}%`, 14)}` : aggF);
      }
    }
  }

  return lines.join("\n");
}

async function main() {
  const dateStr = new Date().toISOString().slice(0, 10);
  console.error(`Fetching data from ${API_BASE}...`);
  const results = [];

  for (const symbol of SYMBOLS) {
    try {
      const state = await fetchState(symbol);
      await sleep(FETCH_DELAY_MS);
      if (!state) {
        console.error(`  Skip ${symbol}: 404 or empty candles`);
        continue;
      }
      const row = analyzeSymbol(symbol, state);
      if (row) results.push(row);
    } catch (e) {
      console.error(`  Skip ${symbol}: ${e.message}`);
    }
  }

  if (results.length === 0) {
    console.error("No data retrieved. Check API availability and market hours.");
    process.exit(1);
  }

  console.log(formatTable(results, dateStr));

  const outPath = process.env.OUTPUT_JSON;
  if (outPath) {
    const fs = await import("fs");
    fs.writeFileSync(outPath, JSON.stringify({ date: dateStr, symbols: results }, null, 2));
    console.error(`\nWrote ${outPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

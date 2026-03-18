/**
 * Shared LTP and MII orderflow indicators.
 * Used by FootprintChart, OrderflowChart, HftScannerChart.
 */

const toMs = (t) => (t != null && t < 1e12 ? t * 1000 : t);

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

/**
 * Liquidity Trap Pressure
 */
export function computeLTP(candles, hftSeries, symbol) {
  if (!candles?.length) return [];
  const s = String(symbol || "").toUpperCase();
  const isIndex = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].some(n => s.includes(n));
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
    const delta = c.delta ?? (buyVol - sellVol);
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
      const openTime = c.open_time != null ? toMs(c.open_time) : (c.chartTime != null ? c.chartTime * 1000 : 0);
      const minKey = Math.floor(openTime / 60000) * 60;
      owpRaw = hftByMin.get(minKey) ?? 0;
    }

    raw.push({ open_time: c.open_time ?? (c.chartTime != null ? c.chartTime * 1000 : 0), chartTime: c.chartTime, dp, asRaw, asSign, ddNorm, owpRaw });
  }

  const asMax = Math.max(1, ...raw.map(r => r.asRaw));
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

  const owpVals = ltpValues.map(v => v.owpRaw).filter(x => x !== 0);
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

/**
 * Momentum Ignition Index
 */
export function computeMII(candles) {
  if (!candles?.length) return [];
  const W_VE = 20;
  const eps = 1e-8;

  const deltas = candles.map(c => c.delta ?? (c.buy_vol ?? 0) - (c.sell_vol ?? 0));
  const ema2 = _ema(deltas, 2);
  const ema5 = _ema(deltas, 5);

  const vols = candles.map(c => (c.buy_vol ?? 0) + (c.sell_vol ?? 0));
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
    const mii = 0.45 * daNorm + 0.30 * veNorm + 0.25 * peNorm;
    return { ...v, mii };
  });
}

/**
 * Delta Acceleration (DA) — rate of change of delta.
 * Captures when order flow momentum is accelerating vs decelerating.
 * DA > 0 = flow accelerating bullish; DA < 0 = accelerating bearish.
 * Uses tanh(daRaw * 0.5) for better signal spread (tuned 2026-03).
 */
export function computeDA(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;

  const raw = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const delta = c.delta ?? (c.buy_vol ?? 0) - (c.sell_vol ?? 0);
    const prevDelta = i > 0 ? (candles[i - 1].delta ?? (candles[i - 1].buy_vol ?? 0) - (candles[i - 1].sell_vol ?? 0)) : delta;
    const daRaw = Math.abs(prevDelta) + eps > 0 ? (delta - prevDelta) / (Math.abs(prevDelta) + eps) : 0;
    const da = Math.tanh(daRaw * 0.5);
    raw.push({ open_time: c.open_time, chartTime: c.chartTime, daRaw, delta, da });
  }

  return raw;
}

/**
 * OI-Delta Confluence (OID) — agreement or disagreement of OI change and delta.
 * OI up + delta up = long buildup (bullish). OI up + delta down = short buildup (bearish).
 * OID = +1 confluence, -1 divergence. Weighted by magnitude for strength.
 */
export function computeOID(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;

  const raw = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const delta = c.delta ?? (c.buy_vol ?? 0) - (c.sell_vol ?? 0);
    const oiChg = c.oi_change ?? 0;
    const signOi = oiChg > eps ? 1 : oiChg < -eps ? -1 : 0;
    const signDelta = delta > eps ? 1 : delta < -eps ? -1 : 0;
    const signProduct = signOi * signDelta; // +1 confluence, -1 divergence, 0 neutral
    const mag = Math.min(1, (Math.abs(oiChg) / 100 + Math.abs(delta) / 10000) * 0.5);
    const oidRaw = signProduct * (mag > 0 ? mag : 0.5);
    raw.push({ open_time: c.open_time, chartTime: c.chartTime, oidRaw, signProduct });
  }

  return raw.map((r) => {
    const oid = Math.max(-1, Math.min(1, r.oidRaw));
    return { ...r, oid };
  });
}

export const SIGNAL_THRESHOLD = 0.4;
export const LTP_THRESHOLD = 0.3;
export const VZP_THRESHOLD = 0.2;
export const DA_THRESHOLD = 0.2;    // tuned 2026-03: higher = less noise, same accuracy
export const OID_THRESHOLD = 0.35;  // tuned 2026-03
export const OID_CONTRARIAN = true; // divergence (neg) = expect up; confluence (pos) = expect down

/**
 * Volume Profile Tilt (VPT) — from footprint level data.
 * Uses intra-candle volume distribution: where is volume concentrated?
 * VPC = Σ(price × vol_at_level) / total_vol = volume-weighted price center
 * VPT = (VPC - mid) / range → positive = volume skewed up (buying at highs), negative = skewed down
 * Divergence: bearish candle + high VPT = absorption at highs (reversal down likely)
 */
export function computeVPT(candles) {
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

  const vptMax = Math.max(0.01, ...raw.map(r => Math.abs(r.vptRaw)));
  return raw.map((r) => {
    const vpt = Math.max(-1, Math.min(1, r.vptRaw / vptMax));
    return { ...r, vpt };
  });
}

/**
 * Volume Zone Pressure (VZP) — leading indicator from footprint level data.
 * Uses bid/ask zone volume imbalance: where is volume concentrated relative to mid?
 * VZP = (askVol - bidVol) / totalVol → positive = ask zone heavy (leading bearish), negative = bid zone heavy (leading bullish)
 * Predicts next bar direction. Fallback when levels missing: -sign(delta).
 */
export function computeVZP(candles) {
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

  const vzpMax = Math.max(0.01, ...raw.map(r => Math.abs(r.vzpRaw)));
  return raw.map((r) => {
    const vzp = Math.max(-1, Math.min(1, r.vzpRaw / vzpMax));
    return { ...r, vzp, vzpRaw: r.vzpRaw };
  });
}

/**
 * Context-Aware Events (CAE) — reversal and rally detection.
 * Combines VZP raw with trend context (prev 2/3 bar direction).
 * Returns REVERSAL_TOP, RALLY_END, RALLY_START, REVERSAL_BOTTOM when conditions align.
 */
/**
 * Range Expansion Reversal (REX) — NIFTY-specific indicator.
 * When bar range (high-low) >= mult × avg(range of last lookback bars), predict reversal.
 * Green bar + range expansion → bearish signal (-1); red bar + range expansion → bullish (1).
 * Tuned on NIFTY MAR FUT: lookback=5, mult=1.8 → 72% next-bar accuracy (min 20 sig).
 */
export function computeRangeExpansion(candles, lookback = 5, mult = 1.8) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const currRange = high - low;
    let rex = 0;
    if (i >= lookback) {
      const ranges = [];
      for (let j = i - lookback; j < i; j++) {
        const h = candles[j].high ?? Math.max(candles[j].open ?? 0, candles[j].close ?? 0);
        const l = candles[j].low ?? Math.min(candles[j].open ?? 1e9, candles[j].close ?? 1e9);
        ranges.push(h - l);
      }
      const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length || eps;
      if (currRange >= mult * avgRange) {
        rex = close > open ? -1 : close < open ? 1 : 0;
      }
    }
    out.push({
      open_time: c.open_time,
      chartTime: c.chartTime,
      rex,
      currRange,
      expanded: rex !== 0,
    });
  }
  return out;
}

export const REX_LOOKBACK = 5;
export const REX_MULT = 1.8;

export function computeContextEvents(candles) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  // Tuned on March futures (2026-03-18): stricter trend + VZP for higher accuracy
  const PREV3_UP = 8;
  const PREV3_DOWN = -8;
  const PREV2_UP = 8;
  const PREV2_FLAT = -1; // RALLY_START requires prev2Chg < -1 (actual down move)
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

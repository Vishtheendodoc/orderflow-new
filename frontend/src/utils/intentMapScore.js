/**
 * Intent Map Score (IMS) — composite order-flow metric.
 * Fuses DeltaScore, ImbalanceScore, AbsorptionScore, EffortResultScore, AuctionLocationScore.
 * Output: IMS in [-1, 1], plus regime and trap detection.
 */

const toMs = (t) => (t != null && t < 1e12 ? t * 1000 : t);

/** IST calendar date YYYY-MM-DD */
function istDateKey(ms) {
  const d = new Date(toMs(ms));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Add highBuy/highSell to levels if missing */
function ensureLevelImbalances(bars) {
  for (const b of bars) {
    const lvs = Object.values(b.levels || {}).filter((l) => l.price != null);
    if (!lvs.length) continue;
    const tBuy = lvs.reduce((s, l) => s + (l.buy_vol || 0), 0);
    const tSell = lvs.reduce((s, l) => s + (l.sell_vol || 0), 0);
    const avgB = tBuy / lvs.length;
    const avgS = tSell / lvs.length;
    const maxV = Math.max(1, ...lvs.map((l) => (l.buy_vol || 0) + (l.sell_vol || 0)));
    for (const lv of lvs) {
      const bv = lv.buy_vol || 0;
      const sv = lv.sell_vol || 0;
      lv.highBuy = avgB > 0 && bv >= avgB * 2 && bv > sv;
      lv.highSell = avgS > 0 && sv >= avgS * 2 && sv > bv;
      lv.volRatio = (bv + sv) / maxV;
    }
  }
  return bars;
}

/** VPOC + 70% value area for a slice of bars */
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
  let vpoc = 0,
    maxVol = 0;
  for (const [p, v] of profile) {
    if (v > maxVol) {
      maxVol = v;
      vpoc = p;
    }
  }
  const totalVol = [...profile.values()].reduce((s, v) => s + v, 0);
  if (totalVol <= 0) return null;
  const vaTarget = totalVol * 0.7;
  const byVolDesc = [...profile.entries()].sort((a, b) => b[1] - a[1]);
  const vaSet = new Set();
  let cumVA = 0;
  for (const [p, v] of byVolDesc) {
    vaSet.add(p);
    cumVA += v;
    if (cumVA >= vaTarget) break;
  }
  const vaPrices = [...vaSet].sort((a, b) => a - b);
  return { vpoc, vah: vaPrices[vaPrices.length - 1], val: vaPrices[0] };
}

/** [start, end] indices per IST day */
function istDayIndexRanges(bars) {
  if (!bars?.length) return [];
  const ranges = [];
  let s = 0;
  for (let i = 1; i <= bars.length; i++) {
    if (i === bars.length || istDateKey(bars[i].open_time) !== istDateKey(bars[i - 1].open_time)) {
      ranges.push([s, i - 1]);
      s = i;
    }
  }
  return ranges;
}

/** ATR(14) from ranges */
function computeATR(bars, period = 14) {
  if (!bars?.length) return 1;
  const ranges = bars.slice(-period).map((b) => {
    const h = b.high ?? Math.max(b.open ?? 0, b.close ?? 0);
    const l = b.low ?? Math.min(b.open ?? 999999, b.close ?? 999999);
    return h - l;
  });
  return ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 1;
}

/** Detect tick size from levels */
function detectTickSize(bars) {
  for (const c of bars) {
    const lvs = Object.values(c.levels || {})
      .filter((l) => l.price != null)
      .map((l) => +l.price)
      .sort((a, b) => a - b);
    if (lvs.length >= 2) {
      const d = Math.abs(lvs[1] - lvs[0]);
      if (d > 0) return d;
    }
  }
  return 0.5;
}

const DEFAULT_WEIGHTS = { w1: 0.2, w2: 0.2, w3: 0.2, w4: 0.2, w5: 0.2 };

/**
 * Compute Intent Map Score for each bar.
 * @param {Array} bars — bars with levels, delta, buy_vol, sell_vol, cvd
 * @param {Object} options — { weights, tickSize }
 * @returns {Array} bars with ims, imsDirection (+1|-1|0)
 */
export function computeIMS(bars, options = {}) {
  if (!bars?.length) return bars;
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const tickSize = options.tickSize ?? detectTickSize(bars);
  const eps = 1e-8;

  ensureLevelImbalances(bars);

  const dayRanges = istDayIndexRanges(bars);
  const sessionVA = new Map(); // dayKey -> { vpoc, vah, val }
  for (const [s, e] of dayRanges) {
    const slice = bars.slice(s, e + 1);
    const va = computeProfileValueArea(slice);
    if (va) {
      const dayKey = istDateKey(bars[s].open_time);
      sessionVA.set(dayKey, va);
    }
  }

  const atrArr = [];
  for (let i = 0; i < bars.length; i++) {
    atrArr.push(computeATR(bars.slice(0, i + 1)));
  }

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const delta = b.delta ?? (b.buy_vol ?? 0) - (b.sell_vol ?? 0);
    const totalVol = (b.buy_vol ?? 0) + (b.sell_vol ?? 0);
    const range = Math.max(eps, (b.high ?? b.close ?? 0) - (b.low ?? b.open ?? 0));
    const lvs = Object.values(b.levels || {});

    // 1. DeltaScore — normalized by vol + ATR
    const atr = atrArr[i] ?? 1;
    const deltaNorm = totalVol > 0 ? Math.abs(delta) / (totalVol * 0.3 + atr * 10 + eps) : 0;
    const deltaScore = delta >= 0 ? Math.min(1, deltaNorm) : -Math.min(1, deltaNorm);

    // 2. ImbalanceScore — count/weight imbalances
    let imbBuy = 0,
      imbSell = 0;
    for (const lv of lvs) {
      const vol = (lv.buy_vol || 0) + (lv.sell_vol || 0);
      if (lv.highBuy) imbBuy += vol;
      if (lv.highSell) imbSell += vol;
    }
    const imbTot = imbBuy + imbSell + eps;
    const imbScore = imbTot > 0 ? (imbBuy - imbSell) / imbTot : 0;

    // 3. AbsorptionScore — high vol at tight range (absorption = selling into strength or buying into weakness)
    const avgVolPerLevel = lvs.length > 0 ? totalVol / lvs.length : 0;
    let absorbRaw = 0;
    for (const lv of lvs) {
      const vol = (lv.buy_vol || 0) + (lv.sell_vol || 0);
      if (avgVolPerLevel > 0 && vol > avgVolPerLevel * 2 && range < atr * 0.5) {
        absorbRaw += vol / (avgVolPerLevel + eps);
      }
    }
    let absorbCap = absorbRaw;
    for (let k = 0; k <= i; k++) {
      const x = bars[k];
      const r = Math.max(eps, (x.high ?? 0) - (x.low ?? 999999));
      const tv = (x.buy_vol ?? 0) + (x.sell_vol ?? 0);
      const xLvs = Object.values(x.levels || {});
      const avg = xLvs.length ? tv / xLvs.length : eps;
      let ar = 0;
      const xAtr = atrArr[k] ?? 1;
      for (const lv of xLvs) {
        const v = (lv.buy_vol || 0) + (lv.sell_vol || 0);
        if (avg > 0 && v > avg * 2 && r < xAtr * 0.5) ar += v / avg;
      }
      absorbCap = Math.max(absorbCap, ar);
    }
    absorbCap = Math.max(1, absorbCap);
    const absorbScore = absorbCap > 0 ? Math.max(-1, Math.min(1, (absorbRaw / absorbCap) * (delta >= 0 ? 1 : -1))) : 0;

    // 4. EffortResultScore — vol per tick of range (high vol/tick = effort without result)
    const ticks = range / (tickSize || 0.5) + 1;
    const volPerTick = totalVol / ticks;
    const evMax = Math.max(eps, ...bars.slice(0, i + 1).map((x) => {
      const r = Math.max(eps, (x.high ?? 0) - (x.low ?? 999999));
      const tv = (x.buy_vol ?? 0) + (x.sell_vol ?? 0);
      return tv / (r / (tickSize || 0.5) + 1);
    }));
    const evNorm = evMax > 0 ? volPerTick / evMax : 0;
    const effortScore = delta >= 0 ? (1 - evNorm) : -(1 - evNorm);

    // 5. AuctionLocationScore — VPOC position in bar
    const dayKey = istDateKey(b.open_time);
    const va = sessionVA.get(dayKey);
    let auctionScore = 0;
    if (va && lvs.length > 0) {
      const barLow = b.low ?? Math.min(...lvs.map((l) => l.price));
      const barHigh = b.high ?? Math.max(...lvs.map((l) => l.price));
      const barRange = barHigh - barLow || eps;
      const vpocPos = (va.vpoc - barLow) / barRange;
      if (vpocPos >= 0.66) auctionScore = 0.5;
      else if (vpocPos <= 0.33) auctionScore = -0.5;
    }

    const ims =
      weights.w1 * deltaScore +
      weights.w2 * imbScore +
      weights.w3 * absorbScore +
      weights.w4 * effortScore +
      weights.w5 * auctionScore;
    const clamped = Math.max(-1, Math.min(1, ims));
    b.ims = clamped;
    b.imsDirection = clamped > 0.1 ? 1 : clamped < -0.1 ? -1 : 0;
  }
  return bars;
}

/**
 * Compute regime per bar: initiative_buy | responsive_sell | absorption
 */
export function computeRegime(bars, window = 5) {
  if (!bars?.length) return bars;
  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = bars.slice(start, i + 1);
    const meanIms = slice.reduce((s, b) => s + (b.ims ?? 0), 0) / slice.length;
    const priceChg = slice.length >= 2
      ? (slice[slice.length - 1].close ?? 0) - (slice[0].open ?? 0)
      : 0;
    const avgRange = slice.reduce((s, b) => s + Math.max(0, (b.high ?? 0) - (b.low ?? 999999)), 0) / slice.length;
    const avgVol = slice.reduce((s, b) => s + (b.buy_vol ?? 0) + (b.sell_vol ?? 0), 0) / slice.length;

    if (meanIms > 0.2 && priceChg > 0) bars[i].regime = "initiative_buy";
    else if (meanIms < -0.2 && priceChg < 0) bars[i].regime = "responsive_sell";
    else if (avgRange < avgVol * 0.001 && Math.abs(meanIms) < 0.3) bars[i].regime = "absorption";
    else bars[i].regime = "neutral";
  }
  return bars;
}

/**
 * Detect trapped traders: extreme IMS but next 1–3 bars reverse.
 */
export function detectTrap(bars, lookAhead = 3, imsThreshold = 0.6) {
  if (!bars?.length) return bars;
  for (let i = 0; i < bars.length - 1; i++) {
    const ims = bars[i].ims ?? 0;
    if (Math.abs(ims) < imsThreshold) continue;
    const p0 = bars[i].close ?? bars[i].open ?? 0;
    let trapped = false;
    for (let j = 1; j <= Math.min(lookAhead, bars.length - 1 - i); j++) {
      const pJ = bars[i + j].close ?? bars[i + j].open ?? 0;
      if (ims > 0 && pJ < p0 - 0.01) {
        trapped = true;
        break;
      }
      if (ims < 0 && pJ > p0 + 0.01) {
        trapped = true;
        break;
      }
    }
    bars[i].trap = trapped ? (ims > 0 ? "trapped_buyers" : "trapped_sellers") : null;
  }
  return bars;
}

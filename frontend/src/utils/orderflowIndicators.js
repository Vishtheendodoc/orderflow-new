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

export const SIGNAL_THRESHOLD = 0.4;

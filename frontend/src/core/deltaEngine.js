/**
 * deltaEngine — maintain cumulative delta series across candles.
 * No React; used from worker.
 */

/**
 * Build cumulative delta array from candles (each candle's totalDelta).
 * @param {import("../models/FootprintCandle.js").FootprintCandle[]} candles sorted by startTime
 * @returns {number[]} cumulative deltas per candle
 */
export function buildCumulativeDelta(candles) {
  const out = [];
  let cvd = 0;
  for (const c of candles) {
    cvd += c.totalDelta;
    out.push(cvd);
  }
  return out;
}

/**
 * CVD divergence: price makes higher high but CVD makes lower high (bearish) or vice versa (bullish).
 * @param {number[]} prices last N closes
 * @param {number[]} cvds last N CVD values
 * @returns {{ type: 'bearish'|'bullish'|null, strength: number }}
 */
export function detectCVDDivergence(prices, cvds) {
  if (prices.length < 3 || cvds.length < 3) return { type: null, strength: 0 };
  const n = prices.length;
  const p1 = prices[n - 3];
  const p2 = prices[n - 2];
  const p3 = prices[n - 1];
  const c1 = cvds[n - 3];
  const c2 = cvds[n - 2];
  const c3 = cvds[n - 1];
  // Bearish: price HH, CVD LH
  if (p3 > p2 && p2 > p1 && c3 < c2 && c2 < c1) {
    return { type: "bearish", strength: Math.abs(c3 - c1) };
  }
  // Bullish: price LL, CVD HL
  if (p3 < p2 && p2 < p1 && c3 > c2 && c2 > c1) {
    return { type: "bullish", strength: Math.abs(c3 - c1) };
  }
  return { type: null, strength: 0 };
}

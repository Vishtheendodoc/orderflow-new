/**
 * imbalanceEngine — detect bid/ask imbalance (e.g. 3:1).
 * No React; used from worker.
 */

const DEFAULT_RATIO = 3; // 3:1

/**
 * Compute average bid and ask volume across levels (for threshold).
 * @param {Map<number, import("../models/PriceLevel.js").PriceLevel>} priceLevels
 * @returns {{ avgBid: number, avgAsk: number }}
 */
function averages(priceLevels) {
  let totalBid = 0;
  let totalAsk = 0;
  let n = 0;
  priceLevels.forEach((lv) => {
    totalBid += lv.bidVolume;
    totalAsk += lv.askVolume;
    n += 1;
  });
  const avgBid = n ? totalBid / n : 0;
  const avgAsk = n ? totalAsk / n : 0;
  return { avgBid, avgAsk };
}

/**
 * Detect imbalance at each level: "buy" if bid >> ask (e.g. 3:1), "sell" if ask >> bid.
 * @param {import("../models/FootprintCandle.js").FootprintCandle} candle
 * @param {number} ratio threshold (e.g. 3 for 3:1)
 */
export function detectImbalance(candle, ratio = DEFAULT_RATIO) {
  candle.imbalance.clear();
  const { avgBid, avgAsk } = averages(candle.priceLevels);

  candle.priceLevels.forEach((lv, price) => {
    const b = lv.bidVolume;
    const a = lv.askVolume;
    if (avgBid > 0 && b >= avgBid * ratio && b > a) {
      candle.imbalance.set(price, "buy");
    } else if (avgAsk > 0 && a >= avgAsk * ratio && a > b) {
      candle.imbalance.set(price, "sell");
    }
  });
}

/**
 * Stacked imbalance: N consecutive levels with same imbalance.
 * @param {import("../models/FootprintCandle.js").FootprintCandle} candle
 * @param {number} minStack
 */
export function detectStackedImbalance(candle, minStack = 2) {
  const levels = Array.from(candle.priceLevels.entries()).sort((a, b) => b[0] - a[0]);
  for (let i = 0; i <= levels.length - minStack; i++) {
    const imb = candle.imbalance.get(levels[i][0]);
    if (!imb) continue;
    let ok = true;
    for (let j = 1; j < minStack; j++) {
      if (candle.imbalance.get(levels[i + j][0]) !== imb) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (let j = 0; j < minStack; j++) {
        candle.imbalance.set(levels[i + j][0], imb === "buy" ? "buy_stacked" : "sell_stacked");
      }
      i += minStack - 1;
    }
  }
}

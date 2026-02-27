/**
 * footprintEngine — update candle price levels, OHLC, delta, volume.
 * No React; used from worker.
 */

/**
 * Apply one trade to a footprint candle: update OHLC, volume, delta, price levels.
 * @param {import("../models/FootprintCandle.js").FootprintCandle} candle
 * @param {{ price: number, qty: number, side: string }} trade
 */
export function applyTradeToCandle(candle, trade) {
  const price = trade.price;
  const qty = trade.qty ?? 0;
  const isBuy = trade.side === "buy" || trade.side === "B" || trade.side === "bid";

  const level = candle.getLevel(price);
  if (isBuy) {
    level.addBid(qty);
  } else {
    level.addAsk(qty);
  }

  if (candle.open == null) {
    candle.open = price;
    candle.high = price;
    candle.low = price;
    candle.close = price;
  } else {
    if (price > candle.high) candle.high = price;
    if (price < candle.low) candle.low = price;
    candle.close = price;
  }

  candle.totalVolume += qty;
  candle.totalDelta += isBuy ? qty : -qty;
}

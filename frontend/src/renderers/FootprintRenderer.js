/**
 * FootprintRenderer - pure drawing: footprint chart. Never modifies data.
 */

const BUY = "#26a69a";
const SELL = "#ef5350";
const BUY_MID = "rgba(38,166,154,0.65)";
const SELL_MID = "rgba(239,83,80,0.65)";
const BUY_HL = "rgba(38,166,154,0.2)";
const SELL_HL = "rgba(239,83,80,0.2)";
const MONO = "JetBrains Mono, Consolas, monospace";

function roundRect(ctx, x, y, w, h, r) {
  if (r <= 0) { ctx.rect(x, y, w, h); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function drawFootprint(ctx, params) {
  const candles = params.candles || [];
  const firstIndex = params.firstIndex ?? 0;
  const lastIndex = params.lastIndex ?? candles.length - 1;
  const priceToY = params.priceToY || (() => 0);
  const indexToX = params.indexToX || (() => 0);
  const barSpacing = params.barSpacing ?? 14;
  const chartTop = params.chartTop ?? 0;
  const chartHeight = params.chartHeight ?? 300;
  const candleWidth = params.candleWidth ?? 4;

  const halfW = candleWidth / 2;
  const numOffset = 4;
  const rowMin = 12;
  const rowMax = 24;

  for (let i = firstIndex; i <= lastIndex; i++) {
    const c = candles[i];
    if (!c) continue;

    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const bull = close >= open;
    const x = indexToX(i);
    const left = x - halfW;

    const levels = c.priceLevels
      ? Object.entries(c.priceLevels).map(([p, lv]) => ({
          price: Number(p),
          bidVolume: lv.bidVolume ?? lv.buy_vol ?? 0,
          askVolume: lv.askVolume ?? lv.sell_vol ?? 0,
          totalVolume: (lv.bidVolume ?? lv.buy_vol ?? 0) + (lv.askVolume ?? lv.sell_vol ?? 0),
          imbalance: c.imbalance ? c.imbalance[String(p)] : null,
        }))
      : [];
    const sortedLevels = levels.sort((a, b) => b.price - a.price);
    const rowHeight = Math.max(rowMin, Math.min(rowMax, Math.floor(chartHeight / Math.max(sortedLevels.length, 20))));
    const fontSz = Math.max(8, Math.min(11, rowHeight - 2));

    for (const lv of sortedLevels) {
      const ly = priceToY(lv.price);
      const rowY = ly - rowHeight / 2;
      if (rowY + rowHeight < chartTop || rowY > chartTop + chartHeight) continue;

      const imb = lv.imbalance;
      if (imb === "buy" || imb === "buy_stacked") {
        ctx.fillStyle = BUY_HL;
        ctx.fillRect(left, rowY, candleWidth, rowHeight);
        ctx.fillStyle = BUY;
        ctx.fillRect(left, rowY, 2, rowHeight);
      } else if (imb === "sell" || imb === "sell_stacked") {
        ctx.fillStyle = SELL_HL;
        ctx.fillRect(left, rowY, candleWidth, rowHeight);
        ctx.fillStyle = SELL;
        ctx.fillRect(left + candleWidth - 2, rowY, 2, rowHeight);
      }

      const sellT = String(Math.round(lv.askVolume ?? 0));
      const buyT = String(Math.round(lv.bidVolume ?? 0));
      ctx.font = (imb ? "600" : "500") + " " + fontSz + "px " + MONO;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      ctx.fillStyle = imb === "sell" || imb === "sell_stacked" ? SELL : SELL_MID;
      ctx.fillText(sellT, x - halfW - numOffset, ly);
      ctx.textAlign = "left";
      ctx.fillStyle = imb === "buy" || imb === "buy_stacked" ? BUY : BUY_MID;
      ctx.fillText(buyT, x + halfW + numOffset, ly);
    }

    ctx.font = "600 " + fontSz + "px " + MONO;
    ctx.textAlign = "left";
    const openY = priceToY(open);
    const closeY = priceToY(close);
    const highY = priceToY(high);
    const lowY = priceToY(low);
    const bodyTop = Math.min(openY, closeY);
    const bodyH = Math.max(2, Math.abs(closeY - openY));

    ctx.fillStyle = bull ? BUY : SELL;
    ctx.fillRect(x - 1, highY, 2, Math.max(1, lowY - highY));
    ctx.fillStyle = bull ? "rgba(38,166,154,0.14)" : "rgba(239,83,80,0.14)";
    ctx.strokeStyle = bull ? BUY : SELL;
    ctx.lineWidth = 1;
    roundRect(ctx, left + 1, bodyTop, Math.max(0, candleWidth - 2), bodyH, 1);
    ctx.fill();
    ctx.stroke();
  }
}

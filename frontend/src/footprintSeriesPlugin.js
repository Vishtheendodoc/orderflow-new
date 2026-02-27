/**
 * Lightweight Charts custom series: Footprint (volume at price per bar).
 * Draws level rows with buy/sell volume, imbalance highlight, and candle wick/body.
 * Compatible with lightweight-charts v4.
 */

const BUY = "#26a69a";
const SELL = "#ef5350";
const BUY_MID = "rgba(38,166,154,0.65)";
const SELL_MID = "rgba(239,83,80,0.65)";
const BODY_BULL = "rgba(38,166,154,0.14)";
const BODY_BEAR = "rgba(239,83,80,0.14)";
const BUY_HL = "rgba(38,166,154,0.14)";
const SELL_HL = "rgba(239,83,80,0.14)";
const BORDER = "rgba(0,0,0,0.06)";
const ROW_MIN = 12;
const ROW_MAX = 24;
const MONO = "'JetBrains Mono','Consolas',monospace";

function roundRect(ctx, x, y, w, h, r) {
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
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

/**
 * Custom data for each footprint bar. Extends CustomData (must have time).
 * levels: array of { price, buy_vol, sell_vol, highBuy?, highSell? }
 */
export function isFootprintWhitespace(data) {
  if (!data || data.time === undefined) return true;
  const d = data;
  return (
    (d.open == null && d.close == null) ||
    (d.levels != null && !Array.isArray(d.levels))
  );
}

/**
 * Footprint custom pane view for lightweight-charts.
 * Use with chart.addCustomSeries(FootprintPaneView).
 */
export class FootprintPaneView {
  constructor() {
    this._data = { bars: [], barSpacing: 30 };
  }

  renderer() {
    const self = this;
    return {
      draw(target, priceConverter, isHovered) {
        target.useMediaCoordinateSpace((scope) => {
          const ctx = scope.context;
          const height = scope.mediaSize.height;
          const width = scope.mediaSize.width;
          const { bars, barSpacing } = self._data;
          if (!bars || bars.length === 0) return;

          const gap = 2;
          const barW = Math.max(4, barSpacing - gap);
          const priceToY = (price) => {
            const coord = priceConverter(price);
            return coord != null ? coord : height / 2;
          };

          ctx.save();
          try {
            for (const bar of bars) {
              const { x, originalData: d } = bar;
              if (d == null || isFootprintWhitespace(d)) continue;
              if (x + barW / 2 < 0 || x - barW / 2 > width) continue;
              const open = d.open ?? d.close ?? 0;
              const close = d.close ?? d.open ?? 0;
              const high = d.high ?? Math.max(open, close);
              const low = d.low ?? Math.min(open, close);
              const bull = close >= open;
              const left = x - barW / 2;
              const openY = priceToY(open);
              const closeY = priceToY(close);
              const highY = priceToY(high);
              const lowY = priceToY(low);
              const bodyTop = Math.min(openY, closeY);
              const bodyH = Math.max(2, Math.abs(closeY - openY));
              const midX = x;

              const levels = Array.isArray(d.levels) ? d.levels : [];
              const rowHeight = Math.max(
                ROW_MIN,
                Math.min(ROW_MAX, Math.floor(height / Math.max(levels.length, 20)))
              );
              const fontSz = Math.max(8, Math.min(11, rowHeight - 2));
              ctx.font = `600 ${fontSz}px ${MONO}`;
              ctx.textBaseline = "middle";

              for (const lv of levels) {
                const ly = priceToY(lv.price);
                const rowY = ly - rowHeight / 2;
                if (rowY + rowHeight < 0 || rowY > height) continue;

                if (lv.highBuy) {
                  ctx.fillStyle = BUY_HL;
                  ctx.fillRect(left, rowY, barW, rowHeight);
                  ctx.fillStyle = BUY;
                  ctx.fillRect(left, rowY, 2, rowHeight);
                } else if (lv.highSell) {
                  ctx.fillStyle = SELL_HL;
                  ctx.fillRect(left, rowY, barW, rowHeight);
                  ctx.fillStyle = SELL;
                  ctx.fillRect(left + barW - 2, rowY, 2, rowHeight);
                }

                const sellT = String(Math.round(lv.sell_vol || 0));
                const buyT = String(Math.round(lv.buy_vol || 0));
                const sw = Math.min(barW / 2 - 3, Math.max(14, ctx.measureText(sellT).width + 6));
                const bw = Math.min(barW / 2 - 3, Math.max(14, ctx.measureText(buyT).width + 6));

                ctx.fillStyle = lv.highSell ? SELL : SELL_MID;
                roundRect(ctx, left + 2, rowY + 1, sw, rowHeight - 2, (rowHeight - 2) / 2);
                ctx.fill();
                ctx.fillStyle = "#fff";
                ctx.textAlign = "center";
                ctx.fillText(sellT, left + 2 + sw / 2, ly);

                ctx.fillStyle = lv.highBuy ? BUY : BUY_MID;
                roundRect(ctx, left + barW - 2 - bw, rowY + 1, bw, rowHeight - 2, (rowHeight - 2) / 2);
                ctx.fill();
                ctx.fillStyle = "#fff";
                ctx.fillText(buyT, left + barW - 2 - bw / 2, ly);
              }

              ctx.fillStyle = bull ? BUY : SELL;
              ctx.fillRect(midX - 1, highY, 2, Math.max(1, lowY - highY));

              ctx.fillStyle = bull ? BODY_BULL : BODY_BEAR;
              ctx.strokeStyle = bull ? BUY : SELL;
              ctx.lineWidth = 1;
              roundRect(ctx, left + 2, bodyTop, barW - 4, bodyH, 2);
              ctx.fill();
              ctx.stroke();
            }
          } finally {
            ctx.restore();
          }
        });
      },
    };
  }

  update(data, seriesOptions) {
    this._data = {
      bars: data.bars || [],
      barSpacing: data.barSpacing ?? 30,
    };
  }

  priceValueBuilder(plotRow) {
    if (isFootprintWhitespace(plotRow)) return [];
    const low = plotRow.low ?? plotRow.open ?? plotRow.close ?? 0;
    const high = plotRow.high ?? plotRow.open ?? plotRow.close ?? 0;
    const close = plotRow.close ?? plotRow.open ?? 0;
    return [low, high, close];
  }

  isWhitespace(data) {
    return isFootprintWhitespace(data);
  }

  defaultOptions() {
    return { color: BUY };
  }
}

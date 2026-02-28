/**
 * LiquidityHeatmap — Bookmap-style canvas visualisation of the order book.
 *
 * X-axis  = time  (newest column on the right, scrolls left)
 * Y-axis  = price (centered on current LTP)
 * Colour  = bid size (teal gradient) / ask size (red gradient)
 * Bright bars mark large resting limit orders — potential S/R zones.
 *
 * Polls  GET /api/heatmap/{symbol}  every POLL_MS milliseconds.
 */

import { useRef, useEffect, useCallback, useState } from "react";

const POLL_MS          = 1_500;     // refresh rate
const PRICE_STEP_FRAC  = 0.0005;   // tick grid: 0.05% of LTP (auto-adapts)
const ROWS_VISIBLE     = 80;       // price levels shown vertically
const LOG_SCALE        = true;     // log-compress qty for colour mapping

function lerp(a, b, t) { return a + (b - a) * t; }

function qtyToAlpha(qty, maxQty) {
  if (!maxQty || qty <= 0) return 0;
  const t = LOG_SCALE ? Math.log1p(qty) / Math.log1p(maxQty) : qty / maxQty;
  return Math.min(1, t);
}

export default function LiquidityHeatmap({ symbol, apiBase, height = 420 }) {
  const canvasRef  = useRef(null);
  const dataRef    = useRef([]);    // snapshots[]
  const rafRef     = useRef(null);
  const [status, setStatus] = useState("waiting…");

  /* ── fetch heatmap data ─────────────────────────────────────── */
  const fetchData = useCallback(async () => {
    if (!symbol || !apiBase) return;
    try {
      const url = `${apiBase}/api/heatmap/${encodeURIComponent(symbol)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = await res.json();
      const snaps = json.snapshots || [];
      if (snaps.length > 0) {
        dataRef.current = snaps;
        setStatus(`${snaps.length} snapshots | LTP ${snaps.at(-1)?.ltp ?? "–"}`);
      } else {
        setStatus("no data (DHAN_TOKEN_DEPTH not set or no index futures)");
      }
    } catch {
      setStatus("fetch error");
    }
  }, [symbol, apiBase]);

  /* ── canvas drawing ─────────────────────────────────────────── */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx    = canvas.getContext("2d");
    const W      = canvas.width;
    const H      = canvas.height;
    const snaps  = dataRef.current;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, W, H);

    if (!snaps.length) {
      ctx.fillStyle = "#555";
      ctx.font = "13px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for order-book data…", W / 2, H / 2);
      return;
    }

    const latest  = snaps.at(-1);
    const ltp     = latest.ltp || 0;
    if (ltp <= 0) return;

    // Dynamic tick size — smallest step in the depth book
    let minStep = ltp * PRICE_STEP_FRAC;
    for (const s of snaps.slice(-10)) {
      const allPx = [...(s.bids || []), ...(s.asks || [])].map(l => l.p).filter(Boolean);
      if (allPx.length >= 2) {
        const sorted = [...allPx].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
          const diff = sorted[i] - sorted[i - 1];
          if (diff > 0) minStep = Math.min(minStep, diff);
        }
        break;
      }
    }
    const TICK = Math.max(minStep, ltp * 0.00005);

    // Visible price range
    const priceHigh = ltp + (ROWS_VISIBLE / 2) * TICK;
    const priceLow  = ltp - (ROWS_VISIBLE / 2) * TICK;
    const priceRange = priceHigh - priceLow;

    const LABEL_W  = 68;
    const plotW    = W - LABEL_W;
    const colW     = Math.max(1, plotW / snaps.length);

    // Find global max qty for colour normalisation
    let maxQty = 1;
    for (const s of snaps) {
      for (const l of [...(s.bids || []), ...(s.asks || [])]) {
        if (l.q > maxQty) maxQty = l.q;
      }
    }

    // Draw each snapshot column
    snaps.forEach((snap, col) => {
      const x = LABEL_W + col * colW;

      const drawLevels = (levels, isBid) => {
        for (const lv of levels) {
          const p = lv.p, q = lv.q;
          if (p < priceLow || p > priceHigh || q <= 0) continue;
          const yFrac = (priceHigh - p) / priceRange;
          const y     = yFrac * H;
          const rowH  = Math.max(1, (TICK / priceRange) * H);
          const alpha = qtyToAlpha(q, maxQty);

          if (isBid) {
            ctx.fillStyle = `rgba(0,200,150,${(alpha * 0.85).toFixed(3)})`;
          } else {
            ctx.fillStyle = `rgba(220,50,50,${(alpha * 0.85).toFixed(3)})`;
          }
          ctx.fillRect(x, y - rowH / 2, colW, rowH);
        }
      };

      drawLevels(snap.bids || [], true);
      drawLevels(snap.asks || [], false);
    });

    // LTP line
    const ltpY = ((priceHigh - ltp) / priceRange) * H;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(LABEL_W, ltpY);
    ctx.lineTo(W, ltpY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Price axis labels (right side)
    ctx.fillStyle   = "#aaa";
    ctx.font        = "10px monospace";
    ctx.textAlign   = "right";
    const labelStep = Math.max(1, Math.floor(ROWS_VISIBLE / 8));
    for (let i = 0; i <= ROWS_VISIBLE; i += labelStep) {
      const price = priceHigh - i * TICK;
      const y     = (i / ROWS_VISIBLE) * H;
      ctx.fillStyle = "#555";
      ctx.fillRect(0, y, LABEL_W - 2, 1);
      ctx.fillStyle = "#aaa";
      ctx.fillText(price.toFixed(0), LABEL_W - 4, y + 4);
    }

    // LTP label
    ctx.fillStyle   = "#fff";
    ctx.font        = "bold 11px monospace";
    ctx.textAlign   = "right";
    ctx.fillText(ltp.toFixed(0), LABEL_W - 4, ltpY + 4);
  }, []);

  /* ── animation loop ─────────────────────────────────────────── */
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [draw]);

  /* ── polling ────────────────────────────────────────────────── */
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  /* ── resize canvas ──────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = height;
    });
    ro.observe(canvas);
    canvas.width  = canvas.offsetWidth || 700;
    canvas.height = height;
    return () => ro.disconnect();
  }, [height]);

  return (
    <div style={{ position: "relative", width: "100%", background: "#0d1117", borderRadius: 6 }}>
      {/* Legend */}
      <div style={{
        position: "absolute", top: 6, left: 76, display: "flex", gap: 16,
        fontSize: 11, zIndex: 2, pointerEvents: "none",
      }}>
        <span style={{ color: "#00c896" }}>■ Bids (buy orders)</span>
        <span style={{ color: "#dc3232" }}>■ Asks (sell orders)</span>
        <span style={{ color: "#888" }}>{status}</span>
      </div>
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height }}
      />
    </div>
  );
}

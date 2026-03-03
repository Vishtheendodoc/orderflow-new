/**
 * LiquidityHeatmap — Live Depth of Market (DOM) view.
 *
 * Shows real-time bid/ask levels from the 200-level Dhan depth feed:
 *  • Numbered qty at each price level (not a blurry colour map)
 *  • Proportional bars (ask = red left, bid = green right)
 *  • ⚡ Wall labels on levels whose cumulative qty is top-10% (S/R zones)
 *  • Key-walls summary panel beneath the DOM
 *
 * Polls GET /api/heatmap/{symbol} every POLL_MS ms.
 */

import { useRef, useEffect, useCallback, useState, useMemo } from "react";

const POLL_MS   = 600;   // 600 ms refresh — real-time feel
const LEVELS    = 20;    // rows above + below LTP

const MONO = "'JetBrains Mono','Fira Mono','Consolas',monospace";

function fmtQ(q) {
  if (q >= 1e6) return (q / 1e6).toFixed(1) + "M";
  if (q >= 1e3) return (q / 1e3).toFixed(1) + "K";
  return String(Math.round(q));
}

function fmtP(p, decimals = 2) {
  return Number(p).toFixed(decimals);
}

/** Detect price-decimal precision from the levels */
function detectDecimals(levels) {
  for (const l of levels) {
    const s = String(l.p);
    const dot = s.indexOf(".");
    if (dot >= 0) return Math.min(s.length - dot - 1, 2);
  }
  return 0;
}

export default function LiquidityHeatmap({ symbol, apiBase, height = 520 }) {
  const canvasRef = useRef(null);
  const dataRef   = useRef([]);
  const rafRef    = useRef(null);
  const [status, setStatus]   = useState("waiting…");
  const [walls,  setWalls]    = useState({ bids: [], asks: [] });

  /* ── fetch ── */
  const fetchData = useCallback(async () => {
    if (!symbol || !apiBase) return;
    try {
      const res  = await fetch(`${apiBase}/api/heatmap/${encodeURIComponent(symbol)}`);
      if (!res.ok) return;
      const json = await res.json();
      const snaps = json.snapshots || [];
      if (!snaps.length) { setStatus("no data — DHAN_TOKEN_DEPTH not set?"); return; }
      dataRef.current = snaps;

      const latest = snaps.at(-1);
      setStatus(`LTP ${(latest?.ltp ?? "–")}  |  ${snaps.length} snaps`);

      /* ── detect S/R walls: cumulative qty across all stored snapshots ── */
      const cumBid = new Map();
      const cumAsk = new Map();
      for (const s of snaps) {
        for (const l of s.bids || []) {
          const k = Math.round(l.p * 100);
          cumBid.set(k, (cumBid.get(k) || 0) + (l.q || 0));
        }
        for (const l of s.asks || []) {
          const k = Math.round(l.p * 100);
          cumAsk.set(k, (cumAsk.get(k) || 0) + (l.q || 0));
        }
      }
      const ltp  = latest?.ltp || 0;
      const topN = 5;
      const sortedBid = [...cumBid.entries()].sort((a, b) => b[1] - a[1]);
      const sortedAsk = [...cumAsk.entries()].sort((a, b) => b[1] - a[1]);
      setWalls({
        bids: sortedBid.slice(0, topN).map(([k, v]) => ({ price: k / 100, qty: v })).filter(w => w.price < ltp),
        asks: sortedAsk.slice(0, topN).map(([k, v]) => ({ price: k / 100, qty: v })).filter(w => w.price > ltp),
      });
    } catch {
      setStatus("fetch error");
    }
  }, [symbol, apiBase]);

  /* ── canvas draw ── */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W   = canvas.width;
    const H   = canvas.height;
    const snaps = dataRef.current;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, W, H);

    if (!snaps.length) {
      ctx.fillStyle = "#556";
      ctx.font = `13px ${MONO}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Waiting for depth data…", W / 2, H / 2);
      return;
    }

    const latest  = snaps.at(-1);
    const ltp     = latest.ltp || 0;
    if (ltp <= 0) return;

    const allLevels = [...(latest.bids || []), ...(latest.asks || [])];
    const dec = detectDecimals(allLevels);

    /* asks sorted ascending (lowest ask first = closest to LTP) */
    const asks = [...(latest.asks || [])].sort((a, b) => a.p - b.p).slice(0, LEVELS);
    /* bids sorted descending (highest bid first = closest to LTP) */
    const bids = [...(latest.bids || [])].sort((a, b) => b.p - a.p).slice(0, LEVELS);

    const maxQty = [...asks, ...bids].reduce((m, l) => Math.max(m, l.q || 0), 1);

    /* S/R threshold: top-10% by current snapshot qty */
    const allQtys = [...asks, ...bids].map(l => l.q).sort((a, b) => b - a);
    const srThreshold = allQtys[Math.floor(allQtys.length * 0.1)] || maxQty * 0.6;

    /* layout */
    const HEADER_H = 32;
    const ROW_H    = Math.max(14, Math.floor((H - HEADER_H) / (LEVELS * 2 + 1)));
    const PRICE_W  = 74;
    const QTY_W    = 52;
    const SR_W     = 24;
    const BAR_W    = Math.max(10, (W / 2 - PRICE_W / 2 - QTY_W - SR_W - 6));
    const MID_X    = W / 2;

    /* column x positions */
    const askBarX  = MID_X - PRICE_W / 2 - QTY_W - BAR_W; // ask bar starts here
    const askQtyX  = MID_X - PRICE_W / 2 - SR_W - 4;       // ask qty right-edge
    const bidQtyX  = MID_X + PRICE_W / 2 + SR_W + 4;       // bid qty left-edge
    const bidBarX  = MID_X + PRICE_W / 2 + QTY_W + SR_W;   // bid bar starts here

    /* ── Header ── */
    ctx.fillStyle = "#141824";
    ctx.fillRect(0, 0, W, HEADER_H);
    ctx.font = `bold 11px ${MONO}`;
    ctx.textBaseline = "middle";

    /* column labels */
    ctx.fillStyle = "#dc3545";
    ctx.textAlign = "center";
    ctx.fillText("ASKS  ▼", askBarX + BAR_W / 2, HEADER_H / 2);

    ctx.fillStyle = "#888";
    ctx.textAlign = "center";
    ctx.fillText("PRICE", MID_X, HEADER_H / 2);

    ctx.fillStyle = "#00c896";
    ctx.textAlign = "center";
    ctx.fillText("▲  BIDS", bidBarX + BAR_W / 2, HEADER_H / 2);

    /* ── Ask rows (above LTP) — drawn top-to-bottom, farthest first ── */
    const askRows = [...asks].reverse(); // farthest ask at top
    askRows.forEach((lv, i) => {
      const rowY = HEADER_H + i * ROW_H;
      const isSR = lv.q >= srThreshold;

      /* row tint */
      ctx.fillStyle = isSR ? "rgba(220,50,50,0.10)" : (i % 2 === 0 ? "rgba(220,50,50,0.03)" : "transparent");
      ctx.fillRect(0, rowY, W, ROW_H);

      /* ask bar — right-aligned against price column */
      const barW = Math.max(2, (lv.q / maxQty) * BAR_W);
      ctx.fillStyle = isSR ? "rgba(220,50,50,0.75)" : "rgba(220,50,50,0.30)";
      ctx.fillRect(MID_X - PRICE_W / 2 - QTY_W - SR_W - barW, rowY + 2, barW, ROW_H - 4);

      /* ask qty */
      ctx.font = isSR ? `bold 10px ${MONO}` : `10px ${MONO}`;
      ctx.fillStyle = isSR ? "#ff6b6b" : "#aa4444";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(fmtQ(lv.q), askQtyX, rowY + ROW_H / 2);

      /* price */
      ctx.font = `10px ${MONO}`;
      ctx.fillStyle = "#6870a0";
      ctx.textAlign = "center";
      ctx.fillText(fmtP(lv.p, dec), MID_X, rowY + ROW_H / 2);

      /* S/R label */
      if (isSR) {
        ctx.font = `bold 9px ${MONO}`;
        ctx.fillStyle = "#ff5555";
        ctx.textAlign = "left";
        ctx.fillText("⚡R", MID_X + PRICE_W / 2 + 3, rowY + ROW_H / 2);
      }
    });

    /* ── LTP row ── */
    const ltpRowY = HEADER_H + asks.length * ROW_H;
    ctx.fillStyle = "rgba(251,191,36,0.14)";
    ctx.fillRect(0, ltpRowY, W, ROW_H);
    ctx.strokeStyle = "rgba(251,191,36,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, ltpRowY); ctx.lineTo(W, ltpRowY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, ltpRowY + ROW_H); ctx.lineTo(W, ltpRowY + ROW_H); ctx.stroke();
    ctx.font = `bold 11px ${MONO}`;
    ctx.fillStyle = "#fbbf24";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`▶  ${fmtP(ltp, dec)}  ◀`, MID_X, ltpRowY + ROW_H / 2);

    /* best bid/ask spread */
    const bestAsk = asks[0]?.p;
    const bestBid = bids[0]?.p;
    if (bestAsk && bestBid) {
      const spread = bestAsk - bestBid;
      ctx.font = `9px ${MONO}`;
      ctx.fillStyle = "#888";
      ctx.textAlign = "right";
      ctx.fillText(`sprd ${spread.toFixed(dec)}`, W - 6, ltpRowY + ROW_H / 2);
    }

    /* ── Bid rows (below LTP) ── */
    bids.forEach((lv, i) => {
      const rowY = ltpRowY + ROW_H + i * ROW_H;
      if (rowY + ROW_H > H) return;
      const isSR = lv.q >= srThreshold;

      /* row tint */
      ctx.fillStyle = isSR ? "rgba(0,200,150,0.10)" : (i % 2 === 0 ? "rgba(0,200,150,0.03)" : "transparent");
      ctx.fillRect(0, rowY, W, ROW_H);

      /* bid bar — left-aligned from price column */
      const barW = Math.max(2, (lv.q / maxQty) * BAR_W);
      ctx.fillStyle = isSR ? "rgba(0,200,150,0.75)" : "rgba(0,200,150,0.30)";
      ctx.fillRect(MID_X + PRICE_W / 2 + QTY_W + SR_W, rowY + 2, barW, ROW_H - 4);

      /* bid qty */
      ctx.font = isSR ? `bold 10px ${MONO}` : `10px ${MONO}`;
      ctx.fillStyle = isSR ? "#00d4a0" : "#007a60";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(fmtQ(lv.q), bidQtyX, rowY + ROW_H / 2);

      /* price */
      ctx.font = `10px ${MONO}`;
      ctx.fillStyle = "#6870a0";
      ctx.textAlign = "center";
      ctx.fillText(fmtP(lv.p, dec), MID_X, rowY + ROW_H / 2);

      /* S/R label */
      if (isSR) {
        ctx.font = `bold 9px ${MONO}`;
        ctx.fillStyle = "#00c896";
        ctx.textAlign = "right";
        ctx.fillText("⚡S", MID_X - PRICE_W / 2 - 3, rowY + ROW_H / 2);
      }
    });

    /* ── vertical dividers ── */
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    [MID_X - PRICE_W / 2, MID_X + PRICE_W / 2].forEach(x => {
      ctx.beginPath(); ctx.moveTo(x, HEADER_H); ctx.lineTo(x, H); ctx.stroke();
    });
  }, []);

  /* ── animation loop ── */
  useEffect(() => {
    let running = true;
    const loop = () => { if (!running) return; draw(); rafRef.current = requestAnimationFrame(loop); };
    rafRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, [draw]);

  /* ── polling ── */
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  /* ── resize ── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => { canvas.width = canvas.offsetWidth || 700; canvas.height = height; });
    ro.observe(canvas);
    canvas.width = canvas.offsetWidth || 700;
    canvas.height = height;
    return () => ro.disconnect();
  }, [height]);

  return (
    <div style={{ width: "100%", background: "#0d1117", borderRadius: 6, overflow: "hidden" }}>
      {/* status bar */}
      <div style={{ padding: "4px 10px", fontSize: 10, color: "#556", fontFamily: MONO, borderBottom: "1px solid #1a1e2e" }}>
        {symbol} &nbsp;·&nbsp; {status}
      </div>

      {/* DOM canvas */}
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height }} />

      {/* Key S/R walls summary */}
      {(walls.asks.length > 0 || walls.bids.length > 0) && (
        <div style={{ display: "flex", gap: 0, borderTop: "1px solid #1a1e2e", fontSize: 11, fontFamily: MONO }}>
          {/* Ask walls (resistance) */}
          <div style={{ flex: 1, padding: "6px 10px", borderRight: "1px solid #1a1e2e" }}>
            <div style={{ color: "#dc3545", fontWeight: 700, marginBottom: 4, fontSize: 10 }}>⚡ RESISTANCE WALLS</div>
            {walls.asks.slice(0, 5).map((w, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", color: "#ff6b6b", marginBottom: 2 }}>
                <span>{fmtP(w.price, 1)}</span>
                <span style={{ color: "#666" }}>{fmtQ(w.qty)}</span>
              </div>
            ))}
          </div>
          {/* Bid walls (support) */}
          <div style={{ flex: 1, padding: "6px 10px" }}>
            <div style={{ color: "#00c896", fontWeight: 700, marginBottom: 4, fontSize: 10 }}>⚡ SUPPORT WALLS</div>
            {walls.bids.slice(0, 5).map((w, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", color: "#00d4a0", marginBottom: 2 }}>
                <span>{fmtP(w.price, 1)}</span>
                <span style={{ color: "#666" }}>{fmtQ(w.qty)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

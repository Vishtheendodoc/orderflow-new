/**
 * GexChart — Dealer Gamma Exposure (GEX) by strike.
 *
 * - Each strike row shows Call GEX (teal, right) and Put GEX (red, left).
 * - Net GEX bar (green/red) shows directional dealer exposure.
 * - Flip Point line = strike where cumulative net GEX crosses zero.
 *   Above flip point → positive gamma (market maker buying dips / selling rips → dampens volatility).
 *   Below flip point → negative gamma (MM amplifies moves → trending).
 * - Gamma Wall = tallest net-positive bar (dealer put-selling cluster = hard ceiling).
 *
 * Polls  GET /api/gex/{symbol}  every POLL_MS milliseconds.
 */

import { useRef, useEffect, useCallback, useState } from "react";

const POLL_MS      = 60_000;
const MAX_STRIKES  = 40;
const BAR_H_MIN    = 6;
const BAR_H_MAX    = 22;

function fmtGex(v) {
  const n = Math.abs(v);
  if (n >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

function resolveIdx(symbol) {
  return (
    ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]
      .find(n => symbol.toUpperCase().includes(n)) || symbol.toUpperCase()
  );
}

export default function GexChart({ symbol, apiBase, height = 480 }) {
  const canvasRef = useRef(null);
  const dataRef   = useRef(null);
  const rafRef    = useRef(null);

  const [info,       setInfo]       = useState("waiting…");
  const [expiries,   setExpiries]   = useState([]);       // all available expiry dates
  const [selExpiry,  setSelExpiry]  = useState("");       // user-selected expiry ("" = default)

  /* ── fetch available expiries ────────────────────────────────── */
  useEffect(() => {
    if (!symbol || !apiBase) return;
    const idx = resolveIdx(symbol);
    fetch(`${apiBase}/api/gex/${encodeURIComponent(idx)}/expiries`)
      .then(r => r.json())
      .then(j => {
        if (Array.isArray(j.expiries) && j.expiries.length) {
          setExpiries(j.expiries);
          // default to nearest (first in list that is >= today)
          const today = new Date().toISOString().slice(0, 10);
          const nearest = j.expiries.find(e => e >= today) || j.expiries[0];
          setSelExpiry(prev => prev || nearest);
        }
      })
      .catch(() => {});
  }, [symbol, apiBase]);

  /* ── fetch GEX for selected expiry ──────────────────────────── */
  const fetchData = useCallback(async () => {
    if (!symbol || !apiBase) return;
    const idx = resolveIdx(symbol);
    const url = selExpiry
      ? `${apiBase}/api/gex/${encodeURIComponent(idx)}?expiry=${selExpiry}`
      : `${apiBase}/api/gex/${encodeURIComponent(idx)}`;
    try {
      const res  = await fetch(url);
      const json = await res.json();
      if (json.error) { setInfo(json.error); return; }
      dataRef.current = json;
      setInfo(
        `Spot ${json.spot?.toFixed(0)} | Expiry ${json.expiry} | Flip ` +
        (json.flip_point ? json.flip_point.toFixed(0) : "—")
      );
    } catch {
      setInfo("fetch error");
    }
  }, [symbol, apiBase, selExpiry]);

  /* ── draw ───────────────────────────────────────────────────── */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx  = canvas.getContext("2d");
    const W    = canvas.width;
    const H    = canvas.height;
    const d    = dataRef.current;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, W, H);

    if (!d || !d.strikes?.length) {
      ctx.fillStyle = "#555";
      ctx.font = "13px monospace";
      ctx.textAlign = "center";
      ctx.fillText(
        d?.error || "Waiting for GEX data (DHAN_TOKEN_OPTIONS required)…",
        W / 2, H / 2
      );
      return;
    }

    const spot      = d.spot || 0;
    const flipPoint = d.flip_point;
    const strikes   = d.strikes;

    // Trim to ±MAX_STRIKES/2 around ATM
    const atm = strikes.reduce((best, r) =>
      Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best,
      strikes[0]
    );
    const atmIdx = strikes.indexOf(atm);
    const half   = Math.floor(MAX_STRIKES / 2);
    const visible = strikes.slice(
      Math.max(0, atmIdx - half),
      Math.min(strikes.length, atmIdx + half)
    );
    if (!visible.length) return;

    // Layout
    const LABEL_W = 68;
    const BAR_H   = Math.max(BAR_H_MIN, Math.min(BAR_H_MAX, Math.floor((H - 40) / visible.length) - 2));
    const totalH  = visible.length * (BAR_H + 2);
    const startY  = Math.max(20, (H - totalH) / 2);
    const midX    = LABEL_W + (W - LABEL_W) / 2;

    // Max GEX magnitude for scaling
    const maxAbs = visible.reduce((m, r) =>
      Math.max(m, Math.abs(r.call_gex), Math.abs(r.put_gex), Math.abs(r.net_gex)), 1
    );
    const scale = (W - LABEL_W) / 2 / maxAbs * 0.9;

    // Centre line
    ctx.strokeStyle = "#333";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(midX, 0);
    ctx.lineTo(midX, H);
    ctx.stroke();

    // Draw each strike row
    visible.forEach((row, i) => {
      const y = startY + i * (BAR_H + 2);
      const isATM = Math.abs(row.strike - spot) <= Math.abs(visible[1]?.strike - visible[0]?.strike || 100) / 2;

      // Row background for ATM
      if (isATM) {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(0, y - 1, W, BAR_H + 2);
      }

      // Call GEX (teal, extends right from midX)
      const callW = row.call_gex * scale;
      ctx.fillStyle = "rgba(0,180,130,0.65)";
      ctx.fillRect(midX, y, callW, BAR_H);

      // Put GEX (red, extends left from midX)
      const putW = row.put_gex * scale;
      ctx.fillStyle = "rgba(210,50,50,0.65)";
      ctx.fillRect(midX - putW, y, putW, BAR_H);

      // Net GEX outline
      const netW = row.net_gex * scale;
      ctx.strokeStyle = row.net_gex >= 0 ? "#00e676" : "#ff5252";
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(
        netW >= 0 ? midX : midX + netW,
        y, Math.abs(netW), BAR_H
      );

      // Strike label
      ctx.fillStyle   = isATM ? "#fff" : "#888";
      ctx.font        = `${isATM ? "bold " : ""}11px monospace`;
      ctx.textAlign   = "right";
      ctx.fillText(row.strike.toFixed(0), LABEL_W - 4, y + BAR_H - 2);

      // Net GEX value label
      if (Math.abs(row.net_gex) > maxAbs * 0.05) {
        ctx.fillStyle  = row.net_gex >= 0 ? "#00e676" : "#ff5252";
        ctx.font       = "9px monospace";
        ctx.textAlign  = netW >= 0 ? "left" : "right";
        const labelX   = netW >= 0 ? midX + netW + 3 : midX + netW - 3;
        ctx.fillText(fmtGex(row.net_gex), labelX, y + BAR_H - 2);
      }
    });

    // Flip-point horizontal line
    if (flipPoint != null) {
      const fpRow = visible.find(r => Math.abs(r.strike - flipPoint) < 1);
      if (fpRow) {
        const i  = visible.indexOf(fpRow);
        const fy = startY + i * (BAR_H + 2) + BAR_H / 2;
        ctx.strokeStyle = "#ffeb3b";
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(LABEL_W, fy);
        ctx.lineTo(W, fy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle  = "#ffeb3b";
        ctx.font       = "bold 10px monospace";
        ctx.textAlign  = "left";
        ctx.fillText(`Flip ${flipPoint.toFixed(0)}`, LABEL_W + 4, fy - 3);
      }
    }

    // Spot price line
    {
      const spotRow = visible.reduce((b, r) =>
        Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b,
        visible[0]
      );
      const si = visible.indexOf(spotRow);
      const sy = startY + si * (BAR_H + 2) + BAR_H / 2;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth   = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(LABEL_W, sy);
      ctx.lineTo(W, sy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle  = "#fff";
      ctx.font       = "bold 10px monospace";
      ctx.textAlign  = "left";
      ctx.fillText(`SPOT ${spot.toFixed(0)}`, LABEL_W + 4, sy - 3);
    }

    // Column headers
    ctx.fillStyle  = "#555";
    ctx.font       = "10px monospace";
    ctx.textAlign  = "center";
    ctx.fillText("← Put GEX", midX - (W - LABEL_W) / 4, 14);
    ctx.fillText("Call GEX →", midX + (W - LABEL_W) / 4, 14);
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

  /* ── resize ─────────────────────────────────────────────────── */
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
      {/* ── top bar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "5px 8px", borderBottom: "1px solid #1e2530",
        flexWrap: "wrap",
      }}>
        {/* Legend */}
        <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
          <span style={{ color: "rgba(0,180,130,0.9)" }}>■ Call GEX</span>
          <span style={{ color: "rgba(210,50,50,0.9)" }}>■ Put GEX</span>
          <span style={{ color: "#00e676" }}>■ Net+</span>
          <span style={{ color: "#ff5252" }}>■ Net−</span>
          <span style={{ color: "#ffeb3b" }}>– Flip pt</span>
        </div>

        {/* Expiry selector */}
        {expiries.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
            <span style={{ fontSize: 11, color: "#888" }}>Expiry:</span>
            <select
              value={selExpiry}
              onChange={e => setSelExpiry(e.target.value)}
              style={{
                background: "#1a2030", color: "#ccc", border: "1px solid #333",
                borderRadius: 4, padding: "2px 6px", fontSize: 12, cursor: "pointer",
              }}
            >
              {expiries.map(exp => (
                <option key={exp} value={exp}>{exp}</option>
              ))}
            </select>
          </div>
        )}

        {/* Status */}
        <span style={{ fontSize: 10, color: "#555", marginLeft: expiries.length ? 0 : "auto" }}>
          {info}
        </span>
      </div>

      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height }}
      />
    </div>
  );
}

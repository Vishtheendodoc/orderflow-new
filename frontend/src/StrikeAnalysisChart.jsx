/**
 * StrikeAnalysisChart — Current vs Previous period flow comparison.
 *
 * Compares options flow (5/10/15/20/25/30 min) for bullish/bearish indication.
 * Phase 2: per-strike bullish/bearish based on flow comparison.
 * Uses HFT scanner data; polls GET /api/strike_analysis/{symbol}?window=N.
 */

import { useEffect, useCallback, useState } from "react";

const POLL_MS = 30_000;
const WINDOWS = [5, 10, 15, 20, 25, 30];

const FLOW_COLORS = {
  "Aggressive Call Buy": "#059669",
  "Heavy Put Write":     "#10b981",
  "Put Write":           "#6ee7b7",
  "Dark Pool CE":        "#0ea5e9",
  "Dark Pool PE":        "#f97316",
  "Call Short":          "#fca5a5",
  "Heavy Call Short":    "#ef4444",
  "Aggressive Put Buy":  "#dc2626",
};

const FLOW_ORDER = [
  "Aggressive Call Buy",
  "Heavy Put Write",
  "Put Write",
  "Dark Pool CE",
  "Dark Pool PE",
  "Call Short",
  "Heavy Call Short",
  "Aggressive Put Buy",
];

function resolveIdx(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.includes("BANKNIFTY")) return "BANKNIFTY";
  if (s.includes("FINNIFTY"))  return "FINNIFTY";
  if (s.includes("MIDCPNIFTY")) return "MIDCPNIFTY";
  if (s.includes("NIFTY"))    return "NIFTY";
  return s;
}

function fmtFlow(v) {
  const n = Math.abs(Number(v));
  if (n >= 1e9) return (Number(v) / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (Number(v) / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (Number(v) / 1e3).toFixed(0) + "K";
  return String(Math.round(Number(v)));
}

export default function StrikeAnalysisChart({ symbol, apiBase, height = 420 }) {
  const [data, setData] = useState(null);
  const [windowMin, setWindowMin] = useState(5);
  const [info, setInfo] = useState("");

  const fetchData = useCallback(async () => {
    if (!symbol || !apiBase) return;
    const idx = resolveIdx(symbol);
    if (!idx) return;
    try {
      const res = await fetch(`${apiBase}/api/strike_analysis/${encodeURIComponent(idx)}?window=${windowMin}`);
      const json = await res.json();
      if (json.error) {
        setInfo(json.error);
        setData(null);
        return;
      }
      setData(json);
      setInfo(`Spot ₹${(json.spot || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} | Window ${windowMin}m`);
    } catch {
      setInfo("Fetch error");
      setData(null);
    }
  }, [symbol, apiBase, windowMin]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  if (!symbol) {
    return (
      <div className="strike-analysis" style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
        Select NIFTY or BANKNIFTY to view strike analysis
      </div>
    );
  }

  const idx = resolveIdx(symbol);
  if (!idx) {
    return (
      <div className="strike-analysis" style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
        Strike analysis available for NIFTY / BANKNIFTY only
      </div>
    );
  }

  const indication = data?.indication || "neutral";
  const score = data?.score ?? 0;

  return (
    <div className="strike-analysis" style={{ display: "flex", flexDirection: "column", height: height || "100%", minHeight: 320 }}>
      {/* Header: window selector + indication badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, color: "#334155" }}>{idx} — Strike Analysis</span>
        <div style={{ display: "flex", gap: 4 }}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              className={`cd-btn ${windowMin === w ? "active" : ""}`}
              onClick={() => setWindowMin(w)}
              style={{ padding: "4px 10px", fontSize: 12 }}
            >
              {w}m
            </button>
          ))}
        </div>
        <span
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: 13,
            background: indication === "bullish" ? "rgba(5,150,105,0.15)" : indication === "bearish" ? "rgba(239,68,68,0.15)" : "rgba(148,163,184,0.2)",
            color: indication === "bullish" ? "#059669" : indication === "bearish" ? "#dc2626" : "#64748b",
          }}
        >
          {indication.toUpperCase()} (score: {score.toFixed(2)})
        </span>
        <span style={{ fontSize: 12, color: "#64748b", marginLeft: "auto" }}>{info}</span>
      </div>

      {/* Flow comparison: Current vs Previous */}
      <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
        {data?.error ? (
          <div style={{ padding: 24, textAlign: "center", color: "#64748b" }}>{data.error}</div>
        ) : !data?.current && !data?.previous ? (
          <div style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
            Waiting for HFT data (DHAN_TOKEN_OPTIONS required)…
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 720 }}>
            {/* Current period */}
            <div>
              <h4 style={{ margin: "0 0 8px 0", fontSize: 13, color: "#334155" }}>
                Current {windowMin}m
              </h4>
              <FlowBars flows={data?.current || {}} />
            </div>
            {/* Previous period */}
            <div>
              <h4 style={{ margin: "0 0 8px 0", fontSize: 13, color: "#334155" }}>
                Previous {windowMin}m
              </h4>
              <FlowBars flows={data?.previous || {}} />
            </div>
          </div>
        )}
        {data?.delta && Object.keys(data.delta).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h4 style={{ margin: "0 0 8px 0", fontSize: 13, color: "#334155" }}>Delta (Current − Previous)</h4>
            <FlowBars flows={data.delta} isDelta />
          </div>
        )}
        {/* Phase 2: Strike-level bullish/bearish */}
        {data?.strikes && data.strikes.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <h4 style={{ margin: "0 0 8px 0", fontSize: 13, color: "#334155" }}>Strike-level (ATM ±5)</h4>
            <div style={{ overflowX: "auto", maxHeight: 240, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ textAlign: "left", padding: "6px 8px", color: "#64748b", fontWeight: 600 }}>Strike</th>
                    <th style={{ textAlign: "right", padding: "6px 8px", color: "#64748b", fontWeight: 600 }}>Score</th>
                    <th style={{ textAlign: "center", padding: "6px 8px", color: "#64748b", fontWeight: 600 }}>Indication</th>
                    <th style={{ textAlign: "center", padding: "6px 8px", color: "#64748b", fontWeight: 600 }}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {data.strikes.map((s) => (
                    <tr key={s.strike} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "6px 8px", fontFamily: "monospace", color: "#334155" }}>
                        {Number(s.strike).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace", color: "#475569" }}>
                        {s.score > 0 ? "+" : ""}{s.score?.toFixed(2)}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "center" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            background: s.indication === "bullish" ? "rgba(5,150,105,0.15)" : s.indication === "bearish" ? "rgba(239,68,68,0.15)" : "rgba(148,163,184,0.2)",
                            color: s.indication === "bullish" ? "#059669" : s.indication === "bearish" ? "#dc2626" : "#64748b",
                          }}
                        >
                          {s.indication}
                        </span>
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "center", fontSize: 11, color: "#94a3b8" }}>
                        {s.source === "raw" ? "OI" : "flow"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {data && !data?.error && (!data?.strikes || data.strikes.length === 0) && (data?.current || data?.previous) && (
          <div style={{ marginTop: 12, fontSize: 12, color: "#94a3b8" }}>
            Strike-level data is fetched from Dhan options API (DHAN_TOKEN_OPTIONS required). Refresh to retry.
          </div>
        )}
      </div>
    </div>
  );
}

function FlowBars({ flows, isDelta }) {
  const entries = FLOW_ORDER.filter((k) => (flows[k] ?? 0) !== 0);
  if (!entries.length) return <div style={{ fontSize: 12, color: "#94a3b8" }}>No flow data</div>;

  const maxVal = Math.max(...entries.map((k) => Math.abs(flows[k] ?? 0)), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {entries.map((k) => {
        const v = flows[k] ?? 0;
        const pct = maxVal > 0 ? (Math.abs(v) / maxVal) * 100 : 0;
        const isNeg = v < 0;
        return (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ width: 140, color: "#475569" }}>{k}</span>
            <div
              style={{
                flex: 1,
                height: 20,
                background: "#e2e8f0",
                borderRadius: 4,
                overflow: "hidden",
                display: "flex",
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: isDelta ? (isNeg ? "#f87171" : "#4ade80") : FLOW_COLORS[k] || "#94a3b8",
                  minWidth: v !== 0 ? 4 : 0,
                }}
              />
            </div>
            <span
              style={{
                width: 56,
                textAlign: "right",
                fontFamily: "monospace",
                color: isDelta ? (isNeg ? "#dc2626" : "#16a34a") : "#334155",
              }}
            >
              {isDelta && v > 0 ? "+" : ""}
              {fmtFlow(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

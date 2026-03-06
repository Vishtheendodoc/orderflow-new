/**
 * StrikeAnalysisChart — Strike-wise CE left / PE right, raw OI/LTP/Greeks, running chart.
 *
 * Uses HFT snapshots (raw data only). Polls GET /api/strike_analysis_timeseries/{symbol}?window=N.
 */

import { useEffect, useCallback, useState } from "react";

const POLL_MS = 30_000;
const WINDOWS = [1, 3, 5, 10, 15, 20, 25, 30];
const CHART_H = 120;

function resolveIdx(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.includes("BANKNIFTY")) return "BANKNIFTY";
  if (s.includes("FINNIFTY")) return "FINNIFTY";
  if (s.includes("MIDCPNIFTY")) return "MIDCPNIFTY";
  if (s.includes("NIFTY")) return "NIFTY";
  return s;
}

function fmtOI(v) {
  const n = Math.abs(Number(v));
  if (n >= 1e6) return (Number(v) / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (Number(v) / 1e3).toFixed(0) + "K";
  return String(Math.round(Number(v)));
}

export default function StrikeAnalysisChart({ symbol, apiBase, height = 420 }) {
  const [data, setData] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [windowMin, setWindowMin] = useState(30);
  const [info, setInfo] = useState("");
  const [showCalibration, setShowCalibration] = useState(false);

  const fetchData = useCallback(async () => {
    if (!symbol || !apiBase) return;
    const idx = resolveIdx(symbol);
    if (!idx) return;
    try {
      const res = await fetch(`${apiBase}/api/strike_analysis_timeseries/${encodeURIComponent(idx)}?window=${windowMin}`);
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

  const fetchCalibration = useCallback(async () => {
    if (!symbol || !apiBase) return;
    const idx = resolveIdx(symbol);
    if (!idx) return;
    try {
      const res = await fetch(`${apiBase}/api/strike_calibration/${encodeURIComponent(idx)}?window=120`);
      const json = await res.json();
      if (json.error) {
        setCalibration({ error: json.error });
      } else {
        setCalibration(json);
      }
    } catch {
      setCalibration({ error: "Fetch error" });
    }
  }, [symbol, apiBase]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  useEffect(() => {
    if (symbol && apiBase && showCalibration) fetchCalibration();
  }, [symbol, apiBase, showCalibration, fetchCalibration]);

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

  const series = data?.series || [];
  const latest = series[series.length - 1];
  const strikes = latest?.strikes || [];

  return (
    <div className="strike-analysis" style={{ display: "flex", flexDirection: "column", height: height || "100%", minHeight: 320 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, color: "#334155" }}>{idx} — Strike (CE | PE)</span>
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
        <button
          type="button"
          onClick={() => setShowCalibration((v) => !v)}
          style={{ padding: "4px 10px", fontSize: 11, marginLeft: 8 }}
          className="cd-btn"
        >
          {showCalibration ? "Hide" : "Show"} calibration
        </button>
        <span style={{ fontSize: 12, color: "#64748b", marginLeft: "auto" }}>{info}</span>
      </div>

      {showCalibration && (
        <CalibrationPanel calibration={calibration} onRefresh={fetchCalibration} />
      )}

      <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
        {data?.error ? (
          <div style={{ padding: 24, textAlign: "center", color: "#64748b" }}>{data.error}</div>
        ) : !series.length ? (
          <div style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
            Waiting for options data (DHAN_TOKEN_OPTIONS required)…
          </div>
        ) : (
          <>
            {/* Strike table: CE left, PE right */}
            <div style={{ marginBottom: 16 }}>
              <h4 style={{ margin: "0 0 8px 0", fontSize: 13, color: "#334155" }}>Strike-wise (ATM ±5) — CE left, PE right</h4>
              <div style={{ overflowX: "auto", maxHeight: 280, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e2e8f0" }}>
                      <th style={{ textAlign: "left", padding: "4px 6px", color: "#64748b", fontWeight: 600 }}>Strike</th>
                      <th colSpan={4} style={{ textAlign: "center", padding: "4px 6px", color: "#0ea5e9", fontWeight: 600 }}>CE</th>
                      <th colSpan={4} style={{ textAlign: "center", padding: "4px 6px", color: "#f97316", fontWeight: 600 }}>PE</th>
                    </tr>
                    <tr style={{ borderBottom: "1px solid #e2e8f0", fontSize: 10 }}>
                      <th></th>
                      <th style={{ padding: "2px 4px", color: "#64748b" }}>OI</th>
                      <th style={{ padding: "2px 4px", color: "#64748b" }}>Δ%</th>
                      <th style={{ padding: "2px 4px", color: "#64748b" }}>δ γ θ ν</th>
                      <th style={{ padding: "2px 4px", color: "#64748b" }}>Ind</th>
                      <th style={{ padding: "2px 4px", color: "#64748b" }}>OI</th>
                      <th style={{ padding: "2px 4px", color: "#64748b" }}>Δ%</th>
                      <th style={{ padding: "2px 4px", color: "#64748b" }}>δ γ θ ν</th>
                      <th style={{ padding: "2px 4px", color: "#64748b" }}>Ind</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strikes.map((s) => (
                      <tr key={s.strike} style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <td style={{ padding: "4px 6px", fontFamily: "monospace", color: "#334155", whiteSpace: "nowrap" }}>
                          {Number(s.strike).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        </td>
                        {/* CE */}
                        <td style={{ padding: "4px 6px", fontFamily: "monospace", color: "#0ea5e9" }}>{fmtOI(s.ce_oi)}</td>
                        <td style={{ padding: "4px 6px", fontFamily: "monospace", color: (s.ce_oi_chg || 0) >= 0 ? "#16a34a" : "#dc2626" }}>
                          {(s.ce_oi_chg || 0) >= 0 ? "↑" : "↓"}
                          {(s.ce_oi_chg || 0) >= 0 ? "+" : ""}
                          {(s.ce_oi_chg || 0).toFixed(1)}%
                        </td>
                        <td style={{ padding: "4px 6px", fontSize: 10, color: "#64748b" }} title={`δ=${s.ce_delta} γ=${s.ce_gamma} θ=${s.ce_theta} ν=${s.ce_vega}`}>
                          {(s.ce_delta || 0).toFixed(2)} {(s.ce_gamma || 0).toFixed(3)} {(s.ce_theta || 0).toFixed(0)} {(s.ce_vega || 0).toFixed(0)}
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          <span
                            style={{
                              padding: "1px 6px",
                              borderRadius: 4,
                              fontSize: 10,
                              fontWeight: 600,
                              background: s.ce_ind === "bullish" ? "rgba(5,150,105,0.15)" : s.ce_ind === "bearish" ? "rgba(239,68,68,0.15)" : "rgba(148,163,184,0.2)",
                              color: s.ce_ind === "bullish" ? "#059669" : s.ce_ind === "bearish" ? "#dc2626" : "#64748b",
                            }}
                          >
                            {s.ce_ind}
                          </span>
                        </td>
                        {/* PE */}
                        <td style={{ padding: "4px 6px", fontFamily: "monospace", color: "#f97316" }}>{fmtOI(s.pe_oi)}</td>
                        <td style={{ padding: "4px 6px", fontFamily: "monospace", color: (s.pe_oi_chg || 0) >= 0 ? "#16a34a" : "#dc2626" }}>
                          {(s.pe_oi_chg || 0) >= 0 ? "↑" : "↓"}
                          {(s.pe_oi_chg || 0) >= 0 ? "+" : ""}
                          {(s.pe_oi_chg || 0).toFixed(1)}%
                        </td>
                        <td style={{ padding: "4px 6px", fontSize: 10, color: "#64748b" }} title={`δ=${s.pe_delta} γ=${s.pe_gamma} θ=${s.pe_theta} ν=${s.pe_vega}`}>
                          {(s.pe_delta || 0).toFixed(2)} {(s.pe_gamma || 0).toFixed(3)} {(s.pe_theta || 0).toFixed(0)} {(s.pe_vega || 0).toFixed(0)}
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          <span
                            style={{
                              padding: "1px 6px",
                              borderRadius: 4,
                              fontSize: 10,
                              fontWeight: 600,
                              background: s.pe_ind === "bullish" ? "rgba(5,150,105,0.15)" : s.pe_ind === "bearish" ? "rgba(239,68,68,0.15)" : "rgba(148,163,184,0.2)",
                              color: s.pe_ind === "bullish" ? "#059669" : s.pe_ind === "bearish" ? "#dc2626" : "#64748b",
                            }}
                          >
                            {s.pe_ind}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Running OI change chart */}
            {series.length >= 2 && (
              <div>
                <h4 style={{ margin: "0 0 8px 0", fontSize: 13, color: "#334155" }}>OI change % (running) — ATM strike</h4>
                <OiOChangeChart series={series} height={CHART_H} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CalibrationPanel({ calibration, onRefresh }) {
  if (!calibration) {
    return (
      <div style={{ padding: 12, borderBottom: "1px solid #e2e8f0", background: "#f8fafc", fontSize: 12 }}>
        <button type="button" onClick={onRefresh} className="cd-btn" style={{ padding: "4px 10px" }}>
          Load calibration
        </button>
      </div>
    );
  }
  if (calibration.error) {
    return (
      <div style={{ padding: 12, borderBottom: "1px solid #e2e8f0", background: "#fef2f2", fontSize: 12, color: "#dc2626" }}>
        {calibration.error}
        <button type="button" onClick={onRefresh} className="cd-btn" style={{ marginLeft: 8, padding: "4px 10px" }}>
          Retry
        </button>
      </div>
    );
  }
  const stats = calibration.stats || {};
  const cutoffs = calibration.suggested_cutoffs || {};
  const copyPaste = calibration.copy_paste || "";

  return (
    <div style={{ padding: 12, borderBottom: "1px solid #e2e8f0", background: "#f8fafc", fontSize: 11 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <strong style={{ color: "#334155" }}>HFT flow calibration ({calibration.symbol}, n={stats.ce_oi_chg?.n ?? 0})</strong>
        <button type="button" onClick={onRefresh} className="cd-btn" style={{ padding: "2px 8px", fontSize: 10 }}>
          Refresh
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, marginBottom: 10 }}>
        {["ce_oi_chg", "pe_oi_chg", "ce_ltp_chg", "pe_ltp_chg", "ce_vol", "pe_vol"].map((k) => {
          const s = stats[k];
          if (!s || s.n === 0) return null;
          return (
            <div key={k} style={{ background: "#fff", padding: 6, borderRadius: 4, border: "1px solid #e2e8f0" }}>
              <div style={{ fontWeight: 600, color: "#64748b", marginBottom: 4 }}>{k}</div>
              <div style={{ fontFamily: "monospace", fontSize: 10 }}>
                p25:{s.p25} p50:{s.p50} p75:{s.p75} p90:{s.p90}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginBottom: 6 }}>
        <strong style={{ color: "#334155" }}>Suggested cutoffs (copy & paste for .env):</strong>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 8,
          background: "#1e293b",
          color: "#e2e8f0",
          borderRadius: 4,
          fontSize: 11,
          overflow: "auto",
          cursor: "text",
          userSelect: "all",
        }}
      >
        {copyPaste || JSON.stringify(cutoffs, null, 2)}
      </pre>
    </div>
  );
}

function OiOChangeChart({ series, height }) {
  const W = 600;
  const H = height;
  const pad = { l: 40, r: 12, t: 8, b: 24 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  if (!series?.length) return null;

  const atmIdx = Math.floor((series[0]?.strikes?.length || 0) / 2);
  const ceChg = series.map((s) => s.strikes?.[atmIdx]?.ce_oi_chg ?? 0);
  const peChg = series.map((s) => s.strikes?.[atmIdx]?.pe_oi_chg ?? 0);
  const times = series.map((s) => s.t || "");
  const allChg = [...ceChg, ...peChg].filter((v) => !Number.isNaN(v));
  const minChg = Math.min(...allChg, -1);
  const maxChg = Math.max(...allChg, 1);
  const range = maxChg - minChg || 1;

  const toX = (i) => pad.l + (i / Math.max(series.length - 1, 1)) * plotW;
  const toY = (v) => pad.t + plotH - ((v - minChg) / range) * plotH;

  const cePts = ceChg.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
  const pePts = peChg.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
  const zeroY = toY(0);

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        <line x1={pad.l} y1={zeroY} x2={pad.l + plotW} y2={zeroY} stroke="#64748b" strokeWidth="1" strokeDasharray="3,3" />
        <polyline points={cePts} fill="none" stroke="#0ea5e9" strokeWidth="1.5" />
        <polyline points={pePts} fill="none" stroke="#f97316" strokeWidth="1.5" />
        {times.map((t, i) => {
          if (times.length > 12 && i % Math.ceil(times.length / 8) !== 0 && i !== times.length - 1) return null;
          return (
            <text key={i} x={toX(i)} y={H - 4} fontSize="10" fill="#64748b" textAnchor="middle">
              {t}
            </text>
          );
        })}
        <text x={pad.l - 8} y={pad.t + 10} fontSize="10" fill="#0ea5e9">CE</text>
        <text x={pad.l - 8} y={pad.t + 22} fontSize="10" fill="#f97316">PE</text>
      </svg>
    </div>
  );
}

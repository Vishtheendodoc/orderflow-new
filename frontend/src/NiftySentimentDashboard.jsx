/**
 * NiftySentimentDashboard — Options sentiment scorecard and strike map.
 *
 * Polls GET /api/sentiment/{symbol} every POLL_MS.
 * Displays: overall signal, PCR, GEX, Max Pain, IV Skew, ATM IV, OI Pressure, Charm, Strike Walls.
 */

import { useEffect, useCallback, useState } from "react";

const POLL_MS = 90_000;

function resolveIdx(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.includes("BANKNIFTY")) return "BANKNIFTY";
  if (s.includes("FINNIFTY")) return "FINNIFTY";
  if (s.includes("MIDCPNIFTY")) return "MIDCPNIFTY";
  if (s.includes("NIFTY")) return "NIFTY";
  return s;
}

function fmtGex(v) {
  const n = Math.abs(Number(v));
  if (n >= 1e9) return (Number(v) / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (Number(v) / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (Number(v) / 1e3).toFixed(1) + "K";
  return String(Math.round(Number(v)));
}

function SignalBadge({ signal, score }) {
  const map = {
    STRONG_BULLISH: { label: "STRONG BULLISH", color: "#059669", bg: "rgba(5,150,105,0.15)" },
    BULLISH: { label: "BULLISH", color: "#10b981", bg: "rgba(16,185,129,0.12)" },
    MILD_BULLISH: { label: "MILD BULLISH", color: "#34d399", bg: "rgba(52,211,153,0.1)" },
    NEUTRAL: { label: "NEUTRAL", color: "#64748b", bg: "rgba(100,116,139,0.1)" },
    MILD_BEARISH: { label: "MILD BEARISH", color: "#fb923c", bg: "rgba(251,146,60,0.1)" },
    BEARISH: { label: "BEARISH", color: "#f97316", bg: "rgba(249,115,22,0.12)" },
    STRONG_BEARISH: { label: "STRONG BEARISH", color: "#dc2626", bg: "rgba(220,38,38,0.15)" },
  };
  const s = map[signal] || { label: signal || "—", color: "#64748b", bg: "rgba(100,116,139,0.1)" };
  return (
    <div
      style={{
        padding: "12px 24px",
        borderRadius: 8,
        background: s.bg,
        border: `2px solid ${s.color}`,
        color: s.color,
        fontWeight: 700,
        fontSize: 18,
      }}
    >
      {s.label} ({score >= 0 ? "+" : ""}{score}/8)
    </div>
  );
}

function FeatureCell({ label, value, signal }) {
  const color =
    signal === "bullish"
      ? "#10b981"
      : signal === "bearish"
        ? "#ef4444"
        : "#64748b";
  return (
    <div
      style={{
        padding: "10px 14px",
        borderRadius: 6,
        background: "#f8fafc",
        borderLeft: `4px solid ${color}`,
      }}
    >
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "#334155" }}>{value}</div>
    </div>
  );
}

export default function NiftySentimentDashboard({ symbol, apiBase, height = 480 }) {
  const [data, setData] = useState(null);
  const [info, setInfo] = useState("waiting…");
  const [training, setTraining] = useState(false);
  const [trainResult, setTrainResult] = useState(null);

  const fetchData = useCallback(async () => {
    if (!symbol || !apiBase) return;
    const idx = resolveIdx(symbol);
    if (!idx) return;
    try {
      const res = await fetch(`${apiBase}/api/sentiment/${encodeURIComponent(idx)}`);
      const json = await res.json();
      if (json.error) {
        setInfo(json.error);
        setData(null);
        return;
      }
      setData(json);
      setInfo(
        `Spot ₹${(json.spot || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} | ` +
          `Expiry ${json.expiry || "—"} | ${json.days_to_expiry != null ? json.days_to_expiry + " days left" : "—"}`
      );
    } catch {
      setInfo("Fetch error");
      setData(null);
    }
  }, [symbol, apiBase]);

  const trainModel = useCallback(async () => {
    const index = resolveIdx(symbol);
    if (!apiBase || !index) return;
    setTraining(true);
    setTrainResult(null);
    try {
      const res = await fetch(`${apiBase}/api/sentiment/train?index=${encodeURIComponent(index)}`, {
        method: "POST",
      });
      const json = await res.json();
      setTrainResult(json.ok ? "Model trained. Refresh in a moment." : "Training failed.");
      if (json.ok) setTimeout(fetchData, 2000);
    } catch {
      setTrainResult("Training failed.");
    } finally {
      setTraining(false);
    }
  }, [apiBase, symbol, fetchData]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  if (!symbol) {
    return (
      <div
        className="sentiment-dashboard"
        style={{ padding: 24, textAlign: "center", color: "#64748b" }}
      >
        Select NIFTY or BANKNIFTY to view sentiment
      </div>
    );
  }

  const idx = resolveIdx(symbol);
  if (!idx) {
    return (
      <div
        className="sentiment-dashboard"
        style={{ padding: 24, textAlign: "center", color: "#64748b" }}
      >
        Sentiment available for NIFTY / BANKNIFTY only
      </div>
    );
  }

  const f = data?.features || {};
  const sm = data?.strike_map || {};

  const featureSignal = (val, bullishCond, bearishCond) => {
    if (bullishCond(val)) return "bullish";
    if (bearishCond(val)) return "bearish";
    return "neutral";
  };

  return (
    <div
      className="sentiment-dashboard"
      style={{
        display: "flex",
        flexDirection: "column",
        height: height || "100%",
        minHeight: 320,
        overflow: "auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          borderBottom: "1px solid #e2e8f0",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 600, color: "#334155" }}>{idx} Options Sentiment</span>
        <span style={{ fontSize: 12, color: "#64748b" }}>{info}</span>
      </div>

      {!data ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#94a3b8",
          }}
        >
          {info}
        </div>
      ) : (
        <>
          {/* Overall Signal + ML */}
          <div
            style={{
              padding: "16px 14px",
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              alignItems: "center",
              gap: 16,
              borderBottom: "1px solid #e2e8f0",
            }}
          >
            <SignalBadge signal={data.overall_signal} score={data.score} />
            {data.ml_confidence > 0 ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    padding: "8px 16px",
                    borderRadius: 6,
                    background: "#f1f5f9",
                    fontSize: 13,
                    color: "#475569",
                  }}
                >
                  ML:{" "}
                  <strong>
                    {data.ml_direction === 1
                      ? "Bullish"
                      : data.ml_direction === -1
                        ? "Bearish"
                        : "Neutral"}
                  </strong>{" "}
                  ({(data.ml_confidence * 100).toFixed(0)}%)
                </div>
                <button
                  type="button"
                  className="cd-btn"
                  onClick={trainModel}
                  disabled={training}
                  style={{
                    padding: "6px 12px",
                    fontSize: 12,
                    background: training ? "#cbd5e1" : "#64748b",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    cursor: training ? "wait" : "pointer",
                  }}
                  title="Retrain model with latest data"
                >
                  {training ? "Training…" : "Retrain"}
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  className="cd-btn"
                  onClick={trainModel}
                  disabled={training}
                  style={{
                    padding: "8px 16px",
                    fontSize: 13,
                    background: training ? "#cbd5e1" : "#3b82f6",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    cursor: training ? "wait" : "pointer",
                  }}
                >
                  {training ? "Training…" : "Train ML Model"}
                </button>
                {trainResult && (
                  <span style={{ fontSize: 12, color: "#64748b" }}>{trainResult}</span>
                )}
              </div>
            )}
          </div>

          {/* Scorecard Grid 2x4 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 10,
              padding: 14,
            }}
          >
            <FeatureCell
              label="PCR-OI"
              value={f.pcr_oi != null ? f.pcr_oi.toFixed(2) : "—"}
              signal={featureSignal(
                f.pcr_oi,
                (v) => v > 1.1,
                (v) => v < 0.8
              )}
            />
            <FeatureCell
              label="GEX"
              value={f.total_gex != null ? fmtGex(f.total_gex) : "—"}
              signal={featureSignal(
                f.total_gex,
                (v) => v > 0,
                (v) => v < 0
              )}
            />
            <FeatureCell
              label="Max Pain"
              value={f.max_pain_strike != null ? f.max_pain_strike.toLocaleString() : "—"}
              signal={featureSignal(
                f.max_pain_distance_pct,
                (v) => v < 0,
                (v) => v > 0
              )}
            />
            <FeatureCell
              label="IV Skew"
              value={f.iv_skew != null ? f.iv_skew.toFixed(2) : "—"}
              signal={featureSignal(
                f.skew_change,
                (v) => v < -0.1,
                (v) => v > 0.1
              )}
            />
            <FeatureCell
              label="ATM IV"
              value={f.atm_iv != null ? f.atm_iv.toFixed(1) + "%" : "—"}
              signal={
                (f.atm_iv ?? 0) < 15 && (f.atm_iv_change ?? 0) < 0
                  ? "bullish"
                  : (f.atm_iv ?? 0) > 20 && (f.atm_iv_change ?? 0) > 0
                    ? "bearish"
                    : "neutral"
              }
            />
            <FeatureCell
              label="OI Pressure"
              value={f.oi_pressure != null ? f.oi_pressure.toLocaleString() : "—"}
              signal={featureSignal(
                f.oi_pressure,
                (v) => v > 0,
                (v) => v < 0
              )}
            />
            <FeatureCell
              label="Charm Flow"
              value={f.charm_flow != null ? fmtGex(f.charm_flow) : "—"}
              signal={featureSignal(
                f.charm_flow,
                (v) => v > 0,
                (v) => v < 0
              )}
            />
            <FeatureCell
              label="Put Wall"
              value={sm.put_wall != null ? sm.put_wall.toLocaleString() : "—"}
              signal={
                sm.put_wall_strength > 1.2
                  ? "bullish"
                  : sm.call_wall_strength > 1.2
                    ? "bearish"
                    : "neutral"
              }
            />
          </div>

          {/* Strike Map */}
          <div
            style={{
              padding: "12px 14px",
              borderTop: "1px solid #e2e8f0",
              background: "#f8fafc",
              borderRadius: 6,
              margin: "0 14px 14px",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 8 }}>
              Strike Map
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                fontSize: 13,
              }}
            >
              <span>
                Call Wall: <strong>{sm.call_wall != null ? sm.call_wall.toLocaleString() : "—"}</strong>
              </span>
              <span>
                Put Wall: <strong>{sm.put_wall != null ? sm.put_wall.toLocaleString() : "—"}</strong>
              </span>
              <span>
                Gamma Flip: <strong>{sm.gamma_flip != null ? sm.gamma_flip.toLocaleString() : "—"}</strong>
              </span>
              <span>
                Max Pain: <strong>{sm.max_pain != null ? sm.max_pain.toLocaleString() : "—"}</strong>
              </span>
              <span>
                Spot: <strong>{data.spot != null ? data.spot.toLocaleString() : "—"}</strong>
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

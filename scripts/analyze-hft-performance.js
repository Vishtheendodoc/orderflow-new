#!/usr/bin/env node
/**
 * HFT (Options Flow) Performance Analysis
 * Fetches HFT data from Render disk (via API) and index futures candles,
 * evaluates OWP and flow metrics as predictors of next-bar direction.
 *
 * Usage: node scripts/analyze-hft-performance.js
 */

const API_BASE = process.env.API_URL || "https://orderflow-backend-3gwk.onrender.com";
const FETCH_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 60000;

/** Forward horizon: HFT at M predicts net direction over next N bars (1=immediate, 2–3=leading) */
const HORIZON = parseInt(process.env.HFT_HORIZON || "2", 10) || 2;
/** Per-metric horizons (override HORIZON when set) */
const OWP_HORIZON = parseInt(process.env.HFT_OWP_HORIZON || "0", 10) || HORIZON;
const CALLSHORT_HORIZON = parseInt(process.env.HFT_CALLSHORT_HORIZON || "0", 10) || HORIZON;
const PUTWRITE_HORIZON = parseInt(process.env.HFT_PUTWRITE_HORIZON || "0", 10) || HORIZON;
const MFI_OB_HORIZON = parseInt(process.env.HFT_MFI_OB_HORIZON || "0", 10) || HORIZON;
const MFI_OS_HORIZON = parseInt(process.env.HFT_MFI_OS_HORIZON || "0", 10) || HORIZON;
/** OWP contrarian: when true, OWP positive = expect down (contrarian to options sentiment) */
const OWP_CONTRARIAN = process.env.HFT_OWP_CONTRARIAN === "1" || process.env.HFT_OWP_CONTRARIAN === "true";

const INDEX_TO_FUT = {
  NIFTY: "NIFTY MAR FUT",
  BANKNIFTY: "BANKNIFTY MAR FUT",
  FINNIFTY: "FINNIFTY MAR FUT",
  MIDCPNIFTY: "MIDCPNIFTY MAR FUT",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function fetchHft(index) {
  const url = `${API_BASE.replace(/\/$/, "")}/api/hft_scanner/${encodeURIComponent(index)}`;
  const data = await fetchJson(url);
  if (!data?.series?.length) return null;
  return data;
}

async function fetchFuturesState(symbol) {
  const url = `${API_BASE.replace(/\/$/, "")}/api/state/${encodeURIComponent(symbol)}`;
  const data = await fetchJson(url);
  if (!data?.candles?.length) return null;
  return data;
}

/** Candle open_time is (Unix + 19800) * 1000 ms. Return Unix minute. */
function candleUnixMinute(candle) {
  const openTime = candle.open_time ?? candle.chartTime * 1000 ?? 0;
  const unixSec = openTime / 1000 - 19800;
  return Math.floor(unixSec / 60);
}

/** HFT ts is Unix seconds. Return Unix minute. */
function hftUnixMinute(snap) {
  const ts = snap.ts ?? snap.timestamp ?? 0;
  return Math.floor(ts / 60);
}

/** OWP = Put Write - Call Short (positive = bullish: put writers dominate) */
function computeOWP(flows) {
  const putWrite = (flows["Heavy Put Write"] || 0) + (flows["Put Write"] || 0);
  const callShort = (flows["Call Short"] || 0) + (flows["Heavy Call Short"] || 0);
  return putWrite - callShort;
}

/** Call short only (excludes Aggressive Call Buy). Positive = bearish. */
function computeCallShort(flows) {
  return (flows["Call Short"] || 0) + (flows["Heavy Call Short"] || 0);
}

/** Put write only (excludes Aggressive Put Buy). Positive = bullish. */
function computePutWrite(flows) {
  return (flows["Put Write"] || 0) + (flows["Heavy Put Write"] || 0);
}

function analyzeHft(index, hftData, futuresState, opts = {}) {
  const owpContrarian = opts.owpContrarian ?? OWP_CONTRARIAN;
  const series = hftData.series || [];
  const candles = (futuresState.candles || []).filter((c) => c.closed !== false);
  if (series.length < 2 || candles.length < 2) return null;

  const candleByMin = {};
  for (const c of candles) {
    const min = candleUnixMinute(c);
    candleByMin[min] = c;
  }

  const results = {
    index,
    hftBars: series.length,
    candles: candles.length,
    owp: { signals: 0, correct: 0 },
    callShort: { signals: 0, correct: 0 },
    putWrite: { signals: 0, correct: 0 },
    mfiOverbought: { signals: 0, correct: 0 },
    mfiOversold: { signals: 0, correct: 0 },
  };

  const OWP_THRESHOLD = parseInt(process.env.HFT_OWP_THRESHOLD || "500", 10) || 500;
  const MFI_OVERBOUGHT = parseFloat(process.env.HFT_MFI_OVERBOUGHT || "75") || 75;
  const MFI_OVERSOLD = parseFloat(process.env.HFT_MFI_OVERSOLD || "25") || 25;

  function netDir(hftMin, horizon) {
    let netChg = 0;
    for (let k = 1; k <= horizon; k++) {
      const c = candleByMin[hftMin + k];
      if (!c) break;
      const o = c.open ?? c.close ?? 0;
      const cl = c.close ?? c.open ?? 0;
      netChg += cl - o;
    }
    return netChg > 0 ? 1 : netChg < 0 ? -1 : 0;
  }

  for (let i = 0; i < series.length; i++) {
    const snap = series[i];
    const flows = snap.flows || {};
    const owp = computeOWP(flows);
    const callShort = computeCallShort(flows);
    const putWrite = computePutWrite(flows);
    const mfi = snap.mfi ?? 50;
    const hftMin = hftUnixMinute(snap);

    const dirOwp = netDir(hftMin, OWP_HORIZON);
    const dirCallShort = netDir(hftMin, CALLSHORT_HORIZON);
    const dirPutWrite = netDir(hftMin, PUTWRITE_HORIZON);
    const dirMfiOb = netDir(hftMin, MFI_OB_HORIZON);
    const dirMfiOs = netDir(hftMin, MFI_OS_HORIZON);

    // OWP: positive = bullish (unless contrarian). Contrarian: positive = expect down
    if (Math.abs(owp) > OWP_THRESHOLD && dirOwp !== 0) {
      results.owp.signals++;
      const expectedDir = owpContrarian ? (owp > 0 ? -1 : 1) : (owp > 0 ? 1 : -1);
      if (dirOwp === expectedDir) results.owp.correct++;
    }

    if (callShort > OWP_THRESHOLD && dirCallShort !== 0) {
      results.callShort.signals++;
      if (dirCallShort === -1) results.callShort.correct++;
    }

    if (putWrite > OWP_THRESHOLD && dirPutWrite !== 0) {
      results.putWrite.signals++;
      if (dirPutWrite === 1) results.putWrite.correct++;
    }

    if (mfi > MFI_OVERBOUGHT && dirMfiOb !== 0) {
      results.mfiOverbought.signals++;
      if (dirMfiOb === -1) results.mfiOverbought.correct++;
    }

    if (mfi < MFI_OVERSOLD && dirMfiOs !== 0) {
      results.mfiOversold.signals++;
      if (dirMfiOs === 1) results.mfiOversold.correct++;
    }
  }

  return results;
}

function formatRow(r) {
  const fmt = (m) => (m.signals > 0 ? `${m.signals}/${((m.correct / m.signals) * 100).toFixed(1)}` : "0/-");
  return {
    index: r.index,
    hftBars: r.hftBars,
    candles: r.candles,
    owp: fmt(r.owp),
    callShort: fmt(r.callShort),
    putWrite: fmt(r.putWrite),
    mfiOB: fmt(r.mfiOverbought),
    mfiOS: fmt(r.mfiOversold),
  };
}

/** When set, run OWP both ways (bullish vs contrarian) and report which fits better */
const OWP_COMPARE = process.env.HFT_OWP_COMPARE === "1" || process.env.HFT_OWP_COMPARE === "true";

async function main() {
  const dateStr = new Date().toISOString().slice(0, 10);
  console.error(`Fetching HFT and futures data from ${API_BASE}...`);

  const dataByIndex = {};
  for (const [index, futSymbol] of Object.entries(INDEX_TO_FUT)) {
    try {
      const [hftData, futuresState] = await Promise.all([
        fetchHft(index),
        fetchFuturesState(futSymbol),
      ]);
      await sleep(FETCH_DELAY_MS);
      if (hftData && futuresState) dataByIndex[index] = { hftData, futuresState };
      else console.error(`  Skip ${index}: no HFT or futures data`);
    } catch (e) {
      console.error(`  Skip ${index}: ${e.message}`);
    }
  }

  if (Object.keys(dataByIndex).length === 0) {
    console.error("No HFT data. Ensure DHAN_TOKEN_OPTIONS is set and market has run.");
    process.exit(1);
  }

  const results = [];
  for (const [index, { hftData, futuresState }] of Object.entries(dataByIndex)) {
    const r = analyzeHft(index, hftData, futuresState);
    if (r) results.push(r);
  }

  if (OWP_COMPARE) {
    const resBullish = [];
    const resContrarian = [];
    for (const [index, { hftData, futuresState }] of Object.entries(dataByIndex)) {
      resBullish.push(analyzeHft(index, hftData, futuresState, { owpContrarian: false }));
      resContrarian.push(analyzeHft(index, hftData, futuresState, { owpContrarian: true }));
    }
    const n = resBullish.filter(Boolean).length;
    const accBullish = n > 0 ? resBullish.filter(Boolean).reduce((s, r) => s + (r.owp.signals > 0 ? (r.owp.correct / r.owp.signals) * 100 : 0), 0) / n : 0;
    const accContrarian = n > 0 ? resContrarian.filter(Boolean).reduce((s, r) => s + (r.owp.signals > 0 ? (r.owp.correct / r.owp.signals) * 100 : 0), 0) / n : 0;
    console.log("\n--- OWP Interpretation Comparison ---");
    console.log(`Bullish (pos=expect up):     ${accBullish.toFixed(1)}% avg`);
    console.log(`Contrarian (pos=expect down): ${accContrarian.toFixed(1)}% avg`);
    console.log(`Best fit: ${accContrarian > accBullish ? "Contrarian" : "Bullish"}\n`);
  }

  const pad = (s, w) => String(s).padEnd(w);
  const header = `${pad("Index", 14)} | ${pad("HFT", 5)} | ${pad("Candles", 7)} | ${pad("OWP (sig/acc%)", 14)} | ${pad("CallShort", 12)} | ${pad("PutWrite", 12)} | ${pad("MFI OB", 10)} | ${pad("MFI OS", 10)}`;
  const sep = "-".repeat(header.length);

  console.log(`\n=== HFT Performance (Render Disk Data, ${dateStr}) ===`);
  console.log(`Horizons: OWP=${OWP_HORIZON} CallShort=${CALLSHORT_HORIZON} PutWrite=${PUTWRITE_HORIZON} MFI_OB=${MFI_OB_HORIZON} MFI_OS=${MFI_OS_HORIZON} (HFT_*_HORIZON env)`);
  if (OWP_CONTRARIAN) console.log(`OWP: contrarian mode (pos=expect down)`);
  console.log("");
  console.log(header);
  console.log(sep);

  for (const r of results) {
    const row = formatRow(r);
    console.log(
      `${pad(row.index, 14)} | ${pad(row.hftBars, 5)} | ${pad(row.candles, 7)} | ${pad(row.owp, 14)} | ${pad(row.callShort, 12)} | ${pad(row.putWrite, 12)} | ${pad(row.mfiOB, 10)} | ${pad(row.mfiOS, 10)}`
    );
  }

  if (results.length > 1) {
    const n = results.length;
    const avgOwp = results.reduce((s, r) => s + (r.owp.signals > 0 ? (r.owp.correct / r.owp.signals) * 100 : 0), 0) / n;
    const avgCallShort = results.reduce((s, r) => s + (r.callShort.signals > 0 ? (r.callShort.correct / r.callShort.signals) * 100 : 0), 0) / n;
    const avgPutWrite = results.reduce((s, r) => s + (r.putWrite.signals > 0 ? (r.putWrite.correct / r.putWrite.signals) * 100 : 0), 0) / n;
    const avgMfiOB = results.reduce((s, r) => s + (r.mfiOverbought.signals > 0 ? (r.mfiOverbought.correct / r.mfiOverbought.signals) * 100 : 0), 0) / n;
    const avgMfiOS = results.reduce((s, r) => s + (r.mfiOversold.signals > 0 ? (r.mfiOversold.correct / r.mfiOversold.signals) * 100 : 0), 0) / n;
    console.log(sep);
    console.log(
      `${pad(`AGGREGATE (${n})`, 14)} | ${pad("-", 5)} | ${pad("-", 7)} | ${pad(`avg ${avgOwp.toFixed(1)}%`, 14)} | ${pad(`avg ${avgCallShort.toFixed(1)}%`, 12)} | ${pad(`avg ${avgPutWrite.toFixed(1)}%`, 12)} | ${pad(`avg ${avgMfiOB.toFixed(1)}%`, 10)} | ${pad(`avg ${avgMfiOS.toFixed(1)}%`, 10)}`
    );
  }

  console.log(`\nMetrics: OWP (pos=${OWP_CONTRARIAN ? "bearish(contrarian)" : "bullish"}), CallShort (pos=bearish), PutWrite (pos=bullish), MFI OB/OS. HFT_OWP_CONTRARIAN=1 for contrarian.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

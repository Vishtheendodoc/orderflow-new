#!/usr/bin/env node
/**
 * HFT Threshold Tuning
 * Sweeps OWP_THRESHOLD and MFI OB/OS on today's data, reports best accuracy.
 *
 * Usage: node scripts/tune-hft-thresholds.js
 */

const API_BASE = process.env.API_URL || "https://orderflow-backend-3gwk.onrender.com";
const FETCH_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 60000;

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
  const data = await fetchJson(`${API_BASE.replace(/\/$/, "")}/api/hft_scanner/${encodeURIComponent(index)}`);
  return data?.series?.length ? data : null;
}

async function fetchFuturesState(symbol) {
  const data = await fetchJson(`${API_BASE.replace(/\/$/, "")}/api/state/${encodeURIComponent(symbol)}`);
  return data?.candles?.length ? data : null;
}

function candleUnixMinute(c) {
  const openTime = c.open_time ?? c.chartTime * 1000 ?? 0;
  return Math.floor((openTime / 1000 - 19800) / 60);
}

function hftUnixMinute(snap) {
  return Math.floor((snap.ts ?? snap.timestamp ?? 0) / 60);
}

function computeOWP(flows) {
  const putWrite = (flows["Heavy Put Write"] || 0) + (flows["Put Write"] || 0);
  const callShort = (flows["Call Short"] || 0) + (flows["Heavy Call Short"] || 0);
  return putWrite - callShort;
}

function computeCallShort(flows) {
  return (flows["Call Short"] || 0) + (flows["Heavy Call Short"] || 0);
}

function computePutWrite(flows) {
  return (flows["Put Write"] || 0) + (flows["Heavy Put Write"] || 0);
}

function evalWithParams(series, candles, candleByMin, params) {
  const { owpTh, mfiOb, mfiOs, horizon } = params;
  const res = { owp: { s: 0, c: 0 }, callShort: { s: 0, c: 0 }, putWrite: { s: 0, c: 0 }, mfiOB: { s: 0, c: 0 }, mfiOS: { s: 0, c: 0 } };

  function netDir(hftMin, h) {
    let netChg = 0;
    for (let k = 1; k <= h; k++) {
      const c = candleByMin[hftMin + k];
      if (!c) break;
      netChg += (c.close ?? c.open ?? 0) - (c.open ?? c.close ?? 0);
    }
    return netChg > 0 ? 1 : netChg < 0 ? -1 : 0;
  }

  for (const snap of series) {
    const flows = snap.flows || {};
    const owp = computeOWP(flows);
    const callShort = computeCallShort(flows);
    const putWrite = computePutWrite(flows);
    const mfi = snap.mfi ?? 50;
    const hftMin = hftUnixMinute(snap);
    const dir = netDir(hftMin, horizon);

    if (Math.abs(owp) > owpTh && dir !== 0) {
      res.owp.s++;
      if ((owp > 0 ? 1 : -1) === dir) res.owp.c++;
    }
    if (callShort > owpTh && dir !== 0) {
      res.callShort.s++;
      if (dir === -1) res.callShort.c++;
    }
    if (putWrite > owpTh && dir !== 0) {
      res.putWrite.s++;
      if (dir === 1) res.putWrite.c++;
    }
    if (mfi > mfiOb && dir !== 0) {
      res.mfiOB.s++;
      if (dir === -1) res.mfiOB.c++;
    }
    if (mfi < mfiOs && dir !== 0) {
      res.mfiOS.s++;
      if (dir === 1) res.mfiOS.c++;
    }
  }
  return res;
}

async function main() {
  console.error("Fetching HFT and futures data...");
  const dataByIndex = {};
  for (const [index, futSymbol] of Object.entries(INDEX_TO_FUT)) {
    try {
      const [hftData, futuresState] = await Promise.all([fetchHft(index), fetchFuturesState(futSymbol)]);
      await sleep(FETCH_DELAY_MS);
      if (hftData && futuresState) dataByIndex[index] = { hftData, futuresState };
    } catch (_) {}
  }

  if (Object.keys(dataByIndex).length === 0) {
    console.error("No HFT data.");
    process.exit(1);
  }

  const OWP_GRID = [500, 1000, 2000, 5000];
  const MFI_GRID = [
    [65, 35],
    [70, 30],
    [75, 25],
  ];
  const HORIZON = parseInt(process.env.HFT_HORIZON || "2", 10) || 2;

  let best = { owp: { th: 500, acc: 0 }, mfiOS: { ob: 75, os: 25, acc: 0 } };

  for (const owpTh of OWP_GRID) {
    let totalS = 0, totalC = 0;
    for (const { hftData, futuresState } of Object.values(dataByIndex)) {
      const candles = futuresState.candles.filter((c) => c.closed !== false);
      const candleByMin = {};
      for (const c of candles) candleByMin[candleUnixMinute(c)] = c;
      const r = evalWithParams(hftData.series, candles, candleByMin, { owpTh, mfiOb: 70, mfiOs: 30, horizon: HORIZON });
      totalS += r.owp.s;
      totalC += r.owp.c;
    }
    const acc = totalS > 0 ? (totalC / totalS) * 100 : 0;
    if (totalS >= 20 && acc > best.owp.acc) best.owp = { th: owpTh, acc, sig: totalS };
  }

  for (const [mfiOb, mfiOs] of MFI_GRID) {
    let totalS = 0, totalC = 0;
    for (const { hftData, futuresState } of Object.values(dataByIndex)) {
      const candles = futuresState.candles.filter((c) => c.closed !== false);
      const candleByMin = {};
      for (const c of candles) candleByMin[candleUnixMinute(c)] = c;
      const r = evalWithParams(hftData.series, candles, candleByMin, { owpTh: 1000, mfiOb, mfiOs, horizon: HORIZON });
      totalS += r.mfiOS.s;
      totalC += r.mfiOS.c;
    }
    const acc = totalS > 0 ? (totalC / totalS) * 100 : 0;
    if (totalS >= 10 && acc > best.mfiOS.acc) best.mfiOS = { ob: mfiOb, os: mfiOs, acc, sig: totalS };
  }

  console.log("\n=== HFT Threshold Tuning (Today's Data) ===\n");
  console.log(`OWP_THRESHOLD: best=${best.owp.th} (${best.owp.acc.toFixed(1)}% accuracy)`);
  console.log(`MFI OB/OS: best=${best.mfiOS.ob}/${best.mfiOS.os} (${best.mfiOS.acc.toFixed(1)}% accuracy)`);
  console.log("\nUse: HFT_OWP_THRESHOLD=<val> HFT_MFI_OVERBOUGHT=<ob> HFT_MFI_OVERSOLD=<os>");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

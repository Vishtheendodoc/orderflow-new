#!/usr/bin/env node
/**
 * CAE (Context-Aware Events) Parameter Tuning
 * Fetches today's March future data, sweeps CAE parameters, and finds the best accuracy.
 *
 * Usage: node scripts/tune-cae-params.js
 */

const API_BASE = process.env.API_URL || "https://orderflow-backend-3gwk.onrender.com";
const FETCH_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 60000;

const SYMBOLS = [
  "NIFTY MAR FUT", "BANKNIFTY MAR FUT", "FINNIFTY MAR FUT", "MIDCPNIFTY MAR FUT",
  "RELIANCE MAR FUT", "INFY MAR FUT", "TCS MAR FUT", "HDFCBANK MAR FUT",
  "ICICIBANK MAR FUT", "BHARTIARTL MAR FUT", "ITC MAR FUT", "KOTAKBANK MAR FUT",
  "SBIN MAR FUT", "LT MAR FUT",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchState(symbol) {
  const url = `${API_BASE.replace(/\/$/, "")}/api/state/${encodeURIComponent(symbol)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 404 || !res.ok) return null;
    const data = await res.json();
    if (!data?.candles?.length) return null;
    return data;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function computeContextEvents(candles, params) {
  if (!candles?.length) return [];
  const eps = 1e-8;
  const {
    PREV3_UP = 5,
    PREV3_DOWN = -5,
    PREV2_UP = 5,
    PREV2_FLAT = 2,
    VZP_REV_TOP = 0.25,
    VZP_RALLY_END = 0.2,
    VZP_RALLY_START = 0.25,
    VZP_REV_BOTTOM = 0.2,
  } = params;

  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const open = c.open ?? c.close ?? 0;
    const close = c.close ?? c.open ?? 0;
    const high = c.high ?? Math.max(open, close);
    const low = c.low ?? Math.min(open, close);
    const mid = (high + low) / 2;
    const delta = c.delta ?? (c.buy_vol ?? 0) - (c.sell_vol ?? 0);

    let bidVol = 0, askVol = 0;
    const lvs = Object.values(c.levels || {});
    if (lvs.length > 0) {
      for (const lv of lvs) {
        const p = lv.price ?? 0;
        const vol = (lv.buy_vol ?? 0) + (lv.sell_vol ?? 0) || (lv.total_vol ?? 0);
        if (vol > 0 && isFinite(p)) {
          if (p < mid) bidVol += vol;
          else if (p > mid) askVol += vol;
        }
      }
    }
    const totalVol = bidVol + askVol;
    const vzpRaw = totalVol > eps ? (askVol - bidVol) / totalVol : (delta !== 0 ? -Math.sign(delta) : 0);

    let prev3Chg = 0, prev2Chg = 0;
    if (i >= 3) {
      for (let j = i - 3; j < i; j++) {
        prev3Chg += (candles[j].close ?? candles[j].open ?? 0) - (candles[j].open ?? candles[j].close ?? 0);
      }
    }
    if (i >= 2) {
      for (let j = i - 2; j < i; j++) {
        prev2Chg += (candles[j].close ?? candles[j].open ?? 0) - (candles[j].open ?? candles[j].close ?? 0);
      }
    }

    let event = null;
    if (prev3Chg > PREV3_UP && vzpRaw > VZP_REV_TOP) {
      event = "REVERSAL_TOP";
    } else if (prev2Chg > PREV2_UP && vzpRaw > VZP_RALLY_END) {
      event = "RALLY_END";
    } else if (prev2Chg < PREV2_FLAT && vzpRaw < -VZP_RALLY_START) {
      event = "RALLY_START";
    } else if (prev3Chg < PREV3_DOWN && vzpRaw < -VZP_REV_BOTTOM) {
      event = "REVERSAL_BOTTOM";
    }
    out.push({ event });
  }
  return out;
}

function nextBarDirection(candles, i) {
  if (i + 1 >= candles.length) return null;
  const next = candles[i + 1];
  const open = next.open ?? next.close ?? 0;
  const close = next.close ?? next.open ?? 0;
  const chg = close - open;
  if (chg > 0) return 1;
  if (chg < 0) return -1;
  return 0;
}

const BEARISH_EVENTS = new Set(["REVERSAL_TOP", "RALLY_END"]);
const BULLISH_EVENTS = new Set(["RALLY_START", "REVERSAL_BOTTOM"]);

function evalCAE(events, candles) {
  const byEvent = {};
  let totalSignals = 0, totalCorrect = 0;
  for (let i = 0; i < events.length - 1; i++) {
    const ev = events[i].event;
    if (!ev) continue;
    if (!byEvent[ev]) byEvent[ev] = { signals: 0, correct: 0 };
    byEvent[ev].signals++;
    totalSignals++;
    const dir = nextBarDirection(candles, i);
    if (dir === null || dir === 0) continue;
    const expectedDir = BEARISH_EVENTS.has(ev) ? -1 : 1;
    if (dir === expectedDir) {
      byEvent[ev].correct++;
      totalCorrect++;
    }
  }
  return { byEvent, totalSignals, totalCorrect, accuracy: totalSignals > 0 ? (totalCorrect / totalSignals) * 100 : 0 };
}

// Parameter grid for tuning
const PARAM_GRID = [
  // Trend thresholds (price change sum) - scale with symbol; try tighter and looser
  { PREV3_UP: 3, PREV3_DOWN: -3, PREV2_UP: 3, PREV2_FLAT: 2, VZP_REV_TOP: 0.2, VZP_RALLY_END: 0.18, VZP_RALLY_START: 0.22, VZP_REV_BOTTOM: 0.18 },
  { PREV3_UP: 3, PREV3_DOWN: -3, PREV2_UP: 3, PREV2_FLAT: 0, VZP_REV_TOP: 0.22, VZP_RALLY_END: 0.2, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.2 },
  { PREV3_UP: 5, PREV3_DOWN: -5, PREV2_UP: 5, PREV2_FLAT: 2, VZP_REV_TOP: 0.2, VZP_RALLY_END: 0.18, VZP_RALLY_START: 0.22, VZP_REV_BOTTOM: 0.18 },
  { PREV3_UP: 5, PREV3_DOWN: -5, PREV2_UP: 5, PREV2_FLAT: 2, VZP_REV_TOP: 0.22, VZP_RALLY_END: 0.2, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.2 },
  { PREV3_UP: 5, PREV3_DOWN: -5, PREV2_UP: 5, PREV2_FLAT: 0, VZP_REV_TOP: 0.2, VZP_RALLY_END: 0.2, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.2 },
  { PREV3_UP: 5, PREV3_DOWN: -5, PREV2_UP: 5, PREV2_FLAT: 0, VZP_REV_TOP: 0.25, VZP_RALLY_END: 0.22, VZP_RALLY_START: 0.28, VZP_REV_BOTTOM: 0.22 },
  { PREV3_UP: 8, PREV3_DOWN: -8, PREV2_UP: 5, PREV2_FLAT: 2, VZP_REV_TOP: 0.22, VZP_RALLY_END: 0.2, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.2 },
  { PREV3_UP: 8, PREV3_DOWN: -8, PREV2_UP: 8, PREV2_FLAT: 0, VZP_REV_TOP: 0.25, VZP_RALLY_END: 0.22, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.22 },
  // Stricter VZP (fewer but stronger signals)
  { PREV3_UP: 5, PREV3_DOWN: -5, PREV2_UP: 5, PREV2_FLAT: 2, VZP_REV_TOP: 0.28, VZP_RALLY_END: 0.25, VZP_RALLY_START: 0.28, VZP_REV_BOTTOM: 0.25 },
  { PREV3_UP: 5, PREV3_DOWN: -5, PREV2_UP: 5, PREV2_FLAT: 0, VZP_REV_TOP: 0.28, VZP_RALLY_END: 0.25, VZP_RALLY_START: 0.3, VZP_REV_BOTTOM: 0.25 },
  // Looser trend (more signals)
  { PREV3_UP: 2, PREV3_DOWN: -2, PREV2_UP: 2, PREV2_FLAT: 3, VZP_REV_TOP: 0.2, VZP_RALLY_END: 0.18, VZP_RALLY_START: 0.22, VZP_REV_BOTTOM: 0.18 },
  { PREV3_UP: 2, PREV3_DOWN: -2, PREV2_UP: 2, PREV2_FLAT: 3, VZP_REV_TOP: 0.25, VZP_RALLY_END: 0.2, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.2 },
  // Current defaults (baseline)
  { PREV3_UP: 5, PREV3_DOWN: -5, PREV2_UP: 5, PREV2_FLAT: 2, VZP_REV_TOP: 0.25, VZP_RALLY_END: 0.2, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.2 },
  // Refinements around winner: stricter PREV2_FLAT for RALLY_START
  { PREV3_UP: 8, PREV3_DOWN: -8, PREV2_UP: 8, PREV2_FLAT: -1, VZP_REV_TOP: 0.25, VZP_RALLY_END: 0.22, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.22 },
  { PREV3_UP: 8, PREV3_DOWN: -8, PREV2_UP: 8, PREV2_FLAT: 1, VZP_REV_TOP: 0.25, VZP_RALLY_END: 0.22, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.22 },
  { PREV3_UP: 6, PREV3_DOWN: -6, PREV2_UP: 6, PREV2_FLAT: 0, VZP_REV_TOP: 0.24, VZP_RALLY_END: 0.21, VZP_RALLY_START: 0.24, VZP_REV_BOTTOM: 0.21 },
  { PREV3_UP: 10, PREV3_DOWN: -10, PREV2_UP: 8, PREV2_FLAT: 0, VZP_REV_TOP: 0.25, VZP_RALLY_END: 0.22, VZP_RALLY_START: 0.25, VZP_REV_BOTTOM: 0.22 },
];

async function main() {
  console.error("Fetching today's March future data...");
  const allCandles = [];
  for (const symbol of SYMBOLS) {
    try {
      const state = await fetchState(symbol);
      await sleep(FETCH_DELAY_MS);
      if (state?.candles?.length) {
        const candles = state.candles.filter((c) => c.closed !== false);
        if (candles.length >= 2) {
          allCandles.push({ symbol, candles });
        }
      }
    } catch (e) {
      console.error(`  Skip ${symbol}: ${e.message}`);
    }
  }

  if (allCandles.length === 0) {
    console.error("No data. Check API and market hours.");
    process.exit(1);
  }

  const totalCandles = allCandles.reduce((s, x) => s + x.candles.length, 0);
  console.error(`Loaded ${allCandles.length} symbols, ${totalCandles} candles total.\n`);

  let best = { params: null, accuracy: 0, signals: 0 };
  const results = [];

  for (const params of PARAM_GRID) {
    let totalSignals = 0, totalCorrect = 0;
    for (const { candles } of allCandles) {
      const events = computeContextEvents(candles, params);
      const { totalSignals: s, totalCorrect: c } = evalCAE(events, candles);
      totalSignals += s;
      totalCorrect += c;
    }
    const accuracy = totalSignals > 0 ? (totalCorrect / totalSignals) * 100 : 0;
    results.push({ params: { ...params }, accuracy, signals: totalSignals, correct: totalCorrect });
    if (totalSignals >= 50 && accuracy > best.accuracy) {
      best = { params: { ...params }, accuracy, signals: totalSignals };
    }
  }

  results.sort((a, b) => b.accuracy - a.accuracy);

  console.log("=== CAE Parameter Tuning Results (Today's Data) ===\n");
  console.log("Top 5 parameter sets by accuracy (min 50 signals):\n");
  let shown = 0;
  for (const r of results) {
    if (r.signals < 50) continue;
    if (++shown > 5) break;
    console.log(`#${shown} Accuracy: ${r.accuracy.toFixed(1)}% (${r.correct}/${r.signals} signals)`);
    console.log(`   PREV3_UP=${r.params.PREV3_UP} PREV3_DOWN=${r.params.PREV3_DOWN} PREV2_UP=${r.params.PREV2_UP} PREV2_FLAT=${r.params.PREV2_FLAT}`);
    console.log(`   VZP: REV_TOP=${r.params.VZP_REV_TOP} RALLY_END=${r.params.VZP_RALLY_END} RALLY_START=${r.params.VZP_RALLY_START} REV_BOTTOM=${r.params.VZP_REV_BOTTOM}`);
    console.log("");
  }

  if (best.params) {
    console.log("--- RECOMMENDED (best accuracy) ---");
    console.log(JSON.stringify(best.params, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Aggregate indicator activity for the latest IST calendar day in loaded bars.
 * "Performance" = signal counts + next-bar direction hit rate (same-day bars only).
 */

import {
  LTP_THRESHOLD,
  SIGNAL_THRESHOLD,
  VZP_THRESHOLD,
  DA_THRESHOLD,
  OID_THRESHOLD,
  OID_CONTRARIAN,
  IFI_THRESHOLD,
  IFID_THRESHOLD,
} from "./orderflowIndicators";

const toMs = (t) => (t != null && t < 1e12 ? t * 1000 : t);

function istYmdKey(bar) {
  const ms = toMs(bar?.open_time ?? bar?.chartTime * 1000);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function sameIstDay(a, b) {
  return istYmdKey(a) === istYmdKey(b);
}

/** Indices of the latest IST day segment in bars (inclusive). */
export function getLatestISTDayBounds(bars) {
  if (!bars?.length) return null;
  const end = bars.length - 1;
  const key = istYmdKey(bars[end]);
  let start = end;
  while (start > 0 && istYmdKey(bars[start - 1]) === key) start -= 1;
  return { start, end, dateKey: key, barsInDay: end - start + 1 };
}

function nextCloseRetSign(bars, i) {
  if (i + 1 >= bars.length) return null;
  if (!sameIstDay(bars[i], bars[i + 1])) return null;
  const c0 = bars[i].close ?? bars[i].open ?? 0;
  const c1 = bars[i + 1].close ?? bars[i + 1].open ?? 0;
  if (c0 === c1) return 0;
  return c1 > c0 ? 1 : -1;
}

function accumulate(name, pred, actualSign, agg) {
  if (pred === null || pred === undefined) return;
  const row = agg[name] || (agg[name] = { label: name, fires: 0, wins: 0, scored: 0 });
  row.fires += 1;
  if (actualSign === null) return;
  row.scored += 1;
  if (pred !== 0 && actualSign !== 0 && pred === actualSign) row.wins += 1;
}

/**
 * @param {object[]} bars – processed footprint bars (same order as chart)
 * @param {object} series – parallel arrays (same length as bars when enabled)
 */
export function computeLatestDayIndicatorStats(bars, series) {
  const bounds = getLatestISTDayBounds(bars);
  if (!bounds) return null;

  const {
    ltpArr = [],
    miiArr = [],
    vptArr = [],
    vzpArr = [],
    daArr = [],
    oidArr = [],
    rexArr = [],
    ifiArr = [],
    ifidArr = [],
    ctxArr = [],
  } = series;

  const agg = {};
  const { start, end, dateKey, barsInDay } = bounds;

  for (let i = start; i <= end; i++) {
    const act = nextCloseRetSign(bars, i);

    const ltp = ltpArr[i]?.ltp;
    if (ltp != null && Math.abs(ltp) > LTP_THRESHOLD) {
      accumulate("LTP", ltp > 0 ? 1 : -1, act, agg);
    }

    const mii = miiArr[i]?.mii;
    if (mii != null && Math.abs(mii) > SIGNAL_THRESHOLD) {
      accumulate("MII", mii > 0 ? 1 : -1, act, agg);
    }

    const vpt = vptArr[i]?.vpt;
    if (vpt != null && Math.abs(vpt) > SIGNAL_THRESHOLD) {
      accumulate("VPT", vpt > 0 ? 1 : -1, act, agg);
    }

    const vzpRaw = vzpArr[i]?.vzpRaw ?? vzpArr[i]?.vzp;
    if (vzpRaw != null && Math.abs(vzpRaw) > VZP_THRESHOLD) {
      // Ask-heavy (positive) → bearish short-term; bid-heavy (negative) → bullish
      accumulate("VZP", vzpRaw > 0 ? -1 : 1, act, agg);
    }

    const da = daArr[i]?.da;
    if (da != null && Math.abs(da) > DA_THRESHOLD) {
      accumulate("DA", da > 0 ? 1 : -1, act, agg);
    }

    const oid = oidArr[i]?.oid;
    if (oid != null && Math.abs(oid) > OID_THRESHOLD) {
      let p = null;
      if (OID_CONTRARIAN) {
        if (oid < -OID_THRESHOLD) p = 1;
        else if (oid > OID_THRESHOLD) p = -1;
      } else {
        if (oid > OID_THRESHOLD) p = 1;
        else if (oid < -OID_THRESHOLD) p = -1;
      }
      accumulate("OID", p, act, agg);
    }

    const rex = rexArr[i]?.rex;
    if (rex != null && rex !== 0) {
      accumulate("REX", Math.sign(rex), act, agg);
    }

    const ifi = ifiArr[i]?.ifi ?? ifiArr[i]?.ifiRaw;
    if (ifi != null && Math.abs(ifi) > IFI_THRESHOLD) {
      accumulate("IFI", ifi > 0 ? 1 : -1, act, agg);
    }

    const ifid = ifidArr[i]?.ifi ?? ifidArr[i]?.ifiRaw;
    if (ifid != null && Math.abs(ifid) > IFID_THRESHOLD) {
      accumulate("IFID", ifid > 0 ? 1 : -1, act, agg);
    }

    const ev = ctxArr[i]?.event;
    if (ev) {
      let p = null;
      if (ev === "REVERSAL_TOP" || ev === "RALLY_END") p = -1;
      else if (ev === "RALLY_START" || ev === "REVERSAL_BOTTOM") p = 1;
      accumulate("CAE", p, act, agg);
    }
  }

  const indicators = Object.values(agg).map((row) => ({
    ...row,
    hitRate: row.scored > 0 ? Math.round((100 * row.wins) / row.scored) : null,
  }));

  return {
    dateKey,
    barsInDay,
    dayStartIdx: start,
    dayEndIdx: end,
    indicators: indicators.sort((a, b) => a.label.localeCompare(b.label)),
  };
}

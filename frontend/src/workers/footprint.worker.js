/**
 * Footprint worker — all heavy computation: aggregation, footprint, imbalance, POC.
 * Receives NEW_TRADE; returns UPDATED_CANDLE.
 * No React; no DOM.
 */

import { Trade } from "../models/Trade.js";
import { aggregateTrade, getBucketStart } from "../core/aggregationEngine.js";
import { applyTradeToCandle } from "../core/footprintEngine.js";
import { detectImbalance, detectStackedImbalance } from "../core/imbalanceEngine.js";
import { calculatePOC, calculateValueArea } from "../core/pocEngine.js";
import { buildCumulativeDelta } from "../core/deltaEngine.js";
import { detectAbsorption, detectUnfinishedAuction, runValueArea } from "../core/advancedFootprintEngine.js";

const DEFAULT_INTERVAL_MS = 60 * 1000;

/** @type {Map<number, import("../models/FootprintCandle.js").FootprintCandle>} */
const candleMap = new Map();
let intervalMs = DEFAULT_INTERVAL_MS;
let cumulativeDeltaSeries = [];

function candleToSerializable(candle) {
  const levels = {};
  candle.priceLevels.forEach((lv, p) => {
    levels[p] = {
      price: lv.price,
      bidVolume: lv.bidVolume,
      askVolume: lv.askVolume,
      totalVolume: lv.totalVolume,
      delta: lv.delta,
    };
  });
  const imbalance = {};
  candle.imbalance.forEach((v, k) => {
    imbalance[k] = v;
  });
  return {
    startTime: candle.startTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    totalVolume: candle.totalVolume,
    totalDelta: candle.totalDelta,
    poc: candle.poc,
    valueAreaHigh: candle.valueAreaHigh,
    valueAreaLow: candle.valueAreaLow,
    priceLevels: levels,
    imbalance,
    absorption: candle.absorption,
    unfinishedAuction: candle.unfinishedAuction,
  };
}

function processTrade(payload) {
  const t =
    payload instanceof Trade
      ? payload
      : new Trade(payload.price, payload.qty, payload.side, payload.timestamp);
  const candle = aggregateTrade(candleMap, t, intervalMs);
  if (!candle) return null;
  applyTradeToCandle(candle, t);
  calculatePOC(candle);
  detectImbalance(candle, 3);
  detectStackedImbalance(candle, 2);
  runValueArea(candle, 0.7);
  detectAbsorption(candle, 2);
  detectUnfinishedAuction(candle);

  const candles = Array.from(candleMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c);
  cumulativeDeltaSeries = buildCumulativeDelta(candles);

  return { candle: candleToSerializable(candle), candles, cumulativeDelta: cumulativeDeltaSeries };
}

self.onmessage = (e) => {
  const { type, payload } = e.data || {};
  try {
    if (type === "NEW_TRADE") {
      const result = processTrade(payload);
      if (result) {
        self.postMessage({
          type: "UPDATED_CANDLE",
          payload: result.candle,
          candles: result.candles.map(candleToSerializable),
          cumulativeDelta: result.cumulativeDelta,
        });
      }
    } else if (type === "SET_INTERVAL_MS") {
      intervalMs = payload ?? DEFAULT_INTERVAL_MS;
      self.postMessage({ type: "OK" });
    } else if (type === "GET_STATE") {
      const candles = Array.from(candleMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => candleToSerializable(c));
      self.postMessage({
        type: "STATE",
        candles,
        cumulativeDelta: cumulativeDeltaSeries,
      });
    }
  } catch (err) {
    self.postMessage({ type: "ERROR", error: String(err.message || err) });
  }
};

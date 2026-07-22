"use strict";
// ================================================================
// session.js  v3.3.0  |  PRONTO-AI — UNIFIED TEMPLATE  (EVAL-config: blocks + RR + risk-mult)
//
// v3.3.0 (20 jul 2026) — CONFIG herzien op 635 ghosts (496 oud + 139 nieuw),
// met STRIKTE volgorde-toets (+X bereikt VOOR -1.0) en een HEDGE-PAAR-analyse
// (158 paren: tegengestelde richting, binnen 30 min geopend).
//
//   Kernbevinding hedge-paren, TP 1.5R:
//     een leg TP  59% -> +0.5R    |  BEIDE SL (chop) 40% -> -2.0R
//     EV per paar -0.47R  => de dubbel-SL-kans, NIET de TP-hoogte, bepaalt alles.
//   Dubbel-SL% per uur is daarmee de zuiverste killzone-detector:
//     US100 17u 75% | US100 14u 67% | XAU 15u 83% | XAU 18-19u 60%  -> DICHT
//     US100 10u 17% | XAU 13u 0-20% | XAU 8u 14%                    -> OPEN
//
// Alleen CONFIG gewijzigd t.o.v. v3.2.0 — geen enkele functie aangeraakt.
//
// One codebase for every account. Pick the account with the FIRM env var:
//   FIRM = ftmo_demo | ftmo_eval | maven | vantage | fundednext
//
// Webhook sends TradingView futures:  MGC1! (Micro Gold) and MNQ1! (Micro Nasdaq)
//   -> canonical keys:  XAUUSD (gold)  and  US100.cash (nasdaq)
//   -> per firm, each canonical key is re-routed to that broker's MT5 symbol.
// ================================================================

const TIMEZONE = "Europe/Brussels";

// ======================================================================
//  CONFIG — EDIT HERE
// ======================================================================

// Risk per trade as a fraction of equity. 0.000375 = 0.0375%.
const DEFAULT_RISK_PCT = 0.000375;

// Server SL = sl_pct (from webhook) × SL_BUFFER_MULT × broker execution price.
// The 1.5 buffer covers spread + timing lag. Lower later if you want.
const SL_BUFFER_MULT = 1.5;

// ── Per-firm MT5 reroute + broker lot rules ───────────────────────────
//   mt5         = the exact symbol string on THAT broker's MT5
//   type        = "commodity" (gold) or "index" (nasdaq)
//   volMin      = smallest lot THIS broker allows (HARD floor to trade)
//   volStep     = lot must be a multiple of this, on THIS broker
//   lotDecimals = how many decimals THIS broker accepts on lot size
//                 (2 = 0.01 lots, 1 = 0.1 lots, 0 = whole lots).
//                 Overrides the value derived from volStep. Set per firm.
//   mode        = "collect" (take EVERYTHING, never filtered) or "live"
const FIRMS = {
  ftmo_demo: {
    label: "FTMO-DEMO", mode: "collect", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD",     type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "US100.cash", type: "index",     pip: 0.10, volMin: 0.01, volStep: 0.01 },
    },
  },
  ftmo_eval: {
    label: "FTMO-EVAL", mode: "live", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD",     type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "US100.cash", type: "index",     pip: 0.10, volMin: 0.01, volStep: 0.01 },
    },
  },
  maven: {
    label: "MAVEN", mode: "live", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      // ⚠️ CONFIRM: your list said "US100.cash", your v2.1 code said "US100".
      "US100.cash": { mt5: "US100.cash", type: "index", pip: 0.10, volMin: 0.01, volStep: 0.01 },
    },
  },
  vantage: {
    label: "VANTAGE", mode: "live", lotDecimals: 2,   // firm default
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      // Nasdaq on Vantage trades in 0.1 steps → override decimals for THIS symbol only.
      "US100.cash": { mt5: "NAS100", type: "index",     pip: 0.10, volMin: 0.10, volStep: 0.10, lotDecimals: 1 },
    },
  },
  fundednext: {
    label: "FUNDEDNEXT", mode: "live", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      // ⚠️ CONFIRM: exact Fundednext Nasdaq string + its volMin/volStep.
      "US100.cash": { mt5: "NDX100", type: "index",     pip: 0.01, volMin: 0.01, volStep: 0.01 },
    },
  },
};

// ── Prop-firm drawdown limits (feature #1 — block wiring pending) ──────
// The high-water-mark tracker (1C) already records daily peak/trough open P&L
// and all-time equity peak. When you give the real numbers per firm, fill these
// in and the drawdown guard becomes a one-liner in canOpenNewTrade. Left null =
// no block (tracking only). Values are fractions, e.g. 0.05 = 5%.
const FIRM_LIMITS = {
  ftmo_demo:  { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // demo: no guard, collect everything
  ftmo_eval:  { dailyLossPct: 0.05, maxTotalDDPct: 0.10, trailing: false }, // FTMO: 5% daily / 10% totaal (statisch)
  maven:      { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ fill from firm rules
  vantage:    { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ fill from firm rules
  fundednext: { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ fill from firm rules
};

// ── RISK WINDOWS — THE adaptive lever ─────────────────────────────────
// This is where you raise risk where the data says your EV is best.
// RR stays flat at 1.5R; you scale RISK, per firm + ticker + hour zone.
//
//   RISK_WINDOWS[firm][canonicalTicker] = [{ start, end, mult }]
//   start/end = Brussels hhmm, end-EXCLUSIVE.  mult = risk multiplier.
//
// Final risk = DEFAULT_RISK_PCT × mult.  Empty / no match = 1.0 (flat).
// Example — double risk on Nasdaq 15:00–17:00 on Vantage only:
//   vantage: { "US100.cash": [{ start: 1500, end: 1700, mult: 2.0 }] },
//
// Fill these per firm from the ghost data (best avg peak-R per zone).
const RISK_WINDOWS = {
  // ftmo_demo staat er BEWUST niet in: de demo blijft vlak op 1.0x meten —
  // dat is de schone controledataset waar de optimizer op rekent.
  //
  // US100 10:00-12:00 = de enige zone met bewijs voor MEER size:
  //   EV/trade +0.31R @2.5R (n=57) en dubbel-SL slechts 17% per hedge-paar.
  // Gekozen: 1.5x, niet 2.0x. Reden: dezelfde zone had een reeks van 6
  // verliezers achter elkaar. Op 1.5x is dat -9R, op 2.0x -12R; bij 0,25%
  // risico per trade is dat 2,25% resp. 3,0% van je account uit EEN ochtend —
  // op een 5%-daglimiet. De EV verdubbelt bij 2x, maar de drawdown ook, en
  // het is de drawdown die een eval beeindigt.
  // Wil je toch 2.0x: zet mult op 2.0 en verlaag DEFAULT_RISK_PCT navenant.
  ftmo_eval: {
    "US100.cash": [{ start: 1000, end: 1200, mult: 1.5 }],
  },
  // maven:      {},
  // vantage:    {},
  // fundednext: {},
};

// ── TP risk-reward ────────────────────────────────────────────────────
// FLAT 1.5R everywhere, for every ticker, every hour, every firm.
// RR is NOT the adaptive lever — risk is (see RISK_WINDOWS above).
// Leave TP_RR_WINDOWS empty unless you deliberately want to override RR
// for a ticker+hour. Anything not listed falls through to DEFAULT_TP_RR.
const DEFAULT_TP_RR = 1.5;
const TP_RR_WINDOWS = {
  // ⚠️ BRON (22 jul 2026): per-uur RR uit de Pine ghost-tracker tabellen
  // (screenshots) — per uur de RR die de HOOGSTE EV gaf in die scan. Dit is
  // dezelfde bron als v3.3.1, ANDERS dan de eerdere double-tested 10-12u/12-14u
  // regels hierboven in dit bestand (die met strikte volgorde-toets + hedge-
  // paar-analyse gevalideerd waren). Bekend CONFLICT: double-tested gaf 10u
  // 2.5R (n=57) / 12u 1.9R — deze scan geeft 10u 2.9R (n=105) / 11u 1.5R
  // (n=110) / 12u 0.6R (n=86). Behandel als startpunt, niet als bewezen.
  // Elk uur niet hieronder gelijst valt terug op DEFAULT_TP_RR (1.5R).
  "XAUUSD": [
    { start: 0,    end: 100,  rr: 3.0 },
    { start: 100,  end: 200,  rr: 3.0 },
    { start: 200,  end: 300,  rr: 3.0 },
    { start: 300,  end: 400,  rr: 2.6 },
    { start: 400,  end: 500,  rr: 2.8 },
    { start: 500,  end: 600,  rr: 2.8 },
    { start: 600,  end: 700,  rr: 2.4 },
    { start: 700,  end: 800,  rr: 1.3 },
    { start: 800,  end: 900,  rr: 2.7 },
    { start: 900,  end: 1000, rr: 2.7 },
    { start: 1000, end: 1100, rr: 1.2 },
    { start: 1100, end: 1200, rr: 0.7 },
    { start: 1200, end: 1300, rr: 2.5 },
    { start: 1300, end: 1400, rr: 1.4 },
    { start: 1400, end: 1500, rr: 1.4 },
    { start: 1500, end: 1600, rr: 1.9 },
    { start: 1600, end: 1700, rr: 0.6 },
    { start: 1700, end: 1800, rr: 0.8 },
    { start: 1800, end: 1900, rr: 0.8 },
    { start: 1900, end: 2000, rr: 0.6 },
    { start: 2000, end: 2100, rr: 0.6 },
    { start: 2100, end: 2200, rr: 0.6 },
    { start: 2200, end: 2300, rr: 2.5 },
    // 23:00 ontbreekt in de ghost-tracker tabel -> valt terug op DEFAULT_TP_RR (1.5R).
  ],
  // ⚠️ NQ 21:00-23:00 ontbraken in de screenshot (rij afgesneden) -> geen entry
  // hieronder, dus die uren vallen terug op DEFAULT_TP_RR (1.5R) tot je die cijfers
  // aanlevert.
  "US100.cash": [
    { start: 0,    end: 100,  rr: 2.8 },
    { start: 100,  end: 200,  rr: 1.4 },
    { start: 200,  end: 300,  rr: 1.5 },
    { start: 300,  end: 400,  rr: 3.0 },
    { start: 400,  end: 500,  rr: 0.6 },
    { start: 500,  end: 600,  rr: 2.4 },
    { start: 600,  end: 700,  rr: 1.8 },
    { start: 700,  end: 800,  rr: 1.9 },
    { start: 800,  end: 900,  rr: 2.2 },
    { start: 900,  end: 1000, rr: 2.3 },
    { start: 1000, end: 1100, rr: 2.9 },
    { start: 1100, end: 1200, rr: 1.5 },
    { start: 1200, end: 1300, rr: 0.6 },
    { start: 1300, end: 1400, rr: 0.7 },
    { start: 1400, end: 1500, rr: 0.6 },
    { start: 1500, end: 1600, rr: 0.8 },
    { start: 1600, end: 1700, rr: 0.6 },
    { start: 1700, end: 1800, rr: 0.9 },
    { start: 1800, end: 1900, rr: 1.3 },
    { start: 1900, end: 2000, rr: 1.7 },
    { start: 2000, end: 2100, rr: 1.9 },
  ],
};

// ── Time blocks (per canonical ticker). DEMO (collect mode) IGNORES these.
//    Empty = nothing blocked (all live firms take everything until the model).
const TIME_BLOCK_WINDOWS = {
  // Onderbouwing per uur — 635 ghosts, strikte volgorde + dubbel-SL per hedge-paar.
  //
  // US100 14:00-18:00  (was 15:00-18:00)
  //   14u: EV -0.40 (n=26), dubbel-SL 67% (9 paren) -> slechtste uur van de dag
  //   15u: EV -0.22 (n=41), dubbel-SL 50% | 16u: -0.24 (n=42), 54% | 17u: -0.30 (n=32), 75%
  //   19-21u block van v3.2.1 is VERVALLEN: gecombineerd n=11, EV -0.05 = neutraal.
  //
  // XAUUSD 10:00-12:00 + 15:00-18:00 + 19:00-22:00
  //   10u: EV -0.17 (n=41), dubbel-SL 42% | 11u: -0.31 (n=40), 56%      -> dicht
  //   12-15u: EV +0.06/+0.05, dubbel-SL 0-20%                            -> OPEN (was dicht)
  //   15u: EV -0.33 (n=19), dubbel-SL 83% | 16u: -0.21 | 17u: -0.25      -> dicht
  //   19u: EV -0.36 (n=20) | 20u: -0.18 | 21u: -0.08                     -> dicht
  //   22-23u: EV +0.08 (n=11), beste paar-EV van goud                    -> OPEN (was dicht)
  "US100.cash": [{ start: 1400, end: 1800 }],
  "XAUUSD":     [{ start: 1000, end: 1200 },
                 { start: 1500, end: 1800 },
                 { start: 1900, end: 2200 }],
};

// Symbols we explicitly refuse (other indices that must never be traded).
const BLOCKED_SYMBOLS = new Set([
  "US30USD","US30","DOW","DJI","DJIA",
  "DE30EUR","DE30","DAX","GER30","GER40",
  "UK100GBP","UK100","FTSE","FTSE100",
  "SP500","SPX","US500","SPX500",
  "JP225","JPN225","NIKKEI",
]);

// TradingView symbol → canonical key.
// ONLY the two tickers the webhook actually sends. Nothing else is accepted —
// any other symbol falls through to SYMBOL_NOT_ALLOWED and is logged, not traded.
const SYMBOL_ALIASES = {
  "MGC1!": "XAUUSD",      // Micro Gold    → gold
  "MNQ1!": "US100.cash",  // Micro Nasdaq  → nasdaq
};

// ======================================================================
//  END CONFIG
// ======================================================================

// ── Resolve the active firm from the env var ──────────────────────────
const FIRM = (process.env.FIRM || process.env.BROKER || "ftmo_demo").toLowerCase().trim();
if (!FIRMS[FIRM]) {
  throw new Error(`[session.js] Unknown FIRM="${FIRM}". Must be: ${Object.keys(FIRMS).join(" | ")}`);
}
const FIRM_CFG        = FIRMS[FIRM];

// ── Model gate mode (feature 10) ──────────────────────────────────────
//   off    — model never runs
//   shadow — model runs and is logged to model_decisions, but never blocks (default)
//   live   — a model "skip" verdict blocks the trade
const MODEL_MODE = (process.env.MODEL_MODE || "shadow").toLowerCase().trim();

const MODE            = FIRM_CFG.mode;                 // "collect" | "live"
const SYMBOL_CATALOG  = FIRM_CFG.symbols;             // canonical -> { mt5, type, volMin, volStep }
const BROKER          = FIRM;                          // back-compat alias for server.js
const BROKER_SYMBOL_MAP = { [FIRM]: FIRM_CFG.symbols };// back-compat shape for server.js

console.log(`[session.js] FIRM="${FIRM}" (${FIRM_CFG.label}) mode=${MODE} | ` +
  `gold->"${SYMBOL_CATALOG["XAUUSD"].mt5}" nasdaq->"${SYMBOL_CATALOG["US100.cash"].mt5}"`);

// ── Volume rounding: round DOWN to volStep, enforce volMin, apply multiplier ──
function roundLots(rawLots, symInfo) {
  const step = symInfo.volStep ?? 0.01;
  const min  = symInfo.volMin  ?? 0.01;
  // Decimal precedence:  per-SYMBOL override  →  per-FIRM default  →  derived from volStep.
  // A broker that only accepts 1 decimal must never be sent 0.37.
  const stepStr = step.toString();
  const derived = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;
  const decimals = Number.isInteger(symInfo.lotDecimals) ? symInfo.lotDecimals
                 : Number.isInteger(FIRM_CFG.lotDecimals) ? FIRM_CFG.lotDecimals
                 : derived;
  const stepsCount = Math.floor(rawLots / step + 1e-9);          // guard float drift
  const stepped    = parseFloat((stepsCount * step).toFixed(decimals));
  const result     = Math.max(min, stepped);                      // never below broker minimum
  return parseFloat(result.toFixed(decimals));
}

// ── Brussels time helpers ─────────────────────────────────────────────
function getBrusselsComponents(date = null) {
  const d = date ? new Date(date) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value;
  const dayMap = { Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6 };
  const day    = dayMap[get("weekday")] ?? 0;
  const hour   = parseInt(get("hour")) % 24;
  const minute = parseInt(get("minute"));
  const second = parseInt(get("second"));
  return { day, hour, minute, second, hhmm: hour * 100 + minute };
}

function getBrusselsDateStr(date = null) {
  const d = date ? new Date(date) : new Date();
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TIMEZONE }).format(d);
}

function getSession(date = null) {
  const { hhmm } = getBrusselsComponents(date);
  if (hhmm >= 200 && hhmm < 800)  return "asia";
  if (hhmm >= 800 && hhmm < 1530) return "london";
  return "ny";
}

function isWeekend(date = null) {
  const { day } = getBrusselsComponents(date);
  return day === 0 || day === 6;
}

// ── Symbol normalization ──────────────────────────────────────────────
// Canonical form used for matching: strip EVERYTHING that is not A-Z or 0-9.
// So "MGC1!", "mgc1!", " MGC1 " all reduce to "MGC1".
function _canon(s) { return s.toString().toUpperCase().replace(/[^A-Z0-9]/g, ""); }

// Pre-build the lookup once: canonical-input → canonical key.
const _ALIAS_LOOKUP = {};
for (const [alias, target] of Object.entries(SYMBOL_ALIASES)) _ALIAS_LOOKUP[_canon(alias)] = target;

function normalizeSymbol(raw) {
  if (!raw) return null;
  return _ALIAS_LOOKUP[_canon(raw)] ?? null;
}

function getSymbolInfo(raw) {
  if (!raw) return null;
  // Accept a canonical key directly (server.js normalizes first, then calls this
  // with "XAUUSD" / "US100.cash"), OR a raw webhook ticker ("MGC1!").
  if (SYMBOL_CATALOG[raw]) return { ...SYMBOL_CATALOG[raw], key: raw };
  const key = normalizeSymbol(raw);
  if (!key || !SYMBOL_CATALOG[key]) return null;
  return { ...SYMBOL_CATALOG[key], key };
}

function getVwapPosition(price, vwapMid) {
  if (price == null || vwapMid == null || vwapMid === 0) return "unknown";
  return parseFloat(price) >= parseFloat(vwapMid) ? "above" : "below";
}

// Optimizer key = "XAUUSD_london_buy_above" — the analytics bucket the AI learns from.
function buildOptimizerKey(symbol, session, direction, vwapPos) {
  return `${symbol}_${session}_${direction}_${vwapPos}`;
}

function buildDailyLabel(date, count) {
  const s = getBrusselsDateStr(date);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}-#${count}`;
}

function _fmtHHMM(n) {
  const s = String(n).padStart(4, "0");
  return s.slice(0, 2) + ":" + s.slice(2);
}

function isTimeBlocked(symbolKey, date = null) {
  const windows = TIME_BLOCK_WINDOWS[symbolKey];
  if (!windows) return null;
  const { hhmm } = getBrusselsComponents(date);
  for (const w of windows) if (hhmm >= w.start && hhmm < w.end) return w;
  return null;
}

// TP risk-reward for a ticker at a given time.
function getTpRR(symbolKey, date = null) {
  if (MODE === "collect") return DEFAULT_TP_RR;   // demo blijft flat 1.5R — schone controle
  const windows = TP_RR_WINDOWS[symbolKey];
  if (windows) {
    const { hhmm } = getBrusselsComponents(date);
    for (const w of windows) if (hhmm >= w.start && hhmm < w.end) return w.rr;
  }
  return DEFAULT_TP_RR;
}

// Risk multiplier for this firm + ticker at a given time (default 1.0).
function getRiskMult(symbolKey, date = null) {
  const byFirm = RISK_WINDOWS[FIRM];
  const windows = byFirm && byFirm[symbolKey];
  if (!windows || !windows.length) return 1.0;
  const { hhmm } = getBrusselsComponents(date);
  for (const w of windows) if (hhmm >= w.start && hhmm < w.end) return w.mult ?? 1.0;
  return 1.0;
}

// Gate: weekends + unknown/blocked symbols always refused.
// Time blocks apply to LIVE firms only — DEMO (collect) takes everything.
function canOpenNewTrade(rawSymbol, date = null) {
  if (isWeekend(date)) return { allowed: false, reason: "WEEKEND" };
  const upper = (rawSymbol || "").toString().toUpperCase().trim().replace(/[^A-Z0-9./]/g, "");
  if (BLOCKED_SYMBOLS.has(upper)) return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — explicitly blocked` };
  const sym = normalizeSymbol(rawSymbol);
  if (!sym) return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — only gold & nasdaq` };
  if (MODE !== "collect") {
    const blk = isTimeBlocked(sym, date);
    if (blk) return { allowed: false, reason: `TIME_BLOCK: ${sym} ${_fmtHHMM(blk.start)}\u2013${_fmtHHMM(blk.end)} Brussels` };
  }
  return { allowed: true, reason: null };
}

module.exports = {
  TIMEZONE, DEFAULT_RISK_PCT, SL_BUFFER_MULT,
  FIRM, MODE, MODEL_MODE, BROKER, BROKER_SYMBOL_MAP, FIRMS, FIRM_LIMITS,
  SYMBOL_CATALOG, SYMBOL_ALIASES,
  getBrusselsComponents, getBrusselsDateStr,
  getSession, isWeekend,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey, buildDailyLabel,
  canOpenNewTrade, TIME_BLOCK_WINDOWS, isTimeBlocked,
  DEFAULT_TP_RR, TP_RR_WINDOWS, getTpRR,
  RISK_WINDOWS, getRiskMult, roundLots,
};

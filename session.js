"use strict";
// ================================================================
// session.js  v3.4.0  |  PRONTO-AI — UNIFIED TEMPLATE
//
// v3.4.0 (23 jul 2026) — CONFIG HERZIEN op 240 SCHONE ghosts uit de
// data-collector (132 US100 + 108 XAUUSD, 13-23 juli, huidige systeem).
//
// WAT ER VERANDERDE T.O.V. v3.3.1 EN WAAROM
//
// 1. PER-UUR RR-TABEL VERVANGEN DOOR ZONES.
//    De oude tabel koos per uur het beste van ~45 RR-niveaus bij n≈5 per
//    uur. Het maximum van 45 ruizige schattingen ligt structureel te hoog:
//    dat is selectiebias, geen edge. Zichtbaar aan de sprongen 10u 2.9R,
//    11u 1.5R, 12u 0.6R — drie aangrenzende uren van dezelfde markt.
//    Nu: 2-3 zones per symbool met n=12-33, RR geklemd op 1.0-2.5.
//
// 2. ALLE RR ONDER 1.0 VERWIJDERD.
//    Break-even winrate = 1/(1+RR). Bij 0.6R heb je 62,5% nodig, vóór
//    spread en commissie. Hoogste gemeten winrate in de dataset: 56%.
//
// 3. ZONES MET n<10 KRIJGEN GEEN EIGEN RR — die vallen terug op
//    DEFAULT_TP_RR. Op n=6 het maximum van de curve kiezen is punt 1.
//
// 4. RISK-MULTIPLIER 2.0x OP DE POSITIEVE-EV ZONES (n>=10 EN EV>0).
//    Drie zones halen die lat. Zie RISK_WINDOWS voor de drawdown-rekensom.
//
// 5. TWEE DODE ZONES DICHT: US100 02-04u en 19-23u (EV -0.55, avg peak
//    0.44-0.54R — de gemiddelde trade komt daar niet halverwege zijn SL).
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
// Met RISK_EQUITY=50000 -> $18,75 per trade op 1.0x.
const DEFAULT_RISK_PCT = 0.000375;

// Server SL = sl_pct (from webhook) × SL_BUFFER_MULT × broker execution price.
const SL_BUFFER_MULT = 1.5;

// Harde grenzen voor elke RR die uit een venster komt. Voorkomt dat een
// typefout (0.06 i.p.v. 0.6) of een toekomstige AI-config iets onmogelijks
// doorlaat. 1.0 = break-even bij 50% WR; 2.5 = break-even bij 28,6%.
const RR_MIN = 1.0;
const RR_MAX = 2.5;

// ── Per-firm MT5 reroute + broker lot rules ───────────────────────────
//   mt5         = the exact symbol string on THAT broker's MT5
//   volMin/Step = broker lot rules; lotDecimals overrides derived decimals
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
    label: "VANTAGE", mode: "live", lotDecimals: 2,
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

// ── Prop-firm drawdown limits ─────────────────────────────────────────
const FIRM_LIMITS = {
  ftmo_demo:  { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // demo: geen guard
  ftmo_eval:  { dailyLossPct: 0.05, maxTotalDDPct: 0.10, trailing: false }, // FTMO 5%/10% statisch
  maven:      { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ fill from firm rules
  vantage:    { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ fill from firm rules
  fundednext: { dailyLossPct: null, maxTotalDDPct: null, trailing: false }, // ⚠️ fill from firm rules
};

// ── RISK WINDOWS — 2.0x op de positieve-EV zones ──────────────────────
//
//   Criterium: n >= 10 EN EV > 0 in de schone dataset. Drie zones halen dat.
//   Zones met n < 10 blijven op 1.0x, hoe mooi hun EV ook oogt — op n=6 is
//   +0.75R één trade verschil.
//
//     ZONE                    n     RR     WR     EV      mult
//     US100  10:00-12:00     33    1.25   48%   +0.09     2.0x
//     XAUUSD 00:00-06:00     14    2.50   36%   +0.25     2.0x
//     XAUUSD 17:00-19:00     12    1.25   50%   +0.12     2.0x
//
//   DE REKENSOM (eval 10k, RISK_EQUITY=50000):
//     1.0x = $18,75/trade = 0,19% van het account
//     2.0x = $37,50/trade = 0,375%
//   Zes verliezers op rij in de 10-12u zone (is voorgekomen) = -2,25%.
//   Past binnen de 5%-daglimiet. MAAR dit systeem hedget: op 21 juli stonden
//   er TIEN US100-posities tegelijk open. Tien legs op 2.0x die samen
//   uitstoppen = 3,75% op één dag, 75% van je daglimiet uit één cluster.
//   Het risico zit in de STAPELING, niet in de reeks.
//   Twee manieren om dat af te dekken:
//     a) max-gelijktijdige-posities guard in server.js, of
//     b) DEFAULT_RISK_PCT naar 0.00025 (dan is 2.0x weer 0,25%/trade).
const RISK_WINDOWS = {
  // ftmo_demo staat er BEWUST niet in: de demo blijft vlak op 1.0x meten —
  // dat is de schone controledataset waar de optimizer op rekent.
  ftmo_eval: {
    "US100.cash": [{ start: 1000, end: 1200, mult: 2.0 }],
    "XAUUSD":     [{ start: 0,    end: 600,  mult: 2.0 },
                   { start: 1700, end: 1900, mult: 2.0 }],
  },
  // maven:      {},
  // vantage:    {},
  // fundednext: {},
};

// ── TP risk-reward — ZONES, niet per uur ──────────────────────────────
const DEFAULT_TP_RR = 1.5;
const TP_RR_WINDOWS = {
  // US100 (n=132)
  //   10-12u  n=33 -> 1.25R : WR 48% EV +0.09 | 1.5R -0.02 | 1.9R -0.12 | 2.5R -0.05
  //           grootste sample van de dataset; het laagste niveau wint duidelijk
  //   12-14u  n=25 -> 2.5R  : WR 28% EV -0.02 | 1.9R -0.19 | 1.5R -0.30 | 1.0R -0.44
  //           exact break-even. Open gelaten, maar dit is de eerste kandidaat
  //           om te blokkeren als hij negatief blijft.
  //   00-02u (n=9), 04-07u (n=8), 07-10u (n=6): te dun -> DEFAULT_TP_RR.
  "US100.cash": [
    { start: 1000, end: 1200, rr: 1.25 },
    { start: 1200, end: 1400, rr: 2.5  },
  ],
  // XAUUSD (n=108)
  //   00-06u  n=14 -> 2.5R  : WR 36% EV +0.25 (3.0R gaf +0.43, geklemd op 2.5)
  //   13-15u  n=18 -> 1.25R : WR 44% EV  0.00 | 1.5R -0.17 | 2.5R -0.42
  //   17-19u  n=12 -> 1.25R : WR 50% EV +0.12 | 1.5R -0.17
  //   06-10u (n=6) en 22-23u (n=6): te dun -> DEFAULT_TP_RR.
  "XAUUSD": [
    { start: 0,    end: 600,  rr: 2.5  },
    { start: 1300, end: 1500, rr: 1.25 },
    { start: 1700, end: 1900, rr: 1.25 },
  ],
};

// ── Time blocks (per canonical ticker). DEMO (collect) IGNORES these. ──
const TIME_BLOCK_WINDOWS = {
  // US100
  //   02-04u  n=10  EV -0.55  avg peak 0.54   -> NIEUW, dode chop
  //   14-18u  n=20 vers (EV -0.50 / -0.17) + n=84-115 historisch, beide negatief
  //   19-23u  n=11  EV -0.55  avg peak 0.44   -> NIEUW, laagste peak van de dag
  "US100.cash": [{ start: 200,  end: 400  },
                 { start: 1400, end: 1800 },
                 { start: 1900, end: 2300 }],
  // XAUUSD
  //   10-12u  vers n=16 EV +0.12 (alleen op 1.0R) vs historisch n=81 EV -0.17/-0.31
  //           -> gecombineerd bewijs leunt negatief, blijft DICHT. Laat de
  //              optimizer dit heropenen als de verse data volhoudt.
  //   15-17u  n=17  EV -0.41  -> dicht. (Dit venster is op 21 juli heropend na
  //           één 6,32R-runner; de volledige dataset weerlegt dat. Hersteld.)
  //   19-22u  n=19  EV -0.47  -> best onderbouwde blok van goud, ook historisch
  "XAUUSD":     [{ start: 1000, end: 1200 },
                 { start: 1500, end: 1700 },
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
const FIRM_CFG = FIRMS[FIRM];

// ── Model gate mode ───────────────────────────────────────────────────
//   off | shadow (default, logt maar blokkeert nooit) | live
const MODEL_MODE = (process.env.MODEL_MODE || "shadow").toLowerCase().trim();

const MODE              = FIRM_CFG.mode;
const SYMBOL_CATALOG    = FIRM_CFG.symbols;
const BROKER            = FIRM;
const BROKER_SYMBOL_MAP = { [FIRM]: FIRM_CFG.symbols };

console.log(`[session.js] v3.4.0 FIRM="${FIRM}" (${FIRM_CFG.label}) mode=${MODE} | ` +
  `gold->"${SYMBOL_CATALOG["XAUUSD"].mt5}" nasdaq->"${SYMBOL_CATALOG["US100.cash"].mt5}"`);

// ── Volume rounding: round DOWN to volStep, enforce volMin ────────────
function roundLots(rawLots, symInfo) {
  const step = symInfo.volStep ?? 0.01;
  const min  = symInfo.volMin  ?? 0.01;
  const stepStr = step.toString();
  const derived = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;
  const decimals = Number.isInteger(symInfo.lotDecimals) ? symInfo.lotDecimals
                 : Number.isInteger(FIRM_CFG.lotDecimals) ? FIRM_CFG.lotDecimals
                 : derived;
  const stepsCount = Math.floor(rawLots / step + 1e-9);
  const stepped    = parseFloat((stepsCount * step).toFixed(decimals));
  const result     = Math.max(min, stepped);
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
function _canon(s) { return s.toString().toUpperCase().replace(/[^A-Z0-9]/g, ""); }

const _ALIAS_LOOKUP = {};
for (const [alias, target] of Object.entries(SYMBOL_ALIASES)) _ALIAS_LOOKUP[_canon(alias)] = target;

function normalizeSymbol(raw) {
  if (!raw) return null;
  return _ALIAS_LOOKUP[_canon(raw)] ?? null;
}

function getSymbolInfo(raw) {
  if (!raw) return null;
  if (SYMBOL_CATALOG[raw]) return { ...SYMBOL_CATALOG[raw], key: raw };
  const key = normalizeSymbol(raw);
  if (!key || !SYMBOL_CATALOG[key]) return null;
  return { ...SYMBOL_CATALOG[key], key };
}

function getVwapPosition(price, vwapMid) {
  if (price == null || vwapMid == null || vwapMid === 0) return "unknown";
  return parseFloat(price) >= parseFloat(vwapMid) ? "above" : "below";
}

// Optimizer key = "XAUUSD_london_buy_above"
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

// TP risk-reward voor een ticker op een tijdstip — MET CLAMP.
function getTpRR(symbolKey, date = null) {
  if (MODE === "collect") return DEFAULT_TP_RR;   // demo blijft flat 1.5R
  const windows = TP_RR_WINDOWS[symbolKey];
  if (windows) {
    const { hhmm } = getBrusselsComponents(date);
    for (const w of windows) {
      if (hhmm >= w.start && hhmm < w.end) {
        const rr = Number(w.rr);
        if (!Number.isFinite(rr)) break;
        const clamped = Math.min(Math.max(rr, RR_MIN), RR_MAX);
        if (clamped !== rr) {
          console.warn(`[session.js] RR ${rr} buiten [${RR_MIN}, ${RR_MAX}] voor ${symbolKey} ` +
            `${_fmtHHMM(w.start)}-${_fmtHHMM(w.end)} -> geklemd op ${clamped}`);
        }
        return clamped;
      }
    }
  }
  return DEFAULT_TP_RR;
}

// Risk multiplier voor deze firm + ticker op een tijdstip (default 1.0).
function getRiskMult(symbolKey, date = null) {
  if (MODE === "collect") return 1.0;             // demo meet altijd op 1.0x
  const byFirm = RISK_WINDOWS[FIRM];
  const windows = byFirm && byFirm[symbolKey];
  if (!windows || !windows.length) return 1.0;
  const { hhmm } = getBrusselsComponents(date);
  for (const w of windows) if (hhmm >= w.start && hhmm < w.end) return w.mult ?? 1.0;
  return 1.0;
}

// Gate: weekends + onbekende/geblokte symbolen altijd geweigerd.
// Time blocks gelden alleen voor LIVE firms — DEMO (collect) neemt alles.
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
  TIMEZONE, DEFAULT_RISK_PCT, SL_BUFFER_MULT, RR_MIN, RR_MAX,
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

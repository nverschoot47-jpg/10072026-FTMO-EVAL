"use strict";
// ================================================================
// session.js  v6.0.0  |  PRONTO-AI — UNIFIED TEMPLATE
//
// v6.0.0 (7 aug 2026) — HERBOUWD op walk-forward validatie.
//
// WAT ER VERANDERD IS T.O.V. v5.0.0 EN WAAROM
//
//   Elke filter uit v5 is opnieuw getest door de dataset in TWEE HELFTEN te
//   splitsen (13-24 juli / 24 juli-7 aug) en te kijken of het effect in BEIDE
//   helften dezelfde kant op wijst. Een filter die alleen over de hele set
//   goed meet maar in één helft omklapt, is gekalibreerd op ruis.
//
//   Dit is de test die v5 niet had. Resultaat:
//
//   BEHOUDEN (beide helften zelfde teken):
//     - Goud 14-24u blok      h1 -0,117  h2 -0,096   <- sterkste filter
//     - Kanaalfilter, maar bij 0,87 i.p.v. 1,25 (zie hieronder)
//     - Cooldown 5 min        kost bijna niets, snijdt drawdown
//
//   AANGEPAST:
//     - MIN_CHAN_R 1,25 -> 0,87
//     - TP per symbool i.p.v. één getal voor allebei
//
//   UITGEZET (klapt om tussen de helften):
//     - Tegenpositie-filter   h1 +0,235 vs h2 -0,005 -> effect verdwijnt
//     - Segmentfilters (symbool x sessie x richting)
//
// ── DE KANAALFILTER: WAAROM 0,87 EN NIET 1,25 ─────────────────────────
//
//   chanR = (session_high - session_low) / sl_dist
//
//     chanR-bak            n    EV h1    EV h2    totaal R
//     < 0,87             104   -0,239   -0,152     -18,6   <- weg
//     0,87 - 1,25        128   +0,153   -0,110      +2,3   <- v5 gooide dit weg
//     >= 1,25            362   +0,129   +0,084     +39,5   <- houden
//
//   De onderste bak is in beide helften negatief: solide bewijs. De middelste
//   bak klapt om van +0,153 naar -0,110 en is over het geheel licht POSITIEF.
//   v5 sneed die weg op basis van een teken dat wisselt. Dat is 128 trades
//   (22% van het totaal) weggooien zonder aantoonbare reden.
//
//   0,87 is niet willekeurig: het is het punt waar de stopafstand groter wordt
//   dan de hele sessierange. Ligt je stop verder weg dan de markt die sessie
//   bewogen heeft, dan is er fysiek geen ruimte om je TP te halen.
//
// ── TP PER SYMBOOL ────────────────────────────────────────────────────
//
//   Ghost-winrates gekalibreerd tegen de echte MT5-closes (de ghost mist ~8%
//   van de US100-hits en ~17% van de goud-hits door gaten in de milestones).
//
//   US100.cash (n=287)          XAUUSD (n=312)
//     TP     EV      h1     h2     TP     EV      h1     h2
//     1,5  +0,098  +0,011 +0,018   1,5  -0,016  -0,102 -0,215
//     1,7  +0,136  +0,016 +0,082   1,7  -0,050  -0,156 -0,224
//     1,9  +0,142  -0,012 +0,121   1,9  -0,014  -0,151 -0,165
//     2,2  +0,100  -0,068 +0,101   2,2  +0,017  -0,104 -0,163
//     2,5  +0,096                  2,5  -0,066
//
//   US100: 1,7R is het HOOGSTE niveau dat in BEIDE helften positief blijft.
//   1,9R meet over het geheel mooier (+0,142) maar helft 1 is dan negatief —
//   dat is precies de fout die v5 maakte met 2,5R. 2,5R leunt volledig op
//   helft 2 en was onderbouwd met n=61.
//
//   XAUUSD: negatief op ELK TP-niveau, in BEIDE helften. Geen TP repareert
//   goud. Daarom blijft goud op 1,5R staan — niet omdat dat goed is, maar
//   omdat verhogen het aantoonbaar erger maakt. Het echte goudprobleem is de
//   stopafstand: goud-WINNAARS gingen gemiddeld eerst -1,03R tegen je in
//   (US100: -0,90R). Je stop zit te krap voor de volatiliteit van dat
//   instrument. Dat is de volgende test, niet iets voor deze config.
//
// ── WAT DE HELE STRATEGIE WAARD IS ────────────────────────────────────
//
//   874 broker-trades (16 juni - 6 aug), echte P&L incl. commissie:
//     winrate 42,4% | gem. winst +1,58R | gem. verlies -1,03R
//     EV +0,077R per trade | +67,7R | +EUR 1.169 | max DD EUR 1.121
//
//   De drawdown is bijna gelijk aan de totale winst. En per halve maand:
//     tot 15 jun  203 trades  +37,9R
//     tot 30 jun   60 trades  +26,7R
//     tot 15 jul  505 trades   +4,2R
//     tot 31 jul  106 trades   -1,1R
//
//   Bijna alles komt uit juni. Sinds midden juli sta je vlak over 600+ trades.
//   Deze config maakt daar geen winstmachine van — hij haalt de aantoonbaar
//   negatieve stukken eruit. Verwacht +0,10 tot +0,13R op US100 en rond nul
//   op goud. Meer beloven zou liegen zijn.
//
// ── LET OP: server.js ROEPT canOpenNewTrade MET ÉÉN ARGUMENT AAN ──────
//
//   In server.js staat nu:
//       const { allowed, reason } = canOpenNewTrade(rawSym);
//
//   Daardoor draaien chanR-filter, cooldown en noodrem NIET — ctx is leeg,
//   openPositions is null, en markTradePlaced() wordt nergens aangeroepen.
//   Alleen het tijdblok, de weekendcheck en de symboolfilter zijn actief.
//
//   Zie ONDERAAN dit bestand voor de exacte patch. Zonder die patch is dit
//   bestand functioneel gelijk aan v5 minus het tijdblok.
//
// One codebase for every account. Pick the account with the FIRM env var:
//   FIRM = ftmo_demo | ftmo_eval | maven | vantage | fundednext
// ================================================================

const TIMEZONE = "Europe/Brussels";

// ======================================================================
//  CONFIG
// ======================================================================

// ── RISICO ────────────────────────────────────────────────────────────
//
//   EUR 20 per trade. Gemeten max drawdown 24R:
//     EUR 20/trade -> EUR  480  (4,8% van een 10k eval)
//     EUR 40/trade -> EUR  960  (9,6% tegen een 10%-limiet)
//
//   Verhoog naar EUR 40 pas bij 200+ NIEUWE trades met een EV boven +0,05R.
//   Het 95%-interval van de EV over 874 trades is [-0,011 , +0,166] — nul zit
//   er nog in. Dat is de reden, niet voorzichtigheid om de voorzichtigheid.
const RISK_EUR = 20;

// Absolute noodrem. Hoogst ooit gemeten gelijktijdigheid is 21. Raakt hij deze
// grens, dan is er iets structureel mis (webhook-storm, dubbele deploy).
const NOODREM_POSITIES = 40;
const MAX_CONCURRENT   = NOODREM_POSITIES;

// Achterwaartse compat voor server.js, dat sizet via SIZING_EQUITY * DEFAULT_RISK_PCT.
const RISK_EQUITY_REF  = 50000;
const DEFAULT_RISK_PCT = RISK_EUR / RISK_EQUITY_REF;   // 0.0004

/** Risico in euro. Vast bedrag — geen staffel, geen plafond.
 *  (v5 had deze functie TWEE KEER gedefinieerd; de tweede overschreef de
 *   eerste en verwees naar RISK_EUR_BASE / RISK_STAFFEL / MAX_TOTAL_RISK_EUR
 *   die nergens bestonden -> ReferenceError bij elke aanroep.) */
function getRiskEur() { return RISK_EUR; }

// Server SL = sl_pct (uit webhook) x SL_BUFFER_MULT x broker execution price.
const SL_BUFFER_MULT = 1.5;

const RR_MIN = 1.5;
const RR_MAX = 3.0;

// ── TAKE PROFIT — PER SYMBOOL ─────────────────────────────────────────
//   Zie het blok bovenaan. US100 1,7R, goud 1,5R. Beide zijn het hoogste
//   niveau dat in BEIDE helften standhield voor dat symbool.
const TP_RR_PER_SYMBOL = {
  "US100.cash": 1.7,
  "XAUUSD":     1.5,
};

// Fallback voor onbekende symbolen en voor collect-mode.
// LET OP: de demo (mode=collect) MOET op 1,5R blijven. Dat is de ongefilterde
// referentiereeks waar alle analyse op steunt. Verander dit niet.
const DEFAULT_TP_RR  = 1.5;
const COLLECT_TP_RR  = 1.5;

// Leeg gelaten: RR per uurvenster is drie keer geprobeerd en drie keer
// omgeslagen out-of-sample. Kanaalbreedte doet dat niet.
const TP_RR_WINDOWS = {};

// ── KANAALFILTER ──────────────────────────────────────────────────────
//   Zie het blok bovenaan voor de onderbouwing van 0,87.
//   Laat ~82% van de trades door (v5 bij 1,25 liet er 61% door).
const MIN_CHAN_R = 0.87;

// ── TEGENPOSITIE-FILTER — UITGEZET ────────────────────────────────────
//
//   v5 noemde dit "de sterkste vondst van dit project". De walk-forward zegt
//   iets anders:
//                          n     EV h1     EV h2
//     geen tegenpositie   151   +0,235    -0,005
//     wel tegenpositie    448   +0,035    -0,007
//
//   In helft 2 is het verschil weg (-0,005 vs -0,007). Het hele effect zit in
//   helft 1. En de filter gooit 75% van je trades weg.
//
//   De onderbouwing in v5 was een tabel van "de acht slechtste dagen". Dat is
//   circulair: selecteer je de slechtste dagen en verwijder je daar trades,
//   dan verbeteren die dagen altijd. Dat zegt niets over de volgende slechte dag.
//
//   0 = uit. Zet op 0.5 als je hem toch wilt testen, en meet het apart per
//   symbool voordat je hem breder aanzet.
const MAX_TEGEN_GAP_R = 0;

// ── COOLDOWN ──────────────────────────────────────────────────────────
//   Kost 4,5R van de 67,7 en snijdt de drawdown met ~60%. Geen hoofdmaatregel,
//   maar hij kost bijna niets. Per symbool gemeten beter dan gezamenlijk
//   (+63,2R / 18,2R DD vs +53,7R / 20,3R DD).
const COOLDOWN_MIN        = 5;
const COOLDOWN_PER_SYMBOL = true;

// ── RISK MULTIPLIER ───────────────────────────────────────────────────
//   Blijft 1.0. Voorwaarden om naar 2.0 te gaan, allebei nodig:
//     a) 200+ nieuwe trades sinds 6 aug met EV boven +0,10R
//     b) het 95%-interval van die EV volledig boven nul
//   Wil je eerder opschalen, verhoog dan RISK_EUR — dan geldt het voor ALLE
//   trades in plaats van juist voor de vensters met de dunste data.
const GLOBAL_RISK_MULT = 1.0;
const RISK_WINDOWS = {};

// ── TIJDBLOKKEN ───────────────────────────────────────────────────────
//   Tijden in Brusselse tijd. De broker-journal staat op UTC+3, Brussel op
//   UTC+2 — journaltijden lopen één uur voor. Onderstaande grenzen zijn al
//   teruggerekend naar Brussel.
//
//   XAUUSD 14:00-24:00 — de sterkste filter die er is:
//                       n      EV      h1       h2      totaal R
//     geblokkeerd     162   -0,109   -0,117   -0,096    -17,6
//     toegestaan      150   +0,083   +0,085   +0,082    +12,5
//
//   Beide helften zelfde teken, groot verschil, en het sluit aan bij wat de
//   segmentanalyse liet zien (XAUUSD ny sell was in z'n eentje -23,6R).
const TIME_BLOCK_WINDOWS = {
  "XAUUSD": [{ start: 1400, end: 2400 }],
};

const BLOCKED_SYMBOLS = new Set([
  "US30USD","US30","DOW","DJI","DJIA",
  "DE30EUR","DE30","DAX","GER30","GER40",
  "UK100GBP","UK100","FTSE","FTSE100",
  "SP500","SPX","US500","SPX500",
  "JP225","JPN225","NIKKEI",
]);

const SYMBOL_ALIASES = {
  "MGC1!": "XAUUSD",
  "MNQ1!": "US100.cash",
};

// ── Per-firm MT5 reroute + broker lot rules ───────────────────────────
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
      "XAUUSD":     { mt5: "XAUUSD",     type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "US100.cash", type: "index",     pip: 0.10, volMin: 0.01, volStep: 0.01 },
    },
  },
  vantage: {
    label: "VANTAGE", mode: "live", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "NAS100", type: "index",     pip: 0.10, volMin: 0.10, volStep: 0.10, lotDecimals: 1 },
    },
  },
  fundednext: {
    label: "FUNDEDNEXT", mode: "live", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "NDX100", type: "index",     pip: 0.01, volMin: 0.01, volStep: 0.01 },
    },
  },
};

const FIRM_LIMITS = {
  ftmo_demo:  { dailyLossPct: null, maxTotalDDPct: null, trailing: false },
  ftmo_eval:  { dailyLossPct: 0.05, maxTotalDDPct: 0.10, trailing: false },
  maven:      { dailyLossPct: null, maxTotalDDPct: null, trailing: false },
  vantage:    { dailyLossPct: null, maxTotalDDPct: null, trailing: false },
  fundednext: { dailyLossPct: null, maxTotalDDPct: null, trailing: false },
};

// ======================================================================
//  END CONFIG
// ======================================================================

const FIRM = (process.env.FIRM || process.env.BROKER || "ftmo_demo").toLowerCase().trim();
if (!FIRMS[FIRM]) {
  throw new Error(`[session.js] Unknown FIRM="${FIRM}". Must be: ${Object.keys(FIRMS).join(" | ")}`);
}
const FIRM_CFG = FIRMS[FIRM];

const MODEL_MODE = (process.env.MODEL_MODE || "shadow").toLowerCase().trim();

const MODE              = FIRM_CFG.mode;
const SYMBOL_CATALOG    = FIRM_CFG.symbols;
const BROKER            = FIRM;
const BROKER_SYMBOL_MAP = { [FIRM]: FIRM_CFG.symbols };

console.log(`[session.js] v6.0.0 FIRM="${FIRM}" (${FIRM_CFG.label}) mode=${MODE} | ` +
  `gold->"${SYMBOL_CATALOG["XAUUSD"].mt5}" nasdaq->"${SYMBOL_CATALOG["US100.cash"].mt5}" | ` +
  `TP: US100=${TP_RR_PER_SYMBOL["US100.cash"]}R XAU=${TP_RR_PER_SYMBOL["XAUUSD"]}R` +
  (MODE === "collect" ? ` (collect -> ${COLLECT_TP_RR}R voor alles)` : "") + ` | ` +
  `chanR>=${MIN_CHAN_R} cooldown=${COOLDOWN_MIN}min tegenpositie=${MAX_TEGEN_GAP_R === 0 ? "UIT" : MAX_TEGEN_GAP_R + "R"}`);

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

/**
 * Take-profit RR voor dit symbool.
 *
 * collect-mode (ftmo_demo) geeft ALTIJD COLLECT_TP_RR terug. Die account is de
 * ongefilterde referentiereeks — zodra je daar per symbool gaat variëren
 * verlies je de basislijn waar alle analyse op rust.
 */
function getTpRR(symbolKey, date = null) {
  if (MODE === "collect") return COLLECT_TP_RR;

  // Uurvensters staan leeg, maar de hook blijft bestaan voor toekomstige tests.
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

  const perSym = TP_RR_PER_SYMBOL[symbolKey];
  if (Number.isFinite(perSym)) return Math.min(Math.max(perSym, RR_MIN), RR_MAX);
  return DEFAULT_TP_RR;
}

function getRiskMult(symbolKey, date = null) {
  if (MODE === "collect") return 1.0;
  const byFirm = RISK_WINDOWS[FIRM];
  const windows = byFirm && byFirm[symbolKey];
  if (windows && windows.length) {
    const { hhmm } = getBrusselsComponents(date);
    for (const w of windows) if (hhmm >= w.start && hhmm < w.end) return (w.mult ?? 1.0) * GLOBAL_RISK_MULT;
  }
  return GLOBAL_RISK_MULT;
}

/** chanR uit de webhook-velden. Ontbreekt er iets, dan laten we de trade door
 *  (null = onbekend, niet blokkeren) — anders val je stil bij een incomplete
 *  payload. */
function berekenChanR({ sessionHigh, sessionLow, slDist } = {}) {
  const h = parseFloat(sessionHigh), l = parseFloat(sessionLow), d = parseFloat(slDist);
  if (!(h > l) || !(d > 0)) return null;
  return +((h - l) / d).toFixed(4);
}

/** Poort op kanaalbreedte. null (onbekend) laat door. */
function chanROk(chanR, symbolKey = "") {
  if (chanR == null) return { allowed: true, reason: null };
  if (chanR >= MIN_CHAN_R) return { allowed: true, reason: null };
  return { allowed: false,
    reason: `CHAN_R ${chanR} < ${MIN_CHAN_R} — stop is breder dan de sessierange` };
}

/**
 * Tegenpositie-filter. UITGEZET zolang MAX_TEGEN_GAP_R op 0 staat.
 * Zie het configblok voor waarom.
 */
function tegenpositieOk(symbolKey, richting, prijs, slDist, openPosities = []) {
  if (!(MAX_TEGEN_GAP_R > 0)) return { allowed: true, reason: null };
  if (!Array.isArray(openPosities) || !openPosities.length) return { allowed: true, reason: null };
  if (!(slDist > 0) || !(prijs > 0)) return { allowed: true, reason: null };

  for (const p of openPosities) {
    if (!p || p.symbol !== symbolKey) continue;
    if (p.direction === richting) continue;
    const gapR = Math.abs(prijs - parseFloat(p.entry)) / slDist;
    if (gapR < MAX_TEGEN_GAP_R) {
      return { allowed: false,
        reason: `TEGENPOSITIE: ${p.direction} open op ${gapR.toFixed(2)}R ` +
                `(< ${MAX_TEGEN_GAP_R}R) — prijs is terug door de entryzone` };
    }
  }
  return { allowed: true, reason: null };
}

// ── COOLDOWN-STAAT ────────────────────────────────────────────────────
//   In-memory. Overleeft een herstart NIET — na een deploy kan er dus één
//   trade doorglippen die anders geblokkeerd was. Acceptabel: het alternatief
//   is een DB-round-trip per signaal.
const _lastTradeAt = new Map();

/** Registreer dat er ZOJUIST een trade geplaatst is.
 *  server.js MOET dit aanroepen NA een succesvolle order — anders doet de
 *  cooldown niets. Zie de patch onderaan dit bestand. */
function markTradePlaced(symbolKey, date = null) {
  const t = date ? new Date(date).getTime() : Date.now();
  _lastTradeAt.set(COOLDOWN_PER_SYMBOL ? symbolKey : "__ALL__", t);
}

function checkCooldown(symbolKey, date = null) {
  if (!(COOLDOWN_MIN > 0)) return { allowed: true, waitMin: 0 };
  if (MODE === "collect") return { allowed: true, waitMin: 0 };   // demo meet alles
  const key = COOLDOWN_PER_SYMBOL ? symbolKey : "__ALL__";
  const last = _lastTradeAt.get(key);
  if (last == null) return { allowed: true, waitMin: 0 };
  const now = date ? new Date(date).getTime() : Date.now();
  const elapsedMin = (now - last) / 60000;
  if (elapsedMin >= COOLDOWN_MIN) return { allowed: true, waitMin: 0 };
  return { allowed: false, waitMin: +(COOLDOWN_MIN - elapsedMin).toFixed(2) };
}

function resetCooldown(symbolKey = null) {
  if (symbolKey) _lastTradeAt.delete(COOLDOWN_PER_SYMBOL ? symbolKey : "__ALL__");
  else _lastTradeAt.clear();
}

/**
 * Volledige poort.
 *
 * @param {string} rawSymbol
 * @param {Date|string|null} date
 * @param {number|null} openPositions   aantal nu open posities (noodrem)
 * @param {object} ctx                  { sessionHigh, sessionLow, slDist,
 *                                        direction, prijs, openPosities }
 *
 * WAARSCHUWING: laat je ctx weg, dan is chanR null en wordt de kanaalfilter
 * OVERGESLAGEN. Dat is het huidige gedrag van server.js. Zie de patch onderaan.
 */
function canOpenNewTrade(rawSymbol, date = null, openPositions = null, ctx = {}) {
  if (isWeekend(date)) return { allowed: false, reason: "WEEKEND" };

  const upper = (rawSymbol || "").toString().toUpperCase().trim().replace(/[^A-Z0-9./]/g, "");
  if (BLOCKED_SYMBOLS.has(upper)) {
    return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — explicitly blocked` };
  }
  const sym = normalizeSymbol(rawSymbol);
  if (!sym) return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — only gold & nasdaq` };

  const chanR = ctx.chanR != null ? ctx.chanR : berekenChanR(ctx);

  if (MODE !== "collect") {
    const blk = isTimeBlocked(sym, date);
    if (blk) {
      return { allowed: false, chanR,
        reason: `TIME_BLOCK: ${sym} ${_fmtHHMM(blk.start)}\u2013${_fmtHHMM(blk.end)} Brussels` };
    }

    if (Number.isFinite(openPositions) && openPositions >= NOODREM_POSITIES) {
      return { allowed: false, chanR,
        reason: `NOODREM: ${openPositions} posities open (>=${NOODREM_POSITIES}) — iets is mis` };
    }

    const ch = chanROk(chanR, sym);
    if (!ch.allowed) return { allowed: false, reason: ch.reason, chanR };

    const tp = tegenpositieOk(sym, ctx.direction, ctx.prijs, ctx.slDist, ctx.openPosities);
    if (!tp.allowed) return { allowed: false, reason: tp.reason, chanR };

    const cd = checkCooldown(sym, date);
    if (!cd.allowed) {
      return { allowed: false, chanR,
        reason: `COOLDOWN: ${sym} nog ${cd.waitMin} min van ${COOLDOWN_MIN} min` };
    }
  }

  return { allowed: true, reason: null, chanR,
           riskEur: getRiskEur(),
           rr: getTpRR(sym, date) };
}

// ======================================================================
//  PATCH VOOR server.js — ZONDER DIT DRAAIEN DE FILTERS NIET
// ======================================================================
//
//  1) De aanroep. server.js heeft op dit moment:
//
//         const { allowed, reason: blockReason } = canOpenNewTrade(rawSym);
//
//     Daardoor is ctx leeg, is openPositions null, en wordt de kanaalfilter
//     stilzwijgend overgeslagen. Vervang door:
//
//         const _slPctForGate = safeNum(sl_pct) ?? 0.003;
//         const _tvForGate    = safeNum(tvClose);
//         const _slDistForGate = _tvForGate ? _slPctForGate * SL_BUFFER_MULT * _tvForGate : null;
//
//         const { allowed, reason: blockReason, chanR } = canOpenNewTrade(
//           rawSym,
//           new Date(),
//           openPositions.size,
//           {
//             sessionHigh: safeNum(session_high) ?? safeNum(day_high),
//             sessionLow:  safeNum(session_low)  ?? safeNum(day_low),
//             slDist:      _slDistForGate,
//             direction,
//             prijs:       _tvForGate,
//             openPosities: [...openPositions.values()].map(p => ({
//               symbol: p.symbol, direction: p.direction, entry: p.tvEntry ?? p.entry,
//             })),
//           }
//         );
//
//     LET OP: dit gebeurt VOOR de MetaAPI-quote, dus slDist wordt hier berekend
//     op de TradingView-prijs in plaats van de execution price. Het verschil is
//     ~0,1% en heeft op chanR geen betekenisvolle invloed. Wil je het exact,
//     verplaats de poort dan tot na de quote — maar dan plaats je een order-
//     aanvraag voor een signaal dat je alsnog weggooit.
//
//  2) De reject-outcome. server.js mapt nu alleen SYMBOL/TIME_BLOCK/WEEKEND:
//
//         const blockOutcome = blockReason.startsWith("SYMBOL") ? "SYMBOL_NOT_ALLOWED"
//           : blockReason.startsWith("TIME_BLOCK") ? "TIME_BLOCKED" : "WEEKEND";
//
//     Een CHAN_R- of COOLDOWN-reject wordt daardoor gelogd als "WEEKEND".
//     Vervang door:
//
//         const blockOutcome =
//             blockReason.startsWith("SYMBOL")       ? "SYMBOL_NOT_ALLOWED"
//           : blockReason.startsWith("TIME_BLOCK")   ? "TIME_BLOCKED"
//           : blockReason.startsWith("CHAN_R")       ? "CHAN_R_TOO_NARROW"
//           : blockReason.startsWith("COOLDOWN")     ? "COOLDOWN"
//           : blockReason.startsWith("TEGENPOSITIE") ? "COUNTER_POSITION"
//           : blockReason.startsWith("NOODREM")      ? "EMERGENCY_STOP"
//           : "WEEKEND";
//
//     Zonder deze fix kun je in signal_log niet meten hoeveel de filter kapt —
//     en dat is precies wat je nodig hebt om te bepalen of hij mag blijven.
//
//  3) De cooldown. markTradePlaced() wordt nergens aangeroepen. Voeg toe in
//     het webhook-succespad, direct naast markWebhookPlaced():
//
//         markWebhookPlaced(rawSym||"", direction);
//         markTradePlaced(symbol);              // <-- NIEUW
//
//     En voeg markTradePlaced toe aan de require-lijst bovenaan server.js.
//
//  4) Optioneel maar aan te raden: log chanR mee in signal_log, zodat je over
//     een maand kunt controleren of 0,87 nog steeds de juiste grens is:
//
//         await db.logSignal({ ..., chanR });
//
// ======================================================================

// ── HANDMATIG INGRIJPEN ───────────────────────────────────────────────
//   Niets. SL en TP staan vast na plaatsing.
//
//   De 45-minutenregel uit v5 is vervallen. Op 7 aug bleek waarom: één been
//   van een paar sluiten laat je eenzijdig achter in de markt — de BUY's
//   werden gesloten, goud brak naar boven uit, en alleen de SELL's bleven over.
//   Sluit NOOIT één kant van een paar: ofwel beide, ofwel geen van beide.
const HANDMATIG = {
  regel45min: null,
  advies: "laat lopen tot SL of TP; grijp niet in op één been",
};

module.exports = {
  TIMEZONE, DEFAULT_RISK_PCT, SL_BUFFER_MULT, RR_MIN, RR_MAX,
  FIRM, MODE, MODEL_MODE, BROKER, BROKER_SYMBOL_MAP, FIRMS, FIRM_LIMITS,
  SYMBOL_CATALOG, SYMBOL_ALIASES,
  getBrusselsComponents, getBrusselsDateStr,
  getSession, isWeekend,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey, buildDailyLabel,
  canOpenNewTrade, TIME_BLOCK_WINDOWS, isTimeBlocked,
  DEFAULT_TP_RR, COLLECT_TP_RR, TP_RR_PER_SYMBOL, TP_RR_WINDOWS, getTpRR,
  MIN_CHAN_R, berekenChanR, chanROk,
  RISK_EUR, NOODREM_POSITIES, MAX_CONCURRENT, getRiskEur, HANDMATIG,
  MAX_TEGEN_GAP_R, tegenpositieOk,
  RISK_WINDOWS, GLOBAL_RISK_MULT, getRiskMult, roundLots,
  COOLDOWN_MIN, COOLDOWN_PER_SYMBOL,
  checkCooldown, markTradePlaced, resetCooldown,
};

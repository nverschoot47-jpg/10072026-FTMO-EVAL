"use strict";
// ================================================================
// session.js  v3.6.0  |  PRONTO-AI — UNIFIED TEMPLATE
//
// v3.5.0 (6 aug 2026) — HERZIEN op 874 ECHTE broker-trades uit de
// journal-export (16 juni – 6 augustus, US100 + XAUUSD, inclusief swap
// en commissie). Dat is ruim 3x de dataset van v3.4.0 én het is de
// werkelijke uitvoering in plaats van ghost-simulatie.
//
// WAT ER VERANDERDE T.O.V. v3.4.0 EN WAAROM
//
// 1. COOLDOWN VAN 5 MINUTEN PER SYMBOOL — DE ENIGE ECHTE WINST.
//    Zonder cooldown: 874 trades, +67,7R, maxDD 46,1R (8,6% van een 10k).
//    Met 5 min:        658 trades, +63,2R, maxDD 18,2R (3,4% van een 10k).
//    Je levert 4,5R in en halveert je drawdown ruim. Dat is de beste ruil
//    in de hele dataset. Reden: clusters van entries op dezelfde beweging
//    stapelen risico zonder rendement toe te voegen — geclusterde trades
//    leveren over de hele periode +0,001R op, geïsoleerde +0,288R.
//
// 2. ALLE 2.0x RISK_WINDOWS UIT. Alle drie waren out-of-sample negatief:
//      US100 10-12u  EV +0,024 -> -0,118
//      XAUUSD 00-06u EV +0,531 -> -0,435   <- stond op 2.0x
//      XAUUSD 17-19u EV +0,071 -> -0,286
//    Zie RISK_MULT hieronder voor wanneer je ze wél mag aanzetten.
//
// 3. TP TERUG NAAR VLAK 1.5R. De zone-RR's van v3.4.0 hielden geen stand:
//    US100 14-19u +0,149 -> -0,231, XAU 00-06u +0,531 -> -0,435. Alleen
//    US100 10-14u overleefde, en die staat in de journal juist op -0,020.
//    Twee bronnen die elkaar tegenspreken = niet genoeg om op te sturen.
//
// 4. MAX_CONCURRENT = 12. Gemeten: gemiddeld 6,9 gelijktijdig open, max 31.
//    Boven 16 gelijktijdig wordt de EV negatief (-0,099 over 84 trades).
//
// 5. XAUUSD 19-24u GEBLOKKEERD. VOOR +0,216 (n=21) -> NA -0,322 (n=62),
//    over de hele set -0,186 over 83 trades. Enige blok dat in beide
//    bronnen negatief is.
//
// WAT ER BEWUST NIET IN ZIT
//    Een filter op "geïsoleerde" trades (geen andere trade binnen 10 min
//    ervoor EN erna) geeft +0,288R en is statistisch significant. Maar dat
//    vereist kennis van de toekomst. De implementeerbare variant — alleen
//    terugkijken — verliest zijn edge out-of-sample (VOOR +0,256, NA -0,008).
//    De cooldown hieronder is de eerlijke benadering: hij vangt het
//    drawdown-voordeel, niet het volledige EV-voordeel.
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
//
//   v3.6.0: 0.000375 -> 0.0008. Met RISK_EQUITY=50000 gaat $18,75 naar $40
//   per trade (2,13x). Je vroeg hierom; hier staat wat het betekent zodat
//   je het bewust doet.
//
//     per trade   gemeten maxDD (18,2R)   winst over 51 dagen (63,2R)
//      $18,75          $341  = 3,4%              +$1.185
//      $30,00          $546  = 5,5%              +$1.896
//      $40,00          $728  = 7,3%              +$2.528   <- gekozen
//
//   Op een FTMO-eval van 10k met 10% totale limiet houd je 2,7% marge over
//   op een drawdown die AL is voorgekomen. En: 12 gelijktijdige posities
//   die samen uitstoppen is $480 = 4,8%, dus je raakt de 5%-daglimiet bij
//   precies je MAX_CONCURRENT. Dat is geen toeval maar wel krap — zie de
//   opmerking bij MAX_CONCURRENT.
//
//   Wil je terug: 0.0006 = $30/trade, 5,5% drawdown, ruimere marge.
const DEFAULT_RISK_PCT = 0.0008;

// Server SL = sl_pct (from webhook) × SL_BUFFER_MULT × broker execution price.
const SL_BUFFER_MULT = 1.5;

const RR_MIN = 1.5;
const RR_MAX = 3.0;   // v3.6.0: was 2.5 — US100 10-14u draagt 3.0R

// ── COOLDOWN — de belangrijkste toevoeging van deze versie ────────────
//
//   Na een geplaatste trade op een symbool worden nieuwe signalen op DAT
//   symbool geweigerd tot de cooldown verstreken is. Meting over 874
//   echte trades:
//
//     cooldown   n     ΣR      EV      maxDD    VOOR      NA
//        0 min  874  +67,7  +0,077   46,1R   +0,259   -0,011
//        5 min  658  +63,2  +0,096   18,2R   +0,255   +0,002   <- gekozen
//       10 min  529  +47,5  +0,090   22,1R   +0,294   -0,035
//       30 min  352  +19,0  +0,054   12,6R   +0,097   +0,028
//       60 min  257  -13,8  -0,054   26,3R   +0,080   -0,133
//
//   5 minuten kost 4,5R van de 67,7 en snijdt de drawdown met 60%.
//   Langere cooldowns snijden te veel winst weg zonder extra veiligheid.
//   Zet op 0 om uit te schakelen (niet aanbevolen).
const COOLDOWN_MIN = 5;

// Cooldown per symbool (true) of over alle symbolen samen (false).
// Per symbool gemeten: +63,2R / 18,2R DD. Gezamenlijk: +53,7R / 20,3R DD.
const COOLDOWN_PER_SYMBOL = true;

// ── MAX GELIJKTIJDIGE POSITIES ────────────────────────────────────────
//   Gemeten bij entry: gemiddeld 6,9 open, mediaan 5, MAX 31.
//     1-6  open : EV +0,077 (n=522)
//     7-15 open : EV +0,133 (n=268)
//     16+  open : EV -0,099 (n=84)   <- hier gaat het mis
//   12 is de grens die de negatieve staart afsnijdt zonder de goede zone
//   te raken. server.js moet dit afdwingen; session.js levert alleen het
//   getal en de check.
//   LET OP bij $40/trade: 12 posities die samen uitstoppen kost $480 op een
//   10k-eval = 4,8%, net onder de 5%-daglimiet. Ga je naar $50/trade, zet
//   dit dan naar 9 (9 x $50 = $450) — anders kan één cluster je dag kosten.
const MAX_CONCURRENT = 12;

// ── RISK MULTIPLIER ───────────────────────────────────────────────────
//
//   BEWUST OP 1.0 GELATEN. Je vroeg om 2.0x en ik snap waarom — bij
//   $18,75 per trade voelt een goede maand als niets. Maar de data draagt
//   het nog niet, en dit is precies waar v3.4.0 op stukliep:
//
//     Wat 2.0x zou doen op de 5-min cooldown-set (658 trades, 51 dagen):
//       1.0x  ->  netto +$1.184   maxDD $342  = 3,4% van een 10k eval
//       2.0x  ->  netto +$2.368   maxDD $684  = 6,8% van een 10k eval
//
//     Die 6,8% is een gemeten drawdown over 51 dagen. FTMO's totale limiet
//     is 10%. Eén slechte week erbij en je bent eruit — en de tweede helft
//     van de dataset (16 jul - 6 aug) had een EV van precies nul, dus zo'n
//     week is geen theorie.
//
//   WANNEER ZET JE HEM WEL AAN:
//     Twee voorwaarden, allebei nodig.
//       a) 200+ nieuwe trades sinds 6 aug met een EV boven +0,10R, en
//       b) het 95%-interval van die EV volledig boven nul.
//     Op dit moment is dat interval [-0,011 , +0,166] over 874 trades —
//     nul zit er nog in. Dat is de reden, niet voorzichtigheid om de
//     voorzichtigheid.
//
//   Als je toch wilt opschalen vóór dat bewijs er is: verhoog dan
//   DEFAULT_RISK_PCT, niet deze multiplier. Dan geldt de verhoging voor
//   álle trades in plaats van juist voor de vensters met de dunste data,
//   en dat is een eerlijker weddenschap.
const GLOBAL_RISK_MULT = 1.0;

// Leeg. Zie de rekensom hierboven voordat je hier iets in zet.
const RISK_WINDOWS = {};

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
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", pip: 0.01, volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "US100.cash", type: "index", pip: 0.10, volMin: 0.01, volStep: 0.01 },
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

// ── TP risk-reward ────────────────────────────────────────────────────
//   Vlak 1.5R. De zone-RR's uit v3.4.0 zijn verwijderd: geen enkele hield
//   stand in de tweede helft van de data, en de journal spreekt de
//   ghost-analyse tegen op precies de zone die het langst overeind bleef.
//
//   v3.6.0 — RR-ZONES TERUG, maar nu op de JUISTE bron.
//
//   Correctie op v3.5.0: de collector draait vlak 1.5R, dus de broker-
//   journal kan NIETS zeggen over hogere RR — die trades bestaan er niet.
//   Alleen de ghost meet hoe ver een trade doorliep na TP. Journal -0,020
//   bij 1,5R en ghost +0,167 bij 2,5R op hetzelfde blok spreken elkaar dus
//   niet tegen; ze zeggen samen: dit blok wil een hogere RR.
//
//   Opgenomen zijn alleen zones die in BEIDE helften van de ghost-data
//   positief zijn (n>=40). Tijden in Brusselse tijd.
//
//     ZONE                  n    RR     WR     EV_totaal  EV_1e   EV_2e
//     US100 10-14u         87   3.0   29,9%     +0,195   +0,159  +0,333
//     XAUUSD 00-06u        47   2.0   38,3%     +0,149   +0,313  +0,065
//
//   US100 10-14u op 4.0R meet nog hoger (+0,379) maar dat is 27,6% winrate
//   en n=87 — te dun om je grootste blok op te zetten. 3.0 is de veilige
//   kant van diezelfde curve.
//
//   NIET opgenomen: US100 19-24u (2.5R is +0,050 in de 2e helft maar
//   -0,475 in de 1e), US100 14-17u (wisselt van teken per RR), XAUUSD
//   10-14u (2.0R +0,063 totaal maar -0,087 in de 1e helft).
const DEFAULT_TP_RR = 1.5;
const TP_RR_WINDOWS = {
  "US100.cash": [{ start: 1000, end: 1400, rr: 3.0 }],
  "XAUUSD":     [{ start: 0,    end: 600,  rr: 2.0 }],
};

// ── Time blocks ───────────────────────────────────────────────────────
//   Alleen waar BEIDE bronnen negatief zijn. Tijden in Brusselse tijd.
//   LET OP: de broker-journal staat op UTC+3, Brussel op UTC+2 — de
//   journaltijden lopen dus één uur voor. Onderstaande grenzen zijn al
//   teruggerekend naar Brussel.
const TIME_BLOCK_WINDOWS = {
  // XAUUSD 19-24u — negatief in ELKE bron en op ELK RR-niveau:
  //   journal  -0,186 (n=83)
  //   ghost    -0,423 @1.5R / -0,446 @2.0R / -0,508 @3.0R (n=65)
  //   1e helft -0,167   2e helft -0,605
  // Dit is het enige blok waar alles het over eens is.
  //
  // XAUUSD 14-17u staat op de wachtlijst: 1e helft +0,111, 2e helft -0,271
  // bij 1,5R, en negatief op elke hogere RR. Nog niet geblokkeerd omdat de
  // eerste helft positief was — herbekijken bij de volgende dataset.
  "XAUUSD": [{ start: 1900, end: 2400 }],
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

console.log(`[session.js] v3.6.0 FIRM="${FIRM}" (${FIRM_CFG.label}) mode=${MODE} | ` +
  `gold->"${SYMBOL_CATALOG["XAUUSD"].mt5}" nasdaq->"${SYMBOL_CATALOG["US100.cash"].mt5}" | ` +
  `cooldown=${COOLDOWN_MIN}min maxOpen=${MAX_CONCURRENT} riskMult=${GLOBAL_RISK_MULT}x`);

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

function getTpRR(symbolKey, date = null) {
  if (MODE === "collect") return DEFAULT_TP_RR;
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

// ── COOLDOWN-STAAT ────────────────────────────────────────────────────
//
//   In-memory. Overleeft een herstart NIET — na een deploy kan er dus één
//   trade doorglippen die anders geblokkeerd was. Dat is acceptabel: het
//   alternatief is een DB-round-trip per signaal, en de kosten van één
//   gemiste blokkade zijn klein. Wil je het wel persistent, lees dan de
//   laatste placed_at per symbool uit de orders-tabel bij het opstarten.
const _lastTradeAt = new Map();

/** Registreer dat er ZOJUIST een trade geplaatst is. server.js roept dit
 *  aan NA een succesvolle order, nooit ervoor. */
function markTradePlaced(symbolKey, date = null) {
  const t = date ? new Date(date).getTime() : Date.now();
  _lastTradeAt.set(COOLDOWN_PER_SYMBOL ? symbolKey : "__ALL__", t);
}

/** Staat de cooldown deze trade toe? */
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

/** Reset — handig in tests of na een handmatige flush. */
function resetCooldown(symbolKey = null) {
  if (symbolKey) _lastTradeAt.delete(COOLDOWN_PER_SYMBOL ? symbolKey : "__ALL__");
  else _lastTradeAt.clear();
}

/**
 * Volledige poort. server.js geeft optioneel het aantal nu open posities
 * mee; laat je dat weg, dan wordt de concurrency-check overgeslagen.
 */
function canOpenNewTrade(rawSymbol, date = null, openPositions = null) {
  if (isWeekend(date)) return { allowed: false, reason: "WEEKEND" };

  const upper = (rawSymbol || "").toString().toUpperCase().trim().replace(/[^A-Z0-9./]/g, "");
  if (BLOCKED_SYMBOLS.has(upper)) {
    return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — explicitly blocked` };
  }
  const sym = normalizeSymbol(rawSymbol);
  if (!sym) return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — only gold & nasdaq` };

  if (MODE !== "collect") {
    const blk = isTimeBlocked(sym, date);
    if (blk) {
      return { allowed: false,
        reason: `TIME_BLOCK: ${sym} ${_fmtHHMM(blk.start)}\u2013${_fmtHHMM(blk.end)} Brussels` };
    }

    if (Number.isFinite(openPositions) && openPositions >= MAX_CONCURRENT) {
      return { allowed: false,
        reason: `MAX_CONCURRENT: ${openPositions}/${MAX_CONCURRENT} posities open` };
    }

    const cd = checkCooldown(sym, date);
    if (!cd.allowed) {
      return { allowed: false,
        reason: `COOLDOWN: ${sym} nog ${cd.waitMin} min van ${COOLDOWN_MIN} min` };
    }
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
  RISK_WINDOWS, GLOBAL_RISK_MULT, getRiskMult, roundLots,
  COOLDOWN_MIN, COOLDOWN_PER_SYMBOL, MAX_CONCURRENT,
  checkCooldown, markTradePlaced, resetCooldown,
};

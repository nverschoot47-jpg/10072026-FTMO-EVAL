"use strict";
// ================================================================
// session.js  v4.2.0  |  PRONTO-AI — UNIFIED TEMPLATE
//
// v4.2.0 (7 aug 2026) — HERZIEN op 307 handmatig uitgelezen ghost-rijen
// (22 juli - 6 augustus) plus 550 rijen uit de database.
//
// UITGANGSPUNT DAT ALLES BEPAALT: SL en TP staan VAST na plaatsing.
// Geen trailing, geen breakeven-stop, geen vroege exit. De enige knoppen
// die overblijven zijn: WELKE trade neem je, WELKE RR zet je erop, en
// HOE GROOT. Dit bestand is volledig op die drie geherbouwd.
//
// DE KERNMETING (307 trades, chronologisch)
//
//   RR     WR      EV      totaal   maxDD   langste verliesreeks
//   1.5   42,7%  +0,067     +20R    21,5R          10
//   2.0   38,1%  +0,143     +44R    26,0R          15
//   3.0   28,7%  +0,147     +45R    35,0R          23
//   5.0   19,9%  +0,192     +59R    55,0R          53
//   8.0   14,3%  +0,290     +89R    75,0R          75
//
//   De EV stijgt met de RR, maar de drawdown stijgt harder. Bij 8.0R is
//   +89R aan winst gekoppeld aan 75R drawdown — dat is €3.000 bij €40 per
//   trade en op geen enkel prop-account houdbaar. RR 2.0 heeft de beste
//   verhouding: +44R tegen 26R drawdown.
//
//   Waarom 1.5R (de oude instelling) het slechtste van allemaal is: de
//   mediane piek over 307 trades is 1,14R. 57% haalt nooit 1,5R. Maar 44
//   trades (14%) haalden 8R of meer, en die 44 zijn goed voor 58% van alle
//   beweging. Bij TP 1,5R pak je 197R van je winnaars terwijl hun pieken
//   844R waard waren — je geeft 4,94R per winnaar weg. Zonder trailing kun
//   je die staart niet volledig pakken, maar 2.0R vangt er meer van dan 1.5R
//   zonder de winrate onder een werkbaar niveau te duwen.
//
// HET VERBAND DAT WERKT: KANAALBREEDTE
//
//   chanR = (session_high - session_low) / sl_dist
//   Dus: hoe breed is de sessierange, uitgedrukt in stopafstanden.
//
//     chanR        n    WR@1.5   WR@3.0   EV@2.0   gem. piek
//     <1.25      216    35,2%    16,2%    -0,125     2,14
//     1.25-1.75  201    40,3%    22,9%    -0,104     2,46
//     >=1.75     133    44,4%    27,1%    +0,038     2,45
//
//   Logica: is het kanaal ongeveer even breed als je stop, dan is er fysiek
//   geen ruimte om 2R te lopen voordat de range je terugkaatst. Bij een
//   breed kanaal wel. Dit is geen tijdvenster dat verwatert — het is een
//   meetbare eigenschap van de markt op het moment van instappen, en het is
//   de enige factor die in elke steekproef dezelfde richting op wees.
//
//   chanR >= 1.25 is de grens waar de EV omslaat. >= 1.75 is beter maar
//   laat maar 24% van de trades over.
//
// WAT ER NIET IN ZIT EN WAAROM
//   - Trailing / breakeven-stop: kan niet, SL staat vast.
//   - Vroege exit na 45 min: kan niet, geen aanpassing na plaatsing.
//     (Was ook riskant: kapte op 27 juli vier trades weg met pieken van
//      11,7 / 6,6 / 11,4 / 17,6R die pas na 83-156 min groen werden.)
//   - RR per uurvenster: drie keer geprobeerd, drie keer omgeslagen
//     out-of-sample. Kanaalbreedte doet dat niet.
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
// ── RISICO PER TRADE ──────────────────────────────────────────────────
//
//   LEES DIT VOORDAT JE HET RISICO VERHOOGT.
//
//   De EV van deze config is NIET aangetoond. Twee metingen op dezelfde
//   strategie geven verschillende antwoorden:
//
//     307 handmatig uitgelezen rijen, RR 2.0, geen kanaalfilter:  EV +0,143
//     223 database-rijen, RR 2.0, MET kanaalfilter + XAU-NY-blok: EV -0,004
//
//   Als de filters werkten hoorde het tweede getal hoger te liggen dan het
//   eerste. Dat het lager ligt betekent dat de filters mogelijk willekeurig
//   snijden in plaats van de slechte trades te verwijderen. Ik weet niet
//   welke van de twee metingen klopt.
//
//   Daarom staat de basis op €20 en niet op €40:
//     €20/trade -> gemeten drawdown 24R = €480  (4,8% van een 10k eval)
//     €40/trade -> €960                          (9,6% — tegen een 10%-limiet)
//     €80/trade -> €1.920                        (onmogelijk)
//
//   Bij een EV die tussen 0,000 en +0,143 ligt, is €480 drawdown het
//   verschil tussen doorleren en je account verliezen.
//
//   VERHOOG NAAR €40 wanneer je 200+ nieuwe trades hebt met een EV boven
//   +0,05R. Tot die tijd is dit een meetperiode met echt geld, geen
//   winstperiode.
//
//   Harde bovengrens blijft MAX_TOTAL_RISK_EUR aan gelijktijdig open risico.
const MAX_TOTAL_RISK_EUR = 500;
const RISK_EUR_BASE      = 20;

//   Staffel: op een rustige dag mag het risico omhoog, op een drukke terug.
//   Gemeten: ~15,6 trades/dag na filters, ~7 gelijktijdig open.
//     0-3 open  -> €40
//     4-5 open  -> €30
//     6+  open  -> €20
const RISK_STAFFEL = [
  { maxOpen: 3, eur: 40 },
  { maxOpen: 5, eur: 30 },
  { maxOpen: 99, eur: 20 },
];

//   Achterwaartse compatibiliteit: server.js rekent nog met een fractie van
//   RISK_EQUITY. Gebruik bij voorkeur getRiskEur() — die kent de staffel en
//   het €500-plafond wel.
const RISK_EQUITY_REF  = 50000;
const DEFAULT_RISK_PCT = RISK_EUR_BASE / RISK_EQUITY_REF;   // 0.0004

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
//   HERMETEN op de HUIDIGE config (kanaalfilter + XAU-NY-blok + RR 2.0):
//                        n     WR      EV      ΣR    maxDD   reeks
//     zonder cooldown   223  33,2%  -0,004   -1,0R   26,0R    12
//     met 5min          196  33,7%  +0,010   +2,0R   24,0R    11
//
//   Kapt 27 trades (12%), levert +3R op, drawdown van €1.040 naar €960 bij
//   €40 per trade. Dat is BEDUIDEND MINDER dan op de ongefilterde journal-
//   data (daar: +67,7R -> +63,2R met drawdown 46,1R -> 18,2R). Reden: de
//   kanaalfilter verwijdert clusters al grotendeels, want geclusterde
//   entries hebben meestal een nauw kanaal. De cooldown vindt daarna nog
//   maar weinig. Behouden omdat hij niets kost, maar hij is geen
//   hoofdmaatregel meer.
//
//   5 minuten kost 4,5R van de 67,7 en snijdt de drawdown met 60%.
//   Langere cooldowns snijden te veel winst weg zonder extra veiligheid.
//   Zet op 0 om uit te schakelen (niet aanbevolen).
const COOLDOWN_MIN = 5;

// Cooldown per symbool (true) of over alle symbolen samen (false).
// Per symbool gemeten: +63,2R / 18,2R DD. Gezamenlijk: +53,7R / 20,3R DD.
const COOLDOWN_PER_SYMBOL = true;

// ── MAX GELIJKTIJDIGE POSITIES ────────────────────────────────────────
//   Volgt uit het €500-plafond gedeeld door het risico per trade:
//     €40 -> 12    €60 -> 8    €80 -> 6
//   getRiskEur() rekent dit per trade uit; MAX_CONCURRENT is de harde stop
//   voor het geval het risico op de basis (€40) staat.
const MAX_CONCURRENT = Math.min(12, Math.floor(MAX_TOTAL_RISK_EUR / RISK_EUR_BASE));
// Geklemd: boven 16 gelijktijdig werd de EV in elke meting negatief.


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

// ── RR: VAST 2.0R ─────────────────────────────────────────────────────
//   Beste EV/drawdown-verhouding van alle geteste niveaus: +0,143R per
//   trade, +44R totaal, 26R maxDD, langste verliesreeks 15.
//   3.0R geeft marginaal meer EV (+0,147) maar 35R drawdown en een reeks
//   van 23 — dat is €1.400 en 23 verliezers op rij bij €40.
const DEFAULT_TP_RR = 2.0;
const TP_RR_WINDOWS = {};

// ── KANAALFILTER — de enige poort die stand hield ────────────────────
//   Neem de trade alleen als het kanaal minstens 1,25 stopafstanden breed is.
//   Onder die grens is de EV negatief op elk RR-niveau (n=216, EV@2.0 -0,125).
//   Laat ~61% van de trades door: 25,6/dag wordt ~15,6/dag.
//
//   Zet op 1.75 als je scherper wilt: EV@2.0 wordt +0,038 maar je houdt nog
//   maar 6/dag over. Dan mag het risico omhoog via RISK_STAFFEL.
const MIN_CHAN_R = 1.25;

/** chanR uit de webhook-velden. Ontbreekt er iets, dan laten we de trade
 *  door (null = onbekend, niet blokkeren) — anders val je stil bij een
 *  incomplete payload. */
function berekenChanR({ sessionHigh, sessionLow, slDist }) {
  const h = parseFloat(sessionHigh), l = parseFloat(sessionLow), d = parseFloat(slDist);
  if (!(h > l) || !(d > 0)) return null;
  return +((h - l) / d).toFixed(4);
}

/** Poort op kanaalbreedte. null (onbekend) laat door. */
function chanROk(chanR) {
  if (chanR == null) return { allowed: true, reason: null };
  if (chanR >= MIN_CHAN_R) return { allowed: true, reason: null };
  return { allowed: false, reason: `CHAN_R ${chanR} < ${MIN_CHAN_R} — kanaal te nauw voor ${DEFAULT_TP_RR}R` };
}

/** Risico in euro voor deze trade, gegeven het aantal nu open posities.
 *  Respecteert altijd het €500-plafond. */
function getRiskEur(openPositions = 0) {
  let eur = RISK_EUR_BASE;
  for (const t of RISK_STAFFEL) if (openPositions <= t.maxOpen) { eur = t.eur; break; }
  const ruimte = MAX_TOTAL_RISK_EUR - openPositions * eur;
  if (ruimte < eur) return Math.max(0, Math.floor(ruimte));   // 0 = niet meer openen
  return eur;
}

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
  // XAUUSD 14:00-24:00 — goud in New York plus de avond.
  //   14-24u met kanaalfilter: EV@2.0 -0,152 over 92 trades.
  //   Periode A -0,104, periode B -0,280 — negatief in BEIDE helften.
  //   Dit is het enige blok waar alle bronnen het eens zijn.
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

console.log(`[session.js] v4.2.0 FIRM="${FIRM}" (${FIRM_CFG.label}) mode=${MODE} | ` +
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
function canOpenNewTrade(rawSymbol, date = null, openPositions = null, ctx = {}) {
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

    // Kanaalbreedte — de belangrijkste poort van deze versie.
    const chanR = ctx.chanR != null ? ctx.chanR : berekenChanR(ctx);
    const ch = chanROk(chanR);
    if (!ch.allowed) return { allowed: false, reason: ch.reason, chanR };

    if (Number.isFinite(openPositions)) {
      const eur = getRiskEur(openPositions);
      if (!(eur > 0)) {
        return { allowed: false, chanR,
          reason: `MAX_TOTAL_RISK: ${openPositions} open, geen ruimte binnen €${MAX_TOTAL_RISK_EUR}` };
      }
    }

    const cd = checkCooldown(sym, date);
    if (!cd.allowed) {
      return { allowed: false,
        reason: `COOLDOWN: ${sym} nog ${cd.waitMin} min van ${COOLDOWN_MIN} min` };
    }
  }

  const chanR = ctx.chanR != null ? ctx.chanR : berekenChanR(ctx);
  return { allowed: true, reason: null, chanR,
           riskEur: Number.isFinite(openPositions) ? getRiskEur(openPositions) : RISK_EUR_BASE,
           rr: DEFAULT_TP_RR };
}

// ═══════════════════════════════════════════════════════════════════════
//  HANDMATIG INGRIJPEN — de 45-minutenregel
//
//  Dit kan session.js NIET afdwingen (SL en TP staan vast na plaatsing).
//  Jij doet dit met de hand, of je bouwt het in de poller. Hieronder staat
//  wat de data zegt, per symbool apart.
//
//  REGEL A — staat de trade na 45 min niet op +0,3R, sluit hem.
//
//    symbool   houden        kappen        staart die je verliest
//    US100     n=99  +0,364   n=46  -0,674   5 trades met piek >=8R
//    XAUUSD    n=106 +0,330   n=83  -0,675   2 trades met piek >=8R
//
//    Werkt op BEIDE symbolen vrijwel identiek. De gekapte kant is met
//    -0,67 per trade duidelijk verliesgevend, dus kappen is juist.
//    Kosten: 7 trades met een piek boven 8R gaan eruit.
//
//  REGEL B — milder: sluit alleen als hij na 45 min niet eens +0,1R haalde.
//
//    symbool   houden        kappen        staart die je verliest
//    US100     n=124 +0,161   n=21  -0,714   2 trades
//    XAUUSD    n=147 +0,041   n=42  -0,643   1 trade
//
//    Kapt veel minder trades (63 i.p.v. 129) en spaart 4 van de 7
//    staart-winnaars. Maar de behouden kant is zwakker.
//
//  AANBEVELING: begin met REGEL A. De gekapte trades zijn bij beide
//  symbolen even slecht (-0,67), en 45 min zonder +0,3R is een duidelijk
//  signaal. Je verliest gemiddeld 7 staart-trades per 550 — dat is de prijs.
//  Vind je dat te veel, stap dan over op REGEL B.
//
//  BELANGRIJK: de meting hierboven is op trades DIE DE KANAALFILTER
//  PASSEERDEN. Op ongefilterde trades gelden andere getallen.
const HANDMATIG = {
  regelA: { naMinuten: 45, minR: 0.3 },
  regelB: { naMinuten: 45, minR: 0.1 },
  actief: "A",
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
  DEFAULT_TP_RR, TP_RR_WINDOWS, getTpRR,
  MIN_CHAN_R, berekenChanR, chanROk,
  MAX_TOTAL_RISK_EUR, RISK_EUR_BASE, RISK_STAFFEL, getRiskEur, HANDMATIG,
  RISK_WINDOWS, GLOBAL_RISK_MULT, getRiskMult, roundLots,
  COOLDOWN_MIN, COOLDOWN_PER_SYMBOL, MAX_CONCURRENT,
  checkCooldown, markTradePlaced, resetCooldown,
};

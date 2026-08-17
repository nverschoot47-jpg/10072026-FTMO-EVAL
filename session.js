"use strict";
// ================================================================
// session.js  v6.2.0  |  PRONTO-AI — UNIFIED TEMPLATE
//
// v6.2.0 (14 aug 2026) — TERUG NAAR ONGEFILTERD 1,5R + 4 NIEUWE SYMBOLEN.
//
//   Op verzoek: MGC1!/MNQ1! weer zonder filter, vast op 1,5R — zoals de
//   originele ongefilterde reeks waar alle analyse op gebaseerd was.
//
//   BELANGRIJKE ONTDEKKING TIJDENS DEZE WIJZIGING: de kanaalfilter
//   (MIN_CHAN_R), de tegenpositie-context en de cooldown draaiden in de
//   praktijk AL NIET. server.js roept canOpenNewTrade(rawSym) aan zonder
//   ctx, date of openPositions — precies het gat dat het "PATCH VOOR
//   server.js"-blok verderop in dit bestand al beschreef, maar dat nooit is
//   doorgevoerd. markTradePlaced() wordt nergens aangeroepen, dus de
//   cooldown-klok stond ook al stil. Het ENIGE dat echt actief blokkeerde
//   was de TIME_BLOCK_WINDOWS-regel die goud 24/7 volledig dichtzette.
//   Die is nu verwijderd. MIN_CHAN_R en COOLDOWN_MIN staan hieronder ook op
//   0/uit, puur defensief — mocht iemand ooit de patch alsnog doorvoeren,
//   dan springen ze niet stiekem weer aan.
//
//   RISICO: RISK_EUR omhoog naar 5 en 4 nieuwe symbolen toegevoegd
//   (GER40.cash, UK100.cash, UKOIL.cash, XAGUSD) via TradingView-webhooks
//   MCL1!/SIL1!/GER40/UK100. LET OP — "minimum lotsize" is NIET hetzelfde
//   als "maximaal $5 risico": roundLots() rondt altijd OMHOOG naar volMin,
//   dus het werkelijke risico bij min lot is wat de sl-afstand van dat
//   symbool op dat moment toevallig oplevert — niet per se $5. Voor goud was
//   dat bij min lot gedocumenteerd EUR 18,45 (zie hieronder), ruim boven de
//   $5-doelstelling. Voor de 4 nieuwe symbolen is dat NIET geverifieerd —
//   zie de nieuwe [Sizing]-waarschuwing in server.js die het werkelijke
//   risico per trade logt (werkelijkRisicoEur() bestond al in dit bestand,
//   maar werd nooit aangeroepen). Check die logs voor je live gaat.
//
// ── v6.1.0 (7 aug 2026) — GEHERCONFIGUREERD VOOR EUR 200 STARTKAPITAAL.
//   (historisch — XAUUSD is in v6.2.0 weer opengezet, zie hierboven)
//
// De analyse uit v6.0.0 staat ongewijzigd overeind (zie het blok "ANALYSE"
// verderop). Wat veranderd is, is de RISICOKANT — en die verandert door één
// harde beperking van de broker, niet door een nieuw inzicht in de strategie.
//
// ── DE MINIMUM-LOT-BEPERKING DIE ALLES BEPAALT ────────────────────────
//
//   Uit server.js:
//     slDist = slPct x SL_BUFFER_MULT x execPrice
//     lotNom = riskEur / slDist
//     lotRaw = (type === "index") ? lotNom : lotNom / 100
//     lots   = roundLots(lotRaw)   -> Math.max(volMin, ...)
//
//   Ingevuld met de werkelijke prijzen:
//
//     XAUUSD  (~4100):  slDist = 0,003 x 1,5 x 4100 =   18,45
//                       min lot 0,01  ->  riskEur = EUR 18,45
//
//     US100   (~23000): slDist = 0,003 x 1,5 x 23000 =  103,50
//                       min lot 0,01  ->  riskEur = EUR  1,04
//
//   Goud kan dus NIET onder EUR 18,45 per trade. Op EUR 200 is dat 9,2% van
//   het account per trade. En roundLots() doet Math.max(volMin, ...) — is de
//   berekende lot te klein, dan wordt hij stilzwijgend OMHOOG gerond naar het
//   minimum. Je kunt dat niet instellen weg.
//
//   Daarom is goud volledig geblokkeerd in deze versie. Niet omdat het
//   verlies gaf (EV was ~0, niet sterk negatief), maar omdat het op dit
//   accountformaat onbestuurbaar is.
//
// ── WAT ER OVERBLIJFT: US100 MET KANAALFILTER ─────────────────────────
//
//     n=231 | winrate 46,8% | EV +0,153R | +35,3R
//     gerealiseerde max drawdown 11,9R
//
//   Dat is het schoonste segment uit de hele dataset. Bij EUR 3 per trade:
//     verwachting  ~EUR 0,46 per trade, ~9 trades/dag -> ~EUR 4/dag
//     p99 drawdown ~30R = EUR 90 = 45% van EUR 200
//
//   Lees dat tweede getal nog eens. Een drawdown van bijna de helft van je
//   account past binnen normaal gedrag van dit systeem. Dat is geen defect —
//   het is wat EUR 200 betekent bij deze variantie.
//
// ── VERPLICHTE ENV VAR ────────────────────────────────────────────────
//
//     RISK_EQUITY=50000
//
//   server.js rekent: riskEur = SIZING_EQUITY x DEFAULT_RISK_PCT, waarbij
//   SIZING_EQUITY = process.env.RISK_EQUITY ?? latestEquity.
//
//   Zet je RISK_EQUITY niet, dan pakt hij je ECHTE equity van EUR 200:
//     200 x 0,00006 = EUR 0,012 -> lot 0,0001 -> roundLots forceert 0,01
//     -> je riskeert EUR 1,04 per trade in plaats van EUR 3.
//   Niet fataal, maar niet wat je instelt. Zet hem.
//
// ── STOPGRENS — BESLIS DIT NU, NIET STRAKS ────────────────────────────
//
//   EUR 200 is te weinig om een drawdown uit te zitten en daarna nog te
//   herstellen. Leg vooraf vast bij welk bedrag je stopt en terugvalt op de
//   demo. Een verdedigbare grens is EUR 120 (40% verlies): dat is ongeveer
//   de p99-drawdown, dus als je daar komt is het waarschijnlijk geen pech
//   meer maar een verandering in de markt.
//
//   session.js kan dit NIET afdwingen — het bestand ziet je equity niet.
//   Dit is een afspraak met jezelf, geen codeconstructie.
//
// ================================================================
//
// ── ANALYSE (ongewijzigd uit v6.0.0) ──────────────────────────────────
//
//   Elke filter is getest door de dataset in TWEE HELFTEN te splitsen
//   (13-24 juli / 24 juli-7 aug) en te kijken of het effect in BEIDE helften
//   dezelfde kant op wijst. Een filter die alleen over de hele set goed meet
//   maar in één helft omklapt, is gekalibreerd op ruis.
//
//   KANAALFILTER   chanR = (session_high - session_low) / sl_dist
//
//     chanR-bak            n    EV h1    EV h2    totaal R
//     < 0,87             104   -0,239   -0,152     -18,6   <- weg
//     0,87 - 1,25        128   +0,153   -0,110      +2,3   <- houden
//     >= 1,25            362   +0,129   +0,084     +39,5   <- houden
//
//     0,87 is het punt waar de stopafstand groter wordt dan de hele
//     sessierange. Ligt je stop verder weg dan de markt die sessie bewogen
//     heeft, dan is er fysiek geen ruimte om je TP te halen.
//
//   TEGENPOSITIE-FILTER — UIT. h1 +0,235 vs h2 -0,005: het effect verdwijnt
//     volledig in de tweede helft, en de filter gooit 75% van de trades weg.
//     De onderbouwing in v5 was een tabel van "de acht slechtste dagen" —
//     dat is circulair.
//
//   TP-NIVEAU — US100 blijft op 1,5R. De gekalibreerde sweep wees 1,7R aan
//     (EV +0,136 vs +0,098), maar dat kon op equity-niveau niet hard gemaakt
//     worden: de ghost mist ~8% van de +1.7-milestones, waardoor de ruwe
//     simulatie 1,7R juist slechter uit liet komen. Op EUR 200 is dit niet
//     het moment voor een parameter die je niet kunt verifiëren.
//
//   REGIMETEST (EUR 20 op 10k, gecombineerde set):
//     13-15 jul   n= 64  EV +0,354  maxDD 1,97%
//     16-31 jul   n=193  EV +0,084  maxDD 3,43%
//     1-7  aug    n= 98  EV +0,080  maxDD 2,79%
//     Alle drie positief. Maar drie regimes over 26 dagen is een steekproef,
//     geen regimetest.
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
//   EUR 20 per trade, expliciet gevraagd (was 5). Dit is het bedoelde
//   risico dat de lot-formule NAAR STREEFT (riskEur / slDist) — het is GEEN
//   harde cap. roundLots() rondt altijd omhoog naar het min lot van het
//   symbool, dus zodra de berekende lotgrootte onder dat minimum valt, is
//   het WERKELIJKE risico hoger dan 20 en varieert het per symbool/prijs.
//
//   LET OP — roundLots() rondt NAAR BENEDEN af, niet omhoog:
//     stepsCount = Math.floor(rawLots / step)  ->  Math.max(volMin, stepped)
//   De oudere notities bovenaan dit bestand ("rondt altijd OMHOOG naar
//   volMin") kloppen alleen voor het geval dat de berekende lot ONDER volMin
//   valt. In alle andere gevallen ligt het werkelijke risico juist LAGER dan
//   het streefbedrag, doordat er naar de lotstap omlaag wordt afgekapt.
//
//   Gemeten met werkelijkRisicoEur() bij RISK_EUR = 20 (indicatieprijzen,
//   slDist = 0,003 x 1,5 x prijs):
//     XAUUSD      ~4100   slDist  18,45  -> lot 0,01  -> EUR 18,45
//     US100.cash ~23000   slDist 103,50  -> lot 0,19  -> EUR 19,67
//     GER40.cash ~24000   slDist 108,00  -> lot 0,18  -> EUR 19,44
//     UK100.cash  ~9500   slDist  42,75  -> lot 0,46  -> EUR 19,67
//     UKOIL.cash    ~65   slDist   0,29  -> lot 0,68  -> EUR 19,89
//     XAGUSD        ~50   slDist   0,23  -> lot 0,01  -> EUR 11,25
//   Geen enkel symbool schiet bij deze prijzen boven de 20 uit; goud zit nog
//   op de min-lot-vloer (18,45) en zilver ligt laag door contractSize 5000.
//
//   WAT ER VERANDERT DOOR 5 -> 20:
//     - Posities worden tot ~4x zo groot; alleen goud verandert niet, dat
//       zat al op de min-lot-vloer van EUR 18,45.
//     - MAX_CONCURRENT staat nog op 20 -> tot EUR 400 open blootstelling.
//       De comment daaronder rekent nog met EUR 3 per trade; die klopt niet
//       meer.
//
//   Kijk naar de "[Sizing]"-logregel in server.js (roept
//   werkelijkRisicoEur() aan) om per symbool het ECHTE risico te zien.
const RISK_EUR = 20;

// 23 gelijktijdig open is gemeten in de gefilterde set. Bij EUR 3 is dat
// EUR 69 aan open blootstelling = 35% van het account. Boven 20 posities
// wordt dat onhoudbaar, dus dit is hier een echte limiet en geen noodrem.
const NOODREM_POSITIES = 20;
const MAX_CONCURRENT   = NOODREM_POSITIES;

// server.js sizet via SIZING_EQUITY x DEFAULT_RISK_PCT.
// ZET RISK_EQUITY=50000 IN DE ENV — anders sizet hij op je echte EUR 200.
const RISK_EQUITY_REF  = 50000;
const DEFAULT_RISK_PCT = RISK_EUR / RISK_EQUITY_REF;   // 20/50000 = 0.0004

/** Risico in euro. Vast bedrag — geen staffel, geen plafond. */
function getRiskEur() { return RISK_EUR; }

// Server SL = sl_pct (uit webhook) x SL_BUFFER_MULT x broker execution price.
const SL_BUFFER_MULT = 1.5;

const RR_MIN = 1.5;
const RR_MAX = 3.0;

// ── TAKE PROFIT ───────────────────────────────────────────────────────
//   Allemaal op 1,5R — geen uitzonderingen. Zie de ANALYSE-noot over 1,7R
//   voor waarom US100/XAUUSD hier bleven staan; de 4 nieuwe symbolen hebben
//   geen eigen backtest, dus ze volgen gewoon dezelfde 1,5R default.
const TP_RR_PER_SYMBOL = {
  "US100.cash": 1.5,
  "XAUUSD":     1.5,
  "GER40.cash": 1.5,
  "UK100.cash": 1.5,
  "UKOIL.cash": 1.5,
  "XAGUSD":     1.5,
};

// De demo (mode=collect) MOET op 1,5R blijven. Dat is de ongefilterde
// referentiereeks waar alle analyse op rust. Verander dit niet.
const DEFAULT_TP_RR  = 1.5;
const COLLECT_TP_RR  = 1.5;

const TP_RR_WINDOWS = {};

// ── KANAALFILTER — UIT (v6.2.0) ─────────────────────────────────────────
//   0 = uit (chanR >= 0 is altijd waar). Was 0,87. In de praktijk deed dit
//   toch al niets — server.js roept canOpenNewTrade() zonder ctx aan, dus
//   chanR kwam altijd als null binnen en chanROk(null) laat sowieso door.
//   Op 0 gezet zodat dat ook zo blijft als de ctx-wiring later alsnog wordt
//   doorgevoerd (zie het PATCH-blok verderop in dit bestand).
const MIN_CHAN_R = 0;

// ── TEGENPOSITIE-FILTER — UIT ─────────────────────────────────────────
//   0 = uit. Zie de ANALYSE-noot.
const MAX_TEGEN_GAP_R = 0;

// ── COOLDOWN — UIT (v6.2.0) ──────────────────────────────────────────
//   Was 5 min. Net als de kanaalfilter deed dit al niets: markTradePlaced()
//   wordt nergens in server.js aangeroepen, dus _lastTradeAt bleef altijd
//   leeg en checkCooldown() gaf altijd "allowed". Op 0 gezet voor
//   consistentie — "no filter" betekent hier ook geen cooldown.
const COOLDOWN_MIN        = 0;
const COOLDOWN_PER_SYMBOL = true;

// ── RISK MULTIPLIER ───────────────────────────────────────────────────
//   Blijft 1.0 en blijft dat voorlopig. Op dit accountformaat is opschalen
//   via een multiplier zinloos — verhoog dan RISK_EUR, zodat het voor alle
//   trades geldt in plaats van juist voor de vensters met de dunste data.
const GLOBAL_RISK_MULT = 1.0;
const RISK_WINDOWS = {};

// ── TIJDBLOKKEN ───────────────────────────────────────────────────────
//   v6.2.0: leeg — geen tijdblokken meer. XAUUSD's 24/7 blok (v6.1.0, om
//   accountformaat-redenen) is verwijderd op verzoek: "1,5R no filter" voor
//   MGC1!/MNQ1!. Zie de v6.2.0-note bovenaan dit bestand voor de gevolgen
//   voor het werkelijke risico bij min lot.
const TIME_BLOCK_WINDOWS = {};

// v6.2.0: GER40 en UK100 verwijderd uit de blocklist (nu expliciet
// toegestaan, zie SYMBOL_ALIASES). De rest blijft geblokkeerd — die zijn
// niet gevraagd en dit bestand kent geen catalogusregels voor ze.
const BLOCKED_SYMBOLS = new Set([
  "US30USD","US30","DOW","DJI","DJIA",
  "DE30EUR","DE30","DAX","GER30",
  "UK100GBP","FTSE","FTSE100",
  "SP500","SPX","US500","SPX500",
  "JP225","JPN225","NIKKEI",
]);

// TradingView-tickersymbool -> canonieke sleutel (moet overeenkomen met een
// key in elke firm's `symbols`-catalogus hieronder).
const SYMBOL_ALIASES = {
  "MGC1!":  "XAUUSD",       // Micro Gold futures      -> XAUUSD
  "MNQ1!":  "US100.cash",   // Micro Nasdaq futures     -> US100.cash
  "GER40":  "GER40.cash",   // DAX/GER40 cash index     -> GER40.cash
  "UK100":  "UK100.cash",   // FTSE 100 cash index      -> UK100.cash
  "MCL1!":  "UKOIL.cash",   // Micro WTI Crude futures  -> UKOIL.cash (let op: WTI-ticker, Brent-broker-symbool — zo gevraagd)
  "SIL1!":  "XAGUSD",       // Micro Silver futures     -> XAGUSD
};

// v6.2.0: 4 nieuwe symbolen toegevoegd aan elke firm hieronder, met de
// mt5-namen zoals opgegeven (GER40.cash, UK100.cash, UKOIL.cash, XAGUSD) —
// hetzelfde voor alle firms, want er zijn geen per-firm varianten opgegeven.
// LET OP: US100.cash heet bij vantage/fundednext ANDERS op de broker
// (NAS100 / NDX100) — check of dat voor deze 4 nieuwe symbolen ook zo is
// voordat je live gaat op die firms; pas de "mt5"-velden aan indien nodig.
//
// v6.3.0: contractSize toegevoegd, GEVERIFIEERD tegen de FTMO MT5-specificatie
// (screenshots, 14 aug 2026):
//   UK100.cash  contract grootte 1     -> bevestigt de oude "index"-aanname
//   GER40.cash  contract grootte 1     -> bevestigt de oude "index"-aanname
//   UKOIL.cash  contract grootte 100   -> bevestigt de oude "commodity"/100-aanname
//   XAGUSD      contract grootte 5000  -> WIJKT AF. De oude type:"commodity"-
//               formule deelde altijd door 100 (goud-aanname) — voor zilver
//               had dat de lotgrootte 50x te GROOT gemaakt, dus ~50x het
//               bedoelde risico. Nu gefixt: de lotformule gebruikt voortaan
//               expliciet contractSize i.p.v. de type-binaire /100-gok.
//   XAUUSD/US100.cash zijn NIET opnieuw geverifieerd nu — contractSize 100/1
//   staat hier nog op de oude, al maandenlang in productie geteste aanname.
// stopLevelPoints/digits: FTMO toont "Stop niveaus: 0" voor alle 4 nieuwe
// symbolen (geen minimale afstand tussen prijs en SL/TP) — dus dit doet nu
// niets, maar staat klaar voor als dat ooit niet meer 0 is (zie
// widenForStopLevel() in server.js).
const FIRMS = {
  ftmo_demo: {
    label: "FTMO-DEMO", mode: "collect", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD",     type: "commodity", contractSize: 100,  digits: 2, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "US100.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "GER40.cash": { mt5: "GER40.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UK100.cash": { mt5: "UK100.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UKOIL.cash": { mt5: "UKOIL.cash", type: "commodity", contractSize: 100,  digits: 3, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "XAGUSD":     { mt5: "XAGUSD",     type: "commodity", contractSize: 5000, digits: 3, stopLevelPoints: 0, pip: 0.001, volMin: 0.01, volStep: 0.01 },
    },
  },
  ftmo_eval: {
    label: "FTMO-EVAL", mode: "live", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD",     type: "commodity", contractSize: 100,  digits: 2, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "US100.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "GER40.cash": { mt5: "GER40.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UK100.cash": { mt5: "UK100.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UKOIL.cash": { mt5: "UKOIL.cash", type: "commodity", contractSize: 100,  digits: 3, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "XAGUSD":     { mt5: "XAGUSD",     type: "commodity", contractSize: 5000, digits: 3, stopLevelPoints: 0, pip: 0.001, volMin: 0.01, volStep: 0.01 },
    },
  },
  maven: {
    label: "MAVEN", mode: "live", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD",     type: "commodity", contractSize: 100,  digits: 2, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "US100.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "GER40.cash": { mt5: "GER40.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UK100.cash": { mt5: "UK100.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UKOIL.cash": { mt5: "UKOIL.cash", type: "commodity", contractSize: 100,  digits: 3, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "XAGUSD":     { mt5: "XAGUSD",     type: "commodity", contractSize: 5000, digits: 3, stopLevelPoints: 0, pip: 0.001, volMin: 0.01, volStep: 0.01 },
    },
  },
  vantage: {
    label: "VANTAGE", mode: "live", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", contractSize: 100,  digits: 2, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "NAS100", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.10, volStep: 0.10, lotDecimals: 1 },
      "GER40.cash": { mt5: "GER40.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UK100.cash": { mt5: "UK100.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UKOIL.cash": { mt5: "UKOIL.cash", type: "commodity", contractSize: 100,  digits: 3, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "XAGUSD":     { mt5: "XAGUSD",     type: "commodity", contractSize: 5000, digits: 3, stopLevelPoints: 0, pip: 0.001, volMin: 0.01, volStep: 0.01 },
    },
  },
  fundednext: {
    label: "FUNDEDNEXT", mode: "live", lotDecimals: 2,
    symbols: {
      "XAUUSD":     { mt5: "XAUUSD", type: "commodity", contractSize: 100,  digits: 2, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "US100.cash": { mt5: "NDX100", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "GER40.cash": { mt5: "GER40.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UK100.cash": { mt5: "UK100.cash", type: "index",     contractSize: 1,    digits: 2, stopLevelPoints: 0, pip: 0.10,  volMin: 0.01, volStep: 0.01 },
      "UKOIL.cash": { mt5: "UKOIL.cash", type: "commodity", contractSize: 100,  digits: 3, stopLevelPoints: 0, pip: 0.01,  volMin: 0.01, volStep: 0.01 },
      "XAGUSD":     { mt5: "XAGUSD",     type: "commodity", contractSize: 5000, digits: 3, stopLevelPoints: 0, pip: 0.001, volMin: 0.01, volStep: 0.01 },
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

// Waarschuw luid als RISK_EQUITY ontbreekt in live-mode — dan sizet server.js
// op de echte equity en klopt RISK_EUR niet.
if (MODE !== "collect" && !process.env.RISK_EQUITY) {
  console.warn(`[session.js] LET OP: RISK_EQUITY is niet gezet. server.js sizet dan op de ` +
    `ECHTE account-equity in plaats van op ${RISK_EQUITY_REF}. Zet RISK_EQUITY=${RISK_EQUITY_REF}.`);
}

const _xauGeblokt = (TIME_BLOCK_WINDOWS["XAUUSD"] || []).some(w => w.start === 0 && w.end === 2400);

console.log(`[session.js] v6.2.0 FIRM="${FIRM}" (${FIRM_CFG.label}) mode=${MODE} | ` +
  `risk=${RISK_EUR}/trade (bedoeld, niet gegarandeerd bij min lot) maxOpen=${NOODREM_POSITIES} | ` +
  `symbols=${Object.keys(SYMBOL_CATALOG).join(",")} alle op ${DEFAULT_TP_RR}R | ` +
  (MODE === "collect" ? `(collect -> ${COLLECT_TP_RR}R, geen filters)` :
    `XAU=${_xauGeblokt ? "GEBLOKKEERD" : "open"}`) + ` | ` +
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

/**
 * Hoeveel euro riskeer je ECHT als de broker naar zijn minimum lot afrondt?
 *
 * v6.3.0: gebruikt nu contractSize i.p.v. de oude type==="index"-binaire gok
 * (die /100 deed voor ALLES wat geen index was — klopte toevallig voor goud
 * en olie, maar was 50x fout voor zilver, contractSize 5000 i.p.v. 100).
 *
 * Handig om te loggen: op een klein account is het verschil tussen bedoeld en
 * werkelijk risico het belangrijkste getal dat er is.
 */
function werkelijkRisicoEur(symInfo, slDist, bedoeldRiskEur) {
  if (!(slDist > 0) || !symInfo) return bedoeldRiskEur;
  const cs     = symInfo.contractSize ?? (symInfo.type === "index" ? 1 : 100);
  const lotNom = bedoeldRiskEur / slDist;
  const lotRaw = lotNom / cs;
  const lots   = roundLots(lotRaw, symInfo);
  const eur    = lots * cs * slDist;
  return parseFloat(eur.toFixed(2));
}

/**
 * v6.3.0 — "zet minimum lotsize aan, tenzij de SL breder moet van de broker".
 *
 * Als de broker een minimale afstand tussen prijs en SL/TP eist
 * (symInfo.stopLevelPoints, in MT5-punten = 10^-digits), en de berekende
 * slDist is smaller dan dat, dan wordt de SL/TP anders geweigerd door MT5.
 * Deze functie verbreedt slDist tot het minimum dat de broker toestaat.
 * Omdat de lotgrootte hierna vast op volMin blijft staan, betekent een
 * bredere SL automatisch een hoger $ risico voor die ene trade — dat is
 * precies "verhoog de risk tot de SL gezet kan worden".
 * Voor de 4 nieuwe FTMO-symbolen staat stopLevelPoints op 0 (geverifieerd
 * via Market Watch -> Specificatie), dus dit doet nu niets; het is een
 * vangnet voor andere brokers/firms waar dat niet zo is.
 */
function widenForStopLevel(slDist, symInfo) {
  const points = symInfo?.stopLevelPoints ?? 0;
  if (!(points > 0)) return slDist;
  const digits  = Number.isInteger(symInfo.digits) ? symInfo.digits : 2;
  const minDist = points * Math.pow(10, -digits);
  return Math.max(slDist, minDist);
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
  if (MODE === "collect") return COLLECT_TP_RR;

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
function chanROk(chanR) {
  if (chanR == null) return { allowed: true, reason: null };
  if (chanR >= MIN_CHAN_R) return { allowed: true, reason: null };
  return { allowed: false,
    reason: `CHAN_R ${chanR} < ${MIN_CHAN_R} — stop is breder dan de sessierange` };
}

/** Tegenpositie-filter. UIT zolang MAX_TEGEN_GAP_R op 0 staat. */
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
const _lastTradeAt = new Map();

/** server.js MOET dit aanroepen NA een succesvolle order — anders doet de
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
 * @param {number|null} openPositions   aantal nu open posities
 * @param {object} ctx                  { sessionHigh, sessionLow, slDist,
 *                                        direction, prijs, openPosities }
 *
 * WAARSCHUWING: laat je ctx weg, dan is chanR null en wordt de kanaalfilter
 * OVERGESLAGEN. Zie de patch onderaan.
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
      const heleDag = blk.start === 0 && blk.end === 2400;
      return { allowed: false, chanR,
        reason: heleDag
          ? `TIME_BLOCK: ${sym} volledig geblokkeerd — min lot te groot voor dit account`
          : `TIME_BLOCK: ${sym} ${_fmtHHMM(blk.start)}\u2013${_fmtHHMM(blk.end)} Brussels` };
    }

    if (Number.isFinite(openPositions) && openPositions >= NOODREM_POSITIES) {
      return { allowed: false, chanR,
        reason: `MAX_OPEN: ${openPositions} posities open (>=${NOODREM_POSITIES}) — ` +
                `EUR ${(openPositions * RISK_EUR).toFixed(0)} blootstelling` };
    }

    const ch = chanROk(chanR);
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
//  1) De aanroep. server.js heeft nu:
//         const { allowed, reason: blockReason } = canOpenNewTrade(rawSym);
//     Daardoor is ctx leeg en wordt de kanaalfilter stilzwijgend overgeslagen.
//     Vervang door:
//
//         const _slPctForGate  = safeNum(sl_pct) ?? 0.003;
//         const _tvForGate     = safeNum(tvClose);
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
//  2) De reject-outcome. server.js mapt nu alleen SYMBOL/TIME_BLOCK/WEEKEND,
//     dus een CHAN_R- of COOLDOWN-reject wordt gelogd als "WEEKEND".
//     Vervang door:
//
//         const blockOutcome =
//             blockReason.startsWith("SYMBOL")       ? "SYMBOL_NOT_ALLOWED"
//           : blockReason.startsWith("TIME_BLOCK")   ? "TIME_BLOCKED"
//           : blockReason.startsWith("CHAN_R")       ? "CHAN_R_TOO_NARROW"
//           : blockReason.startsWith("COOLDOWN")     ? "COOLDOWN"
//           : blockReason.startsWith("TEGENPOSITIE") ? "COUNTER_POSITION"
//           : blockReason.startsWith("MAX_OPEN")     ? "MAX_OPEN"
//           : "WEEKEND";
//
//  3) De cooldown. markTradePlaced() wordt nergens aangeroepen. Voeg toe naast
//     markWebhookPlaced(), en zet markTradePlaced in de require-lijst:
//
//         markWebhookPlaced(rawSym||"", direction);
//         markTradePlaced(symbol);              // <-- NIEUW
//
//  4) OP DIT ACCOUNTFORMAAT AAN TE RADEN: log het WERKELIJKE risico, niet het
//     bedoelde. Bij EUR 3 en min lot kan de broker omhoog afronden.
//     Voeg toe na de lotberekening in server.js:
//
//         const echtRisico = werkelijkRisicoEur(symInfo, slDist, riskEur);
//         if (echtRisico > riskEur * 1.2) {
//           console.warn(`[Sizing] ${symbol}: bedoeld EUR ${riskEur}, ` +
//             `WERKELIJK EUR ${echtRisico} door min lot ${lots}`);
//         }
//
//     Zet werkelijkRisicoEur in de require-lijst. Op EUR 200 is het verschil
//     tussen bedoeld en werkelijk risico het belangrijkste getal dat je hebt.
//
// ======================================================================

// ── HANDMATIG INGRIJPEN ───────────────────────────────────────────────
//   Niets. SL en TP staan vast na plaatsing.
//   Sluit NOOIT één kant van een paar: ofwel beide, ofwel geen van beide.
const HANDMATIG = {
  regel45min: null,
  advies: "laat lopen tot SL of TP; grijp niet in op één been",
  stopgrens: "onder EUR 120: uitzetten en terug naar de demo",
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
  RISK_EUR, RISK_EQUITY_REF, NOODREM_POSITIES, MAX_CONCURRENT,
  getRiskEur, werkelijkRisicoEur, widenForStopLevel, HANDMATIG,
  MAX_TEGEN_GAP_R, tegenpositieOk,
  RISK_WINDOWS, GLOBAL_RISK_MULT, getRiskMult, roundLots,
  COOLDOWN_MIN, COOLDOWN_PER_SYMBOL,
  checkCooldown, markTradePlaced, resetCooldown,
};

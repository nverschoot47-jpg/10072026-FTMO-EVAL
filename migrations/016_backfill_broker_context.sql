-- 016_backfill_broker_context.sql
-- ═══════════════════════════════════════════════════════════════════════════
--  BACKFILL: alle genormaliseerde context-features herberekend op de
--  BROKER-prijs (MT5-fill), voor alle bestaande rijen.
--
--  WAAROM DIT NODIG IS:
--  server.js bouwde het wh-object ZONDER vwapMid (die leefde als losse
--  variabele ernaast). normaliseerContext zag daardoor wh.vwapMid = undefined
--  en schreef vwap_dist_pct / vwap_dist_r / broker_vwap als NULL — op ELKE rij
--  sinds migratie 013. De sessie/dag-features werkten wel (die velden zaten
--  wél in wh). De fix in server.js repareert nieuwe rijen; deze migratie
--  repareert het verleden.
--
--  DE FORMULES — identiek aan normaliseerContext in server.js:
--    pct      = (x - tv_entry) / tv_entry              (futures, dimensieloos)
--    broker_x = entry * (1 + pct)                      (entry = MT5-fill)
--    in R     = (broker_x - entry) / sl_dist
--  vwap_dist_r krijgt een MIN-teken: + = entry ligt BOVEN de vwap.
--  sess_low_dist_r / day_low_dist_r ook: + = ruimte OMLAAG.
--
--  BRONNEN: ruwe futures-niveaus staan in signal_log; de broker-fill (entry)
--  en sl_dist komen uit ghost_trades via position_id. Rijen zonder ghost
--  (rejects, errors) hebben geen fill en blijven ongemoeid — correct, want
--  zonder fill bestaat er geen brokerprijs om op te projecteren.
--
--  IDEMPOTENT: alleen rijen waar vwap_dist_r nog NULL is worden aangeraakt;
--  door de vwap_mid IS NOT NULL-voorwaarde binnen elke CASE blijft NULL
--  gewoon NULL waar de bron ontbreekt (oude payloads) — en de views tonen
--  die als 'onbekend', precies zoals bedoeld.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. signal_log — de bron die v_ghost_clean joint ────────────────────────
UPDATE signal_log s SET
  vwap_dist_pct     = CASE WHEN s.vwap_mid IS NOT NULL
    THEN ROUND((-(s.vwap_mid - s.tv_entry) / s.tv_entry * 100)::numeric, 4) END,
  vwap_dist_r       = CASE WHEN s.vwap_mid IS NOT NULL
    THEN ROUND((-(g.entry * (1 + (s.vwap_mid - s.tv_entry) / s.tv_entry) - g.entry) / g.sl_dist)::numeric, 3) END,
  vwap_band_pct_r   = CASE WHEN s.vwap_upper IS NOT NULL AND s.vwap_lower IS NOT NULL
    THEN ROUND((ABS( g.entry * (1 + (s.vwap_upper - s.tv_entry) / s.tv_entry)
                   - g.entry * (1 + (s.vwap_lower - s.tv_entry) / s.tv_entry)) / g.sl_dist)::numeric, 3) END,

  sess_high_pct     = CASE WHEN s.session_high IS NOT NULL
    THEN ROUND(((s.session_high - s.tv_entry) / s.tv_entry * 100)::numeric, 4) END,
  sess_low_pct      = CASE WHEN s.session_low IS NOT NULL
    THEN ROUND(((s.session_low - s.tv_entry) / s.tv_entry * 100)::numeric, 4) END,
  sess_high_dist_r  = CASE WHEN s.session_high IS NOT NULL
    THEN ROUND(((g.entry * (1 + (s.session_high - s.tv_entry) / s.tv_entry) - g.entry) / g.sl_dist)::numeric, 3) END,
  sess_low_dist_r   = CASE WHEN s.session_low IS NOT NULL
    THEN ROUND((-(g.entry * (1 + (s.session_low - s.tv_entry) / s.tv_entry) - g.entry) / g.sl_dist)::numeric, 3) END,
  sess_range_r      = CASE WHEN s.session_high IS NOT NULL AND s.session_low IS NOT NULL
    THEN ROUND((((s.session_high - s.session_low) / s.tv_entry) * g.entry / g.sl_dist)::numeric, 3) END,
  sess_range_pct    = CASE WHEN s.session_high IS NOT NULL AND s.session_low IS NOT NULL
    THEN ROUND(((s.session_high - s.session_low) / s.tv_entry * 100)::numeric, 4) END,
  pos_in_sess_range = CASE WHEN s.session_high IS NOT NULL AND s.session_low IS NOT NULL
                            AND s.session_high > s.session_low
    THEN ROUND(((s.tv_entry - s.session_low) / (s.session_high - s.session_low))::numeric, 3) END,

  day_high_pct      = CASE WHEN s.day_high IS NOT NULL
    THEN ROUND(((s.day_high - s.tv_entry) / s.tv_entry * 100)::numeric, 4) END,
  day_low_pct       = CASE WHEN s.day_low IS NOT NULL
    THEN ROUND(((s.day_low - s.tv_entry) / s.tv_entry * 100)::numeric, 4) END,
  day_high_dist_r   = CASE WHEN s.day_high IS NOT NULL
    THEN ROUND(((g.entry * (1 + (s.day_high - s.tv_entry) / s.tv_entry) - g.entry) / g.sl_dist)::numeric, 3) END,
  day_low_dist_r    = CASE WHEN s.day_low IS NOT NULL
    THEN ROUND((-(g.entry * (1 + (s.day_low - s.tv_entry) / s.tv_entry) - g.entry) / g.sl_dist)::numeric, 3) END,
  day_range_r       = CASE WHEN s.day_high IS NOT NULL AND s.day_low IS NOT NULL
    THEN ROUND((((s.day_high - s.day_low) / s.tv_entry) * g.entry / g.sl_dist)::numeric, 3) END,
  day_range_pct     = CASE WHEN s.day_high IS NOT NULL AND s.day_low IS NOT NULL
    THEN ROUND(((s.day_high - s.day_low) / s.tv_entry * 100)::numeric, 4) END,
  pos_in_day_range  = CASE WHEN s.day_high IS NOT NULL AND s.day_low IS NOT NULL
                            AND s.day_high > s.day_low
    THEN ROUND(((s.tv_entry - s.day_low) / (s.day_high - s.day_low))::numeric, 3) END,

  -- LAAG 2: concrete MT5-chartniveaus, geprojecteerd uit het futures-percentage
  broker_vwap       = CASE WHEN s.vwap_mid     IS NOT NULL THEN ROUND((g.entry * (1 + (s.vwap_mid     - s.tv_entry) / s.tv_entry))::numeric, 5) END,
  broker_vwap_upper = CASE WHEN s.vwap_upper   IS NOT NULL THEN ROUND((g.entry * (1 + (s.vwap_upper   - s.tv_entry) / s.tv_entry))::numeric, 5) END,
  broker_vwap_lower = CASE WHEN s.vwap_lower   IS NOT NULL THEN ROUND((g.entry * (1 + (s.vwap_lower   - s.tv_entry) / s.tv_entry))::numeric, 5) END,
  broker_sess_high  = CASE WHEN s.session_high IS NOT NULL THEN ROUND((g.entry * (1 + (s.session_high - s.tv_entry) / s.tv_entry))::numeric, 5) END,
  broker_sess_low   = CASE WHEN s.session_low  IS NOT NULL THEN ROUND((g.entry * (1 + (s.session_low  - s.tv_entry) / s.tv_entry))::numeric, 5) END,
  broker_day_high   = CASE WHEN s.day_high     IS NOT NULL THEN ROUND((g.entry * (1 + (s.day_high     - s.tv_entry) / s.tv_entry))::numeric, 5) END,
  broker_day_low    = CASE WHEN s.day_low      IS NOT NULL THEN ROUND((g.entry * (1 + (s.day_low      - s.tv_entry) / s.tv_entry))::numeric, 5) END,

  -- Het futures<->broker basisverschil, vastgelegd ter controle van de brug
  futures_broker_basis_pct = ROUND(((g.entry - s.tv_entry) / s.tv_entry * 100)::numeric, 4)

FROM ghost_trades g
WHERE g.position_id = s.position_id
  AND s.tv_entry IS NOT NULL AND s.tv_entry > 0
  AND g.entry    IS NOT NULL AND g.entry    > 0
  AND g.sl_dist  IS NOT NULL AND g.sl_dist  > 0
  AND s.vwap_dist_r IS NULL;          -- idempotent: alleen nog-lege rijen

-- ── 2. ghost_trades — eigen feature-kolommen (013) meevullen ───────────────
-- Zodat v_ghost_clean ze ook ziet als de signal_log-join ooit mist, en de AI
-- ze direct naast peak_rr_pos heeft zonder join.
UPDATE ghost_trades g SET
  vwap_dist_r       = s.vwap_dist_r,
  sess_high_dist_r  = s.sess_high_dist_r,
  sess_low_dist_r   = s.sess_low_dist_r,
  sess_range_r      = s.sess_range_r,
  pos_in_sess_range = s.pos_in_sess_range,
  day_range_r       = s.day_range_r,
  pos_in_day_range  = s.pos_in_day_range
FROM signal_log s
WHERE s.position_id = g.position_id
  AND g.vwap_dist_r IS NULL
  AND s.vwap_dist_r IS NOT NULL;

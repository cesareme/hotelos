-- Rebrand → ehotelOS · Lote 7 · datos de demo por SQL (solo filas ficticias)
--
-- Renombra las 4 filas FICTICIAS del dataset de demo (org_123 y sus satélites)
-- a los nombres neutros de la decisión D3 (los mismos que fijan
-- packages/database/prisma/seed.ts, apps/api/src/lib/demo-store.ts y
-- apps/api/src/scripts/fix-demo-legal-identity.ts):
--
--   organizations  org_123      name       «Grupo Hotelero Demo»
--                               legal_name «Grupo Hotelero Demo SL»   (tax_id B12345674 se conserva)
--   legal_entities (org_123,HD)  legal_name «Grupo Hotelero Demo SL»   (code HD se conserva; razón
--                               social que se copia a issuer_legal_name de las facturas NUEVAS y a
--                               ObligadoEmision/NombreRazon de los envíos NUEVOS; se selecciona por
--                               (organization_id, code), único, porque su id es un cuid distinto
--                               en cada BD: en el VPS la crea backfill-legal-structure)
--   properties     prop_123     «Hotel Demo Madrid Centro» / «… SL» / trade_name «… SL» (code AMC)
--   properties     prop_canary  «Hotel Demo Tenerife Sur»  / «… SL» / trade_name «… SL» (code ATS)
--
-- NO toca nada más: ni Faranda/CELUISMA, ni invoices (snapshot fiscal con
-- verifactu_hash), ni verifactu_submissions (xml_payload/software_json), ni
-- audit_events (cadena hash), ni notification_deliveries/webhook_deliveries,
-- ni readiness (property_readiness_checks se recalcula por el API, nunca a mano),
-- ni usuarios/contraseñas, ni assets/integration_connections (hotelos://, secret://hotelos/).
--
-- Idempotente y atómico: una transacción; guardas por id y por valor actual
-- (solo se reescribe una fila que lleve el nombre antiguo o el nuevo, nunca un
-- valor inesperado); al final se comprueba que las 4 filas están en el estado
-- objetivo y, si no, RAISE EXCEPTION → ROLLBACK. Un segundo pase actualiza 0 filas.
--
-- Uso (BD local o BD demo del VPS, copia previa con scripts/backup-postgres.sh
-- o pg_dump; el «antes»/«después» se compara con rebrand-ehotelos-demo.verify.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/rebrand-ehotelos-demo.sql
--
-- Después del SQL (fuera de este fichero):
--   1. reiniciar el API (espejos in-memory de demo-store);
--   2. POST /backoffice/properties/{prop_123,prop_canary}/readiness/recalculate
--      (el check issuer_legal_name_set regenera su texto desde la sociedad);
--   3. corepack pnpm --filter @hotelos/api rbac:sync (descripción nueva de
--      admin.tenants.manage si el API no la sincronizó al arrancar).

\set ON_ERROR_STOP on

BEGIN;

DO $rebrand$
DECLARE
  n_org  integer := 0;
  n_le   integer := 0;
  n_amc  integer := 0;
  n_ats  integer := 0;
  n_bad  integer := 0;
BEGIN
  -- 1. Organización demo (tax_id B12345674 intacto).
  UPDATE organizations
     SET name = 'Grupo Hotelero Demo',
         legal_name = 'Grupo Hotelero Demo SL'
   WHERE id = 'org_123'
     AND name IN ('HotelOS Demo Group', 'Grupo Hotelero Demo')
     AND legal_name IN ('HotelOS Demo SL', 'Grupo Hotelero Demo SL')
     AND (name, legal_name) IS DISTINCT FROM ('Grupo Hotelero Demo', 'Grupo Hotelero Demo SL');
  GET DIAGNOSTICS n_org = ROW_COUNT;

  -- 2. Sociedad emisora demo (code HD intacto).
  UPDATE legal_entities
     SET legal_name = 'Grupo Hotelero Demo SL',
         updated_at = now()
   WHERE organization_id = 'org_123'
     AND code = 'HD'
     AND legal_name = 'HotelOS Demo SL';
  GET DIAGNOSTICS n_le = ROW_COUNT;

  -- 3. Hotel demo península (code AMC intacto).
  UPDATE properties
     SET name = 'Hotel Demo Madrid Centro',
         legal_name = 'Hotel Demo Madrid Centro SL',
         trade_name = 'Hotel Demo Madrid Centro SL'
   WHERE id = 'prop_123'
     AND organization_id = 'org_123'
     AND name IN ('Anfitorio Madrid Centro', 'Hotel Demo Madrid Centro')
     AND (name, legal_name, trade_name) IS DISTINCT FROM
         ('Hotel Demo Madrid Centro', 'Hotel Demo Madrid Centro SL', 'Hotel Demo Madrid Centro SL');
  GET DIAGNOSTICS n_amc = ROW_COUNT;

  -- 4. Hotel demo Canarias (code ATS intacto).
  UPDATE properties
     SET name = 'Hotel Demo Tenerife Sur',
         legal_name = 'Hotel Demo Tenerife Sur SL',
         trade_name = 'Hotel Demo Tenerife Sur SL'
   WHERE id = 'prop_canary'
     AND organization_id = 'org_123'
     AND name IN ('Anfitorio Tenerife Sur', 'Hotel Demo Tenerife Sur')
     AND (name, legal_name, trade_name) IS DISTINCT FROM
         ('Hotel Demo Tenerife Sur', 'Hotel Demo Tenerife Sur SL', 'Hotel Demo Tenerife Sur SL');
  GET DIAGNOSTICS n_ats = ROW_COUNT;

  RAISE NOTICE 'rebrand-ehotelos-demo: filas actualizadas organizations=% legal_entities=% properties(prop_123)=% properties(prop_canary)=%',
    n_org, n_le, n_amc, n_ats;

  -- Estado objetivo: las 4 filas existen y llevan exactamente los nombres nuevos.
  SELECT 4 - (
      (SELECT count(*) FROM organizations
        WHERE id = 'org_123' AND name = 'Grupo Hotelero Demo' AND legal_name = 'Grupo Hotelero Demo SL' AND tax_id = 'B12345674')
    + (SELECT count(*) FROM legal_entities
        WHERE organization_id = 'org_123' AND code = 'HD' AND legal_name = 'Grupo Hotelero Demo SL')
    + (SELECT count(*) FROM properties
        WHERE id = 'prop_123' AND organization_id = 'org_123' AND code = 'AMC'
          AND name = 'Hotel Demo Madrid Centro' AND legal_name = 'Hotel Demo Madrid Centro SL' AND trade_name = 'Hotel Demo Madrid Centro SL')
    + (SELECT count(*) FROM properties
        WHERE id = 'prop_canary' AND organization_id = 'org_123' AND code = 'ATS'
          AND name = 'Hotel Demo Tenerife Sur' AND legal_name = 'Hotel Demo Tenerife Sur SL' AND trade_name = 'Hotel Demo Tenerife Sur SL')
  ) INTO n_bad;

  IF n_bad <> 0 THEN
    RAISE EXCEPTION 'rebrand-ehotelos-demo: % fila(s) ficticia(s) no están en el estado objetivo tras el UPDATE (valor actual inesperado o fila ausente); se deshace la transacción', n_bad;
  END IF;

  -- Residuos de marca en las tres tablas (solo pueden ser los ficticios; Faranda/CELUISMA no llevan marca).
  SELECT (SELECT count(*) FROM organizations WHERE name ~* 'anfitorio|hotelos' OR legal_name ~* 'anfitorio|hotelos')
       + (SELECT count(*) FROM legal_entities WHERE legal_name ~* 'anfitorio|hotelos')
       + (SELECT count(*) FROM properties WHERE name ~* 'anfitorio|hotelos' OR legal_name ~* 'anfitorio|hotelos' OR trade_name ~* 'anfitorio|hotelos')
    INTO n_bad;
  IF n_bad <> 0 THEN
    RAISE EXCEPTION 'rebrand-ehotelos-demo: quedan % fila(s) con marca antigua en organizations/legal_entities/properties fuera de las 4 ficticias; se deshace la transacción', n_bad;
  END IF;
END
$rebrand$;

COMMIT;

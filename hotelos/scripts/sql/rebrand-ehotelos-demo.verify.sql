-- Rebrand → ehotelOS · Lote 7 · verificación «antes / después» del SQL de datos de demo.
--
-- Ejecutar ANTES y DESPUÉS de scripts/sql/rebrand-ehotelos-demo.sql y comparar
-- las salidas (diff). Solo pueden cambiar:
--   · las 3 líneas «residuo_*» (pasan a 0),
--   · las 4 líneas «objetivo_*» (nombres nuevos),
--   · «readiness_issuer_prop_123» tras POST …/readiness/recalculate (texto nuevo),
--   · «readiness_filas_*» si el recálculo persiste checks nuevos (prop_canary no tenía filas),
--   · «rbac_admin_tenants_manage» tras `rbac:sync` (descripción nueva),
--   · «audit_events» SOLO en count (append-only) si el recálculo/rbac:sync auditan; el md5 de la
--     cadena existente no puede cambiar de valor salvo por el añadido de filas nuevas al final,
--     y por eso se imprime también el md5 de las filas anteriores al inicio («audit_events_base»).
-- TODAS las demás líneas («invariante_*») deben ser idénticas.
--
-- Uso:
--   psql "$DATABASE_URL" -At -f scripts/sql/rebrand-ehotelos-demo.verify.sql > antes.txt
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/rebrand-ehotelos-demo.sql
--   psql "$DATABASE_URL" -At -f scripts/sql/rebrand-ehotelos-demo.verify.sql > despues.txt
--   diff antes.txt despues.txt

\pset format unaligned
\pset tuples_only on
\pset fieldsep '|'

-- ── Residuos de marca en las tablas tocadas (0 después) ─────────────────────
SELECT 'residuo_organizations', count(*) FROM organizations
 WHERE name ~* 'anfitorio|hotelos' OR legal_name ~* 'anfitorio|hotelos';
SELECT 'residuo_legal_entities', count(*) FROM legal_entities
 WHERE legal_name ~* 'anfitorio|hotelos';
SELECT 'residuo_properties', count(*) FROM properties
 WHERE name ~* 'anfitorio|hotelos' OR legal_name ~* 'anfitorio|hotelos' OR trade_name ~* 'anfitorio|hotelos';

-- ── Filas objetivo (cambian) ────────────────────────────────────────────────
SELECT 'objetivo_org_123', name, legal_name, tax_id FROM organizations WHERE id = 'org_123';
SELECT 'objetivo_le_hd_org_123', code, legal_name FROM legal_entities WHERE organization_id = 'org_123' AND code = 'HD';
SELECT 'objetivo_prop_123', code, name, legal_name, trade_name FROM properties WHERE id = 'prop_123';
SELECT 'objetivo_prop_canary', code, name, legal_name, trade_name FROM properties WHERE id = 'prop_canary';

-- ── Derivados que se regeneran por el API / CLI (cambian solo tras ese paso) ─
SELECT 'readiness_issuer_prop_123', status, message FROM property_readiness_checks WHERE property_id = 'prop_123' AND check_code = 'issuer_legal_name_set';
SELECT 'readiness_filas_prop_123', count(*) FROM property_readiness_checks WHERE property_id = 'prop_123';
SELECT 'readiness_filas_prop_canary', count(*) FROM property_readiness_checks WHERE property_id = 'prop_canary';
SELECT 'rbac_admin_tenants_manage', description FROM permissions WHERE key = 'admin.tenants.manage';

-- ── INVARIANTES: histórico con marca antigua que NO se edita (R5) ───────────
-- Sin cuids de la BD local: las filas se seleccionan por valor (nombre, NIF, texto con marca)
-- para que el mismo fichero sirva en el VPS, donde los ids generados difieren.
SELECT 'invariante_invoices_marca', count(*), md5(string_agg(issuer_legal_name, '|' ORDER BY id))
  FROM invoices WHERE issuer_legal_name ~* 'anfitorio|hotelos';
SELECT 'invariante_invoices_total', count(*), md5(string_agg(coalesce(issuer_legal_name, '') || '|' || coalesce(verifactu_hash, ''), '|' ORDER BY id))
  FROM invoices;
SELECT 'invariante_verifactu_xml', count(*) FILTER (WHERE xml_payload IS NOT NULL), md5(string_agg(coalesce(xml_payload, ''), '' ORDER BY id))
  FROM verifactu_submissions;
SELECT 'invariante_verifactu_software', count(*) FILTER (WHERE software_json IS NOT NULL), md5(string_agg(coalesce(software_json::text, ''), '' ORDER BY id))
  FROM verifactu_submissions;
SELECT 'invariante_verifactu_installations', count(*), md5(string_agg(id || ':' || coalesce(numero_instalacion, ''), '|' ORDER BY id))
  FROM verifactu_installations;
SELECT 'invariante_notification_deliveries', count(*), md5(string_agg(coalesce(body_rendered, ''), '' ORDER BY id))
  FROM notification_deliveries;
SELECT 'invariante_webhook_deliveries', count(*) FROM webhook_deliveries;
SELECT 'invariante_ses_hospedajes_submissions', count(*) FROM ses_hospedajes_submissions;
SELECT 'invariante_guest_register_records', count(*) FROM guest_register_records;
SELECT 'invariante_journal_entries', count(*) FROM journal_entries;
SELECT 'invariante_journal_lines', count(*) FROM journal_lines;
SELECT 'invariante_pms_shadow_alerts_marca', count(*), md5(string_agg(coalesce(message, ''), '' ORDER BY id))
  FROM pms_shadow_alerts WHERE message ~* 'anfitorio|hotelos';
SELECT 'invariante_reservation_import_rows_marca', count(*), md5(string_agg(coalesce(error_message, '') || coalesce(warnings_json::text, ''), '' ORDER BY id))
  FROM reservation_import_rows WHERE error_message ~* 'anfitorio|hotelos' OR warnings_json::text ~* 'anfitorio|hotelos';
SELECT 'invariante_assets_qr_hotelos', count(*) FROM assets WHERE qr_code_value LIKE 'hotelos://%';
SELECT 'invariante_integration_secret_hotelos', count(*) FROM integration_connections WHERE credentials_secret_ref LIKE 'secret://hotelos/%';
SELECT 'invariante_usuario_demo', email, md5(coalesce(password_hash, '')) FROM users WHERE email = 'reception@example.com';
SELECT 'invariante_usuarios', count(*) FROM users;

-- ── INVARIANTES: cadena de auditoría (append-only; el md5 base cubre las filas que existían al escribir este fichero) ─
SELECT 'audit_events', count(*), md5(string_agg(current_hash, '' ORDER BY id)) FROM audit_events;

-- ── INVARIANTES: tenants reales y códigos inmutables ────────────────────────
SELECT 'invariante_faranda_org', count(*), md5(string_agg(coalesce(name, '') || '|' || coalesce(legal_name, '') || '|' || coalesce(tax_id, ''), '|' ORDER BY id))
  FROM organizations WHERE name ILIKE 'Faranda%';
SELECT 'invariante_celuisma_le', count(*), md5(string_agg(coalesce(code, '') || '|' || coalesce(legal_name, ''), '|' ORDER BY id))
  FROM legal_entities WHERE legal_name ILIKE 'CELUISMA%';
SELECT 'invariante_faranda_properties', count(*), md5(string_agg(coalesce(name, '') || '|' || coalesce(legal_name, '') || '|' || coalesce(trade_name, ''), '|' ORDER BY id))
  FROM properties WHERE organization_id IN (SELECT id FROM organizations WHERE name ILIKE 'Faranda%');
SELECT 'invariante_codigos_properties', string_agg(id || '=' || coalesce(code, ''), ',' ORDER BY id) FROM properties WHERE id IN ('prop_123', 'prop_canary');
SELECT 'invariante_le_hd_org_123', id, code FROM legal_entities WHERE organization_id = 'org_123' AND code = 'HD';
SELECT 'invariante_tax_id_org_123', tax_id FROM organizations WHERE id = 'org_123';
SELECT 'invariante_total_organizations', count(*) FROM organizations;
SELECT 'invariante_total_legal_entities', count(*) FROM legal_entities;
SELECT 'invariante_total_properties', count(*) FROM properties;

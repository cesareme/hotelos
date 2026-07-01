# Anfitorio · Revisión 360º (2026-06) — hallazgos y correcciones

Revisión multi-agente (ingeniería full-stack, personas hoteleras, marketing, mercado
+ escépticos). Puntuaciones de las áreas auditadas: **Seguridad 4/10**, **Datos 5/10**.
El dealbreaker nº1 para un piloto de pago con datos reales de huéspedes = aislamiento
entre inquilinos. Este doc registra lo corregido y lo que queda como **decisión de César**.

## ✅ Corregido (commit 7590c64)

### IDOR cross-tenant (CRÍTICO)
Las lecturas por `:id` devolvían datos de CUALQUIER hotel sin verificar la organización
del usuario (un hotel podía leer DNIs, facturas, folios y partes SES de otro). Añadidos
guards de tenant (`assert{Reservation,Invoice,Folio,Guest,GdprRequest}InOrg`, 404 no 403):
- `GET /reservations/:id`, `/invoices/:id`, `/folios/:id/balance`, `/guests/:id/timeline`
- `GET /properties/:propertyId/guest-register-records`, `/properties/:propertyId/reservations`,
  `/compliance/spain/reservations/:id/guest-register` (registro de viajeros SES — RD 933/2021)

### RGPD (CRÍTICO)
- `GET /gdpr/requests` ya no acepta `?organizationId=` de otra org (siempre la del contexto).
- get/acknowledge/fulfill-dsar/execute-erasure/reject exigen que la solicitud sea de tu org
  antes de compilar el dossier de PII o ejecutar el borrado.

### Cifrado PII fail-closed (ALTO)
`assertEncryptionKeyForProduction()` aborta el arranque en producción si falta la clave, en
vez de guardar DNI/email/teléfono en texto plano en silencio.

### Revocación de sesiones (MEDIO)
Reset y cambio de contraseña revocan todas las sesiones activas (los JWT del atacante mueren).

## ⏳ Decisiones para César (no incluidas — necesitan tu visto bueno o una BD)

1. **RBAC_STRICT=true en producción.** Hoy 62 GET sensibles quedan fail-open. Ponerlo a true
   falla-cerrado, PERO antes hay que **completar el manifiesto** con esos 62 GET o darán 403.
   → Tarea de 1 sesión: mapear los 62 + activar el flag. Recomendado antes del primer piloto.
2. **Integridad referencial fiscal (Datos, CRÍTICO).** Solo 9 `@relation` en 250 modelos; la
   cadena factura→líneas→VeriFactu→asientos no tiene FK. Requiere `migrate dev` con BD +
   verificar huérfanos. → Sesión dedicada con la BD del VPS.
3. **Migraciones reproducibles.** Producción vive de `db push`; falta un baseline real y pasar
   a `migrate deploy`. → Mismo bloque que (2).
4. **Cabeceras CSP / X-Frame-Options en Caddy** (clickjacking + defensa XSS). Cambio de config.
5. **PII/tokens en logs**: DNIs por query string y token de portal de huésped en la ruta →
   mover a headers/body y redactar en pino/Caddy.

## Ángulo de marketing (del auditor de mensaje)
La mejor frase del producto ya está escrita en el código (`ReservationCreateScreen.tsx:813`:
"Escanea el DNI, la IA rellena el parte, tú revisas y confirmas. Nada se guarda sin tu
confirmación") — sacarla al one-pager. Ángulo nº1: **cumplimiento con fecha** — "desde el
1-7-2026 tu facturación debe ser VeriFactu; la nuestra ya lo es, te lo demuestro escaneando el
QR AEAT". Regla anti-humo: toda afirmación de producto con `file:line` detrás; lo sandbox/mock,
etiquetado como tal.

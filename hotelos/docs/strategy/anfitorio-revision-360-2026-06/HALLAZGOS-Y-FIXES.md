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

## 🚨 CORRECCIÓN CRÍTICA DE LA SÍNTESIS CEO — la fecha del pitch era FALSA
El **RDL 15/2025 aplazó VeriFactu**: obligatorio **1-1-2027 (sociedades)** y **1-7-2027
(autónomos)**; **2026 es voluntario**. El material que decía "obligatorio 1-7-2026" (incluido
`spanish-compliance.ts:48`, ya corregido) quemaría el canal de gestorías a la primera. Mensaje
correcto: **"SES le sanciona HOY (601–30.000€); llegue a 2027 ya certificado"**.

### Corregido en este pase (commit siguiente)
- Fecha VeriFactu en el artículo de ayuda (`spanish-compliance.ts`).
- Identidad del SIF ante AEAT: `name` "HotelOS"→"Anfitorio", id, version desde env
  (`verifactu-submission.service.ts`). ⚠️ El **NIF del productor** (`VERIFACTU_SOFTWARE_NIF`) sigue
  con placeholder `B00000000` — **César debe poner su NIF real** vía env antes de enviar a AEAT.
- 2 endpoints rotos: no-show (`/transition`→`/no-show`), move-charges (PATCH→POST).
- Toast "huella VeriFactu placeholder" → texto limpio.

## ⚠️ Críticos de dinero/cumplimiento (NO tocados — necesitan BD/tests, decisión de César)
- **Riesgo legal PROPIO (bloqueante)**: como fabricante de SIF, falta la **declaración responsable
  RD 1007/2023** (vigente desde 29-7-2025) y el software se identifica con NIF placeholder →
  exposición hasta 150.000€/ejercicio. **Solo César** puede firmarla y poner su NIF real.
- **Parte SES del check-in falla el 100%** (POST a endpoint inexistente; solo hay GET) con UI de
  éxito → incumplimiento RD 933/2021 (la única norma vigente HOY). Cablear al pipeline SES Prisma.
- **Registro de viajeros + envíos en RAM (demoStore)** → se pierden en cada deploy (retención 3 años).
- **`markInvoicePaid` asigna el pago a un folio arbitrario** + sin idempotencia (doble clic = doble
  cobro) + Invoice sin `folioId` (misma factura N veces). Necesita columna nueva + migración.
- **NIF emisor por regex del nombre legal** con fallback `B00000000` (`invoice.service.ts:285`) →
  usar `organization.taxId` y FALLAR si falta. (No lo toqué sin poder testear el camino del dinero.)
- **VPS en `NODE_ENV=dev`** → desactiva los fail-closed de crypto/JWT (incl. mi guard nuevo). Quick
  win de 10 min: poner `NODE_ENV=production` + `APP_VERSION` en el unit systemd.

## Puntuaciones CEO
Producto **5**, Técnica **4**, Mercado **7**, Go-to-market **3**. Veredicto: **no cobrar hoy**;
primer piloto de pago alcanzable **sep–oct** con alcance pactado + cuña SES como producto de entrada.
Plan 30/60/90 completo en el `.output` del workflow `w5ghkx1ob`.

## Ángulo de marketing
La mejor frase del producto ya está escrita (`ReservationCreateScreen.tsx:813`: "Escanea el DNI, la
IA rellena el parte, tú revisas y confirmas. Nada se guarda sin tu confirmación") — sacarla al
one-pager. Regla anti-humo: toda afirmación con `file:line` detrás; lo sandbox/mock, etiquetado.

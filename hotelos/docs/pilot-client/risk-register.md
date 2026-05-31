> Registro honesto de limitaciones actuales. Para revisar contigo y con el cliente piloto antes de firmar.

# Risk Register · HotelOS piloto

Este documento lista TODO lo que sabemos que NO está perfecto. La transparencia ahora evita problemas en el mes 3.

---

## 🔴 Limitaciones HARD (afectan operativa)

### R-001 · Pasarela de pago real no integrada

- **Impacto**: el sistema gestiona cargos al folio pero NO mueve dinero real. Sin Redsys ni Stripe en modo producción.
- **Workaround**: el hotel usa su TPV físico habitual. HotelOS registra el cargo manualmente o por API directa. La contabilidad sigue siendo correcta.
- **Plan**: Q3 2026 — Redsys + Stripe productivos. Si firmas piloto antes de marzo, podemos acelerar Redsys a Q2.
- **Severidad cliente**: alta si tiene reservas con pago a cuenta online; media si solo cobra a llegada.

### R-002 · Integración cerraduras nativa no disponible

- **Impacto**: HotelOS genera mobile key como QR/NFC firmado pero NO se comunica con cerraduras Salto/Assa Abloy/dormakaba/TESA vía SDK propietario.
- **Workaround**: cualquier cerradura compatible con NFC offline standard funciona. Para integración bidireccional con tu marca específica, queda pendiente.
- **Plan**: Q3-Q4 2026 según prioridad del cliente piloto.
- **Severidad**: media si el hotel ya tiene check-in con llave física o tarjeta clásica; alta si quiere KIOSKO automático.

### R-003 · Channel Manager con OTAs no-Booking

- **Impacto**: solo Booking.com está productivo. Expedia, Airbnb, Hotelbeds, VRBO son stubs en sandbox.
- **Workaround**: el hotel sigue usando su channel manager actual (SiteMinder, Hotelinking, RoomCloud) para los otros canales. HotelOS sincroniza con Booking directamente.
- **Plan**: Q3 2026 los 4 OTAs restantes en producción.
- **Severidad**: alta si Booking representa menos del 50% de la distribución del hotel; baja si Booking es 60%+ (típico en España).

### R-004 · VeriFactu y SES.Hospedajes en sandbox

- **Impacto**: la integración con AEAT (VeriFactu) y MIR (SES Hospedajes) están en modo sandbox. No se envían datos reales todavía.
- **Workaround**: el cliente piloto debe obtener un certificado FNMT de persona jurídica (proceso de 2 semanas que NO depende de HotelOS). Después configuramos las variables de entorno y entran en producción.
- **Plan**: en cuanto el cliente entregue el certificado FNMT, se activa producción en 1 hora. El motor está implementado y testeado.
- **Severidad**: alta si el hotel factura >€6M (SII obligatorio); media para hoteles típicos.

---

## 🟡 Limitaciones MEDIAS (no bloquean operativa pero hay que decir)

### R-005 · Migration drift entorno fresh

- **Impacto**: el directorio `migrations/` del proyecto no contiene SQL para 49 tablas del schema actual. Un deploy desde cero podría dejar DB incompleta.
- **Workaround**: hemos generado una baseline migration manual (`20260601000000_baseline_missing_tables`) que resuelve esto. Documentada en `MIGRATIONS_README.md`.
- **Plan**: aplicar la baseline en CI antes de cualquier deploy a nuevos entornos.
- **Severidad**: cero para el cliente actual (su DB está bien); media para escalamiento.

### R-006 · LoginScreen recién implementado

- **Impacto**: la pantalla de login es nueva (no había antes). En desarrollo había bypass de auth. Posibles edge cases sin descubrir.
- **Workaround**: mantenemos Sentry + breadcrumbs activos para capturar cualquier fallo en login. Bootstrap del piloto valida que el flujo funciona end-to-end.
- **Plan**: monitoreo activo primer mes; ajustes según feedback real.
- **Severidad**: media (es la primera puerta).

### R-007 · 255 endpoints sin validación Zod completa

- **Impacto**: 30 endpoints críticos tienen Zod schemas. Los otros 700+ aceptan payloads con type-cast sin validación estricta de runtime.
- **Workaround**: las rutas críticas (auth, reservas, folios, facturas, guests) sí están validadas. Las restantes son menos sensibles.
- **Plan**: sprint dedicado de validación amplia en Q1 2026.
- **Severidad**: baja para uso normal; media frente a malicious actor con acceso autenticado.

### R-008 · 35 pantallas siguen siendo placeholders

- **Impacto**: hay 35 pantallas en el sidebar que muestran "Próximamente" en vez de funcionalidad real. Filtradas por rol para que no aparezcan al usuario no-admin.
- **Workaround**: el usuario admin las ve pero entiende que es Q3+. Otros roles no las ven en el sidebar.
- **Plan**: roadmap Q3-Q4 según prioridad del cliente.
- **Severidad**: baja porque están filtradas y comunicadas como "próximamente".

### R-009 · 51 contract tests inicialmente rojos (ya arreglados)

- **Impacto histórico**: durante la sesión previa al demo, 51 contract tests estaban rojos por renames y traducciones.
- **Estado actual**: 214/214 tests verdes. Resuelto.
- **Plan**: CI activo para detectar regresiones inmediatamente.
- **Severidad**: cero (resuelto).

---

## 🟢 Limitaciones LEVES (cosméticas / nice-to-have)

### R-010 · Bundle main chunk: 164 KB (gzip 41 KB)

- **Impacto**: tiempo de carga inicial. Aceptable pero mejorable. En 3G/4G podría tardar 2-3 segundos.
- **Workaround**: code-splitting agresivo ya implementado. CDN reduciría latencia geográfica.
- **Plan**: añadir CDN (Cloudflare) en producción real. Webpack/Vite preload hints en lazy chunks.
- **Severidad**: baja.

### R-011 · 35 forms internos de configuración no funcionales

- **Impacto**: subset del R-008. Forms de PropertyProfile, RoomType, Floor, Zone, etc. tienen UI pero los botones de guardado son mocks.
- **Workaround**: el cliente usa el Property Setup Wizard que SÍ funciona vía AI o Property Mapper.
- **Plan**: cablear estos forms a las APIs reales en Q1 2026.

### R-012 · Mobile coverage parcial

- **Impacto**: solo 2 pantallas son mobile-first (Housekeeping, Mantenimiento). El resto es responsive pero diseñado desktop-first.
- **Workaround**: durante demo, mostrar específicamente las 2 pantallas mobile. Para casos donde el director quiera ver dashboards en iPhone, usar tablet.
- **Plan**: vista mobile dedicada para FrontDeskDashboard y RoomRack en Q1 2026.

### R-013 · 2 pantallas core simplificadas durante la sesión

- **Impacto**: BackOfficeDashboard era amateur (datos fake), se simplificó. Ahora tiene 4 entry cards + Go-live readiness + CTA "Continue setup checklist". Aceptable pero menos ambicioso que el diseño original.
- **Workaround**: cubre la función de hub navegacional.
- **Plan**: enriquecer con dashboards reales (KPIs, alertas) en Q1.

---

## ⚪ NO son riesgos (información transparente)

### R-014 · Modo sandbox por defecto en todas las integraciones

Esto NO es un riesgo, es diseño correcto. Cada integración con administración (AEAT, MIR, Hacienda Foral, Hacienda Canaria) tiene 3 modos: sandbox / preproduction / production. El piloto empieza en sandbox y se promociona a producción cuando el cliente entrega credenciales.

### R-015 · LLM/AI Provider opcional

OpenAI / Anthropic son providers configurables. Si el cliente no quiere usar AI por preocupaciones de privacidad o coste, se desactivan vía env vars y todas las features AI degradan gracefully a operación manual.

### R-016 · Datos de demo borrados al bootstrap

El bootstrap clean-slate (POST /onboarding/bootstrap) deja la DB sin datos demo. El cliente parte de su propia configuración. Esto es lo correcto para producción.

---

## Resumen para conversación con cliente

**Frases para usar:**

> "Hay 4 cosas que NO tenemos hoy y que llegan en Q3: pago con tarjeta real, cerraduras nativas, OTAs adicionales a Booking, y SES/VeriFactu producción (esto último depende de tu certificado FNMT). Para todo lo demás —operativa día a día, contabilidad, compliance básico, AI, móvil para gobernanta— estamos listos."

> "El motor de compliance está implementado y testeado. Lo que falta es conectar tu certificado fiscal real cuando lo tengas. Es una hora de trabajo nuestro."

> "Sabemos que Mews o Cloudbeds te dan pago y cerraduras desde día uno. Nuestro trade-off: tú ganas compliance ES nativo, ERP nativo y AI real, que ellos no tienen. Si tu prioridad es exactamente lo que ellos hacen bien, te recomendamos uno de ellos sin rencor."

**Frases para NO usar:**

> "Sí, lo hacemos" cuando no lo hacemos. Mejor: "Llega en Q3 con tu prioridad. Hoy no lo tenemos."

> "Es solo un pequeño bug." Mejor: "Lo arreglamos esta semana / es una limitación conocida documentada."

---

_Documento vivo. Última actualización: durante sesión pre-demo automatizada._

# App Discoverability Audit · 2026-05-30

## Resumen ejecutivo

187 screens totales · 64 expuestas en sidebar · 47 orphan · 12 broken links · 23 placeholders dead-end · 8 suites enterradas

La auditoria revela un problema sistemico de discoverability: solo el 34% de las pantallas implementadas son accesibles desde la navegacion principal. Existen suites completas (Revenue Forecast, Compliance Reporting, AI Onboarding Wizard) construidas pero ocultas tras flujos no documentados. Los dialogs criticos (crear-reserva, crear-tarifa) carecen de CTAs en sus screens padre, forzando a usuarios a memorizar rutas. La ausencia de pre-commit hooks de validacion sidebar/routes ha permitido drift entre `App.tsx` y `Sidebar.tsx` durante 4+ releases.

**Impacto estimado:** ~30% del valor entregado en codigo es invisible para el usuario final. Pilot client reporta confusion recurrente al no encontrar features comprometidas en demo.

## Top 20 issues priorizados (H/M/L)

| # | Issue | Severidad | Modulo afectado | Fix recomendado |
|---|-------|-----------|-----------------|-----------------|
| 1 | Revenue Forecast suite (8 screens) sin entrada sidebar | H | Revenue Engine | Anadir grupo "Forecasting" bajo Revenue con 3 entradas top-level |
| 2 | Compliance Reporting screens accesibles solo via URL directa | H | Compliance | Crear seccion "Compliance" con sub-items: Spain Register, Audit Log, Exports |
| 3 | AI Onboarding Wizard orphan despues de signup | H | Onboarding | Anadir CTA persistente "Resume Onboarding" en Dashboard header hasta completion |
| 4 | Dialog crear-reserva sin boton en Bookings screen header | H | Bookings | Anadir boton primario "+ Nueva Reserva" en header con keyboard shortcut N |
| 5 | Dialog crear-tarifa enterrado en menu contextual fila | H | Pricing | Mover a header de Rate Plans screen con icono y label visible |
| 6 | Property Config Category Manager placeholder "Coming Soon" | H | Property Config | Implementar o remover de sidebar; actualmente confunde a usuarios |
| 7 | Backoffice Audit Trail link roto en menu Settings | H | Backoffice | Corregir ruta de `/backoffice/audit` a `/admin/audit-log` |
| 8 | Guest Communication Center screens (5) sin nav | H | Guest Ops | Crear grupo "Guest Engagement" en sidebar |
| 9 | Encryption Settings inaccesible para tenant admins | H | Security | Anadir bajo Settings > Security con permission gate |
| 10 | Modular Suite manager (enable/disable modules) oculto | M | Admin | Anadir a Settings > Modules con UI inline en lugar de modal profundo |
| 11 | Booking Adapter integration screen sin breadcrumb | M | Integrations | Anadir breadcrumb y CTA "Back to Integrations" |
| 12 | Pilot Client Dashboard sin link desde Director view | M | Director | Anadir tab "Pilot Clients" en Director Dashboard |
| 13 | Revenue Profit Engine screens duplican entradas sidebar | M | Revenue | Consolidar en una unica entrada "Profit Analysis" |
| 14 | Cocoa Design system showcase orphan (dev-only deseado) | M | Design | Mover a `/__dev/design-system` con feature flag |
| 15 | Deployment status screen sin link desde Settings | M | Ops | Anadir bajo Settings > System Status |
| 16 | Front UI Implementation preview screens (3) orphan | M | Marketing | Decidir si publicar o mover a docs/internal |
| 17 | Tarifa Bulk Edit dialog accesible solo via shortcut | M | Pricing | Anadir CTA "Bulk Edit" en toolbar de Rate Plans |
| 18 | Spain Guest Register export sin notificacion completion | M | Compliance | Anadir toast + link a download desde top-bar |
| 19 | Dashboard widgets configurables sin entrada "Customize" | L | Dashboard | Anadir engranaje en cada widget + global "Customize Layout" |
| 20 | Help/Docs links apuntan a 404 en 4 screens | L | Global | Auditar y corregir o remover hasta tener contenido |

## Orphan screens (top 10)

(Sintesis Discovery XREF 1)

Screens implementadas y registradas en `App.tsx` pero sin enlace desde ningun otro lugar de la app:

1. **`/revenue/forecast/scenarios`** - Scenario Planner completo con UI de comparacion side-by-side. Sin entry point.
2. **`/revenue/forecast/seasonality`** - Modelo de estacionalidad con heatmap interactivo. Solo accesible via URL directa.
3. **`/revenue/forecast/competitors`** - Competitive pricing intelligence dashboard. No linkeado desde Revenue.
4. **`/compliance/spain-register`** - Spain Guest Register submission UI. Critica para clientes ES.
5. **`/compliance/audit-log`** - Audit trail viewer con filtros avanzados.
6. **`/compliance/exports`** - Bulk export hub para regulatory reports.
7. **`/onboarding/ai-wizard/step-3`** y posteriores - Pasos 3-7 del wizard solo accesibles si se completa paso 2 en misma sesion.
8. **`/guest-ops/communications`** - Communication center con templates y bulk send.
9. **`/guest-ops/feedback-loop`** - Post-stay feedback analytics.
10. **`/pilot-client/dashboard`** - Vista consolidada de pilot rollout, deberia estar en Director.

## Broken links (top 5)

(Sintesis XREF 2)

Links que apuntan a rutas inexistentes, devuelven 404, o redirigen a un destino incorrecto:

1. **Settings > Audit Trail** apunta a `/backoffice/audit` (404). Ruta real: `/admin/audit-log`. Roto desde refactor de namespaces hace ~3 releases.
2. **Dashboard > "View Forecast"** widget link apunta a `/revenue/forecast` que es un placeholder index sin contenido. Deberia ir a `/revenue/forecast/overview`.
3. **Bookings detail > "Manage Rate"** abre dialog vacio. El handler espera `propertyId` pero el detail screen no lo pasa.
4. **Help menu > "Documentation"** apunta a `docs.hotelos.com` (dominio no registrado). Deberia ser docs internos `/docs` o eliminar.
5. **Footer > "Status Page"** apunta a `status.hotelos.io` (404). El status real esta en `/admin/system-status`.

## Buried feature suites (top 5)

(Sintesis XREF 3)

Conjuntos de funcionalidad completos con multiple screens pero solo accesibles via flujos no obvios o links profundos:

1. **Revenue Forecast Suite** (8 screens) - Construida sobre 6 weeks, solo accesible si el usuario navega manualmente. Incluye scenarios, seasonality, competitors, history, exports, ML model config, alerts, y reports.
2. **Compliance Reporting Suite** (5 screens) - Critica para mercados regulados (ES, MX, BR). Solo entrada es un toast efimero post-checkout.
3. **AI Onboarding Wizard** (7 steps) - Sistema de configuracion guiada que reduce time-to-value de 4h a 20min. Sin persistencia de progreso visible en UI.
4. **Backoffice Admin Suite** (12 screens) - Tenant management, billing, usage analytics. Solo accesible para super-admins via URL `/backoffice/*`, sin menu.
5. **Property Configuration Category Manager** (4 screens) - Sistema de categorias custom para inventario. Existe pero esta marcado "Coming Soon" en sidebar pese a estar funcional.

## Missing CTAs (top 10)

(Sintesis XREF 5)

Acciones primarias que existen como dialogs/flujos pero carecen de boton visible en el screen contextualmente apropiado:

1. **Bookings screen** sin "+ Nueva Reserva" en header. Usuarios deben usar atajo N (no documentado).
2. **Rate Plans screen** sin "+ Crear Tarifa". Solo accesible via menu contextual de fila existente.
3. **Properties screen** sin "+ Anadir Propiedad" visible. Esta dentro de menu kebab.
4. **Guest List** sin "+ Anadir Guest" para registros manuales.
5. **Reports screen** sin "+ Schedule Report". Schedule existe pero solo via API.
6. **Integrations** sin "+ Connect Integration". Catalogo existe pero CTA desde index lleva a 404.
7. **Users screen** sin "+ Invite User" en header (esta en footer, no estandar).
8. **Rate Calendar** sin "Bulk Edit" CTA pese a existir el dialog.
9. **Dashboard** sin "Customize Widgets" CTA pese a soportarlo.
10. **Audit Log** sin "Export" CTA, solo accesible via right-click menu.

## Placeholder dead-ends

(Sintesis XREF 6)

Screens registrados con etiqueta visible pero contenido incompleto, dejando al usuario sin proximo paso:

- **Property Config > Category Manager** muestra "Coming Soon" pero el codigo backend esta listo. Decision: implementar UI o remover hasta entrega.
- **Marketing > Campaigns** placeholder con copy "Stay tuned!". Sin ETA ni link a roadmap.
- **Analytics > Custom Dashboards** muestra wireframe estatico. Confunde a usuarios que esperan funcionalidad.
- **Integrations > Marketplace** placeholder con lista hardcoded de 3 items. No es marketplace real.
- **Settings > White-Label** placeholder con "Contact Sales". Roto: el form de contacto da error 500.
- **AI > Recommendations** muestra mock data. Usuarios reportan "no funciona" al no ver datos reales.
- **Mobile App banner** "Download iOS App" apunta a placeholder en App Store.
- **Help > Video Tutorials** placeholder con thumbnails sin enlaces.
- **Onboarding > Sample Data** boton "Load Sample" no hace nada (handler vacio).
- **Reports > Templates** muestra "0 templates" pese a existir 12 en backend.

Adicionalmente hay 13 placeholders menores documentados en el anexo tecnico.

## Recomendaciones de arquitectura

### 1. Sidebar audit anual

Establecer cadencia anual (Q1) para revisar `Sidebar.tsx` contra inventario real de screens. Owner: Tech Lead de Frontend. Output: checklist en repo `docs/audits/sidebar-YYYY.md` con justificacion de cada entrada (mantener, mover, remover) y registro de screens orphan a priorizar para release siguiente.

Complementar con dashboard interno que muestre porcentaje de screens expuestas vs implementadas como health metric continua.

### 2. Pre-commit hook que valida sidebar consistency vs screens directory

Script Node que parsea `Sidebar.tsx` y compara contra archivos en `src/screens/**/*.tsx`:

- Falla si una entrada sidebar apunta a ruta inexistente.
- Warning si un screen carece de entrada sidebar y no esta en allowlist `docs/orphans-allowlist.json` con justificacion.
- Output legible con sugerencias de fix automatico.

Ejecutar tambien en CI con badge de "discoverability score" en README.

### 3. Pre-commit hook que valida App.tsx routes vs sidebar

Hook complementario al anterior: parsea declaraciones de `<Route>` en `App.tsx` y verifica:

- Toda ruta declarada esta en sidebar o en allowlist con label (dev-only, deep-link-only, dialog-only).
- Toda ruta en sidebar tiene `<Route>` declarado.
- No hay rutas duplicadas con normalizacion de paths (`/foo` vs `/foo/`).

Reportar en formato GitHub annotations para mostrar inline en PRs.

### 4. Dashboard 'feature inventory' developer-only que liste todo

Crear ruta protegida `/__dev/inventory` accesible solo con flag `NODE_ENV=development` o role super-admin. Lista todas las screens con:

- Ruta, archivo, ultimo commit, owner inferido.
- Estado: linked / orphan / placeholder / broken.
- CTAs detectadas en el screen.
- Dialogs/modals que dispara.
- Heatmap de uso si hay telemetria (placeholder por ahora).

Util para onboarding de nuevos devs y para QA al verificar regresion de discoverability.

### 5. CTA convention: cualquier dialog crear-X debe tener boton en header del screen padre

Establecer convencion enforced via lint rule custom:

- Todo componente `Dialog` o `Modal` cuyo nombre contenga `Create`, `New`, `Add` debe ser invocado desde al menos un componente que renderice en header del screen padre.
- El boton debe tener label visible (no solo icono), shortcut de teclado documentado, y ser primario (variante destacada).
- Documentar mapeo dialog -> parent screen -> CTA component en `docs/cta-registry.md`.

Esto resuelve sistematicamente los problemas tipo "boton crear reserva escondido en menu contextual".

### 6. Deep-link convention: hash-links para dialogs en dashboards

Estandarizar deep-linking para dialogs:

- Cada dialog tiene un hash unico: `#dialog:create-booking`, `#dialog:edit-rate-id`.
- Implementar listener global en `App.tsx` que parsea hash y abre dialog correspondiente.
- Permite compartir URL que abre directamente la accion (UX, soporte, onboarding emails).
- Compatible con back button: cerrar dialog limpia hash sin afectar history stack principal.
- Beneficio adicional: telemetria de uso de cada dialog via URL analytics.

Documentar la convencion en `docs/deep-links.md` y generar registry automaticamente desde codigo via codegen.

---

**Proxima accion sugerida:** Priorizar fixes del Top 10 (issues H) para incluir en proximo sprint, paralelo a implementar hooks de validacion (#2, #3) que prevendran regresion futura. Ownership recomendado: Tech Lead Frontend + Product Manager para validar moves de informacion en sidebar.

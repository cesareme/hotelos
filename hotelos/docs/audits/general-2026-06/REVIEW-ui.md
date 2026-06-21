# Revisión adversarial — AUDIT-ui.md

Revisor: product designer senior (escéptico). Fecha: 2026-06-21.
Método: contraste del informe contra código real en `apps/admin-web/src/screens/`, con foco en los **flujos diarios de front desk** de un PMS, que es donde se juega la usabilidad.

## Veredicto rápido

El informe es **honesto y mayormente verificable**: los conteos de adopción y los hallazgos P0 son reales, no teóricos. Pero comete el pecado capital de un auditor de PMS: **evaluó los flujos "de escaparate" (alta de reserva, Rate Grid, onboarding) y casi ignoró las pantallas donde el recepcionista vive 8 horas al día** — el Room Rack, el Night Audit y los dashboards diarios. Ahí está el problema de usabilidad grave que omitió.

---

## Confirmados (reales, no teóricos)

- **Conteos de adopción del DS** — verificados casi al dígito: CocoaPageHeader 14/202, CocoaCard 19/202, ScreenScaffold 30, Skeleton 2, LoadingBlock 57, ErrorState 37. El `bo-*` real es 156 (informe dice 152; diferencia trivial). El diagnóstico de "dos design systems en paralelo" es **correcto y serio**.
- **#2 Datos demo hardcodeados** — CONFIRMADO y es el hallazgo más valioso. `ReservationCreateScreen.tsx:75-103`: `totalAmount:"272"`, `bookerName:"Ana Martinez"`, `firstName:"Ana"`, `surname1:"Martinez"`, `phone:"+34600000000"`, emails `ana@example.com`. Riesgo real de crear una reserva con el huésped equivocado. P0 legítimo.
- **#3 Mega-formulario** — CONFIRMADO: 153 `FieldRow` en una página, 62 KB. Importa `CocoaStepper` solo para contadores de ocupación, no para navegar el alta. Carga cognitiva real.
- **#6 Etiquetas EN/ES mezcladas** + **#12 validación** — CONFIRMADO parcial: 0 `aria-invalid` en todo el archivo; no hay error por campo. **Matiz**: el informe dice "errores solo por toast"; en realidad hay también un `setStatus(message)` inline (línea 563) además del toast. Sigue sin ser validación field-level con scroll-to-error, así que el hallazgo se sostiene, pero la redacción exagera.
- **#1 Mezcla de DS en un archivo** — el patrón es real (ReservationCreate importa 8 componentes Cocoa y los mete en layout `bo-*`).
- **#9 Modelo de personas desalineado** — CONFIRMADO y bien cazado: `roles.ts` define 5 roles / 4 personas reales; el array `PERSONAS` de `PersonaLandingScreen.tsx` tiene **9 entradas** (verificado). El "9 vs 5" es real. (Nota: el comentario interno de la propia pantalla dice "8 personas operativas" — está stale; la cifra 9 del informe es la correcta.)

## Refutados / matizados

- **"Quick Check-in … Cocoa nativo" (resumen ejecutivo)** — FALSO para Check-in. `QuickCheckInDrawer.tsx` tiene **0 referencias a Cocoa**; es Aurora `bo-*` puro. Solo el **Rate Grid** es Cocoa nativo. El flujo de 90s y el cronómetro sí existen y son excelentes, pero el informe los vende como ejemplares del nuevo DS cuando son del viejo. Inconsistencia que el propio informe debería haber detectado.
- **#7 "muestran spinner global"** — IMPRECISO, y en la dirección equivocada (es **peor** de lo que dice). RoomRack, NightAudit y FrontDeskDashboard **no muestran spinner ninguno**: pintan un `<span className="bo-status info">cargando</span>` de ~12px en el header mientras el área de contenido queda **en blanco**. No es "spinner genérico percibido lento": es pantalla vacía con un texto diminuto. La recomendación (skeletons) es correcta, pero el diagnóstico subestima la gravedad.

## Omitidos (lo que un PMS reviewer NO puede dejar pasar)

1. **EL ROOM RACK NO SE AUDITÓ.** Es la pantalla más usada del front desk — su propio encabezado la llama *"el corazón visual del PMS"* — y el informe no la menciona ni una vez en los 12 hallazgos. `RoomRackScreen.tsx`: **0 LoadingBlock, 0 ErrorState, 0 EmptyState, 0 Skeleton**, 24 usos `bo-*`, paleta de estados con **hex hardcodeados** (`#1f8a4c`, `#2663c4`…) fuera de tokens Cocoa — justo el anti-patrón que el informe denuncia en otras pantallas, en la pantalla que más importa. Que el corazón del PMS quede en blanco si la API tarda, y no tenga estado de error, es **más grave que cualquiera de los 12 hallazgos listados**.

2. **Night Audit sin red de seguridad.** `NightAuditScreen.tsx`: mismo patrón (0 estados de `States.tsx`, "cargando" en texto). El cierre de día es una operación crítica e irreversible; merecía un hallazgo propio sobre confirmación/estado de error visible, y no aparece.

3. **No se evaluó el ciclo diario completo como recorrido.** El informe trata pantallas como islas. El flujo real del recepcionista es Rack → check-in → folio → check-out → night audit. El **Quick Check-out** (`QuickCheckOutDrawer.tsx` — folio, validar cargos, detectar saldo, cobrar, emitir factura) está bien estructurado y **ni se menciona**; es la contraparte del check-in que el informe sí elogió. Evaluar uno y no el otro delata que no se recorrió el flujo end-to-end.

4. **Falta una tabla de cobertura de flujos críticos.** Un audit de PMS debería declarar explícitamente qué flujos diarios se probaron (rack, arrivals/departures, walk-in, room move, folio split, no-show, night audit) y con qué resultado. El método ("pantallas representativas de cada flujo") es demasiado vago y, de hecho, dejó fuera el flujo nuclear.

**Crédito justo:** `ReservationsListScreen.tsx` (worklist diaria) sí usa `LoadingBlock`/`ErrorState` correctamente — un buen ejemplo del patrón que el informe no mencionó, lo que refuerza que la cobertura fue selectiva.

---

## Veredicto

El informe es **sólido en lo transversal (deuda de DS, datos demo, validación) y débil en lo profundo (flujos operativos diarios)**. Sus hallazgos son reales y accionables; su orden de prioridad es defendible. Pero un PMS se gana o se pierde en el front desk, y el informe auditó el alta de reserva con lupa mientras dejaba el Room Rack y el Night Audit sin tocar — precisamente las pantallas con peor manejo de estados de toda la app. El score 62/100 del informe es **demasiado generoso** una vez se mira el corazón operativo: incorporando el Rack y el ciclo diario, la realidad está más cerca de **52-55/100**.

**Calidad del informe (no del producto): 68/100.** Honesto, verificable, bien priorizado en su alcance — penalizado por un alcance que esquivó el flujo más crítico de un PMS y por dos imprecisiones (Cocoa/Check-in, "spinner global").

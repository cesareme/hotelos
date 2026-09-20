# Resumen del fin de semana 18-20 de septiembre de 2026 · ehotelOS

Cronología paso a paso de lo hecho entre el jueves 18 por la tarde y el domingo 20 a las 18:00, con lo que entró en `main`, lo que quedó verificado y lo que sigue en manos del propietario. Detalle de cada tanda en `docs/audits/TANDA-*.md` (30 informes) y bloques de estado en `docs/audits/ESTADO-VERIFICADO.md`.

## 1 · Jueves 18 · base y datos reales

1. **Tanda 8a · RBAC** cerrada tras el incidente CORS (faltaba la cabecera `x-property-id` en el API): plantillas de rol v3, separación de funciones, 28 usuarios de demo de Faranda.
2. **Sage 200**: 76 exportaciones del contable convertidas a 79 CSV canónicos con el personal enmascarado (1.077 títulos de cuenta, 569 comentarios); importador adaptado al formato real. El borrado del conjunto sintético y la carga los ejecuta el propietario (el entorno del orquestador no puede borrar en masa): pasos 0-44 la noche del 18 y 45-54 la mañana del 19.
3. **L2 persistencia y API**, **L3 dinero y fiscal** (cotización desde tarifa, políticas de cancelación, penalizaciones) y estimaciones de cola (130-180 M de tokens) → decisión del propietario: dos carriles en paralelo y topes mensuales al alza.

## 2 · Viernes 19 · operaciones, IA, timeline, OPERA, reputación, manual

4. **L5 operaciones** (estado de habitación unificado, parte de viajeros y SES honestos, Setup Center, cierre nocturno) y **L6a núcleo de IA** (`packages/ai-core`: cliente propio, tool use, salidas estructuradas, visión, PII enmascarada, presupuesto por hotel).
5. **Live Timeline** (petición del propietario: «el timeline de la demo de julio con el nuevo look and feel, primera opción del menú para todos»): tablero por habitación con arrastrar, redimensionar, deshacer y penalización prevista al cancelar; redirección de la ruta antigua.
6. **Fusión L6a + Live Timeline** en main (2613f47); README de GitHub reescrito.
7. **OPERA Cloud**: 10 informes reales de 5 hoteles → 13.347 reservas cargadas en lotes reversibles, inventario alineado (30 tipos, 396 habitaciones), 148 huéspedes en casa; informe con 15 preguntas para recepción y administración.
8. **T8 Reputación** construida en su rama y fusionada con dos extras: ids de auditoría de 16 hex (4 colisiones reales) y apagado ordenado por SIGTERM (el API lo ignoraba).
9. **UX-1 recepción**: diseño medido en clics y luego 13 lotes; walk-in de 13 a 2 clics, reserva telefónica de 9 a 1, medida automatizada con Playwright sobre un tenant de prueba.
10. **DOC-1 manual de uso**: 24 páginas, 65 capturas del hotel de demo, plan de formación, fichas y FAQ; al escribirlo aparece que **todos los cajones laterales estaban ocultos en escritorio** desde el lote del shell (17/09): hotfix inmediato.
11. **Verificación adversarial de la carga Sage**: fiel al céntimo (26 lotes de diario, 19 meses cuadrados, cuadre por hotel, libros de IVA Excel = CSV = BD = API), con hallazgos de producto (cuentas anuales con apertura, régimen de IVA, 303) y de privacidad (2 subcuentas y ~230 textos con nombres invertidos).
12. **FIX-1** (12 lotes): cuentas anuales, régimen de IVA con reclasificación por producto, 303 con compensación, exportación de informes, comparar plantillas, webhooks, asistente, mantenimiento, ficha de personal, terceros importados, herramienta de reenmascarado. Al fusionar se descubre que 58 ficheros `.js` compilados y obsoletos sombreaban las fuentes en el front local.
13. **Optimización del proceso** por petición del propietario: `scripts/gates.sh` (puertas deterministas), `scripts/merge-lane.sh` (fusión de carril), base de datos por carril, CLAUDE.md recortado un 30 %, deduplicación de hallazgos y votación 1/3, plantilla v3 de workflows (2 revisores, modelos baratos en votos y puertas, commit en la rama por el integrador).

## 3 · Sábado 20 (madrugada y día) · cierre de la cola

14. **DOC-2**: guía de recepción completa tras UX-1, fichas y FAQ definitivas, ayuda dentro de la aplicación sincronizada y protegida por contrato.
15. **Reenmascarado PII** ejecutado por el propietario (331 filas, una transacción, auditado).
16. **T9 documentos** (captura, pipeline de IA con fallback, flujo centro→oficina, archivo con retención, almacén cifrado con contrato S3) y **CHK check-in automatizado** (identidad MRZ, firma, pago o garantía con PSP sandbox, asignación asistida, kiosco, WhatsApp simulado, recepcionista IA); 12 conflictos entre ambos resueltos por un agente.
17. Por orden del propietario («todo para el lunes por la mañana»), ocho carriles en paralelo: **CIERRE-1** (huecos de seguridad y restos), **UX-2 dirección**, **L8 integraciones honestas** (18 integraciones con modo none/sandbox/real y `/health`), **ACT activo inmobiliario**, **L6b asistente unificado** (memoria por usuario, catálogo por RBAC, panel en el shell y ⌘K), **UX-3 pisos y mantenimiento**, **L7 portal del huésped** (español, accesible, estancia y salida, encuesta post-estancia) y **RRHH** (plantilla, previsión por ocupación, nómina con aprobación e incidencias, panel de costes de personal sobre los datos reales de Sage).
18. Cada cierre: commit en su rama, fusión en main con resolución de conflictos, migración en la BD viva con copia previa, puertas rápidas, push, reinicio del API. Fusión final de RRHH con 20 conflictos y árbol de navegación regenerado; plantillas de rol v5.

## 4 · Cifras finales (main 729ae16, 20/09 17:40)

| Indicador | Jueves | Domingo |
|---|---|---|
| Migraciones | 17 | 30 (deriva 0) |
| Tests API | 2.433 | 4.176 |
| Tests front | 1.448 | 2.587 |
| Contratos raíz | 540 | 971 |
| Pantallas Cocoa | 226 | 260 |
| Ítems del menú · pestañas · URL | 69 · 100 · 192 | 71 · 113 · 207 |
| Puertas completas | — | 14/14 |

Tokens: unos 270 millones en 23 workflows (190 M el viernes, 78 M el sábado con la plantilla v3). Cuatro cortes por tope o crédito, todos reanudados desde caché.

## 5 · Incidentes y lecciones

- El puerto 3000 lo comparte otro proyecto en IPv6: el API se levanta con `HOST=localhost` (ambos loopbacks).
- Un mensaje a un agente de workflow en curso lo duplica; no volver a hacerlo.
- Dos carriles no deben editar el manual ni los CSV de `pilots/` a la vez; los conflictos se resuelven con la versión más reciente del carril de UX/DOC.
- Editar el script de un workflow entre reanudaciones invalida la caché.
- Los planes de recon se acotan a referencias (un plan literal superó el tope de salida).

## 6 · En manos del propietario

Reclasificación de libros de IVA (comando en `TANDA-CIERRE-1`), reenmascarado de `counterparty_name` (39 filas), activar `reputation_quality` en Faranda, formato del manual (Markdown o PDF), servidor donde enseñarlo, y las credenciales que cada integración declara como pendientes en Configuración › Integraciones (IA, PSP, WhatsApp, correo, Google Business Profile, VeriFactu y SES en preproducción). Datos reales de Faranda solo en la BD local; nada al VPS público.

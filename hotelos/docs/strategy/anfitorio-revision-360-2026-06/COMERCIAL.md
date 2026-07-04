# Anfitorio — Kit comercial (v1, jul 2026)

> Corregido tras la revisión 360º. Regla anti-humo: solo lo que el producto hace de
> verdad; lo sandbox/mock se etiqueta. **Fecha regulatoria verificada (RDL 15/2025).**

## 0) La verdad regulatoria que ancla el discurso
- **SES Hospedajes: OBLIGATORIO Y VIGENTE HOY.** Registro de viajeros + comunicación al
  MIR. Sanciones reales **601–30.000 €**. *Esta es la urgencia vendible.*
- **VeriFactu: aplazado por el RDL 15/2025 →** **1‑1‑2027** (sociedades) y **1‑7‑2027**
  (autónomos). **2026 = voluntario.** *No venderlo como "obligatorio ya".*
- **Factura electrónica B2B (Crea y Crece):** sin fecha firme (~2027‑2028). No es palanca este año.
- **Como fabricante de SIF**, Anfitorio debe su **declaración responsable RD 1007/2023**
  (vigente desde 29‑7‑2025) y un NIF real de productor — requisito previo a vender.

**Mensaje maestro:** *"El PMS español que te quita el marrón de recepción y te deja
certificado para 2027 antes de que sea obligatorio — cumpliendo SES desde el primer día."*

## 1) One‑pager
**El problema.** Un hotel de 20–150 hab malabarea 4 herramientas (PMS + channel +
facturación + hoja de cálculo) y un asesor externo. SES ya sanciona; VeriFactu llega en 2027.

**La propuesta.** Un solo sistema, en español:
1. **Recepción sin fricción** — "Mi día" prioriza llegadas/salidas/avisos; check‑in con
   **escaneo del DNI → la IA rellena el parte SES**, tú revisas y confirmas (*nada se guarda
   sin confirmar*). ~90 s.
2. **Cumplimiento integrado** — parte SES desde donde cobras la habitación; facturación con
   huella VeriFactu lista para 2027; tasa turística por CCAA; TicketBAI foral.
3. **Dirección en una pantalla** — ocupación, ADR, RevPAR, pickup, recomendación de tarifa.

**Honestidad (que te conviene):** channel manager en **modo sombra**; cobros con el **TPV
físico** del hotel; **instancia dedicada**; migración y formación incluidas.

**CTA:** *"Te lo enseño en 20 min con datos de un hotel real. Si a los 3 meses no te ha
quitado trabajo, no pagas."*

## 2) Guion de demo — 20 min (director escéptico)
Hilo: *"Son las 8:00 de un sábado de agosto, entran 12 huéspedes y te faltan manos."*

| Min | Pantalla | Wow |
|---|---|---|
| 0–2 | Login → Mi día | La cola priorizada, no un menú de 200 opciones. Modo oscuro premium. |
| 2–7 | Check‑in + escaneo DNI | IA rellena identidad y **parte SES**; "revisas y confirmas". |
| 7–10 | Room Rack | Asignar/cambiar habitación arrastrando. |
| 10–13 | Facturación | Emitir factura → huella VeriFactu + **272,00 €** formato español. |
| 13–16 | Dashboard Gerencia | Ocupación/ADR/RevPAR/pickup. "Tu café de las 8:00." |
| 16–18 | Cumplimiento | Semáforo SES + tasa turística. "Esto te sanciona HOY." |
| 18–20 | Cierre | Piloto 3 meses, instancia tuya, datos migrados, 99 €/mes. |

**NO enseñar:** channel manager en vivo (modo sombra), pasarela propia, nóminas/turnos
avanzados, rate shopper, ESG.

**8 objeciones → respuesta honesta:** (1) migración incluida + export garantizado · (2)
channel en modo sombra + 1 conector en certificación · (3) SLA por escrito · (4) escrow +
export + instancia tuya · (5) 149/299/499 + €/hab, cumplimiento en base; Fundadores 99 € ·
(6) guías por rol + onboarding · (7) **VeriFactu NO era ya: RDL 15/2025 lo aplazó a 2027** ·
(8) producto real, demo con datos reales, cada claim con file:line.

**Checklist pre‑demo (10):** datos seed sin fechas vencidas · toast de factura limpio ·
selector de propiedad OK · modo oscuro probado · móvil/PWA a mano · escaneo DNI con doc de
prueba · una factura emitida visible · dashboard coherente · semáforo SES verde · nada de
"Aurora/Cocoa/HotelOS" en pantalla.

## 3) Pricing (estructura para aprobar)
| Plan | €/mes | €/hab (>25, tope 120) | Incluye |
|---|---|---|---|
| **Recepción** | 149 | 4 | PMS core + **SES + facturación VeriFactu** (cumplimiento SIEMPRE aquí) |
| **Operación** | 299 | 6 | + revenue + channel (sombra) + operaciones (HK/mant/turnos) |
| **Grupo** | 499 | 8 | + ERP (contabilidad, banca CSB‑43/SEPA) + multi‑propiedad + IA avanzada |

- **Programa Fundadores (10 plazas): 99 €/mes** con contraprestaciones firmadas. Migración+formación gratis.
- **Ancla:** "una licencia en vez de cuatro + el asesor". **No** anclar en multa VeriFactu (no aplica 2026).
- Publicar la calculadora cuando exista el billing — publicar precio ya es posicionamiento.

## 4) Go‑to‑market (fundador solo, desde Galicia)
1. **Gestorías como canal nº1** — deciden el SIF de sus 10–30 alojamientos. **20 % comisión
   recurrente** + panel multi‑cliente en roadmap. Cerrar 3–4 despachos.
2. **Masterclass "SES hoy + VeriFactu 2027"** con HOSPECO + Asociación Provincial de Hostelería de A Coruña.
3. **Walk‑ins** en A Coruña y Santiago.
4. **Campaña "segunda opinión antes de renovar con Septeo"** (Tesipro/ACIGrup/Witbooking).
5. **Objetivo:** 3–5 pilotos "Fundador" en sep–oct (no 10; límite de una persona).

## 5) Decisiones de César (previas a vender)
1. Firmar declaración responsable RD 1007/2023 + NIF real en `VERIFACTU_SOFTWARE_NIF`.
2. Aprobar pricing (149/299/499 + €/hab + Fundadores 99 €).
3. Registrar `anfitorio.com`/`.es` + `demo.anfitorio.es`.
4. `NODE_ENV=production` en el VPS (activa los fail‑closed de seguridad).

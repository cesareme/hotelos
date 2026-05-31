# HotelOS — guion para demo Loom (≈10 min)

Audiencia: socio/inversor con conocimiento del sector hotelero. Idioma: español.
Objetivo: enseñar que **HotelOS es un PMS+ERP nativo de IA**, real (no maqueta) y construido para el mercado español.

**Antes de grabar:**
1. Asegúrate de que la app está en `http://localhost:5173/backoffice/reception`.
2. Propiedad activa: **HotelOS Madrid Centro** (prop_123).
3. Perfil: **Recepción**.
4. Tema: oscuro (el botón sol/luna del topbar).
5. Cierra cualquier banner de onboarding ("Empezar recorrido" → "Ahora no").
6. Abre Loom, captura toda la pestaña del navegador.

---

## Escena 1 · La portada (45 s)
**Pantalla:** `/backoffice/reception` — "Mi día (recepción)".

**Qué señalar:**
- "Lo primero que ve la recepcionista al entrar: su día. **14 llegadas, 14 salidas, 20 huéspedes en hotel, 14 reservas sin habitación asignada, 584 € pendientes de cobro**."
- "Estos números son reales: vienen de la base de datos. Hay 1888 reservas sembradas y 47 habitaciones."
- "Cada llegada lleva al lado un botón de **Hacer check-in** y otro **Ver folio**. Cero clicks intermedios."

> **Punch line:** *"No es un dashboard de marketing. Es la portada de trabajo."*

---

## Escena 2 · Búsqueda global (cmd+K) — 45 s
**Acción:** pulsa **⌘K** (o el icono de búsqueda del topbar).

**Qué teclear y mostrar:**
1. Escribe **`Petrova`** → aparecen 7 reservas confirmadas de Nina Petrova de distintos canales (booking.com, expedia, direct, web, wholesaler).
2. Borra y escribe **`103`** → aparecen reservas que contienen "103" + la fila "**Habitación 103 inspected**" bajo otra sección.
3. Borra y escribe **`Globex`** (empresa) → 8 reservas con el nombre de empresa.

**Qué decir:**
- "Esta búsqueda **indexa en vivo** reservas, huéspedes, habitaciones, folios, facturas, propiedades y tarifas. Un solo cuadro para todo el sistema. Latencia: **3-10 ms**."

> **Punch line:** *"Un PMS clásico te obliga a navegar por menús anidados. Aquí encuentras cualquier cosa en dos segundos."*

---

## Escena 3 · Live Timeline (1 min 30 s)
**Acción:** click en **Live Timeline** (sidebar) o link directo `/backoffice/timeline`.

**Qué mostrar:**
1. Vista semanal con bloques de reservas pintadas sobre las 47 habitaciones.
2. Filtros por estado: **Confirmada · En casa · No-show · Cancelada · Salida**.
3. Filtros por canal: **expedia · booking.com · direct · web · wholesaler · email**.
4. Pasa el ratón sobre un bloque → aparece la **ficha rápida** del huésped, fechas, importe.
5. **Arrastra** un bloque a otra habitación → confirmación antes de mover la reserva.

**Qué decir:**
- "Esta es la pantalla central de operaciones. Mismo concepto que el rack de Opera o Mews, pero arrastrar y soltar, filtros instantáneos y tooltips con la información esencial."
- "Si arrastras una reserva, te pide confirmación porque puede cambiar la factura y comunicación al huésped — el sistema sabe lo que es destructivo."

---

## Escena 4 · Detalle de reserva (1 min)
**Acción:** click sobre una reserva en Live Timeline (idealmente `RVNX-00011` o cualquier "Globex Co").

**Qué mostrar:**
- Cabecera con código, fechas, canal.
- Pestañas o tarjetas: **Identidad (SES Hospedajes), Pago, Habitación, Check-in, Estancia, Check-out & factura**.
- Cada paso tiene un semáforo (✓ hecho / ! bloqueado / ○ pendiente) y "Next best action".

**Qué decir:**
- "Cada reserva es un **viaje real**. El sistema sabe en qué paso está, qué bloquea avanzar y cuál es la siguiente acción. No es un timeline cosmético: lo usa la recepcionista para resolver problemas."
- "Si falta el documento de identidad para el **parte de viajeros (SES Hospedajes)**, sale en rojo. Si no hay pago, sale en rojo. La recepcionista no necesita pensar — el sistema le marca qué hacer."

---

## Escena 5 · Folios divididos (1 min) — *diferenciador*
**Acción:** sidebar → **Finanzas y fiscal → Folios y enrutamiento**.

**Qué mostrar:**
1. Pega un ID de reserva (ya hay uno cargado con datos: `cmpl4k5hq00x0fyf1y4trooaq`).
2. **Folios de la reserva:** ves dos folios — `guest` (principal) y `company` (secundario).
3. **Reglas de enrutamiento:** "minibar → company, prioridad 0, activa".
4. **Cargos por folio:** grid con las líneas. Cada línea tiene botón **Transferir**.

**Qué decir:**
- "Esto es **split folios**. Estándar en cadenas grandes — Opera, Cloudbeds, Mews lo tienen — pero ausente en la mayoría de PMS españoles."
- "Permite separar el cargo del huésped (room) del cargo a la empresa (minibar, F&B). Las reglas son **declarativas**: 'todo el minibar va al folio company' y se aplica automáticamente al postear cualquier cargo nuevo."
- "Más manual: el botón **Transferir** mueve una línea concreta a otro folio. Auditado."

> **Punch line:** *"Sin esto, no puedes vender a corporate. Con esto, sí."*

---

## Escena 6 · Tableros operativos (1 min 30 s)

### 6a) Pisos (Housekeeping)
**Acción:** sidebar → **Tableros operativos → Tablero de pisos**.

**Qué mostrar:**
- Grid de habitaciones con estados de color (limpia, sucia, en inspección, OoO).
- Click en habitación → panel lateral con: huésped actual, tarea pendiente, foto del último estado, asignar a camarista.

### 6b) Mantenimiento
**Acción:** sidebar → **Tablero de mantenimiento**.

**Qué mostrar:**
- Órdenes de trabajo activas, prioridad, técnico asignado.
- Botón "Bloquear habitación" → la habitación deja de ser vendible en availability.

### 6c) Personal y turnos
**Acción:** sidebar → **Personal y turnos**.

**Qué mostrar:**
- Turnos del día, fichajes, ausencias, vacaciones pendientes.

**Qué decir general:**
- "Tres tableros conectados entre sí: si Pisos crea una tarea, Mantenimiento la ve. Si Personal marca una baja, el responsable de Pisos lo sabe."

---

## Escena 7 · Revenue Management (1 min)
**Acción:** sidebar → **Comercial → Inicio de revenue**.

**Qué mostrar:**
- KPIs: ocupación, ADR, RevPAR.
- Pace & pickup vs año anterior.
- "Histórico y previsión" → ves la curva real y la previsión a 90 días.
- "Rate shopper" → tarifas de competencia (real, no demo).

**Qué decir:**
- "Revenue management de verdad: pace/pickup reales, forecast con MAPE, recomendaciones BAR (mejor tarifa disponible), comparador de competencia. Esto sustituye a IDeaS o Duetto para hoteles pequeños y medianos."

---

## Escena 8 · Cumplimiento español (1 min) — *diferenciador*
**Acción:** sidebar → **Centro de cumplimiento**.

**Qué mostrar:**
1. **Dashboard** con semáforo de ~70 controles por área (PMS, RGPD, fiscal, contra incendios, alimentación…).
2. **Matriz** filtrable por comunidad autónoma y tipo de hotel.
3. **Documentos**: vault con fechas de caducidad y alertas automáticas.
4. **Modelos AEAT**: 303, 111, 115, 180, 390 listos para presentar.

**Qué decir:**
- "España es el mercado más regulado de Europa: SES Hospedajes, parte de viajeros, RGPD, VeriFactu, modelos AEAT, normativa por CCAA. Lo tenemos resuelto."
- "Esto es el principal foso defensivo frente a Cloudbeds o Mews: ellos te lo dejan a un partner local; nosotros lo metemos en el core."

---

## Escena 9 · IA aplicada (1 min 30 s) — *diferenciador*

### 9a) Cola de revisión humana (HITL)
**Acción:** sidebar → **OPERACIONES DE IA → Cola de revisión humana**.

**Qué mostrar:**
- Lista de borradores generados por IA (respuestas al huésped, reservas extraídas de email, OCR de documentos).
- Cada uno con score de confianza, el modelo usado y el promtp.

### 9b) Pipeline status
**Acción:** sidebar → **Estado de la IA**.

**Qué mostrar:**
- Telemetría: llamadas al modelo, latencia P50/P95, coste, % success.

### 9c) Correo → reservas
**Acción:** sidebar → **Correo → reservas (IA)**.

**Qué mostrar:**
- Conectores OAuth a Gmail/Outlook (cifrados).
- Email entrante → parsing → propuesta de reserva → human review.

**Qué decir:**
- "**IA donde aporta valor: extraer datos de un email de reserva, generar la primera respuesta al huésped, OCR de un DNI.** Pero todo pasa por **Human-in-the-Loop**: la recepcionista aprueba o corrige."
- "Cero alucinaciones en producción: si el modelo no tiene confianza, marca para revisión. Si falla el proveedor, hay fallback determinista."

> **Punch line:** *"AI-native, no AI-washing. Cada llamada al modelo es auditable y tiene fallback."*

---

## Escena 10 · Channel Manager + multi-propiedad (45 s)
**Acción:** sidebar → **Channel Manager (agregador OTA)**.

**Qué mostrar:**
- Estado de sincronización por canal: Booking.com, Expedia, Airbnb, Hotelbeds, Vrbo.
- Mappings por habitación y tarifa.
- Salud de cada canal en tiempo real.

**Acción:** topbar → selector de propiedad → cambia a **"Hotel Los Tilos"**.

**Qué decir:**
- "Funciona como agregador propio: empujamos disponibilidad y precios a las OTAs, recibimos reservas e identificación de huéspedes."
- "Y todo es **multi-propiedad** desde el día cero. Una organización puede tener N hoteles, dashboards consolidados, RBAC granular."

---

## Cierre · Resumen y siguientes pasos (45 s)
**Acción:** vuelve al **Mi día (recepción)**.

**Qué decir:**
- "Resumen: **PMS + Channel Manager + Revenue + ERP financiero + Compliance español + capa de IA**, todo en una sola plataforma, mobile-first, dark/light mode."
- "Stack real, no maqueta: 1888 reservas en demo, API Fastify + Postgres con Prisma, frontend React 19. **CI verde**, typecheck a cero."
- "**Estado:** producto en estado funcional. Lo siguiente es **piloto con un hotel real** para validar el flujo end-to-end y cerrar feedback."

> **Punch line de cierre:** *"Hablamos de quiénes podrían ser los primeros tres hoteles del piloto."*

---

## Notas para grabación

- **Velocidad:** habla rápido pero sin atropellar — son ~10 min con ritmo de demo de producto, no de tutorial.
- **No leas literal:** internaliza las "punch lines" y suelta el resto.
- **Si algo no carga:** sigue. Es local, suele ir rápido pero el socio entenderá la velocidad de red.
- **Audio:** auriculares con micrófono. Habla a 30 cm. Ambiente sin eco.
- **Resolución:** 1440×900 o 1920×1080 → suficiente para Loom HD.
- **Después:** descarga el MP4, comparte el link de Loom + adjunta el `one-pager.pdf` (en este mismo folder).

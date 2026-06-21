# MARKET RESEARCH — Apaleo + Stayntouch

**Fecha:** 2026-06-21 · **Contexto:** Benchmark competitivo para HotelOS (PMS+ERP nativo español, IA + compliance ES profundo)

---

## 1. Perfiles

### Apaleo — el PMS "API-first / headless"
PMS cloud nacido en Múnich (2017) con una tesis radical: el PMS no es una aplicación, es una **plataforma**. Apaleo expone toda su funcionalidad vía API REST pública desde el día uno (no hay "API premium" detrás de un muro), y construye su negocio alrededor de un **App Store / marketplace** donde terceros integran channel managers, kioscos, revenue management, upselling, etc. La UI propia es deliberadamente delgada: Apaleo asume que muchos clientes construirán su propio front o ensamblarán best-of-breed.

- **Modelo:** plataforma + ecosistema. Cobra por unidad/habitación y monetiza el marketplace.
- **Cliente objetivo:** cadenas tech-forward, marcas lifestyle, serviced apartments, hostels, operadores multi-propiedad que quieren control técnico y huir del lock-in monolítico (legacy tipo Opera/Protel).
- **Geografía/fuerza:** DACH y Europa, fuerte en grupos que tienen equipo de producto/IT propio.

### Stayntouch — el PMS "mobile-first / guest-centric"
PMS cloud estadounidense centrado en la **experiencia**: del huésped (check-in/out móvil sin colas, llave digital, registro desde el teléfono) y del staff (la recepción opera desde un iPad/tablet, no anclada a un mostrador). Su producto estrella histórico fue el **check-in contactless**, que ganó enorme tracción post-COVID. UX moderna, limpia, pensada para que un recepcionista nuevo sea productivo en horas, no semanas.

- **Modelo:** PMS SaaS con foco en módulos de guest journey (Stayntouch PMS + Guest Mobility / kiosk).
- **Cliente objetivo:** hoteles independientes upscale, lifestyle/boutique, grupos medianos en EE.UU. que compiten por experiencia, y propiedades que sustituyen legacy con prioridad en UX y movilidad.
- **Geografía/fuerza:** Norteamérica principalmente, expansión EMEA.

---

## 2. El movimiento composable / headless hospitality

El sector vive el mismo desacople que vivió el e-commerce con MACH (Microservices, API-first, Cloud, Headless). La tesis: en lugar de un **monolito** que hace todo regular, el hotel ensambla **best-of-breed** — PMS como "system of record", y encima channel manager, RMS, CRM/CRO, pagos, upselling, BI — todos hablando por API en tiempo real. Apaleo es el abanderado puro de esta corriente; Stayntouch la abraza parcialmente (API abierta + foco en una capa de experiencia). Para el comprador hotelero esto promete: menos lock-in, despliegues más rápidos, innovación delegada al ecosistema. El riesgo: complejidad de integración, "quién es responsable cuando algo falla", y coste de orquestar muchos proveedores. **Aquí está el hueco de HotelOS:** ofrecer la apertura de lo composable SIN obligar al cliente español/mediano a convertirse en integrador, y resolviendo nativamente lo que el ecosistema anglosajón ignora (compliance ES) y lo que los monolitos no tienen (ERP + IA).

---

## 3. Tres virtudes diferenciales (y qué debe aprender HotelOS)

### Virtud 1 — API pública total y "no muros" (Apaleo)
Toda la funcionalidad es accesible por API documentada, con sandbox, OAuth y webhooks de eventos. Esto convierte al PMS en plataforma y atrae integradores.

**→ Lección para HotelOS:** Diseñar la API como **producto de primera clase, no como anexo**. Concretamente: (a) toda operación de la UI debe existir como endpoint público documentado (paridad UI↔API); (b) sandbox gratuito + OAuth2 + **webhooks de eventos** (reserva creada, check-in, factura emitida) para que partners reaccionen en tiempo real; (c) versionado semántico y changelog. Diferenciador propio: exponer también endpoints de **compliance ES** (envío Hospedajes/SES, emisión Veri\*factu/TicketBAI) como API — algo que ningún rival anglosajón tiene.

### Virtud 2 — App Store / marketplace como motor de ecosistema (Apaleo)
El marketplace transfiere el coste de innovación al ecosistema y crea efecto red: cada integración nueva hace el PMS más valioso sin que Apaleo escriba el código.

**→ Lección para HotelOS:** Lanzar un **marketplace curado de integraciones España-first**. Concretamente: catálogo con TPV españoles (Redsys), channel managers, firma biométrica, contabilidad/asesorías (export a software del gestor: A3, Sage, Holded), y conectores con la AEAT/Haciendas forales. No hace falta abrir todo el ecosistema mundial el día uno; basta con **certificar 10–15 integraciones que un hotel español realmente necesita** y cobrar revenue-share. El sello "Certified for HotelOS" reduce el miedo a "best-of-breed roto".

### Virtud 3 — UX mobile-first y time-to-productive bajísimo (Stayntouch)
Check-in/out móvil, recepción en tablet, llave digital, y una interfaz que un empleado nuevo domina en horas. En un sector con rotación de personal altísima, esto es ROI directo (menos formación, menos colas, mejor reseña).

**→ Lección para HotelOS:** Tratar la **UX y la movilidad como ventaja competitiva, no como capa cosmética**. Concretamente: (a) flujo de **check-in móvil que capture el dato del pasaporte/DNI y lo empuje automáticamente al parte de viajeros SES.Hospedajes** — convertir una obligación legal española en una experiencia fluida es un diferenciador que Stayntouch no puede replicar sin entender la norma ES; (b) recepción operable desde tablet; (c) objetivo medible: recepcionista productivo en < 1 jornada. La IA de HotelOS puede además **pre-rellenar y validar** datos de registro, reduciendo errores de compliance.

---

## 4. Dos debilidades (el hueco que HotelOS explota)

### Debilidad 1 — Lo composable transfiere complejidad al hotelero
Apaleo brilla con clientes que tienen equipo de IT/producto. El hotel independiente o el grupo mediano **sin departamento técnico** se ahoga: necesita integrador, ensamblar 6 proveedores, y asumir el "no man's land" de soporte cuando dos sistemas no se entienden. El TCO real (integración + mantenimiento) suele estar oculto.

**→ Oportunidad HotelOS:** Vender **"lo abierto pero llave en mano"** — PMS+ERP nativo integrado (cero integración para el core financiero-operativo) + marketplace para lo accesorio. Un único responsable de soporte para el 80% del stack.

### Debilidad 2 — Cero profundidad en compliance y fiscalidad locales (ES)
Ambos son productos anglosajones. No tienen nativo: parte de viajeros **SES.Hospedajes**, registro de viajeros, **Veri\*factu / TicketBAI / SII**, IVA español y sus tipos, ni ERP/contabilidad española. Lo resuelven (mal) vía integraciones de terceros que el hotel paga y mantiene aparte.

**→ Oportunidad HotelOS:** Esto es el **foso defensivo**. Compliance ES profundo + ERP nativo no es una feature, es una barrera de entrada: ningún competidor global la cruza sin reescribir producto y asumir riesgo regulatorio que no conoce.

---

## 5. Tres lecciones accionables — TOP para HotelOS

1. **API + webhooks como producto de primera clase, con paridad UI↔API y endpoints de compliance ES expuestos.** Adoptar la apertura de Apaleo, pero monetizando lo que nadie más puede ofrecer por API: envío automatizado a SES.Hospedajes y emisión Veri\*factu/TicketBAI.

2. **Marketplace curado "España-first" (10–15 integraciones certificadas, revenue-share).** Captar el efecto-red del App Store de Apaleo sin obligar al hotelero a ser integrador: TPV Redsys, asesorías (A3/Sage/Holded), channel managers, firma biométrica — con sello "Certified for HotelOS".

3. **Check-in móvil que convierte la obligación legal ES en UX premium.** Robar el mobile-first de Stayntouch y fusionarlo con el compliance: el huésped escanea su DNI/pasaporte desde el móvil, la IA valida y pre-rellena, y el dato fluye solo al parte de viajeros. Diferenciador imposible de copiar sin dominar la norma española.

**Posicionamiento síntesis:** HotelOS = *la apertura de lo composable + la UX de lo mobile-first, pero llave en mano y con compliance/ERP español nativo como foso.* Ataca por debajo a los monolitos legacy (Opera/Protel) y por el flanco local a Apaleo/Stayntouch, que nunca priorizarán el mercado español.

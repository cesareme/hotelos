# HotelOS

**PMS + ERP nativo de IA para el mercado hotelero español.**
Una plataforma única que sustituye 4–6 herramientas y resuelve el cumplimiento normativo español dentro del core.

---

## El problema

Los hoteles independientes españoles (3-150 habitaciones) viven con un PMS legacy (Avalon, FideloHotel) + Channel Manager (SiteMinder) + Revenue Management (RoomPriceGenie) + ERP financiero (A3, Sage) + capa de cumplimiento (SES Hospedajes / parte de viajeros) **manualmente conectados**. El staff pierde 4-6 h al día en tareas repetitivas que ya hace la IA.

Las opciones modernas (Cloudbeds, Mews, Apaleo) son anglosajonas: cumplimiento español inexistente o vía partners, sin VeriFactu integrado, sin parte de viajeros nativo, sin modelos AEAT.

---

## La solución

**Una sola plataforma multi-propiedad** con:

| Módulo | Qué hace | Reemplaza a |
|---|---|---|
| **PMS** | Reservas, folios divididos, check-in/out, asignación de habitación, parte de viajeros, multi-folio | Opera, Mews, FideloHotel |
| **Channel Manager** | Sincroniza tarifas/disponibilidad con Booking, Expedia, Airbnb, Hotelbeds, Vrbo | SiteMinder, RateGain |
| **Revenue** | Pace/pickup reales, forecast por segmento, BAR recommendations, rate shopper, presupuesto | IDeaS, Duetto, RoomPriceGenie |
| **Operaciones** | Pisos, mantenimiento, personal, seguridad, TPV, F&B inventory, allotments TT.OO. | Quore, hotelkit, Cobblestone |
| **Finanzas** | Facturación VeriFactu, conciliación bancaria, balance, P&L, cash flow, modelos AEAT (303/111/115/180/390) | A3, Sage |
| **Compliance** | ~70 controles por CCAA, vault documental, alertas de caducidad, dossier de inspección | Consultoría externa |
| **IA aplicada** | OCR de DNI, parsing de emails de reserva, draft de respuestas al huésped, asistente compliance, todo HITL | n/a (categoría nueva) |

---

## Diferenciadores frente a Cloudbeds / Mews

1. **Cumplimiento español en el core** — SES Hospedajes, parte de viajeros XAdES, modelos AEAT, normativa por comunidad autónoma. No es un add-on.
2. **AI-native con Human-in-the-Loop** — cada salida del modelo pasa por revisión humana opcional, con score de confianza y fallback determinista. Cero alucinaciones en producción.
3. **Folios divididos reales** — split entre huésped/empresa/agencia con reglas declarativas. Imprescindible para vender a corporate.
4. **Mobile-first** — pensado para recepción con tablet/móvil, dark mode, responsive desde el día cero.
5. **API-first** — Fastify + Prisma, todos los datos son consultables vía API, todos los eventos están audited.

---

## Tecnología

- **Frontend:** React 19 + Vite + TypeScript.
- **API:** Fastify + Prisma + Postgres 16.
- **IA:** providers configurables (Anthropic, OpenAI, Azure) con fallback determinista por defecto.
- **Compliance:** XAdES para parte de viajeros, hash chain VeriFactu, cifrado de PII a nivel columna.
- **Despliegue:** monorepo pnpm. CI verde (build + typecheck en 4 jobs).

---

## Estado actual

- ✅ Producto funcional end-to-end: 1888 reservas en demo, 47 habitaciones, 4 propiedades sembradas.
- ✅ Búsqueda global cross-entity (reservas, huéspedes, habitaciones, folios, facturas, propiedades, tarifas) en 3-10 ms.
- ✅ 30+ pantallas operativas en español, dark/light mode, mobile-first.
- ✅ Integraciones reales con Anthropic + OpenAI (con fallback) + IMAP/Gmail OAuth.
- 🟡 **Siguiente paso:** piloto con 1-3 hoteles reales para validar onboarding y flujo end-to-end de un mes completo.

---

## El equipo

- **Producto/Ingeniería:** Carlos Fernández (founder).
- Buscamos: capital seed o socio operativo del sector hotelero español.

---

## Próximos pasos

1. **Demo en vivo** con el equipo del socio (60 min, screen share).
2. **Acceso al entorno de pruebas** para que el socio explore solo.
3. **Diseño conjunto del piloto**: 1-3 hoteles del entorno del socio, 90 días, sin coste de licencia.

📧 **Contacto:** [tu email] · 📞 [tu teléfono] · 🌐 [tu URL] · 🇪🇸 Madrid

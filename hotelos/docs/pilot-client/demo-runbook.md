> Runbook operacional para el día del demo. Material confidencial, no entregar al cliente.

# Demo Runbook · día de la presentación

## 0 · Pre-demo (24-48 h antes)

### Provisión del entorno

- [ ] VPS Hetzner CX22 EU provisionado siguiendo `docs/deploy-pilot.md` § Camino C
- [ ] Dominio configurado: `app.tudominio.com` (admin-web) y `api.tudominio.com` (API)
- [ ] HTTPS funcionando vía Caddy
- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` real (32+ bytes random)
- [ ] `BOOTSTRAP_TOKEN` generado con `openssl rand -hex 32`
- [ ] Bootstrap ejecutado con datos REALES del cliente (`POST /onboarding/bootstrap`)
- [ ] Después del bootstrap: `BOOTSTRAP_TOKEN` borrado del `.env`
- [ ] Backups configurados según `docs/deploy-pilot.md` § C.4 + test cycle ejecutado al menos 1 vez
- [ ] `/compliance/health` responde con `overall: "sandbox_only"` (esperado)
- [ ] `/health` responde 200 con todos los checks ok
- [ ] `/metrics` responde 200 con counters
- [ ] Sentry DSN configurado y un error de prueba registrado para verificar pipeline

### Datos para el demo

- [ ] Seed cadena Iberia ejecutado (`./scripts/deploy-pilot.sh seed-iberia`) si se quiere ambient data. SI el cliente espera ver SU hotel, NO sembrar — usar bootstrap clean.
- [ ] Property del cliente creada con sus datos reales (nombre, NIF/CIF, dirección, número aproximado de habitaciones)
- [ ] Usuario admin del cliente creado con su email real
- [ ] 5-10 habitaciones de ejemplo creadas vía Property Setup Wizard
- [ ] 3-5 tipos de habitación
- [ ] 1-2 planes tarifarios
- [ ] 3-5 reservas demo creadas (1 llegando hoy, 1 saliendo hoy, 1 in-house, 1 sin asignar)

### Smoke test propio (60 min antes)

Recorre estos flujos tú mismo:

- [ ] Login con el usuario admin del cliente. Funciona.
- [ ] FrontDeskDashboard carga sin errores en consola del navegador
- [ ] Click "Hacer check-in" en una reserva → drawer abre → completar → toast OK
- [ ] Click "Hacer check-out" en una reserva in-house → drawer abre → completar → toast OK
- [ ] Sidebar → "Crear reserva" → fechas hoy/mañana por defecto → 2 adultos → "Cotizar disponibilidad" → "Crear reserva" → folio se abre
- [ ] Sidebar → "Centro de cumplimiento" → ver semáforo
- [ ] Sidebar → "Centro de configuración" → "Asistente de configuración del hotel" → muestra el wizard
- [ ] Sidebar → "Mapeador de propiedad" → muestra el onboarding con AI (si SUBES un PDF de ejemplo, debería procesarlo en sandbox)
- [ ] Cambiar a modo oscuro y verificar que todo se ve bien
- [ ] Abrir en iPhone (o Chrome DevTools modo móvil 375px) y verificar que Housekeeping/Maintenance mobile funcionan

### Material físico/digital

- [ ] Deck slides (5-7 slides) preparado en PDF
- [ ] Welcome pack del cliente impreso o en PDF
- [ ] DPA + SLA listos para firmar (templates en `docs/pilot-client/`)
- [ ] One-pager comercial con pricing
- [ ] Tarjetas de visita
- [ ] Adaptador HDMI/USB-C según la sala del cliente

### Tecnología propia

- [ ] Portátil con batería 100% + cargador
- [ ] Hotspot móvil como backup si el WiFi del hotel falla
- [ ] iPhone con bookmarks a las 5 pantallas mobile-ready
- [ ] Chrome en modo incógnito para evitar sesiones cacheadas
- [ ] Sentry abierto en otra pestaña para diagnosticar si algo falla en vivo

---

## 1 · Guion del demo (20-25 min)

### Apertura (3 min)

> "Gracias por recibirnos. Sé que tu día está lleno, así que voy a ser concreto. Te voy a enseñar cómo HotelOS resuelve los 5 dolores más comunes de un hotel español de tu tamaño: el papeleo de cumplimiento, el check-in lento, la dispersión de datos entre PMS/contabilidad/canales, la imposibilidad de tomar decisiones en tiempo real, y el coste de tener herramientas separadas para cada cosa. Vamos a verlo, no a contártelo."

### Bloque 1 · Cumplimiento ES nativo (5 min) — DIFERENCIADOR

**Pantalla**: `Centro de Cumplimiento` → ver semáforo VeriFactu/SES/TBAI/IGIC + plantillas por CCAA

> "Esto es lo único de su clase en el mercado. Cuando AEAT activa VeriFactu obligatorio o cuando el Ministerio del Interior te exige el parte SES en 24 horas, no tienes que comprar un add-on, contratar un integrador o cambiar de PMS. Está dentro. Y se mantiene actualizado con la normativa española según cambia."

**Pantalla**: `Centro Fiscal` → ver submissions de prueba con CSV codes

> "Cada factura emitida se envía a AEAT automáticamente. Recibes el CSV de vuelta en segundos. Si una falla, hay reintento automático en 24 h y alerta antes de que se incumpla el plazo legal."

**Si pregunta**: "¿Y si tengo hoteles en País Vasco?" → muestra `TicketBAI` multi-jurisdicción (Bizkaia/Gipuzkoa/Álava).

### Bloque 2 · El "Mi día de Recepción" en una pantalla (4 min)

**Pantalla**: `Front Desk Cockpit / FrontDeskDashboard`

> "Tu recepcionista entra aquí cada mañana. Saludo en español, hora local, las 4 columnas que importan: quién llega hoy, quién se va, quién está dentro, quién está pendiente de asignación. Cada fila tiene UN clic para el check-in. Ese clic abre este drawer..."

**Demo en vivo**: click "Hacer check-in" → drawer abre → mostrar el OCR de DNI (incluso si es sandbox, demostrar que el botón existe) → confirmar → toast → check-in completado en 90 segundos

> "Comparado con Opera o Mews, son 4-5 clics menos por huésped. Si haces 30 check-ins al día, son 20 minutos de tu recepcionista cada día."

### Bloque 3 · La IA real, no la del marketing (4 min)

**Pantalla**: `Onboarding Interactivo` → subir un PDF de ejemplo del hotel (planimetría o lista de habitaciones en Excel/PDF)

> "Aquí te enseño algo que ningún PMS español tiene. Tu equipo me da el documento que ya usáis para describir el hotel — sea un Excel, una memoria, un plano — y la IA propone la estructura. Tipos de habitación, número de habitaciones, planes tarifarios, mapeo a canales. Tú revisas y apruebas. El sistema queda configurado en una hora, no en una semana."

Si el PDF no se procesa en sandbox, explicar: "En tu piloto esta integración con OpenAI/Anthropic está activa con tu API key. Hoy te lo enseño en modo demostración."

### Bloque 4 · ERP nativo, no exportar a la asesoría (3 min)

**Pantalla**: `Reporting Center` → P&L, Balance, asientos

> "Mews, Cloudbeds, Opera... todos te obligan a exportar tus datos al ERP de tu asesoría. Cierre mensual de 3 días. Aquí los asientos contables (PGC español, plan general) se generan automáticamente con cada factura, cada nómina, cada comisión OTA. Si tu asesoría usa A3 o ContaPlus, te lo exportamos. Si quieres manejarlo tú, lo ves vivo."

**Pantalla**: `Banking España` → CSB-43 + SEPA Norma 19

> "Subes el extracto de tu banco (Santander, BBVA, Sabadell). Concilia solo. La remesa SEPA Norma 19 para cobrar la facturación a tour-operadores se genera en 2 clics."

### Bloque 5 · Lo que tendrás en mobile (2 min)

**Demo en iPhone**: HousekeepingMobile + MaintenanceMobile

> "Esto reemplaza el WhatsApp del grupo de gobernanta. La gobernanta ve sus habitaciones priorizadas. Marca limpio/sucio con un dedo. El sistema actualiza el room rack en tiempo real. Mantenimiento idéntico. ¿Tu camarera ahora cómo te dice que la habitación está lista?"

### Bloque 6 · Cierre + pricing (3 min)

> "Para resumir: PMS + ERP + Compliance ES nativo + AI funcional + Channel Manager (Booking productivo, resto Q3 2026) + Banking. En una sola plataforma. Sin exportar, sin re-introducir datos.
> 
> Precio Founding Customer: 4€ por habitación al mes durante el primer año. Tu hotel a 80 habitaciones serían 320€/mes. Compáralo con Mews (8-15€/hab/mes), Cloudbeds (10-20€), Opera Cloud (negociado, mínimo 1.000€/mes). 
> 
> A cambio: testimonial firmado al final del piloto + caso de uso público + derecho a usar tu logo en nuestra web. 
> 
> Setup: gratuito (lo hacemos nosotros en una semana). Formación: 4h del equipo, gratuita. 
> 
> Empezamos con un piloto de 3 meses sin compromiso de continuidad. Si al final no estás convencido, te exportamos todos tus datos en formato abierto y aquí no ha pasado nada."

---

## 2 · Respuestas a objeciones esperadas

### "¿Cobráis con tarjeta?"

> "Hoy gestionamos los cargos al folio del huésped. La pasarela Redsys + Stripe llega en Q3 con la prioridad #1 que nos dé tu feedback. Mientras tanto puedes integrar tu TPV físico habitual y nosotros llevamos la contabilidad. Si te urge desde día uno, podemos acelerar Redsys a Q2 si firmas piloto antes de marzo."

### "¿Las cerraduras se abren con esto?"

> "El sistema genera la mobile key como pase QR/NFC firmado que funciona con cualquier cerradura compatible con el estándar offline (la mayoría modernas). Para integración nativa con Salto KS, Assa Abloy Vingcard o TESA SmartAir, llega en Q3-Q4. Si tu hotel usa una de estas, lo añadimos al sprint con tu nombre."

### "¿Está conectado a Booking?"

> "Booking funciona en producción real con XML push/pull. Es nuestro canal lead. Expedia, Airbnb, Hotelbeds y VRBO los lanzamos en Q3 con tu feedback sobre qué porcentaje de tu negocio viene por cada uno."

### "¿VeriFactu funciona ya?"

> "El motor sí. Para el envío real a AEAT necesitas un certificado FNMT de persona jurídica que tienes que obtener tú (te ayudamos con el proceso, son 2 semanas). Hasta entonces el piloto vive en sandbox donde se generan las facturas válidas y se firma todo, pero el envío queda en cola. Cuando tengas el certificado lo conectamos en una hora y empieza a enviar real."

### "¿Y mi gestoría/asesoría?"

> "Sigue trabajando con tu asesoría. Nosotros te damos los asientos y los modelos generados automáticamente. Tu gestor recibe los datos en SIE, AEB o CSV — el formato que ya usa. La asesoría no compite con HotelOS; HotelOS le da el material ya digerido."

### "¿Y si quiero exportar mis datos?"

> "En cualquier momento, con un clic. Export completo en JSON o CSV. Es contractual: en el DPA está la cláusula. No te quedas atrapado."

### "¿Está GDPR-compliant?"

> "Sí. PII encriptada con AES-256, backups cifrados en Backblaze EU, audit trail inmutable, soft-delete para retención de 4-6 años, derecho de portabilidad, derecho al olvido implementado. El DPA está listo para firmar — te lo paso al final de la reunión."

### "¿Quién más lo usa?"

> Decide tu respuesta según realidad. Si ya tienes otros pilotos: "Estamos en fase Founding Customer. Eres uno de los primeros 5 hoteles. Por eso el precio." Si no: honestidad — "Estamos lanzando el piloto. Eres uno de los primeros hoteles en darlo cara. A cambio: precio fijo de por vida + atención directa del equipo."

### "¿Y si el equipo no quiere cambiar?"

> "Lo respetamos. El piloto incluye 4 horas de formación a tu equipo y un acompañamiento de 4 semanas. Si en la semana 4 alguien sigue resistiéndose, no es problema técnico, es de gestión del cambio — pero las pantallas son tan parecidas a lo que ya usan que la curva es muy plana."

### "¿Qué pasa si tenéis un problema/quebráis?"

> "Buena pregunta. Tres respuestas: (1) tu DB es tuya, te la entregamos en cualquier momento; (2) el código fuente del piloto se deposita en escrow si firmas el contrato anual; (3) somos un proyecto serio con financiación y track record demostrable."

---

## 3 · Post-demo

### Si dicen "lo pensamos"

> "Lo entiendo. ¿Qué necesitas para decidir? ¿Hablar con tu asesoría? ¿Probarlo tu equipo en un día normal? Podemos darte acceso 7 días sin compromiso para que tu equipo lo toque. Si te parece, agendamos llamada el viernes para que me cuentes."

### Si dicen "sí"

> "Genial. Tres pasos: (1) Firmamos el DPA y el SLA hoy mismo — te dejo los documentos. (2) Empezamos el setup técnico esta semana, va por nuestra cuenta. (3) En 7-10 días tienes la app funcionando con tu data. La factura del primer mes se emite tras la primera semana de uso real. ¿Quién es tu interlocutor técnico?"

### Si dicen "no"

> "Te agradezco la honestidad. ¿Qué falló? Si es feature, lo apuntamos al roadmap. Si es timing, podemos hablar dentro de 6 meses. Si es precio, dime tu rango y vemos. Si simplemente no es para ti, te recomiendo Mews para vuestro caso — sin rencor."

### Follow-up

- [ ] Día 0 (mismo día): email de agradecimiento + recap de lo hablado + adjuntos (deck, DPA, SLA)
- [ ] Día 3: ping para resolver dudas concretas si las hay
- [ ] Día 7: propuesta económica formal con condiciones del piloto
- [ ] Día 14: cierre o "no" definitivo. No persigas más.

---

## 4 · Si algo se rompe en vivo

### Plan A: distrae

- "Esto que estamos viendo es la versión que se actualiza en tiempo real desde nuestro repo. Como te puedes imaginar, en una demo siempre hay sorpresas. Si me das 30 segundos lo arreglo o pasamos al siguiente bloque."

### Plan B: usa la otra pantalla

- Tienes Sentry abierto. Verifica si es un error que tú puedes arreglar al instante (reload de la página, login de nuevo). Si no, pasa al siguiente bloque.

### Plan C: honestidad

- "Acabamos de detectar un fallo. Honestamente, esto es lo bueno del piloto: lo encontramos contigo en sala y lo arreglamos hoy. Sigamos con el siguiente bloque y al final me cuentas si esto te preocupa."

NUNCA mentir sobre qué falló. NUNCA echar la culpa a "el internet del hotel" si no es verdad.

---

## 5 · Atajos teclado durante demo

- `⌘K` / `Ctrl+K` — Command palette (busca cualquier cosa)
- `/` — Búsqueda global
- `Esc` — Cerrar drawer/modal abierto
- `?` — Help center (si está implementado)

---

## 6 · Slack/Discord backchannel

Ten un canal con tu equipo durante la demo. Si algo se rompe, alguien del equipo puede:
- Reiniciar API en el VPS
- Mirar Sentry
- Crear datos de emergencia si es necesario

---

¡Suerte! 🚀

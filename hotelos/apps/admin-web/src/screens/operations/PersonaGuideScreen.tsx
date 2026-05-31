// Persona Guide Screen — instrucciones de uso de HotelOS según el rol.
//
// Una sola fuente de verdad sobre cómo trabaja cada perfil con la app:
// qué pantalla es su home, las 5-7 acciones más frecuentes, qué pantallas
// secundarias necesita ocasionalmente, los atajos universales.
//
// Diseñado para abrirse al hacer onboarding de un usuario nuevo o desde el
// PersonaLandingScreen (botón "📖 Cómo usar").

import { useState } from "react";

type Action = {
  icon: string;
  label: string;
  detail: string;
  shortcut?: string;
};

type PersonaGuide = {
  id: string;
  emoji: string;
  label: string;
  oneLiner: string;
  homeScreen: string;
  homeScreenLabel: string;
  whenToUse: string;
  whatYouSee: string[];
  primaryActions: Action[];
  drilldown: Array<{ when: string; goto: string; gotoLabel: string }>;
  tips: string[];
};

const GUIDES: PersonaGuide[] = [
  // ─────────────────────────────────────────────────────────────── RECEPCIÓN
  {
    id: "reception",
    emoji: "🛎️",
    label: "Recepcionista",
    oneLiner:
      "Atiendes al huésped en mostrador, haces check-in/out, resuelves incidencias inmediatas.",
    homeScreen: "FrontDeskDashboard",
    homeScreenLabel: "Mi día · Cockpit de recepción",
    whenToUse:
      "Tu pantalla durante todo el turno. La cola priorizada arriba te dice qué hacer a continuación sin tener que pensar.",
    whatYouSee: [
      "Cola de acciones priorizada (urgent · today · soon) con 12 tipos de detección.",
      "Cards con título + contexto + recomendación + botón 1-clic.",
      "Listas debajo: llegadas hoy, salidas hoy, en-casa, sin habitación.",
      "KPIs del día: arrivals, departures, in-house, sin asignar, saldo pendiente.",
    ],
    primaryActions: [
      { icon: "🔑", label: "Hacer check-in (≤90s)", detail: "Botón verde 'Hacer check-in' en una card de la cola. Se abre un drawer con guest + room + folio + compliance en una sola pantalla." },
      { icon: "👋", label: "Hacer check-out (≤60s)", detail: "Botón en cards de 'late_checkout_overdue' o 'checkout_pending'. Cobra el saldo y cierra el folio en un clic." },
      { icon: "🛏", label: "Asignar habitación", detail: "Card 'Sin habitación'. El sistema sugiere la primera limpia del mismo tipo. Botón ejecuta sin abrir otra pantalla." },
      { icon: "⛔", label: "Marcar no-show", detail: "Card 'no_show_risk' tras las 19:00. Acción secundaria después de intentar contactar al huésped." },
      { icon: "⚠️", label: "Resolver overbooking", detail: "Card roja 'overbooking' → te lleva al Room Rack en la habitación afectada para reubicar." },
      { icon: "🔍", label: "Buscar reserva", detail: "Pulsa ⌘K en cualquier pantalla. Busca por código, nombre, DNI o habitación.", shortcut: "⌘K" },
      { icon: "➕", label: "Crear reserva", detail: "Botón verde 'Crear reserva' arriba a la derecha. Form completo + opción AI parse para texto natural." },
    ],
    drilldown: [
      { when: "Quieres ver el calendario de habitaciones", goto: "LiveTimelineWorkspace", gotoLabel: "Live Timeline" },
      { when: "Quieres ver el estado físico de habitaciones", goto: "RoomRackScreen", gotoLabel: "Tablero de habitaciones" },
      { when: "Necesitas el perfil completo de un huésped", goto: "GuestTimelineScreen", gotoLabel: "Timeline del huésped" },
      { when: "Quieres preguntar al IA", goto: "FrontDeskCopilotScreen", gotoLabel: "Copiloto operativo" },
    ],
    tips: [
      "La cola se auto-refresca cada 30 segundos. Si pulsas una acción que falla, refresca con ↻.",
      "Si una card no tiene botón de acción, el item es solo informativo (ej: 'cliente recurrente').",
      "Las acciones de mutación (asignar habitación, marcar no-show) ejecutan POST a la API directamente — sin confirmación. Úsalas con cuidado.",
    ],
  },
  // ─────────────────────────────────────────────────────────── JEFE RECEPCIÓN
  {
    id: "shift_manager",
    emoji: "👤",
    label: "Jefe de Recepción",
    oneLiner: "Supervisas el turno, productividad del equipo, caja del día, conflictos críticos.",
    homeScreen: "ShiftManagerScreen",
    homeScreenLabel: "Supervisión del turno",
    whenToUse:
      "Al iniciar y cerrar el turno + cuando hay conflictos. Una vista por encima del cockpit de recepción.",
    whatYouSee: [
      "Productividad: check-ins/outs hechos vs planificados, con % completado.",
      "No-shows y cancelaciones del día.",
      "Caja: cobrado · reembolsado · neto · saldo abierto.",
      "5 flags con código de color (conflictos, llegadas sin asignar, incidencias críticas, etc.).",
      "Timeline cronológico de eventos del turno (últimos 50).",
    ],
    primaryActions: [
      { icon: "📊", label: "Revisar productividad", detail: "Al inicio del turno mira los % completados. Si están bajos, redistribuye." },
      { icon: "🔴", label: "Atender flags rojos", detail: "Overbooking, incidencias críticas, llegadas pendientes pasadas las 18:00." },
      { icon: "💰", label: "Cuadrar caja", detail: "Compara cobrado del día con lo que físicamente tienes. Reembolsado debe ser <5% del cobrado." },
      { icon: "🌙", label: "Cerrar el día", detail: "Cuando termines el turno → 'Night audit (cierre del día)' en sidebar." },
    ],
    drilldown: [
      { when: "Necesitas ir al detalle de un huésped o reserva concreta", goto: "FrontDeskDashboard", gotoLabel: "Cockpit recepción" },
      { when: "Hay overbooking que reubicar", goto: "RoomRackScreen", gotoLabel: "Room Rack" },
      { when: "Quieres cerrar el día", goto: "NightAuditScreen", gotoLabel: "Night audit" },
    ],
    tips: [
      "Polling cada 30s — refresca automáticamente.",
      "El timeline de eventos es read-only, sirve para forensia ('¿qué pasó a las 14:30?').",
      "Si el flag de overbooking aparece, no inicies el siguiente turno hasta resolverlo.",
    ],
  },
  // ──────────────────────────────────────────────────────────────── HK MÓVIL
  {
    id: "housekeeping",
    emoji: "🧹",
    label: "Housekeeping (camarera/o, gobernanta)",
    oneLiner: "Limpias habitaciones desde tu tablet o móvil con cola priorizada por urgencia.",
    homeScreen: "HousekeepingMobileScreen",
    homeScreenLabel: "Mi turno (HK móvil)",
    whenToUse:
      "Durante el turno completo. Optimizada para tap targets ≥44px, contraste alto, una columna en móvil, dos en tablet.",
    whatYouSee: [
      "5 chips arriba: Todo · Urgente · Alta · Normal · Baja con contadores.",
      "Cards de habitación con número grande, prioridad, estado HK, motivo en lenguaje natural.",
      "Próximo huésped + ETA (si aplica), VIP star, petición especial del cliente destacada.",
      "Incidencias abiertas mostradas como chip rojo.",
    ],
    primaryActions: [
      { icon: "▶", label: "Iniciar limpieza", detail: "Cuando entras a la habitación. Marca como 'in_progress'." },
      { icon: "✓", label: "Marcar limpia", detail: "Cuando terminas. Aparece el botón '🔍 Inspeccionada' para la supervisión final." },
      { icon: "🔍", label: "Inspeccionada", detail: "Tras revisión por gobernanta o supervisora. La habitación queda lista para entregar." },
      { icon: "⚠️", label: "Reportar incidencia", detail: "Si encuentras avería (luz fundida, grifo gotea, TV no funciona). Crea automáticamente un work order para mantenimiento." },
    ],
    drilldown: [
      { when: "Quieres ver el tablero general del piso", goto: "HousekeepingDashboard", gotoLabel: "Tablero de pisos" },
    ],
    tips: [
      "Las habitaciones URGENT tienen llegada en <2h — prioriza esas siempre.",
      "Las STAYOVER (cliente sigue dentro) requieren limpieza ligera, no full turnover.",
      "Cuando no queden tareas verás 🎉 — eso significa que el piso está al día.",
      "Si añades una nota tras Reportar, queda asociada al work order como historial.",
    ],
  },
  // ────────────────────────────────────────────────────────── MANTENIMIENTO
  {
    id: "maintenance",
    emoji: "🛠️",
    label: "Técnico de Mantenimiento",
    oneLiner: "Resuelves averías con tablet/móvil. Cola priorizada por impacto al huésped.",
    homeScreen: "MaintenanceMobileScreen",
    homeScreenLabel: "Mis averías (Mant. móvil)",
    whenToUse:
      "Durante todo el turno. Diseñada como la HK pero para work orders en lugar de tareas de limpieza.",
    whatYouSee: [
      "5 chips: Todo · Urgente · Alta · Normal · Baja con contadores.",
      "Cards con número grande de habitación + título de la avería.",
      "Chip rojo '🚫 bloquea hab.' si afecta inventario.",
      "Chip ⏰ si el SLA está vencido.",
      "Si hay huésped dentro: '👤 Pierre Smith está en la habitación'.",
      "Edad de la avería y número de fotos asociadas.",
    ],
    primaryActions: [
      { icon: "▶", label: "Tomar avería", detail: "Te asignas la avería (estado in_progress). Otros técnicos verán que la cogiste tú." },
      { icon: "✓", label: "Marcar resuelta", detail: "Tras arreglar. Si bloqueaba la habitación, se libera automáticamente (sellable=true)." },
      { icon: "📝", label: "Añadir nota", detail: "Para documentar el diagnóstico, piezas pedidas, foto del problema, etc." },
    ],
    drilldown: [
      { when: "Quieres ver el tablero general", goto: "MaintenanceDashboard", gotoLabel: "Tablero mantenimiento" },
    ],
    tips: [
      "URGENT = emergencia O bloquea habitación con huésped dentro. Prioridad máxima.",
      "Si la avería tiene huésped dentro, comunícate con recepción antes de entrar.",
      "Las notas son acumulativas — cada nueva se concatena con timestamp.",
    ],
  },
  // ──────────────────────────────────────────────────────── DIRECTOR OPS
  {
    id: "ops_director",
    emoji: "📊",
    label: "Director de Operaciones",
    oneLiner: "Supervisas todos los departamentos del hotel desde una sola pantalla.",
    homeScreen: "OperationsDirectorScreen",
    homeScreenLabel: "Director de operaciones",
    whenToUse:
      "Al inicio de cada turno + cuando hay alertas. Te dice qué departamento necesita atención sin abrir 6 dashboards distintos.",
    whatYouSee: [
      "Resumen: 6 departamentos con health pill (OK/ATENCIÓN/CRÍTICO).",
      "Banner 'Atender ahora' con alertas críticas cross-departamento (emergencias, salidas vencidas, HK retrasada, ausencias).",
      "Cards por departamento (Front Desk, HK, Mantenimiento, Personal, Seguridad, F&B) con 2-4 KPIs y botón 'Abrir' al tablero específico.",
    ],
    primaryActions: [
      { icon: "🔴", label: "Triaje alertas críticas", detail: "Las alertas del banner son las que más afectan al guest experience. Atiende esas antes de cualquier otra cosa." },
      { icon: "🔍", label: "Drilldown a departamento", detail: "Click 'Abrir' en cualquier card te lleva al cockpit de ese departamento (HK móvil, Mantenimiento móvil, etc.)." },
      { icon: "📈", label: "Comparar departamentos", detail: "Si todos los departamentos están en verde pero uno en amber, ese es tu cuello de botella. Pregúntate por qué." },
    ],
    drilldown: [
      { when: "Frontend desk en rojo", goto: "FrontDeskDashboard", gotoLabel: "Cockpit recepción" },
      { when: "HK con tareas retrasadas", goto: "HousekeepingMobileScreen", gotoLabel: "HK móvil" },
      { when: "Emergencia mantenimiento", goto: "MaintenanceMobileScreen", gotoLabel: "Mantenimiento móvil" },
      { when: "Necesitas vista financiera", goto: "FinancePositionDashboard", gotoLabel: "Posición financiera" },
    ],
    tips: [
      "El director no opera — coordina. Si te encuentras haciendo check-ins, falta un recepcionista.",
      "Las alertas críticas se calculan en tiempo real con polling cada 30s.",
      "Si tu hotel está en verde durante 3 turnos seguidos, considera redistribuir personal.",
    ],
  },
  // ───────────────────────────────────────────────────────── GERENCIA GM
  {
    id: "gm",
    emoji: "🏢",
    label: "Gerencia (General Manager)",
    oneLiner:
      "Tomas decisiones estratégicas: ocupación, ADR, RevPAR, mix de canales, reputación, P&L del hotel.",
    homeScreen: "GeneralManagerScreen",
    homeScreenLabel: "Dashboard del director (GM)",
    whenToUse:
      "Al inicio del día (revisar producción) + reunión semanal con propiedad + cierre mensual.",
    whatYouSee: [
      "Producción del día con 4 KPIs: ocupación, ADR, RevPAR, ingresos. Cada uno con ▲▼ vs ayer y vs misma semana anterior.",
      "MTD (Month-To-Date) en cada KPI para contexto.",
      "Mix por canal (top 6 con barra de %).",
      "Mix por segmento (top 6).",
      "Productividad operativa, caja del día, 4 cards de alertas.",
      "Reputación (si hay reviews) + breakdown de ingresos MTD por concepto.",
    ],
    primaryActions: [
      { icon: "📊", label: "Revisar producción diaria", detail: "Cada mañana. Si ADR cae >5% vs ayer sin razón estacional → investigar." },
      { icon: "📈", label: "Drilldown Revenue", detail: "Si necesitas ajustar BAR o ver forecast → 'Ver detalle' en el card Mix canal." },
      { icon: "🤖", label: "Preguntar al copiloto IA", detail: "Para preguntas no estándar (ej. '¿qué huéspedes recurrentes tengo esta semana?') → Copiloto operativo." },
      { icon: "⚠️", label: "Atender alertas", detail: "Card 'Alertas operativas' muestra overbookings, emergencias, bloqueadas. Si >0, vete al cockpit." },
    ],
    drilldown: [
      { when: "Quieres comparar con otras propiedades", goto: "PortfolioDashboard", gotoLabel: "Cartera completa" },
      { when: "Revenue management profundo", goto: "RevenueHomeDashboard", gotoLabel: "Revenue home" },
      { when: "Mix canal", goto: "ChannelPerformanceDashboard", gotoLabel: "Channel performance" },
      { when: "Reputación", goto: "ReputationDashboard", gotoLabel: "Reputación online" },
    ],
    tips: [
      "▲ verde = mejor que comparativa, ▼ rojo = peor.",
      "MTD aparece en chip pequeño junto al KPI del día.",
      "El RevPAR ignora estancias < 1 noche; usa LOS medio del hotel para tu comparativa.",
      "Si tu ADR sube pero ocupación baja, estás expulsando demanda — baja BAR.",
    ],
  },
  // ───────────────────────────────────────────────────────────── PROPIETARIO
  {
    id: "owner",
    emoji: "💼",
    label: "Propietario",
    oneLiner:
      "Ves el resultado del activo (o de toda la cartera) sin entrar en operación diaria.",
    homeScreen: "OwnerHome",
    homeScreenLabel: "Resumen del propietario",
    whenToUse:
      "Como dashboard principal — semanal o diario rápido. Si tienes varias propiedades, ves la cartera consolidada.",
    whatYouSee: [
      "Cartera total: propiedades activas, habitaciones, in-house, ocupación weighted, ADR/RevPAR.",
      "Ingresos MTD + saldo pendiente.",
      "Top 6 propiedades por ingresos.",
      "Alertas críticas cross-property.",
    ],
    primaryActions: [
      { icon: "🌐", label: "Ver cartera completa", detail: "Botón arriba a la derecha → PortfolioDashboard con sort por 10 columnas." },
      { icon: "📊", label: "Revenue", detail: "Botón 'Revenue' → home de revenue management." },
      { icon: "🚨", label: "Atender alertas", detail: "Si aparece alerta crítica de una propiedad, drilldown haciendo click en la propiedad." },
    ],
    drilldown: [
      { when: "Quieres entrar al detalle de una propiedad", goto: "GeneralManagerScreen", gotoLabel: "Dashboard del director" },
      { when: "Necesitas vista financiera", goto: "FinancePositionDashboard", gotoLabel: "Posición financiera" },
      { when: "Quieres comparar propiedades por columna", goto: "PortfolioDashboard", gotoLabel: "Cartera completa" },
    ],
    tips: [
      "La ocupación weighted considera el tamaño de cada hotel (200 hab pesan más que 12 hab).",
      "El saldo pendiente cross-property es un buen termómetro del cash flow.",
      "Si una propiedad concentra muchas alertas, considera pedir GM call.",
    ],
  },
  // ──────────────────────────────────────────────────────── REVENUE MANAGER
  {
    id: "revenue",
    emoji: "📈",
    label: "Revenue Manager",
    oneLiner:
      "Optimizas ingresos: pickup, forecast, restricciones, BAR, comp-set, segmentación.",
    homeScreen: "RevenueHomeDashboard",
    homeScreenLabel: "Revenue home",
    whenToUse:
      "Diariamente al inicio del día + cuando ajustas tarifas o restricciones. Reunión semanal de revenue meeting.",
    whatYouSee: [
      "Pickup últimas 24h y 7 días.",
      "Forecast por segmento con accuracy histórica.",
      "BAR levels actuales + recomendaciones.",
      "Comp-set (rate shopper).",
      "Budget vs forecast vs actual.",
    ],
    primaryActions: [
      { icon: "📈", label: "Ajustar BAR", detail: "Si pickup baja vs forecast → bajar BAR. Si sube fuerte → subir BAR." },
      { icon: "🎯", label: "Revisar comp-set", detail: "Rate shopper diario te dice si estás por encima/debajo del mercado." },
      { icon: "🗓", label: "Revisar restricciones", detail: "MinLOS, CTA, CTD por fecha — ajustar para grupos o eventos." },
      { icon: "📊", label: "Group displacement", detail: "Antes de aceptar grupo, calcula el desplazamiento de transient." },
    ],
    drilldown: [
      { when: "Necesitas plan de reunión semanal", goto: "RevenueMeetingPack", gotoLabel: "Meeting pack" },
      { when: "Quieres ver forecast por segmento", goto: "RevenueHistoryForecastDashboard", gotoLabel: "History & forecast" },
      { when: "Ajustar reglas automáticas de pricing", goto: "RevenueAutomationRulesScreen", gotoLabel: "Automation rules" },
    ],
    tips: [
      "El pickup snapshot se calcula a las 06:00 UTC — los datos del día anterior están completos.",
      "La forecast accuracy se mide a 30 días vista. Si baja del 80%, revisa el modelo.",
      "BAR recommendation propone valor — siempre revísalo antes de publicar."
    ],
  },
];

const COMMON_SHORTCUTS = [
  { keys: "⌘K", label: "Buscar global", detail: "Reservas, huéspedes, habitaciones, folios, facturas en una sola búsqueda." },
  { keys: "↻", label: "Recargar datos", detail: "En cada pantalla, fuerza un refresh del polling sin recargar página." },
  { keys: "Sidebar", label: "Navegación principal", detail: "Filtrado por rol activo. Para ver todo, cambia a 'Todo (admin)' en el selector." },
];

function navigateTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

export function PersonaGuideScreen() {
  const [selected, setSelected] = useState<string>(GUIDES[0].id);
  const guide = GUIDES.find((g) => g.id === selected) ?? GUIDES[0];

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Guía · Cómo usar HotelOS</div>
          <h1 className="bo-page-title">Instrucciones por perfil</h1>
          <p className="bo-page-subtitle">
            HotelOS tiene una vista pensada para cada rol del hotel. Elige el tuyo abajo y verás
            qué pantalla es tu home, qué acciones son las más frecuentes y cuándo cambiar de vista.
          </p>
        </div>
      </div>

      {/* Persona selector */}
      <article className="bo-card" style={{ background: "var(--surface)", position: "sticky", top: 0, zIndex: 5 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {GUIDES.map((g) => (
            <button
              key={g.id}
              type="button"
              className={selected === g.id ? "primary" : "ghost"}
              onClick={() => setSelected(g.id)}
              style={{ padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}
            >
              <span style={{ fontSize: 18 }}>{g.emoji}</span>
              {g.label}
            </button>
          ))}
        </div>
      </article>

      {/* Hero del persona */}
      <article
        className="bo-card"
        style={{
          background: "linear-gradient(135deg, var(--surface) 0%, var(--surface-elevated, rgba(110, 60, 200, 0.06)) 100%)",
          borderLeft: "4px solid var(--accent, #6f3ad2)"
        }}
      >
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 48, lineHeight: 1 }}>{guide.emoji}</span>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h2 style={{ margin: 0, fontSize: 22 }}>{guide.label}</h2>
            <p style={{ margin: "4px 0 0 0", color: "var(--ink)", fontSize: 14 }}>{guide.oneLiner}</p>
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => navigateTo(guide.homeScreen)}
            style={{ minHeight: 44, padding: "8px 18px" }}
          >
            Abrir mi home →
          </button>
        </div>
      </article>

      {/* Pantalla principal + cuando usarla */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)", margin: 0 }}>Tu pantalla principal</h3>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
          <span className="bo-chip" style={{ background: "var(--accent, #6f3ad2)", color: "white", fontFamily: "monospace" }}>
            {guide.homeScreen}
          </span>
          <span style={{ fontSize: 14, color: "var(--ink)" }}>· {guide.homeScreenLabel}</span>
        </div>
        <p style={{ fontSize: 13, color: "var(--ink)", margin: "0 0 12px 0" }}>{guide.whenToUse}</p>
        <strong style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--muted, #888)" }}>
          Lo que ves al entrar
        </strong>
        <ul style={{ margin: "6px 0 0 0", paddingLeft: 20, fontSize: 13, color: "var(--ink)" }}>
          {guide.whatYouSee.map((line, i) => (
            <li key={i} style={{ marginBottom: 4 }}>{line}</li>
          ))}
        </ul>
      </article>

      {/* Acciones primarias */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)", margin: 0 }}>Tus acciones del día a día</h3>
          <span className="bo-chip">{guide.primaryActions.length}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
          {guide.primaryActions.map((act, i) => (
            <div
              key={i}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 12,
                display: "flex",
                gap: 10
              }}
            >
              <span style={{ fontSize: 24, lineHeight: 1 }}>{act.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>{act.label}</strong>
                  {act.shortcut ? (
                    <kbd
                      style={{
                        fontSize: 10,
                        padding: "2px 6px",
                        background: "var(--surface-elevated, rgba(0,0,0,0.05))",
                        borderRadius: 4,
                        fontFamily: "monospace"
                      }}
                    >
                      {act.shortcut}
                    </kbd>
                  ) : null}
                </div>
                <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--muted, #888)", lineHeight: 1.4 }}>
                  {act.detail}
                </p>
              </div>
            </div>
          ))}
        </div>
      </article>

      {/* Drilldown */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)", margin: 0 }}>Cuándo cambiar de vista</h3>
        </div>
        {guide.drilldown.length === 0 ? (
          <p className="bo-muted">Tu home cubre prácticamente todo. Solo si necesitas reportes financieros usarías otras pantallas.</p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Ir a</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {guide.drilldown.map((d, i) => (
                <tr key={i}>
                  <td>{d.when}</td>
                  <td><strong>{d.gotoLabel}</strong></td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="ghost" onClick={() => navigateTo(d.goto)}>Abrir →</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>

      {/* Tips */}
      {guide.tips.length > 0 ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)", margin: 0 }}>💡 Consejos</h3>
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--ink)" }}>
            {guide.tips.map((tip, i) => (
              <li key={i} style={{ marginBottom: 6 }}>{tip}</li>
            ))}
          </ul>
        </article>
      ) : null}

      {/* Atajos comunes */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)", margin: 0 }}>Atajos universales (todos los roles)</h3>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
          {COMMON_SHORTCUTS.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 10, padding: 8 }}>
              <kbd
                style={{
                  fontSize: 12,
                  padding: "4px 10px",
                  background: "var(--surface-elevated, rgba(0,0,0,0.05))",
                  borderRadius: 4,
                  fontFamily: "monospace",
                  minWidth: 60,
                  textAlign: "center",
                  alignSelf: "flex-start"
                }}
              >
                {s.keys}
              </kbd>
              <div>
                <strong style={{ fontSize: 13 }}>{s.label}</strong>
                <p style={{ margin: "2px 0 0 0", fontSize: 12, color: "var(--muted, #888)" }}>{s.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </article>
    </>
  );
}

// Persona Landing Screen — selector de "qué pantalla es mi home" según rol.
//
// Directriz Anfitorio (Nov 2026):
//   "Diseñar por rol. Anfitorio no debe mostrar lo mismo a todos."
//
// Esta pantalla ayuda al usuario a:
//   1. Ver todos los homes de rol disponibles (8 personas operativas)
//   2. Cambiar al home recomendado para su rol activo
//   3. Saltar a otro persona one-click (sin perder propiedad seleccionada)
//
// Es el "centro de control de personas" — útil para usuarios multi-rol
// (gerentes que también supervisan recepción, o jefes de turno que ven
// tableros de operaciones).

import { useState } from "react";
import { ROLES, getActiveRole, setActiveRole, type Role } from "../../navigation/roles";

const PERSONAS: Array<{
  id: string;
  label: string;
  description: string;
  screen: string;
  role: Role | "any";
  emoji: string;
  highlight?: boolean;
}> = [
  {
    id: "reception",
    label: "Recepcionista",
    description: "Cola priorizada de acciones, check-in/out 90s, room rack visual.",
    screen: "FrontDeskDashboard",
    role: "reception",
    emoji: "🛎️",
    highlight: true
  },
  {
    id: "shift_manager",
    label: "Jefe de Recepción",
    description: "Productividad del turno, caja del día, conflictos.",
    screen: "ShiftManagerScreen",
    role: "operations",
    emoji: "👤"
  },
  {
    id: "housekeeping",
    label: "Housekeeping (móvil)",
    description: "Cola priorizada de habitaciones a limpiar, táctil para móvil/tablet.",
    screen: "HousekeepingMobileScreen",
    role: "operations",
    emoji: "🧹"
  },
  {
    id: "maintenance",
    label: "Mantenimiento (móvil)",
    description: "Averías priorizadas, take/resolve/note 1-clic.",
    screen: "MaintenanceMobileScreen",
    role: "operations",
    emoji: "🛠️"
  },
  {
    id: "ops_director",
    label: "Director de Operaciones",
    description: "Vista consolidada cross-departamento.",
    screen: "OperationsDirectorScreen",
    role: "operations",
    emoji: "📊",
    highlight: true
  },
  {
    id: "gm",
    label: "Gerencia (GM)",
    description: "Ocupación, ADR, RevPAR, caja, reputación, incidencias.",
    screen: "GeneralManagerScreen",
    role: "asset",
    emoji: "🏢",
    highlight: true
  },
  {
    id: "owner",
    label: "Propietario",
    description: "Cartera multi-hotel, P&L, alertas críticas.",
    screen: "OwnerHome",
    role: "owner",
    emoji: "💼"
  },
  {
    id: "revenue",
    label: "Revenue Manager",
    description: "Pickup, forecast, BAR, segmentación, comp-set.",
    screen: "RevenueHomeDashboard",
    role: "asset",
    emoji: "📈"
  }
];

function navigateTo(screen: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
  }
}

export function PersonaLandingScreen() {
  const [activeRole, setActiveRoleState] = useState<Role>(() => getActiveRole());
  const [busy, setBusy] = useState(false);

  function selectPersona(persona: typeof PERSONAS[number]) {
    // Persiste el rol si difiere del actual
    if (persona.role !== "any" && persona.role !== activeRole) {
      setActiveRole(persona.role as Role);
      setActiveRoleState(persona.role as Role);
    }
    setBusy(true);
    navigateTo(persona.screen);
    setTimeout(() => setBusy(false), 500);
  }

  function setHome(persona: typeof PERSONAS[number]) {
    if (persona.role !== "any") {
      setActiveRole(persona.role as Role);
      setActiveRoleState(persona.role as Role);
    }
  }

  const activeRoleLabel = ROLES.find((r) => r.id === activeRole)?.label ?? activeRole;

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Personas · Rol activo: {activeRoleLabel}</div>
          <h1 className="bo-page-title">¿Quién eres hoy?</h1>
          <p className="bo-page-subtitle">
            Anfitorio se adapta a tu rol. Elige tu home preferido — el sidebar y los atajos se reorganizan en consecuencia.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => navigateTo("PersonaGuideScreen")}>
            📖 Cómo usar Anfitorio por persona
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
        {PERSONAS.map((p) => {
          const isCurrentHome = activeRole === p.role;
          const isRecommended = p.highlight;
          return (
            <article
              key={p.id}
              className="bo-card"
              style={{
                background: "var(--surface)",
                borderLeft: isCurrentHome ? "4px solid var(--accent, #6f3ad2)" : isRecommended ? "4px solid var(--ok, #1f8a4c)" : "1px solid var(--border)",
                cursor: "pointer"
              }}
              role="button"
              tabIndex={0}
              onClick={() => selectPersona(p)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectPersona(p);
                }
              }}
            >
              <div className="bo-card-head">
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 28, lineHeight: 1 }}>{p.emoji}</span>
                  <div>
                    <h3 style={{ color: "var(--ink)", margin: 0, fontSize: 16 }}>{p.label}</h3>
                    {isCurrentHome ? (
                      <span className="bo-status info" style={{ fontSize: 10 }}>Home actual</span>
                    ) : isRecommended ? (
                      <span className="bo-status ok" style={{ fontSize: 10 }}>Recomendado</span>
                    ) : null}
                  </div>
                </div>
              </div>
              <p style={{ fontSize: 13, color: "var(--ink)", margin: 0, minHeight: 38 }}>{p.description}</p>
              <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectPersona(p);
                  }}
                  style={{ flex: 1, minWidth: 100 }}
                >
                  Abrir →
                </button>
                {!isCurrentHome && p.role !== "any" ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHome(p);
                    }}
                    title="Fijar este rol como activo en el sidebar"
                  >
                    Fijar rol
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

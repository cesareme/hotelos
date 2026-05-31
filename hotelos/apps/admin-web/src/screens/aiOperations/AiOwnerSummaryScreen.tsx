import { getActiveOrganizationId, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";

const PROPERTY_ID = getActivePropertyId();
const ORGANIZATION_ID = getActiveOrganizationId();

// Owner / director facing summary of the AI posture — plain language, no
// engineering jargon, no JSON, no latency. It reads the REAL configuration and
// the REAL human-review decision counts, and is deliberately honest: the AI here
// works in "assisted" mode with human review, so the copy never overclaims.

type AutomationLevel = "off" | "suggest" | "suggest_and_confirm" | "autonomous";

type PropertyAiSettings = {
  aiEnabled: boolean;
  defaultAutomationLevel: AutomationLevel;
  guestFacingDisclosure: string | null;
  voiceLocales: string[];
  configurationJson: Record<string, unknown>;
};

type ReviewStats = {
  pending: number;
  approved24h: number;
  rejected24h: number;
  escalated: number;
};

type CostDashboard = {
  totalCostEur: number;
  projectedMonthlyEur: number;
  windowDays: number;
};

const AUTOMATION_PLAIN: Record<AutomationLevel, { headline: string; detail: string; humanReview: boolean }> = {
  off: {
    headline: "La IA está desactivada",
    detail: "No hace ninguna sugerencia ni acción en este hotel.",
    humanReview: true
  },
  suggest: {
    headline: "La IA solo sugiere",
    detail: "Propone ideas a tu equipo, pero nunca ejecuta nada por su cuenta. Tu personal decide y actúa.",
    humanReview: true
  },
  suggest_and_confirm: {
    headline: "La IA propone y una persona confirma",
    detail:
      "La IA prepara tareas (por ejemplo, clasificar un documento o sugerir una acción) y solo se ejecutan cuando alguien de tu equipo las aprueba. Siempre hay una persona en el medio.",
    humanReview: true
  },
  autonomous: {
    headline: "La IA puede ejecutar tareas aprobadas",
    detail:
      "Para tareas previamente autorizadas, la IA puede actuar de forma automática. Las acciones de alto riesgo siguen necesitando aprobación de un responsable.",
    humanReview: false
  }
};

function eur(n: number | undefined): string {
  return `${(n ?? 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function AiOwnerSummaryScreen() {
  const settings = useApiData<PropertyAiSettings>("/ai-operations/property/settings", {
    query: { propertyId: PROPERTY_ID }
  });
  const stats = useApiData<ReviewStats>("/ai-operations/review/stats", {
    query: { organizationId: ORGANIZATION_ID }
  });
  const cost = useApiData<CostDashboard>("/ai-operations/governance/cost", {
    query: { organizationId: ORGANIZATION_ID, days: 30 }
  });

  const level: AutomationLevel = settings.data?.defaultAutomationLevel ?? "suggest_and_confirm";
  const plain = AUTOMATION_PLAIN[level];
  const aiEnabled = settings.data?.aiEnabled ?? false;
  const disclosureSet = Boolean(settings.data?.guestFacingDisclosure && settings.data.guestFacingDisclosure.trim());
  const decisions = stats.data;

  return (
    <section className="bo-page">
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Inteligencia artificial · Resumen para dirección y propiedad</div>
          <h1 className="bo-page-title">La IA de tu hotel, en claro</h1>
          <p className="bo-muted" style={{ maxWidth: 760 }}>
            Resumen sencillo de qué hace la inteligencia artificial en tu hotel, cómo está configurada y con qué
            controles de seguridad. Sin tecnicismos: para que dirección y propiedad sepan exactamente qué está pasando.
          </p>
        </div>
        <button type="button" className="bo-btn" onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "PropertyAiScreen" }))}>
          Ajustes de IA
        </button>
      </div>

      {/* Cómo trabaja la IA aquí */}
      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Cómo trabaja la IA en este hotel</p>
            <h3 style={{ margin: 0 }}>{aiEnabled ? plain.headline : "La IA está desactivada"}</h3>
          </div>
          <span className={`bo-status ${aiEnabled ? "ok" : "warn"}`}>{aiEnabled ? "Activada" : "Desactivada"}</span>
        </div>
        <p>{aiEnabled ? plain.detail : "Actívala desde Ajustes de IA cuando quieras empezar a usarla."}</p>
        {aiEnabled && plain.humanReview ? (
          <p className="bo-muted">✓ Revisión humana activa: ninguna acción importante ocurre sin que una persona la apruebe.</p>
        ) : null}
      </section>

      {/* Seguridad y control */}
      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Seguridad y control</h3>
          <span className="bo-chip">tus garantías</span>
        </div>
        <div className="bo-grid three">
          <div className="rev-kpi">
            <span className="bo-muted">Revisión humana</span>
            <strong>{plain.humanReview ? "Activa" : "Parcial"}</strong>
            <span className={`bo-status ${plain.humanReview ? "ok" : "warn"}`}>{plain.humanReview ? "Una persona aprueba" : "Algunas acciones automáticas"}</span>
          </div>
          <div className="rev-kpi">
            <span className="bo-muted">Aviso de IA al huésped</span>
            <strong>{disclosureSet ? "Configurado" : "Pendiente"}</strong>
            <span className={`bo-status ${disclosureSet ? "ok" : "warn"}`}>{disclosureSet ? "Cumple transparencia" : "Recomendado configurar"}</span>
          </div>
          <div className="rev-kpi">
            <span className="bo-muted">Estado de la IA</span>
            <strong>{aiEnabled ? "Encendida" : "Apagada"}</strong>
            <span className={`bo-status ${aiEnabled ? "ok" : "warn"}`}>{aiEnabled ? "En uso" : "Sin uso"}</span>
          </div>
        </div>
      </section>

      {/* Decisiones de la IA */}
      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Decisiones de la IA · últimas 24 horas</p>
            <h3 style={{ margin: 0 }}>Qué ha propuesto y quién lo ha decidido</h3>
          </div>
        </div>
        <div className="bo-grid three">
          <div className="rev-kpi">
            <span className="bo-muted">Esperando tu visto bueno</span>
            <strong>{decisions?.pending ?? 0}</strong>
            <span className="bo-status warn">pendientes de aprobar</span>
          </div>
          <div className="rev-kpi">
            <span className="bo-muted">Aprobadas (24 h)</span>
            <strong>{decisions?.approved24h ?? 0}</strong>
            <span className="bo-status ok">tu equipo dio el visto bueno</span>
          </div>
          <div className="rev-kpi">
            <span className="bo-muted">Rechazadas (24 h)</span>
            <strong>{decisions?.rejected24h ?? 0}</strong>
            <span className="bo-status info">descartadas por tu equipo</span>
          </div>
        </div>
        <p className="bo-muted" style={{ marginTop: 8 }}>
          La IA nunca ejecuta una acción de alto riesgo sin que alguien de tu equipo la apruebe en la cola de revisión.
        </p>
      </section>

      {/* Coste */}
      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Coste de la IA</h3>
          <span className="bo-chip">últimos 30 días</span>
        </div>
        <div className="bo-grid two">
          <div className="rev-kpi">
            <span className="bo-muted">Gasto en IA (30 días)</span>
            <strong>{eur(cost.data?.totalCostEur)}</strong>
          </div>
          <div className="rev-kpi">
            <span className="bo-muted">Proyección mensual</span>
            <strong>{eur(cost.data?.projectedMonthlyEur)}</strong>
          </div>
        </div>
      </section>

      {/* Qué hace y qué no hace */}
      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Qué hace y qué NO hace la IA</h3>
        </div>
        <div className="bo-grid two">
          <div>
            <p className="bo-muted">La IA te ayuda con</p>
            <ul>
              <li>Dar de alta el hotel: lee tus ficheros y prepara habitaciones, tarifas y datos.</li>
              <li>Sugerir acciones a tu equipo (siempre revisables).</li>
              <li>Comprobar la calidad de los datos antes de aplicarlos.</li>
            </ul>
          </div>
          <div>
            <p className="bo-muted">La IA NO hace</p>
            <ul>
              <li>No cobra ni factura por su cuenta.</li>
              <li>No cancela ni modifica reservas sin aprobación.</li>
              <li>No toma decisiones de alto riesgo sin que una persona las confirme.</li>
            </ul>
          </div>
        </div>
      </section>

      {settings.error || stats.error || cost.error ? (
        <p className="bo-muted">No se pudieron cargar todos los datos de IA en este momento.</p>
      ) : null}
    </section>
  );
}

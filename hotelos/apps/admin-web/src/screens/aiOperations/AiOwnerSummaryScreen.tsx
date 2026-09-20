// AI owner summary — «Informe IA del día», /hoy/informe-ia (standalone).
//
// Owner / director facing summary of the AI posture — plain language, no
// engineering jargon, no JSON, no latency. It reads the REAL configuration and
// the REAL human-review decision counts, and is deliberately honest: the AI here
// works in "assisted" mode with human review, so the copy never overclaims.
//
// Cocoa 22 (docs/design/COCOA-22.md §4, plantilla DashboardStandalone):
// CocoaPage → «Cómo trabaja la IA» section (headline + CocoaCallout) →
// guarantees as CocoaCallout tiles → decisions and cost as CocoaKpi strips →
// «Qué hace y qué no hace» in a two-column CocoaGrid of section lists.
// Data: GET /ai-operations/property/settings, /ai-operations/review/stats,
// /ai-operations/governance/cost (30 days) and /ai-operations/property/readiness
// (Tanda L6b · lote 04: «En uso» only with real tool calls, «Sin modelo» while
// the `provider` check is not ok, and no fabricated euro when the API says null).

import type { CSSProperties } from "react";
import { getActiveOrganizationId, getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { navigateTo } from "../../lib/navigate";
import { ACTIONS } from "../../content/actions";
import { money } from "../../lib/format";
import { aiUsageStatus, costCallsTotal } from "./ai-operations-labels";
import { CheckCircleIcon, ExclamationCircleIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  type CocoaTone
} from "../../components/cocoa";

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
  /** null while no call of the window has a real cost (never fabricated, AI-CORE §6). */
  projectedMonthlyEur: number | null;
  /** true only if some call has model and cost_eur (rules-based zeros do not count). */
  hasRealCost: boolean;
  byTool: Array<{ toolName: string; calls: number; costEur: number; tokens: number }>;
  windowDays: number;
};

/** GET /ai-operations/property/readiness: `provider` is ok only with a usable model (Tanda L6a). */
type AiReadiness = {
  propertyId: string;
  ready: boolean;
  checks: Array<{ key: string; status: "ok" | "warn" | "error" }>;
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

const HELPS_WITH = [
  "Dar de alta el hotel: lee tus ficheros y prepara habitaciones, tarifas y datos.",
  "Sugerir acciones a tu equipo (siempre revisables).",
  "Comprobar la calidad de los datos antes de aplicarlos."
];

const DOES_NOT = [
  "No cobra ni factura por su cuenta.",
  "No cancela ni modifica reservas sin aprobación.",
  "No toma decisiones de alto riesgo sin que una persona las confirme."
];

type Guarantee = { id: string; label: string; value: string; caption: string; ok: boolean };

// «—» when the API has no figure (null / not loaded): a euro amount is never invented.
function eur(n: number | null | undefined): string {
  return money(n);
}

// Text styles (tokens only; layout comes from the utilities).
const headlineStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-title-3)",
  fontWeight: "var(--cocoa-fw-semibold)",
  color: "var(--cocoa-label)"
};

const captionStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)"
};

const GUARANTEE_TONE: Record<"true" | "false", CocoaTone> = { true: "success", false: "warning" };

export function AiOwnerSummaryScreen() {
  const propertyId = getActivePropertyId();
  const organizationId = getActiveOrganizationId();
  const propertyName = getActiveProperty().propertyName;

  const settings = useApiData<PropertyAiSettings>("/ai-operations/property/settings", {
    query: { propertyId }
  });
  const stats = useApiData<ReviewStats>("/ai-operations/review/stats", {
    query: { organizationId }
  });
  const cost = useApiData<CostDashboard>("/ai-operations/governance/cost", {
    query: { organizationId, days: 30 }
  });
  const readiness = useApiData<AiReadiness>("/ai-operations/property/readiness", {
    query: { propertyId }
  });

  const level: AutomationLevel = settings.data?.defaultAutomationLevel ?? "suggest_and_confirm";
  const plain = AUTOMATION_PLAIN[level];
  const aiEnabled = settings.data?.aiEnabled ?? false;
  const providerCheck = readiness.data?.checks.find((check) => check.key === "provider");
  const providerOk = providerCheck ? providerCheck.status === "ok" : undefined;
  const callsTotal = costCallsTotal(cost.data);
  const usage = aiUsageStatus({ aiEnabled, providerOk, callsTotal, windowDays: cost.data?.windowDays });
  const disclosureSet = Boolean(settings.data?.guestFacingDisclosure && settings.data.guestFacingDisclosure.trim());
  const decisions = stats.data;
  const partialError = Boolean(settings.error || stats.error || cost.error || readiness.error);
  const state = settings.loading && !settings.data ? "loading" : settings.error && !settings.data ? "error" : "ready";

  function refreshAll() {
    settings.refresh();
    stats.refresh();
    cost.refresh();
    readiness.refresh();
  }

  const guarantees: Guarantee[] = [
    {
      id: "human-review",
      label: "Revisión humana",
      value: plain.humanReview ? "Activa" : "Parcial",
      caption: plain.humanReview ? "Una persona aprueba" : "Algunas acciones automáticas",
      ok: plain.humanReview
    },
    {
      id: "disclosure",
      label: "Aviso de IA al huésped",
      value: disclosureSet ? "Configurado" : "Pendiente",
      caption: disclosureSet ? "Cumple transparencia" : "Recomendado configurar",
      ok: disclosureSet
    },
    {
      id: "enabled",
      label: "Estado de la IA",
      value: usage.value,
      caption: usage.caption,
      ok: usage.ok
    }
  ];

  return (
    <CocoaPage
      eyebrow={`Hoy · ${propertyName}`}
      title="Informe IA del día"
      subtitle="Qué hace la inteligencia artificial en tu hotel, cómo está configurada, cuánto cuesta y con qué controles trabaja. Sin tecnicismos, para dirección y propiedad."
      actions={
        <>
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={refreshAll} aria-label={ACTIONS.refresh} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("PropertyAiScreen")}>
            Ajustes de IA
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<OwnerSummarySkeleton />}
      error={{ title: "No se pudo cargar el informe de IA", message: settings.error ?? undefined, onRetry: refreshAll }}
      commands={[
        { id: "ai-owner-summary-refresh", label: "Actualizar el informe IA", run: refreshAll },
        { id: "ai-owner-summary-settings", label: "Abrir los ajustes de IA", run: () => navigateTo("PropertyAiScreen") }
      ]}
    >
      {partialError ? (
        <CocoaCallout
          tone="warning"
          icon={<ExclamationCircleIcon size={16} />}
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          No se pudieron cargar todos los datos de IA en este momento.
        </CocoaCallout>
      ) : null}

      <CocoaSection
        title="Cómo trabaja la IA en este hotel"
        meta={<CocoaBadge tone={aiEnabled ? "success" : "warning"}>{aiEnabled ? "Activada" : "Desactivada"}</CocoaBadge>}
      >
        <p style={headlineStyle}>{aiEnabled ? plain.headline : "La IA está desactivada"}</p>
        <p>{aiEnabled ? plain.detail : "Actívala desde Ajustes de IA cuando quieras empezar a usarla."}</p>
        {aiEnabled && plain.humanReview ? (
          <CocoaCallout tone="success" icon={<CheckCircleIcon size={16} />}>
            Revisión humana activa: ninguna acción importante ocurre sin que una persona la apruebe.
          </CocoaCallout>
        ) : null}
      </CocoaSection>

      <CocoaSection title="Seguridad y control" meta="tus garantías">
        <CocoaKpiStrip min={240} stagger aria-label="Seguridad y control">
          {guarantees.map((g) => (
            <CocoaCallout key={g.id} tone={GUARANTEE_TONE[g.ok ? "true" : "false"]} title={g.label} icon={g.ok ? <CheckCircleIcon size={16} /> : <ExclamationCircleIcon size={16} />}>
              <strong>{g.value}</strong>
              <span style={captionStyle}>{g.caption}</span>
            </CocoaCallout>
          ))}
        </CocoaKpiStrip>
      </CocoaSection>

      <CocoaSection
        title="Qué ha propuesto y quién lo ha decidido"
        meta="Decisiones de la IA · últimas 24 horas"
        action={
          <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("AiHumanReviewQueueScreen")}>
            {ACTIONS.viewDetail}
          </CocoaButton>
        }
      >
        <CocoaKpiStrip min={200} aria-label="Decisiones de la IA en las últimas 24 horas">
          <CocoaKpi
            label="Esperando tu visto bueno"
            value={decisions?.pending ?? 0}
            deltaLabel="pendientes de aprobar"
            polarity="neutral"
            status={decisions && decisions.pending > 0 ? "warning" : "ok"}
            degraded={!decisions}
          />
          <CocoaKpi label="Aprobadas (24 h)" value={decisions?.approved24h ?? 0} deltaLabel="tu equipo dio el visto bueno" polarity="neutral" status="ok" degraded={!decisions} />
          <CocoaKpi label="Rechazadas (24 h)" value={decisions?.rejected24h ?? 0} deltaLabel="descartadas por tu equipo" polarity="neutral" status="ok" degraded={!decisions} />
        </CocoaKpiStrip>
        <p style={captionStyle}>La IA nunca ejecuta una acción de alto riesgo sin que alguien de tu equipo la apruebe en la cola de revisión.</p>
      </CocoaSection>

      <CocoaSection title="Coste de la IA" meta="últimos 30 días">
        <CocoaKpiStrip min={200} aria-label="Coste de la IA">
          <CocoaKpi
            label="Gasto en IA (30 días)"
            value={eur(cost.data?.totalCostEur)}
            caption={cost.data && !cost.data.hasRealCost ? "sin coste real registrado" : undefined}
            polarity="neutral"
            status="ok"
            degraded={!cost.data}
          />
          <CocoaKpi
            label="Proyección mensual"
            value={eur(cost.data?.projectedMonthlyEur)}
            caption={cost.data && cost.data.projectedMonthlyEur === null ? "sin coste real todavía: no se proyecta" : undefined}
            polarity="neutral"
            status="ok"
            degraded={!cost.data}
          />
        </CocoaKpiStrip>
      </CocoaSection>

      <CocoaSection title="Qué hace y qué no hace la IA">
        <CocoaGrid align="start">
          <CocoaSpan cols={6} min={240}>
            <p style={captionStyle}>La IA te ayuda con</p>
            <ul className="c22-section__list" aria-label="La IA te ayuda con">
              {HELPS_WITH.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </CocoaSpan>
          <CocoaSpan cols={6} min={240}>
            <p style={captionStyle}>La IA no hace</p>
            <ul className="c22-section__list" aria-label="La IA no hace">
              {DOES_NOT.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </CocoaSpan>
        </CocoaGrid>
      </CocoaSection>
    </CocoaPage>
  );
}

// Mirror skeleton: posture card, three guarantee tiles, decisions, cost, lists.
function OwnerSummarySkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={140} />
      <CocoaSkeleton.Strip count={3} min={240} />
      <CocoaSkeleton.Strip count={3} min={200} />
      <CocoaSkeleton.Strip count={2} min={200} />
      <CocoaSkeleton variant="card" height={200} />
    </div>
  );
}

export default AiOwnerSummaryScreen;

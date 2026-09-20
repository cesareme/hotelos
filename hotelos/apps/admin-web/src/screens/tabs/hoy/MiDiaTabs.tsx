// Mi día — /hoy (Tanda 5 · L1a · lote tabs-a; Tanda 8a · L4).
//
// Item `FrontDeskDashboard` of the tree: base tab «Recepción» (FrontDeskDashboard)
// plus Operaciones (OperationsDirectorScreen, /hoy/operaciones), Dirección
// (GeneralManagerScreen, /hoy/direccion) and Propietario (OwnerHome,
// /hoy/propietario). The landing tab is the role home (`navigation/role-tokens.ts`
// `roleHome`): recepción stays on Recepción, pisos/mantenimiento/fnb land on
// Operaciones, direccion (and revenue/finanzas/comercial) on Dirección — the
// `owner` template on Propietario. The base tab is painted only for the roles
// whose day starts at the front desk (§3 lists «Mi día [Operaciones]» for pisos
// and «Mi día [Dirección]» for revenue); Tanda 8a adds the hotel clerk
// (`administracion`), the owner (`propiedad`) and the internal auditor
// (`auditoria`) to it.
//
// «Pendientes» card (design §4.9; Tanda UX-2 · D5, docs/design/UX-DIRECCION-FEEL.md
// F-D8): a role holding an approval key (`*.approve` / `*_approve` in the real
// grants of the property) or `ai_governance.read` sees in the header ONE card
// «Pendientes · N aprobaciones · M de la IA» — N = pending requests it may
// decide (GET /approvals, filtered by the service), M = `pending` of
// GET /ai-operations/review/stats (useApiData, 30 s cache shared with the AI
// queue screen, only with the read key) — with a `warning` badge above zero.
// The card opens Hoy › Pendientes de aprobación; a second button «IA» opens
// Hoy › Pendientes de la IA. Cocoa 22: CocoaButton + CocoaBadge, no inline style.
//
// L1b registers: screenKey FrontDeskDashboard · url /hoy · tabs /hoy/operaciones,
// /hoy/direccion, /hoy/propietario; Tanda CHK adds /hoy/check-in-automatizado
// (CheckInAutomationSettingsScreen, roles recepcion · direccion · admin · auditoria);
// Tanda RRHH · PANEL-B adds /hoy/costes-personal (DirectorLaborCostsScreen, roles
// direccion · finanzas · admin · propiedad · auditoria): coste de personal por
// centro y departamento frente a ventas (GET /payroll/labor-cost-panel).

import { useEffect, useState } from "react";
import { CocoaBadge } from "../../../components/cocoa/CocoaBadge";
import { CocoaButton } from "../../../components/cocoa/CocoaButton";
import { useApiData } from "../../../hooks/useApiData";
import { navigateTo } from "../../../lib/navigate";
import { useNavGate } from "../../../navigation/useEnabledModules";
import { getActiveOrganizationId } from "../../../services/activeProperty";
import { listPendingApprovals } from "../../../services/approvalsApi";
import { getUser } from "../../../services/auth-storage";
import { useCurrentUserProfile } from "../../../services/usersApi";
import { hasApprovalKeys, pendingCardLabel, pendingCardParts, pendingCardTotal, pendingForViewer, viewerFromProfile } from "../../approvals/approvals-helpers";
import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  FrontDeskDashboard: () => import("../../operations/FrontDeskDashboard").then((m) => ({ default: m.FrontDeskDashboard })),
  OperationsDirectorScreen: () => import("../../operations/OperationsDirectorScreen").then((m) => ({ default: m.OperationsDirectorScreen })),
  GeneralManagerScreen: () => import("../../operations/GeneralManagerScreen").then((m) => ({ default: m.GeneralManagerScreen })),
  OwnerHome: () => import("../../owner/OwnerHomeScreen").then((m) => ({ default: m.OwnerHomeScreen })),
  // Tanda CHK · W4-B: ajustes del check-in automatizado (política, pesos, kioscos, métricas), /hoy/check-in-automatizado.
  CheckInAutomationSettingsScreen: () => import("../../operations/CheckInAutomationSettingsScreen").then((m) => ({ default: m.CheckInAutomationSettingsScreen })),
  // Tanda RRHH · PANEL-B: costes de personal de dirección (diario 64x / lote de nómina frente a ventas), /hoy/costes-personal.
  DirectorLaborCostsScreen: () => import("../../costs/DirectorLaborCostsScreen").then((m) => ({ default: m.DirectorLaborCostsScreen }))
};

/** Roles whose Mi día includes the front-desk view (the rest land on their own tab). */
const BASE_TAB_ROLES = ["recepcion", "direccion", "admin", "administracion", "propiedad", "auditoria"] as const;

/** Key that reads the AI review queue and its stats (`route-permissions.ts`: GET /ai-operations/review/stats). */
const AI_REVIEW_READ_KEY = "ai_governance.read";

/** The part of GET /ai-operations/review/stats the card reads. */
type ReviewStatsLite = { pending: number };

/** Header card «Pendientes · N aprobaciones · M de la IA»: for a profile that approves something or reads the AI queue. */
function PendingCard() {
  const gate = useNavGate();
  const { profile } = useCurrentUserProfile();
  const approver = hasApprovalKeys(gate.grantedPermissions);
  const aiReader = (gate.grantedPermissions ?? []).includes(AI_REVIEW_READ_KEY);
  const [count, setCount] = useState<number | null>(null);
  // Same path + query as AiHumanReviewQueueScreen → same cache entry (30 s); nothing is requested without the key.
  const { data: aiStats } = useApiData<ReviewStatsLite>(aiReader ? "/ai-operations/review/stats" : null, {
    query: { organizationId: getActiveOrganizationId() },
    staleTime: 30000,
    enabled: aiReader
  });

  useEffect(() => {
    if (!approver) return undefined;
    let alive = true;
    // Corrector 8a (FX-09): the card counts what the user can DECIDE (same criterion as the inbox badge), per hotel of the request.
    const viewer = viewerFromProfile({ userId: getUser()?.userId ?? null, isPlatformAdmin: gate.isPlatformAdmin, grantedPermissions: gate.grantedPermissions, properties: profile?.properties ?? null });
    listPendingApprovals()
      .then((rows) => pendingForViewer(rows, viewer).length)
      .then((value) => {
        if (alive) setCount(value);
      })
      .catch(() => {
        // The card still opens the inbox; the inbox explains the failure itself.
        if (alive) setCount(null);
      });
    return () => {
      alive = false;
    };
  }, [approver, gate.isPlatformAdmin, gate.grantedPermissions, profile]);

  if (!approver && !aiReader) return null;
  const counts = { approvals: approver ? count : null, ai: aiReader && aiStats ? aiStats.pending : null };
  const parts = pendingCardParts(counts);
  const total = pendingCardTotal(counts);
  return (
    <span className="cocoa-cluster" role="group" aria-label="Pendientes de hoy">
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("ApprovalsInbox")} aria-label={pendingCardLabel(counts)} title="Solicitudes de aprobación que puedes decidir y propuestas de la IA pendientes">
        Pendientes
        {parts.length > 0 ? (
          <CocoaBadge tone={total > 0 ? "warning" : "neutral"} size="small" uppercase={false}>
            {parts.join(" · ")}
          </CocoaBadge>
        ) : null}
      </CocoaButton>
      {aiReader ? (
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("AiHumanReviewQueueScreen")} aria-label="Pendientes de la IA" title="Abrir Hoy › Pendientes de la IA">
          IA
        </CocoaButton>
      ) : null}
    </span>
  );
}

export default function MiDiaTabs() {
  return (
    <NavItemTabs
      screenKey="FrontDeskDashboard"
      loaders={LOADERS}
      baseRoles={BASE_TAB_ROLES}
      subtitle="Lo que pasa hoy en la propiedad, visto desde recepción, operaciones, dirección o propiedad."
      actions={<PendingCard />}
    />
  );
}

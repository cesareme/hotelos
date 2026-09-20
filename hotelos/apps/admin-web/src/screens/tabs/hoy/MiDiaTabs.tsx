// Mi día — /hoy (Tanda 5 · L1a · lote tabs-a; Tanda 8a · L4).
//
// Item `FrontDeskDashboard` of the tree: base tab «Recepción» (FrontDeskDashboard)
// plus Operaciones (OperationsDirectorScreen, /hoy/operaciones), Dirección
// (GeneralManagerScreen, /hoy/direccion) and Propietario (OwnerHome,
// /hoy/propietario). The landing tab is the role home (§3): recepción stays on
// Recepción, pisos/mantenimiento/fnb land on Operaciones, revenue/finanzas/
// comercial on Dirección, the owner template on Propietario. The base tab is
// painted only for the roles whose day starts at the front desk (§3 lists
// «Mi día [Operaciones]» for pisos and «Mi día [Dirección]» for revenue);
// Tanda 8a adds the hotel clerk (`administracion`), the owner (`propiedad`)
// and the internal auditor (`auditoria`) to it.
//
// «Pendientes de aprobación» (design §4.9): every role holding an approval
// key (`*.approve` / `*_approve` in the real grants of the property) sees in
// the header a card with the count of pending requests it may decide
// (GET /approvals, filtered by the service) that opens Hoy › Pendientes de
// aprobación. Cocoa 22: CocoaButton + CocoaBadge, no inline style.
//
// L1b registers: screenKey FrontDeskDashboard · url /hoy · tabs /hoy/operaciones,
// /hoy/direccion, /hoy/propietario; Tanda CHK adds /hoy/check-in-automatizado
// (CheckInAutomationSettingsScreen, roles recepcion · direccion · admin · auditoria).

import { useEffect, useState } from "react";
import { CocoaBadge } from "../../../components/cocoa/CocoaBadge";
import { CocoaButton } from "../../../components/cocoa/CocoaButton";
import { navigateTo } from "../../../lib/navigate";
import { useNavGate } from "../../../navigation/useEnabledModules";
import { listPendingApprovals } from "../../../services/approvalsApi";
import { getUser } from "../../../services/auth-storage";
import { useCurrentUserProfile } from "../../../services/usersApi";
import { hasApprovalKeys, pendingForViewer, viewerFromProfile } from "../../approvals/approvals-helpers";
import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";

const LOADERS: TabLoaders = {
  FrontDeskDashboard: () => import("../../operations/FrontDeskDashboard").then((m) => ({ default: m.FrontDeskDashboard })),
  OperationsDirectorScreen: () => import("../../operations/OperationsDirectorScreen").then((m) => ({ default: m.OperationsDirectorScreen })),
  GeneralManagerScreen: () => import("../../operations/GeneralManagerScreen").then((m) => ({ default: m.GeneralManagerScreen })),
  OwnerHome: () => import("../../owner/OwnerHomeScreen").then((m) => ({ default: m.OwnerHomeScreen })),
  // Tanda CHK · W4-B: ajustes del check-in automatizado (política, pesos, kioscos, métricas), /hoy/check-in-automatizado.
  CheckInAutomationSettingsScreen: () => import("../../operations/CheckInAutomationSettingsScreen").then((m) => ({ default: m.CheckInAutomationSettingsScreen }))
};

/** Roles whose Mi día includes the front-desk view (the rest land on their own tab). */
const BASE_TAB_ROLES = ["recepcion", "direccion", "admin", "administracion", "propiedad", "auditoria"] as const;

/** Header card «Pendientes de aprobación»: only for a profile that approves something; the count comes from GET /approvals. */
function PendingApprovalsCard() {
  const gate = useNavGate();
  const { profile } = useCurrentUserProfile();
  const approver = hasApprovalKeys(gate.grantedPermissions);
  const [count, setCount] = useState<number | null>(null);

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

  if (!approver) return null;
  return (
    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("ApprovalsInbox")} title="Solicitudes de aprobación que puedes decidir">
      Pendientes de aprobación
      {count !== null ? (
        <CocoaBadge tone={count > 0 ? "warning" : "neutral"} size="small" uppercase={false}>
          {count}
        </CocoaBadge>
      ) : null}
    </CocoaButton>
  );
}

export default function MiDiaTabs() {
  return (
    <NavItemTabs
      screenKey="FrontDeskDashboard"
      loaders={LOADERS}
      baseRoles={BASE_TAB_ROLES}
      subtitle="Lo que pasa hoy en la propiedad, visto desde recepción, operaciones, dirección o propiedad."
      actions={<PendingApprovalsCard />}
    />
  );
}

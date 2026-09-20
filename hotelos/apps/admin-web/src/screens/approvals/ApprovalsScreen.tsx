// Hoy › Pendientes de aprobación — /hoy/pendientes (Tanda 8a · L4, design §5.7).
//
// The maker/checker inbox of `approval_requests`: GET /approvals lists what
// the signed-in user may decide (the `*_approve` key of the kind in the
// property, `APPROVAL_KIND_PERMISSION`) plus their own requests; pending by
// default, filters by kind and status. A row opens a CocoaDrawer with the
// amount, the tier (`thresholdTier`), the second approver when the amount is
// above T4, the requester and the expiry; «Aprobar» / «Rechazar» (with a note,
// mandatory to reject) call POST /approvals/:id/approve · /reject. The user's
// own requests never show the buttons (dynamic SoD: nobody approves what
// they asked for — 409 APPROVAL_SELF_DECISION, explained in the drawer).
//
// The supervisor PIN (components/SupervisorPinDialog.tsx, design §5.6) is
// NOT mounted here (corrector 8a · FX-03): it belongs to the action of the
// operative who lacks the key (the refund dialog, the reception override, the
// POS void), which resends the authorisation id as `supervisorAuthorizationId`;
// the decision routes only accept `note`. The drawer shows names, never cuids
// (FX-11), and decides with the keys of the HOTEL OF THE REQUEST (FX-09).
//
// Cocoa 22: CocoaPage host, CocoaTable, CocoaDrawer, CocoaDialog, CocoaState,
// CocoaBadge, CocoaCallout; zero inline style; Spanish only; every call through
// services/approvalsApi.ts and services/rbacApi.ts (apiRequest).
//
// Tanda UX-2 · D5 (docs/design/UX-DIRECCION-FEEL.md §1 P1/P2/P4, F-D7; d2 ≤ 3
// clicks from Mi día): every decidable row carries ONE primary «Aprobar»
// (`filled small`, ⌥A on the selected — or first decidable — row) and a
// `bordered` «Rechazar» (`primaryDecisionFor`), always visible; the row itself
// still opens the detail drawer (click, Enter or Space) and ↑↓ move the
// selection between rows without opening it. The decision dialog is nominal
// («Aprobar reembolso de 60,00 €», same text on its button), confirms with
// Enter when the note is optional, waits for the API (money: no optimism, P4)
// and toasts «Aprobada: reembolso 60,00 € · solicitud K3M9Q2». ⌘K: «Aprobar /
// Rechazar la solicitud seleccionada».

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ApprovalKind, ApprovalRequestDto, ApprovalStatus } from "@hotelos/shared";
import { useToast } from "../../components/Toast";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { DIRECCION_PENDIENTES_INSTRUCTIONS } from "../../content/screen-instructions/direccion";
import { dateTime, money, plural } from "../../lib/format";
import { useNavGate } from "../../navigation/useEnabledModules";
import { approveRequest, listApprovals, rejectRequest } from "../../services/approvalsApi";
import { getUser } from "../../services/auth-storage";
import { useCurrentUserProfile } from "../../services/usersApi";
import { useTabHost } from "../tabs/TabHost";
import {
  APPROVAL_KIND_LABELS_ES,
  APPROVAL_STATUS_LABELS_ES,
  KIND_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  THRESHOLD_TIER_LABELS_ES,
  approvalErrorMessage,
  approvingKeyOf,
  decisionDialogTitle,
  decisionFor,
  decisionToast,
  filterApprovals,
  isApprovalKind,
  isApprovalStatus,
  isExpired,
  pendingForViewer,
  primaryDecisionFor,
  secondApproverNote,
  viewerFromProfile,
  type ApprovalFilters,
  type ApprovalViewer
} from "./approvals-helpers";

const STATUS_TONE: Record<ApprovalStatus, CocoaTone> = { pending: "warning", approved: "success", rejected: "danger", expired: "neutral" };

/** Spanish label of the entity a request points at (the drawer never shows a raw type nor a cuid). */
const ENTITY_TYPE_LABELS_ES: Record<string, string> = {
  payment: "Cobro",
  folio: "Folio",
  reservation: "Reserva",
  invoice: "Factura",
  supplier_bill: "Factura de proveedor",
  purchase_order: "Pedido de compra",
  payroll_period: "Registro de nómina",
  capex_project: "Proyecto CAPEX",
  night_audit_run: "Cierre del día",
  rate_change: "Cambio de tarifa"
};

type Decision = "approve" | "reject";

function statusBadge(request: ApprovalRequestDto) {
  const expired = isExpired(request);
  return (
    <CocoaBadge tone={expired ? "neutral" : STATUS_TONE[request.status]} uppercase={false}>
      {expired ? APPROVAL_STATUS_LABELS_ES.expired : APPROVAL_STATUS_LABELS_ES[request.status]}
    </CocoaBadge>
  );
}

export function ApprovalsScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const gate = useNavGate();
  const { profile } = useCurrentUserProfile();
  // The keys of EVERY hotel of the session (FX-09): a request of B is decided with the keys held in B.
  const viewer = useMemo<ApprovalViewer>(
    () => viewerFromProfile({ userId: getUser()?.userId ?? null, grantedPermissions: gate.grantedPermissions, isPlatformAdmin: gate.isPlatformAdmin, properties: profile?.properties ?? null }),
    [gate.grantedPermissions, gate.isPlatformAdmin, profile]
  );

  const [filters, setFilters] = useState<ApprovalFilters>({ status: "pending", kind: "" });
  const [rows, setRows] = useState<ApprovalRequestDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // `selectedId` is the highlighted row (↑↓ move it, ⌥A / ⌘K act on it); the drawer opens only with `detailOpen`.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    listApprovals({ status: filters.status || undefined, kind: filters.kind || undefined })
      .then((list) => {
        if (!alive) return;
        setRows(list);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (!alive) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setRows([]);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filters.status, filters.kind, nonce]);

  const visible = useMemo(() => filterApprovals(rows ?? [], filters), [rows, filters]);
  const pendingMine = useMemo(() => pendingForViewer(rows ?? [], viewer), [rows, viewer]);
  const selected = selectedId ? (visible.find((row) => row.id === selectedId) ?? null) : null;
  const ability = selected ? decisionFor(selected, viewer) : null;
  // The row ⌥A and the ⌘K commands act on: the selected one, else the first the viewer may approve.
  const firstDecidable = useMemo(() => visible.find((row) => primaryDecisionFor(row, viewer) === "approve") ?? null, [visible, viewer]);
  const commandRow = selected ?? firstDecidable;
  const commandPrimary = commandRow ? primaryDecisionFor(commandRow, viewer) : null;

  function openDetail(id: string) {
    setSelectedId(id);
    setDetailOpen(true);
  }

  function closeDetail() {
    setDetailOpen(false);
    setDecision(null);
    setNote("");
  }

  function openDecision(row: ApprovalRequestDto, next: Decision) {
    setSelectedId(row.id);
    setDecision(next);
    setNote("");
  }

  function closeDecision() {
    setDecision(null);
    setNote("");
  }

  /** ↑↓ on a focused row move the selection (and the focus) without opening the drawer; Enter/Space open it (CocoaTable). */
  function moveSelection(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    if (target.tagName !== "TR") return;
    const domRows = Array.from(event.currentTarget.querySelectorAll<HTMLTableRowElement>('tbody tr[data-interactive="true"]'));
    const index = domRows.indexOf(target as HTMLTableRowElement);
    if (index < 0) return;
    const nextIndex = index + (event.key === "ArrowDown" ? 1 : -1);
    const nextRow = domRows[nextIndex];
    const nextData = visible[nextIndex];
    if (!nextRow || !nextData) return;
    event.preventDefault();
    nextRow.focus();
    setSelectedId(nextData.id);
  }

  async function decide() {
    if (!selected || !decision) return;
    if (decision === "reject" && !note.trim()) {
      showToast("Indica el motivo del rechazo", { variant: "error" });
      return;
    }
    setBusy(true);
    try {
      // Money: no optimism (P4) — the dialog spins until the API answers and the toast carries the number.
      const updated = decision === "approve" ? await approveRequest(selected.id, note.trim() || undefined) : await rejectRequest(selected.id, note.trim() || undefined);
      showToast(decisionToast(updated), { variant: "success" });
      closeDecision();
      closeDetail();
      refresh();
    } catch (failure) {
      showToast(approvalErrorMessage(failure), { variant: "error", duration: 7000 });
    } finally {
      setBusy(false);
    }
  }

  const columns: CocoaTableColumn<ApprovalRequestDto>[] = [
    { key: "kind", label: "Tipo", render: (row) => <strong>{APPROVAL_KIND_LABELS_ES[row.kind]}</strong> },
    { key: "amount", label: "Importe", align: "right", fit: true, render: (row) => money(row.amount, row.currency) },
    // Corrector UX2-REV-08: «Umbral» y «Solicitada» son secundarias (el cajón las repite); solo desde escritorio, para que la
    // columna «Acciones» con la primaria «Aprobar» quepa sin desplazamiento horizontal en tablet (1024) y portátil (≤ 1224).
    { key: "tier", label: "Umbral", fit: true, showFrom: "desktop", render: (row) => THRESHOLD_TIER_LABELS_ES[row.thresholdTier] },
    { key: "requester", label: "Solicitante", hideOnNarrow: true, truncate: 180, render: (row) => row.requestedByName ?? "—" },
    { key: "hotel", label: "Hotel", hideOnNarrow: true, truncate: 160, render: (row) => (row.propertyId ? (row.propertyName ?? "—") : "Sociedad") },
    { key: "requestedAt", label: "Solicitada", fit: true, showFrom: "desktop", render: (row) => dateTime(row.requestedAt, { style: "medium" }) },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (row) => (
        <span className="cocoa-cluster">
          {statusBadge(row)}
          {row.requiresSecondApproval ? (
            <CocoaBadge tone="info" size="small" uppercase={false}>
              Doble aprobación
            </CocoaBadge>
          ) : null}
          {viewer.userId !== null && row.requestedByUserId === viewer.userId ? (
            <CocoaBadge tone="neutral" size="small" uppercase={false}>
              Propia
            </CocoaBadge>
          ) : null}
        </span>
      )
    }
  ];

  let body;
  if (loading && rows === null) {
    body = <CocoaTable columns={columns} rows={[]} loading aria-label="Solicitudes de aprobación" />;
  } else if (error) {
    body = <CocoaState kind="error" title={STATUS_LABELS.loadError} message={error} onRetry={refresh} />;
  } else if (visible.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        title={filters.status === "pending" ? "Nada pendiente de aprobar" : "Sin solicitudes"}
        message="Aquí aparecen las solicitudes que puedes decidir con tus claves de aprobación y las que has pedido tú. Cambia los filtros para ver el histórico."
        primaryAction={filters.status !== "pending" || filters.kind !== "" ? { label: ACTIONS.clearFilters, onClick: () => setFilters({ status: "pending", kind: "" }) } : undefined}
      />
    );
  } else {
    body = (
      <div onKeyDown={moveSelection}>
        <CocoaTable
          columns={columns}
          rows={visible}
          rowKey="id"
          selectedKey={selected?.id}
          onSelect={(row) => openDetail(row.id)}
          rowTone={(row) => (row.status === "pending" && isExpired(row) ? "neutral" : undefined)}
          rowTitle={() => "Abrir el detalle de la solicitud"}
          caption="Solicitudes de aprobación"
          aria-label="Solicitudes de aprobación"
          rowActionsVisible="always"
          rowActions={(row) => {
            // P1: one primary per row («Aprobar» filled; «Rechazar» bordered); nothing on rows the viewer cannot decide.
            const primary = primaryDecisionFor(row, viewer);
            if (primary === null) return null;
            const keyed = row.id === (selected?.id ?? firstDecidable?.id);
            return (
              <>
                {primary === "approve" ? (
                  <CocoaButton variant="filled" tone="accent" size="small" accessKey={keyed ? "A" : undefined} disabled={busy} onClick={() => openDecision(row, "approve")} title={decisionDialogTitle("approve", row)}>
                    {ACTIONS.approve}
                  </CocoaButton>
                ) : null}
                <CocoaButton variant="bordered" tone="destructive" size="small" disabled={busy} onClick={() => openDecision(row, "reject")} title={decisionDialogTitle("reject", row)}>
                  {ACTIONS.reject}
                </CocoaButton>
              </>
            );
          }}
        />
      </div>
    );
  }

  const noteRequired = decision === "reject";
  // Nominal title = confirm button (P4): «Aprobar reembolso de 60,00 €», never «¿Aprobar…?».
  const dialogTitle = decision && selected ? decisionDialogTitle(decision, selected) : ACTIONS.approve;

  return (
    <CocoaPage
      eyebrow="Hoy · Pendientes de aprobación"
      title="Pendientes de aprobación"
      subtitle={hosted ? undefined : "Solicitudes de reembolso, ajuste, descuento, tarifa, factura de proveedor, pedido, nómina, CAPEX, anulación y reapertura del día. Quien solicita nunca aprueba; por encima de T4 hacen falta dos firmas."}
      actions={
        <>
          <CocoaBadge tone={pendingMine.length > 0 ? "warning" : "neutral"} uppercase={false} aria-label={`${pendingMine.length} solicitudes que puedes decidir`}>
            {plural(pendingMine.length, "pendiente que puedes decidir", "pendientes que puedes decidir")}
          </CocoaBadge>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "approvals-refresh", label: `${ACTIONS.refresh} solicitudes`, run: refresh },
        ...(commandRow && commandPrimary === "approve"
          ? [{ id: "approvals-approve-selected", label: selected ? "Aprobar la solicitud seleccionada" : "Aprobar la primera solicitud pendiente", shortcut: "⌥A", run: () => openDecision(commandRow, "approve") }]
          : []),
        ...(commandRow && commandPrimary !== null
          ? [{ id: "approvals-reject-selected", label: selected ? "Rechazar la solicitud seleccionada" : "Rechazar la primera solicitud pendiente", run: () => openDecision(commandRow, "reject") }]
          : [])
      ]}
    >
      <CocoaSection title="Filtros" aria-label="Filtros de la bandeja">
        <CocoaFormRow columns={2} role="group" aria-label="Filtros">
          <CocoaField label="Estado">
            <CocoaSelect
              value={filters.status}
              onChange={(value) => setFilters((current) => ({ ...current, status: isApprovalStatus(value) ? value : "" }))}
              options={[{ value: "", label: "Todos los estados" }, ...STATUS_FILTER_OPTIONS]}
              inline
            />
          </CocoaField>
          <CocoaField label="Tipo">
            <CocoaSelect
              value={filters.kind}
              onChange={(value) => setFilters((current) => ({ ...current, kind: isApprovalKind(value) ? (value as ApprovalKind) : "" }))}
              options={[{ value: "", label: "Todos los tipos" }, ...KIND_FILTER_OPTIONS]}
              inline
            />
          </CocoaField>
        </CocoaFormRow>
      </CocoaSection>

      <CocoaSection padding={visible.length > 0 && !loading && !error ? "none" : "md"} aria-label="Solicitudes" footer={visible.length > 0 ? <span>{plural(visible.length, "solicitud", "solicitudes")}</span> : undefined}>
        {body}
      </CocoaSection>

      {/* Ayuda contextual honesta (UX-2 · D8): solo lo que existe en esta bandeja; se descarta una vez. */}
      <CocoaScreenInstructionsCard {...DIRECCION_PENDIENTES_INSTRUCTIONS} dismissible persistKey="direccion-pendientes" />

      <CocoaDrawer
        open={detailOpen && selected !== null}
        onClose={closeDetail}
        title={selected ? APPROVAL_KIND_LABELS_ES[selected.kind] : "Solicitud"}
        subtitle={selected ? `${ENTITY_TYPE_LABELS_ES[selected.entityType] ?? selected.entityType}${selected.propertyId ? ` · ${selected.propertyName ?? "hotel"}` : " · sociedad"}` : undefined}
        side="right"
        size="md"
        dismissible={!busy}
        footer={
          selected ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={closeDetail} disabled={busy}>
                {ACTIONS.close}
              </CocoaButton>
              {ability?.canReject ? (
                <CocoaButton variant="bordered" tone="destructive" disabled={busy} onClick={() => setDecision("reject")}>
                  {ACTIONS.reject}
                </CocoaButton>
              ) : null}
              {ability?.canApprove ? (
                <CocoaButton variant="filled" tone="accent" disabled={busy} onClick={() => setDecision("approve")}>
                  {ACTIONS.approve}
                </CocoaButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <ul className="c22-section__list" aria-label="Datos de la solicitud">
              <li>
                <span>Estado</span>
                {statusBadge(selected)}
              </li>
              <li>
                <span>Importe</span>
                <strong>{money(selected.amount, selected.currency)}</strong>
              </li>
              <li>
                <span>Umbral aplicable</span>
                <strong>{THRESHOLD_TIER_LABELS_ES[selected.thresholdTier]}</strong>
              </li>
              <li>
                <span>Motivo</span>
                <strong>{selected.reasonText ? `${selected.reasonCode} · ${selected.reasonText}` : selected.reasonCode}</strong>
              </li>
              <li>
                <span>Solicitante</span>
                <strong>{selected.requestedByName ?? "Sin nombre"}</strong>
              </li>
              <li>
                <span>Entidad</span>
                <strong>{ENTITY_TYPE_LABELS_ES[selected.entityType] ?? selected.entityType}</strong>
              </li>
              <li>
                <span>Solicitada</span>
                <strong>{dateTime(selected.requestedAt, { style: "medium" })}</strong>
              </li>
              <li>
                <span>Caduca</span>
                <strong>{dateTime(selected.expiresAt, { style: "medium" })}</strong>
              </li>
              <li>
                <span>Hotel</span>
                <strong>{selected.propertyId ? (selected.propertyName ?? "Sin nombre") : "Toda la sociedad"}</strong>
              </li>
              {selected.decidedByUserId ? (
                <li>
                  <span>Decidida por</span>
                  <strong>{selected.decidedByName ?? "Sin nombre"}</strong>
                </li>
              ) : null}
              {selected.secondApproverUserId ? (
                <li>
                  <span>Segunda aprobación</span>
                  <strong>{selected.secondApproverName ?? "Sin nombre"}</strong>
                </li>
              ) : null}
              <li>
                <span>Clave que la decide</span>
                <code className="cocoa-mono">{approvingKeyOf(selected.kind)}</code>
              </li>
            </ul>

            {secondApproverNote(selected) ? (
              <CocoaCallout tone="info" title="Doble aprobación">
                {secondApproverNote(selected)}
              </CocoaCallout>
            ) : null}

            {ability && !ability.canApprove ? (
              <CocoaCallout tone={ability.own ? "warning" : "neutral"} title={ability.own ? "Solicitud propia" : "Sin decisión disponible"}>
                {ability.reason}
              </CocoaCallout>
            ) : null}
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={decision !== null && selected !== null}
        onClose={closeDecision}
        tone={decision === "reject" ? "destructive" : "primary"}
        title={dialogTitle}
        description={
          selected
            ? `${APPROVAL_KIND_LABELS_ES[selected.kind]} · ${money(selected.amount, selected.currency)} · ${THRESHOLD_TIER_LABELS_ES[selected.thresholdTier]}. La decisión queda en el registro de auditoría con tu usuario y la nota.`
            : undefined
        }
        confirmLabel={dialogTitle}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        confirmDisabled={noteRequired && !note.trim()}
        submitOnEnter={!noteRequired}
        onConfirm={decide}
      >
        <CocoaField label={noteRequired ? "Motivo del rechazo" : "Nota"} required={noteRequired} help={noteRequired ? "Obligatorio: el solicitante lo verá." : "Opcional."}>
          <CocoaInput value={note} onChange={setNote} multiline rows={3} maxLength={1000} disabled={busy} />
        </CocoaField>
      </CocoaDialog>

    </CocoaPage>
  );
}

export default ApprovalsScreen;

// Configuración › Usuarios y roles — /configuracion/usuarios (Tanda 8a · L4,
// design §5.4 / §5.5; replaces the Tanda 3 UserRoleManager, whose «Cambiar
// rol» wrote a free-text department label with no RBAC effect, H3).
//
// Two tabs over GET /rbac/users (users.read; the service filters the users
// whose assignments the caller's scope covers):
//   - «Este hotel» (`scopeType=property&ref=<active property>`): who works
//     in the active property, through a property assignment or a wider scope
//     that covers it;
//   - «Sociedad» (`scopeType=organization`): only for a caller with a live
//     organisation / sociedad assignment (`profile.scopes`) or the platform admin.
// Columns: usuario, plantilla RBAC real (`templateKey` → ROLE_TEMPLATE_LABELS_ES,
// never a department label), nivel, ámbito, hoteles, último acceso, estado, 2FA.
// Actions (the drawer of a row): Cambiar rol (POST /rbac/assignments FIRST,
// then DELETE /rbac/assignments/:id of the replaced ones — a 409
// RBAC_SOD_CONFLICT / 403 of the creation leaves the user as it was, never
// without a role; corrector 8a · FX-05), Añadir hotel/grupo (POST /rbac/assignments), Retirar
// de este hotel (revokes the property assignments, never the user), Desactivar
// usuario (POST /backoffice/properties/:id/users/:userId/disable, the whole
// account), Restablecer PIN (POST /rbac/pin with the OWN password; for someone
// else only the notice), Reenviar invitación; the header invites with scope
// (POST …/users/invite with scopeType/scopeRef and a template of rank ≤ own)
// and opens the template comparator (RoleComparePane). The emergency template
// is never offered (§4.8) and nobody acts on their own row (§1).
// Errors: the Spanish message of `details.code` (RBAC_LEVEL_EXCEEDED,
// RBAC_SCOPE_EXCEEDED, RBAC_SOD_CONFLICT, RBAC_SELF_ASSIGNMENT…).
// Cocoa 22: CocoaPage host with tabs, CocoaTable, CocoaDrawer, CocoaDialog,
// CocoaState, CocoaBadge, CocoaCallout; zero inline style; Spanish only; every
// call through services/rbacApi.ts and services/authApi.ts (apiRequest).

import { useCallback, useEffect, useMemo, useState } from "react";
import { ROLE_PERMISSION_MAP, ROLE_TEMPLATE_LEVEL, type RbacUserRowDto, type ScopeType, type UserRoleAssignmentDto } from "@hotelos/shared";
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
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { dateTime, plural } from "../../lib/format";
import { useNavGate } from "../../navigation/useEnabledModules";
import { getActivePropertyId, loadSwitchableProperties, type SwitchableProperty } from "../../services/activeProperty";
import { copyText, describeDelivery, reissueBackOfficeInvitation } from "../../services/authApi";
import { getUser } from "../../services/auth-storage";
import {
  createAssignment,
  disableUser,
  inviteUserWithScope,
  listAssignableRoles,
  listPropertyGroupsIfAllowed,
  listUsersInScope,
  rbacErrorMessage,
  revokeAssignment,
  setOwnPin,
  type PropertyRoleDto
} from "../../services/rbacApi";
import { hasWideScope, templateKeysForProperty, useCurrentUserProfile } from "../../services/usersApi";
import type { PropertyGroupDto } from "@hotelos/shared";
import { useTabHost } from "../tabs/TabHost";
import { AssignmentDrawer, type AssignmentCaller, type AssignmentMode, type AssignmentSubmit } from "./AssignmentDrawer";
import { RoleComparePane } from "./RoleComparePane";
import {
  assignmentsCovering,
  canManageRow,
  hotelsOf,
  isRoleKey,
  levelLabel,
  primaryAssignment,
  rankOfTemplate,
  scopeLabel,
  statusLabel,
  templateLabel,
  callerMaxRank
} from "./users-rbac";

type UsersTab = "hotel" | "sociedad";

const TABS: Array<{ value: UsersTab; label: string }> = [
  { value: "hotel", label: "Este hotel" },
  { value: "sociedad", label: "Sociedad" }
];

const STATUS_TONE: Record<string, CocoaTone> = { active: "success", invited: "warning", disabled: "danger", emergency: "neutral" };

type PendingAction = { kind: "retire" } | { kind: "disable" } | { kind: "revoke"; assignment: UserRoleAssignmentDto } | null;

export function UsersRolesScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const propertyId = getActivePropertyId();
  const gate = useNavGate(propertyId);
  const { profile } = useCurrentUserProfile();
  const sessionUserId = getUser()?.userId ?? null;

  const granted = gate.grantedPermissions ?? [];
  const isPlatformAdmin = gate.isPlatformAdmin;
  const can = useCallback((key: string) => isPlatformAdmin || granted.includes(key), [isPlatformAdmin, granted]);
  const canRead = can("users.read");
  const canAssign = can("users.assign");
  const canInvite = can("users.invite");
  const canDisable = can("users.disable");
  const wideScope = isPlatformAdmin || hasWideScope(profile);
  const tabs = useMemo(() => (wideScope ? TABS : TABS.filter((tab) => tab.value === "hotel")), [wideScope]);

  const caller = useMemo<AssignmentCaller>(
    () => ({
      rank: callerMaxRank(profile ? templateKeysForProperty(profile, propertyId) : []),
      scopes: (profile?.scopes ?? []).map((scope) => scope.scopeType as ScopeType),
      isPlatformAdmin
    }),
    [profile, propertyId, isPlatformAdmin]
  );
  // Corrector 8a (FX-07): the groups a director of operations can assign are
  // its OWN groups (`profile.scopes[].ref`), even without
  // organization.structure.manage to list every group of the organisation.
  const ownGroups = useMemo<PropertyGroupDto[]>(
    () =>
      (profile?.scopes ?? [])
        .filter((scope) => scope.scopeType === "property_group")
        .map((scope) => ({ id: scope.ref, organizationId: profile?.organizationId ?? "", code: scope.ref.slice(-6).toUpperCase(), name: `Grupo de ${plural(scope.propertyIds.length, "hotel", "hoteles")}`, propertyIds: [...scope.propertyIds] })),
    [profile]
  );

  const [tab, setTab] = useState<UsersTab>("hotel");
  const [rows, setRows] = useState<RbacUserRowDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [roles, setRoles] = useState<PropertyRoleDto[]>([]);
  const [properties, setProperties] = useState<SwitchableProperty[]>([]);
  const [groups, setGroups] = useState<PropertyGroupDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<AssignmentMode | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ email: string; inviteUrl: string; expiresAt: string; delivery: string } | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinPassword, setPinPassword] = useState("");
  const [pinValue, setPinValue] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!canRead) {
      setRows([]);
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    const request = tab === "hotel" ? listUsersInScope({ scopeType: "property", ref: propertyId }) : listUsersInScope({ scopeType: "organization" });
    request
      .then((list) => {
        if (!alive) return;
        setRows(list);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (!alive) return;
        setError(rbacErrorMessage(failure, "No se han podido cargar los usuarios."));
        setRows([]);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tab, propertyId, nonce, canRead]);

  // Catalogue for the drawers: roles the caller may hand out, the switchable properties and the groups (when readable).
  useEffect(() => {
    let alive = true;
    if (canInvite || canAssign) {
      listAssignableRoles(propertyId)
        .then((list) => {
          if (alive) setRoles(list);
        })
        .catch(() => {
          if (alive) setRoles([]);
        });
    }
    loadSwitchableProperties()
      .then((list) => {
        if (alive) setProperties(list);
      })
      .catch(() => {
        if (alive) setProperties([]);
      });
    listPropertyGroupsIfAllowed()
      .then((list) => {
        if (alive) setGroups(list);
      })
      .catch(() => {
        if (alive) setGroups([]);
      });
    return () => {
      alive = false;
    };
  }, [propertyId, canInvite, canAssign, nonce]);

  const propertyNames = useMemo(() => new Map(properties.map((property) => [property.id, property.name])), [properties]);
  const users = rows ?? [];
  const selected = selectedId ? (users.find((row) => row.userId === selectedId) ?? null) : null;
  const selectedPrimary = selected ? primaryAssignment(selected.assignments) : null;
  const selectedTemplates = useMemo(() => (selected ? [...new Set(selected.assignments.filter((row) => row.revokedAt === null).map((row) => row.templateKey).filter(Boolean))] : []) as string[], [selected]);
  const selectedHereAssignments = selected ? assignmentsCovering(selected.assignments, propertyId).filter((row) => row.scopeType === "property") : [];
  const selfRow = selected !== null && selected.userId === sessionUserId;
  const manageable = selected ? canManageRow(selected.userId, sessionUserId) : false;

  const compareRoles = useMemo(
    () => roles.map((role) => ({ id: role.id, name: role.name, templateKey: role.templateKey, permissions: isRoleKey(role.templateKey) ? ROLE_PERMISSION_MAP[role.templateKey] : [] })),
    [roles]
  );

  function closeDetail() {
    setSelectedId(null);
    setPending(null);
    setPinOpen(false);
  }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      showToast(label, { variant: "success" });
      refresh();
    } catch (failure) {
      showToast(rbacErrorMessage(failure), { variant: "error", duration: 7000 });
    } finally {
      setBusy(false);
    }
  }

  async function submitAssignment(input: AssignmentSubmit) {
    if (drawer === "invite") {
      if (!input.invite) return;
      setBusy(true);
      try {
        const result = await inviteUserWithScope(propertyId, {
          email: input.invite.email,
          fullName: input.invite.fullName,
          phone: input.invite.phone,
          roleId: input.roleId,
          mfaRequired: input.invite.mfaRequired,
          scopeType: input.scopeType,
          scopeRef: input.scopeRef
        });
        const delivery = describeDelivery(result.invitation.delivery as never, input.invite.email);
        setInviteResult({ email: input.invite.email, inviteUrl: result.invitation.inviteUrl, expiresAt: result.invitation.expiresAt, delivery: `${delivery.title}. ${delivery.detail}` });
        setDrawer(null);
        showToast(`Invitación creada para ${input.invite.email}`, { variant: "success" });
        refresh();
      } catch (failure) {
        showToast(rbacErrorMessage(failure, "No se ha podido crear la invitación."), { variant: "error", duration: 7000 });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!selected) return;
    if (drawer === "change") {
      // Create the new assignment FIRST, then revoke the replaced ones of the
      // same scope (design §5.4 «Cambiar rol»; corrector 8a · FX-05): a 409
      // RBAC_SOD_CONFLICT, a 403 of level / scope or a network failure on the
      // creation leaves the user exactly as it was — never without a role and
      // never with a ROLE_REVOKED without its ROLE_ASSIGNED. The SoD check of
      // the API runs over the live assignments PLUS the new role, so a change
      // inside the same scope (receptionist → front_office_manager) passes
      // whenever the target template is compatible with the OTHER scopes.
      await run(`Rol cambiado para ${selected.fullName}`, async () => {
        const toRevoke = selected.assignments.filter(
          (row) =>
            row.revokedAt === null &&
            row.roleId !== input.roleId &&
            row.scopeType === input.scopeType &&
            (input.scopeType === "organization" || row.propertyId === input.scopeRef || row.propertyGroupId === input.scopeRef || row.legalEntityId === input.scopeRef)
        );
        await createAssignment({ userId: selected.userId, roleId: input.roleId, scopeType: input.scopeType, scopeRef: input.scopeRef, reason: input.reason ?? "Cambio de rol", validTo: input.validTo });
        const failed: string[] = [];
        for (const row of toRevoke) {
          try {
            await revokeAssignment(row.id, input.reason ?? "Cambio de rol");
          } catch (failure) {
            failed.push(rbacErrorMessage(failure));
          }
        }
        if (failed.length > 0) throw new Error(`Rol nuevo asignado, pero ${plural(failed.length, "asignación anterior sigue activa", "asignaciones anteriores siguen activas")}: ${failed[0]}. Retírala desde «Asignaciones».`);
      });
      setDrawer(null);
      return;
    }
    await run(`Asignación añadida a ${selected.fullName}`, async () => {
      await createAssignment({ userId: selected.userId, roleId: input.roleId, scopeType: input.scopeType, scopeRef: input.scopeRef, reason: input.reason, validTo: input.validTo });
    });
    setDrawer(null);
  }

  async function confirmPending() {
    if (!selected || !pending) return;
    if (pending.kind === "disable") {
      await run(`Usuario ${selected.fullName} desactivado`, () => disableUser(propertyId, selected.userId).then(() => undefined));
      setPending(null);
      closeDetail();
      return;
    }
    if (pending.kind === "retire") {
      await run(`${selected.fullName} retirado de este hotel`, async () => {
        for (const row of selectedHereAssignments) await revokeAssignment(row.id, "Retirado del hotel");
      });
      setPending(null);
      return;
    }
    await run("Asignación retirada", () => revokeAssignment(pending.assignment.id, "Asignación retirada").then(() => undefined));
    setPending(null);
  }

  async function savePin() {
    if (!/^\d{4,8}$/.test(pinValue) || !pinPassword) return;
    await run("PIN de supervisor actualizado", () => setOwnPin({ password: pinPassword, pin: pinValue }).then(() => undefined));
    setPinOpen(false);
    setPinPassword("");
    setPinValue("");
  }

  async function reissue(target: RbacUserRowDto) {
    await run(`Invitación reenviada a ${target.email}`, () => reissueBackOfficeInvitation(propertyId, target.userId).then(() => undefined));
  }

  async function copyInvite() {
    if (!inviteResult) return;
    if (await copyText(inviteResult.inviteUrl)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  const columns: CocoaTableColumn<RbacUserRowDto>[] = [
    {
      key: "user",
      label: "Usuario",
      render: (row) => (
        <span className="cocoa-stack" data-gap="0">
          <strong>{row.fullName}</strong>
          <span className="cocoa-note">{row.email}</span>
        </span>
      )
    },
    {
      key: "template",
      label: "Plantilla RBAC",
      render: (row) => {
        const primary = primaryAssignment(row.assignments);
        const live = row.assignments.filter((assignment) => assignment.revokedAt === null).length;
        return (
          <span className="cocoa-cluster">
            <strong>{primary ? templateLabel(primary.templateKey, primary.roleName) : "Sin rol"}</strong>
            {live > 1 ? (
              <CocoaBadge tone="neutral" size="small" uppercase={false}>
                +{live - 1}
              </CocoaBadge>
            ) : null}
          </span>
        );
      }
    },
    { key: "level", label: "Nivel", hideOnNarrow: true, render: (row) => levelLabel(primaryAssignment(row.assignments)?.level ?? null) },
    { key: "scope", label: "Ámbito", fit: true, hideOnNarrow: true, render: (row) => scopeLabel(primaryAssignment(row.assignments)?.scopeType ?? null) },
    { key: "hotels", label: "Hoteles", showFrom: "laptop", truncate: 260, render: (row) => hotelsOf(row.assignments, propertyNames).join(", ") || "—" },
    { key: "lastLoginAt", label: "Último acceso", fit: true, showFrom: "laptop", render: (row) => dateTime(row.lastLoginAt, { style: "medium" }) },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (row) => (
        <CocoaBadge tone={STATUS_TONE[row.status] ?? "info"} uppercase={false}>
          {statusLabel(row.status)}
        </CocoaBadge>
      )
    },
    {
      key: "mfa",
      label: "2FA",
      fit: true,
      hideOnNarrow: true,
      render: (row) => (
        <CocoaBadge tone={row.mfaEnabled ? "success" : "neutral"} size="small" uppercase={false}>
          {row.mfaEnabled ? "Activo" : "No"}
        </CocoaBadge>
      )
    }
  ];

  let body;
  if (!canRead) {
    body = <CocoaState kind="empty" title="Sin acceso a la lista de usuarios" message="Leer los usuarios exige la clave «users.read» en este hotel. Pide acceso a dirección." />;
  } else if (loading && rows === null) {
    body = <CocoaTable columns={columns} rows={[]} loading aria-label="Usuarios" />;
  } else if (error) {
    body = <CocoaState kind="error" title={STATUS_LABELS.loadError} message={error} onRetry={refresh} />;
  } else if (users.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        title={tab === "hotel" ? "Nadie asignado a este hotel" : "Sin usuarios en tu ámbito"}
        message="Invita a la primera persona con su rol y su ámbito; quedará asignada al aceptar el enlace."
        primaryAction={canInvite ? { label: "Invitar con ámbito", onClick: () => setDrawer("invite") } : undefined}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={columns}
        rows={users}
        rowKey="userId"
        selectedKey={selected?.userId}
        onSelect={(row) => setSelectedId(row.userId)}
        rowActions={(row) =>
          row.status === "invited" && canInvite ? (
            <CocoaButton
              variant="plain"
              size="small"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void reissue(row);
              }}
            >
              {ACTIONS.resend}
            </CocoaButton>
          ) : null
        }
        caption={tab === "hotel" ? "Usuarios de este hotel" : "Usuarios de la sociedad"}
        aria-label={tab === "hotel" ? "Usuarios de este hotel" : "Usuarios de la sociedad"}
      />
    );
  }

  const ready = canRead && !loading && !error && users.length > 0;

  return (
    <CocoaPage
      eyebrow="Configuración · Usuarios y roles"
      title="Usuarios y roles"
      subtitle={hosted ? undefined : "Quién trabaja en cada hotel y con qué plantilla: asignaciones por hotel, grupo, sociedad u organización; invitaciones con ámbito; separación de funciones. Todo cambio queda en el registro de auditoría."}
      tabs={tabs}
      activeTab={tab}
      onTabChange={(value) => {
        setTab(value === "sociedad" ? "sociedad" : "hotel");
        closeDetail();
      }}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setCompareOpen(true)}>
            Comparar plantillas
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
          {canInvite ? (
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setDrawer("invite")} disabled={busy}>
              Invitar con ámbito
            </CocoaButton>
          ) : null}
        </>
      }
      commands={[
        { id: "users-invite", label: "Invitar con ámbito", run: () => setDrawer("invite") },
        { id: "users-compare", label: "Comparar plantillas", run: () => setCompareOpen(true) },
        { id: "users-refresh", label: `${ACTIONS.refresh} usuarios`, run: refresh }
      ]}
    >
      {inviteResult ? (
        <CocoaCallout
          tone="success"
          title={`Invitación creada para ${inviteResult.email}`}
          role="status"
          actions={
            <>
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void copyInvite()}>
                {copied ? "Copiado" : "Copiar enlace"}
              </CocoaButton>
              <CocoaButton variant="plain" size="small" onClick={() => setInviteResult(null)}>
                {ACTIONS.close}
              </CocoaButton>
            </>
          }
        >
          {inviteResult.delivery} Caduca el {dateTime(inviteResult.expiresAt, { style: "medium" })}. El enlace es de un solo uso.
        </CocoaCallout>
      ) : null}

      <CocoaSection padding={ready ? "none" : "md"} aria-label="Usuarios" footer={ready ? <span>{plural(users.length, "usuario", "usuarios")}</span> : undefined}>
        {body}
      </CocoaSection>

      <CocoaDrawer
        open={selected !== null}
        onClose={closeDetail}
        title={selected?.fullName ?? "Usuario"}
        subtitle={selected?.email}
        side="right"
        size="md"
        dismissible={!busy}
        footer={
          selected ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={closeDetail} disabled={busy}>
                {ACTIONS.close}
              </CocoaButton>
              {manageable && canDisable && selected.status !== "disabled" ? (
                <CocoaButton variant="bordered" tone="destructive" disabled={busy} onClick={() => setPending({ kind: "disable" })}>
                  Desactivar usuario
                </CocoaButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <ul className="c22-section__list" aria-label="Datos del usuario">
              <li>
                <span>Estado</span>
                <CocoaBadge tone={STATUS_TONE[selected.status] ?? "info"} uppercase={false}>
                  {statusLabel(selected.status)}
                </CocoaBadge>
              </li>
              <li>
                <span>Plantilla principal</span>
                <strong>{selectedPrimary ? templateLabel(selectedPrimary.templateKey, selectedPrimary.roleName) : "Sin rol"}</strong>
              </li>
              <li>
                <span>Nivel</span>
                <strong>{levelLabel(selectedPrimary?.level ?? (isRoleKey(selectedPrimary?.templateKey) ? ROLE_TEMPLATE_LEVEL[selectedPrimary.templateKey] : null))}</strong>
              </li>
              <li>
                <span>2FA</span>
                <strong>{selected.mfaEnabled ? "Activo" : "No activo"}</strong>
              </li>
              <li>
                <span>Último acceso</span>
                <strong>{dateTime(selected.lastLoginAt, { style: "medium" })}</strong>
              </li>
              <li>
                <span>Identificador</span>
                <code className="cocoa-mono">{selected.userId}</code>
              </li>
            </ul>

            {selfRow ? (
              <CocoaCallout tone="info" title="Es tu propio usuario">
                Nadie se concede permisos a sí mismo: pide a otra persona de dirección o de sistemas que cambie tus asignaciones. Aquí solo puedes establecer tu PIN de supervisor.
              </CocoaCallout>
            ) : null}

            <CocoaSection
              title="Asignaciones"
              meta={plural(selected.assignments.filter((row) => row.revokedAt === null).length, "activa", "activas")}
              headingLevel={3}
              action={
                manageable && canAssign ? (
                  <CocoaButton variant="plain" size="small" disabled={busy} onClick={() => setDrawer("add-scope")}>
                    Añadir hotel o grupo
                  </CocoaButton>
                ) : undefined
              }
            >
              {selected.assignments.length === 0 ? (
                <CocoaState kind="empty" inline title="Sin asignaciones en tu ámbito." />
              ) : (
                <ul className="c22-section__list" aria-label="Asignaciones del usuario">
                  {selected.assignments.map((assignment) => (
                    <li key={assignment.id}>
                      <span className="cocoa-stack" data-gap="0">
                        <strong>{templateLabel(assignment.templateKey, assignment.roleName)}</strong>
                        <span className="cocoa-note">
                          {scopeLabel(assignment.scopeType)}
                          {assignment.scopeType === "property" && assignment.propertyId ? ` · ${propertyNames.get(assignment.propertyId) ?? assignment.propertyId}` : ""}
                          {assignment.validTo ? ` · hasta ${dateTime(assignment.validTo, { style: "medium" })}` : ""}
                          {` · rango ${rankOfTemplate(assignment.templateKey) ?? "—"}`}
                        </span>
                      </span>
                      <span className="cocoa-cluster">
                        <CocoaBadge tone={assignment.revokedAt ? "neutral" : "success"} size="small" uppercase={false}>
                          {assignment.revokedAt ? "Revocada" : STATUS_LABELS.active}
                        </CocoaBadge>
                        {manageable && canAssign && !assignment.revokedAt ? (
                          <CocoaButton variant="plain" size="small" tone="destructive" disabled={busy} onClick={() => setPending({ kind: "revoke", assignment })}>
                            Retirar
                          </CocoaButton>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CocoaSection>

            {manageable && canAssign ? (
              <CocoaSection title="Acciones sobre el rol" headingLevel={3}>
                <div className="cocoa-row" data-gap="2" data-wrap="wrap">
                  <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => setDrawer("change")}>
                    Cambiar rol
                  </CocoaButton>
                  {selectedHereAssignments.length > 0 ? (
                    <CocoaButton variant="bordered" tone="destructive" size="small" disabled={busy} onClick={() => setPending({ kind: "retire" })}>
                      Retirar de este hotel
                    </CocoaButton>
                  ) : null}
                  {selected.status === "invited" && canInvite ? (
                    <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => void reissue(selected)}>
                      Reenviar invitación
                    </CocoaButton>
                  ) : null}
                </div>
                <p className="cocoa-note">«Cambiar rol» crea primero la asignación nueva y después revoca la anterior del mismo ámbito (si la nueva se rechaza, nada cambia); «Retirar de este hotel» solo revoca las asignaciones de este hotel, nunca el usuario.</p>
              </CocoaSection>
            ) : null}

            <CocoaSection title="PIN de supervisor" headingLevel={3}>
              {selfRow ? (
                <div className="cocoa-stack" data-gap="2">
                  <p className="cocoa-note">El PIN autoriza acciones de otros compañeros (anular un tique, aplicar un descuento fuera de tu tramo) sin cederles tu sesión. Establecerlo exige tu contraseña; también puedes hacerlo desde el menú de usuario («Mi PIN de supervisor»).</p>
                  <div className="cocoa-row" data-gap="2">
                    <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy} onClick={() => setPinOpen(true)}>
                      Restablecer PIN
                    </CocoaButton>
                  </div>
                </div>
              ) : (
                <CocoaCallout tone="neutral" title="Solo el titular restablece su PIN">
                  Cada persona establece su PIN con su propia contraseña desde el menú de usuario («Mi PIN de supervisor», arriba a la derecha) en su sesión; nadie puede fijarle el PIN a otra persona.
                </CocoaCallout>
              )}
            </CocoaSection>
          </div>
        ) : null}
      </CocoaDrawer>

      <AssignmentDrawer
        open={drawer !== null}
        mode={drawer ?? "invite"}
        onClose={() => setDrawer(null)}
        onSubmit={submitAssignment}
        busy={busy}
        roles={roles}
        properties={properties}
        groups={groups.length > 0 ? groups : ownGroups}
        activePropertyId={propertyId}
        caller={caller}
        userTemplates={drawer === "invite" ? [] : selectedTemplates}
        replacingTemplate={drawer === "change" ? (selectedPrimary?.templateKey ?? null) : null}
        userName={drawer === "invite" ? null : (selected?.fullName ?? null)}
      />

      <CocoaDrawer open={compareOpen} onClose={() => setCompareOpen(false)} title="Comparar plantillas" subtitle="Claves por módulo del diccionario de RBAC y roles con permisos idénticos." side="right" size="lg">
        <RoleComparePane roles={compareRoles} />
      </CocoaDrawer>

      <CocoaDialog
        open={pending !== null && selected !== null}
        onClose={() => setPending(null)}
        tone="destructive"
        title={
          pending?.kind === "disable"
            ? `¿Desactivar a ${selected?.fullName ?? "este usuario"}?`
            : pending?.kind === "retire"
              ? `¿Retirar a ${selected?.fullName ?? "este usuario"} de este hotel?`
              : "¿Retirar esta asignación?"
        }
        description={
          pending?.kind === "disable"
            ? "Perderá el acceso a TODOS los hoteles de inmediato (el usuario entero, no solo este hotel). La acción queda en el registro de auditoría."
            : pending?.kind === "retire"
              ? `Se revocan ${plural(selectedHereAssignments.length, "asignación", "asignaciones")} de este hotel; el usuario conserva las de otros hoteles y ámbitos.`
              : "La asignación se revoca con motivo y queda en el registro de auditoría (ROLE_REVOKED)."
        }
        confirmLabel={pending?.kind === "disable" ? "Desactivar usuario" : "Retirar"}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={confirmPending}
      />

      <CocoaDialog
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        title="Restablecer mi PIN de supervisor"
        description="De 4 a 8 dígitos. Se guarda cifrado; cinco intentos fallidos lo bloquean 15 minutos."
        confirmLabel="Guardar PIN"
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        confirmDisabled={!pinPassword || !/^\d{4,8}$/.test(pinValue)}
        onConfirm={savePin}
      >
        <CocoaFormRow columns={1}>
          <CocoaField label="Tu contraseña" required>
            <CocoaInput value={pinPassword} onChange={setPinPassword} type="password" autoComplete="current-password" disabled={busy} />
          </CocoaField>
          <CocoaField label="Nuevo PIN" required>
            <CocoaInput value={pinValue} onChange={(value) => setPinValue(value.replace(/\D/g, "").slice(0, 8))} type="password" inputMode="numeric" autoComplete="off" maxLength={8} disabled={busy} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default UsersRolesScreen;

// Cajón de asignación (Tanda 8a · L4, design §5.4 / §5.5): the one form behind
// «Invitar con ámbito», «Cambiar rol» and «Añadir hotel/grupo» of Usuarios y
// roles. It picks a role of the organisation (only the templates of rank ≤ the
// caller's, `assignableTemplates`; never break_glass), a scope (property /
// grupo / sociedad / organización, only the scopes the caller holds,
// `scopeWithinReach`) and its reference, a reason and an optional expiry, and
// paints BEFORE the API answers:
//   - the separation-of-duties pairs the combination of the user's live
//     templates plus the chosen one would violate (users-rbac.ts
//     `sodWarningsFor`, a danger CocoaCallout — the API answers 409
//     RBAC_SOD_CONFLICT anyway);
//   - the level rule (`levelWarningFor`: 403 RBAC_LEVEL_EXCEEDED) and the
//     scope rule (403 RBAC_SCOPE_EXCEEDED); while a level or SoD warning is
//     painted the submit button is disabled (corrector 8a · FX-05).
// Invite mode adds the person (name, e-mail, phone, MFA). The submit handler
// belongs to the screen (revoke + create, or invite). Cocoa 22: zero inline style.

import { useEffect, useMemo, useState } from "react";
import { ROLE_TEMPLATE_LABELS_ES, SCOPE_TYPES, type PropertyGroupDto, type RoleKey, type ScopeType } from "@hotelos/shared";
import { CocoaButton, CocoaCallout, CocoaDrawer, CocoaField, CocoaFormSection, CocoaInput, CocoaSelect, CocoaSwitch } from "../../components/cocoa";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import type { SwitchableProperty } from "../../services/activeProperty";
import type { PropertyRoleDto } from "../../services/rbacApi";
import {
  SCOPE_LABELS_ES,
  assignableTemplates,
  describeSodWarning,
  isRoleKey,
  levelLabel,
  levelWarningFor,
  rankOfLevel,
  rankOfTemplate,
  scopeWithinReach,
  sodWarningsFor,
  templateLabel
} from "./users-rbac";

export type AssignmentMode = "invite" | "change" | "add-scope";

export type AssignmentCaller = {
  /** Highest rank of the caller's templates in the active property (null = none). */
  rank: number | null;
  /** Scope types of the caller's live assignments. */
  scopes: readonly ScopeType[];
  isPlatformAdmin: boolean;
};

export type AssignmentSubmit = {
  roleId: string;
  templateKey: string | null;
  scopeType: ScopeType;
  /** Id of the property / group / sociedad (undefined for organisation). */
  scopeRef?: string;
  reason?: string;
  /** ISO date-time with offset (end of the chosen day, Europe/Madrid is the API's business: sent as local midnight UTC offset). */
  validTo?: string;
  invite?: { email: string; fullName: string; phone?: string; mfaRequired: boolean };
};

export type AssignmentDrawerProps = {
  open: boolean;
  mode: AssignmentMode;
  onClose: () => void;
  onSubmit: (input: AssignmentSubmit) => Promise<void>;
  busy: boolean;
  /** Roles of the organisation the caller may hand out (GET /backoffice/properties/:id/roles). */
  roles: readonly PropertyRoleDto[];
  /** Properties the caller can switch to (GET /users/me/properties). */
  properties: readonly SwitchableProperty[];
  /** Property groups the caller may hand out: every group of the organisation (organization.structure.manage) or, failing that, the caller's own groups (`profile.scopes`). */
  groups: readonly PropertyGroupDto[];
  activePropertyId: string;
  caller: AssignmentCaller;
  /** Live template keys of the target user (for the SoD warnings); empty on invite. */
  userTemplates: readonly string[];
  /** Template the change replaces (excluded from the SoD union). */
  replacingTemplate?: string | null;
  userName?: string | null;
};

const TITLES: Record<AssignmentMode, string> = {
  invite: "Invitar con ámbito",
  change: "Cambiar rol",
  "add-scope": "Añadir hotel o grupo"
};

function roleRank(role: PropertyRoleDto): number | null {
  return rankOfTemplate(role.templateKey) ?? rankOfLevel(role.level);
}

/** Roles the caller may hand out: template of rank ≤ own (platform admin: all), never the emergency template. */
export function offerableRoles(roles: readonly PropertyRoleDto[], caller: AssignmentCaller): PropertyRoleDto[] {
  const templates = new Set<string>(assignableTemplates(caller.rank, caller.isPlatformAdmin));
  return roles.filter((role) => {
    if (role.templateKey === "break_glass") return false;
    if (role.templateKey) return templates.has(role.templateKey);
    const rank = rankOfLevel(role.level);
    return caller.isPlatformAdmin || (rank !== null && caller.rank !== null && rank <= caller.rank);
  });
}

/** Local day → ISO date-time with offset (23:59:59 of that day in the browser's zone). */
export function endOfDayIso(day: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const date = new Date(`${day}T23:59:59`);
  if (Number.isNaN(date.getTime())) return undefined;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  return `${day}T23:59:59${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

export function AssignmentDrawer(props: AssignmentDrawerProps) {
  const { open, mode, onClose, onSubmit, busy, roles, properties, groups, activePropertyId, caller, userTemplates, replacingTemplate, userName } = props;
  const [roleId, setRoleId] = useState("");
  const [scopeType, setScopeType] = useState<ScopeType>("property");
  const [scopeRef, setScopeRef] = useState(activePropertyId);
  const [reason, setReason] = useState("");
  const [validToDay, setValidToDay] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [mfa, setMfa] = useState(false);

  const offerable = useMemo(() => offerableRoles(roles, caller), [roles, caller]);
  const legalEntities = useMemo(() => {
    const seen = new Map<string, string>();
    for (const property of properties) if (property.legalEntityId) seen.set(property.legalEntityId, property.legalEntityName ?? property.legalEntityId);
    return [...seen.entries()].map(([id, name]) => ({ value: id, label: name }));
  }, [properties]);
  const scopeOptions = useMemo(
    () => SCOPE_TYPES.filter((scope) => scopeWithinReach(scope, caller.scopes, caller.isPlatformAdmin)).map((scope) => ({ value: scope, label: SCOPE_LABELS_ES[scope] })),
    [caller.scopes, caller.isPlatformAdmin]
  );

  // Fresh form on open (the role list may arrive after the drawer).
  useEffect(() => {
    if (!open) return;
    setRoleId("");
    setScopeType("property");
    setScopeRef(activePropertyId);
    setReason("");
    setValidToDay("");
    setFullName("");
    setEmail("");
    setPhone("");
    setMfa(false);
  }, [open, activePropertyId]);

  useEffect(() => {
    if (!open) return;
    setRoleId((current) => (current && offerable.some((role) => role.id === current) ? current : (offerable[0]?.id ?? "")));
  }, [open, offerable]);

  const role = offerable.find((candidate) => candidate.id === roleId) ?? null;
  const template = role?.templateKey ?? null;
  const rank = role ? roleRank(role) : null;
  const levelWarning = levelWarningFor(rank, caller.rank, caller.isPlatformAdmin);
  const combination = useMemo(() => [...userTemplates.filter((key) => key !== replacingTemplate), ...(template ? [template] : [])], [userTemplates, replacingTemplate, template]);
  const sodWarnings = useMemo(() => sodWarningsFor(combination), [combination]);

  const refOptions = useMemo(() => {
    switch (scopeType) {
      case "property":
        return properties.map((property) => ({ value: property.id, label: property.name }));
      case "property_group":
        return groups.map((group) => ({ value: group.id, label: `${group.name} (${group.code})` }));
      case "legal_entity":
        return legalEntities;
      default:
        return [];
    }
  }, [scopeType, properties, groups, legalEntities]);

  useEffect(() => {
    if (scopeType === "organization") {
      setScopeRef("");
      return;
    }
    setScopeRef((current) => (current && refOptions.some((option) => option.value === current) ? current : (refOptions[0]?.value ?? "")));
  }, [scopeType, refOptions]);

  const inviteValid = mode !== "invite" || (fullName.trim().length > 0 && email.trim().includes("@"));
  const scopeValid = scopeType === "organization" || scopeRef.length > 0;
  // Corrector 8a (FX-05): a painted level / SoD warning is a refusal the API would
  // give (403 RBAC_LEVEL_EXCEEDED / 409 RBAC_SOD_CONFLICT): the button stays off.
  const blocked = levelWarning !== null || sodWarnings.length > 0;
  const canSubmit = Boolean(role) && scopeValid && inviteValid && !blocked && !busy;

  async function submit() {
    if (!role || !canSubmit) return;
    await onSubmit({
      roleId: role.id,
      templateKey: template,
      scopeType,
      scopeRef: scopeType === "organization" ? undefined : scopeRef,
      reason: reason.trim() || undefined,
      validTo: endOfDayIso(validToDay),
      ...(mode === "invite" ? { invite: { email: email.trim(), fullName: fullName.trim(), phone: phone.trim() || undefined, mfaRequired: mfa } } : {})
    });
  }

  const confirmLabel = mode === "invite" ? "Crear invitación" : mode === "change" ? "Cambiar rol" : "Añadir asignación";

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title={TITLES[mode]}
      subtitle={userName ?? (mode === "invite" ? "La persona recibirá un enlace de un solo uso y quedará asignada al ámbito elegido al aceptarlo." : undefined)}
      side="right"
      size="md"
      dismissible={!busy}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={() => void submit()} disabled={!canSubmit} loading={busy}>
            {busy ? STATUS_LABELS.saving : confirmLabel}
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="4">
        {mode === "invite" ? (
          <CocoaFormSection title="Persona" columns={1}>
            <CocoaField label="Nombre completo" required>
              <CocoaInput value={fullName} onChange={setFullName} disabled={busy} autoComplete="off" placeholder="Marta Pérez" />
            </CocoaField>
            <CocoaField label="Correo electrónico" required>
              <CocoaInput value={email} onChange={setEmail} type="email" inputMode="email" disabled={busy} autoComplete="off" placeholder="marta@hotel.test" />
            </CocoaField>
            <CocoaField label="Teléfono" hint={STATUS_LABELS.optional.toLowerCase()}>
              <CocoaInput value={phone} onChange={setPhone} type="tel" inputMode="tel" disabled={busy} autoComplete="off" />
            </CocoaField>
            <CocoaField label="Exigir doble factor (2FA)" inline help="Deja la marca “2FA: Activo” en la ficha para cuando se active la verificación del segundo factor; hoy el acceso no la exige.">
              <CocoaSwitch checked={mfa} onChange={setMfa} disabled={busy} size="small" />
            </CocoaField>
          </CocoaFormSection>
        ) : null}

        <CocoaFormSection title="Rol y ámbito" columns={1} description="Solo puedes asignar roles de nivel igual o inferior al tuyo y dentro de tu ámbito; la API lo comprueba de nuevo.">
          <CocoaField
            label="Rol (plantilla)"
            required
            help={role ? `${templateLabel(role.templateKey, role.name)} · ${levelLabel(role.level)} · ${role.permissionsCount} claves` : undefined}
            error={offerable.length === 0 ? "Ningún rol de la organización está a tu alcance." : undefined}
          >
            <CocoaSelect
              value={roleId}
              onChange={setRoleId}
              disabled={busy || offerable.length === 0}
              placeholder={offerable.length === 0 ? "Sin roles disponibles" : undefined}
              options={offerable.map((candidate) => ({ value: candidate.id, label: `${templateLabel(candidate.templateKey, candidate.name)} · ${levelLabel(candidate.level)}` }))}
            />
          </CocoaField>
          <CocoaField label="Ámbito" required>
            <CocoaSelect value={scopeType} onChange={(value) => setScopeType(value as ScopeType)} disabled={busy} options={scopeOptions} />
          </CocoaField>
          {scopeType !== "organization" ? (
            <CocoaField label={SCOPE_LABELS_ES[scopeType]} required error={refOptions.length === 0 ? "No hay ninguno a tu alcance." : undefined}>
              <CocoaSelect value={scopeRef} onChange={setScopeRef} disabled={busy || refOptions.length === 0} options={refOptions} placeholder={refOptions.length === 0 ? "Sin opciones" : undefined} />
            </CocoaField>
          ) : null}
          <CocoaField label="Motivo" hint={STATUS_LABELS.optional.toLowerCase()} help="Queda en el registro de auditoría (ROLE_ASSIGNED).">
            <CocoaInput value={reason} onChange={setReason} disabled={busy} maxLength={500} />
          </CocoaField>
          <CocoaField label="Caduca el" hint={STATUS_LABELS.optional.toLowerCase()} help="Asignación temporal (refuerzos, sustituciones): al vencer deja de aplicarse.">
            <CocoaInput value={validToDay} onChange={setValidToDay} type="date" disabled={busy} />
          </CocoaField>
        </CocoaFormSection>

        {levelWarning ? (
          <CocoaCallout tone="danger" title="Nivel superior al tuyo" role="alert">
            {levelWarning}
          </CocoaCallout>
        ) : null}

        {sodWarnings.length > 0 ? (
          <CocoaCallout tone="danger" title="Separación de funciones" role="alert">
            <ul className="cocoa-stack" data-gap="1" aria-label="Pares incompatibles">
              {sodWarnings.map((warning) => (
                <li key={`${warning.pair.a}|${warning.pair.b}`}>{describeSodWarning(warning)}</li>
              ))}
            </ul>
            <p className="cocoa-note">La asignación no se envía (la API la rechazaría con 409 RBAC_SOD_CONFLICT). Elige otra plantilla o retira antes la que entra en conflicto.</p>
          </CocoaCallout>
        ) : null}

        {template && isRoleKey(template) ? (
          <p className="cocoa-note">
            Plantilla «{ROLE_TEMPLATE_LABELS_ES[template as RoleKey]}»: {combination.length > 1 ? `se combinará con ${combination.length - 1} plantilla(s) ya asignada(s).` : "sin otras plantillas activas."}
          </p>
        ) : null}
      </div>
    </CocoaDrawer>
  );
}

export default AssignmentDrawer;

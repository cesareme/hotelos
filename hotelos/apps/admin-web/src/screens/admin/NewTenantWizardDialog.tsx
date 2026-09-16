// NewTenantWizardDialog — platform-console provisioning wizard for a new tenant.
//
// Five steps in a CocoaDrawer: organization (with its implicit sociedad,
// Tanda 6b), first work centre, owner user, modules / plan, and a final
// summary that calls POST /admin/tenants. After a successful create the
// drawer shows the REAL outcome of the owner invitation (Tanda 3 ·
// CFG-P1-6): «enviada» only when the API's email provider accepted it,
// otherwise the copyable single-use invite link to hand over by another
// channel, plus «Reenviar invitación» (POST
// /admin/tenants/:orgId/users/:ownerUserId/reissue-invite). No temp password
// is ever displayed.
//
// Props:
//   open       — controls visibility
//   onClose    — fired on Cancel / scrim / Escape (never while submitting)
//   onCompleted(result) — called after the API returns; receives the full
//                         CreateTenantResponse so callers can refresh lists.
//
// Validation: each step has an `isStepValid` gate; «Siguiente» is disabled
// until the current step is complete. Step 4 pre-selects the modules of the
// chosen plan; PMS Core is always on.
//
// Cocoa 22 (lote 10-A · diálogo / drawer): CocoaDrawer (focus trap, Esc,
// scrim, bottom sheet on phones) → CocoaChart.Progress + step badges
// (`aria-current="step"`) → CocoaField + CocoaInput / CocoaSelect / CocoaSwitch
// → summary in `c22-section__list` → two-button footer (Anterior · Siguiente).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createTenant, reissueTenantInvitation, type CreateTenantResponse } from "../../services/tenantAdminApi";
import { copyText, describeDelivery, formatExpiry, type InvitationResult } from "../../services/authApi";
import { ACTIONS } from "../../content/actions";
// Tanda 6b (L6): the tenant is born with its implicit sociedad (NIF optional, checked live) and a typed first centre.
import { LEGAL_FORM_OPTIONS, PROPERTY_KIND_OPTIONS, normalizeStructureCode, normalizeTaxId, propertyKindLabel, structureCodeError, taxIdValidationMessage } from "../structure/structure-ui";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaSwitch,
  type CocoaTone
} from "../../components/cocoa";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewTenantWizardDialogProps {
  open: boolean;
  onClose: () => void;
  onCompleted: (result: CreateTenantResponse) => void;
}

type Plan = "starter" | "pro" | "enterprise";

interface WizardState {
  organizationName: string;
  country: string;
  contactEmail: string;
  /** Tanda 6b: the implicit sociedad of the tenant (all optional; the razón social defaults to the organization name). */
  legalName: string;
  taxId: string;
  legalEntityCode: string;
  legalForm: string;
  propertyName: string;
  propertyType: string;
  /** Tanda 6b: work-centre type and 2-6 character code of the first centre (derived from the name when empty). */
  propertyKind: string;
  propertyCode: string;
  municipality: string;
  province: string;
  ownerEmail: string;
  ownerFullName: string;
  ownerPhone: string;
  plan: Plan;
  modules: Record<string, boolean>;
}

interface ModuleDef {
  code: string;
  label: string;
  description: string;
  alwaysOn?: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const COUNTRIES = [
  { value: "ES", label: "España" },
  { value: "PT", label: "Portugal" },
  { value: "MX", label: "México" },
  { value: "FR", label: "Francia" },
  { value: "IT", label: "Italia" },
  { value: "DE", label: "Alemania" },
  { value: "GB", label: "Reino Unido" },
  { value: "US", label: "Estados Unidos" },
  { value: "AR", label: "Argentina" },
  { value: "CO", label: "Colombia" },
  { value: "CL", label: "Chile" },
  { value: "BR", label: "Brasil" }
];

const PROPERTY_TYPES = [
  { value: "urban", label: "Urbano" },
  { value: "beach", label: "Playa" },
  { value: "resort", label: "Resort" },
  { value: "boutique", label: "Boutique" },
  { value: "rural", label: "Rural" },
  { value: "business", label: "Negocios" },
  { value: "apart", label: "Apartamentos" }
];

const PLAN_OPTIONS: Array<{ value: Plan; label: string }> = [
  { value: "starter", label: "Starter" },
  { value: "pro", label: "Pro" },
  { value: "enterprise", label: "Enterprise" }
];

// The codes must match the canonical manifest of @hotelos/product
// (module-manifest.ts): the backend silently drops unknown codes and the
// tenant would be born without modules.
const MODULES: ModuleDef[] = [
  { code: "pms_core", label: "PMS Core", description: "Reservas, rooming, folios", alwaysOn: true },
  { code: "distribution_hub", label: "Channel Manager", description: "OTA y distribución" },
  { code: "revenue_profit_engine", label: "Revenue Manager", description: "Precios y previsión" },
  { code: "outlet_pos", label: "F&B / TPV", description: "Restaurante, bar, servicio de habitaciones" },
  { code: "guest_experience", label: "Experiencia del huésped", description: "Ventas adicionales, peticiones, bienestar" },
  { code: "compliance_hub", label: "Cumplimiento ES", description: "SES Hospedajes, AEAT" },
  { code: "ai_front_desk", label: "Operaciones con IA", description: "Copiloto operativo" },
  { code: "energy_sustainability", label: "ESRS", description: "Sostenibilidad e informes" },
  { code: "integration_marketplace", label: "Marketplace", description: "Extensiones de partners" }
];

const PLAN_MODULES: Record<Plan, string[]> = {
  starter: ["pms_core", "distribution_hub"],
  pro: ["pms_core", "distribution_hub", "revenue_profit_engine", "outlet_pos", "guest_experience", "compliance_hub"],
  enterprise: MODULES.map((m) => m.code)
};

const TOTAL_STEPS = 5;
const STEP_TITLES = ["Organización", "Centro de trabajo", "Usuario propietario", "Módulos y plan", "Confirmar"];

// The step list is a `.cocoa-cluster` of badges: no markers, no list inset.
const STEP_LIST_STYLE: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

function modulesForPlan(plan: Plan): Record<string, boolean> {
  const enabled = new Set(PLAN_MODULES[plan]);
  return Object.fromEntries(MODULES.map((m) => [m.code, Boolean(m.alwaysOn) || enabled.has(m.code)]));
}

function makeInitialState(): WizardState {
  return {
    organizationName: "",
    country: "ES",
    contactEmail: "",
    legalName: "",
    taxId: "",
    legalEntityCode: "",
    legalForm: "",
    propertyName: "",
    propertyType: "urban",
    propertyKind: "hotel",
    propertyCode: "",
    municipality: "",
    province: "",
    ownerEmail: "",
    ownerFullName: "",
    ownerPhone: "",
    plan: "pro",
    modules: modulesForPlan("pro")
  };
}

function isStepValid(step: number, s: WizardState): boolean {
  if (step === 1) {
    const taxIdOk = s.taxId.trim() === "" || taxIdValidationMessage(s.taxId) === null;
    return s.organizationName.trim().length > 0 && s.country.length > 0 && isEmail(s.contactEmail) && taxIdOk && structureCodeError(s.legalEntityCode) === null;
  }
  if (step === 2) {
    return s.propertyName.trim().length > 0 && s.propertyType.length > 0 && s.municipality.trim().length > 0 && s.province.trim().length > 0 && structureCodeError(s.propertyCode) === null;
  }
  if (step === 3) return isEmail(s.ownerEmail) && s.ownerFullName.trim().length > 0;
  if (step === 4) return Boolean(s.plan);
  if (step === 5) return true;
  return false;
}

/** authApi delivery tone («ok» / «warn» / «error») → Cocoa tone. */
const DELIVERY_TONE: Record<"ok" | "warn" | "error", CocoaTone> = { ok: "success", warn: "warning", error: "danger" };

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface StepProps {
  state: WizardState;
  setState: (next: WizardState) => void;
}

function StepOrganization({ state, setState }: StepProps) {
  const taxIdError = state.taxId.trim() !== "" ? (taxIdValidationMessage(state.taxId) ?? undefined) : undefined;
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaField label="Nombre de la organización" required>
        <CocoaInput value={state.organizationName} onChange={(v) => setState({ ...state, organizationName: v })} placeholder="Hoteles Mediterránea SL" autoComplete="organization" />
      </CocoaField>
      <CocoaField label="País" required>
        <CocoaSelect value={state.country} onChange={(v) => setState({ ...state, country: v })} options={COUNTRIES} />
      </CocoaField>
      <CocoaField label="Email de contacto" required help="Usado para facturación y comunicaciones críticas.">
        <CocoaInput value={state.contactEmail} onChange={(v) => setState({ ...state, contactEmail: v })} placeholder="cuentas@mediterranea.com" type="email" inputMode="email" autoComplete="off" />
      </CocoaField>
      <CocoaField label="Razón social de la sociedad" hint="opcional" help="Quien factura. Vacío = el nombre de la organización; se edita después en Configuración › Estructura societaria › Datos fiscales.">
        <CocoaInput value={state.legalName} onChange={(v) => setState({ ...state, legalName: v })} placeholder="Hoteles Mediterránea S.L." maxLength={200} />
      </CocoaField>
      <CocoaField
        label="NIF de la sociedad"
        hint="opcional"
        error={taxIdError}
        help={state.taxId.trim() === "" ? "Sin NIF la sociedad nace con «NIF pendiente»: no podrá emitir factura en modo fiscal real hasta indicarlo." : taxIdError ? undefined : "Carácter de control correcto."}
      >
        <CocoaInput value={state.taxId} onChange={(v) => setState({ ...state, taxId: v.toUpperCase().replace(/[\s.-]/g, "") })} placeholder="B12345674" maxLength={20} />
      </CocoaField>
      <CocoaField label="Código de la sociedad" hint="opcional" error={structureCodeError(state.legalEntityCode) ?? undefined} help="De 2 a 6 letras o dígitos; vacío = se deriva de la razón social.">
        <CocoaInput value={state.legalEntityCode} onChange={(v) => setState({ ...state, legalEntityCode: normalizeStructureCode(v) })} placeholder="HM" maxLength={6} />
      </CocoaField>
      <CocoaField label="Forma jurídica">
        <CocoaSelect value={state.legalForm} onChange={(v) => setState({ ...state, legalForm: v })} options={[...LEGAL_FORM_OPTIONS]} />
      </CocoaField>
    </div>
  );
}

function StepProperty({ state, setState }: StepProps) {
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaField label="Nombre del centro" required>
        <CocoaInput value={state.propertyName} onChange={(v) => setState({ ...state, propertyName: v })} placeholder="Hotel Palacio del Mar" autoComplete="off" />
      </CocoaField>
      <CocoaField label="Tipo de centro" required help={state.propertyKind === "hotel" ? "Hotel: habitaciones, tarifas, recepción, tasa turística y SES." : "Sin operación hotelera: solo Finanzas y Configuración (nóminas, gastos, bancos, inmovilizado)."}>
        <CocoaSelect value={state.propertyKind} onChange={(v) => setState({ ...state, propertyKind: v })} options={[...PROPERTY_KIND_OPTIONS]} />
      </CocoaField>
      <CocoaField label="Código del centro" hint="opcional" error={structureCodeError(state.propertyCode) ?? undefined} help="De 2 a 6 letras o dígitos; vacío = se deriva del nombre.">
        <CocoaInput value={state.propertyCode} onChange={(v) => setState({ ...state, propertyCode: normalizeStructureCode(v) })} placeholder="RA" maxLength={6} />
      </CocoaField>
      <CocoaField label="Tipo de establecimiento" required>
        <CocoaSelect value={state.propertyType} onChange={(v) => setState({ ...state, propertyType: v })} options={PROPERTY_TYPES} />
      </CocoaField>
      <CocoaFormRow columns={2} min={200}>
        <CocoaField label="Municipio" required>
          <CocoaInput value={state.municipality} onChange={(v) => setState({ ...state, municipality: v })} placeholder="Málaga" autoComplete="address-level2" />
        </CocoaField>
        <CocoaField label="Provincia" required>
          <CocoaInput value={state.province} onChange={(v) => setState({ ...state, province: v })} placeholder="Málaga" autoComplete="address-level1" />
        </CocoaField>
      </CocoaFormRow>
    </div>
  );
}

function StepOwner({ state, setState }: StepProps) {
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaField label="Email del propietario" required>
        <CocoaInput value={state.ownerEmail} onChange={(v) => setState({ ...state, ownerEmail: v })} placeholder="director@palaciodelmar.com" type="email" inputMode="email" autoComplete="off" />
      </CocoaField>
      <CocoaField label="Nombre completo" required>
        <CocoaInput value={state.ownerFullName} onChange={(v) => setState({ ...state, ownerFullName: v })} placeholder="María García López" autoComplete="off" />
      </CocoaField>
      <CocoaField label="Teléfono" hint="opcional">
        <CocoaInput value={state.ownerPhone} onChange={(v) => setState({ ...state, ownerPhone: v })} placeholder="+34 600 000 000" type="tel" inputMode="tel" autoComplete="off" />
      </CocoaField>
      <CocoaCallout tone="info">
        Recibirá un enlace de invitación de un solo uso (72 h) para crear su contraseña. Si el email saliente del servidor no está configurado, al terminar podrás copiar el enlace y entregarlo por otro canal.
      </CocoaCallout>
    </div>
  );
}

function StepModules({ state, setState }: StepProps) {
  const onPlanChange = (next: string) => {
    const plan = next as Plan;
    setState({ ...state, plan, modules: modulesForPlan(plan) });
  };
  const toggleModule = (code: string, alwaysOn?: boolean) => {
    if (alwaysOn) return;
    setState({ ...state, modules: { ...state.modules, [code]: !state.modules[code] } });
  };
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaField label="Plan" required>
        <CocoaSelect value={state.plan} onChange={onPlanChange} options={PLAN_OPTIONS} />
      </CocoaField>
      <CocoaSection title="Módulos activos" meta={`${MODULES.filter((m) => state.modules[m.code]).length} de ${MODULES.length}`}>
        <ul className="c22-section__list" aria-label="Módulos del cliente">
          {MODULES.map((m) => (
            <li key={m.code}>
              <div className="cocoa-stack" data-gap="1" style={{ minWidth: 0 }}>
                <span className="cocoa-cluster">
                  <strong>{m.label}</strong>
                  {m.alwaysOn ? (
                    <CocoaBadge tone="neutral" size="small">
                      siempre activo
                    </CocoaBadge>
                  ) : null}
                </span>
                <span className="cocoa-note">{m.description}</span>
              </div>
              <CocoaSwitch size="small" checked={Boolean(state.modules[m.code])} disabled={m.alwaysOn} onChange={() => toggleModule(m.code, m.alwaysOn)} aria-label={`Módulo ${m.label}`} />
            </li>
          ))}
        </ul>
      </CocoaSection>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <li>
      <span>{k}</span>
      <strong>{v}</strong>
    </li>
  );
}

function StepConfirm({ state }: { state: WizardState }) {
  const country = COUNTRIES.find((c) => c.value === state.country)?.label ?? state.country;
  const ptype = PROPERTY_TYPES.find((p) => p.value === state.propertyType)?.label ?? state.propertyType;
  const enabledModules = MODULES.filter((m) => state.modules[m.code]).map((m) => m.label);
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaSection title="Organización">
        <ul className="c22-section__list" aria-label="Resumen de la organización">
          <SummaryRow k="Nombre" v={state.organizationName} />
          <SummaryRow k="País" v={country} />
          <SummaryRow k="Email de contacto" v={state.contactEmail} />
          <SummaryRow k="Sociedad" v={state.legalName.trim() || `${state.organizationName.trim()} (mismo nombre)`} />
          <SummaryRow k="NIF" v={normalizeTaxId(state.taxId) ?? "pendiente"} />
          {state.legalEntityCode.trim() ? <SummaryRow k="Código de sociedad" v={state.legalEntityCode.trim()} /> : null}
          {state.legalForm ? <SummaryRow k="Forma jurídica" v={LEGAL_FORM_OPTIONS.find((option) => option.value === state.legalForm)?.label ?? state.legalForm} /> : null}
        </ul>
      </CocoaSection>
      <CocoaSection title="Centro de trabajo">
        <ul className="c22-section__list" aria-label="Resumen del centro">
          <SummaryRow k="Nombre" v={state.propertyName} />
          <SummaryRow k="Tipo de centro" v={`${propertyKindLabel(state.propertyKind)}${state.propertyCode.trim() ? ` · ${state.propertyCode.trim()}` : ""}`} />
          <SummaryRow k="Tipo de establecimiento" v={ptype} />
          <SummaryRow k="Ubicación" v={`${state.municipality}, ${state.province}`} />
        </ul>
      </CocoaSection>
      <CocoaSection title="Propietario">
        <ul className="c22-section__list" aria-label="Resumen del propietario">
          <SummaryRow k="Nombre" v={state.ownerFullName} />
          <SummaryRow k="Email" v={state.ownerEmail} />
          {state.ownerPhone ? <SummaryRow k="Teléfono" v={state.ownerPhone} /> : null}
        </ul>
      </CocoaSection>
      <CocoaSection title="Plan y módulos">
        <ul className="c22-section__list" aria-label="Resumen del plan">
          <SummaryRow k="Plan" v={PLAN_OPTIONS.find((p) => p.value === state.plan)?.label ?? state.plan} />
          <SummaryRow k="Módulos" v={enabledModules.join(", ") || "—"} />
        </ul>
      </CocoaSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result panel
// ---------------------------------------------------------------------------

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="cocoa-stack" data-gap="1">
      <span className="cocoa-caption">{label}</span>
      <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
        <CocoaInput value={value} onChange={() => undefined} readOnly aria-label={label} style={{ flex: "1 1 auto", minWidth: 0 }} />
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void handleCopy()}>
          {copied ? "Copiado" : ACTIONS.copy}
        </CocoaButton>
      </div>
    </div>
  );
}

/**
 * What the panel knows about the owner invitation. `delivery` is absent when
 * the API only returned the legacy top-level `inviteLink` (pre-Tanda 3) — the
 * banner then says the send state is unknown and shows the link.
 */
type InviteView = { inviteUrl?: string; expiresAt?: string; delivery?: InvitationResult["delivery"] };

function inviteViewFromResult(result: CreateTenantResponse): InviteView | undefined {
  if (result.invitation) return result.invitation;
  if (result.inviteLink) return { inviteUrl: result.inviteLink };
  return undefined;
}

function SuccessPanel({ invitation, ownerEmail, resendError }: { invitation: InviteView | undefined; ownerEmail: string; resendError: string | null }) {
  const delivery = describeDelivery(invitation?.delivery, ownerEmail);
  const showLink = Boolean(invitation?.inviteUrl) && invitation?.delivery?.status !== "sent";
  return (
    <div className="cocoa-stack" data-gap="4">
      <CocoaState kind="empty" illustration="success" title="Cliente creado" message={`La organización quedó provisionada con su centro de trabajo y el usuario propietario (${ownerEmail}). El propietario crea su contraseña al aceptar la invitación.`} />
      <CocoaCallout tone={DELIVERY_TONE[delivery.tone]} title={delivery.title} role="status">
        {delivery.detail}
      </CocoaCallout>
      {showLink && invitation?.inviteUrl ? <CopyRow label="Enlace de invitación (un solo uso)" value={invitation.inviteUrl} /> : null}
      {invitation?.expiresAt ? <p className="cocoa-note">Caduca el {formatExpiry(invitation.expiresAt)}. Reenviar genera un enlace nuevo y anula este.</p> : null}
      {resendError ? (
        <CocoaCallout tone="danger" title="No se pudo reenviar la invitación" role="alert">
          {resendError}
        </CocoaCallout>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function NewTenantWizardDialog({ open, onClose, onCompleted }: NewTenantWizardDialogProps) {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(() => makeInitialState());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateTenantResponse | null>(null);
  // Owner invitation after the create (re-issued from the footer).
  const [invitation, setInvitation] = useState<InviteView | undefined>(undefined);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep(1);
      setState(makeInitialState());
      setSubmitting(false);
      setError(null);
      setResult(null);
      setInvitation(undefined);
      setResending(false);
      setResendError(null);
    }
  }, [open]);

  const stepValid = useMemo(() => isStepValid(step, state), [step, state]);

  const handleNext = () => {
    if (stepValid && step < TOTAL_STEPS) setStep(step + 1);
  };
  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };
  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const modulesEnabled = MODULES.filter((m) => state.modules[m.code]).map((m) => m.code);
      const res = await createTenant({
        name: state.organizationName.trim(),
        country: state.country,
        plan: state.plan,
        contactEmail: state.contactEmail.trim(),
        ownerEmail: state.ownerEmail.trim(),
        ownerFullName: state.ownerFullName.trim(),
        ownerPhone: state.ownerPhone.trim() || undefined,
        propertyName: state.propertyName.trim(),
        propertyType: state.propertyType,
        municipality: state.municipality.trim(),
        province: state.province.trim(),
        // Tanda 6b (L6): kind / code of the first centre and the implicit sociedad (server bridge: body.property.*, body.legalEntity).
        property: { kind: state.propertyKind, ...(state.propertyCode.trim() ? { code: state.propertyCode.trim() } : {}) },
        ...(state.legalName.trim() || state.taxId.trim() || state.legalEntityCode.trim() || state.legalForm
          ? {
              legalEntity: {
                ...(state.legalName.trim() ? { legalName: state.legalName.trim() } : {}),
                ...(normalizeTaxId(state.taxId) ? { taxId: normalizeTaxId(state.taxId) } : {}),
                ...(state.legalEntityCode.trim() ? { code: state.legalEntityCode.trim() } : {}),
                ...(state.legalForm ? { legalForm: state.legalForm } : {})
              }
            }
          : {}),
        modulesEnabled
      });
      setResult(res);
      setInvitation(inviteViewFromResult(res));
      onCompleted(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (!result) return;
    setResending(true);
    setResendError(null);
    try {
      const next = await reissueTenantInvitation(result.organizationId, result.ownerUserId);
      setInvitation(next);
    } catch (err) {
      setResendError(err instanceof Error ? err.message : String(err));
    } finally {
      setResending(false);
    }
  };

  const stepBody =
    step === 1 ? (
      <StepOrganization state={state} setState={setState} />
    ) : step === 2 ? (
      <StepProperty state={state} setState={setState} />
    ) : step === 3 ? (
      <StepOwner state={state} setState={setState} />
    ) : step === 4 ? (
      <StepModules state={state} setState={setState} />
    ) : (
      <StepConfirm state={state} />
    );

  const busy = submitting || resending;

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title={result ? "Cliente creado" : "Nuevo cliente"}
      subtitle={result ? state.ownerEmail.trim() : `Paso ${step} de ${TOTAL_STEPS} · ${STEP_TITLES[step - 1]}`}
      side="right"
      size="lg"
      dismissible={!busy}
      focusKey={`${step}-${result ? "done" : "form"}`}
      footer={
        result ? (
          <>
            <CocoaButton variant="bordered" tone="accent" onClick={() => void handleResend()} loading={resending} disabled={resending}>
              Reenviar invitación
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={onClose} disabled={resending}>
              {ACTIONS.close}
            </CocoaButton>
          </>
        ) : (
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={handleBack} disabled={step === 1 || submitting}>
              {ACTIONS.previous}
            </CocoaButton>
            {step < TOTAL_STEPS ? (
              <CocoaButton variant="filled" tone="accent" onClick={handleNext} disabled={!stepValid}>
                {ACTIONS.next}
              </CocoaButton>
            ) : (
              <CocoaButton variant="filled" tone="accent" onClick={() => void handleSubmit()} loading={submitting} disabled={!stepValid || submitting}>
                Crear cliente
              </CocoaButton>
            )}
          </>
        )
      }
    >
      {result ? (
        <SuccessPanel invitation={invitation} ownerEmail={state.ownerEmail.trim()} resendError={resendError} />
      ) : (
        <div className="cocoa-stack" data-gap="4">
          <div className="cocoa-stack" data-gap="2">
            <CocoaChart.Progress value={step} max={TOTAL_STEPS} label={STEP_TITLES[step - 1]} valueLabel={`Paso ${step} de ${TOTAL_STEPS}`} aria-label={`Paso ${step} de ${TOTAL_STEPS}: ${STEP_TITLES[step - 1]}`} />
            <ol className="cocoa-cluster" aria-label="Pasos del alta" style={STEP_LIST_STYLE}>
              {STEP_TITLES.map((title, index) => {
                const number = index + 1;
                const tone: CocoaTone = number < step ? "success" : number === step ? "accent" : "neutral";
                return (
                  <li key={title} aria-current={number === step ? "step" : undefined}>
                    <CocoaBadge tone={tone} variant="dot" size="small">
                      {title}
                    </CocoaBadge>
                  </li>
                );
              })}
            </ol>
          </div>
          {stepBody}
          {error ? (
            <CocoaCallout tone="danger" title="No se pudo crear el cliente" role="alert">
              {error}
            </CocoaCallout>
          ) : null}
        </div>
      )}
    </CocoaDrawer>
  );
}

export default NewTenantWizardDialog;

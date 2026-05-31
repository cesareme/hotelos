// NewTenantWizardDialog — Super-Admin provisioning wizard for a new tenant.
//
// 5-step modal dialog: org metadata, first property, owner user, modules /
// plan, and a final confirmation that calls /admin/tenants POST. After a
// successful create we show a result panel with temp password + invite link
// (copyable) plus a "send invite by email" placeholder button.
//
// Props:
//   open       — controls visibility
//   onClose    — fired on Cancel / overlay / Escape
//   onCompleted(result) — called after the API returns; receives the full
//                         CreateTenantResponse so callers can refresh lists.
//
// Validation: each step has an `isStepValid` gate; Next is disabled until the
// current step is complete. Step 4 pre-selects modules for the chosen plan;
// PMS Core is always-on.

import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { createTenant, type CreateTenantResponse } from "../../services/tenantAdminApi";

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
  propertyName: string;
  propertyType: string;
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
  { value: "ES", label: "España" }, { value: "PT", label: "Portugal" },
  { value: "MX", label: "México" }, { value: "FR", label: "Francia" },
  { value: "IT", label: "Italia" }, { value: "DE", label: "Alemania" },
  { value: "GB", label: "Reino Unido" }, { value: "US", label: "Estados Unidos" },
  { value: "AR", label: "Argentina" }, { value: "CO", label: "Colombia" },
  { value: "CL", label: "Chile" }, { value: "BR", label: "Brasil" },
];

const PROPERTY_TYPES = [
  { value: "urban", label: "Urbano" }, { value: "beach", label: "Playa" },
  { value: "resort", label: "Resort" }, { value: "boutique", label: "Boutique" },
  { value: "rural", label: "Rural" }, { value: "business", label: "Business" },
  { value: "apart", label: "Apartamentos" },
];

const PLAN_OPTIONS: Array<{ value: Plan; label: string }> = [
  { value: "starter", label: "Starter" },
  { value: "pro", label: "Pro" },
  { value: "enterprise", label: "Enterprise" },
];

const MODULES: ModuleDef[] = [
  { code: "pms_core", label: "PMS Core", description: "Reservas, rooming, folios", alwaysOn: true },
  { code: "channel_manager", label: "Channel Manager", description: "OTAs y distribución" },
  { code: "revenue_manager", label: "Revenue Manager", description: "Pricing y forecasting" },
  { code: "fnb", label: "F&B", description: "Restaurante, bar, room service" },
  { code: "spa", label: "Spa", description: "Citas y tratamientos" },
  { code: "compliance_es", label: "Compliance ES", description: "SES Hospedajes, AEAT" },
  { code: "ai_operations", label: "AI Operations", description: "Copilot operativo" },
  { code: "esrs", label: "ESRS", description: "Sostenibilidad y reporting" },
  { code: "marketplace", label: "Marketplace", description: "Extensiones de partners" },
];

const PLAN_MODULES: Record<Plan, string[]> = {
  starter: ["pms_core", "channel_manager"],
  pro: ["pms_core", "channel_manager", "revenue_manager", "fnb", "spa", "compliance_es"],
  enterprise: MODULES.map((m) => m.code),
};

const TOTAL_STEPS = 5;
const STEP_TITLES = ["Organización", "Propiedad", "Usuario propietario", "Módulos & plan", "Confirmar"];

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
    organizationName: "", country: "ES", contactEmail: "",
    propertyName: "", propertyType: "urban", municipality: "", province: "",
    ownerEmail: "", ownerFullName: "", ownerPhone: "",
    plan: "pro", modules: modulesForPlan("pro"),
  };
}

function isStepValid(step: number, s: WizardState): boolean {
  if (step === 1) return s.organizationName.trim().length > 0 && s.country.length > 0 && isEmail(s.contactEmail);
  if (step === 2) {
    return s.propertyName.trim().length > 0 && s.propertyType.length > 0 &&
      s.municipality.trim().length > 0 && s.province.trim().length > 0;
  }
  if (step === 3) return isEmail(s.ownerEmail) && s.ownerFullName.trim().length > 0;
  if (step === 4) return Boolean(s.plan);
  if (step === 5) return true;
  return false;
}

async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const S = {
  label: { fontFamily: "var(--cocoa-font)", fontSize: "var(--cocoa-fs-subheadline)", fontWeight: 500, color: "var(--cocoa-label)", margin: 0 } as CSSProperties,
  hint: { fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-tertiary)", margin: 0 } as CSSProperties,
  col: { display: "flex", flexDirection: "column", gap: 16 } as CSSProperties,
  field: { display: "flex", flexDirection: "column", gap: 4 } as CSSProperties,
  row: { display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--cocoa-separator)", fontSize: "var(--cocoa-fs-body)" } as CSSProperties,
  rowK: { color: "var(--cocoa-label-secondary)" } as CSSProperties,
  rowV: { color: "var(--cocoa-label)", fontWeight: 500, textAlign: "right" } as CSSProperties,
  hintBox: { margin: 0, padding: "10px 12px", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)", background: "var(--cocoa-background-control)", borderRadius: "var(--cocoa-radius-md)", border: "1px solid var(--cocoa-separator)" } as CSSProperties,
  moduleBox: { display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--cocoa-separator)", borderRadius: "var(--cocoa-radius-md)", padding: 8, background: "var(--cocoa-background-control)" } as CSSProperties,
  overlay: { position: "fixed", inset: 0, zIndex: 9999, background: "rgba(15, 23, 42, 0.55)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 } as CSSProperties,
  dialog: { background: "var(--cocoa-background-content)", color: "var(--cocoa-label)", borderRadius: "var(--cocoa-radius-lg)", boxShadow: "var(--cocoa-shadow-modal, 0 24px 60px rgba(0,0,0,0.25))", width: "100%", maxWidth: 600, maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "var(--cocoa-font)" } as CSSProperties,
  header: { padding: "20px 24px 12px 24px", borderBottom: "1px solid var(--cocoa-separator)", display: "flex", flexDirection: "column", gap: 8 } as CSSProperties,
  eyebrow: { margin: 0, fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)", letterSpacing: "var(--cocoa-tracking-wide)", textTransform: "uppercase", fontWeight: 600 } as CSSProperties,
  title: { margin: 0, fontSize: "var(--cocoa-fs-title-1)", fontWeight: 700, color: "var(--cocoa-label)" } as CSSProperties,
  progress: { position: "relative", width: "100%", height: 4, borderRadius: "var(--cocoa-radius-full)", background: "color-mix(in srgb, var(--cocoa-separator) 60%, transparent)", overflow: "hidden", marginTop: 4 } as CSSProperties,
  progressFill: (pct: number): CSSProperties => ({ width: `${pct}%`, height: "100%", background: "var(--cocoa-accent)", borderRadius: "var(--cocoa-radius-full)", transition: "width var(--cocoa-duration-base) var(--cocoa-ease-out)" }),
  body: { padding: "20px 24px", overflowY: "auto", flex: 1 } as CSSProperties,
  footer: { padding: "12px 24px 16px 24px", borderTop: "1px solid var(--cocoa-separator)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: "var(--cocoa-background-control)" } as CSSProperties,
  errorBox: { margin: "12px 0 0 0", padding: "10px 12px", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-danger)", background: "rgba(255, 59, 48, 0.08)", border: "1px solid var(--cocoa-danger)", borderRadius: "var(--cocoa-radius-md)" } as CSSProperties,
  moduleLabel: (alwaysOn: boolean): CSSProperties => ({ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px", borderRadius: "var(--cocoa-radius-sm)", cursor: alwaysOn ? "default" : "pointer", opacity: alwaysOn ? 0.85 : 1 }),
};

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={S.field}>
      <label style={S.label}>{label}</label>
      {children}
      {hint ? <p style={S.hint}>{hint}</p> : null}
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={S.row}>
      <span style={S.rowK}>{k}</span>
      <span style={S.rowV}>{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface StepProps { state: WizardState; setState: (next: WizardState) => void }

function StepOrganization({ state, setState }: StepProps) {
  return (
    <div style={S.col}>
      <Field label="Nombre de la organización">
        <CocoaInput value={state.organizationName} onChange={(v) => setState({ ...state, organizationName: v })} placeholder="Hoteles Mediterránea SL" required />
      </Field>
      <Field label="País">
        <CocoaSelect value={state.country} onChange={(v) => setState({ ...state, country: v })} options={COUNTRIES} />
      </Field>
      <Field label="Email de contacto" hint="Usado para facturación y comunicaciones críticas.">
        <CocoaInput value={state.contactEmail} onChange={(v) => setState({ ...state, contactEmail: v })} placeholder="cuentas@mediterranea.com" type="email" inputMode="email" required />
      </Field>
    </div>
  );
}

function StepProperty({ state, setState }: StepProps) {
  return (
    <div style={S.col}>
      <Field label="Nombre de la propiedad">
        <CocoaInput value={state.propertyName} onChange={(v) => setState({ ...state, propertyName: v })} placeholder="Hotel Palacio del Mar" required />
      </Field>
      <Field label="Tipo">
        <CocoaSelect value={state.propertyType} onChange={(v) => setState({ ...state, propertyType: v })} options={PROPERTY_TYPES} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Municipio">
          <CocoaInput value={state.municipality} onChange={(v) => setState({ ...state, municipality: v })} placeholder="Málaga" required />
        </Field>
        <Field label="Provincia">
          <CocoaInput value={state.province} onChange={(v) => setState({ ...state, province: v })} placeholder="Málaga" required />
        </Field>
      </div>
    </div>
  );
}

function StepOwner({ state, setState }: StepProps) {
  return (
    <div style={S.col}>
      <Field label="Email del propietario">
        <CocoaInput value={state.ownerEmail} onChange={(v) => setState({ ...state, ownerEmail: v })} placeholder="director@palaciodelmar.com" type="email" inputMode="email" required />
      </Field>
      <Field label="Nombre completo">
        <CocoaInput value={state.ownerFullName} onChange={(v) => setState({ ...state, ownerFullName: v })} placeholder="María García López" required />
      </Field>
      <Field label="Teléfono (opcional)">
        <CocoaInput value={state.ownerPhone} onChange={(v) => setState({ ...state, ownerPhone: v })} placeholder="+34 600 000 000" inputMode="tel" />
      </Field>
      <p style={S.hintBox}>Recibirá un email con magic link + password temporal.</p>
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
    <div style={S.col}>
      <Field label="Plan">
        <CocoaSelect value={state.plan} onChange={onPlanChange} options={PLAN_OPTIONS} />
      </Field>
      <div>
        <p style={{ ...S.label, marginBottom: 8 }}>Módulos activos</p>
        <div style={S.moduleBox}>
          {MODULES.map((m) => (
            <label key={m.code} style={S.moduleLabel(Boolean(m.alwaysOn))}>
              <input
                type="checkbox"
                checked={Boolean(state.modules[m.code])}
                disabled={m.alwaysOn}
                onChange={() => toggleModule(m.code, m.alwaysOn)}
                style={{ marginTop: 2 }}
              />
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: "var(--cocoa-fs-body)", fontWeight: 500, color: "var(--cocoa-label)" }}>
                  {m.label}
                  {m.alwaysOn ? (
                    <span style={{ marginLeft: 6, fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-tertiary)", fontWeight: 400 }}>(auto)</span>
                  ) : null}
                </span>
                <span style={S.hint}>{m.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepConfirm({ state }: { state: WizardState }) {
  const country = COUNTRIES.find((c) => c.value === state.country)?.label ?? state.country;
  const ptype = PROPERTY_TYPES.find((p) => p.value === state.propertyType)?.label ?? state.propertyType;
  const enabledModules = MODULES.filter((m) => state.modules[m.code]).map((m) => m.label);
  return (
    <div style={S.col}>
      <section>
        <p style={{ ...S.label, marginBottom: 4 }}>Organización</p>
        <SummaryRow k="Nombre" v={state.organizationName} />
        <SummaryRow k="País" v={country} />
        <SummaryRow k="Email contacto" v={state.contactEmail} />
      </section>
      <section>
        <p style={{ ...S.label, marginBottom: 4 }}>Propiedad</p>
        <SummaryRow k="Nombre" v={state.propertyName} />
        <SummaryRow k="Tipo" v={ptype} />
        <SummaryRow k="Ubicación" v={`${state.municipality}, ${state.province}`} />
      </section>
      <section>
        <p style={{ ...S.label, marginBottom: 4 }}>Propietario</p>
        <SummaryRow k="Nombre" v={state.ownerFullName} />
        <SummaryRow k="Email" v={state.ownerEmail} />
        {state.ownerPhone ? <SummaryRow k="Teléfono" v={state.ownerPhone} /> : null}
      </section>
      <section>
        <p style={{ ...S.label, marginBottom: 4 }}>Plan & módulos</p>
        <SummaryRow k="Plan" v={state.plan} />
        <SummaryRow k="Módulos" v={enabledModules.join(", ") || "—"} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result panel
// ---------------------------------------------------------------------------

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (await copyToClipboard(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div style={S.field}>
      <span style={{ ...S.label, fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>{label}</span>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <CocoaInput value={value} onChange={() => undefined} />
        <CocoaButton variant="bordered" tone="neutral" size="regular" onClick={handleCopy}>
          {copied ? "Copiado" : "Copiar"}
        </CocoaButton>
      </div>
    </div>
  );
}

function SuccessPanel({ result, onClose }: { result: CreateTenantResponse; onClose: () => void }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const handleSendInvite = () => {
    // Placeholder — real send-invite endpoint will be wired separately.
    setSending(true);
    window.setTimeout(() => { setSending(false); setSent(true); }, 600);
  };
  return (
    <div style={S.col}>
      <div>
        <h3 style={{ margin: 0, fontSize: "var(--cocoa-fs-title-2)", fontWeight: 700, color: "var(--cocoa-label)" }}>
          Cliente creado
        </h3>
        <p style={{ margin: "6px 0 0 0", color: "var(--cocoa-label-secondary)" }}>
          La organización quedó provisionada con propiedad y usuario propietario.
        </p>
      </div>
      <CopyRow label="Password temporal" value={result.tempPassword} />
      <CopyRow label="Invite link" value={result.inviteLink} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
        <CocoaButton variant="bordered" tone="accent" onClick={handleSendInvite} loading={sending} disabled={sent}>
          {sent ? "Invitación enviada" : "Enviar invitación por email"}
        </CocoaButton>
        <CocoaButton variant="filled" tone="accent" onClick={onClose}>Cerrar</CocoaButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function NewTenantWizardDialog({ open, onClose, onCompleted }: NewTenantWizardDialogProps) {
  const headingId = useId();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(() => makeInitialState());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateTenantResponse | null>(null);

  useEffect(() => {
    if (open) {
      setStep(1);
      setState(makeInitialState());
      setSubmitting(false);
      setError(null);
      setResult(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !submitting) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, submitting]);

  const stepValid = useMemo(() => isStepValid(step, state), [step, state]);

  if (!open) return null;

  const handleNext = () => { if (stepValid && step < TOTAL_STEPS) setStep(step + 1); };
  const handleBack = () => { if (step > 1) setStep(step - 1); };
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
        modulesEnabled,
      });
      setResult(res);
      onCompleted(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const pct = Math.round((step / TOTAL_STEPS) * 100);

  const stepBody =
    step === 1 ? <StepOrganization state={state} setState={setState} /> :
    step === 2 ? <StepProperty state={state} setState={setState} /> :
    step === 3 ? <StepOwner state={state} setState={setState} /> :
    step === 4 ? <StepModules state={state} setState={setState} /> :
    <StepConfirm state={state} />;

  const node = (
    <div
      role="presentation"
      style={S.overlay}
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={headingId} style={S.dialog}>
        <header style={S.header}>
          <p style={S.eyebrow}>
            {result ? "Resultado" : `Paso ${step} de ${TOTAL_STEPS} · ${STEP_TITLES[step - 1]}`}
          </p>
          <h2 id={headingId} style={S.title}>
            {result ? "Cliente creado" : "Nuevo cliente"}
          </h2>
          {!result ? (
            <div role="progressbar" aria-valuemin={0} aria-valuemax={TOTAL_STEPS} aria-valuenow={step} style={S.progress}>
              <div style={S.progressFill(pct)} />
            </div>
          ) : null}
        </header>

        <div style={S.body}>
          {result ? (
            <SuccessPanel result={result} onClose={onClose} />
          ) : (
            <>
              {stepBody}
              {error ? <p role="alert" style={S.errorBox}>{error}</p> : null}
            </>
          )}
        </div>

        {!result ? (
          <footer style={S.footer}>
            <CocoaButton variant="plain" tone="neutral" onClick={onClose} disabled={submitting}>
              Cancelar
            </CocoaButton>
            <div style={{ display: "flex", gap: 8 }}>
              <CocoaButton variant="bordered" tone="neutral" onClick={handleBack} disabled={step === 1 || submitting}>
                Anterior
              </CocoaButton>
              {step < TOTAL_STEPS ? (
                <CocoaButton variant="filled" tone="accent" onClick={handleNext} disabled={!stepValid}>
                  Siguiente
                </CocoaButton>
              ) : (
                <CocoaButton variant="filled" tone="accent" onClick={handleSubmit} loading={submitting} disabled={!stepValid || submitting}>
                  Crear cliente
                </CocoaButton>
              )}
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );

  if (typeof document === "undefined") return node;
  return createPortal(node, document.body);
}

export default NewTenantWizardDialog;

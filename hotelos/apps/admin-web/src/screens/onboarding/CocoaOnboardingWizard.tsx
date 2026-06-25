// CocoaOnboardingWizard — macOS Setup Assistant inspired 5-step wizard.
//
// Welcomes a new admin into Anfitorio, captures the property profile, lets the
// operator pick a theme + accent (applied live), seeds the first user, and
// shows a confirmation card at the end. Layout mirrors NSAssistant: a top
// progress bar ("Paso N de 5"), a centered card body (max-width 560px), and a
// fixed footer with Previous / Next (Finalizar on the last step).
//
// Composition leans on existing Cocoa primitives: CocoaCard, CocoaButton,
// CocoaInput, CocoaSelect, CocoaSwitch, CocoaColorWell, CocoaFormFieldset,
// CocoaSegmentedControl, and CocoaAlert. Theme + accent changes are applied
// live on <html> via data-theme + the --cocoa-accent custom property so the
// preview reflects the choice immediately.
//
// Props:
//   onComplete(data) — async finalization hook called when the user clicks
//   "Finalizar" on step 5. The wizard awaits the promise and surfaces a
//   loading state on the action button while it resolves.

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaSegmentedControl } from "../../components/cocoa/CocoaSegmentedControl";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaSwitch } from "../../components/cocoa/CocoaSwitch";
import { CocoaAlert } from "../../components/cocoa-extras/CocoaAlert";
import { CocoaColorWell } from "../../components/cocoa-extras/CocoaColorWell";
import { CocoaFormFieldset } from "../../components/cocoa-extras/CocoaFormFieldset";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WizardTheme = "light" | "dark" | "auto";
export type WizardUserRole = "owner" | "manager" | "staff";

export interface WizardPropertyProfile {
  name: string;
  address: string;
  country: string;
  currency: string;
}

export interface WizardAppearance {
  theme: WizardTheme;
  accent: string;
  reducedMotion: boolean;
  highContrast: boolean;
}

export interface WizardFirstUser {
  email: string;
  name: string;
  role: WizardUserRole;
}

export interface WizardData {
  property: WizardPropertyProfile;
  appearance: WizardAppearance;
  firstUser: WizardFirstUser;
}

export interface CocoaOnboardingWizardProps {
  onComplete: (data: WizardData) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants — option sets for selects + presets for the accent picker.
// ---------------------------------------------------------------------------

const COUNTRY_OPTIONS = [
  { value: "ES", label: "España" },
  { value: "MX", label: "México" },
  { value: "US", label: "Estados Unidos" },
  { value: "AR", label: "Argentina" },
  { value: "CO", label: "Colombia" },
  { value: "CL", label: "Chile" },
  { value: "PE", label: "Perú" },
  { value: "BR", label: "Brasil" },
  { value: "FR", label: "Francia" },
  { value: "DE", label: "Alemania" },
  { value: "IT", label: "Italia" },
  { value: "PT", label: "Portugal" },
  { value: "GB", label: "Reino Unido" }
];

const CURRENCY_OPTIONS = [
  { value: "EUR", label: "EUR — Euro" },
  { value: "USD", label: "USD — US Dollar" },
  { value: "MXN", label: "MXN — Peso mexicano" },
  { value: "ARS", label: "ARS — Peso argentino" },
  { value: "COP", label: "COP — Peso colombiano" },
  { value: "CLP", label: "CLP — Peso chileno" },
  { value: "PEN", label: "PEN — Sol peruano" },
  { value: "BRL", label: "BRL — Real brasileño" },
  { value: "GBP", label: "GBP — Libra esterlina" }
];

const ROLE_OPTIONS = [
  { value: "owner", label: "Propietario" },
  { value: "manager", label: "Manager" },
  { value: "staff", label: "Staff" }
];

const THEME_SEGMENTS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "auto", label: "Auto" }
];

const ACCENT_PRESETS = [
  "#0064E1",
  "#0A84FF",
  "#34c759",
  "#ff9500",
  "#ff3b30",
  "#5856d6",
  "#af52de",
  "#ff2d55",
  "#a2845e",
  "#8e8e93"
];

const TOTAL_STEPS = 5;

const INITIAL_DATA: WizardData = {
  property: { name: "", address: "", country: "ES", currency: "EUR" },
  appearance: {
    theme: "auto",
    accent: "#0064E1",
    reducedMotion: false,
    highContrast: false
  },
  firstUser: { email: "", name: "", role: "owner" }
};

// ---------------------------------------------------------------------------
// Validation — each step gates the "Next" button.
// ---------------------------------------------------------------------------

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isStepValid(step: number, data: WizardData): boolean {
  switch (step) {
    case 1:
      return true;
    case 2:
      return (
        data.property.name.trim().length > 0 &&
        data.property.address.trim().length > 0 &&
        data.property.country.length > 0 &&
        data.property.currency.length > 0
      );
    case 3:
      return true;
    case 4:
      return (
        isEmail(data.firstUser.email) &&
        data.firstUser.name.trim().length > 0 &&
        data.firstUser.role.length > 0
      );
    case 5:
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Live appearance preview — flip data-theme + --cocoa-accent on <html>.
// We snapshot the previous values on mount and restore them when the wizard
// finishes so we don't leak preview state if the caller bails out.
// ---------------------------------------------------------------------------

function applyAppearancePreview(appearance: WizardAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (appearance.theme === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", appearance.theme);
  }
  root.style.setProperty("--cocoa-accent", appearance.accent);
  root.style.setProperty(
    "--cocoa-background-selection",
    appearance.accent
  );
  if (appearance.reducedMotion) {
    root.setAttribute("data-reduced-motion", "true");
  } else {
    root.removeAttribute("data-reduced-motion");
  }
  if (appearance.highContrast) {
    root.setAttribute("data-high-contrast", "true");
  } else {
    root.removeAttribute("data-high-contrast");
  }
}

// ---------------------------------------------------------------------------
// Sub-components — keep render bodies tight so the orchestrator stays readable.
// ---------------------------------------------------------------------------

const stepLabelStyle: CSSProperties = {
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
  color: "var(--cocoa-label-secondary)",
  letterSpacing: "var(--cocoa-tracking-tight)",
  margin: 0
};

const progressTrackStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: 4,
  borderRadius: "var(--cocoa-radius-full)",
  background: "color-mix(in srgb, var(--cocoa-separator) 60%, transparent)",
  overflow: "hidden"
};

function ProgressHeader({ step }: { step: number }) {
  const pct = Math.round((step / TOTAL_STEPS) * 100);
  const headerStyle: CSSProperties = {
    position: "sticky",
    top: 0,
    zIndex: 2,
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-2)",
    padding: "var(--cocoa-space-4) var(--cocoa-space-6)",
    background: "var(--cocoa-background-toolbar)",
    backdropFilter: "blur(20px) saturate(180%)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    borderBottom: "1px solid var(--cocoa-separator)"
  };
  const fillStyle: CSSProperties = {
    width: `${pct}%`,
    height: "100%",
    background: "var(--cocoa-accent)",
    borderRadius: "var(--cocoa-radius-full)",
    transition:
      "width var(--cocoa-duration-base) var(--cocoa-ease-out), background-color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
  };
  return (
    <header style={headerStyle}>
      <p style={stepLabelStyle}>
        Paso {step} de {TOTAL_STEPS}
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={TOTAL_STEPS}
        aria-valuenow={step}
        aria-label={`Progreso de configuración: paso ${step} de ${TOTAL_STEPS}`}
        style={progressTrackStyle}
      >
        <div style={fillStyle} />
      </div>
    </header>
  );
}

function BrandMark({ accent }: { accent: string }) {
  const wrapStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 88,
    height: 88,
    borderRadius: 22,
    background: `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 60%, #ffffff))`,
    boxShadow: "var(--cocoa-shadow-modal)",
    marginBottom: "var(--cocoa-space-4)"
  };
  return (
    <span style={wrapStyle} aria-hidden="true">
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
        <path
          d="M10 32V12h4v8h16v-8h4v20h-4v-8H14v8z"
          fill="#FFFFFF"
        />
      </svg>
    </span>
  );
}

interface StepProps {
  data: WizardData;
  setData: (next: WizardData) => void;
}

function StepWelcome({
  data,
  onStart
}: {
  data: WizardData;
  onStart: () => void;
}) {
  const wrapStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    padding: "var(--cocoa-space-5) var(--cocoa-space-4)",
    gap: "var(--cocoa-space-3)"
  };
  const heroTitleStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-large-title)",
    fontWeight: "var(--cocoa-fw-bold)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    color: "var(--cocoa-label)",
    lineHeight: 1.15
  };
  const heroSubtitleStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-title-3)",
    fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
    color: "var(--cocoa-label-secondary)",
    lineHeight: 1.4,
    maxWidth: 420
  };
  const ctaWrapStyle: CSSProperties = {
    marginTop: "var(--cocoa-space-4)"
  };
  return (
    <div style={wrapStyle}>
      <BrandMark accent={data.appearance.accent} />
      <h1 style={heroTitleStyle}>Te damos la bienvenida a Anfitorio</h1>
      <p style={heroSubtitleStyle}>
        5 pasos para empezar. Configura tu propiedad, elige cómo se ve la
        aplicación y crea el primer usuario.
      </p>
      <div style={ctaWrapStyle}>
        <CocoaButton variant="filled" tone="accent" size="large" onClick={onStart}>
          Comenzar
        </CocoaButton>
      </div>
    </div>
  );
}

function StepProperty({ data, setData }: StepProps) {
  const setProperty = (
    patch: Partial<WizardPropertyProfile>
  ): void => {
    setData({
      ...data,
      property: { ...data.property, ...patch }
    });
  };

  const rowStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-3)"
  };
  const fieldStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-1)"
  };
  const labelStyle: CSSProperties = {
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-subheadline)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    color: "var(--cocoa-label)",
    margin: 0
  };

  return (
    <CocoaFormFieldset
      title="Perfil de la propiedad"
      description="Información básica de tu hotel. Podrás cambiarla más tarde en Ajustes."
    >
      <div style={rowStyle}>
        <div style={fieldStyle}>
          <label style={labelStyle}>Nombre</label>
          <CocoaInput
            value={data.property.name}
            onChange={(v) => setProperty({ name: v })}
            placeholder="Hotel Bella Vista"
            required
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Dirección</label>
          <CocoaInput
            value={data.property.address}
            onChange={(v) => setProperty({ address: v })}
            placeholder="Calle Mayor 123, Madrid"
            required
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>País</label>
          <CocoaSelect
            value={data.property.country}
            onChange={(v) => setProperty({ country: v })}
            options={COUNTRY_OPTIONS}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Moneda</label>
          <CocoaSelect
            value={data.property.currency}
            onChange={(v) => setProperty({ currency: v })}
            options={CURRENCY_OPTIONS}
          />
        </div>
      </div>
    </CocoaFormFieldset>
  );
}

function StepAppearance({ data, setData }: StepProps) {
  const setAppearance = (patch: Partial<WizardAppearance>): void => {
    setData({
      ...data,
      appearance: { ...data.appearance, ...patch }
    });
  };

  const rowStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-4)"
  };
  const blockStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-2)"
  };
  const labelStyle: CSSProperties = {
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-subheadline)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    color: "var(--cocoa-label)",
    margin: 0
  };
  const inlineRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--cocoa-space-3)"
  };
  const switchRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--cocoa-space-3)"
  };
  const accentValueStyle: CSSProperties = {
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    color: "var(--cocoa-label-secondary)"
  };

  return (
    <CocoaFormFieldset
      title="Tema y apariencia"
      description="Tus cambios se aplican al instante para que veas cómo lucirá Anfitorio."
    >
      <div style={rowStyle}>
        <div style={blockStyle}>
          <label style={labelStyle}>Tema</label>
          <CocoaSegmentedControl
            value={data.appearance.theme}
            onChange={(v) =>
              setAppearance({ theme: v as WizardTheme })
            }
            options={THEME_SEGMENTS}
            aria-label="Tema de la aplicación"
          />
        </div>
        <div style={blockStyle}>
          <label style={labelStyle}>Color de acento</label>
          <div style={inlineRow}>
            <CocoaColorWell
              value={data.appearance.accent}
              onChange={(c) => setAppearance({ accent: c })}
              presets={ACCENT_PRESETS}
              size="large"
            />
            <span style={accentValueStyle}>{data.appearance.accent}</span>
          </div>
        </div>
        <div style={switchRow}>
          <span style={labelStyle}>Reducir movimiento</span>
          <CocoaSwitch
            checked={data.appearance.reducedMotion}
            onChange={(v) => setAppearance({ reducedMotion: v })}
          />
        </div>
        <div style={switchRow}>
          <span style={labelStyle}>Alto contraste</span>
          <CocoaSwitch
            checked={data.appearance.highContrast}
            onChange={(v) => setAppearance({ highContrast: v })}
          />
        </div>
      </div>
    </CocoaFormFieldset>
  );
}

function StepFirstUser({ data, setData }: StepProps) {
  const setFirstUser = (patch: Partial<WizardFirstUser>): void => {
    setData({
      ...data,
      firstUser: { ...data.firstUser, ...patch }
    });
  };

  const rowStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-3)"
  };
  const fieldStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-1)"
  };
  const labelStyle: CSSProperties = {
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-subheadline)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    color: "var(--cocoa-label)",
    margin: 0
  };

  const emailInvalid =
    data.firstUser.email.length > 0 && !isEmail(data.firstUser.email);

  return (
    <CocoaFormFieldset
      title="Primer usuario"
      description="Crea la cuenta principal del workspace. Tendrá acceso completo."
    >
      <div style={rowStyle}>
        <div style={fieldStyle}>
          <label style={labelStyle}>Correo</label>
          <CocoaInput
            value={data.firstUser.email}
            onChange={(v) => setFirstUser({ email: v })}
            placeholder="tu@hotel.com"
            type="email"
            inputMode="email"
            error={emailInvalid}
            required
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Nombre</label>
          <CocoaInput
            value={data.firstUser.name}
            onChange={(v) => setFirstUser({ name: v })}
            placeholder="Ana García"
            required
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Rol</label>
          <CocoaSelect
            value={data.firstUser.role}
            onChange={(v) => setFirstUser({ role: v as WizardUserRole })}
            options={ROLE_OPTIONS}
          />
        </div>
      </div>
    </CocoaFormFieldset>
  );
}

function StepDone({
  onFinish,
  loading
}: {
  onFinish: () => void;
  loading: boolean;
}) {
  const [alertOpen, setAlertOpen] = useState(true);
  const wrapStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    padding: "var(--cocoa-space-5) var(--cocoa-space-4)",
    gap: "var(--cocoa-space-3)"
  };
  const headlineStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-title-1)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    color: "var(--cocoa-label)"
  };
  const bodyStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-body)",
    color: "var(--cocoa-label-secondary)",
    maxWidth: 420,
    lineHeight: 1.4
  };

  return (
    <>
      <div style={wrapStyle}>
        <h2 style={headlineStyle}>¡Listo! Tu workspace está configurado.</h2>
        <p style={bodyStyle}>
          Hemos guardado tu propiedad, preferencias de apariencia y el primer
          usuario. Pulsa el botón para entrar al panel.
        </p>
        <div style={{ marginTop: "var(--cocoa-space-3)" }}>
          <CocoaButton
            variant="filled"
            tone="accent"
            size="large"
            loading={loading}
            onClick={onFinish}
          >
            Entrar al dashboard
          </CocoaButton>
        </div>
      </div>
      <CocoaAlert
        open={alertOpen}
        type="info"
        title="¡Listo!"
        message="Tu workspace está configurado."
        primaryAction={{
          label: "Continuar",
          onClick: () => setAlertOpen(false)
        }}
        onClose={() => setAlertOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function CocoaOnboardingWizard({
  onComplete
}: CocoaOnboardingWizardProps) {
  const [step, setStep] = useState<number>(1);
  const [data, setData] = useState<WizardData>(INITIAL_DATA);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Apply appearance changes live whenever the user touches step 3.
  useEffect(() => {
    applyAppearancePreview(data.appearance);
  }, [data.appearance]);

  const canAdvance = useMemo(() => isStepValid(step, data), [step, data]);

  const goPrev = (): void => {
    if (step <= 1) return;
    setStep((s) => Math.max(1, s - 1));
  };

  const goNext = async (): Promise<void> => {
    if (!canAdvance) return;
    if (step < TOTAL_STEPS) {
      setStep((s) => Math.min(TOTAL_STEPS, s + 1));
      return;
    }
    // Final step → fire onComplete.
    setSubmitting(true);
    setError(null);
    try {
      await onComplete(data);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "No se pudo completar la configuración.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const pageStyle: CSSProperties = {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--cocoa-background-window)",
    fontFamily: "var(--cocoa-font)",
    color: "var(--cocoa-label)"
  };

  const bodyStyle: CSSProperties = {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "var(--cocoa-space-6) var(--cocoa-space-4)",
    paddingBottom: 96
  };

  const cardWrapperStyle: CSSProperties = {
    width: "100%",
    maxWidth: 560
  };

  const footerStyle: CSSProperties = {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 3,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "var(--cocoa-space-3) var(--cocoa-space-6)",
    background: "var(--cocoa-background-toolbar)",
    backdropFilter: "blur(20px) saturate(180%)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    borderTop: "1px solid var(--cocoa-separator)"
  };

  const errorStyle: CSSProperties = {
    marginTop: "var(--cocoa-space-3)",
    color: "var(--cocoa-danger)",
    fontSize: "var(--cocoa-fs-body)",
    textAlign: "center"
  };

  const renderStep = (): React.ReactNode => {
    switch (step) {
      case 1:
        return <StepWelcome data={data} onStart={() => setStep(2)} />;
      case 2:
        return <StepProperty data={data} setData={setData} />;
      case 3:
        return <StepAppearance data={data} setData={setData} />;
      case 4:
        return <StepFirstUser data={data} setData={setData} />;
      case 5:
        return (
          <StepDone
            loading={submitting}
            onFinish={() => {
              void goNext();
            }}
          />
        );
      default:
        return null;
    }
  };

  const isLastStep = step === TOTAL_STEPS;
  const nextLabel = isLastStep ? "Finalizar" : "Siguiente";

  return (
    <div style={pageStyle}>
      <ProgressHeader step={step} />
      <main style={bodyStyle}>
        <div style={cardWrapperStyle}>
          <CocoaCard variant="elevated" padding="lg">
            {renderStep()}
          </CocoaCard>
          {error ? <p style={errorStyle}>{error}</p> : null}
        </div>
      </main>
      <footer style={footerStyle}>
        <CocoaButton
          variant="bordered"
          tone="neutral"
          onClick={goPrev}
          disabled={step <= 1 || submitting}
        >
          Anterior
        </CocoaButton>
        <CocoaButton
          variant="filled"
          tone="accent"
          loading={isLastStep && submitting}
          disabled={!canAdvance || submitting}
          onClick={() => {
            void goNext();
          }}
        >
          {nextLabel}
        </CocoaButton>
      </footer>
    </div>
  );
}

export default CocoaOnboardingWizard;

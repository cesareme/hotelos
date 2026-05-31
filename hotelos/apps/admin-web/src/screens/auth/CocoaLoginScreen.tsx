// CocoaLoginScreen — Aurora Cocoa Edition login surface.
//
// Layout: a split-screen, macOS-native style login. The left panel is a hero
// brand pane with a subtle diagonal gradient (accent → success at low alpha)
// and three floating geometric shapes (circle, triangle, rounded square)
// that bob gently via the `cocoa-float` keyframe. The right panel hosts
// an elevated CocoaCard with the auth form: a CocoaFormFieldset titled
// "Cuenta" wrapping the email and password inputs, the remember-me row,
// the primary "Entrar" button, an "o" separator, a Google SSO bordered
// button, and a footer sales link.
//
// Below 800px the split collapses into a vertical stack with the hero
// pinned to 30vh on top and the form taking the remaining viewport.
//
// Props:
//   onSubmit:  async (email, password) => void — caller handles auth.
//   loading?:  boolean — disables inputs and shows the entrar button busy.
//   error?:    string  — when present, surfaces a CocoaAlert.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode
} from "react";

import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaFormFieldset } from "../../components/cocoa-extras/CocoaFormFieldset";
import { CocoaAlert } from "../../components/cocoa-extras/CocoaAlert";

export interface CocoaLoginScreenProps {
  onSubmit: (email: string, password: string) => Promise<void>;
  loading?: boolean;
  error?: string;
}

// Breakpoint below which the split collapses into a vertical stack.
const NARROW_BREAKPOINT_PX = 800;

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(`(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mql = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`);
    const handle = (event: MediaQueryListEvent) => setNarrow(event.matches);
    mql.addEventListener("change", handle);
    return () => mql.removeEventListener("change", handle);
  }, []);

  return narrow;
}

// Tiny Google "G" mark — kept inline so we don't add brand SVG dependencies.
function GoogleGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.614z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}

// Labelled wrapper around CocoaInput. CocoaInput exposes no label prop, so we
// pair the visible label with the input via an outer <label> + an aria fallback.
interface LabelledFieldProps {
  label: string;
  children: ReactNode;
}

function LabelledField({ label, children }: LabelledFieldProps) {
  const wrapperStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 6
  };
  const labelStyle: CSSProperties = {
    color: "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-subheadline)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)"
  };
  return (
    <label style={wrapperStyle}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

export function CocoaLoginScreen(props: CocoaLoginScreenProps) {
  const { onSubmit, loading = false, error } = props;
  const narrow = useIsNarrow();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [alertOpen, setAlertOpen] = useState<boolean>(Boolean(error));
  const [internalSubmitting, setInternalSubmitting] = useState(false);

  const rememberId = useId();
  const emailWrapperRef = useRef<HTMLDivElement | null>(null);

  // Focus the email input on mount — CocoaInput has no autoFocus prop, so we
  // reach into the rendered <input> via a wrapper ref.
  useEffect(() => {
    const wrapper = emailWrapperRef.current;
    if (!wrapper) return;
    const input = wrapper.querySelector<HTMLInputElement>("input");
    input?.focus({ preventScroll: true });
  }, []);

  // Sync alert visibility with the external error prop.
  useEffect(() => {
    setAlertOpen(Boolean(error));
  }, [error]);

  const isBusy = loading || internalSubmitting;
  const canSubmit = email.trim().length > 0 && password.length > 0 && !isBusy;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmit) return;
      setInternalSubmitting(true);
      try {
        await onSubmit(email.trim(), password);
      } finally {
        setInternalSubmitting(false);
      }
    },
    [canSubmit, onSubmit, email, password]
  );

  // Layout containers — split vs stacked.
  const rootStyle = useMemo<CSSProperties>(
    () => ({
      minHeight: "100vh",
      width: "100%",
      display: "flex",
      flexDirection: narrow ? "column" : "row",
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)",
      background: "var(--cocoa-background-window)"
    }),
    [narrow]
  );

  const heroStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      flex: narrow ? "0 0 30vh" : "1 1 50%",
      minHeight: narrow ? "30vh" : undefined,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: narrow ? "24px" : "48px",
      overflow: "hidden",
      backgroundImage:
        "linear-gradient(135deg, rgba(0, 100, 225, 0.08) 0%, rgba(40, 167, 69, 0.08) 100%)",
      backdropFilter: "blur(12px) saturate(160%)",
      WebkitBackdropFilter: "blur(12px) saturate(160%)",
      borderRight: narrow
        ? undefined
        : "1px solid var(--cocoa-separator)",
      borderBottom: narrow
        ? "1px solid var(--cocoa-separator)"
        : undefined
    }),
    [narrow]
  );

  const brandBlockStyle: CSSProperties = {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: narrow ? "center" : "flex-start",
    gap: 8,
    textAlign: narrow ? "center" : "left",
    maxWidth: 520
  };

  const brandMarkStyle: CSSProperties = {
    margin: 0,
    fontFamily: "var(--cocoa-font)",
    fontSize: narrow ? 36 : 56,
    fontWeight: 600,
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1.05,
    color: "var(--cocoa-label)"
  };

  const subtitleStyle: CSSProperties = {
    margin: 0,
    fontFamily: "var(--cocoa-font)",
    fontStyle: "italic",
    fontSize: narrow ? 14 : 18,
    fontWeight: 400,
    color: "var(--cocoa-label-secondary)",
    lineHeight: 1.35
  };

  const formColumnStyle = useMemo<CSSProperties>(
    () => ({
      flex: narrow ? "1 1 auto" : "1 1 50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: narrow ? "24px 16px" : "48px",
      background: "var(--cocoa-background-window)"
    }),
    [narrow]
  );

  const cardWrapperStyle: CSSProperties = {
    width: "100%",
    maxWidth: 400,
    display: "flex"
  };

  const cardInnerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    width: "100%"
  };

  const titleStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-title-1)",
    lineHeight: "var(--cocoa-lh-title-1)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    color: "var(--cocoa-label)"
  };

  const fieldsetInnerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 14
  };

  const rememberRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap"
  };

  const rememberLabelStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    color: "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-subheadline)",
    cursor: isBusy ? "not-allowed" : "pointer",
    userSelect: "none"
  };

  const forgotLinkStyle: CSSProperties = {
    background: "transparent",
    border: "none",
    padding: 0,
    color: "var(--cocoa-accent)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-subheadline)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    cursor: isBusy ? "not-allowed" : "pointer",
    textDecoration: "none"
  };

  const separatorRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    color: "var(--cocoa-label-tertiary)",
    fontSize: "var(--cocoa-fs-subheadline)"
  };

  const separatorRuleStyle: CSSProperties = {
    flex: 1,
    height: 1,
    background: "var(--cocoa-separator)"
  };

  const footerStyle: CSSProperties = {
    margin: 0,
    textAlign: "center",
    color: "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-subheadline)"
  };

  const footerLinkStyle: CSSProperties = {
    background: "transparent",
    border: "none",
    padding: 0,
    color: "var(--cocoa-accent)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-subheadline)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    cursor: "pointer",
    textDecoration: "none"
  };

  // Floating decoration shapes. Each shape is absolutely positioned over the
  // hero pane and uses the local `cocoa-float-*` keyframes (defined inline
  // below) for a subtle vertical drift. Shapes are hidden in narrow mode to
  // keep the compact hero clean.
  const decoBaseStyle: CSSProperties = {
    position: "absolute",
    opacity: 0.55,
    pointerEvents: "none",
    filter: "saturate(120%)"
  };

  const circleStyle: CSSProperties = {
    ...decoBaseStyle,
    top: "18%",
    left: "12%",
    width: 96,
    height: 96,
    borderRadius: "50%",
    background:
      "radial-gradient(circle at 30% 30%, rgba(0, 100, 225, 0.35), rgba(0, 100, 225, 0.10) 70%)",
    animation: "cocoa-float-a 7s ease-in-out infinite"
  };

  const triangleStyle: CSSProperties = {
    ...decoBaseStyle,
    bottom: "20%",
    right: "16%",
    width: 0,
    height: 0,
    borderLeft: "44px solid transparent",
    borderRight: "44px solid transparent",
    borderBottom: "76px solid rgba(40, 167, 69, 0.30)",
    animation: "cocoa-float-b 9s ease-in-out infinite"
  };

  const squareStyle: CSSProperties = {
    ...decoBaseStyle,
    top: "55%",
    left: "62%",
    width: 80,
    height: 80,
    borderRadius: 18,
    background:
      "linear-gradient(135deg, rgba(0, 100, 225, 0.28), rgba(40, 167, 69, 0.22))",
    animation: "cocoa-float-c 11s ease-in-out infinite"
  };

  return (
    <div style={rootStyle}>
      <style>{`
        @keyframes cocoa-float-a {
          0%, 100% { transform: translateY(0) }
          50% { transform: translateY(-14px) }
        }
        @keyframes cocoa-float-b {
          0%, 100% { transform: translateY(0) }
          50% { transform: translateY(-18px) }
        }
        @keyframes cocoa-float-c {
          0%, 100% { transform: translateY(0) }
          50% { transform: translateY(-10px) }
        }
        @media (prefers-reduced-motion: reduce) {
          .cocoa-login-deco { animation: none !important }
        }
      `}</style>

      <section style={heroStyle} aria-hidden={narrow ? "true" : undefined}>
        {!narrow ? (
          <>
            <span className="cocoa-login-deco" style={circleStyle} />
            <span className="cocoa-login-deco" style={triangleStyle} />
            <span className="cocoa-login-deco" style={squareStyle} />
          </>
        ) : null}
        <div style={brandBlockStyle}>
          <h1 style={brandMarkStyle}>HotelOS</h1>
          <p style={subtitleStyle}>
            Aurora Cocoa Edition · PMS+ERP nativo español
          </p>
        </div>
      </section>

      <section style={formColumnStyle}>
        <div style={cardWrapperStyle}>
          <CocoaCard variant="elevated" padding="lg">
            <form onSubmit={handleSubmit} style={cardInnerStyle} noValidate>
              <h2 style={titleStyle}>Iniciar sesión</h2>

              <CocoaFormFieldset title="Cuenta">
                <div style={fieldsetInnerStyle}>
                  <div ref={emailWrapperRef}>
                    <LabelledField label="Email">
                      <CocoaInput
                        type="email"
                        value={email}
                        onChange={setEmail}
                        placeholder="usted@hotel.com"
                        disabled={isBusy}
                        required
                        inputMode="email"
                      />
                    </LabelledField>
                  </div>
                  <LabelledField label="Contraseña">
                    <CocoaInput
                      type="password"
                      value={password}
                      onChange={setPassword}
                      placeholder="••••••••"
                      disabled={isBusy}
                      required
                    />
                  </LabelledField>
                </div>
              </CocoaFormFieldset>

              <div style={rememberRowStyle}>
                <label htmlFor={rememberId} style={rememberLabelStyle}>
                  <input
                    id={rememberId}
                    type="checkbox"
                    checked={remember}
                    onChange={(event) => setRemember(event.target.checked)}
                    disabled={isBusy}
                    style={{ cursor: isBusy ? "not-allowed" : "pointer" }}
                  />
                  <span>Recordarme</span>
                </label>
                <button
                  type="button"
                  style={forgotLinkStyle}
                  disabled={isBusy}
                  onClick={() => {
                    /* Navigation surface is owned by the caller; placeholder. */
                  }}
                >
                  ¿Olvidó contraseña?
                </button>
              </div>

              <div style={{ display: "flex", width: "100%" }}>
                <div style={{ flex: 1, display: "flex" }}>
                  <CocoaButton
                    type="submit"
                    variant="filled"
                    tone="accent"
                    size="large"
                    loading={isBusy}
                    disabled={!canSubmit}
                    style={{ width: "100%", flex: 1 }}
                  >
                    Entrar
                  </CocoaButton>
                </div>
              </div>

              <div style={separatorRowStyle}>
                <span style={separatorRuleStyle} aria-hidden="true" />
                <span>o</span>
                <span style={separatorRuleStyle} aria-hidden="true" />
              </div>

              <div style={{ display: "flex", width: "100%" }}>
                <div style={{ flex: 1, display: "flex" }}>
                  <CocoaButton
                    type="button"
                    variant="bordered"
                    tone="neutral"
                    icon={<GoogleGlyph />}
                    disabled={isBusy}
                    style={{ width: "100%", flex: 1 }}
                  >
                    Continuar con Google SSO
                  </CocoaButton>
                </div>
              </div>

              <p style={footerStyle}>
                ¿No tienes cuenta?{" "}
                <button
                  type="button"
                  style={footerLinkStyle}
                  onClick={() => {
                    /* Sales contact navigation is owned by the caller. */
                  }}
                >
                  Contacta con ventas
                </button>
              </p>
            </form>
          </CocoaCard>
        </div>
      </section>

      <CocoaAlert
        open={alertOpen}
        type="critical"
        title="No se pudo iniciar sesión"
        message={error}
        primaryAction={{
          label: "Entendido",
          onClick: () => setAlertOpen(false)
        }}
        onClose={() => setAlertOpen(false)}
      />
    </div>
  );
}

export default CocoaLoginScreen;

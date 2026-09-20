import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { claimKiosk, setGuestToken, setKioskToken, signIn, signInWithToken } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";
import { BRAND } from "../config/brand";
import { LangContext } from "../components/Layout";
import { CheckInWizardPage } from "../pages/CheckInWizardPage";
import type { KioskContext } from "../pages/CheckInWizardPage";
import { ArrivalPage } from "../pages/ArrivalPage";
import type { ArrivalOutcome } from "../pages/ArrivalPage";
import { pickLanguage, t } from "../checkin/wizard";
import type { Lang } from "../checkin/wizard";
import { IDLE_TIMEOUT_MS, IDLE_WARNING_MS, createIdleTimer, readKioskDevice, resetSession, writeKioskDevice } from "./kiosk-mode";
import type { KioskDeviceCredential, KioskParams } from "./kiosk-mode";

// Tanda CHK · W4-C — modo kiosco (`?kiosk=1&device=<id>`; diseño §4c columna
// «Kiosco / tablet» y §8 fila «Kiosco»): pantalla completa, botones grandes,
// emparejamiento por código de 8 dígitos (POST /guest-portal/check-in/kiosk/claim
// → deviceToken en localStorage de la tablet, `x-kiosk-token` en cada llamada),
// localización por código de invitación o código de reserva + correo, el mismo
// asistente que el portal, inactividad 90 s → reinicio y borrado de la sesión
// del huésped, y handoff con el nº de ticket que devuelve el servidor cuando recepción tiene que intervenir.
//
// Tanda L7 · L7-05 — accesibilidad WCAG 2.2 AA en la tablet (§7.1; recon §14):
//   · el idioma del kiosco se publica por LangContext (selector es/en en la
//     cabecera del asistente y de la llegada, `<html lang>` sincronizado);
//   · aviso de inactividad `role="alert"` (2.2.1 Timing Adjustable): la frase se
//     anuncia una vez, la cuenta atrás visible no se relee cada segundo y el
//     botón «Continuar» (≥ 56 px, `.gp-button-big`) prolonga la sesión;
//   · códigos con `<label htmlFor>` + `id`, `inputMode="numeric"` y
//     `autoComplete="one-time-code"` (emparejamiento), errores en regiones
//     vivas, `aria-busy` en los formularios y foco al título de cada pantalla.

type Screen = "pairing" | "idle" | "locate" | "wizard" | "arrival";

/** Segundos del aviso previo (kiosk-mode IDLE_WARNING_MS): 15. */
export const IDLE_WARNING_SECONDS = Math.ceil(IDLE_WARNING_MS / 1000);

function tokenFromInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return (url.searchParams.get("token") ?? "").trim();
    }
  } catch {
    // not a URL: treat as a raw token
  }
  return trimmed;
}

/** Ventana máxima de espera a `requestFullscreen()`: algunos navegadores de tablet (y los headless) no resuelven nunca la promesa. */
const FULLSCREEN_WAIT_MS = 1_500;

async function requestFullscreen(): Promise<void> {
  try {
    const element = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
    if (element.requestFullscreen && !document.fullscreenElement) {
      // Never block the kiosk on fullscreen: proceed after FULLSCREEN_WAIT_MS if the promise does not settle.
      await Promise.race([element.requestFullscreen(), new Promise<void>((resolve) => window.setTimeout(resolve, FULLSCREEN_WAIT_MS))]);
    }
  } catch {
    // Fullscreen needs a user gesture and may be refused: the kiosk still works.
  }
}

export function KioskShell({ params }: { params: KioskParams }) {
  const { session, setSession, signOut } = useGuestSession();
  const [lang, setLang] = useState<Lang>(() => pickLanguage(typeof navigator !== "undefined" ? navigator.language : "es"));
  const [device, setDevice] = useState<KioskDeviceCredential | null>(() => {
    const stored = typeof window !== "undefined" ? readKioskDevice(window.localStorage) : null;
    setKioskToken(stored?.token ?? null);
    return stored;
  });
  const [screen, setScreen] = useState<Screen>(device ? "idle" : "pairing");
  const [code, setCode] = useState("");
  const [invitation, setInvitation] = useState("");
  const [reservationCode, setReservationCode] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ArrivalOutcome | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof createIdleTimer> | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const id = useId();
  const ids = {
    pairIntro: `${id}-pair-intro`,
    pairCode: `${id}-pair-code`,
    locateIntro: `${id}-locate-intro`,
    invitation: `${id}-invitation`,
    reservationCode: `${id}-reservation-code`,
    email: `${id}-email`
  };

  // <html lang> sigue al idioma del kiosco (como App en el portal).
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang;
  }, [lang]);

  // Foco al título de la pantalla propia del kiosco al cambiar (el asistente y la llegada gestionan el suyo).
  useEffect(() => {
    if (screen === "pairing" || screen === "idle" || screen === "locate") headingRef.current?.focus({ preventScroll: true });
  }, [screen]);

  const reset = useCallback(() => {
    resetSession({ sessionStorage: typeof window !== "undefined" ? window.sessionStorage : null, clearGuestToken: () => setGuestToken(null), signOut });
    setOutcome(null);
    setInvitation("");
    setReservationCode("");
    setEmail("");
    setError(null);
    setSecondsLeft(null);
    setScreen(device ? "idle" : "pairing");
  }, [device, signOut]);

  // Idle timer: runs while a guest is on the screen (locate → wizard → arrival).
  useEffect(() => {
    const active = screen === "locate" || screen === "wizard" || screen === "arrival";
    if (!active) {
      timerRef.current?.stop();
      timerRef.current = null;
      setSecondsLeft(null);
      return;
    }
    const timer = createIdleTimer({ timeoutMs: IDLE_TIMEOUT_MS, onIdle: reset, onWarning: (seconds) => setSecondsLeft(seconds) });
    timerRef.current = timer;
    timer.touch();
    const touch = () => {
      setSecondsLeft(null);
      timer.touch();
    };
    const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart", "scroll"];
    for (const name of events) window.addEventListener(name, touch, { passive: true });
    return () => {
      for (const name of events) window.removeEventListener(name, touch);
      timer.stop();
    };
  }, [screen, reset]);

  // Countdown for the warning banner.
  useEffect(() => {
    if (secondsLeft === null || secondsLeft <= 0) return;
    const handle = window.setTimeout(() => setSecondsLeft((value) => (value === null ? null : Math.max(0, value - 1))), 1000);
    return () => window.clearTimeout(handle);
  }, [secondsLeft]);

  /** «Continuar» del aviso de inactividad: prolonga la sesión sin esperar al siguiente toque. */
  function stay() {
    setSecondsLeft(null);
    timerRef.current?.touch();
  }

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await claimKiosk(code);
      const credential: KioskDeviceCredential = { deviceId: result.device.id, token: result.deviceToken, name: result.device.name, propertyId: result.device.propertyId, capabilities: result.capabilities, pairedAt: new Date().toISOString() };
      writeKioskDevice(window.localStorage, credential);
      setKioskToken(credential.token);
      setDevice(credential);
      setCode("");
      setScreen("idle");
    } catch {
      setError(t(lang, "kioskPairInvalid"));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    await requestFullscreen();
    setScreen("locate");
  }

  async function locateByInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenFromInput(invitation);
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const next = await signInWithToken(token);
      if (!next) {
        setError(t(lang, "kioskNotFound"));
        return;
      }
      setSession(next);
      setScreen("wizard");
    } finally {
      setBusy(false);
    }
  }

  async function locateByCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await signIn({ reservationCode, email, propertyId: params.propertyId ?? device?.propertyId ?? undefined });
      setSession(next);
      setScreen("wizard");
    } catch {
      setError(t(lang, "kioskNotFound"));
    } finally {
      setBusy(false);
    }
  }

  const kioskContext: KioskContext | null = device ? { deviceId: device.deviceId, name: device.name, capabilities: device.capabilities } : null;
  // Corrector L7-REV-05: el ticket del mostrador lo devuelve el API en la derivación (outcome.ticket); aquí no se inventa ninguno.

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <div className={`gp-kiosk gp-kiosk-${screen}`}>
        {secondsLeft !== null && screen !== "idle" ? (
          <div className="gp-kiosk-idle-warning" role="alert">
            {/* Se anuncia una vez (frase fija); la cuenta atrás visible queda fuera del lector para no releerla cada segundo. */}
            <span className="gp-visually-hidden">{t(lang, "kioskIdleWarning", { seconds: IDLE_WARNING_SECONDS })}</span>
            <div className="gp-stacked">
              <span aria-hidden>{t(lang, "kioskIdleWarning", { seconds: secondsLeft })}</span>
              <button type="button" className="gp-button gp-button-primary gp-button-big" onClick={stay}>
                {t(lang, "next")}
              </button>
            </div>
          </div>
        ) : null}

        {screen === "pairing" ? (
          <main className="gp-kiosk-screen">
            <span className="gp-wordmark">{BRAND.name}</span>
            <h1 tabIndex={-1} ref={headingRef}>{t(lang, "kioskPairTitle")}</h1>
            <p className="gp-subtitle" id={ids.pairIntro}>{t(lang, "kioskPairIntro")}</p>
            <form className="gp-card gp-form gp-kiosk-form" onSubmit={(event) => void pair(event)} noValidate aria-busy={busy}>
              <label className="gp-field" htmlFor={ids.pairCode}>
                <span>{t(lang, "kioskPairCode")}</span>
                <input id={ids.pairCode} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={9} value={code} onChange={(event) => setCode(event.target.value)} className="gp-kiosk-code" aria-describedby={ids.pairIntro} aria-invalid={error ? true : undefined} />
              </label>
              <div aria-live="polite">{error ? <p className="gp-error" role="alert">{error}</p> : null}</div>
              <button type="submit" className="gp-button gp-button-primary gp-button-big" disabled={busy || code.replace(/\D/g, "").length !== 8}>
                {t(lang, "kioskPair")}
              </button>
              {params.deviceId ? <p className="gp-hint">{t(lang, "kioskDevice", { name: params.deviceId })}</p> : null}
            </form>
          </main>
        ) : null}

        {screen === "idle" ? (
          <main className="gp-kiosk-screen gp-kiosk-attract">
            <span className="gp-wordmark">{BRAND.name}</span>
            <h1 tabIndex={-1} ref={headingRef}>{t(lang, "kioskTitle")}</h1>
            <button type="button" className="gp-button gp-button-primary gp-button-huge" onClick={() => void start()}>
              {t(lang, "kioskTouch")}
            </button>
            <button type="button" className="gp-link gp-lang" onClick={() => setLang(lang === "es" ? "en" : "es")} lang={lang === "es" ? "en" : "es"} aria-label={t(lang, "langSelector")}>
              {t(lang, "language")}
            </button>
            {device ? <p className="gp-hint">{t(lang, "kioskDevice", { name: device.name ?? device.deviceId })}</p> : null}
          </main>
        ) : null}

        {screen === "locate" ? (
          <main className="gp-kiosk-screen">
            <span className="gp-wordmark">{BRAND.name}</span>
            <h1 tabIndex={-1} ref={headingRef}>{t(lang, "kioskLocateTitle")}</h1>
            <p className="gp-subtitle" id={ids.locateIntro}>{t(lang, "kioskLocateIntro")}</p>
            <form className="gp-card gp-form gp-kiosk-form" onSubmit={(event) => void locateByInvitation(event)} noValidate aria-busy={busy}>
              <label className="gp-field" htmlFor={ids.invitation}>
                <span>{t(lang, "kioskInvitationToken")}</span>
                <input id={ids.invitation} type="text" autoComplete="off" value={invitation} onChange={(event) => setInvitation(event.target.value)} aria-describedby={ids.locateIntro} />
              </label>
              <button type="submit" className="gp-button gp-button-primary gp-button-big" disabled={busy || !tokenFromInput(invitation)}>
                {t(lang, "kioskFind")}
              </button>
            </form>
            <form className="gp-card gp-form gp-kiosk-form" onSubmit={(event) => void locateByCode(event)} noValidate aria-busy={busy}>
              <label className="gp-field" htmlFor={ids.reservationCode}>
                <span>{t(lang, "reservationCode")}</span>
                <input id={ids.reservationCode} type="text" autoComplete="off" value={reservationCode} onChange={(event) => setReservationCode(event.target.value)} />
              </label>
              <label className="gp-field" htmlFor={ids.email}>
                <span>{t(lang, "email")}</span>
                <input id={ids.email} type="email" autoComplete="off" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <button type="submit" className="gp-button gp-button-ghost gp-button-big" disabled={busy || !reservationCode.trim() || !email.trim()}>
                {t(lang, "kioskFind")}
              </button>
            </form>
            <div aria-live="polite">{error ? <p className="gp-error" role="alert">{error}</p> : null}</div>
            <button type="button" className="gp-link" onClick={reset}>
              {t(lang, "cancel")}
            </button>
          </main>
        ) : null}

        {screen === "wizard" && session ? <CheckInWizardPage lang={lang} onLangChange={setLang} onBack={reset} kiosk={kioskContext} onArrived={(result) => { setOutcome(result); setScreen("arrival"); }} /> : null}

        {screen === "arrival" && outcome ? <ArrivalPage lang={lang} outcome={outcome} kiosk onBack={reset} backLabel={t(lang, "kioskFinish")} /> : null}
      </div>
    </LangContext.Provider>
  );
}

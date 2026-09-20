import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { claimKiosk, setGuestToken, setKioskToken, signIn, signInWithToken } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";
import { BRAND } from "../config/brand";
import { CheckInWizardPage } from "../pages/CheckInWizardPage";
import type { KioskContext } from "../pages/CheckInWizardPage";
import { ArrivalPage } from "../pages/ArrivalPage";
import type { ArrivalOutcome } from "../pages/ArrivalPage";
import { pickLanguage, t } from "../checkin/wizard";
import type { Lang } from "../checkin/wizard";
import { IDLE_TIMEOUT_MS, createIdleTimer, handoffTicket, readKioskDevice, resetSession, writeKioskDevice } from "./kiosk-mode";
import type { KioskDeviceCredential, KioskParams } from "./kiosk-mode";

// Tanda CHK · W4-C — modo kiosco (`?kiosk=1&device=<id>`; diseño §4c columna
// «Kiosco / tablet» y §8 fila «Kiosco»): pantalla completa, botones grandes,
// emparejamiento por código de 8 dígitos (POST /guest-portal/check-in/kiosk/claim
// → deviceToken en localStorage de la tablet, `x-kiosk-token` en cada llamada),
// localización por código de invitación o código de reserva + correo, el mismo
// asistente que el portal, inactividad 90 s → reinicio y borrado de la sesión
// del huésped, y handoff con nº de ticket cuando recepción tiene que intervenir.

type Screen = "pairing" | "idle" | "locate" | "wizard" | "arrival";

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

async function requestFullscreen(): Promise<void> {
  try {
    const element = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
    if (element.requestFullscreen && !document.fullscreenElement) await element.requestFullscreen();
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
  const ticket = session ? handoffTicket(session.reservationId, new Date()) : null;

  return (
    <div className={`gp-kiosk gp-kiosk-${screen}`}>
      {secondsLeft !== null && screen !== "idle" ? (
        <div className="gp-kiosk-idle-warning" role="status" aria-live="polite">
          {t(lang, "kioskIdleWarning", { seconds: secondsLeft })}
        </div>
      ) : null}

      {screen === "pairing" ? (
        <main className="gp-kiosk-screen">
          <span className="gp-wordmark">{BRAND.name}</span>
          <h1>{t(lang, "kioskPairTitle")}</h1>
          <p className="gp-subtitle">{t(lang, "kioskPairIntro")}</p>
          <form className="gp-card gp-form gp-kiosk-form" onSubmit={(event) => void pair(event)} noValidate>
            <label className="gp-field">
              <span>{t(lang, "kioskPairCode")}</span>
              <input type="text" inputMode="numeric" autoComplete="off" maxLength={9} value={code} onChange={(event) => setCode(event.target.value)} className="gp-kiosk-code" />
            </label>
            {error ? <p className="gp-error" role="alert">{error}</p> : null}
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
          <h1>{t(lang, "kioskTitle")}</h1>
          <button type="button" className="gp-button gp-button-primary gp-button-huge" onClick={() => void start()}>
            {t(lang, "kioskTouch")}
          </button>
          <button type="button" className="gp-link gp-lang" onClick={() => setLang(lang === "es" ? "en" : "es")}>
            {t(lang, "language")}
          </button>
          {device ? <p className="gp-hint">{t(lang, "kioskDevice", { name: device.name ?? device.deviceId })}</p> : null}
        </main>
      ) : null}

      {screen === "locate" ? (
        <main className="gp-kiosk-screen">
          <span className="gp-wordmark">{BRAND.name}</span>
          <h1>{t(lang, "kioskLocateTitle")}</h1>
          <p className="gp-subtitle">{t(lang, "kioskLocateIntro")}</p>
          <form className="gp-card gp-form gp-kiosk-form" onSubmit={(event) => void locateByInvitation(event)} noValidate>
            <label className="gp-field">
              <span>{t(lang, "kioskInvitationToken")}</span>
              <input type="text" autoComplete="off" value={invitation} onChange={(event) => setInvitation(event.target.value)} />
            </label>
            <button type="submit" className="gp-button gp-button-primary gp-button-big" disabled={busy || !tokenFromInput(invitation)}>
              {t(lang, "kioskFind")}
            </button>
          </form>
          <form className="gp-card gp-form gp-kiosk-form" onSubmit={(event) => void locateByCode(event)} noValidate>
            <label className="gp-field">
              <span>{t(lang, "reservationCode")}</span>
              <input type="text" autoComplete="off" value={reservationCode} onChange={(event) => setReservationCode(event.target.value)} />
            </label>
            <label className="gp-field">
              <span>{t(lang, "email")}</span>
              <input type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <button type="submit" className="gp-button gp-button-ghost gp-button-big" disabled={busy || !reservationCode.trim() || !email.trim()}>
              {t(lang, "kioskFind")}
            </button>
          </form>
          {error ? <p className="gp-error" role="alert">{error}</p> : null}
          <button type="button" className="gp-link" onClick={reset}>
            {t(lang, "cancel")}
          </button>
        </main>
      ) : null}

      {screen === "wizard" && session ? <CheckInWizardPage lang={lang} onLangChange={setLang} onBack={reset} kiosk={kioskContext} onArrived={(result) => { setOutcome(result); setScreen("arrival"); }} /> : null}

      {screen === "arrival" && outcome ? <ArrivalPage lang={lang} outcome={outcome} kiosk ticket={ticket} onBack={reset} backLabel={t(lang, "kioskFinish")} /> : null}
    </div>
  );
}

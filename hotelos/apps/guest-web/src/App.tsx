import { useContext, useEffect, useRef, useState } from "react";
import { GuestSessionProvider, useGuestSession } from "./auth/GuestSessionContext";
import { signInWithToken } from "./api/client";
import { LangContext } from "./components/Layout";
import { SignInPage } from "./pages/SignInPage";
import { StayOverviewPage } from "./pages/StayOverviewPage";
import { PreCheckInPage } from "./pages/PreCheckInPage";
import { ServiceRequestPage } from "./pages/ServiceRequestPage";
import { CheckInWizardPage } from "./pages/CheckInWizardPage";
import { ArrivalPage } from "./pages/ArrivalPage";
import type { ArrivalOutcome } from "./pages/ArrivalPage";
import { CheckOutPage } from "./pages/CheckOutPage";
import { StayInfoPage } from "./pages/StayInfoPage";
import { SurveyPage } from "./pages/SurveyPage";
import type { Destination } from "./pages/StayOverviewPage";
import { KioskShell } from "./kiosk/KioskShell";
import { GUEST_ARRIVAL_STORAGE_KEY, parseKioskParams } from "./kiosk/kiosk-mode";
import { pickLanguage, t } from "./checkin/wizard";
import type { CopyKey, Lang } from "./checkin/wizard";

// Tanda L7 · L7-06: «checkout» (cuenta, pago honesto y peticiones de salida) e
// «info» (datos del hotel). L7-08: «survey» (encuesta post-estancia, contrato L7-04).
type Page = "overview" | "precheckin" | "service" | "checkin" | "arrival" | "checkout" | "info" | "survey";

/**
 * Read a magic-link `?token=` from the current URL (Sprint 45). Returns the
 * token (if any) and always strips it from the address bar via
 * history.replaceState so the single-use token does not linger in the URL,
 * browser history, or referrer headers.
 */
function consumeUrlToken(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (!token) return null;

  // Remove the token from the URL but keep the rest of the path/query intact.
  params.delete("token");
  const remaining = params.toString();
  const cleanUrl = `${window.location.pathname}${remaining ? `?${remaining}` : ""}${window.location.hash}`;
  try {
    window.history.replaceState({}, document.title, cleanUrl);
  } catch {
    // ignore environments without a usable history API
  }
  return token.trim() || null;
}

/**
 * Tanda CHK · W4-C: the invitation link is `GUEST_WEB_BASE_URL/checkin?token=…`
 * (diseño §4a paso 2). `/checkin` (any trailing path segment) or `?checkin=1`
 * opens the 6-step wizard straight away once the token signs the guest in.
 */
function wantsCheckInWizard(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/checkin" || path.endsWith("/checkin")) return true;
  try {
    return new URLSearchParams(window.location.search).get("checkin") === "1";
  } catch {
    return false;
  }
}

/**
 * Tanda L7 · L7-08: el correo de la encuesta post-estancia enlaza
 * `GUEST_WEB_BASE_URL/?survey=1&token=…&property=…` (post-stay-survey.service.ts
 * buildSurveyUrl). `?survey=1` (o un path que termine en `/survey`) abre la
 * página de encuesta en cuanto el token —o el código de reserva— firma al huésped.
 */
function wantsSurvey(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/survey" || path.endsWith("/survey")) return true;
  try {
    return new URLSearchParams(window.location.search).get("survey") === "1";
  } catch {
    return false;
  }
}

function storeArrival(outcome: ArrivalOutcome): void {
  if (!outcome.ok || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(GUEST_ARRIVAL_STORAGE_KEY, JSON.stringify(outcome.data));
  } catch {
    // ignore
  }
}

// Tanda L7 · L7-01: el idioma vive en App (LangContext); aquí solo se lee y se
// reenvía al asistente, que conserva su prop `lang`/`onLangChange`.
function Router({ linkError, initialPage }: { linkError: CopyKey | null; initialPage: Page }) {
  const { session, signOut } = useGuestSession();
  const [page, setPage] = useState<Page>(initialPage);
  const langContext = useContext(LangContext);
  const lang: Lang = langContext?.lang ?? "es";
  const setLang = (next: Lang) => langContext?.setLang(next);
  const [arrival, setArrival] = useState<ArrivalOutcome | null>(null);

  if (!session) {
    return <SignInPage initialError={linkError ? t(lang, linkError) : null} />;
  }

  // Corrector L7-REV-01: la sesión del enlace de la encuesta solo abre la encuesta;
  // «volver» cierra la sesión y ofrece entrar con el código de reserva.
  if (session.scope === "survey") {
    return <SurveyPage scoped onBack={signOut} />;
  }

  if (page === "precheckin") {
    return <PreCheckInPage onBack={() => setPage("overview")} />;
  }

  if (page === "service") {
    return <ServiceRequestPage onBack={() => setPage("overview")} />;
  }

  if (page === "checkout") {
    return <CheckOutPage onBack={() => setPage("overview")} />;
  }

  if (page === "info") {
    return <StayInfoPage onBack={() => setPage("overview")} />;
  }

  if (page === "survey") {
    return <SurveyPage onBack={() => setPage("overview")} />;
  }

  if (page === "checkin") {
    return (
      <CheckInWizardPage
        lang={lang}
        onLangChange={setLang}
        onBack={() => setPage("overview")}
        onArrived={(outcome) => {
          storeArrival(outcome);
          setArrival(outcome);
          setPage("arrival");
        }}
      />
    );
  }

  if (page === "arrival" && arrival) {
    return <ArrivalPage lang={lang} outcome={arrival} onBack={() => setPage("overview")} reservationCode={session.reservationCode} />;
  }

  return (
    <StayOverviewPage
      lang={lang}
      surveyEnabled
      onNavigate={(destination: Destination) => {
        if (destination === "arrival") {
          // Re-open the last arrival stored in this tab (StayOverviewPage.readStoredArrival).
          try {
            const raw = window.sessionStorage.getItem(GUEST_ARRIVAL_STORAGE_KEY);
            if (raw) setArrival({ ok: true, data: JSON.parse(raw), at: new Date().toISOString() });
          } catch {
            return;
          }
        }
        setPage(destination);
      }}
    />
  );
}

function Bootstrap() {
  const { session, setSession } = useGuestSession();
  const lang = useContext(LangContext)?.lang ?? "es";
  // "pending" while we verify a magic-link token; "done" otherwise.
  const [status, setStatus] = useState<"checking" | "ready">("checking");
  // Clave de copy (no texto): se traduce al pintar, así cambia con el idioma.
  const [linkError, setLinkError] = useState<CopyKey | null>(null);
  // Decided once, before the token is stripped from the URL.
  const [initialPage, setInitialPage] = useState<Page>(() => (wantsCheckInWizard() ? "checkin" : wantsSurvey() ? "survey" : "overview"));
  // Corrector REV-L7-06: tras «Cerrar sesión» el siguiente huésped de la misma pestaña
  // aterriza en SU estancia, no en la última página del anterior (el Router se
  // remonta por reserva —`key`— y la página inicial vuelve a la estancia).
  const hadSession = useRef(false);
  useEffect(() => {
    if (session) {
      hadSession.current = true;
    } else if (hadSession.current) {
      setInitialPage("overview");
    }
  }, [session]);
  // Guard against React 18 StrictMode double-invocation consuming the token twice.
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    const token = consumeUrlToken();
    if (!token) {
      setStatus("ready");
      return;
    }

    let cancelled = false;
    void (async () => {
      // Corrector L7-REV-01: el enlace de la encuesta se verifica contra la encuesta (sesión acotada).
      const next = await signInWithToken(token, wantsSurvey() ? { scope: "survey" } : {});
      if (cancelled) return;
      if (next) {
        setSession(next);
      } else {
        setLinkError("linkExpired");
      }
      setStatus("ready");
    })();

    return () => {
      cancelled = true;
    };
  }, [setSession]);

  if (status === "checking" && !session) {
    return (
      <div className="gp-bootstrap" role="status" aria-live="polite">
        {t(lang, "signingIn")}
      </div>
    );
  }

  return <Router key={session?.reservationId ?? "anon"} linkError={linkError} initialPage={initialPage} />;
}

export function App() {
  // Tanda L7 · L7-01: idioma del portal elevado a App (español por defecto,
  // inglés si el navegador lo pide) y sincronizado con <html lang> para los
  // lectores de pantalla y el corrector del navegador.
  const [lang, setLang] = useState<Lang>(() => pickLanguage(typeof navigator !== "undefined" ? navigator.language : "es"));
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang;
  }, [lang]);

  // Tanda CHK · W4-C: `?kiosk=1&device=<id>` monta la tablet de recepción
  // (pantalla completa, sin persistir nunca la sesión del huésped).
  const kiosk = parseKioskParams(typeof window !== "undefined" ? window.location : null);
  if (kiosk.enabled) {
    return (
      <GuestSessionProvider persist={false}>
        <KioskShell params={kiosk} />
      </GuestSessionProvider>
    );
  }
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <GuestSessionProvider>
        <Bootstrap />
      </GuestSessionProvider>
    </LangContext.Provider>
  );
}

export default App;

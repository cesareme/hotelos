import { useEffect, useRef, useState } from "react";
import { GuestSessionProvider, useGuestSession } from "./auth/GuestSessionContext";
import { signInWithToken } from "./api/client";
import { SignInPage } from "./pages/SignInPage";
import { StayOverviewPage } from "./pages/StayOverviewPage";
import { PreCheckInPage } from "./pages/PreCheckInPage";
import { ServiceRequestPage } from "./pages/ServiceRequestPage";
import { CheckInWizardPage } from "./pages/CheckInWizardPage";
import { ArrivalPage } from "./pages/ArrivalPage";
import type { ArrivalOutcome } from "./pages/ArrivalPage";
import { KioskShell } from "./kiosk/KioskShell";
import { GUEST_ARRIVAL_STORAGE_KEY, parseKioskParams } from "./kiosk/kiosk-mode";
import { pickLanguage } from "./checkin/wizard";
import type { Lang } from "./checkin/wizard";

type Page = "overview" | "precheckin" | "service" | "checkin" | "arrival";

const EXPIRED_LINK_MESSAGE =
  "Your sign-in link expired or is no longer valid. Please request a new one below.";

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

function storeArrival(outcome: ArrivalOutcome): void {
  if (!outcome.ok || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(GUEST_ARRIVAL_STORAGE_KEY, JSON.stringify(outcome.data));
  } catch {
    // ignore
  }
}

function Router({ linkError, initialPage }: { linkError: string | null; initialPage: Page }) {
  const { session } = useGuestSession();
  const [page, setPage] = useState<Page>(initialPage);
  const [lang, setLang] = useState<Lang>(() => pickLanguage(typeof navigator !== "undefined" ? navigator.language : "es"));
  const [arrival, setArrival] = useState<ArrivalOutcome | null>(null);

  if (!session) {
    return <SignInPage initialError={linkError} />;
  }

  if (page === "precheckin") {
    return <PreCheckInPage onBack={() => setPage("overview")} />;
  }

  if (page === "service") {
    return <ServiceRequestPage onBack={() => setPage("overview")} />;
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
      onNavigate={(destination: "precheckin" | "service" | "concierge" | "checkin" | "arrival") => {
        if (destination === "concierge") return;
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
  // "pending" while we verify a magic-link token; "done" otherwise.
  const [status, setStatus] = useState<"checking" | "ready">("checking");
  const [linkError, setLinkError] = useState<string | null>(null);
  // Decided once, before the token is stripped from the URL.
  const [initialPage] = useState<Page>(() => (wantsCheckInWizard() ? "checkin" : "overview"));
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
      const next = await signInWithToken(token);
      if (cancelled) return;
      if (next) {
        setSession(next);
      } else {
        setLinkError(EXPIRED_LINK_MESSAGE);
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
        Signing you in…
      </div>
    );
  }

  return <Router linkError={linkError} initialPage={initialPage} />;
}

export function App() {
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
    <GuestSessionProvider>
      <Bootstrap />
    </GuestSessionProvider>
  );
}

export default App;

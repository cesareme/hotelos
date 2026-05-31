import { useEffect, useRef, useState } from "react";
import { GuestSessionProvider, useGuestSession } from "./auth/GuestSessionContext";
import { signInWithToken } from "./api/client";
import { SignInPage } from "./pages/SignInPage";
import { StayOverviewPage } from "./pages/StayOverviewPage";
import { PreCheckInPage } from "./pages/PreCheckInPage";
import { ServiceRequestPage } from "./pages/ServiceRequestPage";

type Page = "overview" | "precheckin" | "service";

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

function Router({ linkError }: { linkError: string | null }) {
  const { session } = useGuestSession();
  const [page, setPage] = useState<Page>("overview");

  if (!session) {
    return <SignInPage initialError={linkError} />;
  }

  if (page === "precheckin") {
    return <PreCheckInPage onBack={() => setPage("overview")} />;
  }

  if (page === "service") {
    return <ServiceRequestPage onBack={() => setPage("overview")} />;
  }

  return (
    <StayOverviewPage
      onNavigate={(destination: "precheckin" | "service" | "concierge") => {
        if (destination === "concierge") return;
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

  return <Router linkError={linkError} />;
}

export function App() {
  return (
    <GuestSessionProvider>
      <Bootstrap />
    </GuestSessionProvider>
  );
}

export default App;

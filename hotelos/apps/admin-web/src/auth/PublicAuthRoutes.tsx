// PublicAuthRoutes — the only place the shell looks at the URL BEFORE the
// AuthGate (Tanda 3 · CFG-P1-6, contract I).
//
// The admin-web shell has no router: App.tsx maps pathnames to screens only
// once a user is logged in, and any unknown path fell to FrontDeskDashboard.
// Links sent by email (/accept-invite?token=…, /reset-password?token=…) must
// render even when another session is stored in this browser, so App.tsx
// renders this component before the AuthGate:
//
//   <PublicAuthRoutes>            // or: const pub = PublicAuthRoutes(); if (pub) return pub;
//     <AuthGate>…</AuthGate>
//   </PublicAuthRoutes>
//
// It returns
//   • AcceptInviteScreen   for /accept-invite
//   • ResetPasswordScreen  for /reset-password
//   • ChangePasswordScreen when the stored session must rotate its password
//     (user.mustChangePassword from the login payload, or a 403
//     PASSWORD_CHANGE_REQUIRED recorded by services/api-client.ts)
//   • otherwise `children` (null when none are given), i.e. the normal shell.
//
// The token travels in the query string; it is read once and never logged.

import { useEffect, useState, type JSX, type ReactNode } from "react";
import { getUser, onAuthChange } from "../services/auth-storage";
import { isPasswordChangeRequired, onPasswordChangeRequired } from "../services/api-client";
import { sessionMustChangePassword } from "../services/authApi";
import { AcceptInviteScreen } from "../screens/auth/AcceptInviteScreen";
import { ResetPasswordScreen } from "../screens/auth/ResetPasswordScreen";
import { ChangePasswordScreen } from "../screens/auth/ChangePasswordScreen";

export const ACCEPT_INVITE_PATH = "/accept-invite";
export const RESET_PASSWORD_PATH = "/reset-password";

export type PublicAuthRoute = "accept-invite" | "reset-password";

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/** Which public auth screen (if any) a pathname maps to. Pure; usable outside React. */
export function matchPublicAuthRoute(pathname: string = typeof window === "undefined" ? "/" : window.location.pathname): PublicAuthRoute | null {
  const path = normalizePath(pathname);
  if (path === ACCEPT_INVITE_PATH) return "accept-invite";
  if (path === RESET_PASSWORD_PATH) return "reset-password";
  return null;
}

function readToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = new URLSearchParams(window.location.search).get("token");
  return token && token.trim().length > 0 ? token.trim() : null;
}

function mustChangePasswordNow(): boolean {
  if (!getUser()) return false;
  return isPasswordChangeRequired() || sessionMustChangePassword();
}

export type PublicAuthRoutesProps = {
  /** Rendered when no public auth screen applies (typically the AuthGate). */
  children?: ReactNode;
};

export function PublicAuthRoutes(props: PublicAuthRoutesProps = {}): JSX.Element | null {
  const [route, setRoute] = useState<PublicAuthRoute | null>(() => matchPublicAuthRoute());
  const [token, setToken] = useState<string | null>(() => readToken());
  const [mustChange, setMustChange] = useState<boolean>(() => mustChangePasswordNow());

  useEffect(() => {
    function syncLocation() {
      setRoute(matchPublicAuthRoute());
      setToken(readToken());
    }
    window.addEventListener("popstate", syncLocation);
    return () => window.removeEventListener("popstate", syncLocation);
  }, []);

  useEffect(() => {
    const recompute = () => setMustChange(mustChangePasswordNow());
    const offAuth = onAuthChange(recompute);
    const offRequired = onPasswordChangeRequired(recompute);
    return () => {
      offAuth();
      offRequired();
    };
  }, []);

  if (route === "accept-invite") return <AcceptInviteScreen token={token} />;
  if (route === "reset-password") return <ResetPasswordScreen token={token} />;
  if (mustChange) return <ChangePasswordScreen required />;
  return props.children === undefined ? null : <>{props.children}</>;
}

export default PublicAuthRoutes;

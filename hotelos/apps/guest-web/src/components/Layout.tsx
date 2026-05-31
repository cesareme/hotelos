import type { ReactNode } from "react";
import { useGuestSession } from "../auth/GuestSessionContext";

type LayoutProps = {
  propertyName?: string;
  reservationCode?: string;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  back?: { label: string; onClick: () => void };
  children: ReactNode;
  footer?: ReactNode;
};

export function Layout({ propertyName, reservationCode, eyebrow, title, subtitle, back, children, footer }: LayoutProps) {
  const { session, signOut } = useGuestSession();
  return (
    <div className="gp-shell">
      <header className="gp-header">
        <div className="gp-header-top">
          {back ? (
            <button type="button" className="gp-link" onClick={back.onClick}>
              <span aria-hidden>&larr;</span> {back.label}
            </button>
          ) : (
            <span className="gp-wordmark">HotelOS</span>
          )}
          {session ? (
            <button type="button" className="gp-link" onClick={signOut}>
              Sign out
            </button>
          ) : null}
        </div>
        <div className="gp-hero">
          {eyebrow ? <p className="gp-eyebrow">{eyebrow}</p> : null}
          <h1>{title}</h1>
          {subtitle ? <p className="gp-subtitle">{subtitle}</p> : null}
          {propertyName || reservationCode ? (
            <div className="gp-hero-meta">
              {propertyName ? <span>{propertyName}</span> : null}
              {reservationCode ? <span className="gp-hero-code">{reservationCode}</span> : null}
            </div>
          ) : null}
        </div>
      </header>
      <main className="gp-main">{children}</main>
      {footer ? <footer className="gp-footer">{footer}</footer> : null}
    </div>
  );
}

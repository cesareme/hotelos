import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useGuestSession } from "../auth/GuestSessionContext";
import { BRAND } from "../config/brand";
import { t } from "../checkin/wizard";
import type { Lang } from "../checkin/wizard";

// Tanda L7 · L7-01: el idioma del portal vive en App (estado elevado) y llega
// aquí por contexto; las páginas lo leen con `useLang()` y el selector es/en
// de la cabecera lo cambia. Sin proveedor (modo kiosco, que gestiona su propio
// idioma en KioskShell) no se pinta el selector y el copy sale en español.
export type LangContextValue = { lang: Lang; setLang: (lang: Lang) => void };

export const LangContext = createContext<LangContextValue | null>(null);

/** Idioma activo del portal ("es" si no hay proveedor). */
export function useLang(): Lang {
  return useContext(LangContext)?.lang ?? "es";
}

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

const LANGS: readonly { code: Lang; short: string; nameKey: "langEs" | "langEn" }[] = [
  { code: "es", short: "ES", nameKey: "langEs" },
  { code: "en", short: "EN", nameKey: "langEn" }
];

export function Layout({ propertyName, reservationCode, eyebrow, title, subtitle, back, children, footer }: LayoutProps) {
  const { session, signOut } = useGuestSession();
  const langContext = useContext(LangContext);
  const lang = langContext?.lang ?? "es";
  return (
    <div className="gp-shell">
      <a className="gp-skip" href="#gp-main">
        {t(lang, "skipToContent")}
      </a>
      <header className="gp-header">
        <div className="gp-header-top">
          {back ? (
            <button type="button" className="gp-link" onClick={back.onClick}>
              <span aria-hidden>&larr;</span> {back.label}
            </button>
          ) : (
            <span className="gp-wordmark">{BRAND.name}</span>
          )}
          <div className="gp-header-tools">
            {langContext ? (
              <div className="gp-lang-switch" role="group" aria-label={t(lang, "langSelector")}>
                {LANGS.map((option) => (
                  <button
                    key={option.code}
                    type="button"
                    lang={option.code}
                    className={`gp-link gp-lang${lang === option.code ? " is-active" : ""}`}
                    aria-pressed={lang === option.code}
                    aria-label={t(lang, option.nameKey)}
                    onClick={() => langContext.setLang(option.code)}
                  >
                    {option.short}
                  </button>
                ))}
              </div>
            ) : null}
            {session ? (
              <button type="button" className="gp-link" onClick={signOut}>
                {t(lang, "signOut")}
              </button>
            ) : null}
          </div>
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
      <main id="gp-main" className="gp-main" tabIndex={-1}>
        {children}
      </main>
      {footer ? <footer className="gp-footer">{footer}</footer> : null}
    </div>
  );
}

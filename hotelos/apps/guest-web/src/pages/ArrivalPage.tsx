import { Layout } from "../components/Layout";
import { QrCode } from "../components/QrCode";
import { StatusPill } from "../components/StatusPill";
import type { ArriveResponse } from "../api/client";
import { describeArrivalError, formatClockTime, t } from "../checkin/wizard";
import type { ArrivalErrorView, Lang } from "../checkin/wizard";

// Tanda CHK · W4-C (diseño §4c «Móvil del huésped» y §8): resultado de
// POST /guest-portal/check-in/arrive. Éxito → habitación (número, planta) y
// llave (QR / Apple / Google Wallet) o «recoge tu llave en recepción»; 409 →
// mensaje por código (ROOM_NOT_READY «lista a las HH:MM», ventana de fechas,
// identidad, saldo, firmas) y, en modo kiosco, ticket de handoff para el
// mostrador (kiosk/kiosk-mode.ts handoffTicket).

export type ArrivalOutcome =
  | { ok: true; data: ArriveResponse; at: string; /** Zona horaria de la propiedad (corrector REV3-14). */ timeZone?: string }
  | { ok: false; code: string | null; message: string; details: Record<string, unknown> | null; at: string; timeZone?: string };

/** «22/09/2026 02:00» en la zona de la propiedad (o del navegador si no se conoce); null si la fecha no es válida. */
export function formatKeyValidity(iso: string, lang: Lang, timeZone?: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) }).format(date);
  } catch {
    return `${date.toISOString().slice(0, 10)} ${formatClockTime(iso, lang) ?? ""}`.trim();
  }
}

export type ArrivalPageProps = {
  lang: Lang;
  outcome: ArrivalOutcome;
  onBack: () => void;
  backLabel?: string;
  kiosk?: boolean;
  /** Ticket de handoff (kiosco) cuando recepción debe intervenir. */
  ticket?: string | null;
  propertyName?: string;
  reservationCode?: string;
  timeZone?: string;
};

function walletHref(payload: unknown): string | null {
  if (typeof payload === "string" && /^(https?:|data:)/i.test(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["url", "saveUrl", "downloadUrl", "href"]) {
      if (typeof record[key] === "string" && /^(https?:|data:)/i.test(record[key] as string)) return record[key] as string;
    }
  }
  return null;
}

function KeyBlock({ lang, data, timeZone }: { lang: Lang; data: ArriveResponse; timeZone?: string }) {
  const key = data.key;
  if (!key) {
    return (
      <section className="gp-card gp-arrival-key">
        <p className="gp-label">{t(lang, "arrivalKey")}</p>
        <p className="gp-value">{t(lang, "keyAtReception")}</p>
      </section>
    );
  }
  const apple = key.wallet.apple.signedByApple ? walletHref(key.wallet.apple.pass) : null;
  const google = walletHref(key.wallet.google);
  return (
    <section className="gp-card gp-arrival-key">
      <p className="gp-label">{t(lang, "arrivalKey")}</p>
      <p className="gp-meta">{t(lang, "arrivalKeyHint")}</p>
      {/* Corrector REV3-14: QR escaneable (SVG inline) en vez del payload como texto; serie como referencia. */}
      <div className="gp-qr">
        <QrCode value={key.qr} label={t(lang, "arrivalKey")} />
        <span className="gp-qr-serial">{key.serialNumber}</span>
      </div>
      <p className="gp-meta">
        {formatKeyValidity(key.validFrom, lang, timeZone)} → {formatKeyValidity(key.validUntil, lang, timeZone)}
        {timeZone ? ` (${timeZone})` : ""}
      </p>
      <div className="gp-stacked">
        {apple ? (
          <a className="gp-button gp-button-primary" href={apple}>
            {t(lang, "addToApple")}
          </a>
        ) : null}
        {google ? (
          <a className="gp-button gp-button-ghost" href={google}>
            {t(lang, "addToGoogle")}
          </a>
        ) : null}
      </div>
    </section>
  );
}

export function ArrivalPage({ lang, outcome, onBack, backLabel, kiosk = false, ticket = null, propertyName, reservationCode, timeZone: timeZoneProp }: ArrivalPageProps) {
  const back = { label: backLabel ?? (kiosk ? t(lang, "kioskFinish") : t(lang, "backToStay")), onClick: onBack };
  const timeZone = timeZoneProp ?? outcome.timeZone;

  if (outcome.ok) {
    const { data } = outcome;
    return (
      <Layout eyebrow={t(lang, "stepArrival")} title={t(lang, "arrivalWelcome")} propertyName={propertyName} reservationCode={reservationCode} back={back}>
        <section className="gp-card gp-arrival-room" role="status">
          <p className="gp-label">{t(lang, "arrivalRoom")}</p>
          <p className="gp-room-number">{data.room.number}</p>
          {data.room.floor ? <p className="gp-meta">{t(lang, "arrivalFloor", { floor: data.room.floor })}</p> : null}
          <div className="gp-arrival-badges">
            <StatusPill label={t(lang, "statusCheckedIn")} tone="ok" />
            {data.key ? <StatusPill label={t(lang, "keyIssued")} tone="info" /> : <StatusPill label={t(lang, "keyPending")} tone="warn" />}
          </div>
        </section>
        <KeyBlock lang={lang} data={data} timeZone={timeZone} />
        {data.warnings.length > 0 ? (
          <section className="gp-card">
            {data.warnings.map((line) => (
              <p key={line} className="gp-meta">
                {line}
              </p>
            ))}
          </section>
        ) : null}
        <button type="button" className="gp-button gp-button-primary" onClick={onBack}>
          {back.label}
        </button>
      </Layout>
    );
  }

  const view: ArrivalErrorView = describeArrivalError(outcome.details as never, outcome.message, lang, timeZone);
  const showTicket = kiosk && view.handoff && ticket;
  return (
    <Layout eyebrow={t(lang, "stepArrival")} title={view.done ? t(lang, "arrivalWelcome") : showTicket ? t(lang, "handoffTitle") : t(lang, "stepArrival")} propertyName={propertyName} reservationCode={reservationCode} back={back}>
      <section className={`gp-card ${view.done ? "gp-success" : "gp-arrival-pending"}`} role="status">
        <p className="gp-arrival-message">{view.message}</p>
        {outcome.code ? <p className="gp-meta">{outcome.code}</p> : null}
        {showTicket ? (
          <div className="gp-handoff">
            <p className="gp-confirmation">{t(lang, "handoffTicket", { ticket })}</p>
            <p className="gp-meta">{t(lang, "handoffHint")}</p>
          </div>
        ) : null}
      </section>
      <button type="button" className="gp-button gp-button-primary" onClick={onBack}>
        {back.label}
      </button>
    </Layout>
  );
}

import { useEffect, useState } from "react";
import { Layout, useLang } from "../components/Layout";
import { getStay, isApiError } from "../api/client";
import type { StayView } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";
import { isApiConfigured } from "../config/guest-config";
import { t } from "../checkin/wizard";
import { STAGE_HINT_KEY, formatDay, formatDayLong, infoRows, stageOf, telHref } from "../stay/stay";

// Tanda L7 · L7-06 · «Información del hotel»: SOLO lo que el API devuelve en
// `GuestStayView.info` (PropertyAiSetting.configurationJson.faq + Property.address,
// las mismas claves que lee el bot). Lo que el hotel no ha configurado no se
// pinta ni se inventa: la página lo dice y remite a recepción. El teléfono es
// un enlace `tel:` solo si el valor parece un número.

export function StayInfoPage({ onBack }: { onBack: () => void }) {
  const { session } = useGuestSession();
  const lang = useLang();
  const [stay, setStay] = useState<StayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const apiConfigured = isApiConfigured();

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStay()
      .then((data) => {
        if (!cancelled) setStay(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(isApiError(err) && err.message ? err.message : t(lang, "stayLoadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const rows = stay ? infoRows(stay.info) : [];
  const stage = stay ? stageOf(stay) : null;
  const phoneHref = telHref(stay?.info.receptionPhone);

  return (
    <Layout
      eyebrow={t(lang, "infoEyebrow")}
      title={t(lang, "infoTitle")}
      subtitle={t(lang, "infoSubtitle")}
      propertyName={stay?.reservation.propertyName}
      reservationCode={stay?.reservation.reservationCode ?? session?.reservationCode}
      back={{ label: t(lang, "backToStay"), onClick: onBack }}
    >
      <div aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="gp-card gp-skeleton" role="status">
            {t(lang, "loadingReservation")}
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="gp-card gp-error" role="alert">
          {error}
        </div>
      ) : null}
      {!apiConfigured && stay ? <p className="gp-hint">{t(lang, "demoNoApi")}</p> : null}

      {stay && stage ? (
        <>
          <section className="gp-card gp-stay" aria-label={t(lang, "infoYourStay")}>
            <p className="gp-label">{t(lang, "infoYourStay")}</p>
            <dl className="gp-info-list">
              <div className="gp-info-row">
                <dt className="gp-label">{t(lang, "dates")}</dt>
                <dd className="gp-value">{`${formatDay(stay.reservation.arrivalDate, lang)} – ${formatDay(stay.reservation.departureDate, lang)}`}</dd>
              </div>
              <div className="gp-info-row">
                <dt className="gp-label">{t(lang, "room")}</dt>
                <dd className="gp-value">{stay.reservation.assignedRoomNumber ? `${stay.reservation.roomType ?? t(lang, "room")} · ${stay.reservation.assignedRoomNumber}` : stay.reservation.roomType ?? t(lang, "roomPending")}</dd>
              </div>
            </dl>
            <p className="gp-meta">{t(lang, STAGE_HINT_KEY[stage], { date: formatDayLong(stay.reservation.arrivalDate, lang) })}</p>
          </section>

          <section className="gp-card gp-info" aria-label={t(lang, "infoLabel")}>
            <p className="gp-label">{t(lang, "infoLabel")}</p>
            {rows.length === 0 ? <p className="gp-meta">{t(lang, "infoEmpty")}</p> : null}
            {rows.length > 0 ? (
              <dl className="gp-info-list">
                {rows.map((row) => (
                  <div key={row.key} className="gp-info-row">
                    <dt className="gp-label">{t(lang, row.labelKey)}</dt>
                    <dd className={`gp-value${row.kind === "secret" ? " gp-mono" : ""}`}>{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {phoneHref ? (
              <a className="gp-button gp-button-ghost" href={phoneHref}>
                {t(lang, "infoCall")}
              </a>
            ) : null}
            {rows.length > 0 && !stay.info.receptionPhone ? <p className="gp-meta">{t(lang, "contactAtReception")}</p> : null}
          </section>
        </>
      ) : null}
    </Layout>
  );
}

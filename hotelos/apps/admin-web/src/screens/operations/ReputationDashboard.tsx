// Reseñas — Comercial › Reputación y calidad (/comercial/reputacion, base
// tab of ReputacionTabs).
//
// Cocoa 22 · ola 7 · lote 7-B (docs/design/COCOA-22.md §4, archetype
// «dashboard alojado»): CocoaPage → CocoaKpiStrip (average rating with the
// sentiment, reviews 7 d / 30 d, pending answers) → CocoaGrid 6/6 (rating
// distribution with CocoaChart.Progress rows · reviews by source as a
// CocoaTable) → recent reviews as a section list. Read-only.
//
// Data: GET /dashboards/reputation, polled every 2 minutes — only once the
// reputation_quality module is known to be enabled (qa#14): while the module
// list loads the page keeps its skeleton, and with the module off it paints
// «Módulo no activado» (+ «Activar módulo» for users with modules.enable).

import type { CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { StarIcon } from "../../components/cocoa-icons/StatusIcons";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { dateTime, number, percent, plural } from "../../lib/format";
import { moduleDisabledCopy } from "./module-gate";
import { useScreenModuleGate } from "./useScreenModuleGate";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// Menu labels of the tree (Comercial › Reputación y calidad), never retyped here.
const HEADER = treeHeaderFor("ReputationDashboard", { eyebrow: "Comercial", title: "Reputación y calidad" });

type Kpis = {
  avgRating: number;
  reviewsLast7d: number;
  reviewsLast30d: number;
  pendingResponses: number;
  sentimentScore: number;
};
type RatingDistribution = { star1: number; star2: number; star3: number; star4: number; star5: number };
type SourceRow = { sourceName: string; count: number; avgRating: number };
type Review = {
  id: string;
  sourceName: string;
  ratingValue?: number;
  title?: string;
  body?: string;
  createdAt: string;
  respondedAt?: string;
};
type ReputationDashboardData = {
  kpis: Kpis;
  ratingDistribution: RatingDistribution;
  reviewsBySource: SourceRow[];
  recentReviews: Review[];
};

const EMPTY_KPIS: Kpis = { avgRating: 0, reviewsLast7d: 0, reviewsLast30d: 0, pendingResponses: 0, sentimentScore: 0 };
const EMPTY_DISTRIBUTION: RatingDistribution = { star1: 0, star2: 0, star3: 0, star4: 0, star5: 0 };
const MAX_ROWS = 12;

/** Tone of a rating out of 5: 4,5+ success · 3,5+ neutral · 2,5+ warning · below danger. */
function ratingTone(rating: number | undefined): CocoaTone {
  if (rating === undefined || rating === null) return "neutral";
  if (rating >= 4.5) return "success";
  if (rating >= 3.5) return "neutral";
  if (rating >= 2.5) return "warning";
  return "danger";
}

function avgRatingStatus(rating: number): CocoaKpiStatus {
  if (rating >= 4) return "ok";
  if (rating >= 3) return "warning";
  return "critical";
}

function sentimentLabel(score: number): string {
  if (score > 0.2) return "positivo";
  if (score < -0.2) return "negativo";
  return "neutro";
}

function fmtRating(rating: number): string {
  return number(rating, { maximumFractionDigits: 1 });
}

function RatingBadge({ rating }: { rating?: number }) {
  if (rating === undefined) {
    return (
      <CocoaBadge tone="neutral" size="small">
        sin valoración
      </CocoaBadge>
    );
  }
  return (
    <CocoaBadge tone={ratingTone(rating)} size="small" uppercase={false} icon={<StarIcon size={10} aria-hidden="true" />}>
      {fmtRating(rating)} / 5
    </CocoaBadge>
  );
}

// Footnote text (source, date) in the secondary ink; outside a literal `style={{…}}` (rule 6).
const footnoteStyle: CSSProperties = { fontSize: "var(--cocoa-fs-footnote)", color: "var(--cocoa-label-secondary)" };
const bodyStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-body)", lineHeight: "var(--cocoa-lh-body)", color: "var(--cocoa-label)" };

const SOURCE_COLUMNS: CocoaTableColumn<SourceRow>[] = [
  { key: "sourceName", label: "Fuente", render: (row) => <strong>{row.sourceName}</strong> },
  { key: "count", label: "Reseñas", align: "right", fit: true, render: (row) => number(row.count) },
  { key: "avgRating", label: "Valoración media", align: "right", fit: true, render: (row) => <RatingBadge rating={row.avgRating} /> }
];

// Mirror skeleton: the KPI strip, the 6/6 row and the reviews card.
function ReputationSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={220} />
      <CocoaSkeleton variant="card" height={240} />
    </div>
  );
}

export function ReputationDashboard() {
  // Hosted inside ReputacionTabs the container paints eyebrow + H1; CocoaPage adds the subtitle and actions row.
  const propertyName = getActiveProperty().propertyName;
  // Module gate (qa#14): no request (and no 2-minute poll) until reputation_quality is known to be enabled.
  const moduleGate = useScreenModuleGate("ReputationDashboard");
  const { data, loading, error, refresh } = useApiData<ReputationDashboardData>(moduleGate.ready ? "/dashboards/reputation" : null, { pollIntervalMs: 120000 });

  const kpis = data?.kpis ?? EMPTY_KPIS;
  const ratingDistribution = data?.ratingDistribution ?? EMPTY_DISTRIBUTION;
  const reviewsBySource = toArray<SourceRow>(data?.reviewsBySource);
  const recentReviews = toArray<Review>(data?.recentReviews);

  const distributionRows: Array<{ star: 1 | 2 | 3 | 4 | 5; label: string; count: number; tone: CocoaTone }> = [
    { star: 5, label: "5 estrellas", count: ratingDistribution.star5, tone: "success" },
    { star: 4, label: "4 estrellas", count: ratingDistribution.star4, tone: "success" },
    { star: 3, label: "3 estrellas", count: ratingDistribution.star3, tone: "neutral" },
    { star: 2, label: "2 estrellas", count: ratingDistribution.star2, tone: "warning" },
    { star: 1, label: "1 estrella", count: ratingDistribution.star1, tone: "danger" }
  ];
  const totalDistribution = distributionRows.reduce((total, row) => total + row.count, 0);

  // Module not active → the whole body is the «Módulo no activado» state (§3.10).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state =
    moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Opiniones de los huéspedes: valoración media, distribución por estrellas, volumen por canal y reseñas pendientes de respuesta. Se actualiza cada 2 minutos."
      actions={
        moduleGate.ready ? (
          <>
            {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
            {error && data ? (
              <CocoaBadge tone="danger" title={error}>
                {STATUS_LABELS.loadError}
              </CocoaBadge>
            ) : null}
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading}>
              {ACTIONS.refresh}
            </CocoaButton>
          </>
        ) : null
      }
      state={state}
      skeleton={<ReputationSkeleton />}
      empty={{
        title: disabledCopy.title,
        message: disabledCopy.message,
        primaryAction: disabledCopy.cta ? { label: disabledCopy.cta, onClick: moduleGate.enable } : undefined
      }}
      error={{ title: "No se pudo cargar la reputación", message: error ?? undefined, onRetry: refresh }}
      commands={
        moduleGate.ready
          ? [{ id: "reputation-refresh", label: "Actualizar reseñas", run: refresh }]
          : moduleDisabled && disabledCopy.cta
            ? [{ id: "reputation-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
            : []
      }
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de reputación">
        <CocoaKpi
          label="Valoración media"
          value={fmtRating(kpis.avgRating)}
          unit="/ 5"
          caption={`sentimiento ${sentimentLabel(kpis.sentimentScore)} (${number(kpis.sentimentScore, { maximumFractionDigits: 2 })})`}
          polarity="neutral"
          status={avgRatingStatus(kpis.avgRating)}
        />
        <CocoaKpi label="Reseñas · 7 días" value={number(kpis.reviewsLast7d)} caption="recibidas la última semana" polarity="neutral" status="ok" />
        <CocoaKpi label="Reseñas · 30 días" value={number(kpis.reviewsLast30d)} caption="recibidas el último mes" polarity="neutral" status="ok" />
        <CocoaKpi
          label="Respuestas pendientes"
          value={number(kpis.pendingResponses)}
          caption={kpis.pendingResponses > 0 ? "requieren atención" : "todo respondido"}
          polarity="negative-good"
          status={kpis.pendingResponses > 0 ? "warning" : "ok"}
        />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Distribución y fuentes">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Distribución por estrellas" meta={plural(totalDistribution, "reseña", "reseñas")}>
            {totalDistribution === 0 ? (
              <CocoaState kind="empty" inline title="Sin reseñas que representar." />
            ) : (
              <div className="cocoa-stack" data-gap="3">
                {distributionRows.map((row) => {
                  const pct = totalDistribution > 0 ? Math.round((row.count / totalDistribution) * 100) : 0;
                  return (
                    <CocoaChart.Progress
                      key={row.star}
                      value={pct}
                      tone={row.tone}
                      label={row.label}
                      valueLabel={`${number(row.count)} · ${percent(pct, { maximumFractionDigits: 0 })}`}
                      aria-label={`${row.label}: ${plural(row.count, "reseña", "reseñas")} (${percent(pct, { maximumFractionDigits: 0 })})`}
                    />
                  );
                })}
              </div>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Reseñas por fuente"
            meta={plural(reviewsBySource.length, "fuente", "fuentes")}
            padding={reviewsBySource.length === 0 ? "md" : "none"}
            style={{ overflow: "clip" }}
          >
            {reviewsBySource.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay reseñas en el periodo." />
            ) : (
              <CocoaTable columns={SOURCE_COLUMNS} rows={reviewsBySource.slice(0, MAX_ROWS)} rowKey="sourceName" caption="Reseñas por fuente" aria-label="Reseñas por fuente" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection title="Reseñas recientes" meta={plural(recentReviews.length, "reseña", "reseñas")}>
        {recentReviews.length === 0 ? (
          <CocoaState kind="empty" inline title="No hay reseñas recientes." />
        ) : (
          <ul className="c22-section__list" aria-label="Reseñas recientes">
            {recentReviews.slice(0, MAX_ROWS).map((review) => (
              <li key={review.id}>
                <div className="cocoa-stack" data-gap="1" style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <div className="cocoa-row" data-gap="2" data-justify="between">
                    <span className="cocoa-cluster">
                      <strong>{review.title || "(sin título)"}</strong>
                      <span style={footnoteStyle}>{review.sourceName}</span>
                    </span>
                    <RatingBadge rating={review.ratingValue} />
                  </div>
                  {review.body ? <p style={bodyStyle}>{review.body}</p> : null}
                  <span className="cocoa-cluster">
                    <span style={footnoteStyle}>{dateTime(review.createdAt)}</span>
                    {review.respondedAt ? (
                      <CocoaBadge tone="success" variant="dot" size="small">
                        respondida
                      </CocoaBadge>
                    ) : (
                      <CocoaBadge tone="warning" variant="dot" size="small">
                        pendiente de respuesta
                      </CocoaBadge>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CocoaSection>
    </CocoaPage>
  );
}

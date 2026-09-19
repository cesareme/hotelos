// Reseñas — Comercial › Reputación y calidad (/comercial/reputacion, base
// tab of ReputacionTabs).
//
// Tanda T8 · lote T8-G (Cocoa 22, archetype «dashboard alojado», operable):
// CocoaPage → CocoaKpiStrip (índice de reputación 0-100 a 30 días con tono y
// tendencia · reseñas 30 d · pendientes de respuesta · tasa de respuesta ·
// mediana de respuesta) → estado honesto del índice (sin fuentes → CTA
// «Configurar fuentes»; sin reseñas; «N reseñas · insuficiente (mínimo 10)»)
// → CocoaGrid 7/5 (Fuentes con estado real y acciones · Categorías con
// menciones e impacto) → CocoaGrid 4/8 (distribución de notas sobre 10 ·
// Bandeja con filtro de estado y fuente; una fila abre ReviewDetailDrawer).
// Fuentes, categorías y bandeja son componentes locales de este fichero
// (regla 7 del contrato: solo los *Drawer/*Dialog viven aparte).
//
// Data: GET /dashboards/reputation (poll 2 min) y GET /reputation/properties/
// :id/inbox (poll 2 min), ambos solo con el módulo reputation_quality activo
// (useScreenModuleGate, qa#14). Escrituras por services/reputationApi.ts desde
// los drawers; los permisos de escritura salen de useNavGate().grantedPermissions
// (reputation.respond · quality_cases.manage). Sin estilos en línea.

import { useEffect, useMemo, useState } from "react";
import { useToast } from "../../components/Toast";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { getUser } from "../../services/auth-storage";
import { useNavGate } from "../../navigation/useEnabledModules";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { dateTime, number, percent, plural } from "../../lib/format";
import { moduleDisabledCopy } from "./module-gate";
import { useScreenModuleGate } from "./useScreenModuleGate";
import {
  INDEX_MIN_REVIEWS,
  categoryLabel,
  formatIndex,
  formatScore10,
  indexTone,
  providerLabel,
  scoreTone,
  sentimentTone,
  sourceModeLabel,
  statusLabel,
  type ReputationCategoryImpact,
  type ReputationDashboardDto,
  type ReputationIndexResult,
  type ReputationIndexStatus,
  type ReputationScoreDistribution,
  type ReviewInboxItem,
  type ReviewSourceDto
} from "../../services/reputation-contracts";
import { reputationErrorMessage, reputationPropertyPath, reviewInboxQuery, syncReviewSource, type ReputationPage } from "../../services/reputationApi";
import {
  agoCopy,
  analysisBadge,
  analysisTitle,
  canManageQualityCases,
  canRespond,
  indexStatusCopy,
  inboxFilterOptions,
  inboxFilters,
  isInboxFilter,
  kpiStatusFromTone,
  reviewStatusTone,
  slaCopy,
  slaTone,
  sourceStateCopy,
  sourceStateTone,
  trendCaption,
  type InboxFilter
} from "./reputation/reputation-helpers";
import { ReviewDetailDrawer } from "./reputation/ReviewDetailDrawer";
import { ReviewImportDrawer } from "./reputation/ReviewImportDrawer";
import { ReviewSourceDrawer } from "./reputation/ReviewSourceDrawer";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  DegradedBanner,
  type CocoaBarsDatum,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// Menu labels of the tree (Comercial › Reputación y calidad), never retyped here.
const HEADER = treeHeaderFor("ReputationDashboard", { eyebrow: "Comercial", title: "Reputación y calidad" });

const DASHBOARD_POLL_MS = 120000;
const INBOX_POLL_MS = 120000;
const INBOX_PAGE = 25;
const INBOX_PAGE_MAX = 100;
const MAX_SOURCE_ROWS = 12;
const MAX_CATEGORY_BARS = 12;

const EMPTY_INDEX: ReputationIndexResult = { status: "no_sources", windowDays: 30, reviewCount: 0, bySource: [], categoryImpact: [] };
const EMPTY_DISTRIBUTION: ReputationScoreDistribution = { b0_2: 0, b2_4: 0, b4_6: 0, b6_8: 0, b8_10: 0 };
const EMPTY_INBOX = { open: 0, overdue: 0, drafted: 0, unassigned: 0 };

function toneOrNeutral(value: "success" | "warning" | "danger" | "neutral" | "info"): CocoaTone {
  return value;
}

// Mirror skeleton: the KPI strip, the 7/5 row and the 4/8 row.
function ReputationSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[7, 5], [4, 8]]} height={240} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fuentes
// ---------------------------------------------------------------------------

type SourcesSectionProps = {
  sources: ReviewSourceDto[];
  canWrite: boolean;
  onCreate: () => void;
  onEdit: (source: ReviewSourceDto) => void;
  onImport: () => void;
  onSynced: () => void;
};

function SourcesSection({ sources, canWrite, onCreate, onEdit, onImport, onSynced }: SourcesSectionProps) {
  const { showToast } = useToast();
  const [syncing, setSyncing] = useState<string | null>(null);

  const sync = async (source: ReviewSourceDto) => {
    setSyncing(source.id);
    try {
      const result = await syncReviewSource(source.id);
      const run = result.run;
      showToast(run.status === "failed" ? `${source.displayName}: la sincronización falló (${run.error ?? "sin detalle"}).` : `${source.displayName}: ${run.fetched} leídas · ${run.created} nuevas · ${run.updated} actualizadas.`, {
        variant: run.status === "failed" ? "error" : "success"
      });
      onSynced();
    } catch (err) {
      showToast(reputationErrorMessage(err, "No se pudo sincronizar la fuente."), { variant: "error" });
    } finally {
      setSyncing(null);
    }
  };

  const columns: CocoaTableColumn<ReviewSourceDto>[] = [
    {
      key: "displayName",
      label: "Proveedor",
      minWidth: 160,
      render: (row) => (
        <span className="cocoa-stack" data-gap="1">
          <strong>{row.displayName}</strong>
          <span className="cocoa-note">
            {providerLabel(row.provider)}
            {row.isDemo ? " · datos ficticios" : ""}
          </span>
        </span>
      )
    },
    { key: "mode", label: "Modo", fit: true, render: (row) => sourceModeLabel(row.mode) },
    {
      key: "status",
      label: "Estado",
      minWidth: 200,
      render: (row) => (
        <span className="cocoa-stack" data-gap="1">
          <span>
            <CocoaBadge tone={toneOrNeutral(sourceStateTone(row.status))} variant="dot" size="small" uppercase={false}>
              {sourceStateCopy(row.status, null, null).split(" · ")[0]}
            </CocoaBadge>
          </span>
          <span className="cocoa-note">{sourceStateCopy(row.status, row.lastError, row.lastRunAt)}</span>
        </span>
      )
    },
    { key: "lastRunAt", label: "Última ejecución", fit: true, hideOnNarrow: true, render: (row) => (row.lastRunAt ? dateTime(row.lastRunAt) : "—") },
    { key: "weight", label: "Peso", align: "right", fit: true, render: (row) => number(row.weight, { maximumFractionDigits: 2 }) }
  ];

  return (
    <CocoaSection
      title="Fuentes"
      meta={plural(sources.length, "fuente", "fuentes")}
      padding={sources.length === 0 ? "md" : "none"}
      action={
        canWrite ? (
          <span className="cocoa-cluster">
            <CocoaButton variant="plain" tone="accent" size="small" onClick={onImport}>
              Importar CSV
            </CocoaButton>
            <CocoaButton variant="plain" tone="accent" size="small" onClick={onCreate}>
              Nueva fuente
            </CocoaButton>
          </span>
        ) : undefined
      }
    >
      {sources.length === 0 ? (
        <CocoaState
          kind="empty"
          dashed
          title="Sin fuentes configuradas"
          message="Conecta un portal, el correo de notificaciones o importa un CSV exportado del portal."
          primaryAction={canWrite ? { label: "Configurar fuentes", onClick: onCreate } : undefined}
          secondaryAction={canWrite ? { label: "Importar CSV", onClick: onImport } : undefined}
        />
      ) : (
        <CocoaTable
          columns={columns}
          rows={sources.slice(0, MAX_SOURCE_ROWS)}
          rowKey="id"
          density="compact"
          caption="Fuentes de reseñas"
          aria-label="Fuentes de reseñas"
          rowActionsVisible="always"
          rowActions={
            canWrite
              ? (row) => (
                  <span className="cocoa-cluster">
                    {row.status !== "disabled" && row.status !== "unavailable" ? (
                      <CocoaButton variant="plain" tone="accent" size="small" onClick={() => void sync(row)} loading={syncing === row.id} disabled={syncing !== null}>
                        Sincronizar ahora
                      </CocoaButton>
                    ) : null}
                    {row.mode === "csv" ? (
                      <CocoaButton variant="plain" tone="accent" size="small" onClick={onImport}>
                        Importar CSV
                      </CocoaButton>
                    ) : null}
                    <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => onEdit(row)}>
                      {ACTIONS.edit}
                    </CocoaButton>
                  </span>
                )
              : undefined
          }
        />
      )}
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------

function CategoriesSection({ categories, status }: { categories: ReputationCategoryImpact[]; status: ReputationIndexStatus }) {
  const withMentions = categories.filter((row) => row.mentions > 0).slice(0, MAX_CATEGORY_BARS);
  const showImpact = status === "ok" && withMentions.some((row) => row.impact > 0);
  const bars: CocoaBarsDatum[] = withMentions.map((row) => ({
    label: categoryLabel(row.category),
    value: showImpact ? row.impact : row.mentions,
    tone: row.negativeMentions > 0 && row.negativeMentions * 2 >= row.mentions ? "danger" : row.negativeMentions > 0 ? "warning" : "success",
    hint: `${plural(row.mentions, "mención", "menciones")} · ${row.negativeMentions} negativas${showImpact ? ` · resta ${number(row.impact, { maximumFractionDigits: 1 })} puntos` : ""}`
  }));
  return (
    <CocoaSection title="Categorías" meta={showImpact ? "puntos de índice que resta cada categoría" : "menciones en la ventana"}>
      {bars.length === 0 ? (
        <CocoaState kind="empty" inline title="Sin categorías todavía: el análisis las rellena con cada reseña." />
      ) : (
        <CocoaChart.Bars data={bars} height={200} polarity={showImpact ? "negative-good" : "positive-good"} valueFormat={(value) => (showImpact ? `${number(value, { maximumFractionDigits: 1 })} pts` : number(value))} aria-label="Menciones e impacto por categoría" />
      )}
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Distribución de notas sobre 10
// ---------------------------------------------------------------------------

function DistributionSection({ distribution }: { distribution: ReputationScoreDistribution }) {
  const rows: Array<{ key: keyof ReputationScoreDistribution; label: string; tone: CocoaTone }> = [
    { key: "b8_10", label: "8 a 10", tone: "success" },
    { key: "b6_8", label: "6 a 8", tone: "warning" },
    { key: "b4_6", label: "4 a 6", tone: "danger" },
    { key: "b2_4", label: "2 a 4", tone: "danger" },
    { key: "b0_2", label: "0 a 2", tone: "danger" }
  ];
  const total = rows.reduce((sum, row) => sum + distribution[row.key], 0);
  return (
    <CocoaSection title="Notas sobre 10" meta={plural(total, "reseña", "reseñas")}>
      {total === 0 ? (
        <CocoaState kind="empty" inline title="Sin reseñas que representar." />
      ) : (
        <div className="cocoa-stack" data-gap="3">
          {rows.map((row) => {
            const count = distribution[row.key];
            const pct = Math.round((count / total) * 100);
            return (
              <CocoaChart.Progress
                key={row.key}
                value={pct}
                tone={row.tone}
                label={row.label}
                valueLabel={`${number(count)} · ${percent(pct, { maximumFractionDigits: 0 })}`}
                aria-label={`${row.label}: ${plural(count, "reseña", "reseñas")} (${percent(pct, { maximumFractionDigits: 0 })})`}
              />
            );
          })}
        </div>
      )}
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------

type InboxSectionProps = {
  ready: boolean;
  sources: ReviewSourceDto[];
  refreshKey: number;
  onOpen: (reviewId: string) => void;
};

function InboxSection({ ready, sources, refreshKey, onOpen }: InboxSectionProps) {
  const [filter, setFilter] = useState<InboxFilter>("open");
  const [source, setSource] = useState("");
  const [limit, setLimit] = useState(INBOX_PAGE);
  const query = useMemo(() => reviewInboxQuery(inboxFilters(filter, source, limit)), [filter, source, limit]);
  const { data, loading, error, refresh } = useApiData<ReputationPage<ReviewInboxItem>>(ready ? `${reputationPropertyPath()}/inbox` : null, { query, pollIntervalMs: INBOX_POLL_MS });

  useEffect(() => {
    if (refreshKey > 0) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const items = toArray<ReviewInboxItem>(data?.items);
  const total = data?.total ?? items.length;
  const sourceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of sources) if (!seen.has(row.provider)) seen.set(row.provider, row.displayName);
    return [{ value: "", label: "Todas las fuentes" }, ...[...seen.entries()].map(([value, label]) => ({ value, label }))];
  }, [sources]);

  const columns: CocoaTableColumn<ReviewInboxItem>[] = [
    { key: "receivedAt", label: "Recibida", fit: true, render: (row) => dateTime(row.receivedAt ?? row.createdAt, { style: "dayMonth" }) },
    { key: "provider", label: "Fuente", fit: true, hideOnNarrow: true, render: (row) => providerLabel(row.provider) },
    {
      key: "score10",
      label: "Nota",
      fit: true,
      render: (row) => (
        <CocoaBadge tone={row.score10 === null ? "neutral" : scoreTone(row.score10)} size="small" uppercase={false}>
          {formatScore10(row.score10)}
        </CocoaBadge>
      )
    },
    {
      key: "title",
      label: "Reseña",
      minWidth: 240,
      render: (row) => (
        <span className="cocoa-stack" data-gap="1">
          <strong>{row.title?.trim() || "(sin título)"}</strong>
          <span className="cocoa-note">{row.bodyPurged ? "Contenido purgado por retención" : (row.excerpt ?? "Sin texto")}</span>
        </span>
      )
    },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (row) => (
        <span className="cocoa-cluster">
          <CocoaBadge tone={toneOrNeutral(reviewStatusTone(row.status))} variant="dot" size="small">
            {statusLabel(row.status)}
          </CocoaBadge>
          {row.hasDraft && row.status !== "responded" ? (
            <CocoaBadge tone="info" variant="outline" size="small" uppercase={false}>
              borrador
            </CocoaBadge>
          ) : null}
          {row.qualityCaseId ? (
            <CocoaBadge tone="warning" variant="outline" size="small" uppercase={false}>
              caso
            </CocoaBadge>
          ) : null}
        </span>
      )
    },
    {
      key: "sla",
      label: "Plazo",
      fit: true,
      render: (row) => (
        <CocoaBadge tone={toneOrNeutral(slaTone(row))} variant="tinted" size="small" uppercase={false}>
          {slaCopy(row)}
        </CocoaBadge>
      )
    },
    {
      key: "analysis",
      label: "Análisis",
      fit: true,
      showFrom: "desktop",
      render: (row) => (
        <span className="cocoa-cluster">
          <CocoaBadge tone={toneOrNeutral(sentimentTone(row.sentiment))} variant="dot" size="small" uppercase={false} title={analysisTitle(row.analysisSource)}>
            {analysisBadge(row.analysisSource)}
          </CocoaBadge>
          {row.categories.slice(0, 2).map((mention) => (
            <CocoaBadge key={mention.category} tone="neutral" variant="outline" size="small" uppercase={false}>
              {categoryLabel(mention.category)}
            </CocoaBadge>
          ))}
        </span>
      )
    }
  ];

  return (
    <CocoaSection
      title="Bandeja"
      meta={data ? `${number(total)} ${filter === "all" ? "en total" : "con este filtro"}` : undefined}
      padding={items.length === 0 && !loading ? "md" : "none"}
      action={
        <span className="cocoa-cluster">
          <CocoaSegmentedControl
            value={filter}
            onChange={(value) => {
              if (isInboxFilter(value)) {
                setFilter(value);
                setLimit(INBOX_PAGE);
              }
            }}
            options={inboxFilterOptions()}
            size="small"
            aria-label="Filtro de estado de la bandeja"
          />
          <CocoaSelect value={source} onChange={(value) => (setSource(value), setLimit(INBOX_PAGE))} options={sourceOptions} size="small" inline aria-label="Filtro de fuente" />
        </span>
      }
      footer={
        data && data.nextCursor && limit < INBOX_PAGE_MAX ? (
          <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setLimit((current) => Math.min(INBOX_PAGE_MAX, current + INBOX_PAGE))} disabled={loading}>
            Mostrar más
          </CocoaButton>
        ) : undefined
      }
    >
      {error && !data ? (
        <CocoaState kind="error" inline title="No se pudo cargar la bandeja" message={error} onRetry={refresh} />
      ) : items.length === 0 && !loading ? (
        <CocoaState kind="empty" inline title={filter === "open" ? "Sin reseñas pendientes." : "No hay reseñas con este filtro."} />
      ) : (
        <CocoaTable columns={columns} rows={items} rowKey="id" loading={loading && !data} density="compact" caption="Bandeja de reseñas" aria-label="Bandeja de reseñas" onSelect={(row) => onOpen(row.id)} rowTitle={() => "Abrir la reseña"} rowTone={(row) => (row.overdue ? "danger" : undefined)} />
      )}
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------

export function ReputationDashboard() {
  // Hosted inside ReputacionTabs the container paints eyebrow + H1; CocoaPage adds the subtitle and actions row.
  const propertyName = getActiveProperty().propertyName;
  const propertyId = getActivePropertyId();
  const { showToast } = useToast();
  // Module gate (qa#14): no request (and no 2-minute poll) until reputation_quality is known to be enabled.
  const moduleGate = useScreenModuleGate("ReputationDashboard");
  const { data, loading, error, refresh } = useApiData<ReputationDashboardDto>(moduleGate.ready ? "/dashboards/reputation" : null, { pollIntervalMs: DASHBOARD_POLL_MS });
  const navGate = useNavGate(propertyId);
  const canWrite = canRespond(navGate.grantedPermissions);
  const canCases = canManageQualityCases(navGate.grantedPermissions);
  const currentUserId = getUser()?.userId ?? null;

  const [sourceDrawer, setSourceDrawer] = useState<{ open: boolean; source: ReviewSourceDto | null }>({ open: false, source: null });
  const [importOpen, setImportOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [inboxRefresh, setInboxRefresh] = useState(0);

  const refreshAll = () => {
    refresh();
    setInboxRefresh((n) => n + 1);
  };

  const kpis = data?.kpis ?? { avgRating: 0, reviewsLast7d: 0, reviewsLast30d: 0, pendingResponses: 0, sentimentScore: 0 };
  const index = data?.index ?? EMPTY_INDEX;
  const status: ReputationIndexStatus = data?.status ?? index.status ?? "no_sources";
  const sources = toArray<ReviewSourceDto>(data?.sources);
  const categories = toArray<ReputationCategoryImpact>(data?.categories);
  const distribution = data?.scoreDistribution ?? EMPTY_DISTRIBUTION;
  const inbox = data?.inbox ?? EMPTY_INBOX;
  const degraded = toArray<string>(data?.degraded);
  const indexValue = status === "ok" && typeof index.index === "number" ? index.index : null;
  const indexCopy = indexStatusCopy({ status, reviewCount: index.reviewCount });
  const pendingOpen = data ? inbox.open : kpis.pendingResponses;

  // Module not active → the whole body is the «Módulo no activado» state (§3.10).
  const moduleDisabled = moduleGate.status === "disabled";
  const disabledCopy = moduleDisabledCopy(moduleGate.canEnable);
  const state = moduleGate.status === "loading" ? "loading" : moduleDisabled ? "empty" : loading && !data ? "loading" : error && !data ? "error" : "ready";

  const openSourceDrawer = (source: ReviewSourceDto | null) => setSourceDrawer({ open: true, source });

  return (
    <>
      <CocoaPage
        eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
        title={HEADER.title}
        subtitle="Índice de reputación a 30 días, fuentes conectadas, categorías que restan puntos y bandeja de reseñas pendientes. Se actualiza cada 2 minutos."
        actions={
          moduleGate.ready ? (
            <>
              <DegradedBanner degraded={degraded} />
              {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
              {error && data ? (
                <CocoaBadge tone="danger" title={error}>
                  {STATUS_LABELS.loadError}
                </CocoaBadge>
              ) : null}
              {canWrite ? (
                <>
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setImportOpen(true)}>
                    Importar CSV
                  </CocoaButton>
                  <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => openSourceDrawer(null)}>
                    Configurar fuentes
                  </CocoaButton>
                </>
              ) : null}
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} disabled={loading}>
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
            ? [
                { id: "reputation-refresh", label: "Actualizar reseñas", run: refreshAll },
                ...(canWrite
                  ? [
                      { id: "reputation-new-source", label: "Configurar fuentes de reseñas", run: () => openSourceDrawer(null) },
                      { id: "reputation-import", label: "Importar reseñas (CSV)", run: () => setImportOpen(true) }
                    ]
                  : [])
              ]
            : moduleDisabled && disabledCopy.cta
              ? [{ id: "reputation-enable-module", label: `${disabledCopy.cta} · ${HEADER.title}`, run: moduleGate.enable }]
              : []
        }
      >
        <CocoaKpiStrip stagger aria-label="Indicadores de reputación">
          <CocoaKpi
            label="Índice de reputación (30 d)"
            value={formatIndex(indexValue)}
            unit={indexValue !== null ? "/ 100" : undefined}
            caption={indexValue !== null ? trendCaption(index.trendDelta) : (indexCopy ?? "Sin datos")}
            delta={indexValue !== null ? index.trendDelta : undefined}
            deltaUnit="pts"
            deltaLabel={indexValue !== null ? "vs 30 d anteriores" : undefined}
            polarity="positive-good"
            status={indexValue !== null ? kpiStatusFromTone(indexTone(indexValue)) : "warning"}
            degraded={degraded.includes("reputation.reviews")}
          />
          <CocoaKpi label="Reseñas · 30 días" value={number(kpis.reviewsLast30d)} caption={`${number(kpis.reviewsLast7d)} en los últimos 7 días`} polarity="neutral" status="ok" />
          <CocoaKpi
            label="Pendientes de respuesta"
            value={number(pendingOpen)}
            caption={inbox.overdue > 0 ? `${number(inbox.overdue)} fuera de plazo · ${number(inbox.unassigned)} sin asignar` : pendingOpen > 0 ? `${number(inbox.unassigned)} sin asignar` : "todo respondido"}
            polarity="negative-good"
            status={inbox.overdue > 0 ? "critical" : pendingOpen > 0 ? "warning" : "ok"}
          />
          <CocoaKpi
            label="Tasa de respuesta"
            value={typeof index.responseRatePct === "number" ? percent(index.responseRatePct, { maximumFractionDigits: 0 }) : "—"}
            caption="respondidas entre las que admiten respuesta (30 d)"
            polarity="positive-good"
            status={typeof index.responseRatePct === "number" ? (index.responseRatePct >= 80 ? "ok" : index.responseRatePct >= 50 ? "warning" : "critical") : "ok"}
          />
          <CocoaKpi
            label="Mediana de respuesta"
            value={typeof index.medianResponseHours === "number" ? number(index.medianResponseHours, { maximumFractionDigits: 0 }) : "—"}
            unit={typeof index.medianResponseHours === "number" ? "h" : undefined}
            caption="de la recepción a la respuesta"
            polarity="negative-good"
            status={typeof index.medianResponseHours === "number" ? (index.medianResponseHours <= 48 ? "ok" : index.medianResponseHours <= 96 ? "warning" : "critical") : "ok"}
          />
        </CocoaKpiStrip>

        {status !== "ok" ? (
          <CocoaState
            kind="empty"
            dashed
            illustration={status === "no_sources" ? "connection" : "box"}
            title={status === "no_sources" ? "Sin fuentes configuradas" : status === "no_reviews" ? "Sin reseñas en la ventana" : status === "module_off" ? "Módulo no activado" : (indexCopy ?? "Índice no disponible")}
            message={
              status === "no_sources"
                ? "El índice se calcula con las reseñas de las fuentes conectadas. Conecta un portal, el correo de notificaciones o importa un CSV."
                : status === "insufficient"
                  ? `El índice necesita al menos ${INDEX_MIN_REVIEWS} reseñas en 30 días; la bandeja y las fuentes ya funcionan.`
                  : "Sincroniza una fuente o importa un CSV para empezar a puntuar."
            }
            primaryAction={canWrite && status === "no_sources" ? { label: "Configurar fuentes", onClick: () => openSourceDrawer(null) } : undefined}
            secondaryAction={canWrite && (status === "no_sources" || status === "no_reviews") ? { label: "Importar CSV", onClick: () => setImportOpen(true) } : undefined}
          />
        ) : null}

        <CocoaGrid align="start" aria-label="Fuentes y categorías">
          <CocoaSpan cols={7} min={480}>
            <SourcesSection sources={sources} canWrite={canWrite} onCreate={() => openSourceDrawer(null)} onEdit={openSourceDrawer} onImport={() => setImportOpen(true)} onSynced={refreshAll} />
          </CocoaSpan>
          <CocoaSpan cols={5} min={320}>
            <CategoriesSection categories={categories.length > 0 ? categories : index.categoryImpact} status={status} />
          </CocoaSpan>
        </CocoaGrid>

        <CocoaGrid align="start" aria-label="Distribución y bandeja">
          <CocoaSpan cols={4} min={240}>
            <DistributionSection distribution={distribution} />
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            <InboxSection ready={moduleGate.ready} sources={sources} refreshKey={inboxRefresh} onOpen={setReviewId} />
          </CocoaSpan>
        </CocoaGrid>
      </CocoaPage>

      <ReviewSourceDrawer
        open={sourceDrawer.open}
        source={sourceDrawer.source}
        onClose={() => setSourceDrawer({ open: false, source: null })}
        onSaved={() => refreshAll()}
      />
      <ReviewImportDrawer
        open={importOpen}
        onClose={() => setImportOpen(false)}
        sources={sources}
        onImported={(result) => {
          if (result.created + result.updated > 0) showToast(`${number(result.created)} reseñas nuevas en la bandeja.`, { variant: "success" });
          refreshAll();
        }}
      />
      <ReviewDetailDrawer open={reviewId !== null} reviewId={reviewId} onClose={() => setReviewId(null)} onChanged={refreshAll} canRespond={canWrite} canManageCases={canCases} currentUserId={currentUserId} />
    </>
  );
}

// TicketBAI foral — /cumplimiento/verifactu/ticketbai (tab «TicketBAI (forales)»
// of VerifactuTabs). Cocoa 22 · ola 8 · lote 8-B (plantilla DashboardAlojado).
//
// Submissions to the Basque haciendas by territory (Bizkaia · Gipuzkoa · Araba
// · Navarra): the territory filter is the inner views of the hosted head, the
// selected territory paints its hacienda card («Verificar la cadena de huellas»
// calls /tbai/chain/:territory/verify), a KPI strip counts the submissions per
// territory and the history table lists them (CocoaTable: fit columns, the
// secondary ones from tablet / laptop, cards on phones).

import { useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  fetchTerritories,
  fetchSubmissions,
  verifyChain,
  type ForalTerritory,
  type TbaiSubmission,
  type TbaiTerritoryConfig
} from "../../services/tbaiApi";
import { EMPTY, dateTime, number, plural } from "../../lib/format";
import { STATUS_LABELS } from "../../content/actions";
import { submissionStatusLabel } from "./fiscal-shared";
import { useTabHost } from "../tabs/TabHost";
import { CheckCircleIcon, XCircleIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaStat,
  CocoaState,
  CocoaTable,
  type CocoaPageHeaderTab,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
const ALL_TERRITORIES = "all";
const DAY_MS = 86_400_000;

function fmtDateTime(iso: string | null): string {
  return dateTime(iso, { style: "dayMonth" });
}

const STATUS_TONE: Record<string, CocoaTone> = {
  delivered: "success",
  acknowledged: "success",
  accepted: "success",
  accepted_with_errors: "success",
  retrying: "warning",
  submitting: "warning",
  pending: "warning",
  queued: "warning",
  network_error: "warning",
  rejected: "danger",
  failed: "danger",
  abandoned: "danger"
};

function statusTone(status: string): CocoaTone {
  return STATUS_TONE[status] ?? "info";
}

// The Spanish label of every wire status is `submissionStatusLabel`
// (fiscal-shared.ts, shared with FiscalSubmissionsCenter and unit-tested).

/** Columns of the history table; the territory names come from the loaded config. */
function submissionColumns(config: Record<string, TbaiTerritoryConfig>): CocoaTableColumn<TbaiSubmission>[] {
  return [
    { key: "tbaiCode", label: "Código", fit: true, render: (s) => <strong className="cocoa-mono">{s.tbaiCode ?? s.id.slice(0, 16)}</strong> },
    { key: "territory", label: "Territorio", fit: true, render: (s) => config[s.territory]?.name ?? s.territory },
    { key: "status", label: "Estado", fit: true, render: (s) => <CocoaBadge tone={statusTone(s.status)}>{submissionStatusLabel(s.status)}</CocoaBadge> },
    {
      key: "tbaiHash",
      label: "Huella TBAI",
      showFrom: "laptop",
      render: (s) =>
        s.tbaiHash ? (
          <span className="cocoa-mono" title={s.tbaiHash}>
            {`${s.tbaiHash.slice(0, 16)}…`}
          </span>
        ) : (
          EMPTY
        )
    },
    { key: "attempts", label: "Intentos", align: "right", fit: true, render: (s) => number(s.attempts) },
    { key: "submittedAt", label: "Enviado", fit: true, showFrom: "tablet", render: (s) => fmtDateTime(s.submittedAt) },
    { key: "acknowledgedAt", label: "Confirmado", fit: true, showFrom: "tablet", render: (s) => fmtDateTime(s.acknowledgedAt) }
  ];
}

function TbaiSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton variant="card" height={220} />
    </div>
  );
}

export function TbaiForalScreen() {
  const hosted = useTabHost() !== null;
  const [territories, setTerritories] = useState<ForalTerritory[]>([]);
  const [config, setConfig] = useState<Record<string, TbaiTerritoryConfig>>({});
  const [active, setActive] = useState<ForalTerritory | "">("");
  const [submissions, setSubmissions] = useState<TbaiSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [chainResult, setChainResult] = useState<{ valid: boolean; inspected: number; brokenAt?: string } | null>(null);

  useEffect(() => {
    fetchTerritories()
      .then((r) => {
        setTerritories(r.items);
        setConfig(r.config);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error."));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchSubmissions(PROPERTY_ID, active || undefined)
      .then(setSubmissions)
      .catch((e) => setError(e instanceof Error ? e.message : "Error."))
      .finally(() => {
        setLoading(false);
        setLoadedOnce(true);
      });
  }, [active]);

  async function handleVerify() {
    if (!active) return;
    setVerifying(true);
    setChainResult(null);
    try {
      const r = await verifyChain(PROPERTY_ID, active);
      setChainResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error verificando la cadena.");
    } finally {
      setVerifying(false);
    }
  }

  const stats = useMemo(() => {
    const byTerritory: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const s of submissions) {
      byTerritory[s.territory] = (byTerritory[s.territory] ?? 0) + 1;
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }
    return { byTerritory, byStatus };
  }, [submissions]);

  const columns = useMemo(() => submissionColumns(config), [config]);

  const territoryTabs: CocoaPageHeaderTab[] = [
    { value: ALL_TERRITORIES, label: STATUS_LABELS.all },
    ...territories.map((t) => ({ value: t, label: config[t]?.name ?? t }))
  ];

  const activeConfig = active ? config[active] : undefined;
  const activeName = active ? (config[active]?.name ?? active) : "";
  const hasRows = submissions.length > 0;

  return (
    <CocoaPage
      eyebrow="Cumplimiento"
      title="TicketBAI"
      subtitle={hosted ? undefined : "Envíos a las haciendas forales con cadena de huellas TBAI, por territorio."}
      tabs={territoryTabs}
      activeTab={active || ALL_TERRITORIES}
      onTabChange={(value) => setActive(value === ALL_TERRITORIES ? "" : (value as ForalTerritory))}
      state={!loadedOnce && loading ? "loading" : "ready"}
      skeleton={<TbaiSkeleton />}
    >
      <CocoaCallout tone="info" role="note">
        Cada factura emitida en territorio foral se envía a la <strong>hacienda correspondiente</strong> con cadena de huellas TBAI (cada envío
        incluye la huella del anterior). Bizkaia exige el envío en 24 h como máximo.
      </CocoaCallout>

      {error ? (
        <CocoaCallout tone="danger" title={STATUS_LABELS.loadError} role="status">
          {error}
        </CocoaCallout>
      ) : null}

      {active && activeConfig ? (
        <CocoaSection
          title={activeConfig.hacienda}
          meta={activeConfig.name}
          action={
            <CocoaButton variant="plain" tone="accent" size="small" onClick={() => void handleVerify()} loading={verifying}>
              Verificar la cadena de huellas
            </CocoaButton>
          }
        >
          <div className="cocoa-row" data-gap="4" data-align="start">
            <CocoaStat label="Código ISO" value={activeConfig.isoCode} tabular={false} />
            <CocoaStat label="Plazo máximo" value={plural(Math.round(activeConfig.submissionDeadlineMs / DAY_MS), "día", "días")} tabular={false} />
            <CocoaStat
              label="Punto de conexión de pruebas"
              value={
                <span className="cocoa-mono cocoa-truncate" title={activeConfig.endpoints.sandbox} style={{ display: "block", maxWidth: "100%" }}>
                  {activeConfig.endpoints.sandbox}
                </span>
              }
              tabular={false}
              style={{ minWidth: 0, flex: "1 1 240px", maxWidth: "100%" }}
            />
          </div>
          {chainResult ? (
            <CocoaCallout
              tone={chainResult.valid ? "success" : "danger"}
              role="status"
              icon={chainResult.valid ? <CheckCircleIcon size={16} /> : <XCircleIcon size={16} />}
              title={chainResult.valid ? "Cadena íntegra" : "Cadena rota"}
            >
              {chainResult.valid
                ? `${plural(chainResult.inspected, "envío verificado", "envíos verificados")}.`
                : `${plural(chainResult.inspected, "envío inspeccionado", "envíos inspeccionados")} · rota en ${chainResult.brokenAt ?? EMPTY}.`}
            </CocoaCallout>
          ) : null}
        </CocoaSection>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Envíos TicketBAI por territorio">
        <CocoaKpi label="Envíos totales" value={number(submissions.length)} caption={active ? activeName : "Todos los territorios"} polarity="neutral" />
        {territories.slice(0, 3).map((t) => (
          <CocoaKpi key={t} label={config[t]?.name ?? t} value={number(stats.byTerritory[t] ?? 0)} polarity="neutral" />
        ))}
      </CocoaKpiStrip>

      <CocoaSection
        title="Histórico de envíos"
        meta={loading && hasRows ? STATUS_LABELS.loading : plural(submissions.length, "envío", "envíos")}
        padding={hasRows || loading ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {!loading && !hasRows ? (
          <CocoaState
            kind="empty"
            illustration="box"
            title="Sin envíos todavía"
            message={`No hay envíos TicketBAI para ${active ? activeName : "esta propiedad"}. Se crean automáticamente al emitir facturas en territorio foral.`}
          />
        ) : (
          <CocoaTable
            columns={columns}
            rows={submissions}
            rowKey="id"
            loading={loading && !hasRows}
            caption="Histórico de envíos TicketBAI"
            aria-label="Histórico de envíos TicketBAI"
          />
        )}
      </CocoaSection>
    </CocoaPage>
  );
}

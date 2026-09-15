// Ajustes contables (Tanda 3 · lote front-fiscal).
//
// Datos reales: GET /backoffice/properties/:id/accounting-settings (plantilla de
// plan contable, inicio de ejercicio, centros de coste) y GET
// /accounting/fiscal-periods?propertyId= (periodos con estado). Sin literales.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { fetchAccountingSettings, fetchFiscalPeriods, type AccountingSettings as AccountingSettingsPayload, type CostCenter, type FiscalPeriod } from "../services/billingApi";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { CocoaPageHeader } from "../components/cocoa/CocoaPageHeader";
import { pageHead } from "./tabs/configuracion/tab-helpers";
import { CocoaCard } from "../components/cocoa/CocoaCard";
import { CocoaButton } from "../components/cocoa/CocoaButton";
import { CocoaTable, type CocoaTableColumn } from "../components/cocoa/CocoaTable";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import { date } from "../lib/format";

const PROPERTY_ID = getActivePropertyId();

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const PERIOD_STATUS: Record<FiscalPeriod["status"], { label: string; tone: string }> = {
  open: { label: "Abierto", tone: "ok" },
  closing: { label: "En cierre", tone: "warn" },
  closed: { label: "Cerrado", tone: "info" }
};

const PERIOD_TYPE: Record<FiscalPeriod["periodType"], string> = { month: "Mes", quarter: "Trimestre", year: "Ejercicio" };

function fmtDate(value?: string | null): string {
  return date(value);
}

export function AccountingSettings({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside a tab container (Tanda 5) the page header belongs to the container: render a section head instead.
  const Head = pageHead(embedded);
  const [payload, setPayload] = useState<AccountingSettingsPayload | null>(null);
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [periodsError, setPeriodsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [settingsResult, periodsResult] = await Promise.allSettled([fetchAccountingSettings(PROPERTY_ID), fetchFiscalPeriods(PROPERTY_ID)]);
    if (settingsResult.status === "fulfilled") {
      setPayload(settingsResult.value);
    } else {
      setError(settingsResult.reason instanceof Error ? settingsResult.reason.message : "No se pudo cargar la configuración contable.");
    }
    if (periodsResult.status === "fulfilled") {
      setPeriods(toArray<FiscalPeriod>(periodsResult.value));
      setPeriodsError(null);
    } else {
      setPeriods([]);
      setPeriodsError(periodsResult.reason instanceof Error ? periodsResult.reason.message : "No se pudieron cargar los periodos fiscales.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const costCenters = useMemo(() => toArray<CostCenter>(payload?.costCenters), [payload]);
  const settings = payload?.settings;

  const periodColumns = useMemo<CocoaTableColumn<FiscalPeriod>[]>(
    () => [
      { key: "periodCode", label: "Periodo", render: (row) => <strong>{row.periodCode}</strong> },
      { key: "periodType", label: "Tipo", width: "110px", render: (row) => PERIOD_TYPE[row.periodType] ?? row.periodType },
      { key: "range", label: "Fechas", render: (row) => `${fmtDate(row.startDate)} – ${fmtDate(row.endDate)}` },
      {
        key: "status",
        label: "Estado",
        width: "120px",
        render: (row) => {
          const meta = PERIOD_STATUS[row.status] ?? { label: row.status, tone: "info" };
          return <span className={`bo-status ${meta.tone}`} style={{ textTransform: "none" }}>{meta.label}</span>;
        }
      },
      { key: "closedAt", label: "Cerrado", width: "120px", render: (row) => fmtDate(row.closedAt) }
    ],
    []
  );

  const costCenterColumns = useMemo<CocoaTableColumn<CostCenter>[]>(
    () => [
      { key: "code", label: "Código", width: "120px", render: (row) => <strong>{row.code}</strong> },
      { key: "name", label: "Nombre" },
      { key: "type", label: "Tipo", width: "140px" },
      {
        key: "active",
        label: "Activo",
        width: "90px",
        render: (row) => <span className={`bo-status ${row.active ? "ok" : "warn"}`} style={{ textTransform: "none" }}>{row.active ? "sí" : "no"}</span>
      }
    ],
    []
  );

  if (loading && !payload) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando configuración contable…" />
      </section>
    );
  }
  if (error && !payload) {
    return (
      <section className="bo-card">
        <ErrorState title="No se pudo cargar la configuración contable" message={error} onRetry={() => void load()} />
      </section>
    );
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}>
      <Head
        eyebrow="Finanzas y cumplimiento"
        title="Contabilidad"
        subtitle="Plan contable, ejercicio, centros de coste y periodos fiscales"
        actions={
          <span style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", flexWrap: "wrap" }}>
            <CocoaButton variant="plain" onClick={() => navigateTo("TrialBalanceScreen")}>
              Balance de sumas y saldos
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("Modelo303Screen")}>
              Modelo 303
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("FinancePositionDashboard")}>
              Posición financiera
            </CocoaButton>
          </span>
        }
      />

      <div className="bo-grid two">
        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>Plan contable</h3>
            <span className={`bo-status ${settings?.chartTemplate ? "ok" : "warn"}`} style={{ textTransform: "none" }}>
              {settings?.chartTemplate ? settings.chartTemplate : "sin plantilla"}
            </span>
          </div>
          {settings ? (
            <p style={{ margin: 0 }}>
              Inicio del ejercicio: <strong>{MONTHS[(settings.fiscalYearStartMonth ?? 1) - 1] ?? settings.fiscalYearStartMonth}</strong>
              {settings.updatedAt ? <span className="bo-muted"> · actualizado {date(settings.updatedAt)}</span> : null}
            </p>
          ) : (
            <p className="bo-muted" style={{ margin: 0 }}>
              La propiedad no tiene configuración contable guardada. Sin plan de cuentas, los asientos automáticos y el modelo 303 no pueden generarse.
            </p>
          )}
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("FinanceComplianceSetupForm")}>
              Asistente de finanzas y cumplimiento
            </CocoaButton>
          </div>
        </CocoaCard>
        <CocoaCard variant="bordered" padding="md">
          <div className="bo-card-head">
            <h3 style={{ margin: 0 }}>Cierre de ejercicio</h3>
          </div>
          <p className="bo-muted" style={{ margin: 0 }}>
            Los cierres de periodo y de ejercicio bloquean nuevos asientos en fechas cerradas. Se gestionan desde la pantalla de cierre.
          </p>
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("YearEndCloseScreen")}>
              Cierre de ejercicio
            </CocoaButton>
          </div>
        </CocoaCard>
      </div>

      <div>
        <h3 style={{ marginBottom: "var(--cocoa-space-3)" }}>Centros de coste</h3>
        {costCenters.length === 0 ? (
          <EmptyState
            title="Sin centros de coste"
            message="Esta propiedad no tiene centros de coste definidos. La imputación por departamento (habitaciones, F&B, mantenimiento…) no está disponible hasta que se creen; hoy no existe un formulario de alta en el back office."
          />
        ) : (
          <CocoaTable<CostCenter> columns={costCenterColumns} rows={costCenters} rowKey="id" emptyState="Sin centros de coste." />
        )}
      </div>

      <div>
        <div className="bo-card-head">
          <h3 style={{ margin: 0 }}>Periodos fiscales</h3>
          <span className="bo-chip">{periods.length} periodo{periods.length === 1 ? "" : "s"}</span>
        </div>
        {periodsError ? (
          <ErrorState title="No se pudieron cargar los periodos fiscales" message={periodsError} onRetry={() => void load()} />
        ) : periods.length === 0 ? (
          <EmptyState title="Sin periodos fiscales" message="Aún no se ha abierto ningún periodo contable para esta propiedad. Los periodos se abren y cierran desde Cierre de ejercicio." />
        ) : (
          <CocoaTable<FiscalPeriod> columns={periodColumns} rows={periods} rowKey="id" emptyState="Sin periodos." />
        )}
      </div>
    </section>
  );
}

export default AccountingSettings;

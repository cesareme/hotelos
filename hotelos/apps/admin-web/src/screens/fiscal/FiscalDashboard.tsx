// Centro fiscal — /cumplimiento/verifactu (base tab «VeriFactu» of VerifactuTabs).
//
// Cocoa 22 · ola 8 · lote 8-B (plantilla DashboardAlojado). Four submission
// feeds (VeriFactu · TicketBAI · IGIC · SES.HOSPEDAJES) summarised as a KPI
// strip, and three inner views: the authorities (one card each, «Ver envíos»
// opens the submissions centre), the AEAT models (303 · 390 · IRPF) and the
// reference table of the signing certificates.
//
// Cocoa 22 · ola 11: CocoaPage on the host context (hosted, the container
// paints eyebrow and H1 and the page keeps its inner views and actions). The
// frame stays `state="ready"` on purpose: the skeleton and the callout of the
// feeds that failed live in the body, so a failed authority is still reported
// while another one is loading. Navigation goes through the typed `navigateTo`.

import { useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { number, percent, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { navigateTo } from "../../lib/navigate";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaTable,
  type CocoaPageHeaderTab,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type SubmissionLite = { status: string; submittedAt?: string };

type Counts = { accepted: number; rejected: number; retrying: number; queued: number; submitting: number; other: number; total: number };

function countByStatus(rows: SubmissionLite[] | null): Counts {
  const map = { accepted: 0, rejected: 0, retrying: 0, queued: 0, submitting: 0, other: 0 };
  for (const r of rows ?? []) {
    if (r.status in map) map[r.status as keyof typeof map] += 1;
    else map.other += 1;
  }
  return { ...map, total: rows?.length ?? 0 };
}

type FiscalSection = "authorities" | "reports" | "certificates";

const SECTION_TABS: CocoaPageHeaderTab[] = [
  { value: "authorities", label: "Autoridades" },
  { value: "reports", label: "Modelos" },
  { value: "certificates", label: "Certificados" }
];

const SECTION_LABEL: Record<FiscalSection, string> = {
  authorities: "Autoridades",
  reports: "Modelos para la AEAT",
  certificates: "Estado de los certificados"
};

type AuthorityId = "verifactu" | "tbai" | "igic" | "ses";

const AUTHORITIES: ReadonlyArray<{ id: AuthorityId; label: string; body: string; description: string }> = [
  {
    id: "verifactu",
    label: "VeriFactu",
    body: "AEAT · Península y Baleares",
    description: "RD 1007/2023 · Sistema de facturación verificable: cadena de huellas SHA-256, código QR de la AEAT y numeración legal."
  },
  {
    id: "tbai",
    label: "TicketBAI",
    body: "Hacienda Foral · País Vasco",
    description: "Bizkaia · Gipuzkoa · Araba. Cadena de huellas TBAI, XML por territorio foral y código TBAI en cada factura."
  },
  {
    id: "igic",
    label: "IGIC",
    body: "ATC · Canarias",
    description: "Impuesto General Indirecto Canario. Se presenta ante la Hacienda Canaria, no ante la AEAT, con el desglose del IGIC."
  },
  {
    id: "ses",
    label: "SES.HOSPEDAJES",
    body: "MIR · Ministerio del Interior",
    description: "RD 933/2021 · Comunicaciones de Hospedaje. Datos del viajero y contrato firmados con el certificado FNMT registrado en el MIR."
  }
];

/** Tone and label of an authority card: rejected first, then retrying, then «Sin datos» / «Correcto». */
function authorityStatus(c: Counts): { tone: CocoaTone; label: string } {
  if (c.rejected > 0) return { tone: "danger", label: plural(c.rejected, "rechazado", "rechazados") };
  if (c.retrying > 0) return { tone: "warning", label: `${number(c.retrying)} reintentando` };
  if (c.total === 0) return { tone: "neutral", label: "Sin datos" };
  return { tone: "success", label: "Correcto" };
}

// Reference table of the demo environment (no PKCS#12 certificate is configured).
type CertificateRow = { authority: string; mode: string; certificate: string; endpoint: string; status: string };

const CERTIFICATE_ROWS: CertificateRow[] = [
  { authority: "VeriFactu", mode: "Pruebas", certificate: "Firmador en modo demostración (sin certificado PKCS#12 configurado)", endpoint: "Demostración (pruebas)", status: "Demostración" },
  { authority: "TicketBAI", mode: "Pruebas", certificate: "Firmador en modo demostración", endpoint: "Demostración (pruebas)", status: "Demostración" },
  { authority: "IGIC", mode: "Pruebas", certificate: "Firmador en modo demostración", endpoint: "Demostración (pruebas)", status: "Demostración" },
  {
    authority: "SES.HOSPEDAJES",
    mode: "Pruebas",
    certificate: "Firmador en modo demostración (en producción exige el certificado FNMT registrado en el MIR)",
    endpoint: "Demostración (pruebas)",
    status: "Demostración"
  }
];

const CERTIFICATE_COLUMNS: CocoaTableColumn<CertificateRow>[] = [
  { key: "authority", label: "Autoridad", fit: true, render: (r) => <strong>{r.authority}</strong> },
  { key: "mode", label: "Modo", fit: true, render: (r) => <CocoaBadge tone="neutral">{r.mode}</CocoaBadge> },
  { key: "certificate", label: "Certificado", minWidth: 240 },
  { key: "endpoint", label: "Punto de conexión", showFrom: "tablet" },
  { key: "status", label: FIELD_LABELS.status, fit: true, render: (r) => <CocoaBadge tone="warning">{r.status}</CocoaBadge> }
];

function FiscalSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[6, 6], [6, 6]]} height={220} />
    </div>
  );
}

export function FiscalDashboard() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const verifactu = useApiData<SubmissionLite[]>(`/properties/${PROPERTY_ID}/verifactu/submissions`);
  const tbai = useApiData<SubmissionLite[]>(`/properties/${PROPERTY_ID}/tbai/submissions`);
  const igic = useApiData<SubmissionLite[]>(`/properties/${PROPERTY_ID}/igic/submissions`);
  const ses = useApiData<SubmissionLite[]>(`/properties/${PROPERTY_ID}/ses/submissions`);
  const feeds = { verifactu, tbai, igic, ses };

  // Parallel refresh with aggregated feedback: one toast when any authority fails.
  async function refreshAll() {
    const results = await Promise.allSettled([
      Promise.resolve(verifactu.refresh()),
      Promise.resolve(tbai.refresh()),
      Promise.resolve(igic.refresh()),
      Promise.resolve(ses.refresh())
    ]);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      showToast(`No se pudieron refrescar ${failed} de 4 autoridades.`, { variant: "error" });
    }
  }

  // Three inner views (authorities · models · certificates): one visible at a time.
  const [activeSection, setActiveSection] = useState<FiscalSection>("authorities");

  // toArray() normalises every payload shape (plain array, `{ items }` or null):
  // /tbai/submissions answers `{ items }` while the other three answer a plain array.
  const counts: Record<AuthorityId, Counts> = {
    verifactu: countByStatus(toArray<SubmissionLite>(verifactu.data)),
    tbai: countByStatus(toArray<SubmissionLite>(tbai.data)),
    igic: countByStatus(toArray<SubmissionLite>(igic.data)),
    ses: countByStatus(toArray<SubmissionLite>(ses.data))
  };
  const all = Object.values(counts);
  const failures = all.reduce((sum, c) => sum + c.rejected, 0);
  const retrying = all.reduce((sum, c) => sum + c.retrying, 0);
  const totalAccepted = all.reduce((sum, c) => sum + c.accepted, 0);
  const totalSubmissions = all.reduce((sum, c) => sum + c.total, 0);
  const acceptanceRate = totalSubmissions > 0 ? Math.round((totalAccepted / totalSubmissions) * 100) : 0;

  const initialLoading = AUTHORITIES.some((a) => feeds[a.id].loading && feeds[a.id].data === null && feeds[a.id].error === null);
  const anyLoading = AUTHORITIES.some((a) => feeds[a.id].loading);
  const failedFeeds = AUTHORITIES.filter((a) => feeds[a.id].error !== null).map((a) => a.label);

  return (
    <CocoaPage
      eyebrow="Cumplimiento"
      title="Centro fiscal"
      state="ready"
      commands={[
        { id: "centro-fiscal-actualizar", label: "Actualizar el centro fiscal", run: () => void refreshAll() },
        { id: "centro-fiscal-modelo-303", label: "Generar el Modelo 303", run: () => navigateTo("Modelo303Screen") }
      ]}
      subtitle={
        hosted
          ? undefined
          : "Cumplimiento normativo español: VeriFactu (AEAT), TicketBAI (forales vascos), IGIC (Canarias), SES.HOSPEDAJES (MIR) y Modelos 303 / 390. Todos los envíos se firman con XAdES-EPES, se encadenan con huellas digitales y se reintentan automáticamente."
      }
      tabs={SECTION_TABS}
      panelId="fiscal-dashboard-panel"
      activeTab={activeSection}
      onTabChange={(value) => setActiveSection(value as FiscalSection)}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refreshAll()} loading={anyLoading && !initialLoading}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => navigateTo("Modelo303Screen")}>
            Generar Modelo 303
          </CocoaButton>
        </>
      }
    >
      {failedFeeds.length > 0 ? (
        <CocoaCallout
          tone="danger"
          title={STATUS_LABELS.loadError}
          role="status"
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refreshAll()}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          No se pudieron cargar los envíos de {failedFeeds.join(", ")}. Los indicadores solo cuentan las autoridades cargadas.
        </CocoaCallout>
      ) : null}

      {initialLoading ? (
        <FiscalSkeleton />
      ) : (
        <>
          <CocoaKpiStrip stagger aria-label="Indicadores de envíos a las autoridades">
            <CocoaKpi
              label="Tasa de aceptación"
              value={percent(acceptanceRate)}
              caption={`${number(totalAccepted)} de ${number(totalSubmissions)} envíos`}
              polarity="positive-good"
              status={failures > 0 ? "critical" : retrying > 0 ? "warning" : "ok"}
            />
            <CocoaKpi label="Rechazadas" value={number(failures)} caption="Revisión manual requerida" polarity="negative-good" status={failures > 0 ? "critical" : "ok"} />
            <CocoaKpi label="Cola de reintentos" value={number(retrying)} caption="Se reintentará en 5 min" polarity="negative-good" status={retrying > 0 ? "warning" : "ok"} />
            <CocoaKpi label="Total del periodo" value={number(totalSubmissions)} caption="En 4 autoridades" polarity="neutral" />
          </CocoaKpiStrip>

          <div role="tabpanel" id="fiscal-dashboard-panel" aria-label={SECTION_LABEL[activeSection]} className="cocoa-stack" data-gap="4">
            {activeSection === "authorities" ? (
              <CocoaGrid align="start" aria-label="Autoridades">
                {AUTHORITIES.map((a) => {
                  const c = counts[a.id];
                  const status = authorityStatus(c);
                  return (
                    <CocoaSpan key={a.id} cols={6} min={320}>
                      <CocoaSection
                        title={a.label}
                        meta={a.body}
                        action={
                          <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("FiscalSubmissionsCenter")}>
                            Ver envíos
                          </CocoaButton>
                        }
                      >
                        <div className="cocoa-row" data-justify="between" data-align="start">
                          <CocoaStat label="Envíos" value={number(c.total)} size="large" />
                          <CocoaBadge tone={status.tone} variant="tinted">
                            {status.label}
                          </CocoaBadge>
                        </div>
                        <p className="cocoa-note">{a.description}</p>
                        <div className="cocoa-cluster">
                          <CocoaBadge tone="success">{plural(c.accepted, "aceptado", "aceptados")}</CocoaBadge>
                          {c.rejected > 0 ? <CocoaBadge tone="danger">{plural(c.rejected, "rechazado", "rechazados")}</CocoaBadge> : null}
                          {c.retrying > 0 ? <CocoaBadge tone="warning">{number(c.retrying)} reintentando</CocoaBadge> : null}
                        </div>
                      </CocoaSection>
                    </CocoaSpan>
                  );
                })}
              </CocoaGrid>
            ) : null}

            {activeSection === "reports" ? (
              <CocoaGrid align="start" aria-label="Modelos para la AEAT">
                <CocoaSpan cols={4} min={240}>
                  <CocoaSection
                    title="Modelo 303 · Declaración trimestral del IVA"
                    meta={<CocoaBadge tone="neutral">Trimestral</CocoaBadge>}
                    footer={
                      <CocoaButton variant="filled" tone="accent" size="small" onClick={() => navigateTo("Modelo303Screen")}>
                        Abrir Modelo 303
                      </CocoaButton>
                    }
                  >
                    <p className="cocoa-note">
                      Agrega la cuota repercutida (cuenta 477) por tramo de tipo impositivo (4 %, 10 % y 21 %) y la lleva a las casillas oficiales de la AEAT.
                    </p>
                  </CocoaSection>
                </CocoaSpan>
                <CocoaSpan cols={4} min={240}>
                  <CocoaSection
                    title="Modelo 390 · Resumen anual del IVA"
                    meta={<CocoaBadge tone="neutral">Anual</CocoaBadge>}
                    footer={
                      <CocoaButton variant="filled" tone="accent" size="small" onClick={() => navigateTo("Modelo390Screen")}>
                        Abrir Modelo 390
                      </CocoaButton>
                    }
                  >
                    <p className="cocoa-note">
                      Consolidación anual de los cuatro modelos 303 por tipo impositivo, con totales y casillas del Modelo 390 (07/09, 04/06, 99, 109…).
                    </p>
                  </CocoaSection>
                </CocoaSpan>
                <CocoaSpan cols={4} min={240}>
                  <CocoaSection
                    title="Modelos IRPF"
                    meta={<CocoaBadge tone="neutral">Retenciones</CocoaBadge>}
                    footer={
                      <div className="cocoa-row" data-gap="2">
                        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("Modelo111Screen")}>
                          Modelo 111
                        </CocoaButton>
                        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("Modelo115Screen")}>
                          Modelo 115
                        </CocoaButton>
                        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("Modelo180Screen")}>
                          Modelo 180
                        </CocoaButton>
                      </div>
                    }
                  >
                    <p className="cocoa-note">
                      Retenciones de IRPF: Modelo 111 (trimestral) y Modelo 115 (arrendamientos, trimestral), con sus resúmenes anuales en el Modelo 180.
                    </p>
                  </CocoaSection>
                </CocoaSpan>
              </CocoaGrid>
            ) : null}

            {activeSection === "certificates" ? (
              <>
                <CocoaCallout tone="info" title="Tabla de referencia del entorno de demostración" role="note">
                  El estado real del conector VeriFactu y su certificado se consulta en Configuración › Facturación.
                </CocoaCallout>
                <CocoaSection title="Estado de los certificados" meta="Cadena de firma XAdES-EPES" padding="none" style={{ overflow: "clip" }}>
                  <CocoaTable
                    columns={CERTIFICATE_COLUMNS}
                    rows={CERTIFICATE_ROWS}
                    rowKey="authority"
                    caption="Estado de los certificados por autoridad"
                    aria-label="Estado de los certificados por autoridad"
                  />
                </CocoaSection>
              </>
            ) : null}
          </div>
        </>
      )}
    </CocoaPage>
  );
}

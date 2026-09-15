import { useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";

const PROPERTY_ID = getActivePropertyId();

type SubmissionLite = { status: string; submittedAt?: string };

function countByStatus(rows: SubmissionLite[] | null) {
  const map = { accepted: 0, rejected: 0, retrying: 0, queued: 0, submitting: 0, other: 0 };
  for (const r of rows ?? []) {
    if (r.status in map) map[r.status as keyof typeof map] += 1;
    else map.other += 1;
  }
  return { ...map, total: rows?.length ?? 0 };
}

type FiscalSection = "authorities" | "reports" | "certificates";

export function FiscalDashboard(props: { onNavigate?: (screen: string) => void; embedded?: boolean }) {
  const embedded = props.embedded === true;
  // Inside a tab container (Tanda 5) the page header belongs to the container: eyebrow and title are not painted.
  const { showToast } = useToast();
  const verifactu = useApiData<SubmissionLite[]>(`/properties/${PROPERTY_ID}/verifactu/submissions`);
  const tbai = useApiData<SubmissionLite[]>(`/properties/${PROPERTY_ID}/tbai/submissions`);
  const igic = useApiData<SubmissionLite[]>(`/properties/${PROPERTY_ID}/igic/submissions`);
  const ses = useApiData<SubmissionLite[]>(`/properties/${PROPERTY_ID}/ses/submissions`);

  // FIX 4: refresh paralelo con manejo de errores agregado. Antes se disparaban 4
  // refresh() sin try/catch ni feedback; si alguno fallaba el operador no se
  // enteraba. Ahora usamos Promise.allSettled + toast si alguno falla.
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

  // DEV #5 layout declutter — 3 secciones grandes (autoridades, reports, certs)
  // pasan a tabs internos. Solo una sección visible a la vez.
  const [activeSection, setActiveSection] = useState<FiscalSection>("authorities");

  // toArray() normaliza cualquier forma de respuesta (array plano, `{ items }` o
  // null) a un array. /tbai/submissions devuelve `{ items }` mientras que los
  // otros tres devuelven array plano; sin esto, `countByStatus` hacía
  // `for..of` sobre un objeto no iterable y tumbaba la pantalla con el
  // ErrorBoundary (visible sobre todo como admin, que sí recibe 200 de TBAI).
  const v = countByStatus(toArray<SubmissionLite>(verifactu.data));
  const t = countByStatus(toArray<SubmissionLite>(tbai.data));
  const i = countByStatus(toArray<SubmissionLite>(igic.data));
  const s = countByStatus(toArray<SubmissionLite>(ses.data));
  const failures = v.rejected + t.rejected + i.rejected + s.rejected;
  const retrying = v.retrying + t.retrying + i.retrying + s.retrying;
  const totalAccepted = v.accepted + t.accepted + i.accepted + s.accepted;
  const totalSubmissions = v.total + t.total + i.total + s.total;
  const acceptanceRate = totalSubmissions > 0 ? Math.round((totalAccepted / totalSubmissions) * 100) : 0;

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          {embedded ? null : <div className="bo-page-eyebrow">Cumplimiento</div>}
          {embedded ? null : <h1 className="bo-page-title">Centro fiscal</h1>}
          <p className="bo-page-subtitle">
            Cumplimiento normativo español: VeriFactu (AEAT), TicketBAI (forales vascos), IGIC (Canarias), SES.HOSPEDAJES (MIR) y Modelos 303 / 390.
            Todos los envíos se firman con XAdES-EPES, se encadenan con huellas digitales y se reintentan automáticamente.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" className="ghost" onClick={() => { void refreshAll(); }}>↻ Refrescar</button>
          <button type="button" className="primary" onClick={() => props.onNavigate?.("Modelo303Screen")}>Generar Modelo 303</button>
        </div>
      </div>

      <section className="rev-kpi-grid">
        {/* FIX 1-3: KPIs en castellano para mantener consistencia con el resto
            del centro fiscal, y ocultando detalle de implementacion (pg-boss). */}
        <article className={`rev-kpi ${failures > 0 ? "rev-kpi-error" : retrying > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tasa de aceptación</span></div>
          <div className="rev-kpi-value">{acceptanceRate}%</div>
          <div className="rev-kpi-delta">{totalAccepted} / {totalSubmissions} envíos</div>
        </article>
        <article className={`rev-kpi ${failures > 0 ? "rev-kpi-error" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Rechazadas</span></div>
          <div className="rev-kpi-value">{failures}</div>
          <div className="rev-kpi-delta">Revisión manual requerida</div>
        </article>
        <article className={`rev-kpi ${retrying > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Cola de reintentos</span></div>
          <div className="rev-kpi-value">{retrying}</div>
          <div className="rev-kpi-delta">Se reintentará en 5 min</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Total del periodo</span></div>
          <div className="rev-kpi-value">{totalSubmissions}</div>
          <div className="rev-kpi-delta">en 4 autoridades</div>
        </article>
      </section>

      {/* DEV #5 — Tabs internas para dividir 3 secciones grandes: autoridades
          (VeriFactu/TBAI/IGIC/SES), reports (Modelos 303/390/IRPF) y certs. */}
      <nav
        role="tablist"
        aria-label="Vistas del centro fiscal"
        style={{ display: "flex", flexWrap: "wrap", gap: 4, borderBottom: "1px solid var(--border)" }}
      >
        {(
          [
            { id: "authorities" as const, label: "Autoridades" },
            { id: "reports" as const, label: "Modelos" },
            { id: "certificates" as const, label: "Certificados" }
          ]
        ).map((tab) => {
          const isActive = activeSection === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveSection(tab.id)}
              className={isActive ? "primary" : "ghost"}
              style={{ padding: "6px 14px", fontSize: 13 }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {activeSection === "authorities" ? (
      <section className="bo-grid two">
        <button className="bo-card" type="button" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => props.onNavigate?.("FiscalSubmissionsCenter")}>
          <div className="bo-card-head">
            <div>
              <p className="bo-muted" style={{ fontSize: 11 }}>AEAT · Península y Baleares</p>
              <h3>VeriFactu</h3>
            </div>
            <span className={`bo-status ${v.rejected > 0 ? "error" : v.retrying > 0 ? "warn" : "ok"}`}>
              {v.rejected > 0 ? `${v.rejected} rechazados` : v.retrying > 0 ? `${v.retrying} reintentando` : v.total === 0 ? "sin datos" : "correcto"}
            </span>
          </div>
          <div className="bo-metric">{v.total}</div>
          <p>RD 1007/2023 · Sistema de facturación verificable: cadena de huellas SHA-256, código QR de la AEAT y numeración legal.</p>
          <div className="bo-pill-row" style={{ marginTop: 12 }}>
            <span className="bo-pill">{v.accepted} aceptados</span>
            {v.rejected > 0 ? <span className="bo-pill" style={{ color: "var(--danger-ink)" }}>{v.rejected} rechazados</span> : null}
            {v.retrying > 0 ? <span className="bo-pill" style={{ color: "var(--warn-ink)" }}>{v.retrying} reintentando</span> : null}
          </div>
        </button>

        <button className="bo-card" type="button" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => props.onNavigate?.("FiscalSubmissionsCenter")}>
          <div className="bo-card-head">
            <div>
              <p className="bo-muted" style={{ fontSize: 11 }}>Hacienda Foral · País Vasco</p>
              <h3>TicketBAI</h3>
            </div>
            <span className={`bo-status ${t.rejected > 0 ? "error" : t.retrying > 0 ? "warn" : "ok"}`}>
              {t.rejected > 0 ? `${t.rejected} rechazados` : t.retrying > 0 ? `${t.retrying} reintentando` : t.total === 0 ? "sin datos" : "correcto"}
            </span>
          </div>
          <div className="bo-metric">{t.total}</div>
          <p>Bizkaia · Gipuzkoa · Araba. Cadena de huellas TBAI, XML por territorio foral y código TBAI en cada factura.</p>
          <div className="bo-pill-row" style={{ marginTop: 12 }}>
            <span className="bo-pill">{t.accepted} aceptados</span>
            {t.rejected > 0 ? <span className="bo-pill" style={{ color: "var(--danger-ink)" }}>{t.rejected} rechazados</span> : null}
          </div>
        </button>

        <button className="bo-card" type="button" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => props.onNavigate?.("FiscalSubmissionsCenter")}>
          <div className="bo-card-head">
            <div>
              <p className="bo-muted" style={{ fontSize: 11 }}>ATC · Canarias</p>
              <h3>IGIC</h3>
            </div>
            <span className={`bo-status ${i.rejected > 0 ? "error" : i.retrying > 0 ? "warn" : "ok"}`}>
              {i.rejected > 0 ? `${i.rejected} rechazados` : i.retrying > 0 ? `${i.retrying} reintentando` : i.total === 0 ? "sin datos" : "correcto"}
            </span>
          </div>
          <div className="bo-metric">{i.total}</div>
          <p>Impuesto General Indirecto Canario. Se presenta ante la Hacienda Canaria, no ante la AEAT, con el desglose del IGIC.</p>
          <div className="bo-pill-row" style={{ marginTop: 12 }}>
            <span className="bo-pill">{i.accepted} aceptados</span>
          </div>
        </button>

        <button className="bo-card" type="button" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => props.onNavigate?.("FiscalSubmissionsCenter")}>
          <div className="bo-card-head">
            <div>
              <p className="bo-muted" style={{ fontSize: 11 }}>MIR · Ministerio del Interior</p>
              <h3>SES.HOSPEDAJES</h3>
            </div>
            <span className={`bo-status ${s.rejected > 0 ? "error" : s.retrying > 0 ? "warn" : "ok"}`}>
              {s.rejected > 0 ? `${s.rejected} rechazados` : s.retrying > 0 ? `${s.retrying} reintentando` : s.total === 0 ? "sin datos" : "correcto"}
            </span>
          </div>
          <div className="bo-metric">{s.total}</div>
          <p>RD 933/2021 · Comunicaciones de Hospedaje. Datos del viajero + contrato firmados con cert FNMT registrado en MIR.</p>
          <div className="bo-pill-row" style={{ marginTop: 12 }}>
            <span className="bo-pill">{s.accepted} aceptados</span>
            {s.rejected > 0 ? <span className="bo-pill" style={{ color: "var(--danger-ink)" }}>{s.rejected} rechazados</span> : null}
          </div>
        </button>
      </section>
      ) : null}

      {activeSection === "reports" ? (
      <section className="bo-section">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Reports for AEAT</p>
            <h2 style={{ fontSize: 20 }}>Spanish VAT consolidation</h2>
          </div>
        </div>
        <div className="bo-grid two">
          <article className="bo-card">
            <div className="bo-card-head">
              <h3>Modelo 303 — Declaración trimestral IVA</h3>
              <span className="bo-chip">Trimestral</span>
            </div>
            <p>Agrega cuota repercutida (cuenta 477) por bucket de tipo impositivo (4%, 10%, 21%) y mapea a las casillas oficiales AEAT.</p>
            <div className="bo-row" style={{ marginTop: 12 }}>
              <button type="button" className="primary" onClick={() => props.onNavigate?.("Modelo303Screen")}>Abrir Modelo 303</button>
            </div>
          </article>
          <article className="bo-card">
            <div className="bo-card-head">
              <h3>Modelo 390 — Resumen anual IVA</h3>
              <span className="bo-chip">Anual</span>
            </div>
            <p>Consolidación anual de los 4 modelos 303 con buckets por tasa, totales y casillas Modelo 390 (07/09, 04/06, 99, 109, etc.).</p>
            <div className="bo-row" style={{ marginTop: 12 }}>
              <button type="button" className="primary" onClick={() => props.onNavigate?.("Modelo390Screen")}>Abrir Modelo 390</button>
            </div>
          </article>
          <article className="bo-card">
            <div className="bo-card-head">
              <h3>Modelos IRPF</h3>
              <span className="bo-chip">Retenciones</span>
            </div>
            <p>Retenciones de IRPF: Modelo 111 (trimestral) y Modelo 115 (arrendamientos trimestral), con sus resúmenes anuales Modelo 180.</p>
            <div className="bo-row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
              <button type="button" onClick={() => props.onNavigate?.("Modelo111Screen")}>Modelo 111</button>
              <button type="button" onClick={() => props.onNavigate?.("Modelo115Screen")}>Modelo 115</button>
              <button type="button" onClick={() => props.onNavigate?.("Modelo180Screen")}>Modelo 180</button>
            </div>
          </article>
        </div>
      </section>
      ) : null}

      {activeSection === "certificates" ? (
      <section className="bo-section">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Cadena de firma XAdES-EPES</p>
            <h2 style={{ fontSize: 20 }}>Estado de los certificados</h2>
            <p className="bo-muted" style={{ textTransform: "none", marginTop: 4 }}>Tabla de referencia del entorno de demostración. El estado real del conector VeriFactu y su certificado se consulta en Configuración › Facturación.</p>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Autoridad</th>
              <th>Modo</th>
              <th>Certificado</th>
              <th>Punto de conexión</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>VeriFactu</strong></td>
              <td><span className="bo-chip">pruebas</span></td>
              <td>Firmador en modo demostración (sin certificado PKCS#12 configurado)</td>
              <td>Demostración (pruebas)</td>
              <td><span className="bo-status warn">Demostración</span></td>
            </tr>
            <tr>
              <td><strong>TicketBAI</strong></td>
              <td><span className="bo-chip">pruebas</span></td>
              <td>Firmador en modo demostración</td>
              <td>Demostración (pruebas)</td>
              <td><span className="bo-status warn">Demostración</span></td>
            </tr>
            <tr>
              <td><strong>IGIC</strong></td>
              <td><span className="bo-chip">pruebas</span></td>
              <td>Firmador en modo demostración</td>
              <td>Demostración (pruebas)</td>
              <td><span className="bo-status warn">Demostración</span></td>
            </tr>
            <tr>
              <td><strong>SES.HOSPEDAJES</strong></td>
              <td><span className="bo-chip">pruebas</span></td>
              <td>Firmador en modo demostración (en producción exige el certificado FNMT registrado en el MIR)</td>
              <td>Demostración (pruebas)</td>
              <td><span className="bo-status warn">Demostración</span></td>
            </tr>
          </tbody>
        </table>
      </section>
      ) : null}
    </>
  );
}

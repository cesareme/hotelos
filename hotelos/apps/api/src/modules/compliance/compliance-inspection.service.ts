// Compliance inspection folder — assembles a complete, printable dossier
// (HTML, openable + "print to PDF" in any browser) gathering everything an
// inspector asks for: applicable obligations, status, dates, who is
// responsible, the documents that justify each one, open alerts and pending
// corrective tasks. The HTML is a real artifact, not a placeholder link.
import { prisma } from "@hotelos/database";
import {
  getComplianceCenter,
  getComplianceAlerts,
  listComplianceTasks,
  listComplianceDocuments
} from "./compliance-center.service.js";

const STATUS_LABEL: Record<string, string> = {
  COMPLIANT: "Cumple", NON_COMPLIANT: "No cumple", PENDING: "Pendiente", EXPIRED: "Vencido",
  EXPIRING_SOON: "Vence pronto", NOT_APPLICABLE: "No aplica", UNDER_REVIEW: "En revisión"
};
const RISK_LABEL: Record<string, string> = { CRITICAL: "Crítico", HIGH: "Alto", MEDIUM: "Medio", LOW: "Bajo" };
const JURISDICTION_LABEL: Record<string, string> = {
  STATE: "Estatal", AUTONOMOUS_COMMUNITY: "Autonómica", MUNICIPAL: "Municipal", INTERNAL: "Interna"
};
const STATUS_COLOR: Record<string, string> = {
  COMPLIANT: "#15803d", NON_COMPLIANT: "#b91c1c", PENDING: "#b45309", EXPIRED: "#b91c1c",
  EXPIRING_SOON: "#b45309", NOT_APPLICABLE: "#64748b", UNDER_REVIEW: "#1d4ed8"
};

function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtDate(v?: string | Date | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });
}

export async function getInspectionFolderData(propertyId: string, preparedBy?: string) {
  const [property, center, alertsRes, tasks, documents] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId } }),
    getComplianceCenter(propertyId),
    getComplianceAlerts(propertyId),
    listComplianceTasks(propertyId),
    listComplianceDocuments(propertyId)
  ]);
  return {
    propertyId,
    property: property
      ? { name: property.name, legalName: property.legalName, address: property.address, province: property.province, country: property.country }
      : { name: propertyId, legalName: null, address: null, province: null, country: null },
    generatedAt: new Date().toISOString(),
    preparedBy: preparedBy ?? null,
    kpis: center.kpis,
    areas: center.areas,
    controls: center.controls,
    alerts: alertsRes.alerts,
    tasks: tasks.filter((t) => t.status !== "DONE"),
    documents
  };
}

export function buildInspectionFolderHtml(data: Awaited<ReturnType<typeof getInspectionFolderData>>): string {
  const k = data.kpis;
  const applicableControls = data.controls.filter((c) => c.applies);
  const byArea = new Map<string, typeof applicableControls>();
  for (const c of applicableControls) {
    const list = byArea.get(c.areaName) ?? [];
    list.push(c);
    byArea.set(c.areaName, list);
  }

  const kpiCard = (label: string, value: string | number, color = "#0f172a") =>
    `<div class="kpi"><div class="kpi-v" style="color:${color}">${esc(value)}</div><div class="kpi-l">${esc(label)}</div></div>`;

  const areaSections = [...byArea.entries()].map(([areaName, controls]) => {
    const rows = controls.map((c) => {
      const docs = data.documents.filter((d) => d.requirementCode === c.code);
      const docList = docs.length
        ? docs.map((d) => `${esc(d.title)}${d.expiryDate ? ` (vence ${esc(fmtDate(d.expiryDate))})` : ""}`).join("; ")
        : `<span class="muted">— sin documento —</span>`;
      return `<tr>
        <td class="mono">${esc(c.code)}</td>
        <td><strong>${esc(c.title)}</strong><div class="muted small">${esc(JURISDICTION_LABEL[c.jurisdiction] ?? c.jurisdiction)}${c.legalReference ? ` · ${esc(c.legalReference)}` : ""}</div></td>
        <td><span class="badge" style="background:${STATUS_COLOR[c.status] ?? "#334155"}">${esc(STATUS_LABEL[c.status] ?? c.status)}</span></td>
        <td>${esc(RISK_LABEL[c.riskLevel] ?? c.riskLevel)}</td>
        <td>${esc(c.responsibleName || "—")}</td>
        <td>${esc(fmtDate(c.expiryDate))}</td>
        <td class="small">${docList}</td>
      </tr>`;
    }).join("");
    return `<h3 class="area">${esc(areaName)}</h3>
      <table class="grid">
        <thead><tr><th>Código</th><th>Obligación</th><th>Estado</th><th>Riesgo</th><th>Responsable</th><th>Vence</th><th>Documentos</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }).join("");

  const alertRows = data.alerts.length
    ? data.alerts.map((a) => `<tr><td>${esc(RISK_LABEL[a.severity] ?? a.severity)}</td><td>${esc(a.kind)}</td><td><strong>${esc(a.title)}</strong></td><td>${esc(a.detail)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">Sin alertas abiertas.</td></tr>`;

  const taskRows = data.tasks.length
    ? data.tasks.map((t) => `<tr><td><strong>${esc(t.title)}</strong></td><td>${esc(t.requirementCode || "—")}</td><td>${esc(t.priority)}</td><td>${esc(fmtDate(t.dueDate))}</td><td>${esc(t.assignedToName || "—")}</td></tr>`).join("")
    : `<tr><td colspan="5" class="muted">Sin tareas correctivas pendientes.</td></tr>`;

  const addressLine = [data.property.address, data.property.province, data.property.country].filter(Boolean).join(", ");

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Carpeta de inspección — ${esc(data.property.name)}</title>
<style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0f172a}
  body{margin:0;padding:32px;background:#fff;line-height:1.45}
  h1{font-size:24px;margin:0 0 2px}
  h2{font-size:16px;margin:28px 0 10px;border-bottom:2px solid #0f172a;padding-bottom:4px}
  h3.area{font-size:13px;margin:18px 0 6px;color:#1d4ed8;text-transform:uppercase;letter-spacing:.04em}
  .sub{color:#475569;font-size:13px}
  .muted{color:#64748b}.small{font-size:11px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:nowrap}
  .kpis{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
  .kpi{border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;min-width:120px}
  .kpi-v{font-size:22px;font-weight:700}.kpi-l{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.03em}
  table{width:100%;border-collapse:collapse;margin:6px 0 14px;font-size:12px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}
  th{background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#475569}
  .badge{color:#fff;border-radius:999px;padding:2px 8px;font-size:10px;font-weight:600;white-space:nowrap}
  .foot{margin-top:30px;border-top:1px solid #e2e8f0;padding-top:10px;color:#64748b;font-size:11px}
  @media print{body{padding:0}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}
</style></head><body>
  <header>
    <h1>Carpeta de inspección de cumplimiento</h1>
    <div class="sub"><strong>${esc(data.property.name)}</strong>${data.property.legalName ? ` · ${esc(data.property.legalName)}` : ""}</div>
    ${addressLine ? `<div class="sub">${esc(addressLine)}</div>` : ""}
    <div class="sub">Generado el ${esc(fmtDate(data.generatedAt))}${data.preparedBy ? ` · Preparado por ${esc(data.preparedBy)}` : ""}</div>
  </header>

  <h2>Resumen ejecutivo</h2>
  <div class="kpis">
    ${kpiCard("% cumplimiento", `${k.compliancePct}%`, k.compliancePct >= 80 ? "#15803d" : k.compliancePct >= 50 ? "#b45309" : "#b91c1c")}
    ${kpiCard("Obligaciones aplicables", k.applicable)}
    ${kpiCard("Cumplidas", k.compliant, "#15803d")}
    ${kpiCard("Vencidas", k.expired, k.expired ? "#b91c1c" : "#15803d")}
    ${kpiCard("Vencen pronto", k.expiringSoon, k.expiringSoon ? "#b45309" : "#15803d")}
    ${kpiCard("No cumple", k.nonCompliant, k.nonCompliant ? "#b91c1c" : "#15803d")}
    ${kpiCard("Críticos abiertos", k.criticalOpen, k.criticalOpen ? "#b91c1c" : "#15803d")}
  </div>

  <h2>Matriz de obligaciones por área</h2>
  ${areaSections || '<p class="muted">No hay obligaciones aplicables registradas.</p>'}

  <h2>Alertas abiertas</h2>
  <table class="grid"><thead><tr><th>Riesgo</th><th>Tipo</th><th>Obligación</th><th>Detalle</th></tr></thead><tbody>${alertRows}</tbody></table>

  <h2>Tareas correctivas pendientes</h2>
  <table class="grid"><thead><tr><th>Tarea</th><th>Control</th><th>Prioridad</th><th>Vence</th><th>Responsable</th></tr></thead><tbody>${taskRows}</tbody></table>

  <h2>Anexo: documentos en archivo (${data.documents.length})</h2>
  <table class="grid"><thead><tr><th>Documento</th><th>Control</th><th>Emisión</th><th>Caducidad</th></tr></thead><tbody>
    ${data.documents.length ? data.documents.map((d) => `<tr><td><strong>${esc(d.title)}</strong>${d.documentType ? ` <span class="muted">(${esc(d.documentType)})</span>` : ""}</td><td class="mono">${esc(d.requirementCode || "—")}</td><td>${esc(fmtDate(d.issueDate))}</td><td>${esc(fmtDate(d.expiryDate))}</td></tr>`).join("") : '<tr><td colspan="4" class="muted">No hay documentos registrados.</td></tr>'}
  </tbody></table>

  <div class="foot">HotelOS · Centro de cumplimiento · Documento generado automáticamente a partir de los datos registrados en el sistema. Verifique siempre los originales antes de una inspección.</div>
</body></html>`;
}

export async function exportInspectionFolder(input: { propertyId: string; preparedBy?: string }) {
  const data = await getInspectionFolderData(input.propertyId, input.preparedBy);
  const html = buildInspectionFolderHtml(data);
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = data.property.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "hotel";
  return {
    filename: `carpeta-inspeccion-${safeName}-${stamp}.html`,
    generatedAt: data.generatedAt,
    summary: { applicable: data.kpis.applicable, compliancePct: data.kpis.compliancePct, expired: data.kpis.expired, criticalOpen: data.kpis.criticalOpen, documents: data.documents.length, openAlerts: data.alerts.length },
    html
  };
}

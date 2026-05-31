// Compliance AI assistant — turns the live compliance picture into a prioritized
// list of "next best actions" and a short executive narrative.
//
// HONESTY: the suggestion list is always DETERMINISTIC and grounded in real data
// (applicable controls, their status, dates and documents on file). The narrative
// is enriched by the LLM only when a provider is configured; otherwise a
// rules-based narrative is returned. Every response declares its `narrativeSource`
// ("ai" | "rules") so the UI can label it truthfully.
import { llmComplete, isLlmConfigured, llmProviderName } from "../../lib/llm.js";
import { llmExtractJsonFromImage } from "../../lib/llm.js";
import { getComplianceCenter } from "./compliance-center.service.js";

export type SuggestionKind = "MISSING_DOCUMENT" | "RENEW" | "CORRECT" | "REVIEW";
export type SuggestionPriority = "HIGH" | "MEDIUM" | "LOW";

export type ComplianceSuggestion = {
  id: string;
  kind: SuggestionKind;
  priority: SuggestionPriority;
  requirementCode: string;
  controlTitle: string;
  areaName: string;
  action: string;
  taskTitle: string;
  taskPriority: SuggestionPriority;
};

const PRIO_RANK: Record<SuggestionPriority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export async function getComplianceAssistant(propertyId: string) {
  const center = await getComplianceCenter(propertyId);
  const suggestions: ComplianceSuggestion[] = [];

  for (const raw of center.controls) {
    if (!raw.applies) continue;
    const c = { code: raw.code, title: raw.title, areaName: raw.areaName };
    const critical = raw.riskLevel === "CRITICAL";
    const high = raw.riskLevel === "HIGH";
    if (raw.status === "EXPIRED") {
      suggestions.push(mk("RENEW", critical ? "HIGH" : "MEDIUM", c, `Renueva «${c.title}»: el documento está caducado${raw.expiryDate ? ` desde ${fmt(raw.expiryDate)}` : ""}.`, `Renovar ${c.title}`));
    } else if (raw.status === "EXPIRING_SOON") {
      suggestions.push(mk("RENEW", critical ? "HIGH" : "MEDIUM", c, `Programa la renovación de «${c.title}» antes de su caducidad${raw.expiryDate ? ` (${fmt(raw.expiryDate)})` : ""}.`, `Renovar ${c.title}`));
    } else if (raw.status === "NON_COMPLIANT") {
      suggestions.push(mk("CORRECT", critical ? "HIGH" : "MEDIUM", c, raw.correctiveAction?.trim() || `Define y ejecuta la acción correctiva para «${c.title}».`, `Corregir ${c.title}`));
    }
    if (raw.requiredDocuments.length && raw.documentsCount === 0 && raw.status !== "NOT_APPLICABLE") {
      suggestions.push(mk("MISSING_DOCUMENT", critical ? "HIGH" : high ? "MEDIUM" : "LOW", c, `Registra el documento que justifica «${c.title}»: ${raw.requiredDocuments.join(", ")}.`, `Conseguir documento: ${c.title}`));
    } else if (raw.status === "PENDING") {
      suggestions.push(mk("REVIEW", critical ? "MEDIUM" : "LOW", c, `Revisa «${c.title}» y actualiza su estado cuando esté resuelto.`, `Revisar ${c.title}`));
    }
  }

  // de-duplicate by id, sort by priority then critical-first already encoded
  const seen = new Set<string>();
  const unique = suggestions.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  unique.sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority]);
  const top = unique.slice(0, 40);

  const k = center.kpis;
  let narrative = rulesNarrative(k, top);
  let narrativeSource: "ai" | "rules" = "rules";
  if (isLlmConfigured()) {
    try {
      const res = await llmComplete({
        system: "Eres un asesor de cumplimiento normativo de hoteles en España. Responde en español, en 3-4 frases, tono claro y accionable. No inventes obligaciones; usa solo los datos proporcionados.",
        prompt: buildPrompt(k, top),
        maxTokens: 320,
        temperature: 0.3
      });
      if (res.configured && res.text.trim()) { narrative = res.text.trim(); narrativeSource = "ai"; }
    } catch {
      // keep rules-based narrative on any provider error
    }
  }

  const byPriority = top.reduce<Record<string, number>>((acc, s) => { acc[s.priority] = (acc[s.priority] ?? 0) + 1; return acc; }, {});
  return {
    propertyId,
    generatedAt: new Date().toISOString(),
    provider: llmProviderName(),
    narrativeSource,
    narrative,
    count: top.length,
    byPriority,
    suggestions: top
  };
}

function mk(kind: SuggestionKind, priority: SuggestionPriority, c: { code: string; title: string; areaName: string }, action: string, taskTitle: string): ComplianceSuggestion {
  return { id: `${kind}-${c.code}`, kind, priority, requirementCode: c.code, controlTitle: c.title, areaName: c.areaName, action, taskTitle, taskPriority: priority };
}

function fmt(v: string | Date): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("es-ES");
}

function rulesNarrative(k: { compliancePct: number; applicable: number; criticalOpen: number; expired: number; expiringSoon: number; nonCompliant: number }, top: ComplianceSuggestion[]): string {
  const parts: string[] = [];
  parts.push(`El nivel de cumplimiento es del ${k.compliancePct}% sobre ${k.applicable} obligaciones aplicables.`);
  if (k.criticalOpen > 0) parts.push(`Hay ${k.criticalOpen} control(es) crítico(s) sin resolver: priorízalos.`);
  if (k.expired > 0) parts.push(`${k.expired} documento(s) están caducados y deben renovarse de inmediato.`);
  if (k.expiringSoon > 0) parts.push(`${k.expiringSoon} vencerán pronto; conviene programar su renovación.`);
  if (k.nonCompliant > 0) parts.push(`${k.nonCompliant} control(es) figuran como no conformes.`);
  if (top[0]) parts.push(`Acción recomendada ahora: ${top[0].action}`);
  if (parts.length === 1) parts.push("No hay acciones urgentes pendientes.");
  return parts.join(" ");
}

function buildPrompt(k: { compliancePct: number; applicable: number; criticalOpen: number; expired: number; expiringSoon: number; nonCompliant: number; pending: number }, top: ComplianceSuggestion[]): string {
  const lines = top.slice(0, 12).map((s) => `- [${s.priority}] ${s.kind}: ${s.action}`);
  return [
    `Datos de cumplimiento del hotel:`,
    `- Cumplimiento: ${k.compliancePct}% de ${k.applicable} obligaciones aplicables`,
    `- Críticos abiertos: ${k.criticalOpen} · Vencidos: ${k.expired} · Vencen pronto: ${k.expiringSoon} · No cumple: ${k.nonCompliant} · Pendientes: ${k.pending}`,
    `Acciones detectadas (no inventes otras):`,
    ...lines,
    ``,
    `Redacta un resumen ejecutivo breve (3-4 frases) que priorice qué hacer primero y por qué, basándote únicamente en estos datos.`
  ].join("\n");
}

// --- OCR: read issue/expiry dates off a document image ----------------------
const DATE_OCR_INSTRUCTION =
  "Eres un extractor de datos de documentos de cumplimiento de un hotel (licencias, certificados, pólizas, " +
  "actas de revisión, contratos). Lee el documento de la imagen y devuelve EXCLUSIVAMENTE un objeto JSON válido, " +
  "sin texto adicional, con estas claves cuando aparezcan: documentType (descripción corta del tipo de documento), " +
  "issuingAuthority (organismo o empresa emisora), issueDate (fecha de emisión, formato YYYY-MM-DD), " +
  "expiryDate (fecha de caducidad o próxima revisión, formato YYYY-MM-DD). Omite las claves que no puedas leer con seguridad. No inventes datos.";

export async function extractComplianceDocumentDates(imageDataUrl: string) {
  const res = await llmExtractJsonFromImage(imageDataUrl, DATE_OCR_INSTRUCTION);
  if (!res.configured) {
    return { aiGenerated: false, provider: llmProviderName(), reason: res.reason, fields: {} as Record<string, string> };
  }
  const pick = (key: string): string | undefined => {
    const v = res.data[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  return {
    aiGenerated: true,
    provider: res.provider,
    model: res.model,
    fields: {
      documentType: pick("documentType"),
      issuingAuthority: pick("issuingAuthority"),
      issueDate: pick("issueDate"),
      expiryDate: pick("expiryDate")
    }
  };
}

// Estado honesto de las integraciones (Tanda L8 · L8-01).
//
// Una función PURA por integración (entradas explícitas, sin process.env ni
// Prisma) + un colector `collectIntegrationsStatus` que reúne esas entradas
// con los lectores YA existentes (readChannelEnv, aiConfigSummary,
// emailProvidersStatus, emailStatus, isWhatsappConfigured, isSmsConfigured,
// unsignedWebhookMode, pspStatusFor, getComplianceHealth, describeDocument-
// StorageHealth) y con Prisma (perfil y runs del modo sombra, apps de ingest,
// buzones, lotes Sage 200, canales, fuentes de reseñas, últimos envíos de
// VeriFactu / SES, interruptores de cumplimiento y uso del establecimiento y
// últimas entregas de notificaciones). Sentry y Redis llegan como parámetros
// desde server.ts (no hay lector propio).
//
// Corrector L8 (REV-01): `ses` / `verifactu` / `tbai` por propiedad aplican el
// interruptor del establecimiento (properties ∪ property_compliance_settings)
// con la regla del readiness (`resolveComplianceApplicability`, backoffice):
// aplica = interruptor || uso real (envíos SES en 180 días, facturas emitidas,
// territorio foral). Apagado y sin uso ⇒ `none` aunque el proceso esté en
// producción; activo solo por uso ⇒ «Activar … para el establecimiento» en
// missingForReal. /health habla del proceso (sin BD) y no aplica el interruptor.
//
// Reglas fijas (contrato `tests/integrations-honesty-contract.test.mjs`):
//   · readyForReal ≡ mode === "real" && missingForReal vacío.
//   · mode none ⇒ readyForReal=false y lastActivityAt=null.
//   · un modo sandbox nunca dice «enviado»: las frases hablan de simulación.
//   · las frases no llevan URLs, buckets, endpoints ni nombres de variables
//     secretas (el bloque de /health es público); los nombres de variables no
//     secretas tampoco hacen falta: se habla de «credenciales», «tope de modo»…
//   · ningún contador inventado: los números vienen de filas reales.
//
// `describeIntegrationsHealth` es el subconjunto SIN base de datos para el
// bloque `integrations` de GET /health (clave superior, como `schedulers`).

import { prisma } from "@hotelos/database";
import { INTEGRATION_KEYS, INTEGRATION_LABELS_ES, INTEGRATION_SCREENS, type IntegrationHealthEntry, type IntegrationKey, type IntegrationMode, type IntegrationStatusDto, type IntegrationTransport, type IntegrationsHealthBlock, type IntegrationsStatusResponse } from "@hotelos/shared";
import { aiConfigSummary } from "../../lib/ai-config.js";
import { createDegradedCollector } from "../../lib/degraded.js";
import { unsignedWebhookMode } from "../../routes/webhooks-whatsapp.routes.js";
import { readChannelEnv, type ChannelMaxMode } from "../channel-manager/env.partial.js";
import { FORAL_TERRITORIES, getComplianceHealth } from "../compliance/compliance-health.service.js";
import { describeDocumentStorageHealth, type DocumentStorageHealth } from "../documents/documents.config.js";
import { emailStatus } from "../notifications/providers/email.provider.js";
import { isSmsConfigured } from "../notifications/providers/sms.provider.js";
import { isWhatsappConfigured } from "../notifications/providers/whatsapp.provider.js";
import { pspStatusFor } from "../payments/psp/index.js";
import { emailProvidersStatus, purposeOf } from "./email/email-reservation.service.js";

// ───────────────────────────────────────────────── entradas explícitas

export type OperaInput = {
  /** PmsShadowProfile de la propiedad (organización + propiedad) o null. */
  profile: { status: string; updatedAt: Date } | null;
  /** Último PmsShadowRun (cualquier feed / origen) o null. */
  lastRun: { status: string; source: string; createdAt: Date; errorMessage: string | null } | null;
  /** DeveloperApps activas de la organización con el ámbito pms.shadow.ingest. */
  ingestAppCount: number;
  /** EmailConnections de la propiedad conectadas con propósito pms_shadow. */
  shadowMailboxCount: number;
};

export type Sage200Input = {
  totalImports: number;
  postedImports: number;
  lastImport: { status: string; createdAt: Date; postedAt: Date | null } | null;
};

export type GestoriaExportInput = { lastExportAt?: Date | null };

export type ChannelRow = { providerCode: string; mode: string; status: string; lastSyncAt: Date | null };
export type ChannelsInput = { maxMode: ChannelMaxMode; channels: ChannelRow[] };

/** = PspStatusWire sin `message` (la frase la redacta este servicio: la del adaptador nombra variables). */
export type PspInput = { configured: boolean; provider: string | null; mode: "test" | "live" | null; webhookSecretConfigured: boolean };

/** Últimas entregas de un canal de notificaciones (reales, SIMULADO y fallidas). */
export type DeliveryActivity = {
  lastRealAt: Date | null;
  lastSimulatedAt: Date | null;
  lastFailed: { at: Date; error: string | null } | null;
};
export const NO_DELIVERIES: DeliveryActivity = Object.freeze({ lastRealAt: null, lastSimulatedAt: null, lastFailed: null });

export type WebhookMode = "signed" | "simulated" | "refused";
export type WhatsappInput = { outboundConfigured: boolean; webhookMode: WebhookMode; production: boolean; deliveries?: DeliveryActivity };
export type SmsInput = { configured: boolean; production: boolean; deliveries?: DeliveryActivity };
export type EmailOutInput = { configured: boolean; provider: string | null; mode: "real" | "simulated" | "disabled"; deliveries?: DeliveryActivity };

export type EmailProvidersInput = { gmail: { configured: boolean }; microsoft: { configured: boolean }; imap: { configured: boolean }; manual: { configured: boolean } };
export type EmailConnectionRow = { provider: string; status: string; purpose: string; lastSyncAt: Date | null; lastError: string | null; updatedAt: Date };
export type EmailInInput = { providers: EmailProvidersInput; connections: EmailConnectionRow[] };

export type ReviewSourceRow = { provider: string; status: string; mode: string; lastRunAt: Date | null; lastError: string | null; updatedAt: Date };
export type GbpInput = { sources: ReviewSourceRow[] };

/** Entrada de `getComplianceHealth().integrations` (estructural: el tipo de compliance no se exporta). */
export type ComplianceIntegrationInput = {
  integration: string;
  enabled: boolean;
  mode: "sandbox" | "preproduction" | "production";
  readyForReal: boolean;
  cert: { configured: false; reason: string } | { configured: true; certPathExists: boolean };
  notes?: string;
  software?: { ok: boolean; errors: string[] };
};
export type SubmissionActivity = {
  last: { status: string; at: Date } | null;
  lastFailed: { status: string; at: Date; error: string | null } | null;
};
export const NO_SUBMISSIONS: SubmissionActivity = Object.freeze({ last: null, lastFailed: null });

export type StorageInput = { kind: DocumentStorageHealth };
export type AiInput = { provider: string; configured: boolean; reason?: string };
export type SentryInput = { configured: boolean };
export type RedisInput = { configured: boolean; consumerCount: number };

// ───────────────────────────────────────────────── helpers

type Draft = {
  mode: IntegrationMode;
  transport: IntegrationTransport;
  configured: boolean;
  message: string;
  missingForReal: string[];
  lastActivityAt?: Date | null;
  lastError?: string | null;
};

const LAST_ERROR_MAX = 240;

function latest(...dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const date of dates) if (date instanceof Date && (!best || date.getTime() > best.getTime())) best = date;
  return best;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Aplica las reglas fijas del contrato y completa etiqueta y pantalla. */
export function finalizeIntegrationStatus(key: IntegrationKey, draft: Draft): IntegrationStatusDto {
  // Sin punto final: el panel une los pendientes con « · » (corrector L8 · REV-06); los lectores de cumplimiento los traen con punto.
  const missing = [...new Set(draft.missingForReal.map((item) => item.trim().replace(/\.$/, "")).filter((item) => item.length > 0))];
  const mode = draft.mode;
  return {
    key,
    label: INTEGRATION_LABELS_ES[key],
    mode,
    transport: draft.transport,
    configured: draft.configured,
    readyForReal: mode === "real" && missing.length === 0,
    message: draft.message,
    missingForReal: missing,
    lastActivityAt: mode === "none" ? null : (draft.lastActivityAt?.toISOString() ?? null),
    lastError: draft.lastError ? truncate(draft.lastError, LAST_ERROR_MAX) : null,
    screen: INTEGRATION_SCREENS[key]
  };
}

// ───────────────────────────────────────────────── OPERA Cloud · modo sombra

const OPERA_INGEST_MISSING = "Clave de ingest (aplicación activa con ámbito pms.shadow.ingest) o buzón de correo con propósito pms_shadow";

export function operaStatus(input: OperaInput): IntegrationStatusDto {
  const { profile, lastRun } = input;
  if (!profile || profile.status !== "active") {
    return finalizeIntegrationStatus("opera", {
      mode: "none",
      transport: "none",
      configured: profile !== null,
      message: profile
        ? `Perfil de modo sombra en estado «${profile.status}»: no se procesan informes de OPERA.`
        : "Sin perfil de modo sombra para la propiedad: no se reciben informes de OPERA.",
      missingForReal: ["Perfil de modo sombra activo para la propiedad", OPERA_INGEST_MISSING]
    });
  }
  const paths: string[] = [];
  if (input.ingestAppCount > 0) paths.push(plural(input.ingestAppCount, "aplicación con clave de ingest", "aplicaciones con clave de ingest"));
  if (input.shadowMailboxCount > 0) paths.push(plural(input.shadowMailboxCount, "buzón de correo", "buzones de correo"));
  const missing: string[] = [];
  if (paths.length === 0) missing.push(OPERA_INGEST_MISSING);
  if (!lastRun) missing.push("Primer informe recibido (por clave, buzón o CLI pms-shadow:pull)");
  const runLabel: Record<string, string> = { done: "procesado", partial: "procesado con errores", failed: "fallido", received: "recibido, pendiente", processing: "en proceso" };
  const lastError = lastRun && (lastRun.status === "failed" || lastRun.status === "partial")
    ? (lastRun.errorMessage ?? (lastRun.status === "failed" ? "Último informe fallido." : "Último informe procesado con errores."))
    : null;
  return finalizeIntegrationStatus("opera", {
    mode: "real",
    transport: "files",
    configured: true,
    message: `Perfil activo; informes reales de OPERA por ${paths.length > 0 ? paths.join(" y ") : "CLI únicamente (sin clave de ingest ni buzón)"}. ${lastRun ? `Último informe ${runLabel[lastRun.status] ?? lastRun.status} (origen ${lastRun.source}).` : "Ningún informe recibido todavía."}`,
    missingForReal: missing,
    lastActivityAt: lastRun?.createdAt ?? null,
    lastError
  });
}

// ───────────────────────────────────────────────── Sage 200 · importación

export function sage200Status(input: Sage200Input): IntegrationStatusDto {
  if (input.totalImports === 0) {
    return finalizeIntegrationStatus("sage200", {
      mode: "none",
      transport: "none",
      configured: false,
      message: "Sin lotes importados desde Sage 200 en la sociedad: la contabilidad no se ha cargado.",
      missingForReal: ["Primer lote importado (CLI sage200:import o pantalla Importar desde Sage 200)"]
    });
  }
  const missing = input.postedImports === 0 ? ["Contabilizar al menos un lote importado (hoy todos están en borrador o revertidos)"] : [];
  return finalizeIntegrationStatus("sage200", {
    mode: "real",
    transport: "files",
    configured: true,
    message: `${plural(input.totalImports, "lote importado", "lotes importados")} desde ficheros reales de Sage 200 en la sociedad (la importación contable es por sociedad, común a todos sus centros), ${input.postedImports} contabilizado${input.postedImports === 1 ? "" : "s"}. No existe conexión directa con Sage 200: la carga es por ficheros.`,
    missingForReal: missing,
    lastActivityAt: latest(input.lastImport?.createdAt, input.lastImport?.postedAt)
  });
}

// ───────────────────────────────────────────────── Exportación a gestoría

export function gestoriaExportStatus(input: GestoriaExportInput = {}): IntegrationStatusDto {
  return finalizeIntegrationStatus("gestoria_export", {
    mode: "real",
    transport: "manual",
    configured: true,
    message: "Exportación manual de datos reales: CSV universal, libros de IVA y diario compatible ContaPlus / Sage 50 (validar con la gestoría antes de la primera carga). Formatos A3 y Sage 200 no implementados.",
    missingForReal: [],
    lastActivityAt: input.lastExportAt ?? null
  });
}

// ───────────────────────────────────────────────── Canales de venta

const CHANNEL_MODE_RANK: Record<string, number> = { stub: 0, sandbox: 1, real: 2 };

function effectiveChannelMode(maxMode: ChannelMaxMode, channelMode: string): "stub" | "sandbox" | "real" {
  const rank = Math.min(CHANNEL_MODE_RANK[maxMode] ?? 1, CHANNEL_MODE_RANK[channelMode] ?? 0);
  return rank >= 2 ? "real" : rank === 1 ? "sandbox" : "stub";
}

const CHANNEL_MAX_MODE_LABEL: Record<ChannelMaxMode, string> = { stub: "simulador sin credenciales", sandbox: "simulador local", real: "real" };

export function channelsStatus(input: ChannelsInput): IntegrationStatusDto {
  const { maxMode, channels } = input;
  const ceiling = maxMode !== "real" ? [`Subir el tope de modo de canales a real (hoy: ${CHANNEL_MAX_MODE_LABEL[maxMode]})`] : [];
  const credentials = ["Al menos un canal activo en modo real con credenciales del proveedor", "Contrato o certificación con el agregador (Channex) o con cada OTA"];
  const lastActivityAt = latest(...channels.map((channel) => channel.lastSyncAt));
  if (channels.length === 0) {
    return finalizeIntegrationStatus("channels", {
      mode: "none",
      transport: "none",
      configured: false,
      message: `Sin canales dados de alta para la propiedad (tope de modo: ${CHANNEL_MAX_MODE_LABEL[maxMode]}).`,
      missingForReal: ["Dar de alta al menos un canal", ...ceiling, ...credentials]
    });
  }
  const active = channels.filter((channel) => channel.status === "active");
  if (active.length === 0) {
    return finalizeIntegrationStatus("channels", {
      mode: "none",
      transport: "none",
      configured: true,
      message: `${plural(channels.length, "canal dado de alta", "canales dados de alta")}, ninguno activo: no se sincroniza nada.`,
      missingForReal: ["Activar al menos un canal", ...ceiling, ...credentials]
    });
  }
  const effective = active.map((channel) => effectiveChannelMode(maxMode, channel.mode));
  const realCount = effective.filter((mode) => mode === "real").length;
  const simulatedCount = active.length - realCount;
  const mode: IntegrationMode = realCount > 0 ? "real" : "sandbox";
  return finalizeIntegrationStatus("channels", {
    mode,
    transport: "http",
    configured: true,
    message:
      mode === "real"
        ? `${active.length} de ${channels.length} canales activos: ${realCount} en real (HTTPS al proveedor) y ${simulatedCount} en simulador.`
        : `${active.length} de ${channels.length} canales activos, todos en simulador local (tope de modo: ${CHANNEL_MAX_MODE_LABEL[maxMode]}): nada sale a Internet.`,
    missingForReal: [...ceiling, ...(realCount === 0 ? credentials : [])],
    lastActivityAt
  });
}

// ───────────────────────────────────────────────── PSP

const PSP_LABEL: Record<string, string> = { stripe: "Stripe", redsys: "Redsys" };
const PSP_CREDENTIALS_MISSING = ["Credenciales de Stripe o Redsys (clave del comercio y secreto del webhook)", "Contrato con el PSP"];

export function pspStatus(input: PspInput): IntegrationStatusDto {
  if (!input.configured || !input.provider || !input.mode) {
    return finalizeIntegrationStatus("psp", {
      mode: "none",
      transport: "none",
      configured: false,
      message: "Ningún PSP configurado: sin cobros con tarjeta en línea ni enlaces de pago.",
      missingForReal: PSP_CREDENTIALS_MISSING
    });
  }
  const label = PSP_LABEL[input.provider] ?? input.provider;
  const webhook = input.webhookSecretConfigured ? [] : ["Secreto del webhook del PSP (sin él se rechazan las notificaciones de pago)"];
  if (input.mode === "test") {
    return finalizeIntegrationStatus("psp", {
      mode: "sandbox",
      transport: "http",
      configured: true,
      message: `${label} en modo de pruebas: ninguna tarjeta real y ningún cobro con efecto.`,
      missingForReal: [`Credenciales de producción de ${label}`, ...webhook, "Decisión: activar cobros reales"]
    });
  }
  return finalizeIntegrationStatus("psp", {
    mode: "real",
    transport: "http",
    configured: true,
    message: `${label} en modo de producción: los cobros con tarjeta salen al PSP.${input.webhookSecretConfigured ? "" : " Las notificaciones de pago se rechazan hasta configurar el secreto del webhook."}`,
    missingForReal: webhook
  });
}

// ───────────────────────────────────────────────── Notificaciones salientes

const WEBHOOK_LABEL: Record<WebhookMode, string> = {
  signed: "webhook de entrada firmado",
  simulated: "webhook de entrada sin firma (solo fuera de producción)",
  refused: "webhook de entrada rechazado hasta configurar el secreto"
};
const WHATSAPP_MISSING = ["Identificador de teléfono y token de la Cloud API de Meta", "Secreto de la aplicación de Meta para firmar el webhook de entrada", "Cuenta de WhatsApp Business (contrato con Meta)"];

export function whatsappStatus(input: WhatsappInput): IntegrationStatusDto {
  const deliveries = input.deliveries ?? NO_DELIVERIES;
  const lastError = deliveries.lastFailed ? (deliveries.lastFailed.error ?? "Último envío fallido.") : null;
  if (input.outboundConfigured) {
    return finalizeIntegrationStatus("whatsapp", {
      mode: "real",
      transport: "http",
      configured: true,
      message: `Salida por la Cloud API de Meta configurada; ${WEBHOOK_LABEL[input.webhookMode]}.`,
      missingForReal: input.webhookMode === "signed" ? [] : ["Secreto de la aplicación de Meta para firmar el webhook de entrada"],
      lastActivityAt: deliveries.lastRealAt,
      lastError
    });
  }
  if (input.production) {
    return finalizeIntegrationStatus("whatsapp", {
      mode: "none",
      transport: "none",
      configured: false,
      message: `Sin credenciales de WhatsApp: en producción los envíos se registran como fallidos (no se simulan); ${WEBHOOK_LABEL[input.webhookMode]}.`,
      missingForReal: WHATSAPP_MISSING,
      lastError
    });
  }
  return finalizeIntegrationStatus("whatsapp", {
    mode: "sandbox",
    transport: "none",
    configured: false,
    message: `Sin credenciales de WhatsApp: los envíos se registran como SIMULADO y no salen del sistema; ${WEBHOOK_LABEL[input.webhookMode]}.`,
    missingForReal: WHATSAPP_MISSING,
    lastActivityAt: deliveries.lastSimulatedAt,
    lastError
  });
}

const SMS_MISSING = ["Cuenta de Twilio (identificador, token y número remitente)"];

export function smsStatus(input: SmsInput): IntegrationStatusDto {
  const deliveries = input.deliveries ?? NO_DELIVERIES;
  const lastError = deliveries.lastFailed ? (deliveries.lastFailed.error ?? "Último envío fallido.") : null;
  if (input.configured) {
    return finalizeIntegrationStatus("sms", {
      mode: "real",
      transport: "http",
      configured: true,
      message: "Twilio configurado: los SMS salen al proveedor.",
      missingForReal: [],
      lastActivityAt: deliveries.lastRealAt,
      lastError
    });
  }
  if (input.production) {
    return finalizeIntegrationStatus("sms", {
      mode: "none",
      transport: "none",
      configured: false,
      message: "Sin credenciales de SMS: en producción los envíos se registran como fallidos (no se simulan).",
      missingForReal: SMS_MISSING,
      lastError
    });
  }
  return finalizeIntegrationStatus("sms", {
    mode: "sandbox",
    transport: "none",
    configured: false,
    message: "Sin credenciales de SMS: los envíos se registran como SIMULADO y no salen del sistema.",
    missingForReal: SMS_MISSING,
    lastActivityAt: deliveries.lastSimulatedAt,
    lastError
  });
}

const EMAIL_OUT_MISSING = ["Proveedor de correo saliente (Postmark o SendGrid), su clave y un remitente verificado"];
const EMAIL_PROVIDER_LABEL: Record<string, string> = { postmark: "Postmark", sendgrid: "SendGrid" };

export function emailOutStatus(input: EmailOutInput): IntegrationStatusDto {
  const deliveries = input.deliveries ?? NO_DELIVERIES;
  const lastError = deliveries.lastFailed ? (deliveries.lastFailed.error ?? "Último envío fallido.") : null;
  if (input.mode === "real" && input.configured) {
    const label = input.provider ? (EMAIL_PROVIDER_LABEL[input.provider] ?? input.provider) : "Proveedor";
    return finalizeIntegrationStatus("email_out", {
      mode: "real",
      transport: "http",
      configured: true,
      message: `${label} configurado: los correos salen al proveedor.`,
      missingForReal: [],
      lastActivityAt: deliveries.lastRealAt,
      lastError
    });
  }
  if (input.mode === "disabled") {
    return finalizeIntegrationStatus("email_out", {
      mode: "none",
      transport: "none",
      configured: false,
      message: "Sin proveedor de correo saliente: en producción los envíos se registran como fallidos (no se simulan).",
      missingForReal: EMAIL_OUT_MISSING,
      lastError
    });
  }
  return finalizeIntegrationStatus("email_out", {
    mode: "sandbox",
    transport: "none",
    configured: false,
    message: "Sin proveedor de correo saliente: los envíos se registran como SIMULADO y no salen del sistema.",
    missingForReal: EMAIL_OUT_MISSING,
    lastActivityAt: deliveries.lastSimulatedAt,
    lastError
  });
}

// ───────────────────────────────────────────────── Correo entrante (OAuth)

const OAUTH_PROVIDERS = new Set(["gmail", "microsoft"]);
const EMAIL_IN_LABEL: Record<string, string> = { gmail: "Google", microsoft: "Microsoft" };
const EMAIL_IN_MISSING = ["Credenciales OAuth de Google o Microsoft (cliente y secreto)"];

export function emailInStatus(input: EmailInInput): IntegrationStatusDto {
  const apps = (["gmail", "microsoft"] as const).filter((provider) => input.providers[provider]?.configured);
  const oauthConnections = input.connections.filter((connection) => OAUTH_PROVIDERS.has(connection.provider));
  const connected = oauthConnections.filter((connection) => connection.status === "connected");
  const errored = oauthConnections.filter((connection) => connection.status === "error" && connection.lastError).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const lastError = errored[0]?.lastError ?? null;
  const lastActivityAt = latest(...oauthConnections.map((connection) => connection.lastSyncAt));
  if (apps.length === 0) {
    return finalizeIntegrationStatus("email_in", {
      mode: "none",
      transport: input.connections.some((connection) => connection.provider === "manual") ? "manual" : "none",
      configured: false,
      message: "Sin credenciales OAuth de Google ni Microsoft: solo queda el buzón manual (pegar correos a mano).",
      missingForReal: [...EMAIL_IN_MISSING, "Autorizar al menos un buzón"],
      lastError
    });
  }
  const purposes = new Map<string, number>();
  for (const connection of connected) purposes.set(connection.purpose, (purposes.get(connection.purpose) ?? 0) + 1);
  const purposeText = [...purposes.entries()].map(([purpose, count]) => `${count} ${purpose}`).join(", ");
  return finalizeIntegrationStatus("email_in", {
    mode: "real",
    transport: "http",
    configured: true,
    message: `OAuth de ${apps.map((provider) => EMAIL_IN_LABEL[provider]).join(" y ")} configurado; ${connected.length === 0 ? "ningún buzón autorizado todavía" : `${plural(connected.length, "buzón autorizado", "buzones autorizados")} (${purposeText})`}${oauthConnections.length > connected.length ? `, ${oauthConnections.length - connected.length} pendiente(s) o con error` : ""}.`,
    missingForReal: connected.length === 0 ? ["Autorizar al menos un buzón (conexión en estado connected)"] : [],
    lastActivityAt,
    lastError
  });
}

// ───────────────────────────────────────────────── Google Business Profile

const GBP_API_MISSING = ["Ruta de autorización OAuth de Google en el producto (no existe todavía: decisión)", "Credenciales OAuth de Google Business (cliente y secreto)", "Identificador de ubicación de Google de cada hotel"];
const OPERATING = new Set(["connected", "degraded"]);
const FILE_PROVIDERS = new Set(["csv", "email"]);

export function gbpStatus(input: GbpInput): IntegrationStatusDto {
  const sources = input.sources;
  const google = sources.filter((source) => source.provider === "google");
  const googleApi = google.filter((source) => source.mode === "api" && OPERATING.has(source.status));
  const files = sources.filter((source) => FILE_PROVIDERS.has(source.provider) && OPERATING.has(source.status));
  const demo = sources.filter((source) => source.provider === "demo" && OPERATING.has(source.status));
  const errored = sources.filter((source) => (source.status === "error" || source.status === "degraded" || source.status === "unavailable") && source.lastError).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const lastError = errored[0]?.lastError ?? null;
  const lastActivityAt = latest(...sources.map((source) => source.lastRunAt));
  if (googleApi.length > 0) {
    return finalizeIntegrationStatus("gbp", {
      mode: "real",
      transport: "http",
      configured: true,
      message: `API de Google Business Profile autorizada (${plural(googleApi.length, "fuente", "fuentes")}); las reseñas se leen de Google.`,
      missingForReal: [],
      lastActivityAt,
      lastError
    });
  }
  if (files.length > 0) {
    return finalizeIntegrationStatus("gbp", {
      mode: "real",
      transport: "files",
      configured: true,
      message: `Reseñas cargadas por ${files.some((source) => source.provider === "csv") ? "CSV" : "correo"} (${plural(files.length, "fuente conectada", "fuentes conectadas")}); la API de Google Business Profile no está autorizada.`,
      missingForReal: GBP_API_MISSING,
      lastActivityAt,
      lastError
    });
  }
  if (demo.length > 0) {
    return finalizeIntegrationStatus("gbp", {
      mode: "sandbox",
      transport: "none",
      configured: true,
      message: "Fuente de demostración: reseñas ficticias, ninguna llamada a Google.",
      missingForReal: GBP_API_MISSING,
      lastActivityAt,
      lastError
    });
  }
  return finalizeIntegrationStatus("gbp", {
    mode: "none",
    transport: "none",
    configured: sources.length > 0,
    message: google.length > 0 ? `Fuente de Google dada de alta pero no operativa (estado «${google[0]!.status}»): no se leen reseñas.` : "Sin fuente de reseñas conectada para la propiedad.",
    missingForReal: GBP_API_MISSING,
    lastError
  });
}

// ───────────────────────────────────────────────── VeriFactu · SES · TBAI · IGIC

type ComplianceKey = "verifactu" | "ses" | "tbai";
/** Autoridad con preposición contraída («al Ministerio», «del Ministerio»): la frase se compone sin «a el». */
const COMPLIANCE_AUTHORITY_TO: Record<ComplianceKey, string> = { verifactu: "a la AEAT", ses: "al Ministerio del Interior", tbai: "a las haciendas forales" };
const COMPLIANCE_AUTHORITY_OF: Record<ComplianceKey, string> = { verifactu: "de la AEAT", ses: "del Ministerio del Interior", tbai: "de las haciendas forales" };
const COMPLIANCE_ITEM: Record<ComplianceKey, string> = { verifactu: "ningún registro de facturación se envía", ses: "ninguna comunicación de viajeros se envía", tbai: "ningún fichero TicketBAI se envía" };
const COMPLIANCE_SWITCH: Record<ComplianceKey, string> = {
  verifactu: "Decisión: cambiar el modo a preproducción y después a producción (certificado y alta en el servicio de la AEAT)",
  ses: "Decisión: cambiar el modo a producción (certificado y alta en SES.Hospedajes)",
  tbai: "Decisión: cambiar el modo a producción (certificado y alta en la hacienda foral)"
};

/**
 * Interruptor y uso del establecimiento (solo por propiedad; `/health` no lo tiene):
 * aplica = interruptor || uso > 0, la regla de `resolveComplianceApplicability`
 * del readiness. `null` = sin dato de la propiedad (consulta fallida): no se gatea.
 */
export type PropertyComplianceGate = { flagEnabled: boolean; usageCount: number };

const COMPLIANCE_ACTIVATE: Record<ComplianceKey, string> = {
  ses: "Activar SES.Hospedajes para el establecimiento (ajustes de cumplimiento de la propiedad)",
  verifactu: "Activar VeriFactu para el establecimiento (ajustes de cumplimiento de la propiedad)",
  tbai: "Declarar el territorio foral en la ficha del centro"
};
const COMPLIANCE_DISABLED_MESSAGE: Record<ComplianceKey, string> = {
  ses: "Desactivado para este establecimiento y sin envíos en los últimos 180 días: ninguna comunicación de viajeros se envía al Ministerio del Interior.",
  verifactu: "Desactivado para este establecimiento y sin facturas emitidas: ningún registro de facturación se envía a la AEAT.",
  tbai: "No aplica: el establecimiento no declara territorio foral (Bizkaia, Gipuzkoa, Araba o Navarra)."
};
const COMPLIANCE_USAGE_LABEL: Record<ComplianceKey, [string, string]> = {
  ses: ["envío en los últimos 180 días", "envíos en los últimos 180 días"],
  verifactu: ["factura emitida", "facturas emitidas"],
  tbai: ["fichero", "ficheros"]
};

function certMissing(cert: ComplianceIntegrationInput["cert"]): string[] {
  if (!cert.configured) return [cert.reason];
  return cert.certPathExists ? [] : ["El fichero del certificado no existe en la ruta configurada"];
}

function submissionError(activity: SubmissionActivity): string | null {
  if (!activity.lastFailed) return null;
  return activity.lastFailed.error ?? `Último envío ${activity.lastFailed.status}.`;
}

export function complianceStatus(key: ComplianceKey, input: ComplianceIntegrationInput | null, activity: SubmissionActivity = NO_SUBMISSIONS, gate: PropertyComplianceGate | null = null): IntegrationStatusDto {
  if (!input) {
    return finalizeIntegrationStatus(key, { mode: "none", transport: "none", configured: false, message: "Estado de cumplimiento no disponible (la consulta falló).", missingForReal: [] });
  }
  const missingBase = [...certMissing(input.cert), ...(input.software && !input.software.ok ? input.software.errors : [])];
  const envDecision = input.mode === "sandbox" ? [COMPLIANCE_SWITCH[key]] : input.mode === "preproduction" ? ["Decisión: pasar a producción"] : [];
  const lastError = submissionError(activity);
  if (gate && !gate.flagEnabled && gate.usageCount <= 0) {
    // Interruptor del establecimiento apagado y sin uso: para esta propiedad nada
    // cruza, sea cual sea el modo del proceso (el readiness dice lo mismo).
    return finalizeIntegrationStatus(key, {
      mode: "none",
      transport: "none",
      configured: input.cert.configured,
      message: COMPLIANCE_DISABLED_MESSAGE[key],
      missingForReal: [COMPLIANCE_ACTIVATE[key], ...missingBase, ...envDecision],
      lastError
    });
  }
  const byUsageOnly = gate !== null && !gate.flagEnabled && gate.usageCount > 0;
  const usageNote = byUsageOnly ? ` Activo solo por uso (${plural(gate.usageCount, ...COMPLIANCE_USAGE_LABEL[key])}): el interruptor del establecimiento está apagado.` : "";
  const activate = byUsageOnly ? [COMPLIANCE_ACTIVATE[key]] : [];
  if (!input.enabled) {
    return finalizeIntegrationStatus(key, {
      mode: "none",
      transport: "none",
      configured: false,
      message: key === "tbai" ? "No aplica: ninguna propiedad declara territorio foral (Bizkaia, Gipuzkoa, Araba o Navarra)." : "Integración desactivada.",
      missingForReal: []
    });
  }
  if (input.mode === "sandbox") {
    return finalizeIntegrationStatus(key, {
      mode: "sandbox",
      transport: "none",
      configured: input.cert.configured,
      message: `Modo de pruebas local: ${COMPLIANCE_ITEM[key]} ${COMPLIANCE_AUTHORITY_TO[key]}; las respuestas son simuladas.${usageNote}`,
      missingForReal: [...activate, ...missingBase, ...envDecision],
      lastActivityAt: activity.last?.at ?? null,
      lastError
    });
  }
  if (input.mode === "preproduction") {
    return finalizeIntegrationStatus(key, {
      mode: "real",
      transport: "http",
      configured: input.cert.configured,
      message: `Preproducción: los envíos llegan al entorno de pruebas oficial ${COMPLIANCE_AUTHORITY_OF[key]}, sin efectos fiscales ni legales.${usageNote}`,
      missingForReal: [...activate, ...missingBase, ...envDecision],
      lastActivityAt: activity.last?.at ?? null,
      lastError
    });
  }
  return finalizeIntegrationStatus(key, {
    mode: "real",
    transport: "http",
    configured: input.cert.configured,
    message: `Producción: los envíos llegan ${COMPLIANCE_AUTHORITY_TO[key]}.${missingBase.length > 0 ? " Hay requisitos pendientes: los envíos reales fallarán hasta resolverlos." : ""}${usageNote}`,
    missingForReal: [...activate, ...missingBase],
    lastActivityAt: activity.last?.at ?? null,
    lastError
  });
}

export function igicStatus(): IntegrationStatusDto {
  return finalizeIntegrationStatus("igic", {
    mode: "none",
    transport: "none",
    configured: false,
    message: "No es una integración propia: Canarias declara por VeriFactu con Impuesto=03; el estado real es el de VeriFactu.",
    missingForReal: []
  });
}

// ───────────────────────────────────────────────── Almacén · IA · Sentry · Redis

const STORAGE_MISSING = ["Credenciales y bucket de S3 para el almacén externo", "Decisión: almacén externo en lugar del local"];

export function storageStatus(input: StorageInput): IntegrationStatusDto {
  switch (input.kind) {
    case "s3":
      return finalizeIntegrationStatus("storage", {
        mode: "real",
        transport: "http",
        configured: true,
        message: "Almacén S3 configurado, no comprobado: el adaptador solo firma las peticiones y no verifica el acceso al bucket.",
        missingForReal: ["Comprobación de acceso al bucket (no existe: el adaptador no hace ninguna llamada de prueba)"]
      });
    case "disk":
    case "inline":
      return finalizeIntegrationStatus("storage", {
        mode: "sandbox",
        transport: input.kind === "disk" ? "files" : "none",
        configured: true,
        message: input.kind === "disk" ? "Almacén local en disco del servidor: funciona, pero nada se guarda en S3." : "Almacén local en la base de datos (inline): funciona, pero nada se guarda en S3.",
        missingForReal: STORAGE_MISSING
      });
    default:
      return finalizeIntegrationStatus("storage", {
        mode: "none",
        transport: "none",
        configured: false,
        message: "Almacén de documentos no configurado: no se pueden guardar documentos.",
        missingForReal: ["Configurar el almacén de documentos (local o S3)", ...STORAGE_MISSING]
      });
  }
}

const AI_MISSING = ["Clave del proveedor de IA (Anthropic)", "Cuenta y contrato con el proveedor de IA"];
const AI_REASON_LABEL: Record<string, string> = { not_configured: "falta la clave", provider_unsupported: "proveedor no soportado", model_forbidden: "modelo no permitido" };

export function aiStatus(input: AiInput): IntegrationStatusDto {
  if (!input.configured || input.provider === "none") {
    return finalizeIntegrationStatus("ai", {
      mode: "none",
      transport: "none",
      configured: input.provider !== "none",
      message:
        input.provider === "none"
          ? "Sin proveedor de IA: las funciones de IA responden «no configurado» y no inventan resultados."
          : `Proveedor ${input.provider} declarado pero no operativo (${AI_REASON_LABEL[input.reason ?? ""] ?? input.reason ?? "motivo desconocido"}).`,
      missingForReal: AI_MISSING
    });
  }
  return finalizeIntegrationStatus("ai", {
    mode: "real",
    transport: "http",
    configured: true,
    message: `Proveedor ${input.provider} configurado: las peticiones de IA salen al proveedor (presupuesto y límite por propiedad).`,
    missingForReal: []
  });
}

export function sentryStatus(input: SentryInput): IntegrationStatusDto {
  return finalizeIntegrationStatus("sentry", {
    mode: input.configured ? "real" : "none",
    transport: input.configured ? "http" : "none",
    configured: input.configured,
    message: input.configured ? "Sentry activo: los errores del API se envían al proyecto configurado." : "Sentry desactivado: los errores solo quedan en el log del proceso.",
    missingForReal: input.configured ? [] : ["DSN del proyecto de Sentry (cuenta y contrato)"]
  });
}

export function redisStatus(input: RedisInput): IntegrationStatusDto {
  if (input.configured && input.consumerCount > 0) {
    return finalizeIntegrationStatus("redis", {
      mode: "real",
      transport: "http",
      configured: true,
      message: `Redis en uso por ${plural(input.consumerCount, "componente", "componentes")} del API.`,
      missingForReal: []
    });
  }
  return finalizeIntegrationStatus("redis", {
    mode: "none",
    transport: "none",
    configured: input.configured,
    message: input.configured
      ? "Dirección de Redis configurada, pero ningún componente del API la usa: hoy no aporta nada (el dato de /health «configured» solo significa eso)."
      : "Redis no configurado (opcional): ningún componente del API lo necesita hoy.",
    missingForReal: ["Decisión: un consumidor real (colas, caché o límites) que use Redis", ...(input.configured ? [] : ["Dirección de Redis"])]
  });
}

// ───────────────────────────────────────────────── /health (sin BD)

export type IntegrationsHealthInputs = {
  channelMaxMode: ChannelMaxMode;
  whatsapp: { configured: boolean; webhookMode: WebhookMode; production: boolean };
  sms: { configured: boolean; production: boolean };
  emailOut: { configured: boolean; provider: string | null; mode: "real" | "simulated" | "disabled" };
  emailIn: EmailProvidersInput;
  compliance: ComplianceIntegrationInput[];
  storage: DocumentStorageHealth;
  ai: AiInput;
  sentryConfigured: boolean;
  redisConfigured: boolean;
  redisConsumerCount?: number;
};

/** Claves del bloque /health (sin BD): las integraciones por propiedad no aparecen. */
export const INTEGRATION_HEALTH_KEYS: readonly IntegrationKey[] = Object.freeze(
  INTEGRATION_KEYS.filter((key) => key !== "opera" && key !== "sage200" && key !== "psp" && key !== "gbp")
);

function healthEntry(dto: IntegrationStatusDto): IntegrationHealthEntry {
  return { mode: dto.mode, message: dto.message };
}

function complianceOf(list: ComplianceIntegrationInput[], integration: string): ComplianceIntegrationInput | null {
  return list.find((entry) => entry.integration === integration) ?? null;
}

/** /health habla del proceso: TicketBAI aplica por territorio foral del establecimiento (GET /integrations/status). */
const TBAI_PROCESS_NOTE = "Aplica solo a los establecimientos con territorio foral; el modo efectivo se lee por propiedad.";

/**
 * Bloque `integrations` de GET /health: modo + frase por integración, sin BD,
 * sin URLs, buckets, endpoints ni nombres de variables secretas. Para canales
 * y correo entrante habla del tope / de las credenciales de la aplicación:
 * el modo efectivo por propiedad lo da GET /integrations/status.
 */
export function describeIntegrationsHealth(inputs: IntegrationsHealthInputs): IntegrationsHealthBlock {
  const tbaiInput = complianceOf(inputs.compliance, "tbai");
  const tbaiEntry = healthEntry(complianceStatus("tbai", tbaiInput));
  const channelsCeiling: IntegrationHealthEntry = {
    mode: inputs.channelMaxMode === "real" ? "real" : "sandbox",
    message:
      inputs.channelMaxMode === "real"
        ? "Tope de modo de canales en real: cada canal puede salir al proveedor si tiene credenciales; el modo efectivo se lee por propiedad."
        : `Tope de modo de canales en ${CHANNEL_MAX_MODE_LABEL[inputs.channelMaxMode]}: ningún canal sale a Internet.`
  };
  const emailInApps = (["gmail", "microsoft"] as const).filter((provider) => inputs.emailIn[provider]?.configured);
  const emailIn: IntegrationHealthEntry = {
    mode: emailInApps.length > 0 ? "real" : "none",
    message:
      emailInApps.length > 0
        ? `OAuth de ${emailInApps.map((provider) => EMAIL_IN_LABEL[provider]).join(" y ")} configurado; los buzones se autorizan por propiedad.`
        : "Sin credenciales OAuth de Google ni Microsoft: solo el buzón manual."
  };
  return {
    gestoria_export: healthEntry(gestoriaExportStatus()),
    channels: channelsCeiling,
    whatsapp: healthEntry(whatsappStatus({ outboundConfigured: inputs.whatsapp.configured, webhookMode: inputs.whatsapp.webhookMode, production: inputs.whatsapp.production })),
    email_out: healthEntry(emailOutStatus(inputs.emailOut)),
    sms: healthEntry(smsStatus(inputs.sms)),
    email_in: emailIn,
    ses: healthEntry(complianceStatus("ses", complianceOf(inputs.compliance, "ses_hospedajes"))),
    verifactu: healthEntry(complianceStatus("verifactu", complianceOf(inputs.compliance, "verifactu"))),
    tbai: tbaiInput?.enabled ? { mode: tbaiEntry.mode, message: `${tbaiEntry.message} ${TBAI_PROCESS_NOTE}` } : tbaiEntry,
    igic: healthEntry(igicStatus()),
    storage: healthEntry(storageStatus({ kind: inputs.storage })),
    ai: healthEntry(aiStatus(inputs.ai)),
    sentry: healthEntry(sentryStatus({ configured: inputs.sentryConfigured })),
    redis: healthEntry(redisStatus({ configured: inputs.redisConfigured, consumerCount: inputs.redisConsumerCount ?? 0 }))
  };
}

// ───────────────────────────────────────────────── colector (Prisma + lectores)

export type IntegrationsStatusDb = {
  /** Interruptores de cumplimiento y territorio foral de la propiedad (REV-01). */
  property: Pick<(typeof prisma)["property"], "findUnique">;
  propertyComplianceSetting: Pick<(typeof prisma)["propertyComplianceSetting"], "findUnique">;
  /** Facturas emitidas = uso real de VeriFactu (misma regla que el readiness). */
  invoice: Pick<(typeof prisma)["invoice"], "count">;
  pmsShadowProfile: Pick<(typeof prisma)["pmsShadowProfile"], "findFirst">;
  pmsShadowRun: Pick<(typeof prisma)["pmsShadowRun"], "findFirst">;
  developerApp: Pick<(typeof prisma)["developerApp"], "count">;
  emailConnection: Pick<(typeof prisma)["emailConnection"], "findMany">;
  ledgerImport: Pick<(typeof prisma)["ledgerImport"], "count" | "findFirst">;
  channel: Pick<(typeof prisma)["channel"], "findMany">;
  reviewSource: Pick<(typeof prisma)["reviewSource"], "findMany">;
  verifactuSubmission: Pick<(typeof prisma)["verifactuSubmission"], "findFirst">;
  sesHospedajesSubmission: Pick<(typeof prisma)["sesHospedajesSubmission"], "findFirst" | "count">;
  notificationDelivery: Pick<(typeof prisma)["notificationDelivery"], "findFirst">;
};

export type IntegrationsStatusDeps = {
  readChannelEnv: () => { maxMode: ChannelMaxMode };
  aiConfigSummary: () => AiInput;
  emailProvidersStatus: () => EmailProvidersInput;
  emailStatus: (env: NodeJS.ProcessEnv) => { configured: boolean; provider: string | null; mode: "real" | "simulated" | "disabled" };
  isWhatsappConfigured: () => boolean;
  isSmsConfigured: () => boolean;
  unsignedWebhookMode: (env: NodeJS.ProcessEnv) => WebhookMode;
  pspStatusFor: (propertyId: string) => Promise<PspInput>;
  getComplianceHealth: (organizationId?: string) => Promise<{ integrations: ComplianceIntegrationInput[] }>;
  describeDocumentStorageHealth: () => DocumentStorageHealth;
};

const defaultDeps: IntegrationsStatusDeps = {
  readChannelEnv,
  aiConfigSummary: () => aiConfigSummary(),
  emailProvidersStatus,
  emailStatus,
  isWhatsappConfigured,
  isSmsConfigured,
  unsignedWebhookMode,
  pspStatusFor,
  getComplianceHealth,
  describeDocumentStorageHealth
};

export type CollectIntegrationsStatusInput = {
  organizationId: string;
  propertyId: string;
  sentryConfigured: boolean;
  redisConfigured: boolean;
  /** Componentes del API que usan Redis (hoy ninguno: server.ts pasa 0 u omite). */
  redisConsumerCount?: number;
  /** Entorno para los lectores que lo reciben (emailStatus, unsignedWebhookMode, NODE_ENV). Defecto: el del proceso. */
  env?: NodeJS.ProcessEnv;
  now?: Date;
  db?: IntegrationsStatusDb;
  deps?: Partial<IntegrationsStatusDeps>;
};

const SIMULATED_PREFIX = "SIMULADO";

async function deliveryActivity(db: IntegrationsStatusDb, safe: <T>(label: string, promise: Promise<T>, fallback: T) => Promise<T>, organizationId: string, propertyId: string, channel: string): Promise<DeliveryActivity> {
  const scope = { organizationId, channel, OR: [{ propertyId }, { propertyId: null }] };
  const nullRow: { createdAt: Date; sentAt: Date | null; errorMessage: string | null } | null = null;
  const [real, simulated, failed] = await Promise.all([
    safe(
      `deliveries:${channel}:real`,
      db.notificationDelivery.findFirst({
        where: { ...scope, status: "sent", AND: [{ OR: [{ errorMessage: null }, { NOT: { errorMessage: { startsWith: SIMULATED_PREFIX } } }] }] },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, sentAt: true, errorMessage: true }
      }),
      nullRow
    ),
    safe(
      `deliveries:${channel}:simulated`,
      db.notificationDelivery.findFirst({ where: { ...scope, errorMessage: { startsWith: SIMULATED_PREFIX } }, orderBy: { createdAt: "desc" }, select: { createdAt: true, sentAt: true, errorMessage: true } }),
      nullRow
    ),
    safe(
      `deliveries:${channel}:failed`,
      db.notificationDelivery.findFirst({ where: { ...scope, status: "failed" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, sentAt: true, errorMessage: true } }),
      nullRow
    )
  ]);
  return {
    lastRealAt: real ? (real.sentAt ?? real.createdAt) : null,
    lastSimulatedAt: simulated ? (simulated.sentAt ?? simulated.createdAt) : null,
    lastFailed: failed ? { at: failed.createdAt, error: failed.errorMessage } : null
  };
}

async function submissionActivity(
  safe: <T>(label: string, promise: Promise<T>, fallback: T) => Promise<T>,
  label: string,
  findFirst: (where: Record<string, unknown>) => Promise<{ status: string; updatedAt: Date; errorMessage: string | null } | null>,
  propertyId: string
): Promise<SubmissionActivity> {
  const nullRow: { status: string; updatedAt: Date; errorMessage: string | null } | null = null;
  const [last, lastFailed] = await Promise.all([
    safe(`${label}:last`, findFirst({ propertyId }), nullRow),
    safe(`${label}:failed`, findFirst({ propertyId, status: { in: ["failed", "rejected"] } }), nullRow)
  ]);
  return {
    last: last ? { status: last.status, at: last.updatedAt } : null,
    lastFailed: lastFailed ? { status: lastFailed.status, at: lastFailed.updatedAt, error: lastFailed.errorMessage } : null
  };
}

/** Ventana de uso de SES.Hospedajes (la del readiness: `SES_USAGE_WINDOW_DAYS` en backoffice.service.ts). */
export const SES_USAGE_WINDOW_DAYS = 180;
/** Facturas que existen en la cadena fiscal (emitidas, anuladas, rectificadas); los borradores no cuentan. */
export const ISSUED_INVOICE_STATUSES = ["issued", "cancelled", "rectified"] as const;

export type PropertyComplianceFlags = { sesHospedajesEnabled: boolean; verifactuEnabled: boolean; fiscalTerritory: string | null };
export type PropertyComplianceSettingsFlags = { sesHospedajesEnabled: boolean; verifactuEnabled: boolean };

/**
 * Pura: interruptores (properties ∪ property_compliance_settings) y uso por
 * clave de cumplimiento. Sin fila de propiedad no se gatea (null); con el
 * interruptor apagado y el uso sin dato (consulta fallida) tampoco: nunca se
 * declara «desactivado» por una lectura que falló.
 */
export function complianceGates(input: { property: PropertyComplianceFlags | null; settings: PropertyComplianceSettingsFlags | null; sesUsage: number | null; issuedInvoices: number | null }): Record<ComplianceKey, PropertyComplianceGate | null> {
  const { property } = input;
  if (!property) return { ses: null, verifactu: null, tbai: null };
  const gate = (flagEnabled: boolean, usage: number | null): PropertyComplianceGate | null => {
    if (flagEnabled) return { flagEnabled: true, usageCount: usage ?? 0 };
    return usage === null ? null : { flagEnabled: false, usageCount: usage };
  };
  return {
    ses: gate(Boolean(property.sesHospedajesEnabled || input.settings?.sesHospedajesEnabled), input.sesUsage),
    verifactu: gate(Boolean(property.verifactuEnabled || input.settings?.verifactuEnabled), input.issuedInvoices),
    tbai: { flagEnabled: FORAL_TERRITORIES.has(property.fiscalTerritory ?? ""), usageCount: 0 }
  };
}

/**
 * Estado de las 18 integraciones para una propiedad. Cada consulta que falla
 * se degrada a «sin datos» (y se lista en `degraded`), nunca a un éxito.
 */
export async function collectIntegrationsStatus(input: CollectIntegrationsStatusInput): Promise<IntegrationsStatusResponse> {
  const { organizationId, propertyId } = input;
  const db: IntegrationsStatusDb = input.db ?? prisma;
  const deps: IntegrationsStatusDeps = { ...defaultDeps, ...input.deps };
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const production = env.NODE_ENV === "production";
  const { safe, degraded } = createDegradedCollector("integrations.status", { organizationId, propertyId });

  const nullProfile: { status: string; updatedAt: Date } | null = null;
  const nullRun: { status: string; source: string; createdAt: Date; errorMessage: string | null } | null = null;
  const nullImport: { status: string; createdAt: Date; postedAt: Date | null } | null = null;
  const submissionSelect = { status: true, updatedAt: true, errorMessage: true } as const;
  const nullFlags: PropertyComplianceFlags | null = null;
  const nullSettings: PropertyComplianceSettingsFlags | null = null;
  const nullCount: number | null = null;
  const sesUsageSince = new Date(now.getTime() - SES_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [profile, lastRun, ingestAppCount, connections, totalImports, postedImports, lastImport, channels, sources, verifactuActivity, sesActivity, psp, compliance, whatsappDeliveries, emailDeliveries, smsDeliveries, propertyFlags, settingsFlags, sesUsage, issuedInvoices] = await Promise.all([
    safe("pmsShadowProfile", db.pmsShadowProfile.findFirst({ where: { organizationId, propertyId }, select: { status: true, updatedAt: true } }), nullProfile),
    safe("pmsShadowRun", db.pmsShadowRun.findFirst({ where: { organizationId, propertyId }, orderBy: { createdAt: "desc" }, select: { status: true, source: true, createdAt: true, errorMessage: true } }), nullRun),
    safe("developerApps", db.developerApp.count({ where: { organizationId, status: "active", scopes: { has: "pms.shadow.ingest" } } }), 0),
    safe(
      "emailConnections",
      db.emailConnection.findMany({ where: { propertyId }, select: { provider: true, status: true, configJson: true, lastSyncAt: true, lastError: true, updatedAt: true } }),
      [] as Array<{ provider: string; status: string; configJson: unknown; lastSyncAt: Date | null; lastError: string | null; updatedAt: Date }>
    ),
    safe("ledgerImports", db.ledgerImport.count({ where: { organizationId } }), 0),
    safe("ledgerImportsPosted", db.ledgerImport.count({ where: { organizationId, status: "posted" } }), 0),
    safe("ledgerImportLast", db.ledgerImport.findFirst({ where: { organizationId }, orderBy: { createdAt: "desc" }, select: { status: true, createdAt: true, postedAt: true } }), nullImport),
    safe("channels", db.channel.findMany({ where: { propertyId }, select: { providerCode: true, mode: true, status: true, lastSyncAt: true } }), [] as ChannelRow[]),
    safe("reviewSources", db.reviewSource.findMany({ where: { propertyId }, select: { provider: true, status: true, mode: true, lastRunAt: true, lastError: true, updatedAt: true } }), [] as ReviewSourceRow[]),
    submissionActivity(safe, "verifactu", (where) => db.verifactuSubmission.findFirst({ where, orderBy: { updatedAt: "desc" }, select: submissionSelect }), propertyId),
    submissionActivity(safe, "ses", (where) => db.sesHospedajesSubmission.findFirst({ where, orderBy: { updatedAt: "desc" }, select: submissionSelect }), propertyId),
    safe("psp", deps.pspStatusFor(propertyId), { configured: false, provider: null, mode: null, webhookSecretConfigured: false } as PspInput),
    safe("compliance", deps.getComplianceHealth(organizationId).then((report) => report.integrations), null as ComplianceIntegrationInput[] | null),
    deliveryActivity(db, safe, organizationId, propertyId, "whatsapp"),
    deliveryActivity(db, safe, organizationId, propertyId, "email"),
    deliveryActivity(db, safe, organizationId, propertyId, "sms"),
    safe("property", db.property.findUnique({ where: { id: propertyId }, select: { sesHospedajesEnabled: true, verifactuEnabled: true, fiscalTerritory: true } }), nullFlags),
    safe("propertyComplianceSettings", db.propertyComplianceSetting.findUnique({ where: { propertyId }, select: { sesHospedajesEnabled: true, verifactuEnabled: true } }), nullSettings),
    safe("sesUsage", db.sesHospedajesSubmission.count({ where: { propertyId, createdAt: { gte: sesUsageSince } } }), nullCount),
    safe("issuedInvoices", db.invoice.count({ where: { propertyId, status: { in: [...ISSUED_INVOICE_STATUSES] } } }), nullCount)
  ]);
  const gates = complianceGates({ property: propertyFlags, settings: settingsFlags, sesUsage, issuedInvoices });

  const connectionRows: EmailConnectionRow[] = connections.map((row) => ({ provider: row.provider, status: row.status, purpose: purposeOf(row), lastSyncAt: row.lastSyncAt, lastError: row.lastError, updatedAt: row.updatedAt }));
  const shadowMailboxCount = connectionRows.filter((row) => row.purpose === "pms_shadow" && row.status === "connected").length;
  const outbound = deps.emailStatus(env);
  const complianceList = compliance ?? [];
  const complianceOrNull = (integration: string): ComplianceIntegrationInput | null => (compliance ? complianceOf(complianceList, integration) : null);

  const integrations: IntegrationStatusDto[] = [
    operaStatus({ profile, lastRun, ingestAppCount, shadowMailboxCount }),
    sage200Status({ totalImports, postedImports, lastImport }),
    gestoriaExportStatus(),
    channelsStatus({ maxMode: deps.readChannelEnv().maxMode, channels }),
    pspStatus(psp),
    whatsappStatus({ outboundConfigured: deps.isWhatsappConfigured(), webhookMode: deps.unsignedWebhookMode(env), production, deliveries: whatsappDeliveries }),
    emailOutStatus({ configured: outbound.configured, provider: outbound.provider, mode: outbound.mode, deliveries: emailDeliveries }),
    smsStatus({ configured: deps.isSmsConfigured(), production, deliveries: smsDeliveries }),
    emailInStatus({ providers: deps.emailProvidersStatus(), connections: connectionRows }),
    gbpStatus({ sources }),
    complianceStatus("ses", complianceOrNull("ses_hospedajes"), sesActivity, gates.ses),
    complianceStatus("verifactu", complianceOrNull("verifactu"), verifactuActivity, gates.verifactu),
    complianceStatus("tbai", complianceOrNull("tbai"), NO_SUBMISSIONS, gates.tbai),
    igicStatus(),
    storageStatus({ kind: deps.describeDocumentStorageHealth() }),
    aiStatus(deps.aiConfigSummary()),
    sentryStatus({ configured: input.sentryConfigured }),
    redisStatus({ configured: input.redisConfigured, consumerCount: input.redisConsumerCount ?? 0 })
  ];

  return { generatedAt: now.toISOString(), propertyId, integrations, degraded: [...degraded] };
}

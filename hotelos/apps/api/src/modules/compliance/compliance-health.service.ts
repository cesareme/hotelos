// PILOT-D4 · Diagnóstico de las integraciones de compliance ES.
//
// Devuelve el modo actual (sandbox/preproduction/production) y si los
// certificados están configurados para cada integración. Esto le permite al
// cliente piloto comprobar de un vistazo en qué punto está su entorno antes
// de declarar "go-live".
//
// Tanda 3: además del entorno (env/cert) el informe incluye lo que depende de
// la ORGANIZACIÓN — establecimientos SES incompletos, NIF de emisor por
// propiedad y regiones fiscales no canónicas — y el bloque de software de
// VeriFactu (NombreRazon/NIF del productor, IdSistema, versión) que el
// registro exige; readyForReal de VeriFactu exige software.ok.
//
// El endpoint NO devuelve secretos: solo si la variable existe y tiene
// contenido distinto al placeholder "change-me".

import { existsSync } from "node:fs";
import { normalizeTaxRegion, resolveVerifactuSoftware, TAX_REGIONS } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import { createDegradedCollector } from "../../lib/degraded.js";
import { filterOperationalProperties, isOperationalKind } from "../../lib/tenancy.js";
import { resolveIssuerIdentity, type VerifactuExclusion } from "../invoicing/issuer-identity.service.js";
import { resolveSesEstablishment } from "./ses-submission.service.js";

type IntegrationMode = "sandbox" | "preproduction" | "production";

type CertStatus =
  | { configured: false; reason: string }
  | { configured: true; certPathExists: boolean };

/** VeriFactu "SistemaInformatico" block as resolved from env (no secrets). */
export type VerifactuSoftwareHealth = {
  ok: boolean;
  errors: string[];
  nombreRazon: string;
  nif: string;
  nombreSistema: string;
  idSistema: string;
  version: string;
  numeroInstalacion: string;
  tipoUsoPosibleSoloVerifactu: "S" | "N";
  tipoUsoPosibleMultiOT: "S" | "N";
  indicadorMultiplesOT: "S" | "N";
};

type IntegrationHealth = {
  integration: string;
  enabled: boolean;
  mode: IntegrationMode;
  readyForReal: boolean;
  cert: CertStatus;
  endpoint: string;
  notes?: string;
  /** VeriFactu only: the software identification block the registro carries. */
  software?: VerifactuSoftwareHealth;
};

function pickMode(envVar: string | undefined): IntegrationMode {
  if (envVar === "production" || envVar === "preproduction") return envVar;
  return "sandbox";
}

function isPlaceholder(value: string | undefined): boolean {
  return !value || value === "change-me" || value === "";
}

function checkCert(pathEnv: string | undefined, passEnv: string | undefined): CertStatus {
  if (isPlaceholder(pathEnv)) {
    return { configured: false, reason: "Variable de path del certificado no configurada." };
  }
  if (isPlaceholder(passEnv)) {
    return { configured: false, reason: "Passphrase del certificado no configurada." };
  }
  const exists = existsSync(pathEnv!);
  return { configured: true, certPathExists: exists };
}

// ───────────────────────────────────────────────── VeriFactu

function getVerifactuHealth(): IntegrationHealth {
  const mode = pickMode(process.env.VERIFACTU_MODE);
  const cert = checkCert(process.env.VERIFACTU_CERT_PATH, process.env.VERIFACTU_CERT_PASSPHRASE);
  const endpoints: Record<IntegrationMode, string> = {
    sandbox: "stub://verifactu-mock",
    preproduction: "https://prewww1.aeat.es/wlpl/SSII-FACT/ws/fa/SistemaFacturacionWeb",
    production: "https://www1.agenciatributaria.gob.es/wlpl/SSII-FACT/ws/fa/SistemaFacturacionWeb"
  };
  const resolved = resolveVerifactuSoftware(process.env);
  const software: VerifactuSoftwareHealth = { ok: resolved.ok, errors: resolved.errors, ...resolved.software };
  // The AEAT rejects a registro without a valid SistemaInformatico block, so a
  // real mode with cert but no software identification is NOT ready.
  const readyForReal = mode !== "sandbox" && cert.configured && cert.certPathExists && software.ok;
  const notes = [
    mode === "sandbox"
      ? "Modo sandbox: no se llama a AEAT. Cambia VERIFACTU_MODE=preproduction + cert para validar contra AEAT pre-producción."
      : null,
    software.ok ? null : `Bloque SistemaInformatico incompleto: ${software.errors.join(" ")}`
  ].filter((note): note is string => Boolean(note));
  return {
    integration: "verifactu",
    enabled: true,
    mode,
    readyForReal,
    cert,
    endpoint: endpoints[mode],
    notes: notes.length ? notes.join(" ") : undefined,
    software
  };
}

// ───────────────────────────────────────────────── SES Hospedajes

function getSesHospedajesHealth(): IntegrationHealth {
  const mode = pickMode(process.env.SES_HOSPEDAJES_MODE);
  const cert = checkCert(process.env.SES_HOSPEDAJES_CERT_PATH, process.env.SES_HOSPEDAJES_CERT_PASSPHRASE);
  const endpoints: Record<IntegrationMode, string> = {
    sandbox: "stub://ses-hospedajes-mock",
    preproduction: "https://hospedajes-pre.mir.es/hospedajes/api/v1/comunicaciones",
    production: "https://sede.mir.es/hospedajes/api/v1/comunicaciones"
  };
  const hasBasicAuth =
    !isPlaceholder(process.env.SES_HOSPEDAJES_CLIENT_ID) && !isPlaceholder(process.env.SES_HOSPEDAJES_CLIENT_SECRET);
  const readyForReal = mode !== "sandbox" && cert.configured && cert.certPathExists;
  return {
    integration: "ses_hospedajes",
    enabled: true,
    mode,
    readyForReal,
    cert,
    endpoint: endpoints[mode],
    notes: hasBasicAuth
      ? "Credenciales Basic auth (client_id/secret) presentes. El establecimiento de cada propiedad se comprueba en organization.sesEstablishmentIncomplete."
      : "Sin credenciales Basic auth — sólo se usa mTLS. Si el MIR las exige, configura SES_HOSPEDAJES_CLIENT_ID/SECRET. El establecimiento de cada propiedad se comprueba en organization.sesEstablishmentIncomplete."
  };
}

// ───────────────────────────────────────────────── TBAI (País Vasco / Navarra)

const FORAL_TERRITORIES = new Set(["bizkaia", "gipuzkoa", "araba", "navarra"]);

function getTbaiHealth(foralPropertyIds: string[]): IntegrationHealth {
  const mode = pickMode(process.env.TBAI_MODE);
  const tbaiMode: "sandbox" | "production" = mode === "production" ? "production" : "sandbox";
  const cert = checkCert(process.env.TBAI_CERT_PATH, process.env.TBAI_CERT_PASSPHRASE);
  // TBAI tiene 3 territorios; mostramos los 3 endpoints producción de referencia.
  const endpoints: Record<typeof tbaiMode, string> = {
    sandbox: "stub://tbai-{bizkaia|gipuzkoa|araba}",
    production: "https://sarrerak.bizkaia.eus + tbai-z.egoitza.gipuzkoa.eus + ticketbai.araba.eus"
  };
  const enabled = foralPropertyIds.length > 0;
  const readyForReal = enabled && tbaiMode === "production" && cert.configured && cert.certPathExists;
  return {
    integration: "tbai",
    enabled,
    mode: tbaiMode === "production" ? "production" : "sandbox",
    readyForReal,
    cert,
    endpoint: endpoints[tbaiMode],
    notes: enabled
      ? `TicketBAI activo: ${foralPropertyIds.length} propiedad(es) con territorio foral (Property.fiscalTerritory).`
      : "TicketBAI no aplica: ninguna propiedad declara territorio foral (Property.fiscalTerritory = bizkaia | gipuzkoa | araba | navarra)."
  };
}

// ───────────────────────────────────────────────── IGIC (Canarias)

function getIgicHealth(): IntegrationHealth {
  // Canarias no tiene un registro de facturas propio para el IGIC: las
  // facturas se declaran por VeriFactu con Impuesto=03 (IGIC). No hay
  // endpoint ATC que integrar, así que la integración queda apagada.
  return {
    integration: "igic",
    enabled: false,
    mode: pickMode(process.env.VERIFACTU_MODE),
    readyForReal: false,
    cert: { configured: false, reason: "No aplica: IGIC se declara dentro de VeriFactu (Impuesto=03)." },
    endpoint: "verifactu",
    notes: "Canarias declara por VeriFactu con Impuesto=03 (IGIC). No existe un endpoint ATC separado; el estado real es el de la integración verifactu."
  };
}

// ───────────────────────────────────────────────── salud por organización

export type OrganizationComplianceHealth = {
  /** Properties whose SES.HOSPEDAJES establishment block cannot be built (FISC-08). */
  sesEstablishmentIncomplete: { count: number; propertyIds: string[]; missing: Record<string, string[]> };
  /** Issuer NIF validity per property (FISC-03). */
  // Tanda 6b (L3): "legal_entity" once the sociedad carries the NIF; "organization" is the pre-backfill fallback.
  // `verifactuExclusion` (fix t6b#2): non-null when the sociedad is in the SII — VeriFactu does not apply
  // (RD 1007/2023 art. 3.3) and the Compliance Center shows the motivo instead of a readiness failure.
  issuers: Array<{ propertyId: string; taxIdValid: boolean; taxIdSource: "legal_entity" | "organization" | "missing"; verifactuExclusion: VerifactuExclusion | null }>;
  /** Properties whose Property.taxRegion is not one of TAX_REGIONS (legacy 'canary', 'Madrid', null…). */
  nonCanonicalTaxRegion: Array<{ propertyId: string; taxRegion: string | null; province: string | null; normalized: string | null }>;
  /** Properties with a foral territory (TicketBAI). */
  foralPropertyIds: string[];
};

/**
 * Pure (Tanda 6b · R6, t6b#17): the centres that are issuers for the health
 * report — every hotel, plus a non-lodging centre (office · other) only once it
 * bills, i.e. has an ACTIVE invoice series. The head office of a sociedad has
 * the sociedad's identity like every centre, but it is not an issuer until a
 * series is opened for it (design §5.2 R6: «verifactuEnabled a false salvo que
 * se active explícitamente una serie»).
 */
export function selectIssuerProperties<T extends { id: string; kind?: string | null }>(properties: readonly T[], billingPropertyIds: ReadonlySet<string>): T[] {
  return properties.filter((property) => isOperationalKind(property.kind) || billingPropertyIds.has(property.id));
}

async function collectOrganizationHealth(
  properties: Array<{ id: string; taxRegion: string | null; province: string | null; fiscalTerritory: string | null; kind?: string | null }>,
  safe: <T>(label: string, promise: Promise<T>, fallback: T) => Promise<T>
): Promise<OrganizationComplianceHealth> {
  const canonical = new Set<string>(TAX_REGIONS as readonly string[]);
  const nonCanonicalTaxRegion = properties
    .filter((property) => !property.taxRegion || !canonical.has(property.taxRegion))
    .map((property) => ({
      propertyId: property.id,
      taxRegion: property.taxRegion,
      province: property.province,
      normalized: normalizeTaxRegion(property.taxRegion, property.province)
    }));
  const foralPropertyIds = properties
    .filter((property) => property.fiscalTerritory && FORAL_TERRITORIES.has(property.fiscalTerritory))
    .map((property) => property.id);

  // Tanda 6b (R6): the SES establishment block is a lodging obligation — the head
  // office and other non-lodging centres never send partes and are not "incomplete".
  const establishments = await Promise.all(
    filterOperationalProperties(properties).map((property) =>
      safe(
        `sesEstablishment:${property.id}`,
        resolveSesEstablishment(property.id).then((result) => ({ propertyId: property.id, ok: result.ok, missing: result.missing as string[] })),
        { propertyId: property.id, ok: false, missing: ["unavailable"] }
      )
    )
  );
  const incomplete = establishments.filter((entry) => !entry.ok);
  const missing: Record<string, string[]> = {};
  for (const entry of incomplete) missing[entry.propertyId] = entry.missing;

  // Tanda 6b (R6): the head office is an issuer only once it bills (an active
  // series); otherwise it would show as an issuer that never invoices.
  const nonOperationalIds = properties.filter((property) => !isOperationalKind(property.kind)).map((property) => property.id);
  const billingRows =
    nonOperationalIds.length === 0
      ? []
      : await safe(
          "billingCentres",
          prisma.invoiceSequence.findMany({ where: { propertyId: { in: nonOperationalIds }, active: true }, select: { propertyId: true }, distinct: ["propertyId"] }),
          [] as Array<{ propertyId: string }>
        );
  const issuerProperties = selectIssuerProperties(properties, new Set(billingRows.map((row) => row.propertyId)));
  const issuers = await Promise.all(
    issuerProperties.map((property) =>
      safe(
        `issuer:${property.id}`,
        resolveIssuerIdentity(property.id).then((identity) => ({
          propertyId: property.id,
          taxIdValid: identity?.taxIdValid ?? false,
          taxIdSource: identity?.taxIdSource ?? "missing",
          verifactuExclusion: identity?.verifactuExclusion ?? null
        })),
        { propertyId: property.id, taxIdValid: false, taxIdSource: "missing" as const, verifactuExclusion: null }
      )
    )
  );

  return {
    sesEstablishmentIncomplete: { count: incomplete.length, propertyIds: incomplete.map((entry) => entry.propertyId), missing },
    issuers,
    nonCanonicalTaxRegion,
    foralPropertyIds
  };
}

// ───────────────────────────────────────────────── salud agregada

export type ComplianceHealthReport = {
  generatedAt: string;
  overall: "sandbox_only" | "mixed" | "production_ready";
  integrations: IntegrationHealth[];
  organization: OrganizationComplianceHealth;
  // Counters are `null` (never 0) when their query failed; the label of each
  // failed counter is listed in `degraded` so the UI shows "no disponible"
  // instead of a green zero (QC-06).
  stats: {
    verifactuSubmissionsLast24h: number | null;
    sesSubmissionsLast24h: number | null;
    tbaiSubmissionsLast24h: number | null;
    verifactuRejectedLast24h: number | null;
    sesRejectedLast24h: number | null;
    /** SES comunicaciones not accepted (queued/sent/retrying/failed/rejected) more than 24 h after being queued. */
    sesOverdue: number | null;
    /** SES rows failed for a recoverable reason (establishment / NIF) waiting for the profile fix. */
    sesBlockedByEstablishment: number | null;
  };
  degraded: string[];
};

export async function getComplianceHealth(organizationId?: string): Promise<ComplianceHealthReport> {
  // A failed count must not read as "0 rejections" (green) in the Compliance
  // Center: each counter degrades to null and is listed in `degraded`.
  const { safe, degraded } = createDegradedCollector("compliance.health", { organizationId: organizationId ?? null });
  const nullCount: number | null = null;

  // Submission tables carry propertyId but no relation to Property: scope the
  // 24h counters to the caller's organization through its property ids.
  const properties = await safe(
    "properties",
    prisma.property.findMany({
      where: organizationId ? { organizationId } : {},
      select: { id: true, taxRegion: true, province: true, fiscalTerritory: true, kind: true }
    }),
    [] as Array<{ id: string; taxRegion: string | null; province: string | null; fiscalTerritory: string | null; kind: string }>
  );
  const tenantScope = organizationId ? { propertyId: { in: properties.map((p) => p.id) } } : {};

  const organization = await collectOrganizationHealth(properties, safe);
  const integrations = [getVerifactuHealth(), getSesHospedajesHealth(), getTbaiHealth(organization.foralPropertyIds), getIgicHealth()];

  const active = integrations.filter((i) => i.enabled);
  const realCount = active.filter((i) => i.readyForReal).length;
  const allSandbox = active.every((i) => i.mode === "sandbox");
  const overall: ComplianceHealthReport["overall"] = allSandbox
    ? "sandbox_only"
    : realCount === active.length && organization.sesEstablishmentIncomplete.count === 0
      ? "production_ready"
      : "mixed";

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [vCount, sCount, tCount, vRejected, sRejected, sOverdue, sBlocked] = await Promise.all([
    safe("verifactuSubmissionsLast24h", prisma.verifactuSubmission.count({ where: { ...tenantScope, createdAt: { gte: dayAgo } } }), nullCount),
    safe("sesSubmissionsLast24h", prisma.sesHospedajesSubmission.count({ where: { ...tenantScope, createdAt: { gte: dayAgo } } }), nullCount),
    // tbai usa una tabla distinta o reutiliza verifactu — protegemos:
    safe(
      "tbaiSubmissionsLast24h",
      prisma.verifactuSubmission.count({ where: { ...tenantScope, createdAt: { gte: dayAgo }, endpoint: { contains: "tbai" } } }),
      nullCount
    ),
    safe(
      "verifactuRejectedLast24h",
      prisma.verifactuSubmission.count({ where: { ...tenantScope, status: "rejected", createdAt: { gte: dayAgo } } }),
      nullCount
    ),
    safe(
      "sesRejectedLast24h",
      prisma.sesHospedajesSubmission.count({ where: { ...tenantScope, status: "rejected", createdAt: { gte: dayAgo } } }),
      nullCount
    ),
    safe(
      "sesOverdue",
      prisma.sesHospedajesSubmission.count({ where: { ...tenantScope, status: { in: ["queued", "sent", "retrying", "failed", "rejected"] }, createdAt: { lt: dayAgo } } }),
      nullCount
    ),
    safe(
      "sesBlockedByEstablishment",
      prisma.sesHospedajesSubmission.count({
        where: { ...tenantScope, status: "failed", errorCode: { in: ["SES_ESTABLISHMENT_INCOMPLETE", "ISSUER_TAX_ID_MISSING"] } }
      }),
      nullCount
    )
  ]);

  return {
    generatedAt: new Date().toISOString(),
    overall,
    integrations,
    organization,
    stats: {
      verifactuSubmissionsLast24h: vCount,
      sesSubmissionsLast24h: sCount,
      tbaiSubmissionsLast24h: tCount,
      verifactuRejectedLast24h: vRejected,
      sesRejectedLast24h: sRejected,
      sesOverdue: sOverdue,
      sesBlockedByEstablishment: sBlocked
    },
    degraded
  };
}

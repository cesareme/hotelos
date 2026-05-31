// PILOT-D4 · Diagnóstico de las integraciones de compliance ES.
//
// Devuelve el modo actual (sandbox/preproduction/production) y si los
// certificados están configurados para cada integración. Esto le permite al
// cliente piloto comprobar de un vistazo en qué punto está su entorno antes
// de declarar "go-live".
//
// El endpoint NO devuelve secretos: solo si la variable existe y tiene
// contenido distinto al placeholder "change-me".

import { existsSync } from "node:fs";
import { prisma } from "@hotelos/database";

type IntegrationMode = "sandbox" | "preproduction" | "production";

type CertStatus =
  | { configured: false; reason: string }
  | { configured: true; certPathExists: boolean };

type IntegrationHealth = {
  integration: string;
  enabled: boolean;
  mode: IntegrationMode;
  readyForReal: boolean;
  cert: CertStatus;
  endpoint: string;
  notes?: string;
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
  const readyForReal = mode !== "sandbox" && cert.configured && cert.certPathExists;
  return {
    integration: "verifactu",
    enabled: true,
    mode,
    readyForReal,
    cert,
    endpoint: endpoints[mode],
    notes:
      mode === "sandbox"
        ? "Modo sandbox: no se llama a AEAT. Cambia VERIFACTU_MODE=preproduction + cert para validar contra AEAT pre-producción."
        : undefined
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
      ? "Credenciales Basic auth (client_id/secret) presentes."
      : "Sin credenciales Basic auth — sólo se usa mTLS. Si el MIR las exige, configura SES_HOSPEDAJES_CLIENT_ID/SECRET."
  };
}

// ───────────────────────────────────────────────── TBAI (País Vasco)

function getTbaiHealth(): IntegrationHealth {
  const mode = pickMode(process.env.TBAI_MODE);
  const tbaiMode: "sandbox" | "production" = mode === "production" ? "production" : "sandbox";
  const cert = checkCert(process.env.TBAI_CERT_PATH, process.env.TBAI_CERT_PASSPHRASE);
  // TBAI tiene 3 territorios; mostramos los 3 endpoints producción de referencia.
  const endpoints: Record<typeof tbaiMode, string> = {
    sandbox: "stub://tbai-{bizkaia|gipuzkoa|araba}",
    production: "https://sarrerak.bizkaia.eus + tbai-z.egoitza.gipuzkoa.eus + ticketbai.araba.eus"
  };
  const readyForReal = tbaiMode === "production" && cert.configured && cert.certPathExists;
  return {
    integration: "tbai",
    enabled: true,
    mode: tbaiMode === "production" ? "production" : "sandbox",
    readyForReal,
    cert,
    endpoint: endpoints[tbaiMode],
    notes: "TBAI solo aplica si tienes propiedades en País Vasco (Bizkaia/Gipuzkoa/Álava)."
  };
}

// ───────────────────────────────────────────────── IGIC (Canarias)

function getIgicHealth(): IntegrationHealth {
  const mode = pickMode(process.env.IGIC_MODE);
  const cert = checkCert(process.env.IGIC_CERT_PATH, process.env.IGIC_CERT_PASSPHRASE);
  const endpoints: Record<IntegrationMode, string> = {
    sandbox: "stub://igic-mock",
    preproduction: "https://servicios-pruebas.gobiernodecanarias.org/atc/igic/registro-facturas",
    production: "https://servicios.gobiernodecanarias.org/atc/igic/registro-facturas"
  };
  const readyForReal = mode !== "sandbox" && cert.configured && cert.certPathExists;
  return {
    integration: "igic",
    enabled: true,
    mode,
    readyForReal,
    cert,
    endpoint: endpoints[mode],
    notes: "IGIC solo aplica si tienes propiedades en Canarias (taxRegion=canary)."
  };
}

// ───────────────────────────────────────────────── salud agregada

export type ComplianceHealthReport = {
  generatedAt: string;
  overall: "sandbox_only" | "mixed" | "production_ready";
  integrations: IntegrationHealth[];
  stats: {
    verifactuSubmissionsLast24h: number;
    sesSubmissionsLast24h: number;
    tbaiSubmissionsLast24h: number;
    verifactuRejectedLast24h: number;
    sesRejectedLast24h: number;
  };
};

export async function getComplianceHealth(): Promise<ComplianceHealthReport> {
  const integrations = [
    getVerifactuHealth(),
    getSesHospedajesHealth(),
    getTbaiHealth(),
    getIgicHealth()
  ];

  const realCount = integrations.filter((i) => i.readyForReal).length;
  const allSandbox = integrations.every((i) => i.mode === "sandbox");
  const overall: ComplianceHealthReport["overall"] = allSandbox
    ? "sandbox_only"
    : realCount === integrations.length
      ? "production_ready"
      : "mixed";

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [vCount, sCount, tCount, vRejected, sRejected] = await Promise.all([
    prisma.verifactuSubmission.count({ where: { createdAt: { gte: dayAgo } } }).catch(() => 0),
    prisma.sesHospedajesSubmission.count({ where: { createdAt: { gte: dayAgo } } }).catch(() => 0),
    // tbai usa una tabla distinta o reutiliza verifactu — protegemos:
    prisma.verifactuSubmission
      .count({ where: { createdAt: { gte: dayAgo }, endpoint: { contains: "tbai" } } })
      .catch(() => 0),
    prisma.verifactuSubmission.count({ where: { status: "rejected", createdAt: { gte: dayAgo } } }).catch(() => 0),
    prisma.sesHospedajesSubmission.count({ where: { status: "rejected", createdAt: { gte: dayAgo } } }).catch(() => 0)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    overall,
    integrations,
    stats: {
      verifactuSubmissionsLast24h: vCount,
      sesSubmissionsLast24h: sCount,
      tbaiSubmissionsLast24h: tCount,
      verifactuRejectedLast24h: vRejected,
      sesRejectedLast24h: sRejected
    }
  };
}

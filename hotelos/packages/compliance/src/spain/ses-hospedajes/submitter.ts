import { createHash } from "node:crypto";

export type SesSubmissionMode = "sandbox" | "preproduction" | "production";

export type SesSubmissionRequest = {
  externalReference: string;
  establishmentTaxId: string;
  xmlPayload: string;
};

export type SesSubmissionResponse = {
  status: "accepted" | "accepted_with_warnings" | "rejected" | "network_error";
  endpoint: string;
  acknowledgementCode?: string;
  trackingNumber?: string;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: string;
};

const ENDPOINTS: Record<SesSubmissionMode, string> = {
  sandbox: "stub://ses-hospedajes-mock",
  preproduction: "https://hospedajes-pre.mir.es/hospedajes/api/v1/comunicaciones",
  production: "https://sede.mir.es/hospedajes/api/v1/comunicaciones"
};

function pickMode(): SesSubmissionMode {
  const raw = process.env.SES_HOSPEDAJES_MODE;
  if (raw === "production" || raw === "preproduction" || raw === "sandbox") return raw;
  return "sandbox";
}

function generateAck(externalRef: string): string {
  return createHash("sha256").update(`ses|${externalRef}`).digest("hex").toUpperCase().slice(0, 20);
}

export async function submitSesHospedajesComunicacion(input: SesSubmissionRequest): Promise<SesSubmissionResponse> {
  const mode = pickMode();
  const endpoint = ENDPOINTS[mode];

  if (mode === "sandbox") {
    if (!input.xmlPayload.includes("<ses:ComunicacionParte")) {
      return { status: "rejected", endpoint, errorCode: "MALFORMED_XML", errorMessage: "Stub: missing ComunicacionParte root." };
    }
    if (!/<(?:ses:)?NumeroDocumento>/.test(input.xmlPayload)) {
      return { status: "rejected", endpoint, errorCode: "MISSING_DOCUMENT", errorMessage: "Stub: at least one Persona must have NumeroDocumento." };
    }
    const ack = generateAck(input.externalReference);
    return {
      status: "accepted",
      endpoint,
      acknowledgementCode: ack,
      trackingNumber: `SES-${ack.slice(0, 12)}`,
      rawResponse: `<respuesta><Estado>ACEPTADO</Estado><CodigoAcuse>${ack}</CodigoAcuse><NumeroTramite>SES-${ack.slice(0, 12)}</NumeroTramite></respuesta>`
    };
  }

  const certPath = process.env.SES_HOSPEDAJES_CERT_PATH;
  const certPassphrase = process.env.SES_HOSPEDAJES_CERT_PASSPHRASE;
  const clientId = process.env.SES_HOSPEDAJES_CLIENT_ID;
  const clientSecret = process.env.SES_HOSPEDAJES_CLIENT_SECRET;
  if (!certPath || !certPassphrase) {
    return { status: "rejected", endpoint, errorCode: "CERT_NOT_CONFIGURED", errorMessage: `SES.HOSPEDAJES mode '${mode}' requires SES_HOSPEDAJES_CERT_PATH + SES_HOSPEDAJES_CERT_PASSPHRASE (qualified electronic certificate registered with MIR).` };
  }

  try {
    const { readFileSync } = await import("node:fs");
    const { Agent, fetch: undiciFetch } = await import("undici");
    const pfx = readFileSync(certPath);
    const dispatcher = new Agent({ connect: { pfx: [{ buf: pfx, passphrase: certPassphrase }], rejectUnauthorized: true } });
    const headers: Record<string, string> = {
      "Content-Type": "application/xml; charset=utf-8",
      "X-MIR-API-Version": "v1"
    };
    if (clientId && clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    }
    const response = await undiciFetch(endpoint, {
      method: "POST",
      headers,
      body: input.xmlPayload,
      dispatcher
    });
    const text = await response.text();
    if (!response.ok) {
      return { status: "rejected", endpoint, errorCode: `HTTP_${response.status}`, errorMessage: text.slice(0, 500), rawResponse: text };
    }
    const ackMatch = text.match(/<CodigoAcuse>([^<]+)<\/CodigoAcuse>/i);
    const tramiteMatch = text.match(/<NumeroTramite>([^<]+)<\/NumeroTramite>/i);
    const errorMatch = text.match(/<CodigoErrorAcuse>([^<]+)<\/CodigoErrorAcuse>/i);
    if (errorMatch) {
      return { status: "rejected", endpoint, errorCode: errorMatch[1], errorMessage: text.slice(0, 500), rawResponse: text };
    }
    const warningMatch = text.match(/<Aviso>/i);
    return {
      status: warningMatch ? "accepted_with_warnings" : "accepted",
      endpoint,
      acknowledgementCode: ackMatch?.[1],
      trackingNumber: tramiteMatch?.[1],
      rawResponse: text
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "network_error", endpoint, errorCode: "NETWORK", errorMessage: message };
  }
}

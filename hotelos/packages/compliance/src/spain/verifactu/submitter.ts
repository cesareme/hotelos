import { createHash } from "node:crypto";

export type VerifactuSubmissionMode = "sandbox" | "preproduction" | "production";

export type VerifactuSubmissionRequest = {
  invoiceId: string;
  invoiceNumber: string;
  emitterTaxId: string;
  xmlPayload: string;
};

export type VerifactuSubmissionResponse = {
  status: "accepted" | "accepted_with_errors" | "rejected" | "network_error";
  endpoint: string;
  csvCode?: string;
  acceptedHash?: string;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: string;
};

const ENDPOINTS: Record<VerifactuSubmissionMode, string> = {
  sandbox: "stub://verifactu-mock",
  preproduction: "https://prewww1.aeat.es/wlpl/SSII-FACT/ws/fa/SistemaFacturacionWeb",
  production: "https://www1.agenciatributaria.gob.es/wlpl/SSII-FACT/ws/fa/SistemaFacturacionWeb"
};

function pickMode(): VerifactuSubmissionMode {
  const raw = process.env.VERIFACTU_MODE;
  if (raw === "production" || raw === "preproduction" || raw === "sandbox") return raw;
  return "sandbox";
}

function generateCsv(emitterTaxId: string, invoiceNumber: string): string {
  // CSV (Código Seguro de Verificación) is a 16-char alphanumeric assigned by
  // AEAT. We generate a deterministic mock CSV from the invoice when running
  // in sandbox so the same invoice replays the same code.
  const hex = createHash("sha256").update(`${emitterTaxId}|${invoiceNumber}`).digest("hex").toUpperCase();
  return hex.replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

export async function submitVerifactuRegistro(input: VerifactuSubmissionRequest): Promise<VerifactuSubmissionResponse> {
  const mode = pickMode();
  const endpoint = ENDPOINTS[mode];

  if (mode === "sandbox") {
    // Local stub: validates that XML contains required tags and returns ACK.
    if (!input.xmlPayload.includes("<sum1:Huella>")) {
      return {
        status: "rejected",
        endpoint,
        errorCode: "MISSING_HUELLA",
        errorMessage: "Stub: XML does not include Huella element."
      };
    }
    return {
      status: "accepted",
      endpoint,
      csvCode: generateCsv(input.emitterTaxId, input.invoiceNumber),
      acceptedHash: createHash("sha256").update(input.xmlPayload).digest("hex").toUpperCase(),
      rawResponse: `<ack><status>Correcto</status><csv>${generateCsv(input.emitterTaxId, input.invoiceNumber)}</csv></ack>`
    };
  }

  const certPath = process.env.VERIFACTU_CERT_PATH;
  const certPassphrase = process.env.VERIFACTU_CERT_PASSPHRASE;
  if (!certPath || !certPassphrase) {
    return {
      status: "rejected",
      endpoint,
      errorCode: "CERT_NOT_CONFIGURED",
      errorMessage: `VeriFactu mode '${mode}' requires VERIFACTU_CERT_PATH + VERIFACTU_CERT_PASSPHRASE environment variables (PKCS#12).`
    };
  }

  // Production submission uses Node's undici with mTLS. We construct the agent
  // lazily so sandbox mode never has to load the X.509.
  try {
    const { readFileSync } = await import("node:fs");
    const { Agent, fetch: undiciFetch } = await import("undici");
    const pfx = readFileSync(certPath);
    const dispatcher = new Agent({
      connect: {
        pfx: [{ buf: pfx, passphrase: certPassphrase }],
        rejectUnauthorized: true
      }
    });
    const response = await undiciFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
      body: input.xmlPayload,
      dispatcher
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        status: "rejected",
        endpoint,
        errorCode: `HTTP_${response.status}`,
        errorMessage: text.slice(0, 500),
        rawResponse: text
      };
    }
    const csvMatch = text.match(/<CSV>([^<]+)<\/CSV>/i);
    const errorMatch = text.match(/<CodigoErrorRegistro>([^<]+)<\/CodigoErrorRegistro>/i);
    if (errorMatch) {
      return { status: "rejected", endpoint, errorCode: errorMatch[1], errorMessage: text.slice(0, 500), rawResponse: text };
    }
    return {
      status: "accepted",
      endpoint,
      csvCode: csvMatch?.[1],
      acceptedHash: createHash("sha256").update(input.xmlPayload).digest("hex").toUpperCase(),
      rawResponse: text
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "network_error", endpoint, errorCode: "NETWORK", errorMessage: message };
  }
}

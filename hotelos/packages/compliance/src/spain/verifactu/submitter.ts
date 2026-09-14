import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { VERIFACTU_XML_NAMESPACES } from "./xml.js";

// The software resolver lives in ./software.ts; it is re-exported from here so
// `@hotelos/compliance` exposes it through the existing
// `export * from "./verifactu/submitter.js"` line of spain/index.ts (that
// index belongs to another Tanda 3 lot). ./index.ts is the canonical barrel;
// once spain/index.ts points at it this re-export is redundant but harmless
// (same binding, no duplicate-export conflict).
export {
  resolveVerifactuSoftware,
  VERIFACTU_SOFTWARE_DEFAULTS,
  VERIFACTU_SOFTWARE_LIMITS,
  type VerifactuSoftwareBlock,
  type VerifactuSoftwareFlag,
  type VerifactuSoftwareResolution
} from "./software.js";

// Transport to AEAT's SistemaFacturacionWeb (VERI*FACTU). Three modes:
//   sandbox        stub://verifactu-mock — no network, deterministic ACK
//   preproduction  https://prewww1.aeat.es/…  (AEAT test environment)
//   production     https://www1.agenciatributaria.gob.es/…
//
// Credentials (see .env.example, block VERIFACTU_*):
//   VERIFACTU_CERT_P12 (+ VERIFACTU_CERT_P12_PASSPHRASE)  mTLS client certificate (PKCS#12)
//   VERIFACTU_SIGN_PEM (+ VERIFACTU_SIGN_PEM_PASSPHRASE)  PEM (private key + certificate) for the
//                                                        XAdES signature kept in the audit trail
//   VERIFACTU_CERT_PATH (+ VERIFACTU_CERT_PASSPHRASE)     legacy single file: used for mTLS whatever
//                                                        its format (sniffed) and, when it is PEM,
//                                                        also for signing.
//
// NOTE on the signature: in the VERI*FACTU modality the registro is NOT signed —
// integrity comes from the huella chain and the channel is authenticated by
// mTLS (RD 1007/2023 art. 12; the signature is only required for "no VERI*FACTU"
// systems). The XAdES block Anfitorio adds is therefore kept for the local
// audit trail (verifactu_submissions.xml_payload) and the SOAP body carries the
// UNSIGNED registro (`transportXml`), which is what the XSD validates.

export type VerifactuSubmissionMode = "sandbox" | "preproduction" | "production";

/** Kind of registro on the wire: RegistroAlta or RegistroAnulacion. */
export type VerifactuRegistroKind = "alta" | "anulacion";

export type VerifactuSubmissionRequest = {
  invoiceId: string;
  invoiceNumber: string;
  emitterTaxId: string;
  /**
   * "alta" (default, legacy callers) or "anulacion". The sandbox CSV is
   * derived per (NIF, número, registro), so the alta and the anulación of one
   * invoice never share a CSV — AEAT assigns one CSV per registro, not per invoice.
   */
  registroType?: VerifactuRegistroKind;
  /** Registro as stored (may carry the XAdES audit signature). */
  xmlPayload: string;
  /** Registro to put on the wire (unsigned). Defaults to xmlPayload. */
  transportXml?: string;
};

export type VerifactuSubmissionResponse = {
  status: "accepted" | "accepted_with_errors" | "rejected" | "network_error";
  endpoint: string;
  mode: VerifactuSubmissionMode;
  csvCode?: string;
  acceptedHash?: string;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: string;
};

export const VERIFACTU_ENDPOINTS: Record<VerifactuSubmissionMode, string> = {
  sandbox: "stub://verifactu-mock",
  preproduction: "https://prewww1.aeat.es/wlpl/SSII-FACT/ws/fa/SistemaFacturacionWeb",
  production: "https://www1.agenciatributaria.gob.es/wlpl/SSII-FACT/ws/fa/SistemaFacturacionWeb"
};

const SOAP_ENVELOPE_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Error codes the queue treats as transient (retrying) rather than as an AEAT rejection. */
export const VERIFACTU_TRANSIENT_ERROR_CODES: readonly string[] = Object.freeze(["CERT_NOT_CONFIGURED", "SOFTWARE_NOT_CONFIGURED"]);

export function isTransientVerifactuError(errorCode: string | null | undefined): boolean {
  if (!errorCode) return false;
  return errorCode.startsWith("NETWORK_") || VERIFACTU_TRANSIENT_ERROR_CODES.includes(errorCode);
}

export function resolveVerifactuMode(env: NodeJS.ProcessEnv = process.env): VerifactuSubmissionMode {
  const raw = (env.VERIFACTU_MODE ?? "").trim();
  if (raw === "production" || raw === "preproduction" || raw === "sandbox") return raw;
  return "sandbox";
}

export function isVerifactuSimulatedEndpoint(endpoint: string | null | undefined): boolean {
  return typeof endpoint === "string" && endpoint.startsWith("stub://");
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type VerifactuCertificateFormat = "p12" | "pem";

export type VerifactuCredentials = {
  /** Client certificate for mTLS against AEAT, or null when not configured. */
  mtls: { path: string; passphrase: string | null; format: VerifactuCertificateFormat; source: string } | null;
  /** PEM used by the XAdES audit signature, or null (stub signature). */
  signing: { certPath: string; certPassphrase: string | null; source: string } | null;
  warnings: string[];
};

/** "pem" when the file starts with a PEM armour header, "p12" otherwise (binary PKCS#12). */
export function sniffCertificateFormat(path: string, readFile: (p: string) => Buffer): VerifactuCertificateFormat {
  const head = readFile(path).subarray(0, 64).toString("latin1");
  return head.includes("-----BEGIN") ? "pem" : "p12";
}

/**
 * Resolve mTLS and signing material from the environment. Pure apart from
 * the optional file sniff (legacy VERIFACTU_CERT_PATH only), which is
 * injectable for tests. Never throws: an unreadable file becomes a warning and
 * the credential stays unset, so the submitter answers CERT_NOT_CONFIGURED
 * instead of crashing the queue.
 */
export function resolveVerifactuCredentials(
  env: NodeJS.ProcessEnv = process.env,
  readFile?: (p: string) => Buffer
): VerifactuCredentials {
  const warnings: string[] = [];
  let mtls: VerifactuCredentials["mtls"] = null;
  let signing: VerifactuCredentials["signing"] = null;

  const p12 = readEnv(env, "VERIFACTU_CERT_P12");
  if (p12) {
    mtls = {
      path: p12,
      passphrase: readEnv(env, "VERIFACTU_CERT_P12_PASSPHRASE") ?? readEnv(env, "VERIFACTU_CERT_PASSPHRASE"),
      format: "p12",
      source: "VERIFACTU_CERT_P12"
    };
  }

  const signPem = readEnv(env, "VERIFACTU_SIGN_PEM");
  if (signPem) {
    signing = {
      certPath: signPem,
      certPassphrase: readEnv(env, "VERIFACTU_SIGN_PEM_PASSPHRASE") ?? readEnv(env, "VERIFACTU_CERT_PASSPHRASE"),
      source: "VERIFACTU_SIGN_PEM"
    };
  }

  const legacyPath = readEnv(env, "VERIFACTU_CERT_PATH");
  if (legacyPath && (!mtls || !signing)) {
    const legacyPassphrase = readEnv(env, "VERIFACTU_CERT_PASSPHRASE");
    let format: VerifactuCertificateFormat | null = null;
    try {
      format = sniffCertificateFormat(legacyPath, readFile ?? ((p: string) => readFileSync(p)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`VERIFACTU_CERT_PATH no se puede leer (${legacyPath}): ${message}`);
    }
    if (format) {
      if (!mtls) mtls = { path: legacyPath, passphrase: legacyPassphrase, format, source: "VERIFACTU_CERT_PATH" };
      if (!signing && format === "pem") {
        signing = { certPath: legacyPath, certPassphrase: legacyPassphrase, source: "VERIFACTU_CERT_PATH" };
      } else if (!signing && format === "p12") {
        warnings.push(
          "VERIFACTU_CERT_PATH es un PKCS#12: sirve para mTLS pero no para la firma XAdES de auditoría. Define VERIFACTU_SIGN_PEM (openssl pkcs12 -in cert.p12 -nodes -out sign.pem) o acepta la firma stub."
        );
      }
    }
  }

  if (mtls && mtls.format === "p12" && !mtls.passphrase) {
    warnings.push(`El certificado PKCS#12 (${mtls.source}) no tiene contraseña configurada (VERIFACTU_CERT_P12_PASSPHRASE).`);
  }

  return { mtls, signing, warnings };
}

/**
 * CSV (Código Seguro de Verificación) is a 16-char alphanumeric AEAT assigns
 * to each registro. The sandbox stub derives a deterministic one from
 * (NIF | número | registro), so the same registro replays the same code and
 * the alta and the anulación of one invoice get different codes. Pure.
 */
export function generateSandboxCsv(emitterTaxId: string, invoiceNumber: string, registroType: VerifactuRegistroKind = "alta"): string {
  const hex = createHash("sha256").update(`${emitterTaxId}|${invoiceNumber}|${registroType}`).digest("hex").toUpperCase();
  return hex.replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

function payloadHash(xml: string): string {
  return createHash("sha256").update(xml).digest("hex").toUpperCase();
}

/**
 * SOAP 1.1 envelope expected by SistemaFacturacionWeb: the registro
 * (<sum:RegFactuSistemaFacturacion>) as the only Body child, without its XML
 * declaration. Namespaces are re-declared on the Envelope for readability;
 * the registro keeps its own declarations so it stays self-contained.
 */
export function wrapVerifactuSoapEnvelope(registroXml: string): string {
  const body = registroXml.replace(/^\s*<\?xml[^>]*\?>\s*/i, "").trim();
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${SOAP_ENVELOPE_NS}" xmlns:sum="${VERIFACTU_XML_NAMESPACES.sum}" xmlns:sum1="${VERIFACTU_XML_NAMESPACES.sum1}">
  <soapenv:Header/>
  <soapenv:Body>
${body}
  </soapenv:Body>
</soapenv:Envelope>`;
}

export type VerifactuParsedResponse = {
  /** EstadoEnvio: Correcto · ParcialmenteCorrecto · Incorrecto (null when absent). */
  estadoEnvio: string | null;
  csv: string | null;
  /** First RespuestaLinea (Anfitorio sends one registro per envelope). */
  estadoRegistro: string | null;
  codigoErrorRegistro: string | null;
  descripcionErrorRegistro: string | null;
  soapFault: { code: string | null; message: string | null } | null;
};

function firstTag(text: string, localName: string): string | null {
  // Namespace-agnostic: matches <tikR:CSV>, <CSV>, <ns2:CSV …>.
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}(?:\\s[^>]*)?>([^<]*)<\\/(?:[A-Za-z0-9_.-]+:)?${localName}>`, "i");
  const match = re.exec(text);
  return match ? match[1]!.trim() : null;
}

/** Parse a RespuestaRegFactuSistemaFacturacion (or a SOAP Fault). Never throws. */
export function parseVerifactuSoapResponse(text: string): VerifactuParsedResponse {
  const faultCode = firstTag(text, "faultcode");
  const faultString = firstTag(text, "faultstring");
  const soapFault = faultCode || faultString ? { code: faultCode, message: faultString } : null;
  return {
    estadoEnvio: firstTag(text, "EstadoEnvio"),
    csv: firstTag(text, "CSV"),
    estadoRegistro: firstTag(text, "EstadoRegistro"),
    codigoErrorRegistro: firstTag(text, "CodigoErrorRegistro"),
    descripcionErrorRegistro: firstTag(text, "DescripcionErrorRegistro"),
    soapFault
  };
}

/** Map a parsed AEAT response to the queue's status vocabulary. */
export function classifyVerifactuResponse(parsed: VerifactuParsedResponse): {
  status: VerifactuSubmissionResponse["status"];
  errorCode?: string;
  errorMessage?: string;
} {
  if (parsed.soapFault) {
    return {
      status: "rejected",
      errorCode: `SOAP_FAULT${parsed.soapFault.code ? `_${parsed.soapFault.code.replace(/^.*:/, "").toUpperCase()}` : ""}`,
      errorMessage: parsed.soapFault.message ?? "SOAP Fault sin descripción."
    };
  }
  const estado = (parsed.estadoRegistro ?? parsed.estadoEnvio ?? "").toLowerCase();
  if (estado === "correcto") return { status: "accepted" };
  if (estado === "aceptadoconerrores" || estado === "parcialmentecorrecto") {
    return {
      status: "accepted_with_errors",
      errorCode: parsed.codigoErrorRegistro ?? "ACEPTADO_CON_ERRORES",
      errorMessage: parsed.descripcionErrorRegistro ?? "Registro aceptado con errores por AEAT."
    };
  }
  if (estado === "incorrecto" || parsed.codigoErrorRegistro) {
    return {
      status: "rejected",
      errorCode: parsed.codigoErrorRegistro ?? "INCORRECTO",
      errorMessage: parsed.descripcionErrorRegistro ?? "Registro rechazado por AEAT."
    };
  }
  return {
    status: "rejected",
    errorCode: "UNPARSEABLE_RESPONSE",
    errorMessage: "La respuesta de AEAT no contiene EstadoEnvio/EstadoRegistro reconocibles."
  };
}

export type VerifactuSubmitOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: (endpoint: string, init: { method: string; headers: Record<string, string>; body: string; dispatcher?: unknown; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  timeoutMs?: number;
};

export async function submitVerifactuRegistro(
  input: VerifactuSubmissionRequest,
  options: VerifactuSubmitOptions = {}
): Promise<VerifactuSubmissionResponse> {
  const env = options.env ?? process.env;
  const mode = resolveVerifactuMode(env);
  const endpoint = VERIFACTU_ENDPOINTS[mode];

  if (mode === "sandbox") {
    // Local stub: validates that the XML carries a huella and returns an ACK.
    if (!input.xmlPayload.includes("<sum1:Huella>")) {
      return {
        status: "rejected",
        endpoint,
        mode,
        errorCode: "MISSING_HUELLA",
        errorMessage: "Stub: XML does not include Huella element."
      };
    }
    const csv = generateSandboxCsv(input.emitterTaxId, input.invoiceNumber, input.registroType ?? "alta");
    return {
      status: "accepted",
      endpoint,
      mode,
      csvCode: csv,
      acceptedHash: payloadHash(input.xmlPayload),
      rawResponse: `<ack><status>Correcto</status><csv>${csv}</csv></ack>`
    };
  }

  const credentials = resolveVerifactuCredentials(env);
  if (!credentials.mtls) {
    return {
      status: "rejected",
      endpoint,
      mode,
      errorCode: "CERT_NOT_CONFIGURED",
      errorMessage: `El modo VeriFactu '${mode}' requiere un certificado mTLS: VERIFACTU_CERT_P12 + VERIFACTU_CERT_P12_PASSPHRASE (o VERIFACTU_CERT_PATH).${credentials.warnings.length ? ` ${credentials.warnings.join(" ")}` : ""}`
    };
  }

  const soapBody = wrapVerifactuSoapEnvelope(input.transportXml ?? input.xmlPayload);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let dispatcher: unknown;
    let fetchImpl = options.fetchImpl;
    if (!fetchImpl) {
      const { readFileSync } = await import("node:fs");
      const { Agent, fetch: undiciFetch } = await import("undici");
      const material = readFileSync(credentials.mtls.path);
      dispatcher = new Agent({
        connect:
          credentials.mtls.format === "p12"
            ? { pfx: [{ buf: material, passphrase: credentials.mtls.passphrase ?? undefined }], rejectUnauthorized: true }
            : { cert: material, key: material, passphrase: credentials.mtls.passphrase ?? undefined, rejectUnauthorized: true }
      });
      fetchImpl = undiciFetch as unknown as NonNullable<VerifactuSubmitOptions["fetchImpl"]>;
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
      body: soapBody,
      dispatcher,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      const transient = response.status >= 500 || response.status === 429;
      return {
        status: transient ? "network_error" : "rejected",
        endpoint,
        mode,
        errorCode: transient ? `NETWORK_HTTP_${response.status}` : `HTTP_${response.status}`,
        errorMessage: text.slice(0, 500),
        rawResponse: text
      };
    }
    const parsed = parseVerifactuSoapResponse(text);
    const verdict = classifyVerifactuResponse(parsed);
    return {
      status: verdict.status,
      endpoint,
      mode,
      csvCode: parsed.csv ?? undefined,
      acceptedHash: verdict.status === "accepted" || verdict.status === "accepted_with_errors" ? payloadHash(input.xmlPayload) : undefined,
      errorCode: verdict.errorCode,
      errorMessage: verdict.errorMessage,
      rawResponse: text
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      status: "network_error",
      endpoint,
      mode,
      errorCode: aborted ? "NETWORK_TIMEOUT" : "NETWORK_ERROR",
      errorMessage: aborted ? `Sin respuesta de AEAT en ${timeoutMs} ms.` : message
    };
  } finally {
    clearTimeout(timer);
  }
}

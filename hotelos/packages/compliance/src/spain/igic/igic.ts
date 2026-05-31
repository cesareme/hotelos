import { createHash } from "node:crypto";

// IGIC (Impuesto General Indirecto Canario) is administered by the Agencia
// Tributaria Canaria — NOT by AEAT. The submission protocol mirrors VeriFactu
// in spirit but uses a separate endpoint and a slightly different XSD root.
// In sandbox mode we generate a deterministic CSV; production uses the
// official ATC web service over mTLS.

export type IgicInvoiceType = "F1" | "F2" | "R1" | "R2";

export type IgicTaxBreakdown = {
  ratePercent: number;
  taxableBase: number;
  taxAmount: number;
};

export type IgicRegistroInput = {
  emitterTaxId: string;
  emitterName: string;
  invoiceNumber: string;
  issuedAt: string;
  invoiceType: IgicInvoiceType;
  description: string;
  invoiceTotal: number;
  vatTotal: number;
  breakdowns: IgicTaxBreakdown[];
  previousHash: string | null;
  currentHash: string;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildIgicXml(input: IgicRegistroInput): string {
  const breakdowns = input.breakdowns
    .map((b) => `      <DesgloseIGIC>
        <Tipo>${fmt(b.ratePercent)}</Tipo>
        <BaseImponible>${fmt(b.taxableBase)}</BaseImponible>
        <CuotaIGIC>${fmt(b.taxAmount)}</CuotaIGIC>
      </DesgloseIGIC>`)
    .join("\n");

  const encadenamiento = input.previousHash
    ? `    <Encadenamiento><Huella>${input.previousHash}</Huella></Encadenamiento>`
    : `    <Encadenamiento><PrimerRegistro>S</PrimerRegistro></Encadenamiento>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<RegistroIGIC xmlns="urn:gobcan:atc:igic:facturas:v1">
  <Cabecera>
    <NIFEmisor>${xmlEscape(input.emitterTaxId)}</NIFEmisor>
    <RazonSocial>${xmlEscape(input.emitterName)}</RazonSocial>
  </Cabecera>
  <Factura>
    <NumSerieFactura>${xmlEscape(input.invoiceNumber)}</NumSerieFactura>
    <FechaExpedicion>${fmtDate(input.issuedAt)}</FechaExpedicion>
    <TipoFactura>${input.invoiceType}</TipoFactura>
    <Descripcion>${xmlEscape(input.description)}</Descripcion>
    <ImporteTotal>${fmt(input.invoiceTotal)}</ImporteTotal>
    <CuotaTotalIGIC>${fmt(input.vatTotal)}</CuotaTotalIGIC>
    <Desglose>
${breakdowns}
    </Desglose>
  </Factura>
${encadenamiento}
  <Huella>${input.currentHash}</Huella>
</RegistroIGIC>`;
}

export type IgicSubmissionResponse = {
  status: "accepted" | "rejected" | "network_error";
  endpoint: string;
  csvCode?: string;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: string;
};

const IGIC_ENDPOINTS = {
  sandbox: "stub://igic-mock",
  preproduction: "https://servicios-pruebas.gobiernodecanarias.org/atc/igic/registro-facturas",
  production: "https://servicios.gobiernodecanarias.org/atc/igic/registro-facturas"
};

function pickMode(): "sandbox" | "preproduction" | "production" {
  const raw = process.env.IGIC_MODE;
  if (raw === "production" || raw === "preproduction" || raw === "sandbox") return raw;
  return "sandbox";
}

function generateCsv(emitterTaxId: string, invoiceNumber: string): string {
  return createHash("sha256").update(`igic|${emitterTaxId}|${invoiceNumber}`).digest("hex").toUpperCase().slice(0, 18);
}

export async function submitIgicRegistro(input: {
  invoiceId: string;
  invoiceNumber: string;
  emitterTaxId: string;
  xmlPayload: string;
}): Promise<IgicSubmissionResponse> {
  const mode = pickMode();
  const endpoint = IGIC_ENDPOINTS[mode];

  if (mode === "sandbox") {
    if (!input.xmlPayload.includes("<RegistroIGIC")) {
      return { status: "rejected", endpoint, errorCode: "MALFORMED_XML", errorMessage: "Stub: missing RegistroIGIC root." };
    }
    return {
      status: "accepted",
      endpoint,
      csvCode: generateCsv(input.emitterTaxId, input.invoiceNumber),
      rawResponse: `<ack><Resultado>OK</Resultado><CSV>${generateCsv(input.emitterTaxId, input.invoiceNumber)}</CSV></ack>`
    };
  }

  const certPath = process.env.IGIC_CERT_PATH;
  const certPassphrase = process.env.IGIC_CERT_PASSPHRASE;
  if (!certPath || !certPassphrase) {
    return { status: "rejected", endpoint, errorCode: "CERT_NOT_CONFIGURED", errorMessage: `IGIC mode '${mode}' requires IGIC_CERT_PATH + IGIC_CERT_PASSPHRASE.` };
  }

  try {
    const { readFileSync } = await import("node:fs");
    const { Agent, fetch: undiciFetch } = await import("undici");
    const pfx = readFileSync(certPath);
    const dispatcher = new Agent({ connect: { pfx: [{ buf: pfx, passphrase: certPassphrase }], rejectUnauthorized: true } });
    const response = await undiciFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/xml; charset=utf-8" }, body: input.xmlPayload, dispatcher });
    const text = await response.text();
    if (!response.ok) {
      return { status: "rejected", endpoint, errorCode: `HTTP_${response.status}`, errorMessage: text.slice(0, 500), rawResponse: text };
    }
    const csvMatch = text.match(/<CSV>([^<]+)<\/CSV>/);
    return { status: "accepted", endpoint, csvCode: csvMatch?.[1], rawResponse: text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "network_error", endpoint, errorCode: "NETWORK", errorMessage: message };
  }
}

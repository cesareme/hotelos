import { createHash } from "node:crypto";

// TicketBAI (TBAI) — sistema foral del País Vasco. Cada territorio histórico
// (Bizkaia, Gipuzkoa, Álava) tiene un endpoint distinto pero comparten el mismo
// XSD raíz definido por las Diputaciones Forales. La huella de cadena se
// calcula igual: SHA-256 hex sobre el canonical concat de campos del registro
// + huella anterior.

export type TbaiTerritory = "bizkaia" | "gipuzkoa" | "araba";

export type TbaiInvoiceType = "F1" | "F2" | "R1" | "R2" | "R3" | "R4";

export type TbaiHashInput = {
  emitterTaxId: string;
  invoiceNumber: string;
  issuedAt: string;
  invoiceType: TbaiInvoiceType;
  totalAmount: number;
  previousHash?: string | null;
  previousInvoiceNumber?: string | null;
  previousIssuedAt?: string | null;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function fmtAmount(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function buildTbaiCanonical(input: TbaiHashInput): string {
  // BizkaiBAI / GipuzkoaTicketBAI canonical record string per the regulation
  // (Orden Foral 2021/2 art. 4). Field order is fixed.
  return [
    `IDEmisorFactura=${input.emitterTaxId}`,
    `NumSerieFactura=${input.invoiceNumber}`,
    `FechaExpedicionFactura=${fmtDate(input.issuedAt)}`,
    `HoraExpedicionFactura=${fmtTime(input.issuedAt)}`,
    `TipoFactura=${input.invoiceType}`,
    `ImporteTotalFactura=${fmtAmount(input.totalAmount)}`,
    `HuellaTBAIAnterior=${input.previousHash ?? ""}`
  ].join("|");
}

export function computeTbaiHash(input: TbaiHashInput): { canonical: string; hash: string } {
  const canonical = buildTbaiCanonical(input);
  const hash = createHash("sha256").update(canonical, "utf-8").digest("hex").toUpperCase();
  return { canonical, hash };
}

export type TbaiTaxBreakdown = {
  ratePercent: number;
  taxableBase: number;
  taxAmount: number;
};

export type TbaiXmlInput = TbaiHashInput & {
  emitterName: string;
  description: string;
  vatTotal: number;
  breakdowns: TbaiTaxBreakdown[];
  software: {
    nif: string;
    name: string;
    licenseKey: string;
    developerName: string;
    softwareName: string;
    version: string;
  };
  currentHash: string;
  territory: TbaiTerritory;
};

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildTbaiXml(input: TbaiXmlInput): string {
  const breakdowns = input.breakdowns
    .map(
      (b) => `        <DetalleIVA>
          <BaseImponible>${fmtAmount(b.taxableBase)}</BaseImponible>
          <TipoImpositivo>${fmtAmount(b.ratePercent)}</TipoImpositivo>
          <CuotaImpuesto>${fmtAmount(b.taxAmount)}</CuotaImpuesto>
        </DetalleIVA>`
    )
    .join("\n");

  const encadenamiento = input.previousHash
    ? `    <EncadenamientoFacturaAnterior>
      <SerieFacturaAnterior>${xmlEscape(input.previousInvoiceNumber ?? "")}</SerieFacturaAnterior>
      <NumFacturaAnterior>${xmlEscape(input.previousInvoiceNumber ?? "")}</NumFacturaAnterior>
      <FechaExpedicionFacturaAnterior>${fmtDate(input.previousIssuedAt ?? input.issuedAt)}</FechaExpedicionFacturaAnterior>
      <SignatureValueFirmaFacturaAnterior>${input.previousHash}</SignatureValueFirmaFacturaAnterior>
    </EncadenamientoFacturaAnterior>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<T:TicketBAI xmlns:T="urn:ticketbai:emision">
  <Cabecera>
    <IDVersionTBAI>1.2</IDVersionTBAI>
  </Cabecera>
  <Sujetos>
    <Emisor>
      <NIF>${xmlEscape(input.emitterTaxId)}</NIF>
      <ApellidosNombreRazonSocial>${xmlEscape(input.emitterName)}</ApellidosNombreRazonSocial>
    </Emisor>
  </Sujetos>
  <Factura>
    <CabeceraFactura>
      <SerieFactura>${xmlEscape(input.invoiceNumber)}</SerieFactura>
      <NumFactura>${xmlEscape(input.invoiceNumber)}</NumFactura>
      <FechaExpedicionFactura>${fmtDate(input.issuedAt)}</FechaExpedicionFactura>
      <HoraExpedicionFactura>${fmtTime(input.issuedAt)}</HoraExpedicionFactura>
    </CabeceraFactura>
    <DatosFactura>
      <DescripcionFactura>${xmlEscape(input.description)}</DescripcionFactura>
      <ImporteTotalFactura>${fmtAmount(input.totalAmount)}</ImporteTotalFactura>
    </DatosFactura>
    <TipoDesglose>
      <DesgloseFactura>
        <Sujeta>
          <NoExenta>
            <DetalleNoExenta>
              <TipoNoExenta>S1</TipoNoExenta>
              <DesgloseIVA>
${breakdowns}
              </DesgloseIVA>
            </DetalleNoExenta>
          </NoExenta>
        </Sujeta>
      </DesgloseFactura>
    </TipoDesglose>
  </Factura>
  <HuellaTBAI>
${encadenamiento}
    <Software>
      <LicenciaTBAI>${xmlEscape(input.software.licenseKey)}</LicenciaTBAI>
      <EntidadDesarrolladora>
        <NIF>${xmlEscape(input.software.nif)}</NIF>
        <ApellidosNombreRazonSocial>${xmlEscape(input.software.developerName)}</ApellidosNombreRazonSocial>
      </EntidadDesarrolladora>
      <Nombre>${xmlEscape(input.software.softwareName)}</Nombre>
      <Version>${xmlEscape(input.software.version)}</Version>
    </Software>
    <NumSerieDispositivo>HOTELOS-DEV</NumSerieDispositivo>
  </HuellaTBAI>
</T:TicketBAI>`;
}

export type TbaiSubmissionResponse = {
  status: "accepted" | "accepted_with_errors" | "rejected" | "network_error";
  territory: TbaiTerritory;
  endpoint: string;
  tbaiCode?: string;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: string;
};

const TBAI_ENDPOINTS: Record<TbaiTerritory, { sandbox: string; production: string }> = {
  bizkaia: {
    sandbox: "stub://tbai-bizkaia",
    production: "https://sarrerak.bizkaia.eus/N3B4000M/aurkezpena"
  },
  gipuzkoa: {
    sandbox: "stub://tbai-gipuzkoa",
    production: "https://tbai-z.egoitza.gipuzkoa.eus/sarrerak/alta"
  },
  araba: {
    sandbox: "stub://tbai-araba",
    production: "https://ticketbai.araba.eus/TicketBAI/v1/facturas"
  }
};

function generateTbaiCode(emitterTaxId: string, invoiceNumber: string): string {
  const hex = createHash("sha256").update(`tbai|${emitterTaxId}|${invoiceNumber}`).digest("hex").toUpperCase();
  return `TBAI-${emitterTaxId}-${hex.slice(0, 8)}-${hex.slice(8, 13)}`;
}

export async function submitTbaiRegistro(input: {
  territory: TbaiTerritory;
  invoiceNumber: string;
  emitterTaxId: string;
  xmlPayload: string;
}): Promise<TbaiSubmissionResponse> {
  const mode = process.env.TBAI_MODE === "production" ? "production" : "sandbox";
  const endpoint = TBAI_ENDPOINTS[input.territory][mode];

  if (mode === "sandbox") {
    if (!input.xmlPayload.includes("<T:TicketBAI")) {
      return { status: "rejected", territory: input.territory, endpoint, errorCode: "MALFORMED_XML", errorMessage: "Stub: XML root TicketBAI missing." };
    }
    return {
      status: "accepted",
      territory: input.territory,
      endpoint,
      tbaiCode: generateTbaiCode(input.emitterTaxId, input.invoiceNumber),
      rawResponse: `<ack><Estado>00</Estado><CodigoTBAI>${generateTbaiCode(input.emitterTaxId, input.invoiceNumber)}</CodigoTBAI></ack>`
    };
  }

  const certPath = process.env.TBAI_CERT_PATH;
  const certPassphrase = process.env.TBAI_CERT_PASSPHRASE;
  if (!certPath || !certPassphrase) {
    return { status: "rejected", territory: input.territory, endpoint, errorCode: "CERT_NOT_CONFIGURED", errorMessage: "TBAI_CERT_PATH / TBAI_CERT_PASSPHRASE required for production." };
  }

  try {
    const { readFileSync } = await import("node:fs");
    const { Agent, fetch: undiciFetch } = await import("undici");
    const pfx = readFileSync(certPath);
    const dispatcher = new Agent({ connect: { pfx: [{ buf: pfx, passphrase: certPassphrase }], rejectUnauthorized: true } });
    const response = await undiciFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/xml; charset=utf-8" },
      body: input.xmlPayload,
      dispatcher
    });
    const text = await response.text();
    if (!response.ok) {
      return { status: "rejected", territory: input.territory, endpoint, errorCode: `HTTP_${response.status}`, errorMessage: text.slice(0, 500), rawResponse: text };
    }
    const codeMatch = text.match(/<CodigoTBAI>([^<]+)<\/CodigoTBAI>/);
    return { status: "accepted", territory: input.territory, endpoint, tbaiCode: codeMatch?.[1], rawResponse: text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "network_error", territory: input.territory, endpoint, errorCode: "NETWORK", errorMessage: message };
  }
}

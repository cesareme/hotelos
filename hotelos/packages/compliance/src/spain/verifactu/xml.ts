import { formatVerifactuAmount, formatVerifactuDate, formatVerifactuTimestamp, type VerifactuInvoiceType } from "./hash.js";
import type { VerifactuSoftwareBlock } from "./software.js";

// VeriFactu registros (RegistroAlta / RegistroAnulacion) per RD 1007/2023 and
// Orden HAC/1177/2024, serialised against SuministroLR.xsd /
// SuministroInformacion.xsd. The output is the exact document whose fields
// AEAT re-hashes, so every value that enters the huella (IDFactura, TipoFactura,
// CuotaTotal, ImporteTotal, Encadenamiento/Huella, FechaHoraHusoGenRegistro)
// must be rendered with the same formatters as hash.ts.
//
// Estructura societaria (Tanda 6b · L3): the obligado is the SOCIEDAD —
// `emitterTaxId` / `emitterName` are the LegalEntity's NIF and razón social
// (ObligadoEmision, IDEmisorFactura, NombreRazonEmisor); the establishment
// (centro de trabajo) has no element in the registro, it only appears on the
// PDF. `software.numeroInstalacion` is the declared VerifactuInstallation of
// the chain (one per billing centre with `per_center`, one per sociedad with
// `per_entity`), and `RegistroAnterior` is the previous record of THAT
// installation; `IndicadorMultiplesOT = S` states that the installation
// serves several obligados (SaaS). The chain never restarts by year or series.

// Local aliases of contract A's types (packages/compliance/src/spain/
// indirect-tax.ts). Kept private so the package's `export *` never sees the
// same name from two modules.
type TaxFigure = "IVA" | "IGIC" | "IPSI";
type VerifactuImpuesto = "01" | "02" | "03";
type Calificacion = "S1" | "N1";

/**
 * One <DetalleDesglose> group — the shape persisted in Invoice.taxBreakdownJson
 * (contract B: computeInvoiceTotals().breakdown). `base` is
 * BaseImponibleOimporteNoSujeto and `quota` CuotaRepercutida (0 for N1).
 */
export type VerifactuDesgloseGroup = {
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  calificacion: Calificacion;
  ratePercent: number;
  base: number;
  quota: number;
};

/** @deprecated name kept for older imports; identical to VerifactuDesgloseGroup. */
export type VerifactuLineBreakdown = VerifactuDesgloseGroup;

// AEAT TipoRectificativa values: "I" = por diferencias (deltas), "S" = sustitución
// (full replacement; ImporteRectificacion with the ORIGINAL's base/quota is mandatory).
export type VerifactuTipoRectificativa = "S" | "I";

export type VerifactuRectifiedInvoiceRef = {
  invoiceNumber: string;
  issueDate: string;
  emitterTaxId: string;
};

export type VerifactuImporteRectificacion = {
  baseRectificada: number;
  cuotaRectificada: number;
  cuotaRecargoRectificado?: number;
};

export type VerifactuRectificationInput = {
  type: VerifactuTipoRectificativa;
  rectifiedInvoices: VerifactuRectifiedInvoiceRef[];
  /** Required when type === "S" (the XSD makes ImporteRectificacion mandatory for sustitución). */
  importeRectificacion?: VerifactuImporteRectificacion;
};

export type VerifactuRecipient = {
  /** Destinatarios/NombreRazon: the recipient's name or legal name — never the NIF (see assertVerifactuRecipient). */
  name: string;
  taxId: string;
};

export type VerifactuPreviousRecord = {
  /** IDEmisorFactura of the previous record: the NIF snapshot IT was generated with, not the current issuer. */
  emitterTaxId: string;
  invoiceNumber: string;
  issuedAt: string;
  hash: string;
};

export type VerifactuRegistroInput = {
  emitterTaxId: string;
  emitterName: string;
  invoiceNumber: string;
  issuedAt: string;
  invoiceType: VerifactuInvoiceType;
  description: string;
  invoiceTotal: number;
  /** CuotaTotal as hashed; must equal Σ quota of the S1 groups (see sumDesgloseQuotas). */
  vatTotal: number;
  breakdowns: VerifactuDesgloseGroup[];
  previousHash: string | null;
  previousInvoiceNumber?: string | null;
  previousIssuedAt?: string | null;
  /** NIF snapshot of the previous record; defaults to emitterTaxId (legacy callers). */
  previousEmitterTaxId?: string | null;
  currentHash: string;
  rectification?: VerifactuRectificationInput;
  /** Destinatarios/IDDestinatario — mandatory for F1 (and R* rectifying an F1) when the customer is identified. */
  recipient?: VerifactuRecipient | null;
  software: VerifactuSoftwareBlock;
};

export type VerifactuAnulacionInput = {
  /** IDEmisorFacturaAnulada — NIF snapshot the cancelled invoice was issued with. */
  emitterTaxId: string;
  emitterName: string;
  invoiceNumber: string;
  issuedAt: string;
  previous: VerifactuPreviousRecord | null;
  currentHash: string;
  /** FechaHoraHusoGenRegistro of the anulación (the instant the record was generated). */
  generatedAt: string;
  software: VerifactuSoftwareBlock;
};

export const VERIFACTU_XML_NAMESPACES = Object.freeze({
  sum: "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd",
  sum1: "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"
});

function isRectifyingType(type: VerifactuInvoiceType): boolean {
  return type === "R1" || type === "R2" || type === "R3" || type === "R4" || type === "R5";
}

const fmtDate = formatVerifactuDate;
const fmtIsoMadrid = formatVerifactuTimestamp;
const fmt = formatVerifactuAmount;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function alphanumeric(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Destinatarios/NombreRazon must be the recipient's name or legal name. An
 * empty value or the NIF itself is never a name (AEAT validates the field
 * and it would fabricate recipient data), so the builder refuses it instead
 * of shipping the registro. Callers without a name omit the block.
 */
export function assertVerifactuRecipient(recipient: VerifactuRecipient): void {
  const name = recipient.name.trim();
  if (name.length === 0 || alphanumeric(name) === alphanumeric(recipient.taxId)) {
    throw new Error(
      "VeriFactu: Destinatarios/NombreRazon requiere el nombre o razón social del destinatario; no puede ir vacío ni ser el NIF."
    );
  }
}

/** Σ CuotaRepercutida of the S1 groups — what CuotaTotal must equal. */
export function sumDesgloseQuotas(groups: readonly VerifactuDesgloseGroup[]): number {
  const cents = groups.reduce((acc, g) => (g.calificacion === "S1" ? acc + Math.round(g.quota * 100) : acc), 0);
  return cents / 100;
}

function renderDesglose(groups: readonly VerifactuDesgloseGroup[]): string {
  return groups
    .map((g) => {
      // ClaveRegimen (L8A for IVA, L8B for IGIC) only exists for Impuesto 01/03;
      // IPSI (02) and "otros" carry no regime key in the XSD.
      const claveRegimen = g.impuesto === "01" || g.impuesto === "03" ? `\n        <sum1:ClaveRegimen>01</sum1:ClaveRegimen>` : "";
      if (g.calificacion === "N1") {
        return `      <sum1:DetalleDesglose>
        <sum1:Impuesto>${g.impuesto}</sum1:Impuesto>${claveRegimen}
        <sum1:CalificacionOperacion>N1</sum1:CalificacionOperacion>
        <sum1:BaseImponibleOimporteNoSujeto>${fmt(g.base)}</sum1:BaseImponibleOimporteNoSujeto>
      </sum1:DetalleDesglose>`;
      }
      return `      <sum1:DetalleDesglose>
        <sum1:Impuesto>${g.impuesto}</sum1:Impuesto>${claveRegimen}
        <sum1:CalificacionOperacion>S1</sum1:CalificacionOperacion>
        <sum1:TipoImpositivo>${fmt(g.ratePercent)}</sum1:TipoImpositivo>
        <sum1:BaseImponibleOimporteNoSujeto>${fmt(g.base)}</sum1:BaseImponibleOimporteNoSujeto>
        <sum1:CuotaRepercutida>${fmt(g.quota)}</sum1:CuotaRepercutida>
      </sum1:DetalleDesglose>`;
    })
    .join("\n");
}

function renderSistemaInformatico(software: VerifactuSoftwareBlock): string {
  return `      <sum1:SistemaInformatico>
        <sum1:NombreRazon>${xmlEscape(software.nombreRazon)}</sum1:NombreRazon>
        <sum1:NIF>${xmlEscape(software.nif)}</sum1:NIF>
        <sum1:NombreSistemaInformatico>${xmlEscape(software.nombreSistema)}</sum1:NombreSistemaInformatico>
        <sum1:IdSistemaInformatico>${xmlEscape(software.idSistema)}</sum1:IdSistemaInformatico>
        <sum1:Version>${xmlEscape(software.version)}</sum1:Version>
        <sum1:NumeroInstalacion>${xmlEscape(software.numeroInstalacion)}</sum1:NumeroInstalacion>
        <sum1:TipoUsoPosibleSoloVerifactu>${software.tipoUsoPosibleSoloVerifactu}</sum1:TipoUsoPosibleSoloVerifactu>
        <sum1:TipoUsoPosibleMultiOT>${software.tipoUsoPosibleMultiOT}</sum1:TipoUsoPosibleMultiOT>
        <sum1:IndicadorMultiplesOT>${software.indicadorMultiplesOT}</sum1:IndicadorMultiplesOT>
      </sum1:SistemaInformatico>`;
}

function renderEncadenamiento(previous: VerifactuPreviousRecord | null): string {
  if (!previous) {
    return `      <sum1:Encadenamiento>
        <sum1:PrimerRegistro>S</sum1:PrimerRegistro>
      </sum1:Encadenamiento>`;
  }
  return `      <sum1:Encadenamiento>
        <sum1:RegistroAnterior>
          <sum1:IDEmisorFactura>${xmlEscape(previous.emitterTaxId)}</sum1:IDEmisorFactura>
          <sum1:NumSerieFactura>${xmlEscape(previous.invoiceNumber)}</sum1:NumSerieFactura>
          <sum1:FechaExpedicionFactura>${fmtDate(previous.issuedAt)}</sum1:FechaExpedicionFactura>
          <sum1:Huella>${previous.hash}</sum1:Huella>
        </sum1:RegistroAnterior>
      </sum1:Encadenamiento>`;
}

function renderEnvelope(emitterName: string, emitterTaxId: string, registro: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sum:RegFactuSistemaFacturacion
  xmlns:sum="${VERIFACTU_XML_NAMESPACES.sum}"
  xmlns:sum1="${VERIFACTU_XML_NAMESPACES.sum1}">
  <sum:Cabecera>
    <sum1:ObligadoEmision>
      <sum1:NombreRazon>${xmlEscape(emitterName)}</sum1:NombreRazon>
      <sum1:NIF>${xmlEscape(emitterTaxId)}</sum1:NIF>
    </sum1:ObligadoEmision>
  </sum:Cabecera>
  <sum:RegistroFactura>
${registro}
  </sum:RegistroFactura>
</sum:RegFactuSistemaFacturacion>`;
}

export function buildVerifactuRegistroAlta(input: VerifactuRegistroInput): string {
  const breakdowns = renderDesglose(input.breakdowns);

  // Rectificativa blocks (R1-R5 only; silently skipped otherwise so callers may
  // pass `rectification` unconditionally). Schema order: TipoFactura →
  // TipoRectificativa → FacturasRectificadas → ImporteRectificacion →
  // DescripcionOperacion. ImporteRectificacion is mandatory for "S"
  // (sustitución: base/cuota of the ORIGINAL invoice) and must be absent for
  // "I" (por diferencias: the registro's own amounts are the deltas).
  let rectificativaBlocks = "";
  if (input.rectification && isRectifyingType(input.invoiceType)) {
    const facturasRectificadas = input.rectification.rectifiedInvoices
      .map(
        (ref) => `        <sum1:IDFacturaRectificada>
          <sum1:IDEmisorFactura>${xmlEscape(ref.emitterTaxId)}</sum1:IDEmisorFactura>
          <sum1:NumSerieFactura>${xmlEscape(ref.invoiceNumber)}</sum1:NumSerieFactura>
          <sum1:FechaExpedicionFactura>${fmtDate(ref.issueDate)}</sum1:FechaExpedicionFactura>
        </sum1:IDFacturaRectificada>`
      )
      .join("\n");

    const tipoBlock = `      <sum1:TipoRectificativa>${input.rectification.type}</sum1:TipoRectificativa>`;
    const facturasBlock = `      <sum1:FacturasRectificadas>
${facturasRectificadas}
      </sum1:FacturasRectificadas>`;

    let importeBlock = "";
    if (input.rectification.type === "S") {
      const ir = input.rectification.importeRectificacion;
      if (!ir) {
        throw new Error("VeriFactu: TipoRectificativa 'S' requires importeRectificacion (BaseRectificada/CuotaRectificada of the original invoice).");
      }
      const recargoLine =
        ir.cuotaRecargoRectificado !== undefined
          ? `\n        <sum1:CuotaRecargoRectificado>${fmt(ir.cuotaRecargoRectificado)}</sum1:CuotaRecargoRectificado>`
          : "";
      importeBlock = `\n      <sum1:ImporteRectificacion>
        <sum1:BaseRectificada>${fmt(ir.baseRectificada)}</sum1:BaseRectificada>
        <sum1:CuotaRectificada>${fmt(ir.cuotaRectificada)}</sum1:CuotaRectificada>${recargoLine}
      </sum1:ImporteRectificacion>`;
    }

    rectificativaBlocks = `\n${tipoBlock}\n${facturasBlock}${importeBlock}`;
  }

  // Destinatarios: identified recipient (F1 / R* of an F1). Simplified
  // invoices (F2) have no recipient block by definition. The name is the
  // recipient's own (Invoice.customerName snapshot); the NIF never stands in.
  const recipient = input.recipient && input.invoiceType !== "F2" ? input.recipient : null;
  if (recipient) assertVerifactuRecipient(recipient);
  const destinatariosBlock = recipient
    ? `\n      <sum1:Destinatarios>
        <sum1:IDDestinatario>
          <sum1:NombreRazon>${xmlEscape(recipient.name)}</sum1:NombreRazon>
          <sum1:NIF>${xmlEscape(recipient.taxId)}</sum1:NIF>
        </sum1:IDDestinatario>
      </sum1:Destinatarios>`
    : "";

  const previous: VerifactuPreviousRecord | null = input.previousHash
    ? {
        emitterTaxId: input.previousEmitterTaxId ?? input.emitterTaxId,
        invoiceNumber: input.previousInvoiceNumber ?? "",
        issuedAt: input.previousIssuedAt ?? input.issuedAt,
        hash: input.previousHash
      }
    : null;

  const registro = `    <sum1:RegistroAlta>
      <sum1:IDVersion>1.0</sum1:IDVersion>
      <sum1:IDFactura>
        <sum1:IDEmisorFactura>${xmlEscape(input.emitterTaxId)}</sum1:IDEmisorFactura>
        <sum1:NumSerieFactura>${xmlEscape(input.invoiceNumber)}</sum1:NumSerieFactura>
        <sum1:FechaExpedicionFactura>${fmtDate(input.issuedAt)}</sum1:FechaExpedicionFactura>
      </sum1:IDFactura>
      <sum1:NombreRazonEmisor>${xmlEscape(input.emitterName)}</sum1:NombreRazonEmisor>
      <sum1:TipoFactura>${input.invoiceType}</sum1:TipoFactura>${rectificativaBlocks}
      <sum1:DescripcionOperacion>${xmlEscape(input.description)}</sum1:DescripcionOperacion>${destinatariosBlock}
      <sum1:Desglose>
${breakdowns}
      </sum1:Desglose>
      <sum1:CuotaTotal>${fmt(input.vatTotal)}</sum1:CuotaTotal>
      <sum1:ImporteTotal>${fmt(input.invoiceTotal)}</sum1:ImporteTotal>
${renderEncadenamiento(previous)}
${renderSistemaInformatico(input.software)}
      <sum1:FechaHoraHusoGenRegistro>${fmtIsoMadrid(input.issuedAt)}</sum1:FechaHoraHusoGenRegistro>
      <sum1:TipoHuella>01</sum1:TipoHuella>
      <sum1:Huella>${input.currentHash}</sum1:Huella>
    </sum1:RegistroAlta>`;

  return renderEnvelope(input.emitterName, input.emitterTaxId, registro);
}

/**
 * RegistroAnulacion (contract E): cancels a registro already sent to AEAT.
 * Chained like an alta (Encadenamiento over the previous record of the
 * obligado, whatever its kind) and hashed with computeVerifactuAnulacionHash.
 */
export function buildVerifactuRegistroAnulacion(input: VerifactuAnulacionInput): string {
  const registro = `    <sum1:RegistroAnulacion>
      <sum1:IDVersion>1.0</sum1:IDVersion>
      <sum1:IDFactura>
        <sum1:IDEmisorFacturaAnulada>${xmlEscape(input.emitterTaxId)}</sum1:IDEmisorFacturaAnulada>
        <sum1:NumSerieFacturaAnulada>${xmlEscape(input.invoiceNumber)}</sum1:NumSerieFacturaAnulada>
        <sum1:FechaExpedicionFacturaAnulada>${fmtDate(input.issuedAt)}</sum1:FechaExpedicionFacturaAnulada>
      </sum1:IDFactura>
${renderEncadenamiento(input.previous)}
${renderSistemaInformatico(input.software)}
      <sum1:FechaHoraHusoGenRegistro>${fmtIsoMadrid(input.generatedAt)}</sum1:FechaHoraHusoGenRegistro>
      <sum1:TipoHuella>01</sum1:TipoHuella>
      <sum1:Huella>${input.currentHash}</sum1:Huella>
    </sum1:RegistroAnulacion>`;

  return renderEnvelope(input.emitterName, input.emitterTaxId, registro);
}

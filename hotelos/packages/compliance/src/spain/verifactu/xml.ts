import type { VerifactuInvoiceType } from "./hash.js";

// Build a VeriFactu RegistroAlta XML envelope per RD 1007/2023 and the
// technical resolution (Sistemas de Facturación). This is the canonical
// document submitted to AEAT. Real submission requires X.509 signature, but
// the envelope content here matches the official schema and is byte-stable
// for downstream signing.

export type VerifactuLineBreakdown = {
  taxCode: string;
  ratePercent: number;
  taxableBase: number;
  taxAmount: number;
};

// AEAT TipoRectificativa values: "S" = sustitución (substitution), "I" = por diferencias.
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
  importeRectificacion?: VerifactuImporteRectificacion;
};

export type VerifactuRegistroInput = {
  emitterTaxId: string;
  emitterName: string;
  invoiceNumber: string;
  issuedAt: string;
  invoiceType: VerifactuInvoiceType;
  description: string;
  invoiceTotal: number;
  vatTotal: number;
  breakdowns: VerifactuLineBreakdown[];
  previousHash: string | null;
  previousInvoiceNumber?: string | null;
  previousIssuedAt?: string | null;
  currentHash: string;
  rectification?: VerifactuRectificationInput;
  software: {
    nif: string;
    name: string;
    id: string;
    version: string;
    installNumber: string;
  };
};

function isRectifyingType(type: VerifactuInvoiceType): boolean {
  return type === "R1" || type === "R2" || type === "R3" || type === "R4" || type === "R5";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function fmtIsoMadrid(iso: string): string {
  const d = new Date(iso);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dst = month > 3 && month < 10 ? true : month === 3 ? day >= 29 : month === 10 ? day <= 25 : false;
  const offsetMinutes = dst ? 120 : 60;
  const adjusted = new Date(d.getTime() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${adjusted.getUTCFullYear()}-${pad(adjusted.getUTCMonth() + 1)}-${pad(adjusted.getUTCDate())}T${pad(adjusted.getUTCHours())}:${pad(adjusted.getUTCMinutes())}:${pad(adjusted.getUTCSeconds())}${offsetMinutes >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
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

export function buildVerifactuRegistroAlta(input: VerifactuRegistroInput): string {
  const breakdowns = input.breakdowns
    .map(
      (b) => `      <sum1:DetalleDesglose>
        <sum1:Impuesto>01</sum1:Impuesto>
        <sum1:ClaveRegimen>01</sum1:ClaveRegimen>
        <sum1:CalificacionOperacion>S1</sum1:CalificacionOperacion>
        <sum1:TipoImpositivo>${fmt(b.ratePercent)}</sum1:TipoImpositivo>
        <sum1:BaseImponibleOimporteNoSujeto>${fmt(b.taxableBase)}</sum1:BaseImponibleOimporteNoSujeto>
        <sum1:CuotaRepercutida>${fmt(b.taxAmount)}</sum1:CuotaRepercutida>
      </sum1:DetalleDesglose>`
    )
    .join("\n");

  // Build optional rectificativa blocks. AEAT requires these only for R1-R5
  // invoice types; the builder silently skips them if the invoice type is not
  // rectifying, so callers may unconditionally pass `rectification` for clarity.
  let rectificativaBlocks = "";
  if (input.rectification && isRectifyingType(input.invoiceType)) {
    const facturasRectificadas = input.rectification.rectifiedInvoices
      .map(
        (ref) => `        <sum1:IDFacturaAnterior>
          <sum1:IDEmisorFactura>${xmlEscape(ref.emitterTaxId)}</sum1:IDEmisorFactura>
          <sum1:NumSerieFactura>${xmlEscape(ref.invoiceNumber)}</sum1:NumSerieFactura>
          <sum1:FechaExpedicion>${fmtDate(ref.issueDate)}</sum1:FechaExpedicion>
        </sum1:IDFacturaAnterior>`
      )
      .join("\n");

    const tipoBlock = `      <sum1:TipoRectificativa>${input.rectification.type}</sum1:TipoRectificativa>`;
    const facturasBlock = `      <sum1:FacturasRectificadas>
${facturasRectificadas}
      </sum1:FacturasRectificadas>`;

    let importeBlock = "";
    if (input.rectification.type === "I" && input.rectification.importeRectificacion) {
      const ir = input.rectification.importeRectificacion;
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

  const encadenamiento = input.previousHash
    ? `    <sum1:Encadenamiento>
      <sum1:RegistroAnterior>
        <sum1:IDEmisorFactura>${xmlEscape(input.emitterTaxId)}</sum1:IDEmisorFactura>
        <sum1:NumSerieFactura>${xmlEscape(input.previousInvoiceNumber ?? "")}</sum1:NumSerieFactura>
        <sum1:FechaExpedicionFactura>${fmtDate(input.previousIssuedAt ?? input.issuedAt)}</sum1:FechaExpedicionFactura>
        <sum1:Huella>${input.previousHash}</sum1:Huella>
      </sum1:RegistroAnterior>
    </sum1:Encadenamiento>`
    : `    <sum1:Encadenamiento>
      <sum1:PrimerRegistro>S</sum1:PrimerRegistro>
    </sum1:Encadenamiento>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<sum:RegFactuSistemaFacturacion
  xmlns:sum="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd"
  xmlns:sum1="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd">
  <sum:Cabecera>
    <sum1:ObligadoEmision>
      <sum1:NombreRazon>${xmlEscape(input.emitterName)}</sum1:NombreRazon>
      <sum1:NIF>${xmlEscape(input.emitterTaxId)}</sum1:NIF>
    </sum1:ObligadoEmision>
  </sum:Cabecera>
  <sum:RegistroFactura>
    <sum1:RegistroAlta>
      <sum1:IDVersion>1.0</sum1:IDVersion>
      <sum1:IDFactura>
        <sum1:IDEmisorFactura>${xmlEscape(input.emitterTaxId)}</sum1:IDEmisorFactura>
        <sum1:NumSerieFactura>${xmlEscape(input.invoiceNumber)}</sum1:NumSerieFactura>
        <sum1:FechaExpedicionFactura>${fmtDate(input.issuedAt)}</sum1:FechaExpedicionFactura>
      </sum1:IDFactura>
      <sum1:NombreRazonEmisor>${xmlEscape(input.emitterName)}</sum1:NombreRazonEmisor>
      <sum1:TipoFactura>${input.invoiceType}</sum1:TipoFactura>${rectificativaBlocks}
      <sum1:DescripcionOperacion>${xmlEscape(input.description)}</sum1:DescripcionOperacion>
      <sum1:Desglose>
${breakdowns}
      </sum1:Desglose>
      <sum1:CuotaTotal>${fmt(input.vatTotal)}</sum1:CuotaTotal>
      <sum1:ImporteTotal>${fmt(input.invoiceTotal)}</sum1:ImporteTotal>
${encadenamiento}
      <sum1:SistemaInformatico>
        <sum1:NombreRazon>${xmlEscape(input.software.name)}</sum1:NombreRazon>
        <sum1:NIF>${xmlEscape(input.software.nif)}</sum1:NIF>
        <sum1:NombreSistemaInformatico>${xmlEscape(input.software.name)}</sum1:NombreSistemaInformatico>
        <sum1:IdSistemaInformatico>${xmlEscape(input.software.id)}</sum1:IdSistemaInformatico>
        <sum1:Version>${xmlEscape(input.software.version)}</sum1:Version>
        <sum1:NumeroInstalacion>${xmlEscape(input.software.installNumber)}</sum1:NumeroInstalacion>
        <sum1:TipoUsoPosibleSoloVerifactu>S</sum1:TipoUsoPosibleSoloVerifactu>
        <sum1:TipoUsoPosibleMultiOT>N</sum1:TipoUsoPosibleMultiOT>
        <sum1:IndicadorMultiplesOT>N</sum1:IndicadorMultiplesOT>
      </sum1:SistemaInformatico>
      <sum1:FechaHoraHusoGenRegistro>${fmtIsoMadrid(input.issuedAt)}</sum1:FechaHoraHusoGenRegistro>
      <sum1:TipoHuella>01</sum1:TipoHuella>
      <sum1:Huella>${input.currentHash}</sum1:Huella>
    </sum1:RegistroAlta>
  </sum:RegistroFactura>
</sum:RegFactuSistemaFacturacion>`;
}

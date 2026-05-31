// SES.HOSPEDAJES — Comunicaciones de Hospedaje al Ministerio del Interior
// per Real Decreto 933/2021 and the technical resolution of 2022. The schema
// (ses-hospedajes-v1.xsd) is published by the Sede Electrónica del MIR.
// This builder produces a canonical XML envelope matching the field order
// expected by the official submission endpoint. Production submission
// requires a qualified electronic certificate registered with the MIR.

export type SesContractType = "alquiler" | "alojamiento";
export type SesPaymentMethod = "card" | "cash" | "bank_transfer" | "platform" | "other";

export type SesGuest = {
  documentType: "DNI" | "NIE" | "PASSPORT" | "TIE";
  documentNumber: string;
  documentSupportNumber?: string;
  firstName: string;
  surname1: string;
  surname2?: string;
  dateOfBirth: string;
  nationality: string;
  gender?: "M" | "F" | "X";
  phone?: string;
  email?: string;
  residenceAddress?: string;
  residenceMunicipality?: string;
  residenceProvince?: string;
  residenceCountry?: string;
  residencePostalCode?: string;
  isMinor?: boolean;
  parentDocumentNumber?: string;
  parentName?: string;
  relationshipToMinor?: string;
};

export type SesEstablishment = {
  taxId: string;
  legalName: string;
  registryNumber: string;
  registryType: "establecimiento_turistico" | "vivienda_uso_turistico";
  address: string;
  municipalityCode: string;
  province: string;
  postalCode: string;
  country: string;
};

export type SesContract = {
  contractRef: string;
  contractDate: string;
  checkinDate: string;
  checkoutDate: string;
  contractType: SesContractType;
  numberOfPersons: number;
  paymentMethod: SesPaymentMethod;
  paymentReference?: string;
  totalAmount: number;
  internetAccess?: boolean;
};

export type SesSubmissionRecord = {
  establishment: SesEstablishment;
  contract: SesContract;
  guests: SesGuest[];
  submissionType: "alta" | "modificacion" | "baja";
  externalReference: string;
};

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmtDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function fmtAmount(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function buildPersonaBlock(guest: SesGuest, idx: number): string {
  const tipoDoc = guest.documentType === "DNI" ? "1" : guest.documentType === "NIE" ? "2" : guest.documentType === "PASSPORT" ? "3" : "4";
  const sexo = guest.gender === "M" ? "1" : guest.gender === "F" ? "2" : "0";
  return `      <Persona>
        <Rol>${idx === 0 ? "TI" : "VI"}</Rol>
        <Nombre>${xmlEscape(guest.firstName)}</Nombre>
        <ApellidoPrimero>${xmlEscape(guest.surname1)}</ApellidoPrimero>
${guest.surname2 ? `        <ApellidoSegundo>${xmlEscape(guest.surname2)}</ApellidoSegundo>\n` : ""}        <TipoDocumento>${tipoDoc}</TipoDocumento>
        <NumeroDocumento>${xmlEscape(guest.documentNumber)}</NumeroDocumento>
${guest.documentSupportNumber ? `        <NumeroSoporte>${xmlEscape(guest.documentSupportNumber)}</NumeroSoporte>\n` : ""}        <FechaNacimiento>${fmtDate(guest.dateOfBirth)}</FechaNacimiento>
        <Sexo>${sexo}</Sexo>
        <Nacionalidad>${xmlEscape(guest.nationality)}</Nacionalidad>
${guest.phone ? `        <Telefono>${xmlEscape(guest.phone)}</Telefono>\n` : ""}${guest.email ? `        <Correo>${xmlEscape(guest.email)}</Correo>\n` : ""}${guest.residenceAddress ? `        <DireccionDomicilio>${xmlEscape(guest.residenceAddress)}</DireccionDomicilio>\n` : ""}${guest.residenceMunicipality ? `        <MunicipioDomicilio>${xmlEscape(guest.residenceMunicipality)}</MunicipioDomicilio>\n` : ""}${guest.residenceProvince ? `        <ProvinciaDomicilio>${xmlEscape(guest.residenceProvince)}</ProvinciaDomicilio>\n` : ""}${guest.residencePostalCode ? `        <CodigoPostalDomicilio>${xmlEscape(guest.residencePostalCode)}</CodigoPostalDomicilio>\n` : ""}${guest.residenceCountry ? `        <PaisDomicilio>${xmlEscape(guest.residenceCountry)}</PaisDomicilio>\n` : ""}${guest.isMinor ? `        <Menor>S</Menor>\n        <ParentescoMenor>${xmlEscape(guest.relationshipToMinor ?? "")}</ParentescoMenor>\n        <NombreParentesco>${xmlEscape(guest.parentName ?? "")}</NombreParentesco>\n        <DocumentoParentesco>${xmlEscape(guest.parentDocumentNumber ?? "")}</DocumentoParentesco>\n` : ""}      </Persona>`;
}

export function buildSesHospedajesXml(record: SesSubmissionRecord): string {
  const paymentCode = {
    card: "T",
    cash: "EF",
    bank_transfer: "TR",
    platform: "PL",
    other: "OT"
  }[record.contract.paymentMethod];

  const contractTypeCode = record.contract.contractType === "alquiler" ? "AL" : "AH";

  const personas = record.guests.map(buildPersonaBlock).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ses:ComunicacionParte xmlns:ses="https://sede.mir.gob.es/ses/hospedajes/v1">
  <ses:Cabecera>
    <ses:TipoComunicacion>${record.submissionType === "alta" ? "A" : record.submissionType === "modificacion" ? "M" : "B"}</ses:TipoComunicacion>
    <ses:ReferenciaExterna>${xmlEscape(record.externalReference)}</ses:ReferenciaExterna>
    <ses:FechaComunicacion>${new Date().toISOString()}</ses:FechaComunicacion>
  </ses:Cabecera>
  <ses:Establecimiento>
    <ses:NIF>${xmlEscape(record.establishment.taxId)}</ses:NIF>
    <ses:RazonSocial>${xmlEscape(record.establishment.legalName)}</ses:RazonSocial>
    <ses:NumeroRegistro>${xmlEscape(record.establishment.registryNumber)}</ses:NumeroRegistro>
    <ses:TipoRegistro>${record.establishment.registryType === "establecimiento_turistico" ? "ET" : "VUT"}</ses:TipoRegistro>
    <ses:Direccion>${xmlEscape(record.establishment.address)}</ses:Direccion>
    <ses:CodigoMunicipio>${xmlEscape(record.establishment.municipalityCode)}</ses:CodigoMunicipio>
    <ses:Provincia>${xmlEscape(record.establishment.province)}</ses:Provincia>
    <ses:CodigoPostal>${xmlEscape(record.establishment.postalCode)}</ses:CodigoPostal>
    <ses:Pais>${xmlEscape(record.establishment.country)}</ses:Pais>
  </ses:Establecimiento>
  <ses:Contrato>
    <ses:Referencia>${xmlEscape(record.contract.contractRef)}</ses:Referencia>
    <ses:FechaContrato>${fmtDate(record.contract.contractDate)}</ses:FechaContrato>
    <ses:TipoContrato>${contractTypeCode}</ses:TipoContrato>
    <ses:FechaEntrada>${fmtDate(record.contract.checkinDate)}</ses:FechaEntrada>
    <ses:FechaSalida>${fmtDate(record.contract.checkoutDate)}</ses:FechaSalida>
    <ses:NumPersonas>${record.contract.numberOfPersons}</ses:NumPersonas>
    <ses:MedioPago>${paymentCode}</ses:MedioPago>
${record.contract.paymentReference ? `    <ses:ReferenciaPago>${xmlEscape(record.contract.paymentReference)}</ses:ReferenciaPago>\n` : ""}    <ses:ImporteTotal>${fmtAmount(record.contract.totalAmount)}</ses:ImporteTotal>
${typeof record.contract.internetAccess === "boolean" ? `    <ses:AccesoInternet>${record.contract.internetAccess ? "S" : "N"}</ses:AccesoInternet>\n` : ""}  </ses:Contrato>
  <ses:Personas>
${personas}
  </ses:Personas>
</ses:ComunicacionParte>`;
}

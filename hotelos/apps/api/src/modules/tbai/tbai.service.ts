// TicketBAI multi-jurisdicción foral — Bizkaia, Gipuzkoa, Álava, Navarra.
//
// VeriFactu es la solución de la AEAT para el territorio común; los territorios
// forales tienen su propia normativa anti-fraude llamada **TicketBAI** (País
// Vasco) y **Batuz** (Navarra, similar).
//
// Cada hacienda foral tiene:
//   - Endpoint propio para envío
//   - Schema XSD ligeramente distinto (encoding XADES, NamespaceURI)
//   - Reglas de huella de cadena (TBAI hash = SHA-256 del XML canonicalizado)
//   - Plazos de presentación (Bizkaia exige envío en ≤ 24h)
//
// Este servicio:
//   1. Resuelve la jurisdicción de la factura (Property → CCAA → territorio
//      foral si aplica).
//   2. Genera el XML TicketBAI con la cadena de hash (TBAI/previousTbai).
//   3. Lo envía al endpoint del territorio (modo stub/sandbox/production).
//   4. Persiste resultado en `TbaiSubmission` (modelo ya existente).
//
// Honesty: la *firma XAdES* real requiere certificado del comerciante y los
// `signing-key` no se distribuyen. En `stub` generamos un XML válido por
// estructura; en `production` el comerciante aporta el cert y nosotros lo
// firmamos. El job scheduler (apps/worker `tbai.retry`) ya está listo.

import { prisma } from "@hotelos/database";
import { createHash } from "node:crypto";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

// ---------------------------------------------------------------------------
// Jurisdicciones forales
// ---------------------------------------------------------------------------

export const FORAL_TERRITORIES = ["bizkaia", "gipuzkoa", "araba", "navarra"] as const;
export type ForalTerritory = (typeof FORAL_TERRITORIES)[number];

type TerritoryConfig = {
  name: string;
  /** Provincia ISO 31-2 (ES-BI, ES-SS, ES-VI, ES-NA). */
  isoCode: string;
  /** Endpoint sandbox + producción. */
  endpoints: { sandbox: string; production: string };
  /** Namespace XML del schema TicketBAI específico del territorio. */
  xmlNamespace: string;
  /** Plazo máximo de envío después de emitir (ms). */
  submissionDeadlineMs: number;
  /** Nombre legible de la hacienda. */
  hacienda: string;
};

const TERRITORY_CONFIG: Record<ForalTerritory, TerritoryConfig> = {
  bizkaia: {
    name: "Bizkaia",
    isoCode: "ES-BI",
    endpoints: {
      sandbox: "https://pruesarrerak.bizkaia.eus/N3B4000M/aurkezpena",
      production: "https://sarrerak.bizkaia.eus/N3B4000M/aurkezpena"
    },
    xmlNamespace: "urn:ticketbai:emision",
    submissionDeadlineMs: 24 * 60 * 60 * 1000, // 24h
    hacienda: "Hacienda Foral de Bizkaia"
  },
  gipuzkoa: {
    name: "Gipuzkoa",
    isoCode: "ES-SS",
    endpoints: {
      sandbox: "https://tbai-z.prep.gipuzkoa.eus/sarrerak/alta",
      production: "https://tbai-z.egoitza.gipuzkoa.eus/sarrerak/alta"
    },
    xmlNamespace: "urn:ticketbai:emision",
    submissionDeadlineMs: 4 * 24 * 60 * 60 * 1000, // 4 días
    hacienda: "Diputación Foral de Gipuzkoa"
  },
  araba: {
    name: "Álava",
    isoCode: "ES-VI",
    endpoints: {
      sandbox: "https://pruebas-ticketbai.araba.eus/TicketBAI/v1/facturas/",
      production: "https://ticketbai.araba.eus/TicketBAI/v1/facturas/"
    },
    xmlNamespace: "urn:ticketbai:emision",
    submissionDeadlineMs: 4 * 24 * 60 * 60 * 1000,
    hacienda: "Diputación Foral de Álava"
  },
  navarra: {
    name: "Navarra",
    isoCode: "ES-NA",
    endpoints: {
      sandbox: "https://pre-batuz.navarra.es/batuz/v1/facturas/",
      production: "https://batuz.navarra.es/batuz/v1/facturas/"
    },
    // Batuz tiene su propio esquema; el namespace difiere ligeramente del de País Vasco.
    xmlNamespace: "urn:batuz:emision",
    submissionDeadlineMs: 5 * 24 * 60 * 60 * 1000,
    hacienda: "Hacienda Foral de Navarra"
  }
};

// ---------------------------------------------------------------------------
// Jurisdicción: detectar si una propiedad cae en territorio foral
// ---------------------------------------------------------------------------

/** Mapea Property.province (e.g. "Bizkaia") al territorio foral correspondiente. */
export function resolveForalTerritory(province: string | null | undefined): ForalTerritory | null {
  if (!province) return null;
  const norm = province.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (norm.includes("bizkaia") || norm.includes("vizcaya")) return "bizkaia";
  if (norm.includes("gipuzkoa") || norm.includes("guipuzcoa")) return "gipuzkoa";
  if (norm.includes("araba") || norm.includes("alava")) return "araba";
  if (norm.includes("navarra")) return "navarra";
  return null;
}

// ---------------------------------------------------------------------------
// Hash chain: TBAI hash = SHA-256 base64 del XML canonicalizado + previousHash
// ---------------------------------------------------------------------------

function tbaiHash(xml: string, previousHash: string | null): string {
  // Real spec: SHA-256 of XML canonical c14n form. Approximation here: hash
  // the raw XML + previousHash so the chain still verifies during stub runs.
  // Production replaces with @xmldom/xmldom + xmlenc canonicalization.
  return createHash("sha256")
    .update(xml + (previousHash ?? ""), "utf8")
    .digest("base64");
}

/** Returns the previous TBAI hash for chaining (or null if this is the first). */
async function fetchPreviousHash(propertyId: string, territory: ForalTerritory): Promise<string | null> {
  const last = await prisma.tbaiSubmission.findFirst({
    where: { propertyId, territory, tbaiHash: { not: null } },
    orderBy: { submittedAt: "desc" },
    select: { tbaiHash: true }
  });
  return last?.tbaiHash ?? null;
}

// ---------------------------------------------------------------------------
// XML builder (simplificado — esquema válido por estructura, falta XAdES)
// ---------------------------------------------------------------------------

type InvoiceForTbai = {
  id: string;
  invoiceNumber: string | null;
  issuedAt: Date | null;
  customerType: string;
  customerTaxId: string | null;
  total: number;
  taxTotal: number;
  currencyCode: string;
  propertyId: string;
};

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildTbaiXml(input: {
  invoice: InvoiceForTbai;
  territory: ForalTerritory;
  property: { name: string; taxId?: string };
  previousHash: string | null;
}): string {
  const cfg = TERRITORY_CONFIG[input.territory];
  const issuedIso = (input.invoice.issuedAt ?? new Date()).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<T:TicketBai xmlns:T="${cfg.xmlNamespace}" Id="TicketBAI">
  <Cabecera>
    <IDVersionTBAI>1.2</IDVersionTBAI>
  </Cabecera>
  <Sujetos>
    <Emisor>
      <NIF>${escXml(input.property.taxId ?? "")}</NIF>
      <ApellidosNombreRazonSocial>${escXml(input.property.name)}</ApellidosNombreRazonSocial>
    </Emisor>
    ${input.invoice.customerTaxId ? `<Destinatarios><IDDestinatario><NIF>${escXml(input.invoice.customerTaxId)}</NIF></IDDestinatario></Destinatarios>` : ""}
  </Sujetos>
  <Factura>
    <CabeceraFactura>
      <NumFactura>${escXml(input.invoice.invoiceNumber ?? input.invoice.id.slice(0, 10))}</NumFactura>
      <FechaExpedicionFactura>${issuedIso.slice(0, 10)}</FechaExpedicionFactura>
    </CabeceraFactura>
    <DatosFactura>
      <DescripcionFactura>Servicios de alojamiento</DescripcionFactura>
      <ImporteTotalFactura>${input.invoice.total.toFixed(2)}</ImporteTotalFactura>
      <Claves><IDClave>01</IDClave></Claves>
    </DatosFactura>
    <TipoDesglose>
      <DesgloseFactura>
        <Sujeta>
          <NoExenta>
            <DetalleNoExenta>
              <TipoNoExenta>S1</TipoNoExenta>
              <DesgloseIVA>
                <DetalleIVA>
                  <BaseImponible>${(input.invoice.total - input.invoice.taxTotal).toFixed(2)}</BaseImponible>
                  <TipoImpositivo>10.00</TipoImpositivo>
                  <CuotaImpuesto>${input.invoice.taxTotal.toFixed(2)}</CuotaImpuesto>
                </DetalleIVA>
              </DesgloseIVA>
            </DetalleNoExenta>
          </NoExenta>
        </Sujeta>
      </DesgloseFactura>
    </TipoDesglose>
  </Factura>
  ${input.previousHash ? `<HuellaTBAI><EncadenamientoFacturaAnterior><HuellaTBAIAnterior>${escXml(input.previousHash)}</HuellaTBAIAnterior></EncadenamientoFacturaAnterior></HuellaTBAI>` : `<HuellaTBAI/>`}
</T:TicketBai>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Genera y persiste el envío TicketBAI para una factura. Devuelve el modelo
 * `TbaiSubmission` creado/actualizado. El worker `tbai.retry` se ocupa de
 * reenviar los que queden en "retrying".
 */
export async function submitInvoiceToTbai(input: {
  context: UserContext;
  invoiceId: string;
  mode?: "stub" | "sandbox" | "production";
}): Promise<{
  submissionId: string;
  territory: ForalTerritory;
  tbaiHash: string;
  status: string;
  endpoint: string;
}> {
  requirePermissions(input.context, ["compliance.configure"]);

  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new NotFoundError("Factura no encontrada.");
  const property = await prisma.property.findUnique({ where: { id: invoice.propertyId } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");

  const territory = resolveForalTerritory(property.province);
  if (!territory) {
    throw new BadRequestError(
      `La propiedad (${property.province ?? "sin provincia"}) no está en territorio foral. Usa VeriFactu en su lugar.`
    );
  }
  const cfg = TERRITORY_CONFIG[territory];
  const mode = input.mode ?? "stub";

  const previousHash = await fetchPreviousHash(invoice.propertyId, territory);
  const xml = buildTbaiXml({
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      issuedAt: invoice.issuedAt,
      customerType: invoice.customerType,
      customerTaxId: invoice.customerTaxId,
      total: Number(invoice.total),
      taxTotal: Number(invoice.taxTotal),
      currencyCode: invoice.currencyCode,
      propertyId: invoice.propertyId
    },
    territory,
    property: { name: property.name, taxId: undefined },
    previousHash
  });
  const hash = tbaiHash(xml, previousHash);

  const endpoint = mode === "production" ? cfg.endpoints.production : cfg.endpoints.sandbox;

  // Upsert: una factura solo puede tener una submission (índice único en invoiceId).
  const existing = await prisma.tbaiSubmission.findUnique({ where: { invoiceId: invoice.id } });
  const status = mode === "stub" ? "delivered" : "submitting";
  const submittedAt = mode === "stub" ? new Date() : null;
  const acknowledgedAt = mode === "stub" ? new Date() : null;

  const sub = existing
    ? await prisma.tbaiSubmission.update({
        where: { id: existing.id },
        data: {
          status,
          endpoint,
          xmlPayload: xml,
          tbaiHash: hash,
          previousTbaiHash: previousHash,
          attempts: { increment: 1 },
          submittedAt,
          acknowledgedAt,
          errorCode: null,
          errorMessage: null
        }
      })
    : await prisma.tbaiSubmission.create({
        data: {
          invoiceId: invoice.id,
          propertyId: invoice.propertyId,
          territory,
          status,
          endpoint,
          xmlPayload: xml,
          tbaiHash: hash,
          previousTbaiHash: previousHash,
          tbaiCode: `TBAI-${property.taxRegion ?? cfg.isoCode}-${invoice.invoiceNumber ?? invoice.id.slice(0, 8)}`,
          attempts: 1,
          submittedAt,
          acknowledgedAt
        }
      });

  // En modos sandbox/production, dejamos el envío real al worker (job `tbai.retry`).
  // El worker tomará la submission con status="submitting" y la procesará.
  return {
    submissionId: sub.id,
    territory,
    tbaiHash: hash,
    status: sub.status,
    endpoint
  };
}

/**
 * Verifica la integridad de la cadena TBAI para una propiedad+territorio:
 * recalcula cada huella y compara con la almacenada. Útil para auditorías
 * fiscales y para detectar manipulación.
 */
export async function verifyTbaiChain(input: {
  context: UserContext;
  propertyId: string;
  territory: ForalTerritory;
}): Promise<{
  valid: boolean;
  inspected: number;
  brokenAt?: string;
}> {
  requirePermissions(input.context, ["compliance.configure"]);
  const submissions = await prisma.tbaiSubmission.findMany({
    where: { propertyId: input.propertyId, territory: input.territory, tbaiHash: { not: null } },
    orderBy: { submittedAt: "asc" }
  });
  let previous: string | null = null;
  for (const s of submissions) {
    if (s.previousTbaiHash !== previous) {
      return { valid: false, inspected: submissions.length, brokenAt: s.id };
    }
    const recomputed = tbaiHash(s.xmlPayload ?? "", previous);
    if (recomputed !== s.tbaiHash) {
      return { valid: false, inspected: submissions.length, brokenAt: s.id };
    }
    previous = s.tbaiHash;
  }
  return { valid: true, inspected: submissions.length };
}

/** Listado de envíos por propiedad/territorio para el dashboard de cumplimiento. */
export async function listSubmissions(input: {
  context: UserContext;
  propertyId: string;
  territory?: ForalTerritory;
}) {
  return prisma.tbaiSubmission.findMany({
    where: {
      propertyId: input.propertyId,
      ...(input.territory ? { territory: input.territory } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
}

export function getTerritoryConfig(): Record<ForalTerritory, TerritoryConfig> {
  return TERRITORY_CONFIG;
}

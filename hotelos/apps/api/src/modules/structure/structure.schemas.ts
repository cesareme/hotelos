// Estructura societaria · L2 · zod contracts of the structure routes.
//
// Every HTTP body of this module is `.strict()` (unknown keys → 400
// VALIDATION_ERROR through parseOr400). The provisioning spec (`centreSpecSchema`)
// is shared by POST /legal-entities/:legalEntityId/properties and by the CLI
// apps/api/src/scripts/provision-pilot-property.ts (which extends it with
// `organizationId`), so a centre is described the same way from the product and
// from the operator's JSON file.
//
// Vocabulary (design §5.3): Sociedad · Centro de trabajo (Hotel / Oficina / Otro).
// Money never appears here; `surfaceM2` is a decimal STRING with ≤ 2 decimals.

import { z } from "zod";
import {
  LEGAL_FORMS,
  PGC_VARIANTS,
  PROPERTY_KINDS,
  STRUCTURE_CODE_PATTERN,
  VERIFACTU_CHAIN_SCOPES,
  type LegalForm,
  type PgcVariant,
  type PropertyKind,
  type VerifactuChainScope
} from "@hotelos/shared";

const nonEmpty = z.string().trim().min(1);
const text = (max: number) => z.string().trim().min(1).max(max);
/** Optional free text: "" and whitespace collapse to null (never persisted as ""). */
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value.length === 0 ? null : value));

const kindEnum = z.enum(PROPERTY_KINDS as unknown as [PropertyKind, ...PropertyKind[]]);
const legalFormEnum = z.enum(LEGAL_FORMS as unknown as [LegalForm, ...LegalForm[]]);
const pgcVariantEnum = z.enum(PGC_VARIANTS as unknown as [PgcVariant, ...PgcVariant[]]);
const chainScopeEnum = z.enum(VERIFACTU_CHAIN_SCOPES as unknown as [VerifactuChainScope, ...VerifactuChainScope[]]);

export const FISCAL_TERRITORIES = ["common", "bizkaia", "gipuzkoa", "araba", "navarra"] as const;

/** 2-6 upper-case letters or digits; lower-case input is normalised (ra → RA). */
export const structureCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(STRUCTURE_CODE_PATTERN, "código de 2 a 6 letras o dígitos (p. ej. RA, LT, OC)"));

/** Raw NIF as typed; normalisation and checksum live in the service (400 TAX_ID_INVALID). */
export const taxIdInputSchema = z.string().trim().min(1).max(20);

/** Código de cuenta de cotización: 11 digits (2 provincia + 7 número + 2 control). */
const cccSchema = z.string().trim().regex(/^\d{11}$/, "CCC de 11 dígitos").nullable();

/** Census / local data of a centre (036, IAE, registro turístico, SES, TGSS, centro de trabajo). */
export const censusSchema = z
  .object({
    cadastralReference: nullableText(20),
    surfaceM2: z
      .string()
      .trim()
      .regex(/^\d{1,8}(\.\d{1,2})?$/, "superficie en m² con hasta 2 decimales (p. ej. 1250.50)")
      .nullable(),
    iaeEpigraph: nullableText(12),
    bedCapacity: z.number().int().min(0).max(100000).nullable(),
    starRating: z.number().int().min(1).max(5).nullable(),
    openingMonths: z.number().int().min(1).max(12).nullable(),
    tourismRegistryNumber: nullableText(40),
    sesEstablishmentCode: nullableText(40),
    socialSecurityCcc: cccSchema,
    laborCenterCode: nullableText(40)
  })
  .partial()
  .strict();

export type CensusInput = z.output<typeof censusSchema>;

// ---------------------------------------------------------------------------
// Sociedad
// ---------------------------------------------------------------------------

const legalEntityFields = {
  legalName: text(200),
  code: structureCodeSchema,
  taxId: taxIdInputSchema.nullable(),
  legalForm: legalFormEnum.nullable(),
  fiscalAddress: nullableText(240),
  fiscalPostalCode: z.string().trim().regex(/^\d{5}$/, "código postal de 5 dígitos").nullable(),
  fiscalMunicipality: nullableText(120),
  fiscalIneCode: z.string().trim().regex(/^\d{5}$/, "código INE de 5 dígitos").nullable(),
  fiscalProvince: nullableText(80),
  registeredOfficeAddress: nullableText(240),
  registeredOfficePostalCode: z.string().trim().regex(/^\d{5}$/, "código postal de 5 dígitos").nullable(),
  registeredOfficeMunicipality: nullableText(120),
  registeredOfficeProvince: nullableText(80),
  mercantileRegistry: nullableText(200),
  cnae: z.string().trim().regex(/^\d{4}$/, "CNAE de 4 dígitos").nullable(),
  pgcVariant: pgcVariantEnum,
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  largeCompany: z.boolean(),
  siiEnabled: z.boolean(),
  cccPrincipal: cccSchema
};

/**
 * PATCH /legal-entities/:legalEntityId. `verifactuChainScope` is NOT here on
 * purpose: the chain policy is fixed from the platform console (R7). The fields
 * that re-qualify the whole NIF — `taxId` (change or clearing), `legalName`,
 * `siiEnabled`, `largeCompany`, `pgcVariant`, `fiscalYearStartMonth` — are high
 * risk: they need `confirmHighRisk: true` (plus the `ai.high_risk.confirm`
 * permission; the regime ones also `accounting.configure`) or the service
 * answers 409 HIGH_RISK_CONFIRMATION_REQUIRED { field, fields, changes }
 * (legal-entity.service.ts HIGH_RISK_LEGAL_ENTITY_FIELDS).
 */
export const legalEntityPatchSchema = z
  .object({ ...legalEntityFields, confirmHighRisk: z.boolean() })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== "confirmHighRisk"), {
    message: "indica al menos un campo de la sociedad a modificar"
  });

export type LegalEntityPatchInput = z.output<typeof legalEntityPatchSchema>;

/** POST /legal-entities (only the FIRST legal entity of an organization; the second is 409 MULTI_ENTITY_NOT_ENABLED). */
export const legalEntityCreateSchema = z
  .object({ ...legalEntityFields })
  .partial()
  .required({ legalName: true })
  .strict();

export type LegalEntityCreateInput = z.output<typeof legalEntityCreateSchema>;

// ---------------------------------------------------------------------------
// Centro de trabajo (alta)
// ---------------------------------------------------------------------------

const roomTypeSpecSchema = z
  .object({
    code: nonEmpty,
    name: nonEmpty,
    baseCapacity: z.number().int().min(1),
    maxOccupancy: z.number().int().min(1),
    count: z.number().int().min(0),
    defaultRateCategory: nonEmpty.nullable().default(null)
  })
  .strict();

const invoiceSequenceSpecSchema = z
  .object({
    sequenceCode: nonEmpty,
    invoiceType: nonEmpty,
    /** Omitted → R3 default: `${serie}-${año}-` with one billing centre, `${serie}-${código}-${año}-` with several. */
    prefix: nonEmpty.optional(),
    year: z.number().int().min(2000).max(2100),
    padding: z.number().int().min(1).max(10).default(6)
  })
  .strict();

/**
 * Spec of ONE work centre (hotel · office · other) of a legal entity. Same
 * shape as the operator's JSON spec minus `organizationId` (taken from the
 * legal entity of the route). Hotel-only sections (building, totalRooms,
 * roomTypes, rooms, ratePlans) are optional here and enforced per kind by
 * validateCentreSpec (property-provisioning.service.ts).
 */
export const centreSpecSchema = z
  .object({
    _notes: z.unknown().optional(),
    property: z
      .object({
        name: nonEmpty,
        kind: kindEnum.default("hotel"),
        /** Omitted → derived from the name (initials) and made unique inside the legal entity. */
        code: structureCodeSchema.nullable().default(null),
        /** Nombre comercial of the establishment block on the invoice (never the razón social). */
        tradeName: nonEmpty.nullable().default(null),
        /** deprecated (Tanda 6b): accepted from old specs and mapped to tradeName; Property.legalName is never written. */
        legalName: nonEmpty.nullable().default(null),
        address: nonEmpty.nullable().default(null),
        municipality: nonEmpty.nullable().default(null),
        province: nonEmpty.nullable().default(null),
        country: nonEmpty.default("ES"),
        postalCode: nonEmpty.nullable().default(null),
        ineMunicipalityCode: nonEmpty.nullable().default(null),
        taxRegion: nonEmpty.nullable().default(null),
        fiscalTerritory: z.enum(FISCAL_TERRITORIES).nullable().default(null),
        timezone: nonEmpty.default("Europe/Madrid"),
        sesHospedajesEnabled: z.boolean().default(false),
        verifactuEnabled: z.boolean().default(false),
        census: censusSchema.default({})
      })
      .strict(),
    profile: z
      .object({
        hotelType: nonEmpty.nullable().default(null),
        autonomousCommunity: nonEmpty.nullable().default(null),
        hasRestaurant: z.boolean().default(false),
        hasKitchen: z.boolean().default(false),
        hasPool: z.boolean().default(false),
        hasSpa: z.boolean().default(false),
        hasParking: z.boolean().default(false),
        hasEvents: z.boolean().default(false),
        hasTerrace: z.boolean().default(false),
        hasLaundry: z.boolean().default(false),
        buildingProtected: z.boolean().default(false)
      })
      .passthrough()
      .default({}),
    owners: z.array(z.object({ userId: nonEmpty, roleId: nonEmpty }).strict()).default([]),
    modules: z.array(nonEmpty).default([]),
    building: z.object({ name: nonEmpty, code: nonEmpty, floors: z.number().int().min(1).max(50) }).strict().optional(),
    totalRooms: z.number().int().min(1).optional(),
    roomTypes: z
      .object({
        _estimated: z.boolean().optional(),
        _estimatedReason: z.string().optional(),
        items: z.array(roomTypeSpecSchema).min(1)
      })
      .strict()
      .optional(),
    /** Optional explicit rooming list; when absent planRooms derives it deterministically. */
    rooms: z.array(z.object({ number: nonEmpty, roomTypeCode: nonEmpty, floorNumber: z.number().int().optional() }).strict()).optional(),
    ratePlans: z.array(z.object({ code: nonEmpty, name: nonEmpty, ratePlanType: nonEmpty, mealPlan: nonEmpty.nullable().default(null) }).strict()).default([]),
    invoiceSequences: z.array(invoiceSequenceSpecSchema).default([]),
    departments: z
      .array(
        z
          .object({
            code: nonEmpty,
            name: nonEmpty,
            users: z.array(z.object({ userId: nonEmpty, roleLabel: nonEmpty.nullable().default(null) }).strict()).default([])
          })
          .strict()
      )
      .default([])
  })
  .strict();

export type CentreSpec = z.output<typeof centreSpecSchema>;
export type CentreSpecInput = z.input<typeof centreSpecSchema>;

/** Body of POST /legal-entities/:legalEntityId/properties: the spec plus `dryRun` (live validation of the wizard). */
export const propertyCreateBodySchema = centreSpecSchema.extend({ dryRun: z.boolean().optional() }).strict();

export type PropertyCreateBody = z.output<typeof propertyCreateBodySchema>;

// ---------------------------------------------------------------------------
// Centro de trabajo (ficha)
// ---------------------------------------------------------------------------

/** PATCH /properties/:propertyId/establishment — never NIF nor razón social (they belong to the legal entity). */
export const establishmentPatchSchema = z
  .object({
    kind: kindEnum,
    code: structureCodeSchema,
    tradeName: nullableText(200),
    ...censusSchema.shape
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "indica al menos un campo del centro a modificar" });

export type EstablishmentPatchInput = z.output<typeof establishmentPatchSchema>;

// ---------------------------------------------------------------------------
// Consola de plataforma · política de cadena VeriFactu
// ---------------------------------------------------------------------------

/** POST /admin/legal-entities/:legalEntityId/verifactu-scope — `confirm: true` is mandatory (decision recorded in the declaración responsable). */
export const verifactuScopeBodySchema = z
  .object({
    scope: chainScopeEnum,
    confirm: z.literal(true, { errorMap: () => ({ message: "confirm debe ser true: la política de cadena consta en la declaración responsable" }) })
  })
  .strict();

export type VerifactuScopeBody = z.output<typeof verifactuScopeBodySchema>;

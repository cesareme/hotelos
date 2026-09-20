// Tanda ACT · lote ACT-L7 · tenant de prueba del activo inmobiliario
// (docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §10.1 adaptado a un tenant
// AISLADO por producto, patrón prisma/seed-checkin.ts; reglas: tenants aislados,
// nunca Faranda).
//
// Crea y rearma un tenant AISLADO para toda verificación con escritura de la
// tanda: organización `org_act`, sociedad `le_act` (NIF ficticio con letra de
// control válida, mismo algoritmo que tests/integration/helpers/l2-tenant.mts)
// y dos hoteles:
//   · `prop_act_a` «Hotel ACT Norte (prueba)» (INE 15030, 4★, 120 plazas) —
//     PROPIETARIA: ficha del edificio (1972, reformado 2018, 4.850 m², 6
//     plantas, 120 habitaciones, valor catastral 2.400.000 € de 2025), finca
//     registral ficticia con referencia catastral de formato válido, hipoteca
//     3.500.000 € (saldo 2.100.000 €), tasación ECO 805 2025 por 9.800.000 €,
//     tenencia `propiedad` vigente, tributos IBI (27.240 €, domiciliado, PAC en
//     3 plazos; INE 15030 no está en la tabla municipal → los tributos anuales
//     caen en el periodo supletorio LGT 62.3), IAE (3.900 €) y residuos (1.200 €)
//     con recibos 2026 previstos (el primer plazo del IBI `pagado` por banco el
//     15-06-2026 sin asiento), 8 documentos de metadatos sin fichero + 1
//     `sustituido` (versión 1 de la póliza multirriesgo), inspecciones (OCA
//     ascensor realizada 2025-03-10 → próxima 2027-03-10, OCA BT vencida hace 20
//     días → alerta alta, CEE programada 2031-05-01), pólizas (RC vigente hasta
//     2027-03-31, multirriesgo que vence en 40 días → alerta media por preaviso)
//     y la obra «Sustitución enfriadora» (48.000 €, eficiencia energética) EN
//     CURSO con licencia exigida y sin registrar (→ alerta alta), 2 partidas y
//     un asiento contabilizado 212/572 de 31.500 € («Enfriadora · certificación
//     1») para que la ejecución salga del diario;
//   · `prop_act_b` «Hotel ACT Sur (prueba)» (INE 28079, 3★, 80 plazas) —
//     ARRENDATARIA DE INDUSTRIA: tenencia `arrendamiento_industria` vigente con
//     «Inmuebles Demo Sur SL» (NIF ficticio válido; 2020-2035, preaviso 12
//     meses, renta mixta 32.000 €/mes + 4 % GOR, revisión IPC en enero, fianza
//     64.000 €, IBI a cargo del arrendatario, retención), IBI con `taxpayer
//     propietario_tercero` (solo calendario), contrato como documento y CEE
//     caducado en 2025 (documento caducado + inspección vencida → estado rojo).
//
// Cuatro usuarios `*@act.test` con roles de plantilla (asset_manager con ámbito
// legal_entity le_act, accountant de organización, manager y receptionist de
// prop_act_a), contraseña común que cumple la política del API (ACT_DEMO_PASSWORD
// la sustituye), plan PGC Pymes hotelero (631, 572, 570, 5721, 475, 231, 211 y
// 212 postables) y ejercicio 2026 `open` de la organización.
//
// Todo por Prisma (sin API): ids fijos `*_act_*` y upserts que convergen al plan
// → idempotente (segunda pasada: mismos recuentos y mismas alertas). `--reset`
// borra la capa ACT de prop_act_* (deleteScoped: activos con su cascada, obras y
// partidas, asientos je_act_* con sus líneas) y la vuelve a sembrar; `--dry-run`
// imprime el plan sin escribir. Las fechas que disparan alertas son relativas a
// HOY (Europe/Madrid); el resto son literales y redondas. Ningún nombre de
// persona, ningún NIF real.
//
// Guardado por assertDemoTarget (Tanda 4 · DATA-05): org_act está en la
// allowlist demo (lib/demo-guard.ts). Nunca toca Faranda ni otros tenants.
//
//   corepack pnpm --filter @hotelos/database db:seed:real-estate [-- --reset|--dry-run]

import { prisma } from "../src/client.js";
import { hashPassword } from "../src/password.js";
import { assertDemoTarget, type PlannedWrite } from "./lib/demo-guard.js";
import type { Prisma } from "@prisma/client";
import { applyRoleTemplate, provisionDefaultTemplateRoles, syncPermissionCatalog } from "../../../apps/api/src/lib/rbac-catalog.js";
import { provisionOrganizationChart } from "../../../apps/api/src/modules/accounting/chart-of-accounts.service.js";
import { ensurePropertySettings } from "../../../apps/api/src/lib/tenant-hydration.js";

// ---------------------------------------------------------------------------
// Identidad del tenant
// ---------------------------------------------------------------------------

export const ORG_ID = "org_act";
export const ORG_NAME = "ACT (pruebas de activo inmobiliario)";
export const LEGAL_ENTITY_ID = "le_act";
export const LEGAL_ENTITY_CODE = "ACT";
export const LEGAL_ENTITY_NAME = "ACT Pruebas Inmobiliarias SL";
export const PROPERTY_A_ID = "prop_act_a";
export const PROPERTY_B_ID = "prop_act_b";
export const PROPERTY_IDS: readonly string[] = [PROPERTY_A_ID, PROPERTY_B_ID];
export const EMAIL_DOMAIN = "act.test";
/** Contraseña común de los cuatro usuarios de prueba (solo demo local; nunca real). `ACT_DEMO_PASSWORD` la sustituye; debe cumplir la política del API. */
export const DEMO_PASSWORD = process.env.ACT_DEMO_PASSWORD?.trim() || "Act-Demo-2026!";
export const FISCAL_YEAR_CODE = "2026";
export const COUNTERPARTY_NAME = "Inmuebles Demo Sur SL";
/** Referencia catastral ficticia con la forma real (7 + 7 + 4 + 2); nunca es una finca real. */
export const CADASTRAL_REFERENCE = "9872023VH5797S0001WX";
/** Cuentas postables que exige la tanda (631 tributos, 572/570/5721 tesorería, 475 HP acreedora, 231 obras en curso, 211/212 inmovilizado). */
export const REQUIRED_ACCOUNTS: readonly string[] = ["631", "572", "570", "5721", "475", "231", "211", "212"];
/** Días de retraso de la OCA BT (→ INSPECTION_OVERDUE alta) y días que faltan para el vencimiento de la póliza multirriesgo (→ INSURANCE_EXPIRING media por preaviso de 60 días). */
export const OCA_BT_OVERDUE_DAYS = 20;
export const MULTIRRIESGO_DAYS_LEFT = 40;

export const PROPERTIES = [
  { id: PROPERTY_A_ID, code: "ACTA", name: "Hotel ACT Norte (prueba)", ineMunicipalityCode: "15030", municipality: "A Coruña", province: "A Coruña", postalCode: "15001", address: "Rúa do Activo 1", starRating: 4, bedCapacity: 120, tenure: "propietaria" },
  { id: PROPERTY_B_ID, code: "ACTB", name: "Hotel ACT Sur (prueba)", ineMunicipalityCode: "28079", municipality: "Madrid", province: "Madrid", postalCode: "28001", address: "Calle del Activo 2", starRating: 3, bedCapacity: 80, tenure: "arrendataria de industria" }
] as const;

type UserScope = { scopeType: "legal_entity"; legalEntityId: string } | { scopeType: "organization" } | { scopeType: "property"; propertyId: string };
type UserSpec = { id: string; local: string; fullName: string; templateKey: string; scope: UserScope };

/** Usuarios de prueba (roles de plantilla de packages/shared/src/permissions.ts; ningún nombre de persona). */
export const USERS: readonly UserSpec[] = [
  { id: "usr_act_activos", local: "activos", fullName: "Gestión de activos ACT", templateKey: "asset_manager", scope: { scopeType: "legal_entity", legalEntityId: LEGAL_ENTITY_ID } },
  { id: "usr_act_contabilidad", local: "contabilidad", fullName: "Contabilidad ACT", templateKey: "accountant", scope: { scopeType: "organization" } },
  { id: "usr_act_direccion", local: "direccion", fullName: "Dirección ACT Norte", templateKey: "manager", scope: { scopeType: "property", propertyId: PROPERTY_A_ID } },
  { id: "usr_act_recepcion", local: "recepcion", fullName: "Recepción ACT Norte", templateKey: "receptionist", scope: { scopeType: "property", propertyId: PROPERTY_A_ID } }
];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** CIF con letra de control válida (mismo algoritmo que tests/integration/helpers/l2-tenant.mts cifFor). */
export function cifFor(letter: string, seed: number): string {
  const digits = String(Math.abs(seed) % 10_000_000).padStart(7, "0");
  let even = 0;
  let odd = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = Number(digits[i]);
    if (i % 2 === 1) even += d;
    else {
      const doubled = d * 2;
      odd += doubled >= 10 ? doubled - 9 : doubled;
    }
  }
  const control = (10 - ((even + odd) % 10)) % 10;
  return `${letter}${digits}${control}`;
}

/** NIF de la sociedad de prueba (número fijo → siempre el mismo CIF; distinto del de CHK y UXDAY). */
export const LEGAL_ENTITY_TAX_ID = cifFor("B", 7_201_972);
/** NIF ficticio del arrendador de prop_act_b. */
export const COUNTERPARTY_TAX_ID = cifFor("B", 7_202_020);

/** Misma política que validatePasswordPolicy del API (copiada de seed-rbac-demo.ts): falla pronto, nunca siembra una contraseña inutilizable. */
export function passwordPolicyErrors(plain: string): string[] {
  const errors: string[] = [];
  if (plain.length < 8) errors.push("mínimo 8 caracteres");
  if (!/[A-Z]/.test(plain)) errors.push("al menos una mayúscula");
  if (!/[0-9]/.test(plain)) errors.push("al menos un número");
  if (!/[^A-Za-z0-9]/.test(plain)) errors.push("al menos un carácter especial");
  return errors;
}

/** Hoy (YYYY-MM-DD) en la zona horaria del hotel. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isoPlus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const log = (line: string) => console.log(line);

// ---------------------------------------------------------------------------
// Plan de datos ACT (ids fijos; fechas de alerta relativas a `today`)
// ---------------------------------------------------------------------------

type WithId<T> = T & { id: string };

export type RealEstatePlan = {
  assets: WithId<Prisma.RealEstateAssetUncheckedCreateInput>[];
  units: WithId<Prisma.RealEstateUnitUncheckedCreateInput>[];
  charges: WithId<Prisma.RealEstateChargeUncheckedCreateInput>[];
  valuations: WithId<Prisma.RealEstateValuationUncheckedCreateInput>[];
  tenures: WithId<Prisma.RealEstateTenureUncheckedCreateInput>[];
  taxes: WithId<Prisma.PropertyTaxUncheckedCreateInput>[];
  receipts: WithId<Prisma.PropertyTaxReceiptUncheckedCreateInput>[];
  documents: WithId<Prisma.RealEstateDocumentUncheckedCreateInput>[];
  inspections: WithId<Prisma.RealEstateInspectionUncheckedCreateInput>[];
  insurances: WithId<Prisma.RealEstateInsuranceUncheckedCreateInput>[];
  capexProjects: WithId<Prisma.CapexProjectUncheckedCreateInput>[];
  capexItems: WithId<Prisma.CapexItemUncheckedCreateInput>[];
  journalEntries: Array<{ entry: WithId<Omit<Prisma.JournalEntryUncheckedCreateInput, "fiscalYearId" | "entryNumber">>; lines: Array<{ id: string; accountCode: string; debit: string; credit: string; description: string }> }>;
};

export const ASSET_A_ID = "rea_act_a";
export const ASSET_B_ID = "rea_act_b";
export const UNIT_A_ID = "reu_act_a_finca";
export const TENURE_A_ID = "ret_act_a_propiedad";
export const TENURE_B_ID = "ret_act_b_arrendamiento";
export const CAPEX_PROJECT_ID = "cpx_act_a_enfriadora";
export const JOURNAL_ENTRY_ID = "je_act_a_enfriadora_1";
/** Plazos PAC del IBI de prop_act_a: forma wire `{ label, dueFrom, dueTo, pct }` (MM-DD; PropertyTaxInstallmentSchema). */
export const IBI_INSTALLMENTS = [
  { label: "PAC-01", dueFrom: "05-01", dueTo: "06-30", pct: "33.33" },
  { label: "PAC-02", dueFrom: "09-01", dueTo: "10-31", pct: "33.33" },
  { label: "PAC-03", dueFrom: "11-01", dueTo: "12-31", pct: "33.34" }
] as const;
/** 27.240 € en tres plazos redondos de 9.080 €. */
export const IBI_INSTALLMENT_AMOUNT = "9080.00";

export function buildPlan(today: string): RealEstatePlan {
  const ocaBtDue = isoPlus(today, -OCA_BT_OVERDUE_DAYS);
  const multirriesgoUntil = isoPlus(today, MULTIRRIESGO_DAYS_LEFT);
  const multirriesgoFrom = isoPlus(multirriesgoUntil, -365);
  const multirriesgoPreviousFrom = isoPlus(multirriesgoUntil, -730);
  const docA = (id: string) => ({ id, organizationId: ORG_ID, propertyId: PROPERTY_A_ID, assetId: ASSET_A_ID });
  const docB = (id: string) => ({ id, organizationId: ORG_ID, propertyId: PROPERTY_B_ID, assetId: ASSET_B_ID });
  const AUTHORITY_A = "Ayuntamiento de A Coruña";
  const AUTHORITY_B = "Ayuntamiento de Madrid";

  return {
    assets: [
      {
        id: ASSET_A_ID,
        organizationId: ORG_ID,
        legalEntityId: LEGAL_ENTITY_ID,
        propertyId: PROPERTY_A_ID,
        name: "Edificio Hotel ACT Norte",
        yearBuilt: 1972,
        yearLastRefurbished: 2018,
        builtSurfaceM2: "4850.00",
        plotSurfaceM2: "1200.00",
        floorsAbove: 6,
        floorsBelow: 1,
        roomsCount: 120,
        protectionLevel: "none",
        energyRating: "C",
        energyCertValidUntil: dateOnly("2031-05-01"),
        cadastralValueTotal: "2400000.00",
        cadastralValueYear: 2025,
        lastValuationValue: "9800000.00",
        lastValuationAt: dateOnly("2025-06-30"),
        currentTenureKind: "propiedad",
        status: "active",
        notes: "Tenant de prueba ACT (datos ficticios)."
      },
      {
        id: ASSET_B_ID,
        organizationId: ORG_ID,
        legalEntityId: LEGAL_ENTITY_ID,
        propertyId: PROPERTY_B_ID,
        name: "Edificio Hotel ACT Sur",
        yearBuilt: 1985,
        yearLastRefurbished: 2012,
        builtSurfaceM2: "3200.00",
        floorsAbove: 5,
        floorsBelow: 1,
        roomsCount: 80,
        protectionLevel: "none",
        energyRating: "E",
        energyCertValidUntil: dateOnly("2025-04-01"),
        currentTenureKind: "arrendamiento_industria",
        status: "active",
        notes: "Tenant de prueba ACT (datos ficticios): la sociedad explota el hotel como arrendataria de industria."
      }
    ],
    units: [
      {
        id: UNIT_A_ID,
        organizationId: ORG_ID,
        assetId: ASSET_A_ID,
        kind: "finca_registral",
        registryOffice: "Registro de la Propiedad nº 3 de A Coruña (ficticio)",
        registryFincaNumber: "12345",
        registryTomo: "1234",
        registryLibro: "456",
        registryFolio: "78",
        cru: "15001000123456",
        cadastralReference: CADASTRAL_REFERENCE,
        useCode: "hotelero",
        surfaceM2: "4850.00",
        cadastralValueLand: "1100000.00",
        cadastralValueBuilding: "1300000.00",
        titleKind: "pleno_dominio",
        titleHolderTaxId: LEGAL_ENTITY_TAX_ID,
        titleHolderName: LEGAL_ENTITY_NAME,
        titleDeedDate: dateOnly("1998-06-15"),
        notary: "Notaría de prueba (ficticia)"
      }
    ],
    charges: [
      {
        id: "rec_act_a_hipoteca",
        unitId: UNIT_A_ID,
        kind: "hipoteca",
        holderName: "Banco Demo SA",
        amount: "3500000.00",
        outstandingAmount: "2100000.00",
        registeredAt: dateOnly("2018-09-01"),
        expiresAt: dateOnly("2038-09-01"),
        note: "Préstamo hipotecario de la reforma de 2018 (ficticio)."
      }
    ],
    valuations: [
      {
        id: "rev_act_a_eco805_2025",
        assetId: ASSET_A_ID,
        kind: "eco_805",
        purpose: "hipotecaria",
        valuedAt: dateOnly("2025-06-30"),
        value: "9800000.00",
        capRatePct: "6.50",
        method: "Comparación y descuento de flujos",
        appraiser: "Tasadora Demo SA",
        documentId: "red_act_a_tasacion"
      }
    ],
    tenures: [
      {
        id: TENURE_A_ID,
        assetId: ASSET_A_ID,
        kind: "propiedad",
        counterpartyName: LEGAL_ENTITY_NAME,
        counterpartyTaxId: LEGAL_ENTITY_TAX_ID,
        startDate: dateOnly("1998-06-15"),
        renewal: "ninguna",
        ibiPayer: "propietario",
        insurancePayer: "propietario",
        capexResponsibility: "propietario",
        status: "vigente",
        documentId: "red_act_a_escritura"
      },
      {
        id: TENURE_B_ID,
        assetId: ASSET_B_ID,
        kind: "arrendamiento_industria",
        counterpartyName: COUNTERPARTY_NAME,
        counterpartyTaxId: COUNTERPARTY_TAX_ID,
        counterpartyNonResident: false,
        startDate: dateOnly("2020-01-01"),
        endDate: dateOnly("2035-12-31"),
        noticeMonths: 12,
        renewal: "tacita",
        rentKind: "mixta",
        rentMonthly: "32000.00",
        rentVariablePct: "4.00",
        rentVariableBase: "gor",
        rentReviewIndex: "ipc",
        rentReviewMonth: 1,
        depositAmount: "64000.00",
        vatApplies: true,
        withholdingApplies: true,
        withholdingRatePct: "19.00",
        ibiPayer: "arrendatario",
        insurancePayer: "propietario",
        capexResponsibility: "compartido",
        status: "vigente",
        documentId: "red_act_b_contrato_arrendamiento"
      }
    ],
    taxes: [
      {
        id: "ptx_act_a_ibi",
        organizationId: ORG_ID,
        propertyId: PROPERTY_A_ID,
        assetId: ASSET_A_ID,
        unitId: UNIT_A_ID,
        kind: "ibi",
        taxpayer: "sociedad",
        authorityName: AUTHORITY_A,
        ineMunicipalityCode: "15030",
        fiscalReference: "IBI-ACT-0001",
        taxBase: "2400000.00",
        ratePct: "1.1350",
        expectedAnnualAmount: "27240.00",
        periodicity: "anual",
        directDebit: true,
        installmentsJson: IBI_INSTALLMENTS.map((item) => ({ ...item })),
        accountCode: "631",
        capitalizable: false,
        legalBasis: "TRLRHL arts. 60-77 (tipo diferenciado uso ocio y hostelería)",
        status: "activo"
      },
      {
        id: "ptx_act_a_iae",
        organizationId: ORG_ID,
        propertyId: PROPERTY_A_ID,
        assetId: ASSET_A_ID,
        kind: "iae",
        taxpayer: "sociedad",
        authorityName: AUTHORITY_A,
        ineMunicipalityCode: "15030",
        fiscalReference: "IAE-ACT-681",
        expectedAnnualAmount: "3900.00",
        periodicity: "anual",
        directDebit: false,
        accountCode: "631",
        capitalizable: false,
        legalBasis: "Tarifas IAE grupo 681 (hoteles de cuatro estrellas)",
        status: "activo"
      },
      {
        id: "ptx_act_a_residuos",
        organizationId: ORG_ID,
        propertyId: PROPERTY_A_ID,
        assetId: ASSET_A_ID,
        kind: "residuos",
        taxpayer: "sociedad",
        authorityName: AUTHORITY_A,
        ineMunicipalityCode: "15030",
        fiscalReference: "TGR-ACT-0001",
        expectedAnnualAmount: "1200.00",
        periodicity: "anual",
        directDebit: false,
        accountCode: "631",
        capitalizable: false,
        legalBasis: "Ordenanza fiscal de la tasa de gestión de residuos (Ley 7/2022)",
        status: "activo"
      },
      {
        id: "ptx_act_b_ibi",
        organizationId: ORG_ID,
        propertyId: PROPERTY_B_ID,
        assetId: ASSET_B_ID,
        kind: "ibi",
        taxpayer: "propietario_tercero",
        authorityName: AUTHORITY_B,
        ineMunicipalityCode: "28079",
        fiscalReference: "IBI-ACT-B-0001",
        expectedAnnualAmount: "18000.00",
        periodicity: "anual",
        voluntaryFrom: "10-01",
        voluntaryTo: "11-30",
        directDebit: false,
        accountCode: "631",
        capitalizable: false,
        legalBasis: "IBI del arrendador repercutido al arrendatario por contrato (solo calendario)",
        status: "activo"
      }
    ],
    receipts: [
      {
        id: "ptr_act_a_ibi_2026_pac01",
        taxId: "ptx_act_a_ibi",
        fiscalYear: 2026,
        period: "PAC-01",
        issuedAt: dateOnly("2026-04-15"),
        dueFrom: dateOnly("2026-05-01"),
        dueTo: dateOnly("2026-06-30"),
        amount: IBI_INSTALLMENT_AMOUNT,
        surchargeAmount: "0.00",
        status: "pagado",
        paidAt: dateOnly("2026-06-15"),
        paidWith: "bank",
        journalEntryId: null,
        notes: "Primer plazo domiciliado; pagado sin asiento (la propuesta 631/572 la genera el módulo)."
      },
      { id: "ptr_act_a_ibi_2026_pac02", taxId: "ptx_act_a_ibi", fiscalYear: 2026, period: "PAC-02", dueFrom: dateOnly("2026-09-01"), dueTo: dateOnly("2026-10-31"), amount: IBI_INSTALLMENT_AMOUNT, surchargeAmount: "0.00", status: "previsto" },
      { id: "ptr_act_a_ibi_2026_pac03", taxId: "ptx_act_a_ibi", fiscalYear: 2026, period: "PAC-03", dueFrom: dateOnly("2026-11-01"), dueTo: dateOnly("2026-12-31"), amount: IBI_INSTALLMENT_AMOUNT, surchargeAmount: "0.00", status: "previsto" },
      // Supletorio LGT 62.3 (1 de septiembre a 20 de noviembre): INE 15030 no está en la tabla municipal.
      { id: "ptr_act_a_iae_2026", taxId: "ptx_act_a_iae", fiscalYear: 2026, period: "anual", dueFrom: dateOnly("2026-09-01"), dueTo: dateOnly("2026-11-20"), amount: "3900.00", surchargeAmount: "0.00", status: "previsto" },
      { id: "ptr_act_a_residuos_2026", taxId: "ptx_act_a_residuos", fiscalYear: 2026, period: "anual", dueFrom: dateOnly("2026-09-01"), dueTo: dateOnly("2026-11-20"), amount: "1200.00", surchargeAmount: "0.00", status: "previsto" }
    ],
    documents: [
      { ...docA("red_act_a_escritura"), category: "legal", kind: "escritura", title: "Escritura de compraventa del edificio (1998)", issuerName: "Notaría de prueba (ficticia)", issueDate: dateOnly("1998-06-15"), linkedEntityType: "unit", linkedEntityId: UNIT_A_ID, storageKind: "inline" },
      { ...docA("red_act_a_nota_simple"), category: "legal", kind: "nota_simple", title: "Nota simple registral (2026)", issuerName: "Registro de la Propiedad nº 3 de A Coruña (ficticio)", issueDate: dateOnly("2026-02-10"), linkedEntityType: "unit", linkedEntityId: UNIT_A_ID, storageKind: "inline" },
      { ...docA("red_act_a_certificacion_catastral"), category: "legal", kind: "certificacion_catastral", title: "Certificación catastral descriptiva y gráfica (2025)", issuerName: "Sede electrónica del Catastro", issueDate: dateOnly("2025-03-01"), linkedEntityType: "unit", linkedEntityId: UNIT_A_ID, storageKind: "inline" },
      { ...docA("red_act_a_licencia_actividad"), category: "licencias", kind: "licencia_actividad", title: "Licencia de actividad hotelera (2018)", issuerName: AUTHORITY_A, issueDate: dateOnly("2018-11-20"), storageKind: "inline" },
      { ...docA("red_act_a_cee"), category: "inspecciones", kind: "cee", title: "Certificado de eficiencia energética · clase C", issuerName: "Técnico certificador (ficticio)", issueDate: dateOnly("2021-05-01"), validFrom: dateOnly("2021-05-01"), validUntil: dateOnly("2031-05-01"), renewalDays: 90, linkedEntityType: "inspection", linkedEntityId: "rei_act_a_cee", storageKind: "inline" },
      { ...docA("red_act_a_acta_oca_ascensor"), category: "inspecciones", kind: "acta_oca", title: "Acta OCA ascensor 2025 (favorable)", issuerName: "OCA Demo SL", issueDate: dateOnly("2025-03-10"), validFrom: dateOnly("2025-03-10"), validUntil: dateOnly("2027-03-10"), renewalDays: 60, linkedEntityType: "inspection", linkedEntityId: "rei_act_a_oca_ascensor", storageKind: "inline" },
      // Póliza multirriesgo: versión 2 vigente (vence en MULTIRRIESGO_DAYS_LEFT días) y versión 1 sustituida.
      { ...docA("red_act_a_poliza_multirriesgo_v2"), category: "seguros", kind: "poliza", title: "Póliza multirriesgo (anualidad vigente)", issuerName: "Aseguradora Demo SA", issueDate: dateOnly(multirriesgoFrom), validFrom: dateOnly(multirriesgoFrom), validUntil: dateOnly(multirriesgoUntil), renewalDays: 60, version: 2, supersedesId: "red_act_a_poliza_multirriesgo_v1", linkedEntityType: "insurance", linkedEntityId: "rin_act_a_multirriesgo", storageKind: "inline" },
      { ...docA("red_act_a_poliza_multirriesgo_v1"), category: "seguros", kind: "poliza", title: "Póliza multirriesgo (anualidad anterior)", issuerName: "Aseguradora Demo SA", issueDate: dateOnly(multirriesgoPreviousFrom), validFrom: dateOnly(multirriesgoPreviousFrom), validUntil: dateOnly(multirriesgoFrom), renewalDays: 60, version: 1, supersededById: "red_act_a_poliza_multirriesgo_v2", linkedEntityType: "insurance", linkedEntityId: "rin_act_a_multirriesgo", storageKind: "inline" },
      { ...docA("red_act_a_tasacion"), category: "valoraciones", kind: "tasacion", title: "Informe de tasación ECO 805 (2025)", issuerName: "Tasadora Demo SA", issueDate: dateOnly("2025-06-30"), storageKind: "inline" },
      { ...docB("red_act_b_contrato_arrendamiento"), category: "contratos", kind: "contrato_arrendamiento", title: "Contrato de arrendamiento de industria 2020-2035", issuerName: COUNTERPARTY_NAME, issueDate: dateOnly("2020-01-01"), validFrom: dateOnly("2020-01-01"), validUntil: dateOnly("2035-12-31"), linkedEntityType: "tenure", linkedEntityId: TENURE_B_ID, confidentiality: "solo_propiedad", storageKind: "inline" },
      { ...docB("red_act_b_cee"), category: "inspecciones", kind: "cee", title: "Certificado de eficiencia energética · clase E (caducado)", issuerName: "Técnico certificador (ficticio)", issueDate: dateOnly("2015-04-01"), validFrom: dateOnly("2015-04-01"), validUntil: dateOnly("2025-04-01"), renewalDays: 90, linkedEntityType: "inspection", linkedEntityId: "rei_act_b_cee", storageKind: "inline" }
    ],
    inspections: [
      { ...docA("rei_act_a_oca_ascensor"), kind: "oca_ascensor", legalBasis: "RD 355/2024 art. 11.4.a", periodicityMonths: 24, installationRef: "RAE-ACT-0001", providerName: "OCA Demo SL", scheduledAt: dateOnly("2025-03-10"), performedAt: dateOnly("2025-03-10"), result: "favorable", nextDueAt: dateOnly("2027-03-10"), documentId: "red_act_a_acta_oca_ascensor", status: "realizada" },
      // Vencida hace OCA_BT_OVERDUE_DAYS días → INSPECTION_OVERDUE alta.
      { ...docA("rei_act_a_oca_bt"), kind: "oca_bt", legalBasis: "REBT ITC-BT-05 (pública concurrencia, cada 5 años)", periodicityMonths: 60, installationRef: "CGBT-ACT-01", providerName: "OCA Demo SL", scheduledAt: dateOnly(ocaBtDue), nextDueAt: dateOnly(ocaBtDue), status: "programada" },
      { ...docA("rei_act_a_cee"), kind: "cee", legalBasis: "RD 390/2021 (renovación a los 10 años)", periodicityMonths: 120, scheduledAt: dateOnly("2031-05-01"), nextDueAt: dateOnly("2031-05-01"), documentId: "red_act_a_cee", status: "programada" },
      // CEE del hotel Sur caducado en 2025 → INSPECTION_OVERDUE alta (estado rojo de la arrendataria).
      { ...docB("rei_act_b_cee"), kind: "cee", legalBasis: "RD 390/2021 (renovación a los 10 años)", periodicityMonths: 120, scheduledAt: dateOnly("2025-04-01"), nextDueAt: dateOnly("2025-04-01"), documentId: "red_act_b_cee", status: "programada" }
    ],
    insurances: [
      { ...docA("rin_act_a_rc"), kind: "rc", insurerName: "Aseguradora Demo SA", policyNumber: "RC-ACT-0001", policyholder: "sociedad", insuredSum: "3000000.00", premiumAnnual: "4800.00", validFrom: dateOnly("2026-04-01"), validUntil: dateOnly("2027-03-31"), autoRenew: true, noticeDays: 60, mandatoryBasis: "Ley 7/2011 de Galicia (RC turística)", status: "vigente" },
      // Vence en MULTIRRIESGO_DAYS_LEFT días (≤ noticeDays 60) → INSURANCE_EXPIRING media.
      { ...docA("rin_act_a_multirriesgo"), kind: "multirriesgo", insurerName: "Aseguradora Demo SA", policyNumber: "MR-ACT-0002", policyholder: "sociedad", insuredSum: "12000000.00", deductible: "3000.00", premiumAnnual: "18000.00", validFrom: dateOnly(multirriesgoFrom), validUntil: dateOnly(multirriesgoUntil), autoRenew: true, noticeDays: 60, documentId: "red_act_a_poliza_multirriesgo_v2", status: "vigente" }
    ],
    capexProjects: [
      {
        id: CAPEX_PROJECT_ID,
        propertyId: PROPERTY_A_ID,
        name: "Sustitución enfriadora",
        description: "Sustitución de la enfriadora de 400 kW por una de alta eficiencia (eficiencia energética).",
        budget: "48000.00",
        // Decisión ACT-L7: `in_progress` (no `approved`) porque CAPEX_LICENCE_MISSING solo se evalúa
        // sobre obras en curso (alerts.pure.ts) y el diario ya lleva ejecución.
        status: "in_progress",
        startDate: dateOnly("2026-07-01"),
        targetEndDate: dateOnly("2026-12-15"),
        createdByUserId: "usr_act_activos",
        realEstateAssetId: ASSET_A_ID,
        workKind: "eficiencia_energetica",
        licenceRequired: true,
        licenceDocumentId: null,
        licenceGrantedAt: null,
        // ICIO 3,75 % sobre 48.000 € = 1.800 €.
        icioAmount: "1800.00",
        executionAccountPrefixes: "212",
        executedAmountLedger: null
      }
    ],
    capexItems: [
      { id: "cpi_act_a_enfriadora_1", capexProjectId: CAPEX_PROJECT_ID, description: "Enfriadora 400 kW (suministro)", estimatedCost: "36000.00", actualCost: "31500.00", status: "approved" },
      { id: "cpi_act_a_enfriadora_2", capexProjectId: CAPEX_PROJECT_ID, description: "Montaje, conexiones y puesta en marcha", estimatedCost: "12000.00", actualCost: "0.00", status: "proposed" }
    ],
    journalEntries: [
      {
        entry: {
          id: JOURNAL_ENTRY_ID,
          organizationId: ORG_ID,
          propertyId: PROPERTY_A_ID,
          sourceType: "manual",
          sourceId: null,
          status: "posted",
          postedAt: new Date("2026-08-31T12:00:00.000Z"),
          createdBy: "usr_act_contabilidad",
          currencyCode: "EUR",
          entryKind: "normal",
          entryDate: dateOnly("2026-08-31"),
          fiscalYearCode: FISCAL_YEAR_CODE,
          description: "Enfriadora · certificación 1",
          reference: "CERT-ENF-01"
        },
        lines: [
          { id: "jl_act_a_enfriadora_1_212", accountCode: "212", debit: "31500.00", credit: "0.00", description: "Instalaciones técnicas · enfriadora (certificación 1)" },
          { id: "jl_act_a_enfriadora_1_572", accountCode: "572", debit: "0.00", credit: "31500.00", description: "Bancos · pago certificación 1" }
        ]
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Borrado acotado (solo prop_act_*)
// ---------------------------------------------------------------------------

type ScopedModel = "realEstateAsset" | "capexProject" | "journalEntry";

/** Borra filas del modelo SOLO dentro de prop_act_* (`propertyId IN (prop_act_a, prop_act_b)` siempre). */
async function deleteScoped(model: ScopedModel, extraWhere: Record<string, unknown> = {}): Promise<number> {
  const where = { ...extraWhere, propertyId: { in: [...PROPERTY_IDS] } };
  const delegate = prisma[model] as unknown as { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> };
  const result = await delegate.deleteMany({ where });
  return result.count;
}

/** --reset: capa ACT de prop_act_* (los satélites del activo caen en cascada; partidas y líneas por el id de su padre acotado). */
async function resetRealEstate(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const entries = await prisma.journalEntry.findMany({ where: { propertyId: { in: [...PROPERTY_IDS] }, id: { startsWith: "je_act_" } }, select: { id: true } });
  counts.journalLine = (await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((row) => row.id) } } })).count;
  counts.journalEntry = await deleteScoped("journalEntry", { id: { startsWith: "je_act_" } });
  const projects = await prisma.capexProject.findMany({ where: { propertyId: { in: [...PROPERTY_IDS] }, id: { startsWith: "cpx_act_" } }, select: { id: true } });
  counts.capexItem = (await prisma.capexItem.deleteMany({ where: { capexProjectId: { in: projects.map((row) => row.id) } } })).count;
  counts.capexProject = await deleteScoped("capexProject", { id: { startsWith: "cpx_act_" } });
  counts.realEstateAsset = await deleteScoped("realEstateAsset");
  return counts;
}

// ---------------------------------------------------------------------------
// Tenant (idempotente)
// ---------------------------------------------------------------------------

async function ensureTenant(): Promise<void> {
  const clash = await prisma.legalEntity.findFirst({ where: { taxId: LEGAL_ENTITY_TAX_ID, NOT: { id: LEGAL_ENTITY_ID } }, select: { id: true, organizationId: true } });
  if (clash) {
    throw new Error(`El NIF ${LEGAL_ENTITY_TAX_ID} ya pertenece a la sociedad ${clash.id} (organización ${clash.organizationId}); no se puede crear ${LEGAL_ENTITY_ID}.`);
  }

  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: ORG_NAME, legalName: LEGAL_ENTITY_NAME, taxId: LEGAL_ENTITY_TAX_ID, country: "ES" }
  });
  await prisma.legalEntity.upsert({
    where: { id: LEGAL_ENTITY_ID },
    update: {},
    create: {
      id: LEGAL_ENTITY_ID,
      organizationId: ORG_ID,
      code: LEGAL_ENTITY_CODE,
      legalName: LEGAL_ENTITY_NAME,
      taxId: LEGAL_ENTITY_TAX_ID,
      legalForm: "sl",
      fiscalAddress: "Rúa do Activo 1",
      fiscalPostalCode: "15001",
      fiscalMunicipality: "A Coruña",
      fiscalIneCode: "15030",
      fiscalProvince: "A Coruña",
      pgcVariant: "pymes",
      isDefault: true
    }
  });
  for (const spec of PROPERTIES) {
    const census = {
      name: spec.name,
      tradeName: spec.name,
      ineMunicipalityCode: spec.ineMunicipalityCode,
      municipality: spec.municipality,
      province: spec.province,
      postalCode: spec.postalCode,
      address: spec.address,
      starRating: spec.starRating,
      bedCapacity: spec.bedCapacity
    };
    await prisma.property.upsert({
      where: { id: spec.id },
      update: census,
      create: {
        id: spec.id,
        organizationId: ORG_ID,
        legalEntityId: LEGAL_ENTITY_ID,
        code: spec.code,
        kind: "hotel",
        legalName: LEGAL_ENTITY_NAME,
        country: "ES",
        taxRegion: "ES_PENINSULA_BALEARES",
        fiscalTerritory: "common",
        timezone: "Europe/Madrid",
        currency: "EUR",
        status: "open",
        sesHospedajesEnabled: false,
        verifactuEnabled: false,
        ...census
      }
    });
  }

  // Catálogo de permisos + roles de plantilla (22 de organización); reaplica las plantillas usadas.
  await syncPermissionCatalog();
  const roles: Record<string, string> = {};
  for (const role of await provisionDefaultTemplateRoles(ORG_ID)) roles[role.templateKey] = role.id;
  for (const templateKey of new Set(USERS.map((u) => u.templateKey))) {
    const roleId = roles[templateKey];
    if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${ORG_ID}.`);
    await applyRoleTemplate(roleId, templateKey);
  }

  const passwordHash = hashPassword(DEMO_PASSWORD);
  for (const spec of USERS) {
    const email = `${spec.local}@${EMAIL_DOMAIN}`;
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, organizationId: true } });
    if (existing && existing.organizationId !== ORG_ID) {
      throw new Error(`El correo ${email} ya existe en otra organización (${existing.organizationId}); el seed no lo toca.`);
    }
    // Rearmable: la contraseña documentada vuelve a valer en cada pasada.
    await prisma.user.upsert({
      where: { email },
      update: { status: "active", passwordHash, mustChangePassword: false },
      create: {
        id: spec.id,
        organizationId: ORG_ID,
        email,
        fullName: spec.fullName,
        status: "active",
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date()
      }
    });
    const roleId = roles[spec.templateKey]!;
    const userId = existing?.id ?? spec.id;
    const scope = spec.scope.scopeType === "legal_entity"
      ? { legalEntityId: spec.scope.legalEntityId }
      : spec.scope.scopeType === "property"
        ? { propertyId: spec.scope.propertyId }
        : {};
    const assignment = await prisma.userRoleAssignment.findFirst({ where: { userId, roleId, scopeType: spec.scope.scopeType, ...scope, revokedAt: null }, select: { id: true } });
    if (!assignment) {
      await prisma.userRoleAssignment.create({
        data: { userId, roleId, scopeType: spec.scope.scopeType, ...scope, organizationId: ORG_ID, reason: "seed real-estate (tenant de prueba ACT)" }
      });
    }
  }

  // Plan PGC Pymes hotelero (631/572/570/5721/475/231/211/212 postables), ajustes de las propiedades y ejercicio 2026 abierto.
  await provisionOrganizationChart(ORG_ID);
  const accounts = await prisma.account.findMany({ where: { organizationId: ORG_ID, code: { in: [...REQUIRED_ACCOUNTS] } }, select: { code: true, isPostable: true } });
  const missingAccounts = REQUIRED_ACCOUNTS.filter((code) => !accounts.some((account) => account.code === code && account.isPostable));
  if (missingAccounts.length > 0) throw new Error(`El plan de ${ORG_ID} no tiene postables las cuentas ${missingAccounts.join(", ")}.`);
  for (const spec of PROPERTIES) await ensurePropertySettings(spec.id);
  const year = await prisma.fiscalYear.findFirst({ where: { organizationId: ORG_ID, propertyId: null, code: FISCAL_YEAR_CODE }, select: { id: true } });
  if (!year) {
    await prisma.fiscalYear.create({
      data: { organizationId: ORG_ID, propertyId: null, code: FISCAL_YEAR_CODE, startDate: dateOnly(`${FISCAL_YEAR_CODE}-01-01`), endDate: dateOnly(`${FISCAL_YEAR_CODE}-12-31`), status: "open" }
    });
  }
}

// ---------------------------------------------------------------------------
// Datos ACT (upserts por id fijo que convergen al plan)
// ---------------------------------------------------------------------------

async function seedRealEstate(plan: RealEstatePlan): Promise<void> {
  for (const row of plan.assets) await prisma.realEstateAsset.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.units) await prisma.realEstateUnit.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.charges) await prisma.realEstateCharge.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.valuations) await prisma.realEstateValuation.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.tenures) await prisma.realEstateTenure.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.taxes) await prisma.propertyTax.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.receipts) await prisma.propertyTaxReceipt.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.documents) await prisma.realEstateDocument.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.inspections) await prisma.realEstateInspection.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.insurances) await prisma.realEstateInsurance.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.capexProjects) await prisma.capexProject.upsert({ where: { id: row.id }, update: row, create: row });
  for (const row of plan.capexItems) await prisma.capexItem.upsert({ where: { id: row.id }, update: row, create: row });

  // Asiento contabilizado del centro A (ejecución de la obra leída del diario): cuentas del plan de la organización.
  const year = await prisma.fiscalYear.findFirst({ where: { organizationId: ORG_ID, propertyId: null, code: FISCAL_YEAR_CODE }, select: { id: true } });
  if (!year) throw new Error(`Sin ejercicio ${FISCAL_YEAR_CODE} en ${ORG_ID}.`);
  const accounts = new Map((await prisma.account.findMany({ where: { organizationId: ORG_ID, code: { in: [...REQUIRED_ACCOUNTS] } }, select: { id: true, code: true } })).map((account) => [account.code, account.id] as const));
  for (const { entry, lines } of plan.journalEntries) {
    const existing = await prisma.journalEntry.findUnique({ where: { id: entry.id }, select: { entryNumber: true } });
    const max = existing ? null : (await prisma.journalEntry.aggregate({ where: { organizationId: ORG_ID, fiscalYearCode: FISCAL_YEAR_CODE }, _max: { entryNumber: true } }))._max.entryNumber;
    const row = { ...entry, fiscalYearId: year.id, entryNumber: existing?.entryNumber ?? (max ?? 0) + 1 };
    await prisma.journalEntry.upsert({ where: { id: row.id }, update: row, create: row });
    for (const line of lines) {
      const accountId = accounts.get(line.accountCode);
      if (!accountId) throw new Error(`Sin cuenta ${line.accountCode} en el plan de ${ORG_ID}.`);
      const lineRow = { id: line.id, journalEntryId: entry.id, accountId, accountCode: line.accountCode, debit: line.debit, credit: line.credit, currency: "EUR", description: line.description };
      await prisma.journalLine.upsert({ where: { id: lineRow.id }, update: lineRow, create: lineRow });
    }
  }
}

/** Recuento por tabla del tenant (para el informe y la comprobación de idempotencia). */
export async function countRows(): Promise<Record<string, number>> {
  const propertyIds = [...PROPERTY_IDS];
  const assetIds = [ASSET_A_ID, ASSET_B_ID];
  const entries = [
    ["organizations", prisma.organization.count({ where: { id: ORG_ID } })],
    ["legal_entities", prisma.legalEntity.count({ where: { organizationId: ORG_ID } })],
    ["properties", prisma.property.count({ where: { organizationId: ORG_ID } })],
    ["users", prisma.user.count({ where: { organizationId: ORG_ID } })],
    ["user_role_assignments", prisma.userRoleAssignment.count({ where: { organizationId: ORG_ID, revokedAt: null } })],
    ["roles", prisma.role.count({ where: { organizationId: ORG_ID } })],
    ["accounts", prisma.account.count({ where: { organizationId: ORG_ID } })],
    ["fiscal_years", prisma.fiscalYear.count({ where: { organizationId: ORG_ID } })],
    ["real_estate_assets", prisma.realEstateAsset.count({ where: { propertyId: { in: propertyIds } } })],
    ["real_estate_units", prisma.realEstateUnit.count({ where: { assetId: { in: assetIds } } })],
    ["real_estate_charges", prisma.realEstateCharge.count({ where: { unit: { assetId: { in: assetIds } } } })],
    ["real_estate_valuations", prisma.realEstateValuation.count({ where: { assetId: { in: assetIds } } })],
    ["real_estate_tenures", prisma.realEstateTenure.count({ where: { assetId: { in: assetIds } } })],
    ["property_taxes", prisma.propertyTax.count({ where: { propertyId: { in: propertyIds } } })],
    ["property_tax_receipts", prisma.propertyTaxReceipt.count({ where: { tax: { propertyId: { in: propertyIds } } } })],
    ["real_estate_documents", prisma.realEstateDocument.count({ where: { propertyId: { in: propertyIds } } })],
    ["real_estate_inspections", prisma.realEstateInspection.count({ where: { propertyId: { in: propertyIds } } })],
    ["real_estate_insurances", prisma.realEstateInsurance.count({ where: { propertyId: { in: propertyIds } } })],
    ["capex_projects", prisma.capexProject.count({ where: { propertyId: { in: propertyIds } } })],
    ["capex_items", prisma.capexItem.count({ where: { capexProjectId: { startsWith: "cpx_act_" } } })],
    ["journal_entries", prisma.journalEntry.count({ where: { organizationId: ORG_ID } })],
    ["journal_lines", prisma.journalLine.count({ where: { journalEntryId: { startsWith: "je_act_" } } })]
  ] as const;
  const out: Record<string, number> = {};
  for (const [table, promise] of entries) out[table] = await promise;
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const dryRun = args.includes("--dry-run");
  // El seed crea usuarios con contraseña conocida: nunca contra una base de
  // producción (la allowlist de demo-guard permite org_act en cualquier BD).
  if (process.env.NODE_ENV === "production" && process.env.SEED_ACT_ALLOW_PRODUCTION !== "1") {
    throw new Error("[seed-real-estate] NODE_ENV=production: el tenant de prueba ACT (usuarios con contraseña conocida) no se siembra en producción. Exporta SEED_ACT_ALLOW_PRODUCTION=1 solo para una demo aislada.");
  }
  const policyErrors = passwordPolicyErrors(DEMO_PASSWORD);
  if (policyErrors.length > 0) throw new Error(`[seed-real-estate] la contraseña de demo (ACT_DEMO_PASSWORD) no cumple la política: ${policyErrors.join(", ")}.`);

  const today = todayIn("Europe/Madrid");
  const plan = buildPlan(today);
  const planned: PlannedWrite[] = [
    { table: "organizations / legal_entities / properties / property_ai_settings / property_compliance_settings", op: "upsert", where: `id = ${ORG_ID} / ${LEGAL_ENTITY_ID} / ${PROPERTY_IDS.join(", ")}`, count: 3 + PROPERTIES.length * 2 },
    { table: "roles + role_permissions (plantillas) / accounts (plan PGC Pymes hotelero) / fiscal_years 2026", op: "upsert", where: `organization_id = ${ORG_ID}` },
    { table: "users + user_role_assignments", op: "upsert", where: `*@${EMAIL_DOMAIN}`, count: USERS.length },
    { table: "real_estate_assets / units / charges / valuations / tenures", op: "upsert", where: `property_id IN (${PROPERTY_IDS.join(", ")})`, count: plan.assets.length + plan.units.length + plan.charges.length + plan.valuations.length + plan.tenures.length },
    { table: "property_taxes / property_tax_receipts", op: "upsert", where: `property_id IN (${PROPERTY_IDS.join(", ")})`, count: plan.taxes.length + plan.receipts.length },
    { table: "real_estate_documents (metadatos sin fichero) / inspections / insurances", op: "upsert", where: `property_id IN (${PROPERTY_IDS.join(", ")})`, count: plan.documents.length + plan.inspections.length + plan.insurances.length },
    { table: "capex_projects / capex_items / journal_entries + journal_lines (posted 212/572)", op: "upsert", where: `property_id = ${PROPERTY_A_ID}`, count: plan.capexProjects.length + plan.capexItems.length + plan.journalEntries.length * 3 }
  ];
  if (reset) {
    planned.unshift(
      { table: "journal_lines + journal_entries je_act_*", op: "deleteMany", where: `property_id IN (${PROPERTY_IDS.join(", ")}) AND id LIKE 'je_act_%'` },
      { table: "capex_items + capex_projects cpx_act_*", op: "deleteMany", where: `property_id IN (${PROPERTY_IDS.join(", ")}) AND id LIKE 'cpx_act_%'` },
      { table: "real_estate_assets (cascada: units, charges, valuations, tenures, property_taxes, receipts, documents, inspections, insurances)", op: "deleteMany", where: `property_id IN (${PROPERTY_IDS.join(", ")})` }
    );
  }

  log(`[seed-real-estate] hoy (Europe/Madrid) = ${today} · OCA BT vencida el ${isoPlus(today, -OCA_BT_OVERDUE_DAYS)} · multirriesgo vence el ${isoPlus(today, MULTIRRIESGO_DAYS_LEFT)}${reset ? " · --reset" : ""}${dryRun ? " · --dry-run" : ""}`);
  if (dryRun) {
    for (const p of planned) log(`  ${p.op.padEnd(10)} ${p.table}${typeof p.count === "number" ? ` ×${p.count}` : ""}${p.where ? ` — ${p.where}` : ""}`);
    log("[seed-real-estate] dry-run: nada escrito.");
    return;
  }

  // Solo el orgId va al guard (org_act está en DEMO_ORG_IDS); las propiedades quedan acotadas por deleteScoped.
  assertDemoTarget({ orgId: ORG_ID, action: `seed-real-estate (${reset ? "reset" : "ensure"})`, planned });

  await ensureTenant();
  if (reset) {
    const removed = await resetRealEstate();
    log(`[seed-real-estate] reset: ${Object.entries(removed).map(([table, count]) => `${table}=${count}`).join(" · ")}`);
  }
  await seedRealEstate(plan);
  const counts = await countRows();

  log(
    `[seed-real-estate] listo · ${ORG_NAME} (${ORG_ID}) · sociedad ${LEGAL_ENTITY_NAME} ${LEGAL_ENTITY_TAX_ID} · ` +
      `${PROPERTIES.map((p) => `${p.name} (${p.id}, ${p.tenure})`).join(" · ")} · ` +
      `usuarios ${USERS.map((u) => `${u.local}@${EMAIL_DOMAIN} (${u.templateKey})`).join(", ")} (contraseña ${DEMO_PASSWORD})`
  );
  log(`[seed-real-estate] cifras: valor catastral 2.400.000 € (suelo 1.100.000 / construcción 1.300.000) · hipoteca 3.500.000 € (saldo 2.100.000) · tasación ECO 805 9.800.000 € · IBI 27.240 € (3 × 9.080; PAC-01 pagado 2026-06-15) · IAE 3.900 € · residuos 1.200 € · renta Sur 32.000 €/mes + 4 % GOR (fianza 64.000) · obra enfriadora 48.000 € (ICIO 1.800; diario 212 = 31.500)`);
  log("[seed-real-estate] filas por tabla:");
  for (const [table, count] of Object.entries(counts)) log(`  ${table.padEnd(26)} ${count}`);
}

main()
  .catch((error) => {
    console.error("[seed-real-estate] ERROR:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

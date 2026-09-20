// Tanda ACT · lote ACT-L7 · contrato del tenant de prueba del activo
// inmobiliario (docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §10.1 adaptado a
// un tenant aislado por producto; reglas: tenants aislados, nunca Faranda).
//
//   · packages/database/prisma/seed-real-estate.ts existe, pasa por
//     assertDemoTarget (solo el orgId: org_act está en DEMO_ORG_IDS), es
//     autónomo (no importa seed.ts, seed-operations.ts, seed-ux-day.ts ni
//     seed-checkin.ts), usa los prefijos del tenant aislado (org_act, le_act,
//     prop_act_*, *@act.test, *_act_*) y no contiene ningún apellido real ni
//     nombre de persona (los usuarios llevan nombres de puesto);
//   · sociedad con NIF ficticio de letra de control válida (cifFor, mismo
//     algoritmo que tests/integration/helpers/l2-tenant.mts) y arrendador con
//     otro NIF ficticio válido; ambos distintos del de CHK;
//   · dos centros (Norte propietaria: INE 15030, 4★, 120 plazas; Sur
//     arrendataria de industria: INE 28079, 3★, 80 plazas), cuatro usuarios con
//     roles de plantilla (asset_manager de la sociedad, accountant de la
//     organización, manager y receptionist de prop_act_a), contraseña que
//     cumple la política del API (ACT_DEMO_PASSWORD la sustituye), plan PGC
//     Pymes hotelero con las 8 cuentas postables de la tanda y ejercicio 2026;
//   · datos ACT por Prisma con ids fijos: ficha, finca registral con referencia
//     catastral ficticia de formato válido, hipoteca, tasación ECO 805, tenencia
//     `propiedad`, IBI/IAE/residuos con recibos 2026 (PAC-01 del IBI pagado por
//     banco el 15-06-2026 sin asiento; los anuales en el supletorio LGT 62.3),
//     8 documentos sin fichero + 1 sustituido, inspecciones (OCA BT vencida
//     hace 20 días → alerta alta), pólizas (multirriesgo vence en 40 días →
//     alerta media), obra en curso sin licencia (→ alerta alta) con 2 partidas
//     y un asiento contabilizado 212/572 de 31.500 €; Sur con tenencia
//     `arrendamiento_industria`, IBI `propietario_tercero` y CEE caducado;
//   · los deleteMany van acotados a prop_act_* (deleteScoped o ids de padres
//     leídos con ese filtro); nunca toca Faranda, org_123, org_uxday ni org_chk;
//   · org_act está en la allowlist demo (lib/demo-guard.ts), el script
//     `db:seed:real-estate` existe y tests/demo-seed-contract lo guarda.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const seed = read("../packages/database/prisma/seed-real-estate.ts");
const guard = read("../packages/database/prisma/lib/demo-guard.ts");
const demoSeedContract = read("./demo-seed-contract.test.mjs");
const databasePackage = JSON.parse(read("../packages/database/package.json"));

/** Apellidos que NUNCA pueden aparecer en el seed de prueba (misma lista que seed-checkin-contract). */
const SURNAME_BLACKLIST = [
  "Ameijeiras", "Ares", "Baña", "Brey", "Carballo", "Castiñeira", "Cobas", "Cueto", "Docampo", "Espiño", "Freire",
  "Insua", "Lavandera", "Lema", "Menéndez", "Nogueira", "Piñeiro", "Prieto", "Requeijo", "Rial", "Rubido", "Salgado",
  "Souto", "Turnes", "Varela", "Vieites", "Vilar", "Lopez", "López", "Garcia", "García", "Fernández", "Fernandez",
  "Rodríguez", "Rodriguez", "Martínez", "Martinez", "Pérez", "Perez", "Sánchez", "Sanchez", "Gómez", "Gomez", "González",
  "Gonzalez", "Ruiz", "Díaz", "Diaz", "Hernández", "Moreno", "Jiménez", "Álvarez", "Romero", "Torres", "Navarro", "Vázquez",
  "Ramos", "Gil", "Serrano", "Blanco", "Molina", "Castro", "Ortiz", "Rubio", "Marín", "Sanz", "Iglesias", "Núñez", "Medina",
  "Garrido", "Cortés", "Santos", "Lozano", "Guerrero", "Cano", "Méndez", "Cruz", "Flores", "Herrera", "Peña", "Vega", "Fuentes",
  "Carrasco", "Diez", "Caballero", "Reyes", "Nieto", "Aguilar", "Pascual", "Herrero", "Santana", "Lorenzo", "Hidalgo", "Montero",
  "Ibáñez", "Ferrer", "Duran", "Vicente", "Benítez", "Mora", "Vidal", "Arias", "Carmona", "Crespo", "Soto", "Román", "Pastor",
  "Velasco", "Parra", "Sáez", "Moya", "Bravo", "Rivera", "Gallego", "Rey", "Silva", "Calvo", "Otero", "Costa", "Pereira"
];

function importSpecifiers(source) {
  return [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
}

/** Mismo algoritmo que el seed y que l2-tenant.mts (el test lo reimplementa para no importar TypeScript). */
function cifFor(letter, seed) {
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

/** Letra de control de un CIF numérico (B…): el último dígito debe ser el que da el algoritmo. */
function cifChecksumValid(cif) {
  return /^[A-Z]\d{8}$/.test(cif) && cifFor(cif[0], Number(cif.slice(1, 8))) === cif;
}

describe("Seed «tenant de prueba ACT» (ACT-L7)", () => {
  it("existe, pasa por assertDemoTarget con el orgId y solo escribe en el tenant aislado", () => {
    assert.match(seed, /assertDemoTarget\(\{ orgId: ORG_ID, action: `seed-real-estate \(\$\{reset \? "reset" : "ensure"\}\)`, planned \}\)/);
    assert.match(seed, /export const ORG_ID = "org_act"/);
    assert.match(seed, /export const LEGAL_ENTITY_ID = "le_act"/);
    assert.match(seed, /export const LEGAL_ENTITY_CODE = "ACT"/);
    assert.match(seed, /export const PROPERTY_A_ID = "prop_act_a"/);
    assert.match(seed, /export const PROPERTY_B_ID = "prop_act_b"/);
    assert.match(seed, /export const PROPERTY_IDS: readonly string\[\] = \[PROPERTY_A_ID, PROPERTY_B_ID\]/);
    assert.match(seed, /export const EMAIL_DOMAIN = "act\.test"/);
    assert.match(seed, /process\.env\.ACT_DEMO_PASSWORD\?\.trim\(\) \|\| "Act-Demo-2026!"/, "contraseña sustituible");
    assert.match(seed, /export function passwordPolicyErrors\(plain: string\): string\[\]/, "política copiada de seed-rbac-demo.ts");
    assert.match(seed, /const policyErrors = passwordPolicyErrors\(DEMO_PASSWORD\);\s*if \(policyErrors\.length > 0\) throw new Error/, "falla pronto si la contraseña no cumple la política");
    assert.match(seed, /hashPassword\(DEMO_PASSWORD\)/);
    assert.match(seed, /NODE_ENV === "production" && process\.env\.SEED_ACT_ALLOW_PRODUCTION !== "1"/, "guarda de producción");
    assert.match(seed, /args\.includes\("--reset"\)/);
    assert.match(seed, /args\.includes\("--dry-run"\)/);
  });

  it("es autónomo: no importa seed.ts, seed-operations.ts, seed-ux-day.ts ni seed-checkin.ts", () => {
    const specifiers = importSpecifiers(seed);
    assert.ok(specifiers.length >= 5, `imports parsed: ${specifiers.length}`);
    for (const specifier of specifiers) {
      assert.doesNotMatch(specifier, /seed\.js$|seed\.ts$|seed-operations|seed-commercial|seed-rbac|seed-ux-day|seed-checkin/, `import prohibido: ${specifier}`);
    }
    assert.match(seed, /from "\.\/lib\/demo-guard\.js"/);
    assert.match(seed, /from "\.\.\/src\/password\.js"/);
  });

  it("sociedad y arrendador con NIF ficticio de letra de control válida (cifFor de l2-tenant.mts), distintos del de CHK", () => {
    assert.match(seed, /export function cifFor\(letter: string, seed: number\): string/);
    assert.match(seed, /export const LEGAL_ENTITY_TAX_ID = cifFor\("B", 7_201_972\)/);
    assert.match(seed, /export const COUNTERPARTY_TAX_ID = cifFor\("B", 7_202_020\)/);
    const legalEntity = cifFor("B", 7_201_972);
    const counterparty = cifFor("B", 7_202_020);
    assert.ok(cifChecksumValid(legalEntity), `NIF de la sociedad válido: ${legalEntity}`);
    assert.ok(cifChecksumValid(counterparty), `NIF del arrendador válido: ${counterparty}`);
    assert.notEqual(legalEntity, counterparty);
    assert.notEqual(legalEntity, cifFor("B", 2026_0920), "distinto del NIF de le_chk (seed-checkin.ts)");
    assert.match(seed, /NOT: \{ id: LEGAL_ENTITY_ID \}/, "aborta si el NIF ya pertenece a otra sociedad");
    assert.match(seed, /legalForm: "sl"/);
    assert.match(seed, /pgcVariant: "pymes"/);
  });

  it("dos centros (Norte propietaria 15030/4★/120, Sur arrendataria 28079/3★/80), cuatro usuarios de plantilla, plan PGC y ejercicio 2026", () => {
    assert.match(seed, /id: PROPERTY_A_ID, code: "ACTA", name: "Hotel ACT Norte \(prueba\)", ineMunicipalityCode: "15030"[^\n]*starRating: 4, bedCapacity: 120, tenure: "propietaria"/);
    assert.match(seed, /id: PROPERTY_B_ID, code: "ACTB", name: "Hotel ACT Sur \(prueba\)", ineMunicipalityCode: "28079"[^\n]*starRating: 3, bedCapacity: 80, tenure: "arrendataria de industria"/);
    assert.match(seed, /kind: "hotel"/);
    assert.match(seed, /timezone: "Europe\/Madrid"/);
    assert.match(seed, /taxRegion: "ES_PENINSULA_BALEARES"/);
    for (const [local, templateKey, scope] of [
      ["activos", "asset_manager", 'scopeType: "legal_entity", legalEntityId: LEGAL_ENTITY_ID'],
      ["contabilidad", "accountant", 'scopeType: "organization"'],
      ["direccion", "manager", 'scopeType: "property", propertyId: PROPERTY_A_ID'],
      ["recepcion", "receptionist", 'scopeType: "property", propertyId: PROPERTY_A_ID']
    ]) {
      assert.match(seed, new RegExp(`local: "${local}",[^\\n]*templateKey: "${templateKey}", scope: \\{ ${scope.replace(/[()]/g, "\\$&")} \\}`), `${local} → ${templateKey} (${scope})`);
    }
    assert.match(seed, /syncPermissionCatalog\(\)/);
    assert.match(seed, /provisionDefaultTemplateRoles\(ORG_ID\)/);
    assert.match(seed, /applyRoleTemplate\(roleId, templateKey\)/);
    assert.match(seed, /provisionOrganizationChart\(ORG_ID\)/);
    assert.match(seed, /REQUIRED_ACCOUNTS: readonly string\[\] = \["631", "572", "570", "5721", "475", "231", "211", "212"\]/);
    assert.match(seed, /account\.code === code && account\.isPostable/, "comprueba que las 8 cuentas son postables");
    for (const propertyId of ["PROPERTY_A_ID", "PROPERTY_B_ID"]) assert.match(seed, new RegExp(`export const ${propertyId}`));
    assert.match(seed, /for \(const spec of PROPERTIES\) await ensurePropertySettings\(spec\.id\)/);
    assert.match(seed, /export const FISCAL_YEAR_CODE = "2026"/);
    assert.match(seed, /prisma\.fiscalYear\.findFirst\(\{ where: \{ organizationId: ORG_ID, propertyId: null, code: FISCAL_YEAR_CODE \}/);
    assert.match(seed, /code: FISCAL_YEAR_CODE, startDate: dateOnly\(`\$\{FISCAL_YEAR_CODE\}-01-01`\), endDate: dateOnly\(`\$\{FISCAL_YEAR_CODE\}-12-31`\), status: "open"/);
  });

  it("activo A: ficha, finca registral con referencia catastral ficticia válida, hipoteca, tasación ECO 805 y tenencia propiedad", () => {
    assert.match(seed, /export const CADASTRAL_REFERENCE = "9872023VH5797S0001WX"/);
    assert.match(seed, /name: "Edificio Hotel ACT Norte",\s*yearBuilt: 1972,\s*yearLastRefurbished: 2018,\s*builtSurfaceM2: "4850\.00"/);
    assert.match(seed, /floorsAbove: 6,\s*floorsBelow: 1,\s*roomsCount: 120/);
    assert.match(seed, /cadastralValueTotal: "2400000\.00",\s*cadastralValueYear: 2025/);
    assert.match(seed, /lastValuationValue: "9800000\.00"/);
    assert.match(seed, /currentTenureKind: "propiedad"/);
    assert.match(seed, /kind: "finca_registral"/);
    assert.match(seed, /registryOffice: "Registro de la Propiedad nº 3 de A Coruña \(ficticio\)"/);
    assert.match(seed, /cadastralReference: CADASTRAL_REFERENCE/);
    assert.match(seed, /cadastralValueLand: "1100000\.00",\s*cadastralValueBuilding: "1300000\.00"/);
    assert.match(seed, /titleKind: "pleno_dominio",\s*titleHolderTaxId: LEGAL_ENTITY_TAX_ID,\s*titleHolderName: LEGAL_ENTITY_NAME/);
    assert.match(seed, /kind: "hipoteca",\s*holderName: "Banco Demo SA",\s*amount: "3500000\.00",\s*outstandingAmount: "2100000\.00"/);
    assert.match(seed, /kind: "eco_805",\s*purpose: "hipotecaria",\s*valuedAt: dateOnly\("2025-06-30"\),\s*value: "9800000\.00"/);
    assert.match(seed, /id: TENURE_A_ID,\s*assetId: ASSET_A_ID,\s*kind: "propiedad"/);
    assert.match(seed, /kind: "propiedad",[\s\S]{0,400}?status: "vigente"/);
  });

  it("tributos A: IBI 27.240 € domiciliado con PAC de 3 plazos (wire { label, dueFrom, dueTo, pct }), IAE 3.900, residuos 1.200; recibos 2026 (PAC-01 pagado por banco el 15-06-2026 sin asiento; anuales en el supletorio LGT 62.3)", () => {
    const installments = /export const IBI_INSTALLMENTS = \[([\s\S]*?)\] as const;/.exec(seed);
    assert.ok(installments, "IBI_INSTALLMENTS");
    const items = [...installments[1].matchAll(/\{ label: "(PAC-\d{2})", dueFrom: "(\d{2}-\d{2})", dueTo: "(\d{2}-\d{2})", pct: "([\d.]+)" \}/g)];
    assert.equal(items.length, 3, "tres plazos");
    assert.deepEqual(items.map((m) => m[1]), ["PAC-01", "PAC-02", "PAC-03"]);
    assert.equal(items.reduce((sum, m) => sum + Number(m[4]), 0).toFixed(2), "100.00", "los porcentajes suman 100");
    assert.match(seed, /export const IBI_INSTALLMENT_AMOUNT = "9080\.00"/, "27.240 € = 3 × 9.080 €");
    assert.match(seed, /kind: "ibi",\s*taxpayer: "sociedad",[\s\S]{0,300}?ineMunicipalityCode: "15030",[\s\S]{0,200}?taxBase: "2400000\.00",\s*ratePct: "1\.1350",\s*expectedAnnualAmount: "27240\.00",\s*periodicity: "anual",\s*directDebit: true,\s*installmentsJson: IBI_INSTALLMENTS\.map/);
    assert.match(seed, /kind: "iae",[\s\S]{0,300}?expectedAnnualAmount: "3900\.00"/);
    assert.match(seed, /kind: "residuos",[\s\S]{0,300}?expectedAnnualAmount: "1200\.00"/);
    assert.match(seed, /id: "ptr_act_a_ibi_2026_pac01",\s*taxId: "ptx_act_a_ibi",\s*fiscalYear: 2026,\s*period: "PAC-01",[\s\S]{0,300}?status: "pagado",\s*paidAt: dateOnly\("2026-06-15"\),\s*paidWith: "bank",\s*journalEntryId: null/);
    assert.match(seed, /id: "ptr_act_a_ibi_2026_pac02"[^\n]*period: "PAC-02"[^\n]*status: "previsto"/);
    assert.match(seed, /id: "ptr_act_a_ibi_2026_pac03"[^\n]*period: "PAC-03"[^\n]*status: "previsto"/);
    for (const id of ["ptr_act_a_iae_2026", "ptr_act_a_residuos_2026"]) {
      assert.match(seed, new RegExp(`id: "${id}"[^\\n]*period: "anual", dueFrom: dateOnly\\("2026-09-01"\\), dueTo: dateOnly\\("2026-11-20"\\)[^\\n]*status: "previsto"`), `${id} en el supletorio 01-09 → 20-11`);
    }
    assert.match(seed, /accountCode: "631"/);
  });

  it("documentos A: 8 de metadatos sin fichero + la versión 1 de la póliza sustituida; B: contrato y CEE caducado", () => {
    const kinds = ["escritura", "nota_simple", "certificacion_catastral", "licencia_actividad", "cee", "acta_oca", "poliza", "tasacion"];
    for (const kind of kinds) assert.match(seed, new RegExp(`docA\\("red_act_a_[a-z_0-9]+"\\), category: "[a-z]+", kind: "${kind}"`), `documento A ${kind}`);
    assert.match(seed, /docA\("red_act_a_cee"\)[^\n]*validUntil: dateOnly\("2031-05-01"\)/, "CEE válido hasta 2031-05-01");
    assert.match(seed, /docA\("red_act_a_acta_oca_ascensor"\)[^\n]*issueDate: dateOnly\("2025-03-10"\)/);
    assert.match(seed, /docA\("red_act_a_poliza_multirriesgo_v2"\)[^\n]*version: 2, supersedesId: "red_act_a_poliza_multirriesgo_v1"/);
    assert.match(seed, /docA\("red_act_a_poliza_multirriesgo_v1"\)[^\n]*version: 1, supersededById: "red_act_a_poliza_multirriesgo_v2"/, "versión 1 sustituida (status derivado «sustituido»)");
    assert.match(seed, /docB\("red_act_b_contrato_arrendamiento"\), category: "contratos", kind: "contrato_arrendamiento"[^\n]*linkedEntityType: "tenure", linkedEntityId: TENURE_B_ID/);
    assert.match(seed, /docB\("red_act_b_cee"\), category: "inspecciones", kind: "cee"[^\n]*validUntil: dateOnly\("2025-04-01"\)/, "CEE del Sur caducado en 2025");
    const docs = [...seed.matchAll(/\{ \.\.\.doc[AB]\("red_act_[a-z0-9_]+"\), category: /g)];
    assert.equal(docs.length, 11, "9 documentos de A (8 + 1 sustituido) y 2 de B");
    assert.match(seed, /storageKind: "inline"/);
    assert.doesNotMatch(seed, /fileName: "|inline: "|sha256: "/, "metadatos sin fichero: ni nombre, ni bytes, ni hash");
  });

  it("inspecciones, pólizas y obra: OCA BT vencida hace 20 días y multirriesgo a 40 días (relativas a hoy), OCA ascensor realizada, CEE 2031, obra en curso sin licencia con asiento 212/572 de 31.500 €", () => {
    assert.match(seed, /export const OCA_BT_OVERDUE_DAYS = 20/);
    assert.match(seed, /export const MULTIRRIESGO_DAYS_LEFT = 40/);
    assert.match(seed, /todayIn\("Europe\/Madrid"\)/);
    assert.match(seed, /const ocaBtDue = isoPlus\(today, -OCA_BT_OVERDUE_DAYS\)/);
    assert.match(seed, /const multirriesgoUntil = isoPlus\(today, MULTIRRIESGO_DAYS_LEFT\)/);
    assert.match(seed, /docA\("rei_act_a_oca_ascensor"\), kind: "oca_ascensor"[^\n]*performedAt: dateOnly\("2025-03-10"\), result: "favorable", nextDueAt: dateOnly\("2027-03-10"\)[^\n]*status: "realizada"/);
    assert.match(seed, /docA\("rei_act_a_oca_bt"\), kind: "oca_bt"[^\n]*scheduledAt: dateOnly\(ocaBtDue\), nextDueAt: dateOnly\(ocaBtDue\), status: "programada"/, "→ INSPECTION_OVERDUE alta");
    assert.match(seed, /docA\("rei_act_a_cee"\), kind: "cee"[^\n]*nextDueAt: dateOnly\("2031-05-01"\)[^\n]*status: "programada"/);
    assert.match(seed, /docB\("rei_act_b_cee"\), kind: "cee"[^\n]*nextDueAt: dateOnly\("2025-04-01"\)[^\n]*status: "programada"/, "CEE del Sur vencido → alerta alta");
    assert.match(seed, /docA\("rin_act_a_rc"\), kind: "rc"[^\n]*validUntil: dateOnly\("2027-03-31"\)[^\n]*status: "vigente"/);
    assert.match(seed, /docA\("rin_act_a_multirriesgo"\), kind: "multirriesgo"[^\n]*validUntil: dateOnly\(multirriesgoUntil\)[^\n]*noticeDays: 60[^\n]*status: "vigente"/, "→ INSURANCE_EXPIRING media (40 ≤ 60 días de preaviso)");
    assert.match(seed, /id: CAPEX_PROJECT_ID,\s*propertyId: PROPERTY_A_ID,\s*name: "Sustitución enfriadora",[\s\S]{0,200}?budget: "48000\.00"/);
    assert.match(seed, /status: "in_progress",\s*startDate: dateOnly\("2026-07-01"\)/, "en curso: CAPEX_LICENCE_MISSING solo se evalúa sobre obras in_progress");
    assert.match(seed, /realEstateAssetId: ASSET_A_ID,\s*workKind: "eficiencia_energetica",\s*licenceRequired: true,\s*licenceDocumentId: null/);
    assert.match(seed, /icioAmount: "1800\.00"/, "ICIO 3,75 % de 48.000");
    assert.match(seed, /executionAccountPrefixes: "212"/);
    const items = [...seed.matchAll(/id: "cpi_act_a_enfriadora_\d", capexProjectId: CAPEX_PROJECT_ID/g)];
    assert.equal(items.length, 2, "dos partidas");
    assert.match(seed, /sourceType: "manual",[\s\S]{0,120}?status: "posted",[\s\S]{0,200}?entryKind: "normal",\s*entryDate: dateOnly\("2026-08-31"\),\s*fiscalYearCode: FISCAL_YEAR_CODE,\s*description: "Enfriadora · certificación 1"/);
    assert.match(seed, /accountCode: "212", debit: "31500\.00", credit: "0\.00"/);
    assert.match(seed, /accountCode: "572", debit: "0\.00", credit: "31500\.00"/);
    assert.match(seed, /entryNumber: existing\?\.entryNumber \?\? \(max \?\? 0\) \+ 1/, "numeración por ejercicio sin colisiones");
  });

  it("activo B: tenencia arrendamiento_industria vigente (2020-2035, preaviso 12, 32.000 + 4 % GOR, IPC enero, fianza 64.000, IBI arrendatario, retención) e IBI propietario_tercero solo calendario", () => {
    assert.match(seed, /export const COUNTERPARTY_NAME = "Inmuebles Demo Sur SL"/);
    assert.match(seed, /id: TENURE_B_ID,\s*assetId: ASSET_B_ID,\s*kind: "arrendamiento_industria",\s*counterpartyName: COUNTERPARTY_NAME,\s*counterpartyTaxId: COUNTERPARTY_TAX_ID/);
    assert.match(seed, /startDate: dateOnly\("2020-01-01"\),\s*endDate: dateOnly\("2035-12-31"\),\s*noticeMonths: 12/);
    assert.match(seed, /rentKind: "mixta",\s*rentMonthly: "32000\.00",\s*rentVariablePct: "4\.00",\s*rentVariableBase: "gor",\s*rentReviewIndex: "ipc",\s*rentReviewMonth: 1,\s*depositAmount: "64000\.00"/);
    assert.match(seed, /withholdingApplies: true,[\s\S]{0,80}?ibiPayer: "arrendatario"/);
    assert.match(seed, /kind: "arrendamiento_industria",[\s\S]{0,900}?status: "vigente"/);
    assert.match(seed, /currentTenureKind: "arrendamiento_industria"/);
    assert.match(seed, /id: "ptx_act_b_ibi",[\s\S]{0,200}?kind: "ibi",\s*taxpayer: "propietario_tercero"/);
    assert.doesNotMatch(seed, /taxId: "ptx_act_b_ibi"/, "el IBI del Sur no genera recibos (solo calendario)");
  });

  it("no contiene ningún apellido real ni nombres de personas (usuarios con nombre de puesto)", () => {
    const names = [...seed.matchAll(/"([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)"/g)].map((m) => m[1]);
    const lower = new Set(names.map((n) => n.toLowerCase()));
    for (const surname of SURNAME_BLACKLIST) assert.ok(!lower.has(surname.toLowerCase()), `apellido real en el seed: ${surname}`);
    for (const fullName of ["Gestión de activos ACT", "Contabilidad ACT", "Dirección ACT Norte", "Recepción ACT Norte"]) {
      assert.ok(seed.includes(`fullName: "${fullName}"`), `usuario con nombre de puesto: ${fullName}`);
    }
    assert.doesNotMatch(seed, /\b[A-Z]\d{7}[A-Z]\b|\b\d{8}[A-Z]\b/, "ningún NIF/DNI literal: los CIF salen de cifFor");
  });

  it("los deleteMany van acotados a prop_act_* (deleteScoped o ids de padres leídos con ese filtro); nunca toca Faranda ni otros tenants", () => {
    const calls = [...seed.matchAll(/deleteMany\(/g)];
    assert.equal(calls.length, 3, "deleteScoped + líneas de asiento + partidas (por id de padre acotado)");
    assert.match(seed, /const where = \{ \.\.\.extraWhere, propertyId: \{ in: \[\.\.\.PROPERTY_IDS\] \} \};/);
    assert.match(seed, /prisma\.journalEntry\.findMany\(\{ where: \{ propertyId: \{ in: \[\.\.\.PROPERTY_IDS\] \}, id: \{ startsWith: "je_act_" \} \}/);
    assert.match(seed, /prisma\.journalLine\.deleteMany\(\{ where: \{ journalEntryId: \{ in: entries\.map\(\(row\) => row\.id\) \} \} \}\)/);
    assert.match(seed, /prisma\.capexProject\.findMany\(\{ where: \{ propertyId: \{ in: \[\.\.\.PROPERTY_IDS\] \}, id: \{ startsWith: "cpx_act_" \} \}/);
    assert.match(seed, /prisma\.capexItem\.deleteMany\(\{ where: \{ capexProjectId: \{ in: projects\.map\(\(row\) => row\.id\) \} \} \}\)/);
    assert.match(seed, /deleteScoped\("journalEntry", \{ id: \{ startsWith: "je_act_" \} \}\)/);
    assert.match(seed, /deleteScoped\("capexProject", \{ id: \{ startsWith: "cpx_act_" \} \}\)/);
    assert.match(seed, /deleteScoped\("realEstateAsset"\)/, "los satélites del activo caen en cascada");
    assert.match(seed, /if \(reset\) \{\s*const removed = await resetRealEstate\(\);/, "solo con --reset");
    assert.doesNotMatch(seed, /cmrhw9jy30002fyvb6tsdiugt|cmrhw9jy4|cmu4805|cmu1mifcp|org_123|prop_123|prop_canary|org_uxday|prop_uxday|org_chk|prop_chk/, "nunca toca Faranda (ids de organización/propiedades), el demo base, UXDAY ni CHK");
  });

  it("es idempotente y rearmable: upserts por id fijo que convergen al plan y recuento por tabla", () => {
    for (const model of ["realEstateAsset", "realEstateUnit", "realEstateCharge", "realEstateValuation", "realEstateTenure", "propertyTax", "propertyTaxReceipt", "realEstateDocument", "realEstateInspection", "realEstateInsurance", "capexProject", "capexItem"]) {
      assert.match(seed, new RegExp(`prisma\\.${model}\\.upsert\\(\\{ where: \\{ id: row\\.id \\}, update: row, create: row \\}\\)`), `${model} converge al plan`);
    }
    assert.match(seed, /prisma\.journalEntry\.upsert\(\{ where: \{ id: row\.id \}, update: row, create: row \}\)/);
    assert.match(seed, /prisma\.journalLine\.upsert\(\{ where: \{ id: lineRow\.id \}, update: lineRow, create: lineRow \}\)/);
    assert.match(seed, /update: \{ status: "active", passwordHash, mustChangePassword: false \}/, "la contraseña documentada vuelve a valer en cada pasada");
    assert.match(seed, /export async function countRows\(\): Promise<Record<string, number>>/);
    assert.match(seed, /\[seed-real-estate\] filas por tabla:/);
  });

  it("está en la allowlist demo (solo la organización), tiene script pnpm y tests/demo-seed-contract lo guarda", () => {
    assert.match(guard, /DEMO_ORG_IDS: readonly string\[\] = \["org_123", "org_uxday", "org_chk", "org_act", "org_hr"\]/);
    assert.match(guard, /DEMO_PROPERTY_IDS: readonly string\[\] = \["prop_123", "prop_canary", "prop_uxday", "prop_chk", "prop_hr"\]/, "prop_act_* no entra en la allowlist: los acota el propio seed");
    assert.equal(databasePackage.scripts["db:seed:real-estate"], "node --env-file=../../.env --import tsx prisma/seed-real-estate.ts");
    assert.match(demoSeedContract, /"seed-real-estate\.ts"/);
  });
});

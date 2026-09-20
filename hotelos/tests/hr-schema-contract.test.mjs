// Contrato de esquema, cifrado, claves y tipos wire de la Tanda RRHH (RRHH-1 · 2026-09-20).
//
// Sin TypeScript ni base de datos (mismos parsers por expresión regular que tests/rbac-sod-contract.test.mjs):
// lee packages/database/prisma/schema.prisma, la migración 20260920173000_rrhh_plantilla_nomina,
// packages/database/src/crypto-fields.ts, packages/shared/src/{permissions,types,index,hr-types}.ts,
// packages/product/src/modules/module-manifest.ts y tests/integration/helpers/l2-tenant.mts y fija lo que
// docs/design/RRHH-PLANTILLA-NOMINA.md §4, §6, §7.2 y §9 (recortados al alcance de la tanda) exigen de los DATOS:
//   - 6 modelos nuevos (Employee, CollectiveAgreement, AgreementRule, LaborStandard, StaffingPlan,
//     StaffingPlanLine) con sus tablas, claves únicas e índices y sin @relation (convención plana del bloque);
//   - 6 ampliaciones nulables o con default (StaffProfile, EmploymentContract, AbsenceRequest, LaborForecast,
//     PayrollPeriod, Property) que no rompen ninguna columna existente;
//   - la migración es la última de la cadena, aditiva (sin DROP, funciones, triggers ni vistas), con el SQL
//     del generador y el CHECK absence_requests_requested_ne_approved escrito a mano; la cadena sigue con 4 triggers;
//   - PII_FIELDS.Employee / LOOKUP_HASH_FIELDS.Employee y su espejo HR_PII_FIELDS;
//   - las 5 claves hr.* en PERMISSIONS (259), PermissionKey, plantillas (recon §3.2), manifiesto y sin revocaciones;
//   - ROLE_TEMPLATE_VERSION 5 aditiva; hr-types.ts exportado desde index.ts con DTOs, defaults, tipos 2026 y códigos;
//   - alias de padre en l2-tenant (AgreementRule → CollectiveAgreement, StaffingPlanLine → StaffingPlan).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const schema = read("../packages/database/prisma/schema.prisma");
const MIGRATION = "20260920173000_rrhh_plantilla_nomina";
const PREVIOUS_MIGRATION = "20260920160000_checkin_pago_en_recepcion";
const migrationsDir = new URL("../packages/database/prisma/migrations/", import.meta.url);
const migrationFolders = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const migration = read(`../packages/database/prisma/migrations/${MIGRATION}/migration.sql`);
const chainSql = migrationFolders.map((folder) => readFileSync(new URL(`${folder}/migration.sql`, migrationsDir), "utf8")).join("\n");
const cryptoFields = read("../packages/database/src/crypto-fields.ts");
const permissionsSource = read("../packages/shared/src/permissions.ts");
const typesSource = read("../packages/shared/src/types.ts");
const indexSource = read("../packages/shared/src/index.ts");
const hrTypes = read("../packages/shared/src/hr-types.ts");
const manifest = read("../packages/product/src/modules/module-manifest.ts");
const l2Tenant = read("../tests/integration/helpers/l2-tenant.mts");

const HR_KEYS = ["hr.employee.read", "hr.employee.manage", "hr.config.manage", "hr.standards.manage", "hr.staffing.approve"];
const EMPLOYEE_PII = ["taxId", "socialSecurityNumber", "email", "phone", "iban"];
const NEW_TABLES = {
  Employee: "employees",
  CollectiveAgreement: "collective_agreements",
  AgreementRule: "agreement_rules",
  LaborStandard: "labor_standards",
  StaffingPlan: "staffing_plans",
  StaffingPlanLine: "staffing_plan_lines"
};

// ---------------------------------------------------------------------------
// Parsers (sin TS)
// ---------------------------------------------------------------------------

function modelBlock(name) {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  assert.ok(match, `model ${name} exists`);
  return match[1];
}

/** `  name   Type  …` → { type, rest } o null. */
function fieldOf(block, name) {
  const match = new RegExp(`^\\s+${name}\\s+(\\S+)(.*)$`, "m").exec(block);
  return match ? { type: match[1], rest: match[2] } : null;
}

function stripLineComments(source) {
  return source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^"\n]*$/gm, "");
}

function parsePermissionCatalog(source) {
  const block = source.match(/export const PERMISSIONS[^{]*\{(.*?)\n\};/s);
  assert.ok(block, "PERMISSIONS block not found");
  return [...block[1].matchAll(/^\s*"([a-z_]+(?:\.[a-z_]+)+)":\s*"/gm)].map((m) => m[1]);
}

function parseArrayRecord(source, name, orgKeys) {
  const block = source.match(new RegExp(`export const ${name}[^{]*\\{(.*?)\\n\\};`, "s"));
  assert.ok(block, `${name} block not found`);
  const record = {};
  for (const m of stripLineComments(block[1]).matchAll(/^\s*(\w+):\s*\[(.*?)\]/gms)) {
    record[m[1]] = m[2].includes("ORG_PERMISSION_KEYS") ? new Set(orgKeys) : new Set([...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]));
  }
  return record;
}

function parseUnion(source, name) {
  const start = source.indexOf(`export type ${name} =`);
  assert.ok(start >= 0, `type ${name} not found`);
  const members = [];
  for (const line of source.slice(start).split("\n").slice(1)) {
    const code = line.replace(/\/\/.*$/, "");
    const m = code.match(/^\s*\|\s*"([^"]+)"\s*;?\s*$/);
    if (m) members.push(m[1]);
    if (/";\s*$/.test(code)) break;
  }
  return members;
}

/** `export const NAME = [ "a", "b" ] as const;` → ["a", "b"] */
function parseConstArray(source, name) {
  const block = source.match(new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`, "s"));
  assert.ok(block, `${name} not found`);
  return [...stripLineComments(block[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const catalog = parsePermissionCatalog(permissionsSource);
const catalogSet = new Set(catalog);
const orgKeys = catalog.filter((key) => !key.startsWith("admin.") && !key.startsWith("platform."));
const templates = parseArrayRecord(permissionsSource, "ROLE_PERMISSION_MAP", orgKeys);
const revocations = parseArrayRecord(permissionsSource, "ROLE_TEMPLATE_REVOCATIONS", orgKeys);
const permissionKeyUnion = parseUnion(typesSource, "PermissionKey");
const hotelTemplates = Object.keys(templates).filter((key) => key !== "break_glass");

// ---------------------------------------------------------------------------
// Esquema (recon §3.1)
// ---------------------------------------------------------------------------

describe("RRHH · esquema · 6 modelos nuevos (recon §3.1)", () => {
  it("cada modelo nuevo existe, mapea su tabla y sigue la convención plana (sin @relation)", () => {
    for (const [model, table] of Object.entries(NEW_TABLES)) {
      const block = modelBlock(model);
      assert.match(block, new RegExp(`@@map\\("${table}"\\)`), `${model} → ${table}`);
      assert.doesNotMatch(block, /@relation\(/, `${model} keeps the flat convention of the workforce block`);
      assert.match(block, /^\s+id\s+String\s+@id @default\(cuid\(\)\)/m, `${model}.id cuid`);
    }
  });

  it("Employee: expediente por sociedad con PII cifrada, taxIdLookupHash y las claves únicas e índice del diseño", () => {
    const block = modelBlock("Employee");
    for (const name of ["organizationId", "legalEntityId", "employeeNumber", "firstName", "lastName", "taxId", "hiredAt"]) {
      const field = fieldOf(block, name);
      assert.ok(field, `Employee.${name}`);
      assert.equal(field.type.endsWith("?"), false, `Employee.${name} is required`);
    }
    assert.equal(fieldOf(block, "taxId").type, "String");
    for (const name of ["userId", "taxIdLookupHash", "socialSecurityNumber", "email", "phone", "iban", "gender", "primaryPropertyId", "usaliDepartment", "jobTitle", "terminatedAt", "terminationReason"]) {
      const field = fieldOf(block, name);
      assert.ok(field, `Employee.${name}`);
      assert.ok(field.type.endsWith("?"), `Employee.${name} is nullable`);
    }
    assert.match(block, /^\s+status\s+String\s+@default\("active"\)/m);
    assert.match(block, /^\s+updatedAt\s+DateTime\s+@updatedAt/m);
    assert.match(block, /@@unique\(\[legalEntityId, employeeNumber\]\)/);
    assert.match(block, /@@unique\(\[legalEntityId, taxIdLookupHash\]\)/);
    assert.match(block, /@@index\(\[organizationId, status\]\)/);
    // Fuera de la tanda (plan-olas «Fuera»): nada de dirección, salud, retención ni contacto de emergencia en el expediente.
    for (const absent of ["birthDate", "disabilityPct", "retentionUntil", "legalHold", "emergencyContact", "address"]) assert.equal(fieldOf(block, absent), null, `Employee.${absent} is out of scope`);
  });

  it("CollectiveAgreement y AgreementRule: convenio por organización con reglas versionadas por validFrom", () => {
    const agreement = modelBlock("CollectiveAgreement");
    for (const name of ["organizationId", "code", "name", "validFrom"]) assert.ok(fieldOf(agreement, name), `CollectiveAgreement.${name}`);
    for (const name of ["scope", "publishedRef", "validTo"]) assert.ok(fieldOf(agreement, name)?.type.endsWith("?"), `CollectiveAgreement.${name} nullable`);
    assert.match(agreement, /^\s+ultraactivity\s+Boolean\s+@default\(false\)/m);
    assert.match(agreement, /@@unique\(\[organizationId, code\]\)/);
    const rule = modelBlock("AgreementRule");
    assert.equal(fieldOf(rule, "agreementId").type, "String");
    assert.equal(fieldOf(rule, "key").type, "String");
    assert.equal(fieldOf(rule, "valueJson").type, "Json");
    assert.equal(fieldOf(rule, "validFrom").type, "DateTime");
    assert.equal(fieldOf(rule, "validTo").type, "DateTime?");
    assert.match(rule, /@@unique\(\[agreementId, key, validFrom\]\)/);
  });

  it("LaborStandard: centro × departamento USALI × driver, sin jobCategoryId, con tramos, suplementos y factor de cobertura", () => {
    const block = modelBlock("LaborStandard");
    for (const name of ["propertyId", "usaliDepartment", "driver", "unit", "validFrom"]) assert.ok(fieldOf(block, name), `LaborStandard.${name}`);
    assert.match(block, /^\s+value\s+Decimal\s+@db\.Decimal\(10, 3\)/m);
    assert.equal(fieldOf(block, "bandsJson").type, "Json?");
    assert.match(block, /^\s+allowancePct\s+Decimal\s+@default\(0\)/m);
    assert.match(block, /^\s+coverageFactor\s+Decimal\s+@default\(1\.4\)/m);
    assert.match(block, /^\s+source\s+String\s+@default\("sector_default"\)/m);
    assert.equal(fieldOf(block, "jobCategoryId"), null, "JobCategory is out of the tanda");
    assert.match(block, /@@unique\(\[propertyId, usaliDepartment, driver, validFrom\]\)/);
  });

  it("StaffingPlan y StaffingPlanLine: plantilla máxima por centro × año × temporada con aprobación (createdBy ≠ approvedBy en servicio)", () => {
    const plan = modelBlock("StaffingPlan");
    assert.equal(fieldOf(plan, "year").type, "Int");
    assert.equal(fieldOf(plan, "season").type, "String");
    assert.equal(fieldOf(plan, "fromMonth").type, "Int");
    assert.equal(fieldOf(plan, "toMonth").type, "Int");
    assert.match(plan, /^\s+status\s+String\s+@default\("draft"\)/m);
    for (const name of ["createdBy", "approvedBy", "approvedAt"]) assert.ok(fieldOf(plan, name)?.type.endsWith("?"), `StaffingPlan.${name} nullable`);
    assert.match(plan, /@@unique\(\[propertyId, year, season\]\)/);
    const line = modelBlock("StaffingPlanLine");
    assert.equal(fieldOf(line, "planId").type, "String");
    assert.equal(fieldOf(line, "usaliDepartment").type, "String");
    assert.match(line, /^\s+maxFte\s+Decimal\s+@map\("max_fte"\) @db\.Decimal\(6, 2\)/m);
    assert.equal(fieldOf(line, "maxHeadcount").type, "Int?");
    assert.equal(fieldOf(line, "budgetMonthlyCost").type, "Decimal?");
    assert.match(line, /@@unique\(\[planId, usaliDepartment\]\)/);
  });
});

describe("RRHH · esquema · 6 ampliaciones nulables o con default (recon §3.1)", () => {
  it("StaffProfile gana employeeId / usaliDepartment / jobTitle (nulables) e índice; userId sigue NOT NULL", () => {
    const block = modelBlock("StaffProfile");
    assert.match(block, /^\s+userId\s+String\s+@map\("user_id"\)/m, "userId stays required (export.service, staff-profiles.service)");
    for (const name of ["employeeId", "usaliDepartment", "jobTitle"]) assert.equal(fieldOf(block, name)?.type, "String?", `StaffProfile.${name}`);
    assert.match(block, /@@index\(\[employeeId, active\]\)/);
    assert.match(block, /@@index\(\[propertyId, active\]\)/);
  });

  it("EmploymentContract gana agreementId, weeklyHours, partTimePct, fixedDiscontinuous (default false), contributionGroup y endReason; conserva socialSecurityCategory", () => {
    const block = modelBlock("EmploymentContract");
    assert.equal(fieldOf(block, "agreementId").type, "String?");
    assert.match(block, /^\s+weeklyHours\s+Decimal\?\s+@db\.Decimal\(5, 2\)/m);
    assert.match(block, /^\s+partTimePct\s+Decimal\?\s+@db\.Decimal\(5, 2\)/m);
    assert.match(block, /^\s+fixedDiscontinuous\s+Boolean\s+@default\(false\)/m);
    assert.equal(fieldOf(block, "contributionGroup").type, "Int?");
    assert.equal(fieldOf(block, "endReason").type, "String?");
    assert.equal(fieldOf(block, "socialSecurityCategory").type, "String?", "deprecated but kept (no backfill)");
    assert.match(block, /^\s+payCount\s+Int\s+@default\(14\)/m);
  });

  it("AbsenceRequest gana requestedBy, decidedAt y reason (nulables) y conserva approvedBy", () => {
    const block = modelBlock("AbsenceRequest");
    assert.equal(fieldOf(block, "requestedBy").type, "String?");
    assert.equal(fieldOf(block, "decidedAt").type, "DateTime?");
    assert.equal(fieldOf(block, "reason").type, "String?");
    assert.equal(fieldOf(block, "approvedBy").type, "String?");
    assert.match(block, /absence_requests_requested_ne_approved/, "the CHECK is documented next to the columns");
  });

  it("LaborForecast gana usaliDepartment (default \"all\"), source, driversJson, requiredFte, estimatedCost, generatedAt y la clave única; conserva requiredLaborHours", () => {
    const block = modelBlock("LaborForecast");
    assert.match(block, /^\s+usaliDepartment\s+String\s+@default\("all"\)/m);
    assert.equal(fieldOf(block, "source").type, "String?");
    assert.match(block, /^\s+driversJson\s+Json\s+@default\("\{\}"\)/m);
    assert.match(block, /^\s+requiredFte\s+Decimal\?\s+@map\("required_fte"\) @db\.Decimal\(8, 2\)/m);
    assert.match(block, /^\s+estimatedCost\s+Decimal\?\s+@map\("estimated_cost"\) @db\.Decimal\(14, 2\)/m);
    assert.equal(fieldOf(block, "generatedAt").type, "DateTime?");
    assert.match(block, /@@unique\(\[propertyId, forecastDate, usaliDepartment\]\)/);
    assert.match(block, /@@index\(\[propertyId, forecastDate\]\)/);
    assert.match(block, /^\s+requiredLaborHours\s+Decimal\?/m, "dashboards/workforce.service keeps reading requiredLaborHours");
  });

  it("PayrollPeriod gana mode (default \"external\") y closedAt; Property gana agreementId", () => {
    const period = modelBlock("PayrollPeriod");
    assert.match(period, /^\s+mode\s+String\s+@default\("external"\)/m);
    assert.equal(fieldOf(period, "closedAt").type, "DateTime?");
    assert.match(period, /^\s+approvedByUserId\s+String\?/m);
    assert.match(period, /@@unique\(\[organizationId, periodCode, propertyId\]\)/);
    const property = modelBlock("Property");
    assert.match(property, /^\s+agreementId\s+String\?\s+@map\("agreement_id"\)/m);
  });
});

describe("RRHH · migración 20260920173000_rrhh_plantilla_nomina (aditiva, SQL del generador + CHECK a mano)", () => {
  it("es la última carpeta de la cadena, posterior a 20260920160000_checkin_pago_en_recepcion, con cabecera de la casa", () => {
    assert.equal(migrationFolders.at(-1), MIGRATION);
    assert.ok(MIGRATION > PREVIOUS_MIGRATION);
    assert.ok(migrationFolders.includes(PREVIOUS_MIGRATION));
    assert.ok(existsSync(new URL(`${MIGRATION}/migration.sql`, migrationsDir)));
    assert.match(migration, /^-- 20260920173000_rrhh_plantilla_nomina · RRHH \/ plantilla, convenio, estándares y nómina \(Tanda RRHH · RRHH-1\)$/m);
    assert.match(migration, /prisma migrate diff --from-schema-datasource/);
    assert.match(migration, /ADITIVA/);
    assert.match(migration, /Reversible/);
  });

  it("crea las 6 tablas, añade solo columnas nulables o con default a las 6 tablas ampliadas y crea los índices", () => {
    for (const table of Object.values(NEW_TABLES)) assert.match(migration, new RegExp(`^CREATE TABLE "${table}" \\($`, "m"), `CREATE TABLE ${table}`);
    assert.equal((migration.match(/^CREATE TABLE "/gm) ?? []).length, 6);
    const added = {
      staff_profiles: ["employee_id", "usali_department", "job_title"],
      employment_contracts: ["agreement_id", "weekly_hours", "part_time_pct", "fixed_discontinuous", "contribution_group", "end_reason"],
      absence_requests: ["requested_by", "decided_at", "reason"],
      labor_forecasts: ["usali_department", "source", "drivers_json", "required_fte", "estimated_cost", "generated_at"],
      payroll_periods: ["mode", "closed_at"],
      properties: ["agreement_id"]
    };
    for (const [table, columns] of Object.entries(added)) {
      const block = migration.match(new RegExp(`^ALTER TABLE "${table}" ADD COLUMN[\\s\\S]*?;$`, "m"));
      assert.ok(block, `ALTER TABLE ${table}`);
      for (const column of columns) assert.match(block[0], new RegExp(`ADD COLUMN\\s+"${column}" `), `${table}.${column}`);
    }
    // Ninguna columna añadida es NOT NULL sin DEFAULT (las filas existentes de Faranda no se reescriben).
    for (const line of migration.split("\n").filter((l) => /ADD COLUMN/.test(l))) {
      if (/NOT NULL/.test(line)) assert.match(line, /NOT NULL DEFAULT /, `NOT NULL without default: ${line.trim()}`);
    }
    assert.match(migration, /^ALTER TABLE "labor_forecasts" ADD COLUMN[\s\S]*?"usali_department" TEXT NOT NULL DEFAULT 'all';$/m);
    assert.match(migration, /^ALTER TABLE "payroll_periods" ADD COLUMN[\s\S]*?"mode" TEXT NOT NULL DEFAULT 'external'/m);
    assert.match(migration, /"fixed_discontinuous" BOOLEAN NOT NULL DEFAULT false/);
    for (const index of [
      'CREATE UNIQUE INDEX "employees_legal_entity_id_employee_number_key"',
      'CREATE UNIQUE INDEX "employees_legal_entity_id_tax_id_lookup_hash_key"',
      'CREATE INDEX "employees_organization_id_status_idx"',
      'CREATE UNIQUE INDEX "collective_agreements_organization_id_code_key"',
      'CREATE UNIQUE INDEX "agreement_rules_agreement_id_key_valid_from_key"',
      'CREATE UNIQUE INDEX "labor_standards_property_id_usali_department_driver_valid_f_key"',
      'CREATE UNIQUE INDEX "staffing_plans_property_id_year_season_key"',
      'CREATE UNIQUE INDEX "staffing_plan_lines_plan_id_usali_department_key"',
      'CREATE UNIQUE INDEX "labor_forecasts_property_id_forecast_date_usali_department_key"',
      'CREATE INDEX "staff_profiles_employee_id_active_idx"'
    ]) assert.ok(migration.includes(index), index);
    assert.equal((migration.match(/^CREATE UNIQUE INDEX "/gm) ?? []).length, 8);
    assert.equal((migration.match(/^CREATE INDEX "/gm) ?? []).length, 2);
  });

  it("lleva el CHECK absence_requests_requested_ne_approved escrito a mano y nada de DROP, funciones, triggers, vistas ni extensiones", () => {
    assert.match(
      migration,
      /^ALTER TABLE "absence_requests" ADD CONSTRAINT "absence_requests_requested_ne_approved" CHECK \("requested_by" IS NULL OR "approved_by" IS NULL OR "requested_by" <> "approved_by"\);$/m
    );
    assert.equal((migration.match(/ADD CONSTRAINT "\w+" CHECK/g) ?? []).length, 1, "the CHECK is the only hand-written statement");
    assert.doesNotMatch(migration, /^(DROP|ALTER TABLE "\w+" DROP|CREATE EXTENSION|CREATE (OR REPLACE )?FUNCTION|CREATE TRIGGER|CREATE (OR REPLACE )?VIEW|UPDATE |DELETE |INSERT )/m);
    assert.doesNotMatch(migration, /FOREIGN KEY/, "flat convention: no FK (one FOREIGN KEY per @relation is the chain invariant)");
    // scripts/check-fresh-install.sh censa los triggers de la cadena: la tanda no añade ninguno (siguen 4).
    assert.equal((chainSql.match(/^CREATE TRIGGER /gm) ?? []).length, 4);
  });
});

// ---------------------------------------------------------------------------
// Cifrado (recon §3.1 · PII)
// ---------------------------------------------------------------------------

describe("RRHH · cifrado · PII_FIELDS.Employee y LOOKUP_HASH_FIELDS.Employee (patrón Guest)", () => {
  it("registra taxId, socialSecurityNumber, email, phone e iban, y solo taxId lleva sibling de hash", () => {
    const pii = cryptoFields.match(/export const PII_FIELDS[\s\S]*?\n\};/);
    assert.ok(pii, "PII_FIELDS block");
    const employee = pii[0].match(/^\s*Employee:\s*\[([^\]]*)\]/m);
    assert.ok(employee, "PII_FIELDS.Employee");
    assert.deepEqual([...employee[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), EMPLOYEE_PII);
    const lookup = cryptoFields.match(/export const LOOKUP_HASH_FIELDS = \{([\s\S]*?)\n\} as const;/);
    assert.ok(lookup, "LOOKUP_HASH_FIELDS block");
    const employeeLookup = lookup[1].match(/^\s*Employee:\s*\{([^}]*)\}/m);
    assert.ok(employeeLookup, "LOOKUP_HASH_FIELDS.Employee");
    assert.deepEqual([...employeeLookup[1].matchAll(/(\w+):\s*"(\w+)"/g)].map((m) => [m[1], m[2]]), [["taxId", "taxIdLookupHash"]]);
  });

  it("cada campo PII y el hash son columnas de Employee; el nombre y el número de empleado quedan en claro (listados)", () => {
    const block = modelBlock("Employee");
    for (const name of [...EMPLOYEE_PII, "taxIdLookupHash"]) assert.ok(fieldOf(block, name), `Employee.${name} column`);
    for (const plain of ["firstName", "lastName", "employeeNumber"]) assert.equal(EMPLOYEE_PII.includes(plain), false, `${plain} is not encrypted`);
    assert.deepEqual(parseConstArray(hrTypes, "HR_PII_FIELDS"), EMPLOYEE_PII, "HR_PII_FIELDS mirrors PII_FIELDS.Employee");
  });
});

// ---------------------------------------------------------------------------
// RBAC (recon §3.2)
// ---------------------------------------------------------------------------

describe("RRHH · RBAC · 5 claves hr.* (recon §3.2)", () => {
  it("las 5 claves existen en PERMISSIONS (259) y en PermissionKey, con descripción, sin ámbito de plataforma", () => {
    assert.equal(catalog.length, 259);
    assert.deepEqual([...catalog].sort(), [...permissionKeyUnion].sort());
    for (const key of HR_KEYS) {
      assert.ok(catalogSet.has(key), `${key} not in PERMISSIONS`);
      assert.ok(permissionKeyUnion.includes(key), `${key} not in PermissionKey`);
      assert.match(permissionsSource, new RegExp(`^\\s*"${key.replace(/\./g, "\\.")}": "[^"]{20,}",?$`, "m"), `${key}: description`);
      assert.equal(key.startsWith("admin.") || key.startsWith("platform."), false);
    }
  });

  it("plantillas: payroll_hr (4 hr.* + compliance.read, sin staffing.approve ni users.read), general_manager (read + staffing.approve), manager / operations_director / owner (read)", () => {
    const holders = (key) => hotelTemplates.filter((template) => templates[template].has(key));
    assert.deepEqual(holders("hr.employee.read").sort(), ["general_manager", "manager", "operations_director", "owner", "payroll_hr"]);
    assert.deepEqual(holders("hr.employee.manage"), ["payroll_hr"]);
    assert.deepEqual(holders("hr.config.manage"), ["payroll_hr"]);
    assert.deepEqual(holders("hr.standards.manage"), ["payroll_hr"]);
    assert.deepEqual(holders("hr.staffing.approve"), ["general_manager"]);
    assert.ok(templates.payroll_hr.has("compliance.read"));
    assert.equal(templates.payroll_hr.has("users.read"), false, "T8a decision kept: payroll_hr without users.read");
    assert.equal(templates.payroll_hr.size, 18, "payroll_hr v3 = 13 keys + 4 hr.* + compliance.read");
    // SoD estática {payroll.manage, hr.staffing.approve}: ninguna plantilla reúne ambas.
    for (const template of hotelTemplates) assert.equal(templates[template].has("payroll.manage") && templates[template].has("hr.staffing.approve"), false, template);
    for (const key of HR_KEYS) for (const template of Object.keys(revocations)) assert.equal(revocations[template].has(key), false, `${template} revokes ${key}`);
  });

  it("ROLE_TEMPLATE_VERSION = 5 con nota «Version 5 (Tanda RRHH» y el manifiesto workforce_labor lleva las 5 claves", () => {
    assert.match(permissionsSource, /export const ROLE_TEMPLATE_VERSION = 5;/);
    assert.match(permissionsSource, /Version 5 \(Tanda RRHH/);
    const module = manifest.match(/code: "workforce_labor",[\s\S]*?permissions: \[([^\]]*)\]/);
    assert.ok(module, "workforce_labor module block");
    const permissions = [...module[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const key of [...HR_KEYS, "workforce.read", "workforce.schedule.manage", "workforce.timeclock.manage", "workforce.labor_cost.view"]) assert.ok(permissions.includes(key), `manifest: ${key}`);
    for (const key of permissions) assert.ok(catalogSet.has(key), `manifest key ${key} not in PERMISSIONS`);
  });
});

// ---------------------------------------------------------------------------
// Tipos wire (recon §3.3)
// ---------------------------------------------------------------------------

describe("RRHH · hr-types.ts (recon §3.3) exportado desde index.ts", () => {
  it("index.ts reexporta hr-types y el fichero declara los DTOs, vocabularios, defaults y códigos acordados", () => {
    assert.match(indexSource, /^export \* from "\.\/hr-types\.js";$/m);
    for (const name of [
      "EmployeeSummaryDto", "EmployeeDetailDto", "EmployeePiiDto", "EmployeeContractSummaryDto", "CollectiveAgreementDto", "AgreementRuleDto",
      "LaborStandardDto", "StaffingPlanDto", "StaffingPlanLineDto", "LaborForecastDayDto", "HrKpisDto", "HrAlertDto", "PayrollIncidenceRow",
      "LaborCostPanelDto", "LaborCostPanelCentreDto", "LaborCostPanelMonthDto", "LaborCostPanelDepartmentDto", "HrDegradedEntry"
    ]) assert.match(hrTypes, new RegExp(`^export interface ${name}\\b`, "m"), `interface ${name}`);
    for (const name of [
      "EMPLOYEE_STATUSES", "HR_PII_FIELDS", "HR_USALI_DEPARTMENTS", "ABSENCE_TYPES", "HR_AGREEMENT_CODES", "HR_AGREEMENT_RULE_KEYS",
      "LABOR_STANDARD_DRIVERS", "LABOR_STANDARD_UNITS", "LABOR_STANDARD_SOURCES", "STAFFING_SEASONS", "STAFFING_PLAN_STATUSES",
      "LABOR_FORECAST_SOURCES", "PAYROLL_PERIOD_MODES", "HR_ALERT_KINDS", "HR_RULE_KEYS", "PAYROLL_INCIDENCE_KINDS",
      "HR_AGREEMENT_DEFAULTS", "HR_STANDARD_DEFAULTS", "PAYROLL_RATES_2026", "HR_ERROR_CODES", "HR_ERROR_MESSAGES_ES", "HR_AUDIT_ACTIONS"
    ]) assert.match(hrTypes, new RegExp(`^export const ${name}\\b`, "m"), `const ${name}`);
    assert.match(hrTypes, /^export function hrStarBandOf\(/m);
  });

  it("vocabularios: estados, tipos de ausencia tasados, drivers/unidades/orígenes de estándar, temporadas, orígenes de previsión y modos de nómina", () => {
    assert.deepEqual(parseConstArray(hrTypes, "EMPLOYEE_STATUSES"), ["active", "inactive", "leave"]);
    assert.deepEqual(parseConstArray(hrTypes, "ABSENCE_TYPES"), ["vacation", "it_common", "it_accident", "permit_paid", "permit_unpaid", "maternity", "unjustified", "strike", "compensatory_rest"]);
    assert.deepEqual(parseConstArray(hrTypes, "LABOR_STANDARD_DRIVERS"), ["occupied_rooms", "departures", "stayovers", "arrivals", "pax", "covers_breakfast", "covers_restaurant", "rooms_inventory", "fixed"]);
    assert.deepEqual(parseConstArray(hrTypes, "LABOR_STANDARD_UNITS"), ["minutes_per_unit", "units_per_shift", "fte_per_100", "posts_by_band"]);
    assert.deepEqual(parseConstArray(hrTypes, "LABOR_STANDARD_SOURCES"), ["sector_default", "measured", "agreement"]);
    assert.deepEqual(parseConstArray(hrTypes, "STAFFING_SEASONS"), ["high", "shoulder", "low"]);
    assert.deepEqual(parseConstArray(hrTypes, "STAFFING_PLAN_STATUSES"), ["draft", "approved"]);
    assert.deepEqual(parseConstArray(hrTypes, "LABOR_FORECAST_SOURCES"), ["otb", "pms_forecast", "deterministic", "actual", "manual"]);
    assert.deepEqual(parseConstArray(hrTypes, "PAYROLL_PERIOD_MODES"), ["external", "calculated"]);
    assert.deepEqual(parseConstArray(hrTypes, "HR_AGREEMENT_CODES"), ["ES-15-HOST", "ES-33-HOST", "ES-39-HOST", "ES-28-HOSP"]);
    assert.equal(parseConstArray(hrTypes, "HR_AGREEMENT_RULE_KEYS").length, 21);
    assert.deepEqual(parseConstArray(hrTypes, "HR_RULE_KEYS"), ["rest_between_shifts", "max_daily_hours", "weekly_rest", "overtime_annual"]);
    for (const kind of ["overstaffed", "understaffed", "over_approved", "forecast_degraded"]) assert.ok(parseConstArray(hrTypes, "HR_ALERT_KINDS").includes(kind), kind);
  });

  it("HR_AGREEMENT_DEFAULTS: jornada, pagas y vacaciones de los 4 convenios (diseño §2.3 / §6.1)", () => {
    const expected = {
      "ES-15-HOST": { annual_hours: 1792, extra_pay_count: 3, vacation_days: 30, fd_call_notice_days: 10, overtime_pct: 25 },
      "ES-33-HOST": { annual_hours: 1782, extra_pay_count: 3, vacation_days: 30, fd_call_notice_days: 7, overtime_pct: 75, max_daily_hours: 8 },
      "ES-39-HOST": { annual_hours: 1766, extra_pay_count: 3, vacation_days: 32, fd_call_notice_days: 7, overtime_pct: 75 },
      "ES-28-HOSP": { annual_hours: 1800, extra_pay_count: 2, vacation_days: 30, fd_max_delay_days: 20, overtime_pct: 100 }
    };
    const defaults = hrTypes.match(/export const HR_AGREEMENT_DEFAULTS[\s\S]*?\n\};/);
    assert.ok(defaults, "HR_AGREEMENT_DEFAULTS block");
    for (const [code, rules] of Object.entries(expected)) {
      const block = defaults[0].match(new RegExp(`"${code}": \\{([\\s\\S]*?)\\n  \\}`, "m"));
      assert.ok(block, `defaults for ${code}`);
      assert.match(block[1], new RegExp(`code: "${code}"`));
      for (const [key, value] of Object.entries(rules)) assert.match(block[1], new RegExp(`^\\s+${key}: ${value},?$`, "m"), `${code}.${key} = ${value}`);
      assert.match(block[1], /rest_between_shifts_h: 12/);
      assert.match(block[1], /overtime_max_year: 80/);
    }
  });

  it("HR_STANDARD_DEFAULTS por estrellas 2/3/4 (diseño §6.2) y PAYROLL_RATES_2026 = 6,50 / 32,15 (Orden PJC/297/2026)", () => {
    const standards = hrTypes.match(/export const HR_STANDARD_DEFAULTS[\s\S]*?\n\};/);
    assert.ok(standards, "HR_STANDARD_DEFAULTS block");
    for (const band of ["4", "3", "2"]) assert.match(standards[0], new RegExp(`^  ${band}: \\[`, "m"), `band ${band}★`);
    assert.match(standards[0], /roomsStandards\(20, 32, 5, 12\)/, "4★ pisos 20/32/5 min, 12 %");
    assert.match(standards[0], /roomsStandards\(18, 30, 5, 12\)/, "3★ pisos 18/30/5 min, 12 %");
    assert.match(standards[0], /roomsStandards\(16, 28, 4, 10\)/, "2★ pisos 16/28/4 min, 10 %");
    assert.match(standards[0], /pomStandard\(1\.4\)/);
    assert.match(standards[0], /pomStandard\(1\.2\)/);
    assert.match(standards[0], /pomStandard\(1\.0\)/);
    assert.match(hrTypes, /const COVERAGE_FACTOR_DEFAULT = "1\.40";/);
    const rates = hrTypes.match(/export const PAYROLL_RATES_2026 = \{([\s\S]*?)\} as const;/);
    assert.ok(rates, "PAYROLL_RATES_2026");
    assert.match(rates[1], /employeePct: "6\.50"/);
    assert.match(rates[1], /employerPct: "32\.15"/);
    assert.match(rates[1], /maxBaseMonthly: "5101\.20"/);
    assert.match(rates[1], /minBaseMonthly: "1424\.40"/);
  });

  it("HR_ERROR_CODES cubre los códigos de las rutas y cada uno tiene mensaje en español; el listado de empleados no lleva PII", () => {
    const codes = parseConstArray(hrTypes, "HR_ERROR_CODES");
    for (const code of ["HR_EMPLOYEE_REQUIRED", "HR_EMPLOYEE_TAXID_DUPLICATE", "APPROVAL_SELF_DECISION", "HR_STAFFING_EXCEEDED", "HR_RULE_VIOLATION", "HR_TAXID_INVALID", "HR_PII_KEY_MISSING", "VALIDATION_ERROR"]) assert.ok(codes.includes(code), code);
    const messages = hrTypes.match(/export const HR_ERROR_MESSAGES_ES[\s\S]*?\n\};/);
    assert.ok(messages, "HR_ERROR_MESSAGES_ES");
    for (const code of codes) assert.match(messages[0], new RegExp(`^\\s+${code}: "[^"]+"`, "m"), `message for ${code}`);
    assert.ok(parseConstArray(hrTypes, "HR_AUDIT_ACTIONS").includes("HR_PII_READ"));
    const summary = hrTypes.match(/export interface EmployeeSummaryDto \{([\s\S]*?)\n\}/);
    assert.ok(summary, "EmployeeSummaryDto");
    for (const field of EMPLOYEE_PII) assert.doesNotMatch(summary[1], new RegExp(`^\\s+${field}\\b`, "m"), `EmployeeSummaryDto never carries ${field}`);
    const detail = hrTypes.match(/export interface EmployeeDetailDto extends EmployeeSummaryDto \{([\s\S]*?)\n\}/);
    assert.ok(detail, "EmployeeDetailDto");
    assert.match(detail[1], /^\s+pii: EmployeePiiDto \| null;/m);
    assert.match(detail[1], /^\s+piiFields: HrPiiField\[\];/m);
  });
});

// ---------------------------------------------------------------------------
// Tenants de prueba (l2-tenant)
// ---------------------------------------------------------------------------

describe("RRHH · l2-tenant · alias de padre para los hijos sin columna de propietario", () => {
  it("AgreementRule.agreementId → CollectiveAgreement y StaffingPlanLine.planId → StaffingPlan", () => {
    const aliases = l2Tenant.match(/const PARENT_ALIASES[\s\S]*?\n\};/);
    assert.ok(aliases, "PARENT_ALIASES block");
    assert.match(aliases[0], /^\s+AgreementRule: \{ agreementId: "CollectiveAgreement" \}/m);
    assert.match(aliases[0], /^\s+StaffingPlanLine: \{ planId: "StaffingPlan" \}/m);
    // Los demás modelos nuevos llevan organizationId / propertyId y entran en el barrido genérico.
    for (const model of ["Employee", "CollectiveAgreement"]) assert.ok(fieldOf(modelBlock(model), "organizationId"), `${model}.organizationId`);
    for (const model of ["LaborStandard", "StaffingPlan"]) assert.ok(fieldOf(modelBlock(model), "propertyId"), `${model}.propertyId`);
  });
});

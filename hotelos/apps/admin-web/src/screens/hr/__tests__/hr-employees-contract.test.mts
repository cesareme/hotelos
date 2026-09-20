import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EMPLOYEE_SEGMENT_OPTIONS, employeeDetailQuery, employeeListQuery } from "../../../services/hr-contracts";

// Tanda RRHH · RRHH-8 (diseño docs/design/RRHH-PLANTILLA-NOMINA.md §10
// «Plantilla»; recon RRHH/recon-delta.md §3.10): la pestaña Plantilla, su cajón
// y los servicios detrás se pinan sobre el fuente — la pantalla alcanza
// api-client (import.meta.env) y no carga bajo node --test, como
// payroll-cost-screen-contract.test.mts. Pins: reglas Cocoa 22 (0 `style={`,
// sin elementos crudos, sin colores literales, sin emoji, sin `fetch`), las
// columnas de la tabla y la ausencia de PII en ella, la búsqueda por nombre /
// número, el CocoaSegmentedControl Activos · Bajas · Fijos discontinuos, las
// puertas de lectura y escritura con las concesiones reales, el cajón lg con
// Datos · Contrato · Baja, el «Mostrar» explícito de la PII, la baja con
// diálogo destructivo y la superficie de servicios (apiRequest, nunca fetch).
// Desde apps/admin-web:
//   node --import ../api/node_modules/tsx/dist/loader.mjs --test src/screens/hr/__tests__/hr-employees-contract.test.mts

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const screen = source("../HrEmployeesScreen.tsx");
const drawer = source("../EmployeeDrawer.tsx");
const form = source("../employee-form.ts");
const api = source("../../../services/hrApi.ts");
const contracts = source("../../../services/hr-contracts.ts");

/** Rules 1-5, 9-11 of tests/cocoa-22-contract.test.mjs, applied to one file. */
function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/, `${name}: no transition: all, fixed position nor numeric zIndex`);
  assert.doesNotMatch(src, /\bfetch\s*\(/, `${name}: no raw fetch`);
  assert.equal(count(src, /\bstyle=\{/g), 0, `${name}: born without inline styles`);
}

/** Source without comments (the header comments name PII fields and hooks on purpose). */
function stripComments(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Import lines of a source (what the module reaches). */
const imports = (src: string) => src.match(/^import[\s\S]*?from\s+"[^"]+";/gm) ?? [];

describe("Plantilla · HrEmployeesScreen (RRHH-8)", () => {
  it("keeps the Cocoa 22 rules with zero inline styles and only Cocoa components", () => {
    assertCocoaRules("HrEmployeesScreen.tsx", screen);
    assertCocoaRules("EmployeeDrawer.tsx", drawer);
    for (const src of [screen, drawer]) {
      const componentImports = imports(src).filter((line) => /from "\.\.\/\.\.\/components\//.test(line));
      for (const line of componentImports) assert.match(line, /components\/(cocoa|Toast|finance\/FinanceScopeSelector)"/, `only Cocoa components (or the shell toast / finance scope): ${line}`);
    }
  });

  it("is a hosted CocoaPage «Plantilla» without a subtitle of its own, with the ONE «Ámbito» of Finanzas and its eyebrow", () => {
    assert.match(screen, /<CocoaPage\s+eyebrow=\{finance\.eyebrow\("Finanzas"\)\}\s+title="Plantilla"/);
    assert.doesNotMatch(screen, /<CocoaPage[\s\S]*?\bsubtitle=/, "the container (NominasTabs) paints the subtitle");
    assert.match(screen, /useFinanceScope\(financeScopePolicy\("HrEmployeesScreen"\)\)/);
    assert.match(screen, /<FinanceScopeSelector scope=\{finance\} \/>/);
    assert.match(screen, /export function HrEmployeesScreen\(\)/);
  });

  it("«Vencimiento» paints «—» for a file without contract, never «Indefinido» (RF-15)", () => {
    assert.match(screen, /if \(!row\.contract\) return "—";\s*const expiry = contractExpiry\(row\.contractEndsAt, today\);/);
  });

  it("paints the promised columns (nombre · nº · centro · puesto · departamento USALI · contrato/jornada · estado · vencimiento) and never a NIF, NAF, IBAN, email or phone", () => {
    for (const label of ["Nombre", "Nº", "Centro", "Puesto", "Departamento", "Contrato / jornada", "Estado", "Vencimiento"]) assert.match(screen, new RegExp(`label: "${label}"`), `column ${label}`);
    assert.doesNotMatch(stripComments(screen), /taxId|socialSecurityNumber|\biban\b|\bemail\b|\bphone\b|\bpii\b/i, "the list never touches PII fields");
    assert.match(screen, /contractSummaryLabel\(row\.contract\)/);
    assert.match(screen, /contractExpiry\(row\.contractEndsAt, today\)/);
    assert.match(screen, /employeeStatusBadge\(row\.status\)/);
    assert.match(screen, /usaliDepartmentLabel\(row\.usaliDepartment\)/);
    assert.match(screen, /rowKey="id"/);
    assert.match(screen, /onSelect=\{openRow\}/);
  });

  it("searches by name or employee number (debounced CocoaSearchInput) and segments Activos · Bajas · Fijos discontinuos through the typed query", () => {
    assert.match(screen, /<CocoaSearchInput value=\{search\} onChange=\{setSearch\} placeholder="Buscar por nombre o número de empleado" debounceMs=\{300\}/);
    assert.match(screen, /<CocoaSegmentedControl value=\{segment\} onChange=\{[^}]+\} options=\{\[\.\.\.EMPLOYEE_SEGMENT_OPTIONS\]\}/);
    // RF-08: «Excedencias» (status leave) so a file on leave stays reachable from the UI.
    assert.deepEqual(
      EMPLOYEE_SEGMENT_OPTIONS.map((option) => option.label),
      ["Activos", "Excedencias", "Bajas", "Fijos discontinuos"]
    );
    assert.match(screen, /segment === "leave" \? "No hay expedientes en excedencia en este ámbito\."/);
    assert.match(screen, /useApiData<EmployeeSummaryDto\[\]>\(read \? "\/hr\/employees" : null, \{\s*query: employeeListQuery\(\{ propertyId, \.\.\.employeeSegmentQuery\(segment\), search \}\)/);
    assert.equal("taxId" in employeeListQuery({ search: "12345678Z" }), false);
    assert.deepEqual(employeeDetailQuery(false), {});
    assert.deepEqual(employeeDetailQuery(true), { pii: "1" });
  });

  it("gates reading on hr.employee.read and writing on hr.employee.manage with the real grants (canDo over useNavGate); disabled controls and Spanish notes", () => {
    assert.match(screen, /import \{ useNavGate \} from "\.\.\/\.\.\/navigation\/useEnabledModules";/);
    assert.match(screen, /import \{ canDo, todayIso \} from "\.\.\/accounting\/accounting-ui";/);
    assert.match(screen, /const read = canDo\(gate, "hr\.employee\.read"\);/);
    assert.match(screen, /const manage = canDo\(gate, "hr\.employee\.manage"\);/);
    assert.match(screen, /disabled=\{!manage\}/);
    assert.match(screen, /<p className="cocoa-note">\{MANAGE_HINT\}<\/p>/);
    assert.match(screen, /const MANAGE_HINT = "Necesitas el permiso de gestión de expedientes \(hr\.employee\.manage\)/);
    assert.match(screen, /const READ_HINT = "Necesitas el permiso de lectura de expedientes \(hr\.employee\.read\)/);
    assert.match(screen, /<CocoaState kind="empty" title="Sin acceso a la plantilla" message=\{READ_HINT\}/);
    assert.match(screen, /canManage=\{manage\}/);
    assert.doesNotMatch(screen, /auth-storage|getUser\(|\?\.permissions/);
    assert.doesNotMatch(stripComments(drawer), /auth-storage|getUser\(|\?\.permissions|useNavGate/, "the drawer receives canManage from the screen");
  });

  it("paints the loading, error and empty states honestly (skeleton, retry, empty per segment / search)", () => {
    assert.match(screen, /skeleton=\{<ScreenSkeleton \/>\}/);
    assert.match(screen, /error=\{\{ title: "No se pudo cargar la plantilla", message: employeesState\.error \?\? undefined, onRetry: employeesState\.refresh \}\}/);
    assert.match(screen, /emptyState=\{<CocoaState kind="empty" inline title="Sin expedientes" message=\{emptyMessage\}/);
    assert.match(screen, /Ningún expediente coincide con/);
    assert.match(screen, /keepDataWhileLoading/);
  });
});

describe("Plantilla · EmployeeDrawer (RRHH-8)", () => {
  it("is a right drawer (lg) with the three views Datos · Contrato · Baja and forms driven by employee-form.ts", () => {
    assert.match(drawer, /<CocoaDrawer[\s\S]*?side="right"[\s\S]*?size="lg"/);
    assert.match(drawer, /\{ value: "data", label: "Datos" \},\s*\{ value: "contract", label: "Contrato" \},\s*\{ value: "termination", label: "Baja" \}/);
    assert.match(drawer, /<CocoaSegmentedControl value=\{section\}/);
    assert.match(drawer, /validateEmployeeForm\(form, isNew \? "create" : "edit"\)/);
    assert.match(drawer, /createEmployee\(toEmployeeBody\(form, legalEntityId\)\)/);
    assert.match(drawer, /const patch = toEmployeePatch\(form, detail\);/);
    assert.match(drawer, /patchEmployee\(detail\.id, patch\)/);
    for (const label of ["Nombre", "Apellidos", "NIF / NIE", "Número de empleado", "Fecha de alta", "Centro de trabajo principal", "Departamento USALI", "Puesto"]) assert.match(drawer, new RegExp(`<CocoaField label="${label}"`), `field ${label}`);
    assert.match(drawer, /<CocoaDatePicker value=\{form\.hiredAt\}/);
  });

  it("shows the encrypted fields ONLY behind an explicit «Mostrar» (GET ?pii=1), masks them otherwise and never keeps them in the form", () => {
    assert.match(drawer, /getEmployee\(employeeId, \{ pii: true \}\)/);
    assert.equal(count(drawer, /getEmployee\(employeeId, \{ pii: true \}\)/g), 1, "one explicit PII read");
    assert.match(drawer, /const loaded = await getEmployee\(id\);/, "the detail loads without PII");
    assert.match(drawer, />\s*Mostrar\s*<\/CocoaButton>/);
    assert.match(drawer, />\s*Ocultar\s*<\/CocoaButton>/);
    assert.match(drawer, /const PII_MASK = "•+";/);
    assert.match(drawer, /value=\{pii \? \(pii\[field\] \?\? "—"\) : PII_MASK\} readOnly/);
    assert.match(drawer, /HR_PII_FIELD_ORDER\.filter\(\(field\) => detail\.piiFields\.includes\(field\)\)/);
    assert.match(drawer, /Tu ámbito no puede consultar los datos personales cifrados/);
    assert.match(drawer, /queda registrada en la auditoría \(HR_PII_READ\)/);
    assert.match(drawer, /setPii\(null\);/, "the PII vanishes on close / save");
    assert.match(drawer, /label="Corregir datos cifrados \(vacío = sin cambio\)"/);
    assert.match(form, /taxId: "",[\s\S]*?employeeFormFromDetail/, "the detail form never preloads the encrypted values");
  });

  it("registers a contract on a linked ficha with the RRHH-2 fields; the agreement fills pays and hours; the pays use CocoaStepper 12-16", () => {
    assert.match(drawer, /createEmployeeContract\(toContractBody\(contractForm, contractPropertyId\)\)/);
    assert.match(drawer, /applyAgreementRules\(next, values\)/);
    assert.match(drawer, /listAgreementRules\(effective, contractForm\.startDate \|\| today\)/);
    assert.match(drawer, /<CocoaStepper value=\{Number\(contractForm\.payCount \|\| 14\)\}[\s\S]*?min=\{CONTRACT_PAY_COUNT_MIN\} max=\{CONTRACT_PAY_COUNT_MAX\}/);
    for (const label of ["Ficha de personal", "Convenio", "Modalidad de contrato", "Bruto mensual \\(€\\)", "Pagas anuales", "Jornada semanal \\(h\\)", "Porcentaje de jornada", "Grupo de cotización", "Fijo discontinuo"]) assert.match(drawer, new RegExp(`<CocoaField label="${label}"`), `contract field ${label}`);
    assert.match(drawer, /Sin ficha de personal en ningún centro/);
    assert.match(drawer, /profiles\.filter\(\(profile\) => linked\.has\(profile\.id\)\)/, "only the fichas linked to the file are offered");
  });

  it("terminates through a destructive CocoaDialog after validating date ≥ hire and reason, and explains the consequences", () => {
    assert.match(drawer, /validateTerminateForm\(terminateForm, detail\?\.hiredAt\)/);
    assert.match(drawer, /terminateEmployee\(detail\.id, toTerminateBody\(terminateForm\)\)/);
    assert.match(drawer, /<CocoaDialog\s+open=\{terminateOpen\}[\s\S]*?tone="destructive"/);
    assert.match(drawer, /confirmLabel="Dar de baja"/);
    assert.match(drawer, /<CocoaButton variant="filled" tone="destructive" onClick=\{\(\) => setTerminateOpen\(true\)\} disabled=\{!canManage \|\| !terminateValid \|\| terminating\}/);
    assert.match(drawer, /<CocoaCallout tone="warning" title="La baja no se deshace">/);
    assert.match(drawer, /result\.deactivatedContractIds\.length/);
    assert.match(drawer, /result\.revokedAssignmentIds\.length/);
    assert.match(drawer, /Expediente dado de baja/);
  });

  it("disables every write control without canManage and explains it", () => {
    assert.ok(count(drawer, /disabled=\{!canWriteData\}/g) >= 8, "the Datos fields follow canWriteData");
    assert.ok(count(drawer, /disabled=\{!canManage\}/g) >= 8, "the contract and termination fields follow canManage");
    assert.match(drawer, /const MANAGE_HINT = "Necesitas el permiso de gestión de expedientes \(hr\.employee\.manage\)/);
    assert.match(drawer, /const canWriteData = canManage && !terminated;/);
  });
});

describe("Plantilla · servicios (hrApi.ts · hr-contracts.ts · employee-form.ts)", () => {
  it("hrApi reaches the API only through apiRequest, on the routes of hr.routes.ts and POST /payroll/contracts", () => {
    assert.doesNotMatch(api, /\bfetch\s*\(/);
    assert.match(api, /import \{ apiRequest \} from "\.\/api-client";/);
    assert.match(api, /apiRequest<EmployeeSummaryDto\[\]>\("\/hr\/employees", \{ query: employeeListQuery\(query\) \}\)/);
    assert.match(api, /apiRequest<EmployeeDetailDto>\(`\/hr\/employees\/\$\{enc\(employeeId\)\}`, \{ query: employeeDetailQuery\(options\.pii === true\) \}\)/);
    assert.match(api, /apiRequest<EmployeeDetailDto>\("\/hr\/employees", \{ method: "POST", body \}\)/);
    assert.match(api, /apiRequest<EmployeeDetailDto>\(`\/hr\/employees\/\$\{enc\(employeeId\)\}`, \{ method: "PATCH", body \}\)/);
    assert.match(api, /apiRequest<TerminateEmployeeResult>\(`\/hr\/employees\/\$\{enc\(employeeId\)\}\/terminate`, \{ method: "POST", body \}\)/);
    assert.match(api, /apiRequest<CollectiveAgreementDto\[\]>\("\/hr\/agreements"\)/);
    assert.match(api, /apiRequest<AgreementRuleDto\[\]>\(`\/hr\/agreements\/\$\{enc\(agreementId\)\}\/rules`, \{ query: agreementRulesQuery\(asOf\) \}\)/);
    assert.match(api, /apiRequest<EmployeeContractRecord>\("\/payroll\/contracts", \{ method: "POST", body: \{ \.\.\.body, propertyId: body\.propertyId \?\? getActivePropertyId\(\) \} \}\)/);
    for (const field of ["agreementId", "weeklyHours", "partTimePct", "fixedDiscontinuous", "contributionGroup"]) assert.match(api, new RegExp(`${field}\\?:`), `contract body carries ${field}`);
  });

  it("hr-contracts and employee-form stay pure (no React, no api-client, no Vite meta) and the messages come from HR_ERROR_MESSAGES_ES", () => {
    for (const [name, src] of [
      ["hr-contracts.ts", contracts],
      ["employee-form.ts", form]
    ] as const) {
      assert.doesNotMatch(src, /from "react"|from "\.\/api-client"|from "\.\.\/\.\.\/services\/api-client"|import\.meta|\bfetch\s*\(/, `${name} is pure`);
      assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
    }
    assert.match(contracts, /HR_ERROR_MESSAGES_ES/);
    assert.match(contracts, /export function hrErrorMessage\(error: unknown, fallback: string = HR_ERROR_FALLBACK\): string/);
    assert.match(form, /import type \{ CreateEmployeeContractRequest, CreateEmployeeRequest, PatchEmployeeRequest, TerminateEmployeeRequest \} from "\.\.\/\.\.\/services\/hrApi";/, "only types cross into the pure module");
    assert.match(form, /export function isValidSpanishTaxId\(raw: string\): boolean/);
    assert.match(form, /const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";/);
  });
});

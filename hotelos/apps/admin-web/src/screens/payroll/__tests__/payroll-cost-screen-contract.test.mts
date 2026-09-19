import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda 6c · L4 (design docs/design/FINANZAS-COSTE-PERSONAL.md §8): the
// «Coste de personal» tab of Nóminas, its import drawer and the USALI badge
// are pinned on the source — the screens reach api-client (import.meta.env)
// and cannot load under node --test, like finance-scope-usage.test.mts and
// configure-gate.test.mts do. The pins are the ones the lot promised:
// Cocoa 22 rules (no inline styles beyond the frozen 9 of PayrollScreen, zero
// in the drawer, no raw elements, no colour literals, no emoji), the gate on
// `payroll.manage` through canDo(useNavGate(), …), the range / group pickers
// as small inline selects, the expandable centres, the two bar charts, the
// drawer's file input and switch, the destructive reversal dialog with a
// mandatory reason, and the services surface behind them. FIX-1 · F10 pins the
// «Nueva ficha de personal» drawer, the ficha select of «Nuevo contrato» and
// the retired 2FA promise of AssignmentDrawer (M6).

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const screen = source("../PayrollScreen.tsx");
const drawer = source("../PayrollCostImportDrawer.tsx");
const usali = source("../../finance/UsaliScreen.tsx");
const accountingUi = source("../../accounting/accounting-ui.ts");

/** Rules 1-5, 9-11 of tests/cocoa-22-contract.test.mjs, applied to one file. */
function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/, `${name}: no transition: all, fixed position nor numeric zIndex`);
  assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, `${name}: the currency never travels as a literal`);
  assert.doesNotMatch(src, /\bfetch\s*\(/, `${name}: no raw fetch`);
}

describe("Nóminas · pestaña «Coste de personal» (Tanda 6c · L4)", () => {
  it("keeps the Cocoa 22 rules and the frozen inline-style budget (≤ 9 in PayrollScreen, 0 in the drawer)", () => {
    assertCocoaRules("PayrollScreen.tsx", screen);
    assertCocoaRules("PayrollCostImportDrawer.tsx", drawer);
    assert.ok(count(screen, /\bstyle=\{/g) <= 9, `PayrollScreen.tsx: style={ ×${count(screen, /\bstyle=\{/g)} > 9`);
    assert.equal(count(drawer, /\bstyle=\{/g), 0, "the drawer is born without inline styles");
  });

  it("adds the fourth view «cost» with its page tab and keeps the ONE «Ámbito» of the screen", () => {
    assert.match(screen, /type View = "contracts" \| "periods" \| "slips" \| "cost";/);
    assert.match(screen, /\{ value: "cost", label: "Coste de personal" \}/);
    assert.match(screen, /useFinanceScope\(financeScopePolicy\("PayrollScreen"\)/);
    assert.match(screen, /<FinanceScopeSelector scope=\{finance\} \/>/);
    assert.match(screen, /eyebrow=\{finance\.eyebrow\("Finanzas"\)\}/);
  });

  it("reads the report and the lots through the typed client queries, lazily (null path outside the tab)", () => {
    assert.match(screen, /useApiData<PayrollCostReport>\(costActive \? "\/payroll\/cost-report" : null/);
    assert.match(screen, /useApiData<PayrollCostImportRecord\[\]>\(costActive \? "\/payroll\/cost-imports" : null/);
    assert.match(screen, /payrollCostReportQuery\(\{ from: costRange\.from, to: costRange\.to, propertyId, group: /);
    assert.match(screen, /payrollCostImportListQuery\(/);
    assert.match(screen, /import \{ payrollCostImportListQuery, payrollCostReportQuery \} from "\.\.\/\.\.\/services\/finance-contracts";/);
  });

  it("gates Importar / Contabilizar / Revertir on payroll.manage with the real grants (canDo over useNavGate), disabled controls and a Spanish note", () => {
    assert.match(screen, /import \{ useNavGate \} from "\.\.\/\.\.\/navigation\/useEnabledModules";/);
    assert.match(screen, /import \{ canDo \} from "\.\.\/accounting\/accounting-ui";/);
    assert.match(screen, /const manage = canDo\(useNavGate\(\), "payroll\.manage"\);/);
    assert.ok(count(screen, /disabled=\{!manage\}/g) >= 3, "Importar informe · Contabilizar · Revertir are disabled without the grant");
    assert.match(screen, /<p className="cocoa-note">Necesitas el permiso de gestión de nóminas/);
    assert.doesNotMatch(screen, /auth-storage|getUser\(|\?\.permissions/);
    assert.match(screen, /<PayrollCostImportDrawer open=\{importOpen\} onClose=\{[^}]+\} finance=\{finance\} canManage=\{manage\} onPosted=\{onImported\} \/>/);
  });

  it("paints the range and group pickers as small inline selects («Desde» · «Hasta» · «Grupo»)", () => {
    for (const label of ["Desde", "Hasta", "Grupo"]) assert.match(screen, new RegExp(`<CocoaSelect size="small" inline aria-label="${label}"`), `picker ${label}`);
    assert.match(screen, /clampCostRange\(/);
    assert.match(screen, /monthPickerOptions\(/);
    assert.match(screen, /options=\{GROUP_OPTIONS\}/);
  });

  it("expands a centre into its USALI departments with a Set in state and an accessible plain button", () => {
    assert.match(screen, /useState<ReadonlySet<string>>\(\(\) => new Set<string>\(\)\)/);
    assert.match(screen, /toggleExpanded\(current, centreId\)/);
    assert.match(screen, /<CocoaButton variant="plain" tone="neutral" size="small" aria-expanded=\{open\} aria-controls=\{matrixId\}/);
    assert.match(screen, /<CocoaSection\s+id=\{matrixId\}/);
    assert.match(screen, /costMatrixRows\(report, expandedCentres\)/);
    assert.match(screen, /stickyFirstColumn/);
  });

  it("paints the KPI strip of the tab (degraded without report) and the two bar charts in a 6 + 6 grid", () => {
    for (const label of ["Coste de personal", "Coste por empleado", "Personal s\\/ ventas", "Empleados medios"]) assert.match(screen, new RegExp(`<CocoaKpi label="${label}"[^>]*degraded=\\{!report\\}`), `KPI ${label}`);
    assert.match(screen, /deltaLabel=\{laborPct\?\.source === "reference" \? "[^"]+" : "s\/ ventas del libro"\}/);
    assert.match(screen, /<CocoaGrid columns=\{12\}/);
    assert.equal(count(screen, /<CocoaSpan cols=\{6\} min=\{320\}>/g), 2);
    assert.equal(count(screen, /<CocoaChart\.Bars /g), 2);
    assert.match(screen, /aria-label="Coste de personal por mes"/);
    assert.match(screen, /aria-label="Ventas netas por mes, del libro o de referencia"/);
  });

  it("lists the lots with «Contabilizar» (draft) and «Revertir» (posted) and reverses through a destructive dialog with a mandatory reason", () => {
    assert.match(screen, /record\.status === "draft" \? \(/);
    assert.match(screen, /record\.status === "posted" \? \(/);
    assert.match(screen, /\{ACTIONS\.revert\}/);
    assert.match(screen, /tone="destructive"\s+title=\{reverseTarget \? `Revertir la importación/);
    assert.match(screen, /confirmDisabled=\{Boolean\(reverseReasonError\(reverseReason\)\)\}/);
    assert.match(screen, /reversePayrollCostImport\(reverseTarget\.id, \{ reason: reverseReason\.trim\(\), entryDate: reverseDate \|\| undefined \}\)/);
    assert.match(screen, /postPayrollCostImport\(postTarget\.id, \{ replace: postReplace \}\)/);
    assert.match(screen, /<CocoaInput value=\{reverseReason\} onChange=\{setReverseReason\} multiline rows=\{3\}/);
    assert.match(screen, /importStatusBadge\(record\.status\)/);
  });

  it("corrector 6c: the reversal dialog offers the date (FU-06), the draft dialog the «Sustituir» switch (FU-12), the phone cards carry the centre and only the last month (FU-05), and the captions say what they measure (FU-03, FU-07, FU-09, FU-11)", () => {
    assert.match(screen, /<CocoaField label="Fecha de la anulación" hint="opcional"/);
    assert.match(screen, /<CocoaDatePicker value=\{reverseDate\} onChange=\{setReverseDate\}/);
    assert.match(screen, /reábrelo en Contabilidad › Periodos antes de revertir/);
    assert.match(screen, /<CocoaSwitch checked=\{postReplace\} onChange=\{setPostReplace\} label="Sustituir los lotes anteriores \(reverso \+ este lote\)"/);
    assert.match(screen, /confirmLabel=\{postReplace \? "Sustituir y contabilizar" : "Contabilizar"\}/);
    assert.match(screen, /const phone = useViewportTier\(\) === "phone";/);
    assert.match(screen, /blockLabels\.get\(row\.propertyId \?\? "society"\)/);
    assert.match(screen, /showFrom: index === months\.length - 1 \? undefined : "tablet"/);
    assert.match(screen, /deltaLabel="acumulado del rango por empleado medio"/);
    assert.doesNotMatch(screen, /media mensual del rango/);
    assert.match(screen, /"sin dato de empleados"/);
    assert.match(screen, /reportState\.loading && report \? \(\s*<CocoaBadge tone="info" size="small" aria-live="polite">/);
    assert.match(screen, /\{record\.fileName \? <span className="cocoa-caption">\{PAYROLL_COST_SOURCE_LABELS\[record\.source\]/);
  });
});

describe("Nóminas · cajón «Importar informe» (PayrollCostImportDrawer.tsx)", () => {
  it("is a right drawer (lg) with the file input (.csv / .json, ≤ 1 MB), the pasted-text input and the format note", () => {
    assert.match(drawer, /<CocoaDrawer[\s\S]*?side="right"[\s\S]*?size="lg"/);
    assert.match(drawer, /<CocoaFileInput accept="\.csv,\.json" maxBytes=\{1_000_000\}/);
    assert.match(drawer, /<CocoaInput value=\{content\} onChange=\{[^}]+\} multiline rows=\{6\}/);
    assert.match(drawer, /<p className="cocoa-note" id=\{noteId\}>/);
    assert.match(drawer, /PAYROLL_COST_CSV_HEADER_NOTE/);
    assert.match(drawer, /Previsualizar/);
  });

  it("maps unmapped centres to the centres of the ERP and departments to the USALI labor departments; each change previews again", () => {
    assert.match(drawer, /centreSelectOptions\(finance\.structure, finance\.active\)/);
    assert.match(drawer, /usaliLaborDepartmentOptions\(\)/);
    assert.match(drawer, /suggestedCentreId\(label\)/);
    assert.match(drawer, /function changeCentre\([^)]*\) \{[\s\S]*?void runPreview\(/);
    assert.match(drawer, /function changeDepartment\([^)]*\) \{[\s\S]*?void runPreview\(/);
    assert.match(drawer, /placeholder="Elige un centro de trabajo"/);
    assert.match(drawer, /placeholder="Elige un departamento USALI"/);
  });

  it("previews without writing, warns about duplicates / overlaps / real payroll with the «Sustituir» switch, and posts only when the API says canPost", () => {
    assert.match(drawer, /previewPayrollCostImport\(\{ format, content, mapping: buildImportMapping\(/);
    assert.match(drawer, /createPayrollCostImport\(\{[\s\S]*?post: true[\s\S]*?\}\)/);
    assert.match(drawer, /const canPost = Boolean\(preview\?\.canPost\) && canManage/);
    assert.match(drawer, /disabled=\{!canPost\}/);
    assert.match(drawer, /<CocoaSwitch checked=\{replace\} onChange=\{changeReplace\} label="Sustituir los lotes anteriores \(reverso \+ lote nuevo\)"/);
    assert.match(drawer, /replacedImportsSummary\(preview\)/);
    assert.match(drawer, /preview\.payrollPeriodsPosted/);
    for (const tone of ["danger", "warning", "success"]) assert.match(drawer, new RegExp(`<CocoaCallout tone="${tone}"`), `callout ${tone}`);
    assert.match(drawer, /<CocoaStat label="Salario bruto"/);
    assert.match(drawer, /<CocoaStat label="Seguridad Social empresa"/);
    assert.match(drawer, /<CocoaStat label="Coste a contabilizar"/);
    assert.match(drawer, /<CocoaStat label="Empleados medios"/);
    assert.match(drawer, /importResultTitle\(result\)/);
    assert.match(drawer, /entrySummaryLabel\(entry\)/);
    assert.match(drawer, /payrollCostErrorMessage\(/);
  });

  it("explains the missing grant instead of hiding the action, and never stores person data (aggregate format only)", () => {
    assert.match(drawer, /<p className="cocoa-note">Necesitas el permiso de gestión de nóminas para previsualizar y contabilizar/);
    assert.match(drawer, /nunca nombres ni datos por persona/);
  });

  it("corrector 6c: starts clean on every opening (FU-04), previews again with the suggested centres and keeps the labels listed (FU-01), and separates a file read error from a preview error (FU-10)", () => {
    assert.match(drawer, /import \{ useEffect, useId, useState \} from "react";/);
    assert.match(drawer, /useEffect\(\(\) => \{\s*if \(open\) resetAll\(\);/);
    assert.match(drawer, /for \(let pass = 0; pass < 2; pass \+= 1\) \{[\s\S]*?await previewPayrollCostImport\(/);
    assert.match(drawer, /if \(!suggested\) break;/);
    assert.match(drawer, /const \[centreLabels, setCentreLabels\] = useState<Record<string, PayrollCostUnmappedLabel>>/);
    assert.match(drawer, /centreLabelList\.map\(\(label\) => \(/);
    assert.match(drawer, /Aplicado en la previsualización: /);
    assert.match(drawer, /<CocoaCallout tone="danger" title="No se pudo leer el fichero" role="alert">/);
    assert.match(drawer, /disabled=\{!canPreview\}/);
  });
});

describe("Nóminas · cajón «Nueva ficha de personal» (FIX-1 · F10)", () => {
  const usersDrawer = source("../../users/AssignmentDrawer.tsx");

  it("adds «Nueva ficha» to the header actions and the palette, gated on payroll.manage, and keeps the frozen style budget (≤ 9, no new inline styles)", () => {
    assert.match(screen, /const newProfileLabel = newLabel\("f", "ficha"\);/);
    assert.match(screen, /<CocoaButton variant="bordered" tone="accent" size="small" onClick=\{openProfileDrawer\} disabled=\{!manage\}/);
    assert.match(screen, /\{ id: "payroll-new-profile", label: `\$\{newProfileLabel\} de personal`, run: openProfileDrawer \}/);
    assert.ok(count(screen, /\bstyle=\{/g) <= 9, "the drawer is born without inline styles");
    assertCocoaRules("PayrollScreen.tsx", screen);
  });

  it("is a CocoaDrawer «Nueva ficha de personal» with Persona (listUsersInScope), código, departamento (property.configure), modalidad and coste hora", () => {
    assert.match(screen, /<CocoaDrawer\s+open=\{profileOpen\}[\s\S]*?title="Nueva ficha de personal"/);
    assert.match(screen, /import \{ listUsersInScope \} from "\.\.\/\.\.\/services\/rbacApi";/);
    assert.match(screen, /listUsersInScope\(\{ scopeType: "property", ref: centre \}\)/);
    assert.match(screen, /const configure = canDo\(useNavGate\(\), "property\.configure"\);/);
    assert.match(screen, /configure \? listPropertyDepartments\(centre\) : Promise\.resolve\(\[\] as PropertyDepartmentRecord\[\]\)/);
    for (const label of ["Persona", "Código de empleado", "Departamento", "Modalidad", "Coste hora \\(€\\)"]) assert.match(screen, new RegExp(`<CocoaField\\s+label="${label}"|<CocoaField label="${label}"`), `field ${label}`);
    assert.match(screen, /<CocoaField label="Centro de trabajo" required fullWidth/);
    assert.match(screen, /<CocoaSelect value=\{profileForm\.userId\} onChange=\{\(value\) => updateProfile\("userId", value\)\} options=\{peopleOptions\} placeholder="Elige a la persona"/);
    assert.match(screen, /<CocoaSelect value=\{profileForm\.employmentType\} onChange=\{\(value\) => updateProfile\("employmentType", value\)\} options=\{employmentTypeOptions\} \/>/);
    assert.match(screen, /<CocoaInput value=\{profileForm\.hourlyCost\} onChange=\{\(value\) => updateProfile\("hourlyCost", value\)\} type="number" inputMode="decimal" min=\{0\} step="0\.01"/);
    assert.match(screen, /<CocoaInput value=\{profileForm\.employeeCode\} onChange=\{\(value\) => updateProfile\("employeeCode", value\)\} maxLength=\{32\}/);
    assert.match(screen, /validateStaffProfileForm\(profileForm\)/);
    assert.match(screen, /createStaffProfile\(toStaffProfileBody\(profileForm, profilePropertyId\)\)/);
    assert.match(screen, /showToast\("Ficha creada\.", \{ variant: "success" \}\)/);
    assert.match(screen, /profilesState\.refresh\(\);\s*\/\/ «Nuevo contrato» opens with the ficha just created already selected\.\s*setStaffProfileId\(created\.id\);/);
    assert.match(screen, /<CocoaCallout tone="danger" title="No se pudo crear la ficha" role="alert">/);
  });

  it("«Nuevo contrato» picks the ficha from a CocoaSelect (label employeeCode ?? userFullName) and never asks for the id by hand; the tables paint the same label", () => {
    assert.doesNotMatch(screen, /Identificador de la ficha/);
    assert.match(screen, /<CocoaField label="Ficha de personal" required error=\{staffProfileId === "" \? undefined : contractErrors\.staffProfileId\}/);
    assert.match(screen, /<CocoaSelect value=\{staffProfileId\} onChange=\{setStaffProfileId\} options=\{profileOptions\} placeholder="Elige una ficha de personal"/);
    assert.match(screen, /useApiData<StaffProfileRecord\[\]>\("\/payroll\/staff-profiles", \{ query: \{ propertyId \} \}\)/);
    assert.match(screen, /const profileLabels = useMemo\(\(\) => staffProfileLabelMap\(profiles\), \[profiles\]\);/);
    assert.match(screen, /<strong>\{employeeLabel\(labels, c\.staffProfileId\)\}<\/strong>/);
    assert.match(screen, /<strong>\{employeeLabel\(labels, s\.staffProfileId\)\}<\/strong>/);
    assert.match(screen, /employeeLabel\(profileLabels, pendingDeactivate\.staffProfileId\)/);
    assert.doesNotMatch(screen, /<strong>\{c\.staffProfileId\}<\/strong>|<strong>\{s\.staffProfileId\}<\/strong>/);
  });

  it("M6: the invitation drawer no longer promises a mandatory second factor (the login does not verify it)", () => {
    assert.doesNotMatch(usersDrawer, /Obligatorio para supervisión/);
    assert.match(usersDrawer, /help="Deja la marca “2FA: Activo” en la ficha para cuando se active la verificación del segundo factor; hoy el acceso no la exige\."/);
  });
});

describe("USALI · origen «Centro de coste» y etiqueta del diario", () => {
  it("UsaliScreen paints the info badge on an account routed by cost centre and leaves SOURCE_LABELS untouched", () => {
    assert.match(usali, /account\.source === "cost_center" \? \(/);
    assert.match(usali, /<CocoaBadge tone="info" size="small"[^>]*>\s*Centro de coste\s*<\/CocoaBadge>/);
    const labels = usali.match(/const SOURCE_LABELS: Record<UsaliMappingSource, [^=]+= \{([\s\S]*?)\};/);
    assert.ok(labels, "SOURCE_LABELS block");
    assert.deepEqual([...labels[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]), ["mapping", "account", "template", "none"]);
  });

  it("accounting-ui names the new journal source «Coste de personal importado»", () => {
    assert.match(accountingUi, /payroll_cost_import: "Coste de personal importado",/);
  });
});

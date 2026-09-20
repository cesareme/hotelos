import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda RRHH · RRHH-10 (recon §3.10 «Personal»; RRHH-4 resolveStaff): the time
// clock and the new-shift drawer of Operaciones › Personal y turnos identify the
// person by her ficha de personal (StaffProfile) chosen in a CocoaSelect, and the
// client sends `{ staffProfileId }` — never a free-text name, which the API now
// rejects with 400 HR_EMPLOYEE_REQUIRED. Pinned on the source like the other
// screen contracts (the screens reach api-client / import.meta and cannot load
// under node --test).

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const screen = read("../WorkforceDashboard.tsx");
const screenCode = stripComments(screen);
const api = read("../../../services/workforceApi.ts");
const apiCode = stripComments(api);

describe("Personal y turnos · ficha de personal por CocoaSelect (Tanda RRHH · RRHH-10)", () => {
  it("workforceApi sends { staffProfileId } for the time clock and the shift, and never a free-text name", () => {
    assert.doesNotMatch(apiCode, /staffName/, "workforceApi.ts: no free-text alias field");
    assert.match(apiCode, /export type CreateShiftRequest = \{ staffProfileId: string; role\?: string; startAt: string; endAt: string \};/);
    assert.match(apiCode, /export function clockIn\(staffProfileId: string, propertyId = getActivePropertyId\(\)\)/);
    assert.match(apiCode, /export function clockOut\(staffProfileId: string, propertyId = getActivePropertyId\(\)\)/);
    assert.match(apiCode, /export function createShift\(payload: CreateShiftRequest, propertyId = getActivePropertyId\(\)\)/);
    assert.match(apiCode, /body: \{ propertyId, staffProfileId, action: "in", at: new Date\(\)\.toISOString\(\) \}/);
    assert.match(apiCode, /body: \{ propertyId, staffProfileId, action: "out", at: new Date\(\)\.toISOString\(\) \}/);
    assert.match(apiCode, /const body: CreateShiftRequest = \{ staffProfileId: payload\.staffProfileId, startAt: payload\.startAt, endAt: payload\.endAt,/);
    // Corrector RRHH · SEC-02: the fichas come from GET /workforce/properties/:propertyId/staff-profiles (workforce.read), never from payroll.read.
    assert.match(apiCode, /export function workforceStaffProfilesPath\(propertyId: string\): string \{\s*return `\/workforce\/properties\/\$\{encodeURIComponent\(propertyId\)\}\/staff-profiles`;/);
    assert.match(apiCode, /export function listWorkforceStaffProfiles\(propertyId = getActivePropertyId\(\)\): Promise<WorkforceStaffProfile\[\]>/);
    assert.match(apiCode, /export type WorkforceStaffProfile = Omit<StaffProfileRecord, "hourlyCost" \| "userEmail">;/);
    assert.doesNotMatch(apiCode, /\/payroll\/staff-profiles/, "no payroll route in the workforce client");
    assert.match(apiCode, /from "\.\/api-client"/);
    assert.doesNotMatch(apiCode, /\bfetch\s*\(/);
  });

  it("workforceApi maps the HR error codes to Spanish (HR_EMPLOYEE_REQUIRED · APPROVAL_SELF_DECISION · HR_INVALID_TRANSITION) and exposes the rule warnings of a created shift", () => {
    assert.match(apiCode, /export function workforceErrorMessage\(error: unknown, fallback = "No se pudo completar la acción\."\): string/);
    assert.match(apiCode, /HR_EMPLOYEE_REQUIRED: "Elige una ficha de personal: los turnos y fichajes ya no admiten nombres libres\."/);
    assert.match(apiCode, /APPROVAL_SELF_DECISION: "Quien solicita no puede aprobar su propia solicitud/);
    assert.match(apiCode, /HR_INVALID_TRANSITION: "La solicitud ya fue decidida\."/);
    // RF-11: the generic engine spells the same conflict INVALID_TRANSITION; RF-01: the self-only time clock.
    assert.match(apiCode, /INVALID_TRANSITION: "La solicitud ya fue decidida\."/);
    assert.match(apiCode, /HR_TIMECLOCK_SELF_ONLY: "Solo puedes fichar con tu propia ficha de personal\."/);
    assert.match(apiCode, /export function recordWarnings\(record: WorkforceRecord \| null \| undefined\): WorkforceRuleWarning\[\]/);
  });

  it("mirrors ABSENCE_TYPE_LABELS_ES of @hotelos/shared and labels a restricted (health) absence without naming its type (SEC-07)", () => {
    const shared = read("../../../../../../packages/shared/src/hr-types.ts");
    const sharedBlock = /export const ABSENCE_TYPE_LABELS_ES: Record<AbsenceType, string> = \{([\s\S]*?)\};/.exec(shared)![1]!;
    const apiBlock = /export const ABSENCE_TYPE_LABELS_ES: Readonly<Record<string, string>> = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(apiCode)![1]!;
    const entries = (block: string) => [...block.matchAll(/(\w+): "([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`).sort();
    assert.deepEqual(entries(apiBlock), entries(sharedBlock), "same labels as packages/shared");
    assert.match(apiCode, /export function absenceTypeLabel\(type: string \| null \| undefined, restricted = false\): string/);
    assert.match(apiCode, /export const ABSENCE_RESTRICTED_LABEL = "Ausencia \(tipo reservado\)";/);
    assert.match(screenCode, /type: string \| null; restricted\?: boolean;/, "the dashboard absence carries the mask");
    assert.match(screenCode, /return absenceTypeLabel\(a\.type, a\.restricted === true\);/);
    assert.doesNotMatch(screenCode, /sick: "baja médica"/, "the old catalogue is gone");
  });

  it("the screen reads the fichas of the centre (GET /workforce/properties/:p/staff-profiles, active only) and paints a CocoaSelect for the time clock (own ficha without timeclock.manage) and for the shift drawer", () => {
    assert.match(screenCode, /useApiData<WorkforceStaffProfile\[\]>\(moduleGate\.ready \? workforceStaffProfilesPath\(PROPERTY_ID\) : null\)/);
    assert.match(screenCode, /\.filter\(\(profile\) => profile\.active\)/);
    assert.match(screenCode, /import \{ employeeLabel, staffProfileLabelMap, staffProfileOptions \} from "\.\.\/payroll\/staff-profile-form";/);
    assert.match(screenCode, /const profileOptions = useMemo\(\(\) => staffProfileOptions\(profiles\), \[profiles\]\);/);
    // RF-01: without workforce.timeclock.manage the API only accepts the actor's own ficha, so the clock picker offers just hers.
    assert.match(screenCode, /const clocksForOthers = canDo\(gate, "workforce\.timeclock\.manage"\);/);
    assert.match(screenCode, /const ownUserId = getUser\(\)\?\.userId \?\? null;/);
    assert.match(screenCode, /const clockProfiles = useMemo\(\(\) => \(clocksForOthers \? profiles : profiles\.filter\(\(profile\) => profile\.userId === ownUserId\)\), \[clocksForOthers, profiles, ownUserId\]\);/);
    assert.match(screenCode, /const NO_OWN_PROFILE_HELP = "No tienes ficha de personal en este centro: pide a RRHH que la cree para poder fichar/);
    assert.match(screenCode, /<CocoaField label="Ficha de personal" help=\{clockHelp\}>\s*<CocoaSelect value=\{clockProfile\} onChange=\{setClockProfileId\} options=\{clockOptions\} placeholder=\{PROFILE_PLACEHOLDER\} disabled=\{busy \|\| clockProfiles\.length === 0\}/);
    assert.match(screenCode, /<CocoaField label="Ficha de personal" required help=\{profilesHelp\}>\s*<CocoaSelect value=\{sStaffProfileId\} onChange=\{setSStaffProfileId\} options=\{profileOptions\} placeholder=\{PROFILE_PLACEHOLDER\} disabled=\{busy \|\| profiles\.length === 0\}/);
    assert.equal(count(screenCode, /<CocoaSelect /g), 2, "one select per picker: fichaje and nuevo turno");
  });

  it("no free-text name reaches the client: the old inputs are gone and the actions send the chosen ficha", () => {
    assert.doesNotMatch(screenCode, /placeholder="Nombre del empleado"|placeholder="Empleado"/);
    assert.doesNotMatch(screenCode, /clockName|setClockName|sStaff\b|setSStaff\b/);
    assert.doesNotMatch(screenCode, /createShift\(\{ staffName|clockIn\(employee\)|clockOut\(employee\)/);
    assert.match(screenCode, /clockIn\(clockProfile\), `Entrada registrada para \$\{clockLabel\}\.`/);
    assert.match(screenCode, /clockOut\(clockProfile\), `Salida registrada para \$\{clockLabel\}\.`/);
    assert.match(screenCode, /await createShift\(\{ staffProfileId: sStaffProfileId, role: sRole \|\| undefined, startAt: new Date\(sStart\)\.toISOString\(\), endAt: new Date\(sEnd\)\.toISOString\(\) \}\)/);
    assert.match(screenCode, /const canCreateShift = !busy && sStaffProfileId !== "" && sStart !== "" && sEnd !== "";/);
    // The name of a shift or absence still comes from the API (resolved from the ficha): display only.
    assert.match(screenCode, /render: \(s\) => <strong>\{s\.staffName\}<\/strong>/);
  });

  it("explains an empty or unreadable list of fichas instead of a silent disabled picker, announces the rule warnings and maps the errors", () => {
    assert.match(screenCode, /const NO_PROFILES_HELP = "No hay fichas de personal en este centro: créalas en Finanzas › Nóminas \(«Nueva ficha»\) antes de fichar o crear turnos\.";/);
    assert.match(screenCode, /No se pudieron cargar las fichas de personal: \$\{profilesState\.error\}/);
    assert.match(screenCode, /showToast\(workforceErrorMessage\(e, "No se pudo completar la acción\."\), \{ variant: "error" \}\)/);
    assert.match(screenCode, /const warnings = recordWarnings\(created\);\s*if \(warnings\.length > 0\) showToast\(`Turno con \$\{plural\(warnings\.length, "aviso", "avisos"\)\}: /);
  });

  it("keeps the Cocoa 22 rules and the workspace style budget (no new inline styles: ≤ 7)", () => {
    assert.ok(count(screen, /\bstyle=\{/g) <= 7, `WorkforceDashboard.tsx: style={ ×${count(screen, /\bstyle=\{/g)} > 7`);
    assert.doesNotMatch(screen, /<(?:input|select|textarea|button|table)\b/, "no raw form controls, buttons nor tables");
    assert.doesNotMatch(screen, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, "no colour literals");
    assert.doesNotMatch(screen, /\bfetch\s*\(/, "no raw fetch");
    assert.doesNotMatch(screen, /\p{Extended_Pictographic}/u, "no emoji");
  });
});

// Portal del huésped · ajustes honestos (Tanda L7 · lote L7-08) —
// services/guestPortalApi.ts: política ↔ formulario, validación de las horas,
// cuerpo del PUT con SOLO las tres claves persistidas y guardado real contra
// GET/PUT /properties/:id/check-in/policy (fetch doble, sin red). Contrato de
// fuente de GuestPortalSettingsScreen.tsx: sin interruptores sin backend.
// Desde apps/admin-web:
//   corepack pnpm --filter @hotelos/admin-web test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// api-client.ts lee `import.meta.env` al cargar (Vite): se sustituye solo ese
// módulo por su fuente sin tipos precedida de `import.meta.env ??= {}`
// (mismo truco que services/__tests__/api-client-dedupe.test.mts).
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

type FetchCall = { url: string; method: string; body: unknown; headers: Record<string, string> };

const calls: FetchCall[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  // Sin sesión en Node, apiRequest hace el login de demo: se contesta al vuelo.
  if (url.endsWith("/auth/login")) {
    return Promise.resolve(new Response(JSON.stringify({ token: "t-demo", user: { permissions: [] } }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
  calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, headers });
  return Promise.resolve(new Response(JSON.stringify(nextResponse.body), { status: nextResponse.status, headers: { "Content-Type": "application/json" } }));
}) as typeof fetch;

const api = await import("../../../services/guestPortalApi.ts");
const {
  GUEST_PORTAL_FORM_DEFAULTS,
  GUEST_PORTAL_POLICY_KEYS,
  SURVEY_DELAY_DEFAULT_HOURS,
  SURVEY_DELAY_MAX_HOURS,
  SURVEY_DELAY_MIN_HOURS,
  guestPortalPublicUrl,
  isPortalFormDirty,
  loadGuestPortalSettings,
  parseDelayHours,
  saveGuestPortalSettings,
  toPortalForm,
  toPortalPatch,
  validatePortalForm
} = api;

const POLICY = {
  propertyId: "prop_x",
  selfCheckInEnabled: true,
  inviteDaysBefore: 3,
  reminderDaysBefore: 1,
  allowedVerificationMethods: ["mrz_checksum"],
  requireVisualCheckAtKiosk: false,
  requireInspectedRoom: true,
  depositPolicy: "none",
  depositAmount: null,
  allowPayAtReception: true,
  allowWalkIn: true,
  allowUpgradeSuggestion: false,
  autoAssignLevel: "suggest",
  assignmentWeights: {},
  welcomeChannelOrder: ["email"],
  guestConsentText: null,
  aiDisclosureText: null,
  postStaySurveyEnabled: true,
  postStaySurveyDelayHours: 48,
  updatedAt: "2026-09-20T10:00:00.000Z"
} as const;

beforeEach(() => {
  calls.length = 0;
  nextResponse = { status: 200, body: POLICY };
});

describe("guestPortalApi · política ↔ formulario", () => {
  it("las tres claves persistidas y los defectos de las columnas (encuesta apagada, 24 h, sin pago en recepción)", () => {
    assert.deepEqual([...GUEST_PORTAL_POLICY_KEYS], ["postStaySurveyEnabled", "postStaySurveyDelayHours", "allowPayAtReception"]);
    assert.equal(SURVEY_DELAY_MIN_HOURS, 0);
    assert.equal(SURVEY_DELAY_MAX_HOURS, 72);
    assert.equal(SURVEY_DELAY_DEFAULT_HOURS, 24);
    assert.deepEqual(GUEST_PORTAL_FORM_DEFAULTS, { postStaySurveyEnabled: false, postStaySurveyDelayHours: "24", allowPayAtReception: false });
    assert.deepEqual(toPortalForm(null), GUEST_PORTAL_FORM_DEFAULTS);
    assert.notEqual(toPortalForm(null), GUEST_PORTAL_FORM_DEFAULTS, "copia, no la constante congelada");
  });

  it("toPortalForm copia la política (horas como texto) y tolera valores raros", () => {
    assert.deepEqual(toPortalForm(POLICY), { postStaySurveyEnabled: true, postStaySurveyDelayHours: "48", allowPayAtReception: true });
    assert.deepEqual(toPortalForm({ postStaySurveyEnabled: false, postStaySurveyDelayHours: 0, allowPayAtReception: false }), { postStaySurveyEnabled: false, postStaySurveyDelayHours: "0", allowPayAtReception: false });
    // Un valor no entero (política corrupta o versión anterior del API) cae al defecto de la columna.
    assert.equal(toPortalForm({ postStaySurveyEnabled: true, postStaySurveyDelayHours: Number.NaN, allowPayAtReception: true }).postStaySurveyDelayHours, "24");
  });

  it("parseDelayHours / validatePortalForm: entero 0-72; vacío, decimales, negativos y > 72 no valen", () => {
    for (const [input, expected] of [["24", 24], [" 0 ", 0], ["72", 72], ["007", 7]] as const) assert.equal(parseDelayHours(input), expected, input);
    for (const input of ["", " ", "-1", "73", "24,5", "24.5", "abc", "1e2", "1000"]) assert.equal(parseDelayHours(input), null, JSON.stringify(input));
    assert.deepEqual(validatePortalForm({ postStaySurveyEnabled: true, postStaySurveyDelayHours: "24", allowPayAtReception: false }), {});
    const errors = validatePortalForm({ postStaySurveyEnabled: false, postStaySurveyDelayHours: "99", allowPayAtReception: false });
    assert.match(errors.postStaySurveyDelayHours ?? "", /entre 0 y 72/);
    // Se valida aunque la encuesta esté apagada: el valor se guarda igual (PolicyPutSchema lo rechazaría con 400).
    assert.match(validatePortalForm({ postStaySurveyEnabled: false, postStaySurveyDelayHours: "", allowPayAtReception: true }).postStaySurveyDelayHours ?? "", /entero/);
  });

  it("toPortalPatch: exactamente las tres claves, horas como número (nunca el resto de la política)", () => {
    const patch = toPortalPatch({ postStaySurveyEnabled: true, postStaySurveyDelayHours: " 36 ", allowPayAtReception: false });
    assert.deepEqual(patch, { postStaySurveyEnabled: true, postStaySurveyDelayHours: 36, allowPayAtReception: false });
    assert.deepEqual(Object.keys(patch).sort(), [...GUEST_PORTAL_POLICY_KEYS].sort());
    // Horas inválidas (el formulario ya lo impide): defecto de la columna en vez de NaN.
    assert.equal(toPortalPatch({ postStaySurveyEnabled: false, postStaySurveyDelayHours: "x", allowPayAtReception: false }).postStaySurveyDelayHours, 24);
  });

  it("isPortalFormDirty compara con la política cargada (espacios en las horas no cuentan) o con los defectos sin política", () => {
    const form = toPortalForm(POLICY);
    assert.equal(isPortalFormDirty(form, POLICY), false);
    assert.equal(isPortalFormDirty({ ...form, postStaySurveyDelayHours: " 48 " }, POLICY), false);
    assert.equal(isPortalFormDirty({ ...form, postStaySurveyDelayHours: "24" }, POLICY), true);
    assert.equal(isPortalFormDirty({ ...form, postStaySurveyEnabled: false }, POLICY), true);
    assert.equal(isPortalFormDirty({ ...form, allowPayAtReception: false }, POLICY), true);
    assert.equal(isPortalFormDirty({ ...GUEST_PORTAL_FORM_DEFAULTS }, null), false);
    assert.equal(isPortalFormDirty({ ...GUEST_PORTAL_FORM_DEFAULTS, allowPayAtReception: true }, null), true);
  });

  it("guestPortalPublicUrl: https://<host de la marca>/?property=<id> (el portal resuelve el hotel por ?property=)", () => {
    assert.equal(guestPortalPublicUrl("huesped.ehotelos.com", "prop_chk"), "https://huesped.ehotelos.com/?property=prop_chk");
    assert.equal(guestPortalPublicUrl("https://huesped.ehotelos.com/", "prop x"), "https://huesped.ehotelos.com/?property=prop%20x");
  });
});

describe("guestPortalApi · guardado real (GET/PUT /properties/:id/check-in/policy)", () => {
  it("loadGuestPortalSettings hace GET a la política de la propiedad", async () => {
    const policy = await loadGuestPortalSettings("prop_x");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/properties\/prop_x\/check-in\/policy$/);
    assert.equal(policy.postStaySurveyDelayHours, 48);
  });

  it("saveGuestPortalSettings hace PUT con SOLO las tres claves del portal y devuelve la política guardada", async () => {
    nextResponse = { status: 200, body: { ...POLICY, postStaySurveyEnabled: false, postStaySurveyDelayHours: 12, allowPayAtReception: true } };
    const saved = await saveGuestPortalSettings("prop_x", { postStaySurveyEnabled: false, postStaySurveyDelayHours: "12", allowPayAtReception: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PUT");
    assert.match(calls[0].url, /\/properties\/prop_x\/check-in\/policy$/);
    assert.deepEqual(calls[0].body, { postStaySurveyEnabled: false, postStaySurveyDelayHours: 12, allowPayAtReception: true });
    assert.equal(calls[0].headers["content-type"], "application/json");
    assert.equal(saved.postStaySurveyDelayHours, 12);
    assert.equal(saved.selfCheckInEnabled, true, "devuelve la política completa (el resto no se toca)");
  });

  it("un 4xx del API llega como error con el mensaje del servidor (la pantalla lo muestra en el toast)", async () => {
    nextResponse = { status: 400, body: { message: "postStaySurveyDelayHours: Number must be less than or equal to 72", details: { code: "VALIDATION_ERROR" } } };
    await assert.rejects(saveGuestPortalSettings("prop_x", { postStaySurveyEnabled: true, postStaySurveyDelayHours: "72", allowPayAtReception: false }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /72/);
      assert.equal((error as { status?: number }).status, 400);
      return true;
    });
  });
});

describe("GuestPortalSettingsScreen · contrato de fuente (sin ajustes decorativos)", () => {
  const screen = readFileSync(new URL("../GuestPortalSettingsScreen.tsx", import.meta.url), "utf8");
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("guarda con saveGuestPortalSettings y carga la política real; enlaza a /hoy/check-in-automatizado; gate guest_self_service.manage", () => {
    assert.match(code, /saveGuestPortalSettings\(propertyId, form\)/);
    assert.match(code, /useApiData<PropertyCheckInPolicyDto>\(policyPath\(propertyId\)\)/);
    assert.match(code, /toPortalForm\(policy\)/);
    assert.match(code, /validatePortalForm\(form\)/);
    assert.match(code, /const dirty = edited && isPortalFormDirty\(form, policy\)/);
    assert.match(code, /if \(policy && !edited\) setForm\(toPortalForm\(policy\)\)/, "la política cargada rellena el formulario hasta la primera edición");
    assert.match(code, /navigateTo\("CheckInAutomationSettingsScreen"\)/);
    assert.match(code, /canManageCheckInPolicy\(gate\.grantedPermissions, gate\.isPlatformAdmin\)/);
    assert.match(code, /guestPortalPublicUrl\(BRAND\.guestPortalHost, propertyId\)/);
    assert.match(code, /GUEST_WEB_BASE_URL/, "dice dónde se fija la base real de los enlaces");
  });

  it("retira los interruptores sin backend (marca, idiomas, ventanas, funciones visibles) y no confirma guardados locales", () => {
    for (const forbidden of ["FEATURES", "brandName", "customDomain", "logoUrl", "primaryColor", "toggleLanguage", "AVAILABLE_LANGUAGES", "preCheckInOpensHours", "onlineCheckOutEnabled", "showFolioBalance", "requireIdScan", "Recomendaciones locales"]) {
      assert.doesNotMatch(code, new RegExp(forbidden), `sin «${forbidden}»`);
    }
    assert.doesNotMatch(code, /Los cambios se aplican en la próxima visita al portal/, "el «guardado» local desapareció");
    assert.doesNotMatch(code, /extensión PII/, "sin afirmaciones inventadas sobre el cifrado");
    assert.doesNotMatch(code, /\sstyle=\{/, "0 style= inline");
    // Solo dos interruptores reales.
    assert.equal((code.match(/<CocoaSwitch /g) ?? []).length, 2);
    assert.match(code, /set\("postStaySurveyEnabled", v\)/);
    assert.match(code, /set\("allowPayAtReception", v\)/);
    assert.match(code, /set\("postStaySurveyDelayHours", v\)/);
    assert.match(code, /disabled=\{!canManage \|\| !policy \|\| !form\.postStaySurveyEnabled\}/, "las horas solo se editan con la encuesta activa");
  });
});

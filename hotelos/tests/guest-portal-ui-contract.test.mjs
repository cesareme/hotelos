import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// Sprint 37b rewrote the guest portal into a focused self-service app
// (sign-in -> stay overview -> pre-check-in / service request) and Sprint 45
// wired magic-link token auto-detection. This contract validates that
// current architecture (the pre-Sprint-37b scaffold was removed).
// Tanda CHK · W4-C added the 6-step check-in wizard (CheckInWizardPage),
// the arrival page, the kiosk mode and moved the guest session from
// localStorage to sessionStorage (diseño §4a paso 2: nunca localStorage).

const guestPackageJson = JSON.parse(
  readFileSync(new URL("../apps/guest-web/package.json", import.meta.url), "utf8")
);
const guestApp = readFileSync(new URL("../apps/guest-web/src/App.tsx", import.meta.url), "utf8");
const guestStyles = readFileSync(new URL("../apps/guest-web/src/styles.css", import.meta.url), "utf8");
const apiClient = readFileSync(new URL("../apps/guest-web/src/api/client.ts", import.meta.url), "utf8");
const sessionCtx = readFileSync(
  new URL("../apps/guest-web/src/auth/GuestSessionContext.tsx", import.meta.url),
  "utf8"
);

const PAGE = (name) => new URL(`../apps/guest-web/src/pages/${name}`, import.meta.url);

describe("Guest Portal UI layer", () => {
  it("is a standalone guest-web workspace app", () => {
    assert.equal(guestPackageJson.name, "@hotelos/guest-web");
    assert.equal(existsSync(new URL("../apps/guest-web/src/main.tsx", import.meta.url)), true);
    assert.equal(existsSync(new URL("../apps/guest-web/src/auth/GuestSessionContext.tsx", import.meta.url)), true);
  });

  it("implements the four guest self-service pages", () => {
    for (const page of [
      "SignInPage.tsx",
      "StayOverviewPage.tsx",
      "PreCheckInPage.tsx",
      "ServiceRequestPage.tsx"
    ]) {
      assert.equal(existsSync(PAGE(page)), true, `${page} should exist`);
    }
  });

  it("uses the warm guest-facing design tokens (not the admin Aurora)", () => {
    // Sprint 37b cream + gold palette
    assert.match(guestStyles, /#fdfbf7/i);
    assert.match(guestStyles, /#b08a3e/i);
  });

  it("calls the real guest-portal API with stub fallback", () => {
    assert.match(apiClient, /\/guest-portal\/sign-in/);
    assert.match(apiClient, /\/guest-portal\/reservation/);
    assert.match(apiClient, /\/guest-portal\/pre-check-in/);
    assert.match(apiClient, /\/guest-portal\/service-request/);
    // honours the env base + falls back to stubs offline
    assert.match(apiClient, /VITE_GUEST_API_BASE/);
  });

  it("auto-detects the magic-link token on load (Sprint 45)", () => {
    assert.match(guestApp + apiClient, /token/);
    assert.match(guestApp, /replaceState|URLSearchParams|location\.search/);
  });

  it("keeps the guest session in sessionStorage only (reload yes, tab close no; never localStorage)", () => {
    assert.match(sessionCtx, /window\.sessionStorage/);
    assert.doesNotMatch(sessionCtx, /localStorage/);
    // Kiosk mode never persists the guest session (persist prop).
    assert.match(sessionCtx, /persist/);
  });

  it("keeps the legal data-retention disclosure visible", () => {
    const preCheckIn = readFileSync(PAGE("PreCheckInPage.tsx"), "utf8");
    assert.match(preCheckIn, /933\/2021|retention|retención/i);
  });

  // ---- Tanda CHK · W4-C ------------------------------------------------------

  it("implements CheckInWizardPage and ArrivalPage (six steps, camera, signature, kiosk shell)", () => {
    for (const page of ["CheckInWizardPage.tsx", "ArrivalPage.tsx"]) {
      assert.equal(existsSync(PAGE(page)), true, `${page} should exist`);
    }
    for (const file of ["components/DocumentCamera.tsx", "components/SignaturePad.tsx", "checkin/wizard.ts", "kiosk/KioskShell.tsx", "kiosk/kiosk-mode.ts"]) {
      assert.equal(existsSync(new URL(`../apps/guest-web/src/${file}`, import.meta.url)), true, `${file} should exist`);
    }
    const wizardLogic = readFileSync(new URL("../apps/guest-web/src/checkin/wizard.ts", import.meta.url), "utf8");
    assert.match(wizardLogic, /WIZARD_STEPS = \["travellers", "document", "details", "signature", "payment", "arrival"\]/);
    for (const fn of ["nextStep", "canAdvance", "missingFor", "normalizeMrzText", "formatDocumentHint", "isMinorAt"]) {
      assert.match(wizardLogic, new RegExp(`export function ${fn}\\(`), `wizard.ts exports ${fn}`);
    }
    const kiosk = readFileSync(new URL("../apps/guest-web/src/kiosk/kiosk-mode.ts", import.meta.url), "utf8");
    assert.match(kiosk, /export function parseKioskParams\(/);
    assert.match(kiosk, /idleTimeoutMs = IDLE_TIMEOUT_MS/);
    assert.match(kiosk, /IDLE_TIMEOUT_MS = 90_000/);
    assert.match(kiosk, /export function resetSession\(/);
    const camera = readFileSync(new URL("../apps/guest-web/src/components/DocumentCamera.tsx", import.meta.url), "utf8");
    assert.match(camera, /type="file" accept="image\/\*" capture="environment"/);
    assert.match(camera, /getUserMedia/);
    assert.match(guestApp, /kiosk/);
    assert.match(guestApp, /CheckInWizardPage/);
    assert.equal(guestPackageJson.scripts.test, 'node --import ../api/node_modules/tsx/dist/loader.mjs --test "src/**/__tests__/*.test.mts"');
    assert.equal(guestPackageJson.scripts.build, "vite build");
  });

  it("the wizard shows the retention notice (RD 933/2021)", () => {
    const wizard = readFileSync(PAGE("CheckInWizardPage.tsx"), "utf8");
    assert.match(wizard, /933\/2021|retention|retención/i);
    const wizardLogic = readFileSync(new URL("../apps/guest-web/src/checkin/wizard.ts", import.meta.url), "utf8");
    assert.match(wizardLogic, /RD 933\/2021/);
  });

  it("client.ts calls /guest-portal/check-in (session, guests, document, signature, payment, OTP, arrive, kiosk claim) and /guest-portal/chat", () => {
    assert.match(apiClient, /\/guest-portal\/check-in/);
    for (const fn of ["getCheckIn", "patchCheckIn", "addGuest", "patchGuest", "removeGuest", "uploadDocument", "submitMrz", "signGuest", "requestPaymentLink", "requestOtp", "verifyOtp", "arrive", "claimKiosk", "chat", "completeCheckIn"]) {
      assert.match(apiClient, new RegExp(`export async function ${fn}\\(`), `client.ts exports ${fn}`);
    }
    assert.match(apiClient, /"x-guest-token"/);
    assert.match(apiClient, /"x-kiosk-token"/);
    assert.match(apiClient, /\/guest-portal\/chat/);
    assert.match(apiClient, /kiosk\/claim/);
  });

  // Tanda CHK · corrector (revisión 3).
  it("REV3-10: chat() envía { text } (GuestChatSchema estricto) y el widget de chat está montado en la estancia y en el asistente", () => {
    assert.match(apiClient, /body: JSON\.stringify\(\{ text, /, "el cuerpo del bot es { text, conversationId?, language? }");
    assert.doesNotMatch(apiClient, /JSON\.stringify\(\{ message,/, "la ruta rechaza `message` con 400");
    assert.equal(existsSync(new URL("../apps/guest-web/src/components/ChatWidget.tsx", import.meta.url)), true);
    const widget = readFileSync(new URL("../apps/guest-web/src/components/ChatWidget.tsx", import.meta.url), "utf8");
    assert.match(widget, /disclosureShown/, "muestra el aviso de IA cuando el API lo declara");
    assert.match(widget, /pending_confirmation|handoff/, "muestra la acción del turno");
    for (const page of ["StayOverviewPage.tsx", "CheckInWizardPage.tsx"]) {
      assert.match(readFileSync(PAGE(page), "utf8"), /<ChatWidget /, `${page} monta el chat`);
    }
  });

  it("REV3-11: con documento ya conocido el paso 2 sigue ofreciendo «Volver a leer el documento» (cámara + MRZ) y distingue el origen perfil/MRZ", () => {
    const wizard = readFileSync(PAGE("CheckInWizardPage.tsx"), "utf8");
    assert.match(wizard, /documentReread/);
    assert.match(wizard, /export function documentOriginLabel\(/);
    assert.match(wizard, /documentSourceProfile/);
    assert.match(wizard, /identity_mismatch/, "una MRZ ajena se anuncia sin aplicar los datos");
    const copy = readFileSync(new URL("../apps/guest-web/src/checkin/wizard.ts", import.meta.url), "utf8");
    for (const key of ["documentReread", "documentSourceProfile", "documentMismatch", "chatTitle", "chatDisclosure"]) {
      assert.equal((copy.match(new RegExp(`^  ${key}: "`, "gm")) ?? []).length, 2, `${key} en es y en`);
    }
  });

  it("REV3-14: la llegada pinta la llave como QR (SVG inline, codificador propio) y la validez en la zona horaria de la propiedad", () => {
    const arrival = readFileSync(PAGE("ArrivalPage.tsx"), "utf8");
    assert.match(arrival, /<QrCode value=\{key\.qr\}/);
    assert.doesNotMatch(arrival, /<code className="gp-qr-payload">\{key\.qr\}<\/code>/, "el payload hotelos://unlock ya no se pinta como texto");
    assert.match(arrival, /export function formatKeyValidity\(/);
    assert.match(arrival, /formatKeyValidity\(key\.validUntil, lang, timeZone\)/);
    assert.equal(existsSync(new URL("../apps/guest-web/src/checkin/qr-encoder.ts", import.meta.url)), true);
    assert.equal(existsSync(new URL("../apps/guest-web/src/components/QrCode.tsx", import.meta.url)), true);
    assert.match(apiClient, /propertyTimezone/);
  });
});

// ---- Tanda L7 · L7-01 · Portal base: español, a11y y textos honestos ----------
// Las páginas fuera del asistente (sesión, estancia, pre-check-in clásico,
// peticiones) hablan por `t(lang, clave)` (wizard.ts COPY_ES/COPY_EN), el
// idioma vive en App (LangContext en Layout) y se refleja en <html lang>; sin
// teléfono inventado, sin factura de mentira y el aviso «cualquier código entra»
// solo cuando no hay API. Controles ≥ 44 px, foco visible, skip link, aria-live.

const L7_PAGES = ["SignInPage.tsx", "StayOverviewPage.tsx", "PreCheckInPage.tsx", "ServiceRequestPage.tsx"];
const guestLayout = readFileSync(new URL("../apps/guest-web/src/components/Layout.tsx", import.meta.url), "utf8");
const guestIndexHtml = readFileSync(new URL("../apps/guest-web/index.html", import.meta.url), "utf8");
const guestConfig = readFileSync(new URL("../apps/guest-web/src/config/guest-config.ts", import.meta.url), "utf8");
const wizardCopy = readFileSync(new URL("../apps/guest-web/src/checkin/wizard.ts", import.meta.url), "utf8");

/** Quita comentarios (// y /* *\/, también dentro de JSX) para mirar solo el código que se pinta. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// Literales ingleses que estas páginas y la cabecera pintaban antes de L7-01.
const FORBIDDEN_EN_PORTAL = [
  "Sign out", "Welcome", "Guest portal", "Continue", "Signing in", "Signing you in", "Reservation code", "Need help?",
  "Your stay", "Loading your stay", "Loading reservation", "Dates pending", "Balance due", "Guests", "Request a service",
  "View invoice", "Download a copy", "Contact concierge", "Call the front desk", "Save time at arrival", "Confirmed", "Checked out", "Cancelled",
  "Back to my stay", "Speed up your arrival", "Document type", "Document number", "Residence address", "Country of residence",
  "Estimated arrival", "Special requests", "Submit pre-check-in", "Confirmation number", "You're all set", "Your data is encrypted",
  "Service request", "How can we help?", "Category", "Housekeeping", "Food & beverage", "Concierge", "Maintenance", "What do you need?",
  "Preferred time", "Send request", "Request received", "Ticket number", "Submit another request", "Sign in failed"
];

describe("Guest Portal · Tanda L7 · L7-01 (español, a11y, honestidad)", () => {
  it("las cuatro páginas y la cabecera hablan por t(lang, clave): sin literales ingleses pintados", () => {
    const sources = [...L7_PAGES.map((page) => [page, readFileSync(PAGE(page), "utf8")]), ["components/Layout.tsx", guestLayout], ["App.tsx", guestApp]];
    for (const [name, raw] of sources) {
      const code = stripComments(raw);
      assert.match(code, /\bt\(lang, "/, `${name} usa t(lang, clave)`);
      for (const literal of FORBIDDEN_EN_PORTAL) {
        const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Texto JSX (>Literal<), atributo/prop ("Literal") o rama de ternario.
        assert.doesNotMatch(code, new RegExp(`(>\\s*|["'\`])${escaped}(\\s*<|["'\`…\\.])`), `${name} pinta «${literal}» sin traducir`);
      }
    }
  });

  it("el copy nuevo del portal existe en las dos tablas (paridad es/en) y el español es el idioma por defecto", () => {
    for (const key of ["signOut", "skipToContent", "langSelector", "signInTitle", "previewAnyCode", "hello", "resConfirmed", "contactAtReception", "preCheckInTitle", "countryOfResidence", "serviceTitle", "catHousekeeping", "sendRequest", "linkExpired", "signingIn"]) {
      assert.equal((wizardCopy.match(new RegExp(`^  ${key}: "`, "gm")) ?? []).length, 2, `${key} en es y en`);
    }
    assert.match(wizardCopy, /COPY\[lang\]\[key\] \?\? COPY\.es\[key\]/, "t() cae al español");
    assert.match(guestApp, /pickLanguage\(/, "idioma inicial por navegador (es por defecto)");
  });

  it("el idioma vive en App (LangContext), el selector es/en está en Layout y <html lang> se sincroniza", () => {
    assert.match(guestLayout, /export const LangContext = createContext/);
    assert.match(guestLayout, /export function useLang\(\)/);
    assert.match(guestApp, /<LangContext\.Provider value=\{\{ lang, setLang \}\}>/);
    assert.match(guestApp, /document\.documentElement\.lang = lang/);
    assert.match(guestLayout, /className="gp-lang-switch" role="group"/);
    assert.match(guestLayout, /aria-pressed=\{lang === option\.code\}/);
    assert.match(guestLayout, /className=\{`gp-link gp-lang/);
    assert.match(guestIndexHtml, /<html lang="es">/);
    assert.doesNotMatch(guestIndexHtml, /lang="en"/);
    for (const page of ["PreCheckInPage.tsx", "ServiceRequestPage.tsx", "SignInPage.tsx"]) {
      assert.match(readFileSync(PAGE(page), "utf8"), /const lang = useLang\(\);/, `${page} lee el idioma del contexto`);
    }
    assert.match(readFileSync(PAGE("StayOverviewPage.tsx"), "utf8"), /lang = "es"/, "StayOverviewPage recibe lang de App con es por defecto");
  });

  it("honestidad: aviso «cualquier código entra» solo sin API, sin teléfono inventado y sin factura stub", () => {
    assert.match(guestConfig, /export function isApiConfigured\(\): boolean/);
    assert.match(guestConfig, /VITE_GUEST_API_BASE/, "misma variable que api/client.ts");
    const signIn = readFileSync(PAGE("SignInPage.tsx"), "utf8");
    assert.match(signIn, /isApiConfigured\(\)/);
    assert.match(signIn, /\{!apiConfigured \? <p className="gp-hint">\{t\(lang, "previewAnyCode"\)\}<\/p> : null\}/, "el aviso solo se pinta sin API");
    assert.doesNotMatch(signIn, /single-use link|in production/i, "no promete un enlace que no se envía");
    assert.match(signIn, /t\(lang, "signInNotFound"\)/, "el ok:false del API se traduce (client.ts lanza un Error en inglés)");
    assert.doesNotMatch(stripComments(signIn), /err\.message/, "nunca pinta el texto crudo del cliente/servidor en el sign-in");
    for (const page of L7_PAGES) {
      const code = stripComments(readFileSync(PAGE(page), "utf8"));
      assert.doesNotMatch(code, /tel:/, `${page} no enlaza un teléfono`);
      assert.doesNotMatch(code, /\+34\d+|000000000/, `${page} no lleva un número inventado`);
    }
    const overview = readFileSync(PAGE("StayOverviewPage.tsx"), "utf8");
    assert.doesNotMatch(overview, /downloadInvoice|onInvoice/, "el botón de factura stub (.txt) se retira; la real llega en L7-06");
    assert.match(overview, /t\(lang, "contactAtReception"\)/, "sin dato de contacto → «pregunta en recepción»");
    assert.match(wizardCopy, /contactAtReception: "Pregunta en recepción"/);
  });

  it("a11y: controles ≥ 44 px, foco visible de 2 px, «Ir al contenido» + <main id>, aria-live en carga y errores, 0 style= inline", () => {
    const block = (selector) => {
      const start = guestStyles.indexOf(`${selector} {`);
      assert.notEqual(start, -1, `${selector} existe en styles.css`);
      return guestStyles.slice(start, guestStyles.indexOf("}", start));
    };
    for (const selector of [".gp-link", ".gp-chip", ".gp-header-top", ".gp-lang", ".gp-skip"]) {
      assert.match(block(selector), /min-height: 44px/, `${selector} ≥ 44 px de alto`);
    }
    assert.match(block(".gp-link"), /min-width: 44px/);
    assert.match(block(".gp-lang"), /min-width: 44px/);
    assert.match(block(".gp-button"), /min-height: 48px/);
    assert.match(block(".gp-action"), /min-height: 96px/);
    assert.match(guestStyles, /:focus-visible \{\n  outline: 2px solid var\(--gp-accent-deep\);/, "anillo de foco global de 2 px");
    assert.match(guestStyles, /\.gp-skip:focus,\n\.gp-skip:focus-visible \{\n  top: 12px;/, "skip link visible al recibir el foco");
    assert.match(guestLayout, /<a className="gp-skip" href="#gp-main">/);
    assert.match(guestLayout, /<main id="gp-main" className="gp-main" tabIndex=\{-1\}>/);
    // Contraste ≥ 4,5:1 del texto secundario y de los estados sobre sus fondos suaves (calculado en L7-01).
    assert.match(guestStyles, /--gp-muted: #726250;/);
    assert.match(guestStyles, /--gp-accent-deep: #836221;/);
    assert.match(guestStyles, /--gp-warn: #8f5d13;/);
    assert.match(guestStyles, /--gp-success: #27704e;/);
    assert.match(guestStyles, /--gp-on-accent: #ffffff;/);
    assert.match(block(".gp-button-primary"), /background: var\(--gp-accent-deep\);\n  color: var\(--gp-on-accent\);/, "texto blanco solo sobre el dorado profundo (≥ 4,5:1)");
    assert.doesNotMatch(guestStyles, /--gp-muted: #9a8a78/);
    // aria-live / role en carga y errores.
    assert.match(guestApp, /className="gp-bootstrap" role="status" aria-live="polite"/);
    const overview = readFileSync(PAGE("StayOverviewPage.tsx"), "utf8");
    assert.match(overview, /<div aria-live="polite" aria-busy=\{loading\}>/);
    assert.match(overview, /className="gp-card gp-skeleton" role="status"/);
    assert.match(overview, /className="gp-card gp-error" role="alert"/);
    for (const page of ["SignInPage.tsx", "PreCheckInPage.tsx", "ServiceRequestPage.tsx"]) {
      const code = readFileSync(PAGE(page), "utf8");
      assert.match(code, /<div aria-live="polite">\{error \? <p className="gp-error" role="alert">/, `${page} anuncia los errores`);
      assert.match(code, /aria-busy=\{submitting\}/, `${page} marca el envío`);
    }
    // 0 `style=` inline en todo guest-web (Cocoa).
    const srcDir = new URL("../apps/guest-web/src/", import.meta.url);
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : entry.name.endsWith(".tsx") ? [new URL(entry.name, dir)] : []));
    for (const file of walk(srcDir)) {
      assert.doesNotMatch(stripComments(readFileSync(file, "utf8")), /\sstyle=\{/, `${file.pathname} sin style= inline`);
    }
  });
});

// ---- Tanda L7 · L7-06 · Portal: estancia y salida (folio real, facturas, peticiones, pago honesto) ----
// La estancia se pinta desde GET /guest-portal/stay (L7-02): etapa → CTA (stay/stay.ts puro),
// folio REAL, facturas emitidas (PDF del API por cabecera), peticiones con estado, datos del
// hotel solo si el API los da; CheckOutPage (pago honesto + peticiones de salida) y StayInfoPage.
// Sin stub de factura (.txt) y sin «Pagar ahora» fuera de un enlace real.

const stayLogic = readFileSync(new URL("../apps/guest-web/src/stay/stay.ts", import.meta.url), "utf8");
const sharedGuestPortalTypes = readFileSync(new URL("../packages/shared/src/guest-portal-types.ts", import.meta.url), "utf8");
const L706_PAGES = ["StayOverviewPage.tsx", "CheckOutPage.tsx", "StayInfoPage.tsx"];

/** Lee un array `as const` de literales de un fichero TS: `export const NAME = ["a", "b"] as const`. */
function constArray(source, name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]+)\\] as const`));
  assert.ok(match, `${name} declarado como array as const`);
  return match[1].split(",").map((part) => part.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

describe("Guest Portal · Tanda L7 · L7-06 (estancia y salida)", () => {
  it("existen CheckOutPage, StayInfoPage y el módulo puro stay/stay.ts con su test", () => {
    for (const page of ["CheckOutPage.tsx", "StayInfoPage.tsx"]) assert.equal(existsSync(PAGE(page)), true, `${page} should exist`);
    assert.equal(existsSync(new URL("../apps/guest-web/src/stay/stay.ts", import.meta.url)), true);
    assert.equal(existsSync(new URL("../apps/guest-web/src/stay/__tests__/stay.test.mts", import.meta.url)), true);
    for (const fn of ["stageOf", "deriveStage", "stayActions", "primaryAction", "checkOutOptions", "buildStayRequest", "formatFolio", "formatMoney", "folioStatusKey", "balanceSummary", "paymentOutcome", "paymentRedirectOf", "canOfferPayment", "infoRows", "telHref", "invoiceFilename"]) {
      assert.match(stayLogic, new RegExp(`export function ${fn}\\(`), `stay.ts exports ${fn}`);
    }
    assert.doesNotMatch(stayLogic, /from "react"|document\.|window\.|fetch\(/, "stay.ts es puro (sin React, DOM ni fetch)");
  });

  it("los tipos espejo de stay.ts coinciden con el contrato wire (etapas, clases de petición y estados de folio)", () => {
    assert.deepEqual(constArray(stayLogic, "STAY_STAGES"), constArray(sharedGuestPortalTypes, "GUEST_STAY_STAGES"));
    assert.deepEqual(constArray(stayLogic, "STAY_REQUEST_KINDS"), constArray(sharedGuestPortalTypes, "GUEST_STAY_REQUEST_KINDS"));
    assert.deepEqual(constArray(stayLogic, "STAY_FOLIO_STATUSES"), constArray(sharedGuestPortalTypes, "GUEST_STAY_FOLIO_STATUSES"));
  });

  it("client.ts llama a las rutas L7-02 (stay, requests, payment-link, invoices/:id/pdf) y retira el stub de factura", () => {
    for (const fn of ["getStay", "invoicePdfBlob", "saveInvoicePdf", "requestStayAction", "requestStayPaymentLink"]) {
      assert.match(apiClient, new RegExp(`export async function ${fn}\\(`), `client.ts exports ${fn}`);
    }
    assert.match(apiClient, /const STAY_PATH = "\/guest-portal\/stay"/);
    assert.match(apiClient, /`\$\{STAY_PATH\}\/requests`/);
    assert.match(apiClient, /`\$\{STAY_PATH\}\/payment-link`/);
    assert.match(apiClient, /\/guest-portal\/invoices\/\$\{encodeURIComponent\(invoiceId\)\}\/pdf/);
    // El PDF viaja con el token en la cabecera, nunca en la URL (?token=).
    assert.doesNotMatch(apiClient, /pdf\?token=|token=\$\{/, "el token del portal no va en la URL del PDF");
    assert.match(apiClient, /headers: \{ Accept: "application\/pdf", \.\.\.guestHeaders\(\) \}/);
    assert.doesNotMatch(apiClient, /export async function downloadInvoice\(|Provisional invoice|text\/plain;charset=utf-8|invoice-\$\{reservationId\}\.txt/, "sin factura .txt inventada");
    assert.doesNotMatch(apiClient, /import \{ BRAND \}/, "client.ts ya no necesita la marca (solo la usaba el stub)");
    // Stubs honestos sin API: el enlace de pago nunca es «link_sent» ni «paid» con folio con saldo.
    assert.match(apiClient, /reason: "DEMO_SIN_API"/);
    assert.match(apiClient, /code: "DEMO_NO_API"/);
  });

  it("request() solo fija Content-Type: application/json cuando hay cuerpo (DELETE …/guests/:id → «Quitar» funciona)", () => {
    assert.match(apiClient, /\.\.\.\(init\?\.body !== undefined && init\?\.body !== null \? \{ "Content-Type": "application\/json" \} : \{\}\)/);
    assert.doesNotMatch(apiClient, /headers: \{\n\s+"Content-Type": "application\/json",/, "la cabecera incondicional se retira");
  });

  it("StayOverviewPage pinta desde getStay(): etapa + CTA (stayActions), folio real, facturas, peticiones, encuesta y chat sin sesión CHK", () => {
    const overview = stripComments(readFileSync(PAGE("StayOverviewPage.tsx"), "utf8"));
    assert.match(overview, /getStay\(\)/);
    assert.doesNotMatch(overview, /getReservation\(|getCheckIn\(/, "una sola llamada: la vista de la estancia ya trae reserva y check-in");
    // Corrector REV-L7-02: `stayed` (una confirmada con la salida pasada nunca se alojó → sin encuesta ni «gracias»).
    assert.match(overview, /stayActions\(stage, stay\.checkIn, stay\.survey, \{ surveyEnabled, stayed \}\)/);
    assert.match(overview, /stageHintKey\(stage, reservation\.status\)/);
    // Corrector REV-L7-03: el botón del folio depende de la etapa (ninguno con la reserva cancelada; «Cuenta y facturas» tras la salida).
    assert.match(overview, /const folioAction = stage \? folioActionKey\(stage\) : null;/);
    assert.match(overview, /\{folioAction \? \(\n\s+<button type="button" className="gp-button gp-button-ghost" onClick=\{\(\) => onNavigate\("checkout"\)\}>\n\s+\{t\(lang, folioAction\)\}/);
    assert.doesNotMatch(overview, /\{t\(lang, "ctaCheckOut"\)\}/, "sin botón incondicional «Salida y cuenta»");
    // Corrector REV-L7-05: tras la salida no se ofrece «Pedir un servicio».
    assert.match(overview, /stage !== "cancelled" && stage !== "post_stay" \? \(/);
    assert.match(overview, /\{stage === "post_stay" && stayed \? \(/, "bloque de encuesta solo con estancia real");
    assert.match(overview, /STAGE_LABEL_KEY\[stage\]/);
    assert.match(overview, /formatFolio\(stay\.folio, lang, stay\.reservation\.currency/);
    assert.match(overview, /balanceSummary\(stay\.folio, lang, reservation\.currency\)/, "saldo real del folio, nunca un 0 literal");
    assert.match(overview, /stay\.invoices\.map\(/);
    assert.match(overview, /saveInvoicePdf\(\{ id: invoiceId \}\)/);
    assert.match(overview, /stay\.requests\.map\(/);
    assert.match(overview, /requestStatusView\(request\.status, lang\)/);
    assert.match(overview, /stay\.info\.receptionPhone \?\? t\(lang, "contactAtReception"\)/, "teléfono solo si el hotel lo publica");
    assert.match(overview, /stage === "post_stay"/);
    assert.match(overview, /surveyAnswered|surveyInvited|surveyNotInvited/);
    // El bot responde con el token del portal sin CheckInSession (checkin.routes.ts W4-D): ya no se ata a checkInAvailable.
    assert.match(overview, /\{stage !== "cancelled" \? <ChatWidget lang=\{lang\} propertyName=\{reservation\.propertyName\} \/> : null\}/);
    assert.doesNotMatch(overview, /checkInAvailable/);
    assert.match(overview, /t\(lang, "demoNoApi"\)/, "sin API la página dice que los datos son de demostración");
    assert.match(overview, /onNavigate\("checkout"\)/);
    assert.match(overview, /onNavigate\("info"\)/);
    assert.match(guestApp, /import \{ CheckOutPage \} from ".\/pages\/CheckOutPage"/);
    assert.match(guestApp, /import \{ StayInfoPage \} from ".\/pages\/StayInfoPage"/);
    assert.match(guestApp, /page === "checkout"/);
    assert.match(guestApp, /page === "info"/);
  });

  it("CheckOutPage: pago honesto («Pagar ahora» solo con enlace real; sin PSP «en recepción»), peticiones de salida con nº SRQ y facturas", () => {
    const checkout = stripComments(readFileSync(PAGE("CheckOutPage.tsx"), "utf8"));
    assert.match(checkout, /requestStayPaymentLink\(/);
    assert.match(checkout, /paymentOutcome\(response, stay\.folio\)/);
    // Corrector REV-L7-03: cabecera propia de la cancelada y nunca CTA de pago con la reserva cancelada.
    assert.match(checkout, /const copy = checkOutCopy\(stage\);/);
    assert.match(checkout, /const offerPayment = stay \? canOfferPayment\(stay\.folio, stage\) : false;/);
    assert.match(checkout, /\{stage === "cancelled" \? <p className="gp-payment-message">\{t\(lang, "paymentCancelledAtReception"\)\}<\/p> : null\}/);
    assert.match(checkout, /title=\{t\(lang, copy\.titleKey\)\}/);
    // «Pagar ahora» (payNow) SOLO dentro de la rama con redirect real (GET enlace / POST formulario).
    const payNowUses = checkout.match(/t\(lang, "payNow"\)/g) ?? [];
    assert.equal(payNowUses.length, 2, "dos usos de «Pagar ahora»: enlace GET y formulario POST");
    assert.match(checkout, /payment\.kind === "link" && payment\.redirect\.method === "GET" \? \(\s*<a className="gp-button gp-button-primary" href=\{payment\.redirect\.url\} target="_blank" rel="noopener noreferrer">\s*\{t\(lang, "payNow"\)\}/);
    assert.match(checkout, /payment\.kind === "link" && payment\.redirect\.method === "POST" \? \(\s*<form/);
    assert.match(checkout, /t\(lang, "getPaymentLink"\)/, "el primer botón pide el enlace, no promete pagar");
    assert.match(checkout, /"paymentSettled" : "paymentNoChargesYet"/, "folio sin líneas nunca es «todo pagado»");
    assert.match(checkout, /requestStayAction\(buildStayRequest\(kind, note, preferredTime\)\)/);
    assert.match(checkout, /checkOutOptions\(stageOf\(data\)\)/);
    assert.match(checkout, /isApiError\(err, "STAY_CLOSED"\)/);
    assert.match(checkout, /<p className="gp-confirmation">\{ticket\.number\}<\/p>/, "muestra el nº de petición SRQ-<8>");
    assert.match(checkout, /type="time"/, "hora preferida «HH:MM» para la salida tardía");
    assert.match(checkout, /maxLength=\{500\}/);
    assert.match(checkout, /saveInvoicePdf\(\{ id: invoiceId \}\)/);
    assert.match(checkout, /const lang = useLang\(\);/);
  });

  it("StayInfoPage: solo filas con valor del API (infoRows), teléfono como tel: solo si es un número, y aviso honesto si no hay datos", () => {
    const info = stripComments(readFileSync(PAGE("StayInfoPage.tsx"), "utf8"));
    assert.match(info, /infoRows\(stay\.info\)/);
    assert.match(info, /telHref\(stay\?\.info\.receptionPhone\)/);
    assert.match(info, /t\(lang, "infoEmpty"\)/);
    assert.doesNotMatch(info, /\+34\d+|000000000/, "sin número inventado");
    assert.match(info, /const lang = useLang\(\);/);
    assert.match(info, /<dl className="gp-info-list">/);
  });

  it("las páginas nuevas hablan por t(lang, clave), sin literales ingleses, y el copy L7-06 existe en es y en", () => {
    for (const page of L706_PAGES) {
      const code = stripComments(readFileSync(PAGE(page), "utf8"));
      assert.match(code, /\bt\(lang, "/, `${page} usa t(lang, clave)`);
      for (const literal of [...FORBIDDEN_EN_PORTAL, "Pay now", "Your bill", "Invoices", "Download PDF", "Express check-out", "Late check-out", "Hotel information", "Wi-Fi", "Loading"]) {
        const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.doesNotMatch(code, new RegExp(`(>\\s*|["'\`])${escaped}(\\s*<|["'\`…\\.])`), `${page} pinta «${literal}» sin traducir`);
      }
      assert.doesNotMatch(code, /\sstyle=\{/, `${page} sin style= inline`);
      assert.match(code, /aria-live="polite"/, `${page} anuncia carga/errores`);
    }
    for (const key of [
      "demoNoApi", "stagePreArrival", "stageArrivalDay", "stageInHouse", "stageDepartureDay", "stagePostStay", "stageCancelled", "ctaArrive", "ctaCheckOut", "ctaExpressCheckOut", "ctaSurvey",
      "folioTitle", "folioNoCharges", "folioSettled", "folioBalanceDue", "getPaymentLink", "paymentAtReceptionStay", "paymentNoChargesYet", "kindExpressCheckout", "kindLateCheckout", "kindInvoiceEmail", "kindLuggage",
      "sendToReception", "requestsTitle", "invoicesTitle", "invoicesEmpty", "invoiceDownload", "infoTitle", "infoWifi", "infoEmpty", "surveyInvited", "surveyAnswered", "checkOutRequestsClosed", "stayClosedError"
    ]) {
      assert.equal((wizardCopy.match(new RegExp(`^  ${key}: "`, "gm")) ?? []).length, 2, `${key} en es y en`);
    }
    assert.match(wizardCopy, /ctaArrive: "Llegar"/);
    assert.match(wizardCopy, /ctaExpressCheckOut: "Salida exprés"/);
    assert.match(wizardCopy, /paymentAtReceptionStay: "El saldo pendiente se cobra en recepción; no tienes que hacer nada más ahora\."/);
  });

  it("a11y L7-06: resumen del desplegable y enlaces-botón ≥ 44 px, listas por clase (0 style= inline)", () => {
    const block = (selector) => {
      const start = guestStyles.indexOf(`${selector} {`);
      assert.notEqual(start, -1, `${selector} existe en styles.css`);
      return guestStyles.slice(start, guestStyles.indexOf("}", start));
    };
    assert.match(block(".gp-fold > summary"), /min-height: 44px/);
    assert.match(block("a.gp-button"), /text-decoration: none/);
    for (const selector of [".gp-lines", ".gp-line", ".gp-line-total", ".gp-list", ".gp-list-item", ".gp-info-list", ".gp-info-row", ".gp-action-primary", ".gp-error-text"]) {
      assert.notEqual(guestStyles.indexOf(`${selector} {`), -1, `${selector} existe`);
    }
  });
});

// ---- Tanda L7 · L7-08 · Portal: página de encuesta post-estancia (contrato L7-04 §19.7) ----
// `?survey=1&token=…` abre SurveyPage (App.tsx wantsSurvey, como wantsCheckInWizard); NPS 0-10
// como radiogroup de botones ≥ 44 px (gp-chip + gp-link), comentario ≤ 2000, envío a
// POST /guest-portal/survey (client.ts getSurvey/submitSurvey), «Gracias» con vuelta a la
// estancia; respondida / todavía no / cancelada como estado; enlace caducado → sign-in.

describe("Guest Portal · Tanda L7 · L7-08 (encuesta post-estancia)", () => {
  const surveyPage = readFileSync(PAGE("SurveyPage.tsx"), "utf8");
  const surveyCode = stripComments(surveyPage);

  it("existe SurveyPage y App.tsx la abre con ?survey=1 (o /survey) y desde «Responder la encuesta» de la estancia", () => {
    assert.equal(existsSync(PAGE("SurveyPage.tsx")), true);
    assert.match(guestApp, /import \{ SurveyPage \} from ".\/pages\/SurveyPage"/);
    assert.match(guestApp, /function wantsSurvey\(\): boolean/);
    assert.match(guestApp, /get\("survey"\) === "1"/);
    assert.match(guestApp, /path === "\/survey" \|\| path\.endsWith\("\/survey"\)/);
    assert.match(guestApp, /wantsCheckInWizard\(\) \? "checkin" : wantsSurvey\(\) \? "survey" : "overview"/, "el enlace del asistente sigue mandando; después la encuesta");
    assert.match(guestApp, /page === "survey"/);
    assert.match(guestApp, /<SurveyPage onBack=\{\(\) => setPage\("overview"\)\} \/>/);
    assert.match(guestApp, /surveyEnabled\n/, "StayOverviewPage recibe surveyEnabled: el CTA «Responder la encuesta» ya lleva a una página");
    assert.doesNotMatch(stripComments(guestApp), /if \(destination === "survey"\) return;/, "el destino «survey» ya no se ignora");
    assert.match(guestApp, /type Page = .*"survey"/);
  });

  it("client.ts: getSurvey()/submitSurvey() sobre /guest-portal/survey con el token en la cabecera; stub honesto sin API (una sola respuesta)", () => {
    for (const fn of ["getSurvey", "submitSurvey"]) {
      assert.match(apiClient, new RegExp(`export async function ${fn}\\(`), `client.ts exports ${fn}`);
    }
    assert.match(apiClient, /const SURVEY_PATH = "\/guest-portal\/survey"/);
    assert.match(apiClient, /request<SurveyView>\(SURVEY_PATH, \{ headers: guestHeaders\(\) \}\)/);
    assert.match(apiClient, /request<SurveySubmitResult>\(SURVEY_PATH, \{ method: "POST", headers: guestHeaders\(\), body: JSON\.stringify\(input\) \}\)/);
    assert.doesNotMatch(apiClient, /survey\?token=|SURVEY_PATH\}\?token/, "el token nunca va en la URL de la encuesta");
    assert.match(apiClient, /code: "SURVEY_ALREADY_ANSWERED"/, "el stub también rechaza la segunda respuesta");
  });

  it("stay.ts: helpers puros de la encuesta (estado honesto, validación, cuerpo) y tipos espejo del contrato wire", () => {
    for (const fn of ["surveyStatus", "isNpsScore", "scoreQuestion", "extraQuestions", "validateSurvey", "surveyHasErrors", "buildSurveySubmission", "surveyErrorKey"]) {
      assert.match(stayLogic, new RegExp(`export function ${fn}\\(`), `stay.ts exports ${fn}`);
    }
    assert.deepEqual(constArray(stayLogic, "SURVEY_QUESTION_TYPES"), constArray(sharedGuestPortalTypes, "GUEST_SURVEY_QUESTION_TYPES"));
    assert.match(stayLogic, /export const SURVEY_TEXT_MAX = 2000/);
    assert.match(stayLogic, /export const SURVEY_MAX_ANSWERS = 20/);
    // Mismos límites que el API (post-stay-survey.service.ts).
    const surveyService = readFileSync(new URL("../apps/api/src/modules/guest-portal/post-stay-survey.service.ts", import.meta.url), "utf8");
    assert.match(surveyService, /SURVEY_ANSWER_MAX_KEYS = 20/);
    assert.match(surveyService, /SURVEY_ANSWER_TEXT_MAX = 2000/);
    // Post-estancia: «Responder la encuesta» principal con invitación y secundaria sin ella (el API la admite en post_stay).
    assert.match(stayLogic, /if \(surveyOpen && survey\.invited\) return \{ primary: surveyAction, secondary: invoices \};/);
    assert.match(stayLogic, /secondary: surveyOpen \? surveyAction : null/);
  });

  it("SurveyPage: NPS como radiogroup de botones ≥ 44 px (gp-chip + gp-link), flechas, comentario ≤ 2000, envío y «Gracias» con vuelta a la estancia", () => {
    assert.match(surveyCode, /role="radiogroup"/);
    assert.match(surveyCode, /role="radio"/);
    assert.match(surveyCode, /aria-checked=\{value === score\}/);
    assert.match(surveyCode, /className=\{`gp-chip gp-link\$\{value === score \? " is-active" : ""\}`\}/, "pastilla con min-width y min-height de 44 px (gp-link) y estado activo (gp-chip.is-active)");
    assert.match(surveyCode, /tabIndex=\{index === focusedIndex \? 0 : -1\}/, "tabulación itinerante");
    assert.match(surveyCode, /"ArrowRight" \|\| event\.key === "ArrowDown"/);
    assert.match(surveyCode, /values=\{NPS_SCORES\}/);
    assert.match(surveyCode, /maxLength=\{SURVEY_TEXT_MAX\}/);
    assert.match(surveyCode, /submitSurvey\(buildSurveySubmission\(questions, draft\)\)/);
    assert.match(surveyCode, /validateSurvey\(questions, draft\)/);
    assert.match(surveyCode, /surveyStatus\(view\)/);
    assert.match(surveyCode, /SURVEY_STATUS_KEY\[status\]/);
    assert.match(surveyCode, /t\(lang, "surveyThanksTitle"\)/);
    assert.match(surveyCode, /t\(lang, "surveyAnsweredOn", \{ date: formatDay\(view\.answeredAt, lang\) \}\)/);
    assert.match(surveyCode, /isApiError\(err, "SURVEY_ALREADY_ANSWERED"\)/, "409 al repetir → estado respondida, no error crudo");
    assert.match(surveyCode, /isApiError\(err, "SURVEY_NOT_AVAILABLE"\)/);
    // Enlace caducado / sesión revocada: aviso y vuelta al acceso por código (signOut → SignInPage).
    assert.match(surveyCode, /isApiError\(err, "GUEST_SESSION_INVALID"\)/);
    assert.match(surveyCode, /t\(lang, "surveySessionExpired"\)/);
    assert.match(surveyCode, /onClick=\{signOut\}/);
    assert.match(surveyCode, /t\(lang, "surveySignIn"\)/);
    // Vuelta a la estancia y aviso sin API.
    // Corrector L7-REV-01: con la sesión `survey` del enlace (`scoped`) la vuelta es «Entrar en el portal con mi código» (cierra la sesión).
    assert.match(surveyCode, /const backLabel = t\(lang, scoped \? "surveyToPortal" : "backToStay"\);/);
    assert.match(surveyCode, /back=\{\{ label: backLabel, onClick: onBack \}\}/);
    assert.match(guestApp, /if \(session\.scope === "survey"\) \{\n\s+return <SurveyPage scoped onBack=\{signOut\} \/>;/, "el Router solo monta la encuesta con la sesión acotada");
    assert.match(guestApp, /signInWithToken\(token, wantsSurvey\(\) \? \{ scope: "survey" \} : \{\}\)/);
    assert.match(guestApp, /<Router key=\{session\?\.reservationId \?\? "anon"\}/, "REV-L7-06: el Router se remonta por reserva (la página no sobrevive a «Cerrar sesión»)");
    assert.match(apiClient, /const view = await request<SurveyView>\(SURVEY_PATH, \{ headers: guestHeaders\(\) \}\);/, "el enlace de la encuesta se verifica contra GET /guest-portal/survey");
    assert.match(surveyCode, /t\(lang, "demoNoApi"\)/);
    // a11y: carga y errores anunciados, envío marcado, 0 style= inline, sin literales ingleses.
    assert.match(surveyCode, /<div aria-live="polite" aria-busy=\{state === "loading"\}>/);
    assert.match(surveyCode, /aria-busy=\{submitting\}/);
    assert.match(surveyCode, /className="gp-card gp-success" role="status" aria-live="polite"/);
    assert.match(surveyCode, /const lang = useLang\(\);/);
    assert.doesNotMatch(surveyCode, /\sstyle=\{/, "SurveyPage sin style= inline");
    assert.doesNotMatch(surveyCode, /err\.message/, "nunca pinta el texto crudo del servidor");
    for (const literal of [...FORBIDDEN_EN_PORTAL, "Thank you", "Send", "Submit", "Survey", "How was your stay", "Loading"]) {
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.doesNotMatch(surveyCode, new RegExp(`(>\\s*|["'\`])${escaped}(\\s*<|["'\`…\\.])`), `SurveyPage pinta «${literal}» sin traducir`);
    }
  });

  it("el copy L7-08 existe en es y en, con el español por defecto y sin prometer envíos", () => {
    for (const key of [
      "surveyEyebrow", "surveyPageTitle", "surveyPageSubtitle", "surveyLoading", "surveyLoadError", "surveyNpsLegend", "surveyScaleLegend", "surveyScoreOption", "surveyScoreChosen",
      "surveyScoreRequired", "surveyAnswerRequired", "surveyAnswerTooLong", "surveyCommentPlaceholder", "surveySubmit", "surveySubmitting", "surveySendError", "surveyThanksTitle",
      "surveyThanksBody", "surveyAlreadyAnswered", "surveyAnsweredOn", "surveyNotYet", "surveyClosed", "surveySessionExpired", "surveySignIn"
    ]) {
      assert.equal((wizardCopy.match(new RegExp(`^  ${key}: "`, "gm")) ?? []).length, 2, `${key} en es y en`);
    }
    assert.match(wizardCopy, /surveyPageTitle: "¿Qué tal tu estancia\?"/);
    assert.match(wizardCopy, /surveyNpsLegend: "0 = nada probable · 10 = seguro"/);
    assert.match(wizardCopy, /surveySessionExpired: "Tu enlace ha caducado\. Entra con tu código de reserva y tu correo para responder\."/);
  });
});

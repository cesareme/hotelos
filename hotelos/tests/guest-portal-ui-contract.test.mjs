import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";

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

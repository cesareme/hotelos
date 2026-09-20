import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSIGNMENT_WEIGHT_RULES,
  DAYS_MAX,
  KIOSK_FORM_DEFAULTS,
  POLICY_FORM_DEFAULTS,
  canConfigureKiosks,
  canManageCheckInPolicy,
  computeArrivalMetrics,
  isoDayOffset,
  kioskCapabilitiesLabel,
  kioskStatusLabel,
  lastDays,
  metricPctLabel,
  parseWeight,
  toKioskCreateBody,
  toPolicyForm,
  toPolicyPatch,
  toggleInList,
  validateKioskForm,
  validatePolicyForm,
  weightRange
} from "../checkin-settings-view.ts";

// Tanda CHK · W4-B (docs/design/CHECKIN-AUTOMATIZADO-IA.md §8 «Ajustes» y §1.8):
// lógica pura de la pestaña /hoy/check-in-automatizado, sin React ni DOM.

const DTO = {
  propertyId: "prop_chk",
  selfCheckInEnabled: true,
  inviteDaysBefore: 3,
  reminderDaysBefore: 1,
  allowedVerificationMethods: ["visual_reception", "mrz_checksum"],
  requireVisualCheckAtKiosk: true,
  requireInspectedRoom: false,
  depositPolicy: "balance",
  depositAmount: null,
  allowWalkIn: false,
  allowUpgradeSuggestion: true,
  autoAssignLevel: "suggest_and_confirm",
  assignmentWeights: { hk_inspected: 35, inventory_protection: -25 },
  welcomeChannelOrder: ["whatsapp", "email"],
  guestConsentText: null,
  aiDisclosureText: "Este check-in usa IA para leer el documento.",
  updatedAt: "2026-09-19T10:00:00.000Z"
} as const;

describe("Ajustes de check-in · formulario de la política", () => {
  it("el DTO se normaliza a un formulario controlado (pesos como texto, textos vacíos) y vuelve al mismo patch", () => {
    const form = toPolicyForm(DTO as never);
    assert.equal(form.selfCheckInEnabled, true);
    assert.deepEqual(form.weights, { hk_inspected: "35", inventory_protection: "-25" });
    assert.equal(form.depositAmount, "");
    assert.equal(form.guestConsentText, "");
    assert.equal(form.aiDisclosureText, DTO.aiDisclosureText);
    assert.deepEqual(validatePolicyForm(form), {});
    const patch = toPolicyPatch(form);
    assert.deepEqual(patch.assignmentWeights, { hk_inspected: 35, inventory_protection: -25 });
    assert.equal(patch.depositAmount, null);
    assert.equal(patch.guestConsentText, null);
    assert.equal(patch.aiDisclosureText, DTO.aiDisclosureText);
    assert.deepEqual(patch.welcomeChannelOrder, ["whatsapp", "email"]);
    assert.ok(!("propertyId" in patch) && !("updatedAt" in patch), "PolicyPutSchema es strict: sin claves ajenas");
  });
  it("sin DTO (antes de cargar) usa los valores por defecto del modelo y no comparte arrays entre instancias", () => {
    const a = toPolicyForm(null);
    const b = toPolicyForm(undefined);
    assert.equal(a.depositPolicy, "balance");
    assert.equal(a.autoAssignLevel, "suggest_and_confirm");
    assert.deepEqual(a.welcomeChannelOrder, ["whatsapp", "email", "sms"]);
    a.welcomeChannelOrder.push("kiosk" as never);
    assert.deepEqual(b.welcomeChannelOrder, ["whatsapp", "email", "sms"]);
    assert.deepEqual(POLICY_FORM_DEFAULTS.weights, {});
  });
  it("pesos fuera de rango rechazados: bonificaciones 0..100, penalizaciones −100..0, texto que no es número; los vacíos no se envían", () => {
    const form = toPolicyForm(DTO as never);
    form.weights = { hk_inspected: "150", hk_clean: "-5", inventory_protection: "20", free_upgrade: "-120", vip: "abc", returning: "", group: "12" };
    const errors = validatePolicyForm(form);
    assert.equal(errors["weights.hk_inspected"], "Entre 0 y 100.");
    assert.equal(errors["weights.hk_clean"], "Entre 0 y 100.");
    assert.equal(errors["weights.inventory_protection"], "Entre -100 y 0.");
    assert.equal(errors["weights.free_upgrade"], "Entre -100 y 0.");
    assert.equal(errors["weights.vip"], "Entre 0 y 100.");
    assert.equal(errors["weights.returning"], undefined, "vacío = peso por defecto");
    assert.equal(errors["weights.group"], undefined);
    form.weights = { hk_inspected: "100", inventory_protection: "0", free_upgrade: "-100", returning: "  " };
    assert.deepEqual(validatePolicyForm(form), {});
    assert.deepEqual(toPolicyPatch(form).assignmentWeights, { hk_inspected: 100, inventory_protection: 0, free_upgrade: -100 });
    assert.deepEqual(weightRange("inventory_protection"), { min: -100, max: 0 });
    assert.deepEqual(weightRange("unknown_rule"), { min: 0, max: 100 });
    assert.equal(parseWeight(""), null);
    assert.equal(parseWeight("1.5"), undefined);
    assert.equal(parseWeight("-20"), -20);
    for (const rule of ASSIGNMENT_WEIGHT_RULES) {
      const range = weightRange(rule.key);
      assert.ok(rule.defaultValue >= range.min && rule.defaultValue <= range.max, `${rule.key} por defecto dentro de su rango`);
    }
  });
  it("días 0..30, recordatorio nunca antes que la invitación, importe obligatorio con depósito fijo, al menos un método con self check-in", () => {
    const form = toPolicyForm(DTO as never);
    form.inviteDaysBefore = DAYS_MAX + 1;
    form.reminderDaysBefore = -1;
    assert.equal(validatePolicyForm(form).inviteDaysBefore, "Entre 0 y 30 días.");
    assert.equal(validatePolicyForm(form).reminderDaysBefore, "Entre 0 y 30 días.");
    form.inviteDaysBefore = 2;
    form.reminderDaysBefore = 5;
    assert.match(validatePolicyForm(form).reminderDaysBefore ?? "", /después de la invitación/);
    form.reminderDaysBefore = 1;
    form.depositPolicy = "fixed";
    form.depositAmount = "";
    assert.match(validatePolicyForm(form).depositAmount ?? "", /importe/);
    form.depositAmount = "12,5";
    assert.match(validatePolicyForm(form).depositAmount ?? "", /decimales/);
    form.depositAmount = "120.00";
    assert.equal(validatePolicyForm(form).depositAmount, undefined);
    assert.equal(toPolicyPatch(form).depositAmount, "120.00");
    form.allowedVerificationMethods = [];
    assert.match(validatePolicyForm(form).allowedVerificationMethods ?? "", /al menos un método/);
    form.selfCheckInEnabled = false;
    assert.equal(validatePolicyForm(form).allowedVerificationMethods, undefined, "sin self check-in no se exige método");
    form.welcomeChannelOrder = [];
    assert.match(validatePolicyForm(form).welcomeChannelOrder ?? "", /canal/);
  });
  it("toggleInList conserva el orden de pulsación (canales de bienvenida en orden)", () => {
    assert.deepEqual(toggleInList(["email"], "whatsapp"), ["email", "whatsapp"]);
    assert.deepEqual(toggleInList(["email", "whatsapp"], "email"), ["whatsapp"]);
  });
});

describe("Ajustes de check-in · métricas §1.8", () => {
  it("métricas con 0 llegadas no dividen por cero: porcentajes null y «—» en pantalla", () => {
    const empty = computeArrivalMetrics([]);
    assert.deepEqual(empty, { arrivals: 0, invited: 0, preCheckInCompleted: 0, assigned: 0, keysIssued: 0, keysSigned: 0, invitedPct: null, preCheckInPct: null, assignedPct: null, keysPct: null });
    assert.equal(metricPctLabel(empty.preCheckInPct, (v) => `${v} %`), "—");
    assert.equal(metricPctLabel(62.5, (v) => `${v} %`), "62.5 %");
  });
  it("cuenta completados (ready_for_arrival · arrived · checked_in; handed_off NO), invitadas, asignadas y llaves firmadas (el QR de demo no es «sin recepción»)", () => {
    const metrics = computeArrivalMetrics([
      { status: "confirmed", preCheckIn: { status: "ready_for_arrival" }, assignedRoomId: "r1", key: null },
      { status: "confirmed", preCheckIn: { status: "invited" }, assignedRoomId: null, key: null },
      { status: "checked_in", preCheckIn: { status: "checked_in" }, assignedRoomId: "r2", key: { serialNumber: "K1", signed: false } },
      { status: "checked_in", preCheckIn: { status: "checked_in" }, assignedRoomId: "r3", key: { serialNumber: "K2", signed: true } },
      { status: "confirmed", preCheckIn: { status: "handed_off" }, assignedRoomId: null, key: null },
      { status: "confirmed", preCheckIn: null, assignedRoomId: null, key: null }
    ]);
    assert.equal(metrics.arrivals, 6);
    assert.equal(metrics.invited, 5);
    // corrector REV3-09: la sesión derivada a recepción (handed_off) no cuenta como pre-check-in hecho.
    assert.equal(metrics.preCheckInCompleted, 3);
    assert.equal(metrics.preCheckInPct, 50);
    assert.equal(metrics.assignedPct, 50);
    // corrector REV3-13: 2 llaves emitidas, 1 firmada → «llaves sin recepción» = 1/6.
    assert.equal(metrics.keysIssued, 2);
    assert.equal(metrics.keysSigned, 1);
    assert.equal(metrics.keysPct, 16.7);
  });
  it("ventana de días en ISO local (7 días terminando hoy; mañana = +1)", () => {
    const base = new Date(2026, 8, 20, 15, 30);
    assert.equal(isoDayOffset(base, 0), "2026-09-20");
    assert.equal(isoDayOffset(base, 1), "2026-09-21");
    assert.equal(isoDayOffset(base, -1), "2026-09-19");
    assert.deepEqual(lastDays(base, 7), ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"]);
    assert.equal(isoDayOffset(new Date(2026, 0, 1), -1), "2025-12-31");
  });
});

describe("Ajustes de check-in · kioscos y permisos", () => {
  it("el alta exige nombre (≤ 80) y manda solo name + capabilities (KioskCreateSchema strict)", () => {
    assert.match(validateKioskForm({ ...KIOSK_FORM_DEFAULTS }).name ?? "", /nombre/);
    assert.match(validateKioskForm({ ...KIOSK_FORM_DEFAULTS, name: "x".repeat(81) }).name ?? "", /80/);
    assert.deepEqual(validateKioskForm({ ...KIOSK_FORM_DEFAULTS, name: " Tablet mostrador " }), {});
    assert.deepEqual(toKioskCreateBody({ name: " Tablet mostrador ", mrzReader: true, cardEncoder: false, paymentTerminal: false, printer: true }), {
      name: "Tablet mostrador",
      capabilities: { mrzReader: true, cardEncoder: false, paymentTerminal: false, printer: true }
    });
    assert.equal(kioskCapabilitiesLabel({ mrzReader: true, printer: true }), "lector MRZ · impresora");
    assert.equal(kioskCapabilitiesLabel(null), "sin periféricos");
    assert.equal(kioskStatusLabel("unpaired"), "Sin emparejar");
    assert.equal(kioskStatusLabel("weird"), "Desconocido");
  });
  it("guardar exige guest_self_service.manage y kioscos kiosk.configure; el administrador de plataforma pasa; recepción de plantilla no", () => {
    assert.equal(canManageCheckInPolicy(["guest_self_service.read"]), false);
    assert.equal(canManageCheckInPolicy(["guest_self_service.read", "guest_self_service.manage"]), true);
    assert.equal(canManageCheckInPolicy(null, true), true);
    assert.equal(canConfigureKiosks(["guest_self_service.manage"]), false);
    assert.equal(canConfigureKiosks(["kiosk.configure"]), true);
    assert.equal(canConfigureKiosks(undefined), false);
  });
});

// Unit tests · Tanda CHK · lote W2-A — contexto de servicio del check-in
// (service-context.ts): separación de funciones (T8a) y forma del contexto.
// Sin base de datos, sin red (solo la construcción PURA buildServiceContext).
// Desde apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/service-context.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PERMISSIONS } from "@hotelos/shared";
import {
  CHECKIN_SERVICE_DEVICE_ID,
  CHECKIN_SERVICE_FULL_NAME,
  CHECKIN_SERVICE_PERMISSIONS,
  FORBIDDEN_SERVICE_PERMISSIONS,
  PAYMENT_LINK_SERVICE_PERMISSIONS,
  actorFromUserId,
  buildServiceContext,
  serviceUserId,
  type CheckInActor
} from "../service-context.js";

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Código sin comentarios de línea ni de bloque (los encabezados citan «demoStore.userContext» como lo que NO se hace). */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}
const catalog = new Set(Object.keys(PERMISSIONS));

describe("CHECKIN_SERVICE_PERMISSIONS · separación de funciones", () => {
  it("nunca contiene claves de dinero, override ni confirmación de alto riesgo (SoD T8a)", () => {
    const forbidden = new Set<string>(FORBIDDEN_SERVICE_PERMISSIONS);
    assert.deepEqual(CHECKIN_SERVICE_PERMISSIONS.filter((key) => forbidden.has(key)), []);
    assert.deepEqual(PAYMENT_LINK_SERVICE_PERMISSIONS.filter((key) => forbidden.has(key)), []);
    // Las 7 prohibidas son exactamente las del brief (dinero, override, alto riesgo).
    assert.deepEqual([...FORBIDDEN_SERVICE_PERMISSIONS].sort(), [
      "ai.high_risk.confirm",
      "folio.adjust",
      "folio.adjust_approve",
      "payment.refund",
      "payments.refund_approve",
      "pms.reservation.discount",
      "pms.reservation.override"
    ]);
  });

  it("todas las claves (fijas, de pago y prohibidas) existen en el catálogo PERMISSIONS", () => {
    for (const key of [...CHECKIN_SERVICE_PERMISSIONS, ...PAYMENT_LINK_SERVICE_PERMISSIONS, ...FORBIDDEN_SERVICE_PERMISSIONS]) {
      assert.ok(catalog.has(key), `clave desconocida en el catálogo: ${key}`);
    }
  });

  it("las 12 claves fijas son las del diseño §4c y el enlace de pago SOLO payment.capture", () => {
    assert.deepEqual([...CHECKIN_SERVICE_PERMISSIONS].sort(), [
      "ai.tool.execute",
      "compliance.ses.submit",
      "guest_register.create",
      "guest_register.edit",
      "guest_register.read",
      "guest_register.sign",
      "guest_register.submit",
      "guests.manage",
      "guests.read",
      "pms.checkin.execute",
      "pms.reservation.modify",
      "pms.reservation.read"
    ]);
    assert.deepEqual([...PAYMENT_LINK_SERVICE_PERMISSIONS], ["payment.capture"]);
  });

  it("buildServiceContext rechaza cualquier clave prohibida aunque se le pase a mano", () => {
    assert.throws(
      () =>
        buildServiceContext({
          organizationId: "org_test",
          propertyId: "prop_test",
          actor: { kind: "system", job: "x" },
          permissions: ["pms.reservation.read", "payment.refund"]
        }),
      /claves prohibidas: payment\.refund/
    );
  });
});

describe("userId sintético por actor", () => {
  const cases: Array<[CheckInActor, string]> = [
    [{ kind: "guest", sessionId: "cis_123" }, "guest:cis_123"],
    [{ kind: "kiosk", deviceId: "kd_9" }, "kiosk:kd_9"],
    [{ kind: "system", job: "invitation" }, "system:checkin:invitation"]
  ];

  it("guest/kiosk/system generan userId con su prefijo y se reconocen de vuelta", () => {
    for (const [actor, expected] of cases) {
      assert.equal(serviceUserId(actor), expected);
      assert.deepEqual(actorFromUserId(expected), actor);
    }
    assert.equal(actorFromUserId("usr_persona"), null);
  });

  it("el contexto queda acotado a la propiedad (orgScope false, assignedPropertyIds) y sin admin de plataforma", () => {
    const context = buildServiceContext({
      organizationId: "org_test",
      propertyId: "prop_test",
      actor: { kind: "guest", sessionId: "cis_1" },
      permissions: CHECKIN_SERVICE_PERMISSIONS
    });
    assert.equal(context.organizationId, "org_test");
    assert.equal(context.propertyId, "prop_test");
    assert.equal(context.userId, "guest:cis_1");
    assert.equal(context.fullName, CHECKIN_SERVICE_FULL_NAME);
    assert.equal(context.deviceId, CHECKIN_SERVICE_DEVICE_ID);
    assert.equal(context.isPlatformAdmin, false);
    assert.equal(context.orgScope, false);
    assert.deepEqual(context.assignedPropertyIds, ["prop_test"]);
    assert.equal(context.assignments, undefined);
    // Copia defensiva: mutar el contexto no altera la constante.
    context.permissions.push("payment.refund");
    assert.ok(!CHECKIN_SERVICE_PERMISSIONS.includes("payment.refund"));
  });
});

describe("contrato de fuente", () => {
  it("service-context.ts nunca reutiliza demoStore.userContext ni request.userContext (R17)", () => {
    const source = codeOnly(readFileSync(join(MODULE_DIR, "service-context.ts"), "utf8"));
    assert.doesNotMatch(source, /demoStore\.userContext/);
    assert.doesNotMatch(source, /request\.userContext/);
    assert.match(source, /prisma\.property\.findUnique/, "organizationId se resuelve desde prisma.property");
    assert.match(source, /Propiedad no encontrada\./, "404 opaco si la propiedad no existe");
  });

  it("checkin-session.service.ts audita con el contexto de servicio, nunca con demoStore.userContext", () => {
    const source = codeOnly(readFileSync(join(MODULE_DIR, "checkin-session.service.ts"), "utf8"));
    assert.doesNotMatch(source, /demoStore/);
    assert.match(source, /checkInServiceContext\(/);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_OUTCOME_LABEL,
  OUTCOME_FILTER_OPTIONS,
  apiStatusForOutcomeFilter,
  deliveryOutcome,
  deliveryOutcomeTone,
  isSimulatedDelivery,
  matchesOutcomeFilter,
  splitSentCounts,
  type DeliveryOutcomeInput
} from "../delivery-outcome.ts";

// Tanda L8 · lote L8-03 (recon «Éxitos falsos» nº 3): the dispatcher records a
// send without provider as `sent` + errorMessage «SIMULADO: …»; the screen
// painted it «enviado» in green and added it to «entregadas». Everything the
// screen says about a delivery must come from these pure helpers.

const SIMULATED_MESSAGE = "SIMULADO: proveedor no configurado; no se envió de verdad.";
const SCREEN = fileURLToPath(new URL("../NotificationsScreen.tsx", import.meta.url));

const real: DeliveryOutcomeInput = { status: "sent", errorMessage: null };
const simulated: DeliveryOutcomeInput = { status: "sent", errorMessage: SIMULATED_MESSAGE };
const failed: DeliveryOutcomeInput = { status: "failed", errorMessage: "Fallo simulado del proveedor email." };
const bounced: DeliveryOutcomeInput = { status: "bounced", errorMessage: "hard bounce" };
const queued: DeliveryOutcomeInput = { status: "queued", errorMessage: null };
const pending: DeliveryOutcomeInput = { status: "pending" };

describe("Comunicaciones · resultado honesto de un envío (delivery-outcome)", () => {
  it("a `sent` row without message (or with a message that is not SIMULADO) is a real send", () => {
    assert.equal(deliveryOutcome(real), "sent");
    assert.equal(deliveryOutcome({ status: "sent", errorMessage: "" }), "sent");
    assert.equal(deliveryOutcome({ status: "sent" }), "sent");
    // The marker is a prefix: a provider message that merely mentions a simulation is not one.
    assert.equal(deliveryOutcome({ status: "sent", errorMessage: "El proveedor devolvió: SIMULADO" }), "sent");
    assert.equal(isSimulatedDelivery(real), false);
  });

  it("a `sent` row whose errorMessage starts with SIMULADO (any case) is «simulated», never «sent»", () => {
    assert.equal(deliveryOutcome(simulated), "simulated");
    assert.equal(deliveryOutcome({ status: "sent", errorMessage: "simulado: sin proveedor" }), "simulated");
    assert.equal(deliveryOutcome({ status: "sent", errorMessage: "Simulado" }), "simulated");
    assert.equal(isSimulatedDelivery(simulated), true);
  });

  it("the wire status wins for everything that is not `sent`: failed / bounced stay failed / bounced even with a SIMULADO message", () => {
    assert.equal(deliveryOutcome(failed), "failed");
    assert.equal(deliveryOutcome(bounced), "bounced");
    assert.equal(deliveryOutcome({ status: "failed", errorMessage: SIMULATED_MESSAGE }), "failed");
    assert.equal(deliveryOutcome({ status: "queued", errorMessage: SIMULATED_MESSAGE }), "queued");
    assert.equal(isSimulatedDelivery({ status: "failed", errorMessage: SIMULATED_MESSAGE }), false);
  });

  it("queued and pending rows pass through untouched", () => {
    assert.equal(deliveryOutcome(queued), "queued");
    assert.equal(deliveryOutcome(pending), "pending");
  });

  it("labels and tones: «simulado» is a warning, only a real send is a success, failures are danger", () => {
    assert.equal(DELIVERY_OUTCOME_LABEL.simulated, "simulado");
    assert.equal(DELIVERY_OUTCOME_LABEL.sent, "enviado");
    assert.equal(deliveryOutcomeTone("simulated"), "warning");
    assert.equal(deliveryOutcomeTone("sent"), "success");
    assert.equal(deliveryOutcomeTone("failed"), "danger");
    assert.equal(deliveryOutcomeTone("bounced"), "danger");
    assert.equal(deliveryOutcomeTone("queued"), "warning");
    assert.equal(deliveryOutcomeTone("pending"), "warning");
    for (const outcome of ["pending", "queued", "sent", "simulated", "failed", "bounced"] as const) {
      assert.ok(DELIVERY_OUTCOME_LABEL[outcome].length > 0, `sin etiqueta para ${outcome}`);
      if (outcome !== "sent") assert.notEqual(deliveryOutcomeTone(outcome), "success", `${outcome} no puede pintarse en verde`);
    }
  });

  it("the status filter offers «simulado», asks the API for `sent` and narrows the rows by real outcome", () => {
    const values = OUTCOME_FILTER_OPTIONS.map((o) => o.value);
    assert.deepEqual(values, ["", "sent", "simulated", "failed", "queued", "bounced"]);
    assert.equal(OUTCOME_FILTER_OPTIONS.find((o) => o.value === "simulated")?.label, "simulado");
    assert.equal(apiStatusForOutcomeFilter(""), undefined);
    assert.equal(apiStatusForOutcomeFilter("simulated"), "sent");
    assert.equal(apiStatusForOutcomeFilter("sent"), "sent");
    assert.equal(apiStatusForOutcomeFilter("failed"), "failed");
    const rows = [real, simulated, failed, queued];
    assert.deepEqual(rows.filter((r) => matchesOutcomeFilter(r, "")), rows);
    assert.deepEqual(rows.filter((r) => matchesOutcomeFilter(r, "sent")), [real]);
    assert.deepEqual(rows.filter((r) => matchesOutcomeFilter(r, "simulated")), [simulated]);
    assert.deepEqual(rows.filter((r) => matchesOutcomeFilter(r, "failed")), [failed]);
  });

  it("splitSentCounts separates real from simulated sends and ignores the rest", () => {
    assert.deepEqual(splitSentCounts([]), { real: 0, simulated: 0 });
    assert.deepEqual(splitSentCounts([real, simulated, simulated, failed, bounced, queued, pending]), { real: 1, simulated: 2 });
    assert.deepEqual(splitSentCounts([simulated, simulated, simulated]), { real: 0, simulated: 3 });
    assert.deepEqual(splitSentCounts([real, real]), { real: 2, simulated: 0 });
  });

  it("NotificationsScreen derives badge, filter and KPIs from these helpers and never counts `status === \"sent\"` on its own", () => {
    const source = readFileSync(SCREEN, "utf8");
    assert.match(source, /from "\.\/delivery-outcome"/);
    for (const helper of ["deliveryOutcome(", "deliveryOutcomeTone(", "splitSentCounts(", "matchesOutcomeFilter(", "apiStatusForOutcomeFilter(", "OUTCOME_FILTER_OPTIONS"]) {
      assert.ok(source.includes(helper), `la pantalla no usa ${helper}`);
    }
    assert.doesNotMatch(source, /status === "sent"/, "la pantalla no debe contar `sent` sin mirar SIMULADO");
    assert.doesNotMatch(source, /sent: "enviado"/, "la etiqueta de `sent` vive en delivery-outcome.ts");
    assert.match(source, /"simulada", "simuladas"\)\} \(sin proveedor\)/, "la KPI de enviadas debe explicar las simuladas «(sin proveedor)»");
  });
});

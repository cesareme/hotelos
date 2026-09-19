import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// U7 · fechas editables de la ficha (docs/design/UX-RECEPCION-FEEL.md §5.5 (3),
// F8, §4.2 «Cambiar fechas en ficha»): noches, «+1 / −1 noche», bloqueo
// honesto de una alojada (409 REC-03), validación y cuerpo del PATCH (solo las
// claves que cambian; `totalAmount` solo cuando la recotización lo mueve).
// services/pmsCommerceApi → api-client → `import.meta.env` (Vite): mismo
// gancho que hooks/__tests__/useApiData.test.mts.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const { stayDatesError, stayDatesLockedReason, stayDatesPatch, stayNights, stayWithNights } = await import("../../../services/pmsCommerceApi.ts");
/** Fuente sin comentarios: solo cuenta el código que se ejecuta. */
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const SCREEN = stripComments(readFileSync(new URL("../ReservationWorkspaceScreen.tsx", import.meta.url), "utf8"));

describe("stayNights · noches de calendario", () => {
  it("cuenta noches entre dos ISO (también con hora) y devuelve 0 con fechas inválidas o invertidas", () => {
    assert.equal(stayNights("2026-09-19", "2026-09-21"), 2);
    assert.equal(stayNights("2026-09-19T14:00:00.000Z", "2026-09-20T11:00:00.000Z"), 1);
    assert.equal(stayNights("2026-03-28", "2026-03-30"), 2, "cambio de hora");
    assert.equal(stayNights("2026-09-21", "2026-09-19"), 0);
    assert.equal(stayNights("", "2026-09-19"), 0);
  });
});

describe("stayWithNights · «+1 noche» / «−1 noche» mueven la salida", () => {
  const stay = { arrivalDate: "2026-09-19", departureDate: "2026-09-21" };
  it("suma y resta noches sobre la salida y nunca baja de una noche", () => {
    assert.deepEqual(stayWithNights(stay, 1), { arrivalDate: "2026-09-19", departureDate: "2026-09-22" });
    assert.deepEqual(stayWithNights(stay, -1), { arrivalDate: "2026-09-19", departureDate: "2026-09-20" });
    assert.deepEqual(stayWithNights(stay, -5), { arrivalDate: "2026-09-19", departureDate: "2026-09-20" });
    assert.deepEqual(stayWithNights({ arrivalDate: "2026-09-19T00:00:00.000Z", departureDate: "2026-09-21T00:00:00.000Z" }, 1), { arrivalDate: "2026-09-19", departureDate: "2026-09-22" });
  });
});

describe("stayDatesLockedReason · honestidad por estado (REC-03)", () => {
  it("bloquea alojadas y cerradas con la explicación; confirmadas y borradores editan", () => {
    assert.match(stayDatesLockedReason("checked_in") ?? "", /alojado/);
    assert.match(stayDatesLockedReason("checked_in") ?? "", /REC-03/);
    assert.match(stayDatesLockedReason("checked_out") ?? "", /cerrada/);
    assert.match(stayDatesLockedReason("cancelled") ?? "", /cerrada/);
    assert.match(stayDatesLockedReason("NO_SHOW") ?? "", /cerrada/);
    assert.equal(stayDatesLockedReason("confirmed"), null);
    assert.equal(stayDatesLockedReason("draft"), null);
    assert.equal(stayDatesLockedReason(undefined), null);
  });
});

describe("stayDatesError · validación antes de escribir", () => {
  it("exige dos fechas ISO y salida posterior a la llegada", () => {
    assert.equal(stayDatesError({ arrivalDate: "2026-09-19", departureDate: "2026-09-21" }), null);
    assert.match(stayDatesError({ arrivalDate: "2026-09-19", departureDate: "2026-09-19" }) ?? "", /posterior/);
    assert.match(stayDatesError({ arrivalDate: "2026-09-19", departureDate: "2026-09-18" }) ?? "", /posterior/);
    assert.match(stayDatesError({ arrivalDate: "", departureDate: "2026-09-21" }) ?? "", /dos fechas/);
  });
});

describe("stayDatesPatch · PATCH estricto con solo lo que cambia", () => {
  const current = { arrivalDate: "2026-09-19T00:00:00.000Z", departureDate: "2026-09-21T00:00:00.000Z", totalAmount: 178 };
  it("solo la salida cuando cambia la salida; nada cuando nada cambia", () => {
    assert.deepEqual(stayDatesPatch(current, { arrivalDate: "2026-09-19", departureDate: "2026-09-22" }), { departureDate: "2026-09-22" });
    assert.deepEqual(stayDatesPatch(current, { arrivalDate: "2026-09-19", departureDate: "2026-09-21" }), {});
  });
  it("añade totalAmount solo cuando la recotización difiere del total actual (a un céntimo)", () => {
    assert.deepEqual(stayDatesPatch(current, { arrivalDate: "2026-09-19", departureDate: "2026-09-22" }, 267), { departureDate: "2026-09-22", totalAmount: 267 });
    assert.deepEqual(stayDatesPatch(current, { arrivalDate: "2026-09-19", departureDate: "2026-09-22" }, 178.004), { departureDate: "2026-09-22" });
    assert.deepEqual(stayDatesPatch(current, { arrivalDate: "2026-09-18", departureDate: "2026-09-21" }, null), { arrivalDate: "2026-09-18" });
  });
});

describe("Ficha · fechas cableadas (fuente)", () => {
  it("pinta dos CocoaDatePicker con aritmética, «+1 / −1 noche», recotiza antes de aplicar y deshace con el PATCH inverso", () => {
    assert.equal((SCREEN.match(/<CocoaDatePicker[\s\S]*?arithmetic/g) ?? []).length, 2, "dos selectores con aritmética");
    assert.match(SCREEN, /RESERVATION_ACTIONS\.plusNight/);
    assert.match(SCREEN, /RESERVATION_ACTIONS\.minusNight/);
    assert.match(SCREEN, /quoteStayTotal\(reservation\.propertyId, reservation, next\)/);
    assert.match(SCREEN, /setStayQuote\(\{ next, total: quote\.total, currency: quote\.currency \}\)/);
    assert.match(SCREEN, /stayDatesPatch\(previous, next, quotedTotal\)/);
    assert.match(SCREEN, /const revert: ReservationPatch = \{ arrivalDate: previous\.arrivalDate, departureDate: previous\.departureDate/);
    assert.match(SCREEN, /stayDatesLockedReason\(status\)/);
    assert.match(SCREEN, /data-cocoa="stay-locked"/);
  });
  it("ninguna escritura vuelve a hacer «await fn(); await reload()»: mutate + invalidateApi", () => {
    assert.doesNotMatch(SCREEN, /await reload\(\)/);
    assert.doesNotMatch(SCREEN, /async function reload\(/);
    assert.match(SCREEN, /invalidateApi\(`\/reservations\/\$\{reservationId\}`\)/);
    assert.ok((SCREEN.match(/State\.mutate\(/g) ?? []).length >= 8, "mutate optimista en habitación, fechas, nota, cargo, check-in, check-out y ciclo de vida");
  });
});

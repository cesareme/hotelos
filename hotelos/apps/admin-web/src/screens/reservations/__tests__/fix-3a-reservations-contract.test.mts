import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// Source contract of lote fix:3-A (Cocoa 22 · ola 3 · Recepción › Reservas).
const SRC = new URL("../../", import.meta.url);
/** Source without comments: only rendered code is checked. */
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const read = (rel: string) => stripComments(readFileSync(new URL(rel, SRC), "utf8"));

describe("Reservas · el huésped nunca es un id interno (qa#7)", () => {
  for (const rel of ["reservations/ReservationsListScreen.tsx", "reservations/ReservationWorkspaceScreen.tsx"]) {
    it(`${rel} labels the guest through reservation-guest-label and never falls back to primaryGuestId`, () => {
      const source = read(rel);
      assert.match(source, /from "\.\/reservation-guest-label"/);
      assert.doesNotMatch(source, /primaryGuestId \?\?/);
      assert.doesNotMatch(source, /\?\? reservation\.primaryGuestId/);
    });
  }
  it("the list resolves the missing names through /guests/:id and keys them by primary guest id", () => {
    const source = read("reservations/ReservationsListScreen.tsx");
    assert.match(source, /fetchGuest\(id\)/);
    assert.match(source, /pendingGuestIds\(reservations, /);
    assert.match(source, /reservationGuestLabel\(r, r\.primaryGuestId \? guestNames\[r\.primaryGuestId\] : undefined\)/);
  });
  it("the detail reads the primary guest the API joins and paints it in the Huéspedes view", () => {
    const source = read("reservations/ReservationWorkspaceScreen.tsx");
    assert.match(source, /primaryGuest\?: GuestNameParts \| null/);
    assert.match(source, /<span>Huésped principal<\/span>/);
    assert.match(source, /meta=\{guestLabel\(reservation\)\}/);
  });
});

describe("Nueva reserva · un solo aria-current=\"step\" por paso (qa#12)", () => {
  it("keeps aria-current on the step button only, never on its <li>", () => {
    const source = read("reservations/ReservationCreateScreen.tsx");
    const start = source.indexOf("{STEPS.map((s, index) => (");
    const end = source.indexOf("</ol>", start);
    assert.ok(start > 0 && end > start, "step list not found");
    const stepItem = source.slice(start, end);
    assert.match(stepItem, /<li key=\{s\.key\}>/);
    assert.equal(stepItem.match(/aria-current=/g)?.length, 1);
    assert.match(stepItem, /<CocoaButton[\s\S]*?aria-current=\{index === step \? "step" : undefined\}/);
  });
});

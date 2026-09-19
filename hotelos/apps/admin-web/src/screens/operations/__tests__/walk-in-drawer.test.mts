import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// U6 · WalkInDrawer (docs/design/UX-RECEPCION-FEEL.md §5.3, F4): la lógica pura
// del cajón — noches, fechas por defecto, habitación candidata (F24: nunca una
// ocupada), importe de la cotización y cuerpo de POST reservations con
// `bookingSource: "walk_in"` y sin cadenas vacías (el API responde 400 a un
// correo «» o a un país que no sea ISO-3). El módulo llega a
// services/api-client → `import.meta.env`, que define Vite: el gancho lo
// sustituye igual que frontdesk-actions.test.mts.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const { WALK_IN_QUOTE_DEBOUNCE_MS, buildWalkInReservationBody, pickWalkInRoom, pickWalkInRoomType, walkInAmount, walkInCandidateRooms, walkInDefaultDates, walkInMissing, walkInNights, walkInRoomTypeLabel } = await import("../WalkInDrawer.tsx");
const SOURCE = readFileSync(new URL("../WalkInDrawer.tsx", import.meta.url), "utf8");

type Room = { id: string; number: string; roomTypeId: string; status: string; housekeepingStatus?: string; sellable: boolean };
const room = (id: string, number: string, roomTypeId: string, status: string, hk: string, sellable = true): Room => ({ id, number, roomTypeId, status, housekeepingStatus: hk, sellable });
const ROOMS: Room[] = [
  room("r110", "110", "dbl", "dirty", "dirty"),
  room("r101", "101", "dbl", "occupied", "clean"),
  room("r103", "103", "dbl", "clean", "clean"),
  room("r102", "102", "dbl", "clean", "inspected"),
  room("r301", "301", "sup", "clean", "clean"),
  room("r104", "104", "dbl", "clean", "clean", false),
  room("r105", "105", "dbl", "out_of_order", "clean")
];

describe("walk-in · noches y fechas", () => {
  it("noches entre ISO; 0 si la salida no es posterior", () => {
    assert.equal(walkInNights("2026-09-19", "2026-09-20"), 1);
    assert.equal(walkInNights("2026-09-19", "2026-09-22"), 3);
    assert.equal(walkInNights("2026-09-19", "2026-09-19"), 0);
    assert.equal(walkInNights("2026-09-19", "2026-09-18"), 0);
    assert.equal(walkInNights("", "2026-09-18"), 0);
  });
  it("por defecto hoy → mañana (una noche)", () => {
    assert.deepEqual(walkInDefaultDates("2026-09-19"), { arrivalDate: "2026-09-19", departureDate: "2026-09-20" });
    assert.deepEqual(walkInDefaultDates("2026-12-31"), { arrivalDate: "2026-12-31", departureDate: "2027-01-01" });
  });
  it("la cotización espera 300 ms (precio en vivo sin una petición por tecla)", () => {
    assert.equal(WALK_IN_QUOTE_DEBOUNCE_MS, 300);
  });
});

describe("walk-in · habitación candidata (F24)", () => {
  it("solo limpias o inspeccionadas, vendibles y no ocupadas ni fuera de servicio, del tipo pedido", () => {
    assert.deepEqual(walkInCandidateRooms(ROOMS as never, "dbl").map((r) => r.number).sort(), ["102", "103"]);
    assert.deepEqual(walkInCandidateRooms(ROOMS as never, "sup").map((r) => r.number), ["301"]);
    assert.deepEqual(walkInCandidateRooms(ROOMS as never, "js"), []);
  });
  it("preselecciona la primera por número (102 antes que 103) y null si no hay", () => {
    assert.equal(pickWalkInRoom(ROOMS as never, "dbl")?.number, "102");
    assert.equal(pickWalkInRoom(ROOMS as never, "js"), null);
  });
});

describe("walk-in · tipo, precio en vivo e importe", () => {
  const types = [
    { id: "dbl", name: "Doble" },
    { id: "sup", name: "Superior" }
  ];
  const quotes = [
    { roomTypeId: "dbl", roomTypeName: "Doble", availableRooms: 0, currency: "EUR", totalAmount: 89, cancellationPolicy: "FLEX24" },
    { roomTypeId: "sup", roomTypeName: "Superior", availableRooms: 2, currency: "EUR", totalAmount: 119.5, cancellationPolicy: "FLEX24" }
  ];
  it("el tipo preseleccionado es el primero con disponibilidad; sin cotización, el primero del catálogo", () => {
    assert.equal(pickWalkInRoomType(types as never, quotes as never), "sup");
    assert.equal(pickWalkInRoomType(types as never, []), "dbl");
    assert.equal(pickWalkInRoomType([], quotes as never), "");
  });
  it("el importe es el total de la cotización del tipo (una habitación), redondeado a céntimos", () => {
    assert.equal(walkInAmount(quotes as never, "sup"), 119.5);
    assert.equal(walkInAmount(quotes as never, "dbl"), 89);
    assert.equal(walkInAmount(quotes as never, "js"), null);
    assert.equal(walkInAmount([], "dbl"), null);
  });
  it("la etiqueta del tipo lleva el precio en vivo y las libres", () => {
    const eur = (amount: number) => `${amount.toFixed(2).replace(".", ",")} €`;
    assert.equal(walkInRoomTypeLabel(types[0], quotes[0] as never, eur), "Doble · 89,00 € · 0 libres");
    assert.equal(walkInRoomTypeLabel(types[1], { ...quotes[1], availableRooms: 1 } as never, eur), "Superior · 119,50 € · 1 libre");
    assert.equal(walkInRoomTypeLabel(types[0], undefined, eur), "Doble");
  });
});

describe("walk-in · cuerpo de POST /properties/:id/reservations", () => {
  const form = { arrivalDate: "2026-09-19", departureDate: "2026-09-20", adults: 2, roomTypeId: "dbl", roomId: "r102", firstName: " Cliente ", surname1: "Walkin", documentNumber: "" };
  it("lo mínimo del API + origen walk_in + habitación; sin correos ni país vacíos", () => {
    const body = buildWalkInReservationBody(form);
    assert.deepEqual(body, {
      arrivalDate: "2026-09-19",
      departureDate: "2026-09-20",
      adults: 2,
      children: 0,
      roomsCount: 1,
      roomTypeId: "dbl",
      channel: "direct",
      bookingSource: "walk_in",
      currency: "EUR",
      primaryGuest: { firstName: "Cliente", surname1: "Walkin" },
      assignedRoomId: "r102"
    });
    assert.equal("bookerEmail" in body, false);
    assert.equal("residenceCountry" in (body.primaryGuest as object), false);
    assert.equal("email" in (body.primaryGuest as object), false);
  });
  it("sin habitación no envía assignedRoomId; el documento solo si se tecleó", () => {
    const body = buildWalkInReservationBody({ ...form, roomId: null, documentNumber: " 12345678A " });
    assert.equal("assignedRoomId" in body, false);
    assert.deepEqual(body.primaryGuest, { firstName: "Cliente", surname1: "Walkin", documentNumber: "12345678A" });
  });
  it("qué falta, en el orden de la vista", () => {
    assert.deepEqual(walkInMissing(form), []);
    assert.deepEqual(walkInMissing({ ...form, departureDate: "2026-09-19" }), ["dates"]);
    assert.deepEqual(walkInMissing({ ...form, roomTypeId: "", firstName: " " }), ["roomType", "guest"]);
  });
  it("el cajón es un <form> con Intro, sin estilos en línea y con los CTA de content/actions.ts", () => {
    assert.match(SOURCE, /<form id=\{formId\} onSubmit=\{onSubmit\}/);
    assert.match(SOURCE, /type="submit" form=\{formId\}/);
    assert.equal(SOURCE.includes("style={"), false);
    assert.match(SOURCE, /FRONT_DESK_ACTIONS\.createAndCheckIn/);
    assert.match(SOURCE, /FRONT_DESK_ACTIONS\.createOnly/);
    assert.match(SOURCE, /bookingSource: "walk_in"/);
    assert.match(SOURCE, /runCheckin\(/);
    assert.doesNotMatch(SOURCE, /preautoriz/i);
  });
});

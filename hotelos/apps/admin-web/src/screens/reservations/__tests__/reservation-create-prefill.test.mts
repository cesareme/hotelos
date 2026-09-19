import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PREFILL_NOTE, hasReservationPrefill, parseReservationPrefill } from "../reservation-create-prefill.ts";

// Tanda TL · corrección 1 (UXC-03 / TLF-01): el Live Timeline navega a Nueva
// reserva con ?arrivalDate&departureDate&roomTypeId&assignedRoomId al crear
// por celdas; el formulario los lee al montar (antes abría con hoy/mañana y sin
// tipo ni habitación, y el diálogo prometía lo contrario).

const SEARCH = "?arrivalDate=2026-09-21&departureDate=2026-09-24&roomTypeId=type-dbl&assignedRoomId=room-202";

describe("parseReservationPrefill", () => {
  it("lee los cuatro parámetros (con o sin «?») en el orden que emite newReservationSearch", () => {
    const expected = { arrivalDate: "2026-09-21", departureDate: "2026-09-24", roomTypeId: "type-dbl", assignedRoomId: "room-202" };
    assert.deepEqual(parseReservationPrefill(SEARCH), expected);
    assert.deepEqual(parseReservationPrefill(SEARCH.slice(1)), expected);
    assert.ok(hasReservationPrefill(parseReservationPrefill(SEARCH)));
  });

  it("sin query (o sin parámetros conocidos) no prefija nada", () => {
    assert.deepEqual(parseReservationPrefill(""), {});
    assert.deepEqual(parseReservationPrefill("?"), {});
    assert.deepEqual(parseReservationPrefill("?mode=sync&lot=abc"), {});
    assert.equal(hasReservationPrefill({}), false);
  });

  it("las fechas solo se aplican juntas, reales y con salida posterior a la llegada (nunca salida ≤ llegada)", () => {
    assert.deepEqual(parseReservationPrefill("?arrivalDate=2026-09-21"), {});
    assert.deepEqual(parseReservationPrefill("?departureDate=2026-09-24"), {});
    assert.deepEqual(parseReservationPrefill("?arrivalDate=2026-09-24&departureDate=2026-09-21"), {});
    assert.deepEqual(parseReservationPrefill("?arrivalDate=2026-09-21&departureDate=2026-09-21"), {});
    assert.deepEqual(parseReservationPrefill("?arrivalDate=2026-02-30&departureDate=2026-03-02"), {});
    assert.deepEqual(parseReservationPrefill("?arrivalDate=21/09/2026&departureDate=24/09/2026"), {});
    assert.deepEqual(parseReservationPrefill("?arrivalDate=2026-09-21T00:00:00Z&departureDate=2026-09-24"), {});
    assert.deepEqual(parseReservationPrefill("?arrivalDate=2026-09-21&departureDate=2026-09-22"), { arrivalDate: "2026-09-21", departureDate: "2026-09-22" });
  });

  it("los ids solo admiten caracteres de identificador; el tipo y la habitación son independientes de las fechas", () => {
    assert.deepEqual(parseReservationPrefill("?roomTypeId=cmrhw9jy40003fyvbuu2ec2w7"), { roomTypeId: "cmrhw9jy40003fyvbuu2ec2w7" });
    assert.deepEqual(parseReservationPrefill("?assignedRoomId=room_202-b"), { assignedRoomId: "room_202-b" });
    assert.deepEqual(parseReservationPrefill("?roomTypeId=<script>&assignedRoomId=a%20b"), {});
    assert.deepEqual(parseReservationPrefill(`?roomTypeId=${"x".repeat(65)}`), {});
    assert.deepEqual(parseReservationPrefill("?arrivalDate=bad&departureDate=worse&roomTypeId=t1"), { roomTypeId: "t1" });
  });

  it("la nota del formulario está en español y nombra el Live Timeline", () => {
    assert.match(PREFILL_NOTE, /Live Timeline/);
    assert.match(PREFILL_NOTE, /revísalos/);
  });
});

describe("ReservationCreateScreen · contrato de fuente del prefijado", () => {
  const screen = readFileSync(new URL("../ReservationCreateScreen.tsx", import.meta.url), "utf8");
  const prefill = readFileSync(new URL("../reservation-create-prefill.ts", import.meta.url), "utf8");

  it("el formulario nace de defaultForm + parseReservationPrefill(window.location.search), leído una vez al montar, y avisa con un callout", () => {
    assert.match(screen, /import \{ PREFILL_NOTE, hasReservationPrefill, parseReservationPrefill \} from "\.\/reservation-create-prefill";/);
    assert.match(screen, /const \[prefill\] = useState\(\(\) => parseReservationPrefill\(typeof window === "undefined" \? "" : window\.location\.search\)\);/);
    assert.match(screen, /useState<FormValues>\(\(\) => \(\{ \.\.\.defaultForm, \.\.\.prefill \}\)\)/);
    assert.match(screen, /\{prefilled \? \(\s*<CocoaCallout tone="info" role="note">\s*\{PREFILL_NOTE\}/);
    assert.doesNotMatch(screen, /useState<FormValues>\(defaultForm\)/, "ya no ignora la query");
  });

  it("el módulo es puro (sin React, DOM ni servicios) y no inventa valores", () => {
    assert.doesNotMatch(prefill, /from "react"|\bdocument\b|\bwindow\b|services\//);
    assert.doesNotMatch(prefill, /TODAY|Date\.now\(\)|new Date\(\)/, "no rellena con hoy: lo que falta se queda como estaba");
  });
});

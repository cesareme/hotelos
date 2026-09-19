import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// U9a · Nueva reserva rápida (docs/design/UX-RECEPCION-FEEL.md §5.10, F12,
// F33, 3.3.7): la lógica pura del modo rápido —los 3 obligatorios, el cuerpo
// mínimo del POST compartido por los dos modos (sin cadenas vacías, países en
// ISO-3, `primaryGuestId`), el precio en vivo → total (un relleno nunca es el
// total, el importe manual gana), la empresa (razón social → «Factura a
// empresa»), el modo por `?modo=` y el prefijado de huésped— y el contrato de
// fuente de la pantalla (esqueleto en vez de «Sin tipos…» durante la carga,
// <form> en el modo rápido, un solo cuerpo de POST). Mismo gancho que
// walk-in-drawer.test.mts para `import.meta.env` de api-client.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const quick = await import("../ReservationQuickCreate.tsx");
const {
  COMPANY_BILLING_INSTRUCTION,
  QUICK_FIELD_IDS,
  QUICK_QUOTE_DEBOUNCE_MS,
  applyCompany,
  buildCreateReservationPayload,
  defaultReservationForm,
  guestDisplayName,
  guestIdFromSearch,
  guestPrefillValues,
  heldRoomIds,
  isoCountry,
  pickQuickCheckinRoom,
  pickGuestSuggestion,
  pickQuickRoomType,
  quickBlockingTitle,
  quickMissing,
  quickPrice,
  quickRoomTypeLabel,
  quickTotal,
  reservationModeFromSearch,
  searchWithReservationMode
} = quick;

const SCREEN = readFileSync(new URL("../ReservationCreateScreen.tsx", import.meta.url), "utf8");
const QUICK_SRC = readFileSync(new URL("../ReservationQuickCreate.tsx", import.meta.url), "utf8");
const INSTRUCTIONS = readFileSync(new URL("../../../content/screen-instructions/reservations.ts", import.meta.url), "utf8");

type Form = typeof defaultReservationForm;
const form = (patch: Partial<Form> = {}): Form => ({ ...defaultReservationForm, arrivalDate: "2026-09-19", departureDate: "2026-09-21", ...patch });

const QUOTES = [
  { roomTypeId: "dbl", roomTypeName: "Doble", availableRooms: 4, currency: "EUR", totalAmount: 178, cancellationPolicy: "FLEX24", priceSource: "rate_plan" as const },
  { roomTypeId: "sup", roomTypeName: "Superior", availableRooms: 0, currency: "EUR", totalAmount: 238, cancellationPolicy: "FLEX24", priceSource: "rate_plan" as const },
  { roomTypeId: "js", roomTypeName: "Junior suite", availableRooms: 1, currency: "EUR", totalAmount: 318, cancellationPolicy: "FLEX24", priceSource: "fallback" as const, nightsWithoutRate: 1, fallbackNightly: 159 }
];
const TYPES = [
  { id: "dbl", propertyId: "p", name: "Doble", code: "DBL", maxOccupancy: 2 },
  { id: "sup", propertyId: "p", name: "Superior", code: "SUP", maxOccupancy: 3 },
  { id: "js", propertyId: "p", name: "Junior suite", code: "JS", maxOccupancy: 3 }
];
const money = (amount: number, currency = "EUR") => `${amount.toFixed(2).replace(".", ",")} ${currency === "EUR" ? "€" : currency}`;

describe("modo rápido · los 3 obligatorios", () => {
  it("faltan fechas, tipo y huésped en el orden de la vista; con los tres, nada", () => {
    assert.deepEqual(quickMissing(form({ departureDate: "2026-09-19" })), ["dates", "roomType", "guest"]);
    assert.deepEqual(quickMissing(form({ roomTypeId: "dbl" })), ["guest"]);
    assert.deepEqual(quickMissing(form({ roomTypeId: "dbl", firstName: "Ana", surname1: " " })), ["guest"]);
    assert.deepEqual(quickMissing(form({ roomTypeId: "dbl", firstName: "Ana", surname1: "Alfa" })), []);
  });

  it("L-02: bloquea una llegada anterior a hoy (min en el campo) y un precio de relleno o 0 € sin importe manual; sin cotización todavía no bloquea", () => {
    const ok = form({ roomTypeId: "dbl", firstName: "Ana", surname1: "Alfa" });
    assert.deepEqual(quickMissing(ok, { today: "2026-09-19" }), []);
    assert.deepEqual(quickMissing({ ...ok, arrivalDate: "2026-03-10", departureDate: "2026-05-10" }, { today: "2026-09-19" }), ["pastArrival"]);
    const filler = { total: 8296, nightly: 136, currency: "EUR", available: 3, filler: true };
    assert.deepEqual(quickMissing(ok, { today: "2026-09-19", price: filler, manualTotal: null }), ["price"]);
    assert.deepEqual(quickMissing(ok, { price: { ...filler, filler: false, total: 0 } }), ["price"]);
    assert.deepEqual(quickMissing(ok, { price: filler, manualTotal: 300 }), [], "el importe manual desbloquea");
    assert.deepEqual(quickMissing(ok, { price: null }), [], "cotización pendiente: Intro sigue creando");
    assert.equal(quickBlockingTitle(["pastArrival", "guest"]), "La llegada es anterior a hoy.");
    assert.equal(quickBlockingTitle(["price"]), "Sin tarifa publicada para esas noches: indica el importe total.");
    assert.equal(quickBlockingTitle([]), "Intro también crea la reserva");
    assert.match(QUICK_SRC, /<CocoaDatePicker value=\{form\.arrivalDate\}[^\n]*min=\{today\}/, "la llegada lleva min=hoy");
    assert.match(QUICK_SRC, /quickMissing\(form, \{ today, price, manualTotal \}\)/);
  });

  it("los ids de los campos obligatorios son los que enfoca la pantalla (mismo id en los dos modos)", () => {
    assert.deepEqual(QUICK_FIELD_IDS, { roomType: "rc-field-roomtype", firstName: "rc-field-firstname", surname1: "rc-field-surname1" });
    for (const id of Object.values(QUICK_FIELD_IDS)) assert.ok(SCREEN.includes(`"${id}"`), `la pantalla enfoca ${id}`);
    assert.match(SCREEN, /focusField\(!form\.firstName\.trim\(\) \? "rc-field-firstname" : "rc-field-surname1"\)/);
  });
});

describe("modo rápido · cuerpo mínimo del POST (compartido por los dos modos)", () => {
  it("con los valores por defecto lleva los obligatorios del API y NINGUNA cadena vacía en correos, teléfonos ni notas (400 «Invalid email»)", () => {
    const body = buildCreateReservationPayload(form({ roomTypeId: "dbl", firstName: " Ana ", surname1: "Alfa " }), { nightsCount: 2, manualTotal: null });
    assert.equal(body.arrivalDate, "2026-09-19");
    assert.equal(body.departureDate, "2026-09-21");
    assert.equal(body.roomTypeId, "dbl");
    assert.equal(body.nightsCount, 2);
    assert.equal(body.adults, 2);
    assert.equal(body.currency, "EUR");
    assert.equal(body.totalAmount, undefined, "sin importe manual el API cotiza desde la parrilla");
    assert.equal(body.childrenAges, undefined, "sin niños no viaja childrenAges (antes «» → [0])");
    assert.deepEqual(buildCreateReservationPayload(form({ roomTypeId: "dbl", children: "2", childrenAges: "4, 7" }), { nightsCount: 2, manualTotal: null }).childrenAges, [4, 7]);
    assert.equal(body.bookerEmail, undefined);
    assert.equal(body.bookerName, undefined);
    assert.equal(body.notes, undefined);
    assert.equal(body.primaryGuestId, undefined);
    const guest = body.primaryGuest as Record<string, unknown>;
    assert.equal(guest.firstName, "Ana");
    assert.equal(guest.surname1, "Alfa");
    assert.equal(guest.email, undefined);
    assert.equal(guest.phone, undefined);
    assert.equal(guest.residenceCountry, "ESP", "país en ISO-3, nunca «España» (máx. 3 caracteres en el API)");
    assert.equal(guest.nationality, "ESP");
    assert.equal(guest.marketingConsent, false);
    const blanks = Object.entries(guest).filter(([, value]) => value === "");
    assert.deepEqual(blanks, [], "sin cadenas vacías en primaryGuest");
    assert.deepEqual(Object.entries(body).filter(([, value]) => value === ""), [], "sin cadenas vacías en el cuerpo");
  });

  it("el importe manual viaja como totalAmount; el tecleado en correos y teléfonos también; el huésped enlazado como primaryGuestId", () => {
    const body = buildCreateReservationPayload(
      form({ roomTypeId: "dbl", firstName: "Ana", surname1: "Alfa", email: "ana@uxday.test", phone: "600000000", totalAmount: "150", primaryGuestId: "g1", residenceCountry: "España" }),
      { nightsCount: 2, manualTotal: 150 }
    );
    assert.equal(body.totalAmount, 150);
    assert.equal(body.primaryGuestId, "g1");
    const guest = body.primaryGuest as Record<string, unknown>;
    assert.equal(guest.email, "ana@uxday.test");
    assert.equal(guest.phone, "600000000");
    assert.equal(guest.residenceCountry, "ESP", "«España» se traduce a ISO-3");
  });

  it("acompañantes: solo los que hay, con nacionalidad ISO-3 y sin vacíos", () => {
    const companions = [{ firstName: "Luis", surname1: "Beta", documentType: "DNI", documentNumber: "", dateOfBirth: "", nationality: "esp", type: "child" as const }];
    const body = buildCreateReservationPayload(form({ roomTypeId: "dbl", firstName: "Ana", surname1: "Alfa" }), { nightsCount: 2, manualTotal: null, companions });
    assert.deepEqual(body.companions, [{ firstName: "Luis", surname1: "Beta", documentType: "DNI", documentNumber: undefined, dateOfBirth: undefined, nationality: "ESP", type: "child" }]);
    assert.equal(buildCreateReservationPayload(form({ roomTypeId: "dbl" }), { nightsCount: 2, manualTotal: null }).companions, undefined);
  });

  it("isoCountry: código de 3 letras tal cual, nombres conocidos traducidos, lo demás se omite", () => {
    assert.equal(isoCountry("esp"), "ESP");
    assert.equal(isoCountry(" PRT "), "PRT");
    assert.equal(isoCountry("España"), "ESP");
    assert.equal(isoCountry("Portugal"), "PRT");
    assert.equal(isoCountry("Atlántida"), undefined);
    assert.equal(isoCountry(""), undefined);
    assert.equal(isoCountry(undefined), undefined);
  });

  it("la pantalla crea con ESE cuerpo en los dos modos (un solo createReservation) y el modo rápido es un <form> con Intro", () => {
    assert.equal(SCREEN.match(/createReservation\(PROPERTY_ID,/g)?.length, 1);
    assert.match(SCREEN, /createReservation\(PROPERTY_ID, buildCreateReservationPayload\(form, \{ nightsCount, manualTotal, companions \}\)\)/);
    assert.match(SCREEN, /onCreate=\{createFromForm\}/);
    assert.match(QUICK_SRC, /<form id=\{formId\} onSubmit=\{onSubmit\}/);
    assert.match(QUICK_SRC, /type: "submit",\s*form: formId/);
    assert.doesNotMatch(QUICK_SRC, /style=\{/, "0 estilos en línea (contrato Cocoa 22)");
  });
});

describe("modo rápido · precio en vivo → total", () => {
  it("quickPrice: por noche y estancia del tipo elegido, libres y si es relleno", () => {
    assert.deepEqual(quickPrice(QUOTES, "dbl", 2), { total: 178, nightly: 89, currency: "EUR", available: 4, filler: false });
    assert.deepEqual(quickPrice(QUOTES, "dbl", 2, 2), { total: 356, nightly: 89, currency: "EUR", available: 4, filler: false });
    assert.equal(quickPrice(QUOTES, "js", 2)?.filler, true);
    assert.equal(quickPrice(QUOTES, "nope", 2), null);
    assert.equal(quickPrice([], "dbl", 2), null);
  });

  it("quickTotal: el manual gana; el cotizado si no; un relleno nunca es el total", () => {
    assert.equal(quickTotal(quickPrice(QUOTES, "dbl", 2), null), 178);
    assert.equal(quickTotal(quickPrice(QUOTES, "dbl", 2), 150), 150);
    assert.equal(quickTotal(quickPrice(QUOTES, "js", 2), null), null);
    assert.equal(quickTotal(null, null), null);
  });

  it("la etiqueta del tipo lleva el precio por noche y las libres: «Doble · 89,00 €/noche · 4 libres»", () => {
    assert.equal(quickRoomTypeLabel(TYPES[0], quickPrice(QUOTES, "dbl", 2), money), "Doble · 89,00 €/noche · 4 libres");
    assert.equal(quickRoomTypeLabel(TYPES[2], quickPrice(QUOTES, "js", 2), money), "Junior suite · 159,00 €/noche · 1 libre");
    assert.equal(quickRoomTypeLabel(TYPES[1], null, money), "Superior");
  });

  it("tipo preseleccionado: el primero con disponibilidad; sin cotización, el primero del catálogo", () => {
    assert.equal(pickQuickRoomType(TYPES, QUOTES), "dbl");
    assert.equal(pickQuickRoomType(TYPES.slice(1), QUOTES), "js");
    assert.equal(pickQuickRoomType(TYPES, []), "dbl");
    assert.equal(pickQuickRoomType([], QUOTES), "");
  });

  it("la cotización va con 300 ms de espera y sin botón «Consultar disponibilidad» en el modo rápido", () => {
    assert.equal(QUICK_QUOTE_DEBOUNCE_MS, 300);
    assert.match(QUICK_SRC, /quoteAvailability\(propertyId, \{/);
    assert.doesNotMatch(QUICK_SRC, /Consultar disponibilidad/);
  });
});

describe("modo rápido · empresa (T5, factura a la empresa)", () => {
  it("la razón social pone la instrucción de cobro en «Factura a empresa» y al borrarla vuelve al valor por defecto", () => {
    const withCompany = applyCompany(form(), "Empresa UXDAY SL");
    assert.equal(withCompany.companyName, "Empresa UXDAY SL");
    assert.equal(withCompany.billingInstruction, COMPANY_BILLING_INSTRUCTION);
    const cleared = applyCompany(withCompany, "");
    assert.equal(cleared.companyName, "");
    assert.equal(cleared.billingInstruction, defaultReservationForm.billingInstruction);
    const manual = applyCompany({ ...form(), billingInstruction: "prepaid" }, "");
    assert.equal(manual.billingInstruction, "prepaid", "una instrucción elegida a mano no se toca");
  });

  it("el cuerpo lleva companyName y billingInstruction company_invoice; el NIF no viaja (lo recuerda la pantalla para la factura)", () => {
    const body = buildCreateReservationPayload(applyCompany(form({ roomTypeId: "dbl", firstName: "Contacto", surname1: "Corporativo", companyTaxId: "B12345674" }), "Empresa UXDAY SL"), {
      nightsCount: 2,
      manualTotal: null
    });
    assert.equal(body.companyName, "Empresa UXDAY SL");
    assert.equal(body.billingInstruction, "company_invoice");
    assert.equal("companyTaxId" in body, false);
    assert.match(SCREEN, /rememberTaxId\(localStorageOrNull\(\), form\.companyName, form\.companyTaxId\)/);
  });
});

describe("modo rápido · modo por URL y huésped prefijado (3.3.7)", () => {
  it("rápida por defecto; `?modo=completa` abre el asistente; el conmutador conserva el resto de la query", () => {
    assert.equal(reservationModeFromSearch(""), "rapida");
    assert.equal(reservationModeFromSearch("?modo=rapida"), "rapida");
    assert.equal(reservationModeFromSearch("?modo=completa"), "completa");
    assert.equal(reservationModeFromSearch("?modo=otra"), "rapida");
    assert.equal(searchWithReservationMode("?guestId=g1&modo=rapida", "completa"), "?guestId=g1&modo=completa");
    assert.equal(searchWithReservationMode("?modo=completa&roomTypeId=t1", "rapida"), "?roomTypeId=t1");
    assert.equal(searchWithReservationMode("", "rapida"), "");
  });

  it("guestIdFromSearch solo admite ids con caracteres de identificador", () => {
    assert.equal(guestIdFromSearch("?guestId=cmrhw9jy40003fyvbuu2ec2w7"), "cmrhw9jy40003fyvbuu2ec2w7");
    assert.equal(guestIdFromSearch("?guestId=<script>"), null);
    assert.equal(guestIdFromSearch("?modo=completa"), null);
  });

  it("guestPrefillValues copia solo lo que tiene valor y enlaza primaryGuestId; nunca pisa con vacíos", () => {
    const values = guestPrefillValues({
      id: "g1",
      organizationId: "org",
      firstName: "Ana",
      surname1: "Alfa",
      fullName: "Ana Alfa",
      email: "ana@uxday.test",
      phone: "",
      documentType: "DNI",
      documentNumber: "12345678Z",
      dateOfBirth: "1990-01-02T00:00:00.000Z",
      residenceCountry: "ESP",
      preferences: [],
      marketingConsent: true,
      createdAt: "2026-01-01"
    });
    assert.equal(values.primaryGuestId, "g1");
    assert.equal(values.firstName, "Ana");
    assert.equal(values.email, "ana@uxday.test");
    assert.equal("phone" in values, false, "un teléfono vacío no pisa lo tecleado");
    assert.equal(values.dateOfBirth, "1990-01-02");
    assert.equal(values.marketingConsent, "yes");
    const merged = { ...form({ phone: "600" }), ...values };
    assert.equal(merged.phone, "600");
    assert.equal(guestDisplayName({ fullName: "", firstName: "Ana", surname1: "Alfa" }), "Ana Alfa");
  });

  it("pickGuestSuggestion: apellido de 3+ letras contenido en el nombre completo, nombre por prefijo, nunca una descartada", () => {
    const guests = [
      { id: "g1", organizationId: "o", firstName: "Ana", surname1: "Alfa", fullName: "Ana Alfa", preferences: [], createdAt: "" },
      { id: "g2", organizationId: "o", firstName: "Luis", surname1: "Alfaro", fullName: "Luis Alfaro", preferences: [], createdAt: "" }
    ];
    assert.equal(pickGuestSuggestion(guests, { firstName: "", surname1: "Alf" })?.id, "g1");
    assert.equal(pickGuestSuggestion(guests, { firstName: "Lu", surname1: "Alfa" })?.id, "g2");
    assert.equal(pickGuestSuggestion(guests, { firstName: "", surname1: "Al" }), null);
    assert.equal(pickGuestSuggestion(guests, { firstName: "", surname1: "Alfa" }, new Set(["g1"]))?.id, "g2");
    assert.equal(pickGuestSuggestion(guests, { firstName: "Zoe", surname1: "Alfa" }), null);
  });

  it("la pantalla lee ?guestId= una vez, pide la ficha y la aplica con primaryGuestId (lista y ficha de huéspedes enlazan así)", () => {
    assert.match(SCREEN, /useState\(\(\) => guestIdFromSearch\(typeof window === "undefined" \? "" : window\.location\.search\)\)/);
    assert.match(SCREEN, /fetchGuest\(prefillGuestId\)/);
    assert.match(SCREEN, /setForm\(\(current\) => \(\{ \.\.\.current, \.\.\.guestPrefillValues\(detail\.guest\) \}\)\)/);
    const guestsList = readFileSync(new URL("../../guests/GuestsListScreen.tsx", import.meta.url), "utf8");
    assert.match(guestsList, /\?guestId=\$\{encodeURIComponent\(guestId\)\}/);
  });
});

describe("modo rápido · esqueleto y ayuda honesta (F33)", () => {
  it("la página pinta el esqueleto espejo mientras carga el catálogo y solo dice «Sin tipos…» con la carga terminada", () => {
    assert.match(SCREEN, /state=\{createdReservation \? "empty" : catalogLoading \? "loading" : "ready"\}/);
    assert.match(SCREEN, /skeleton=\{quick \? <ReservationQuickCreateSkeleton \/> : <ReservationWizardSkeleton \/>\}/);
    assert.match(SCREEN, /roomTypesLoaded && roomTypes\.length === 0 \? "Sin tipos de habitación: configúralos primero\." : undefined/);
    assert.doesNotMatch(SCREEN, /help=\{roomTypes\.length === 0 \?/);
  });

  it("conmutador Rápida / Completa en la cabecera (misma URL, ?modo=) y el modo completo conserva los seis pasos y su CTA", () => {
    assert.match(SCREEN, /tabs=\{MODE_TABS\}/);
    assert.match(SCREEN, /activeTab=\{mode\}/);
    assert.match(SCREEN, /window\.history\.replaceState\(/);
    assert.match(SCREEN, /const STEPS: Array<\{ key: StepKey; label: string; description: string \}> = \[/);
    assert.equal(SCREEN.match(/\{ key: "(estancia|huespedes|tarifa|origen|pagos|solicitudes)"/g)?.length, 6);
    assert.match(SCREEN, /"Confirmar y crear reserva"/);
  });

  it("la tarjeta de instrucciones describe los dos modos con el atajo del registro (⌥N) y no promete vistas que no existen", () => {
    assert.match(INSTRUCTIONS, /shortcutKeys\("nav\.reservation-create"\)/);
    assert.match(INSTRUCTIONS, /RESERVATION_CREATE_INSTRUCTIONS/);
    assert.match(INSTRUCTIONS, /Rápida/);
    assert.match(INSTRUCTIONS, /Completa/);
    assert.doesNotMatch(INSTRUCTIONS, /vista calendario|rack de habitaciones|Shift al hacer clic/);
    assert.doesNotMatch(INSTRUCTIONS, /'⌘K'|"⌘K"/, "los atajos salen del registro, no escritos a mano");
  });
});

describe("modo rápido · «Crear y hacer check-in»: habitación sin otra reserva (409 «ya está asignada»)", () => {
  type Room = { id: string; number: string; roomTypeId: string; status: string; housekeepingStatus?: string; sellable: boolean };
  const room = (id: string, number: string, roomTypeId: string, status: string, hk: string): Room => ({ id, number, roomTypeId, status, housekeepingStatus: hk, sellable: true });
  const ROOMS: Room[] = [room("r104", "104", "dbl", "clean", "clean"), room("r105", "105", "dbl", "clean", "inspected"), room("r110", "110", "dbl", "dirty", "dirty"), room("r301", "301", "sup", "clean", "clean")];

  it("heldRoomIds: solo las reservas vivas de otros (confirmadas y alojadas), nunca la propia ni las cerradas", () => {
    const held = heldRoomIds(
      [
        { id: "mine", assignedRoomId: "r105", status: "confirmed" },
        { id: "a", assignedRoomId: "r104", status: "confirmed" },
        { id: "b", assignedRoomId: "r110", status: "checked_in" },
        { id: "c", assignedRoomId: "r301", status: "cancelled" },
        { id: "d", assignedRoomId: null as unknown as string, status: "confirmed" }
      ],
      "mine"
    );
    assert.deepEqual([...held].sort(), ["r104", "r110"]);
  });

  it("pickQuickCheckinRoom: la primera limpia y libre del tipo que nadie retiene; null si todas están retenidas o sucias", () => {
    assert.equal(pickQuickCheckinRoom(ROOMS, "dbl", new Set())?.number, "104");
    assert.equal(pickQuickCheckinRoom(ROOMS, "dbl", new Set(["r104"]))?.number, "105");
    assert.equal(pickQuickCheckinRoom(ROOMS, "dbl", new Set(["r104", "r105"])), null);
    assert.equal(pickQuickCheckinRoom(ROOMS, "sup", new Set())?.number, "301");
  });

  it("el componente consulta las reservas vivas de la ventana justo antes de asignar y, sin candidata, crea igualmente y abre la ficha con aviso", () => {
    assert.match(QUICK_SRC, /fetchReservations\(propertyId, \{ from: form\.arrivalDate, to: form\.departureDate, status: \["confirmed", "checked_in"\], limit: 500 \}\)/);
    assert.match(QUICK_SRC, /pickQuickCheckinRoom\(rooms, form\.roomTypeId, heldRoomIds\(overlapping\.items \?\? \[\], reservation\.id\)\)/);
    assert.match(QUICK_SRC, /payment: null/, "el check-in desde Nueva reserva no cobra: el cobro es «Crear y cobrar depósito» o la ficha");
  });
});

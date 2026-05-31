// demo-pre-demo-enrichment.mjs
//
// Pre-demo enrichment seed: pinta una capa REALISTA de reservas, huéspedes y
// folios sobre los datos que ya existen, sin destruirlos.
//
// Para cada Property activa crea (idempotente via upsert / skipDuplicates):
//   · 25 reservas en una ventana de ±30 días alrededor de HOY, con la mezcla
//     concreta que la demo necesita ver en pantalla:
//        - 5  llegadas de hoy             (confirmed, arrival=today)
//        - 3  salidas de hoy              (checked_out, departure=today)
//        - 12 in-house                    (checked_in, arrival<today<=departure)
//        - 5  futuras                     (confirmed, arrival>today)
//   · 1 Guest por reserva (DNI/Pasaporte + nacionalidad + fecha de nacimiento
//     → suficiente para el SES Hospedajes record check).
//   · 1 Folio con 3-5 cargos (alojamiento + 2-4 de breakfast / minibar / parking /
//     spa) por reserva.
//   · 6 reservas con folio totalmente pagado (status=checked_out, balance 0).
//   · 8 reservas con saldo pendiente (payment < total).
//
// Determinismo:
//   - El script NUNCA usa Math.random en su cuerpo. Toda la variabilidad sale
//     de "i % N" sobre el índice de la reserva dentro de la property.
//   - Códigos de reserva con prefijo PREENR-<propShort>-<NNN> → upsert estable.
//   - Re-ejecutar el script NO duplica filas: primero borra los rastros de
//     ejecuciones previas (sólo filas con códigos PREENR-) y luego upsertea.
//     Los datos reales que ya tenga la propiedad NO se tocan.
//
// Uso:
//   node --env-file=../../.env packages/database/seeds/demo-pre-demo-enrichment.mjs
//
// Salida final (stdout): un resumen con totales de reservas / huéspedes / folios
// creados para que el script orquestador pueda parsearlo.

import { prisma } from "@hotelos/database";

const PREFIX = "PREENR";
const MS_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Helpers de fecha (todo en UTC para evitar el clásico salto de zona horaria
// que mueve la reserva un día arriba o abajo según el huso del runner CI).
// ---------------------------------------------------------------------------
function startOfTodayUtc() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function addDays(d, n) {
  return new Date(d.getTime() + n * MS_DAY);
}
function atUtc(d, hour, minute = 0) {
  return new Date(d.getTime() + (hour * 60 + minute) * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Catálogos determinísticos — cero randomness, variabilidad por índice.
// ---------------------------------------------------------------------------
const SPANISH_FIRST = [
  "Antonio", "María", "Manuel", "Carmen", "José", "Ana", "Francisco", "Isabel",
  "David", "Laura", "Javier", "Marta", "Carlos", "Lucía", "Daniel", "Sara",
  "Pablo", "Paula", "Jorge", "Elena", "Alberto", "Cristina", "Sergio", "Andrea",
  "Rubén"
];
const SPANISH_SUR = [
  "García", "Rodríguez", "González", "Fernández", "López", "Martínez", "Sánchez",
  "Pérez", "Gómez", "Martín", "Jiménez", "Ruiz", "Hernández", "Díaz", "Moreno",
  "Muñoz", "Álvarez", "Romero", "Alonso", "Gutiérrez", "Navarro", "Torres",
  "Domínguez", "Vázquez", "Ramos"
];
const INTL_FIRST = [
  "Hans", "Sophie", "Liam", "Emma", "Lukas", "Marie", "Pierre", "Camille",
  "Giuseppe", "Sofia", "Diego", "Beatriz", "Oliver", "Klaus", "Anna"
];
const INTL_SUR = [
  "Müller", "Schmidt", "Smith", "Brown", "Dubois", "Martin", "Rossi", "Bianchi",
  "Silva", "Santos", "Becker", "Andersen", "Larsen"
];
const INTL_NAT = ["DE", "FR", "GB", "IT", "PT", "NL", "BE", "DK", "SE"];

const CHANNELS = ["direct", "booking.com", "expedia", "hotelbeds", "web"];
const BOARDS = ["RO", "BB", "BB", "HB", "AI"];
const MARKET_SEGMENTS = ["leisure", "corporate", "leisure", "group", "ota_leisure"];
const SOURCE_TAGS = ["DIRECT", "BDC", "EXP", "HBEDS", "WEB"];

// Spanish DNI control letter from the 8-digit numeric part.
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
function dniLetter(num) {
  return DNI_LETTERS[num % 23];
}

// ---------------------------------------------------------------------------
// Guest builder — completamente determinístico a partir del índice.
// ---------------------------------------------------------------------------
function buildGuest(orgId, propShort, idx) {
  // Mezcla 70% nacionales / 30% internacionales → matches la realidad ES PMS.
  const isSpanish = idx % 10 < 7;
  const baseYear = 1955 + (idx * 7) % 50; // 1955-2004
  const month = idx % 12;
  const day = 1 + (idx * 3) % 28;
  const dob = new Date(Date.UTC(baseYear, month, day));

  if (isSpanish) {
    const first = SPANISH_FIRST[idx % SPANISH_FIRST.length];
    const sur1 = SPANISH_SUR[idx % SPANISH_SUR.length];
    const sur2 = SPANISH_SUR[(idx + 7) % SPANISH_SUR.length];
    // 8-digit deterministic DNI body — embebemos propShort en los primeros
    // dígitos para evitar colisiones globales (la unique constraint efectiva
    // está en (organizationId, documentNumberLookupHash), pero queremos que
    // los huéspedes de cada hotel parezcan distintos en listados cross-org).
    const shortDigits = propShort.split("").map((c) => c.charCodeAt(0)).reduce((s, n) => s + n, 0);
    const dniNum = (10000000 + shortDigits * 1000 + idx * 37) % 100000000;
    const dniStr = String(dniNum).padStart(8, "0");
    const dni = `${dniStr}${dniLetter(dniNum)}`;
    return {
      organizationId: orgId,
      firstName: first,
      surname1: sur1,
      surname2: sur2,
      nationality: "ES",
      sex: idx % 2 === 0 ? "F" : "M",
      documentType: "DNI",
      documentNumber: dni,
      dateOfBirth: dob,
      email: `${first.toLowerCase()}.${sur1.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}.${propShort.toLowerCase()}${idx}@demo.example`,
      phone: `+34 6${10 + (idx * 11) % 90} ${100 + (idx * 31) % 900} ${100 + (idx * 41) % 900}`,
      residenceCountry: "ES",
      residenceLocality: ["Madrid", "Barcelona", "Valencia", "Sevilla", "Zaragoza", "Bilbao", "Málaga", "Granada"][idx % 8],
      residenceProvince: ["Madrid", "Barcelona", "Valencia", "Sevilla", "Zaragoza", "Vizcaya", "Málaga", "Granada"][idx % 8],
      residenceAddress: `Calle ${SPANISH_SUR[(idx + 3) % SPANISH_SUR.length]} ${1 + (idx * 13) % 200}`,
      residencePostalCode: String(1000 + (idx * 137) % 49000).padStart(5, "0"),
      marketingConsent: idx % 3 === 0
    };
  }

  const first = INTL_FIRST[idx % INTL_FIRST.length];
  const sur1 = INTL_SUR[idx % INTL_SUR.length];
  const nat = INTL_NAT[idx % INTL_NAT.length];
  // Passport format: 2-letter country + 2 letters + 6 digits.
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const passport =
    nat +
    letters[idx % 26] +
    letters[(idx * 7) % 26] +
    String(100000 + (idx * 173) % 899999).padStart(6, "0");
  return {
    organizationId: orgId,
    firstName: first,
    surname1: sur1,
    nationality: nat,
    sex: idx % 2 === 0 ? "M" : "F",
    documentType: "PASSPORT",
    documentNumber: passport,
    dateOfBirth: dob,
    email: `${first.toLowerCase()}.${sur1.toLowerCase()}.${propShort.toLowerCase()}${idx}@demo.example`,
    phone: `+${30 + (idx % 20)} ${100 + (idx * 17) % 900} ${1000 + (idx * 43) % 9000}`,
    residenceCountry: nat,
    marketingConsent: idx % 4 === 0
  };
}

// ---------------------------------------------------------------------------
// Plan de reserva — distribución dirigida por índice (no por bucket aleatorio).
//   idx 0-4   → 5 today arrivals
//   idx 5-7   → 3 today departures
//   idx 8-19  → 12 in-house
//   idx 20-24 → 5 futuras
// ---------------------------------------------------------------------------
function planReservation(idx, today) {
  if (idx < 5) {
    // Llegada hoy, salida en 1-3 noches.
    const los = 1 + (idx % 3);
    return { bucket: "arrival_today", status: "confirmed", arrival: today, departure: addDays(today, los), nights: los };
  }
  if (idx < 8) {
    // Salida hoy → arrival en pasado, status checked_out.
    const los = 2 + (idx % 3);
    return { bucket: "departure_today", status: "checked_out", arrival: addDays(today, -los), departure: today, nights: los };
  }
  if (idx < 20) {
    // In-house: arrival en pasado (1-4 días), departure futuro.
    const past = 1 + ((idx - 8) % 4);
    const ahead = 1 + ((idx - 8) % 5);
    return { bucket: "in_house", status: "checked_in", arrival: addDays(today, -past), departure: addDays(today, ahead), nights: past + ahead };
  }
  // Futuras: arrival 2-25 días por delante.
  const ahead = 2 + ((idx - 20) * 5) % 24;
  const los = 2 + ((idx - 20) % 4);
  return { bucket: "future", status: "confirmed", arrival: addDays(today, ahead), departure: addDays(today, ahead + los), nights: los };
}

// ---------------------------------------------------------------------------
// ADR determinista: 95-180€, varía por idx.
// ---------------------------------------------------------------------------
function adrFor(idx) {
  return 95 + (idx * 7) % 86; // ∈ [95, 180]
}

// ---------------------------------------------------------------------------
// Cargos extra (3-5 totales por folio incluyendo room rate).
// El bloque varía por idx → reproducible.
// ---------------------------------------------------------------------------
const INCIDENTALS = [
  { type: "breakfast", desc: "Desayuno buffet", unit: 18 },
  { type: "minibar", desc: "Minibar consumo", unit: 12.5 },
  { type: "parking", desc: "Parking 24h", unit: 22 },
  { type: "spa", desc: "Tratamiento spa", unit: 65 },
  { type: "laundry", desc: "Servicio lavandería", unit: 14 },
  { type: "fb", desc: "Restaurante a la carta", unit: 38 }
];

function pickIncidentals(idx, nights) {
  // 3-5 cargos totales → 2-4 incidentals (room rate cuenta como 1).
  const incidentalCount = 2 + (idx % 3); // 2, 3 ó 4
  const lines = [];
  for (let k = 0; k < incidentalCount; k++) {
    const inc = INCIDENTALS[(idx + k) % INCIDENTALS.length];
    // breakfast escala con noches; minibar/laundry son 1 cargo único; parking
    // escala con noches; spa/fb son cargos puntuales.
    const qty =
      inc.type === "breakfast" || inc.type === "parking"
        ? Math.max(1, nights)
        : 1;
    const total = Math.round(inc.unit * qty * 100) / 100;
    lines.push({ type: inc.type, description: inc.desc, quantity: qty, unitPrice: inc.unit, total });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Construye un nombre de booker desde el idx (sin acceso al objeto guest
// completo, lo derivamos del idx para que no requiera prefetch).
// ---------------------------------------------------------------------------
function bookerName(idx) {
  const isSpanish = idx % 10 < 7;
  if (isSpanish) {
    return `${SPANISH_FIRST[idx % SPANISH_FIRST.length]} ${SPANISH_SUR[idx % SPANISH_SUR.length]}`;
  }
  return `${INTL_FIRST[idx % INTL_FIRST.length]} ${INTL_SUR[idx % INTL_SUR.length]}`;
}

// ---------------------------------------------------------------------------
// Borra suavemente los rastros de ejecuciones previas para esta property.
// Solo toca filas con códigos PREENR-* — todo lo demás queda intacto.
// ---------------------------------------------------------------------------
async function purgePrevious(propertyId) {
  const previous = await prisma.reservation.findMany({
    where: { propertyId, code: { startsWith: `${PREFIX}-` } },
    select: { id: true }
  });
  if (previous.length === 0) return 0;
  const ids = previous.map((r) => r.id);

  // Capturar guests primarios antes de borrar reservation_guests para limpiarlos
  // también — son sintéticos (sólo viven en esta seed) así que no contaminan los
  // datasets de huéspedes reales del PMS.
  const guestLinks = await prisma.reservationGuest.findMany({
    where: { reservationId: { in: ids } },
    select: { guestId: true }
  });
  const guestIds = Array.from(new Set(guestLinks.map((g) => g.guestId)));

  await prisma.payment.deleteMany({ where: { folio: { reservationId: { in: ids } } } });
  await prisma.folioLine.deleteMany({ where: { folio: { reservationId: { in: ids } } } });
  await prisma.folio.deleteMany({ where: { reservationId: { in: ids } } });
  await prisma.stay.deleteMany({ where: { reservationId: { in: ids } } });
  await prisma.reservationGuest.deleteMany({ where: { reservationId: { in: ids } } });
  await prisma.reservation.deleteMany({ where: { id: { in: ids } } });
  if (guestIds.length > 0) {
    await prisma.guest.deleteMany({ where: { id: { in: guestIds } } });
  }
  return previous.length;
}

// ---------------------------------------------------------------------------
// Seed core — todo lo que se hace para UNA property.
// ---------------------------------------------------------------------------
async function seedProperty(property) {
  // Identificador corto y estable para los códigos de reserva.
  const propShort = property.id.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase() || "DEMO";
  const today = startOfTodayUtc();

  // 1) Limpiar runs anteriores → idempotencia.
  const purged = await purgePrevious(property.id);

  // 2) Pre-fetch room types & rooms (variabilidad por idx).
  const roomTypes = await prisma.roomType.findMany({
    where: { propertyId: property.id, active: true },
    orderBy: { displayOrder: "asc" }
  });
  if (roomTypes.length === 0) {
    return { property: property.id, skipped: true, reason: "no_room_types", purged };
  }

  // Tomamos sólo los rate plans activos (opcional en el schema; muchas
  // propiedades en demos legacy no tienen ninguno).
  const ratePlans = await prisma.ratePlan.findMany({
    where: { propertyId: property.id, active: true },
    take: 5
  });

  // Para asignar habitaciones (Stay) en in-house / checked_out, intentamos
  // pillar una room de cada room type — no es crítico si no hay rooms (la
  // reserva se crea igual sin assignedRoomId / stay).
  const rooms = await prisma.room.findMany({
    where: { propertyId: property.id, active: true, sellable: true },
    take: 200
  });
  const roomsByType = new Map();
  for (const r of rooms) {
    if (!r.roomTypeId) continue;
    if (!roomsByType.has(r.roomTypeId)) roomsByType.set(r.roomTypeId, []);
    roomsByType.get(r.roomTypeId).push(r);
  }

  let createdReservations = 0;
  let createdGuests = 0;
  let createdFolios = 0;
  let createdFolioLines = 0;
  let createdPayments = 0;

  // Buckets de pago dirigidos por índice:
  //   · 6 reservas "fully_paid" (idx 5..10): coincide con las departures del
  //     día + las primeras in-house, que es donde el pago capturado tiene más
  //     sentido en la pantalla de demo.
  //   · 8 reservas "outstanding" (idx 11..18): in-house con saldo pendiente,
  //     típico de huéspedes que pagarán al check-out.
  //   · Resto (idx ∈ {0..4, 19..24}): sin payment → saldo 100% pendiente.
  const FULLY_PAID_IDX = new Set([5, 6, 7, 8, 9, 10]);
  const OUTSTANDING_IDX = new Set([11, 12, 13, 14, 15, 16, 17, 18]);

  for (let i = 0; i < 25; i++) {
    const plan = planReservation(i, today);
    const rt = roomTypes[i % roomTypes.length];
    const rp = ratePlans.length > 0 ? ratePlans[i % ratePlans.length] : null;
    const channel = CHANNELS[i % CHANNELS.length];
    const board = BOARDS[i % BOARDS.length];
    const segment = MARKET_SEGMENTS[i % MARKET_SEGMENTS.length];
    const sourceTag = SOURCE_TAGS[i % SOURCE_TAGS.length];
    const adr = adrFor(i);
    const adults = 1 + (i % 2); // 1 ó 2
    const children = i % 7 === 0 ? 1 : 0;
    const nights = Math.max(1, plan.nights);
    const roomTotal = Math.round(adr * nights * 100) / 100;
    const incidentals = pickIncidentals(i, nights);
    const incidentalsTotal = Math.round(incidentals.reduce((s, l) => s + l.total, 0) * 100) / 100;
    const total = Math.round((roomTotal + incidentalsTotal) * 100) / 100;

    const code = `${PREFIX}-${propShort}-${String(i + 1).padStart(3, "0")}`;

    // 3) Upsert reserva — code es único por (propertyId, code) → reentry safe.
    const reservationData = {
      propertyId: property.id,
      code,
      channel,
      status: plan.status,
      arrivalDate: plan.arrival,
      departureDate: plan.departure,
      adults,
      children,
      roomsCount: 1,
      roomTypeId: rt.id,
      ratePlanId: rp ? rp.id : null,
      boardType: board,
      marketSegment: segment,
      sourceCode: sourceTag,
      purposeOfStay: segment === "corporate" ? "business" : segment === "group" ? "group" : "leisure",
      bookerName: bookerName(i),
      bookerEmail: `${bookerName(i).toLowerCase().replace(/[^a-z]/g, ".")}@demo.example`,
      totalAmount: total,
      currency: "EUR",
      vipFlag: i % 11 === 0,
      depositAmount: null,
      externalReference:
        channel === "booking.com"
          ? `BDC-${1000000 + (i * 1237) % 9000000}`
          : channel === "expedia"
            ? `EXP-${100000 + (i * 311) % 900000}`
            : null,
      specialRequests: i % 6 === 0 ? "Cuna para bebé" : i % 6 === 3 ? "Habitación tranquila" : null
    };

    const reservation = await prisma.reservation.upsert({
      where: { propertyId_code: { propertyId: property.id, code } },
      create: reservationData,
      update: reservationData
    });
    createdReservations++;

    // 4) Guest + ReservationGuest link. Como el documento + lookupHash van
    //    cifrados por la extensión Prisma, un upsert por documentNumber es
    //    arriesgado (la PII se transforma antes de la query). Por eso aquí
    //    creamos el guest tras haber purgado los anteriores en purgePrevious.
    const guestData = buildGuest(property.organizationId, propShort, i + propShort.charCodeAt(0));
    const guest = await prisma.guest.create({ data: guestData });
    createdGuests++;
    await prisma.reservationGuest.create({
      data: {
        reservationId: reservation.id,
        guestId: guest.id,
        isPrimary: true,
        relationshipType: "self"
      }
    });

    // 5) Asignar habitación + Stay para reservas in-house / checked_out.
    if (plan.status === "checked_in" || plan.status === "checked_out") {
      const candidates = roomsByType.get(rt.id) ?? [];
      if (candidates.length > 0) {
        // Index distribution: cada idx pilla una room diferente del pool de
        // su room type — evita "habitación X aparece en 5 reservas".
        const room = candidates[i % candidates.length];
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: { assignedRoomId: room.id }
        });
        // Stay → 16:00 check-in, 11:00 check-out el día de salida.
        await prisma.stay.create({
          data: {
            reservationId: reservation.id,
            roomId: room.id,
            checkinAt: atUtc(plan.arrival, 16),
            checkoutAt: plan.status === "checked_out" ? atUtc(plan.departure, 11) : null,
            status: plan.status === "checked_in" ? "in_house" : "checked_out"
          }
        });
      }
    }

    // 6) Folio primario + folio lines.
    const folio = await prisma.folio.create({
      data: {
        reservationId: reservation.id,
        guestId: guest.id,
        status: plan.status === "checked_out" ? "closed" : "open",
        currency: "EUR",
        label: "guest",
        isPrimary: true
      }
    });
    createdFolios++;

    // 6a) Línea de habitación (1 línea agregada por todas las noches).
    await prisma.folioLine.create({
      data: {
        folioId: folio.id,
        type: "room",
        description: `Alojamiento ${rt.name} · ${nights} noches`,
        quantity: nights,
        unitPrice: adr,
        taxCode: "IVA_10",
        total: roomTotal,
        postedAt: plan.arrival
      }
    });
    createdFolioLines++;

    // 6b) Incidentals (2-4 líneas).
    if (incidentals.length > 0) {
      const incidentalRows = incidentals.map((line, k) => ({
        folioId: folio.id,
        type: line.type,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxCode: line.type === "spa" ? "IVA_21" : "IVA_10",
        total: line.total,
        // Distribuye los cargos a lo largo de la estancia.
        postedAt: addDays(plan.arrival, Math.min(nights - 1, k))
      }));
      const result = await prisma.folioLine.createMany({
        data: incidentalRows,
        skipDuplicates: true
      });
      createdFolioLines += result.count;
    }

    // 7) Política de pagos por idx.
    if (FULLY_PAID_IDX.has(i)) {
      // Si la reserva no es checked_out, la promovemos a checked_out + folio
      // cerrado para que sea coherente con el saldo a cero.
      if (plan.status !== "checked_out") {
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: { status: "checked_out" }
        });
        await prisma.folio.update({ where: { id: folio.id }, data: { status: "closed" } });
      }
      await prisma.payment.create({
        data: {
          propertyId: property.id,
          folioId: folio.id,
          amount: total,
          currency: "EUR",
          method: i % 2 === 0 ? "card" : "transfer",
          pspReference: `PSP-${10000000 + (i * 173) % 89999999}`,
          status: "captured"
        }
      });
      createdPayments++;
    } else if (OUTSTANDING_IDX.has(i)) {
      // Deposit del 30-50% según idx → saldo pendiente del 70-50%.
      const depositPct = 0.3 + ((i - 11) % 3) * 0.1; // 0.3, 0.4, 0.5
      const deposit = Math.round(total * depositPct * 100) / 100;
      await prisma.payment.create({
        data: {
          propertyId: property.id,
          folioId: folio.id,
          amount: deposit,
          currency: "EUR",
          method: "card",
          pspReference: `PSP-${10000000 + (i * 211) % 89999999}`,
          status: "captured"
        }
      });
      createdPayments++;
    }
    // Resto (idx ∈ {0..4, 19..24}): sin payment → saldo 100% pendiente,
    // típico de reservas confirmadas sin deposit o llegadas del día.
  }

  return {
    property: property.id,
    skipped: false,
    purged,
    reservations: createdReservations,
    guests: createdGuests,
    folios: createdFolios,
    folioLines: createdFolioLines,
    payments: createdPayments
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  // "Active" property = status en {open, active, live}. El schema usa "open"
  // como default; aceptamos varios valores para ser tolerantes con seeds
  // existentes (chain-iberia usa "open", local-demo usa "open", futuros seeds
  // podrían usar "active").
  const ACTIVE_STATUSES = ["open", "active", "live"];
  const properties = await prisma.property.findMany({
    where: { status: { in: ACTIVE_STATUSES } },
    orderBy: { name: "asc" }
  });
  if (properties.length === 0) {
    console.log("[pre-demo-enrich] no active properties found; nothing to seed.");
    console.log(JSON.stringify({ propertiesSeeded: 0, reservations: 0, guests: 0, folios: 0, folioLines: 0, payments: 0 }));
    await prisma.$disconnect();
    return;
  }

  console.log(`[pre-demo-enrich] enriching ${properties.length} active properties…`);

  let totalReservations = 0;
  let totalGuests = 0;
  let totalFolios = 0;
  let totalFolioLines = 0;
  let totalPayments = 0;
  let propsSeeded = 0;
  let propsSkipped = 0;

  for (const property of properties) {
    try {
      const result = await seedProperty(property);
      if (result.skipped) {
        propsSkipped++;
        console.log(`[pre-demo-enrich] · skipped ${property.id} (${property.name}) → ${result.reason}`);
        continue;
      }
      propsSeeded++;
      totalReservations += result.reservations;
      totalGuests += result.guests;
      totalFolios += result.folios;
      totalFolioLines += result.folioLines;
      totalPayments += result.payments;
      console.log(
        `[pre-demo-enrich] ✓ ${property.id} (${property.name}) · purged=${result.purged} · res=${result.reservations} guests=${result.guests} folios=${result.folios} lines=${result.folioLines} payments=${result.payments}`
      );
    } catch (err) {
      console.error(`[pre-demo-enrich] ✗ ${property.id} failed:`, err instanceof Error ? err.message : err);
      throw err;
    }
  }

  // Resumen final (también imprime una línea JSON parseable por el
  // orquestador, además del bloque humano-legible).
  console.log("\n[pre-demo-enrich] === Summary ===");
  console.log(`  Properties seeded : ${propsSeeded}`);
  console.log(`  Properties skipped: ${propsSkipped}`);
  console.log(`  Reservations      : ${totalReservations}`);
  console.log(`  Guests            : ${totalGuests}`);
  console.log(`  Folios            : ${totalFolios}`);
  console.log(`  Folio lines       : ${totalFolioLines}`);
  console.log(`  Payments          : ${totalPayments}`);
  console.log(
    JSON.stringify({
      propertiesSeeded: propsSeeded,
      propertiesSkipped: propsSkipped,
      reservations: totalReservations,
      guests: totalGuests,
      folios: totalFolios,
      folioLines: totalFolioLines,
      payments: totalPayments
    })
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[pre-demo-enrich] FATAL:", err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

// Seed: reservas + huéspedes + folios para la cadena Iberia (8 hoteles).
//
// Genera una distribución realista alrededor de HOY:
//   - in_house   (15%): checked_in, llegada en últimos 5 días, salida futura
//   - departures (8%):  checked_in, salida HOY
//   - arrivals   (10%): confirmed, llegada HOY
//   - future     (35%): confirmed, llegada en próximos 60 días
//   - past       (25%): checked_out, completadas
//   - cancelled  (5%):  cancelled
//   - no_show    (2%):  no_show
//
// Distribuye proporcionalmente al tamaño del hotel (Mallorca 210 hab → ~50 reservas,
// Granada 28 hab → ~10 reservas) hasta totalizar ~200.
//
// Cada reserva:
//   - 1-4 huéspedes (con DNI/pasaporte español para SES Hospedajes)
//   - Folio primario con línea(s) de habitación + tasa turística (CCAA aplicable)
//   - Pago (captured) en check-out
//
// Idempotente: borra primero todas las reservas con código IBSEED-* antes de regenerar.

import { prisma } from "@hotelos/database";

const ORG_ID = "org_chain_iberia";
const SEED_PREFIX = "IBSEED";

// ---------------------------------------------------------------------------
// Datasets — nombres españoles, nacionalidades y emisores DNI realistas.
// ---------------------------------------------------------------------------

const FIRST_NAMES_ES = [
  "Antonio", "María", "Manuel", "Carmen", "José", "Ana", "Francisco", "Isabel",
  "David", "Laura", "Javier", "Marta", "Carlos", "Lucía", "Daniel", "Sara",
  "Pablo", "Paula", "Jorge", "Elena", "Alberto", "Cristina", "Sergio", "Andrea",
  "Rubén", "Patricia", "Iván", "Beatriz", "Adrián", "Nuria"
];
const SURNAMES_ES = [
  "García", "Rodríguez", "González", "Fernández", "López", "Martínez", "Sánchez",
  "Pérez", "Gómez", "Martín", "Jiménez", "Ruiz", "Hernández", "Díaz", "Moreno",
  "Muñoz", "Álvarez", "Romero", "Alonso", "Gutiérrez", "Navarro", "Torres",
  "Domínguez", "Vázquez", "Ramos", "Gil", "Ramírez", "Serrano", "Blanco", "Suárez"
];
const FIRST_NAMES_EU = [
  "Hans", "Klaus", "Sabine", "Liam", "Sophie", "Oliver", "Emma", "Lukas",
  "Marie", "Pierre", "Camille", "Giuseppe", "Sofia", "Diego", "Beatriz"
];
const SURNAMES_EU = [
  "Müller", "Schmidt", "Becker", "Smith", "Brown", "Dubois", "Martin",
  "Rossi", "Bianchi", "Silva", "Santos"
];
const NATIONALITIES_INTL = ["DE", "FR", "GB", "IT", "PT", "NL", "BE", "DK", "SE"];

// Canales con su comisión típica.
const CHANNELS = [
  { code: "direct", weight: 22 },
  { code: "booking.com", weight: 38 },
  { code: "expedia", weight: 14 },
  { code: "hotelbeds", weight: 8 },
  { code: "tui", weight: 6 },
  { code: "tour_operator", weight: 4 },
  { code: "group", weight: 4 },
  { code: "walk_in", weight: 4 }
];

const PURPOSES = ["leisure", "leisure", "leisure", "business", "business", "group"];
const BOARDS = ["RO", "BB", "BB", "BB", "HB", "AI"];

// Reservas a generar por hotel (proporcional al tamaño).
const RESERVATIONS_PER_HOTEL: Record<string, number> = {
  prop_iberia_madrid: 22,
  prop_iberia_barcelona: 32,
  prop_iberia_sevilla: 14,
  prop_iberia_marbella: 42,
  prop_iberia_valencia: 22,
  prop_iberia_bilbao: 18,
  prop_iberia_mallorca: 48,
  prop_iberia_granada: 12
};

// CCAA → tasa turística aplicable (per person per night, € medio aplicado).
const TOURIST_TAX_BY_CCAA: Record<string, { perNight: number; class: string } | undefined> = {
  CAT: { perNight: 3.2, class: "4_estrellas" },  // Barcelona supplement → 3.2 4★
  BAL: { perNight: 2.5, class: "4_estrellas" },  // base 1.5 + verano +1
  EUSK: { perNight: 1.5, class: "4_estrellas" }
};

// CCAA code de cada hotel (mirror del seed principal).
const CCAA_BY_HOTEL: Record<string, string> = {
  prop_iberia_madrid: "MAD",
  prop_iberia_barcelona: "CAT",
  prop_iberia_sevilla: "AND",
  prop_iberia_marbella: "AND",
  prop_iberia_valencia: "VC",
  prop_iberia_bilbao: "EUSK",
  prop_iberia_mallorca: "BAL",
  prop_iberia_granada: "AND"
};

// ADR base por hotel (€/noche). Refleja la mezcla de room types del seed
// principal. Se ajusta con ±15% en función de canal y fin de semana.
const ADR_BY_HOTEL: Record<string, number> = {
  prop_iberia_madrid: 165,
  prop_iberia_barcelona: 195,
  prop_iberia_sevilla: 175,
  prop_iberia_marbella: 360,
  prop_iberia_valencia: 145,
  prop_iberia_bilbao: 165,
  prop_iberia_mallorca: 280,
  prop_iberia_granada: 195
};

// ---------------------------------------------------------------------------
// Generadores deterministas (PRNG con semilla) — re-ejecuciones idénticas.
// ---------------------------------------------------------------------------

let prngState = 0x12345678;
function seedPrng(s: number) { prngState = s; }
function rand(): number {
  prngState = (prngState * 1664525 + 1013904223) >>> 0;
  return prngState / 0xffffffff;
}
function randInt(min: number, max: number): number { return Math.floor(rand() * (max - min + 1)) + min; }
function pick<T>(arr: readonly T[]): T { return arr[Math.floor(rand() * arr.length)]; }
function pickWeighted<T extends { weight: number }>(arr: readonly T[]): T {
  const total = arr.reduce((s, x) => s + x.weight, 0);
  let n = rand() * total;
  for (const item of arr) { n -= item.weight; if (n <= 0) return item; }
  return arr[arr.length - 1];
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// DNI español: 8 dígitos + letra de control.
function generateDni(): string {
  const num = String(randInt(10000000, 99999999));
  const letters = "TRWAGMYFPDXBNJZSQVHLCKE";
  const letter = letters[Number(num) % 23];
  return `${num}${letter}`;
}

// Pasaporte aleatorio (formato genérico AB123456).
function generatePassport(country: string): string {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return country + a[randInt(0, 25)] + a[randInt(0, 25)] + String(randInt(100000, 999999));
}

// ---------------------------------------------------------------------------
// Build guest data — devuelve datos crudos para Prisma.
// ---------------------------------------------------------------------------

function generateGuest(spanishProbability = 0.7): {
  firstName: string;
  surname1: string;
  surname2?: string;
  nationality: string;
  documentType: string;
  documentNumber: string;
  email: string;
  phone: string;
  dateOfBirth: Date;
  residenceCountry: string;
  residenceLocality?: string;
  residenceProvince?: string;
  residenceAddress?: string;
  residencePostalCode?: string;
} {
  const isSpanish = rand() < spanishProbability;
  if (isSpanish) {
    const first = pick(FIRST_NAMES_ES);
    const sur1 = pick(SURNAMES_ES);
    const sur2 = pick(SURNAMES_ES);
    return {
      firstName: first,
      surname1: sur1,
      surname2: sur2,
      nationality: "ES",
      documentType: "DNI",
      documentNumber: generateDni(),
      email: `${first.toLowerCase()}.${sur1.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}@example.com`,
      phone: `+34 6${randInt(10, 99)} ${randInt(100, 999)} ${randInt(100, 999)}`,
      dateOfBirth: new Date(Date.UTC(randInt(1955, 2005), randInt(0, 11), randInt(1, 28))),
      residenceCountry: "ES",
      residenceLocality: pick(["Madrid", "Barcelona", "Valencia", "Sevilla", "Zaragoza", "Bilbao", "Málaga", "Granada"]),
      residenceProvince: pick(["Madrid", "Barcelona", "Valencia", "Sevilla", "Zaragoza", "Vizcaya", "Málaga", "Granada"]),
      residenceAddress: `Calle ${pick(SURNAMES_ES)} ${randInt(1, 200)}`,
      residencePostalCode: String(randInt(1000, 50000)).padStart(5, "0")
    };
  }
  const first = pick(FIRST_NAMES_EU);
  const sur1 = pick(SURNAMES_EU);
  const nat = pick(NATIONALITIES_INTL);
  return {
    firstName: first,
    surname1: sur1,
    nationality: nat,
    documentType: "PASSPORT",
    documentNumber: generatePassport(nat),
    email: `${first.toLowerCase()}.${sur1.toLowerCase()}@example.com`,
    phone: `+${randInt(30, 49)} ${randInt(100, 999)} ${randInt(1000, 9999)}`,
    dateOfBirth: new Date(Date.UTC(randInt(1955, 2005), randInt(0, 11), randInt(1, 28))),
    residenceCountry: nat
  };
}

// ---------------------------------------------------------------------------
// Plan de reserva — decide fechas + estado.
// ---------------------------------------------------------------------------

type ReservationPlan = {
  status: "draft" | "confirmed" | "checked_in" | "checked_out" | "cancelled" | "no_show";
  arrival: Date;
  departure: Date;
  bucket: string;
};

function planReservation(today: Date): ReservationPlan {
  const r = rand();
  // Buckets: in_house 15% · departures 8% · arrivals 10% · future 35% · past 25% · cancelled 5% · no_show 2%
  if (r < 0.15) {
    const nightsAgo = randInt(1, 5);
    const stay = randInt(2, 7);
    return { status: "checked_in", arrival: addDays(today, -nightsAgo), departure: addDays(today, stay - nightsAgo), bucket: "in_house" };
  }
  if (r < 0.23) {
    const nightsAgo = randInt(2, 6);
    return { status: "checked_in", arrival: addDays(today, -nightsAgo), departure: today, bucket: "departures" };
  }
  if (r < 0.33) {
    const stay = randInt(2, 5);
    return { status: "confirmed", arrival: today, departure: addDays(today, stay), bucket: "arrivals" };
  }
  if (r < 0.68) {
    const ahead = randInt(2, 60);
    const stay = randInt(2, 7);
    return { status: "confirmed", arrival: addDays(today, ahead), departure: addDays(today, ahead + stay), bucket: "future" };
  }
  if (r < 0.93) {
    const ago = randInt(7, 90);
    const stay = randInt(2, 5);
    return { status: "checked_out", arrival: addDays(today, -ago - stay), departure: addDays(today, -ago), bucket: "past" };
  }
  if (r < 0.98) {
    const ahead = randInt(-10, 30);
    const stay = randInt(2, 5);
    return { status: "cancelled", arrival: addDays(today, ahead), departure: addDays(today, ahead + stay), bucket: "cancelled" };
  }
  const ago = randInt(1, 10);
  const stay = randInt(2, 5);
  return { status: "no_show", arrival: addDays(today, -ago), departure: addDays(today, -ago + stay), bucket: "no_show" };
}

// ---------------------------------------------------------------------------
// Seed runner
// ---------------------------------------------------------------------------

async function clearPreviousSeed() {
  console.log("[res-seed] purgando reservas anteriores IBSEED…");
  const existing = await prisma.reservation.findMany({
    where: { code: { startsWith: SEED_PREFIX }, propertyId: { startsWith: "prop_iberia_" } },
    select: { id: true }
  });
  if (existing.length === 0) return;
  const ids = existing.map((r) => r.id);
  // Cascade deletes: stays, folios → folio_lines / payments, reservation_guests
  await prisma.payment.deleteMany({ where: { folio: { reservationId: { in: ids } } } });
  await prisma.folioLine.deleteMany({ where: { folio: { reservationId: { in: ids } } } });
  await prisma.folio.deleteMany({ where: { reservationId: { in: ids } } });
  await prisma.stay.deleteMany({ where: { reservationId: { in: ids } } });
  await prisma.reservationGuest.deleteMany({ where: { reservationId: { in: ids } } });
  await prisma.reservation.deleteMany({ where: { id: { in: ids } } });
  console.log(`[res-seed] purgadas ${existing.length} reservas previas.`);
}

async function seedForHotel(propertyId: string, count: number, today: Date) {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property) {
    console.warn(`[res-seed] ⚠️ ${propertyId} no existe, salto.`);
    return { created: 0, guests: 0 };
  }
  const roomTypes = await prisma.roomType.findMany({ where: { propertyId } });
  const ratePlans = await prisma.ratePlan.findMany({ where: { propertyId } });
  const rooms = await prisma.room.findMany({ where: { propertyId } });
  if (roomTypes.length === 0 || ratePlans.length === 0) {
    console.warn(`[res-seed] ⚠️ ${propertyId} sin room types / rate plans, salto.`);
    return { created: 0, guests: 0 };
  }

  let createdReservations = 0;
  let createdGuests = 0;

  for (let i = 0; i < count; i++) {
    const plan = planReservation(today);
    const rt = pick(roomTypes);
    const rp = pick(ratePlans);
    const channel = pickWeighted(CHANNELS).code;
    const purpose = pick(PURPOSES);
    const board = pick(BOARDS);
    const nights = Math.max(1, Math.round((plan.departure.getTime() - plan.arrival.getTime()) / 86400000));
    const adults = randInt(1, 2);
    const children = rand() < 0.18 ? randInt(1, 2) : 0;
    const basePrice = ADR_BY_HOTEL[propertyId] ?? 150;
    // Aplicar variación: ±15% según canal + 10% extra fin de semana + ruido aleatorio
    // por room type (algunos cuartos son más caros que el ADR base).
    const dayOfWeek = plan.arrival.getUTCDay();
    const weekendMultiplier = dayOfWeek === 5 || dayOfWeek === 6 ? 1.1 : 1;
    const channelMultiplier = channel === "direct" ? 1 : channel === "booking.com" ? 0.98 : 0.92;
    const roomTypeMultiplier = 0.85 + rand() * 0.4; // 0.85–1.25
    const adr = Math.round(basePrice * weekendMultiplier * channelMultiplier * roomTypeMultiplier * 100) / 100;
    const totalRoom = adr * nights;
    // Tasa turística (sólo si CCAA aplica)
    const ccaa = CCAA_BY_HOTEL[propertyId];
    const taxConfig = TOURIST_TAX_BY_CCAA[ccaa];
    const taxableNights = taxConfig ? Math.min(nights, 7) : 0; // CAT cap 7 noches
    const taxAmount = taxConfig ? taxConfig.perNight * adults * taxableNights : 0;
    const total = Math.round((totalRoom + taxAmount) * 100) / 100;

    const code = `${SEED_PREFIX}-${propertyId.slice(11, 14).toUpperCase()}-${String(i + 1).padStart(4, "0")}`;

    // Crear reserva
    const reservation = await prisma.reservation.create({
      data: {
        propertyId,
        code,
        channel,
        status: plan.status,
        arrivalDate: plan.arrival,
        departureDate: plan.departure,
        adults,
        children,
        roomsCount: 1,
        roomTypeId: rt.id,
        ratePlanId: rp.id,
        boardType: board,
        marketSegment: purpose === "business" ? "corporate" : purpose === "group" ? "group" : "transient",
        sourceCode: channel.toUpperCase(),
        purposeOfStay: purpose,
        guaranteeType: rand() < 0.6 ? "credit_card" : "deposit",
        cancellationPolicyCode: rand() < 0.7 ? `${propertyId}_std` : rand() < 0.5 ? `${propertyId}_flex` : `${propertyId}_nrf`,
        externalReference: channel === "booking.com" ? `BDC-${randInt(1000000, 9999999)}` : channel === "expedia" ? `EXP-${randInt(100000, 999999)}` : null,
        totalAmount: total,
        currency: "EUR"
      }
    });
    createdReservations++;

    // Guest principal
    const primaryGuestData = generateGuest(propertyId === "prop_iberia_marbella" || propertyId === "prop_iberia_mallorca" ? 0.45 : 0.78);
    const primaryGuest = await prisma.guest.create({
      data: { organizationId: ORG_ID, ...primaryGuestData }
    });
    createdGuests++;
    await prisma.reservationGuest.create({
      data: { reservationId: reservation.id, guestId: primaryGuest.id, isPrimary: true, relationshipType: "self" }
    });

    // Acompañante (50% probabilidad si adultos == 2)
    if (adults === 2 && rand() < 0.7) {
      const companionData = generateGuest(0.65);
      const companion = await prisma.guest.create({ data: { organizationId: ORG_ID, ...companionData } });
      createdGuests++;
      await prisma.reservationGuest.create({
        data: { reservationId: reservation.id, guestId: companion.id, isPrimary: false, relationshipType: "spouse" }
      });
    }

    // Asignar room + crear Stay (solo si checked_in / checked_out / no_show)
    if (plan.status === "checked_in" || plan.status === "checked_out" || plan.status === "no_show") {
      const candidateRooms = rooms.filter((r) => r.roomTypeId === rt.id);
      if (candidateRooms.length > 0) {
        const room = pick(candidateRooms);
        // assignedRoomId en la reserva → la Live Timeline pinta el bloque en la
        // fila de la habitación. Sin esto, todo va a "Sin asignar".
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: { assignedRoomId: room.id }
        });
        if (plan.status !== "no_show") {
          await prisma.stay.create({
            data: {
              reservationId: reservation.id,
              roomId: room.id,
              checkinAt: new Date(plan.arrival.getTime() + 16 * 3600 * 1000), // 16:00 check-in
              checkoutAt: plan.status === "checked_out" ? new Date(plan.departure.getTime() + 11 * 3600 * 1000) : null,
              status: plan.status === "checked_in" ? "in_house" : "checked_out"
            }
          });
        }
      }
    }
    // Pre-asignar ~30% de las reservas 'confirmed' (algunas cadenas pre-asignan).
    if (plan.status === "confirmed" && rand() < 0.3) {
      const candidateRooms = rooms.filter((r) => r.roomTypeId === rt.id);
      if (candidateRooms.length > 0) {
        const room = pick(candidateRooms);
        await prisma.reservation.update({ where: { id: reservation.id }, data: { assignedRoomId: room.id } });
      }
    }

    // Folio (sólo para confirmed/checked_in/checked_out)
    if (plan.status === "confirmed" || plan.status === "checked_in" || plan.status === "checked_out") {
      const folio = await prisma.folio.create({
        data: {
          reservationId: reservation.id,
          guestId: primaryGuest.id,
          status: plan.status === "checked_out" ? "closed" : "open",
          currency: "EUR",
          label: "guest",
          isPrimary: true
        }
      });
      // Línea de habitación (1 por noche, simplificado a una sola línea agregada)
      await prisma.folioLine.create({
        data: {
          folioId: folio.id,
          type: "room",
          description: `Alojamiento ${rt.name} · ${nights} noches`,
          quantity: nights,
          unitPrice: adr,
          taxCode: "IVA_10",
          total: totalRoom,
          postedAt: plan.arrival
        }
      });
      // Tasa turística
      if (taxAmount > 0 && taxConfig) {
        await prisma.folioLine.create({
          data: {
            folioId: folio.id,
            type: "tourist_tax",
            description: `Tasa turística ${ccaa} · ${adults} adultos × ${taxableNights} noches`,
            quantity: adults * taxableNights,
            unitPrice: taxConfig.perNight,
            taxCode: "EXENTO",
            total: Math.round(taxAmount * 100) / 100,
            postedAt: plan.arrival
          }
        });
      }
      // F&B charge ocasional (~20% reservas con HB/AI o estancia > 3 noches)
      if ((board === "HB" || board === "AI" || nights > 3) && rand() < 0.35) {
        const fbAmount = Math.round(randInt(15, 80) * (1 + rand()) * 100) / 100;
        await prisma.folioLine.create({
          data: {
            folioId: folio.id,
            type: "fb",
            description: pick(["Cena restaurante", "Bar bebidas", "Room service", "Desayuno extra"]),
            quantity: 1,
            unitPrice: fbAmount,
            taxCode: "IVA_10",
            total: fbAmount,
            postedAt: addDays(plan.arrival, randInt(0, Math.max(1, nights - 1)))
          }
        });
      }
      // Pago — capturado al check-out, autorizado al confirmar (deposit).
      if (plan.status === "checked_out") {
        await prisma.payment.create({
          data: {
            propertyId,
            folioId: folio.id,
            amount: total,
            currency: "EUR",
            method: pick(["card", "card", "card", "cash", "transfer"]),
            pspReference: `PSP-${randInt(10000000, 99999999)}`,
            status: "captured"
          }
        });
      } else if (plan.status === "confirmed" || plan.status === "checked_in") {
        // Depósito 30% al confirmar
        const deposit = Math.round(total * 0.3 * 100) / 100;
        await prisma.payment.create({
          data: {
            propertyId,
            folioId: folio.id,
            amount: deposit,
            currency: "EUR",
            method: "card",
            pspReference: `PSP-${randInt(10000000, 99999999)}`,
            status: "captured"
          }
        });
      }
    }
  }

  return { created: createdReservations, guests: createdGuests };
}

async function run() {
  seedPrng(0xABCDEF42);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  console.log(`[res-seed] starting · ref date = ${today.toISOString().slice(0, 10)}`);

  await clearPreviousSeed();

  let totalRes = 0;
  let totalGuests = 0;
  for (const [propertyId, count] of Object.entries(RESERVATIONS_PER_HOTEL)) {
    const r = await seedForHotel(propertyId, count, today);
    totalRes += r.created;
    totalGuests += r.guests;
    console.log(`[res-seed] ✓ ${propertyId} · ${r.created} reservas · ${r.guests} huéspedes`);
  }
  console.log(`[res-seed] done · ${totalRes} reservas · ${totalGuests} huéspedes · 8 propiedades`);
  await prisma.$disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });

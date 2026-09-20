/**
 * Tanda CHK · lote W5-B — walkthrough del seed del check-in automatizado
 * (docs/design/CHECKIN-AUTOMATIZADO-IA.md §10.1) — integración sobre Postgres real
 * que EJECUTA `packages/database/prisma/seed-checkin.ts --reset` sobre el tenant de
 * prueba real `org_chk` / `prop_chk` (no sobre una organización aislada: el seed es
 * el objeto de la prueba y su guard solo admite la allowlist demo) y lo comprueba
 * por API con los usuarios `*@chk.test` bajo STRICT_ENV (auth real, RBAC_STRICT).
 *
 * Qué fija (en orden):
 *   · el seed termina con salida 0, imprime las MRZ sintéticas como fixture y
 *     todas son válidas para parseMrz (checksums del propio parser, §10.1); las
 *     líneas NO están en la BD (solo el número y el soporte del documento);
 *   · 10 reservas CHK-* (+ la estancia previa CHK-07P), 9 sesiones por estado
 *     (2 invited · 2 in_progress · 3 ready_for_arrival · 1 checked_in · 1
 *     handed_off identity_review), ninguna sin CheckInGuest, 3 sugerencias
 *     `suggested` (la del VIP con empate → confianza 0), 8 capturas sin imagen ni
 *     PII en fieldsJson, 4 firmas con PDF, política, kiosco online, bloqueo y
 *     comunicadas;
 *   · GET /properties/prop_chk/check-in/arrivals (recepción) con preCheckIn por
 *     llegada de hoy, sugerencia en las ready_for_arrival y llave en la alojada;
 *   · cola de Mi día: `buildFrontDeskQueue` al mediodía del día sembrado →
 *     precheckin_ready ≥ 3 e identity_review 1 (determinista); por API,
 *     GET /dashboards/front-desk-queue aplica la regla horaria de W3-D (tras las
 *     19:00 UTC las llegadas de hoy salen como no_show_risk y ocultan
 *     precheckin_ready) y el día UTC (entre las 22:00 y las 24:00 UTC el «hoy»
 *     de Madrid ya es mañana para la cola), que la prueba reproduce en vez de
 *     omitirse;
 *   · sesión handed_off por API sin PII, política con textos «(texto
 *     provisional)», kiosco chk_kiosk_01 online sin hashes en el DTO (dirección),
 *     bloqueo de la 401 mañana y comunicadas 201-202;
 *   · el token del asistente que imprime el seed abre GET /guest-portal/check-in
 *     (R18) de la sesión invitada de CHK-03;
 *   · segunda ejecución SIN --reset: idempotente (sesiones existentes=9, nada
 *     nuevo);
 *   · invariantes de Faranda idénticas antes y después.
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/checkin-seed-walkthrough.test.mts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const { loginOrThrow, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma } = await import("@hotelos/database");
const { parseMrz } = await import("@hotelos/compliance");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { buildFrontDeskQueue } = await import("../../apps/api/src/modules/dashboards/front-desk-queue.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Reply = { status: number; body: any; raw: string };

const ORG_ID = "org_chk";
const PROPERTY_ID = "prop_chk";
const EMAIL_DOMAIN = "chk.test";
/** Misma regla que DEMO_PASSWORD del seed. */
const PASSWORD = process.env.SEED_CHK_PASSWORD?.trim() || "chk-demo";
const SEED_PATH = fileURLToPath(new URL("../../packages/database/prisma/seed-checkin.ts", import.meta.url));
const SEED_CWD = fileURLToPath(new URL("../../packages/database/", import.meta.url));
/** Huésped: rutas públicas sin JWT; NODE_ENV≠production para que el token del asistente valga como en el seed. */
const GUEST_ENV: Record<string, string | undefined> = { ...STRICT_ENV, NODE_ENV: "development", HOTELOS_ALLOW_DEMO_AUTH: "true" };

const EXPECTED_SESSIONS: Record<string, string> = {
  chk_res_09: "invited",
  chk_res_03: "invited",
  chk_res_01: "in_progress",
  chk_res_02: "in_progress",
  chk_res_04: "ready_for_arrival",
  chk_res_05: "ready_for_arrival",
  chk_res_06: "ready_for_arrival",
  chk_res_10: "checked_in",
  chk_res_08: "handed_off"
};

type SeedRun = {
  stdout: string;
  today: string;
  /** CHK-xx → líneas MRZ impresas (fixture). */
  fixtures: Array<{ code: string; guestId: string; lines: string[] }>;
  /** chk_res_xx → URL del asistente (token en claro, solo demo local). */
  checkInUrls: Map<string, string>;
  created: number;
  existing: number;
};

function runSeed(args: string[]): SeedRun {
  const stdout = execFileSync(process.execPath, ["--import", "tsx", SEED_PATH, ...args], {
    cwd: SEED_CWD,
    env: { ...process.env, GUEST_WEB_BASE_URL: "http://127.0.0.1:5189" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 240_000
  });
  const today = /hoy \(Europe\/Madrid\) = (\d{4}-\d{2}-\d{2})/.exec(stdout)?.[1] ?? "";
  const fixtures = [...stdout.matchAll(/^ {2}(CHK-\w+) +(chk_guest_\w+) +([A-Z0-9<]{30}) · ([A-Z0-9<]{30}) · ([A-Z0-9<]{30})( \(sin documento en el perfil[^)]*\))?$/gm)].map((m) => ({ code: m[1]!, guestId: m[2]!, lines: [m[3]!, m[4]!, m[5]!] }));
  const checkInUrls = new Map<string, string>();
  let current = "";
  for (const line of stdout.split("\n")) {
    const scenario = /^ {2}(CHK-\d{2}) +[a-z_]+ +(created|existing|skipped)/.exec(line);
    if (scenario) current = `chk_res_${scenario[1]!.slice(4)}`;
    const url = /^ {10}asistente: (\S+)$/.exec(line);
    if (url && current) checkInUrls.set(current, url[1]!);
  }
  const counts = /sesiones creadas=(\d+) existentes=(\d+) omitidas=(\d+)/.exec(stdout);
  return { stdout, today, fixtures, checkInUrls, created: Number(counts?.[1] ?? -1), existing: Number(counts?.[2] ?? -1) };
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get("token") ?? "";
}

let app: ApiApp;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let seed: SeedRun;
let receptionist: Session;
let director: Session;

async function call(method: Method, url: string, options: { payload?: unknown; headers?: Record<string, string>; env?: Record<string, string | undefined> } = {}): Promise<Reply> {
  const res = await withEnv(options.env ?? STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: options.headers ?? {},
      ...(options.payload !== undefined ? { payload: options.payload } : {})
    })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body };
}

/**
 * Corrector CHK (REV3-03): esta suite EJECUTA el seed (--reset) contra la BD de
 * DATABASE_URL y deja el tenant org_chk (usuarios *@chk.test, contraseña
 * conocida). Solo corre contra una BD de carril (nombre terminado en `_chk`) o
 * con CHK_WALKTHROUGH=1 explícito; en la BD principal (`hotelos`, la que sirve
 * :3000) se salta con motivo, para que `test:integration` en main no siembre
 * un tenant de demo con contraseña conocida.
 */
export function walkthroughSkipReason(env: { DATABASE_URL?: string; CHK_WALKTHROUGH?: string }): string | false {
  if (env.CHK_WALKTHROUGH === "1") return false;
  let database = "";
  try {
    database = new URL(env.DATABASE_URL ?? "").pathname.replace(/^\//, "").split("?")[0] ?? "";
  } catch {
    database = "";
  }
  if (/_chk$/.test(database)) return false;
  return `walkthrough del seed omitido: DATABASE_URL apunta a «${database || "?"}» (no termina en _chk); el seed dejaría org_chk sembrado. Usa la BD del carril o CHK_WALKTHROUGH=1.`;
}

const WALKTHROUGH_SKIP = walkthroughSkipReason(process.env);
if (WALKTHROUGH_SKIP) console.warn(`[checkin-seed-walkthrough] ${WALKTHROUGH_SKIP}`);

before(async () => {
  if (WALKTHROUGH_SKIP) return;
  invariantsBefore = await farandaInvariants();
  // El seed SIEMPRE con el API parado: se ejecuta antes de construir la app (la cadena de auditoría se hidrata en cada proceso).
  seed = runSeed(["--reset"]);
  assert.match(seed.today, /^\d{4}-\d{2}-\d{2}$/, "el seed imprime el día sembrado");
  resetRbacScopeCacheForTests();
  app = await buildApiServer();
  await app.ready();
  receptionist = await loginOrThrow(app, `recepcion@${EMAIL_DOMAIN}`, PASSWORD);
  director = await loginOrThrow(app, `direccion@${EMAIL_DOMAIN}`, PASSWORD);
});

after(async () => {
  if (WALKTHROUGH_SKIP) {
    await prisma.$disconnect();
    return;
  }
  await flushAuditQueues();
  await app?.close();
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "invariantes de Faranda intactas");
  await prisma.$disconnect();
});

describe("W5-B · el seed rearma org_chk / prop_chk", { skip: WALKTHROUGH_SKIP }, () => {
  it("imprime 9 sesiones creadas, la política, el kiosco online, el bloqueo y las comunicadas", () => {
    assert.equal(seed.created, 9, seed.stdout.slice(-1500));
    assert.equal(seed.existing, 0);
    assert.match(seed.stdout, /kiosco chk_kiosk_01 online/);
    assert.match(seed.stdout, /bloqueo 401 mañana created/);
    assert.match(seed.stdout, /comunicadas 201-202 (created|existing)/);
    assert.match(seed.stdout, /política (created|updated|unchanged)/);
    assert.equal(seed.checkInUrls.size, 8, "un enlace del asistente por sesión invitada (todas menos la alojada)");
  });

  it("las MRZ sintéticas impresas son válidas para parseMrz y no se guardan: en la BD solo el número y el soporte", async () => {
    assert.ok(seed.fixtures.length >= 10, `fixtures MRZ impresas: ${seed.fixtures.length}`);
    const today = new Date(`${seed.today}T12:00:00.000Z`);
    for (const fixture of seed.fixtures) {
      const parsed = parseMrz(fixture.lines, { today });
      assert.equal(parsed.valid, true, `${fixture.code} ${fixture.guestId}: ${parsed.errors.join(" | ")}`);
      assert.equal(parsed.format, "TD1");
      assert.equal(parsed.fields?.documentType, "DNI");
      const profile = await prisma.guest.findUniqueOrThrow({ where: { id: fixture.guestId }, select: { documentNumber: true, documentSupportNumber: true, firstName: true, surname1: true } });
      if (fixture.guestId === "chk_guest_03") {
        // Titular del walkthrough: sin documento en el perfil; la MRZ impresa es la que se teclea en el asistente.
        assert.equal(profile.documentNumber, null, "CHK-03 sin documento en el perfil");
        assert.match(parsed.fields?.documentNumber ?? "", /^CHK\d{6}$/);
      } else {
        assert.equal(parsed.fields?.documentNumber, profile.documentNumber, "número del documento = perfil");
        assert.equal(parsed.fields?.documentSupportNumber, profile.documentSupportNumber, "soporte = perfil");
      }
      assert.equal(parsed.fields?.firstName, profile.firstName.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase());
    }
    assert.ok(seed.fixtures.some((f) => f.guestId === "chk_guest_03"), "la MRZ del titular de CHK-03 se imprime aunque no esté en el perfil");
    // Ninguna columna de la capa del check-in contiene una línea MRZ (fieldsJson sin PII, W2-B).
    const captures = await prisma.documentCapture.findMany({ where: { propertyId: PROPERTY_ID } });
    assert.equal(captures.length, 8, "CHK-01 ×2, CHK-02, CHK-04, CHK-05, CHK-06 ×2 y la discrepante de CHK-08");
    for (const capture of captures) {
      const json = JSON.stringify(capture.fieldsJson) + JSON.stringify(capture.confidenceJson) + JSON.stringify(capture.checksJson);
      for (const fixture of seed.fixtures) for (const line of fixture.lines) assert.ok(!json.includes(line), `línea MRZ persistida en document_captures ${capture.id}`);
      assert.equal(capture.imageStored, false);
      assert.equal(capture.source, "mrz_reader");
      assert.equal(capture.mrzFormat, "TD1");
      const fields = capture.fieldsJson as Record<string, unknown>;
      assert.ok(!("documentNumber" in fields) && !("firstName" in fields) && !("surname1" in fields), `fieldsJson con PII: ${Object.keys(fields).join(",")}`);
      assert.deepEqual(capture.checksJson, { document: true, birth: true, expiry: true, composite: true });
    }
    const mismatch = captures.filter((capture) => (capture.needsReviewJson as string[]).includes("identity_mismatch"));
    assert.equal(mismatch.length, 1, "solo la captura de CHK-08 lleva identity_mismatch");
    // El viajero de CHK-01 lleva el número del documento (cifrado en la fila, descifrado por la extensión) igual que su MRZ.
    const session01 = await prisma.checkInSession.findUniqueOrThrow({ where: { reservationId: "chk_res_01" }, select: { id: true } });
    const primary01 = await prisma.checkInGuest.findFirstOrThrow({ where: { sessionId: session01.id, isPrimary: true }, select: { documentNumber: true, documentSupportNumber: true, identityVerificationMethod: true, identityVerifiedAt: true, status: true } });
    const fixture01 = seed.fixtures.find((f) => f.code === "CHK-01" && f.guestId === "chk_guest_01");
    assert.ok(fixture01, "fixture de CHK-01");
    assert.equal(primary01.documentNumber, parseMrz(fixture01.lines, { today }).fields?.documentNumber);
    assert.equal(primary01.identityVerificationMethod, "mrz_checksum", "el checksum no verifica a la persona: sin identityVerifiedAt");
    assert.equal(primary01.identityVerifiedAt, null);
  });

  it("10 reservas CHK-* (+ CHK-07P), 9 sesiones por estado sin ninguna sin viajero, 3 sugerencias y 4 firmas con PDF", async () => {
    const reservations = await prisma.reservation.findMany({ where: { propertyId: PROPERTY_ID, code: { startsWith: "CHK-" } }, select: { id: true, code: true, status: true, arrivalDate: true, assignedRoomId: true } });
    assert.equal(reservations.filter((r) => r.code !== "CHK-07P").length, 10);
    assert.equal(reservations.length, 11, "las 10 de §10.1 + la estancia previa CHK-07P");
    const today = new Date(`${seed.today}T00:00:00.000Z`).getTime();
    const arrivingToday = reservations.filter((r) => r.arrivalDate.getTime() === today).map((r) => r.code).sort();
    assert.deepEqual(arrivingToday, ["CHK-01", "CHK-03", "CHK-04", "CHK-05", "CHK-06", "CHK-08"], "el grupo, el VIP y la accesible llegan hoy");
    assert.ok(reservations.filter((r) => r.status === "confirmed" && r.assignedRoomId === null).length >= 8, "las llegadas nacen sin habitación");

    const sessions = await prisma.checkInSession.findMany({ where: { propertyId: PROPERTY_ID }, include: { guests: { select: { id: true, status: true, isPrimary: true } } } });
    assert.equal(sessions.length, 9);
    const byReservation = Object.fromEntries(sessions.map((s) => [s.reservationId, s.status]));
    assert.deepEqual(byReservation, EXPECTED_SESSIONS);
    for (const session of sessions) {
      assert.ok(session.guests.length >= 1, `sesión ${session.reservationId} sin CheckInGuest`);
      assert.equal(session.guests.filter((g) => g.isPrimary).length, 1, `sesión ${session.reservationId} con un solo titular`);
    }
    const handedOff = sessions.find((s) => s.reservationId === "chk_res_08")!;
    assert.equal(handedOff.handoffKind, "identity_review");
    assert.ok(handedOff.handoffReason, "motivo del handoff");
    const checkedIn = sessions.find((s) => s.reservationId === "chk_res_10")!;
    assert.equal(checkedIn.channel, "reception");
    assert.ok(checkedIn.checkedInAt && checkedIn.arrivedAt, "la alojada lleva arrivedAt/checkedInAt");
    assert.equal(checkedIn.guests[0]!.status, "verified");
    for (const key of ["chk_res_04", "chk_res_05", "chk_res_06"]) {
      const ready = sessions.find((s) => s.reservationId === key)!;
      assert.ok(ready.completedAt, `${key} completedAt`);
      assert.ok(ready.guests.every((g) => g.status === "signed"), `${key} viajeros firmados: ${ready.guests.map((g) => g.status).join(",")}`);
    }
    assert.equal(sessions.find((s) => s.reservationId === "chk_res_06")!.guests.length, 2, "CHK-06: titular + acompañante");
    assert.equal(sessions.find((s) => s.reservationId === "chk_res_02")!.guests.length, 2, "CHK-02: adulto + menor");
    assert.equal((await prisma.checkInGuest.count({ where: { propertyId: PROPERTY_ID, isMinor: true } })), 1, "un menor (CHK-02)");

    const suggestions = await prisma.assignmentSuggestion.findMany({ where: { propertyId: PROPERTY_ID }, orderBy: { reservationId: "asc" } });
    assert.deepEqual(suggestions.map((s) => [s.reservationId, s.status, s.sessionId !== null]), [["chk_res_04", "suggested", true], ["chk_res_05", "suggested", true], ["chk_res_06", "suggested", true]]);
    const vip = suggestions.find((s) => s.reservationId === "chk_res_06")!;
    assert.equal(Number(vip.confidence), 0, "VIP con empate → confianza 0");
    assert.ok((vip.candidatesJson as Array<{ warnings?: string[] }>).some((c) => (c.warnings ?? []).some((w) => /Empate/.test(w))), "aviso de empate en las candidatas");
    assert.ok(suggestions.filter((s) => Number(s.confidence) > 0).length >= 1, "alguna sugerencia del grupo con confianza > 0");

    const signatures = await prisma.signature.findMany({ where: { propertyId: PROPERTY_ID } });
    assert.equal(signatures.length, 4, "CHK-04, CHK-05 y los dos de CHK-06");
    for (const signature of signatures) {
      assert.equal(signature.method, "touch_portal");
      assert.ok(signature.pdfSha256 && signature.pdfObjectKey, "PDF del parte");
      assert.ok(signature.checkInGuestId, "vinculada al viajero");
    }
    assert.equal(await prisma.guestRegisterRecord.count({ where: { propertyId: PROPERTY_ID, signatureObjectKey: { not: null } } }), 4, "partes firmados");
    assert.equal(await prisma.guestPortalAction.count({ where: { propertyId: PROPERTY_ID, actionType: "mobile_key", status: "active", reservationId: "chk_res_10" } }), 1, "llave QR de la alojada");
    assert.equal(await prisma.notificationDelivery.count({ where: { propertyId: PROPERTY_ID, templateCode: "checkin_invitation" } }), 8, "una invitación (simulada) por sesión invitada");
  });
});

describe("W5-B · por API con los usuarios @chk.test", { skip: WALKTHROUGH_SKIP }, () => {
  it("GET /properties/prop_chk/check-in/arrivals (recepción): preCheckIn por llegada, sugerencia en las listas y llave en la alojada", async () => {
    const res = await call("GET", `/properties/${PROPERTY_ID}/check-in/arrivals?date=${seed.today}`, { headers: receptionist.headers });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    const items = res.body.items as Array<Record<string, any>>;
    const byCode = Object.fromEntries(items.map((item) => [item.code, item]));
    assert.deepEqual(Object.keys(byCode).sort(), ["CHK-01", "CHK-03", "CHK-04", "CHK-05", "CHK-06", "CHK-08"]);
    assert.equal(byCode["CHK-01"].preCheckIn.status, "in_progress");
    assert.equal(byCode["CHK-01"].preCheckIn.etaDeclared, "16:30");
    assert.equal(byCode["CHK-01"].eta, "16:30", "la ETA declarada se escribe en la reserva");
    assert.equal(byCode["CHK-03"].preCheckIn.status, "invited");
    assert.equal(byCode["CHK-08"].preCheckIn.status, "handed_off");
    for (const code of ["CHK-04", "CHK-05", "CHK-06"]) {
      assert.equal(byCode[code].preCheckIn.status, "ready_for_arrival", code);
      assert.equal(byCode[code].preCheckIn.completedGuests, byCode[code].preCheckIn.totalGuests, `${code} viajeros completos`);
      assert.ok(byCode[code].suggestion && byCode[code].suggestion.status === "suggested" && byCode[code].suggestion.topRoomNumber, `${code} con sugerencia`);
      assert.equal(byCode[code].assignedRoomId, null);
    }
    assert.equal(byCode["CHK-06"].suggestion.confidence, 0);
    for (const item of items) assert.ok(!("documentNumber" in item) && (!item.primaryGuest || !("email" in item.primaryGuest)), "sin PII en las llegadas");
    // La alojada llegó ayer: su fila de ayer lleva la llave.
    const yesterday = new Date(`${seed.today}T00:00:00.000Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const prior = await call("GET", `/properties/${PROPERTY_ID}/check-in/arrivals?date=${yesterday.toISOString().slice(0, 10)}`, { headers: receptionist.headers });
    assert.equal(prior.status, 200);
    const inHouse = (prior.body.items as Array<Record<string, any>>).find((item) => item.code === "CHK-10");
    assert.ok(inHouse, "CHK-10 en las llegadas de ayer");
    assert.equal(inHouse.status, "checked_in");
    assert.equal(inHouse.preCheckIn.status, "checked_in");
    assert.ok(inHouse.key?.serialNumber, "llave QR activa");
  });

  it("cola de Mi día: precheckin_ready ≥ 3 e identity_review 1 (determinista al mediodía del día sembrado; por API con la regla horaria de W3-D)", async () => {
    const noon = new Date(`${seed.today}T12:00:00.000Z`);
    const queue = await buildFrontDeskQueue({ propertyId: PROPERTY_ID, now: noon });
    assert.ok(queue.counts.precheckin_ready >= 3, `precheckin_ready=${queue.counts.precheckin_ready}`);
    assert.equal(queue.counts.identity_review, 1);
    const ready = queue.items.filter((item) => item.kind === "precheckin_ready").map((item) => item.reservationId).sort();
    assert.deepEqual(ready, ["chk_res_04", "chk_res_05", "chk_res_06"]);
    const review = queue.items.find((item) => item.kind === "identity_review")!;
    assert.equal(review.reservationId, "chk_res_08");
    assert.equal(review.primaryAction?.kind, "open_precheckin");
    assert.ok(queue.items.every((item) => !/CHK\d{6}/.test(item.title + item.context)), "sin números de documento en la cola");
    assert.deepEqual(queue.degraded, []);

    const res = await call("GET", `/dashboards/front-desk-queue?propertyId=${PROPERTY_ID}`, { headers: receptionist.headers });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    const now = new Date();
    const utcDay = now.toISOString().slice(0, 10);
    if (utcDay !== seed.today) {
      // 22:00-24:00 UTC: para la cola (día UTC) las llegadas de «hoy» (Madrid) son de mañana → assignment_suggested, nunca precheckin_ready.
      assert.equal(res.body.counts.precheckin_ready, 0, "día UTC ≠ día sembrado");
      assert.ok(res.body.counts.assignment_suggested >= 3, `assignment_suggested=${res.body.counts.assignment_suggested}`);
    } else if (now.getUTCHours() >= 19) {
      // Regla de W3-D: tras las 19:00 UTC las llegadas confirmadas salen como no_show_risk y ocultan precheckin_ready.
      assert.equal(res.body.counts.precheckin_ready, 0);
      assert.ok(res.body.counts.no_show_risk >= 3, `no_show_risk=${res.body.counts.no_show_risk}`);
      assert.equal(res.body.counts.identity_review, 1, "el handoff no depende de la hora");
    } else {
      assert.ok(res.body.counts.precheckin_ready >= 3, `precheckin_ready=${res.body.counts.precheckin_ready}`);
      assert.equal(res.body.counts.identity_review, 1);
    }
  });

  it("sesión handed_off por API sin PII; política con textos provisionales; kiosco online sin hashes; bloqueo y comunicadas", async () => {
    const session = await prisma.checkInSession.findUniqueOrThrow({ where: { reservationId: "chk_res_08" }, select: { id: true } });
    const view = await call("GET", `/properties/${PROPERTY_ID}/check-in/sessions/${session.id}`, { headers: receptionist.headers });
    assert.equal(view.status, 200, view.raw.slice(0, 300));
    assert.equal(view.body.status, "handed_off");
    assert.equal(view.body.handoffKind, "identity_review");
    assert.equal(view.body.guests.length, 1);
    assert.ok(!("documentNumber" in view.body.guests[0]) && !("email" in view.body.guests[0]), "el DTO del viajero no lleva PII");
    assert.equal(view.body.policy.selfCheckInEnabled, true);

    const policy = await call("GET", `/properties/${PROPERTY_ID}/check-in/policy`, { headers: receptionist.headers });
    assert.equal(policy.status, 200, policy.raw.slice(0, 300));
    assert.equal(policy.body.selfCheckInEnabled, true);
    assert.equal(policy.body.depositPolicy, "balance");
    assert.deepEqual([...policy.body.allowedVerificationMethods].sort(), ["mrz_checksum", "otp_email", "visual_reception"]);
    assert.equal(policy.body.requireVisualCheckAtKiosk, false, "kiosco de demo sin lector: la MRZ válida entrega la llave (decisión de demo)");
    assert.match(policy.body.guestConsentText, /\(texto provisional\)$/);
    assert.match(policy.body.aiDisclosureText, /\(texto provisional\)$/);

    const kiosks = await call("GET", `/properties/${PROPERTY_ID}/kiosks`, { headers: director.headers });
    assert.equal(kiosks.status, 200, kiosks.raw.slice(0, 300));
    assert.equal(kiosks.body.length, 1, "solo el kiosco del seed tras --reset");
    const kiosk = kiosks.body[0];
    assert.equal(kiosk.id, "chk_kiosk_01");
    assert.equal(kiosk.status, "online");
    assert.equal(kiosk.paired, true);
    assert.deepEqual(kiosk.capabilities, { mrzReader: false, cardEncoder: false, paymentTerminal: false, printer: false });
    assert.ok(!("pairingCodeHash" in kiosk) && !("deviceTokenHash" in kiosk), "sin hashes en el DTO");
    const kioskDenied = await call("GET", `/properties/${PROPERTY_ID}/kiosks`, { headers: receptionist.headers });
    assert.equal(kioskDenied.status, 403, "recepción no configura kioscos (kiosk.configure)");

    const tomorrow = new Date(`${seed.today}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const blocks = await call("GET", `/properties/${PROPERTY_ID}/room-blocks?from=${tomorrow.toISOString().slice(0, 10)}&to=${tomorrow.toISOString().slice(0, 10)}`, { headers: receptionist.headers });
    assert.equal(blocks.status, 200, blocks.raw.slice(0, 300));
    const blockItems = (Array.isArray(blocks.body) ? blocks.body : blocks.body.items) as Array<Record<string, any>>;
    assert.equal(blockItems.length, 1);
    assert.equal(blockItems[0]!.roomId, "chk_room_401");
    assert.equal(blockItems[0]!.reason, "deep_clean");
    const connections = await call("GET", `/properties/${PROPERTY_ID}/room-connections`, { headers: receptionist.headers });
    assert.equal(connections.status, 200, connections.raw.slice(0, 300));
    const connectionItems = (Array.isArray(connections.body) ? connections.body : connections.body.items) as Array<Record<string, any>>;
    assert.equal(connectionItems.length, 1);
    assert.deepEqual([connectionItems[0]!.roomAId, connectionItems[0]!.roomBId].sort(), ["chk_room_201", "chk_room_202"]);
    assert.equal(connectionItems[0]!.kind, "connecting");
  });

  it("el token del asistente impreso por el seed abre la sesión invitada de CHK-03 (GET /guest-portal/check-in)", async () => {
    const url = seed.checkInUrls.get("chk_res_03");
    assert.ok(url, "enlace del asistente de CHK-03");
    const token = tokenOf(url);
    assert.equal(token.length, 64, "token opaco de 32 bytes en hex");
    const res = await call("GET", "/guest-portal/check-in", { headers: { "x-guest-token": token }, env: GUEST_ENV });
    assert.equal(res.status, 200, res.raw.slice(0, 300));
    assert.equal(res.body.status, "invited");
    assert.equal(res.body.reservationId, "chk_res_03");
    assert.equal(res.body.guests.length, 1);
    assert.equal(res.body.guests[0].status, "pending", "el titular de CHK-03 llega sin documento: lo lee en el asistente");
    assert.equal(res.body.guests[0].documentNumberLast3, null);
    assert.ok(!("documentNumber" in res.body.guests[0]) && !("email" in res.body.guests[0]), "sin PII en el DTO del huésped");
    const none = await call("GET", "/guest-portal/check-in", { env: GUEST_ENV });
    assert.equal(none.status, 401, "sin token 401 (R18)");
  });

  it("segunda ejecución sin --reset: idempotente (9 sesiones existentes, nada nuevo)", async () => {
    const before = {
      sessions: await prisma.checkInSession.count({ where: { propertyId: PROPERTY_ID } }),
      captures: await prisma.documentCapture.count({ where: { propertyId: PROPERTY_ID } }),
      signatures: await prisma.signature.count({ where: { propertyId: PROPERTY_ID } }),
      suggestions: await prisma.assignmentSuggestion.count({ where: { propertyId: PROPERTY_ID } }),
      blocks: await prisma.roomBlock.count({ where: { propertyId: PROPERTY_ID } }),
      kiosks: await prisma.kioskDevice.count({ where: { propertyId: PROPERTY_ID } }),
      deliveries: await prisma.notificationDelivery.count({ where: { propertyId: PROPERTY_ID } })
    };
    const again = runSeed([]);
    assert.equal(again.created, 0, again.stdout.slice(-800));
    assert.equal(again.existing, 9);
    assert.match(again.stdout, /política unchanged/);
    assert.match(again.stdout, /kiosco chk_kiosk_01 online \(ya emparejado\)/);
    assert.match(again.stdout, /bloqueo 401 mañana existing/);
    assert.match(again.stdout, /comunicadas 201-202 existing/);
    assert.match(again.stdout, /reservas nuevas=0 existentes=11/);
    const after = {
      sessions: await prisma.checkInSession.count({ where: { propertyId: PROPERTY_ID } }),
      captures: await prisma.documentCapture.count({ where: { propertyId: PROPERTY_ID } }),
      signatures: await prisma.signature.count({ where: { propertyId: PROPERTY_ID } }),
      suggestions: await prisma.assignmentSuggestion.count({ where: { propertyId: PROPERTY_ID } }),
      blocks: await prisma.roomBlock.count({ where: { propertyId: PROPERTY_ID } }),
      kiosks: await prisma.kioskDevice.count({ where: { propertyId: PROPERTY_ID } }),
      deliveries: await prisma.notificationDelivery.count({ where: { propertyId: PROPERTY_ID } })
    };
    assert.deepEqual(after, before);
    assert.equal(await prisma.guest.count({ where: { organizationId: ORG_ID, id: { startsWith: "chk_guest_" } } }), 13, "13 huéspedes ficticios");
  });
});

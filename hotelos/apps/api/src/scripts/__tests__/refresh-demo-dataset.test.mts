// Pure unit tests for the demo refresh CLI and the shared demo-target guard.
// No database: only classification, date planning, chain analysis, flag
// parsing and the guard decision. Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/refresh-demo-dataset.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyseChainLinks,
  assertDeletableModel,
  assertDeletableSequences,
  assertDraftInvoices,
  classifyAuditGuests,
  classifyGroupBookings,
  classifyReservations,
  GUEST_REFERENCE_TABLES,
  hasAuditMarker,
  isAuditGuest,
  isAuditReservation,
  isOrphanStaleCheckIn,
  keepActionFor,
  parseFlags,
  planDateShift,
  PROTECTED_MODELS,
  type ReservationLite
} from "../refresh-demo-dataset.js";
import { diffIdentity, IDENTITY_TARGETS, parseFlags as parseIdentityFlags } from "../fix-demo-legal-identity.js";
import { assertDemoTarget, evaluateDemoTarget, confirmedTargets, DEMO_ORG_IDS, DEMO_PROPERTY_IDS, UX2_DEMO_PROPERTY_IDS } from "../../../../../packages/database/prisma/lib/demo-guard.js";

const TODAY = new Date("2026-09-14T00:00:00.000Z");

function res(over: Partial<ReservationLite> & { id: string; code: string }): ReservationLite {
  return {
    status: "confirmed",
    arrivalDate: new Date("2026-11-10T00:00:00.000Z"),
    departureDate: new Date("2026-11-11T00:00:00.000Z"),
    notes: null,
    bookerName: null,
    externalReference: null,
    internalNotes: null,
    createdAt: new Date("2026-09-13T10:00:00.000Z"),
    assignedRoomId: null,
    groupCode: null,
    groupBookingId: null,
    ...over
  };
}

describe("isAuditReservation", () => {
  it("matches the AUDIT prefix in any free-text field, case-insensitively", () => {
    assert.equal(isAuditReservation(res({ id: "1", code: "A", notes: "AUDIT ciclo completo" })), true);
    assert.equal(isAuditReservation(res({ id: "2", code: "B", bookerName: "audit-T0R" })), true);
    assert.equal(isAuditReservation(res({ id: "3", code: "C", externalReference: "AUDIT-T2R-INV-1" })), true);
    assert.equal(isAuditReservation(res({ id: "4", code: "D", internalNotes: "  AUDIT-T2 interno" })), true);
  });
  it("matches the probe bookers without marker (RES-00038/39) and nothing else", () => {
    assert.equal(isAuditReservation(res({ id: "5", code: "E", bookerName: "PRODPROBE" })), true);
    assert.equal(isAuditReservation(res({ id: "6", code: "F", bookerName: "PROD-T1" })), true);
    assert.equal(isAuditReservation(res({ id: "7", code: "G", bookerName: "María López", notes: "Cuna para el bebé" })), false);
    assert.equal(isAuditReservation(res({ id: "8", code: "H" })), false);
  });
  it("reads the marker from the reservation code and the group code (AUDIT-T4-REG-001 has it nowhere else)", () => {
    assert.equal(isAuditReservation(res({ id: "9", code: "AUDIT-T4-REG-001" })), true);
    assert.equal(isAuditReservation(res({ id: "10", code: "RES-00090", groupCode: "AUDIT-T4-REG2" })), true);
    assert.equal(isAuditReservation(res({ id: "11", code: "RES-00091", groupCode: "CONGRESO-2026" })), false);
    assert.equal(isAuditReservation(res({ id: "12", code: "PREENR-P123-001" })), false);
  });
});

describe("hasAuditMarker (message bodies / metadata)", () => {
  it("matches AUDIT- anywhere, case-insensitively, but not the plain word", () => {
    assert.equal(hasAuditMarker("AUDIT-T1 admin probe"), true);
    assert.equal(hasAuditMarker("respuesta al audit-t2 fixture"), true);
    assert.equal(hasAuditMarker("Le enviamos el informe de auditoría"), false);
    assert.equal(hasAuditMarker("AUDIT sin guion"), false);
    assert.equal(hasAuditMarker(null), false);
  });
});

describe("isAuditGuest / classifyAuditGuests (orphan AUDIT guests)", () => {
  const guests = [
    { id: "g_dos", firstName: "Audit", surname1: "CuatroRegDos", email: null },
    { id: "g_reg", firstName: "Audit", surname1: "CuatroReg", email: "v1.encrypted" },
    { id: "g_prueba", firstName: "Prueba", surname1: "AUDIT", email: null },
    { id: "g_mail", firstName: "Ana", surname1: "Pérez", email: "audit-t1@example.com" },
    { id: "g_maria", firstName: "María", surname1: "López", email: "maria@example.com" },
    { id: "g_auditoria", firstName: "Auditoría", surname1: "Interna SL", email: null }
  ];
  it("reads the marker at the start of first name, surname or email, case-insensitively", () => {
    assert.equal(isAuditGuest(guests[0]), true);
    assert.equal(isAuditGuest(guests[2]), true);
    assert.equal(isAuditGuest(guests[3]), true);
    assert.equal(isAuditGuest(guests[4]), false);
    assert.equal(isAuditGuest({ firstName: null, surname1: null, email: null }), false);
  });
  it("deletes only AUDIT guests with zero references and keeps the rest with the tables that hold them", () => {
    const refs = new Map<string, Record<string, number>>([
      ["g_dos", { reservation_guests: 0, folios: 0, conversations: 0 }],
      ["g_reg", { reservation_guests: 1, guest_register_records: 1, folios: 0 }],
      ["g_prueba", { reservation_guests: 4, guest_register_records: 4, folios: 4 }],
      ["g_mail", { conversations: 2 }]
    ]);
    const out = classifyAuditGuests(guests, refs);
    assert.deepEqual(out.deletable, ["g_dos"]);
    assert.deepEqual(out.kept.map((k) => [k.guestId, k.name, k.reason]), [
      ["g_reg", "Audit CuatroReg", "referenciado: reservation_guests=1, guest_register_records=1"],
      ["g_prueba", "Prueba AUDIT", "referenciado: reservation_guests=4, guest_register_records=4, folios=4"],
      ["g_mail", "Ana Pérez", "referenciado: conversations=2"]
    ]);
    assert.equal(out.kept.some((k) => k.guestId === "g_maria" || k.guestId === "g_auditoria"), false, "non-AUDIT guests are never classified");
  });
  it("treats a guest with no reference entry as unreferenced, and covers every guest_id table", () => {
    const out = classifyAuditGuests([guests[0]], new Map());
    assert.deepEqual(out.deletable, ["g_dos"]);
    const tables = Object.values(GUEST_REFERENCE_TABLES);
    for (const t of ["reservation_guests", "guest_register_records", "folios", "conversations", "guest_reviews", "guest_portal_sessions", "payment_tokens"]) {
      assert.ok(tables.includes(t), `${t} must be checked before deleting a guest`);
    }
    assert.equal(new Set(tables).size, tables.length);
  });
});

describe("classifyGroupBookings (AUDIT groups)", () => {
  const groups = [
    { id: "g1", code: "AUDIT-T4-REG", name: "AUDIT-T4 Regresion (fixture)" },
    { id: "g2", code: "AUDIT-T4-REG2", name: "AUDIT-T4 Regresion 2 (fixture)" },
    { id: "g3", code: null, name: "AUDIT-T4 sin código" },
    { id: "g4", code: "AUDIT-T4-EVT", name: "AUDIT-T4 con evento" }
  ];
  const reservations = [
    res({ id: "r1", code: "AUDIT-T4-REG-001", groupCode: "AUDIT-T4-REG" }),
    res({ id: "r2", code: "AUDIT-T4-REG2-001", groupCode: "AUDIT-T4-REG2" }),
    res({ id: "r3", code: "RES-00099", groupBookingId: "g3" })
  ];
  it("keeps a group while any linked reservation (by id or by group_code) is KEEP, deletes it otherwise", () => {
    const out = classifyGroupBookings(groups, reservations, new Set(["r2", "r3"]), new Map([["g4", 2]]));
    assert.deepEqual(out.deletable.map((g) => g.id), ["g2", "g3"]);
    assert.deepEqual(out.kept.map((k) => [k.group.id, k.reason]), [
      ["g1", "reservas conservadas: AUDIT-T4-REG-001"],
      ["g4", "2 eventos MICE"]
    ]);
  });
  it("never links a reservation through an empty group code", () => {
    const out = classifyGroupBookings([{ id: "g5", code: "", name: "x" }], [res({ id: "r9", code: "RES-00001", groupCode: "" })], new Set());
    assert.deepEqual(out.deletable.map((g) => g.id), ["g5"]);
  });
});

describe("classifyReservations (KEEP vs DELETABLE)", () => {
  const rows = [
    res({ id: "r21", code: "RES-00021", status: "checked_in", notes: "AUDIT facturacion fiscal" }),
    res({ id: "r36", code: "RES-00036", status: "confirmed", notes: "AUDIT-T0R regresion folio" }),
    res({ id: "r41", code: "RES-00041", status: "checked_out", notes: "AUDIT-T1 ciclo" }),
    res({ id: "r84", code: "RES-00084", status: "checked_in", notes: "AUDIT-T3 ses-registro" }),
    res({ id: "r17", code: "RES-00017", status: "checked_out", notes: "AUDIT ciclo completo" }),
    res({ id: "r38", code: "RES-00038", status: "confirmed", bookerName: "PRODPROBE" }),
    res({ id: "r03", code: "RES-00003", status: "confirmed" })
  ];
  const links = {
    reservationsWithHashInvoice: new Set(["r21", "r36", "r41"]),
    reservationsWithSes: new Set(["r21", "r84"])
  };
  const out = classifyReservations(rows, links);

  it("keeps every AUDIT reservation that carries a VeriFactu invoice or an SES submission", () => {
    assert.deepEqual(out.keep.map((k) => k.reservation.code).sort(), ["RES-00021", "RES-00036", "RES-00041", "RES-00084"]);
    const r21 = out.keep.find((k) => k.reservation.id === "r21")!;
    assert.deepEqual(r21.reasons, ["factura con verifactu_hash", "ses_hospedajes_submission"]);
  });
  it("derives the KEEP action from the status: checked_in → check_out, confirmed → cancel, closed → none", () => {
    const byCode = Object.fromEntries(out.keep.map((k) => [k.reservation.code, k.action]));
    assert.equal(byCode["RES-00021"], "check_out");
    assert.equal(byCode["RES-00084"], "check_out");
    assert.equal(byCode["RES-00036"], "cancel");
    assert.equal(byCode["RES-00041"], "none");
    assert.equal(keepActionFor("no_show"), "none");
    assert.equal(keepActionFor("draft"), "cancel");
  });
  it("marks the remaining AUDIT/probe reservations deletable and never touches walkthrough bookings", () => {
    assert.deepEqual(out.deletable.map((r) => r.code).sort(), ["RES-00017", "RES-00038"]);
    assert.equal(out.keep.some((k) => k.reservation.code === "RES-00003"), false);
  });
});

describe("isOrphanStaleCheckIn (RES-00001)", () => {
  const empty = { guests: 0, folioLines: 0, payments: 0, invoices: 0, registerRecords: 0, sesSubmissions: 0 };
  const stale = res({ id: "r1", code: "RES-00001", status: "checked_in", arrivalDate: new Date("2026-07-12T00:00:00.000Z"), departureDate: new Date("2026-07-14T00:00:00.000Z") });
  it("flags an expired empty check-in", () => {
    assert.equal(isOrphanStaleCheckIn(stale, empty, TODAY), true);
  });
  it("refuses when anything hangs from it, when it is still current, or when it is an AUDIT fixture", () => {
    assert.equal(isOrphanStaleCheckIn(stale, { ...empty, folioLines: 1 }, TODAY), false);
    assert.equal(isOrphanStaleCheckIn(stale, { ...empty, sesSubmissions: 1 }, TODAY), false);
    assert.equal(isOrphanStaleCheckIn({ ...stale, departureDate: new Date("2026-09-15T00:00:00.000Z") }, empty, TODAY), false);
    assert.equal(isOrphanStaleCheckIn({ ...stale, notes: "AUDIT" }, empty, TODAY), false);
    assert.equal(isOrphanStaleCheckIn({ ...stale, status: "confirmed" }, empty, TODAY), false);
  });
});

describe("planDateShift", () => {
  it("moves the whole group so the first arrival lands on today+1, keeping LOS and order", () => {
    const plan = planDateShift(
      [
        { id: "a", code: "RES-00003", arrivalDate: new Date("2026-07-16T00:00:00.000Z"), departureDate: new Date("2026-07-18T00:00:00.000Z") },
        { id: "b", code: "RES-00016", arrivalDate: new Date("2026-08-02T00:00:00.000Z"), departureDate: new Date("2026-08-05T00:00:00.000Z") }
      ],
      TODAY
    );
    assert.deepEqual(plan.map((p) => [p.code, p.to.arrival, p.to.departure, p.los]), [
      ["RES-00003", "2026-09-15", "2026-09-17", 2],
      ["RES-00016", "2026-10-02", "2026-10-05", 3]
    ]);
  });
  it("compresses arrival offsets when the original span does not fit in 30 days, never shortening a stay", () => {
    const plan = planDateShift(
      [
        { id: "a", code: "A", arrivalDate: new Date("2026-01-01T00:00:00.000Z"), departureDate: new Date("2026-01-03T00:00:00.000Z") },
        { id: "b", code: "B", arrivalDate: new Date("2026-03-01T00:00:00.000Z"), departureDate: new Date("2026-03-05T00:00:00.000Z") }
      ],
      TODAY
    );
    assert.equal(plan[0].to.arrival, "2026-09-15");
    assert.equal(plan[1].los, 4);
    assert.ok(plan[1].to.departure <= "2026-10-14", `last departure ${plan[1].to.departure} must stay within today+30`);
    assert.ok(plan[1].to.arrival > plan[0].to.arrival);
  });
  it("returns nothing for an empty group", () => {
    assert.deepEqual(planDateShift([], TODAY), []);
  });
});

describe("analyseChainLinks", () => {
  it("counts genesis rows and dangling previous_hash links independently of order", () => {
    const rows = [
      { previousHash: "h1", currentHash: "h2" },
      { previousHash: null, currentHash: "h1" },
      { previousHash: "h2", currentHash: "h3" },
      { previousHash: "missing", currentHash: "h4" }
    ];
    assert.deepEqual(analyseChainLinks(rows), { total: 4, genesis: 1, dangling: 1 });
  });
});

describe("protected tables and fiscal assertions", () => {
  it("refuses to plan a deleteMany on the audit trail, event stream, VeriFactu or SES submissions", () => {
    for (const model of PROTECTED_MODELS) assert.throws(() => assertDeletableModel(model), /protegida/);
    assert.doesNotThrow(() => assertDeletableModel("posOrder"));
  });
  it("aborts when an invoice with verifactu_hash or a non-draft slips into the deletion set", () => {
    assert.doesNotThrow(() => assertDraftInvoices([{ id: "i1", status: "draft", verifactuHash: null, invoiceNumber: null }]));
    assert.throws(() => assertDraftInvoices([{ id: "i2", status: "issued", verifactuHash: "abc", invoiceNumber: "FAC-2026-000001" }]), /FAC-2026-000001/);
    assert.throws(() => assertDraftInvoices([{ id: "i3", status: "issued", verifactuHash: null, invoiceNumber: "X" }]), /abortado/);
  });
  it("only deletes AUDIT invoice sequences, never FAC/REC", () => {
    assert.doesNotThrow(() => assertDeletableSequences([{ id: "s1", sequenceCode: "AUDIT", prefix: "AUDIT-2026-" }]));
    assert.throws(() => assertDeletableSequences([{ id: "s2", sequenceCode: "FAC", prefix: "AUDIT-" }]), /protegida/);
    assert.throws(() => assertDeletableSequences([{ id: "s3", sequenceCode: "TEST", prefix: "T-2026-" }]), /protegida/);
  });
});

describe("parseFlags (demo:refresh)", () => {
  it("defaults to dry-run, scope all, exclude-after now", () => {
    const now = new Date("2026-09-14T12:00:00.000Z");
    const f = parseFlags([], now);
    assert.deepEqual(f, { apply: false, scope: "all", excludeAfter: now, json: false });
  });
  it("parses --apply, --scope, --exclude-after and --json", () => {
    const f = parseFlags(["--apply", "--scope", "faranda", "--exclude-after", "2026-09-14T13:00:00Z", "--json"]);
    assert.equal(f.apply, true);
    assert.equal(f.scope, "faranda");
    assert.equal(f.excludeAfter.toISOString(), "2026-09-14T13:00:00.000Z");
    assert.equal(f.json, true);
  });
  it("rejects unknown flags, bad scopes, bad dates and --dry-run together with --apply (exit 2 path)", () => {
    assert.throws(() => parseFlags(["--force"]), /Unknown flag/);
    assert.throws(() => parseFlags(["--scope", "everything"]), /--scope must be one of/);
    assert.throws(() => parseFlags(["--exclude-after", "ayer"]), /ISO/);
    assert.throws(() => parseFlags(["--dry-run", "--apply"]), /mutually exclusive/);
  });
});

describe("fix-demo-legal-identity", () => {
  it("requires --confirm with --apply and only accepts managed organisations", () => {
    assert.throws(() => parseIdentityFlags(["--apply"]), /--confirm/);
    assert.throws(() => parseIdentityFlags(["--apply", "--confirm", "org_999"]), /does not manage/);
    const f = parseIdentityFlags(["--apply", "--confirm", "cmrhw9jy30002fyvb6tsdiugt", "--confirm", "org_123"]);
    assert.deepEqual(f.confirm, ["cmrhw9jy30002fyvb6tsdiugt", "org_123"]);
  });
  it("diffs only the fields that differ and fills region/territory only when empty", () => {
    const faranda = IDENTITY_TARGETS[0];
    const changes = diffIdentity(faranda, {
      organization: { legalName: "AUDIT-T1 SL", taxId: "B99999999" },
      property: { legalName: "AUDIT-T1 SL", address: "AUDIT-T1 Paseo Marítimo 1", postalCode: null, province: "A Coruña", municipality: null, ineMunicipalityCode: null, taxRegion: "ES_PENINSULA_BALEARES", fiscalTerritory: "" }
    });
    const fields = changes.map((c) => `${c.entity}.${c.field}`);
    assert.deepEqual(fields, ["organization.legalName", "organization.taxId", "property.legalName", "property.address", "property.postalCode", "property.municipality", "property.ineMunicipalityCode", "property.fiscalTerritory"]);
    assert.equal(changes.find((c) => c.field === "taxId")!.after, "B99999997");
  });
  it("is idempotent: a converged tenant yields no changes", () => {
    const demo = IDENTITY_TARGETS[1];
    assert.deepEqual(diffIdentity(demo, { organization: { name: "Grupo Hotelero Demo", legalName: "Grupo Hotelero Demo SL", taxId: "B12345674" }, property: null }), []);
  });
});

describe("demo-guard", () => {
  it("allows the demo allowlist without any confirmation (org_uxday / prop_uxday = tenant aislado de UX-1 · seed-ux-day; org_chk / prop_chk = tenant aislado de CHK · seed-checkin; prop_uxday_b = segundo hotel de UX-2 · seed-ux-direccion; org_act = tenant aislado de ACT · seed-real-estate)", () => {
    assert.deepEqual([...DEMO_ORG_IDS], ["org_123", "org_uxday", "org_chk", "org_act"]);
    assert.deepEqual([...DEMO_PROPERTY_IDS], ["prop_123", "prop_canary", "prop_uxday", "prop_chk", "prop_uxday_b"]);
    assert.deepEqual([...UX2_DEMO_PROPERTY_IDS], ["prop_uxday_b"]);
    assert.equal(evaluateDemoTarget({ orgId: "org_uxday", propertyId: "prop_uxday_b", action: "t" }, {}).allowed, true);
    // Tanda ACT: el seed solo pasa el orgId al guard; prop_act_* no está en la allowlist (los acota el propio seed).
    assert.equal(evaluateDemoTarget({ orgId: "org_act", action: "t" }, {}).allowed, true);
    assert.equal(evaluateDemoTarget({ propertyId: "prop_act_a", action: "t" }, {}).allowed, false);
    const d = evaluateDemoTarget({ orgId: "org_123", propertyId: "prop_canary", action: "t" }, {});
    assert.deepEqual(d, { allowed: true, via: "allowlist", targets: ["org_123", "prop_canary"] });
  });
  it("refuses a real target without SEED_ALLOW_REAL=1 and SEED_CONFIRM=<exact id>", () => {
    const faranda = "cmrhw9jy40003fyvbuu2ec2w7";
    assert.equal(evaluateDemoTarget({ propertyId: faranda, action: "t" }, {}).allowed, false);
    assert.equal(evaluateDemoTarget({ propertyId: faranda, action: "t" }, { SEED_ALLOW_REAL: "1" }).allowed, false);
    assert.equal(evaluateDemoTarget({ propertyId: faranda, action: "t" }, { SEED_ALLOW_REAL: "1", SEED_CONFIRM: "prop_123" }).allowed, false);
    assert.equal(evaluateDemoTarget({ propertyId: faranda, action: "t" }, { SEED_CONFIRM: faranda }).allowed, false);
    const ok = evaluateDemoTarget({ orgId: "org_x", propertyId: faranda, action: "t" }, { SEED_ALLOW_REAL: "1", SEED_CONFIRM: ` org_x , ${faranda}` });
    assert.deepEqual(ok, { allowed: true, via: "confirmed", targets: ["org_x", faranda] });
    assert.deepEqual(confirmedTargets({ SEED_ALLOW_REAL: "0", SEED_CONFIRM: "a,b" }), []);
  });
  it("refuses when the seed names no target at all", () => {
    assert.equal(evaluateDemoTarget({ action: "t" }, { SEED_ALLOW_REAL: "1", SEED_CONFIRM: "x" }).allowed, false);
  });
  it("assertDemoTarget prints the planned writes and exits with 2 (then throws) when blocked", () => {
    const log: string[] = [];
    const exits: number[] = [];
    assert.throws(
      () =>
        assertDemoTarget(
          { propertyId: "real_hotel", action: "seed-x", planned: [{ table: "rate_days", op: "deleteMany", where: "ventana", count: 900 }] },
          { env: {}, log: (l) => log.push(l), exit: (c) => { exits.push(c); } }
        ),
      /no permitido/
    );
    assert.deepEqual(exits, [2]);
    assert.ok(log.some((l) => l.includes("deleteMany") && l.includes("rate_days") && l.includes("×900")));
    assert.ok(log.some((l) => l.includes("BLOQUEADO")));
  });
  it("assertDemoTarget returns the decision for an allowlisted target without exiting", () => {
    const exits: number[] = [];
    const d = assertDemoTarget({ propertyId: "prop_123", action: "seed-y" }, { env: {}, log: () => undefined, exit: (c) => { exits.push(c); } });
    assert.equal(d.allowed, true);
    assert.deepEqual(exits, []);
  });
});

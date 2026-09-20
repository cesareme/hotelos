// Unit tests · Tanda T9 · corrector RV-10 — avisos in-app a la oficina
// (office-notifications.ts) sobre un Prisma simulado: destinatarios por clave y
// ámbito (organización / sociedad / centro / grupo, asignaciones vivas, roles
// heredados, usuarios activos), agrupación por hora y aviso diario del SLA.
// Sin Postgres. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/office-notifications.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OFFICE_SENT_TITLE_PREFIX, SLA_BREACH_TITLE_PREFIX, findUsersWithPermission, notifyOfficeDocumentSent, notifySlaBreaches } from "../office-notifications.js";

type Row = Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
}

/** Subconjunto de filtros Prisma que usa office-notifications.ts. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      if (!(cond as Row[]).every((sub) => matches(row, sub))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(cond as Row[]).some((sub) => matches(row, sub))) return false;
      continue;
    }
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond instanceof Date || typeof cond !== "object") {
      if (!same(value, cond)) return false;
      continue;
    }
    const filter = cond as Row;
    if ("in" in filter && !(filter.in as unknown[]).some((item) => same(item, value))) return false;
    if ("lte" in filter && (value == null || (value as Date).getTime() > (filter.lte as Date).getTime())) return false;
    if ("gte" in filter && (value == null || (value as Date).getTime() < (filter.gte as Date).getTime())) return false;
    if ("gt" in filter && (value == null || (value as Date).getTime() <= (filter.gt as Date).getTime())) return false;
    if ("startsWith" in filter && !String(value ?? "").startsWith(String(filter.startsWith))) return false;
  }
  return true;
}

function table(rows: Row[]) {
  return {
    rows,
    findMany: async (args: { where?: Row } = {}) => rows.filter((row) => matches(row, args.where)),
    findFirst: async (args: { where?: Row } = {}) => rows.find((row) => matches(row, args.where)) ?? null,
    findUnique: async (args: { where: Row }) => rows.find((row) => matches(row, args.where)) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `row_${rows.length + 1}`, createdAt: NOW, ...data };
      rows.push(row);
      return row;
    }
  };
}

const NOW = new Date("2026-09-20T10:00:00.000Z");
const ORG = "org_notif";
const PROP_A = "prop_a";
const PROP_B = "prop_b";
const live = (over: Row): Row => ({ organizationId: ORG, revokedAt: null, validFrom: new Date("2026-01-01T00:00:00.000Z"), validTo: null, propertyId: null, propertyGroupId: null, legalEntityId: null, ...over });

function fakeDb() {
  return {
    permission: table([{ id: "perm_review", key: "documents.review" }, { id: "perm_admin", key: "documents.admin" }]),
    rolePermission: table([
      { roleId: "role_clerk", permissionId: "perm_review" },
      { roleId: "role_owner", permissionId: "perm_review" },
      { roleId: "role_owner", permissionId: "perm_admin" },
      { roleId: "role_other_org", permissionId: "perm_review" }
    ]),
    role: table([{ id: "role_clerk", organizationId: ORG }, { id: "role_owner", organizationId: ORG }, { id: "role_other_org", organizationId: "org_otra" }]),
    property: table([{ id: PROP_A, legalEntityId: "le_1", name: "Hotel A", code: "HA" }, { id: PROP_B, legalEntityId: "le_2", name: "Hotel B", code: "HB" }]),
    propertyGroupMember: table([{ propertyGroupId: "grp_costa", propertyId: PROP_A }]),
    userRoleAssignment: table([
      live({ userId: "usr_clerk_a", roleId: "role_clerk", scopeType: "property", propertyId: PROP_A }),
      live({ userId: "usr_clerk_b", roleId: "role_clerk", scopeType: "property", propertyId: PROP_B }),
      live({ userId: "usr_owner", roleId: "role_owner", scopeType: "organization" }),
      live({ userId: "usr_entity", roleId: "role_clerk", scopeType: "legal_entity", legalEntityId: "le_1" }),
      live({ userId: "usr_group", roleId: "role_clerk", scopeType: "property_group", propertyGroupId: "grp_costa" }),
      live({ userId: "usr_revoked", roleId: "role_clerk", scopeType: "property", propertyId: PROP_A, revokedAt: new Date("2026-09-01T00:00:00.000Z") }),
      live({ userId: "usr_expired", roleId: "role_clerk", scopeType: "property", propertyId: PROP_A, validTo: new Date("2026-09-10T00:00:00.000Z") }),
      live({ userId: "usr_inactive", roleId: "role_clerk", scopeType: "property", propertyId: PROP_A }),
      live({ userId: "usr_other_org", roleId: "role_other_org", scopeType: "organization", organizationId: "org_otra" })
    ]),
    userPropertyRole: table([{ userId: "usr_legacy", roleId: "role_clerk", propertyId: PROP_A }]),
    user: table([
      { id: "usr_clerk_a", organizationId: ORG, status: "active" },
      { id: "usr_clerk_b", organizationId: ORG, status: "active" },
      { id: "usr_owner", organizationId: ORG, status: "active" },
      { id: "usr_entity", organizationId: ORG, status: "active" },
      { id: "usr_group", organizationId: ORG, status: "active" },
      { id: "usr_revoked", organizationId: ORG, status: "active" },
      { id: "usr_expired", organizationId: ORG, status: "active" },
      { id: "usr_inactive", organizationId: ORG, status: "disabled" },
      { id: "usr_legacy", organizationId: ORG, status: "active" },
      { id: "usr_other_org", organizationId: "org_otra", status: "active" }
    ]),
    notification: table([])
  };
}

type Db = Parameters<typeof findUsersWithPermission>[0];

describe("findUsersWithPermission", () => {
  it("documents.review en el hotel A: centro, grupo que lo contiene, sociedad del centro, organización y rol heredado; nunca revocados, caducados, inactivos, otro centro u otra organización", async () => {
    const db = fakeDb();
    const users = await findUsersWithPermission(db as unknown as Db, { organizationId: ORG, propertyId: PROP_A, key: "documents.review", now: NOW });
    assert.deepEqual(users, ["usr_clerk_a", "usr_entity", "usr_group", "usr_legacy", "usr_owner"]);
    const inB = await findUsersWithPermission(db as unknown as Db, { organizationId: ORG, propertyId: PROP_B, key: "documents.review", now: NOW });
    assert.deepEqual(inB, ["usr_clerk_b", "usr_owner"]);
  });

  it("propertyId null (avisos de la organización): solo asignaciones de organización / sociedad; clave desconocida → []", async () => {
    const db = fakeDb();
    assert.deepEqual(await findUsersWithPermission(db as unknown as Db, { organizationId: ORG, propertyId: null, key: "documents.admin", now: NOW }), ["usr_owner"]);
    assert.deepEqual(await findUsersWithPermission(db as unknown as Db, { organizationId: ORG, propertyId: null, key: "documents.review", now: NOW }), ["usr_entity", "usr_owner"]);
    assert.deepEqual(await findUsersWithPermission(db as unknown as Db, { organizationId: ORG, propertyId: PROP_A, key: "documents.capture", now: NOW }), []);
  });
});

describe("notifyOfficeDocumentSent · agrupado por hora, sin el remitente", () => {
  const row = { id: "doc_1", organizationId: ORG, propertyId: PROP_A, registryNumber: "DOC-HA-2026-000001", kind: "invoice" };

  it("primer envío: un aviso por revisor del centro (enlace por número de registro, sin adjunto); el segundo dentro de la hora se agrupa; pasada la hora vuelve a avisar", async () => {
    const db = fakeDb();
    const first = await notifyOfficeDocumentSent(db as unknown as Db, { row, at: NOW, excludeUserId: "usr_clerk_a" });
    assert.deepEqual(first, { notified: ["usr_entity", "usr_group", "usr_legacy", "usr_owner"], grouped: [] });
    assert.equal(db.notification.rows.length, 4);
    const note = db.notification.rows[0]!;
    assert.equal(note.type, "system");
    assert.equal(note.status, "unread");
    assert.equal(note.propertyId, PROP_A);
    assert.equal(note.title, `${OFFICE_SENT_TITLE_PREFIX} · HA`);
    assert.match(String(note.body), /DOC-HA-2026-000001 \(factura\)/);
    assert.doesNotMatch(String(note.body), /base64|JVBERi0/);

    const second = await notifyOfficeDocumentSent(db as unknown as Db, { row: { ...row, id: "doc_2", registryNumber: "DOC-HA-2026-000002" }, at: new Date(NOW.getTime() + 20 * 60_000) });
    assert.deepEqual(second.notified, ["usr_clerk_a"], "solo quien no tenía aviso en la última hora (el remitente del primero)");
    assert.deepEqual(second.grouped, ["usr_entity", "usr_group", "usr_legacy", "usr_owner"]);
    assert.equal(db.notification.rows.length, 5);

    const later = await notifyOfficeDocumentSent(db as unknown as Db, { row: { ...row, id: "doc_3", registryNumber: "DOC-HA-2026-000003" }, at: new Date(NOW.getTime() + 61 * 60_000) });
    assert.equal(later.notified.length, 5);
    assert.deepEqual(later.grouped, []);
  });

  it("sin revisores en el centro no crea nada", async () => {
    const db = fakeDb();
    db.userRoleAssignment.rows.length = 0;
    db.userPropertyRole.rows.length = 0;
    assert.deepEqual(await notifyOfficeDocumentSent(db as unknown as Db, { row, at: NOW }), { notified: [], grouped: [] });
    assert.equal(db.notification.rows.length, 0);
  });
});

describe("notifySlaBreaches · aviso diario a documents.admin", () => {
  it("cita hasta 10 registros y cuenta el resto; una vez al día por persona", async () => {
    const db = fakeDb();
    const breached = Array.from({ length: 12 }, (_, index) => ({ id: `doc_${index}`, organizationId: ORG, propertyId: PROP_A, registryNumber: `DOC-HA-2026-0000${String(index + 1).padStart(2, "0")}`, sentAt: new Date("2026-09-10T00:00:00.000Z") }));
    const first = await notifySlaBreaches(db as unknown as Db, { organizationId: ORG, breached, slaBusinessDays: 2, at: NOW });
    assert.deepEqual(first, { notified: ["usr_owner"], grouped: [] });
    const note = db.notification.rows[0]!;
    assert.equal(note.title, `${SLA_BREACH_TITLE_PREFIX} · 12 documentos`);
    assert.match(String(note.body), /12 documentos enviados a la oficina hace más de 2 días laborables/);
    assert.match(String(note.body), /DOC-HA-2026-000010 y 2 más/);
    assert.doesNotMatch(String(note.body), /DOC-HA-2026-000011/);

    const sameDay = await notifySlaBreaches(db as unknown as Db, { organizationId: ORG, breached, slaBusinessDays: 2, at: new Date(NOW.getTime() + 6 * 3_600_000) });
    assert.deepEqual(sameDay, { notified: [], grouped: ["usr_owner"] });
    const nextDay = await notifySlaBreaches(db as unknown as Db, { organizationId: ORG, breached: breached.slice(0, 1), slaBusinessDays: 1, at: new Date(NOW.getTime() + 25 * 3_600_000) });
    assert.deepEqual(nextDay.notified, ["usr_owner"]);
    assert.equal(db.notification.rows[1]!.title, `${SLA_BREACH_TITLE_PREFIX} · 1 documento`);
    assert.match(String(db.notification.rows[1]!.body), /1 documento enviado a la oficina hace más de 1 día laborable sin decisión: DOC-HA-2026-000001\./);
    assert.deepEqual(await notifySlaBreaches(db as unknown as Db, { organizationId: ORG, breached: [], slaBusinessDays: 2, at: NOW }), { notified: [], grouped: [] });
  });
});

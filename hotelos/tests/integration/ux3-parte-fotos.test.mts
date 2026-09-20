/**
 * Tanda UX-3 · lote M1 · fotos del parte de mantenimiento (diseño §4.6, D2/D3, R4).
 * app.inject sobre Postgres real con dos organizaciones AISLADAS (helpers/l2-tenant.mts):
 * A escribe y lee; B (otra organización, con las mismas claves de mantenimiento) nunca ve
 * nada. STRICT_ENV: auth real, sin unión de permisos de demo, RBAC_STRICT=true.
 *
 *   (1) la camarera (plantilla housekeeper, maintenance.workorder.create) crea el parte con
 *       una foto → 201, parte + fila de work_order_media con los bytes en base64 en UNA
 *       transacción; GET /dashboards/maintenance-mobile lo lista con mediaCount 1;
 *   (2) el técnico (maintenance.read) lee los metadatos (GET …/:id/media) y los bytes
 *       (GET /work-orders/media/:mediaId: content-type, cache-control private, nosniff);
 *   (3) 404 opaco: el técnico de la organización B sobre el parte y la foto de A; un id
 *       inexistente responde el mismo mensaje; (3b, corrector REV-05) un técnico de la MISMA
 *       organización asignado solo al otro hotel (x-property-id del otro hotel) recibe el
 *       mismo 404 sobre las fotos del parte de A;
 *   (4) D3: la camarera no adjunta después de crear (403 maintenance.workorder.manage); el
 *       técnico sí ({ contentBase64, mimeType } → 201) hasta 3 fotos en línea por parte;
 *   (5) guardas: > 3 fotos, html disfrazado y tipo no admitido → 400 con details.code y SIN
 *       parte creado; el cuerpo clásico sin `photos` sigue respondiendo 200 y `{ objectKey }`
 *       sigue creando una fila legacy (sin bytes → 404 WORK_ORDER_MEDIA_NOT_INLINE al servirla);
 *   (6) corrector REV-L03: cuatro POST …/media concurrentes sobre un parte sin fotos dejan
 *       exactamente 3 filas en línea (recuento + inserción en una transacción con FOR UPDATE).
 *
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/ux3-parte-fotos.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
type Session = import("./helpers/l2-tenant.mts").Session;
const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Reply = { status: number; body: any; raw: string; headers: Record<string, unknown>; bytes: Buffer };

const RUN = `f${newRunId()}`;

/** PNG 1×1 real (67 bytes). */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_B64, "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(40, 0x2a)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 "), Buffer.alloc(10)]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>");
const photo = (bytes: Buffer, mimeType: string) => ({ contentBase64: bytes.toString("base64"), mimeType });

let app: ApiApp;
let A: IsolatedTenant;
let B: IsolatedTenant;
/** Camarera de pisos del hotel A (plantilla housekeeper): crea partes con foto, no adjunta después. */
let housekeeper: Session;
let housekeeperId = "";
/** Técnico de mantenimiento del hotel A (plantilla maintenance): lee y adjunta. */
let maintenance: Session;
/** Técnico de la organización B: mismas claves, otro ámbito → 404 opaco. */
let maintenanceB: Session;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;

async function call(method: Method, url: string, session: Session | null, options: { payload?: unknown; propertyId?: string } = {}): Promise<Reply> {
  const res = await withEnv(STRICT_ENV, () =>
    app.inject({
      method,
      url,
      headers: { ...(session?.headers ?? {}), ...(options.propertyId ? { "x-property-id": options.propertyId } : {}) },
      ...(options.payload !== undefined ? { payload: options.payload } : {})
    })
  );
  let body: any = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, raw: res.body, headers: res.headers as Record<string, unknown>, bytes: res.rawPayload };
}

function expect404(reply: Reply, message: string): void {
  assert.equal(reply.status, 404, reply.raw.slice(0, 300));
  assert.equal(reply.body?.message, message);
}

function expect403(reply: Reply, key: string): void {
  assert.equal(reply.status, 403, reply.raw.slice(0, 300));
  const message = String(reply.body?.message ?? "");
  assert.match(message, /^No tienes permiso para realizar esta acción/, message);
  assert.ok(message.includes(key), `la clave que falta (${key}) viaja en el mensaje: ${message}`);
}

function expect400(reply: Reply, code: string): void {
  assert.equal(reply.status, 400, reply.raw.slice(0, 300));
  assert.equal(reply.body?.details?.code ?? reply.body?.code, code, reply.raw.slice(0, 300));
}

/** Usuario extra con una plantilla de T8a asignado a un hotel; cuelga de la org → cleanupTenant lo barre. */
async function addTenantUser(tenant: IsolatedTenant, spec: { local: string; templateKey: string; propertyId: string }): Promise<{ id: string; email: string }> {
  const id = `usr_l2_${spec.local}_${tenant.run}`;
  const email = `${spec.local}.l2.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `L2 ${spec.local} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[spec.templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${spec.templateKey}» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({
    data: { userId: id, roleId, scopeType: "property", propertyId: spec.propertyId, organizationId: tenant.organizationId, reason: `ux3-m1 ${spec.local}` }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  app = await buildApiServer();
  A = await createIsolatedTenant(RUN);
  B = await createIsolatedTenant(`${RUN}b`);
  const hk = await addTenantUser(A, { local: "housekeeper", templateKey: "housekeeper", propertyId: A.propertyA });
  housekeeperId = hk.id;
  const mt = await addTenantUser(A, { local: "maintenance", templateKey: "maintenance", propertyId: A.propertyA });
  const mtB = await addTenantUser(B, { local: "maintenance", templateKey: "maintenance", propertyId: B.propertyA });
  await withEnv(STRICT_ENV, async () => {
    housekeeper = await loginOrThrow(app, hk.email, A.password, "ux3-m1-housekeeper");
    maintenance = await loginOrThrow(app, mt.email, A.password, "ux3-m1-maintenance");
    maintenanceB = await loginOrThrow(app, mtB.email, B.password, "ux3-m1-maintenance-b");
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    if (A) await cleanupTenant(A.organizationId);
    if (B) await cleanupTenant(B.organizationId);
  } finally {
    await app?.close();
  }
  assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
  assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organizaciones residuales de esta suite");
});

let workOrderId = "";
let mediaId = "";

describe("UX-3 M1 · (1) la camarera crea el parte con foto", () => {
  it("POST /work-orders con photos[1] → 201, parte + fila de medios con los bytes en la fila y media[] en la respuesta", async () => {
    const created = await call("POST", "/work-orders", housekeeper, {
      propertyId: A.propertyA,
      payload: { roomNumber: "101", title: `Hab. 101: Fuga de agua ${RUN}`, priority: "urgent", blocksRoom: false, photos: [photo(PNG, "image/png")] }
    });
    assert.equal(created.status, 201, created.raw.slice(0, 300));
    workOrderId = created.body.id;
    assert.equal(created.body.propertyId, A.propertyA);
    assert.equal(created.body.status, "open");
    assert.equal(created.body.createdBy, housekeeperId);
    assert.ok(Array.isArray(created.body.media) && created.body.media.length === 1, "media[] con la foto");
    const meta = created.body.media[0];
    mediaId = meta.id;
    assert.equal(meta.workOrderId, workOrderId);
    assert.equal(meta.mediaType, "photo");
    assert.equal(meta.mimeType, "image/png");
    assert.equal(meta.sizeBytes, PNG.length);
    assert.equal(meta.inline, true);
    assert.equal(meta.createdBy, housekeeperId);
    assert.ok(!("contentBase64" in meta), "la respuesta no devuelve los bytes");

    const rows = await prisma.workOrderMedia.findMany({ where: { workOrderId } });
    assert.equal(rows.length, 1, "una fila en work_order_media");
    assert.equal(rows[0]!.contentBase64, PNG_B64);
    assert.equal(rows[0]!.mimeType, "image/png");
    assert.equal(rows[0]!.sizeBytes, PNG.length);
    assert.equal(rows[0]!.createdBy, housekeeperId);
    assert.ok(rows[0]!.objectKey.startsWith("inline://work-order-media/"));
    assert.ok(rows[0]!.createdAt instanceof Date);
  });

  it("GET /dashboards/maintenance-mobile (analytics.read) lista el parte con mediaCount 1", async () => {
    const dashboard = await call("GET", `/dashboards/maintenance-mobile?propertyId=${A.propertyA}`, housekeeper, { propertyId: A.propertyA });
    assert.equal(dashboard.status, 200, dashboard.raw.slice(0, 300));
    const item = (dashboard.body.items as Array<{ workOrderId: string; mediaCount: number }>).find((row) => row.workOrderId === workOrderId);
    assert.ok(item, "el parte recién creado aparece en Mis averías");
    assert.equal(item.mediaCount, 1);
  });

  it("el cuerpo clásico sin photos sigue respondiendo 200 (l2-modulos-operaciones) con media = []", async () => {
    const classic = await call("POST", "/work-orders", housekeeper, {
      propertyId: A.propertyA,
      payload: { roomNumber: "102", title: `Hab. 102: Bombilla ${RUN}`, priority: "normal", blocksRoom: false }
    });
    assert.equal(classic.status, 200, classic.raw.slice(0, 300));
    assert.deepEqual(classic.body.media, []);
    assert.equal(await prisma.workOrderMedia.count({ where: { workOrderId: classic.body.id } }), 0);
  });
});

describe("UX-3 M1 · (2) el técnico lee metadatos y bytes", () => {
  it("GET /work-orders/:id/media (maintenance.read) → 200 con los metadatos y sin contentBase64", async () => {
    const list = await call("GET", `/work-orders/${workOrderId}/media`, maintenance, { propertyId: A.propertyA });
    assert.equal(list.status, 200, list.raw.slice(0, 300));
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, mediaId);
    assert.equal(list.body[0].mimeType, "image/png");
    assert.equal(list.body[0].sizeBytes, PNG.length);
    assert.equal(list.body[0].inline, true);
    assert.ok(!("contentBase64" in list.body[0]));
    assert.ok(!list.raw.includes(PNG_B64.slice(0, 32)), "los bytes no viajan en la lista");
  });

  it("GET /work-orders/media/:mediaId (maintenance.read) → 200 image/png, cache-control private, nosniff, bytes idénticos", async () => {
    const file = await call("GET", `/work-orders/media/${mediaId}`, maintenance, { propertyId: A.propertyA });
    assert.equal(file.status, 200, file.raw.slice(0, 300));
    assert.equal(file.headers["content-type"], "image/png");
    assert.equal(file.headers["content-length"], String(PNG.length));
    assert.match(String(file.headers["cache-control"]), /private/);
    assert.equal(file.headers["x-content-type-options"], "nosniff");
    assert.match(String(file.headers["content-disposition"]), /^inline; filename="wom_[0-9a-f]{16}\.png"$/);
    assert.ok(file.bytes.equals(PNG), "los bytes servidos son la foto");
  });
});

describe("UX-3 M1 · (3) 404 opaco fuera de la organización", () => {
  it("el técnico de B sobre el parte y la foto de A → 404; un id inexistente responde el MISMO mensaje", async () => {
    expect404(await call("GET", `/work-orders/${workOrderId}/media`, maintenanceB, { propertyId: B.propertyA }), "Orden de trabajo no encontrada.");
    expect404(await call("GET", `/work-orders/media/${mediaId}`, maintenanceB, { propertyId: B.propertyA }), "Archivo del parte no encontrado.");
    expect404(await call("POST", `/work-orders/${workOrderId}/media`, maintenanceB, { propertyId: B.propertyA, payload: photo(JPEG, "image/jpeg") }), "Orden de trabajo no encontrada.");
    expect404(await call("GET", `/work-orders/media/wom_0000000000000000`, maintenance, { propertyId: A.propertyA }), "Archivo del parte no encontrado.");
    expect404(await call("GET", `/work-orders/wo_desconocido/media`, maintenance, { propertyId: A.propertyA }), "Orden de trabajo no encontrada.");
    assert.equal(await prisma.workOrderMedia.count({ where: { workOrderId } }), 1, "B no adjuntó nada");
  });
});

describe("UX-3 M1 · (3b) 404 opaco entre propiedades de la MISMA organización (corrector REV-05)", () => {
  it("un técnico de A asignado solo al hotel B (x-property-id B) no lista ni descarga las fotos del parte de A; el técnico del hotel A sí", async () => {
    const other = await addTenantUser(A, { local: "maintenance-b", templateKey: "maintenance", propertyId: A.propertyB });
    const session = await withEnv(STRICT_ENV, () => loginOrThrow(app, other.email, A.password, "ux3-rev05-maintenance-b"));
    expect404(await call("GET", `/work-orders/${workOrderId}/media`, session, { propertyId: A.propertyB }), "Orden de trabajo no encontrada.");
    expect404(await call("GET", `/work-orders/media/${mediaId}`, session, { propertyId: A.propertyB }), "Archivo del parte no encontrado.");
    // Con la cabecera del hotel A (fuera de su ámbito) el hook global de server.ts ya responde 404 antes del handler.
    assert.equal((await call("GET", `/work-orders/${workOrderId}/media`, session, { propertyId: A.propertyA })).status, 404);
    // El técnico del hotel A con su propiedad activa sigue leyendo metadatos y bytes.
    assert.equal((await call("GET", `/work-orders/${workOrderId}/media`, maintenance, { propertyId: A.propertyA })).status, 200);
    assert.equal((await call("GET", `/work-orders/media/${mediaId}`, maintenance, { propertyId: A.propertyA })).status, 200);
  });
});

describe("UX-3 M1 · (4) adjuntar después de crear (D3)", () => {
  it("la camarera → 403 maintenance.workorder.manage; el técnico → 201 hasta 3 fotos en línea, la cuarta → 400 WORK_ORDER_PHOTOS_TOO_MANY", async () => {
    expect403(await call("POST", `/work-orders/${workOrderId}/media`, housekeeper, { propertyId: A.propertyA, payload: photo(JPEG, "image/jpeg") }), "maintenance.workorder.manage");

    const second = await call("POST", `/work-orders/${workOrderId}/media`, maintenance, { propertyId: A.propertyA, payload: photo(JPEG, "image/jpeg") });
    assert.equal(second.status, 201, second.raw.slice(0, 300));
    assert.equal(second.body.mimeType, "image/jpeg");
    assert.equal(second.body.sizeBytes, JPEG.length);
    assert.equal(second.body.inline, true);
    assert.equal(second.body.createdBy, maintenance.userId);

    const third = await call("POST", `/work-orders/${workOrderId}/media`, maintenance, { propertyId: A.propertyA, payload: { ...photo(WEBP, "image/webp"), mediaType: "photo" } });
    assert.equal(third.status, 201, third.raw.slice(0, 300));
    assert.equal(third.body.mimeType, "image/webp");

    expect400(await call("POST", `/work-orders/${workOrderId}/media`, maintenance, { propertyId: A.propertyA, payload: photo(PNG, "image/png") }), "WORK_ORDER_PHOTOS_TOO_MANY");
    assert.equal(await prisma.workOrderMedia.count({ where: { workOrderId } }), 3);

    const list = await call("GET", `/work-orders/${workOrderId}/media`, maintenance, { propertyId: A.propertyA });
    assert.deepEqual(
      list.body.map((m: { mimeType: string }) => m.mimeType),
      ["image/png", "image/jpeg", "image/webp"],
      "orden de alta"
    );
    const dashboard = await call("GET", `/dashboards/maintenance-mobile?propertyId=${A.propertyA}`, maintenance, { propertyId: A.propertyA });
    const item = (dashboard.body.items as Array<{ workOrderId: string; mediaCount: number }>).find((row) => row.workOrderId === workOrderId);
    assert.equal(item?.mediaCount, 3);
  });

  it("una foto en línea con mediaType video → 400; contentBase64 sin mimeType admitido → 400 WORK_ORDER_PHOTO_MIME_NOT_ALLOWED", async () => {
    const video = await call("POST", `/work-orders/${workOrderId}/media`, maintenance, { propertyId: A.propertyA, payload: { ...photo(JPEG, "image/jpeg"), mediaType: "video" } });
    assert.equal(video.status, 400, video.raw.slice(0, 300));
    expect400(await call("POST", `/work-orders/${workOrderId}/media`, maintenance, { propertyId: A.propertyA, payload: photo(JPEG, "image/gif") }), "WORK_ORDER_PHOTO_MIME_NOT_ALLOWED");
  });
});

describe("UX-3 M1 · (5) guardas del cuerpo y compatibilidad", () => {
  it("> 3 fotos, html disfrazado de png, tipo no admitido y photos que no es lista → 400 con details.code y SIN parte creado", async () => {
    const before = await prisma.workOrder.count({ where: { propertyId: A.propertyA } });
    const cases: Array<[unknown, string]> = [
      [Array.from({ length: 4 }, () => photo(PNG, "image/png")), "WORK_ORDER_PHOTOS_TOO_MANY"],
      [[photo(HTML, "image/png")], "WORK_ORDER_PHOTO_CONTENT_MISMATCH"],
      [[photo(PNG, "image/svg+xml")], "WORK_ORDER_PHOTO_MIME_NOT_ALLOWED"],
      [[{ contentBase64: "", mimeType: "image/png" }], "WORK_ORDER_PHOTO_EMPTY"],
      [[{ contentBase64: "no*base64", mimeType: "image/png" }], "WORK_ORDER_PHOTO_BASE64_INVALID"],
      ["foto", "WORK_ORDER_PHOTOS_INVALID"]
    ];
    for (const [photos, code] of cases) {
      const reply = await call("POST", "/work-orders", housekeeper, {
        propertyId: A.propertyA,
        payload: { roomNumber: "103", title: `Hab. 103: rechazada ${code}`, priority: "normal", blocksRoom: false, photos }
      });
      expect400(reply, code);
    }
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), before, "ninguna guarda dejó un parte a medias");
  });

  it("una foto > 1,5 MiB → 400 WORK_ORDER_PHOTO_TOO_LARGE; tres fotos de 1,5 MiB caben en el bodyLimit (6 MiB + envoltura JSON) → 201", async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(1_572_864 + 1 - JPEG.length, 0x2a)]);
    expect400(
      await call("POST", "/work-orders", housekeeper, { propertyId: A.propertyA, payload: { title: `Grande ${RUN}`, priority: "normal", blocksRoom: false, photos: [photo(big, "image/jpeg")] } }),
      "WORK_ORDER_PHOTO_TOO_LARGE"
    );
    const limit = Buffer.concat([JPEG, Buffer.alloc(1_572_864 - JPEG.length, 0x2a)]);
    const three = await call("POST", "/work-orders", housekeeper, {
      propertyId: A.propertyA,
      payload: { roomNumber: "103", title: `Hab. 103: tres fotos ${RUN}`, priority: "normal", blocksRoom: false, photos: [photo(limit, "image/jpeg"), photo(limit, "image/jpeg"), photo(limit, "image/jpeg")] }
    });
    assert.equal(three.status, 201, three.raw.slice(0, 300));
    assert.equal(three.body.media.length, 3);
    const stored = await prisma.workOrderMedia.aggregate({ where: { workOrderId: three.body.id }, _sum: { sizeBytes: true }, _count: { id: true } });
    assert.equal(stored._count.id, 3);
    assert.equal(stored._sum.sizeBytes, 3 * 1_572_864);
  });

  it("(6) cuatro POST …/media concurrentes sobre un parte sin fotos → 3 × 201 + 1 × 400 WORK_ORDER_PHOTOS_TOO_MANY y exactamente 3 filas (REV-L03)", async () => {
    const created = await call("POST", "/work-orders", maintenance, {
      propertyId: A.propertyA,
      payload: { roomNumber: "102", title: `Hab. 102: concurrencia ${RUN}`, priority: "normal", blocksRoom: false }
    });
    assert.equal(created.status, 200, created.raw.slice(0, 300));
    const replies = await Promise.all(
      Array.from({ length: 4 }, () => call("POST", `/work-orders/${created.body.id}/media`, maintenance, { propertyId: A.propertyA, payload: photo(JPEG, "image/jpeg") }))
    );
    const statuses = replies.map((reply) => reply.status).sort();
    assert.deepEqual(statuses, [201, 201, 201, 400], replies.map((reply) => reply.raw.slice(0, 120)).join(" | "));
    assert.equal(replies.find((reply) => reply.status === 400)?.body?.details?.code, "WORK_ORDER_PHOTOS_TOO_MANY");
    assert.equal(await prisma.workOrderMedia.count({ where: { workOrderId: created.body.id } }), 3, "nunca una cuarta fila en línea");
  });

  it("{ objectKey } sigue creando una fila legacy (200, inline false) que GET /work-orders/media/:id no sirve (404 WORK_ORDER_MEDIA_NOT_INLINE)", async () => {
    const classic = await call("POST", "/work-orders", maintenance, {
      propertyId: A.propertyA,
      payload: { roomNumber: "102", title: `Hab. 102: legacy ${RUN}`, priority: "normal", blocksRoom: false }
    });
    assert.equal(classic.status, 200, classic.raw.slice(0, 300));
    const legacy = await call("POST", `/work-orders/${classic.body.id}/media`, maintenance, { propertyId: A.propertyA, payload: { objectKey: `s3://bucket/${RUN}.jpg`, mediaType: "photo" } });
    assert.equal(legacy.status, 200, legacy.raw.slice(0, 300));
    assert.equal(legacy.body.objectKey, `s3://bucket/${RUN}.jpg`);
    assert.equal(legacy.body.inline, false);
    assert.equal(legacy.body.mimeType, null);
    const list = await call("GET", `/work-orders/${classic.body.id}/media`, maintenance, { propertyId: A.propertyA });
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].inline, false);
    const served = await call("GET", `/work-orders/media/${legacy.body.id}`, maintenance, { propertyId: A.propertyA });
    assert.equal(served.status, 404, served.raw.slice(0, 300));
    assert.equal(served.body?.details?.code, "WORK_ORDER_MEDIA_NOT_INLINE");
  });
});

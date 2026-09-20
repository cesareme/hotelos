// Tanda UX-3 · lote M1 (diseño §4.6, D2/D3): fotos del parte sin base de datos.
// Cubre las guardas de cuerpo (número, tamaño, tipo por magic bytes, base64) y la
// unidad de escritura parte + medios (persistWorkOrderWithPhotos) con un doble de
// transacción que solo confirma si la función resuelve. Desde apps/api:
//   node --import tsx --test src/modules/maintenance/__tests__/work-order-media.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildInlineMediaRows,
  parseWorkOrderPhoto,
  parseWorkOrderPhotos,
  persistWorkOrderWithPhotos,
  sniffWorkOrderPhotoMime,
  WORK_ORDER_MEDIA_INLINE_PREFIX,
  WORK_ORDER_PHOTO_MAX_BYTES,
  WORK_ORDER_PHOTO_MAX_COUNT,
  WORK_ORDER_PHOTOS_BODY_LIMIT,
  type WorkOrderInlineMediaRow,
  type WorkOrderWriteClient
} from "../maintenance.service.js";

const code = (error: unknown) => (error as { details?: { code?: string } }).details?.code;
const status = (error: unknown) => (error as { statusCode?: number }).statusCode;

/** PNG 1×1 real (67 bytes). */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_B64, "base64");
/** Cabecera JFIF + relleno: solo importan los magic bytes. */
const jpegOf = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(Math.max(0, size - 11), 0x2a)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 "), Buffer.alloc(10)]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>");
const photo = (bytes: Buffer, mimeType: string) => ({ contentBase64: bytes.toString("base64"), mimeType });

describe("sniffWorkOrderPhotoMime · magic bytes", () => {
  it("reconoce jpeg, png y webp; rechaza pdf, html y un RIFF que no es WEBP", () => {
    assert.equal(sniffWorkOrderPhotoMime(jpegOf(64)), "image/jpeg");
    assert.equal(sniffWorkOrderPhotoMime(PNG), "image/png");
    assert.equal(sniffWorkOrderPhotoMime(WEBP), "image/webp");
    assert.equal(sniffWorkOrderPhotoMime(Buffer.from("%PDF-1.4")), null);
    assert.equal(sniffWorkOrderPhotoMime(HTML), null);
    assert.equal(sniffWorkOrderPhotoMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])), null);
    assert.equal(sniffWorkOrderPhotoMime(Buffer.alloc(0)), null);
  });
});

describe("parseWorkOrderPhotos · número", () => {
  it("ausente → [] y una lista de hasta 3 fotos válidas se decodifica en orden", () => {
    assert.deepEqual(parseWorkOrderPhotos(undefined), []);
    assert.deepEqual(parseWorkOrderPhotos(null), []);
    const parsed = parseWorkOrderPhotos([photo(PNG, "image/png"), photo(jpegOf(100), "image/jpeg"), photo(WEBP, "image/webp")]);
    assert.deepEqual(
      parsed.map((p) => [p.mimeType, p.sizeBytes]),
      [
        ["image/png", PNG.length],
        ["image/jpeg", 100],
        ["image/webp", WEBP.length]
      ]
    );
    assert.ok(parsed[0]!.bytes.equals(PNG));
  });

  it("más de 3 → 400 WORK_ORDER_PHOTOS_TOO_MANY (sin decodificar ninguna)", () => {
    assert.equal(WORK_ORDER_PHOTO_MAX_COUNT, 3);
    const four = Array.from({ length: 4 }, () => photo(PNG, "image/png"));
    assert.throws(() => parseWorkOrderPhotos(four), (error: unknown) => status(error) === 400 && code(error) === "WORK_ORDER_PHOTOS_TOO_MANY");
  });

  it("photos que no es lista, o un elemento que no es objeto → 400 WORK_ORDER_PHOTOS_INVALID con la posición", () => {
    assert.throws(() => parseWorkOrderPhotos("foto"), (error: unknown) => code(error) === "WORK_ORDER_PHOTOS_INVALID");
    assert.throws(() => parseWorkOrderPhotos({ contentBase64: PNG_B64, mimeType: "image/png" }), (error: unknown) => code(error) === "WORK_ORDER_PHOTOS_INVALID");
    assert.throws(
      () => parseWorkOrderPhotos([photo(PNG, "image/png"), "x"]),
      (error: unknown) => code(error) === "WORK_ORDER_PHOTOS_INVALID" && (error as { details: { position: number } }).details.position === 2
    );
    assert.throws(() => parseWorkOrderPhotos([{ contentBase64: 12, mimeType: "image/png" }]), (error: unknown) => code(error) === "WORK_ORDER_PHOTOS_INVALID");
  });
});

describe("parseWorkOrderPhoto · tipo", () => {
  it("solo jpeg | png | webp; el MIME declarado se normaliza (mayúsculas y parámetros)", () => {
    assert.equal(parseWorkOrderPhoto(photo(PNG, "Image/PNG; charset=binary")).mimeType, "image/png");
    for (const mime of ["image/gif", "image/svg+xml", "application/pdf", "text/html", "", "image/tiff"]) {
      assert.throws(() => parseWorkOrderPhoto(photo(PNG, mime)), (error: unknown) => status(error) === 400 && code(error) === "WORK_ORDER_PHOTO_MIME_NOT_ALLOWED", mime);
    }
  });

  it("los bytes mandan: png declarado jpeg, html disfrazado de png y un pdf declarado webp → 400 WORK_ORDER_PHOTO_CONTENT_MISMATCH", () => {
    assert.throws(() => parseWorkOrderPhoto(photo(PNG, "image/jpeg")), (error: unknown) => code(error) === "WORK_ORDER_PHOTO_CONTENT_MISMATCH");
    assert.throws(
      () => parseWorkOrderPhoto(photo(HTML, "image/png")),
      (error: unknown) => code(error) === "WORK_ORDER_PHOTO_CONTENT_MISMATCH" && (error as { details: { sniffed: unknown } }).details.sniffed === null
    );
    assert.throws(() => parseWorkOrderPhoto(photo(Buffer.from("%PDF-1.7 x"), "image/webp")), (error: unknown) => code(error) === "WORK_ORDER_PHOTO_CONTENT_MISMATCH");
  });
});

describe("parseWorkOrderPhoto · tamaño y base64", () => {
  it("1,5 MiB exactos pasan; un byte más → 400 WORK_ORDER_PHOTO_TOO_LARGE", () => {
    assert.equal(WORK_ORDER_PHOTO_MAX_BYTES, 1_572_864);
    const limit = parseWorkOrderPhoto(photo(jpegOf(WORK_ORDER_PHOTO_MAX_BYTES), "image/jpeg"));
    assert.equal(limit.sizeBytes, WORK_ORDER_PHOTO_MAX_BYTES);
    assert.throws(
      () => parseWorkOrderPhoto(photo(jpegOf(WORK_ORDER_PHOTO_MAX_BYTES + 1), "image/jpeg")),
      (error: unknown) => status(error) === 400 && code(error) === "WORK_ORDER_PHOTO_TOO_LARGE"
    );
  });

  it("un base64 desmesurado se rechaza por longitud ANTES de decodificar (sin reservar memoria)", () => {
    const huge = { contentBase64: "A".repeat(3 * 1024 * 1024), mimeType: "image/jpeg" };
    const originalFrom = Buffer.from;
    let decoded = false;
    (Buffer as unknown as { from: unknown }).from = (...args: unknown[]) => {
      if (args[1] === "base64") decoded = true;
      return (originalFrom as (...a: unknown[]) => Buffer).apply(Buffer, args);
    };
    try {
      assert.throws(() => parseWorkOrderPhoto(huge), (error: unknown) => code(error) === "WORK_ORDER_PHOTO_TOO_LARGE");
    } finally {
      (Buffer as unknown as { from: unknown }).from = originalFrom;
    }
    assert.equal(decoded, false, "no se llamó a Buffer.from(…, \"base64\")");
  });

  it("vacío → WORK_ORDER_PHOTO_EMPTY; caracteres fuera del alfabeto → WORK_ORDER_PHOTO_BASE64_INVALID; el prefijo data: y los saltos de línea se toleran", () => {
    assert.throws(() => parseWorkOrderPhoto({ contentBase64: "", mimeType: "image/png" }), (error: unknown) => code(error) === "WORK_ORDER_PHOTO_EMPTY");
    assert.throws(() => parseWorkOrderPhoto({ contentBase64: "data:image/png;base64,", mimeType: "image/png" }), (error: unknown) => code(error) === "WORK_ORDER_PHOTO_EMPTY");
    assert.throws(() => parseWorkOrderPhoto({ contentBase64: "iVBOR*w0KGgo", mimeType: "image/png" }), (error: unknown) => code(error) === "WORK_ORDER_PHOTO_BASE64_INVALID");
    const dataUrl = parseWorkOrderPhoto({ contentBase64: `data:image/png;base64,${PNG_B64}`, mimeType: "image/png" });
    assert.ok(dataUrl.bytes.equals(PNG));
    const wrapped = parseWorkOrderPhoto({ contentBase64: `${PNG_B64.slice(0, 20)}\n${PNG_B64.slice(20)}\n`, mimeType: "image/png" });
    assert.ok(wrapped.bytes.equals(PNG));
  });

  it("el bodyLimit de la ruta cubre 3 fotos de 1,5 MiB en base64 MÁS la envoltura JSON", () => {
    const threeInBase64 = 3 * Math.ceil(WORK_ORDER_PHOTO_MAX_BYTES / 3) * 4;
    assert.equal(threeInBase64, 6 * 1024 * 1024, "tres fotos al tope son exactamente 6 MiB en base64");
    assert.ok(WORK_ORDER_PHOTOS_BODY_LIMIT - threeInBase64 >= 16 * 1024, `margen para el JSON: ${WORK_ORDER_PHOTOS_BODY_LIMIT - threeInBase64} bytes`);
    assert.equal(WORK_ORDER_PHOTOS_BODY_LIMIT, 6 * 1024 * 1024 + 64 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Unidad de escritura parte + medios
// ---------------------------------------------------------------------------

type OrderRow = Parameters<WorkOrderWriteClient["workOrder"]["create"]>[0]["data"] & { id: string; createdAt: Date; resolvedAt: null; assignedTo: null };

/** Doble de Prisma con «transacción»: las escrituras van a un borrador y solo se confirman si la función resuelve. */
function fakeDb(options: { failMedia?: boolean } = {}) {
  const committed = { orders: [] as OrderRow[], media: [] as WorkOrderInlineMediaRow[] };
  let seq = 0;
  const staged = { orders: [] as OrderRow[], media: [] as WorkOrderInlineMediaRow[] };
  const calls: string[] = [];
  const tx: WorkOrderWriteClient = {
    workOrder: {
      async create({ data }) {
        calls.push("workOrder.create");
        const row = { ...data, id: `wo_${++seq}`, createdAt: new Date("2026-09-20T10:00:00.000Z"), resolvedAt: null, assignedTo: null };
        staged.orders.push(row);
        return row;
      }
    },
    workOrderMedia: {
      async createMany({ data }) {
        calls.push(`workOrderMedia.createMany(${data.length})`);
        if (options.failMedia) throw new Error("boom: work_order_media");
        staged.media.push(...data);
        return { count: data.length };
      }
    }
  };
  async function $transaction<T>(run: (client: WorkOrderWriteClient) => Promise<T>): Promise<T> {
    try {
      const result = await run(tx);
      committed.orders.push(...staged.orders);
      committed.media.push(...staged.media);
      return result;
    } finally {
      staged.orders.length = 0;
      staged.media.length = 0;
    }
  }
  return { tx, $transaction, committed, calls };
}

const DATA = {
  propertyId: "prop_ux3",
  roomId: "room_203",
  title: "Hab. 203: Fuga de agua",
  description: null,
  priority: "urgent" as const,
  status: "open" as const,
  blocksRoom: false,
  createdBy: "usr_camarera"
};

describe("buildInlineMediaRows", () => {
  it("una fila por foto con id propio, objectKey inline://…/<id>, base64, mime, tamaño y autor", () => {
    const photos = parseWorkOrderPhotos([photo(PNG, "image/png"), photo(WEBP, "image/webp")]);
    const now = new Date("2026-09-20T09:30:00.000Z");
    const rows = buildInlineMediaRows("wo_1", photos, "usr_camarera", now);
    assert.equal(rows.length, 2);
    for (const [index, row] of rows.entries()) {
      assert.match(row.id, /^wom_[0-9a-f]{16}$/);
      assert.equal(row.objectKey, `${WORK_ORDER_MEDIA_INLINE_PREFIX}${row.id}`);
      assert.equal(row.workOrderId, "wo_1");
      assert.equal(row.mediaType, "photo");
      assert.equal(row.contentBase64, photos[index]!.bytes.toString("base64"));
      assert.equal(row.mimeType, photos[index]!.mimeType);
      assert.equal(row.sizeBytes, photos[index]!.sizeBytes);
      assert.equal(row.createdAt, now);
      assert.equal(row.createdBy, "usr_camarera");
    }
    assert.notEqual(rows[0]!.id, rows[1]!.id);
  });
});

describe("persistWorkOrderWithPhotos · transacción", () => {
  it("con fotos: crea el parte y las N filas de medios en la misma unidad; los metadatos devueltos no llevan bytes", async () => {
    const db = fakeDb();
    const photos = parseWorkOrderPhotos([photo(PNG, "image/png"), photo(jpegOf(50), "image/jpeg"), photo(WEBP, "image/webp")]);
    const result = await db.$transaction((tx) => persistWorkOrderWithPhotos(tx, { data: DATA, photos, createdBy: "usr_camarera" }));
    assert.deepEqual(db.calls, ["workOrder.create", "workOrderMedia.createMany(3)"]);
    assert.equal(result.order.id, "wo_1");
    assert.equal(result.media.length, 3);
    assert.equal(db.committed.orders.length, 1);
    assert.equal(db.committed.media.length, 3);
    assert.ok(db.committed.media.every((row) => row.workOrderId === "wo_1"));
    for (const meta of result.media) {
      assert.equal(meta.inline, true);
      assert.equal(meta.createdBy, "usr_camarera");
      assert.equal(typeof meta.createdAt, "string");
      assert.ok(!("contentBase64" in meta), "los metadatos no llevan contentBase64");
      assert.ok(!("bytes" in meta));
    }
    assert.deepEqual(
      result.media.map((m) => m.mimeType),
      ["image/png", "image/jpeg", "image/webp"]
    );
  });

  it("sin fotos: solo el parte (no se llama a createMany) y media = []", async () => {
    const db = fakeDb();
    const result = await persistWorkOrderWithPhotos(db.tx, { data: DATA, photos: [], createdBy: "usr_camarera" });
    assert.deepEqual(db.calls, ["workOrder.create"]);
    assert.deepEqual(result.media, []);
  });

  it("si la inserción de medios falla, la función rechaza y la transacción NO confirma el parte (nunca un parte con fotos a medias)", async () => {
    const db = fakeDb({ failMedia: true });
    const photos = parseWorkOrderPhotos([photo(PNG, "image/png")]);
    await assert.rejects(
      db.$transaction((tx) => persistWorkOrderWithPhotos(tx, { data: DATA, photos, createdBy: "usr_camarera" })),
      /boom: work_order_media/
    );
    assert.deepEqual(db.calls, ["workOrder.create", "workOrderMedia.createMany(1)"]);
    assert.equal(db.committed.orders.length, 0, "el parte no se confirmó");
    assert.equal(db.committed.media.length, 0);
  });

  it("un createMany que inserta menos filas de las pedidas también aborta la unidad", async () => {
    const db = fakeDb();
    const flaky: WorkOrderWriteClient = {
      workOrder: db.tx.workOrder,
      workOrderMedia: { createMany: async ({ data }) => ({ count: data.length - 1 }) }
    };
    const photos = parseWorkOrderPhotos([photo(PNG, "image/png"), photo(WEBP, "image/webp")]);
    await assert.rejects(
      db.$transaction(() => persistWorkOrderWithPhotos(flaky, { data: DATA, photos, createdBy: "usr_camarera" })),
      /se esperaban 2 filas y se insertaron 1/
    );
    assert.equal(db.committed.orders.length, 0);
  });
});

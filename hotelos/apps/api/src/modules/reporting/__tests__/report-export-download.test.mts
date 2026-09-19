// Unit tests · corrector FIX-1 (SEC-06) — el fichero de una exportación del Centro de informes
// (`getReportExportFile`) solo se sirve dentro de la organización Y del ámbito de propiedad del
// actor (R11); fuera, el mismo 404 opaco. Sin base de datos: el almacén es un Map en memoria.
// Desde apps/api:
//   node --import tsx --test src/modules/reporting/__tests__/report-export-download.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PermissionDeniedError } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import { REPORT_EXPORT_STORE, REPORT_EXPORT_TTL_MS, getReportExportFile, type StoredReportExport } from "../reporting.service.js";

const ORG = "org_rep_test";
const PROP_A = "prop_rep_a";
const PROP_B = "prop_rep_b";
const ID = "report_export_unit_sec06";

const base = { organizationId: ORG, propertyId: PROP_A, userId: "usr_rep", fullName: "Dirección Test", deviceId: "rep-test", permissions: ["analytics.export"], orgScope: true } as unknown as UserContext;
const entry = (): StoredReportExport => ({ organizationId: ORG, propertyId: PROP_A, filename: "informe.csv", contentType: "text/csv;charset=utf-8", content: "a;b\n1;2\n", expiresAt: Date.now() + REPORT_EXPORT_TTL_MS });

const expect404 = (context: UserContext, why: string): void => {
  assert.throws(
    () => getReportExportFile({ context, exportId: ID }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404 && error.message === "Exportación no encontrada o caducada.",
    why
  );
};

describe("SEC-06 · getReportExportFile: organización y ámbito de propiedad", () => {
  afterEach(() => {
    REPORT_EXPORT_STORE.delete(ID);
  });

  it("sirve el fichero al actor de la organización con ámbito de toda la organización, con la propiedad asignada o como administrador de plataforma", () => {
    REPORT_EXPORT_STORE.set(ID, entry());
    assert.equal(getReportExportFile({ context: base, exportId: ID }).filename, "informe.csv");
    assert.equal(getReportExportFile({ context: { ...base, assignedPropertyIds: [PROP_A], orgScope: false } as unknown as UserContext, exportId: ID }).content, "a;b\n1;2\n");
    assert.equal(getReportExportFile({ context: { ...base, assignedPropertyIds: [], orgScope: false, isPlatformAdmin: true } as unknown as UserContext, exportId: ID }).filename, "informe.csv");
  });

  it("404 opaco: otra organización, propiedad fuera del ámbito del actor (solo la B asignada) o asignaciones vacías sin ámbito de organización", () => {
    REPORT_EXPORT_STORE.set(ID, entry());
    expect404({ ...base, organizationId: "org_otra" } as unknown as UserContext, "otra organización");
    expect404({ ...base, assignedPropertyIds: [PROP_B], orgScope: false } as unknown as UserContext, "solo la propiedad B asignada");
    expect404({ ...base, assignedPropertyIds: [], orgScope: false } as unknown as UserContext, "sesión real sin asignaciones");
    assert.ok(REPORT_EXPORT_STORE.has(ID), "una lectura denegada no borra el artefacto");
  });

  it("sin analytics.export → 403 antes de mirar el almacén; caducada → 404 y se poda", () => {
    REPORT_EXPORT_STORE.set(ID, entry());
    assert.throws(() => getReportExportFile({ context: { ...base, permissions: ["analytics.read"] } as unknown as UserContext, exportId: ID }), (error: unknown) => error instanceof PermissionDeniedError);
    REPORT_EXPORT_STORE.set(ID, { ...entry(), expiresAt: Date.now() - 1 });
    expect404(base, "caducada");
    assert.equal(REPORT_EXPORT_STORE.has(ID), false, "la entrada caducada se poda al leerla");
  });
});

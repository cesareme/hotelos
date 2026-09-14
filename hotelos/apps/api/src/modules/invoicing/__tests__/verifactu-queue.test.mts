// Unit tests for the pure helpers of the VeriFactu queue (Tanda 3): routing
// by fiscal territory / canonical region, Desglose fallback for pre-Tanda-3
// invoices, status mapping of AEAT/transport responses, submittability,
// Destinatarios resolution (cierre) and the chain order of legacy
// cancellations. No database. Run from apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/verifactu-queue.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chainTailIsAnulacion,
  desgloseForInvoice,
  finalStatusForResponse,
  orderLegacyCancellations,
  resolveVerifactuRecipient,
  sortByGeneration,
  submissionRouteForProperty,
  submissionRouteForRegion,
  unsubmittableReason
} from "../verifactu-submission.service.js";

const dec = (n: number) => ({ toString: () => String(n) });

describe("submissionRouteForProperty — Canarias goes to VeriFactu, foral territories to TicketBAI", () => {
  it("routes the demo properties (Madrid alias, canary) to VeriFactu with their canonical region", () => {
    assert.deepEqual(submissionRouteForProperty({ taxRegion: "Madrid" }), { route: "verifactu", territory: null, taxRegion: "ES_PENINSULA_BALEARES" });
    assert.deepEqual(submissionRouteForProperty({ taxRegion: "canary" }), { route: "verifactu", territory: null, taxRegion: "ES_CANARIAS" });
  });

  it("derives the region from the province when taxRegion is unset, and leaves null when nothing is known", () => {
    assert.equal(submissionRouteForProperty({ taxRegion: null, province: "Las Palmas" }).taxRegion, "ES_CANARIAS");
    assert.equal(submissionRouteForProperty({ taxRegion: null, province: "Ceuta" }).taxRegion, "ES_CEUTA");
    assert.deepEqual(submissionRouteForProperty({ taxRegion: null }), { route: "verifactu", territory: null, taxRegion: null });
  });

  it("uses Property.fiscalTerritory first and the legacy taxRegion value as fallback", () => {
    assert.deepEqual(submissionRouteForProperty({ taxRegion: "mainland", fiscalTerritory: "bizkaia" }), { route: "tbai", territory: "bizkaia", taxRegion: null });
    assert.deepEqual(submissionRouteForProperty({ taxRegion: "gipuzkoa" }), { route: "tbai", territory: "gipuzkoa", taxRegion: null });
    assert.equal(submissionRouteForProperty({ taxRegion: "araba", fiscalTerritory: " ARABA " }).territory, "araba");
    // Navarra is foral but has no TicketBAI: common VeriFactu route, unknown region.
    assert.equal(submissionRouteForProperty({ taxRegion: null, fiscalTerritory: "navarra" }).route, "verifactu");
    assert.equal(submissionRouteForProperty({ taxRegion: "mainland", fiscalTerritory: "common" }).route, "verifactu");
  });

  it("legacy string helper never answers igic any more", () => {
    assert.equal(submissionRouteForRegion("canary"), "verifactu");
    assert.equal(submissionRouteForRegion("bizkaia"), "tbai");
    assert.equal(submissionRouteForRegion(null), "verifactu");
  });
});

describe("desgloseForInvoice — persisted breakdown first, per-line fallback for legacy invoices", () => {
  it("returns Invoice.taxBreakdownJson untouched when it is a valid contract-B array", () => {
    const groups = [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 110, quota: 11 }];
    const result = desgloseForInvoice({ taxBreakdownJson: groups }, [], "ES_PENINSULA_BALEARES");
    assert.equal(result.source, "breakdown");
    assert.deepEqual(result.groups, groups);
  });

  it("rebuilds the Desglose from legacy lines: ES_IGIC_7 → Impuesto 03, grouped with per-group rounding", () => {
    const result = desgloseForInvoice(
      { taxBreakdownJson: null },
      [
        { taxCode: "ES_IGIC_7", taxRate: dec(7), total: dec(107) },
        { taxCode: "ES_IGIC_7", taxRate: dec(7), total: dec(53.5) },
        { taxCode: "ES_IGIC_N1", taxRate: dec(0), total: dec(20) }
      ],
      "ES_CANARIAS"
    );
    assert.equal(result.source, "lines");
    assert.deepEqual(result.groups, [
      { figure: "IGIC", impuesto: "03", calificacion: "S1", ratePercent: 7, base: 150, quota: 10.5 },
      { figure: "IGIC", impuesto: "03", calificacion: "N1", ratePercent: 0, base: 20, quota: 0 }
    ]);
  });

  it("uses the line's taxFigure/taxCalificacion columns when present and the region for unknown codes", () => {
    const result = desgloseForInvoice(
      { taxBreakdownJson: [] },
      [
        { taxCode: "ES_UNKNOWN_0", taxRate: dec(2), total: dec(102), taxFigure: "IPSI", taxCalificacion: "S1" },
        { taxCode: "ES_UNKNOWN_0", taxRate: dec(0), total: dec(30), taxFigure: null, taxCalificacion: "N1" }
      ],
      "ES_MELILLA"
    );
    assert.deepEqual(result.groups, [
      { figure: "IPSI", impuesto: "02", calificacion: "S1", ratePercent: 2, base: 100, quota: 2 },
      { figure: "IPSI", impuesto: "02", calificacion: "N1", ratePercent: 0, base: 30, quota: 0 }
    ]);
  });

  it("falls back to IVA (peninsula) when neither the code nor the region is known", () => {
    const result = desgloseForInvoice({ taxBreakdownJson: "garbage" }, [{ taxCode: "ES_UNKNOWN_0", taxRate: dec(0), total: dec(50) }], null);
    assert.deepEqual(result.groups, [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 0, base: 50, quota: 0 }]);
  });
});

describe("finalStatusForResponse — rejected is reserved for AEAT, transport/config failures retry", () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);

  it("maps accepted / accepted_with_errors without a retry", () => {
    assert.deepEqual(finalStatusForResponse({ status: "accepted" }, now), { status: "accepted", nextRetryAt: null });
    assert.deepEqual(finalStatusForResponse({ status: "accepted_with_errors", errorCode: "3002" }, now), { status: "accepted_with_errors", nextRetryAt: null });
  });

  it("keeps a real AEAT rejection terminal", () => {
    assert.deepEqual(finalStatusForResponse({ status: "rejected", errorCode: "1100" }, now), { status: "rejected", nextRetryAt: null });
    assert.deepEqual(finalStatusForResponse({ status: "rejected", errorCode: "HTTP_400" }, now), { status: "rejected", nextRetryAt: null });
  });

  it("retries network errors with the regular backoff and configuration gaps with the longer one", () => {
    const network = finalStatusForResponse({ status: "network_error", errorCode: "NETWORK_TIMEOUT" }, now);
    assert.equal(network.status, "retrying");
    assert.equal(network.nextRetryAt?.getTime(), now + 5 * 60_000);

    const rejectedNetwork = finalStatusForResponse({ status: "rejected", errorCode: "NETWORK_HTTP_503" }, now);
    assert.equal(rejectedNetwork.status, "retrying");

    const cert = finalStatusForResponse({ status: "rejected", errorCode: "CERT_NOT_CONFIGURED" }, now);
    assert.equal(cert.status, "retrying");
    assert.equal(cert.nextRetryAt?.getTime(), now + 15 * 60_000);

    const software = finalStatusForResponse({ status: "rejected", errorCode: "SOFTWARE_NOT_CONFIGURED" }, now);
    assert.equal(software.status, "retrying");
    assert.equal(software.nextRetryAt?.getTime(), now + 15 * 60_000);
  });
});

describe("unsubmittableReason — altas survive cancellation/rectification, anulaciones need a cancelled invoice", () => {
  const base = { status: "issued", verifactuHash: "H", invoiceNumber: "FAC-2026-000001", deletedAt: null, cancelledAt: null };

  it("alta: sendable for issued, cancelled and rectified invoices with a huella and a number", () => {
    assert.equal(unsubmittableReason(base, "alta"), null);
    assert.equal(unsubmittableReason({ ...base, status: "cancelled", cancelledAt: new Date() }, "alta"), null);
    assert.equal(unsubmittableReason({ ...base, status: "rectified" }, "alta"), null);
  });

  it("alta: refuses drafts, deleted invoices and invoices without huella/number", () => {
    assert.match(unsubmittableReason({ ...base, status: "draft" }, "alta") ?? "", /borrador/);
    assert.match(unsubmittableReason({ ...base, deletedAt: new Date() }, "alta") ?? "", /eliminada/);
    assert.match(unsubmittableReason({ ...base, verifactuHash: null }, "alta") ?? "", /huella/);
    assert.match(unsubmittableReason({ ...base, invoiceNumber: null }, "alta") ?? "", /número/);
    assert.match(unsubmittableReason(null, "alta") ?? "", /no existe/);
  });

  it("anulación: only for cancelled invoices with cancelledAt", () => {
    assert.match(unsubmittableReason(base, "anulacion") ?? "", /no anulada/);
    assert.match(unsubmittableReason({ ...base, status: "cancelled", cancelledAt: null }, "anulacion") ?? "", /no anulada/);
    assert.equal(unsubmittableReason({ ...base, status: "cancelled", cancelledAt: new Date() }, "anulacion"), null);
  });
});

// ── Destinatarios (Tanda 3 cierre) ───────────────────────────────────────────

describe("resolveVerifactuRecipient — Destinatarios from Invoice.customerName, never the NIF as the name", () => {
  it("anonymous / simplified invoice (no NIF): no recipient and no warning", () => {
    assert.deepEqual(resolveVerifactuRecipient({ customerTaxId: null, customerName: "Alguien" }, "Legacy Name"), { recipient: null, warning: null });
    assert.deepEqual(resolveVerifactuRecipient({ customerTaxId: "  " }, null), { recipient: null, warning: null });
  });

  it("uses the customerName snapshot first (trimmed) and normalises the NIF", () => {
    const resolved = resolveVerifactuRecipient({ customerTaxId: "es-a58818501", customerName: "  Acme & Co SL  " }, "Ignored Legacy");
    assert.deepEqual(resolved, { recipient: { name: "Acme & Co SL", taxId: "A58818501" }, warning: null });
  });

  it("falls back to the legacy folio/reservation name only when the snapshot is empty", () => {
    const resolved = resolveVerifactuRecipient({ customerTaxId: "12345678Z", customerName: "   " }, "María Pérez García");
    assert.deepEqual(resolved, { recipient: { name: "María Pérez García", taxId: "12345678Z" }, warning: null });
  });

  it("omits the block and warns when no name is resolvable — the NIF is never sent as NombreRazon", () => {
    const resolved = resolveVerifactuRecipient({ customerTaxId: "12345678Z", customerName: null }, null);
    assert.equal(resolved.recipient, null);
    assert.match(resolved.warning ?? "", /12345678Z/);
    assert.match(resolved.warning ?? "", /sin bloque Destinatarios/);
    assert.match(resolved.warning ?? "", /Indica el nombre o razón social del destinatario/);
  });

  it("a name that is just the NIF (legacy rows sent with NombreRazon = NIF) counts as no name", () => {
    assert.equal(resolveVerifactuRecipient({ customerTaxId: "A58818501", customerName: "a-588-18501" }, null).recipient, null);
    assert.equal(resolveVerifactuRecipient({ customerTaxId: "A58818501", customerName: null }, "A58818501").recipient, null);
  });
});

// ── Legacy cancellations: chain order (Tanda 3 cierre) ───────────────────────

// Faranda-shaped scenario (property chain, times as ms of one day):
// altas FAC-006 … FAC-013 issued in number order; five of them were cancelled
// BEFORE cancelInvoice computed anulación huellas, in this wall-clock order:
// 011 (12:53:21) → 012 (12:53:28) → 006 → 007 → 009 (12:59:40.285/.308/.328).
// Invoice ids (creation order) are 006 < 007 < 009 < 011 < 012.
type ChainRecord = { id: string; number: string; issuedAt: number; altaHash: string; cancelledAt: number | null; cancellationHash: string | null };

const T = (h: number, m: number, s: number, ms = 0) => Date.UTC(2026, 8, 14, h, m, s, ms);

function faranda(): ChainRecord[] {
  const make = (n: number, issuedAt: number, cancelledAt: number | null): ChainRecord => ({
    id: `inv_${String(n).padStart(3, "0")}`,
    number: `FAC-2026-${String(n).padStart(6, "0")}`,
    issuedAt,
    altaHash: `ALTA-${n}`,
    cancelledAt,
    cancellationHash: null
  });
  return [
    make(6, T(12, 8, 14), T(12, 59, 40, 285)),
    make(7, T(12, 9, 48), T(12, 59, 40, 308)),
    make(8, T(12, 20, 37), null),
    make(9, T(12, 23, 32), T(12, 59, 40, 328)),
    make(10, T(12, 24, 22), null),
    make(11, T(12, 52, 13), T(12, 53, 21)),
    make(12, T(12, 52, 21), T(12, 53, 28)),
    make(13, T(12, 52, 35), null)
  ];
}

// In-memory replica of chainTailBefore + prepareVerifactuAnulacion over the
// legacy set, driven by the real tail rule: for each anulación (in the given
// order) the previous record is the latest alta issued up to its cancelledAt
// or the latest OTHER anulación that already has a huella up to that instant.
function chainLegacyAnulaciones(records: ChainRecord[], order: string[]): Map<string, string> {
  const byId = new Map(records.map((r) => [r.id, r]));
  const previousOf = new Map<string, string>();
  for (const id of order) {
    const me = byId.get(id)!;
    const at = me.cancelledAt!;
    const alta = records.filter((r) => r.issuedAt <= at).sort((a, b) => b.issuedAt - a.issuedAt)[0] ?? null;
    const anulacion =
      records
        .filter((r) => r.id !== id && r.cancellationHash !== null && r.cancelledAt !== null && r.cancelledAt <= at)
        .sort((a, b) => b.cancelledAt! - a.cancelledAt!)[0] ?? null;
    const useAnulacion = chainTailIsAnulacion(alta?.issuedAt ?? null, anulacion?.cancelledAt ?? null);
    const previous = useAnulacion ? `anulacion:${anulacion!.number}` : alta ? `alta:${alta.number}` : "first";
    me.cancellationHash = `ANUL-${me.number}<-${previous}`;
    previousOf.set(id, previous);
  }
  return previousOf;
}

describe("legacy cancellations — chained in cancelled_at order, one RegistroAnterior per anulación", () => {
  const legacyRows = () =>
    faranda()
      .filter((r) => r.cancelledAt !== null)
      .map((r) => ({ id: r.id, propertyId: "prop_faranda", cancelledAt: new Date(r.cancelledAt!) }));

  it("orderLegacyCancellations sorts by cancelledAt then id, grouped per property in first-seen order", () => {
    const rows = [
      ...legacyRows(),
      { id: "inv_x2", propertyId: "prop_123", cancelledAt: new Date(T(12, 55, 0)) },
      { id: "inv_x1", propertyId: "prop_123", cancelledAt: new Date(T(12, 55, 0)) }
    ];
    const groups = orderLegacyCancellations(rows);
    assert.deepEqual(
      groups.map((g) => ({ propertyId: g.propertyId, ids: g.rows.map((r) => r.id) })),
      [
        { propertyId: "prop_faranda", ids: ["inv_011", "inv_012", "inv_006", "inv_007", "inv_009"] },
        { propertyId: "prop_123", ids: ["inv_x1", "inv_x2"] }
      ]
    );
    // Pure: the input order is untouched.
    assert.equal(rows[0]!.id, "inv_006");
  });

  it("processing in cancelled_at order links every anulación to the record generated right before it", () => {
    const records = faranda();
    const order = orderLegacyCancellations(legacyRows())[0]!.rows.map((r) => r.id);
    const previousOf = chainLegacyAnulaciones(records, order);
    assert.deepEqual(
      order.map((id) => [id, previousOf.get(id)]),
      [
        ["inv_011", "alta:FAC-2026-000013"],
        ["inv_012", "anulacion:FAC-2026-000011"],
        ["inv_006", "anulacion:FAC-2026-000012"],
        ["inv_007", "anulacion:FAC-2026-000006"],
        ["inv_009", "anulacion:FAC-2026-000007"]
      ]
    );
    const previous = Array.from(previousOf.values());
    assert.equal(new Set(previous).size, previous.length, "no two anulaciones may share a RegistroAnterior");
  });

  it("control: processing by invoice creation order (the row-less scan order) forks the chain", () => {
    const records = faranda();
    const creationOrder = ["inv_006", "inv_007", "inv_009", "inv_011", "inv_012"];
    const previousOf = chainLegacyAnulaciones(records, creationOrder);
    // 006 (cancelled 12:59) sees no chained anulación yet and takes alta 013;
    // 011 (cancelled 12:53) is processed afterwards and takes alta 013 too.
    assert.equal(previousOf.get("inv_006"), "alta:FAC-2026-000013");
    assert.equal(previousOf.get("inv_011"), "alta:FAC-2026-000013");
    const previous = Array.from(previousOf.values());
    assert.ok(new Set(previous).size < previous.length, "the old order produced two anulaciones on one RegistroAnterior");
  });

  it("chainTailIsAnulacion: the anulación is the tail only when strictly later than the latest alta", () => {
    assert.equal(chainTailIsAnulacion(null, null), false);
    assert.equal(chainTailIsAnulacion(100, null), false);
    assert.equal(chainTailIsAnulacion(null, 100), true);
    assert.equal(chainTailIsAnulacion(100, 101), true);
    assert.equal(chainTailIsAnulacion(100, 100), false);
    assert.equal(chainTailIsAnulacion(101, 100), false);
  });

  it("sortByGeneration interleaves altas (issuedAt) and anulaciones (cancelledAt) by instant, id as tie-breaker", () => {
    const rows = [
      { id: "b", registroType: "alta", generatedAt: new Date(T(12, 0, 5)) },
      { id: "a", registroType: "anulacion", generatedAt: new Date(T(12, 0, 5)) },
      { id: "c", registroType: "anulacion", generatedAt: new Date(T(12, 0, 1)) },
      { id: "d", registroType: "alta", generatedAt: new Date(T(12, 0, 9)) }
    ];
    assert.deepEqual(
      sortByGeneration(rows).map((r) => r.id),
      ["c", "a", "b", "d"]
    );
    assert.equal(rows[0]!.id, "b");
  });
});

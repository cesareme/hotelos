import { prisma } from "@hotelos/database";
import { demoStore, type UserContext } from "../../lib/demo-store.js";
import { createId, nowIso } from "../../lib/ids.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { getReservationFolio } from "../folio/folio.service.js";
import { listInvoices } from "../invoicing/invoice.service.js";

export type OperationalReportFormat = "pdf" | "csv" | "xlsx" | "json";
export type OperationalReportType = "reservation" | "billing" | "revenue" | "owner";

function requireProperty(propertyId: string) {
  if (!demoStore.properties.some((property) => property.id === propertyId)) {
    throw new Error("Property was not found.");
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function withinRange(iso: string | undefined, fromDate?: string, toDate?: string): boolean {
  if (!iso) return false;
  return (!fromDate || iso >= fromDate) && (!toDate || iso <= toDate);
}

function inRange(date: string, fromDate?: string, toDate?: string) {
  return (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
}

function sum(values: number[]) {
  return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
}

function countBy<T extends string>(values: T[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export function getReportCatalog(propertyId: string) {
  requireProperty(propertyId);
  return {
    propertyId,
    generatedAt: nowIso(),
    reports: [
      {
        code: "reservation_arrivals_departures",
        title: "Reservation arrivals and departures",
        permission: "analytics.read",
        endpoint: "/reports/properties/:propertyId/reservations",
        formats: ["pdf", "csv", "xlsx", "json"],
        inputs: ["fromDate", "toDate", "status", "channel", "marketSegment", "roomTypeId"],
        targetTables: ["reservations", "reservation_guests", "rooms", "room_types"]
      },
      {
        code: "billing_invoice_payment",
        title: "Billing, invoices and payments",
        permission: "analytics.read",
        endpoint: "/reports/properties/:propertyId/billing",
        formats: ["pdf", "csv", "xlsx", "json"],
        inputs: ["fromDate", "toDate", "invoiceStatus", "paymentMethod", "customerType"],
        targetTables: ["folios", "folio_lines", "payments", "invoices", "invoice_lines"]
      },
      {
        code: "revenue_history_forecast",
        title: "Revenue History & Forecast",
        permission: "revenue.history_forecast.read",
        endpoint: "/revenue/properties/:propertyId/history-forecast",
        formats: ["pdf", "csv", "xlsx", "json"],
        inputs: ["fromDate", "toDate", "granularity", "channel", "segment", "revenueMode"],
        targetTables: ["revenue_daily_snapshots", "revenue_forecast_snapshots", "revenue_report_views"]
      }
    ]
  };
}

export async function getReservationReport(propertyId: string, query: Record<string, unknown> = {}) {
  const fromDate = typeof query.fromDate === "string" ? query.fromDate : undefined;
  const toDate = typeof query.toDate === "string" ? query.toDate : undefined;
  const status = typeof query.status === "string" ? query.status : undefined;
  const channel = typeof query.channel === "string" ? query.channel : undefined;
  const marketSegment = typeof query.marketSegment === "string" ? query.marketSegment : undefined;
  const roomTypeId = typeof query.roomTypeId === "string" ? query.roomTypeId : undefined;

  const reservations = await prisma.reservation.findMany({
    where: {
      propertyId,
      ...(status ? { status: status as "draft" | "confirmed" | "checked_in" | "checked_out" | "cancelled" | "no_show" } : {}),
      ...(channel ? { channel } : {}),
      ...(marketSegment ? { marketSegment } : {}),
      ...(roomTypeId ? { roomTypeId } : {}),
      ...(fromDate || toDate
        ? {
            OR: [
              { arrivalDate: { gte: fromDate ? new Date(`${fromDate}T00:00:00.000Z`) : undefined, lte: toDate ? new Date(`${toDate}T23:59:59.000Z`) : undefined } },
              { departureDate: { gte: fromDate ? new Date(`${fromDate}T00:00:00.000Z`) : undefined, lte: toDate ? new Date(`${toDate}T23:59:59.000Z`) : undefined } }
            ]
          }
        : {})
    },
    orderBy: { arrivalDate: "asc" }
  });

  const roomTypeIds = Array.from(new Set(reservations.map((r) => r.roomTypeId).filter((id): id is string => Boolean(id))));
  const assignedRoomIds = Array.from(new Set(reservations.map((r) => r.assignedRoomId).filter((id): id is string => Boolean(id))));
  const [roomTypes, rooms, links] = await Promise.all([
    roomTypeIds.length ? prisma.roomType.findMany({ where: { id: { in: roomTypeIds } } }) : Promise.resolve([]),
    assignedRoomIds.length ? prisma.room.findMany({ where: { id: { in: assignedRoomIds } } }) : Promise.resolve([]),
    reservations.length ? prisma.reservationGuest.findMany({ where: { reservationId: { in: reservations.map((r) => r.id) }, isPrimary: true } }) : Promise.resolve([])
  ]);
  const guestIds = Array.from(new Set(links.map((l) => l.guestId)));
  const guests = guestIds.length ? await prisma.guest.findMany({ where: { id: { in: guestIds } } }) : [];

  const roomTypeById = new Map(roomTypes.map((r) => [r.id, r]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const primaryGuestByRes = new Map<string, string | undefined>(links.map((l) => [l.reservationId, l.guestId]));
  const guestById = new Map(guests.map((g) => [g.id, g]));

  const rows = reservations.map((r) => {
    const guestId = primaryGuestByRes.get(r.id);
    const guest = guestId ? guestById.get(guestId) : undefined;
    return {
      reservationId: r.id,
      code: r.code,
      status: r.status,
      guestName: guest ? [guest.firstName, guest.surname1, guest.surname2].filter(Boolean).join(" ") : r.bookerName ?? "Unassigned",
      arrivalDate: isoDate(r.arrivalDate),
      departureDate: isoDate(r.departureDate),
      roomType: r.roomTypeId ? roomTypeById.get(r.roomTypeId)?.name ?? r.roomTypeId : "",
      room: r.assignedRoomId ? roomById.get(r.assignedRoomId)?.number ?? "Unassigned" : "Unassigned",
      channel: r.channel,
      sourceCode: r.sourceCode ?? undefined,
      marketSegment: r.marketSegment ?? undefined,
      billingInstruction: r.billingInstruction ?? undefined,
      totalAmount: Number(r.totalAmount),
      currency: r.currency
    };
  });

  return {
    propertyId,
    fromDate,
    toDate,
    generatedAt: nowIso(),
    kpis: {
      reservations: rows.length,
      arrivals: rows.filter((row) => withinRange(row.arrivalDate, fromDate, toDate)).length,
      departures: rows.filter((row) => withinRange(row.departureDate, fromDate, toDate)).length,
      cancelled: rows.filter((row) => row.status === "cancelled").length,
      noShows: rows.filter((row) => row.status === "no_show").length,
      totalAmount: sum(rows.map((row) => row.totalAmount))
    },
    byStatus: countBy(rows.map((row) => row.status)),
    byChannel: countBy(rows.map((row) => row.channel)),
    rows
  };
}

export async function getBillingReport(propertyId: string, query: Record<string, unknown> = {}) {
  const invoices = await listInvoices(propertyId);
  const reservations = await prisma.reservation.findMany({ where: { propertyId }, select: { id: true } });
  const reservationIds = reservations.map((r) => r.id);
  const folioRows = reservationIds.length
    ? await prisma.folio.findMany({ where: { reservationId: { in: reservationIds } } })
    : [];
  const folioBalances = await Promise.all(folioRows.map((folio) => getReservationFolio(folio.reservationId)));
  const payments = (await prisma.payment.findMany({ where: { propertyId } })).map((p) => ({
    id: p.id,
    propertyId: p.propertyId,
    folioId: p.folioId,
    amount: Number(p.amount),
    currency: p.currency,
    method: p.method,
    status: p.status,
    createdAt: p.createdAt.toISOString()
  }));
  const openBalances = folioBalances.filter((balance) => balance.folio.status === "open" && balance.balanceDue !== 0);

  return {
    propertyId,
    generatedAt: nowIso(),
    query,
    kpis: {
      invoiceCount: invoices.length,
      issuedInvoices: invoices.filter((invoice) => invoice.status === "issued").length,
      draftInvoices: invoices.filter((invoice) => invoice.status === "draft").length,
      invoiceTotal: sum(invoices.map((invoice) => invoice.total)),
      taxTotal: sum(invoices.map((invoice) => invoice.taxTotal)),
      capturedPayments: sum(payments.filter((payment) => payment.status === "captured").map((payment) => payment.amount)),
      openFolioBalances: sum(openBalances.map((balance) => balance.balanceDue))
    },
    invoices,
    folios: folioBalances.map((balance) => ({
      folioId: balance.folio.id,
      reservationId: balance.folio.reservationId,
      status: balance.folio.status,
      chargesTotal: balance.chargesTotal,
      paymentsTotal: balance.paymentsTotal,
      balanceDue: balance.balanceDue,
      currency: balance.folio.currency
    })),
    payments
  };
}

export async function exportOperationalReport(input: {
  context: UserContext;
  propertyId: string;
  reportType: OperationalReportType;
  format: OperationalReportFormat;
  query?: Record<string, unknown>;
  correlationId: string;
}) {
  requirePermissions(input.context, ["analytics.export"]);
  const payload =
    input.reportType === "billing"
      ? await getBillingReport(input.propertyId, input.query)
      : input.reportType === "reservation"
        ? await getReservationReport(input.propertyId, input.query)
        : getReportCatalog(input.propertyId);
  // Generate a REAL downloadable artifact instead of a placeholder URL: the
  // frontend wraps `content` in a Blob and triggers a download under `filename`.
  // We honour the requested format with a sensible fallback (PDF/XLSX → HTML
  // print-to-PDF and a CSV companion, so the user always gets something useful).
  const filename = buildReportFilename(input.propertyId, input.reportType, input.format);
  const content = buildReportContent(input.reportType, input.format, payload);
  const exportRecord = {
    id: createId("report_export"),
    propertyId: input.propertyId,
    reportType: input.reportType,
    format: input.format,
    generatedAt: nowIso(),
    filename,
    contentType: contentTypeFor(input.format)
  };
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "OperationalReportExported",
    entityType: "report_export",
    entityId: exportRecord.id,
    afterJson: { exportRecord, query: input.query },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: "report_export",
    entityId: exportRecord.id,
    eventType: "OperationalReportExported",
    payload: { reportType: input.reportType, format: input.format },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return { export: exportRecord, payload, content };
}

function contentTypeFor(format: OperationalReportFormat): string {
  switch (format) {
    case "csv": return "text/csv;charset=utf-8";
    case "json": return "application/json;charset=utf-8";
    case "xlsx": return "text/csv;charset=utf-8"; // fallback (no xlsx writer available)
    case "pdf": return "text/html;charset=utf-8";  // fallback: printable HTML
    default: return "text/plain;charset=utf-8";
  }
}

function buildReportFilename(propertyId: string, type: OperationalReportType, format: OperationalReportFormat): string {
  const ext = format === "pdf" ? "html" : format === "xlsx" ? "csv" : format;
  const stamp = new Date().toISOString().slice(0, 10);
  return `informe-${type}-${propertyId}-${stamp}.${ext}`;
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return [keys.join(";"), ...rows.map((r) => keys.map((k) => csvEscape(r[k])).join(";"))].join("\n");
}

function buildReportContent(type: OperationalReportType, format: OperationalReportFormat, payload: unknown): string {
  if (format === "json") return JSON.stringify(payload, null, 2);
  // CSV-friendly extraction: pick the most relevant array from each report
  const data = payload as Record<string, unknown>;
  let rows: Array<Record<string, unknown>> = [];
  if (type === "billing" && Array.isArray(data.invoices)) rows = data.invoices as Array<Record<string, unknown>>;
  else if (type === "billing" && Array.isArray(data.folios)) rows = data.folios as Array<Record<string, unknown>>;
  else if (type === "reservation" && Array.isArray(data.reservations)) rows = data.reservations as Array<Record<string, unknown>>;
  else if (Array.isArray(data.items)) rows = data.items as Array<Record<string, unknown>>;
  if (format === "pdf") {
    const table = rows.length
      ? `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;font-family:system-ui,Arial,sans-serif;font-size:12px"><thead><tr>${Object.keys(rows[0]).map((k) => `<th>${k}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${Object.values(r).map((v) => `<td>${v ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : `<pre style="white-space:pre-wrap">${JSON.stringify(payload, null, 2)}</pre>`;
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe ${type}</title></head><body><h1>Informe ${type}</h1><p>Generado ${new Date().toLocaleDateString("es-ES")}</p>${table}</body></html>`;
  }
  return toCsv(rows);
}

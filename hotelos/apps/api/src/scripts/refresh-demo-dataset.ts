// Demo dataset refresh CLI (Tanda 4 · dataset-seeds · DATA-05/06/07/09, REV-05, FISC-10).
//
// The demo database mixes the July walkthrough (Faranda + org_123) with two
// days of 360-audit fixtures (AUDIT orgs, AUDIT reservations, POS tickets,
// users, masters…). This command removes the audit residue WITHOUT touching
// anything fiscal or the audit trail, re-dates the walkthrough bookings so the
// dashboards stop showing expired arrivals, and (only when missing) re-seeds
// the BAR grid / revenue snapshots of the demo properties.
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/refresh-demo-dataset.ts \
//     [--dry-run | --apply] [--scope audit-orgs|faranda|org123|all] [--exclude-after <ISO>] [--json]
//
//   --dry-run             (default) plan + counts, write nothing
//   --apply               execute the plan (take a backup first: bash scripts/backup-postgres.sh)
//   --scope <s>           audit-orgs · faranda · org123 · all (default all)
//   --exclude-after <ISO> rows created after this instant are ignored (default: now) —
//                         lets a batch still writing fixtures finish before the sweep
//   --json                machine-readable summary on stdout
//
// PROTECTED (never deleteMany, asserted in code — see PROTECTED_MODELS and the
// per-row assertions): audit_events and event_stream (global hash chains),
// invoices with verifactu_hash, verifactu_submissions, ses_hospedajes_submissions
// (any status; accepted ones are legally immutable), invoice_sequences FAC/REC.
//
// Phases:
//   A  AUDIT organisations (name AUDIT%, never org_123 / Faranda): the whole
//      tenant in child→parent order inside one transaction per org, only when
//      the org has 0 invoices with hash, 0 VeriFactu/SES submissions and 0 rate
//      journals. Their audit_events/event_stream rows stay (orphan org id is
//      expected in an immutable trail).
//   B  Faranda (and B′ org_123): AUDIT reservations split into KEEP (a VeriFactu
//      invoice or an SES submission hangs from them → checked_in ones are
//      checked out with acknowledgeBalance, future ones cancelled — both through
//      the PMS service so the trail chains) and DELETABLE (full tree:
//      invoice_lines → draft invoices → refunds → payments → folio_lines →
//      folios → stays → guest_register_records → routing rules →
//      reservation_guests → reservations → exclusive guests). AUDIT guests of
//      the org with no reservation, parte, folio or any other guest_id reference
//      (Audit CuatroRegDos, left behind by a rooming-list probe) go too; an AUDIT
//      guest that is still referenced is KEEP and reported with the tables that
//      hold it. Then AUDIT
//      masters, POS tickets, housekeeping tasks (with their housekeeping_events),
//      users, sessions and roles. A stale checked_in booking with no
//      guest/charges/documents (RES-00001) is removed and its room freed.
//      The AUDIT marker is read from every free-text field AND from the
//      reservation code / group code (AUDIT-T4-REG-001 carries it nowhere else).
//      AUDIT group_bookings are deleted only when every reservation hanging
//      from them (by group_booking_id or group_code) is in the deletable set
//      and no MICE event references them; otherwise the group is KEEP and
//      reported. Messages of the tenant are deleted when their body/metadata
//      carry the "AUDIT-" marker or when their conversation belongs to a
//      deleted reservation/guest (attachments first, conversation last).
//   E  Orphan sweep, global: housekeeping_events whose task no longer exists,
//      messages without conversation, attachments without message, and
//      conversations whose property or reservation no longer exists (residue
//      of earlier refreshes that ran before these tables were covered).
//   C  Walkthrough bookings that expired (confirmed, departure < today, no
//      stay/invoice) are moved into [today+1, today+30] keeping their length of
//      stay; open folios of checked_out reservations with balance 0 are closed.
//   D  Only if missing: BAR rate grid (seed-commercial SEED_SCOPE=rates) and
//      demo revenue snapshots (seed-revenue-snapshots) for the allowlisted demo
//      properties, run as child processes through their own demo guard.
//
// After --apply: audit/event_stream chain check (no dangling previous_hash),
// residual sweep over every tenant-scoped table (only audit_events/event_stream
// may still reference the deleted orgs), final inventory, and one
// DEMO_DATASET_REFRESHED audit event (chained). The API keeps in-memory
// mirrors of tenants: restart it after a refresh.
//
// Exit codes: 0 ok · 1 failure (precondition, service error, broken chain) ·
// 2 unknown flag / invalid argument.

import { execFileSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import type { PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../lib/demo-store.js";
import { addDays, dayUtc, isoDate, MS_DAY } from "../modules/revenue/actuals.js";

// ───────────────────────────────────────────────────────────── constants

export type RefreshScope = "audit-orgs" | "faranda" | "org123" | "all";
export const REFRESH_SCOPES: readonly RefreshScope[] = ["audit-orgs", "faranda", "org123", "all"];

export type RefreshFlags = {
  apply: boolean;
  scope: RefreshScope;
  excludeAfter: Date;
  json: boolean;
};

export const DEMO_ORG_ID = "org_123";
export const DEMO_PROPERTY_IDS: readonly string[] = ["prop_123", "prop_canary"];
export const FARANDA_ORG_ID = "cmrhw9jy30002fyvb6tsdiugt";
export const FARANDA_PROPERTY_ID = "cmrhw9jy40003fyvbuu2ec2w7";
/** Organisations that must NEVER be treated as an AUDIT tenant, whatever their name. */
export const LIVE_ORG_IDS: readonly string[] = [DEMO_ORG_ID, FARANDA_ORG_ID];
export const AUDIT_PREFIX = "AUDIT";
/** Marker searched INSIDE free text (message bodies): the hyphen keeps "auditoría" out. */
export const AUDIT_MARKER = "AUDIT-";
/** Phase label of the global orphan sweep (rows whose parent row no longer exists). */
export const PHASE_ORPHANS = "E:orphans";
/** Booker names of probe reservations that carry no AUDIT marker (RES-00038/39). */
export const PROBE_BOOKERS: readonly string[] = ["PRODPROBE", "PROD-T1"];
/** First day of the 360 audit: residue with no text marker (POS tickets, HK tasks) is dated from here. */
export const AUDIT_WINDOW_START = new Date("2026-09-13T00:00:00.000Z");
export const CORRELATION_ID = "corr_demo_refresh";
export const SYSTEM_USER_ID = "usr_system_demo_refresh";
export const FUTURE_WINDOW_DAYS = 30;
export const MIN_FUTURE_BAR_DAYS = 90;
export const MIN_DEMO_SNAPSHOT_DAYS = 400;
export const DEMO_BAR_PRICES: Record<string, Record<string, number>> = { prop_123: { DBL: 105 } };

/** Prisma delegates this script refuses to deleteMany on, whatever the caller asks. */
export const PROTECTED_MODELS: readonly string[] = ["auditEvent", "eventStream", "verifactuSubmission", "sesHospedajesSubmission", "permission"];
export const PROTECTED_SEQUENCE_CODES: readonly string[] = ["FAC", "REC"];

const TX_OPTIONS = { maxWait: 30_000, timeout: 600_000 } as const;
const SAMPLE = 5;

// ───────────────────────────────────────────────────────────── flags

const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function parseFlags(argv: readonly string[], now: Date = new Date()): RefreshFlags {
  const flags: RefreshFlags = { apply: false, scope: "all", excludeAfter: now, json: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`Flag "${arg}" requires a value.`);
      i++;
      return v;
    };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--scope") {
      const v = next();
      if (!REFRESH_SCOPES.includes(v as RefreshScope)) throw new Error(`--scope must be one of ${REFRESH_SCOPES.join("|")} (got "${v}").`);
      flags.scope = v as RefreshScope;
    } else if (arg === "--exclude-after") {
      const v = next();
      if (!ISO_RE.test(v) || Number.isNaN(Date.parse(v))) throw new Error(`--exclude-after expects an ISO date/time (got "${v}").`);
      flags.excludeAfter = new Date(v);
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --dry-run, --apply, --scope <audit-orgs|faranda|org123|all>, --exclude-after <ISO>, --json.`);
  }
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  return flags;
}

// ───────────────────────────────────────────────────────────── pure classification

export type ReservationLite = {
  id: string;
  code: string;
  status: string;
  arrivalDate: Date;
  departureDate: Date;
  notes: string | null;
  bookerName: string | null;
  externalReference: string | null;
  internalNotes: string | null;
  createdAt: Date;
  assignedRoomId: string | null;
  groupCode: string | null;
  groupBookingId: string | null;
};

function startsWithAudit(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().toUpperCase().startsWith(AUDIT_PREFIX);
}

/** "AUDIT-" anywhere in a free-text blob (message body, metadata JSON), case-insensitive. */
export function hasAuditMarker(value: string | null | undefined): boolean {
  return typeof value === "string" && value.toUpperCase().includes(AUDIT_MARKER);
}

/**
 * AUDIT marker at the start of any free-text field, of the reservation code
 * or of the group code (AUDIT-T4-REG-001 has it only there), or a known probe
 * booker (RES-00038/39).
 */
export function isAuditReservation(r: Pick<ReservationLite, "code" | "notes" | "bookerName" | "externalReference" | "internalNotes" | "groupCode">): boolean {
  if (startsWithAudit(r.code) || startsWithAudit(r.groupCode)) return true;
  if (startsWithAudit(r.notes) || startsWithAudit(r.bookerName) || startsWithAudit(r.externalReference) || startsWithAudit(r.internalNotes)) return true;
  return typeof r.bookerName === "string" && PROBE_BOOKERS.includes(r.bookerName.trim());
}

export type GuestLite = { id: string; firstName: string | null; surname1: string | null; email: string | null };
export type GuestKeepPlan = { guestId: string; name: string; reason: string };
export type GuestClassification = { deletable: string[]; kept: GuestKeepPlan[] };

/**
 * Tables that reference guests.guest_id. Only reservation_guests carries a real
 * FK (ON DELETE CASCADE); the rest are soft references, so deleting a guest
 * they point at would leave orphans. Every one must be empty before a guest
 * is deletable. Keys are Prisma delegates; values the SQL table names for
 * the report.
 */
export const GUEST_REFERENCE_TABLES: Readonly<Record<string, string>> = {
  reservationGuest: "reservation_guests",
  guestRegisterRecord: "guest_register_records",
  folio: "folios",
  conversation: "conversations",
  guestReview: "guest_reviews",
  guestPortalSession: "guest_portal_sessions",
  guestPortalAction: "guest_portal_actions",
  guestProfileLink: "guest_profile_links",
  paymentToken: "payment_tokens",
  serviceRequest: "service_requests",
  surveyResponse: "survey_responses",
  qualityCase: "quality_cases",
  safetyIncident: "safety_incidents",
  upsellImpression: "upsell_impressions",
  identityDocumentProcessingEvent: "identity_document_processing_events"
};

/** "AUDIT" as a leading token (end, space, hyphen, underscore or digit after it): "Auditoría" is a real word. */
const AUDIT_TOKEN_RE = /^\s*AUDIT(?:[\s\-_\d]|$)/i;

/**
 * AUDIT token at the start of the first name, the surname or the email
 * ("Audit CuatroRegDos", "AUDIT-T2 Facturas", "audit-t1@…"). Stricter than
 * startsWithAudit on purpose: a guest named "Auditoría Interna SL" is not a
 * fixture. Emails are encrypted at rest in the demo DB, so the email rule only
 * catches plain seeds.
 */
export function isAuditGuest(g: Pick<GuestLite, "firstName" | "surname1" | "email">): boolean {
  return [g.firstName, g.surname1, g.email].some((value) => typeof value === "string" && AUDIT_TOKEN_RE.test(value));
}

/**
 * An AUDIT guest is deletable only when every guest_id reference table is
 * empty for it (no reservation, parte, folio, conversation…). Otherwise it is
 * KEEP with the non-empty tables as the reason. `refs` maps guest id → table
 * name → row count; a missing entry counts as zero references.
 */
export function classifyAuditGuests(guests: readonly GuestLite[], refs: ReadonlyMap<string, Readonly<Record<string, number>>>): GuestClassification {
  const out: GuestClassification = { deletable: [], kept: [] };
  for (const g of guests) {
    if (!isAuditGuest(g)) continue;
    const counts = refs.get(g.id) ?? {};
    const held = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([table, n]) => `${table}=${n}`);
    const name = [g.firstName, g.surname1].filter((x) => typeof x === "string" && x.trim().length > 0).join(" ") || g.id;
    if (held.length === 0) out.deletable.push(g.id);
    else out.kept.push({ guestId: g.id, name, reason: `referenciado: ${held.join(", ")}` });
  }
  return out;
}

export type GroupBookingLite = { id: string; code: string | null; name: string };
export type GroupKeep = { group: GroupBookingLite; reason: string };
export type GroupClassification = { deletable: GroupBookingLite[]; kept: GroupKeep[] };

/**
 * An AUDIT group booking is deletable only when every reservation linked to
 * it — by group_booking_id or by group_code (the T4 fixtures use the code
 * only) — is itself in the deletable set and no MICE event references it.
 * A group with a KEEP reservation (fiscal document) stays, and is reported.
 */
export function classifyGroupBookings(
  groups: readonly GroupBookingLite[],
  reservations: readonly Pick<ReservationLite, "id" | "code" | "groupCode" | "groupBookingId">[],
  deletableReservationIds: ReadonlySet<string>,
  eventsByGroup: ReadonlyMap<string, number> = new Map()
): GroupClassification {
  const deletable: GroupBookingLite[] = [];
  const kept: GroupKeep[] = [];
  for (const g of groups) {
    const linked = reservations.filter((r) => r.groupBookingId === g.id || (g.code !== null && g.code !== "" && r.groupCode === g.code));
    const keepers = linked.filter((r) => !deletableReservationIds.has(r.id));
    const events = eventsByGroup.get(g.id) ?? 0;
    const reasons: string[] = [];
    if (keepers.length > 0) reasons.push(`reservas conservadas: ${keepers.map((r) => r.code).join(", ")}`);
    if (events > 0) reasons.push(`${events} eventos MICE`);
    if (reasons.length > 0) kept.push({ group: g, reason: reasons.join(" · ") });
    else deletable.push(g);
  }
  return { deletable, kept };
}

export type FiscalLinks = {
  /** reservation ids that carry an invoice with verifactu_hash (direct or through a folio) */
  reservationsWithHashInvoice: Set<string>;
  /** reservation ids that carry any ses_hospedajes_submission (direct or through a guest register record) */
  reservationsWithSes: Set<string>;
};

export type KeepAction = "check_out" | "cancel" | "none";
export type KeepDecision = { reservation: ReservationLite; reasons: string[]; action: KeepAction };
export type Classification = { keep: KeepDecision[]; deletable: ReservationLite[] };

export function keepActionFor(status: string): KeepAction {
  if (status === "checked_in") return "check_out";
  if (status === "confirmed" || status === "draft") return "cancel";
  return "none";
}

/**
 * AUDIT reservations → KEEP when a fiscal document (VeriFactu invoice) or an
 * SES submission hangs from them, DELETABLE otherwise. Non-audit reservations
 * are ignored here (see isOrphanStaleCheckIn for RES-00001).
 */
export function classifyReservations(reservations: readonly ReservationLite[], links: FiscalLinks): Classification {
  const keep: KeepDecision[] = [];
  const deletable: ReservationLite[] = [];
  for (const r of reservations) {
    if (!isAuditReservation(r)) continue;
    const reasons: string[] = [];
    if (links.reservationsWithHashInvoice.has(r.id)) reasons.push("factura con verifactu_hash");
    if (links.reservationsWithSes.has(r.id)) reasons.push("ses_hospedajes_submission");
    if (reasons.length > 0) keep.push({ reservation: r, reasons, action: keepActionFor(r.status) });
    else deletable.push(r);
  }
  return { keep, deletable };
}

export type ReservationCounts = { guests: number; folioLines: number; payments: number; invoices: number; registerRecords: number; sesSubmissions: number };

/**
 * A non-audit booking still "checked_in" long after its departure, with no
 * guest, no charge, no payment and no document — RES-00001 of the July
 * walkthrough. Nothing to preserve: delete it and free its room.
 */
export function isOrphanStaleCheckIn(r: ReservationLite, counts: ReservationCounts, today: Date): boolean {
  if (isAuditReservation(r)) return false;
  if (r.status !== "checked_in") return false;
  if (dayUtc(r.departureDate).getTime() >= dayUtc(today).getTime()) return false;
  return counts.guests === 0 && counts.folioLines === 0 && counts.payments === 0 && counts.invoices === 0 && counts.registerRecords === 0 && counts.sesSubmissions === 0;
}

export type DateShift = { id: string; code: string; from: { arrival: string; departure: string }; to: { arrival: string; departure: string }; los: number };

/**
 * Moves a group of expired bookings into [today+1, today+windowDays] keeping
 * each length of stay and the relative order. When the original span does not
 * fit, arrival offsets are compressed proportionally (LOS is never shortened).
 */
export function planDateShift(
  reservations: readonly Pick<ReservationLite, "id" | "code" | "arrivalDate" | "departureDate">[],
  today: Date,
  windowDays = FUTURE_WINDOW_DAYS
): DateShift[] {
  if (reservations.length === 0) return [];
  const base = dayUtc(today);
  const first = addDays(base, 1);
  const rows = reservations.map((r) => {
    const arrival = dayUtc(r.arrivalDate);
    const departure = dayUtc(r.departureDate);
    const los = Math.max(1, Math.round((departure.getTime() - arrival.getTime()) / MS_DAY));
    return { r, arrival, departure, los };
  });
  const minArrival = Math.min(...rows.map((x) => x.arrival.getTime()));
  const maxOffset = Math.max(...rows.map((x) => (x.arrival.getTime() - minArrival) / MS_DAY));
  const maxLos = Math.max(...rows.map((x) => x.los));
  const room = windowDays - 1 - maxLos; // last arrival offset that still departs within the window
  const scale = maxOffset > 0 && room >= 0 && maxOffset > room ? room / maxOffset : 1;
  return rows.map(({ r, arrival, departure, los }) => {
    const offset = Math.round(((arrival.getTime() - minArrival) / MS_DAY) * scale);
    const newArrival = addDays(first, offset);
    const newDeparture = addDays(newArrival, los);
    return {
      id: r.id,
      code: r.code,
      from: { arrival: isoDate(arrival), departure: isoDate(departure) },
      to: { arrival: isoDate(newArrival), departure: isoDate(newDeparture) },
      los
    };
  });
}

export type ChainRow = { previousHash: string | null; currentHash: string };
export type ChainReport = { total: number; genesis: number; dangling: number };

/** Link check independent of insertion order: every previous_hash must point at an existing current_hash. */
export function analyseChainLinks(rows: readonly ChainRow[]): ChainReport {
  const known = new Set(rows.map((r) => r.currentHash));
  let genesis = 0;
  let dangling = 0;
  for (const r of rows) {
    if (r.previousHash === null || r.previousHash === undefined) genesis++;
    else if (!known.has(r.previousHash)) dangling++;
  }
  return { total: rows.length, genesis, dangling };
}

export function assertDeletableModel(model: string): void {
  if (PROTECTED_MODELS.includes(model)) {
    throw new Error(`Tabla protegida: el refresco nunca borra "${model}" (audit trail / documentos fiscales / SES).`);
  }
}

export function assertDraftInvoices(rows: readonly { id: string; status: string; verifactuHash: string | null; invoiceNumber: string | null }[]): void {
  const bad = rows.filter((i) => i.verifactuHash !== null || i.status !== "draft");
  if (bad.length > 0) {
    throw new Error(`Factura fiscal en el conjunto a borrar (${bad.map((i) => i.invoiceNumber ?? i.id).join(", ")}): abortado.`);
  }
}

export function assertDeletableSequences(rows: readonly { id: string; sequenceCode: string; prefix: string | null }[]): void {
  const bad = rows.filter((s) => PROTECTED_SEQUENCE_CODES.includes(s.sequenceCode.toUpperCase()) || !startsWithAudit(s.prefix ?? s.sequenceCode));
  if (bad.length > 0) {
    throw new Error(`Serie de facturación protegida en el conjunto a borrar (${bad.map((s) => s.sequenceCode).join(", ")}): abortado.`);
  }
}

// ───────────────────────────────────────────────────────────── plan model

export type Deletion = { phase: string; model: string; table: string; ids: string[]; note?: string };
export type KeepPlan = { reservationId: string; code: string; status: string; action: KeepAction; reasons: string[]; organizationId: string; propertyId: string };
export type RoomFree = { roomId: string; number: string; reservationCode: string };
export type FolioClose = { folioId: string; reservationCode: string; balanceDue: number };
export type ReseedNeed = { seed: "rates" | "snapshots"; target: string; reason: string; env: Record<string, string> };

class Planner {
  readonly deletions: Deletion[] = [];
  readonly warnings: string[] = [];
  add(phase: string, model: string, table: string, ids: readonly string[], note?: string): void {
    assertDeletableModel(model);
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    this.deletions.push({ phase, model, table, ids: unique, note });
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
}

type DeleteDelegate = { deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }> };

async function executeDeletions(tx: Prisma.TransactionClient, deletions: readonly Deletion[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const d of deletions) {
    assertDeletableModel(d.model);
    const delegate = (tx as unknown as Record<string, DeleteDelegate>)[d.model];
    if (!delegate || typeof delegate.deleteMany !== "function") throw new Error(`Delegado Prisma desconocido: ${d.model}`);
    let total = 0;
    for (let i = 0; i < d.ids.length; i += 1000) {
      const res = await delegate.deleteMany({ where: { id: { in: d.ids.slice(i, i + 1000) } } });
      total += res.count;
    }
    counts[d.table] = (counts[d.table] ?? 0) + total;
  }
  return counts;
}

function ids<T extends { id: string }>(rows: readonly T[]): string[] {
  return rows.map((r) => r.id);
}

const AUDIT_TEXT = { startsWith: AUDIT_PREFIX, mode: "insensitive" as const };
const AUDIT_EMAIL = { startsWith: "audit", mode: "insensitive" as const };

// ───────────────────────────────────────────────────────────── phase A · AUDIT orgs

type AuditOrg = { id: string; name: string; propertyIds: string[] };

async function findAuditOrgs(excludeAfter: Date): Promise<AuditOrg[]> {
  const orgs = await prisma.organization.findMany({
    where: { name: AUDIT_TEXT, id: { notIn: [...LIVE_ORG_IDS] }, createdAt: { lte: excludeAfter } },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" }
  });
  const out: AuditOrg[] = [];
  for (const org of orgs) {
    const props = await prisma.property.findMany({ where: { organizationId: org.id }, select: { id: true } });
    out.push({ id: org.id, name: org.name, propertyIds: ids(props) });
  }
  return out;
}

async function collectAuditOrg(org: AuditOrg, planner: Planner): Promise<boolean> {
  const P = `A:${org.id}`;
  const propertyIds = org.propertyIds;
  const [hashInvoices, verifactu, ses, journals] = await Promise.all([
    prisma.invoice.count({ where: { propertyId: { in: propertyIds }, verifactuHash: { not: null } } }),
    prisma.verifactuSubmission.count({ where: { propertyId: { in: propertyIds } } }),
    prisma.sesHospedajesSubmission.count({ where: { propertyId: { in: propertyIds } } }),
    prisma.rateChangeJournal.count({ where: { propertyId: { in: propertyIds } } })
  ]);
  if (hashInvoices > 0 || verifactu > 0 || ses > 0 || journals > 0) {
    planner.warn(`Org AUDIT ${org.id} (${org.name}) conservada: tiene ${hashInvoices} facturas con hash, ${verifactu} VeriFactu, ${ses} SES, ${journals} journals.`);
    return false;
  }

  const users = await prisma.user.findMany({ where: { organizationId: org.id }, select: { id: true, email: true } });
  const userIds = ids(users);
  const invoices = await prisma.invoice.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true, status: true, verifactuHash: true, invoiceNumber: true } });
  assertDraftInvoices(invoices);
  const invoiceLines = await prisma.invoiceLine.findMany({ where: { invoiceId: { in: ids(invoices) } }, select: { id: true } });
  const posOrders = await prisma.posOrder.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const posLines = await prisma.posOrderLine.findMany({ where: { posOrderId: { in: ids(posOrders) } }, select: { id: true } });
  const outlets = await prisma.outlet.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const reservations = await prisma.reservation.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const reservationIds = ids(reservations);
  const folios = await prisma.folio.findMany({ where: { reservationId: { in: reservationIds } }, select: { id: true } });
  const folioIds = ids(folios);
  const payments = await prisma.payment.findMany({ where: { OR: [{ folioId: { in: folioIds } }, { propertyId: { in: propertyIds } }] }, select: { id: true } });
  const refunds = await prisma.paymentRefund.findMany({ where: { paymentId: { in: ids(payments) } }, select: { id: true } });
  const folioLines = await prisma.folioLine.findMany({ where: { folioId: { in: folioIds } }, select: { id: true } });
  const stays = await prisma.stay.findMany({ where: { reservationId: { in: reservationIds } }, select: { id: true } });
  const rgs = await prisma.reservationGuest.findMany({ where: { reservationId: { in: reservationIds } }, select: { id: true } });
  const routing = await prisma.folioRoutingRule.findMany({ where: { reservationId: { in: reservationIds } }, select: { id: true } });
  const grr = await prisma.guestRegisterRecord.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const guests = await prisma.guest.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const hkTasks = await prisma.housekeepingTask.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const hkEvents = await prisma.housekeepingEvent.findMany({ where: { taskId: { in: ids(hkTasks) } }, select: { id: true } });
  const conversations = await prisma.conversation.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const messages = await prisma.message.findMany({ where: { conversationId: { in: ids(conversations) } }, select: { id: true } });
  const attachments = await prisma.messageAttachment.findMany({ where: { messageId: { in: ids(messages) } }, select: { id: true } });
  const workOrders = await prisma.workOrder.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const rooms = await prisma.room.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const roomTypes = await prisma.roomType.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const rateDays = await prisma.rateDay.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const ratePlans = await prisma.ratePlan.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const snapshots = await prisma.revenueDailySnapshot.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const pace = await prisma.revenuePaceSnapshot.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const accuracy = await prisma.forecastAccuracy.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const forecasts = await prisma.revenueForecast.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const recos = await prisma.revenueRecommendation.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const compSnaps = await prisma.competitorRateSnapshot.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const comps = await prisma.competitorHotel.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const budgets = await prisma.budget.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const readiness = await prisma.propertyReadinessCheck.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const modules = await prisma.propertyModule.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const aiSettings = await prisma.propertyAiSetting.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const complianceSettings = await prisma.propertyComplianceSetting.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const upsells = await prisma.upsellOffer.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const departments = await prisma.department.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const userDepartments = await prisma.userDepartment.findMany({ where: { OR: [{ departmentId: { in: ids(departments) } }, { userId: { in: userIds } }] }, select: { id: true } });
  const deliveries = await prisma.notificationDelivery.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const invitations = await prisma.userInvitation.findMany({ where: { OR: [{ organizationId: org.id }, { userId: { in: userIds } }] }, select: { id: true } });
  const upr = await prisma.userPropertyRole.findMany({ where: { OR: [{ userId: { in: userIds } }, { propertyId: { in: propertyIds } }] }, select: { id: true } });
  const sessions = await prisma.session.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const devices = await prisma.device.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const resetTokens = await prisma.passwordResetToken.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const roles = await prisma.role.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const rolePermissions = await prisma.rolePermission.findMany({ where: { roleId: { in: ids(roles) } }, select: { id: true } });
  const taxes = await prisma.tax.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const taxRates = await prisma.taxRate.findMany({ where: { taxId: { in: ids(taxes) } }, select: { id: true } });
  const floors = await prisma.floor.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const buildings = await prisma.building.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const zones = await prisma.propertyZone.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const spaces = await prisma.propertySpace.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const channels = await prisma.channel.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const allotments = await prisma.allotment.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const allotmentDays = await prisma.allotmentDay.findMany({ where: { allotmentId: { in: ids(allotments) } }, select: { id: true } });
  const groupBookings = await prisma.groupBooking.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const groupRoomBlocks = await prisma.groupRoomBlock.findMany({ where: { groupBookingId: { in: ids(groupBookings) } }, select: { id: true } });
  const templates = await prisma.documentTemplate.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const sequences = await prisma.invoiceSequence.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true, sequenceCode: true, prefix: true } });
  const bankAccounts = await prisma.bankAccount.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const gdpr = await prisma.gdprRequest.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const tourOperators = await prisma.tourOperator.findMany({ where: { organizationId: org.id }, select: { id: true } });
  const hkSections = await prisma.housekeepingSection.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const mtAreas = await prisma.maintenanceArea.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const hkRules = await prisma.housekeepingRule.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const mtRules = await prisma.maintenanceRule.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });

  // An AUDIT org's sequences are only test series; still never FAC/REC.
  if (sequences.some((s) => PROTECTED_SEQUENCE_CODES.includes(s.sequenceCode.toUpperCase()))) {
    planner.warn(`Org AUDIT ${org.id} conservada: tiene series FAC/REC.`);
    return false;
  }

  planner.add(P, "invoiceLine", "invoice_lines", ids(invoiceLines));
  planner.add(P, "invoice", "invoices", ids(invoices), "drafts sin hash");
  planner.add(P, "posOrderLine", "pos_order_lines", ids(posLines));
  planner.add(P, "posOrder", "pos_orders", ids(posOrders));
  planner.add(P, "outlet", "outlets", ids(outlets));
  planner.add(P, "paymentRefund", "payment_refunds", ids(refunds));
  planner.add(P, "payment", "payments", ids(payments));
  planner.add(P, "folioLine", "folio_lines", ids(folioLines));
  planner.add(P, "folio", "folios", folioIds);
  planner.add(P, "stay", "stays", ids(stays));
  planner.add(P, "folioRoutingRule", "folio_routing_rules", ids(routing));
  planner.add(P, "reservationGuest", "reservation_guests", ids(rgs));
  planner.add(P, "reservation", "reservations", reservationIds);
  planner.add(P, "guestRegisterRecord", "guest_register_records", ids(grr));
  planner.add(P, "guest", "guests", ids(guests));
  planner.add(P, "housekeepingEvent", "housekeeping_events", ids(hkEvents));
  planner.add(P, "housekeepingTask", "housekeeping_tasks", ids(hkTasks));
  planner.add(P, "messageAttachment", "message_attachments", ids(attachments));
  planner.add(P, "message", "messages", ids(messages));
  planner.add(P, "conversation", "conversations", ids(conversations));
  planner.add(P, "workOrder", "work_orders", ids(workOrders));
  planner.add(P, "room", "rooms", ids(rooms));
  planner.add(P, "roomType", "room_types", ids(roomTypes));
  planner.add(P, "rateDay", "rate_days", ids(rateDays));
  planner.add(P, "ratePlan", "rate_plans", ids(ratePlans));
  planner.add(P, "revenueDailySnapshot", "revenue_daily_snapshots", ids(snapshots));
  planner.add(P, "revenuePaceSnapshot", "revenue_pace_snapshots", ids(pace));
  planner.add(P, "forecastAccuracy", "forecast_accuracy", ids(accuracy));
  planner.add(P, "revenueForecast", "revenue_forecasts", ids(forecasts));
  planner.add(P, "revenueRecommendation", "revenue_recommendations", ids(recos));
  planner.add(P, "competitorRateSnapshot", "competitor_rate_snapshots", ids(compSnaps));
  planner.add(P, "competitorHotel", "competitor_hotels", ids(comps));
  planner.add(P, "budget", "budgets", ids(budgets));
  planner.add(P, "propertyReadinessCheck", "property_readiness_checks", ids(readiness));
  planner.add(P, "propertyModule", "property_modules", ids(modules));
  planner.add(P, "propertyAiSetting", "property_ai_settings", ids(aiSettings));
  planner.add(P, "propertyComplianceSetting", "property_compliance_settings", ids(complianceSettings));
  planner.add(P, "upsellOffer", "upsell_offers", ids(upsells));
  planner.add(P, "userDepartment", "user_departments", ids(userDepartments));
  planner.add(P, "department", "departments", ids(departments));
  planner.add(P, "notificationDelivery", "notification_deliveries", ids(deliveries));
  planner.add(P, "userInvitation", "user_invitations", ids(invitations));
  planner.add(P, "userPropertyRole", "user_property_roles", ids(upr));
  planner.add(P, "session", "sessions", ids(sessions));
  planner.add(P, "device", "devices", ids(devices));
  planner.add(P, "passwordResetToken", "password_reset_tokens", ids(resetTokens));
  planner.add(P, "user", "users", userIds, users.map((u) => u.email).join(", "));
  planner.add(P, "rolePermission", "role_permissions", ids(rolePermissions));
  planner.add(P, "role", "roles", ids(roles));
  planner.add(P, "taxRate", "tax_rates", ids(taxRates));
  planner.add(P, "tax", "taxes", ids(taxes));
  planner.add(P, "allotmentDay", "allotment_days", ids(allotmentDays));
  planner.add(P, "allotment", "allotments", ids(allotments));
  planner.add(P, "groupRoomBlock", "group_room_blocks", ids(groupRoomBlocks));
  planner.add(P, "groupBooking", "group_bookings", ids(groupBookings));
  planner.add(P, "documentTemplate", "document_templates", ids(templates));
  planner.add(P, "invoiceSequence", "invoice_sequences", ids(sequences));
  planner.add(P, "channel", "channels", ids(channels));
  planner.add(P, "propertySpace", "property_spaces", ids(spaces));
  planner.add(P, "propertyZone", "property_zones", ids(zones));
  planner.add(P, "floor", "floors", ids(floors));
  planner.add(P, "building", "buildings", ids(buildings));
  planner.add(P, "housekeepingSection", "housekeeping_sections", ids(hkSections));
  planner.add(P, "maintenanceArea", "maintenance_areas", ids(mtAreas));
  planner.add(P, "housekeepingRule", "housekeeping_rules", ids(hkRules));
  planner.add(P, "maintenanceRule", "maintenance_rules", ids(mtRules));
  planner.add(P, "bankAccount", "bank_accounts", ids(bankAccounts));
  planner.add(P, "gdprRequest", "gdpr_requests", ids(gdpr));
  planner.add(P, "tourOperator", "tour_operators", ids(tourOperators));
  planner.add(P, "property", "properties", propertyIds);
  planner.add(P, "organization", "organizations", [org.id], org.name);
  return true;
}

// ───────────────────────────────────────────────────────────── phase B · live tenants

type TenantScope = { label: string; organizationId: string; propertyIds: string[] };

export type GroupKeepPlan = { groupId: string; code: string | null; name: string; reason: string };

type TenantPlan = {
  keep: KeepPlan[];
  keptGroups: GroupKeepPlan[];
  keptGuests: GuestKeepPlan[];
  orphanCheckIns: { reservationId: string; code: string }[];
  roomFrees: RoomFree[];
  dateShifts: DateShift[];
  skippedRoomTypes: string[];
};

/** Naive-UTC literal for a `timestamp(3) without time zone` column (Prisma stores UTC). */
function sqlTimestamp(d: Date): string {
  return d.toISOString().replace("Z", "");
}

async function fiscalLinksFor(propertyIds: string[]): Promise<FiscalLinks> {
  const hashInvoices = await prisma.invoice.findMany({
    where: { propertyId: { in: propertyIds }, verifactuHash: { not: null } },
    select: { reservationId: true, folioId: true }
  });
  const folioIds = hashInvoices.map((i) => i.folioId).filter((x): x is string => typeof x === "string");
  const folios = folioIds.length > 0 ? await prisma.folio.findMany({ where: { id: { in: folioIds } }, select: { reservationId: true } }) : [];
  const reservationsWithHashInvoice = new Set<string>();
  for (const i of hashInvoices) if (i.reservationId) reservationsWithHashInvoice.add(i.reservationId);
  for (const f of folios) reservationsWithHashInvoice.add(f.reservationId);

  const ses = await prisma.sesHospedajesSubmission.findMany({
    where: { propertyId: { in: propertyIds } },
    select: { reservationId: true, guestRegisterRecordId: true }
  });
  const grrIds = ses.map((s) => s.guestRegisterRecordId);
  const grr = grrIds.length > 0 ? await prisma.guestRegisterRecord.findMany({ where: { id: { in: grrIds } }, select: { reservationId: true } }) : [];
  const reservationsWithSes = new Set<string>();
  for (const s of ses) if (s.reservationId) reservationsWithSes.add(s.reservationId);
  for (const g of grr) if (g.reservationId) reservationsWithSes.add(g.reservationId);
  return { reservationsWithHashInvoice, reservationsWithSes };
}

async function collectTenantResidue(scope: TenantScope, flags: RefreshFlags, today: Date, planner: Planner): Promise<TenantPlan> {
  const P = `B:${scope.label}`;
  const { organizationId, propertyIds } = scope;
  const excludeAfter = flags.excludeAfter;
  const plan: TenantPlan = { keep: [], keptGroups: [], keptGuests: [], orphanCheckIns: [], roomFrees: [], dateShifts: [], skippedRoomTypes: [] };

  const reservations: (ReservationLite & { propertyId: string })[] = await prisma.reservation.findMany({
    where: { propertyId: { in: propertyIds }, createdAt: { lte: excludeAfter } },
    select: {
      id: true, code: true, status: true, arrivalDate: true, departureDate: true, notes: true, bookerName: true,
      externalReference: true, internalNotes: true, createdAt: true, assignedRoomId: true, propertyId: true,
      groupCode: true, groupBookingId: true
    }
  });
  const links = await fiscalLinksFor(propertyIds);
  const { keep, deletable } = classifyReservations(reservations, links);
  for (const k of keep) {
    const r = reservations.find((x) => x.id === k.reservation.id)!;
    plan.keep.push({ reservationId: r.id, code: r.code, status: r.status, action: k.action, reasons: k.reasons, organizationId, propertyId: r.propertyId });
  }

  // Orphan stale check-ins (RES-00001): non-audit, checked_in, expired, empty.
  const orphanCandidates = reservations.filter((r) => !isAuditReservation(r) && r.status === "checked_in" && dayUtc(r.departureDate).getTime() < dayUtc(today).getTime());
  const orphans: (ReservationLite & { propertyId: string })[] = [];
  for (const r of orphanCandidates) {
    const folioIds = ids(await prisma.folio.findMany({ where: { reservationId: r.id }, select: { id: true } }));
    const grrIds = ids(await prisma.guestRegisterRecord.findMany({ where: { reservationId: r.id }, select: { id: true } }));
    const counts: ReservationCounts = {
      guests: await prisma.reservationGuest.count({ where: { reservationId: r.id } }),
      folioLines: await prisma.folioLine.count({ where: { folioId: { in: folioIds } } }),
      payments: await prisma.payment.count({ where: { folioId: { in: folioIds } } }),
      invoices: await prisma.invoice.count({ where: { OR: [{ reservationId: r.id }, { folioId: { in: folioIds } }] } }),
      registerRecords: grrIds.length,
      sesSubmissions: await prisma.sesHospedajesSubmission.count({ where: { OR: [{ reservationId: r.id }, { guestRegisterRecordId: { in: grrIds } }] } })
    };
    if (isOrphanStaleCheckIn(r, counts, today)) {
      orphans.push(r);
      plan.orphanCheckIns.push({ reservationId: r.id, code: r.code });
    }
  }

  // ── DELETABLE reservation tree ─────────────────────────────────────────
  const toDelete = [...deletable, ...orphans];
  const deletableIds = ids(toDelete);
  const folios = await prisma.folio.findMany({ where: { reservationId: { in: deletableIds } }, select: { id: true, guestId: true } });
  const folioIds = ids(folios);
  const treeInvoices = await prisma.invoice.findMany({
    where: { OR: [{ reservationId: { in: deletableIds } }, { folioId: { in: folioIds } }] },
    select: { id: true, status: true, verifactuHash: true, invoiceNumber: true }
  });
  assertDraftInvoices(treeInvoices);
  const payments = await prisma.payment.findMany({ where: { folioId: { in: folioIds } }, select: { id: true } });
  const refunds = await prisma.paymentRefund.findMany({ where: { paymentId: { in: ids(payments) } }, select: { id: true } });
  const folioLines = await prisma.folioLine.findMany({ where: { folioId: { in: folioIds } }, select: { id: true } });
  const stays = await prisma.stay.findMany({ where: { reservationId: { in: deletableIds } }, select: { id: true, roomId: true } });
  const grr = await prisma.guestRegisterRecord.findMany({ where: { reservationId: { in: deletableIds } }, select: { id: true, guestId: true } });
  const grrWithSes = await prisma.sesHospedajesSubmission.count({ where: { guestRegisterRecordId: { in: ids(grr) } } });
  if (grrWithSes > 0) throw new Error(`Partes de viajeros con SES en el conjunto a borrar (${grrWithSes}): la clasificación KEEP falló, abortado.`);
  const routing = await prisma.folioRoutingRule.findMany({ where: { reservationId: { in: deletableIds } }, select: { id: true } });
  const rgs = await prisma.reservationGuest.findMany({ where: { reservationId: { in: deletableIds } }, select: { id: true, guestId: true } });

  // Guests exclusive to the deleted reservations (no other reservation, folio or parte).
  const candidateGuestIds = [...new Set(rgs.map((g) => g.guestId))];
  const guestRows = candidateGuestIds.length > 0
    ? await prisma.guest.findMany({ where: { id: { in: candidateGuestIds }, organizationId }, select: { id: true } })
    : [];
  const deletableSet = new Set(deletableIds);
  const folioSet = new Set(folioIds);
  const grrSet = new Set(ids(grr));
  const exclusiveGuestIds: string[] = [];
  for (const g of guestRows) {
    const otherRgs = await prisma.reservationGuest.count({ where: { guestId: g.id, reservationId: { notIn: deletableIds } } });
    const otherFolios = (await prisma.folio.findMany({ where: { guestId: g.id }, select: { id: true } })).filter((f) => !folioSet.has(f.id)).length;
    const otherGrr = (await prisma.guestRegisterRecord.findMany({ where: { guestId: g.id }, select: { id: true } })).filter((x) => !grrSet.has(x.id)).length;
    if (otherRgs === 0 && otherFolios === 0 && otherGrr === 0) exclusiveGuestIds.push(g.id);
  }

  // Drafts hanging from KEEP reservations (no number, no hash) and orphan
  // drafts created during the audit window (no folio, no reservation).
  const keepIds = plan.keep.map((k) => k.reservationId);
  const keepFolioIds = ids(await prisma.folio.findMany({ where: { reservationId: { in: keepIds } }, select: { id: true } }));
  const keepDrafts = await prisma.invoice.findMany({
    where: { status: "draft", verifactuHash: null, OR: [{ reservationId: { in: keepIds } }, { folioId: { in: keepFolioIds } }] },
    select: { id: true, status: true, verifactuHash: true, invoiceNumber: true }
  });
  const orphanDrafts = await prisma.invoice.findMany({
    where: { propertyId: { in: propertyIds }, status: "draft", verifactuHash: null, folioId: null, reservationId: null, createdAt: { gte: AUDIT_WINDOW_START, lte: excludeAfter } },
    select: { id: true, status: true, verifactuHash: true, invoiceNumber: true }
  });
  const draftIds = [...new Set([...ids(treeInvoices), ...ids(keepDrafts), ...ids(orphanDrafts)])];
  const draftLines = await prisma.invoiceLine.findMany({ where: { invoiceId: { in: draftIds } }, select: { id: true } });

  planner.add(P, "invoiceLine", "invoice_lines", ids(draftLines));
  planner.add(P, "invoice", "invoices", draftIds, `drafts: ${treeInvoices.length} del árbol · ${keepDrafts.length} de KEEP · ${orphanDrafts.length} huérfanos`);
  planner.add(P, "paymentRefund", "payment_refunds", ids(refunds));
  planner.add(P, "payment", "payments", ids(payments));
  planner.add(P, "folioLine", "folio_lines", ids(folioLines));
  planner.add(P, "folio", "folios", folioIds);
  planner.add(P, "stay", "stays", ids(stays));
  planner.add(P, "guestRegisterRecord", "guest_register_records", ids(grr), "drafts sin SES");
  planner.add(P, "folioRoutingRule", "folio_routing_rules", ids(routing));
  planner.add(P, "reservationGuest", "reservation_guests", ids(rgs));
  planner.add(P, "reservation", "reservations", deletableIds, `${deletable.length} AUDIT + ${orphans.length} huérfanas (${orphans.map((o) => o.code).join(", ") || "—"})`);
  planner.add(P, "guest", "guests", exclusiveGuestIds, "exclusivos del conjunto borrado");

  // AUDIT guests of the org that hang from nothing (H4): a rooming-list probe
  // left "Audit CuatroRegDos" with no reservation_guests row, so the exclusive
  // rule above never sees it. Every guest_id reference table must be empty;
  // rows of the deletable tree are ignored (they go in this same phase).
  const auditGuestRows: GuestLite[] = await prisma.guest.findMany({
    where: {
      organizationId,
      createdAt: { lte: excludeAfter },
      id: { notIn: exclusiveGuestIds },
      OR: [{ firstName: AUDIT_TEXT }, { surname1: AUDIT_TEXT }, { email: AUDIT_EMAIL }]
    },
    select: { id: true, firstName: true, surname1: true, email: true }
  });
  const treeRgIds = new Set(ids(rgs));
  const guestRefs = new Map<string, Record<string, number>>();
  for (const g of auditGuestRows) {
    const counts: Record<string, number> = {};
    for (const [model, table] of Object.entries(GUEST_REFERENCE_TABLES)) {
      const delegate = (prisma as unknown as Record<string, { findMany(args: { where: { guestId: string }; select: { id: true } }): Promise<{ id: string }[]> }>)[model];
      if (!delegate || typeof delegate.findMany !== "function") throw new Error(`Delegado Prisma desconocido para referencias de huéspedes: ${model}`);
      const rows = await delegate.findMany({ where: { guestId: g.id }, select: { id: true } });
      const outsideTree = rows.filter((r) => {
        if (model === "reservationGuest") return !treeRgIds.has(r.id);
        if (model === "folio") return !folioSet.has(r.id);
        if (model === "guestRegisterRecord") return !grrSet.has(r.id);
        return true;
      });
      counts[table] = outsideTree.length;
    }
    guestRefs.set(g.id, counts);
  }
  const auditGuests = classifyAuditGuests(auditGuestRows, guestRefs);
  plan.keptGuests.push(...auditGuests.kept);
  planner.add(P, "guest", "guests", auditGuests.deletable, "AUDIT sin reservas, partes, folios ni otras referencias");

  // Rooms freed by the orphan check-ins (no other in-house stay on the room).
  const deletedStayIds = new Set(ids(stays));
  for (const o of orphans) {
    const roomId = o.assignedRoomId ?? stays.find((s) => deletedStayIds.has(s.id))?.roomId ?? null;
    if (!roomId) continue;
    const room = await prisma.room.findUnique({ where: { id: roomId }, select: { id: true, number: true } });
    if (!room) continue;
    const otherInHouse = await prisma.stay.count({ where: { roomId, status: "in_house", id: { notIn: ids(stays) } } });
    if (otherInHouse === 0) plan.roomFrees.push({ roomId: room.id, number: room.number, reservationCode: o.code });
  }

  // ── AUDIT masters, POS, tasks, users, sessions, roles ───────────────────
  const auditRooms = await prisma.room.findMany({ where: { propertyId: { in: propertyIds }, number: AUDIT_TEXT }, select: { id: true, number: true } });
  const auditRoomIds = ids(auditRooms);
  const auditRoomStays = await prisma.stay.count({ where: { roomId: { in: auditRoomIds }, id: { notIn: ids(stays) } } });
  if (auditRoomStays > 0) planner.warn(`${auditRoomStays} stays sobre habitaciones AUDIT fuera del conjunto borrado: esas habitaciones se conservan.`);
  const roomTasks = await prisma.housekeepingTask.findMany({ where: { roomId: { in: auditRoomIds } }, select: { id: true } });
  const windowTasks = await prisma.housekeepingTask.findMany({
    where: { propertyId: { in: propertyIds }, createdAt: { gte: AUDIT_WINDOW_START, lte: excludeAfter } },
    select: { id: true }
  });
  const deletableTaskIds = [...new Set([...ids(roomTasks), ...ids(windowTasks)])];
  // Events hang from tasks without an FK: delete them first or they become orphans (Phase E residue).
  const taskEvents = await prisma.housekeepingEvent.findMany({ where: { taskId: { in: deletableTaskIds } }, select: { id: true } });
  planner.add(P, "housekeepingEvent", "housekeeping_events", ids(taskEvents), "eventos de las tareas borradas");
  planner.add(P, "housekeepingTask", "housekeeping_tasks", deletableTaskIds, "creadas en la ventana de auditoría o sobre habitaciones AUDIT");
  planner.add(P, "workOrder", "work_orders", ids(await prisma.workOrder.findMany({ where: { propertyId: { in: propertyIds }, title: AUDIT_TEXT }, select: { id: true } })));
  if (auditRoomStays === 0) planner.add(P, "room", "rooms", auditRoomIds, auditRooms.map((r) => r.number).join(", "));

  const auditRoomTypes = await prisma.roomType.findMany({
    where: { propertyId: { in: propertyIds }, OR: [{ code: AUDIT_TEXT }, { name: AUDIT_TEXT }] },
    select: { id: true, code: true }
  });
  const deletableRoomTypeIds: string[] = [];
  for (const rt of auditRoomTypes) {
    const roomsLeft = await prisma.room.count({ where: { roomTypeId: rt.id, id: { notIn: auditRoomStays === 0 ? auditRoomIds : [] } } });
    const reservationsLeft = await prisma.reservation.count({ where: { roomTypeId: rt.id, id: { notIn: deletableIds } } });
    const rateDaysLeft = await prisma.rateDay.count({ where: { roomTypeId: rt.id } });
    if (roomsLeft === 0 && reservationsLeft === 0 && rateDaysLeft === 0) deletableRoomTypeIds.push(rt.id);
    else plan.skippedRoomTypes.push(`${rt.code} (rooms ${roomsLeft}, reservas ${reservationsLeft}, rate_days ${rateDaysLeft})`);
  }
  planner.add(P, "roomType", "room_types", deletableRoomTypeIds, auditRoomTypes.filter((rt) => deletableRoomTypeIds.includes(rt.id)).map((rt) => rt.code).join(", "));

  // Rate cells written by AUDIT journals + AUDIT rate plans (only when empty).
  const auditJournals = await prisma.rateChangeJournal.findMany({
    where: { propertyId: { in: propertyIds }, reason: AUDIT_TEXT },
    select: { id: true, changesJson: true }
  });
  const cellIds: string[] = [];
  for (const j of auditJournals) {
    const changes = Array.isArray(j.changesJson) ? (j.changesJson as Array<{ date?: string; ratePlanId?: string; roomTypeId?: string }>) : [];
    for (const c of changes) {
      if (!c.date || !c.ratePlanId || !c.roomTypeId) continue;
      const cell = await prisma.rateDay.findFirst({ where: { ratePlanId: c.ratePlanId, roomTypeId: c.roomTypeId, date: dayUtc(c.date) }, select: { id: true } });
      if (cell) cellIds.push(cell.id);
    }
  }
  const auditPlans = await prisma.ratePlan.findMany({ where: { propertyId: { in: propertyIds }, OR: [{ code: AUDIT_TEXT }, { name: AUDIT_TEXT }] }, select: { id: true, code: true } });
  const auditPlanCells = await prisma.rateDay.findMany({ where: { ratePlanId: { in: ids(auditPlans) } }, select: { id: true } });
  planner.add(P, "rateDay", "rate_days", [...cellIds, ...ids(auditPlanCells)], "celdas de journals AUDIT + celdas de planes AUDIT");
  planner.add(P, "rateChangeJournal", "rate_change_journals", ids(auditJournals));
  planner.add(P, "ratePlan", "rate_plans", ids(auditPlans), auditPlans.map((p) => p.code).join(", "));

  const sequences = await prisma.invoiceSequence.findMany({
    where: { propertyId: { in: propertyIds }, OR: [{ prefix: AUDIT_TEXT }, { sequenceCode: AUDIT_TEXT }] },
    select: { id: true, sequenceCode: true, prefix: true }
  });
  assertDeletableSequences(sequences);
  planner.add(P, "invoiceSequence", "invoice_sequences", ids(sequences), sequences.map((s) => s.sequenceCode).join(", "));

  const departments = await prisma.department.findMany({ where: { propertyId: { in: propertyIds }, OR: [{ code: AUDIT_TEXT }, { name: AUDIT_TEXT }] }, select: { id: true } });
  const auditUsers = await prisma.user.findMany({ where: { organizationId, email: AUDIT_EMAIL, createdAt: { lte: excludeAfter } }, select: { id: true, email: true } });
  const auditUserIds = ids(auditUsers);
  planner.add(P, "userDepartment", "user_departments", ids(await prisma.userDepartment.findMany({ where: { OR: [{ departmentId: { in: ids(departments) } }, { userId: { in: auditUserIds } }] }, select: { id: true } })));
  planner.add(P, "department", "departments", ids(departments));
  planner.add(P, "floor", "floors", ids(await prisma.floor.findMany({ where: { propertyId: { in: propertyIds }, name: AUDIT_TEXT }, select: { id: true } })));
  planner.add(P, "housekeepingSection", "housekeeping_sections", ids(await prisma.housekeepingSection.findMany({ where: { propertyId: { in: propertyIds }, OR: [{ code: AUDIT_TEXT }, { name: AUDIT_TEXT }] }, select: { id: true } })));
  planner.add(P, "maintenanceArea", "maintenance_areas", ids(await prisma.maintenanceArea.findMany({ where: { propertyId: { in: propertyIds }, OR: [{ code: AUDIT_TEXT }, { name: AUDIT_TEXT }] }, select: { id: true } })));
  planner.add(P, "housekeepingRule", "housekeeping_rules", ids(await prisma.housekeepingRule.findMany({ where: { propertyId: { in: propertyIds }, ruleCode: AUDIT_TEXT }, select: { id: true } })));
  planner.add(P, "maintenanceRule", "maintenance_rules", ids(await prisma.maintenanceRule.findMany({ where: { propertyId: { in: propertyIds }, ruleCode: AUDIT_TEXT }, select: { id: true } })));
  const allotments = await prisma.allotment.findMany({ where: { propertyId: { in: propertyIds }, OR: [{ code: AUDIT_TEXT }, { name: AUDIT_TEXT }] }, select: { id: true } });
  planner.add(P, "allotmentDay", "allotment_days", ids(await prisma.allotmentDay.findMany({ where: { allotmentId: { in: ids(allotments) } }, select: { id: true } })));
  planner.add(P, "allotment", "allotments", ids(allotments));
  // AUDIT groups: only when every linked reservation is deletable (by id or by
  // group_code) and no MICE event points at them; a KEEP reservation keeps the group.
  const auditGroups: GroupBookingLite[] = await prisma.groupBooking.findMany({
    where: { propertyId: { in: propertyIds }, OR: [{ code: AUDIT_TEXT }, { name: AUDIT_TEXT }] },
    select: { id: true, code: true, name: true }
  });
  const groupEvents = await prisma.event.groupBy({ by: ["groupBookingId"], where: { groupBookingId: { in: ids(auditGroups) } }, _count: { _all: true } });
  const eventsByGroup = new Map<string, number>();
  for (const e of groupEvents) if (e.groupBookingId) eventsByGroup.set(e.groupBookingId, e._count._all);
  const groupsAtAudit = classifyGroupBookings(auditGroups, reservations, deletableSet, eventsByGroup);
  for (const k of groupsAtAudit.kept) {
    plan.keptGroups.push({ groupId: k.group.id, code: k.group.code, name: k.group.name, reason: k.reason });
    planner.warn(`Grupo AUDIT ${k.group.code ?? k.group.id} (${k.group.name}) conservado: ${k.reason}.`);
  }
  const deletableGroupIds = ids(groupsAtAudit.deletable);
  planner.add(P, "groupRoomBlock", "group_room_blocks", ids(await prisma.groupRoomBlock.findMany({ where: { groupBookingId: { in: deletableGroupIds } }, select: { id: true } })));
  planner.add(P, "groupBooking", "group_bookings", deletableGroupIds, groupsAtAudit.deletable.map((g) => g.code ?? g.name).join(", "));
  planner.add(P, "documentTemplate", "document_templates", ids(await prisma.documentTemplate.findMany({ where: { propertyId: { in: propertyIds }, OR: [{ templateCode: AUDIT_TEXT }, { name: AUDIT_TEXT }] }, select: { id: true } })));
  planner.add(P, "propertyZone", "property_zones", ids(await prisma.propertyZone.findMany({ where: { propertyId: { in: propertyIds }, name: AUDIT_TEXT }, select: { id: true } })));
  planner.add(P, "propertySpace", "property_spaces", ids(await prisma.propertySpace.findMany({ where: { propertyId: { in: propertyIds }, name: AUDIT_TEXT }, select: { id: true } })));
  planner.add(P, "channel", "channels", ids(await prisma.channel.findMany({ where: { propertyId: { in: propertyIds }, name: AUDIT_TEXT }, select: { id: true } })));
  planner.add(P, "upsellOffer", "upsell_offers", ids(await prisma.upsellOffer.findMany({ where: { propertyId: { in: propertyIds }, name: AUDIT_TEXT }, select: { id: true } })));
  planner.add(P, "bankAccount", "bank_accounts", ids(await prisma.bankAccount.findMany({ where: { organizationId, name: AUDIT_TEXT }, select: { id: true } })));
  planner.add(P, "gdprRequest", "gdpr_requests", ids(await prisma.gdprRequest.findMany({ where: { organizationId, requestorEmail: AUDIT_EMAIL }, select: { id: true } })));
  planner.add(P, "tourOperator", "tour_operators", ids(await prisma.tourOperator.findMany({ where: { organizationId, OR: [{ code: AUDIT_TEXT }, { name: AUDIT_TEXT }] }, select: { id: true } })));

  // POS: every ticket of the audit window is a fixture (none of the July
  // walkthrough sold through POS); id-like outlet names (out_casino) too.
  const posOrders = await prisma.posOrder.findMany({ where: { propertyId: { in: propertyIds }, createdAt: { gte: AUDIT_WINDOW_START, lte: excludeAfter } }, select: { id: true } });
  planner.add(P, "posOrderLine", "pos_order_lines", ids(await prisma.posOrderLine.findMany({ where: { posOrderId: { in: ids(posOrders) } }, select: { id: true } })));
  planner.add(P, "posOrder", "pos_orders", ids(posOrders), "creados en la ventana de auditoría");
  const outlets = await prisma.outlet.findMany({ where: { propertyId: { in: propertyIds }, OR: [{ name: AUDIT_TEXT }, { name: { startsWith: "out_" } }] }, select: { id: true, name: true } });
  const outletIds: string[] = [];
  for (const o of outlets) {
    const remaining = await prisma.posOrder.count({ where: { outletId: o.id, id: { notIn: ids(posOrders) } } });
    if (remaining === 0) outletIds.push(o.id);
    else planner.warn(`Outlet ${o.name} conservado: ${remaining} tickets fuera de la ventana.`);
  }
  planner.add(P, "outlet", "outlets", outletIds, outlets.filter((o) => outletIds.includes(o.id)).map((o) => o.name).join(", "));

  // Messaging: conversations of deleted reservations / exclusive guests go
  // whole; elsewhere only the messages carrying "AUDIT-" in body or metadata
  // (msg_d7a701d8 "AUDIT-T1 admin probe" sits in the walkthrough conversation
  // conv_maria, which stays). Attachments first, conversation last.
  const conversations = await prisma.conversation.findMany({
    where: { propertyId: { in: propertyIds }, createdAt: { lte: excludeAfter } },
    select: { id: true, reservationId: true, guestId: true }
  });
  const exclusiveGuestSet = new Set(exclusiveGuestIds);
  const deletableConversationIds = ids(conversations.filter((c) => (c.reservationId !== null && deletableSet.has(c.reservationId)) || (c.guestId !== null && exclusiveGuestSet.has(c.guestId))));
  const conversationMessages = await prisma.message.findMany({ where: { conversationId: { in: deletableConversationIds } }, select: { id: true } });
  // metadata_json is Json in Prisma: the text search needs SQL (read-only, parameterised).
  const markerMessages = conversations.length === 0
    ? []
    : await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT m.id FROM messages m
         WHERE m.conversation_id IN (${conversations.map((_, i) => `$${i + 1}`).join(",")})
           AND m.sent_at <= $${conversations.length + 1}::timestamp
           AND (m.body ILIKE $${conversations.length + 2} OR m.metadata_json::text ILIKE $${conversations.length + 2})`,
        ...ids(conversations),
        sqlTimestamp(excludeAfter),
        `%${AUDIT_MARKER}%`
      );
  const messageIds = [...new Set([...ids(conversationMessages), ...ids(markerMessages)])];
  planner.add(P, "messageAttachment", "message_attachments", ids(await prisma.messageAttachment.findMany({ where: { messageId: { in: messageIds } }, select: { id: true } })));
  planner.add(P, "message", "messages", messageIds, `${conversationMessages.length} de conversaciones borradas · ${markerMessages.length} con marcador ${AUDIT_MARKER}`);
  planner.add(P, "conversation", "conversations", deletableConversationIds, "de reservas borradas o huéspedes exclusivos");

  // Users, sessions, roles.
  // Sessions of AUDIT users, plus sessions any user of the org opened from an
  // audit device (device_id audit_2026_09 / audit-t1-verifier…).
  const orgUserIds = ids(await prisma.user.findMany({ where: { organizationId }, select: { id: true } }));
  const auditSessions = await prisma.session.findMany({
    where: { OR: [{ userId: { in: auditUserIds } }, { userId: { in: orgUserIds }, deviceId: AUDIT_EMAIL }] },
    select: { id: true }
  });
  const sessionIds = ids(auditSessions);
  planner.add(P, "session", "sessions", sessionIds, "de usuarios AUDIT o con device AUDIT");
  planner.add(P, "device", "devices", ids(await prisma.device.findMany({ where: { userId: { in: auditUserIds } }, select: { id: true } })));
  planner.add(P, "passwordResetToken", "password_reset_tokens", ids(await prisma.passwordResetToken.findMany({ where: { userId: { in: auditUserIds } }, select: { id: true } })));
  planner.add(P, "userInvitation", "user_invitations", ids(await prisma.userInvitation.findMany({ where: { userId: { in: auditUserIds } }, select: { id: true } })));
  planner.add(P, "notificationDelivery", "notification_deliveries", ids(await prisma.notificationDelivery.findMany({ where: { organizationId, recipient: { in: auditUsers.map((u) => u.email) } }, select: { id: true } })));
  const auditRoles = await prisma.role.findMany({ where: { organizationId, name: AUDIT_TEXT }, select: { id: true } });
  planner.add(P, "userPropertyRole", "user_property_roles", ids(await prisma.userPropertyRole.findMany({ where: { OR: [{ userId: { in: auditUserIds } }, { roleId: { in: ids(auditRoles) } }] }, select: { id: true } })));
  planner.add(P, "user", "users", auditUserIds, auditUsers.map((u) => u.email).join(", "));
  planner.add(P, "rolePermission", "role_permissions", ids(await prisma.rolePermission.findMany({ where: { roleId: { in: ids(auditRoles) } }, select: { id: true } })));
  planner.add(P, "role", "roles", ids(auditRoles));

  // ── Phase C · re-date expired walkthrough bookings ─────────────────────
  const stale = reservations.filter(
    (r) => !isAuditReservation(r) && r.status === "confirmed" && !deletableSet.has(r.id) && dayUtc(r.departureDate).getTime() < dayUtc(today).getTime()
  );
  const shiftable: (ReservationLite & { propertyId: string })[] = [];
  for (const r of stale) {
    const [stayCount, invoiceCount] = await Promise.all([
      prisma.stay.count({ where: { reservationId: r.id } }),
      prisma.invoice.count({ where: { reservationId: r.id } })
    ]);
    if (stayCount === 0 && invoiceCount === 0) shiftable.push(r);
    else planner.warn(`Reserva vencida ${r.code} no desplazada: tiene ${stayCount} stays / ${invoiceCount} facturas.`);
  }
  // One window per property so each hotel keeps its own sequence.
  for (const propertyId of propertyIds) {
    plan.dateShifts.push(...planDateShift(shiftable.filter((r) => r.propertyId === propertyId), today));
  }
  return plan;
}

async function collectFolioCloses(propertyIds: string[], excludedFolioIds: Set<string>): Promise<FolioClose[]> {
  const { getFolioBalance } = await import("../modules/folio/folio.service.js");
  const rows = await prisma.folio.findMany({
    where: { status: "open", deletedAt: null, reservation: { propertyId: { in: propertyIds }, status: "checked_out" } },
    select: { id: true, reservation: { select: { code: true } } }
  });
  const out: FolioClose[] = [];
  for (const f of rows) {
    if (excludedFolioIds.has(f.id)) continue;
    const balance = await getFolioBalance(f.id);
    if (Math.abs(balance.balanceDue) < 0.005) out.push({ folioId: f.id, reservationCode: f.reservation.code, balanceDue: balance.balanceDue });
  }
  return out;
}

// ───────────────────────────────────────────────────────────── phase E · global orphans

/**
 * Rows whose parent no longer exists (no FK in the schema, so nothing
 * cascaded): housekeeping_events of deleted tasks (44 left by the first
 * refresh), messages without conversation, attachments without message and
 * conversations without property / reservation. Read-only SQL here; the
 * deletes go through the Prisma delegates like every other phase. Rows newer
 * than --exclude-after are ignored, as everywhere else.
 */
async function collectOrphans(excludeAfter: Date, planner: Planner): Promise<void> {
  const cutoff = sqlTimestamp(excludeAfter);
  const hkEvents = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT e.id FROM housekeeping_events e LEFT JOIN housekeeping_tasks t ON t.id = e.task_id
     WHERE t.id IS NULL AND e.created_at <= $1::timestamp`,
    cutoff
  );
  const attachments = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT a.id FROM message_attachments a LEFT JOIN messages m ON m.id = a.message_id
     WHERE m.id IS NULL AND a.created_at <= $1::timestamp`,
    cutoff
  );
  const messages = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT m.id FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
     WHERE c.id IS NULL AND m.sent_at <= $1::timestamp`,
    cutoff
  );
  const conversations = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT c.id FROM conversations c
     LEFT JOIN properties p ON p.id = c.property_id
     LEFT JOIN reservations r ON r.id = c.reservation_id
     WHERE (p.id IS NULL OR (c.reservation_id IS NOT NULL AND r.id IS NULL)) AND c.created_at <= $1::timestamp`,
    cutoff
  );
  // Messages of an orphan conversation go with it (they are not orphans yet).
  const orphanConversationMessages = await prisma.message.findMany({ where: { conversationId: { in: ids(conversations) } }, select: { id: true } });
  const orphanConversationAttachments = await prisma.messageAttachment.findMany({ where: { messageId: { in: ids(orphanConversationMessages) } }, select: { id: true } });
  planner.add(PHASE_ORPHANS, "housekeepingEvent", "housekeeping_events", ids(hkEvents), "tarea inexistente");
  planner.add(PHASE_ORPHANS, "messageAttachment", "message_attachments", [...ids(attachments), ...ids(orphanConversationAttachments)], "mensaje inexistente o de conversación huérfana");
  planner.add(PHASE_ORPHANS, "message", "messages", [...ids(messages), ...ids(orphanConversationMessages)], "conversación inexistente o huérfana");
  planner.add(PHASE_ORPHANS, "conversation", "conversations", ids(conversations), "propiedad o reserva inexistente");
}

// ───────────────────────────────────────────────────────────── phase D · reseed when missing

async function collectReseedNeeds(scope: RefreshScope, today: Date): Promise<ReseedNeed[]> {
  const needs: ReseedNeed[] = [];
  if (scope !== "org123" && scope !== "all") return needs;
  let snapshotsNeeded = false;
  for (const propertyId of DEMO_PROPERTY_IDS) {
    const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, name: true, organizationId: true } });
    if (!property || property.organizationId !== DEMO_ORG_ID) continue;
    const activeRooms = await prisma.room.count({ where: { propertyId, active: true } });
    const sellableTypesWithRooms = await prisma.roomType.count({ where: { propertyId, sellable: true, active: true, id: { in: (await prisma.room.findMany({ where: { propertyId, active: true }, select: { roomTypeId: true }, distinct: ["roomTypeId"] })).map((r) => r.roomTypeId) } } });
    const bar = await prisma.ratePlan.findFirst({ where: { propertyId, active: true, OR: [{ code: { equals: "BAR", mode: "insensitive" } }, { ratePlanType: "bar" }] }, select: { id: true } });
    const futureCells = bar ? await prisma.rateDay.findMany({ where: { ratePlanId: bar.id, date: { gte: dayUtc(today) } }, select: { date: true }, distinct: ["date"] }) : [];
    if (futureCells.length < MIN_FUTURE_BAR_DAYS) {
      const prices = DEMO_BAR_PRICES[propertyId];
      if (sellableTypesWithRooms === 0 || !prices) {
        needs.push({ seed: "rates", target: propertyId, reason: `BAR con ${futureCells.length} días futuros (<${MIN_FUTURE_BAR_DAYS}) pero ${sellableTypesWithRooms === 0 ? "sin tipos vendibles con habitaciones" : "sin precios base en DEMO_BAR_PRICES"} → omitido`, env: {} });
      } else {
        needs.push({
          seed: "rates",
          target: propertyId,
          reason: `BAR con ${futureCells.length} días futuros (<${MIN_FUTURE_BAR_DAYS})`,
          env: { SEED_PROPERTY_ID: propertyId, SEED_SCOPE: "rates", SEED_BAR_PRICES: JSON.stringify(prices) }
        });
      }
    }
    const topLevel = await prisma.revenueDailySnapshot.count({ where: { propertyId, roomTypeId: null, ratePlanId: null, channelId: null, segment: null, market: null } });
    if (activeRooms > 0 && topLevel < MIN_DEMO_SNAPSHOT_DAYS) snapshotsNeeded = true;
  }
  if (snapshotsNeeded) {
    needs.push({ seed: "snapshots", target: DEMO_ORG_ID, reason: `alguna propiedad demo con habitaciones tiene <${MIN_DEMO_SNAPSHOT_DAYS} snapshots top-level`, env: { SEED_ORG_ID: DEMO_ORG_ID } });
  }
  return needs;
}

function databaseDir(): string {
  return resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../../packages/database");
}

function runSeed(need: ReseedNeed): void {
  const file = need.seed === "rates" ? "prisma/seed-commercial-demo.ts" : "prisma/seed-revenue-snapshots.ts";
  execFileSync(process.execPath, ["--import", "tsx", file], { cwd: databaseDir(), env: { ...process.env, ...need.env }, stdio: "inherit" });
}

// ───────────────────────────────────────────────────────────── verification helpers

async function chainReports(): Promise<{ audit: ChainReport; events: ChainReport }> {
  const [audit, events] = await Promise.all([
    prisma.auditEvent.findMany({ select: { previousHash: true, currentHash: true } }),
    prisma.eventStream.findMany({ select: { previousHash: true, currentHash: true } })
  ]);
  return { audit: analyseChainLinks(audit), events: analyseChainLinks(events) };
}

type SweepRow = { table: string; column: string; count: number };

/** Rows in every tenant-scoped table that still reference the given org/property ids (raw, read-only). */
async function sweepTenantRows(orgIds: string[], propertyIds: string[]): Promise<SweepRow[]> {
  if (orgIds.length === 0 && propertyIds.length === 0) return [];
  const columns = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name IN ('organization_id','organizationId','property_id','propertyId')
       AND table_name NOT IN ('organizations','properties') ORDER BY table_name, column_name`
  );
  // One query per table: a row counts once even when the table carries both
  // an organization_id and a property_id column.
  const byTable = new Map<string, string[]>();
  for (const c of columns) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(c.table_name) || !/^[a-z_][a-z0-9_]*$/i.test(c.column_name)) continue;
    byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
  }
  const out: SweepRow[] = [];
  for (const [table, cols] of byTable) {
    const params: string[] = [];
    const clauses: string[] = [];
    for (const col of cols) {
      const values = col.toLowerCase().startsWith("organization") ? orgIds : propertyIds;
      if (values.length === 0) continue;
      const placeholders = values.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      clauses.push(`"${col}" IN (${placeholders.join(",")})`);
    }
    if (clauses.length === 0) continue;
    const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE ${clauses.join(" OR ")}`, ...params);
    const n = rows[0]?.n ?? 0;
    if (n > 0) out.push({ table, column: cols.join("|"), count: n });
  }
  return out;
}

export type Inventory = Record<string, number | Record<string, number>>;

async function inventory(): Promise<Inventory> {
  const byProperty = async (rows: { propertyId: string; _count: { _all: number } }[]) => Object.fromEntries(rows.map((r) => [r.propertyId, r._count._all]));
  const [reservations, invoicesHash, snapshots] = await Promise.all([
    prisma.reservation.groupBy({ by: ["propertyId"], _count: { _all: true } }),
    prisma.invoice.groupBy({ by: ["propertyId"], where: { verifactuHash: { not: null } }, _count: { _all: true } }),
    prisma.revenueDailySnapshot.groupBy({ by: ["dataSource"], _count: { _all: true } })
  ]);
  return {
    organizations: await prisma.organization.count(),
    properties: await prisma.property.count(),
    users: await prisma.user.count(),
    roles: await prisma.role.count(),
    reservations: await byProperty(reservations),
    guests: await prisma.guest.count(),
    rooms: await prisma.room.count(),
    room_types: await prisma.roomType.count(),
    folios_open: await prisma.folio.count({ where: { status: "open" } }),
    folios_closed: await prisma.folio.count({ where: { status: "closed" } }),
    folio_lines: await prisma.folioLine.count(),
    payments: await prisma.payment.count(),
    invoices_with_hash: await byProperty(invoicesHash),
    invoices_drafts: await prisma.invoice.count({ where: { verifactuHash: null } }),
    invoice_lines: await prisma.invoiceLine.count(),
    verifactu_submissions: await prisma.verifactuSubmission.count(),
    ses_hospedajes_submissions: await prisma.sesHospedajesSubmission.count(),
    guest_register_records: await prisma.guestRegisterRecord.count(),
    pos_orders: await prisma.posOrder.count(),
    housekeeping_tasks: await prisma.housekeepingTask.count(),
    rate_days: await prisma.rateDay.count(),
    revenue_daily_snapshots: Object.fromEntries(snapshots.map((s) => [s.dataSource, s._count._all])),
    audit_events: await prisma.auditEvent.count(),
    event_stream: await prisma.eventStream.count()
  };
}

function systemContext(organizationId: string, propertyId: string): UserContext {
  return {
    organizationId,
    propertyId,
    userId: SYSTEM_USER_ID,
    fullName: "Refresco del dataset demo",
    deviceId: "demo-refresh",
    permissions: ["pms.checkout.execute", "pms.reservation.modify"] as PermissionKey[]
  };
}

// ───────────────────────────────────────────────────────────── summary + runner

export type RefreshSummary = {
  dryRun: boolean;
  scope: RefreshScope;
  excludeAfter: string;
  today: string;
  auditOrgs: { id: string; name: string; propertyIds: string[]; planned: boolean }[];
  deletions: { phase: string; table: string; count: number; note?: string; sample: string[] }[];
  deletionTotals: Record<string, number>;
  keep: KeepPlan[];
  keptGroups: GroupKeepPlan[];
  keptGuests: GuestKeepPlan[];
  orphanCheckIns: { reservationId: string; code: string }[];
  roomFrees: RoomFree[];
  dateShifts: DateShift[];
  folioCloses: FolioClose[];
  skippedRoomTypes: string[];
  reseed: ReseedNeed[];
  chains: { before: { audit: ChainReport; events: ChainReport }; after?: { audit: ChainReport; events: ChainReport } };
  residual: SweepRow[];
  inventory: { before: Inventory; after?: Inventory };
  applied?: { deleted: Record<string, number>; keepActions: { code: string; action: KeepAction; result: string }[]; dateShifts: number; roomFrees: number; folioCloses: number; reseeds: string[] };
  warnings: string[];
  errors: string[];
  durationMs: number;
};

export async function runRefresh(flags: RefreshFlags, today: Date = dayUtc()): Promise<RefreshSummary> {
  const start = Date.now();
  const planner = new Planner();
  const errors: string[] = [];
  const doA = flags.scope === "audit-orgs" || flags.scope === "all";
  const doFaranda = flags.scope === "faranda" || flags.scope === "all";
  const doOrg123 = flags.scope === "org123" || flags.scope === "all";

  const inventoryBefore = await inventory();
  const chainsBefore = await chainReports();

  // Phase A plan.
  const auditOrgs = doA ? await findAuditOrgs(flags.excludeAfter) : [];
  const auditOrgSummary: RefreshSummary["auditOrgs"] = [];
  for (const org of auditOrgs) {
    const planned = await collectAuditOrg(org, planner);
    auditOrgSummary.push({ id: org.id, name: org.name, propertyIds: org.propertyIds, planned });
  }

  // Phase B / B′ plan.
  const tenants: TenantScope[] = [];
  if (doFaranda) {
    const faranda = await prisma.property.findMany({ where: { organizationId: FARANDA_ORG_ID }, select: { id: true } });
    tenants.push({ label: "faranda", organizationId: FARANDA_ORG_ID, propertyIds: ids(faranda) });
  }
  if (doOrg123) {
    const demo = await prisma.property.findMany({ where: { organizationId: DEMO_ORG_ID }, select: { id: true } });
    tenants.push({ label: "org123", organizationId: DEMO_ORG_ID, propertyIds: ids(demo) });
  }
  const tenantPlans: TenantPlan[] = [];
  for (const t of tenants) tenantPlans.push(await collectTenantResidue(t, flags, today, planner));
  const keep = tenantPlans.flatMap((p) => p.keep);
  const keptGroups = tenantPlans.flatMap((p) => p.keptGroups);
  const keptGuests = tenantPlans.flatMap((p) => p.keptGuests);
  const orphanCheckIns = tenantPlans.flatMap((p) => p.orphanCheckIns);
  const roomFrees = tenantPlans.flatMap((p) => p.roomFrees);
  const dateShifts = tenantPlans.flatMap((p) => p.dateShifts);
  const skippedRoomTypes = tenantPlans.flatMap((p) => p.skippedRoomTypes);
  const plannedFolioIds = new Set(planner.deletions.filter((d) => d.model === "folio").flatMap((d) => d.ids));
  const tenantPropertyIds = tenants.flatMap((t) => t.propertyIds);
  let folioCloses = tenantPropertyIds.length > 0 ? await collectFolioCloses(tenantPropertyIds, plannedFolioIds) : [];
  const reseed = await collectReseedNeeds(flags.scope, today);
  // Phase E plan: global, independent of scope (orphans belong to no tenant).
  await collectOrphans(flags.excludeAfter, planner);

  const deletionTotals: Record<string, number> = {};
  for (const d of planner.deletions) deletionTotals[d.table] = (deletionTotals[d.table] ?? 0) + d.ids.length;

  const summary: RefreshSummary = {
    dryRun: !flags.apply,
    scope: flags.scope,
    excludeAfter: flags.excludeAfter.toISOString(),
    today: isoDate(dayUtc(today)),
    auditOrgs: auditOrgSummary,
    deletions: planner.deletions.map((d) => ({ phase: d.phase, table: d.table, count: d.ids.length, note: d.note, sample: d.ids.slice(0, SAMPLE) })),
    deletionTotals,
    keep,
    keptGroups,
    keptGuests,
    orphanCheckIns,
    roomFrees,
    dateShifts,
    folioCloses,
    skippedRoomTypes,
    reseed,
    chains: { before: chainsBefore },
    residual: await sweepTenantRows(auditOrgSummary.filter((o) => o.planned).map((o) => o.id), auditOrgSummary.filter((o) => o.planned).flatMap((o) => o.propertyIds)),
    inventory: { before: inventoryBefore },
    warnings: planner.warnings,
    errors,
    durationMs: 0
  };

  if (!flags.apply) {
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // ── APPLY ───────────────────────────────────────────────────────────────
  const audit = await import("../modules/audit/audit.service.js");
  await audit.hydrateAuditChainFromPostgres();
  const applied: NonNullable<RefreshSummary["applied"]> = { deleted: {}, keepActions: [], dateShifts: 0, roomFrees: 0, folioCloses: 0, reseeds: [] };

  // Phase A: one transaction per AUDIT org.
  for (const org of auditOrgSummary.filter((o) => o.planned)) {
    const own = planner.deletions.filter((d) => d.phase === `A:${org.id}`);
    try {
      const counts = await prisma.$transaction((tx) => executeDeletions(tx, own), TX_OPTIONS);
      for (const [table, n] of Object.entries(counts)) applied.deleted[table] = (applied.deleted[table] ?? 0) + n;
    } catch (error) {
      errors.push(`Fase A ${org.id} (${org.name}) falló: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Phase B1: KEEP reservations through the PMS service (audit-chained).
  if (keep.length > 0) {
    const pms = await import("../modules/pms/pms.service.js");
    for (const k of keep) {
      if (k.action === "none") {
        applied.keepActions.push({ code: k.code, action: k.action, result: `conservada (${k.status})` });
        continue;
      }
      const context = systemContext(k.organizationId, k.propertyId);
      try {
        if (k.action === "check_out") {
          const res = await pms.checkOutReservationDetailed({ context, reservationId: k.reservationId, acknowledgeBalance: true, correlationId: CORRELATION_ID });
          applied.keepActions.push({ code: k.code, action: k.action, result: `checked_out · saldo ${res.balanceDue.toFixed(2)} €${res.balanceAcknowledged ? " reconocido" : ""}` });
        } else {
          await pms.transitionReservation({ context, reservationId: k.reservationId, status: "cancelled", reason: `Fixture AUDIT conservada por ${k.reasons.join(" + ")} (refresco dataset demo)`, correlationId: CORRELATION_ID });
          applied.keepActions.push({ code: k.code, action: k.action, result: "cancelled" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`KEEP ${k.code} (${k.action}) falló: ${message}`);
        applied.keepActions.push({ code: k.code, action: k.action, result: `ERROR ${message}` });
      }
    }
  }

  // Phase B2/B3: deletions of the live tenants in one transaction each.
  for (const t of tenants) {
    const own = planner.deletions.filter((d) => d.phase === `B:${t.label}`);
    if (own.length === 0) continue;
    try {
      const counts = await prisma.$transaction((tx) => executeDeletions(tx, own), TX_OPTIONS);
      for (const [table, n] of Object.entries(counts)) applied.deleted[table] = (applied.deleted[table] ?? 0) + n;
    } catch (error) {
      errors.push(`Fase B ${t.label} falló: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Phase E: global orphans, one transaction (planned from the state before
  // A/B ran; rows orphaned by A/B themselves were deleted there explicitly).
  const orphanDeletions = planner.deletions.filter((d) => d.phase === PHASE_ORPHANS);
  if (orphanDeletions.length > 0) {
    try {
      const counts = await prisma.$transaction((tx) => executeDeletions(tx, orphanDeletions), TX_OPTIONS);
      for (const [table, n] of Object.entries(counts)) applied.deleted[table] = (applied.deleted[table] ?? 0) + n;
    } catch (error) {
      errors.push(`Fase E (huérfanos) falló: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Phase C: dates, rooms, folios — recomputed after the deletions so a folio
  // closed by a check-out above is not touched twice.
  folioCloses = tenantPropertyIds.length > 0 ? await collectFolioCloses(tenantPropertyIds, new Set()) : [];
  summary.folioCloses = folioCloses;
  try {
    await prisma.$transaction(async (tx) => {
      for (const s of dateShifts) {
        await tx.reservation.update({ where: { id: s.id }, data: { arrivalDate: dayUtc(s.to.arrival), departureDate: dayUtc(s.to.departure) } });
        applied.dateShifts++;
      }
      for (const r of roomFrees) {
        const inHouse = await tx.stay.count({ where: { roomId: r.roomId, status: "in_house" } });
        if (inHouse > 0) continue;
        await tx.room.update({ where: { id: r.roomId }, data: { status: "clean", housekeepingStatus: "clean" } });
        applied.roomFrees++;
      }
      for (const f of folioCloses) {
        const res = await tx.folio.updateMany({ where: { id: f.folioId, status: "open" }, data: { status: "closed" } });
        applied.folioCloses += res.count;
      }
    }, TX_OPTIONS);
  } catch (error) {
    errors.push(`Fase C falló: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Phase D: seeds through their own demo guard (child processes).
  for (const need of reseed) {
    if (Object.keys(need.env).length === 0) continue;
    try {
      runSeed(need);
      applied.reseeds.push(`${need.seed}:${need.target}`);
    } catch (error) {
      errors.push(`Fase D ${need.seed} ${need.target} falló: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Trail marker + queue flush (audit persistence is asynchronous).
  audit.recordAuditEvent({
    organizationId: DEMO_ORG_ID,
    propertyId: DEMO_PROPERTY_IDS[0],
    actorUserId: SYSTEM_USER_ID,
    actorType: "system",
    action: "DEMO_DATASET_REFRESHED",
    entityType: "dataset",
    entityId: "demo",
    afterJson: {
      scope: flags.scope,
      excludeAfter: flags.excludeAfter.toISOString(),
      auditOrgsDeleted: auditOrgSummary.filter((o) => o.planned).map((o) => o.id),
      deleted: applied.deleted,
      keepActions: applied.keepActions,
      keptGroups: keptGroups.map((g) => ({ code: g.code, reason: g.reason })),
      dateShifts: applied.dateShifts,
      roomFrees: applied.roomFrees,
      folioCloses: applied.folioCloses,
      reseeds: applied.reseeds,
      errors
    },
    correlationId: CORRELATION_ID
  });
  await audit.flushAuditQueues();
  const [projection, extra, hooks, verifactu] = await Promise.all([
    import("../modules/accounting/projection.js"),
    import("../modules/accounting/posting-rules/index.js"),
    import("../modules/notifications/event-hooks.service.js"),
    import("../modules/invoicing/verifactu-submission.service.js")
  ]);
  await projection.flushAccountingProjection();
  await extra.flushExtraProjections();
  await hooks.flushNotificationHooks();
  await verifactu.flushVerifactuQueue();
  await audit.flushAuditQueues();

  // Post-conditions.
  const chainsAfter = await chainReports();
  summary.chains.after = chainsAfter;
  if (chainsAfter.audit.dangling > chainsBefore.audit.dangling) errors.push(`Cadena audit_events con ${chainsAfter.audit.dangling} enlaces colgantes (antes ${chainsBefore.audit.dangling}).`);
  if (chainsAfter.events.dangling > chainsBefore.events.dangling) errors.push(`Cadena event_stream con ${chainsAfter.events.dangling} enlaces colgantes (antes ${chainsBefore.events.dangling}).`);
  summary.residual = await sweepTenantRows(auditOrgSummary.filter((o) => o.planned).map((o) => o.id), auditOrgSummary.filter((o) => o.planned).flatMap((o) => o.propertyIds));
  const unexpected = summary.residual.filter((r) => r.table !== "audit_events" && r.table !== "event_stream");
  if (unexpected.length > 0) errors.push(`Filas residuales de orgs AUDIT: ${unexpected.map((r) => `${r.table}=${r.count}`).join(", ")}`);
  summary.inventory.after = await inventory();
  summary.applied = applied;
  summary.durationMs = Date.now() - start;
  return summary;
}

// ───────────────────────────────────────────────────────────── output

function fmtInventory(inv: Inventory): string[] {
  return Object.entries(inv).map(([k, v]) => `    ${k}: ${typeof v === "number" ? v : Object.entries(v).map(([a, b]) => `${a}=${b}`).join(" · ")}`);
}

export function printHuman(summary: RefreshSummary): void {
  const mode = summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED";
  const lines: string[] = [];
  lines.push(`[demo:refresh] ${mode} · scope ${summary.scope} · today ${summary.today} · exclude-after ${summary.excludeAfter} · ${summary.durationMs} ms`);
  lines.push(`  Fase A · orgs AUDIT: ${summary.auditOrgs.length}`);
  for (const o of summary.auditOrgs) lines.push(`    ${o.planned ? "BORRAR " : "CONSERVAR"} ${o.id} (${o.name}) · properties ${o.propertyIds.join(", ") || "—"}`);
  lines.push(`  Fase B · KEEP (fiscal/SES): ${summary.keep.length}`);
  for (const k of summary.keep) lines.push(`    ${k.code} ${k.status} → ${k.action} [${k.reasons.join(" + ")}]`);
  lines.push(`  Fase B · grupos AUDIT conservados: ${summary.keptGroups.length}`);
  for (const g of summary.keptGroups) lines.push(`    ${g.code ?? g.groupId} (${g.name}) [${g.reason}]`);
  lines.push(`  Fase B · huéspedes AUDIT conservados: ${summary.keptGuests.length}`);
  for (const g of summary.keptGuests) lines.push(`    ${g.guestId} (${g.name}) [${g.reason}]`);
  lines.push(`  Fase B · huérfanas checked_in: ${summary.orphanCheckIns.map((o) => o.code).join(", ") || "—"} · habitaciones liberadas: ${summary.roomFrees.map((r) => r.number).join(", ") || "—"}`);
  if (summary.skippedRoomTypes.length > 0) lines.push(`    room_types AUDIT conservados: ${summary.skippedRoomTypes.join("; ")}`);
  lines.push(`  Borrados previstos por fase/tabla (${summary.deletions.length} grupos):`);
  for (const d of summary.deletions) lines.push(`    ${d.phase.padEnd(30)} ${d.table.padEnd(28)} ×${String(d.count).padStart(5)}${d.note ? `  ${d.note}` : ""}  [${d.sample.join(", ")}${d.count > d.sample.length ? ", …" : ""}]`);
  lines.push(`  Totales por tabla: ${Object.entries(summary.deletionTotals).map(([t, n]) => `${t}=${n}`).join(" · ") || "—"}`);
  lines.push(`  Fase C · desplazamientos de fecha: ${summary.dateShifts.length}`);
  for (const s of summary.dateShifts) lines.push(`    ${s.code}: ${s.from.arrival}→${s.from.departure} ⇒ ${s.to.arrival}→${s.to.departure} (LOS ${s.los})`);
  lines.push(`  Fase C · folios open de checked_out a saldo 0 → cerrar: ${summary.folioCloses.length}${summary.folioCloses.length ? ` (${summary.folioCloses.map((f) => f.reservationCode).join(", ")})` : ""}`);
  lines.push(`  Fase D · reseed: ${summary.reseed.length === 0 ? "nada que sembrar" : ""}`);
  for (const r of summary.reseed) lines.push(`    ${r.seed} ${r.target}: ${r.reason}${Object.keys(r.env).length ? ` → ${Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`);
  lines.push(`  Cadenas hash (antes): audit_events ${summary.chains.before.audit.total} filas · génesis ${summary.chains.before.audit.genesis} · colgantes ${summary.chains.before.audit.dangling} | event_stream ${summary.chains.before.events.total} · génesis ${summary.chains.before.events.genesis} · colgantes ${summary.chains.before.events.dangling}`);
  if (summary.chains.after) lines.push(`  Cadenas hash (después): audit_events ${summary.chains.after.audit.total} · colgantes ${summary.chains.after.audit.dangling} | event_stream ${summary.chains.after.events.total} · colgantes ${summary.chains.after.events.dangling}`);
  lines.push(`  Residuo orgs AUDIT (${summary.dryRun ? "actual" : "tras borrar"}): ${summary.residual.map((r) => `${r.table}=${r.count}`).join(" · ") || "ninguno"}`);
  lines.push("  Inventario antes:");
  lines.push(...fmtInventory(summary.inventory.before));
  if (summary.inventory.after) {
    lines.push("  Inventario después:");
    lines.push(...fmtInventory(summary.inventory.after));
  }
  if (summary.applied) {
    lines.push(`  Aplicado: ${Object.entries(summary.applied.deleted).map(([t, n]) => `${t}=${n}`).join(" · ") || "sin borrados"}`);
    for (const k of summary.applied.keepActions) lines.push(`    KEEP ${k.code} ${k.action}: ${k.result}`);
    lines.push(`    fechas ${summary.applied.dateShifts} · habitaciones ${summary.applied.roomFrees} · folios ${summary.applied.folioCloses} · reseeds ${summary.applied.reseeds.join(", ") || "—"}`);
  }
  for (const w of summary.warnings) lines.push(`  WARN ${w}`);
  for (const e of summary.errors) lines.push(`  ERROR ${e}`);
  if (summary.dryRun) lines.push("  Nada escrito. Haz backup (bash scripts/backup-postgres.sh) y repite con --apply; reinicia el API después.");
  else lines.push("  Reinicia el API: los espejos in-memory de tenants solo se recargan al arrancar.");
  console.log(lines.join("\n"));
}

// CLI entrypoint: only runs when invoked directly (same guard as backfill-snapshots.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: RefreshFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[demo:refresh] ${(error as Error).message}`);
    process.exit(2);
  }
  runRefresh(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      await prisma.$disconnect();
      return summary.errors.length;
    })
    .then((failed) => process.exit(failed > 0 ? 1 : 0))
    .catch(async (error) => {
      console.error("[demo:refresh] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function enforceSpanishIdScanPolicy(request) {
  const errors = [];
  if (request.documentImageStored !== false) {
    errors.push("ID document images must not be stored for hospedaje compliance.");
  }
  if (request.idImageDiscarded !== true) {
    errors.push("The original ID image must be discarded and the deletion event logged.");
  }
  return errors.length ? { allowed: false, errors } : { allowed: true, errors: [], auditAction: "ID_IMAGE_DISCARDED" };
}

function detectMissingGuestRegisterFields(fields) {
  return ["firstName", "surname1", "documentType", "documentNumber", "nationality", "dateOfBirth", "phone"].filter(
    (field) => fields[field] === undefined || fields[field] === null || String(fields[field]).trim() === ""
  );
}

function calculateGuestRegisterRetentionUntil(createdAt) {
  const retentionUntil = new Date(createdAt);
  retentionUntil.setFullYear(retentionUntil.getFullYear() + 3);
  return retentionUntil;
}

function assertInvoiceMutable(status) {
  if (status !== "draft") {
    throw new Error("Issued invoices are immutable. Use cancellation, credit note, or rectifying invoice workflow.");
  }
}

function assertBalancedJournal(lines) {
  const debit = lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = lines.reduce((sum, line) => sum + line.credit, 0);
  if (Math.round((debit - credit) * 100) !== 0) {
    throw new Error("Journal entry is not balanced.");
  }
}

function readAllFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? readAllFiles(path) : [path];
  });
}

describe("HotelOS safety rules", () => {
  it("rejects ID scan requests that store document images", () => {
    const result = enforceSpanishIdScanPolicy({
      documentImageStored: true,
      idImageDiscarded: false
    });

    assert.equal(result.allowed, false);
    assert.match(result.errors.join(" "), /must not be stored/);
  });

  it("accepts extract-and-discard ID scan requests and requires deletion audit", () => {
    const result = enforceSpanishIdScanPolicy({
      documentImageStored: false,
      idImageDiscarded: true
    });

    assert.equal(result.allowed, true);
    assert.equal(result.auditAction, "ID_IMAGE_DISCARDED");
  });

  it("detects missing required guest register fields", () => {
    const missing = detectMissingGuestRegisterFields({
      firstName: "Maria",
      surname1: "Lopez",
      documentType: "DNI",
      documentNumber: "12345678X",
      nationality: "ES",
      dateOfBirth: "1986-04-18"
    });

    assert.deepEqual(missing, ["phone"]);
  });

  it("calculates guest register retention as three years", () => {
    assert.equal(calculateGuestRegisterRetentionUntil(new Date("2026-05-14T00:00:00Z")).toISOString(), "2029-05-14T00:00:00.000Z");
  });

  it("blocks destructive edits to issued invoices", () => {
    assert.throws(() => assertInvoiceMutable("issued"), /immutable/);
    assert.doesNotThrow(() => assertInvoiceMutable("draft"));
  });

  it("requires double-entry journals to balance", () => {
    assert.doesNotThrow(() =>
      assertBalancedJournal([
        { accountCode: "572", debit: 480, credit: 0 },
        { accountCode: "430", debit: 0, credit: 480 }
      ])
    );

    assert.throws(() => assertBalancedJournal([{ accountCode: "572", debit: 480, credit: 0 }]), /not balanced/);
  });

  it("keeps AI Gateway away from direct database access", () => {
    const files = readAllFiles(fileURLToPath(new URL("../apps/ai-gateway/src", import.meta.url)));
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");

    assert.equal(source.includes("@hotelos/database"), false);
    assert.equal(source.includes("@prisma/client"), false);
    assert.equal(source.includes("PrismaClient"), false);
  });

  it("keeps audit and AI tool call tables in the schema", () => {
    const schema = readFileSync(new URL("../packages/database/prisma/schema.prisma", import.meta.url), "utf8");
    assert.match(schema, /@@map\("audit_events"\)/);
    assert.match(schema, /@@map\("ai_tool_calls"\)/);
    assert.match(schema, /@@map\("event_stream"\)/);
  });
});

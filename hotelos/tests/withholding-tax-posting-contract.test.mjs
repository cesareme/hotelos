import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const withholdingRule = readFileSync(
  new URL("../apps/api/src/modules/accounting/posting-rules/withholding-tax.ts", import.meta.url),
  "utf8"
);
const postingRulesIndex = readFileSync(
  new URL("../apps/api/src/modules/accounting/posting-rules/index.ts", import.meta.url),
  "utf8"
);
const auditService = readFileSync(
  new URL("../apps/api/src/modules/audit/audit.service.ts", import.meta.url),
  "utf8"
);
const accountingService = readFileSync(
  new URL("../apps/api/src/modules/accounting/accounting.service.ts", import.meta.url),
  "utf8"
);
const modelo111Service = readFileSync(
  new URL("../apps/api/src/modules/accounting/modelo-111.service.ts", import.meta.url),
  "utf8"
);
const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
const schema = readFileSync(
  new URL("../packages/database/prisma/schema.prisma", import.meta.url),
  "utf8"
);

describe("Withholding-tax posting rule (Modelo 111 IRPF) contract", () => {
  it("exposes a dedicated withholding-tax posting rule module", () => {
    assert.match(withholdingRule, /export\s+async\s+function\s+upsertWithholdingRecord/);
    assert.match(withholdingRule, /export\s+function\s+draftFromEvent/);
    assert.match(withholdingRule, /export\s+async\s+function\s+recordWithholdingFromEvent/);
  });

  it("maps domain events to the correct AEAT row code", () => {
    // 02 = profesionales (default for vendor invoices)
    assert.match(withholdingRule, /vendor_invoice:\s*"02"/);
    // 01 = rendimientos del trabajo (payroll)
    assert.match(withholdingRule, /payroll_payment:\s*"01"/);
    assert.match(withholdingRule, /case\s+"SupplierBillCreated"/);
    assert.match(withholdingRule, /case\s+"InvoiceIssued"/);
  });

  it("upserts idempotently by (sourceType, sourceId)", () => {
    // The rule must look up an existing record before inserting.
    assert.match(withholdingRule, /findFirst\(\{[\s\S]*?sourceType:\s*draft\.sourceType[\s\S]*?sourceId:\s*draft\.sourceId/);
    // And must perform either an update or a create.
    assert.match(withholdingRule, /\.update\(/);
    assert.match(withholdingRule, /\.create\(/);
    // The upsert must run inside a transaction to avoid race-condition dupes.
    assert.match(withholdingRule, /\$transaction/);
  });

  it("uses Prisma Decimal-safe monetary representations (no float)", () => {
    // No JavaScript `Number(` coercion at write time for monetary fields.
    // Values are passed through as strings (fixed 2-decimal) or Decimal.
    assert.match(withholdingRule, /toDecimal/);
    assert.match(withholdingRule, /toFixed\(2\)/);
    // Type pulled from @hotelos/database / Prisma:
    assert.match(withholdingRule, /Prisma.*Decimal/);
  });

  it("registers the rule in the posting-rules dispatcher", () => {
    assert.match(postingRulesIndex, /recordWithholdingFromEvent/);
    assert.match(postingRulesIndex, /queueExtraProjections/);
    // Handlers must be idempotent and non-throwing — failures are logged.
    assert.match(postingRulesIndex, /catch\s*\(error\)/);
  });

  it("wires the dispatcher into the domain-event recorder", () => {
    assert.match(auditService, /queueExtraProjections/);
    assert.match(auditService, /from\s+"\.\.\/accounting\/posting-rules/);
    // Called for every domain event:
    assert.match(auditService, /recordDomainEvent[\s\S]{0,800}queueExtraProjections\(event\)/);
  });

  it("propagates retention fields from supplier bills onto the SupplierBillCreated event", () => {
    // The supplier-bill draft now carries retention fields,
    assert.match(accountingService, /retentionRate\?:\s*number/);
    assert.match(accountingService, /retentionAmount\?:\s*number/);
    assert.match(accountingService, /rowCode\?:\s*string/);
    // and they end up on the SupplierBillCreated event payload so the
    // withholding-tax posting rule can pick them up off the event stream.
    assert.match(
      accountingService,
      /eventType:\s*"SupplierBillCreated",[\s\S]*?retentionRate:[\s\S]*?retentionAmount:[\s\S]*?rowCode:/
    );
  });

  it("exposes retention fields on the supplier-bill HTTP route", () => {
    assert.match(server, /\/supplier-bills\/drafts/);
    // Body fields are forwarded to the service.
    assert.match(
      server,
      /createSupplierBillDraft\(\{[\s\S]*?retentionRate:\s*body\.retentionRate[\s\S]*?retentionAmount:\s*body\.retentionAmount[\s\S]*?rowCode:\s*body\.rowCode/
    );
  });

  it("matches the WithholdingTaxRecord schema columns it writes to", () => {
    // Every monetary field the rule writes must exist in schema.prisma — we
    // cannot add columns from this task, so this guards drift.
    for (const field of [
      "organizationId",
      "propertyId",
      "sourceType",
      "sourceId",
      "recipientNif",
      "recipientName",
      "grossAmount",
      "retentionRate",
      "retentionAmount",
      "rowCode",
      "paymentDate"
    ]) {
      assert.match(withholdingRule, new RegExp(field));
    }
    // And the schema still has the WithholdingTaxRecord model with those columns.
    assert.match(schema, /model WithholdingTaxRecord/);
    assert.match(schema, /retentionAmount\s+Decimal/);
    assert.match(schema, /rowCode\s+String/);
  });

  it("computes retentionAmount from retentionRate when only the rate is provided", () => {
    // Compute path: grossBase * (rate%) rounded to 2 decimals.
    assert.match(accountingService, /input\.total\s*-\s*input\.taxTotal/);
    assert.match(accountingService, /Math\.round\(grossBase\s*\*\s*ratePct\s*\*\s*100\)\s*\/\s*100/);
    // And again on the rule side, in case an event arrives with rate but no amount.
    assert.match(withholdingRule, /Math\.round\(gross\s*\*\s*ratePct\s*\*\s*100\)\s*\/\s*100/);
  });

  it("produces row-02 (profesionales) records that flow into Modelo 111 casillas 7/8/9", () => {
    // The rule writes rowCode "02" by default for vendor invoices…
    assert.match(withholdingRule, /MODELO_111_ROW_DEFAULTS/);
    // …and Modelo 111 maps row 02 to casillas 7 (perceptores), 8 (base), 9 (retenciones).
    assert.match(
      modelo111Service,
      /code:\s*"02"[\s\S]*?perceptores:\s*7[\s\S]*?base:\s*8[\s\S]*?retenciones:\s*9/
    );
  });

  it("never inserts duplicate records — handler returns silently for zero-retention events", () => {
    // The draft builder bails out when both rate and amount are zero.
    assert.match(
      withholdingRule,
      /if\s*\(\s*retentionRate\s*<=\s*0\s*&&\s*retentionAmount\s*<=\s*0\s*\)\s*return null/
    );
    // And `recordWithholdingFromEvent` short-circuits on a null draft.
    assert.match(
      withholdingRule,
      /if\s*\(\s*!draft\s*\)\s*return/
    );
  });
});

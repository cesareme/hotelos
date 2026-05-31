import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("reservation, billing and reporting entry points", () => {
  it("defines a product route map for reservations, billing and reports", () => {
    const routeMap = read("packages/product/src/navigation/reservation-commerce-route-map.ts");
    for (const marker of [
      "reservation_create",
      "/backoffice/reservations/new",
      "/properties/:propertyId/reservations",
      "folio_billing",
      "/backoffice/billing/center",
      "invoice_lifecycle",
      "reporting_center",
      "/reports/properties/:propertyId/export",
      "reservation_reports",
      "billing_reports"
    ]) {
      assert.match(routeMap, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("exposes API routes for reports and keeps PMS billing routes visible", () => {
    const server = read("apps/api/src/server.ts");
    const permissions = read("apps/api/src/security/route-permissions.ts");
    for (const route of [
      "/properties/:propertyId/availability/quote",
      "/properties/:propertyId/reservations",
      "/reservations/:id/folio",
      // Invoice drafts are now created from a folio (POST /folios/:id/invoice)
      // rather than a standalone POST /invoices/drafts.
      "/folios/:id/invoice",
      "/reports/properties/:propertyId/catalog",
      "/reports/properties/:propertyId/reservations",
      "/reports/properties/:propertyId/billing",
      "/reports/properties/:propertyId/export"
    ]) {
      const escaped = route.replace(/[/:]/g, "\\$&");
      assert.match(server, new RegExp(escaped));
      assert.match(permissions, new RegExp(escaped));
    }
  });

  it("adds admin routes and sidebar navigation for reservation creation, billing and reports", () => {
    const routes = read("apps/admin-web/src/routes/backoffice.routes.tsx");
    const sidebar = read("apps/admin-web/src/navigation/Sidebar.tsx");
    const app = read("apps/admin-web/src/App.tsx");
    for (const marker of [
      "ReservationWorkspace",
      "ReservationCreate",
      "ReservationDetailWorkspace",
      "BillingCenter",
      "ReportingCenter",
      "/backoffice/reservations",
      "/backoffice/reservations/new",
      "/backoffice/billing/center",
      "/backoffice/reports"
    ]) {
      assert.match(routes + sidebar + app, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("adds configurable reservation categories and persistence fields", () => {
    const backoffice = read("apps/api/src/modules/backoffice/backoffice.service.ts");
    const pms = read("apps/api/src/modules/pms/pms.service.ts");
    const schema = read("packages/database/prisma/schema.prisma");
    for (const marker of [
      "reservation_source_codes",
      "reservation_statuses",
      "guarantee_policies",
      "cancellation_policies",
      "billing_instruction_types",
      "marketSegment",
      "sourceCode",
      "guaranteeType",
      "billingInstruction"
    ]) {
      assert.match(backoffice + pms + schema, new RegExp(marker));
    }
  });

  it("makes local demo entry points visible for manual hotel input", () => {
    const html = read("demo/public/index.html");
    const js = read("demo/public/app.js");
    for (const marker of [
      "Create Reservation",
      "Reservations Workspace",
      "Billing Center",
      "Reports Center",
      "reservationSaveButton",
      "invoiceSaveButton",
      "reportExportButton",
      "saveReservationDemo",
      "saveInvoiceDemo",
      "generateReportDemo"
    ]) {
      assert.match(html + js, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});

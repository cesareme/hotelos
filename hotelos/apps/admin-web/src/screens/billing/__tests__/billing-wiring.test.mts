import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Corrector L3 ronda 1 (FUX-07): the SCREENS of the money path cannot load
// under node --test (they reach api-client / import.meta.env), so their wiring
// is pinned on the source, like pos-dashboard-summary.test.mts does for the
// TPV board: the billing centre searches reservations with q + cursor, both
// «Añadir cargo» forms send an explicit `taxCategory` restricted to the
// categories compatible with the type, the invoice cancellation resends
// `supervisorAuthorizationId`, the cancel / no-show dialogs send `applyPolicy`
// and lift a 409 APPROVAL_REQUIRED of a waiver with the supervisor PIN, and
// the timeline demands the same reason the reservation form demands.

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const billingCentre = source("../BillingCenterScreen.tsx");
const reservation = source("../../reservations/ReservationWorkspaceScreen.tsx");
// U7: cancelar / no-show y la renuncia con PIN de supervisor viven en el diálogo compartido con Mi día.
const lifecycle = source("../../../components/reservations/LifecycleDialog.tsx");
const reservationCreate = source("../../reservations/ReservationCreateScreen.tsx");
const timeline = source("../../timeline/LiveTimeline.tsx");
const timelineDialog = source("../../../components/timeline/TimelineActionDialog.tsx");
const client = source("../../../services/pmsCommerceApi.ts");

describe("Centro de facturación · cableado (BillingCenterScreen.tsx)", () => {
  it("busca reservas con q + cursor (billingSearch) en vez de una única página de 200", () => {
    assert.match(billingCentre, /buildReservationSearchQuery\(/);
    assert.match(billingCentre, /mergeReservationPages\(/);
    assert.doesNotMatch(billingCentre, /limit:\s*200/);
  });

  it("«Añadir cargo» envía taxCategory explícita y solo ofrece las categorías compatibles con el tipo (FC-4)", () => {
    assert.match(billingCentre, /taxCategoryOptionsForType\(chargeForm\.type, TAX_CATEGORY_OPTIONS\)/);
    assert.match(billingCentre, /taxCategory: chargeForm\.taxCategory/);
    assert.match(billingCentre, /taxCategory: defaultTaxCategoryForType\(type\)/, "al cambiar el tipo la categoría vuelve a la que infiere el API");
  });

  it("«Añadir cargo» reparte los cinco campos en dos filas (3 + 2): la categoría fiscal va junto al tipo (FUX-06)", () => {
    const section = billingCentre.slice(billingCentre.indexOf('title="Añadir cargo"'), billingCentre.indexOf('title="Borrador de factura"'));
    assert.match(section, /<CocoaFormRow columns=\{3\} min=\{150\}>/);
    assert.match(section, /<CocoaFormRow columns=\{2\} min=\{150\}>/);
    assert.doesNotMatch(section, /<CocoaFormRow columns=\{4\}/);
    assert.doesNotMatch(section, /style=\{\{/, "cero style={} nuevos (Cocoa 22)");
  });

  it("la anulación reenvía supervisorAuthorizationId tras el 409 y el aviso no promete una solicitud que la pantalla no crea (FUX-04)", () => {
    assert.match(billingCentre, /\.\.\.\(supervisorAuthorizationId \? \{ supervisorAuthorizationId \} : \{\}\)/);
    assert.match(billingCentre, /permissionKey="invoice\.cancel_approve"/);
    assert.doesNotMatch(billingCentre, /abre una solicitud en Hoy › Pendientes de aprobación/);
    assert.match(billingCentre, /todavía no crea solicitudes de anulación/);
  });
});

describe("Ficha de reserva · cableado (ReservationWorkspaceScreen.tsx + components/reservations/LifecycleDialog.tsx, U7)", () => {
  it("cancelar y no-show envían applyPolicy (y el PIN si lo hay) y leen la vista previa con el modo", () => {
    assert.match(reservation, /<LifecycleDialog[\s\S]*?allowWaiver/);
    assert.match(lifecycle, /previewCancellationCharge\(reservation\.id, mode\)/);
    assert.match(lifecycle, /supervisorAuthorizationId: waiverAuthorization\.id/);
    assert.match(lifecycle, /cancelReservation\(reservation\.id, text, options\)/);
    assert.match(lifecycle, /noShowReservation\(reservation\.id, text, options\)/);
  });

  it("una renuncia por encima del tramo (409 APPROVAL_REQUIRED) ofrece el PIN de supervisor sobre pms.reservation.override (DS-02)", () => {
    assert.match(lifecycle, /financeErrorCode\(error\) === "APPROVAL_REQUIRED"/);
    assert.match(lifecycle, /permissionKey="pms\.reservation\.override"/);
    assert.match(lifecycle, /entityType="reservation"/);
    assert.match(lifecycle, /Autorizar con PIN de supervisor/);
  });

  it("«Añadir cargo» de la ficha envía taxCategory y solo las categorías compatibles con el tipo (DS-08)", () => {
    assert.match(reservation, /taxCategoryOptionsForType\(chargeType, TAX_CATEGORY_OPTIONS\)/);
    assert.match(reservation, /taxCategory: chargeTaxCategory/);
  });

  it("el motivo es obligatorio en cancelación y no-show y cada toast habla de su acción (FUX-05)", () => {
    assert.match(lifecycle, /Indica el motivo de la cancelación\./);
    assert.match(lifecycle, /Indica el motivo del no-show\./);
    assert.match(lifecycle, /confirmDisabled=\{!reason\.trim\(\) \|\| preview\.loading\}/);
  });
});

describe("Live Timeline · cableado (LiveTimeline.tsx + components/timeline/TimelineActionDialog.tsx; fusión TL: sustituye a LiveTimelineWorkspace.tsx)", () => {
  it("exige el motivo para cancelar / no-show, como la ficha (FUX-05)", () => {
    assert.match(timelineDialog, /\(type === "cancel" \|\| type === "noshow"\) && reason\.trim\(\)\.length < MIN_REASON_LENGTH/);
    assert.match(timelineDialog, /<CocoaField label="Motivo" required/);
    assert.doesNotMatch(timelineDialog, /STATUS_LABELS\.optional/);
  });

  it("cancelar y no-show envían applyPolicy, leen la vista previa con el modo y el diálogo la pinta (L3-F1 traspasado)", () => {
    assert.match(timeline, /previewCancellationCharge\(lifecycleId, lifecycleMode\)/);
    assert.match(timeline, /cancelReservation\(res\.id, input\.reason, \{ applyPolicy: true \}\)/);
    assert.match(timeline, /noShowReservation\(res\.id, input\.reason, \{ applyPolicy: true \}\)/);
    assert.match(timeline, /lifecycleOutcomeSummary\(mode, result\.cancellation \?\? null/);
    assert.match(timelineDialog, /penaltyPreview\?: TimelinePenaltyPreview \| null;/);
    assert.match(timelineDialog, /\{penaltyPreview \? \(\s*<CocoaCallout tone=\{penaltyPreview\.tone\} title=\{penaltyPreview\.title \?\? undefined\} role="status">/);
    // Misma voz que la ficha de reserva: aviso cuando la política cobra, plazo gratuito y título con la política.
    assert.match(timeline, /tone: chargeable \? "warning" : "info"/);
    assert.match(timeline, /Plazo gratuito hasta \$\{dateTime\(penalty\.cutoffAt, \{ style: "medium" \}\)\}/);
    assert.match(timeline, /`Política «\$\{penalty\.policyName\}»` : "Sin política de cancelación"/);
  });
});

describe("Nueva reserva · política y cotización (ReservationCreateScreen.tsx)", () => {
  it("solo preselecciona la política marcada isDefault; sin default queda «Sin política» (FUX-01)", () => {
    const fn = reservationCreate.slice(reservationCreate.indexOf("function defaultPolicyCode("), reservationCreate.indexOf("function policyHelp("));
    assert.match(fn, /policy\.isDefault === true/);
    assert.doesNotMatch(fn, /policies\.find\(\(policy\) => policy\.active\)\)/);
    assert.match(reservationCreate, /El hotel no tiene política por defecto/);
  });

  it("avisa cuando el plan elegido no publica precio y la estimación usa BAR — la misma que fija el precio al crear (FUX-02)", () => {
    assert.match(reservationCreate, /quote\.ratePlanSwitched/);
    assert.match(reservationCreate, /selectedQuote\?\.ratePlanSwitched/);
    assert.match(reservationCreate, /sin tarifa publicada en ningún plan/);
  });
});

describe("Cliente pmsCommerceApi.ts", () => {
  it("el cuerpo de cancel / no-show lleva applyPolicy y supervisorAuthorizationId bajo esas claves exactas", () => {
    assert.match(client, /supervisorAuthorizationId: options\.supervisorAuthorizationId/);
    assert.match(client, /applyPolicy: options\.applyPolicy/);
  });

  it("AvailabilityQuote declara el plan que cotizó y el salto a BAR", () => {
    assert.match(client, /quotedRatePlanId\?: string \| null;/);
    assert.match(client, /ratePlanSwitched\?: boolean;/);
  });
});

// Cocoa 22 · ola 11 · lote api-datos (qa#17): the public API reference reads
// in Spanish. The manifest is built with the real service (no database); the
// assertions compute their expectations from the manifest instead of pinning
// endpoint counts, so a new route never breaks them.
// Run from apps/api with
//   node --import tsx --test src/modules/developer/__tests__/api-reference.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routePermissionManifest } from "../../../security/route-permissions.js";
import { ACTION_LABELS, SEGMENT_LABELS, SINGLETON_LABELS, buildApiReference, describeEndpoint, pluralizePhrase, resourceLabel } from "../api-reference.service.js";

const reference = buildApiReference();
const endpoints = reference.categories.flatMap((group) => group.endpoints);

/** Effective last segment of a path: the resource before a trailing `:param`. */
function effectiveLastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  return last.startsWith(":") ? (parts[parts.length - 2] ?? "") : last;
}

describe("api-reference · manifest counters", () => {
  it("lists every manifest endpoint once and byMethod (with PUT) adds up to totalEndpoints", () => {
    assert.equal(reference.totalEndpoints, routePermissionManifest.length);
    assert.equal(endpoints.length, reference.totalEndpoints);
    const sum = Object.values(reference.byMethod).reduce((total, count) => total + count, 0);
    assert.equal(sum, reference.totalEndpoints, `byMethod ${JSON.stringify(reference.byMethod)} no suma ${reference.totalEndpoints}`);
    assert.equal(reference.byMethod.PUT, routePermissionManifest.filter((route) => route.method === "PUT").length);
    assert.ok(reference.byMethod.PUT >= 1, "el manifest declara rutas PUT");
  });
});

describe("api-reference · descriptions in Spanish (qa#17)", () => {
  it("never echoes «METHOD /path» and never shows a route parameter", () => {
    const echoes = endpoints.filter((endpoint) => /^[A-Z]+ \//.test(endpoint.description));
    assert.deepEqual(echoes.map((endpoint) => `${endpoint.method} ${endpoint.path}`), []);
    const withParams = endpoints.filter((endpoint) => /:[A-Za-z]/.test(endpoint.description));
    assert.deepEqual(withParams.map((endpoint) => `${endpoint.method} ${endpoint.path} → ${endpoint.description}`), []);
  });

  it("every description is a sentence: capitalised, ends with a period, no «de el»", () => {
    for (const endpoint of endpoints) {
      assert.match(endpoint.description, /^[A-ZÁÉÍÓÚ«].*\.$/, `${endpoint.method} ${endpoint.path} → «${endpoint.description}»`);
      assert.doesNotMatch(endpoint.description, /\bde el\b/, `${endpoint.method} ${endpoint.path} → «${endpoint.description}»`);
    }
  });

  it("at least 95 % of the descriptions carry none of the 30 most frequent English segments", () => {
    const frequency = new Map<string, number>();
    for (const route of routePermissionManifest) {
      const segment = effectiveLastSegment(route.path);
      if (segment) frequency.set(segment, (frequency.get(segment) ?? 0) + 1);
    }
    const blacklist = [...frequency.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 30)
      .map(([segment]) => new RegExp(`\\b${segment.replace(/-/g, " ")}\\b`, "i"));
    const leaking = endpoints.filter((endpoint) => blacklist.some((pattern) => pattern.test(endpoint.description)));
    const share = leaking.length / endpoints.length;
    assert.ok(share <= 0.05, `${leaking.length}/${endpoints.length} descripciones con segmento inglés: ${leaking.slice(0, 5).map((e) => e.description).join(" · ")}`);
  });

  it("translates at least 95 % of the effective last segments (eco ≤ 5 %)", () => {
    const untranslated = routePermissionManifest.filter((route) => {
      const segment = effectiveLastSegment(route.path);
      return segment !== "" && !resourceLabel(segment).translated && !(segment in ACTION_LABELS);
    });
    assert.ok(untranslated.length / routePermissionManifest.length <= 0.05, `${untranslated.length} rutas sin traducir: ${untranslated.slice(0, 8).map((r) => r.path).join(", ")}`);
  });

  it("fixed cases: list, detail, PUT, token parameter and specific actions", () => {
    assert.equal(describeEndpoint("GET", "/reservations"), "Listar reservas.");
    assert.equal(describeEndpoint("GET", "/reservations/:id"), "Obtener el detalle de la reserva.");
    assert.equal(describeEndpoint("GET", "/guests/:id"), "Obtener el detalle del huésped.");
    assert.equal(describeEndpoint("POST", "/reservations"), "Crear o registrar una reserva.");
    assert.equal(describeEndpoint("PATCH", "/reservations/:id"), "Actualizar la reserva.");
    assert.equal(describeEndpoint("DELETE", "/webhooks/subscriptions/:id"), "Eliminar la suscripción.");
    assert.ok(describeEndpoint("PUT", "/fiscal/vat-settings").startsWith("Sustituir"));
    assert.equal(describeEndpoint("PUT", "/fiscal/vat-settings"), "Sustituir los ajustes del IVA.");
    assert.equal(describeEndpoint("PUT", "/backoffice/properties/:propertyId/taxes/rates"), "Sustituir las tarifas.");
    const invitation = describeEndpoint("GET", "/auth/invitations/:token");
    assert.ok(!invitation.includes(":token"), invitation);
    assert.equal(invitation, "Obtener el detalle de la invitación.");
    assert.equal(describeEndpoint("GET", "/reservations/:id/folio"), "Obtener el folio de la reserva.");
    assert.equal(describeEndpoint("POST", "/reservations/:id/cancel"), "Cancelar la reserva (aplica política de cancelación).");
    assert.equal(describeEndpoint("POST", "/invoices/:id/cancel"), "Cancelar la factura.");
    assert.equal(describeEndpoint("POST", "/reservations/:id/no-show"), "Marcar la reserva como no presentado.");
    assert.match(describeEndpoint("POST", "/reservations/:id/check-out"), /tarea de limpieza de salida/);
    assert.match(describeEndpoint("POST", "/developer/apps/:appId/rotate-secret"), /aplicación de desarrollador/);
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/housekeeping-settings"), "Obtener los ajustes de limpieza.");
    assert.equal(describeEndpoint("POST", "/channel-manager/channels/:channelId/ingest"), "Cargar los datos del canal.");
  });

  it("ola 11 · R6: the segments that still echoed English read in Spanish and a DELETE on a match undoes it", () => {
    assert.equal(describeEndpoint("DELETE", "/banking/lines/:bankLineId/match"), "Deshacer la conciliación de la línea.");
    assert.equal(describeEndpoint("DELETE", "/treasury/bank-lines/:bankLineId/reconcile"), "Deshacer la conciliación de la línea bancaria.");
    assert.equal(describeEndpoint("POST", "/treasury/bank-lines/:bankLineId/reconcile"), "Conciliar la línea bancaria.");
    assert.equal(describeEndpoint("GET", "/treasury/bank-lines/:bankLineId/suggestions"), "Listar sugerencias de la línea bancaria.");
    assert.equal(describeEndpoint("POST", "/commissions/accrue"), "Devengar las comisiones.");
    assert.equal(describeEndpoint("GET", "/accounting/usali/compare"), "Comparar el informe USALI.");
    assert.equal(describeEndpoint("POST", "/mobile-keys/:serial/revoke"), "Revocar la llave móvil.");
    assert.equal(describeEndpoint("POST", "/invoices/:id/tbai/submit"), "Enviar la factura a TicketBAI.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/tbai/chain/:territory/verify"), "Verificar la cadena de TicketBAI.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/banking/csb43/import"), "Importar el extracto CSB43.");
    assert.equal(describeEndpoint("POST", "/banking/iban/validate"), "Validar el IBAN.");
    assert.equal(describeEndpoint("POST", "/onboarding/projects/:projectId/ai/analyze"), "Analizar el proyecto con IA.");
    assert.equal(describeEndpoint("POST", "/onboarding/projects/:projectId/room-walk/parse"), "Interpretar el recorrido de habitaciones.");
    assert.equal(describeEndpoint("POST", "/revenue/properties/:propertyId/export-center/generate"), "Generar la exportación.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/email/ingest"), "Cargar los datos del correo.");
    assert.equal(describeEndpoint("POST", "/channel-manager/parity/check"), "Comprobar la paridad de tarifas.");
    assert.equal(describeEndpoint("GET", "/backoffice/properties/:propertyId/property-map/export"), "Exportar el mapa de la propiedad.");
    assert.equal(describeEndpoint("POST", "/offline/sync"), "Sincronizar los cambios sin conexión.");
    assert.equal(describeEndpoint("POST", "/folio-lines/:lineId/transfer"), "Transferir la línea de folio.");
    assert.equal(describeEndpoint("POST", "/compliance/ses-hospedajes/properties/:propertyId/batches/:batchId/submit"), "Enviar el lote.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/mapper/apply"), "Aplicar el mapeador.");
    assert.equal(describeEndpoint("POST", "/ai/confirmations/:confirmationId/execute"), "Ejecutar la confirmación.");
    // FIX-1 (F2 · F5 · F10 · F11): las rutas nuevas de la tanda leen en español.
    assert.equal(describeEndpoint("POST", "/fiscal/vat-books/reclassify"), "Reclasificar los libros de IVA.");
    assert.equal(describeEndpoint("GET", "/reports/exports/:exportId/download"), "Descargar la exportación.");
    assert.equal(describeEndpoint("GET", "/payroll/staff-profiles"), "Listar fichas de personal.");
    assert.equal(describeEndpoint("POST", "/payroll/staff-profiles"), "Crear o registrar una ficha de personal.");
    assert.equal(describeEndpoint("GET", "/accounting/ledger-imports/third-parties"), "Listar terceros.");
    // No description of the manifest echoes a raw (untranslated) segment of its own path any more,
    // except «marketplace» and «OAuth», which are Spanish usage.
    const echo = routePermissionManifest.filter((route) => {
      const description = describeEndpoint(route.method, route.path);
      return route.path.split("/").filter((p) => p && !p.startsWith(":")).some((segment) => {
        if (segment === "marketplace" || segment === "oauth") return false;
        if (resourceLabel(segment).translated || segment in ACTION_LABELS) return false;
        return new RegExp(`\\b${segment.replace(/-/g, " ")}\\b`, "i").test(description);
      });
    });
    assert.deepEqual(echo.map((r) => `${r.method} ${r.path}`), []);
  });

  // Documentos y digitalización (Tanda T9 · puerta de ola 2): las rutas del centro no
  // devuelven segmentos en inglés («file», «pages», «image», «send-to-office», «recapture»).
  it("Tanda T9 · the document capture routes read in Spanish", () => {
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/documents/:id/file"), "Obtener el fichero original del documento.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/documents/:id/pages/:n/image"), "Obtener la imagen de la página.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/documents/:id/send-to-office"), "Enviar el documento a la oficina.");
    assert.equal(
      describeEndpoint("POST", "/properties/:propertyId/documents/:id/recapture"),
      "Recapturar el documento devuelto al centro (fichero nuevo, mismo número de registro)."
    );
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/documents/:id/files"), "Crear o registrar un fichero del documento.");
    assert.equal(describeEndpoint("GET", "/organizations/:organizationId/documents/queue"), "Obtener la cola.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/documents/:id/classify"), "Clasificar el documento.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/documents/:id/extract"), "Extraer los datos del documento.");
  });

  // Documentos y digitalización (Tanda T9 · puerta de ola 3): recepciones de mercancía y valija
  // (goods-receipts.routes.ts y workflow.routes.ts) sin «goods receipts», «dispatch batches», «dispute» ni «sheet».
  it("Tanda T9 · the goods receipt and dispatch batch routes read in Spanish", () => {
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/goods-receipts"), "Crear o registrar una recepción de mercancía.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/goods-receipts"), "Listar recepciones de mercancía.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/goods-receipts/:id"), "Obtener el detalle de la recepción de mercancía.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/goods-receipts/:id/dispute"), "Poner en disputa la recepción de mercancía.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/documents/dispatch-batches"), "Crear o registrar una valija.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/documents/dispatch-batches/:batchId/receive"), "Recibir la valija.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/documents/dispatch-batches/:batchId/sheet"), "Obtener la hoja de remesa de la valija.");
  });

  // Activo inmobiliario (Tanda ACT · puerta de ola 3): recibos, calendario tributario, obra, inspecciones y seguros leen en español.
  it("Tanda ACT: las rutas del activo inmobiliario leen en español", () => {
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/real-estate/taxes/:taxId/receipts"), "Crear o registrar un recibo del impuesto.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/real-estate/taxes/:taxId/receipts/generate"), "Generar los recibos previstos del impuesto (idempotente).");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/real-estate/receipts"), "Listar recibos.");
    assert.equal(describeEndpoint("PATCH", "/properties/:propertyId/real-estate/receipts/:receiptId"), "Actualizar el recibo.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/real-estate/receipts/:receiptId/propose-entry"), "Proponer el asiento contable en borrador del recibo.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/real-estate/tax-calendar"), "Obtener el calendario tributario.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/real-estate/works"), "Listar obras.");
    assert.equal(describeEndpoint("PATCH", "/capex-projects/:id/work"), "Actualizar la obra del proyecto de inversión.");
    assert.equal(describeEndpoint("POST", "/capex-projects/:id/approve"), "Aprobar el proyecto de inversión (nunca quien lo propuso).");
    // ACT-REV-06: pinado literal; capitalizar no propone asiento (works.service.ts, api-contracts, diseño §7).
    assert.equal(describeEndpoint("POST", "/capex-projects/:id/capitalize"), "Capitalizar el proyecto de inversión (alta en el registro de inmovilizado; sin asiento).");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/real-estate/inspections"), "Listar inspecciones.");
    assert.equal(describeEndpoint("PATCH", "/properties/:propertyId/real-estate/inspections/:inspectionId"), "Actualizar la inspección.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/real-estate/insurances"), "Crear o registrar un seguro.");
  });

  it("Tanda CHK: el check-in automatizado y los kioscos leen en español", () => {
    assert.equal(describeEndpoint("GET", "/guest-portal/check-in"), "Obtener la sesión de check-in en línea del huésped.");
    assert.match(describeEndpoint("PATCH", "/guest-portal/check-in"), /^Actualizar la sesión de check-in en línea del huésped/);
    assert.equal(describeEndpoint("POST", "/guest-portal/check-in/guests/:id/mrz"), "Leer la zona MRZ del documento de identidad del huésped.");
    assert.equal(describeEndpoint("POST", "/guest-portal/check-in/complete"), "Completar el check-in en línea del huésped.");
    assert.match(describeEndpoint("POST", "/guest-portal/check-in/kiosk/claim"), /^Emparejar el kiosco/);
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/check-in/arrivals"), "Listar llegadas.");
    assert.match(describeEndpoint("POST", "/properties/:propertyId/check-in/sessions"), /^Invitar a la reserva al check-in en línea/);
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/check-in/sessions/:id"), "Obtener el detalle de la sesión.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/check-in/sessions/:id/resend"), "Reenviar la invitación de la sesión.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/check-in/policy"), "Obtener la política de check-in en línea.");
    assert.equal(describeEndpoint("PUT", "/properties/:propertyId/check-in/policy"), "Sustituir la política de check-in en línea.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/kiosks"), "Listar kioscos.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/kiosks"), "Crear o registrar un kiosco.");
    assert.equal(describeEndpoint("PATCH", "/properties/:propertyId/kiosks/:id"), "Actualizar el kiosco.");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/kiosks/:id/pair"), "Generar el código de emparejamiento del kiosco.");
    // W3-A: pasos del huésped (captura, firma, pago, OTP, llegada) y de recepción («/reservations/:id/check-in/…»).
    assert.equal(describeEndpoint("POST", "/guest-portal/check-in/guests/:id/document"), "Capturar el documento de identidad del huésped.");
    assert.equal(describeEndpoint("POST", "/guest-portal/check-in/guests/:id/signature"), "Registrar la firma del huésped.");
    assert.match(describeEndpoint("POST", "/guest-portal/check-in/payment-link"), /^Generar el enlace de pago/);
    assert.equal(describeEndpoint("POST", "/guest-portal/check-in/otp/request"), "Solicitar el código de un solo uso (OTP).");
    assert.equal(describeEndpoint("POST", "/guest-portal/check-in/otp/verify"), "Verificar el código de un solo uso (OTP).");
    assert.match(describeEndpoint("POST", "/guest-portal/check-in/arrive"), /^Registrar la llegada del huésped/);
    assert.match(describeEndpoint("GET", "/reservations/:id/check-in"), /^Obtener el estado del check-in de la reserva/);
    assert.match(describeEndpoint("POST", "/reservations/:id/check-in/scan"), /^Escanear el documento de identidad/);
    assert.equal(describeEndpoint("POST", "/reservations/:id/check-in/signature"), "Registrar la firma del viajero en recepción.");
    assert.equal(describeEndpoint("POST", "/reservations/:id/check-in/verify-identity"), "Marcar la identidad del viajero como verificada en recepción.");
    assert.match(describeEndpoint("POST", "/reservations/:id/check-in/complete"), /^Completar el check-in de la reserva desde recepción/);
    // W3-B: asignación explicable y habitaciones comunicadas (pms/room-assignment.routes.ts).
    assert.match(describeEndpoint("POST", "/reservations/:id/assignment-suggestions"), /^Generar la sugerencia de asignación de habitación de la reserva/);
    assert.equal(describeEndpoint("GET", "/reservations/:id/assignment-suggestions"), "Listar sugerencias de asignación de la reserva.");
    assert.equal(describeEndpoint("POST", "/assignment-suggestions/:id/confirm"), "Confirmar la sugerencia de asignación.");
    assert.equal(describeEndpoint("GET", "/properties/:propertyId/room-connections"), "Listar conexiones de habitaciones (comunicadas o contiguas).");
    assert.equal(describeEndpoint("POST", "/properties/:propertyId/room-connections"), "Crear o registrar una conexión de habitaciones (comunicadas o contiguas).");
    assert.equal(describeEndpoint("DELETE", "/room-connections/:id"), "Eliminar la conexión de habitaciones (comunicadas o contiguas).");
    // W4-D: webhook público de WhatsApp (routes/webhooks-whatsapp.routes.ts).
    assert.match(describeEndpoint("GET", "/webhooks/whatsapp"), /^Verificar la suscripción del webhook de WhatsApp/);
    assert.match(describeEndpoint("POST", "/webhooks/whatsapp"), /^Recibir los mensajes entrantes de WhatsApp/);
    // El check-in de la reserva desde recepción no cambia.
    assert.equal(describeEndpoint("POST", "/reservations/:id/check-in"), "Hacer check-in de la reserva.");
  });

  it("the -settings suffix reads «los ajustes de …» even for an unlisted owner", () => {
    assert.equal(resourceLabel("housekeeping-settings").singular, "los ajustes de limpieza");
    const derived = resourceLabel("reservations-settings");
    assert.equal(derived.singular, "los ajustes de la reserva");
    assert.equal(derived.singleton, true);
  });

  it("pluralises Spanish noun phrases on the head noun and its adjectives", () => {
    assert.equal(pluralizePhrase("la reserva"), "las reservas");
    assert.equal(pluralizePhrase("la habitación"), "las habitaciones");
    assert.equal(pluralizePhrase("la orden de trabajo"), "las órdenes de trabajo");
    assert.equal(pluralizePhrase("el plan de tarifas"), "los planes de tarifas");
    assert.equal(pluralizePhrase("el campo personalizado"), "los campos personalizados");
    assert.equal(pluralizePhrase("el área de mantenimiento"), "las áreas de mantenimiento");
    assert.equal(pluralizePhrase("el KPI"), "los KPI");
    assert.equal(pluralizePhrase("los ajustes"), "los ajustes");
  });

  it("dictionary hygiene: every label starts with an article and no segment is both singleton and countable", () => {
    for (const [segment, label] of [...Object.entries(SEGMENT_LABELS), ...Object.entries(SINGLETON_LABELS)]) {
      assert.match(label, /^(el|la|los|las) /, `${segment} → «${label}»`);
      assert.doesNotMatch(label, /[A-Z]{2,}_/, `${segment} → «${label}» no debe llevar claves de entorno`);
    }
    const overlap = Object.keys(SEGMENT_LABELS).filter((segment) => segment in SINGLETON_LABELS);
    assert.deepEqual(overlap, []);
  });
});

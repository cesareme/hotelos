// Recorrido del huésped en recepción (Tanda L7 · lote L7-07, 2026-09-20) —
// superficie HTTP (recon §19.8).
//
// Registro: `registerGuestJourneyRoutes(app)` desde server.ts tras
// registerGuestPortalRoutes(app). Permisos: journey-route-permissions.partial.ts
// (segundo partial del módulo guest-portal, como accounting; spread en
// security/route-permissions.ts).
//
//   GET /reservations/:id/guest-journey → GuestJourneyView (guest-journey.service.ts):
//       sesión de check-in en línea, avisos enviados (destinatario enmascarado),
//       llave móvil activa, peticiones, encuesta post-estancia y sesiones del
//       portal. Personal con pms.reservation.read (riesgo low); la reserva
//       cruza la tenencia con assertEntityAccess({ entity: "reservation" })
//       → 404 opaco si cuelga de otra propiedad u organización, como
//       GET /reservations/:id/check-in (checkin.routes.ts).
//
// Solo lectura: las acciones del recorrido reutilizan rutas existentes
// (POST /properties/:propertyId/check-in/sessions para reinvitar; la encuesta
// inmediata es POST /reservations/:id/post-stay/survey-invite del lote L7-04).

import type { FastifyInstance } from "fastify";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { getGuestJourney } from "./guest-journey.service.js";

type IdParams = { id: string };

export function registerGuestJourneyRoutes(app: FastifyInstance): void {
  app.get("/reservations/:id/guest-journey", async (request) => {
    const { id } = request.params as IdParams;
    await assertEntityAccess(request, { entity: "reservation", id });
    return getGuestJourney(id);
  });
}

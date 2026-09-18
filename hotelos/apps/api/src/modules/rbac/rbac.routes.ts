// RBAC por departamento (Tanda 8a · L1) · HTTP surface of the access engine.
//
// Registrado desde server.ts con `registerRbacRoutes(app)`. Permisos:
// route-permissions.partial.ts (fusionado en routePermissionManifest); el
// contract test lee este fichero y el partial. Textos en español; todo cuerpo y
// query pasa por un esquema `.strict()` de rbac.schemas.ts (400 en español).
//
// Tenencia: las rutas son de organización (organizationId del contexto). Las
// que reciben una propiedad en el cuerpo (`POST /approvals` con propertyId,
// `POST /rbac/supervisor-authorizations`) pasan por el hook de ámbito y la
// guarda de tenencia global (404 opaco fuera del ámbito del llamante); las de
// asignaciones llevan el ámbito en `scopeType` + `scopeRef` y el servicio
// contesta 403 RBAC_SCOPE_EXCEEDED / 403 RBAC_LEVEL_EXCEEDED / 409
// RBAC_SOD_CONFLICT / 404 opaco. Toda escritura desde una sesión de emergencia
// → 403 RBAC_BREAK_GLASS_FORBIDDEN (servicio).

import type { FastifyInstance } from "fastify";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import {
  createAssignment,
  createPropertyGroup,
  createRoleFromTemplate,
  editRolePermissions,
  listAssignments,
  listPropertyGroups,
  listRoles,
  listUsersInScope,
  revokeAssignment,
  updatePropertyGroup
} from "./assignments.service.js";
import { decideApproval, listApprovals, requestApproval } from "./approvals.service.js";
import { closeBreakGlass, listBreakGlass, openBreakGlass, reviewBreakGlass } from "./break-glass.service.js";
import {
  AccessLogQuerySchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ApprovalsListQuerySchema,
  AssignmentCreateSchema,
  AssignmentListQuerySchema,
  AssignmentRevokeBodySchema,
  AssignmentRevokeQuerySchema,
  BreakGlassOpenSchema,
  PinSetSchema,
  PropertyGroupCreateSchema,
  PropertyGroupPatchSchema,
  RoleCreateSchema,
  RolePermissionsPatchSchema,
  SupervisorAuthorizeSchema,
  ThresholdsPutSchema,
  UsersInScopeQuerySchema
} from "./rbac.schemas.js";
import { accessLog, rbacReport } from "./report.service.js";
import { authorize as supervisorAuthorize, setOwnPin } from "./supervisor.service.js";
import { getThresholds, putThresholds } from "./thresholds.service.js";

type IdParams = { id: string };

export function registerRbacRoutes(app: FastifyInstance): void {
  // ── Assignments ───────────────────────────────────────────────────────────
  app.get("/rbac/assignments", async (request) => {
    const query = parseOr400(AssignmentListQuerySchema, request.query ?? {}, "Filtro");
    return listAssignments({ context: request.userContext, ...query });
  });

  app.post("/rbac/assignments", async (request, reply) => {
    const body = parseOr400(AssignmentCreateSchema, request.body ?? {}, "Asignación");
    const assignment = await createAssignment({
      context: request.userContext,
      userId: body.userId,
      roleId: body.roleId,
      scopeType: body.scopeType,
      propertyId: body.scopeType === "property" ? body.scopeRef : undefined,
      propertyGroupId: body.scopeType === "property_group" ? body.scopeRef : undefined,
      legalEntityId: body.scopeType === "legal_entity" ? body.scopeRef : undefined,
      reason: body.reason,
      validTo: body.validTo
    });
    return reply.code(201).send(assignment);
  });

  app.delete("/rbac/assignments/:id", async (request) => {
    const { id } = request.params as IdParams;
    const body = parseOr400(AssignmentRevokeBodySchema, request.body ?? {}, "Motivo");
    const query = parseOr400(AssignmentRevokeQuerySchema, request.query ?? {}, "Motivo");
    return revokeAssignment({ context: request.userContext, id, reason: body.reason ?? query.reason });
  });

  app.get("/rbac/users", async (request) => {
    const query = parseOr400(UsersInScopeQuerySchema, request.query ?? {}, "Filtro");
    return listUsersInScope({ context: request.userContext, ...query });
  });

  // ── Roles ─────────────────────────────────────────────────────────────────
  app.get("/rbac/roles", async (request) => listRoles({ context: request.userContext }));

  app.post("/rbac/roles", async (request, reply) => {
    const body = parseOr400(RoleCreateSchema, request.body ?? {}, "Rol");
    const role = await createRoleFromTemplate({ context: request.userContext, ...body });
    return reply.code(201).send(role);
  });

  app.patch("/rbac/roles/:id/permissions", async (request) => {
    const { id } = request.params as IdParams;
    const body = parseOr400(RolePermissionsPatchSchema, request.body ?? {}, "Permisos");
    return editRolePermissions({ context: request.userContext, roleId: id, remove: body.remove });
  });

  // ── Property groups ───────────────────────────────────────────────────────
  app.get("/rbac/property-groups", async (request) => listPropertyGroups({ context: request.userContext }));

  app.post("/rbac/property-groups", async (request, reply) => {
    const body = parseOr400(PropertyGroupCreateSchema, request.body ?? {}, "Grupo");
    const group = await createPropertyGroup({ context: request.userContext, ...body });
    return reply.code(201).send(group);
  });

  app.patch("/rbac/property-groups/:id", async (request) => {
    const { id } = request.params as IdParams;
    const body = parseOr400(PropertyGroupPatchSchema, request.body ?? {}, "Grupo");
    return updatePropertyGroup({ context: request.userContext, id, ...body });
  });

  // ── Thresholds ────────────────────────────────────────────────────────────
  app.get("/rbac/thresholds", async (request) => getThresholds(request.userContext.organizationId));

  app.put("/rbac/thresholds", async (request) => {
    const body = parseOr400(ThresholdsPutSchema, request.body ?? {}, "Umbrales");
    return putThresholds({ context: request.userContext, body });
  });

  // ── Approvals inbox (§5.7) ────────────────────────────────────────────────
  app.get("/approvals", async (request) => {
    const query = parseOr400(ApprovalsListQuerySchema, request.query ?? {}, "Filtro");
    return listApprovals({ context: request.userContext, ...query });
  });

  app.post("/approvals", async (request, reply) => {
    const body = parseOr400(ApprovalRequestSchema, request.body ?? {}, "Solicitud");
    const created = await requestApproval({ context: request.userContext, ...body, amount: body.amount ?? null });
    return reply.code(201).send(created);
  });

  app.post("/approvals/:id/approve", async (request) => {
    const { id } = request.params as IdParams;
    const body = parseOr400(ApprovalDecisionSchema, request.body ?? {}, "Decisión");
    return decideApproval({ context: request.userContext, id, decision: "approve", note: body.note });
  });

  app.post("/approvals/:id/reject", async (request) => {
    const { id } = request.params as IdParams;
    const body = parseOr400(ApprovalDecisionSchema, request.body ?? {}, "Decisión");
    return decideApproval({ context: request.userContext, id, decision: "reject", note: body.note });
  });

  // ── Supervisor PIN (§5.6) ─────────────────────────────────────────────────
  app.post("/rbac/supervisor-authorizations", async (request, reply) => {
    const body = parseOr400(SupervisorAuthorizeSchema, request.body ?? {}, "Autorización");
    const authorization = await supervisorAuthorize({ context: request.userContext, ...body, ipAddress: request.ip });
    return reply.code(201).send(authorization);
  });

  app.post("/rbac/pin", async (request) => {
    const body = parseOr400(PinSetSchema, request.body ?? {}, "PIN");
    return setOwnPin({ context: request.userContext, ...body });
  });

  // ── Break glass (§4.8) ────────────────────────────────────────────────────
  app.post("/rbac/break-glass", async (request, reply) => {
    const body = parseOr400(BreakGlassOpenSchema, request.body ?? {}, "Emergencia");
    const opened = await openBreakGlass({ context: request.userContext, ...body, ipAddress: request.ip });
    return reply.code(201).send(opened);
  });

  app.post("/rbac/break-glass/:id/close", async (request) => {
    const { id } = request.params as IdParams;
    return closeBreakGlass({ context: request.userContext, id, ipAddress: request.ip });
  });

  app.post("/rbac/break-glass/:id/review", async (request) => {
    const { id } = request.params as IdParams;
    return reviewBreakGlass({ context: request.userContext, id });
  });

  app.get("/rbac/break-glass", async (request) => listBreakGlass({ context: request.userContext }));

  // ── Reports ───────────────────────────────────────────────────────────────
  app.get("/rbac/report", async (request) => rbacReport({ context: request.userContext }));

  app.get("/rbac/access-log", async (request) => {
    const query = parseOr400(AccessLogQuerySchema, request.query ?? {}, "Filtro");
    return accessLog({ context: request.userContext, ...query });
  });
}

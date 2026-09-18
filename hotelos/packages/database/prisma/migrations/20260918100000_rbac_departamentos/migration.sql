-- ============================================================================
-- 20260918100000_rbac_departamentos · RBAC por departamento, nivel y ámbito (Tanda 8a · L0)
-- ============================================================================
-- Generada el 2026-09-18 con:
--   cd packages/database && corepack pnpm exec prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16.14)
-- y revisada a mano. Todo lo que emitió el generador está aquí VERBATIM (5 CREATE
-- TYPE, 11 ALTER TABLE … ADD COLUMN, 7 CREATE TABLE, 18 índices). Lo ÚNICO escrito
-- a mano son las dos restricciones CHECK del final sobre approval_requests
-- (DDL que Prisma no puede declarar y que `prisma migrate diff
-- --from-schema-datasource` ignora, igual que los triggers de 20260916102000 →
-- db:drift:check sigue en 0):
--   approval_requests_no_self_decision · quien solicita nunca decide
--     (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id);
--   approval_requests_no_self_second   · el segundo aprobador no es el solicitante
--     ni el primer aprobador (second_approver_user_id IS NULL OR
--     (second_approver_user_id <> requested_by_user_id AND
--      second_approver_user_id <> decided_by_user_id)).
-- Son la mitad «en base de datos» de la separación de funciones dinámica de
-- docs/design/RBAC-DEPARTAMENTOS.md §4.7 (NIST SoD, PCI DSS req. 7): el servicio
-- de aprobaciones (L1) responde 409 APPROVAL_SELF_DECISION antes de llegar aquí y
-- la restricción impide que un UPDATE crudo la esquive.
--
-- Diseño: docs/design/RBAC-DEPARTAMENTOS.md §4.1 (niveles × ámbito), §4.2
-- (plantillas), §4.7 (umbrales, doble aprobación), §4.8 (break glass), §5.5
-- (invitaciones con ámbito), §5.6 (PIN de supervisor) y §6.1 (modelo de datos).
-- Catálogo de valores (texto) y contrato wire: packages/shared/src/rbac-types.ts
-- (tests/rbac-sod-contract.test.mjs exige que los enums de Prisma y del contrato
-- coincidan valor a valor).
--
-- ADITIVA (ninguna tabla, columna ni fila existente se toca; sin paso de datos;
-- la API en marcha con el cliente Prisma anterior sigue sirviendo):
--   · CREATE TYPE RoleLevel (operative | supervisor | hotel_director |
--     operations_director | general_management | ownership | central_admin),
--     ScopeType (property | property_group | legal_entity | organization),
--     ThresholdAction (11 operaciones con umbral), ApprovalKind (10 tipos de
--     aprobación) y ApprovalStatus (pending | approved | rejected | expired);
--   · roles gana level (RoleLevel, NULL en roles anteriores hasta el upgrade),
--     department, template_version (0 = anterior al versionado de plantillas:
--     solo `rbac:sync --upgrade-templates` lo sube y aplica las revocaciones;
--     el top-up del arranque sigue siendo aditivo) y managed (true; false =
--     rol personalizado que el backfill nunca toca);
--   · organizations gana rbac_version (invalida las cachés de permisos de las
--     sesiones vivas en cada escritura de roles o asignaciones);
--   · users gana pin_hash / pin_updated_at / pin_failed_attempts /
--     pin_locked_until (PIN de supervisor); `status` sigue siendo texto: las
--     cuentas de emergencia usan el valor nuevo «emergency»;
--   · user_invitations gana scope_type / scope_ref / invited_by_user_id (la
--     invitación crea la asignación en ese ámbito al aceptarse);
--   · columnas de autor (todas NULL en las filas existentes) para la SoD
--     dinámica de L2: payments.captured_by_user_id; invoices.issued_by_user_id
--     y cancelled_by_user_id; supplier_bills.created_by_user_id;
--     night_audit_runs.reviewed_by_user_id / reviewed_at /
--     reopened_by_user_id / reopened_at / reopen_reason_code;
--     payroll_periods.calculated_by_user_id / approved_by_user_id /
--     approved_at; pos_orders.voided_at / voided_by_user_id /
--     void_reason_code; capex_projects.created_by_user_id;
--   · property_groups + property_group_members — clúster de hoteles (Galicia =
--     LT + RA…), ámbito de asignación; única por (organization_id, code) y por
--     (property_group_id, property_id);
--   · user_role_assignments — asignación plantilla × ámbito (usuario, rol,
--     scope_type, property_id / property_group_id / legal_entity_id,
--     organization_id, vigencia, concedente, revocación con motivo); única por
--     (user_id, role_id, scope_type, property_id, property_group_id,
--     legal_entity_id); índices (user_id, revoked_at), (organization_id,
--     scope_type) y (role_id). user_property_roles se CONSERVA (lectura dual
--     hasta el corte de L6);
--   · role_thresholds — umbral por organización y rol (o nivel, para roles
--     personalizados): acción, tramo (T1…ABOVE_T4), importe DECIMAL(14,2),
--     porcentaje DECIMAL(5,2), moneda y segunda aprobación; índices
--     (organization_id, action) y (role_id);
--   · approval_requests — solicitud maker/checker: tipo, entidad, importe,
--     motivo, solicitante, estado, decisor, segundo aprobador, consumo y
--     caducidad; índices (organization_id, status, kind), (entity_type,
--     entity_id) y (requested_by_user_id, created_at);
--   · supervisor_authorizations — autorización por PIN de un supervisor
--     presente (actor, autorizador, clave, entidad, importe, motivo, caducidad
--     de 60 s, uso único); índices (organization_id, actor_user_id, created_at)
--     y (entity_type, entity_id);
--   · break_glass_sessions — sesión de emergencia (quien la abre, cuenta usada,
--     session_id único, motivo, ticket, apertura, cierre previsto y real,
--     revisión); índices (organization_id, opened_at) y (account_user_id,
--     closed_at).
--   Sin claves ajenas, como el resto de tablas RBAC (roles / permissions /
--   role_permissions / user_property_roles): tenencia y referencias las
--   comprueban los servicios.
--
-- Comprobaciones previas en la BD demo local antes de escribir (psql, 2026-09-18):
--   · 12 migraciones aplicadas («Database schema is up to date!»), drift 0,
--     283 tablas de modelo / 33 enums;
--   · 223 permisos, 21 roles (10 por organización en Faranda y org_123 +
--     Local Super Admin), 10 user_property_roles, 1 invitación;
--   · copia previa: pg_dump -Fc > <scratchpad>/pre-rbac-8a.dump.
-- Esperado tras aplicar: 13 migraciones, drift 0, 290 tablas de modelo / 38
-- enums, 10 user_property_roles (ninguna fila cambia: solo DDL).
-- ============================================================================

-- CreateEnum
CREATE TYPE "RoleLevel" AS ENUM ('operative', 'supervisor', 'hotel_director', 'operations_director', 'general_management', 'ownership', 'central_admin');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('property', 'property_group', 'legal_entity', 'organization');

-- CreateEnum
CREATE TYPE "ThresholdAction" AS ENUM ('folio_adjust', 'refund', 'discount', 'invoice_cancel', 'day_reopen', 'rate_change', 'supplier_bill', 'purchase_order', 'payroll', 'capex', 'accounting_export');

-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('refund', 'folio_adjust', 'discount', 'rate_change', 'supplier_bill', 'purchase_order', 'payroll', 'capex', 'invoice_cancel', 'day_reopen');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- AlterTable
ALTER TABLE "capex_projects" ADD COLUMN     "created_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "cancelled_by_user_id" TEXT,
ADD COLUMN     "issued_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "night_audit_runs" ADD COLUMN     "reopen_reason_code" TEXT,
ADD COLUMN     "reopened_at" TIMESTAMP(3),
ADD COLUMN     "reopened_by_user_id" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "rbac_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "captured_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "payroll_periods" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_user_id" TEXT,
ADD COLUMN     "calculated_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "pos_orders" ADD COLUMN     "void_reason_code" TEXT,
ADD COLUMN     "voided_at" TIMESTAMP(3),
ADD COLUMN     "voided_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "department" TEXT,
ADD COLUMN     "level" "RoleLevel",
ADD COLUMN     "managed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "template_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "supplier_bills" ADD COLUMN     "created_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "user_invitations" ADD COLUMN     "invited_by_user_id" TEXT,
ADD COLUMN     "scope_ref" TEXT,
ADD COLUMN     "scope_type" "ScopeType";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pin_failed_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pin_hash" TEXT,
ADD COLUMN     "pin_locked_until" TIMESTAMP(3),
ADD COLUMN     "pin_updated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "property_groups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_group_members" (
    "id" TEXT NOT NULL,
    "property_group_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role_assignments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "scope_type" "ScopeType" NOT NULL,
    "property_id" TEXT,
    "property_group_id" TEXT,
    "legal_entity_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "granted_by_user_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_thresholds" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "role_id" TEXT,
    "level" "RoleLevel",
    "action" "ThresholdAction" NOT NULL,
    "tier" TEXT NOT NULL,
    "max_amount" DECIMAL(14,2),
    "max_pct" DECIMAL(5,2),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "requires_second_approval" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "kind" "ApprovalKind" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT,
    "payload_json" JSONB,
    "requested_by_user_id" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "second_approver_user_id" TEXT,
    "second_decided_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "consumed_by_user_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervisor_authorizations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "actor_user_id" TEXT NOT NULL,
    "authorizer_user_id" TEXT NOT NULL,
    "permission_key" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "reason_code" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supervisor_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "break_glass_sessions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "opened_by_user_id" TEXT NOT NULL,
    "account_user_id" TEXT NOT NULL,
    "session_id" TEXT,
    "reason" TEXT NOT NULL,
    "ticket" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closes_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closed_by_user_id" TEXT,
    "reviewed_by_user_id" TEXT,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "break_glass_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "property_groups_organization_id_idx" ON "property_groups"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "property_groups_organization_id_code_key" ON "property_groups"("organization_id", "code");

-- CreateIndex
CREATE INDEX "property_group_members_property_id_idx" ON "property_group_members"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "property_group_members_property_group_id_property_id_key" ON "property_group_members"("property_group_id", "property_id");

-- CreateIndex
CREATE INDEX "user_role_assignments_user_id_revoked_at_idx" ON "user_role_assignments"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_role_assignments_organization_id_scope_type_idx" ON "user_role_assignments"("organization_id", "scope_type");

-- CreateIndex
CREATE INDEX "user_role_assignments_role_id_idx" ON "user_role_assignments"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_assignments_user_id_role_id_scope_type_property_i_key" ON "user_role_assignments"("user_id", "role_id", "scope_type", "property_id", "property_group_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "role_thresholds_organization_id_action_idx" ON "role_thresholds"("organization_id", "action");

-- CreateIndex
CREATE INDEX "role_thresholds_role_id_idx" ON "role_thresholds"("role_id");

-- CreateIndex
CREATE INDEX "approval_requests_organization_id_status_kind_idx" ON "approval_requests"("organization_id", "status", "kind");

-- CreateIndex
CREATE INDEX "approval_requests_entity_type_entity_id_idx" ON "approval_requests"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "approval_requests_requested_by_user_id_created_at_idx" ON "approval_requests"("requested_by_user_id", "created_at");

-- CreateIndex
CREATE INDEX "supervisor_authorizations_organization_id_actor_user_id_cre_idx" ON "supervisor_authorizations"("organization_id", "actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "supervisor_authorizations_entity_type_entity_id_idx" ON "supervisor_authorizations"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "break_glass_sessions_session_id_key" ON "break_glass_sessions"("session_id");

-- CreateIndex
CREATE INDEX "break_glass_sessions_organization_id_opened_at_idx" ON "break_glass_sessions"("organization_id", "opened_at");

-- CreateIndex
CREATE INDEX "break_glass_sessions_account_user_id_closed_at_idx" ON "break_glass_sessions"("account_user_id", "closed_at");


-- Separación de funciones dinámica en base de datos (escrito a mano, §4.7):
-- nadie aprueba lo que solicitó, y el segundo aprobador es una tercera persona.
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_no_self_decision" CHECK ("decided_by_user_id" IS NULL OR "decided_by_user_id" <> "requested_by_user_id");
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_no_self_second" CHECK ("second_approver_user_id" IS NULL OR ("second_approver_user_id" <> "requested_by_user_id" AND "second_approver_user_id" <> "decided_by_user_id"));

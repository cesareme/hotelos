-- ============================================================================
-- 20260920173000_rrhh_plantilla_nomina · RRHH / plantilla, convenio, estándares y nómina (Tanda RRHH · RRHH-1)
-- ============================================================================
-- Generada el 2026-09-20 con:
--   prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- sobre hotelos_rrhh (24 migraciones aplicadas, drift 0) y revisada a mano (reviewed by hand).
-- Todo lo que emitió el generador está aquí VERBATIM; lo ÚNICO escrito a mano es el CHECK final de
-- absence_requests (Prisma no declara CHECKs y `migrate diff` los ignora → db:drift:check sigue en 0).
-- Sin funciones ni triggers (scripts/check-fresh-install.sh sigue censando 4 triggers) y sin ningún DROP.
--
-- Diseño: docs/design/RRHH-PLANTILLA-NOMINA.md §4, recortado al alcance de la tanda
-- (scratchpad RRHH/recon-delta.md §3.1). GDPR: employees guarda PII CIFRADA por la extensión Prisma
-- (PII_FIELDS.Employee en packages/database/src/crypto-fields.ts: tax_id, social_security_number,
-- email, phone, iban) con hash de búsqueda solo para tax_id (LOOKUP_HASH_FIELDS.Employee); los
-- listados nunca devuelven PII. Datos ficticios solo en el tenant de demo; en Faranda NADA.
--
-- ADITIVA (ninguna fila existente se reescribe; sin paso de datos):
--   · employees — expediente por sociedad: número único por sociedad y NIF único por hash;
--   · collective_agreements + agreement_rules — convenio parametrizado (reglas versionadas por valid_from);
--   · labor_standards — estándar de dotación por centro × departamento USALI × driver;
--   · staffing_plans + staffing_plan_lines — plantilla máxima aprobada por centro × año × temporada;
--   · staff_profiles + employee_id / usali_department / job_title (user_id sigue NOT NULL) e índice;
--   · employment_contracts + agreement_id / weekly_hours / part_time_pct / fixed_discontinuous (default
--     false) / contribution_group / end_reason (social_security_category se conserva, deprecada);
--   · absence_requests + requested_by / decided_at / reason y el CHECK
--     absence_requests_requested_ne_approved (solicitante ≠ aprobador; 0 filas hoy);
--   · labor_forecasts + usali_department (default 'all') / source / drivers_json / required_fte /
--     estimated_cost / generated_at y la clave única (property_id, forecast_date, usali_department)
--     (0 filas hoy; el dashboard sigue leyendo required_labor_hours);
--   · payroll_periods + mode (default 'external') / closed_at;
--   · properties + agreement_id.
--
-- Reversible: DROP TABLE de las 6 tablas nuevas, DROP COLUMN de las columnas añadidas, DROP INDEX de
-- los índices nuevos y ALTER TABLE "absence_requests" DROP CONSTRAINT "absence_requests_requested_ne_approved".
-- ============================================================================

-- AlterTable
ALTER TABLE "absence_requests" ADD COLUMN     "decided_at" TIMESTAMP(3),
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "requested_by" TEXT;

-- AlterTable
ALTER TABLE "employment_contracts" ADD COLUMN     "agreement_id" TEXT,
ADD COLUMN     "contribution_group" INTEGER,
ADD COLUMN     "end_reason" TEXT,
ADD COLUMN     "fixed_discontinuous" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "part_time_pct" DECIMAL(5,2),
ADD COLUMN     "weekly_hours" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "labor_forecasts" ADD COLUMN     "drivers_json" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "estimated_cost" DECIMAL(14,2),
ADD COLUMN     "generated_at" TIMESTAMP(3),
ADD COLUMN     "required_fte" DECIMAL(8,2),
ADD COLUMN     "source" TEXT,
ADD COLUMN     "usali_department" TEXT NOT NULL DEFAULT 'all';

-- AlterTable
ALTER TABLE "payroll_periods" ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'external';

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "agreement_id" TEXT;

-- AlterTable
ALTER TABLE "staff_profiles" ADD COLUMN     "employee_id" TEXT,
ADD COLUMN     "job_title" TEXT,
ADD COLUMN     "usali_department" TEXT;

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "employee_number" TEXT NOT NULL,
    "user_id" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "tax_id_lookup_hash" TEXT,
    "social_security_number" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "iban" TEXT,
    "gender" TEXT,
    "primary_property_id" TEXT,
    "usali_department" TEXT,
    "job_title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "hired_at" TIMESTAMP(3) NOT NULL,
    "terminated_at" TIMESTAMP(3),
    "termination_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collective_agreements" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT,
    "published_ref" TEXT,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),
    "ultraactivity" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collective_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement_rules" (
    "id" TEXT NOT NULL,
    "agreement_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labor_standards" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "usali_department" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "value" DECIMAL(10,3) NOT NULL,
    "bands_json" JSONB,
    "allowance_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "coverage_factor" DECIMAL(5,2) NOT NULL DEFAULT 1.4,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'sector_default',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labor_standards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staffing_plans" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "season" TEXT NOT NULL,
    "from_month" INTEGER NOT NULL,
    "to_month" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staffing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staffing_plan_lines" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "usali_department" TEXT NOT NULL,
    "max_fte" DECIMAL(6,2) NOT NULL,
    "max_headcount" INTEGER,
    "budget_monthly_cost" DECIMAL(14,2),

    CONSTRAINT "staffing_plan_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employees_organization_id_status_idx" ON "employees"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "employees_legal_entity_id_employee_number_key" ON "employees"("legal_entity_id", "employee_number");

-- CreateIndex
CREATE UNIQUE INDEX "employees_legal_entity_id_tax_id_lookup_hash_key" ON "employees"("legal_entity_id", "tax_id_lookup_hash");

-- CreateIndex
CREATE UNIQUE INDEX "collective_agreements_organization_id_code_key" ON "collective_agreements"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "agreement_rules_agreement_id_key_valid_from_key" ON "agreement_rules"("agreement_id", "key", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "labor_standards_property_id_usali_department_driver_valid_f_key" ON "labor_standards"("property_id", "usali_department", "driver", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "staffing_plans_property_id_year_season_key" ON "staffing_plans"("property_id", "year", "season");

-- CreateIndex
CREATE UNIQUE INDEX "staffing_plan_lines_plan_id_usali_department_key" ON "staffing_plan_lines"("plan_id", "usali_department");

-- CreateIndex
CREATE UNIQUE INDEX "labor_forecasts_property_id_forecast_date_usali_department_key" ON "labor_forecasts"("property_id", "forecast_date", "usali_department");

-- CreateIndex
CREATE INDEX "staff_profiles_employee_id_active_idx" ON "staff_profiles"("employee_id", "active");


-- ----------------------------------------------------------------------------
-- Escrito a mano (Prisma no declara CHECKs): separación de funciones en las ausencias — quien solicita
-- no aprueba. Ambas columnas son nulables (filas previas y solicitudes pendientes); el servicio responde
-- 409 APPROVAL_SELF_DECISION antes de llegar aquí. Mismo patrón que approval_requests_no_self_decision
-- (20260918100000_rbac_departamentos).
-- ----------------------------------------------------------------------------
ALTER TABLE "absence_requests" ADD CONSTRAINT "absence_requests_requested_ne_approved" CHECK ("requested_by" IS NULL OR "approved_by" IS NULL OR "requested_by" <> "approved_by");

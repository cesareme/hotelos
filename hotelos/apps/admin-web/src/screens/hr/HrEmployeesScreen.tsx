// Plantilla — Finanzas › Nóminas › Plantilla (/finanzas/nominas/plantilla,
// pestaña alojada del contenedor NominasTabs que registra RRHH-11).
//
// Tanda RRHH · lote RRHH-8 (diseño docs/design/RRHH-PLANTILLA-NOMINA.md §10
// «Plantilla»; recon RRHH/recon-delta.md §3.10). Cocoa 22, pantalla alojada
// (sin subtitle propio: el contenedor pinta categoría y H1; el eyebrow
// «Finanzas · <sociedad>» se registra con `finance.eyebrow`): CocoaTable de
// GET /hr/employees (nombre, número, centro, puesto, departamento USALI,
// contrato / jornada, estado, vencimiento) con búsqueda (nombre o número, nunca
// NIF) y CocoaSegmentedControl Activos · Bajas · Fijos discontinuos; el ámbito
// (sociedad o un centro) es el «Ámbito» único de Finanzas (useFinanceScope). Una
// fila abre EmployeeDrawer (Datos · Contrato · Baja); «Nuevo expediente» lo abre
// vacío. La tabla NUNCA lleva NIF, NAF, correo, teléfono ni IBAN
// (EmployeeSummaryDto no los trae); el detalle solo los muestra con «Mostrar».
// Lectura gateada por hr.employee.read (sin la clave no se llama al API y se
// explica) y escritura por hr.employee.manage, ambas con las concesiones reales:
// canDo(useNavGate(), …). Estados: cargando (skeleton), error (reintentar),
// vacío (por segmento / búsqueda), sin permiso. Sin estilos en línea, sin `fetch`,
// copy en español, sin datos de personas reales.

import { useMemo, useState } from "react";
import type { EmployeeSummaryDto } from "@hotelos/shared";
import { useApiData } from "../../hooks/useApiData";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { useNavGate } from "../../navigation/useEnabledModules";
import { canDo, todayIso } from "../accounting/accounting-ui";
import {
  EMPLOYEE_SEGMENT_OPTIONS,
  contractExpiry,
  contractSummaryLabel,
  employeeListQuery,
  employeeSegmentQuery,
  employeeStatusBadge,
  isEmployeeSegment,
  usaliDepartmentLabel,
  type EmployeeSegment
} from "../../services/hr-contracts";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS, newLabel } from "../../content/actions";
import { date, number, plural } from "../../lib/format";
import { CocoaBadge, CocoaButton, CocoaPage, CocoaSearchInput, CocoaSection, CocoaSegmentedControl, CocoaSkeleton, CocoaState, CocoaTable, type CocoaTableColumn } from "../../components/cocoa";
import { EmployeeDrawer, type EmployeeDrawerCentre } from "./EmployeeDrawer";

const READ_HINT = "Necesitas el permiso de lectura de expedientes (hr.employee.read) para ver la plantilla.";
const MANAGE_HINT = "Necesitas el permiso de gestión de expedientes (hr.employee.manage) para dar de alta, editar o dar de baja.";

function employeeColumns(today: string): CocoaTableColumn<EmployeeSummaryDto>[] {
  return [
    { key: "fullName", label: "Nombre", sortable: true, minWidth: 180, render: (row) => <strong>{row.fullName}</strong> },
    { key: "employeeNumber", label: "Nº", sortable: true, fit: true, render: (row) => <span className="cocoa-tabular">{row.employeeNumber}</span> },
    { key: "centre", label: "Centro", hideOnNarrow: true, render: (row) => row.propertyCode ?? row.propertyName ?? "—" },
    { key: "jobTitle", label: "Puesto", render: (row) => row.jobTitle ?? "—" },
    { key: "usaliDepartment", label: "Departamento", hideOnNarrow: true, render: (row) => usaliDepartmentLabel(row.usaliDepartment) ?? "—" },
    { key: "contract", label: "Contrato / jornada", render: (row) => contractSummaryLabel(row.contract) },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (row) => {
        const badge = employeeStatusBadge(row.status);
        return (
          <CocoaBadge tone={badge.tone} size="small">
            {badge.label}
          </CocoaBadge>
        );
      }
    },
    {
      key: "contractEndsAt",
      label: "Vencimiento",
      sortable: true,
      fit: true,
      render: (row) => {
        if (row.status === "inactive") return row.terminatedAt ? <span className="cocoa-tabular">{date(row.terminatedAt)}</span> : "—";
        // RF-15: a file without a contract has nothing to expire — never «Indefinido».
        if (!row.contract) return "—";
        const expiry = contractExpiry(row.contractEndsAt, today);
        if (!expiry) return <span className="cocoa-caption">Indefinido</span>;
        return (
          <CocoaBadge tone={expiry.tone} size="small" title={row.contractEndsAt ? date(row.contractEndsAt) : undefined}>
            {expiry.label}
          </CocoaBadge>
        );
      }
    }
  ];
}

function sortRows(rows: EmployeeSummaryDto[], sort: { key: string; direction: "asc" | "desc" } | undefined): EmployeeSummaryDto[] {
  if (!sort) return rows;
  const dir = sort.direction === "asc" ? 1 : -1;
  const value = (row: EmployeeSummaryDto): string => {
    if (sort.key === "employeeNumber") return row.employeeNumber;
    if (sort.key === "contractEndsAt") return row.contractEndsAt ?? "9999-12-31";
    return `${row.lastName} ${row.firstName}`;
  };
  return [...rows].sort((a, b) => value(a).localeCompare(value(b), "es", { numeric: true }) * dir);
}

function ScreenSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="row" lines={6} />
    </div>
  );
}

export function HrEmployeesScreen() {
  // The employer is the sociedad: the «Ámbito» lists every centre by default and filters one on demand.
  const finance = useFinanceScope(financeScopePolicy("HrEmployeesScreen"));
  const propertyId = finance.propertyId;
  const today = todayIso();

  // Both gates read the real grants of the active property (never the demo union of the login payload).
  const gate = useNavGate();
  const read = canDo(gate, "hr.employee.read");
  const manage = canDo(gate, "hr.employee.manage");

  const [segment, setSegment] = useState<EmployeeSegment>("active");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; direction: "asc" | "desc" } | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Without the read grant nothing is requested (a 403 would only repeat what the note says).
  const employeesState = useApiData<EmployeeSummaryDto[]>(read ? "/hr/employees" : null, {
    query: employeeListQuery({ propertyId, ...employeeSegmentQuery(segment), search })
  });
  const employees = useMemo(() => toArray<EmployeeSummaryDto>(employeesState.data), [employeesState.data]);
  const rows = useMemo(() => sortRows(employees, sort), [employees, sort]);
  const columns = useMemo(() => employeeColumns(today), [today]);

  const centres = useMemo<EmployeeDrawerCentre[]>(() => {
    const listed = finance.structure?.centres ?? [];
    if (listed.length > 0) return listed.map((centre) => ({ id: centre.id, code: centre.code, name: centre.name, legalEntityId: centre.legalEntityId }));
    return [{ id: finance.active.propertyId, code: null, name: finance.active.propertyName, legalEntityId: null }];
  }, [finance.structure, finance.active]);

  // Sociedad empleadora of a new file: the structure's entity, else the centre's, else what the listed files carry.
  const legalEntityId = useMemo(() => {
    const fromEntity = finance.structure?.entity?.id ?? null;
    if (fromEntity) return fromEntity;
    const fromCentre = (propertyId ? centres.find((centre) => centre.id === propertyId)?.legalEntityId : null) ?? centres.find((centre) => centre.legalEntityId)?.legalEntityId ?? null;
    if (fromCentre) return fromCentre;
    return employees[0]?.legalEntityId ?? null;
  }, [finance.structure, centres, propertyId, employees]);

  const newEmployeeLabel = newLabel("m", "expediente");
  const loading = employeesState.loading && employees.length === 0;
  const state = !read ? "ready" : loading ? "loading" : employeesState.error && employees.length === 0 ? "error" : "ready";
  const expiring = useMemo(() => employees.filter((row) => row.status !== "inactive" && contractExpiry(row.contractEndsAt, today)?.tone === "warning").length, [employees, today]);

  function openNew() {
    setSelectedId(null);
    setDrawerOpen(true);
  }

  function openRow(row: EmployeeSummaryDto) {
    setSelectedId(row.id);
    setDrawerOpen(true);
  }

  const emptyMessage = search.trim() ? `Ningún expediente coincide con «${search.trim()}» en este segmento.` : segment === "active" ? "Aún no hay expedientes activos en este ámbito." : segment === "leave" ? "No hay expedientes en excedencia en este ámbito." : segment === "inactive" ? "No hay expedientes dados de baja en este ámbito." : "No hay contratos fijos discontinuos en este ámbito.";

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title="Plantilla"
      state={state}
      skeleton={<ScreenSkeleton />}
      error={{ title: "No se pudo cargar la plantilla", message: employeesState.error ?? undefined, onRetry: employeesState.refresh }}
      actions={
        <>
          {employeesState.isValidating && employees.length > 0 ? (
            <CocoaBadge tone="info" size="small" role="status">
              {STATUS_LABELS.loading}
            </CocoaBadge>
          ) : null}
          <FinanceScopeSelector scope={finance} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={employeesState.refresh} disabled={!read}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={openNew} disabled={!manage} title={manage ? "Alta de un expediente laboral (los datos personales se guardan cifrados)" : MANAGE_HINT}>
            {newEmployeeLabel}
          </CocoaButton>
        </>
      }
      commands={manage ? [{ id: "hr-new-employee", label: newEmployeeLabel, run: openNew }] : undefined}
    >
      {!read ? (
        <CocoaState kind="empty" title="Sin acceso a la plantilla" message={READ_HINT} illustration="box" />
      ) : (
        <CocoaSection
          title="Expedientes"
          meta={employees.length > 0 ? `${plural(employees.length, "expediente", "expedientes")}${expiring > 0 ? ` · ${number(expiring)} con contrato que vence en 30 días` : ""}` : undefined}
          scroll="x"
        >
          <div className="cocoa-stack" data-gap="3">
            <div className="cocoa-row" data-gap="2" data-justify="between">
              <CocoaSegmentedControl value={segment} onChange={(value) => isEmployeeSegment(value) && setSegment(value)} options={[...EMPLOYEE_SEGMENT_OPTIONS]} size="small" aria-label="Segmento de la plantilla" />
              <CocoaSearchInput value={search} onChange={setSearch} placeholder="Buscar por nombre o número de empleado" debounceMs={300} aria-label="Buscar en la plantilla" />
            </div>
            {!manage ? <p className="cocoa-note">{MANAGE_HINT}</p> : null}
            <CocoaTable
              columns={columns}
              rows={rows}
              rowKey="id"
              sortBy={sort}
              onSort={setSort}
              selectedKey={selectedId ?? undefined}
              onSelect={openRow}
              loading={employeesState.isValidating && employees.length === 0}
              keepDataWhileLoading
              density="compact"
              caption="Plantilla del ámbito seleccionado"
              rowTitle={() => "Abrir el expediente"}
              emptyState={<CocoaState kind="empty" inline title="Sin expedientes" message={emptyMessage} primaryAction={manage && !search.trim() && segment === "active" ? { label: newEmployeeLabel, onClick: openNew } : undefined} />}
            />
          </div>
        </CocoaSection>
      )}

      <EmployeeDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        employeeId={selectedId}
        centres={centres}
        defaultPropertyId={propertyId ?? (centres.length === 1 ? centres[0]!.id : null)}
        legalEntityId={legalEntityId}
        canManage={manage}
        today={today}
        onChanged={employeesState.refresh}
      />
    </CocoaPage>
  );
}

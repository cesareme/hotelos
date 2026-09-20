// Plantilla · cajón de expediente (Tanda RRHH · lote RRHH-8; diseño
// docs/design/RRHH-PLANTILLA-NOMINA.md §10 «Plantilla», recon RRHH/recon-delta.md §3.10).
//
// Un CocoaDrawer `size="lg"` con tres vistas (CocoaSegmentedControl) Datos ·
// Contrato · Baja sobre GET /hr/employees/:id (services/hrApi.ts):
//   · Datos: alta (POST /hr/employees) o edición (PATCH, solo lo que cambió)
//     con las reglas puras de employee-form.ts (NIF con letra, obligatorios,
//     topes). Los campos cifrados (NIF, NAF, correo, teléfono, IBAN) NUNCA
//     llegan con el detalle: el bloque «Datos personales cifrados» los pide
//     con «Mostrar» explícito (`?pii=1`, auditado HR_PII_READ por campo y
//     limitado a `piiFields` del ámbito) y el switch «Corregir datos cifrados»
//     abre inputs vacíos (vacío = sin cambio).
//   · Contrato: los contratos del expediente (EmployeeContractSummaryDto) y el
//     alta de uno nuevo sobre una ficha de centro enlazada (POST
//     /payroll/contracts, campos RRHH-2): el convenio elegido rellena pagas
//     (12 + extras) y jornada (40 h) si están vacías; sin ficha, un aviso
//     apunta a «Nueva ficha» de Nóminas (la ficha exige persona con acceso).
//     `CocoaStepper` es el control numérico ± de Cocoa (no un asistente por
//     pasos): aquí lleva las pagas anuales 12-16.
//   · Baja: fecha (≥ alta) y causa (HR_END_REASONS) → CocoaDialog destructivo
//     → POST …/terminate (critical: cierra contratos, desactiva fichas y
//     revoca accesos); un expediente ya de baja solo muestra fecha y causa.
// Escritura gateada por `canManage` (hr.employee.manage) desde la pantalla; sin
// la clave los controles se deshabilitan y una nota lo explica. Sin estilos en
// línea, solo componentes Cocoa, copy en español, nunca datos de personas reales.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { EmployeeContractSummaryDto, EmployeeDetailDto, EmployeePiiDto, HrPiiField } from "@hotelos/shared";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaStepper,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date } from "../../lib/format";
import {
  CONTRIBUTION_GROUP_OPTIONS,
  HR_CONTRACT_TYPE_OPTIONS,
  HR_END_REASON_OPTIONS,
  HR_GENDER_OPTIONS,
  HR_PII_FIELD_LABELS_ES,
  HR_PII_FIELD_ORDER,
  HR_USALI_DEPARTMENT_OPTIONS,
  agreementLabel,
  agreementOptions,
  contractDefaultsFromRules,
  contractTypeLabel,
  contributionGroupLabel,
  employeeStatusBadge,
  endReasonLabel,
  hoursLabel,
  hrErrorMessage,
  pctLabel,
  ruleValuesFrom
} from "../../services/hr-contracts";
import {
  createEmployee,
  createEmployeeContract,
  getEmployee,
  listAgreementRules,
  listAgreements,
  listEmployeeStaffProfiles,
  patchEmployee,
  terminateEmployee,
  type CollectiveAgreementDto,
  type StaffProfileRecord
} from "../../services/hrApi";
import { staffProfileLabel } from "../payroll/staff-profile-form";
import {
  CONTRACT_PAY_COUNT_MAX,
  CONTRACT_PAY_COUNT_MIN,
  EMPLOYEE_EMAIL_MAX,
  EMPLOYEE_IBAN_MAX,
  EMPLOYEE_JOB_TITLE_MAX,
  EMPLOYEE_NAF_MAX,
  EMPLOYEE_NAME_MAX,
  EMPLOYEE_NUMBER_MAX,
  EMPLOYEE_PHONE_MAX,
  applyAgreementRules,
  employeeFormFromDetail,
  isFormValid,
  newContractForm,
  newEmployeeForm,
  newTerminateForm,
  toContractBody,
  toEmployeeBody,
  toEmployeePatch,
  toTerminateBody,
  validateContractForm,
  validateEmployeeForm,
  validateTerminateForm,
  type ContractFormValues,
  type EmployeeFormValues,
  type TerminateFormValues
} from "./employee-form";

export type EmployeeDrawerCentre = { id: string; code: string | null; name: string; legalEntityId: string | null };

export type EmployeeDrawerProps = {
  open: boolean;
  onClose: () => void;
  /** null = alta de un expediente nuevo. */
  employeeId: string | null;
  centres: ReadonlyArray<EmployeeDrawerCentre>;
  /** Centro del ámbito: preselección del alta y centro del contrato nuevo. */
  defaultPropertyId: string | null;
  /** Sociedad empleadora del alta (POST /hr/employees.legalEntityId); null → el alta se deshabilita con aviso. */
  legalEntityId: string | null;
  /** hr.employee.manage con las concesiones reales (canDo(useNavGate(), …)) — la pantalla lo resuelve. */
  canManage: boolean;
  /** Día de hoy (YYYY-MM-DD, zona del hotel). */
  today: string;
  /** Tras alta, edición, contrato o baja: la pantalla recarga el listado. */
  onChanged: () => void;
};

type Section = "data" | "contract" | "termination";

const SECTION_OPTIONS: ReadonlyArray<{ value: Section; label: string }> = [
  { value: "data", label: "Datos" },
  { value: "contract", label: "Contrato" },
  { value: "termination", label: "Baja" }
];

const MANAGE_HINT = "Necesitas el permiso de gestión de expedientes (hr.employee.manage) para escribir en la plantilla.";
const PII_MASK = "••••••••";

function centreOptions(centres: ReadonlyArray<EmployeeDrawerCentre>): Array<{ value: string; label: string }> {
  return [{ value: "", label: "Sin centro principal" }, ...centres.map((centre) => ({ value: centre.id, label: centre.code ? `${centre.code} · ${centre.name}` : centre.name }))];
}

function contractColumns(agreements: readonly CollectiveAgreementDto[]): CocoaTableColumn<EmployeeContractSummaryDto>[] {
  return [
    { key: "contractType", label: "Modalidad", render: (row) => <strong>{contractTypeLabel(row.contractType)}</strong> },
    { key: "startDate", label: "Inicio", fit: true, render: (row) => <span className="cocoa-tabular">{date(row.startDate)}</span> },
    { key: "endDate", label: "Fin", fit: true, render: (row) => (row.endDate ? <span className="cocoa-tabular">{date(row.endDate)}</span> : "Indefinido") },
    {
      key: "hours",
      label: "Jornada",
      render: (row) => {
        const hours = hoursLabel(row.weeklyHours);
        const pct = pctLabel(row.partTimePct);
        const parts = [hours, pct].filter((part): part is string => Boolean(part));
        return parts.length > 0 ? parts.join(" · ") : "—";
      }
    },
    { key: "agreement", label: "Convenio", render: (row) => agreementLabel(agreements, row.agreementId, row.agreementCode) },
    { key: "payCount", label: "Pagas", align: "right", fit: true, render: (row) => <span className="cocoa-tabular">{row.payCount}</span> },
    { key: "group", label: "Grupo", hideOnNarrow: true, render: (row) => contributionGroupLabel(row.contributionGroup) ?? "—" },
    {
      key: "active",
      label: "Estado",
      fit: true,
      render: (row) => (
        <CocoaBadge tone={row.active ? "success" : "neutral"} size="small">
          {row.active ? "Vigente" : "Cerrado"}
        </CocoaBadge>
      )
    }
  ];
}

export function EmployeeDrawer({ open, onClose, employeeId, centres, defaultPropertyId, legalEntityId, canManage, today, onChanged }: EmployeeDrawerProps) {
  const { showToast } = useToast();
  const panelId = useId();
  const isNew = employeeId === null;

  const [section, setSection] = useState<Section>("data");
  const [detail, setDetail] = useState<EmployeeDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // ---- Datos ----
  const [form, setForm] = useState<EmployeeFormValues>(() => newEmployeeForm({ today, propertyId: defaultPropertyId }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editPii, setEditPii] = useState(false);
  // PII: null while hidden; the values of `?pii=1` once «Mostrar» was pressed (audited by the API).
  const [pii, setPii] = useState<EmployeePiiDto | null>(null);
  const [piiLoading, setPiiLoading] = useState(false);
  const [piiError, setPiiError] = useState<string | null>(null);

  // ---- Contrato ----
  const [agreements, setAgreements] = useState<CollectiveAgreementDto[]>([]);
  const [profiles, setProfiles] = useState<StaffProfileRecord[]>([]);
  const [contractForm, setContractForm] = useState<ContractFormValues>(() => newContractForm({ today }));
  const [contractSaving, setContractSaving] = useState(false);
  const [contractError, setContractError] = useState<string | null>(null);
  const [rulesNote, setRulesNote] = useState<string | null>(null);

  // ---- Baja ----
  const [terminateForm, setTerminateForm] = useState<TerminateFormValues>(() => newTerminateForm(today));
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [terminateError, setTerminateError] = useState<string | null>(null);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      setDetailError(null);
      try {
        const loaded = await getEmployee(id);
        setDetail(loaded);
        setForm(employeeFormFromDetail(loaded));
      } catch (error) {
        setDetail(null);
        setDetailError(hrErrorMessage(error, "No se pudo cargar el expediente."));
      } finally {
        setDetailLoading(false);
      }
    },
    []
  );

  // Every opening starts clean: the section, the forms and the PII (never kept between files).
  useEffect(() => {
    if (!open) return;
    setSection("data");
    setSaveError(null);
    setContractError(null);
    setTerminateError(null);
    setPii(null);
    setPiiError(null);
    setEditPii(false);
    setRulesNote(null);
    setContractForm(newContractForm({ today }));
    setTerminateForm(newTerminateForm(today));
    setTerminateOpen(false);
    if (employeeId) {
      void loadDetail(employeeId);
    } else {
      setDetail(null);
      setDetailError(null);
      setForm(newEmployeeForm({ today, propertyId: defaultPropertyId }));
    }
  }, [open, employeeId, today, defaultPropertyId, loadDetail]);

  // Agreements and fichas are read lazily, once the Contrato view is opened.
  useEffect(() => {
    if (!open || section !== "contract" || !detail) return;
    let cancelled = false;
    void Promise.all([listAgreements(), listEmployeeStaffProfiles(null)])
      .then(([loadedAgreements, loadedProfiles]) => {
        if (cancelled) return;
        setAgreements(loadedAgreements);
        setProfiles(loadedProfiles);
      })
      .catch((error: unknown) => {
        if (!cancelled) setContractError(hrErrorMessage(error, "No se pudieron cargar los convenios y las fichas."));
      });
    return () => {
      cancelled = true;
    };
  }, [open, section, detail]);

  const employeeProfiles = useMemo(() => {
    const linked = new Set(detail?.staffProfileIds ?? []);
    return profiles.filter((profile) => linked.has(profile.id));
  }, [profiles, detail]);

  const profileOptions = useMemo(
    () =>
      employeeProfiles.map((profile) => {
        const centre = centres.find((row) => row.id === profile.propertyId);
        const where = centre ? (centre.code ?? centre.name) : profile.propertyId;
        return { value: profile.id, label: `${staffProfileLabel(profile)} · ${where}${profile.active ? "" : " (inactiva)"}` };
      }),
    [employeeProfiles, centres]
  );

  // The first linked ficha is preselected as soon as the fichas arrive.
  useEffect(() => {
    if (contractForm.staffProfileId === "" && employeeProfiles.length > 0) {
      setContractForm((current) => (current.staffProfileId === "" ? { ...current, staffProfileId: employeeProfiles[0]!.id } : current));
    }
  }, [employeeProfiles, contractForm.staffProfileId]);

  const contractPropertyId = useMemo(() => employeeProfiles.find((profile) => profile.id === contractForm.staffProfileId)?.propertyId ?? detail?.primaryPropertyId ?? defaultPropertyId ?? null, [employeeProfiles, contractForm.staffProfileId, detail, defaultPropertyId]);

  // RF-14: what the stepper shows is what the API saves — the centre's agreement fills pays and hours as soon as the
  // Contrato view knows the agreements and the centre (once per centre; the selector re-resolves on change).
  const [rulesPreloadedFor, setRulesPreloadedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!open || section !== "contract" || !detail || agreements.length === 0 || !contractPropertyId) return;
    if (rulesPreloadedFor === contractPropertyId || contractForm.payCount.trim() !== "") return;
    setRulesPreloadedFor(contractPropertyId);
    void changeAgreement(contractForm.agreementId);
    // changeAgreement reads the current form on purpose (it keeps what the person typed); no dependency on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, section, detail, agreements, contractPropertyId, rulesPreloadedFor]);

  const formErrors = useMemo(() => validateEmployeeForm(form, isNew ? "create" : "edit"), [form, isNew]);
  const formValid = isFormValid(formErrors);
  const contractErrors = useMemo(() => validateContractForm(contractForm), [contractForm]);
  const contractValid = isFormValid(contractErrors);
  const terminateErrors = useMemo(() => validateTerminateForm(terminateForm, detail?.hiredAt), [terminateForm, detail]);
  const terminateValid = isFormValid(terminateErrors);

  const update = <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]) => setForm((current) => ({ ...current, [key]: value }));
  const updateContract = <K extends keyof ContractFormValues>(key: K, value: ContractFormValues[K]) => setContractForm((current) => ({ ...current, [key]: value }));

  /** «Mostrar»: ONE explicit GET ?pii=1 (audited per field); the values live only in this state and vanish on close. */
  async function showPii() {
    if (!employeeId) return;
    setPiiLoading(true);
    setPiiError(null);
    try {
      const loaded = await getEmployee(employeeId, { pii: true });
      setPii(loaded.pii ?? { taxId: null, socialSecurityNumber: null, email: null, phone: null, iban: null });
    } catch (error) {
      setPiiError(hrErrorMessage(error, "No se pudieron mostrar los datos personales."));
    } finally {
      setPiiLoading(false);
    }
  }

  async function saveData() {
    setSaveError(null);
    if (!formValid) return;
    setSaving(true);
    try {
      if (isNew) {
        if (!legalEntityId) throw new Error("No se pudo determinar la sociedad empleadora del alta.");
        const created = await createEmployee(toEmployeeBody(form, legalEntityId));
        showToast(`Expediente ${created.employeeNumber} creado.`, { variant: "success" });
        onChanged();
        onClose();
        return;
      }
      if (!detail) return;
      const patch = toEmployeePatch(form, detail);
      if (!patch) {
        showToast("No hay cambios que guardar.", { variant: "info" });
        return;
      }
      const updated = await patchEmployee(detail.id, patch);
      setDetail(updated);
      setForm(employeeFormFromDetail(updated));
      setEditPii(false);
      setPii(null);
      showToast("Expediente actualizado.", { variant: "success" });
      onChanged();
    } catch (error) {
      setSaveError(hrErrorMessage(error, isNew ? "No se pudo crear el expediente." : "No se pudo guardar el expediente."));
    } finally {
      setSaving(false);
    }
  }

  /** The agreement chosen (or the centre's) fills pays and full-time hours over the empty fields. */
  async function changeAgreement(agreementId: string) {
    setContractError(null);
    const effective = agreementId || agreements.find((agreement) => contractPropertyId !== null && agreement.propertyIds.includes(contractPropertyId))?.id || "";
    const next: ContractFormValues = { ...contractForm, agreementId, payCount: "", weeklyHours: "" };
    if (!effective) {
      setContractForm(next);
      setRulesNote("El centro no tiene convenio asignado: el API aplicará 14 pagas salvo que indiques otra cifra.");
      return;
    }
    try {
      const rules = await listAgreementRules(effective, contractForm.startDate || today);
      const values = ruleValuesFrom(rules);
      const defaults = contractDefaultsFromRules(values);
      setContractForm(applyAgreementRules(next, values));
      const agreement = agreements.find((row) => row.id === effective);
      const parts = [`${defaults.payCount} pagas`];
      if (defaults.annualHours !== null) parts.push(`jornada anual ${defaults.annualHours} h`);
      if (defaults.vacationDays !== null) parts.push(`${defaults.vacationDays} días de vacaciones`);
      setRulesNote(`${agreement ? agreement.code : "Convenio del centro"}: ${parts.join(" · ")}.`);
    } catch (error) {
      setContractForm(next);
      setRulesNote(null);
      setContractError(hrErrorMessage(error, "No se pudieron leer las reglas del convenio."));
    }
  }

  async function saveContract() {
    setContractError(null);
    if (!contractValid || !detail) return;
    setContractSaving(true);
    try {
      const createdContract = await createEmployeeContract(toContractBody(contractForm, contractPropertyId));
      showToast("Contrato creado.", { variant: "success" });
      // Position control (RF-05) and second active contract (RF-07): warnings never block, so they follow the success toast.
      const contractWarnings = createdContract.warnings ?? [];
      if (contractWarnings.length > 0) showToast(contractWarnings.join(" · "), { variant: "warning" });
      setContractForm(newContractForm({ today, staffProfileId: contractForm.staffProfileId }));
      setRulesNote(null);
      await loadDetail(detail.id);
      onChanged();
    } catch (error) {
      setContractError(hrErrorMessage(error, "No se pudo crear el contrato."));
    } finally {
      setContractSaving(false);
    }
  }

  async function confirmTerminate() {
    if (!detail || !terminateValid) return;
    setTerminating(true);
    setTerminateError(null);
    try {
      const result = await terminateEmployee(detail.id, toTerminateBody(terminateForm));
      setDetail(result.employee);
      setForm(employeeFormFromDetail(result.employee));
      setTerminateOpen(false);
      const closed = result.deactivatedContractIds.length;
      const revoked = result.revokedAssignmentIds.length;
      showToast(`Baja registrada: ${closed} ${closed === 1 ? "contrato cerrado" : "contratos cerrados"}, ${revoked} ${revoked === 1 ? "acceso revocado" : "accesos revocados"}.`, { variant: "success" });
      onChanged();
    } catch (error) {
      setTerminateOpen(false);
      setTerminateError(hrErrorMessage(error, "No se pudo registrar la baja."));
    } finally {
      setTerminating(false);
    }
  }

  const terminated = detail?.status === "inactive";
  const title = isNew ? "Nuevo expediente" : detail ? `${detail.fullName} · ${detail.employeeNumber}` : "Expediente";
  const status = detail ? employeeStatusBadge(detail.status) : null;
  const canWriteData = canManage && !terminated;
  const piiFields: readonly HrPiiField[] = detail ? HR_PII_FIELD_ORDER.filter((field) => detail.piiFields.includes(field)) : [];

  const footer =
    section === "termination" ? (
      <CocoaButton variant="bordered" tone="neutral" onClick={onClose}>
        {ACTIONS.close}
      </CocoaButton>
    ) : section === "contract" ? (
      <>
        <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={contractSaving}>
          {ACTIONS.close}
        </CocoaButton>
        <CocoaButton variant="filled" tone="accent" onClick={() => void saveContract()} loading={contractSaving} disabled={!canWriteData || !contractValid || contractSaving || employeeProfiles.length === 0} title={canManage ? undefined : MANAGE_HINT}>
          {contractSaving ? STATUS_LABELS.saving : "Guardar contrato"}
        </CocoaButton>
      </>
    ) : (
      <>
        <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={saving}>
          {ACTIONS.cancel}
        </CocoaButton>
        <CocoaButton variant="filled" tone="accent" onClick={() => void saveData()} loading={saving} disabled={!canWriteData || !formValid || saving || (isNew && !legalEntityId)} title={canManage ? undefined : MANAGE_HINT}>
          {saving ? STATUS_LABELS.saving : isNew ? "Crear expediente" : ACTIONS.saveChanges}
        </CocoaButton>
      </>
    );

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title={title}
      subtitle={isNew ? "Datos del expediente laboral; el contrato se da de alta después sobre una ficha de centro." : undefined}
      side="right"
      size="lg"
      footer={footer}
      loading={detailLoading && !detail}
      skeleton={
        <div className="cocoa-stack" data-gap="3" aria-hidden="true">
          <CocoaSkeleton variant="title" />
          <CocoaSkeleton variant="row" lines={4} />
        </div>
      }
    >
      {detailError ? <CocoaState kind="error" inline title="No se pudo cargar el expediente" message={detailError} onRetry={employeeId ? () => void loadDetail(employeeId) : undefined} /> : null}

      {!isNew && detail ? (
        <div className="cocoa-stack" data-gap="3">
          <div className="cocoa-row" data-gap="2">
            {status ? <CocoaBadge tone={status.tone}>{status.label}</CocoaBadge> : null}
            {detail.terminatedAt ? <span className="cocoa-caption">Baja el {date(detail.terminatedAt)}</span> : null}
            {!canManage ? <span className="cocoa-caption">Solo lectura</span> : null}
          </div>
          <CocoaSegmentedControl value={section} onChange={(value) => setSection(value as Section)} options={[...SECTION_OPTIONS]} size="small" panelId={panelId} aria-label="Vistas del expediente" />
        </div>
      ) : null}

      {!canManage && isNew ? <p className="cocoa-note">{MANAGE_HINT}</p> : null}
      {isNew && !legalEntityId ? (
        <CocoaCallout tone="warning" title="Sin sociedad empleadora">
          No se pudo determinar la sociedad del ámbito; elige un centro en el selector de la pantalla o revisa la estructura societaria.
        </CocoaCallout>
      ) : null}

      {/* ---- Datos ---- */}
      {section === "data" && (isNew || detail) ? (
        <div id={panelId} className="cocoa-stack" data-gap="4">
          <CocoaFormSection title="Identidad">
            <CocoaFormRow columns={2}>
              <CocoaField label="Nombre" required error={form.firstName === "" ? undefined : formErrors.firstName}>
                <CocoaInput value={form.firstName} onChange={(value) => update("firstName", value)} maxLength={EMPLOYEE_NAME_MAX} disabled={!canWriteData} autoComplete="off" />
              </CocoaField>
              <CocoaField label="Apellidos" required error={form.lastName === "" ? undefined : formErrors.lastName}>
                <CocoaInput value={form.lastName} onChange={(value) => update("lastName", value)} maxLength={EMPLOYEE_NAME_MAX} disabled={!canWriteData} autoComplete="off" />
              </CocoaField>
              {isNew ? (
                <CocoaField label="NIF / NIE" required error={form.taxId === "" ? undefined : formErrors.taxId} help="Con la letra de control; se guarda cifrado y nunca aparece en el listado.">
                  <CocoaInput value={form.taxId} onChange={(value) => update("taxId", value)} maxLength={20} placeholder="00000000T" disabled={!canWriteData} autoComplete="off" />
                </CocoaField>
              ) : null}
              <CocoaField label="Número de empleado" hint="opcional" error={formErrors.employeeNumber} help={isNew ? "Vacío: el sistema asigna el siguiente número de la sociedad." : undefined}>
                <CocoaInput value={form.employeeNumber} onChange={(value) => update("employeeNumber", value)} maxLength={EMPLOYEE_NUMBER_MAX} placeholder="Automático" disabled={!canWriteData} autoComplete="off" />
              </CocoaField>
              <CocoaField label="Fecha de alta" required error={form.hiredAt === "" ? undefined : formErrors.hiredAt}>
                <CocoaDatePicker value={form.hiredAt} onChange={(value) => update("hiredAt", value)} disabled={!canWriteData} today={today} />
              </CocoaField>
              <CocoaField label="Sexo" hint="opcional" help="Solo para el registro retributivo (RD 902/2020).">
                <CocoaSelect value={form.gender} onChange={(value) => update("gender", value)} options={[...HR_GENDER_OPTIONS]} disabled={!canWriteData} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection title="Puesto y centro">
            <CocoaFormRow columns={2}>
              <CocoaField label="Centro de trabajo principal" help="El contrato lleva su propio centro (la ficha).">
                <CocoaSelect value={form.primaryPropertyId} onChange={(value) => update("primaryPropertyId", value)} options={centreOptions(centres)} disabled={!canWriteData} />
              </CocoaField>
              <CocoaField label="Departamento USALI" error={formErrors.usaliDepartment}>
                <CocoaSelect value={form.usaliDepartment} onChange={(value) => update("usaliDepartment", value)} options={[...HR_USALI_DEPARTMENT_OPTIONS]} disabled={!canWriteData} />
              </CocoaField>
              <CocoaField label="Puesto" hint="opcional" error={formErrors.jobTitle}>
                <CocoaInput value={form.jobTitle} onChange={(value) => update("jobTitle", value)} maxLength={EMPLOYEE_JOB_TITLE_MAX} placeholder="Camarera de pisos" disabled={!canWriteData} autoComplete="off" />
              </CocoaField>
              <CocoaField label="Situación" help="La baja definitiva se registra en la vista «Baja».">
                <CocoaSelect
                  value={form.status}
                  onChange={(value) => update("status", value === "leave" ? "leave" : "active")}
                  options={[
                    { value: "active", label: "Activo" },
                    { value: "leave", label: "Excedencia" }
                  ]}
                  disabled={!canWriteData}
                />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          {isNew ? (
            <CocoaFormSection title="Datos de contacto y bancarios" description="Se guardan cifrados; solo se muestran en la ficha con «Mostrar» y cada consulta queda auditada.">
              <CocoaFormRow columns={2}>
                <CocoaField label="Correo electrónico" hint="opcional" error={form.email === "" ? undefined : formErrors.email}>
                  <CocoaInput value={form.email} onChange={(value) => update("email", value)} type="email" inputMode="email" maxLength={EMPLOYEE_EMAIL_MAX} disabled={!canWriteData} autoComplete="off" />
                </CocoaField>
                <CocoaField label="Teléfono" hint="opcional" error={formErrors.phone}>
                  <CocoaInput value={form.phone} onChange={(value) => update("phone", value)} type="tel" inputMode="tel" maxLength={EMPLOYEE_PHONE_MAX} disabled={!canWriteData} autoComplete="off" />
                </CocoaField>
                <CocoaField label="Número de afiliación (NAF)" hint="opcional" error={form.socialSecurityNumber === "" ? undefined : formErrors.socialSecurityNumber} help="12 dígitos.">
                  <CocoaInput value={form.socialSecurityNumber} onChange={(value) => update("socialSecurityNumber", value)} inputMode="numeric" maxLength={EMPLOYEE_NAF_MAX} disabled={!canWriteData} autoComplete="off" />
                </CocoaField>
                <CocoaField label="IBAN" hint="opcional" error={form.iban === "" ? undefined : formErrors.iban}>
                  <CocoaInput value={form.iban} onChange={(value) => update("iban", value)} maxLength={EMPLOYEE_IBAN_MAX + 8} placeholder="ES00 0000 0000 0000 0000 0000" disabled={!canWriteData} autoComplete="off" />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>
          ) : (
            <CocoaFormSection
              title="Datos personales cifrados"
              description="NIF, NAF, correo, teléfono e IBAN no viajan con la ficha: se piden con «Mostrar» y cada consulta queda registrada en la auditoría (HR_PII_READ)."
              actions={
                piiFields.length === 0 ? null : pii ? (
                  <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setPii(null)}>
                    Ocultar
                  </CocoaButton>
                ) : (
                  <CocoaButton variant="plain" tone="accent" size="small" onClick={() => void showPii()} loading={piiLoading} disabled={piiLoading}>
                    Mostrar
                  </CocoaButton>
                )
              }
            >
              {piiFields.length === 0 ? (
                <p className="cocoa-note">Tu ámbito no puede consultar los datos personales cifrados de este expediente.</p>
              ) : (
                <CocoaFormRow columns={2}>
                  {piiFields.map((field) => (
                    <CocoaField key={field} label={HR_PII_FIELD_LABELS_ES[field]}>
                      <CocoaInput value={pii ? (pii[field] ?? "—") : PII_MASK} readOnly onChange={() => undefined} aria-label={`${HR_PII_FIELD_LABELS_ES[field]}${pii ? "" : " (oculto)"}`} />
                    </CocoaField>
                  ))}
                </CocoaFormRow>
              )}
              {piiError ? (
                <CocoaCallout tone="danger" title="No se pudieron mostrar los datos" role="alert">
                  {piiError}
                </CocoaCallout>
              ) : null}
              {canWriteData ? (
                <div className="cocoa-stack" data-gap="3">
                  <CocoaSwitch checked={editPii} onChange={setEditPii} label="Corregir datos cifrados (vacío = sin cambio)" />
                  {editPii ? (
                    <CocoaFormRow columns={2}>
                      <CocoaField label="Nuevo NIF / NIE" error={form.taxId === "" ? undefined : formErrors.taxId}>
                        <CocoaInput value={form.taxId} onChange={(value) => update("taxId", value)} maxLength={20} autoComplete="off" />
                      </CocoaField>
                      <CocoaField label="Nuevo correo electrónico" error={form.email === "" ? undefined : formErrors.email}>
                        <CocoaInput value={form.email} onChange={(value) => update("email", value)} type="email" inputMode="email" maxLength={EMPLOYEE_EMAIL_MAX} autoComplete="off" />
                      </CocoaField>
                      <CocoaField label="Nuevo teléfono" error={formErrors.phone}>
                        <CocoaInput value={form.phone} onChange={(value) => update("phone", value)} type="tel" inputMode="tel" maxLength={EMPLOYEE_PHONE_MAX} autoComplete="off" />
                      </CocoaField>
                      <CocoaField label="Nuevo NAF" error={form.socialSecurityNumber === "" ? undefined : formErrors.socialSecurityNumber}>
                        <CocoaInput value={form.socialSecurityNumber} onChange={(value) => update("socialSecurityNumber", value)} inputMode="numeric" maxLength={EMPLOYEE_NAF_MAX} autoComplete="off" />
                      </CocoaField>
                      <CocoaField label="Nuevo IBAN" error={form.iban === "" ? undefined : formErrors.iban}>
                        <CocoaInput value={form.iban} onChange={(value) => update("iban", value)} maxLength={EMPLOYEE_IBAN_MAX + 8} autoComplete="off" />
                      </CocoaField>
                    </CocoaFormRow>
                  ) : null}
                </div>
              ) : null}
            </CocoaFormSection>
          )}

          {saveError ? (
            <CocoaCallout tone="danger" title={isNew ? "No se pudo crear el expediente" : "No se pudo guardar"} role="alert">
              {saveError}
            </CocoaCallout>
          ) : null}
        </div>
      ) : null}

      {/* ---- Contrato ---- */}
      {section === "contract" && detail ? (
        <div id={panelId} className="cocoa-stack" data-gap="4">
          <CocoaFormSection title="Contratos del expediente" description="Vigentes y cerrados; el vigente es el que aparece en el listado.">
            {detail.contracts.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin contratos" message="Este expediente aún no tiene ningún contrato registrado." />
            ) : (
              <CocoaTable columns={contractColumns(agreements)} rows={detail.contracts} rowKey="id" density="compact" caption="Contratos del expediente" />
            )}
          </CocoaFormSection>

          {terminated ? (
            <CocoaCallout tone="info" title="Expediente dado de baja">
              No se pueden dar de alta contratos sobre un expediente dado de baja.
            </CocoaCallout>
          ) : employeeProfiles.length === 0 ? (
            <CocoaCallout tone="info" title="Sin ficha de personal en ningún centro">
              El contrato se registra sobre una ficha de centro (persona con acceso a la aplicación): créala en Nóminas › Contratos con «Nueva ficha» y vuelve aquí.
            </CocoaCallout>
          ) : (
            <CocoaFormSection title="Nuevo contrato" description="El convenio elegido rellena las pagas y la jornada a tiempo completo; puedes ajustarlas.">
              {!canManage ? <p className="cocoa-note">{MANAGE_HINT}</p> : null}
              <CocoaFormRow columns={2}>
                <CocoaField label="Ficha de personal" required error={contractForm.staffProfileId === "" ? undefined : contractErrors.staffProfileId}>
                  <CocoaSelect value={contractForm.staffProfileId} onChange={(value) => updateContract("staffProfileId", value)} options={profileOptions} placeholder="Elige una ficha de personal" disabled={!canManage} />
                </CocoaField>
                <CocoaField label="Convenio" help={rulesNote ?? "Vacío: el convenio asignado al centro de la ficha."}>
                  <CocoaSelect value={contractForm.agreementId} onChange={(value) => void changeAgreement(value)} options={agreementOptions(agreements)} disabled={!canManage} />
                </CocoaField>
                <CocoaField label="Modalidad de contrato" required error={contractErrors.contractType}>
                  <CocoaSelect value={contractForm.contractType} onChange={(value) => updateContract("contractType", value)} options={[...HR_CONTRACT_TYPE_OPTIONS]} disabled={!canManage} />
                </CocoaField>
                <CocoaField label="Bruto mensual (€)" required error={contractForm.grossSalary === "" ? undefined : contractErrors.grossSalary}>
                  <CocoaInput value={contractForm.grossSalary} onChange={(value) => updateContract("grossSalary", value)} type="number" inputMode="decimal" min={0} step="0.01" placeholder="1800,00" disabled={!canManage} />
                </CocoaField>
                <CocoaField label="Inicio" required error={contractForm.startDate === "" ? undefined : contractErrors.startDate}>
                  <CocoaDatePicker value={contractForm.startDate} onChange={(value) => updateContract("startDate", value)} disabled={!canManage} today={today} />
                </CocoaField>
                <CocoaField label="Fin" hint="opcional" error={contractErrors.endDate}>
                  <CocoaDatePicker value={contractForm.endDate} onChange={(value) => updateContract("endDate", value)} min={contractForm.startDate || undefined} disabled={!canManage} today={today} />
                </CocoaField>
                <CocoaField label="Pagas anuales" error={contractErrors.payCount} help="Entre 12 y 16; el convenio suma sus pagas extra a las 12 mensuales.">
                  <CocoaStepper value={Number(contractForm.payCount || 14)} onChange={(value) => updateContract("payCount", String(value))} min={CONTRACT_PAY_COUNT_MIN} max={CONTRACT_PAY_COUNT_MAX} step={1} disabled={!canManage} />
                </CocoaField>
                <CocoaField label="Jornada semanal (h)" hint="opcional" error={contractForm.weeklyHours === "" ? undefined : contractErrors.weeklyHours} help="Hasta 60 h; 40 h a tiempo completo.">
                  <CocoaInput value={contractForm.weeklyHours} onChange={(value) => updateContract("weeklyHours", value)} type="number" inputMode="decimal" min={0} max={60} step="0.5" placeholder="40" disabled={!canManage} />
                </CocoaField>
                <CocoaField label="Porcentaje de jornada" hint="opcional" error={contractForm.partTimePct === "" ? undefined : contractErrors.partTimePct} help="100 = jornada completa.">
                  <CocoaInput value={contractForm.partTimePct} onChange={(value) => updateContract("partTimePct", value)} type="number" inputMode="decimal" min={0} max={100} step="0.01" disabled={!canManage} />
                </CocoaField>
                <CocoaField label="Grupo de cotización" hint="opcional" error={contractErrors.contributionGroup}>
                  <CocoaSelect value={contractForm.contributionGroup} onChange={(value) => updateContract("contributionGroup", value)} options={[...CONTRIBUTION_GROUP_OPTIONS]} disabled={!canManage} />
                </CocoaField>
                <CocoaField label="Fijo discontinuo" inline fullWidth help="Se marca solo con la modalidad «Fijo discontinuo».">
                  <CocoaSwitch checked={contractForm.fixedDiscontinuous || contractForm.contractType === "fijo_discontinuo"} onChange={(value) => updateContract("fixedDiscontinuous", value)} disabled={!canManage || contractForm.contractType === "fijo_discontinuo"} />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>
          )}

          {contractError ? (
            <CocoaCallout tone="danger" title="No se pudo completar la operación" role="alert">
              {contractError}
            </CocoaCallout>
          ) : null}
        </div>
      ) : null}

      {/* ---- Baja ---- */}
      {section === "termination" && detail ? (
        <div id={panelId} className="cocoa-stack" data-gap="4">
          {terminated ? (
            <CocoaCallout tone="info" title={`Baja registrada el ${detail.terminatedAt ? date(detail.terminatedAt) : "—"}`}>
              {endReasonLabel(detail.terminationReason) ?? "Causa sin especificar"}. Los contratos quedaron cerrados, las fichas desactivadas y los accesos revocados.
            </CocoaCallout>
          ) : (
            <>
              <CocoaCallout tone="warning" title="La baja no se deshace">
                Cierra los contratos vigentes en la fecha indicada, desactiva las fichas de centro y revoca los accesos a la aplicación de la persona. Las incidencias del mes la recogen para la gestoría.
              </CocoaCallout>
              {!canManage ? <p className="cocoa-note">{MANAGE_HINT}</p> : null}
              <CocoaFormSection title="Datos de la baja">
                <CocoaFormRow columns={2}>
                  <CocoaField label="Fecha de baja" required error={terminateErrors.terminatedAt}>
                    <CocoaDatePicker value={terminateForm.terminatedAt} onChange={(value) => setTerminateForm((current) => ({ ...current, terminatedAt: value }))} min={detail.hiredAt} disabled={!canManage} today={today} />
                  </CocoaField>
                  <CocoaField label="Causa" hint="opcional" error={terminateErrors.reason}>
                    <CocoaSelect value={terminateForm.reason} onChange={(value) => setTerminateForm((current) => ({ ...current, reason: value }))} options={[...HR_END_REASON_OPTIONS]} disabled={!canManage} />
                  </CocoaField>
                </CocoaFormRow>
              </CocoaFormSection>
              <div className="cocoa-row" data-justify="end">
                <CocoaButton variant="filled" tone="destructive" onClick={() => setTerminateOpen(true)} disabled={!canManage || !terminateValid || terminating} title={canManage ? undefined : MANAGE_HINT}>
                  Dar de baja
                </CocoaButton>
              </div>
            </>
          )}
          {terminateError ? (
            <CocoaCallout tone="danger" title="No se pudo registrar la baja" role="alert">
              {terminateError}
            </CocoaCallout>
          ) : null}
        </div>
      ) : null}

      <CocoaDialog
        open={terminateOpen}
        onClose={() => setTerminateOpen(false)}
        tone="destructive"
        title={detail ? `Dar de baja a ${detail.fullName}` : "Dar de baja"}
        description={`Con fecha ${terminateForm.terminatedAt ? date(terminateForm.terminatedAt) : "—"}. Se cierran los contratos vigentes, se desactivan las fichas y se revocan los accesos. No se puede deshacer.`}
        confirmLabel="Dar de baja"
        cancelLabel={ACTIONS.cancel}
        onConfirm={() => void confirmTerminate()}
        busy={terminating}
        confirmDisabled={!terminateValid}
      />
    </CocoaDrawer>
  );
}

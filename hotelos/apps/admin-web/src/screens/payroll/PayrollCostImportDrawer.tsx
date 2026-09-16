// «Importar informe» — the drawer of Nóminas › Coste de personal (Tanda 6c · L4;
// design docs/design/FINANZAS-COSTE-PERSONAL.md §8). A CocoaDrawer (640) with
// three blocks and no inline styles:
//
//   1 Fichero o texto   CocoaFileInput (.csv / .json, ≤ 1 MB) or the pasted CSV /
//                       JSON in a multiline CocoaInput → «Previsualizar»
//                       (POST /payroll/cost-imports/preview: never writes).
//   2 Mapeo             only when the preview reports labels without a match:
//                       one CocoaSelect per centre label (centres of the ERP,
//                       preselected with the API's first suggestion — and the
//                       preview is run AGAIN with that suggestion so the table
//                       and «Contabilizar» agree with the selects, front-ux-FU-01;
//                       the label stays listed so the user confirms or changes it)
//                       and per department label (USALI departments that admit
//                       `labor`); every change previews again with the mapping.
//   3 Vista previa      counts, totals, the byCentreMonth table (one row = one
//                       entry to post), errors, warnings and the duplicate /
//                       overlap / real-payroll callout with the «Sustituir los
//                       lotes anteriores» switch (replace reverses the earlier
//                       lots ENTIRELY: always re-import the full range).
//
// «Contabilizar» (POST /payroll/cost-imports, post: true) is enabled only when
// the preview says `canPost` and the session holds `payroll.manage` (the
// parent decides with canDo(useNavGate(), …) and passes `canManage`). The
// result paints the entries posted (nº, ejercicio) and the parent refreshes.
// Every opening starts clean (front-ux-FU-04): file, preview, mapping and result
// of the previous import never leak into the next one. The preview itself needs
// `payroll.manage` (the API answers 403 otherwise), so without the grant the
// drawer explains it and disables «Previsualizar» (front-ux-FU-10).
// The ERP stores aggregates only: the format has no person columns.

import { useEffect, useId, useState } from "react";
import type { PayrollCostImportCreateResult, PayrollCostImportFormat, PayrollCostImportPreview, PayrollCostUnmappedLabel } from "@hotelos/shared";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDrawer, CocoaField, CocoaFileInput, CocoaFormRow, CocoaFormSection, CocoaInput, CocoaSelect, CocoaStat, CocoaSwitch, CocoaTable, type CocoaTableColumn } from "../../components/cocoa";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { money, number, plural } from "../../lib/format";
import { centreSelectOptions, type FinanceScopeState } from "../../services/financeScope";
import { createPayrollCostImport, previewPayrollCostImport } from "../../services/payrollApi";
import {
  PAYROLL_COST_CSV_HEADER_NOTE,
  PAYROLL_COST_MAX_BYTES,
  buildImportMapping,
  costGroupLabel,
  detectImportFormat,
  entrySummaryLabel,
  formatHeadcount,
  importResultTitle,
  importSourceOf,
  monthLabel,
  monthRangeLabel,
  payrollCostErrorMessage,
  previewBlockers,
  replacedImportsSummary,
  suggestedCentreId,
  usaliDepartmentLabel,
  usaliLaborDepartmentOptions
} from "./payroll-cost-helpers";

export type PayrollCostImportDrawerProps = {
  open: boolean;
  onClose: () => void;
  /** The «Ámbito» of the screen: its structure feeds the centre pickers of the mapping step. */
  finance: Pick<FinanceScopeState, "structure" | "active">;
  /** `payroll.manage` granted (canDo over useNavGate in the parent). */
  canManage: boolean;
  /** Called after a successful post (the parent refreshes the report and the lots). */
  onPosted: (result: PayrollCostImportCreateResult) => void;
};

type CentreMonthRow = PayrollCostImportPreview["byCentreMonth"][number];

const CENTRE_MONTH_COLUMNS: CocoaTableColumn<CentreMonthRow>[] = [
  {
    key: "centre",
    label: "Centro",
    render: (row) => (
      <span className="cocoa-stack" data-gap="1">
        <strong>{row.propertyCode ? `${row.propertyName ?? row.propertyId} (${row.propertyCode})` : row.propertyName ?? row.propertyId}</strong>
        {row.workCenterLabels.length > 1 ? <span className="cocoa-caption">{row.workCenterLabels.join(" · ")}</span> : null}
      </span>
    )
  },
  { key: "periodCode", label: "Mes", fit: true, render: (row) => monthLabel(row.periodCode) },
  { key: "lines", label: "Filas", align: "right", hideOnNarrow: true, render: (row) => number(row.lines) },
  { key: "gross", label: "Bruto", align: "right", render: (row) => money(row.gross) },
  { key: "employerSs", label: "SS empresa", align: "right", hideOnNarrow: true, render: (row) => money(row.employerSs) },
  { key: "totalCost", label: "Coste", align: "right", render: (row) => <strong>{money(row.totalCost)}</strong> },
  { key: "headcount", label: "Empleados", align: "right", hideOnNarrow: true, render: (row) => formatHeadcount(row.headcount) },
  { key: "employeesReported", label: "Empleados del informe", align: "right", showFrom: "laptop", render: (row) => formatHeadcount(row.employeesReported) },
  { key: "departments", label: "Departamentos", showFrom: "laptop", render: (row) => row.departments.map(usaliDepartmentLabel).join(" · ") || "—" }
];

const REJECT_FALLBACK = "El fichero no se pudo leer.";

export function PayrollCostImportDrawer({ open, onClose, finance, canManage, onPosted }: PayrollCostImportDrawerProps) {
  const noteId = useId();
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [format, setFormat] = useState<PayrollCostImportFormat>("csv");
  const [centreMap, setCentreMap] = useState<Record<string, string>>({});
  const [departmentMap, setDepartmentMap] = useState<Record<string, string>>({});
  // Labels the API reported without a match (first sight): they stay listed in «2 · Mapeo» even after a
  // suggestion or a choice resolves them, so the user can confirm or change the centre (front-ux-FU-01).
  const [centreLabels, setCentreLabels] = useState<Record<string, PayrollCostUnmappedLabel>>({});
  const [departmentLabels, setDepartmentLabels] = useState<Record<string, PayrollCostUnmappedLabel>>({});
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<PayrollCostImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [result, setResult] = useState<PayrollCostImportCreateResult | null>(null);

  const hasContent = content.trim() !== "";
  const tooLong = content.length > PAYROLL_COST_MAX_BYTES;
  const blockers = previewBlockers(preview);
  const canPreview = hasContent && !tooLong && canManage && !posting;
  const canPost = Boolean(preview?.canPost) && canManage && !posting && !previewing && result === null;
  const centreOptions = centreSelectOptions(finance.structure, finance.active);
  const departmentOptions = usaliLaborDepartmentOptions();

  function resetPreview() {
    setPreview(null);
    setPreviewError(null);
    setPostError(null);
    setResult(null);
  }

  function resetAll() {
    setFileName(null);
    setContent("");
    setFormat("csv");
    setCentreMap({});
    setDepartmentMap({});
    setCentreLabels({});
    setDepartmentLabels({});
    setReplace(false);
    setFileError(null);
    resetPreview();
  }

  // Every opening starts clean (front-ux-FU-04): «Cerrar» after a post, or after an error, must not
  // bring back the previous file, its preview, the green «N asientos» callout or a disabled «Contabilizar».
  useEffect(() => {
    if (open) resetAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on opening only
  }, [open]);

  function updateContent(next: string, name: string | null) {
    setContent(next);
    setFileName(name);
    setFormat(detectImportFormat(name, next));
    setCentreMap({});
    setDepartmentMap({});
    setCentreLabels({});
    setDepartmentLabels({});
    setFileError(null);
    resetPreview();
  }

  async function pickFile(file: File) {
    try {
      const text = await file.text();
      updateContent(text, file.name);
    } catch {
      setFileError(REJECT_FALLBACK);
    }
  }

  async function runPreview(maps: { centres: Record<string, string>; departments: Record<string, string> }, nextReplace: boolean) {
    if (!hasContent || previewing || tooLong || !canManage) return;
    setPreviewing(true);
    setPreviewError(null);
    setPostError(null);
    setResult(null);
    try {
      const centres = { ...maps.centres };
      const departments = { ...maps.departments };
      // Two passes at most: the first preview may report centres without a match whose first suggestion
      // is preselected; the second previews WITH those suggestions so the table, `canPost` and the
      // «Contabilizar» button agree with what the selects show (front-ux-FU-01). The labels stay listed
      // in «2 · Mapeo» so the user confirms or changes each centre (every change previews again).
      for (let pass = 0; pass < 2; pass += 1) {
        const next = await previewPayrollCostImport({ format, content, mapping: buildImportMapping(centres, departments), replace: nextReplace });
        setPreview(next);
        let suggested = false;
        for (const label of next.unmappedCentres) {
          setCentreLabels((current) => (label.label in current ? current : { ...current, [label.label]: label }));
          if (label.label in centres) continue;
          const propertyId = suggestedCentreId(label);
          centres[label.label] = propertyId;
          if (propertyId !== "") suggested = true;
        }
        for (const label of next.unmappedDepartments) {
          setDepartmentLabels((current) => (label.label in current ? current : { ...current, [label.label]: label }));
          if (!(label.label in departments)) departments[label.label] = "";
        }
        setCentreMap(centres);
        setDepartmentMap(departments);
        if (!suggested) break;
      }
    } catch (err) {
      setPreview(null);
      setPreviewError(payrollCostErrorMessage(err, "No se pudo previsualizar el fichero."));
    } finally {
      setPreviewing(false);
    }
  }

  function changeCentre(label: string, propertyId: string) {
    const centres = { ...centreMap, [label]: propertyId };
    setCentreMap(centres);
    if (propertyId !== "") void runPreview({ centres, departments: departmentMap }, replace);
  }

  function changeDepartment(label: string, department: string) {
    const departments = { ...departmentMap, [label]: department };
    setDepartmentMap(departments);
    if (department !== "") void runPreview({ centres: centreMap, departments }, replace);
  }

  function changeReplace(next: boolean) {
    setReplace(next);
    void runPreview({ centres: centreMap, departments: departmentMap }, next);
  }

  async function post() {
    if (!canPost || !preview) return;
    setPosting(true);
    setPostError(null);
    try {
      const posted = await createPayrollCostImport({
        format,
        content,
        mapping: buildImportMapping(centreMap, departmentMap),
        replace,
        fileName: fileName ?? undefined,
        source: importSourceOf(format, content),
        post: true
      });
      setResult(posted);
      onPosted(posted);
    } catch (err) {
      setPostError(payrollCostErrorMessage(err));
    } finally {
      setPosting(false);
    }
  }

  function close() {
    if (posting) return;
    onClose();
  }

  const replaced = preview ? replacedImportsSummary(preview) : [];
  const centreLabelList = Object.values(centreLabels).sort((a, b) => a.label.localeCompare(b.label));
  const departmentLabelList = Object.values(departmentLabels).sort((a, b) => a.label.localeCompare(b.label));
  const needsMapping = preview !== null && (centreLabelList.length > 0 || departmentLabelList.length > 0);
  const conflicts = preview !== null && (preview.duplicateOf !== null || preview.overlaps.length > 0 || preview.payrollPeriodsPosted.length > 0);
  const centreOptionLabel = (propertyId: string): string => centreOptions.find((option) => option.value === propertyId)?.label ?? propertyId;

  return (
    <CocoaDrawer
      open={open}
      onClose={close}
      title="Importar informe de coste de personal"
      subtitle="Informe agregado de RRHH por centro, mes, grupo y departamento: nunca nombres ni datos por persona. Se contabiliza un asiento por centro y mes (640 y 642 por departamento USALI contra 465 y 476)."
      side="right"
      size="lg"
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={close} disabled={posting}>
            {result ? ACTIONS.close : ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={() => void post()} loading={posting} disabled={!canPost} title={blockers.length > 0 ? `No se puede contabilizar: ${blockers.join(", ")}.` : undefined}>
            {posting ? STATUS_LABELS.saving : "Contabilizar"}
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="4">
        {!canManage ? <p className="cocoa-note">Necesitas el permiso de gestión de nóminas para previsualizar y contabilizar una importación: la previsualización también la calcula el servidor. El informe ya contabilizado se consulta en la pestaña.</p> : null}

        <CocoaFormSection title="1 · Fichero o texto" description="CSV con separador «;» (decimales con coma o punto) o el JSON del informe agregado. Cabecera obligatoria.">
          <div className="cocoa-stack" data-gap="3">
            <div className="cocoa-row">
              <CocoaFileInput accept=".csv,.json" maxBytes={1_000_000} fileName={fileName} onPick={(file) => void pickFile(file)} onReject={(message) => setPreviewError(message)} disabled={posting} aria-describedby={noteId} />
              {fileName ? (
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => updateContent("", null)} disabled={posting}>
                  Quitar fichero
                </CocoaButton>
              ) : null}
              <CocoaBadge tone="neutral" size="small">{format === "json" ? "JSON" : "CSV"}</CocoaBadge>
            </div>
            <CocoaField label="…o pega aquí el CSV / JSON" error={tooLong ? "El texto supera el millón de caracteres: carga el informe con la herramienta de línea de comandos." : undefined}>
              <CocoaInput value={content} onChange={(next) => updateContent(next, fileName && next !== content ? null : fileName)} multiline rows={6} placeholder={PAYROLL_COST_CSV_HEADER_NOTE} disabled={posting} aria-describedby={noteId} />
            </CocoaField>
            <p className="cocoa-note" id={noteId}>
              Formato: <span className="cocoa-mono">{PAYROLL_COST_CSV_HEADER_NOTE}</span>. Mes como AAAA-MM o MM/AAAA. Guarda el CSV como UTF-8; los informes de más de 1 MB o en latin1 se cargan con la herramienta de línea de comandos (runbook §18).
            </p>
            <div className="cocoa-row">
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void runPreview({ centres: centreMap, departments: departmentMap }, replace)} loading={previewing} disabled={!canPreview} title={canManage ? undefined : "Necesitas el permiso de gestión de nóminas"}>
                Previsualizar
              </CocoaButton>
              {preview ? <span className="cocoa-caption">Previsualización sin escribir nada: {preview.periodFrom && preview.periodTo ? monthRangeLabel(preview.periodFrom, preview.periodTo) : "sin meses"}</span> : null}
            </div>
            {fileError ? (
              <CocoaCallout tone="danger" title="No se pudo leer el fichero" role="alert">
                {fileError}
              </CocoaCallout>
            ) : null}
            {previewError ? (
              <CocoaCallout tone="danger" title="No se pudo previsualizar" role="alert">
                {previewError}
              </CocoaCallout>
            ) : null}
          </div>
        </CocoaFormSection>

        {preview && needsMapping ? (
          <CocoaFormSection title="2 · Mapeo" description="Etiquetas del informe que el ERP no reconoce. La primera sugerencia ya está aplicada a la previsualización: confírmala o elige otro centro; cada cambio vuelve a previsualizar.">
            <div className="cocoa-stack" data-gap="3">
              {centreLabelList.length > 0 ? (
                <CocoaFormRow columns={2}>
                  {centreLabelList.map((label) => (
                    <CocoaField
                      key={`centre-${label.label}`}
                      label={`Centro «${label.label}»`}
                      hint={plural(label.rows, "fila", "filas")}
                      required
                      help={
                        centreMap[label.label]
                          ? `Aplicado en la previsualización: ${centreOptionLabel(centreMap[label.label]!)}${label.suggestions[0]?.propertyId === centreMap[label.label] ? " (sugerencia del ERP)" : ""}. Cámbialo si no es el centro correcto.`
                          : label.suggestions.length > 0
                            ? `Sugerencia: ${label.suggestions.map((suggestion) => (suggestion.code ? `${suggestion.name} (${suggestion.code})` : suggestion.name)).join(", ")}`
                            : "Sin centro parecido en el ERP: elige uno o dalo de alta en Configuración › Estructura societaria."
                      }
                    >
                      <CocoaSelect value={centreMap[label.label] ?? ""} onChange={(value) => changeCentre(label.label, value)} options={centreOptions} placeholder="Elige un centro de trabajo" disabled={previewing || posting} />
                    </CocoaField>
                  ))}
                </CocoaFormRow>
              ) : null}
              {departmentLabelList.length > 0 ? (
                <CocoaFormRow columns={2}>
                  {departmentLabelList.map((label) => (
                    <CocoaField key={`department-${label.label}`} label={`Departamento «${label.label}»`} hint={plural(label.rows, "fila", "filas")} required>
                      <CocoaSelect value={departmentMap[label.label] ?? ""} onChange={(value) => changeDepartment(label.label, value)} options={departmentOptions} placeholder="Elige un departamento USALI" disabled={previewing || posting} />
                    </CocoaField>
                  ))}
                </CocoaFormRow>
              ) : null}
              {preview.unmappedGroups.length > 0 ? (
                <CocoaCallout tone="warning" title="Grupos de coste sin reconocer">
                  {preview.unmappedGroups.map((label) => label.label).join(", ")}. Usa operaciones, extras, estructura, mantenimiento_obra o familia, o indica la equivalencia en el fichero (mapping.grupos del JSON).
                </CocoaCallout>
              ) : null}
            </div>
          </CocoaFormSection>
        ) : null}

        {preview ? (
          <CocoaFormSection title={needsMapping ? "3 · Vista previa" : "2 · Vista previa"} description="Lo que se contabilizará: una fila por centro y mes = un asiento.">
            <div className="cocoa-stack" data-gap="3">
              <div className="cocoa-cluster">
                <CocoaBadge tone="neutral">{plural(preview.rowCount, "fila", "filas")}</CocoaBadge>
                <CocoaBadge tone="info">{plural(preview.byCentreMonth.length, "centro × mes", "centros × meses")}</CocoaBadge>
                <CocoaBadge tone={preview.errors.length > 0 ? "danger" : "success"}>{plural(preview.errors.length, "error", "errores")}</CocoaBadge>
                <CocoaBadge tone={preview.warnings.length > 0 ? "warning" : "neutral"}>{plural(preview.warnings.length, "aviso", "avisos")}</CocoaBadge>
                {preview.byGroup.map((group) => (
                  <CocoaBadge key={group.costGroup} tone="neutral" variant="tinted" uppercase={false}>
                    {costGroupLabel(group.costGroup)} · {money(group.totalCost)}
                  </CocoaBadge>
                ))}
              </div>
              <div className="cocoa-row">
                <CocoaStat label="Salario bruto" value={money(preview.totals.gross)} />
                <CocoaStat label="Seguridad Social empresa" value={money(preview.totals.employerSs)} />
                <CocoaStat label="Coste a contabilizar" value={money(preview.totals.totalCost)} hint={preview.totals.reportedTotalCost !== null && preview.totals.reportedTotalCost !== preview.totals.totalCost ? `El informe declara ${money(preview.totals.reportedTotalCost)}` : undefined} />
                <CocoaStat label="Empleados medios" value={formatHeadcount(preview.totals.headcountAverage)} />
              </div>
              {preview.byCentreMonth.length > 0 ? <CocoaTable columns={CENTRE_MONTH_COLUMNS} rows={preview.byCentreMonth} rowKey={(row) => `${row.propertyId}:${row.periodCode}`} density="compact" caption="Asientos previstos por centro y mes" aria-label="Asientos previstos por centro y mes" /> : null}
              {preview.errors.length > 0 ? (
                <CocoaCallout tone="danger" title="Filas que no se pueden contabilizar">
                  <ul className="c22-section__list">
                    {preview.errors.map((issue, index) => (
                      <li key={index}>
                        <span>{issue.line !== null ? `Línea ${issue.line}: ${issue.message}` : issue.message}</span>
                      </li>
                    ))}
                  </ul>
                </CocoaCallout>
              ) : null}
              {preview.warnings.length > 0 ? (
                <CocoaCallout tone="warning" title="Avisos">
                  <ul className="c22-section__list">
                    {preview.warnings.map((warning, index) => (
                      <li key={index}>
                        <span>{warning}</span>
                      </li>
                    ))}
                  </ul>
                </CocoaCallout>
              ) : null}
              {conflicts ? (
                <CocoaCallout tone="warning" title={preview.duplicateOf ? "Este informe ya está importado" : preview.overlaps.length > 0 ? "Hay centros y meses ya contabilizados" : "Hay nóminas reales contabilizadas en esos meses"}>
                  <div className="cocoa-stack" data-gap="2">
                    {replaced.length > 0 ? (
                      <>
                        <span>Con «Sustituir» se revierten ENTEROS estos lotes y se contabiliza el nuevo en la misma operación. Reimporta siempre el rango completo:</span>
                        <ul className="c22-section__list">
                          {replaced.map((label) => (
                            <li key={label}>
                              <span>{label}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {preview.payrollPeriodsPosted.length > 0 ? <span>{plural(preview.payrollPeriodsPosted.length, "periodo de nómina real ya contabilizado", "periodos de nómina real ya contabilizados")} en los mismos centros y meses ({preview.payrollPeriodsPosted.map((period) => monthLabel(period.periodCode)).join(", ")}): comprueba que el coste no se devengue dos veces.</span> : null}
                    {replaced.length > 0 ? <CocoaSwitch checked={replace} onChange={changeReplace} label="Sustituir los lotes anteriores (reverso + lote nuevo)" size="small" disabled={previewing || posting || !canManage} /> : null}
                  </div>
                </CocoaCallout>
              ) : null}
              {blockers.length > 0 && result === null ? <p className="cocoa-note">No se puede contabilizar todavía: {blockers.join(", ")}.</p> : null}
            </div>
          </CocoaFormSection>
        ) : null}

        {postError ? (
          <CocoaCallout tone="danger" title="No se pudo contabilizar" role="alert">
            {postError}
          </CocoaCallout>
        ) : null}

        {result ? (
          <CocoaCallout tone="success" title={importResultTitle(result)} role="status">
            <div className="cocoa-stack" data-gap="2">
              <span>
                Lote {result.fileName ?? result.id} · {monthRangeLabel(result.periodFrom, result.periodTo)} · coste {money(result.totalCost)}
                {result.reportedTotalCost !== null && result.reportedTotalCost !== result.totalCost ? ` (el informe declaraba ${money(result.reportedTotalCost)})` : ""}
              </span>
              {result.entries.length > 0 ? (
                <ul className="c22-section__list">
                  {result.entries.map((entry) => (
                    <li key={entry.id}>
                      <span>{entrySummaryLabel(entry)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {result.warnings.length > 0 ? (
                <ul className="c22-section__list">
                  {result.warnings.map((warning, index) => (
                    <li key={index}>
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaDrawer>
  );
}

export default PayrollCostImportDrawer;

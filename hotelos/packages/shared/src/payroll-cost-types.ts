/**
 * Coste de personal importado (Tanda 6c · L0, 2026-09-16): contrato wire entre el
 * API (`apps/api/src/modules/payroll/cost-import.*`, `cost-report.service.ts`, el
 * CLI `payroll:import-cost`) y el admin-web (pestaña «Coste de personal» de Nóminas).
 *
 * Qué es. El informe de RRHH «coste de nómina» llega AGREGADO por centro de trabajo
 * × mes × grupo de coste × departamento: el ERP nunca guarda nombres ni datos por
 * persona (GDPR) y el formato de importación no admite columnas de persona. Un lote
 * (`PayrollCostImport`) = un fichero (csv | json | informe_rrhh) identificado por el
 * sha256 de su contenido normalizado (idempotencia). Al contabilizar produce UN
 * asiento por (centro, mes), `sourceType payroll_cost_import`, `sourceId
 * <importId>:<propertyId>:<periodCode>`, fechado el último día del mes: D 640 (bruto)
 * y D 642 (SS empresa) por departamento USALI con centro de coste
 * (`cost_centers { propertyId, code: USALI en mayúsculas, type "usali" }`), H 465
 * (Σ bruto) y H 476 (Σ SS empresa). El reverso del lote reversa esos asientos y solo
 * esos; los asientos previos del diario nunca se tocan.
 *
 * Convenciones (docs/runbooks/finanzas-contabilidad.md §18):
 *   · Dinero como `MoneyString` ("1234.56", dos decimales, punto): el API calcula con
 *     Prisma.Decimal y nunca expone floats; el front solo formatea.
 *   · Empleados (o FTE) también como cadena de dos decimales (`HeadcountString`,
 *     "12.50"): las jornadas parciales existen.
 *   · Ratios y porcentajes como `RatioString`; `null` con denominador 0, nunca un 0
 *     falso.
 *   · Meses como `periodCode` "YYYY-MM"; fechas contables "YYYY-MM-DD"; instantes
 *     (`…At`) como ISO.
 *   · Se contabiliza SIEMPRE bruto + SS empresa (`totalCost = gross + employerSs`);
 *     el `coste_total` del fichero se conserva como `reportedTotalCost`
 *     (informativo: se avisa si difiere, nunca bloquea).
 *   · Simplificación documentada: devengo del coste empresa, sin IRPF ni SS del
 *     trabajador (el pago y las retenciones se registran aparte por tesorería).
 *
 * Diseño: docs/design/FINANZAS-COSTE-PERSONAL.md §2 (modelo), §5 (API), §6 (formato).
 */

import type { JournalEntryStatus } from "./accounting-types.js";
import type { IsoDate, MoneyString, RatioString, UsaliDepartmentKey } from "./financial-statements-types.js";
import type { PropertyKind } from "./legal-structure-types.js";

/** Empleados o FTE con dos decimales ("12.50"), nunca un float. */
export type HeadcountString = string;

// ---------------------------------------------------------------------------
// Vocabulario (espejo de los valores documentales del runbook §18 y del enum
// Prisma PayrollCostImportStatus)
// ---------------------------------------------------------------------------

/**
 * Grupos de coste del informe de RRHH: `operaciones` (personal de hotel),
 * `extras` (refuerzos), `estructura` (oficinas), `mantenimiento_obra` (equipo de
 * mantenimiento / obra) y `familia` (administradores / propiedad). El grupo vive en
 * las líneas del lote y en el informe, no en el diario (el diario distingue por
 * centro de coste = departamento USALI).
 */
export const PAYROLL_COST_GROUPS = ["operaciones", "extras", "estructura", "mantenimiento_obra", "familia"] as const;
export type PayrollCostGroup = (typeof PAYROLL_COST_GROUPS)[number];

export const PAYROLL_COST_GROUP_LABELS_ES: Record<PayrollCostGroup, string> = {
  operaciones: "Operaciones",
  extras: "Extras",
  estructura: "Estructura",
  mantenimiento_obra: "Mantenimiento y obra",
  familia: "Familia"
};

/** Origen documental del lote: fichero CSV, JSON `{ rows }` o el agregado del informe de RRHH (JSON con `fuente`). */
export const PAYROLL_COST_IMPORT_SOURCES = ["csv", "json", "informe_rrhh"] as const;
export type PayrollCostImportSource = (typeof PAYROLL_COST_IMPORT_SOURCES)[number];

/** Formato del contenido enviado a previsualizar / importar. */
export const PAYROLL_COST_IMPORT_FORMATS = ["csv", "json"] as const;
export type PayrollCostImportFormat = (typeof PAYROLL_COST_IMPORT_FORMATS)[number];

/** Estado del lote (enum Prisma `PayrollCostImportStatus`): draft → posted (asientos) → reversed (reverso completo). */
export type PayrollCostImportStatus = "draft" | "posted" | "reversed";

export const PAYROLL_COST_IMPORT_STATUS_LABELS_ES: Record<PayrollCostImportStatus, string> = {
  draft: "Borrador",
  posted: "Contabilizado",
  reversed: "Revertido"
};

/**
 * Departamentos USALI que admiten la línea `labor` (USALI_DEPARTMENT_LINES del API):
 * los únicos destino posibles de una fila de coste de personal. `utilities`,
 * `misc_income`, `management_fees`, `non_operating` y `below_ebitda` no la admiten
 * (400 USALI_LINE_NOT_ADMITTED).
 */
export type PayrollCostUsaliDepartment = Extract<UsaliDepartmentKey, "rooms" | "fnb" | "other_operated" | "admin_general" | "it" | "sales_marketing" | "pom">;

export const PAYROLL_COST_USALI_DEPARTMENTS: readonly PayrollCostUsaliDepartment[] = ["rooms", "fnb", "other_operated", "admin_general", "it", "sales_marketing", "pom"];

/** Etiquetas en español de los departamentos admitidos (mismas que USALI_DEPARTMENTS del API). */
export const PAYROLL_COST_USALI_DEPARTMENT_LABELS_ES: Record<PayrollCostUsaliDepartment, string> = {
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operados",
  admin_general: "Administración y general",
  it: "Tecnología de la información",
  sales_marketing: "Ventas y marketing",
  pom: "Mantenimiento y operación de la propiedad"
};

/**
 * Formato CSV (runbook §18.2): cabecera obligatoria, separador `;` (o `,` si no hay
 * `;`), decimales con coma o punto, mes `YYYY-MM` o `MM/YYYY`, UTF-8 o latin1 (el
 * CLI decodifica; el navegador entrega UTF-8). Las tres columnas opcionales
 * alimentan `PayrollCostReference` por (centro, mes) y `usali` fija el departamento
 * sin diccionario. Columnas desconocidas → aviso; fila con error → `errors` con nº
 * de línea 1-based.
 */
export const PAYROLL_COST_CSV_COLUMNS = ["centro", "mes", "grupo", "departamento", "salario_bruto", "coste_ss", "coste_total", "empleados"] as const;
export const PAYROLL_COST_CSV_OPTIONAL_COLUMNS = ["ventas_sin_iva", "hab_disponibles", "usali"] as const;
export type PayrollCostCsvColumn = (typeof PAYROLL_COST_CSV_COLUMNS)[number] | (typeof PAYROLL_COST_CSV_OPTIONAL_COLUMNS)[number];
export const PAYROLL_COST_CSV_HEADER = "centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados;ventas_sin_iva;hab_disponibles;usali";

/** Longitud máxima del contenido aceptado por HTTP (caracteres); informes mayores → CLI. */
export const PAYROLL_COST_IMPORT_MAX_CONTENT = 1_000_000;
/** Rango máximo del informe de coste (`GET /payroll/cost-report`), en meses. */
export const PAYROLL_COST_REPORT_MAX_MONTHS = 24;
/**
 * Topes de un lote de importación (corrector 6c · SEC-6C-03): la contabilización es
 * UNA transacción que retiene el lock de numeración del diario del ejercicio hasta el
 * commit, así que el tamaño del lote acota el tiempo que el resto de asientos de la
 * organización esperan. Fuera de tope → 400 PAYROLL_IMPORT_INVALID { errors }.
 */
/** Meses distintos por lote (mismo tope que el informe). */
export const PAYROLL_COST_IMPORT_MAX_MONTHS = 24;
/** Celdas (centro, mes) = asientos por lote (10 centros × 24 meses). */
export const PAYROLL_COST_IMPORT_MAX_CELLS = 240;
/** Filas normalizadas (centro × mes × grupo × departamento) por lote. */
export const PAYROLL_COST_IMPORT_MAX_ROWS = 5000;
/** Etiquetas del fichero (centro, grupo, departamento): longitud máxima en caracteres, sin caracteres de control (SEC-6C-02). */
export const PAYROLL_COST_LABEL_MAX_LENGTH = 200;
/** Importes (bruto, SS, coste total, ventas): máximo admitido, Decimal(14,2) de `payroll_cost_lines`. */
export const PAYROLL_COST_AMOUNT_MAX = "999999999999.99";
/** Empleados por fila o referencia: máximo admitido, Decimal(8,2). */
export const PAYROLL_COST_HEADCOUNT_MAX = "999999.99";
/** Inventario de habitaciones de referencia: máximo admitido (INT4). */
export const PAYROLL_COST_ROOMS_MAX = 2_147_483_647;

// ---------------------------------------------------------------------------
// Mapeo y filas normalizadas (previsualización)
// ---------------------------------------------------------------------------

/**
 * Mapeo que el usuario (o el JSON del informe) aporta para resolver etiquetas. Las
 * claves son etiquetas normalizadas (trim, espacios colapsados, mayúsculas; acentos
 * conservados). Orden de prioridad del resolutor (diseño §6): mapeo explícito →
 * dato del fichero (`centroCode` ≡ `Property.code`, columna `usali`, `mapping.grupos`
 * del JSON) → diccionario / valor canónico.
 */
export type PayrollCostMapping = {
  /** Etiqueta de centro del informe → `propertyId` del ERP (varias etiquetas pueden ir al mismo centro). */
  centres?: Record<string, string>;
  /** Etiqueta de departamento del informe → departamento USALI que admite `labor`. */
  departments?: Record<string, PayrollCostUsaliDepartment>;
  /** Etiqueta de grupo no canónica ("mant-obra") → grupo canónico. */
  groups?: Record<string, PayrollCostGroup>;
};

/**
 * Fila normalizada del fichero (una por celda centro × mes × grupo × departamento;
 * filas con la misma clave se fusionan sumando importes y empleados, con aviso).
 * También es el elemento aceptado en el JSON `{ rows: PayrollCostRowDto[] }`
 * (los campos `null` pueden omitirse en la entrada; `line` es opcional ahí).
 */
export type PayrollCostRowDto = {
  /** Nº de línea 1-based del fichero (cabecera = 1) o índice + 1 en `lineas[]` del JSON; 0 cuando la fila es fruto de una fusión. */
  line: number;
  /** Etiqueta ORIGINAL del centro, normalizada ("OFICINA MADRID", "REG. CORUÑA"…): es parte de la clave natural de la línea. */
  workCenterLabel: string;
  /** `centroCode` del JSON (≡ `Property.code`) cuando viene; null en CSV. */
  workCenterCode: string | null;
  /** Mes "YYYY-MM". */
  periodCode: string;
  /** Grupo tal como viene (normalizado); canónico (`PayrollCostGroup`) tras aplicar el mapeo. */
  costGroup: string;
  /** Departamento tal como viene en el informe ("3 RECEPCIO", "6 PISOS"…). */
  departmentLabel: string;
  /** Departamento USALI fijado por el fichero (columna `usali` / `usaliDepartment`) o resuelto por el mapeo; null si sigue pendiente. */
  usaliDepartment: PayrollCostUsaliDepartment | null;
  /** Salario bruto de la celda. */
  gross: MoneyString;
  /** Seguridad Social a cargo de la empresa. */
  employerSs: MoneyString;
  /** Siempre `gross + employerSs`: lo que se contabiliza. */
  totalCost: MoneyString;
  /** `coste_total` del fichero (informativo; null si no viene). */
  reportedTotalCost: MoneyString | null;
  /** Empleados (o FTE) de la celda en el mes. */
  headcount: HeadcountString;
  /** Columna opcional `ventas_sin_iva` (referencia por centro × mes). */
  netSalesReported: MoneyString | null;
  /** Columna opcional `hab_disponibles`: INVENTARIO de habitaciones del informe (no habitaciones-noche). */
  roomsAvailableReported: number | null;
  /** Empleados del informe por centro × mes (`referencia[].empleadosInforme` del JSON). */
  employeesReported: HeadcountString | null;
};

/** Centro del ERP sugerido para una etiqueta sin mapear (coincidencia parcial de `code` / `name` / `tradeName`). */
export type PayrollCostCentreSuggestion = {
  propertyId: string;
  code: string | null;
  name: string;
  kind: PropertyKind;
};

/** Etiqueta del informe que el resolutor no pudo asignar (centro, departamento o grupo). */
export type PayrollCostUnmappedLabel = {
  label: string;
  /** Filas del fichero que la usan. */
  rows: number;
  /** Solo para centros: candidatos del ERP; vacío si no hay ninguno parecido. */
  suggestions: PayrollCostCentreSuggestion[];
};

/** Error o aviso de parseo referido a una línea del fichero (null cuando afecta al fichero entero). */
export type PayrollCostImportIssue = {
  line: number | null;
  message: string;
};

/** Totales de un conjunto de filas (lote, celda, grupo o departamento). */
export type PayrollCostTotals = {
  /** Filas agregadas. */
  lines: number;
  gross: MoneyString;
  employerSs: MoneyString;
  /** Σ(gross + employerSs). */
  totalCost: MoneyString;
  /** Σ `coste_total` del fichero (null si ninguna fila lo trae). */
  reportedTotalCost: MoneyString | null;
  /** Σ empleados de las filas (sobrecuenta a quien figura en dos grupos: los ratios priman `employeesReported`). */
  headcount: HeadcountString;
};

export type PayrollCostGroupTotals = PayrollCostTotals & { costGroup: PayrollCostGroup };
export type PayrollCostDepartmentTotals = PayrollCostTotals & { usaliDepartment: PayrollCostUsaliDepartment };

/**
 * Celda (centro, mes) del lote: una por asiento previsto / contabilizado. Varias
 * etiquetas del informe (OFICINA ASTURIAS / OFICINA MADRID / REG. CORUÑA → OC) se
 * agregan en la misma celda conservando las etiquetas en `workCenterLabels`.
 */
export type PayrollCostCentreMonthDto = PayrollCostTotals & {
  propertyId: string;
  propertyCode: string | null;
  propertyName: string | null;
  workCenterLabels: string[];
  periodCode: string;
  /** Empleados del informe para el centro × mes (referencia), si vienen. */
  employeesReported: HeadcountString | null;
  /** Departamentos USALI presentes (parejas D 640 / D 642 del asiento). */
  departments: PayrollCostUsaliDepartment[];
  byGroup: PayrollCostGroupTotals[];
  byDepartment: PayrollCostDepartmentTotals[];
};

/** Lote vivo con el mismo contenido (409 PAYROLL_IMPORT_DUPLICATE sin `replace`). */
export type PayrollCostDuplicateRef = {
  importId: string;
  status: PayrollCostImportStatus;
  fileName: string | null;
  postedAt: string | null;
  periodFrom: string;
  periodTo: string;
};

/** Celda ya contabilizada por otro lote (409 PAYROLL_IMPORT_OVERLAP sin `replace`; con `replace` el lote se revierte ENTERO). */
export type PayrollCostOverlapRef = {
  importId: string;
  fileName: string | null;
  periodFrom: string;
  periodTo: string;
  propertyId: string;
  periodCode: string;
};

/** Periodo de nómina real ya contabilizado para el mismo centro × mes (aviso: no devengar dos veces). */
export type PayrollCostPayrollPeriodRef = {
  periodId: string;
  propertyId: string | null;
  periodCode: string;
};

/** Respuesta de `POST /payroll/cost-imports/preview` (nunca escribe). */
export type PayrollCostImportPreview = {
  organizationId: string;
  format: PayrollCostImportFormat;
  /** sha256 hex del contenido normalizado (filas + referencias): el mismo para CSV y JSON equivalentes. */
  contentHash: string;
  periodFrom: string | null;
  periodTo: string | null;
  rowCount: number;
  /** Filas normalizadas tras el mapeo (para la tabla de previsualización y el CLI). */
  rows: PayrollCostRowDto[];
  totals: PayrollCostTotals & {
    /** Media de los meses con dato (referencia del informe o Σ headcount de las celdas), 2 decimales; null sin datos. */
    headcountAverage: HeadcountString | null;
  };
  byCentreMonth: PayrollCostCentreMonthDto[];
  byGroup: PayrollCostGroupTotals[];
  byDepartment: PayrollCostDepartmentTotals[];
  /** Mapeo efectivo aplicado (explícito + resuelto): el que se guardará en `mappingJson` al importar. */
  mapping: PayrollCostMapping;
  unmappedCentres: PayrollCostUnmappedLabel[];
  unmappedDepartments: PayrollCostUnmappedLabel[];
  unmappedGroups: PayrollCostUnmappedLabel[];
  duplicateOf: PayrollCostDuplicateRef | null;
  overlaps: PayrollCostOverlapRef[];
  payrollPeriodsPosted: PayrollCostPayrollPeriodRef[];
  /** Con `replace: true`, lotes que se revertirían ENTEROS (duplicado + solapes, sin repetir). */
  replacedImportIds: string[];
  errors: PayrollCostImportIssue[];
  /** Discrepancias de `coste_total`, filas fusionadas, columnas desconocidas… (texto en español). */
  warnings: string[];
  /** `replace` solicitado en la petición. */
  replace: boolean;
  /** Sin errores ∧ sin pendientes de mapeo ∧ (sin duplicado ni solapes ∨ replace). */
  canPost: boolean;
};

// ---------------------------------------------------------------------------
// Lote, líneas, referencias y asientos
// ---------------------------------------------------------------------------

/** Asiento del lote (devengo o reverso) tal como lo devuelven create / post / detail. */
export type PayrollCostImportEntryDto = {
  id: string;
  /** `entry` = devengo (D 640 / D 642 / H 465 / H 476); `reversal` = reverso del lote. */
  kind: "entry" | "reversal";
  propertyId: string;
  propertyCode: string | null;
  periodCode: string;
  /** Fecha contable: último día del mes (devengo) o la del reverso. */
  entryDate: IsoDate;
  entryNumber: number | null;
  fiscalYearCode: string | null;
  status: JournalEntryStatus;
  /** `<importId>:<propertyId>:<periodCode>` (devengo) o `reversal:<id>` (reverso). */
  sourceId: string;
  description: string | null;
  totalDebit: MoneyString;
  /** false solo cuando el puente encontró un asiento previo con el mismo sourceId (idempotencia; el servicio lo trata como 409 PAYROLL_IMPORT_ENTRY_EXISTS). */
  created: boolean;
  reversalOfId: string | null;
  reversedById: string | null;
};

/** Fila agregada guardada (`payroll_cost_lines`). */
export type PayrollCostLineDto = {
  id: string;
  importId: string;
  organizationId: string;
  propertyId: string;
  propertyCode: string | null;
  workCenterLabel: string;
  costGroup: PayrollCostGroup;
  departmentLabel: string;
  usaliDepartment: PayrollCostUsaliDepartment;
  /** CostCenter `usali` del centro al que se imputaron 640/642; null mientras el lote es borrador. */
  costCenterId: string | null;
  costCenterCode: string | null;
  periodCode: string;
  gross: MoneyString;
  employerSs: MoneyString;
  totalCost: MoneyString;
  reportedTotalCost: MoneyString | null;
  headcount: HeadcountString;
};

/** Referencia del informe por centro × mes (`payroll_cost_references`). */
export type PayrollCostReferenceDto = {
  id: string;
  importId: string;
  organizationId: string;
  propertyId: string;
  propertyCode: string | null;
  workCenterLabel: string | null;
  periodCode: string;
  employeesReported: HeadcountString | null;
  /** Inventario de habitaciones del informe (no habitaciones-noche). */
  roomsAvailableReported: number | null;
  netSalesReported: MoneyString | null;
};

/** Lote tal como lo devuelven el listado, el reverso y (ampliado) el detalle. */
export type PayrollCostImportRecord = {
  id: string;
  organizationId: string;
  /** Sociedad empleadora (`resolveLedgerScope`); null en tenants sin sociedad. */
  legalEntityId: string | null;
  source: PayrollCostImportSource;
  fileName: string | null;
  contentHash: string;
  periodFrom: string;
  periodTo: string;
  status: PayrollCostImportStatus;
  rowCount: number;
  totalGross: MoneyString;
  totalEmployerSs: MoneyString;
  /** Σ(gross + employerSs): lo contabilizado en 640 + 642. */
  totalCost: MoneyString;
  reportedTotalCost: MoneyString | null;
  headcountAverage: HeadcountString | null;
  /** Mapeo aplicado al importar (`mappingJson`). */
  mapping: PayrollCostMapping;
  /** Centros del ERP que toca el lote (visible / actuable solo si TODOS están en el ámbito del usuario). */
  propertyIds: string[];
  /** Nº de celdas (centro, mes) = asientos de devengo previstos. */
  centreMonths: number;
  journalEntryIds: string[];
  reversalJournalEntryIds: string[];
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  postedAt: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reversalReason: string | null;
  /** Solo en la respuesta del reverso: true cuando el lote ya estaba revertido (idempotente, nada escrito). */
  alreadyReversed?: boolean;
};

/** `GET /payroll/cost-imports/:id`: lote + líneas + referencias + asientos y reversos. */
export type PayrollCostImportDetail = PayrollCostImportRecord & {
  lines: PayrollCostLineDto[];
  references: PayrollCostReferenceDto[];
  byCentreMonth: PayrollCostCentreMonthDto[];
  /** Asientos de devengo (`journalEntryIds`) con número, ejercicio, estado y total. */
  entries: PayrollCostImportEntryDto[];
  /** Reversos (`reversalJournalEntryIds`). */
  reversals: PayrollCostImportEntryDto[];
};

/** `POST /payroll/cost-imports` (201) y `POST /payroll/cost-imports/:id/post` (200): el lote más lo contabilizado. */
export type PayrollCostImportCreateResult = PayrollCostImportRecord & {
  entries: PayrollCostImportEntryDto[];
  /** Lotes revertidos ENTEROS por `replace: true` (vacío sin sustitución). */
  replacedImportIds: string[];
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Cuerpos y consultas de las rutas
// ---------------------------------------------------------------------------

/** `POST /payroll/cost-imports/preview`. */
export type PayrollCostImportPreviewBody = {
  organizationId?: string;
  format: PayrollCostImportFormat;
  /** Texto del fichero (≤ PAYROLL_COST_IMPORT_MAX_CONTENT caracteres). */
  content: string;
  mapping?: PayrollCostMapping;
  replace?: boolean;
};

/** `POST /payroll/cost-imports`: previsualización + datos del lote. */
export type PayrollCostImportCreateBody = PayrollCostImportPreviewBody & {
  fileName?: string;
  source?: PayrollCostImportSource;
  /** Contabilizar en la misma transacción (por defecto true); false deja el lote en borrador. */
  post?: boolean;
  notes?: string;
};

/** `POST /payroll/cost-imports/:id/post`. */
export type PayrollCostImportPostBody = {
  replace?: boolean;
};

/** `POST /payroll/cost-imports/:id/reverse` (espejo de `ReverseJournalEntryInput`). */
export type PayrollCostImportReverseBody = {
  /** Motivo obligatorio (3..500 caracteres): va a la descripción de cada reverso. */
  reason: string;
  /**
   * Fecha contable del reverso; por defecto la de cada asiento. El periodo del asiento
   * ORIGINAL debe estar abierto aunque se indique otra fecha (409 FISCAL_PERIOD_CLOSED /
   * FISCAL_YEAR_CLOSED): la regla de lectura de los estados excluye la pareja marcada
   * entera, así que un reverso fechado fuera del periodo cerrado alteraría ese periodo
   * (corrector 6c · contable-6C-02). Mes cerrado a posteriori → reabrirlo antes.
   */
  entryDate?: IsoDate;
};

/** `GET /payroll/cost-imports`. */
export type PayrollCostImportListQuery = {
  organizationId?: string;
  status?: PayrollCostImportStatus;
  /** Solape con [periodFrom, periodTo] del lote ("YYYY-MM"). */
  from?: string;
  to?: string;
  /** 1..200. */
  limit?: number;
};

/** `GET /payroll/cost-report`. */
export type PayrollCostReportQuery = {
  /** "YYYY-MM", `to ≥ from`, ≤ PAYROLL_COST_REPORT_MAX_MONTHS meses. */
  from: string;
  to: string;
  /** Sin centro = toda la sociedad (exige `accounting.entity.read` o contexto sin asignaciones). */
  propertyId?: string;
  /** Filtra solo las líneas de coste; ventas y referencia no se filtran. */
  group?: PayrollCostGroup;
};

// ---------------------------------------------------------------------------
// Informe de coste de personal (centros × meses)
// ---------------------------------------------------------------------------

/** De dónde sale el headcount de una celda: referencia del informe (`employeesReported`) o Σ empleados de las filas. */
export type PayrollCostHeadcountSource = "reference" | "lines";

/** De dónde salen las ventas usadas en un ratio o gráfico: libro mayor (grupo 70) o referencia del informe. */
export type PayrollCostSalesSource = "ledger" | "reference";

/**
 * Cobertura mínima del libro (corrector 6c · contable-6C-03): el libro mayor es la
 * fuente principal de ventas de una celda o agregado solo cuando tiene ventas y, si
 * existe referencia del informe, alcanza al menos esta fracción de ella. Con menos
 * cobertura (facturación aún no cargada en el ERP) la fuente principal es la
 * referencia; `laborPctLedger` y `laborPctReference` se calculan siempre por separado.
 */
export const PAYROLL_COST_LEDGER_COVERAGE_MIN = "0.9";

/** Métricas derivadas comunes a celda, centro y sociedad (calculadas en servidor; el front solo formatea). */
export type PayrollCostReportMetrics = PayrollCostTotals & {
  /** Empleados del informe (referencia) si existen. */
  employeesReported: HeadcountString | null;
  /** `employeesReported ?? headcount` de las filas (media mensual en agregados); null sin datos. */
  headcountEffective: HeadcountString | null;
  headcountSource: PayrollCostHeadcountSource | null;
  /** totalCost / headcountEffective. */
  costPerEmployee: MoneyString | null;
  /** Ventas netas del libro mayor (cuentas 70x del centro y mes: sin borradores, reversados ni reversos, sin regularización / cierre / apertura). */
  ledgerNetSales: MoneyString;
  /** Ventas sin IVA del informe (referencia). */
  netSalesReported: MoneyString | null;
  /** totalCost / ledgerNetSales. */
  laborPctLedger: RatioString | null;
  /** totalCost / netSalesReported. */
  laborPctReference: RatioString | null;
  /**
   * Fuente principal de ventas (regla de cobertura PAYROLL_COST_LEDGER_COVERAGE_MIN):
   * `ledger` cuando el libro cubre el periodo, `reference` cuando solo cubre el informe,
   * null sin ventas. El front pinta el `laborPct*` de esta fuente.
   */
  salesSource: PayrollCostSalesSource | null;
  /** Habitaciones activas del ERP (`room.count`, hoteles); 0 en oficinas. */
  roomsInventory: number;
  /** Inventario de habitaciones del informe, si viene. */
  roomsInventoryReported: number | null;
  /** (roomsInventoryReported ?? roomsInventory) × días del mes (Σ en agregados). */
  roomsAvailable: number;
  /** totalCost / roomsAvailable. */
  costPerAvailableRoom: MoneyString | null;
  byGroup: PayrollCostGroupTotals[];
  byDepartment: PayrollCostDepartmentTotals[];
};

/** Celda centro × mes del informe. */
export type PayrollCostReportCell = PayrollCostReportMetrics & {
  propertyId: string;
  periodCode: string;
  daysInMonth: number;
  /** Lotes `posted` que alimentan la celda. */
  importIds: string[];
};

/** Fila de centro del informe (matriz centros × meses) con sus celdas y el total del rango. */
export type PayrollCostReportCentre = {
  propertyId: string;
  code: string | null;
  name: string;
  kind: PropertyKind;
  /** Una celda por mes del rango (sin datos → totales a "0.00" y ratios null). */
  cells: PayrollCostReportCell[];
  totals: PayrollCostReportMetrics;
};

/** Columna de mes del informe (gráficos «coste por mes» y «ventas por mes»). */
export type PayrollCostReportMonth = PayrollCostReportMetrics & {
  periodCode: string;
  /** Ventas usadas en el gráfico: la fuente principal de la columna (misma regla de cobertura que las métricas). */
  salesSource: PayrollCostSalesSource | null;
};

/** `GET /payroll/cost-report`. */
export type PayrollCostReport = {
  organizationId: string;
  legalEntityId: string | null;
  /** "YYYY-MM" inclusivo. */
  period: { from: string; to: string };
  /** Meses del rango en orden. */
  months: string[];
  /** Centro filtrado o null (toda la sociedad). */
  propertyId: string | null;
  /** Grupo filtrado o null (todos). */
  group: PayrollCostGroup | null;
  centres: PayrollCostReportCentre[];
  byMonth: PayrollCostReportMonth[];
  /** Totales de la sociedad (o del centro filtrado) en el rango. */
  totals: PayrollCostReportMetrics & {
    /** Media mensual de empleados (meses con dato). */
    headcountAverage: HeadcountString | null;
    /** totalCost / headcountAverage: coste ACUMULADO del rango por empleado medio (no una media mensual; front-ux-FU-03). */
    costPerEmployeeAverage: MoneyString | null;
  };
  /** Lotes `posted` que alimentan el informe. */
  imports: Array<{ importId: string; fileName: string | null; periodFrom: string; periodTo: string; postedAt: string | null }>;
  generatedAt: string;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Errores de dominio (`details.code`, mensajes en español)
// ---------------------------------------------------------------------------

/** Códigos con los que responden las rutas `/payroll/cost-imports*` y `/payroll/cost-report` (diseño §5.1). */
export const PAYROLL_COST_ERROR_CODES = [
  /** 400 · issues zod: clave desconocida, formato inválido, rango > 24 meses, motivo corto. */
  "VALIDATION_ERROR",
  /** 400 · `{ errors: [{ line, message }] }`: cabecera, mes, importes negativos o no numéricos. */
  "PAYROLL_IMPORT_INVALID",
  /** 400 · sin líneas de coste (o todas a 0). */
  "PAYROLL_IMPORT_EMPTY",
  /** 400 · `{ labels }`: grupo fuera de los 5 canónicos y sin mapeo. */
  "PAYROLL_IMPORT_GROUP_INVALID",
  /** 400 · `organizationId` del JSON ≠ organización. */
  "PAYROLL_IMPORT_ORGANIZATION_MISMATCH",
  /** 400 · `{ labels, rows }`: etiqueta de centro sin Property (la preview no lanza: `unmappedCentres`). */
  "PAYROLL_IMPORT_CENTRE_UNMAPPED",
  /** 400 · `{ labels }`: etiqueta de departamento sin USALI. */
  "PAYROLL_IMPORT_DEPARTMENT_UNMAPPED",
  /** 400 · `{ department }`: departamento que no admite la línea `labor`. */
  "USALI_LINE_NOT_ADMITTED",
  /** 404 opaco · centro de otra organización. */
  "PROPERTY_NOT_FOUND",
  /** 404 opaco · centro fuera del ámbito del usuario (R11) o informe de toda la sociedad sin `accounting.entity.read`. */
  "ENTITY_SCOPE_REQUIRED",
  /** 404 opaco · lote inexistente o de otra organización. */
  "PAYROLL_IMPORT_NOT_FOUND",
  /** 409 · `{ importId, status, fileName, postedAt }`: mismo hash vivo sin `replace`. */
  "PAYROLL_IMPORT_DUPLICATE",
  /** 409 · `{ overlaps }`: celda (centro, mes) ya contabilizada por otro lote sin `replace`. */
  "PAYROLL_IMPORT_OVERLAP",
  /** 409 · `post` sobre un lote ya contabilizado. */
  "PAYROLL_IMPORT_ALREADY_POSTED",
  /** 409 · `post` sobre un lote revertido. */
  "PAYROLL_IMPORT_REVERSED",
  /** 409 · `{ sourceId }`: el puente devolvió `created: false` (defensivo). */
  "PAYROLL_IMPORT_ENTRY_EXISTS",
  /** 400 · reverso sin motivo. */
  "JOURNAL_REVERSAL_REASON_REQUIRED",
  /** 409 · del motor contable: mes cerrado (rollback completo del lote). */
  "FISCAL_PERIOD_CLOSED",
  /** 409 · del motor contable: ejercicio cerrado (rollback completo del lote). */
  "FISCAL_YEAR_CLOSED"
] as const;
export type PayrollCostErrorCode = (typeof PAYROLL_COST_ERROR_CODES)[number];

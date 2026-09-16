// Plan de cuentas — Finanzas › Contabilidad › Plan de cuentas
// (/finanzas/contabilidad/plan-de-cuentas, hosted in ContabilidadTabs).
// Cocoa 22 · lote 6-C, archetype «lista / tabla».
//
// GET /accounting/chart paints the «PGC Pymes hotelero» tree ordered by code:
// groups → subgroups → accounts → sub-accounts (indent by `level`, header rows
// with `isPostable = false` in a neutral tone), with the PGC nature, the USALI
// department/line and the postable flag. Toolbar: search by code or name,
// group 1-7, «solo imputables». Actions: «Nueva cuenta» (drawer → POST
// /accounting/chart, accounting.configure) and, from a row, edit name /
// postable / USALI (PATCH /accounting/chart/:code) or open its Mayor. The
// USALI vocabularies (labels in Spanish) come from GET /accounting/usali/mappings
// when the drawer opens; without them the USALI fields stay read-only.
// 409 CHART_NOT_PROVISIONED → error state with the provisioning hint.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ChartAccountCreateInput, ChartAccountPatchInput, ChartAccountView } from "@hotelos/shared";
import { accountingErrorMessage, createChartAccount, listChartAccounts, patchChartAccount } from "../../services/accountingApi";
import { getUsaliMappings, type UsaliMappingsResponse } from "../../services/financialStatementsApi";
import { financeErrorCode } from "../../services/finance-contracts";
import { useNavGate } from "../../navigation/useEnabledModules";
import { urlForScreen } from "../../navigation/nav-tree";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { number, plural } from "../../lib/format";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaSelectOption,
  type CocoaTableColumn
} from "../../components/cocoa";
import { KIND_OPTIONS, PGC_GROUP_OPTIONS, canDo, kindLabel, kindTone, withQuery } from "./accounting-ui";

const CODE_PATTERN = /^[1-9][0-9]{0,7}(\.[0-9]{1,3})?$/;

const codeStyle: CSSProperties = { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

function levelLabel(level: number): string {
  switch (level) {
    case 1:
      return "Grupo";
    case 2:
      return "Subgrupo";
    case 3:
      return "Cuenta";
    default:
      return "Subcuenta";
  }
}

function usaliLabel(account: ChartAccountView, vocab: UsaliMappingsResponse | null): string {
  if (!account.usaliDepartment && !account.usaliLine) return "—";
  const department = vocab?.departments.find((d) => d.key === account.usaliDepartment)?.label ?? account.usaliDepartment ?? "";
  const line = vocab?.lines.find((l) => l.key === account.usaliLine)?.label ?? account.usaliLine ?? "";
  return [department, line].filter(Boolean).join(" · ");
}

// Indent by hierarchy level (grupo 0 · subgrupo 1 · cuenta 2 · subcuenta 3) with
// non-breaking spaces so the tree reads without a layout style per row.
function indentedCode(account: ChartAccountView): string {
  return `${"   ".repeat(Math.max(0, account.level - 1))}${account.code}`;
}

function buildColumns(vocab: UsaliMappingsResponse | null): CocoaTableColumn<ChartAccountView>[] {
  return [
    {
      key: "code",
      label: "Código",
      width: "16ch",
      render: (account) => (account.isPostable ? <span style={codeStyle}>{indentedCode(account)}</span> : <strong style={codeStyle}>{indentedCode(account)}</strong>)
    },
    {
      key: "name",
      label: "Nombre",
      render: (account) => (
        <>
          <span>{account.name}</span>
          <span style={subStyle}>
            {levelLabel(account.level)}
            {account.parentCode ? ` · cabecera ${account.parentCode}` : ""}
          </span>
        </>
      )
    },
    { key: "kind", label: "Naturaleza", render: (account) => <CocoaBadge tone={kindTone(account.kind)}>{kindLabel(account.kind)}</CocoaBadge>, hideOnNarrow: true },
    { key: "usali", label: "USALI", render: (account) => usaliLabel(account, vocab), hideOnNarrow: true },
    {
      key: "isPostable",
      label: "Imputable",
      render: (account) => (account.isPostable ? <CocoaBadge tone="success">Imputable</CocoaBadge> : <CocoaBadge tone="neutral">Cabecera</CocoaBadge>)
    }
  ];
}

type Draft = { code: string; name: string; kind: string; isPostable: boolean; usaliDepartment: string; usaliLine: string };

const EMPTY_DRAFT: Draft = { code: "", name: "", kind: "", isPostable: true, usaliDepartment: "", usaliLine: "" };

function draftOf(account: ChartAccountView): Draft {
  return { code: account.code, name: account.name, kind: account.kind, isPostable: account.isPostable, usaliDepartment: account.usaliDepartment ?? "", usaliLine: account.usaliLine ?? "" };
}

export function ChartOfAccountsScreen() {
  const header = treeHeaderFor("ChartOfAccountsScreen", { eyebrow: "Finanzas · Contabilidad", title: "Plan de cuentas" });
  const { showToast } = useToast();
  // Tanda 6b · L7: one chart per sociedad (R1) — forced scope, painted disabled in a multi-centre sociedad.
  const finance = useFinanceScope(financeScopePolicy("ChartOfAccountsScreen"));
  const gate = useNavGate();
  const canConfigure = canDo(gate, "accounting.configure");

  // ---- chart ------------------------------------------------------------------
  const [accounts, setAccounts] = useState<ChartAccountView[]>([]);
  const [template, setTemplate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    listChartAccounts()
      .then((response) => {
        if (!mounted) return;
        setAccounts(response.accounts);
        setTemplate(response.chartTemplate);
      })
      .catch((err: unknown) => {
        if (mounted) setError(err);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [nonce]);

  // ---- USALI vocabularies (lazy: only when editing) -----------------------------
  const [vocab, setVocab] = useState<UsaliMappingsResponse | null>(null);
  const [vocabError, setVocabError] = useState<unknown>(null);
  function ensureVocab() {
    if (vocab || vocabError) return;
    getUsaliMappings()
      .then(setVocab)
      .catch((err: unknown) => setVocabError(err));
  }
  const columns = useMemo(() => buildColumns(vocab), [vocab]);

  // ---- filters ------------------------------------------------------------------
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [postableOnly, setPostableOnly] = useState(false);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return [...accounts]
      .sort((a, b) => a.code.localeCompare(b.code, "es"))
      .filter((account) => (group ? String(account.group) === group : true))
      .filter((account) => (postableOnly ? account.isPostable : true))
      .filter((account) => (needle ? `${account.code} ${account.name}`.toLowerCase().includes(needle) : true));
  }, [accounts, search, group, postableOnly]);

  const postableCount = useMemo(() => accounts.filter((account) => account.isPostable).length, [accounts]);
  const filtered = search.trim() !== "" || group !== "" || postableOnly;

  // ---- drawer (create / edit) ---------------------------------------------------
  const [editing, setEditing] = useState<ChartAccountView | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setTouched(false);
    setDrawerOpen(true);
    ensureVocab();
  }

  function openEdit(account: ChartAccountView) {
    setEditing(account);
    setDraft(draftOf(account));
    setSaveError(null);
    setTouched(false);
    setDrawerOpen(true);
    ensureVocab();
  }

  const parentOfDraft = useMemo(() => {
    if (editing || !CODE_PATTERN.test(draft.code)) return null;
    // Longest existing prefix (the API inherits the nature from it).
    const base = draft.code.replace(".", "");
    let best: ChartAccountView | null = null;
    for (const account of accounts) {
      const candidate = account.code.replace(".", "");
      if (candidate !== base && base.startsWith(candidate) && (!best || candidate.length > best.code.replace(".", "").length)) best = account;
    }
    return best;
  }, [accounts, draft.code, editing]);

  const draftErrors = {
    code: editing ? undefined : draft.code.trim() === "" ? "Indica el código." : !CODE_PATTERN.test(draft.code.trim()) ? "Código PGC: de 1 a 8 dígitos, con una subcuenta opcional tras el punto (705.1)." : accounts.some((account) => account.code === draft.code.trim()) ? "Ya existe una cuenta con ese código." : undefined,
    name: draft.name.trim().length < 2 ? "El nombre necesita al menos dos caracteres." : undefined,
    kind: !editing && !parentOfDraft && !draft.kind ? "Sin cabecera en el plan, indica la naturaleza de la cuenta." : undefined,
    usali: (draft.usaliDepartment && !draft.usaliLine) || (!draft.usaliDepartment && draft.usaliLine) ? "Departamento y línea USALI van juntos." : undefined
  };
  const draftValid = !draftErrors.code && !draftErrors.name && !draftErrors.kind && !draftErrors.usali;

  async function save() {
    setTouched(true);
    if (!draftValid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const usali = draft.usaliDepartment ? { usaliDepartment: draft.usaliDepartment, usaliLine: draft.usaliLine } : { usaliDepartment: null, usaliLine: null };
      if (editing) {
        const body: ChartAccountPatchInput = { name: draft.name.trim(), isPostable: draft.isPostable, ...usali };
        const updated = await patchChartAccount(editing.code, body);
        setAccounts((current) => current.map((account) => (account.code === updated.code ? updated : account)));
        showToast(`Cuenta ${updated.code} actualizada.`, { variant: "success" });
      } else {
        const body: ChartAccountCreateInput = { code: draft.code.trim(), name: draft.name.trim(), isPostable: draft.isPostable, ...(draft.kind ? { kind: draft.kind as ChartAccountCreateInput["kind"] } : {}), ...usali };
        const created = await createChartAccount(body);
        setAccounts((current) => [...current, created]);
        showToast(`Cuenta ${created.code} creada.`, { variant: "success" });
      }
      setDrawerOpen(false);
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  const departmentOptions: CocoaSelectOption[] = useMemo(() => (vocab ? vocab.departments.map((d) => ({ value: d.key, label: d.label })) : []), [vocab]);
  const lineOptions: CocoaSelectOption[] = useMemo(() => {
    if (!vocab) return [];
    const department = vocab.departments.find((d) => d.key === draft.usaliDepartment);
    const allowed = department ? new Set<string>(department.lines) : null;
    return vocab.lines.filter((line) => !allowed || allowed.has(line.key)).map((line) => ({ value: line.key, label: line.label }));
  }, [vocab, draft.usaliDepartment]);

  const ledgerUrl = urlForScreen("LedgerScreen");
  const settingsUrl = urlForScreen("AccountingSettingsScreen");
  const chartMissing = financeErrorCode(error) === "CHART_NOT_PROVISIONED";
  const ready = !loading && !error && rows.length > 0;

  let body;
  if (loading && accounts.length === 0) {
    body = <CocoaTable columns={columns} rows={[]} loading aria-label="Plan de cuentas" />;
  } else if (error) {
    body = (
      <CocoaState
        kind="error"
        title={chartMissing ? "Sin plan de cuentas" : "No se pudo cargar el plan de cuentas"}
        message={accountingErrorMessage(error)}
        onRetry={() => setNonce((n) => n + 1)}
        secondaryAction={chartMissing && settingsUrl ? { label: "Ir a Ajustes", onClick: () => openTabPath(settingsUrl) } : undefined}
      />
    );
  } else if (rows.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration="search"
        title={STATUS_LABELS.noResults}
        message="Ninguna cuenta coincide con la búsqueda o los filtros."
        primaryAction={{
          label: ACTIONS.clearFilters,
          onClick: () => {
            setSearch("");
            setGroup("");
            setPostableOnly(false);
          }
        }}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={columns}
        rows={rows}
        rowKey="code"
        density="compact"
        selectedKey={editing?.code}
        onSelect={canConfigure ? openEdit : undefined}
        rowActions={(account) => (
          <>
            {ledgerUrl && account.isPostable ? (
              <CocoaButton
                variant="plain"
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  openTabPath(withQuery(ledgerUrl, { cuenta: account.code }));
                }}
              >
                Ver mayor
              </CocoaButton>
            ) : null}
            {canConfigure ? (
              <CocoaButton
                variant="plain"
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  openEdit(account);
                }}
              >
                {ACTIONS.edit}
              </CocoaButton>
            ) : null}
          </>
        )}
        caption="Plan de cuentas"
        aria-label="Plan de cuentas"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title={header.title}
      subtitle="Cuentas del PGC de Pymes con las subcuentas hoteleras, un solo plan para toda la sociedad: solo las imputables admiten apuntes; cada cuenta de resultados lleva su departamento y línea USALI."
      actions={
        <>
          <FinanceScopeSelector scope={finance} />
          {canConfigure ? (
            <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon size={14} aria-hidden="true" />} onClick={openCreate} disabled={loading || !!error}>
              Nueva cuenta
            </CocoaButton>
          ) : null}
        </>
      }
      commands={[
        ...(canConfigure ? [{ id: "chart-new-account", label: "Nueva cuenta del plan", run: openCreate }] : []),
        { id: "chart-refresh", label: "Actualizar el plan de cuentas", run: () => setNonce((n) => n + 1) }
      ]}
      id="chart-of-accounts-screen"
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Filtros del plan de cuentas"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaSearchInput value={search} onChange={setSearch} placeholder="Código o nombre…" aria-label="Buscar cuentas por código o nombre" />
            <CocoaSelect value={group} onChange={setGroup} options={[...PGC_GROUP_OPTIONS]} placeholder="Todos los grupos" size="small" aria-label="Filtrar por grupo del PGC" />
            <CocoaField label="Solo imputables" inline>
              <CocoaSwitch checked={postableOnly} onChange={setPostableOnly} size="small" />
            </CocoaField>
          </div>
        }
        rightSlot={
          !loading && !error ? (
            <div className="cocoa-cluster">
              <CocoaBadge tone="neutral" uppercase={false}>
                {plural(accounts.length, "cuenta", "cuentas")} · {number(postableCount)} imputables
              </CocoaBadge>
              {template ? (
                <CocoaBadge tone="accent" uppercase={false}>
                  {template === "pgc_pymes_hotelero_v1" ? "Plantilla PGC Pymes hotelero" : `Plantilla ${template}`}
                </CocoaBadge>
              ) : (
                <CocoaBadge tone="warning">Sin plantilla</CocoaBadge>
              )}
            </div>
          ) : undefined
        }
      />

      <CocoaSection
        padding={ready ? "none" : "md"}
        footer={ready ? <span>{filtered ? `${number(rows.length)} de ${number(accounts.length)} cuentas` : plural(accounts.length, "cuenta", "cuentas")}</span> : undefined}
        style={{ overflow: "clip" }}
        aria-label="Cuentas del plan"
      >
        {body}
      </CocoaSection>

      <CocoaDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={editing ? `Cuenta ${editing.code}` : "Nueva cuenta"}
        subtitle={editing ? `${levelLabel(editing.level)} · ${kindLabel(editing.kind)}${editing.parentCode ? ` · cabecera ${editing.parentCode}` : ""}` : "El código fija la posición en el plan; la naturaleza se hereda de su cabecera."}
        side="right"
        size="md"
        focusKey={drawerOpen}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setDrawerOpen(false)} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" loading={saving} disabled={saving || (touched && !draftValid)} onClick={() => void save()}>
              {editing ? ACTIONS.saveChanges : "Crear cuenta"}
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          <CocoaFormRow columns={2}>
            <CocoaField label="Código" required error={touched ? draftErrors.code : undefined} help={editing ? "El código no se cambia: crea otra cuenta si hace falta." : parentOfDraft ? `Cabecera: ${parentOfDraft.code} · ${parentOfDraft.name}` : "Grupo, subgrupo, cuenta o subcuenta (4300, 705.1, 477.21)."}>
              <CocoaInput value={draft.code} onChange={(value) => setDraft((current) => ({ ...current, code: value.trim() }))} placeholder="705.4" disabled={!!editing} inputMode="decimal" maxLength={12} />
            </CocoaField>
            <CocoaField label="Naturaleza" required={!editing && !parentOfDraft} error={touched ? draftErrors.kind : undefined} help={editing ? "Fijada al crear la cuenta." : parentOfDraft ? `Heredada de ${parentOfDraft.code} (${kindLabel(parentOfDraft.kind)}).` : undefined}>
              <CocoaSelect value={editing ? editing.kind : draft.kind} onChange={(value) => setDraft((current) => ({ ...current, kind: value }))} options={[...KIND_OPTIONS]} placeholder={parentOfDraft ? kindLabel(parentOfDraft.kind) : "Elegir…"} disabled={!!editing} />
            </CocoaField>
            <CocoaField label="Nombre" required error={touched ? draftErrors.name : undefined} fullWidth>
              <CocoaInput value={draft.name} onChange={(value) => setDraft((current) => ({ ...current, name: value }))} placeholder="Prestaciones de servicios: aparcamiento" maxLength={200} />
            </CocoaField>
            <CocoaField label="Admite apuntes" inline help="Las cabeceras (grupos y subgrupos) no admiten apuntes; una cuenta con apuntes no puede convertirse en cabecera.">
              <CocoaSwitch checked={draft.isPostable} onChange={(value) => setDraft((current) => ({ ...current, isPostable: value }))} size="small" />
            </CocoaField>
          </CocoaFormRow>

          <CocoaSection title="Presentación USALI" meta="solo cuentas de resultados">
            {vocabError ? (
              <CocoaCallout tone="warning" title="Vocabulario USALI no disponible" role="status">
                {accountingErrorMessage(vocabError, "No se pudo cargar la lista de departamentos y líneas; el mapeo USALI se edita desde Estados contables › USALI.")}
              </CocoaCallout>
            ) : (
              <CocoaFormRow columns={2}>
                <CocoaField label="Departamento" error={touched ? draftErrors.usali : undefined}>
                  <CocoaSelect
                    value={draft.usaliDepartment}
                    onChange={(value) => setDraft((current) => ({ ...current, usaliDepartment: value, usaliLine: "" }))}
                    options={departmentOptions}
                    placeholder={vocab ? "Sin asignar" : STATUS_LABELS.loading}
                    disabled={!vocab}
                  />
                </CocoaField>
                <CocoaField label="Línea">
                  <CocoaSelect value={draft.usaliLine} onChange={(value) => setDraft((current) => ({ ...current, usaliLine: value }))} options={lineOptions} placeholder={draft.usaliDepartment ? "Elegir línea…" : "Elige antes el departamento"} disabled={!vocab || !draft.usaliDepartment} />
                </CocoaField>
              </CocoaFormRow>
            )}
          </CocoaSection>

          {saveError ? (
            <CocoaCallout tone="danger" title={editing ? "No se pudo guardar" : "No se pudo crear la cuenta"} role="alert">
              {accountingErrorMessage(saveError)}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default ChartOfAccountsScreen;

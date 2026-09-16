// Configuración › Estructura societaria › Datos fiscales — /configuracion/estructura-societaria
// (Tanda 6b · L6; design docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md §5.3;
// Cocoa 22 «workspace split»: sociedad card 4 / tab content 8, stacked below
// 900 px). This file is the base tab of the item AND the shared layout the
// other four tabs reuse (StructureSplit · StructureActions · LegalEntityCard ·
// structurePageProps): every tab is a CocoaPage hosted in
// tabs/configuracion/EstructuraSocietariaTabs.tsx, loads the same
// GET /organizations/me/structure through useStructureModel and paints the same
// left card, warnings and «Añadir centro» wizard.
//
// «Datos fiscales» is the ONLY screen that writes the NIF and the razón social
// (R2): PATCH /legal-entities/:id with a live checksum, a destructive-tone
// confirmation for the high-risk fields (resent with `confirmHighRisk: true`),
// the 409 HIGH_RISK_CONFIRMATION_REQUIRED / TAX_ID_INVALID / TAX_ID_IN_USE /
// CODE_IN_USE mapped onto their field or a callout, and the `warnings[]` of the
// 200 (series still numbering under the previous NIF) listed after saving.
// Issued invoices keep their snapshot: the form says so. Read-only for a
// profile without organization.structure.manage; a centre-scoped reader
// (`scope: "assigned_properties"`) sees no fiscal data at all (never a fake
// «NIF pendiente»). Hotel individual: same page with the card «Tu sociedad».

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { LegalForm } from "@hotelos/shared";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  useViewportTier,
  type CocoaPageProps
} from "../../components/cocoa";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, confirmDiscard } from "../../content/actions";
import { plural } from "../../lib/format";
import { patchLegalEntity, type LegalEntityPatchBody, type StructureLegalEntity } from "../../services/structureApi";
import { useTabHost } from "../tabs/TabHost";
import { vatPeriodicityLabel, vatRegimeLabel } from "../accounting/accounting-ui";
import { AddPropertyWizard } from "./AddPropertyDrawer";
import { useStructureModel, type StructureModel, type StructureView } from "./structure-model";
import {
  CHAIN_SCOPE_SHORT_LABELS,
  LEGAL_FORM_OPTIONS,
  PGC_VARIANT_LABELS,
  describeCentreCounts,
  describeChangeValue,
  fiscalDataFieldOf,
  highRiskChangesOf,
  highRiskFieldLabel,
  isValidTaxId,
  legalFormLabel,
  normalizeStructureCode,
  normalizeTaxId,
  structureCodeError,
  structureErrorCode,
  structureErrorMessage,
  taxIdValidationMessage
} from "./structure-ui";

// ---------------------------------------------------------------------------
// Shared layout of the five tabs
// ---------------------------------------------------------------------------

export type WizardState = { open: boolean; show: () => void; hide: () => void };

/** Open / close state of the «Añadir centro» drawer, shared by the actions row and the split. */
export function useWizardState(): WizardState {
  const [open, setOpen] = useState(false);
  return useMemo(() => ({ open, show: () => setOpen(true), hide: () => setOpen(false) }), [open]);
}

/** Props every structure tab hands to its CocoaPage (state, skeleton, error, header, ⌘K). */
export function structurePageProps(model: StructureModel, hosted: boolean, subtitle: string): Omit<CocoaPageProps, "children" | "actions"> {
  return {
    eyebrow: model.header.eyebrow,
    title: model.header.title,
    subtitle: hosted ? undefined : subtitle,
    state: model.loading && !model.structure ? "loading" : model.error && !model.structure ? "error" : "ready",
    skeleton: <StructureSkeleton />,
    error: { title: "No se pudo cargar la estructura", message: model.errorMessage ?? undefined, onRetry: model.refresh },
    commands: [{ id: `structure-${model.view}-refresh`, label: "Actualizar la estructura societaria", run: model.refresh }],
    id: `structure-${model.view}-screen`
  };
}

/** Mirror skeleton of the split (card 4 / content 8). */
export function StructureSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Grid rows={[[4, 8]]} height={320} />
    </div>
  );
}

/** Actions row: «Añadir centro» (or «Añadir otro establecimiento» for a hotel individual) and «Actualizar». */
export function StructureActions({ model, wizard }: { model: StructureModel; wizard: WizardState }) {
  const canAdd = model.permissions.manage && model.legalEntity !== null && !model.redacted;
  return (
    <>
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={model.refresh} disabled={model.loading}>
        {ACTIONS.refresh}
      </CocoaButton>
      {canAdd ? (
        <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon size={14} aria-hidden="true" />} onClick={wizard.show}>
          {model.singleHotel ? "Añadir otro establecimiento" : "Añadir centro"}
        </CocoaButton>
      ) : null}
    </>
  );
}

const WARNING_COPY: Record<string, { title: string; message: string }> = {
  LEGAL_ENTITY_PENDING: { title: "Sociedad pendiente", message: "La organización aún no tiene su sociedad: hasta que se cree, las facturas siguen usando la identidad heredada." },
  TAX_ID_PENDING: { title: "NIF pendiente", message: "La sociedad no tiene NIF: sin él no se puede emitir factura en modo fiscal real. Indícalo en Datos fiscales." },
  PROPERTIES_UNLINKED: { title: "Centros sin sociedad", message: "Algún centro no está enlazado a la sociedad; el emisor de sus facturas se resuelve por la organización hasta que se enlace." }
};

/**
 * Split layout of every tab: warnings and the redaction notice on top, the
 * sociedad card on the left (4 columns), the tab content on the right (8);
 * below 900 px the card stacks above the content. Mounts the «Añadir centro»
 * drawer for the whole item.
 */
export function StructureSplit({ model, wizard, children }: { model: StructureModel; wizard: WizardState; children: ReactNode }) {
  const tier = useViewportTier();
  const compact = tier === "phone" || tier === "tablet";
  const structure = model.structure;
  if (!structure) return null;

  const notices = (
    <>
      {model.redacted ? (
        <CocoaCallout tone="info" title="Ves solo tus centros">
          Tu perfil no tiene el permiso «Finanzas de toda la sociedad»: esta pantalla muestra los centros en los que tienes rol y oculta el NIF, las series y las instalaciones de la sociedad.
        </CocoaCallout>
      ) : null}
      {structure.warnings.map((warning) => {
        const copy = WARNING_COPY[warning];
        return copy ? (
          <CocoaCallout key={warning} tone="warning" title={copy.title}>
            {copy.message}
          </CocoaCallout>
        ) : null;
      })}
    </>
  );

  const card = <LegalEntityCard model={model} />;
  const drawer = model.legalEntity ? (
    <AddPropertyWizard
      open={wizard.open}
      onClose={wizard.hide}
      legalEntity={model.legalEntity}
      properties={model.properties}
      singleHotel={model.singleHotel}
      onCreated={model.refresh}
    />
  ) : null;

  if (compact) {
    return (
      <>
        {notices}
        {card}
        {children}
        {drawer}
      </>
    );
  }
  return (
    <>
      {notices}
      <CocoaGrid align="start" aria-label="Sociedad y detalle">
        <CocoaSpan cols={4} min={320}>
          {card}
        </CocoaSpan>
        <CocoaSpan cols={8} min={480}>
          <div className="cocoa-stack" data-gap="4">
            {children}
          </div>
        </CocoaSpan>
      </CocoaGrid>
      {drawer}
    </>
  );
}

/** Left card: the sociedad («Tu sociedad» for a hotel individual) — identity, regime and centre count. */
export function LegalEntityCard({ model }: { model: StructureModel }) {
  const entity = model.legalEntity;
  const structure = model.structure;
  if (!structure) return null;
  const title = model.singleHotel ? "Tu sociedad" : "Sociedad";
  if (!entity) {
    return (
      <CocoaSection title={title}>
        <CocoaState kind="empty" inline title="Sociedad pendiente" message="La organización aún no tiene sociedad." />
      </CocoaSection>
    );
  }
  const nif = model.redacted ? null : entity.taxId;
  const vat = entity.vatSettings;
  return (
    <CocoaSection title={title} meta={entity.code} footer={model.singleHotel ? "Añadir otro establecimiento convierte este hotel en una sociedad con varios centros." : "Una sociedad por organización: «Añadir sociedad» llegará con la fase de grupo."}>
      <ul className="c22-section__list" aria-label="Datos de la sociedad">
        <li>
          <span>Razón social</span>
          <strong>{entity.legalName}</strong>
        </li>
        <li>
          <span>NIF</span>
          {model.redacted ? (
            <strong>—</strong>
          ) : nif ? (
            <span className="cocoa-cluster">
              <strong className="cocoa-tabular">{nif}</strong>
              {entity.taxIdValid ? <CocoaBadge tone="success" size="small">válido</CocoaBadge> : <CocoaBadge tone="danger" size="small">revisar</CocoaBadge>}
            </span>
          ) : (
            <CocoaBadge tone="warning" size="small">pendiente</CocoaBadge>
          )}
        </li>
        <li>
          <span>Forma jurídica</span>
          <strong>{legalFormLabel(entity.legalForm)}</strong>
        </li>
        <li>
          <span>Plan contable</span>
          <strong>{PGC_VARIANT_LABELS[entity.pgcVariant]}</strong>
        </li>
        <li>
          <span>IVA</span>
          <strong>{vat ? `${vatPeriodicityLabel(vat.periodicity)} · ${vatRegimeLabel(vat.regime)}` : model.redacted ? "—" : "Sin ajustes guardados"}</strong>
        </li>
        <li>
          <span>Régimen</span>
          <span className="cocoa-cluster">
            {entity.siiEnabled ? <CocoaBadge tone="warning" size="small">SII</CocoaBadge> : null}
            {entity.largeCompany ? <CocoaBadge tone="warning" size="small">gran empresa</CocoaBadge> : null}
            {!entity.siiEnabled && !entity.largeCompany ? <strong>General</strong> : null}
          </span>
        </li>
        <li>
          <span>VeriFactu</span>
          <strong>{CHAIN_SCOPE_SHORT_LABELS[entity.verifactuChainScope]}</strong>
        </li>
        <li>
          <span>{model.singleHotel ? "Establecimiento" : "Centros"}</span>
          <strong>{model.singleHotel ? "Este hotel" : describeCentreCounts(structure.counts)}</strong>
        </li>
      </ul>
    </CocoaSection>
  );
}

// ---------------------------------------------------------------------------
// Datos fiscales (base tab)
// ---------------------------------------------------------------------------

type Draft = {
  legalName: string;
  code: string;
  taxId: string;
  legalForm: string;
  cnae: string;
  fiscalAddress: string;
  fiscalPostalCode: string;
  fiscalMunicipality: string;
  fiscalIneCode: string;
  fiscalProvince: string;
  registeredOfficeDiffers: boolean;
  registeredOfficeAddress: string;
  registeredOfficePostalCode: string;
  registeredOfficeMunicipality: string;
  registeredOfficeProvince: string;
  mercantileRegistry: string;
  cccPrincipal: string;
};

const text = (value: string | null | undefined) => value ?? "";

function draftOf(entity: StructureLegalEntity): Draft {
  const differs = Boolean(entity.registeredOfficeAddress || entity.registeredOfficePostalCode || entity.registeredOfficeMunicipality || entity.registeredOfficeProvince);
  return {
    legalName: entity.legalName,
    code: entity.code,
    taxId: text(entity.taxId),
    legalForm: text(entity.legalForm),
    cnae: text(entity.cnae),
    fiscalAddress: text(entity.fiscalAddress),
    fiscalPostalCode: text(entity.fiscalPostalCode),
    fiscalMunicipality: text(entity.fiscalMunicipality),
    fiscalIneCode: text(entity.fiscalIneCode),
    fiscalProvince: text(entity.fiscalProvince),
    registeredOfficeDiffers: differs,
    registeredOfficeAddress: text(entity.registeredOfficeAddress),
    registeredOfficePostalCode: text(entity.registeredOfficePostalCode),
    registeredOfficeMunicipality: text(entity.registeredOfficeMunicipality),
    registeredOfficeProvince: text(entity.registeredOfficeProvince),
    mercantileRegistry: text(entity.mercantileRegistry),
    cccPrincipal: text(entity.cccPrincipal)
  };
}

const nullable = (value: string) => (value.trim() === "" ? null : value.trim());

/** PATCH body = only the fields that differ from the saved sociedad (a same-value write is not a change). */
export function diffLegalEntity(saved: StructureLegalEntity, draft: Draft): LegalEntityPatchBody {
  const body: LegalEntityPatchBody = {};
  if (draft.legalName.trim() !== saved.legalName.trim()) body.legalName = draft.legalName.trim();
  if (draft.code.trim().toUpperCase() !== saved.code) body.code = draft.code.trim().toUpperCase();
  const nextTaxId = normalizeTaxId(draft.taxId);
  if (nextTaxId !== (saved.taxId ?? null)) body.taxId = nextTaxId;
  if (nullable(draft.legalForm) !== (saved.legalForm ?? null)) body.legalForm = (nullable(draft.legalForm) as LegalForm | null) ?? null;
  const textFields: Array<[keyof Draft & keyof LegalEntityPatchBody, string | null]> = [
    ["cnae", saved.cnae],
    ["fiscalAddress", saved.fiscalAddress],
    ["fiscalPostalCode", saved.fiscalPostalCode],
    ["fiscalMunicipality", saved.fiscalMunicipality],
    ["fiscalIneCode", saved.fiscalIneCode],
    ["fiscalProvince", saved.fiscalProvince],
    ["mercantileRegistry", saved.mercantileRegistry],
    ["cccPrincipal", saved.cccPrincipal]
  ];
  for (const [field, current] of textFields) {
    const next = nullable(draft[field] as string);
    if (next !== (current ?? null)) (body as Record<string, unknown>)[field] = next;
  }
  const office: Array<[keyof Draft & keyof LegalEntityPatchBody, string | null]> = [
    ["registeredOfficeAddress", saved.registeredOfficeAddress],
    ["registeredOfficePostalCode", saved.registeredOfficePostalCode],
    ["registeredOfficeMunicipality", saved.registeredOfficeMunicipality],
    ["registeredOfficeProvince", saved.registeredOfficeProvince]
  ];
  for (const [field, current] of office) {
    const next = draft.registeredOfficeDiffers ? nullable(draft[field] as string) : null;
    if (next !== (current ?? null)) (body as Record<string, unknown>)[field] = next;
  }
  return body;
}

const HIGH_RISK_REASONS: Record<string, string> = {
  taxId: "Cambiar o retirar el NIF afecta a todas las facturas futuras de todos los centros de la sociedad; las emitidas conservan su NIF.",
  legalName: "Cambiar la razón social cambia la identidad emisora de todas las facturas futuras y el NombreRazon de los registros VeriFactu; las emitidas conservan su snapshot."
};

function fiveDigits(value: string, label: string): string | undefined {
  return value.trim() !== "" && !/^\d{5}$/.test(value.trim()) ? `${label} de 5 dígitos.` : undefined;
}

export function StructureScreen() {
  const hosted = useTabHost() !== null;
  const model = useStructureModel("fiscal");
  const wizard = useWizardState();
  const { showToast } = useToast();
  const entity = model.legalEntity;
  const canEdit = model.permissions.manage && !model.redacted;

  const saved = useMemo(() => (entity ? draftOf(entity) : null), [entity]);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ field: "taxId" | "code" | "legalName" | null; message: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ body: LegalEntityPatchBody; changes: Array<{ field: string; from: unknown; to: unknown }> } | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);

  const body = useMemo(() => (entity && draft ? diffLegalEntity(entity, draft) : {}), [entity, draft]);
  const dirty = Object.keys(body).length > 0;

  const taxIdError = draft && draft.taxId.trim() !== "" && !isValidTaxId(draft.taxId) ? taxIdValidationMessage(draft.taxId) ?? undefined : undefined;
  const codeError = draft ? structureCodeError(draft.code) ?? (draft.code.trim() === "" ? "El código de la sociedad es obligatorio." : undefined) : undefined;
  const cnaeError = draft && draft.cnae.trim() !== "" && !/^\d{4}$/.test(draft.cnae.trim()) ? "CNAE de 4 dígitos." : undefined;
  const cccError = draft && draft.cccPrincipal.trim() !== "" && !/^\d{11}$/.test(draft.cccPrincipal.trim()) ? "CCC de 11 dígitos (2 provincia + 7 número + 2 control)." : undefined;
  const fiscalPostalError = draft ? fiveDigits(draft.fiscalPostalCode, "Código postal") : undefined;
  const fiscalIneError = draft ? fiveDigits(draft.fiscalIneCode, "Código INE") : undefined;
  const officePostalError = draft && draft.registeredOfficeDiffers ? fiveDigits(draft.registeredOfficePostalCode, "Código postal") : undefined;
  const legalNameError = draft && draft.legalName.trim() === "" ? "La razón social es obligatoria." : undefined;
  const valid = !taxIdError && !codeError && !cnaeError && !cccError && !fiscalPostalError && !fiscalIneError && !officePostalError && !legalNameError;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setFailure(null);
  }

  async function submit(patch: LegalEntityPatchBody) {
    if (!entity) return;
    setSaving(true);
    setFailure(null);
    try {
      const response = await patchLegalEntity(entity.id, patch);
      const { warnings: nextWarnings, ...dto } = response;
      model.patchLegalEntityLocally(dto);
      setWarnings(nextWarnings);
      setConfirm(null);
      showToast("Datos fiscales de la sociedad guardados.", { variant: "success" });
    } catch (err) {
      const code = structureErrorCode(err);
      if (code === "HIGH_RISK_CONFIRMATION_REQUIRED") {
        setConfirm({ body: { ...patch, confirmHighRisk: true }, changes: highRiskChangesOf(err) });
        return;
      }
      setFailure({ field: fiscalDataFieldOf(code), message: structureErrorMessage(err, STATUS_LABELS.saveError, { propertyNames: model.propertyNames }) });
    } finally {
      setSaving(false);
    }
  }

  function save() {
    if (!entity || !draft || !dirty || !valid || saving) return;
    const highRisk = (["taxId", "legalName"] as const).filter((field) => field in body);
    if (highRisk.length > 0) {
      setConfirm({
        body: { ...body, confirmHighRisk: true },
        changes: highRisk.map((field) => ({ field, from: field === "taxId" ? entity.taxId : entity.legalName, to: body[field] ?? null }))
      });
      return;
    }
    void submit(body);
  }

  const discard = confirmDiscard();
  const centreCount = model.structure?.counts.properties ?? 0;

  let content: ReactNode = null;
  if (model.structure && !entity) {
    content = (
      <CocoaSection aria-label="Sociedad pendiente">
        <CocoaState kind="empty" title="Sociedad pendiente" message="La organización aún no tiene su sociedad: se crea con el alta del tenant o con el proceso de estructura del API. Hasta entonces no hay datos fiscales que editar." illustration="box" />
      </CocoaSection>
    );
  } else if (model.redacted) {
    content = (
      <CocoaSection aria-label="Sin acceso a los datos fiscales">
        <CocoaState kind="empty" title="Sin acceso a los datos fiscales" message="Los datos fiscales de la sociedad (NIF, domicilios, registro) solo los ve quien tiene el permiso «Finanzas de toda la sociedad» o gestiona la estructura." illustration="box" />
      </CocoaSection>
    );
  } else if (entity && draft) {
    content = (
      <>
        {failure && failure.field === null ? (
          <CocoaCallout tone="danger" title="No se pudo guardar" role="alert">
            {failure.message}
          </CocoaCallout>
        ) : null}
        {warnings.length > 0 ? (
          <CocoaCallout tone="warning" title={plural(warnings.length, "serie bloqueada por el NIF anterior", "series bloqueadas por el NIF anterior")} role="status">
            <ul className="c22-section__list">
              {warnings.map((warning) => (
                <li key={warning}>
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          </CocoaCallout>
        ) : null}
        {!canEdit ? (
          <CocoaCallout tone="info" title="Solo lectura">
            Tu perfil consulta los datos fiscales pero no los modifica: hace falta el permiso de gestión de la estructura societaria.
          </CocoaCallout>
        ) : model.permissions.highRisk ? null : (
          <CocoaCallout tone="info" title="NIF y razón social">
            Cambiar el NIF o la razón social es una acción de alto riesgo que exige además el permiso de confirmación de acciones de alto riesgo.
          </CocoaCallout>
        )}
        <CocoaCallout tone="warning" title={model.singleHotel ? "El NIF afecta a todas las facturas futuras" : `Cambiar el NIF afecta a todas las facturas futuras de ${plural(centreCount, "centro", "centros")}`}>
          Las facturas ya emitidas conservan su NIF y su razón social; las series que numeraron con el NIF anterior se cierran y se abren otras. Nunca se renumera.
        </CocoaCallout>

        <CocoaFormSection title="Identidad" description="Quién factura: la razón social y el NIF del sujeto pasivo, la forma jurídica y la actividad. El NIF se comprueba con su carácter de control mientras escribes.">
          <CocoaFormRow columns={2}>
            <CocoaField label="Razón social" required error={failure?.field === "legalName" ? failure.message : legalNameError}>
              <CocoaInput value={draft.legalName} onChange={(v) => set("legalName", v)} placeholder="CELUISMA S.A." maxLength={200} disabled={!canEdit} autoComplete="organization" />
            </CocoaField>
            <CocoaField label="NIF" hint={draft.taxId.trim() === "" ? "pendiente" : undefined} error={failure?.field === "taxId" ? failure.message : taxIdError} help={draft.taxId.trim() === "" ? "Sin NIF no se puede emitir factura en modo fiscal real." : isValidTaxId(draft.taxId) ? "Carácter de control correcto." : undefined}>
              <CocoaInput value={draft.taxId} onChange={(v) => set("taxId", v.toUpperCase().replace(/[\s.-]/g, ""))} placeholder="B12345674" maxLength={20} disabled={!canEdit} />
            </CocoaField>
            <CocoaField label="Código de la sociedad" required error={failure?.field === "code" ? failure.message : codeError} help="De 2 a 6 letras o dígitos; identifica la sociedad en informes y ámbitos.">
              <CocoaInput value={draft.code} onChange={(v) => set("code", normalizeStructureCode(v))} placeholder="CEL" maxLength={6} disabled={!canEdit} />
            </CocoaField>
            <CocoaField label="Forma jurídica">
              <CocoaSelect value={draft.legalForm} onChange={(v) => set("legalForm", v)} options={[...LEGAL_FORM_OPTIONS]} disabled={!canEdit} />
            </CocoaField>
            <CocoaField label="CNAE" error={cnaeError} help="Actividad principal (5510 hoteles y alojamientos similares).">
              <CocoaInput value={draft.cnae} onChange={(v) => set("cnae", v.replace(/\D/g, "").slice(0, 4))} placeholder="5510" inputMode="numeric" maxLength={4} disabled={!canEdit} />
            </CocoaField>
            <CocoaField label="CCC principal de la Seguridad Social" error={cccError} help="11 dígitos; los CCC provinciales de cada centro van en su ficha.">
              <CocoaInput value={draft.cccPrincipal} onChange={(v) => set("cccPrincipal", v.replace(/\D/g, "").slice(0, 11))} placeholder="28123456789" inputMode="numeric" maxLength={11} disabled={!canEdit} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Domicilio fiscal" description="Se imprime en la cabecera de todas las facturas de la sociedad y es el domicilio del 036.">
          <CocoaFormRow columns={2}>
            <CocoaField label="Dirección" fullWidth>
              <CocoaInput value={draft.fiscalAddress} onChange={(v) => set("fiscalAddress", v)} placeholder="Calle Portugal 7" maxLength={240} disabled={!canEdit} autoComplete="street-address" />
            </CocoaField>
            <CocoaField label="Código postal" error={fiscalPostalError}>
              <CocoaInput value={draft.fiscalPostalCode} onChange={(v) => set("fiscalPostalCode", v.replace(/\D/g, "").slice(0, 5))} placeholder="33207" inputMode="numeric" maxLength={5} disabled={!canEdit} autoComplete="postal-code" />
            </CocoaField>
            <CocoaField label="Municipio">
              <CocoaInput value={draft.fiscalMunicipality} onChange={(v) => set("fiscalMunicipality", v)} placeholder="Gijón" maxLength={120} disabled={!canEdit} autoComplete="address-level2" />
            </CocoaField>
            <CocoaField label="Código INE del municipio" error={fiscalIneError} help="5 dígitos; los dos primeros coinciden con la provincia del código postal.">
              <CocoaInput value={draft.fiscalIneCode} onChange={(v) => set("fiscalIneCode", v.replace(/\D/g, "").slice(0, 5))} placeholder="33024" inputMode="numeric" maxLength={5} disabled={!canEdit} />
            </CocoaField>
            <CocoaField label="Provincia">
              <CocoaInput value={draft.fiscalProvince} onChange={(v) => set("fiscalProvince", v)} placeholder="Asturias" maxLength={80} disabled={!canEdit} autoComplete="address-level1" />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>

        <CocoaFormSection title="Domicilio social y Registro Mercantil" description="Solo si el domicilio social difiere del fiscal. El pie legal de la factura lleva los datos registrales.">
          <CocoaFormRow columns={2}>
            <CocoaField label="El domicilio social difiere del fiscal" inline>
              <CocoaSwitch checked={draft.registeredOfficeDiffers} onChange={(v) => set("registeredOfficeDiffers", v)} size="small" disabled={!canEdit} />
            </CocoaField>
            <CocoaField label="Registro Mercantil" help="Tomo, folio, hoja e inscripción tal como constan.">
              <CocoaInput value={draft.mercantileRegistry} onChange={(v) => set("mercantileRegistry", v)} placeholder="RM de Asturias, tomo 1234, folio 56, hoja AS-7890" maxLength={200} disabled={!canEdit} />
            </CocoaField>
            {draft.registeredOfficeDiffers ? (
              <>
                <CocoaField label="Dirección del domicilio social" fullWidth>
                  <CocoaInput value={draft.registeredOfficeAddress} onChange={(v) => set("registeredOfficeAddress", v)} maxLength={240} disabled={!canEdit} />
                </CocoaField>
                <CocoaField label="Código postal" error={officePostalError}>
                  <CocoaInput value={draft.registeredOfficePostalCode} onChange={(v) => set("registeredOfficePostalCode", v.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" maxLength={5} disabled={!canEdit} />
                </CocoaField>
                <CocoaField label="Municipio">
                  <CocoaInput value={draft.registeredOfficeMunicipality} onChange={(v) => set("registeredOfficeMunicipality", v)} maxLength={120} disabled={!canEdit} />
                </CocoaField>
                <CocoaField label="Provincia">
                  <CocoaInput value={draft.registeredOfficeProvince} onChange={(v) => set("registeredOfficeProvince", v)} maxLength={80} disabled={!canEdit} />
                </CocoaField>
              </>
            ) : null}
          </CocoaFormRow>
        </CocoaFormSection>

        {canEdit ? (
          <CocoaActionBar
            aria-label="Acciones de los datos fiscales"
            status={dirty ? (valid ? "Cambios sin guardar" : "Revisa los campos marcados") : undefined}
            secondary={{ label: ACTIONS.cancel, disabled: !dirty || saving, onClick: () => setAskDiscard(true) }}
            primary={{ label: saving ? STATUS_LABELS.saving : ACTIONS.save, loading: saving, disabled: !dirty || !valid || saving, onClick: save }}
            publishToastOffset
          />
        ) : null}

        <CocoaDialog
          open={askDiscard}
          onClose={() => setAskDiscard(false)}
          tone="destructive"
          title={discard.title}
          description={discard.message}
          confirmLabel={discard.confirmLabel}
          cancelLabel={discard.cancelLabel}
          onConfirm={() => {
            if (saved) setDraft(saved);
            setFailure(null);
            setAskDiscard(false);
          }}
        />

        <CocoaDialog
          open={confirm !== null}
          onClose={() => setConfirm(null)}
          tone="destructive"
          title="Confirmar el cambio de identidad de la sociedad"
          description="Este cambio afecta a todas las facturas y modelos futuros de la sociedad. Las facturas ya emitidas conservan su snapshot y ninguna serie se renumera."
          confirmLabel="Aplicar el cambio"
          cancelLabel={ACTIONS.cancel}
          busy={saving}
          onConfirm={() => (confirm ? submit(confirm.body) : undefined)}
          size="md"
        >
          {confirm ? (
            <ul className="c22-section__list" aria-label="Cambios de alto riesgo">
              {confirm.changes.map((change) => (
                <li key={change.field}>
                  <span className="cocoa-stack" data-gap="1">
                    <span>
                      {highRiskFieldLabel(change.field)}: {describeChangeValue(change.from)} → {describeChangeValue(change.to)}
                    </span>
                    {HIGH_RISK_REASONS[change.field] ? <span className="cocoa-note">{HIGH_RISK_REASONS[change.field]}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </CocoaDialog>
      </>
    );
  }

  return (
    <CocoaPage {...structurePageProps(model, hosted, "Quién factura y dónde se trabaja: la sociedad (NIF, razón social, domicilios) y sus centros de trabajo.")} actions={<StructureActions model={model} wizard={wizard} />}>
      <StructureSplit model={model} wizard={wizard}>
        {content}
      </StructureSplit>
    </CocoaPage>
  );
}

export default StructureScreen;

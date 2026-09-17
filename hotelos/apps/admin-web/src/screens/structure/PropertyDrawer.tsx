// Ficha del centro — the CocoaDrawer that opens from a row of the Centros
// table (Tanda 6b · L6; design §5.3). It has NO NIF and NO razón social: a
// callout says «Factura como <sociedad> · <NIF> — editar en Datos fiscales»
// and links there. Editable: tipo (hotel · oficina · otro), código, nombre
// comercial and the census columns (catastro, superficie, IAE, plazas,
// estrellas, meses de apertura, registro turístico, SES, CCC, centro laboral)
// through PATCH /properties/:id/establishment (organization.structure.manage).
// A hotel with rooms cannot become an office (409 PROPERTY_KIND_CHANGE_BLOCKED,
// shown as a callout); a duplicate code lands on its field (409 CODE_IN_USE).
// There is deliberately no «Mover a otra sociedad» (invariant R10.5).
// Read-only: series, installation, municipality and status.
// Esc, the scrim and «Cancelar» ask «¿Descartar los cambios?» while the form
// is dirty (qa#9); the initial focus lands on «Tipo», the first control, and
// falls back to «Cerrar» for a read-only profile (qa#10).

import { useEffect, useId, useMemo, useState } from "react";
import type { PropertyKind } from "@hotelos/shared";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKbd,
  CocoaSelect,
  openTabPath
} from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, confirmDiscard } from "../../content/actions";
import { urlForScreen } from "../../navigation/nav-tree";
import { patchEstablishment, type EstablishmentPatchBody, type StructureLegalEntity, type StructureProperty } from "../../services/structureApi";
import { PROPERTY_KIND_OPTIONS, invoiceTypeLabel, isOperationalKind, normalizeStructureCode, propertyKindLabel, structureCodeError, structureErrorCode, structureErrorMessage } from "./structure-ui";
import { BRAND } from "../../config/brand";

export type PropertyDrawerProps = {
  property: StructureProperty | null;
  legalEntity: StructureLegalEntity;
  /** organization.structure.manage; false paints every control disabled. */
  canEdit: boolean;
  /** The caller sees only its assigned centres (no NIF in the callout, no series). */
  redacted: boolean;
  singleHotel: boolean;
  onClose: () => void;
  /** After a successful PATCH (the structure reloads). */
  onSaved: () => void;
};

type Draft = {
  kind: PropertyKind;
  code: string;
  tradeName: string;
  cadastralReference: string;
  surfaceM2: string;
  iaeEpigraph: string;
  bedCapacity: string;
  starRating: string;
  openingMonths: string;
  tourismRegistryNumber: string;
  sesEstablishmentCode: string;
  socialSecurityCcc: string;
  laborCenterCode: string;
};

/**
 * The structure payload carries the identity of the centre but not the census
 * columns (those live in PATCH /properties/:id/establishment); the drawer
 * starts them empty and only sends the ones the user fills in.
 */
function draftOf(property: StructureProperty): Draft {
  return {
    kind: property.kind,
    code: property.code ?? "",
    tradeName: property.tradeName ?? "",
    cadastralReference: "",
    surfaceM2: "",
    iaeEpigraph: "",
    bedCapacity: "",
    starRating: "",
    openingMonths: "",
    tourismRegistryNumber: "",
    sesEstablishmentCode: "",
    socialSecurityCcc: "",
    laborCenterCode: ""
  };
}

const digits = (value: string, max: number) => value.replace(/\D/g, "").slice(0, max);

/** PATCH body: identity fields only when they change; census fields only when filled in. */
export function diffEstablishment(property: StructureProperty, draft: Draft): EstablishmentPatchBody {
  const body: EstablishmentPatchBody = {};
  if (draft.kind !== property.kind) body.kind = draft.kind;
  const code = draft.code.trim().toUpperCase();
  if (code && code !== (property.code ?? "")) body.code = code;
  const tradeName = draft.tradeName.trim();
  if (tradeName !== (property.tradeName ?? "")) body.tradeName = tradeName === "" ? null : tradeName;
  const text = (key: "cadastralReference" | "iaeEpigraph" | "tourismRegistryNumber" | "sesEstablishmentCode" | "laborCenterCode") => {
    const value = draft[key].trim();
    if (value) body[key] = value;
  };
  text("cadastralReference");
  text("iaeEpigraph");
  text("tourismRegistryNumber");
  text("sesEstablishmentCode");
  text("laborCenterCode");
  if (draft.surfaceM2.trim()) body.surfaceM2 = draft.surfaceM2.trim().replace(",", ".");
  if (draft.bedCapacity.trim()) body.bedCapacity = Number(draft.bedCapacity);
  if (draft.starRating) body.starRating = Number(draft.starRating);
  if (draft.openingMonths.trim()) body.openingMonths = Number(draft.openingMonths);
  if (draft.socialSecurityCcc.trim()) body.socialSecurityCcc = draft.socialSecurityCcc.trim();
  return body;
}

const STAR_OPTIONS = [{ value: "", label: "Sin cambio" }, ...[1, 2, 3, 4, 5].map((stars) => ({ value: String(stars), label: `${stars} ${stars === 1 ? "estrella" : "estrellas"}` }))];

const DATOS_FISCALES_PATH = urlForScreen("StructureScreen") ?? "/configuracion/estructura-societaria";

export function PropertyDrawer({ property, legalEntity, canEdit, redacted, singleHotel, onClose, onSaved }: PropertyDrawerProps) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ field: "code" | null; message: string } | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const kindSelectId = useId();

  useEffect(() => {
    setDraft(property ? draftOf(property) : null);
    setFailure(null);
    setAskDiscard(false);
  }, [property]);

  const body = useMemo(() => (property && draft ? diffEstablishment(property, draft) : {}), [property, draft]);
  const dirty = Object.keys(body).length > 0;
  const discard = confirmDiscard();

  // Dirty guard (qa#9): the drawer's Esc / scrim / «Cancelar» go through here.
  function requestClose() {
    if (saving) return;
    if (dirty) setAskDiscard(true);
    else onClose();
  }

  /** First control of the form; a disabled one (read-only profile) yields null so the trap falls back to «Cerrar». */
  function initialFocus(): HTMLElement | null {
    const node = document.getElementById(kindSelectId);
    return node && !node.hasAttribute("disabled") ? node : null;
  }
  const codeError = draft ? structureCodeError(draft.code) : null;
  const cccError = draft && draft.socialSecurityCcc.trim() !== "" && !/^\d{11}$/.test(draft.socialSecurityCcc.trim()) ? "CCC de 11 dígitos." : undefined;
  const surfaceError = draft && draft.surfaceM2.trim() !== "" && !/^\d{1,8}([.,]\d{1,2})?$/.test(draft.surfaceM2.trim()) ? "Superficie en m² con hasta dos decimales." : undefined;
  const monthsError = draft && draft.openingMonths.trim() !== "" && !(Number(draft.openingMonths) >= 1 && Number(draft.openingMonths) <= 12) ? "Entre 1 y 12 meses." : undefined;
  const valid = !codeError && !cccError && !surfaceError && !monthsError;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setFailure(null);
  }

  async function save() {
    if (!property || !dirty || !valid || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      await patchEstablishment(property.id, body);
      showToast(`Centro «${property.tradeName ?? property.name}» actualizado.`, { variant: "success" });
      onSaved();
      onClose();
    } catch (err) {
      const code = structureErrorCode(err);
      setFailure({ field: code === "CODE_IN_USE" ? "code" : null, message: structureErrorMessage(err, STATUS_LABELS.saveError) });
    } finally {
      setSaving(false);
    }
  }

  const hotel = draft ? isOperationalKind(draft.kind) : true;
  const title = property ? property.tradeName ?? property.name : "Centro";
  const subtitle = property ? [property.code, propertyKindLabel(property.kind), property.municipality].filter(Boolean).join(" · ") : undefined;

  const drawer = (
    <CocoaDrawer
      open={property !== null}
      onClose={requestClose}
      title={title}
      subtitle={subtitle}
      side="right"
      size="lg"
      dismissible={!saving}
      initialFocus={initialFocus}
      focusKey={draft ? "ready" : "loading"}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={requestClose} disabled={saving}>
            {canEdit ? ACTIONS.cancel : ACTIONS.close}
          </CocoaButton>
          {canEdit ? (
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={saving} disabled={!dirty || !valid || saving}>
              {saving ? STATUS_LABELS.saving : ACTIONS.saveChanges}
            </CocoaButton>
          ) : null}
        </>
      }
    >
      {property && draft ? (
        <div className="cocoa-stack" data-gap="4">
          {failure && failure.field === null ? (
            <CocoaCallout tone="danger" title="No se pudo guardar" role="alert">
              {failure.message}
            </CocoaCallout>
          ) : null}
          <CocoaCallout
            tone="info"
            title={`Factura como ${legalEntity.legalName}${!redacted && legalEntity.taxId ? ` · ${legalEntity.taxId}` : ""}`}
            actions={
              !redacted ? (
                <CocoaButton variant="plain" tone="accent" size="small" onClick={() => openTabPath(DATOS_FISCALES_PATH)}>
                  Editar en Datos fiscales
                </CocoaButton>
              ) : undefined
            }
          >
            El NIF y la razón social son de la sociedad y no se editan en la ficha del centro. La factura imprime además el bloque «Establecimiento» con el nombre comercial y la dirección de este centro.
          </CocoaCallout>

          <CocoaFormSection title="Identidad del centro" description={singleHotel ? "Nombre comercial y código de este hotel." : "Tipo, código y nombre comercial. Un centro no se mueve a otra sociedad: un traspaso es un centro nuevo."}>
            <CocoaFormRow columns={2}>
              <CocoaField label="Tipo" required help={hotel ? "Hotel: habitaciones, tarifas, recepción, tasa turística y SES." : "Sin operación hotelera: solo nóminas, gastos, bancos, inmovilizado y retenciones."}>
                <CocoaSelect id={kindSelectId} value={draft.kind} onChange={(value) => set("kind", value as PropertyKind)} options={[...PROPERTY_KIND_OPTIONS]} disabled={!canEdit} />
              </CocoaField>
              <CocoaField label="Código" required error={failure?.field === "code" ? failure.message : codeError ?? undefined} help="De 2 a 6 letras o dígitos; va en los prefijos de serie cuando la sociedad factura desde varios centros.">
                <CocoaInput value={draft.code} onChange={(value) => set("code", normalizeStructureCode(value))} maxLength={6} disabled={!canEdit} />
              </CocoaField>
              <CocoaField label="Nombre comercial (en factura)" fullWidth help="Bloque «Establecimiento» de la factura y del registro VeriFactu; vacío = el nombre del centro.">
                <CocoaInput value={draft.tradeName} onChange={(value) => set("tradeName", value)} placeholder={property.name} maxLength={200} disabled={!canEdit} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          {property.kind === "hotel" && !hotel ? (
            <CocoaCallout tone="warning" title="Pasar a un centro no alojativo">
              Solo es posible si el hotel no tiene habitaciones ni tipos de habitación; al cambiar deja de enviar partes SES.
            </CocoaCallout>
          ) : null}

          <CocoaFormSection title="Datos censales" description={`Datos para la gestoría (036, IAE, registro turístico, SES, Seguridad Social): ${BRAND.name} los guarda, no los liquida. Solo se envían los campos que rellenes.`}>
            <CocoaFormRow columns={2}>
              <CocoaField label="Referencia catastral">
                <CocoaInput value={draft.cadastralReference} onChange={(value) => set("cadastralReference", value.toUpperCase())} maxLength={20} disabled={!canEdit} />
              </CocoaField>
              <CocoaField label="Superficie (m²)" error={surfaceError}>
                <CocoaInput value={draft.surfaceM2} onChange={(value) => set("surfaceM2", value)} inputMode="decimal" maxLength={12} placeholder="1250,50" disabled={!canEdit} />
              </CocoaField>
              <CocoaField label="Epígrafe IAE" help={hotel ? "Grupo 681 (hospedaje en hoteles y moteles)." : "Cuota por superficie del local."}>
                <CocoaInput value={draft.iaeEpigraph} onChange={(value) => set("iaeEpigraph", value)} maxLength={12} placeholder={hotel ? "681" : ""} disabled={!canEdit} />
              </CocoaField>
              <CocoaField label="CCC de la Seguridad Social" error={cccError} help="CCC provincial del centro si difiere del principal de la sociedad.">
                <CocoaInput value={draft.socialSecurityCcc} onChange={(value) => set("socialSecurityCcc", digits(value, 11))} inputMode="numeric" maxLength={11} disabled={!canEdit} />
              </CocoaField>
              <CocoaField label="Código de centro de trabajo" help="El que consta ante la autoridad laboral (comunicación de apertura).">
                <CocoaInput value={draft.laborCenterCode} onChange={(value) => set("laborCenterCode", value)} maxLength={40} disabled={!canEdit} />
              </CocoaField>
              {hotel ? (
                <>
                  <CocoaField label="Plazas">
                    <CocoaInput value={draft.bedCapacity} onChange={(value) => set("bedCapacity", digits(value, 5))} inputMode="numeric" maxLength={5} disabled={!canEdit} />
                  </CocoaField>
                  <CocoaField label="Categoría">
                    <CocoaSelect value={draft.starRating} onChange={(value) => set("starRating", value)} options={STAR_OPTIONS} disabled={!canEdit} />
                  </CocoaField>
                  <CocoaField label="Meses de apertura al año" error={monthsError} help="12 si abre todo el año; menos si es estacional.">
                    <CocoaInput value={draft.openingMonths} onChange={(value) => set("openingMonths", digits(value, 2))} inputMode="numeric" maxLength={2} disabled={!canEdit} />
                  </CocoaField>
                  <CocoaField label="Registro turístico">
                    <CocoaInput value={draft.tourismRegistryNumber} onChange={(value) => set("tourismRegistryNumber", value)} maxLength={40} disabled={!canEdit} />
                  </CocoaField>
                  <CocoaField label="Código de establecimiento SES">
                    <CocoaInput value={draft.sesEstablishmentCode} onChange={(value) => set("sesEstablishmentCode", value)} maxLength={40} disabled={!canEdit} />
                  </CocoaField>
                </>
              ) : null}
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection title="Series e instalación" description="Solo lectura: las series se gestionan en Series y VeriFactu y en Facturación y pagos; la instalación la abre la plataforma.">
            <ul className="c22-section__list" aria-label="Series e instalación del centro">
              <li>
                <span>Municipio</span>
                <strong>{[property.municipality, property.province].filter(Boolean).join(", ") || "—"}</strong>
              </li>
              <li>
                <span>Estado</span>
                <CocoaBadge tone={property.status === "open" ? "success" : "neutral"}>{property.status === "open" ? STATUS_LABELS.active : property.status}</CocoaBadge>
              </li>
              {redacted ? null : (
                <>
                  <li>
                    <span>Series activas</span>
                    <strong>{property.series.filter((row) => row.active).map((row) => `${row.prefix ?? row.sequenceCode} (${invoiceTypeLabel(row.invoiceType)})`).join(" · ") || "ninguna"}</strong>
                  </li>
                  <li>
                    <span>Instalación VeriFactu</span>
                    {property.installation ? (
                      <span className="cocoa-cluster">
                        <CocoaKbd announce>{property.installation.numeroInstalacion}</CocoaKbd>
                        <CocoaBadge tone={property.installation.active ? "success" : "neutral"} size="small">
                          {property.installation.active ? "activa" : "retirada"}
                        </CocoaBadge>
                      </span>
                    ) : (
                      <strong>{property.kind === "hotel" ? "sin declarar" : "no aplica"}</strong>
                    )}
                  </li>
                </>
              )}
            </ul>
          </CocoaFormSection>

          {!canEdit ? (
            <CocoaCallout tone="info" title="Solo lectura">
              Tu perfil consulta la ficha del centro pero no la modifica: hace falta el permiso de gestión de la estructura societaria.
            </CocoaCallout>
          ) : null}
        </div>
      ) : null}
    </CocoaDrawer>
  );

  // The dialog is a sibling of the drawer (both are portals): inside the drawer
  // its Tab presses would bubble through the React tree into the drawer's trap.
  return (
    <>
      {drawer}
      <CocoaDialog
        open={askDiscard}
        onClose={() => setAskDiscard(false)}
        tone="destructive"
        title={discard.title}
        description={discard.message}
        confirmLabel={discard.confirmLabel}
        cancelLabel={discard.cancelLabel}
        onConfirm={() => {
          if (property) setDraft(draftOf(property));
          setFailure(null);
          setAskDiscard(false);
          onClose();
        }}
      />
    </>
  );
}

export default PropertyDrawer;

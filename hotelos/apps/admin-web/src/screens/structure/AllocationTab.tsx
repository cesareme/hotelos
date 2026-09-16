// Configuración › Estructura societaria › Reparto —
// /configuracion/estructura-societaria/reparto (Tanda 6b · L6; design §5.3, R5).
// The INFORMATIVE allocation key of the oficina central cost over the hotels:
// Ninguno · Habitaciones · Ingresos · Plantilla · Porcentajes (GET/PUT
// /accounting/allocation, accounting.configure). With «Porcentajes» a table of
// hotel · peso with a live total that must reach 100. The callout says what
// every row repeats: it only changes the USALI / PyG por centro reports — the
// Diario and the taxes are never touched, no journal entry is ever posted.
// Without a corporate centre there is nothing to allocate and the page says so.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CorporateAllocationMethod, CorporateAllocationView } from "@hotelos/shared";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, confirmDiscard } from "../../content/actions";
import { number, percent, plural } from "../../lib/format";
import { getCorporateAllocation, putCorporateAllocation } from "../../services/structureApi";
import { useTabHost } from "../tabs/TabHost";
import { StructureActions, StructureSplit, structurePageProps, useWizardState } from "./StructureScreen";
import { useStructureModel } from "./structure-model";
import { ALLOCATION_METHOD_HELP, ALLOCATION_METHOD_LABELS, ALLOCATION_METHOD_ORDER, manualWeightsError, parseWeight, propertyKindLabel, structureErrorMessage, weightsTotal, type WeightDraft } from "./structure-ui";

type Draft = { method: CorporateAllocationMethod; weights: WeightDraft[] };

function draftOf(view: CorporateAllocationView): Draft {
  const byProperty = new Map(view.weights.map((row) => [row.propertyId, row.weight]));
  return {
    method: view.method,
    weights: view.hotels.map((hotel) => ({ propertyId: hotel.propertyId, weight: byProperty.has(hotel.propertyId) ? String(byProperty.get(hotel.propertyId)).replace(".", ",") : "" }))
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  if (a.method !== b.method) return false;
  if (a.method !== "manual") return true;
  return a.weights.length === b.weights.length && a.weights.every((row, index) => row.propertyId === b.weights[index]?.propertyId && (parseWeight(row.weight) ?? 0) === (parseWeight(b.weights[index]?.weight ?? "") ?? 0));
}

type PreviewRow = { propertyId: string; code: string | null; name: string; weight: string; share: number | null };

export function StructureAllocationTab() {
  const hosted = useTabHost() !== null;
  const model = useStructureModel("allocation");
  const wizard = useWizardState();
  const { showToast } = useToast();
  const canEdit = model.permissions.configureAccounting && !model.redacted;

  const [view, setView] = useState<CorporateAllocationView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (model.redacted || !model.structure) return;
    let mounted = true;
    setError(null);
    getCorporateAllocation()
      .then((payload) => {
        if (mounted) setView(payload);
      })
      .catch((err: unknown) => {
        if (mounted) setError(err);
      });
    return () => {
      mounted = false;
    };
  }, [nonce, model.redacted, model.structure]);

  const saved = useMemo(() => (view ? draftOf(view) : null), [view]);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const dirty = draft !== null && saved !== null && !sameDraft(draft, saved);
  const weightsError = draft && draft.method === "manual" ? manualWeightsError(draft.weights) : null;
  const total = draft ? weightsTotal(draft.weights) : 0;
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);

  const preview = useMemo<PreviewRow[]>(() => {
    if (!view || !draft) return [];
    return view.hotels.map((hotel) => {
      const weight = draft.weights.find((row) => row.propertyId === hotel.propertyId)?.weight ?? "";
      const value = parseWeight(weight);
      return { propertyId: hotel.propertyId, code: hotel.code, name: hotel.tradeName ?? hotel.name, weight, share: draft.method === "manual" && value !== null && total > 0 ? (value / total) * 100 : null };
    });
  }, [view, draft, total]);

  function setWeight(propertyId: string, weight: string) {
    setDraft((current) => (current ? { ...current, weights: current.weights.map((row) => (row.propertyId === propertyId ? { ...row, weight } : row)) } : current));
    setFailure(null);
  }

  function distributeEvenly() {
    setDraft((current) => {
      if (!current || current.weights.length === 0) return current;
      const share = Math.floor((100 / current.weights.length) * 100) / 100;
      const remainder = Math.round((100 - share * current.weights.length) * 100) / 100;
      return { ...current, weights: current.weights.map((row, index) => ({ ...row, weight: String(index === 0 ? Math.round((share + remainder) * 100) / 100 : share).replace(".", ",") })) };
    });
  }

  async function save() {
    if (!draft || !dirty || weightsError || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      const next = await putCorporateAllocation({
        method: draft.method,
        ...(draft.method === "manual" ? { weights: draft.weights.map((row) => ({ propertyId: row.propertyId, weight: parseWeight(row.weight) ?? 0 })) } : {})
      });
      setView(next);
      showToast("Clave de reparto guardada. Solo cambia los informes por centro; el Diario no se toca.", { variant: "success" });
    } catch (err) {
      setFailure(structureErrorMessage(err, STATUS_LABELS.saveError));
    } finally {
      setSaving(false);
    }
  }

  const columns = useMemo<CocoaTableColumn<PreviewRow>[]>(
    () => [
      { key: "code", label: "Código", fit: true, render: (row) => row.code ?? "—" },
      { key: "name", label: "Hotel", minWidth: 160, render: (row) => row.name },
      {
        key: "weight",
        label: "Peso (%)",
        fit: true,
        align: "right",
        render: (row) =>
          draft?.method === "manual" ? (
            <CocoaInput value={row.weight} onChange={(value) => setWeight(row.propertyId, value)} inputMode="decimal" size="small" maxLength={7} aria-label={`Peso de ${row.name}`} disabled={!canEdit} />
          ) : (
            "según la clave"
          )
      },
      { key: "share", label: "Cuota", fit: true, align: "right", render: (row) => (row.share === null ? "—" : percent(row.share, { maximumFractionDigits: 2 })) }
    ],
    [draft?.method, canEdit]
  );

  const discard = confirmDiscard();
  let content: ReactNode = null;
  if (model.redacted) {
    content = (
      <CocoaSection aria-label="Sin acceso al reparto">
        <CocoaState kind="empty" title="Sin acceso al reparto" message="La clave de reparto es de toda la sociedad: la ve quien tiene el permiso «Finanzas de toda la sociedad»." illustration="box" />
      </CocoaSection>
    );
  } else if (model.singleHotel) {
    content = (
      <CocoaSection aria-label="Sin reparto">
        <CocoaState kind="empty" title="Nada que repartir" message="El reparto solo tiene sentido cuando la sociedad tiene una oficina central o varios hoteles. Este hotel lleva todos sus costes." illustration="box" />
      </CocoaSection>
    );
  } else if (error) {
    content = (
      <CocoaSection aria-label="Error del reparto">
        <CocoaState kind="error" title="No se pudo cargar la clave de reparto" message={structureErrorMessage(error)} onRetry={() => setNonce((n) => n + 1)} />
      </CocoaSection>
    );
  } else if (!view || !draft) {
    content = (
      <CocoaSection aria-label="Cargando el reparto">
        <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
      </CocoaSection>
    );
  } else {
    const noCorporate = view.corporateCentres.length === 0;
    content = (
      <>
        <CocoaCallout tone="info" title="Solo informativo">
          El reparto cambia únicamente los informes USALI y PyG por centro (fila «Reparto corporativo (informativo · no contabilizado)»). El Diario, los modelos y los impuestos no se tocan: no se genera ningún asiento.
        </CocoaCallout>
        {noCorporate ? (
          <CocoaCallout tone="warning" title="Sin oficina central">
            La sociedad no tiene centros no alojativos: no hay coste corporativo que repartir. La clave queda guardada para cuando exista una oficina central.
          </CocoaCallout>
        ) : (
          <p className="cocoa-note">
            {plural(view.corporateCentres.length, "centro corporativo", "centros corporativos")}: {view.corporateCentres.map((centre) => `${centre.tradeName ?? centre.name} (${propertyKindLabel(centre.kind)})`).join(", ")}. Base del reparto: el coste de explotación de la oficina (−GOP USALI) del periodo que se consulte.
          </p>
        )}
        {failure ? (
          <CocoaCallout tone="danger" title="No se pudo guardar" role="alert">
            {failure}
          </CocoaCallout>
        ) : null}
        {!canEdit ? (
          <CocoaCallout tone="info" title="Solo lectura">
            Tu perfil consulta la clave de reparto pero no la cambia: hace falta el permiso de configuración contable.
          </CocoaCallout>
        ) : null}

        <CocoaFormSection title="Clave de reparto" description={view.persisted ? "Clave guardada para la sociedad." : "Aún no se ha guardado ninguna clave: se muestra «Ninguno»."}>
          <CocoaField label="Método" required help={ALLOCATION_METHOD_HELP[draft.method]}>
            <CocoaSegmentedControl
              value={draft.method}
              onChange={(value) => {
                setDraft((current) => (current ? { ...current, method: value as CorporateAllocationMethod } : current));
                setFailure(null);
              }}
              options={ALLOCATION_METHOD_ORDER.map((method) => ({ value: method, label: ALLOCATION_METHOD_LABELS[method], disabled: !canEdit && method !== draft.method }))}
              size="small"
              aria-label="Método de reparto"
            />
          </CocoaField>
        </CocoaFormSection>

        <CocoaSection
          title="Vista previa por hotel"
          meta={
            draft.method === "manual" ? (
              <span className="cocoa-cluster">
                <span>Total {number(total, { maximumFractionDigits: 2 })} %</span>
                <CocoaBadge tone={weightsError ? "danger" : "success"} size="small">
                  {weightsError ? "no suma 100" : "suma 100"}
                </CocoaBadge>
              </span>
            ) : (
              plural(view.hotels.length, "hotel", "hoteles")
            )
          }
          action={
            draft.method === "manual" && canEdit ? (
              <CocoaButton variant="plain" size="small" onClick={distributeEvenly}>
                Repartir a partes iguales
              </CocoaButton>
            ) : undefined
          }
          padding={view.hotels.length > 0 ? "none" : "md"}
          style={{ overflow: "clip" }}
          footer={draft.method === "manual" ? (weightsError ?? "Los pesos suman 100: la cuota de cada hotel es su peso.") : "El importe repartido depende del periodo consultado en USALI o PyG por centro; aquí solo se elige la clave."}
        >
          {view.hotels.length === 0 ? <CocoaState kind="empty" inline title="La sociedad no tiene hoteles entre los que repartir." /> : <CocoaTable columns={columns} rows={preview} rowKey="propertyId" caption="Vista previa del reparto por hotel" aria-label="Vista previa del reparto por hotel" density="compact" />}
        </CocoaSection>

        {canEdit ? (
          <CocoaActionBar
            aria-label="Acciones del reparto"
            status={dirty ? (weightsError ?? "Cambios sin guardar") : undefined}
            secondary={{ label: ACTIONS.cancel, disabled: !dirty || saving, onClick: () => setAskDiscard(true) }}
            primary={{ label: saving ? STATUS_LABELS.saving : ACTIONS.save, loading: saving, disabled: !dirty || Boolean(weightsError) || saving, onClick: () => void save() }}
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
            setAskDiscard(false);
          }}
        />
      </>
    );
  }

  return (
    <CocoaPage {...structurePageProps(model, hosted, "Cómo se reparte, solo en los informes, el coste de la oficina central entre los hoteles de la sociedad.")} actions={<StructureActions model={model} wizard={wizard} />}>
      <StructureSplit model={model} wizard={wizard}>
        {content}
      </StructureSplit>
    </CocoaPage>
  );
}

export default StructureAllocationTab;

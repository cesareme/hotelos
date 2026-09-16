// Upsells — catálogo de ofertas adicionales que se muestran al huésped antes
// y durante la estancia (room upgrade, early check-in, late check-out, parking,
// breakfast add-on, spa credit).
//
// Tanda 3 · CF-02: la pantalla lee y escribe sobre Prisma UpsellOffer a través
// de las rutas staff (services/upsellsApi.ts). La categoría de la UI se guarda
// como `offerType`; la categoría fiscal (`taxCategory`) decide el tipo de IVA /
// IGIC / IPSI que aplicará el folio cuando se venda la oferta.
//
// Cocoa 22 · ola 7 · lote 7-C (hosted in VentasAdicionalesTabs, tab «Ofertas»;
// pilots GuestsListScreen + SuppliersScreen): KPI strip with the catalogue
// counters → CocoaSection padding none + CocoaTable (a row opens the offer in a
// CocoaDrawer; «Pausar / Activar» is a row action) → the drawer is the create
// AND edit form (CocoaFormSection × 2, two footer buttons). Same API calls:
// listUpsellOffers · createUpsellOffer · patchUpsellOffer.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTabHost } from "../tabs/TabHost";
import { useActiveProperty } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import {
  createUpsellOffer,
  listUpsellOffers,
  patchUpsellOffer,
  toUpsellOfferInput,
  type UpsellOffer
} from "../../services/upsellsApi";
import { money, number, plural, toNumber } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

const DESCRIPTION =
  "Define qué se ofrece al huésped antes y durante la estancia (upgrade, parking, desayuno…), por qué canal y a qué precio. El portal, el kiosko y el panel de ventas adicionales leen este catálogo.";

const CATEGORIES: Array<{ value: string; label: string; defaultTaxCategory: string }> = [
  { value: "upgrade", label: "Upgrade de habitación", defaultTaxCategory: "accommodation" },
  { value: "early_checkin", label: "Check-in temprano", defaultTaxCategory: "accommodation" },
  { value: "late_checkout", label: "Check-out tardío", defaultTaxCategory: "accommodation" },
  { value: "breakfast", label: "Desayuno", defaultTaxCategory: "food_beverage" },
  { value: "parking", label: "Parking", defaultTaxCategory: "general_services" },
  { value: "spa", label: "Spa / wellness", defaultTaxCategory: "general_services" },
  { value: "transfer", label: "Traslado aeropuerto", defaultTaxCategory: "transport" },
  { value: "amenity", label: "Amenities", defaultTaxCategory: "general_services" },
  { value: "experience", label: "Experiencia local", defaultTaxCategory: "general_services" }
];

const CHANNELS = [
  { value: "pre_stay", label: "Pre-estancia (correo)" },
  { value: "in_stay", label: "Durante la estancia (app)" },
  { value: "checkout", label: "Al hacer check-out" },
  { value: "kiosk", label: "Kiosko self check-in" }
];

// Categorías fiscales del catálogo (packages/compliance/src/spain/indirect-tax.ts).
// El tipo concreto (10 % / 21 % IVA, 7 % IGIC, 2 % / 4 % IPSI) lo resuelve el API
// según la región fiscal de la propiedad; aquí solo se elige el concepto.
const TAX_CATEGORIES = [
  { value: "accommodation", label: "Alojamiento (tipo reducido de hostelería)" },
  { value: "food_beverage", label: "Restauración / F&B (tipo reducido de hostelería)" },
  { value: "general_services", label: "Servicios generales (spa, parking, salas… tipo general)" },
  { value: "transport", label: "Transporte de viajeros" },
  { value: "not_subject", label: "No sujeto (indemnizaciones)" }
];

function defaultTaxCategory(category: string): string {
  return CATEGORIES.find((c) => c.value === category)?.defaultTaxCategory ?? "general_services";
}

function categoryLabel(category: string): string {
  return CATEGORIES.find((c) => c.value === category)?.label ?? category;
}

function channelLabel(channel: string | null): string {
  if (!channel) return "—";
  return CHANNELS.find((c) => c.value === channel)?.label ?? channel;
}

/** Short fiscal label for the table («Alojamiento», «Transporte de viajeros»). */
function taxLabel(taxCategory: string | null): string {
  if (!taxCategory) return "—";
  const match = TAX_CATEGORIES.find((t) => t.value === taxCategory);
  return match ? match.label.split(" (")[0] : taxCategory;
}

// Form values travel as strings (Cocoa controls are string-controlled); the
// price is parsed on save.
type Draft = {
  id: string | null;
  code: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  category: string;
  active: boolean;
  channel: string;
  imageUrl: string;
  taxCategory: string;
};

type DraftErrors = Partial<Record<"name" | "price", string>>;

function newDraft(): Draft {
  return {
    id: null,
    code: "",
    name: "",
    description: "",
    price: "0",
    currency: "EUR",
    category: "upgrade",
    active: true,
    channel: "pre_stay",
    imageUrl: "",
    taxCategory: defaultTaxCategory("upgrade")
  };
}

function draftOf(offer: UpsellOffer): Draft {
  return {
    id: offer.id,
    code: offer.code,
    name: offer.name,
    description: offer.description ?? "",
    price: String(offer.price),
    currency: offer.currency,
    category: offer.category,
    active: offer.active,
    channel: offer.channel ?? "pre_stay",
    imageUrl: offer.imageUrl ?? "",
    taxCategory: offer.taxCategory ?? defaultTaxCategory(offer.category)
  };
}

function validate(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.name.trim()) errors.name = "El nombre de la oferta es obligatorio.";
  const price = toNumber(draft.price);
  if (price === null) errors.price = "Introduce un precio válido.";
  else if (price < 0) errors.price = "El precio no puede ser negativo.";
  return errors;
}

const COLUMNS: CocoaTableColumn<UpsellOffer>[] = [
  { key: "code", label: "Código", fit: true, render: (o) => <strong>{o.code || "—"}</strong> },
  { key: "name", label: FIELD_LABELS.name, minWidth: 160, render: (o) => o.name },
  { key: "category", label: "Categoría", hideOnNarrow: true, render: (o) => categoryLabel(o.category) },
  { key: "channel", label: FIELD_LABELS.channel, showFrom: "desktop", render: (o) => channelLabel(o.channel) },
  { key: "price", label: FIELD_LABELS.price, align: "right", fit: true, render: (o) => money(o.price, o.currency) },
  { key: "taxCategory", label: "Fiscal", showFrom: "desktop", render: (o) => taxLabel(o.taxCategory) },
  {
    key: "active",
    label: FIELD_LABELS.status,
    fit: true,
    render: (o) => <CocoaBadge tone={o.active ? "success" : "neutral"}>{o.active ? "activa" : "pausada"}</CocoaBadge>
  }
];

function CatalogueSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={3} />
      <CocoaSkeleton variant="card" height={240} />
    </div>
  );
}

export function UpsellsSettingsScreen() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const { propertyId, propertyName } = useActiveProperty();
  const [items, setItems] = useState<UpsellOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setItems(await listUpsellOffers(propertyId));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "No se pudo cargar el catálogo de ofertas adicionales.");
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const active = items.filter((i) => i.active).length;
    const channels = new Set(items.map((o) => o.channel ?? "any"));
    return { total: items.length, active, channels: channels.size };
  }, [items]);

  const newOfferLabel = newLabel("f", "oferta");
  const errors = editing ? validate(editing) : {};
  const valid = !errors.name && !errors.price;
  const fieldError = (key: keyof DraftErrors) => (touched ? errors[key] : undefined);

  function startNew() {
    setFailure(null);
    setTouched(false);
    setEditing(newDraft());
  }

  function startEdit(offer: UpsellOffer) {
    setFailure(null);
    setTouched(false);
    setEditing(draftOf(offer));
  }

  function closeDrawer() {
    if (busy) return;
    setEditing(null);
  }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setEditing((current) => (current ? { ...current, [key]: value } : current));
  }

  function changeCategory(category: string) {
    setEditing((current) => {
      if (!current) return current;
      // Keep the fiscal category in sync unless the user already overrode it.
      const prevDefault = defaultTaxCategory(current.category);
      const taxCategory = current.taxCategory && current.taxCategory !== prevDefault ? current.taxCategory : defaultTaxCategory(category);
      return { ...current, category, taxCategory };
    });
  }

  async function save() {
    if (!editing || busy) return;
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setFailure(null);
    try {
      const { id, ...fields } = editing;
      const input = toUpsellOfferInput({
        ...fields,
        price: toNumber(fields.price) ?? 0,
        description: fields.description || null,
        channel: fields.channel || null,
        imageUrl: fields.imageUrl || null,
        taxCategory: fields.taxCategory || null
      });
      if (id) await patchUpsellOffer(id, input);
      else await createUpsellOffer(propertyId, input);
      setEditing(null);
      showToast(id ? "Oferta actualizada" : "Oferta creada", { variant: "success" });
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo guardar la oferta.";
      setFailure(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(offer: UpsellOffer) {
    if (busy) return;
    setBusy(true);
    try {
      await patchUpsellOffer(offer.id, { active: !offer.active });
      showToast(offer.active ? `«${offer.name}» pausada` : `«${offer.name}» activada`, { variant: "success" });
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "No se pudo cambiar el estado de la oferta.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const ready = !loadError && items.length > 0;

  let body;
  if (loadError) {
    body = <CocoaState kind="error" title="No se pudo cargar el catálogo" message={loadError} onRetry={() => void load()} />;
  } else if (items.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration="box"
        title="Sin ofertas en esta propiedad"
        message="Aún no hay ofertas adicionales configuradas. Empieza con un upgrade o un late check-out: son los más rentables. Hasta que exista al menos una oferta activa, el panel de ventas adicionales y el portal del huésped no mostrarán nada."
        primaryAction={{ label: newOfferLabel, onClick: startNew }}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={items}
        rowKey="id"
        selectedKey={editing?.id ?? undefined}
        onSelect={startEdit}
        rowTitle={() => "Abrir la oferta para editarla"}
        rowActions={(o) => (
          <CocoaButton
            variant="plain"
            tone={o.active ? "neutral" : "accent"}
            size="small"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void toggleActive(o);
            }}
          >
            {o.active ? "Pausar" : ACTIONS.activate}
          </CocoaButton>
        )}
        caption="Catálogo de ofertas adicionales"
        aria-label="Catálogo de ofertas adicionales"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow={`Comercial · ${propertyName}`}
      title="Catálogo de ofertas adicionales"
      subtitle={hosted ? undefined : DESCRIPTION}
      actions={
        <CocoaButton variant="filled" tone="accent" size={hosted ? "small" : "regular"} onClick={startNew} disabled={busy}>
          {newOfferLabel}
        </CocoaButton>
      }
      state={loading && items.length === 0 && !loadError ? "loading" : "ready"}
      skeleton={<CatalogueSkeleton />}
      commands={[
        { id: "upsells-ofertas-nueva", label: newOfferLabel, run: startNew },
        { id: "upsells-ofertas-refresh", label: "Actualizar el catálogo de ofertas", run: () => void load() }
      ]}
    >
      <CocoaKpiStrip stagger aria-label="Resumen del catálogo">
        <CocoaKpi label="Ofertas totales" value={number(stats.total)} caption="en el catálogo" polarity="neutral" status="ok" degraded={Boolean(loadError)} />
        <CocoaKpi label="Activas" value={number(stats.active)} caption="vendibles ahora mismo" polarity="neutral" status={stats.active > 0 ? "ok" : "warning"} degraded={Boolean(loadError)} />
        <CocoaKpi label="Canales" value={number(stats.channels)} caption="canales distintos con oferta" polarity="neutral" status="ok" degraded={Boolean(loadError)} />
      </CocoaKpiStrip>

      <CocoaSection
        title="Catálogo"
        meta={ready ? plural(items.length, "oferta", "ofertas") : undefined}
        action={
          <CocoaButton variant="plain" tone="accent" size="small" onClick={() => void load()} loading={loading} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        }
        padding={ready ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {body}
      </CocoaSection>

      <CocoaDrawer
        open={editing !== null}
        onClose={closeDrawer}
        title={editing?.id ? "Editar oferta" : newOfferLabel}
        subtitle={editing?.id ? editing.name : undefined}
        side="right"
        size="lg"
        dismissible={!busy}
        focusKey={editing?.id ?? "new"}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={closeDrawer} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={busy} disabled={busy || (touched && !valid)}>
              {busy ? STATUS_LABELS.saving : ACTIONS.save}
            </CocoaButton>
          </>
        }
      >
        {editing ? (
          <div className="cocoa-stack" data-gap="4">
            {failure ? (
              <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.saveError}>
                {failure}
              </CocoaCallout>
            ) : null}

            <CocoaFormSection title="Oferta" description={DESCRIPTION}>
              <CocoaFormRow columns={2}>
                <CocoaField label="Código" hint={STATUS_LABELS.optional}>
                  <CocoaInput value={editing.code} onChange={(v) => set("code", v.toUpperCase())} placeholder="UPG-SUITE" maxLength={32} disabled={busy} />
                </CocoaField>
                <CocoaField label={FIELD_LABELS.name} required error={fieldError("name")}>
                  <CocoaInput value={editing.name} onChange={(v) => set("name", v)} disabled={busy} />
                </CocoaField>
                <CocoaField label="Categoría">
                  <CocoaSelect value={editing.category} onChange={changeCategory} options={CATEGORIES} disabled={busy} />
                </CocoaField>
                <CocoaField label={FIELD_LABELS.channel}>
                  <CocoaSelect value={editing.channel} onChange={(v) => set("channel", v)} options={CHANNELS} disabled={busy} />
                </CocoaField>
                <CocoaField label={FIELD_LABELS.description} fullWidth>
                  <CocoaInput value={editing.description} onChange={(v) => set("description", v)} multiline rows={2} disabled={busy} />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>

            <CocoaFormSection title="Precio e impuestos" description="El tipo concreto de IVA, IGIC o IPSI lo decide la región fiscal de la propiedad cuando la oferta se vende.">
              <CocoaFormRow columns={2}>
                <CocoaField label="Precio (impuestos incluidos)" required error={fieldError("price")}>
                  <CocoaInput value={editing.price} onChange={(v) => set("price", v)} inputMode="decimal" placeholder="0,00" disabled={busy} />
                </CocoaField>
                <CocoaField label={FIELD_LABELS.currency}>
                  <CocoaInput value={editing.currency} onChange={(v) => set("currency", v.toUpperCase())} maxLength={3} disabled={busy} />
                </CocoaField>
                <CocoaField label="Categoría fiscal" fullWidth>
                  <CocoaSelect value={editing.taxCategory} onChange={(v) => set("taxCategory", v)} options={TAX_CATEGORIES} disabled={busy} />
                </CocoaField>
                <CocoaField label="Imagen (URL)" fullWidth>
                  <CocoaInput value={editing.imageUrl} onChange={(v) => set("imageUrl", v)} type="url" inputMode="url" placeholder="https://…" disabled={busy} />
                </CocoaField>
                <CocoaField label="Oferta activa" inline help="Solo las ofertas activas se muestran al huésped.">
                  <CocoaSwitch checked={editing.active} onChange={(v) => set("active", v)} size="small" disabled={busy} />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}

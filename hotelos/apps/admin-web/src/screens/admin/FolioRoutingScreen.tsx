// Enrutamiento de folios — Finanzas › Facturación y cobros › Enrutamiento
// (/finanzas/facturacion/enrutamiento). Cocoa 22 · lote 6-A, archetype
// «formulario» (docs/design/COCOA-22.md §4, plantilla `Formulario`).
//
// Split folios and routing rules of ONE reservation:
//   1. pick the reservation (selector of the property's reservations, a typed
//      identifier, or `?reserva=` in the URL — FolioDetail links here);
//   2. see its folios (primary + secondary) and open a secondary one
//      (POST /reservations/:id/folios);
//   3. declare rules «every charge of type X goes to folio Y»
//      (POST /reservations/:id/routing-rules · DELETE /routing-rules/:id);
//   4. inspect the charges of every folio and transfer one by hand
//      (POST /folio-lines/:id/transfer).
// Reads GET /properties/:id/reservations, GET /reservations/:id/folios,
// GET /reservations/:id/routing-rules and GET /folios/:id/balance per folio.
// Hosted inside FacturacionTabs the container paints the head.

import { useEffect, useMemo, useState } from "react";
import {
  fetchReservationFolios,
  createSecondaryFolio,
  fetchRoutingRules,
  createRoutingRule,
  deleteRoutingRule,
  transferFolioLine,
  fetchFolioLines,
  type Folio,
  type FolioLine,
  type FolioRoutingRule
} from "../../services/folioRoutingApi";
import { fetchReservations, type AdminReservation } from "../../services/pmsCommerceApi";
import { chargeTypeLabel, routingSourceOptions } from "../../components/billing/charge-types";
import { financeErrorMessage } from "../../services/finance-contracts";
import { getActivePropertyId } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { date, dateTime, money, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, confirmDelete } from "../../content/actions";
import { folioDisplayName, folioLabelText } from "../../content/data-labels";
import { fillParams, urlForScreen } from "../../navigation/nav-tree";
import { useTabHost } from "../tabs/TabHost";
import {
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
  CocoaStepper,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";

const FOLIO_URL = urlForScreen("FolioDetail") ?? "/finanzas/facturacion/folios/:id";
// Reservations offered in the selector (most recent arrivals first; the API caps at 500).
const RESERVATION_PAGE_SIZE = 200;

// Charge types the router can match on ("*" is the catch-all); labels shared
// with FolioDetailScreen through components/billing/charge-types.
const SOURCE_TYPES: Array<{ value: string; label: string }> = routingSourceOptions();
const sourceTypeLabel = chargeTypeLabel;

function folioStatusLabel(status: string): string {
  return status === "open" ? "Abierto" : status === "closed" ? "Cerrado" : status;
}

/** `?reserva=` of the current URL (FolioDetail and BillingCenter link here with the reservation preselected). */
function reservationFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("reserva");
  return value && value.trim() ? value.trim() : null;
}

type FolioBucket = { lines: FolioLine[]; total: number; balanceDue: number };

export function FolioRoutingScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const propertyId = getActivePropertyId();

  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [reservationsError, setReservationsError] = useState<string | null>(null);
  const [selectedReservation, setSelectedReservation] = useState("");
  const [manualId, setManualId] = useState("");
  const [reservationId, setReservationId] = useState<string | null>(() => reservationFromUrl());

  const [folios, setFolios] = useState<Folio[]>([]);
  const [rules, setRules] = useState<FolioRoutingRule[]>([]);
  const [buckets, setBuckets] = useState<Record<string, FolioBucket>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newFolioLabel, setNewFolioLabel] = useState("");
  const [newFolioCurrency, setNewFolioCurrency] = useState("");
  const [ruleSource, setRuleSource] = useState("minibar");
  const [ruleTarget, setRuleTarget] = useState("");
  const [rulePriority, setRulePriority] = useState(100);
  const [ruleNotes, setRuleNotes] = useState("");
  const [ruleToDelete, setRuleToDelete] = useState<FolioRoutingRule | null>(null);
  const [transfer, setTransfer] = useState<{ line: FolioLine; from: Folio } | null>(null);
  const [transferTarget, setTransferTarget] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchReservations(propertyId, { limit: RESERVATION_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setReservations(page.items);
        setReservationsError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setReservationsError(financeErrorMessage(err, "No se pudieron cargar las reservas."));
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  async function loadAll(id: string) {
    setLoading(true);
    setError(null);
    try {
      const [folioList, ruleList] = await Promise.all([fetchReservationFolios(id), fetchRoutingRules(id)]);
      setFolios(folioList);
      setRules(ruleList);
      // Lines per folio, best effort: a folio whose balance fails shows «—».
      const results = await Promise.all(
        folioList.map((folio) =>
          fetchFolioLines(folio.id)
            .then((result) => ({ id: folio.id, bucket: { lines: result.lines, total: result.total, balanceDue: result.balanceDue } as FolioBucket }))
            .catch(() => null)
        )
      );
      const next: Record<string, FolioBucket> = {};
      for (const result of results) if (result) next[result.id] = result.bucket;
      setBuckets(next);
    } catch (err) {
      setFolios([]);
      setRules([]);
      setBuckets({});
      setError(financeErrorMessage(err, "No se pudieron cargar los folios de la reserva."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (reservationId) void loadAll(reservationId);
    else {
      setFolios([]);
      setRules([]);
      setBuckets({});
    }
  }, [reservationId]);

  const reservationOptions = useMemo(
    () =>
      reservations.map((reservation) => ({
        value: reservation.id,
        label: `${reservation.code} · ${reservation.bookerName ?? reservation.companyName ?? "Huésped"} · ${date(reservation.arrivalDate, "dayMonth")}`
      })),
    [reservations]
  );
  const selected = reservations.find((reservation) => reservation.id === reservationId) ?? null;
  const primary = folios.find((folio) => folio.isPrimary) ?? folios[0] ?? null;
  const secondaries = folios.filter((folio) => !folio.isPrimary);

  function openReservation() {
    const id = (manualId.trim() || selectedReservation).trim();
    if (!id) return;
    setReservationId(id);
  }

  async function run(label: string, action: () => Promise<unknown>, after?: () => void) {
    if (!reservationId) return;
    setBusy(true);
    try {
      await action();
      showToast(label, { variant: "success" });
      after?.();
      await loadAll(reservationId);
    } catch (err) {
      showToast(financeErrorMessage(err, "No se pudo completar la operación."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const folioLabel = (id: string | null | undefined): string => {
    if (!id) return "—";
    const folio = folios.find((candidate) => candidate.id === id);
    return folio ? folioDisplayName(folio) : id;
  };

  const folioColumns = useMemo<CocoaTableColumn<Folio>[]>(
    () => [
      { key: "label", label: "Folio", render: (folio) => <strong>{folioLabelText(folio.label)}</strong> },
      { key: "kind", label: FIELD_LABELS.type, render: (folio) => <CocoaBadge tone={folio.isPrimary ? "info" : "neutral"}>{folio.isPrimary ? "Principal" : "Secundario"}</CocoaBadge> },
      { key: "status", label: FIELD_LABELS.status, render: (folio) => <CocoaBadge tone={folio.status === "open" ? "success" : "neutral"}>{folioStatusLabel(folio.status)}</CocoaBadge> },
      { key: "currency", label: FIELD_LABELS.currency, render: (folio) => folio.currency, hideOnNarrow: true },
      { key: "total", label: "Cargos", align: "right", render: (folio) => (buckets[folio.id] ? money(buckets[folio.id].total, folio.currency) : "—") },
      { key: "balanceDue", label: "Pendiente", align: "right", render: (folio) => (buckets[folio.id] ? money(buckets[folio.id].balanceDue, folio.currency) : "—") }
    ],
    [buckets]
  );

  const ruleColumns = useMemo<CocoaTableColumn<FolioRoutingRule>[]>(
    () => [
      { key: "sourceType", label: "Origen", render: (rule) => <strong>{sourceTypeLabel(rule.sourceType)}</strong> },
      { key: "targetFolioId", label: "Folio destino", render: (rule) => folioLabel(rule.targetFolioId) },
      { key: "priority", label: "Prioridad", align: "right", render: (rule) => rule.priority, hideOnNarrow: true },
      { key: "active", label: FIELD_LABELS.status, render: (rule) => <CocoaBadge tone={rule.active ? "success" : "neutral"}>{rule.active ? "Activa" : "Pausada"}</CocoaBadge> },
      { key: "notes", label: FIELD_LABELS.notes, render: (rule) => rule.notes ?? "—", hideOnNarrow: true },
      { key: "createdAt", label: "Creada", render: (rule) => dateTime(rule.createdAt, { style: "dayMonth" }), hideOnNarrow: true }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folios]
  );

  const lineColumns = useMemo<CocoaTableColumn<FolioLine & { currency: string }>[]>(
    () => [
      { key: "type", label: FIELD_LABELS.type, render: (line) => sourceTypeLabel(line.type), hideOnNarrow: true },
      { key: "description", label: FIELD_LABELS.description, render: (line) => line.description },
      { key: "total", label: FIELD_LABELS.total, align: "right", render: (line) => <strong>{money(line.total, line.currency)}</strong> }
    ],
    []
  );

  const deleteCopy = confirmDelete(ruleToDelete ? `la regla «${sourceTypeLabel(ruleToDelete.sourceType)} → ${folioLabel(ruleToDelete.targetFolioId)}»` : "la regla");

  return (
    <CocoaPage
      eyebrow="Finanzas · Facturación y cobros"
      title="Enrutamiento de folios"
      subtitle={hosted ? undefined : "Divide los cargos de una reserva entre el huésped, la empresa o la agencia; las reglas envían cada nuevo cargo al folio adecuado."}
      actions={
        reservationId ? (
          <>
            <CocoaBadge tone="neutral">{selected ? selected.code : reservationId}</CocoaBadge>
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy || loading} onClick={() => void loadAll(reservationId)}>
              {ACTIONS.refresh}
            </CocoaButton>
            <CocoaButton
              variant="plain"
              tone="neutral"
              size="small"
              disabled={busy}
              onClick={() => {
                setReservationId(null);
                setSelectedReservation("");
                setManualId("");
              }}
            >
              Cambiar de reserva
            </CocoaButton>
          </>
        ) : undefined
      }
    >
      {!reservationId ? (
        <CocoaFormSection title="Reserva" description="Elige una reserva de la propiedad o indica su identificador.">
          <CocoaFormRow columns={2}>
            <CocoaField label={FIELD_LABELS.reservation} help={reservationsError ?? undefined}>
              <CocoaSelect value={selectedReservation} onChange={setSelectedReservation} options={reservationOptions} placeholder={reservations.length === 0 ? "Sin reservas cargadas" : "Elige una reserva"} disabled={reservations.length === 0} />
            </CocoaField>
            <CocoaField label="Identificador de la reserva" hint="opcional">
              <CocoaInput value={manualId} onChange={setManualId} placeholder="cmu1j7yem00amfywhevs8xvn4" autoComplete="off" onKeyDown={(event) => { if (event.key === "Enter") openReservation(); }} />
            </CocoaField>
          </CocoaFormRow>
          <div className="cocoa-row" data-gap="2" data-justify="end">
            <CocoaButton variant="filled" tone="accent" disabled={!manualId.trim() && !selectedReservation} onClick={openReservation}>
              Cargar folios
            </CocoaButton>
          </div>
        </CocoaFormSection>
      ) : loading && folios.length === 0 && !error ? (
        <CocoaSkeleton.Grid rows={[[12], [12]]} height={180} />
      ) : error ? (
        <CocoaSection aria-label="Error al cargar la reserva">
          <CocoaState kind="error" title="No se pudieron cargar los folios" message={error} onRetry={() => void loadAll(reservationId)} />
        </CocoaSection>
      ) : (
        <>
          <CocoaSection
            title="Folios de la reserva"
            meta={selected ? `${selected.code} · ${selected.bookerName ?? selected.companyName ?? ""}`.trim() : plural(folios.length, "folio", "folios")}
            padding={folios.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
          >
            {folios.length === 0 ? (
              <CocoaState kind="empty" inline title="Esta reserva todavía no tiene folios." message="El folio principal se crea al registrar el primer cargo o al hacer el check-in." />
            ) : (
              <CocoaTable
                columns={folioColumns}
                rows={folios}
                rowKey="id"
                caption="Folios de la reserva"
                aria-label="Folios de la reserva"
                onSelect={(folio) => openTabPath(fillParams(FOLIO_URL, { id: folio.id }))}
                rowActions={(folio) => (
                  <CocoaButton
                    variant="plain"
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      openTabPath(fillParams(FOLIO_URL, { id: folio.id }));
                    }}
                  >
                    {ACTIONS.view}
                  </CocoaButton>
                )}
              />
            )}
          </CocoaSection>

          <CocoaFormSection
            title="Nuevo folio secundario"
            description="Para la empresa, la agencia o un acompañante. Después, una regla o «Transferir» le envían sus cargos."
            actions={
              <CocoaButton
                variant="filled"
                tone="accent"
                size="small"
                disabled={busy || !newFolioLabel.trim()}
                onClick={() =>
                  void run(`Folio «${newFolioLabel.trim()}» creado.`, () => createSecondaryFolio(reservationId, { label: newFolioLabel.trim(), currency: newFolioCurrency.trim() || undefined }), () => {
                    setNewFolioLabel("");
                    setNewFolioCurrency("");
                  })
                }
              >
                Añadir folio
              </CocoaButton>
            }
          >
            <CocoaFormRow columns={2}>
              <CocoaField label="Etiqueta" required help="Por ejemplo «Empresa» o «Agencia».">
                <CocoaInput value={newFolioLabel} onChange={setNewFolioLabel} placeholder="Empresa" maxLength={80} autoComplete="off" disabled={busy} />
              </CocoaField>
              <CocoaField label={FIELD_LABELS.currency} hint="opcional" help={`Vacío: la del folio principal${primary ? ` (${primary.currency})` : ""}.`}>
                <CocoaInput value={newFolioCurrency} onChange={(value) => setNewFolioCurrency(value.toUpperCase())} placeholder={primary?.currency ?? ""} maxLength={3} autoComplete="off" disabled={busy} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaSection title="Reglas de enrutamiento" meta={plural(rules.length, "regla", "reglas")} padding={rules.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {rules.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin reglas activas." message="Cada regla mueve los nuevos cargos del folio principal al folio destino; si varias coinciden gana la de menor prioridad." />
            ) : (
              <CocoaTable
                columns={ruleColumns}
                rows={rules}
                rowKey="id"
                caption="Reglas de enrutamiento"
                aria-label="Reglas de enrutamiento"
                rowActions={(rule) => (
                  <CocoaButton
                    variant="plain"
                    tone="destructive"
                    size="small"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      setRuleToDelete(rule);
                    }}
                  >
                    {ACTIONS.delete}
                  </CocoaButton>
                )}
              />
            )}
          </CocoaSection>

          {secondaries.length === 0 ? (
            <CocoaCallout tone="info" title="Las reglas necesitan un folio secundario">
              Crea uno arriba (por ejemplo «Empresa») para poder enviarle cargos.
            </CocoaCallout>
          ) : (
            <CocoaFormSection
              title="Nueva regla"
              description="«Cualquier cargo» hace de comodín; una prioridad menor gana cuando varias reglas coinciden."
              actions={
                <CocoaButton
                  variant="filled"
                  tone="accent"
                  size="small"
                  disabled={busy || !ruleTarget}
                  onClick={() =>
                    void run(
                      `Regla añadida: ${sourceTypeLabel(ruleSource)} → ${folioLabel(ruleTarget)}.`,
                      () => createRoutingRule(reservationId, { sourceType: ruleSource, targetFolioId: ruleTarget, priority: rulePriority, notes: ruleNotes.trim() || undefined, active: true }),
                      () => setRuleNotes("")
                    )
                  }
                >
                  Añadir regla
                </CocoaButton>
              }
            >
              <CocoaFormRow columns={4} min={180}>
                <CocoaField label="Origen" required>
                  <CocoaSelect value={ruleSource} onChange={setRuleSource} options={SOURCE_TYPES} disabled={busy} />
                </CocoaField>
                <CocoaField label="Folio destino" required>
                  <CocoaSelect value={ruleTarget} onChange={setRuleTarget} placeholder="Elige un folio" options={secondaries.map((folio) => ({ value: folio.id, label: folioLabelText(folio.label) }))} disabled={busy} />
                </CocoaField>
                <CocoaField label="Prioridad" help="Menor gana.">
                  <CocoaStepper value={rulePriority} onChange={setRulePriority} min={1} max={999} step={10} disabled={busy} />
                </CocoaField>
                <CocoaField label={FIELD_LABELS.notes} hint="opcional">
                  <CocoaInput value={ruleNotes} onChange={setRuleNotes} placeholder="Acuerdo con la agencia" maxLength={200} autoComplete="off" disabled={busy} />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>
          )}

          {folios.length >= 2 ? (
            <CocoaGrid align="start" aria-label="Cargos por folio">
              {folios.map((folio) => {
                const bucket = buckets[folio.id];
                const rows = (bucket?.lines ?? []).map((line) => ({ ...line, currency: folio.currency }));
                return (
                  <CocoaSpan key={folio.id} cols={6} min={320}>
                    <CocoaSection
                      title={folioDisplayName(folio)}
                      meta={plural(rows.length, "cargo", "cargos")}
                      padding={rows.length > 0 ? "none" : "md"}
                      style={{ overflow: "clip" }}
                      footer={bucket ? <span>Cargos {money(bucket.total, folio.currency)} · pendiente {money(bucket.balanceDue, folio.currency)}</span> : undefined}
                    >
                      {!bucket ? (
                        <CocoaState kind="degraded" inline title="Saldo no disponible." />
                      ) : rows.length === 0 ? (
                        <CocoaState kind="empty" inline title="Sin cargos." />
                      ) : (
                        <CocoaTable
                          columns={lineColumns}
                          rows={rows}
                          rowKey="id"
                          caption={`Cargos del folio ${folioLabelText(folio.label)}`}
                          aria-label={`Cargos del folio ${folioLabelText(folio.label)}`}
                          rowActions={
                            folio.status === "open"
                              ? (line) => (
                                  <CocoaButton
                                    variant="plain"
                                    size="small"
                                    disabled={busy}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setTransferTarget(folios.find((candidate) => candidate.id !== folio.id && candidate.status === "open")?.id ?? "");
                                      setTransfer({ line, from: folio });
                                    }}
                                  >
                                    Transferir
                                  </CocoaButton>
                                )
                              : undefined
                          }
                        />
                      )}
                    </CocoaSection>
                  </CocoaSpan>
                );
              })}
            </CocoaGrid>
          ) : null}
        </>
      )}

      <CocoaDialog
        open={ruleToDelete !== null}
        onClose={() => setRuleToDelete(null)}
        tone="destructive"
        title={deleteCopy.title}
        description="Los cargos ya movidos se quedan donde están; solo dejan de enrutarse los nuevos."
        confirmLabel={busy ? "Eliminando…" : deleteCopy.confirmLabel}
        cancelLabel={deleteCopy.cancelLabel}
        busy={busy}
        onConfirm={() => (ruleToDelete ? run("Regla eliminada.", () => deleteRoutingRule(ruleToDelete.id), () => setRuleToDelete(null)) : undefined)}
      />

      <CocoaDialog
        open={transfer !== null}
        onClose={() => setTransfer(null)}
        title="Transferir cargo"
        description={transfer ? `${transfer.line.description} · ${money(transfer.line.total, transfer.from.currency)} · desde «${transfer.from.label}»` : undefined}
        confirmLabel={busy ? "Transfiriendo…" : "Transferir"}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={() => {
          if (!transfer || !transferTarget) {
            showToast("Elige el folio de destino.", { variant: "error" });
            return;
          }
          return run("Cargo transferido.", () => transferFolioLine(transfer.line.id, transferTarget), () => setTransfer(null));
        }}
      >
        <CocoaField label="Folio de destino" required>
          <CocoaSelect
            value={transferTarget}
            onChange={setTransferTarget}
            placeholder="Elige un folio"
            options={folios.filter((folio) => folio.id !== transfer?.from.id && folio.status === "open").map((folio) => ({ value: folio.id, label: folioDisplayName(folio) }))}
          />
        </CocoaField>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default FolioRoutingScreen;

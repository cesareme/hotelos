// Folio — Finanzas › Facturación y cobros › Folio (/finanzas/facturacion/folios/:id).
//
// Cocoa 22 pilot of the «detalle» archetype (docs/design/COCOA-22.md §4,
// plantilla `Detalle`): CocoaPage with a status badge and the folio actions
// in the header, inner views (Cargos · Cobros · Enrutamiento) as `tabs`,
// grid 8/4 (body + aside with CocoaStat) and Cocoa dialogs for every write:
//   · Cobrar → PaymentDialog (POST /folios/:id/payments, enum + clientRequestId)
//   · Devolver → RefundDialog (POST /payments/:id/refund; refund rows are
//     `kind: "refund"` in the balance and are never offered again)
//   · Dividir folio → POST /reservations/:id/folios (secondary folio)
//   · Mover cargo → POST /folios/:id/move-charges (one charge to a sibling)
//   · Cerrar folio → POST /folios/:id/close (only with balance 0)
// Reads GET /folios/:id/balance (payments carry kind / refundedAmount /
// methodCode), GET /reservations/:id/folios, GET /reservations/:id/routing-rules
// and, best effort, GET /reservations/:id for the reservation code (RES-xxxxx),
// holder and stay dates of the «Reserva» card (the folio only carries the id).
// Charge types are labelled by components/billing/charge-types (never raw);
// Tanda L3 · F1 adds the «Categoría fiscal» column (FolioLine.taxCategory,
// labelled by services/taxesApi TAX_CATEGORY_LABELS; the penalties posted by
// the cancellation engine — cancellation_fee / no_show_fee — read «no sujeto»).
// Hosted inside FacturacionTabs the `:id` comes from the sub-URL (the
// container remounts the screen per folio); standalone it reads the same
// route parameter. Without an id the page offers a lookup by identifier.

import { useEffect, useMemo, useState } from "react";
import { fetchReservationFolios, fetchRoutingRules, createSecondaryFolio, type Folio, type FolioLine, type FolioRoutingRule } from "../../services/folioRoutingApi";
import { fetchReservation, type AdminReservation, type FolioPaymentRow } from "../../services/pmsCommerceApi";
import { TAX_CATEGORY_LABELS, type TaxCategory } from "../../services/taxesApi";
import { apiRequest } from "../../services/api-client";
import { financeErrorMessage } from "../../services/finance-contracts";
import { getActivePropertyId } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { dateRange, dateTime, money, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS } from "../../content/actions";
import { folioDisplayName, folioLabelText } from "../../content/data-labels";
import { fillParams, urlForScreen } from "../../navigation/nav-tree";
import { useTabHost } from "../tabs/TabHost";
import { useRouteParam } from "../tabs/tab-helpers";
import { PaymentDialog } from "../../components/billing/PaymentDialog";
import { RefundDialog } from "../../components/billing/RefundDialog";
import { paymentKind, paymentKindLabel, paymentMethodLabel, paymentStatusLabel, paymentStatusTone, refundableAmount, refundablePayments } from "../../components/billing/payment-flow";
import { chargeTypeLabel } from "../../components/billing/charge-types";
import {
  CocoaBadge,
  CocoaButton,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";

const FOLIO_URL = urlForScreen("FolioDetail") ?? "/finanzas/facturacion/folios/:id";
const ROUTING_URL = urlForScreen("FolioRouting") ?? "/finanzas/facturacion/enrutamiento";

// GET /folios/:id/balance lines carry `taxCategory` (FolioLine.taxCategory,
// inferred by the API since L3-T when the writer sent none); the routing
// client type predates it, so it is widened here (Tanda L3 · F1).
type FolioLineRow = FolioLine & { taxCategory?: string | null };

type FolioBalanceResponse = {
  folio: Folio;
  lines: FolioLineRow[];
  payments: FolioPaymentRow[];
  chargesTotal: number;
  paymentsTotal: number;
  refundsTotal?: number;
  balanceDue: number;
};

type MoveChargesResponse = { ok: boolean; sourceFolioId: string; targetFolioId: string; moved: string[] };

type FolioView = "cargos" | "cobros" | "enrutamiento";

const VIEWS: Array<{ value: FolioView; label: string }> = [
  { value: "cargos", label: "Cargos" },
  { value: "cobros", label: "Cobros" },
  { value: "enrutamiento", label: "Enrutamiento" }
];

function folioStatusLabel(status: string): string {
  return status === "open" ? "Abierto" : status === "closed" ? "Cerrado" : status;
}

export interface FolioDetailScreenProps {
  /** Folio to show; when omitted the screen reads `:id` from the URL. */
  folioId?: string;
}

export function FolioDetailScreen({ folioId: folioIdProp }: FolioDetailScreenProps = {}) {
  const host = useTabHost();
  const hosted = host !== null;
  const { showToast } = useToast();
  const routeId = useRouteParam(FOLIO_URL, "id");
  const [manualId, setManualId] = useState<string | null>(null);
  const folioId = folioIdProp ?? routeId ?? manualId;

  const [balance, setBalance] = useState<FolioBalanceResponse | null>(null);
  const [siblings, setSiblings] = useState<Folio[]>([]);
  const [rules, setRules] = useState<FolioRoutingRule[]>([]);
  // Reservation behind the folio (code, holder, dates); null when unreadable.
  const [reservation, setReservation] = useState<AdminReservation | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(folioId));
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<FolioView>("cargos");
  const [busy, setBusy] = useState(false);

  const [lookup, setLookup] = useState("");
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [refundFor, setRefundFor] = useState<{ open: boolean; paymentId?: string }>({ open: false });
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitLabel, setSplitLabel] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [moveLine, setMoveLine] = useState<FolioLineRow | null>(null);
  const [moveTarget, setMoveTarget] = useState("");

  async function load(id: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<FolioBalanceResponse>(`/folios/${id}/balance`);
      setBalance(response);
      // Siblings, rules and the reservation are best effort: they never block
      // the balance (a role without pms.reservation.read keeps the raw id).
      const reservationId = response.folio.reservationId;
      const [folios, ruleList, booking] = await Promise.all([
        fetchReservationFolios(reservationId).catch(() => [] as Folio[]),
        fetchRoutingRules(reservationId).catch(() => [] as FolioRoutingRule[]),
        fetchReservation(reservationId).catch(() => null)
      ]);
      setSiblings(folios.filter((folio) => folio.id !== id));
      setRules(ruleList);
      setReservation(booking);
    } catch (err) {
      setBalance(null);
      setReservation(null);
      setError(financeErrorMessage(err, "No se pudo cargar el folio."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (folioId) void load(folioId);
    else {
      setBalance(null);
      setReservation(null);
      setLoading(false);
    }
  }, [folioId]);

  const folio = balance?.folio ?? null;
  const currency = folio?.currency;
  const lines = balance?.lines ?? [];
  const payments = balance?.payments ?? [];
  const refundable = useMemo(() => refundablePayments(payments), [payments]);
  const isOpen = folio?.status === "open";
  const balanceDue = balance?.balanceDue ?? 0;

  function openFolio(id: string) {
    const trimmed = id.trim();
    if (!trimmed) return;
    if (hosted) openTabPath(fillParams(FOLIO_URL, { id: trimmed }));
    else setManualId(trimmed);
  }

  async function run(label: string, action: () => Promise<unknown>, after?: () => void) {
    if (!folioId) return;
    setBusy(true);
    try {
      await action();
      showToast(label, { variant: "success" });
      after?.();
      await load(folioId);
    } catch (err) {
      showToast(financeErrorMessage(err, "No se pudo completar la operación."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const chargeColumns = useMemo<CocoaTableColumn<FolioLineRow>[]>(
    () => [
      { key: "description", label: FIELD_LABELS.description, render: (line) => <strong>{line.description}</strong> },
      { key: "type", label: FIELD_LABELS.type, render: (line) => chargeTypeLabel(line.type), hideOnNarrow: true },
      {
        key: "taxCategory",
        label: "Categoría fiscal",
        hideOnNarrow: true,
        render: (line) =>
          line.taxCategory && line.taxCategory in TAX_CATEGORY_LABELS ? (
            <CocoaBadge tone={line.taxCategory === "not_subject" ? "info" : "neutral"} size="small" uppercase={false}>
              {TAX_CATEGORY_LABELS[line.taxCategory as TaxCategory]}
            </CocoaBadge>
          ) : (
            <CocoaBadge tone="warning" size="small" uppercase={false} title="Línea anterior a la inferencia fiscal: la categoría se resuelve por el tipo al facturar">
              por tipo al facturar
            </CocoaBadge>
          )
      },
      { key: "quantity", label: "Cantidad × precio", align: "right", render: (line) => `${line.quantity} × ${money(line.unitPrice, currency)}`, hideOnNarrow: true },
      { key: "postedAt", label: FIELD_LABELS.date, render: (line) => dateTime(line.postedAt, { style: "dayMonth" }), hideOnNarrow: true },
      { key: "total", label: FIELD_LABELS.total, align: "right", render: (line) => <strong>{money(line.total, currency)}</strong> }
    ],
    [currency]
  );

  const paymentColumns = useMemo<CocoaTableColumn<FolioPaymentRow>[]>(
    () => [
      { key: "createdAt", label: FIELD_LABELS.date, render: (row) => dateTime(row.createdAt ?? row.capturedAt, { style: "dayMonth" }), hideOnNarrow: true },
      {
        key: "kind",
        label: "Movimiento",
        render: (row) => {
          const kind = paymentKind(row);
          return <CocoaBadge tone={kind === "refund" ? "info" : "neutral"}>{paymentKindLabel(kind)}</CocoaBadge>;
        }
      },
      { key: "method", label: "Método", render: (row) => paymentMethodLabel(row.method, row.methodCode) },
      { key: "pspReference", label: "Referencia", render: (row) => row.pspReference ?? "—", hideOnNarrow: true },
      {
        key: "status",
        label: FIELD_LABELS.status,
        render: (row) => {
          const kind = paymentKind(row);
          const refunded = kind === "capture" && (row.refundedAmount ?? 0) > 0 && refundableAmount(row) > 0;
          return (
            <span className="cocoa-cluster">
              <CocoaBadge tone={paymentStatusTone(row.status, kind)}>{paymentStatusLabel(row.status)}</CocoaBadge>
              {refunded ? <CocoaBadge tone="warning">devuelto {money(row.refundedAmount, row.currency || currency)}</CocoaBadge> : null}
            </span>
          );
        }
      },
      {
        key: "amount",
        label: FIELD_LABELS.amount,
        align: "right",
        render: (row) => <strong>{paymentKind(row) === "refund" ? `−${money(row.amount, row.currency || currency)}` : money(row.amount, row.currency || currency)}</strong>
      }
    ],
    [currency]
  );

  const ruleColumns = useMemo<CocoaTableColumn<FolioRoutingRule>[]>(
    () => [
      { key: "sourceType", label: "Origen", render: (rule) => <strong>{chargeTypeLabel(rule.sourceType)}</strong> },
      {
        key: "targetFolioId",
        label: "Folio destino",
        render: (rule) => {
          const target = rule.targetFolioId === folioId ? folio : siblings.find((candidate) => candidate.id === rule.targetFolioId);
          return target ? folioDisplayName(target) : rule.targetFolioId;
        }
      },
      { key: "priority", label: "Prioridad", align: "right", render: (rule) => rule.priority, hideOnNarrow: true },
      { key: "active", label: FIELD_LABELS.status, render: (rule) => <CocoaBadge tone={rule.active ? "success" : "neutral"}>{rule.active ? "Activa" : "Pausada"}</CocoaBadge> }
    ],
    [folioId, folio, siblings]
  );

  const title = folio ? `Folio ${folioLabelText(folio.label, folio.isPrimary ? "principal" : folio.id)}` : "Folio";
  // RES-xxxxx when the reservation is readable; the internal id only as a fallback.
  const reservationRef = reservation?.code ?? folio?.reservationId ?? "";
  const reservationHolder = reservation ? (reservation.bookerName?.trim() || reservation.companyName?.trim() || reservation.travelAgentName?.trim() || null) : null;
  const reservationStay = reservation ? dateRange(reservation.arrivalDate, reservation.departureDate, { style: "dayMonth" }) : null;
  const subtitle = folio ? `Reserva ${reservationRef} · ${plural(lines.length, "cargo", "cargos")} · ${plural(payments.length, "movimiento de caja", "movimientos de caja")}` : "Cargos, cobros y devoluciones de un folio.";
  const reservationUrl = folio ? urlForScreen("ReservationDetailWorkspace", { id: folio.reservationId }) : null;
  const routingUrl = folio ? `${ROUTING_URL}?reserva=${encodeURIComponent(folio.reservationId)}` : ROUTING_URL;

  const pageState = !folioId ? "ready" : loading && !balance ? "loading" : error && !balance ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow="Finanzas · Facturación y cobros"
      title={title}
      subtitle={hosted ? undefined : subtitle}
      tabs={folio ? VIEWS : undefined}
      activeTab={view}
      onTabChange={(value) => setView(value as FolioView)}
      actions={
        folio ? (
          <>
            <CocoaBadge tone={isOpen ? "success" : "neutral"}>{folioStatusLabel(folio.status)}</CocoaBadge>
            {folio.isPrimary ? <CocoaBadge tone="info">Principal</CocoaBadge> : null}
            <CocoaButton variant="filled" tone="accent" size="small" disabled={busy || !isOpen} onClick={() => setPaymentOpen(true)}>
              Cobrar
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy || refundable.length === 0} onClick={() => setRefundFor({ open: true })}>
              Devolver
            </CocoaButton>
            <CocoaButton variant="plain" tone="neutral" size="small" disabled={busy || !isOpen} onClick={() => { setSplitLabel(""); setSplitOpen(true); }}>
              Dividir folio
            </CocoaButton>
            <CocoaButton
              variant="bordered"
              tone="destructive"
              size="small"
              disabled={busy || !isOpen || balanceDue !== 0}
              title={!isOpen ? "El folio ya está cerrado" : balanceDue !== 0 ? "Solo se cierra con saldo cero" : undefined}
              onClick={() => setCloseOpen(true)}
            >
              Cerrar folio
            </CocoaButton>
          </>
        ) : undefined
      }
      state={pageState}
      skeleton={<CocoaSkeleton.Grid rows={[[8, 4]]} height={280} />}
      error={{ title: "No se pudo cargar el folio", message: error ?? undefined, onRetry: () => (folioId ? void load(folioId) : undefined) }}
      commands={folio && isOpen ? [{ id: "folio-cobrar", label: `Cobrar en ${title}`, run: () => setPaymentOpen(true) }] : undefined}
    >
      {!folioId ? (
        <CocoaSection title="Abrir un folio" aria-label="Abrir un folio">
          <p>Los folios se abren desde Facturación y cobros (reserva → folio) o desde la ficha de la reserva. También puedes indicar su identificador.</p>
          <CocoaFormRow columns={2} min={240}>
            <CocoaField label="Identificador del folio">
              <CocoaInput value={lookup} onChange={setLookup} placeholder="cmu1j7yer00aqfywhw1d0hh6x" autoComplete="off" onKeyDown={(event) => { if (event.key === "Enter") openFolio(lookup); }} />
            </CocoaField>
          </CocoaFormRow>
          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="filled" tone="accent" disabled={!lookup.trim()} onClick={() => openFolio(lookup)}>
              Abrir folio
            </CocoaButton>
            <CocoaButton variant="plain" tone="neutral" onClick={() => openTabPath(urlForScreen("BillingCenter") ?? "/finanzas/facturacion")}>
              Ir a Facturación y cobros
            </CocoaButton>
          </div>
        </CocoaSection>
      ) : folio ? (
        <CocoaGrid align="start" aria-label="Detalle del folio">
          <CocoaSpan cols={8} min={480}>
            {view === "cargos" ? (
              <CocoaSection
                title="Cargos"
                meta={plural(lines.length, "línea", "líneas")}
                padding={lines.length > 0 ? "none" : "md"}
                style={{ overflow: "clip" }}
                footer={lines.length > 0 ? <span>Total cargos {money(balance?.chargesTotal, currency)}</span> : undefined}
              >
                {lines.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin cargos registrados." />
                ) : (
                  <CocoaTable
                    columns={chargeColumns}
                    rows={lines}
                    rowKey="id"
                    caption="Cargos del folio"
                    aria-label="Cargos del folio"
                    rowActions={
                      siblings.length > 0 && isOpen
                        ? (line) => (
                            <CocoaButton
                              variant="plain"
                              size="small"
                              disabled={busy}
                              onClick={(event) => {
                                event.stopPropagation();
                                setMoveTarget(siblings[0]?.id ?? "");
                                setMoveLine(line);
                              }}
                            >
                              Mover
                            </CocoaButton>
                          )
                        : undefined
                    }
                  />
                )}
              </CocoaSection>
            ) : null}

            {view === "cobros" ? (
              <CocoaSection
                title="Cobros y devoluciones"
                meta={plural(payments.length, "movimiento", "movimientos")}
                padding={payments.length > 0 ? "none" : "md"}
                style={{ overflow: "clip" }}
                action={
                  isOpen ? (
                    <CocoaButton variant="plain" size="small" onClick={() => setPaymentOpen(true)}>
                      Cobrar
                    </CocoaButton>
                  ) : undefined
                }
                footer={payments.length > 0 ? <span>Cobrado neto {money(balance?.paymentsTotal, currency)}{(balance?.refundsTotal ?? 0) > 0 ? ` · devuelto ${money(balance?.refundsTotal, currency)}` : ""}</span> : undefined}
              >
                {payments.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin cobros registrados." message={isOpen ? "Registra el primero con «Cobrar»." : undefined} />
                ) : (
                  <CocoaTable
                    columns={paymentColumns}
                    rows={payments}
                    rowKey="id"
                    caption="Cobros y devoluciones del folio"
                    aria-label="Cobros y devoluciones del folio"
                    rowTone={(row) => (paymentKind(row) === "refund" ? "info" : undefined)}
                    rowActions={(row) =>
                      refundableAmount(row) > 0 ? (
                        <CocoaButton
                          variant="plain"
                          size="small"
                          disabled={busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            setRefundFor({ open: true, paymentId: row.id });
                          }}
                        >
                          Devolver
                        </CocoaButton>
                      ) : null
                    }
                  />
                )}
              </CocoaSection>
            ) : null}

            {view === "enrutamiento" ? (
              <CocoaSection
                title="Reglas de enrutamiento"
                meta={plural(rules.length, "regla", "reglas")}
                padding={rules.length > 0 ? "none" : "md"}
                style={{ overflow: "clip" }}
                action={
                  <CocoaButton variant="plain" size="small" onClick={() => openTabPath(routingUrl)}>
                    Gestionar reglas
                  </CocoaButton>
                }
              >
                {rules.length === 0 ? (
                  <CocoaState
                    kind="empty"
                    inline
                    title="Sin reglas para esta reserva."
                    message="Las reglas envían cada nuevo cargo (minibar, restauración…) al folio de la empresa o de la agencia."
                  />
                ) : (
                  <CocoaTable columns={ruleColumns} rows={rules} rowKey="id" caption="Reglas de enrutamiento de la reserva" aria-label="Reglas de enrutamiento de la reserva" />
                )}
              </CocoaSection>
            ) : null}
          </CocoaSpan>

          <CocoaSpan cols={4} min={240}>
            <div className="cocoa-stack" data-gap="3">
              <CocoaSection title="Saldo" meta={isOpen ? (balanceDue > 0 ? "pendiente de cobro" : balanceDue < 0 ? "a favor del cliente" : "liquidado") : "folio cerrado"}>
                <div className="cocoa-stack" data-gap="3">
                  <CocoaStat label="Saldo pendiente" value={money(balanceDue, currency)} tone={balanceDue > 0 ? "warning" : balanceDue < 0 ? "info" : "success"} size="large" />
                  <CocoaStat label="Cargos" value={money(balance?.chargesTotal, currency)} hint={plural(lines.length, "línea", "líneas")} />
                  <CocoaStat label="Cobrado neto" value={money(balance?.paymentsTotal, currency)} hint={(balance?.refundsTotal ?? 0) > 0 ? `Devuelto ${money(balance?.refundsTotal, currency)}` : undefined} />
                </div>
              </CocoaSection>

              <CocoaSection title="Reserva" meta={reservationRef}>
                <div className="cocoa-stack" data-gap="2">
                  {reservation ? (
                    <p>
                      {reservationHolder ? <strong>{reservationHolder}</strong> : null}
                      {reservationHolder && reservationStay ? " · " : null}
                      {reservationStay}
                    </p>
                  ) : null}
                  <div className="cocoa-row" data-gap="2">
                    {reservationUrl ? (
                      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openTabPath(reservationUrl)}>
                        Abrir reserva
                      </CocoaButton>
                    ) : null}
                    <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => openTabPath(urlForScreen("BillingCenter") ?? "/finanzas/facturacion")}>
                      Facturación y cobros
                    </CocoaButton>
                  </div>
                </div>
              </CocoaSection>

              <CocoaSection title="Otros folios de la reserva" meta={plural(siblings.length, "folio", "folios")}>
                {siblings.length === 0 ? (
                  <CocoaState kind="empty" inline title="Solo hay un folio." message={isOpen ? "Divide el folio para separar los cargos de la empresa o de un acompañante." : undefined} />
                ) : (
                  <ul className="c22-section__list">
                    {siblings.map((sibling) => (
                      <li key={sibling.id}>
                        <span className="cocoa-cluster">
                          <strong>{folioLabelText(sibling.label)}</strong>
                          <CocoaBadge tone={sibling.status === "open" ? "success" : "neutral"} size="small">
                            {folioStatusLabel(sibling.status)}
                          </CocoaBadge>
                          {sibling.isPrimary ? (
                            <CocoaBadge tone="info" size="small">
                              Principal
                            </CocoaBadge>
                          ) : null}
                        </span>
                        <CocoaButton variant="plain" size="small" onClick={() => openFolio(sibling.id)}>
                          {ACTIONS.view}
                        </CocoaButton>
                      </li>
                    ))}
                  </ul>
                )}
              </CocoaSection>
            </div>
          </CocoaSpan>
        </CocoaGrid>
      ) : null}

      {folio ? (
        <>
          <PaymentDialog
            open={paymentOpen}
            onClose={() => setPaymentOpen(false)}
            folioId={folio.id}
            propertyId={getActivePropertyId()}
            currency={folio.currency}
            balanceDue={balanceDue}
            subject={title}
            onCaptured={() => {
              logBreadcrumb("folio.payment.captured", "mutation", { folioId: folio.id });
              void load(folio.id);
            }}
            onIntent={() => logBreadcrumb("folio.payment.intent", "mutation", { folioId: folio.id })}
          />
          <RefundDialog
            open={refundFor.open}
            onClose={() => setRefundFor({ open: false })}
            payments={payments}
            initialPaymentId={refundFor.paymentId}
            currency={folio.currency}
            onRefunded={() => {
              logBreadcrumb("folio.payment.refunded", "mutation", { folioId: folio.id });
              void load(folio.id);
            }}
          />

          <CocoaDialog
            open={splitOpen}
            onClose={() => setSplitOpen(false)}
            title="Dividir folio"
            description="Crea un folio secundario en la misma reserva. Después mueve a él los cargos que correspondan o define una regla de enrutamiento."
            confirmLabel={busy ? "Creando…" : "Crear folio"}
            cancelLabel={ACTIONS.cancel}
            busy={busy}
            initialFocus={() => document.getElementById("folio-split-label")}
            onConfirm={async () => {
              const label = splitLabel.trim();
              if (!label) {
                showToast("Indica una etiqueta para el folio nuevo.", { variant: "error" });
                return;
              }
              await run(`Folio «${label}» creado.`, () => createSecondaryFolio(folio.reservationId, { label, currency: folio.currency }), () => setSplitOpen(false));
            }}
          >
            <CocoaField label="Etiqueta del folio nuevo" required help="Por ejemplo «Empresa», «Agencia» o el nombre del acompañante.">
              <CocoaInput id="folio-split-label" value={splitLabel} onChange={setSplitLabel} placeholder="Empresa" maxLength={80} autoComplete="off" />
            </CocoaField>
          </CocoaDialog>

          <CocoaDialog
            open={closeOpen}
            onClose={() => setCloseOpen(false)}
            tone="destructive"
            title={`¿Cerrar el folio ${folioLabelText(folio.label, folio.isPrimary ? "principal" : folio.id)}?`}
            description="Un folio cerrado no admite más cargos ni cobros. Solo se cierra con saldo cero."
            confirmLabel={busy ? "Cerrando…" : "Cerrar folio"}
            cancelLabel={ACTIONS.cancel}
            busy={busy}
            onConfirm={() => run("Folio cerrado.", () => apiRequest<{ ok: boolean }>(`/folios/${folio.id}/close`, { method: "POST" }), () => setCloseOpen(false))}
          />

          <CocoaDialog
            open={moveLine !== null}
            onClose={() => setMoveLine(null)}
            title="Mover cargo a otro folio"
            description={moveLine ? `${moveLine.description} · ${money(moveLine.total, currency)}` : undefined}
            confirmLabel={busy ? "Moviendo…" : "Mover"}
            cancelLabel={ACTIONS.cancel}
            busy={busy}
            onConfirm={async () => {
              if (!moveLine || !moveTarget) {
                showToast("Elige el folio de destino.", { variant: "error" });
                return;
              }
              await run(
                "Cargo movido.",
                () => apiRequest<MoveChargesResponse>(`/folios/${folio.id}/move-charges`, { method: "POST", body: { chargeIds: [moveLine.id], targetFolioId: moveTarget } }),
                () => setMoveLine(null)
              );
            }}
          >
            <CocoaField label="Folio de destino" required>
              <CocoaSelect
                value={moveTarget}
                onChange={setMoveTarget}
                placeholder="Elige un folio"
                options={siblings.filter((sibling) => sibling.status === "open").map((sibling) => ({ value: sibling.id, label: folioDisplayName(sibling) }))}
              />
            </CocoaField>
          </CocoaDialog>
        </>
      ) : null}
    </CocoaPage>
  );
}

export default FolioDetailScreen;

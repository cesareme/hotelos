// FolioDetailScreen — DEV FOLIO1
//
// Workspace para un folio concreto con cuatro pestañas:
//   • Cargos: lista de FolioLines con drag-and-drop nativo. El usuario puede
//     arrastrar uno o varios cargos seleccionados sobre otro folio visible
//     (lista lateral de "otros folios" de la misma reserva). Al soltar se
//     dispara PATCH /folios/:sourceId/move-charges con el array chargeIds[].
//   • Pagos: lista de pagos capturados con totales y balance.
//   • Routing rules: lista de reglas + botón Nueva regla (placeholder).
//   • Notas: textarea libre persistida en sessionStorage como fallback.
//
// El header (CocoaPageHeader) muestra título / subtítulo y acciones de alto
// nivel (Split folio + Cerrar folio). El balance pendiente vive en un
// CocoaCard variant="elevated" debajo del header.
//
// useToast da feedback a todas las mutaciones. El typecheck se ejecuta vía
// `npm run typecheck` en apps/admin-web.

import { useEffect, useMemo, useState, type CSSProperties, type DragEvent } from "react";
import {
  fetchReservationFolios,
  fetchRoutingRules,
  createSecondaryFolio,
  type Folio,
  type FolioLine,
  type FolioRoutingRule
} from "../../services/folioRoutingApi";
import { apiRequest } from "../../services/api-client";
import { useToast } from "../../components/Toast";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaSegmentedControl } from "../../components/cocoa/CocoaSegmentedControl";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaInput } from "../../components/cocoa/CocoaInput";

type FolioTab = "charges" | "payments" | "routing" | "notes";

type PaymentRecord = {
  id: string;
  amount: number;
  currency: string;
  method: string;
  status: string;
  pspReference?: string;
  capturedAt?: string;
};

type FolioBalanceResponse = {
  folio: Folio;
  lines: FolioLine[];
  payments: PaymentRecord[];
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};

type MoveChargesResponse = {
  ok: boolean;
  sourceFolioId: string;
  targetFolioId: string;
  moved: string[];
};

function fmtMoney(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

function noteStorageKey(folioId: string): string {
  return `hotelos.folio.note.${folioId}`;
}

function readNote(folioId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(noteStorageKey(folioId)) ?? "";
  } catch {
    return "";
  }
}

function writeNote(folioId: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(noteStorageKey(folioId), value);
  } catch {
    /* ignore quota errors */
  }
}

export interface FolioDetailScreenProps {
  /**
   * ID del folio a mostrar. Si no se pasa, el screen intenta leerlo del
   * hash de la URL (#folio=fol_xxx) para soportar deep-linking sin router.
   */
  folioId?: string;
}

export function FolioDetailScreen({ folioId: folioIdProp }: FolioDetailScreenProps = {}) {
  const { showToast } = useToast();

  const initialFolioId = useMemo<string | null>(() => {
    if (folioIdProp) return folioIdProp;
    if (typeof window === "undefined") return null;
    const match = window.location.hash.match(/folio=([\w-]+)/);
    return match?.[1] ?? null;
  }, [folioIdProp]);

  const [folioId, setFolioId] = useState<string | null>(initialFolioId);
  const [folio, setFolio] = useState<Folio | null>(null);
  const [lines, setLines] = useState<FolioLine[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [chargesTotal, setChargesTotal] = useState<number>(0);
  const [paymentsTotal, setPaymentsTotal] = useState<number>(0);
  const [balanceDue, setBalanceDue] = useState<number>(0);
  const [siblingFolios, setSiblingFolios] = useState<Folio[]>([]);
  const [rules, setRules] = useState<FolioRoutingRule[]>([]);
  const [activeTab, setActiveTab] = useState<FolioTab>("charges");
  const [note, setNote] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  // Drag selection (multi-select cargos antes de arrastrar).
  const [selectedChargeIds, setSelectedChargeIds] = useState<Set<string>>(new Set());
  const [draggedChargeIds, setDraggedChargeIds] = useState<string[]>([]);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Diálogos placeholder.
  const [splitOpen, setSplitOpen] = useState<boolean>(false);
  const [splitLabel, setSplitLabel] = useState<string>("");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState<boolean>(false);

  // Lookup manual cuando el screen se monta sin folioId.
  const [folioLookup, setFolioLookup] = useState<string>("");

  async function loadFolio(id: string) {
    setLoading(true);
    setError(null);
    try {
      const balance = await apiRequest<FolioBalanceResponse>(`/folios/${id}/balance`);
      setFolio(balance.folio);
      setLines(balance.lines);
      setPayments(balance.payments ?? []);
      setChargesTotal(balance.chargesTotal);
      setPaymentsTotal(balance.paymentsTotal);
      setBalanceDue(balance.balanceDue);
      setNote(readNote(id));

      // Folios hermanos (drop targets) y reglas — best-effort, no bloquean.
      const reservationId = balance.folio.reservationId;
      const [siblings, ruleList] = await Promise.all([
        fetchReservationFolios(reservationId).catch(() => [] as Folio[]),
        fetchRoutingRules(reservationId).catch(() => [] as FolioRoutingRule[])
      ]);
      setSiblingFolios(siblings.filter((f) => f.id !== id));
      setRules(ruleList);
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo cargar el folio";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (folioId) void loadFolio(folioId);
  }, [folioId]);

  function handleLookup() {
    const id = folioLookup.trim();
    if (!id) {
      showToast("Indica un ID de folio", { variant: "error" });
      return;
    }
    setFolioId(id);
  }

  function toggleSelect(chargeId: string) {
    setSelectedChargeIds((current) => {
      const next = new Set(current);
      if (next.has(chargeId)) next.delete(chargeId);
      else next.add(chargeId);
      return next;
    });
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, chargeId: string) {
    // Si la fila arrastrada no estaba seleccionada, arrastramos solo esa.
    const ids = selectedChargeIds.has(chargeId)
      ? Array.from(selectedChargeIds)
      : [chargeId];
    setDraggedChargeIds(ids);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-hotelos-charges", JSON.stringify(ids));
    event.dataTransfer.setData("text/plain", ids.join(","));
    logBreadcrumb("folio.charge.dragStart", "ui", { count: ids.length });
  }

  function handleDragEnd() {
    setDraggedChargeIds([]);
    setDropTargetId(null);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, targetFolioId: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropTargetId !== targetFolioId) setDropTargetId(targetFolioId);
  }

  function handleDragLeave(targetFolioId: string) {
    if (dropTargetId === targetFolioId) setDropTargetId(null);
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>, targetFolioId: string) {
    event.preventDefault();
    setDropTargetId(null);
    if (!folioId) return;
    let chargeIds: string[] = [];
    try {
      const raw = event.dataTransfer.getData("application/x-hotelos-charges");
      if (raw) chargeIds = JSON.parse(raw) as string[];
    } catch {
      /* fall back to dragged state */
    }
    if (chargeIds.length === 0) chargeIds = draggedChargeIds;
    if (chargeIds.length === 0) {
      showToast("No hay cargos seleccionados para mover", { variant: "info" });
      return;
    }
    setBusy(true);
    logBreadcrumb("folio.charges.move", "mutation", {
      sourceFolioId: folioId,
      targetFolioId,
      count: chargeIds.length
    });
    try {
      await apiRequest<MoveChargesResponse>(`/folios/${folioId}/move-charges`, {
        method: "POST",
        body: { chargeIds, targetFolioId }
      });
      showToast(`Movidos ${chargeIds.length} cargo(s) al folio destino`, { variant: "success" });
      setSelectedChargeIds(new Set());
      setDraggedChargeIds([]);
      await loadFolio(folioId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudieron mover los cargos";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function handleNoteChange(value: string) {
    setNote(value);
    if (folioId) writeNote(folioId, value);
  }

  function handleNoteSave() {
    if (!folioId) return;
    logBreadcrumb("folio.note.save", "mutation", { folioId });
    showToast("Nota guardada (sessionStorage; persistencia backend pendiente)", { variant: "success" });
  }

  function openSplitDialog() {
    setSplitLabel("");
    setSplitOpen(true);
  }

  async function confirmSplit() {
    if (!folio) return;
    const label = splitLabel.trim();
    if (!label) {
      showToast("Indica una etiqueta para el folio nuevo", { variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const created = await createSecondaryFolio(folio.reservationId, {
        label,
        currency: folio.currency
      });
      showToast(`Folio "${created.label}" creado`, { variant: "success" });
      setSplitOpen(false);
      if (folioId) await loadFolio(folioId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo crear el folio";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function openCloseDialog() {
    if (balanceDue !== 0) {
      showToast("El folio debe tener saldo 0 para cerrarse", { variant: "error" });
      return;
    }
    setCloseConfirmOpen(true);
  }

  async function confirmClose() {
    if (!folioId) return;
    setBusy(true);
    logBreadcrumb("folio.close", "mutation", { folioId });
    try {
      await apiRequest<{ ok: boolean }>(`/folios/${folioId}/close`, { method: "POST" });
      showToast("Folio cerrado", { variant: "success" });
      setCloseConfirmOpen(false);
      await loadFolio(folioId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo cerrar el folio";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function handleNewRulePlaceholder() {
    logBreadcrumb("folio.routing.newRule.intent", "ui", { folioId });
    showToast("Editor de reglas de routing: disponible en pantalla dedicada", { variant: "info" });
  }

  const currency = folio?.currency ?? "EUR";

  const tabOptions = useMemo(
    () => [
      { value: "charges", label: `Cargos (${lines.length})` },
      { value: "payments", label: `Pagos (${payments.length})` },
      { value: "routing", label: `Routing rules (${rules.length})` },
      { value: "notes", label: "Notas" }
    ],
    [lines.length, payments.length, rules.length]
  );

  const paymentColumns = useMemo<CocoaTableColumn<PaymentRecord>[]>(
    () => [
      {
        key: "capturedAt",
        label: "Capturado",
        render: (payment) =>
          payment.capturedAt ? new Date(payment.capturedAt).toLocaleString("es-ES") : "—"
      },
      {
        key: "method",
        label: "Método",
        render: (payment) => <strong>{payment.method}</strong>
      },
      {
        key: "amount",
        label: "Importe",
        align: "right",
        render: (payment) => fmtMoney(payment.amount, payment.currency || currency)
      },
      {
        key: "status",
        label: "Estado",
        render: (payment) => payment.status
      },
      {
        key: "pspReference",
        label: "Ref. PSP",
        render: (payment) => payment.pspReference ?? "—"
      }
    ],
    [currency]
  );

  const routingColumns = useMemo<CocoaTableColumn<FolioRoutingRule>[]>(
    () => [
      {
        key: "sourceType",
        label: "Origen",
        render: (rule) => <strong>{rule.sourceType}</strong>
      },
      {
        key: "targetFolioId",
        label: "Folio destino",
        render: (rule) => rule.targetFolioId
      },
      {
        key: "priority",
        label: "Prioridad",
        align: "right",
        render: (rule) => String(rule.priority)
      },
      {
        key: "active",
        label: "Estado",
        render: (rule) => (rule.active ? "Activa" : "Pausada")
      }
    ],
    []
  );

  // Render del lookup si aún no hay folioId.
  if (!folioId) {
    return (
      <section className="bo-card">
        <CocoaPageHeader
          eyebrow="Facturación"
          title="Detalle de folio"
          subtitle="Indica el ID del folio que quieres abrir."
        />
        <p
          className="bo-muted"
          style={{ marginTop: "var(--cocoa-space-4)" }}
        >
          Indica el ID del folio que quieres abrir. También puedes navegar con el
          parámetro <code>#folio=fol_xxx</code> en la URL.
        </p>
        <div
          style={{
            display: "flex",
            gap: "var(--cocoa-space-2)",
            alignItems: "flex-end",
            flexWrap: "wrap",
            marginTop: "var(--cocoa-space-3)"
          }}
        >
          <label
            className="bo-form-field"
            style={{ flex: "1 1 280px", minWidth: 240 }}
          >
            <span>ID del folio</span>
            <CocoaInput
              value={folioLookup}
              onChange={setFolioLookup}
              placeholder="fol_abc123"
            />
          </label>
          <CocoaButton variant="filled" tone="accent" onClick={handleLookup}>
            Abrir folio
          </CocoaButton>
        </div>
      </section>
    );
  }

  // Estilos del balance hero: el plan indica usar accent cuando hay saldo y
  // success cuando saldo es 0. Los estilos quedan inline contra tokens.
  const balanceColor: string =
    balanceDue === 0
      ? "var(--cocoa-success, var(--cocoa-label))"
      : "var(--cocoa-accent)";

  return (
    <section className="bo-card">
      <CocoaPageHeader
        eyebrow={`Folio ${folio?.label ?? folioId}${folio ? ` · ${folio.status}` : ""}`}
        title="Detalle de folio"
        subtitle={folio ? `Reserva ${folio.reservationId}` : undefined}
        actions={
          <span
            style={{
              display: "inline-flex",
              gap: "var(--cocoa-space-2)",
              flexWrap: "wrap"
            }}
          >
            <CocoaButton
              variant="plain"
              onClick={openSplitDialog}
              disabled={busy || !folio}
            >
              Split folio
            </CocoaButton>
            <CocoaButton
              variant="filled"
              tone="accent"
              onClick={openCloseDialog}
              disabled={busy || !folio || folio.status === "closed" || balanceDue !== 0}
              aria-label={
                folio?.status === "closed"
                  ? "Folio ya cerrado"
                  : balanceDue !== 0
                    ? "Cerrar folio (requiere saldo 0)"
                    : "Cerrar folio"
              }
            >
              Cerrar folio
            </CocoaButton>
          </span>
        }
      />

      {/* Balance hero — CocoaCard elevated */}
      <div style={{ margin: "var(--cocoa-space-4) 0", maxWidth: 480 }}>
        <CocoaCard variant="elevated" padding="lg">
          <span
            style={{
              color: "var(--cocoa-label-secondary)",
              fontSize: "var(--cocoa-fs-caption)",
              textTransform: "uppercase",
              letterSpacing: "var(--cocoa-tracking-wide)"
            }}
          >
            Balance pendiente
          </span>
          <div
            style={{
              fontSize: "var(--cocoa-fs-large-title)",
              fontWeight: 700,
              lineHeight: 1.1,
              marginTop: "var(--cocoa-space-2)",
              color: balanceColor,
              fontVariantNumeric: "tabular-nums",
              opacity: loading ? 0.5 : 1
            }}
          >
            {fmtMoney(balanceDue, currency)}
          </div>
          <p
            style={{
              marginTop: "var(--cocoa-space-2)",
              color: "var(--cocoa-label-secondary)",
              fontSize: "var(--cocoa-fs-caption)"
            }}
          >
            Cargos {fmtMoney(chargesTotal, currency)} · Pagos {fmtMoney(paymentsTotal, currency)}
          </p>
        </CocoaCard>
      </div>

      {/* CocoaSegmentedControl tabs */}
      <div style={{ marginBottom: "var(--cocoa-space-4)" }}>
        <CocoaSegmentedControl
          value={activeTab}
          options={tabOptions}
          onChange={(value) => setActiveTab(value as FolioTab)}
          aria-label="Secciones del folio"
        />
      </div>

      {error ? <p className="bo-muted">{error}</p> : null}

      {activeTab === "charges" ? (
        <div className="bo-grid two" style={{ gap: "var(--cocoa-space-4)" }}>
          {/* Lista DRAGGABLE de cargos — drag-drop preservado */}
          <section>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "var(--cocoa-space-2)"
              }}
            >
              <h3 style={{ margin: 0 }}>Cargos ({lines.length})</h3>
              <span
                style={{
                  color: "var(--cocoa-label-secondary)",
                  fontSize: "var(--cocoa-fs-caption)"
                }}
              >
                {selectedChargeIds.size > 0
                  ? `${selectedChargeIds.size} seleccionado(s) — arrastra al folio destino`
                  : "Clic para seleccionar · arrastra para mover"}
              </span>
            </div>
            {lines.length === 0 ? (
              <CocoaCard variant="bordered" padding="lg">
                <p
                  style={{
                    margin: 0,
                    textAlign: "center",
                    color: "var(--cocoa-label-secondary)"
                  }}
                >
                  Sin cargos registrados.
                </p>
              </CocoaCard>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--cocoa-space-1)"
                }}
              >
                {lines.map((line) => {
                  const isSelected = selectedChargeIds.has(line.id);
                  const isDragging = draggedChargeIds.includes(line.id);
                  const chargeStyle: CSSProperties = {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "var(--cocoa-space-3)",
                    padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
                    border: `1px solid ${
                      isSelected
                        ? "var(--cocoa-accent)"
                        : "var(--cocoa-separator)"
                    }`,
                    borderRadius: "var(--cocoa-radius-md)",
                    background: isSelected
                      ? "var(--cocoa-background-selection)"
                      : isDragging
                        ? "var(--cocoa-background-control)"
                        : "var(--cocoa-background-content)",
                    color: isSelected ? "var(--cocoa-accent-contrast)" : "var(--cocoa-label)",
                    cursor: "grab",
                    opacity: isDragging ? 0.6 : 1,
                    transition:
                      "background var(--cocoa-duration-base) var(--cocoa-ease-out), border-color var(--cocoa-duration-base) var(--cocoa-ease-out)"
                  };
                  return (
                    <div
                      key={line.id}
                      role="button"
                      tabIndex={0}
                      draggable
                      onDragStart={(event) => handleDragStart(event, line.id)}
                      onDragEnd={handleDragEnd}
                      onClick={() => toggleSelect(line.id)}
                      onKeyDown={(event) => {
                        if (event.key === " " || event.key === "Enter") {
                          event.preventDefault();
                          toggleSelect(line.id);
                        }
                      }}
                      aria-grabbed={isDragging}
                      aria-selected={isSelected}
                      style={chargeStyle}
                    >
                      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                        <strong
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap"
                          }}
                        >
                          {line.description}
                        </strong>
                        <small
                          style={{
                            color: isSelected
                              ? "var(--cocoa-accent-contrast)"
                              : "var(--cocoa-label-secondary)"
                          }}
                        >
                          {line.type} · {line.quantity} × {fmtMoney(line.unitPrice, currency)}
                          {line.taxCode ? ` · ${line.taxCode}` : ""}
                        </small>
                      </span>
                      <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                        {fmtMoney(line.total, currency)}
                      </strong>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Drop targets: otros folios visibles */}
          <aside>
            <h3 style={{ margin: "0 0 var(--cocoa-space-2) 0" }}>Mover a otro folio</h3>
            {siblingFolios.length === 0 ? (
              <CocoaCard variant="bordered" padding="lg">
                <p
                  style={{
                    margin: 0,
                    color: "var(--cocoa-label-secondary)"
                  }}
                >
                  No hay otros folios en esta reserva. Crea uno con "Split folio" para habilitar el destino.
                </p>
              </CocoaCard>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--cocoa-space-2)"
                }}
              >
                {siblingFolios.map((target) => {
                  const isActive = dropTargetId === target.id;
                  const dropStyle: CSSProperties = {
                    padding: "var(--cocoa-space-4)",
                    border: `2px dashed ${
                      isActive ? "var(--cocoa-accent)" : "var(--cocoa-separator)"
                    }`,
                    borderRadius: "var(--cocoa-radius-lg)",
                    background: isActive
                      ? "var(--cocoa-background-selection)"
                      : "var(--cocoa-background-control)",
                    transition:
                      "all var(--cocoa-duration-base) var(--cocoa-ease-out)"
                  };
                  return (
                    <div
                      key={target.id}
                      data-dropzone={isActive ? "active" : "idle"}
                      onDragOver={(event) => handleDragOver(event, target.id)}
                      onDragLeave={() => handleDragLeave(target.id)}
                      onDrop={(event) => void handleDrop(event, target.id)}
                      style={dropStyle}
                    >
                      <strong>{target.label}</strong>
                      <div
                        style={{
                          color: "var(--cocoa-label-secondary)",
                          fontSize: "var(--cocoa-fs-caption)",
                          marginTop: "var(--cocoa-space-1)"
                        }}
                      >
                        {target.isPrimary ? "Primario · " : ""}
                        {target.status} · {target.currency}
                      </div>
                      <p
                        style={{
                          color: "var(--cocoa-label-secondary)",
                          fontSize: "var(--cocoa-fs-caption)",
                          marginTop: "var(--cocoa-space-2)",
                          marginBottom: 0
                        }}
                      >
                        Suelta aquí los cargos seleccionados.
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      ) : null}

      {activeTab === "payments" ? (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "var(--cocoa-space-2)"
            }}
          >
            <h3 style={{ margin: 0 }}>Pagos ({payments.length})</h3>
            <span style={{ color: "var(--cocoa-label-secondary)" }}>
              Total pagado: <strong style={{ color: "var(--cocoa-label)" }}>{fmtMoney(paymentsTotal, currency)}</strong> · Balance:{" "}
              <strong style={{ color: "var(--cocoa-label)" }}>{fmtMoney(balanceDue, currency)}</strong>
            </span>
          </div>
          <CocoaTable<PaymentRecord>
            columns={paymentColumns}
            rows={payments}
            rowKey="id"
            emptyState="Sin pagos registrados."
          />
        </div>
      ) : null}

      {activeTab === "routing" ? (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "var(--cocoa-space-2)"
            }}
          >
            <h3 style={{ margin: 0 }}>Reglas de routing ({rules.length})</h3>
            <CocoaButton
              variant="plain"
              onClick={handleNewRulePlaceholder}
            >
              Nueva regla
            </CocoaButton>
          </div>
          <CocoaTable<FolioRoutingRule>
            columns={routingColumns}
            rows={rules}
            rowKey="id"
            emptyState="No hay reglas de routing definidas para esta reserva."
          />
          <p
            style={{
              marginTop: "var(--cocoa-space-3)",
              color: "var(--cocoa-label-secondary)"
            }}
          >
            El editor completo de reglas vive en la pantalla{" "}
            <CocoaButton
              variant="plain"
              size="small"
              onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "FolioRoutingScreen" }))}
            >
              FolioRouting
            </CocoaButton>
            .
          </p>
        </div>
      ) : null}

      {activeTab === "notes" ? (
        <div>
          <h3 style={{ marginTop: 0 }}>Notas internas</h3>
          <label className="bo-form-field">
            <span>Nota sobre este folio</span>
            <textarea
              rows={10}
              value={note}
              onChange={(event) => handleNoteChange(event.target.value)}
              placeholder="Anotaciones para el equipo de facturación…"
            />
          </label>
          <div className="bo-actions">
            <CocoaButton variant="filled" tone="accent" onClick={handleNoteSave}>
              Guardar nota
            </CocoaButton>
          </div>
        </div>
      ) : null}

      {/* Split folio dialog (placeholder UI mínima) */}
      {splitOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Split folio"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1100
          }}
          onClick={() => setSplitOpen(false)}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              background: "var(--cocoa-background-content)",
              padding: "var(--cocoa-space-5)",
              borderRadius: "var(--cocoa-radius-lg)",
              minWidth: 320,
              maxWidth: 480,
              boxShadow: "var(--cocoa-shadow-modal)"
            }}
          >
            <h3 style={{ marginTop: 0 }}>Split folio</h3>
            <p style={{ color: "var(--cocoa-label-secondary)" }}>
              Crea un folio secundario en la misma reserva. Los cargos podrán arrastrarse desde el folio actual.
            </p>
            <label className="bo-form-field">
              <span>Etiqueta del folio nuevo</span>
              <CocoaInput
                value={splitLabel}
                onChange={setSplitLabel}
                placeholder="ej. Empresa, Acompañante…"
              />
            </label>
            <div
              className="bo-actions"
              style={{
                display: "flex",
                gap: "var(--cocoa-space-2)",
                justifyContent: "flex-end"
              }}
            >
              <CocoaButton variant="plain" onClick={() => setSplitOpen(false)} disabled={busy}>
                Cancelar
              </CocoaButton>
              <CocoaButton
                variant="filled"
                tone="accent"
                onClick={() => void confirmSplit()}
                disabled={busy}
              >
                Crear folio
              </CocoaButton>
            </div>
          </div>
        </div>
      ) : null}

      {/* Cerrar folio confirm */}
      {closeConfirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Cerrar folio"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1100
          }}
          onClick={() => setCloseConfirmOpen(false)}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              background: "var(--cocoa-background-content)",
              padding: "var(--cocoa-space-5)",
              borderRadius: "var(--cocoa-radius-lg)",
              minWidth: 320,
              maxWidth: 420,
              boxShadow: "var(--cocoa-shadow-modal)"
            }}
          >
            <h3 style={{ marginTop: 0 }}>Cerrar folio</h3>
            <p>
              ¿Confirmas el cierre del folio? Esta acción evita posteriores cargos o pagos. Solo
              se permite cuando el balance es cero.
            </p>
            <div
              className="bo-actions"
              style={{
                display: "flex",
                gap: "var(--cocoa-space-2)",
                justifyContent: "flex-end"
              }}
            >
              <CocoaButton variant="plain" onClick={() => setCloseConfirmOpen(false)} disabled={busy}>
                Cancelar
              </CocoaButton>
              <CocoaButton
                variant="filled"
                tone="destructive"
                onClick={() => void confirmClose()}
                disabled={busy}
              >
                Cerrar folio
              </CocoaButton>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default FolioDetailScreen;

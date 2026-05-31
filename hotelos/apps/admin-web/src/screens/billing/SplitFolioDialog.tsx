// SplitFolioDialog — Sprint 40 split-folio UX.
//
// Standard PMS workflow (Cloudbeds / Opera): pick a subset of charges from an
// existing folio and move them into a NEW sibling folio on the same
// reservation. Use cases:
//   - Split master folio between two payers (company vs guest).
//   - Move incidentals (minibar, spa) out of the main folio so the company
//     doesn't see them.
//
// Modal styled after NewGroupDialog: fixed overlay, backdrop click closes,
// Escape closes, inline error panel, primary/secondary buttons in footer.
// Toast feedback via useToast.

import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { splitFolio } from "../../services/folioRoutingApi";
import { useToast } from "../../components/Toast";

// ─── Helpers locales (mismo patrón visual que NewGroupDialog) ────────────

const fieldsetStyle: CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: 12,
  margin: 0
};

const legendStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-soft, #555)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 6px"
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "var(--radius-sm, 6px)",
  background: "var(--surface, white)",
  color: "var(--ink, #1a1a1a)",
  fontSize: 14,
  fontFamily: "inherit"
};

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--ink)" }}>
      <span style={{ fontWeight: 500 }}>{props.label}</span>
      {props.children}
      {props.hint ? <span className="bo-muted" style={{ fontSize: 11 }}>{props.hint}</span> : null}
    </label>
  );
}

// ─── Tipos públicos del componente ───────────────────────────────────────

export type SplitFolioCharge = {
  id: string;
  description: string;
  amount: number;
};

export type SplitFolioDialogProps = {
  folioId: string;
  folioName: string;
  charges: SplitFolioCharge[];
  onClose: () => void;
  onSplit: (newFolioId: string) => void;
};

// ─── Componente principal ────────────────────────────────────────────────

export function SplitFolioDialog(props: SplitFolioDialogProps) {
  const { showToast } = useToast();

  // Multi-select de charges (Set por O(1) toggle).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Nuevo folio
  const [name, setName] = useState<string>("");
  const [accountId, setAccountId] = useState<string>("");
  // Submit lifecycle
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleCharge(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(props.charges.map((c) => c.id)));
  }
  function clearAll() {
    setSelectedIds(new Set());
  }

  // Resumen del importe que se moverá al nuevo folio.
  const movedTotal = useMemo(() => {
    let sum = 0;
    for (const c of props.charges) if (selectedIds.has(c.id)) sum += Number(c.amount) || 0;
    return sum;
  }, [props.charges, selectedIds]);

  const remainingTotal = useMemo(() => {
    let sum = 0;
    for (const c of props.charges) if (!selectedIds.has(c.id)) sum += Number(c.amount) || 0;
    return sum;
  }, [props.charges, selectedIds]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Validaciones requeridas por la tarea.
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("El nombre del nuevo folio es obligatorio.");
      return;
    }
    if (selectedIds.size < 1) {
      setError("Selecciona al menos un cargo para mover al nuevo folio.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await splitFolio(props.folioId, {
        newFolio: {
          label: trimmedName,
          // accountId es opcional. El backend acepta guestId como dueño
          // del nuevo folio. Mapeamos accountId → guestId cuando se rellena
          // para reaprovechar el endpoint /folios/:id/split sin tocar API.
          guestId: accountId.trim() ? accountId.trim() : undefined
        },
        moveChargeIds: Array.from(selectedIds)
      });
      const verb = response.idempotent ? "reutilizado" : "creado";
      showToast(`Folio "${trimmedName}" ${verb} con ${response.movedChargeIds.length} cargo(s)`, { variant: "success" });
      props.onSplit(response.newFolio.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      showToast(msg, { variant: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  const allSelected = selectedIds.size > 0 && selectedIds.size === props.charges.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="split-folio-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16
      }}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}
    >
      <form
        onSubmit={submit}
        className="bo-card"
        style={{
          width: "100%",
          maxWidth: 680,
          maxHeight: "92vh",
          overflow: "auto",
          background: "var(--surface-1, var(--surface))",
          padding: "var(--space-5, 20px)",
          borderRadius: "var(--radius-md, 12px)",
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <div>
            <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}>
              Billing · Folio split
            </p>
            <h3 id="split-folio-title" style={{ margin: "2px 0 0 0" }}>Dividir folio</h3>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Cerrar"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}
          >×</button>
        </div>

        <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
          Mueve cargos del folio <strong>{props.folioName}</strong> a un nuevo folio hermano de la misma reserva.
          Útil para separar pagadores (empresa vs. huésped) o aislar extras (minibar, spa).
        </p>

        {/* 1. Selección de cargos */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>
            Cargos a mover ({selectedIds.size} de {props.charges.length})
          </legend>
          <div
            className="bo-row"
            style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = someSelected; }}
                onChange={(e) => { if (e.target.checked) selectAll(); else clearAll(); }}
                disabled={props.charges.length === 0}
                aria-label="Seleccionar todos los cargos"
              />
              Seleccionar todos
            </label>
            <span className="bo-muted" style={{ fontSize: 12 }}>
              Total seleccionado: <strong>{movedTotal.toFixed(2)}</strong> · Resto: {remainingTotal.toFixed(2)}
            </span>
          </div>

          {props.charges.length === 0 ? (
            <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
              El folio no tiene cargos disponibles para mover.
            </p>
          ) : (
            <div
              role="listbox"
              aria-multiselectable="true"
              aria-label="Cargos del folio origen"
              style={{
                border: "1px solid var(--border, #e5e7eb)",
                borderRadius: "var(--radius-sm, 6px)",
                maxHeight: 280,
                overflowY: "auto",
                background: "var(--surface, white)"
              }}
            >
              {props.charges.map((charge) => {
                const checked = selectedIds.has(charge.id);
                return (
                  <label
                    key={charge.id}
                    role="option"
                    aria-selected={checked}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--border, #f1f5f9)",
                      cursor: "pointer",
                      background: checked ? "rgba(15, 76, 199, 0.05)" : "transparent",
                      fontSize: 13
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCharge(charge.id)}
                      aria-label={`Mover cargo ${charge.description}`}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ display: "block", fontWeight: 500 }}>{charge.description}</strong>
                      <span className="bo-muted" style={{ fontSize: 11 }}>ID {charge.id}</span>
                    </span>
                    <strong style={{ whiteSpace: "nowrap" }}>
                      {Number(charge.amount).toFixed(2)}
                    </strong>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>

        {/* 2. Nuevo folio */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Nuevo folio destino</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Nombre / etiqueta *" hint="Ej: 'Cargos empresa', 'Extras huésped', 'Minibar'.">
              <input
                type="text"
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={inputStyle}
                placeholder="Cargos empresa"
                autoFocus
              />
            </Field>
            <Field label="Account ID" hint="Opcional. Asocia el folio a un huésped/cuenta pagadora.">
              <input
                type="text"
                maxLength={64}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                style={inputStyle}
                placeholder="guest_... / acct_..."
              />
            </Field>
          </div>
        </fieldset>

        {error ? (
          <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>{error}</p>
        ) : null}

        <div className="bo-row" style={{ gap: 8, justifyContent: "space-between", marginTop: 4 }}>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>* Campos obligatorios</p>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={props.onClose} disabled={submitting}>Cancelar</button>
            <button
              type="submit"
              className="primary"
              disabled={submitting || selectedIds.size === 0 || !name.trim()}
            >
              {submitting ? "Procesando…" : "Hacer split"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

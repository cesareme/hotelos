// Reusable right-side detail drawer used by the operations boards.
import { useEffect, useId, type ReactNode } from "react";

export function SidePanel({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  // a11y: cierra el drawer con Escape igual que al pulsar fuera. Sin esto los
  // usuarios con teclado quedaban atrapados en el modal.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,.45)", zIndex: 70, display: "flex", justifyContent: "flex-end" }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 94vw)",
          height: "100%",
          background: "var(--surface, #fff)",
          boxShadow: "-16px 0 48px rgba(2,6,23,.32)",
          display: "flex",
          flexDirection: "column"
        }}
      >
        <header className="bo-card-head" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line-soft)", marginBottom: 0 }}>
          <div style={{ minWidth: 0 }}>
            <h3 id={titleId} style={{ color: "var(--ink)", margin: 0 }}>{title}</h3>
            {subtitle ? <p className="bo-muted" style={{ margin: "2px 0 0", fontSize: 12.5, textTransform: "none" }}>{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar panel" title="Cerrar (Esc)" style={{ minHeight: 32 }}>✕</button>
        </header>
        <div style={{ padding: 18, overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
        {footer ? (
          <footer style={{ padding: "12px 18px", borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, flexWrap: "wrap" }}>{footer}</footer>
        ) : null}
      </aside>
    </div>
  );
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "5px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <span className="bo-muted" style={{ textTransform: "none" }}>{label}</span>
      <span style={{ color: "var(--ink)", textAlign: "right" }}>{children}</span>
    </div>
  );
}

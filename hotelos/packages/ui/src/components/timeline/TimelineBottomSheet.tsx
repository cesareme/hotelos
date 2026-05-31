import type { CSSProperties, ReactNode } from "react";

export type TimelineBottomSheetProps = {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  maxHeight?: string;
  style?: CSSProperties;
};

export function TimelineBottomSheet(props: TimelineBottomSheetProps) {
  const { open, title, subtitle, onClose, children, maxHeight = "70vh", style } = props;
  if (!open) return null;
  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(11,16,38,0.32)",
          zIndex: 60
        }}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: "#ffffff",
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          borderTop: "1px solid #d9e0ea",
          boxShadow: "0 -22px 55px rgba(15,23,42,0.18)",
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          maxHeight,
          overflowY: "auto",
          zIndex: 61,
          ...style
        }}
      >
        <div
          aria-hidden
          style={{
            width: 60,
            height: 6,
            borderRadius: 3,
            background: "#cdd5e2",
            margin: "0 auto"
          }}
        />
        <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, color: "#667085", fontWeight: 900, fontSize: 12, textTransform: "uppercase" }}>
              Detail
            </p>
            <h2 style={{ margin: "4px 0 0", fontSize: 22, lineHeight: 1.1, color: "#0b1026" }}>{title}</h2>
            {subtitle ? <p style={{ margin: "4px 0 0", color: "#667085", lineHeight: 1.45 }}>{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail"
            style={{
              minWidth: 36,
              minHeight: 36,
              borderRadius: 10,
              border: "1px solid #cdd5e2",
              background: "#f8fafc",
              color: "#0b1026",
              fontWeight: 900,
              cursor: "pointer"
            }}
          >
            X
          </button>
        </header>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
      </section>
    </>
  );
}

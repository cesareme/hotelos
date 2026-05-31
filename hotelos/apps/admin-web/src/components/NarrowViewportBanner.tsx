import { useEffect, useState } from "react";

const NARROW_VIEWPORT_THRESHOLD = 700;

export function NarrowViewportBanner() {
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < NARROW_VIEWPORT_THRESHOLD;
  });
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleResize = () => {
      setIsNarrow(window.innerWidth < NARROW_VIEWPORT_THRESHOLD);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  if (dismissed || !isNarrow) return null;

  return (
    <div
      className="bo-card"
      style={{
        borderLeft: "4px solid var(--warn)",
        color: "var(--ink)",
        padding: "var(--space-3)",
        marginBottom: "var(--space-3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-3)",
        flexWrap: "wrap",
      }}
      role="status"
      aria-live="polite"
    >
      <span>
        Esta vista funciona mejor en tablet o ordenador. Algunas tablas pueden requerir scroll horizontal.
      </span>
      <button type="button" onClick={() => setDismissed(true)}>
        Entendido
      </button>
    </div>
  );
}

export default NarrowViewportBanner;

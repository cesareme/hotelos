// CocoaContextualHelp — Widget de ayuda contextual.
//
// Card "plain" (flat) con padding medio que muestra una sección de preguntas
// frecuentes específicas para un tema. Cabecera con icono "?" y el título
// "Preguntas frecuentes sobre {topic}", seguido de un acordeón de preguntas
// (una abierta a la vez) y un pie con enlace "Ver toda la ayuda".

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";

export interface CocoaContextualHelpQuestion {
  /** Pregunta (texto de cabecera del item del acordeón). */
  q: string;
  /** Respuesta. Acepta texto plano o nodos React. */
  a: ReactNode;
}

export interface CocoaContextualHelpProps {
  /** Tema sobre el que trata el widget, usado en el título de cabecera. */
  topic: string;
  /** Lista de preguntas y respuestas a mostrar en el acordeón. */
  questions: CocoaContextualHelpQuestion[];
  /**
   * URL o callback para el enlace del pie "Ver toda la ayuda".
   * Si es un string, se renderiza como ancla. Si es una función, se renderiza
   * como botón que invoca el callback. Si se omite, no se muestra el pie.
   */
  onSeeAllHelp?: string | (() => void);
  /** Etiqueta personalizada para el enlace del pie. */
  seeAllHelpLabel?: string;
  /** className opcional para el contenedor raíz. */
  className?: string;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)",
  fontFamily: "var(--cocoa-font)",
  color: "var(--cocoa-label)"
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  margin: 0
};

const helpBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-footnote)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  lineHeight: 1,
  flexShrink: 0
};

const titleStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-headline)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  color: "var(--cocoa-label)",
  lineHeight: 1.25,
  margin: 0,
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const accordionListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  listStyle: "none",
  margin: 0,
  padding: 0,
  borderTop: "1px solid var(--cocoa-separator)"
};

const accordionItemStyle: CSSProperties = {
  borderBottom: "1px solid var(--cocoa-separator)"
};

const accordionTriggerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  width: "100%",
  padding: "var(--cocoa-space-3) 0",
  background: "transparent",
  border: "none",
  textAlign: "left",
  font: "inherit",
  color: "var(--cocoa-label)",
  cursor: "pointer"
};

const accordionTriggerLabelStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  fontSize: "var(--cocoa-fs-body)",
  fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
  color: "var(--cocoa-label)",
  lineHeight: 1.35,
  margin: 0
};

const chevronWrapperStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  color: "var(--cocoa-label-secondary)",
  flexShrink: 0,
  transition:
    "transform var(--cocoa-duration-base) var(--cocoa-ease-out)"
};

const accordionPanelStyle: CSSProperties = {
  padding: "0 0 var(--cocoa-space-3) 0",
  fontSize: "var(--cocoa-fs-subheadline)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1.4,
  margin: 0
};

const footerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  paddingTop: "var(--cocoa-space-1)"
};

const footerLinkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "transparent",
  border: "none",
  padding: 0,
  font: "inherit",
  fontSize: "var(--cocoa-fs-footnote)",
  fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
  color: "var(--cocoa-tint)",
  textDecoration: "none",
  cursor: "pointer"
};

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3 1.5L6.5 5L3 8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function slugify(value: string, index: number): string {
  const base = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 40);
  return base.length > 0 ? `${base}-${index}` : `q-${index}`;
}

export function CocoaContextualHelp({
  topic,
  questions,
  onSeeAllHelp,
  seeAllHelpLabel = "Ver toda la ayuda",
  className
}: CocoaContextualHelpProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const handleToggle = useCallback((index: number) => {
    setOpenIndex((prev) => (prev === index ? null : index));
  }, []);

  const handleFooterClick = useCallback(() => {
    if (typeof onSeeAllHelp === "function") {
      onSeeAllHelp();
    }
  }, [onSeeAllHelp]);

  const showFooter = onSeeAllHelp !== undefined;

  return (
    <CocoaCard variant="plain" padding="md" className={className}>
      <div style={containerStyle}>
        <header style={headerStyle}>
          <span style={helpBadgeStyle} aria-hidden="true">
            ?
          </span>
          <h3 style={titleStyle}>
            Preguntas frecuentes sobre {topic}
          </h3>
        </header>

        {questions.length > 0 ? (
          <ul style={accordionListStyle} role="list">
            {questions.map((item, index) => {
              const isOpen = openIndex === index;
              const baseId = slugify(item.q, index);
              const triggerId = `cocoa-contextual-help-trigger-${baseId}`;
              const panelId = `cocoa-contextual-help-panel-${baseId}`;
              return (
                <li key={baseId} style={accordionItemStyle}>
                  <button
                    type="button"
                    id={triggerId}
                    style={accordionTriggerStyle}
                    onClick={() => handleToggle(index)}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                  >
                    <span style={accordionTriggerLabelStyle}>{item.q}</span>
                    <span
                      aria-hidden="true"
                      style={{
                        ...chevronWrapperStyle,
                        transform: isOpen ? "rotate(90deg)" : "rotate(0deg)"
                      }}
                    >
                      <Chevron />
                    </span>
                  </button>
                  {isOpen ? (
                    <div
                      id={panelId}
                      role="region"
                      aria-labelledby={triggerId}
                      style={accordionPanelStyle}
                    >
                      {item.a}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {showFooter ? (
          <div style={footerStyle}>
            {typeof onSeeAllHelp === "string" ? (
              <a
                href={onSeeAllHelp}
                style={footerLinkStyle}
                className="cocoa-focus-ring"
              >
                {seeAllHelpLabel}
                <span aria-hidden="true">→</span>
              </a>
            ) : (
              <button
                type="button"
                onClick={handleFooterClick}
                style={footerLinkStyle}
                className="cocoa-focus-ring"
              >
                {seeAllHelpLabel}
                <span aria-hidden="true">→</span>
              </button>
            )}
          </div>
        ) : null}
      </div>
    </CocoaCard>
  );
}

export default CocoaContextualHelp;

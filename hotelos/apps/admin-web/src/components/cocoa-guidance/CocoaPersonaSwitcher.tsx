// CocoaPersonaSwitcher — Runtime role/persona switch widget.
//
// Renders a dropdown trigger labeled "Vista actual: {currentPersona}". When
// clicked, opens a popover containing cards for each available persona
// (e.g. Recepcion, Housekeeping, Maintenance, Manager, Owner, Compliance
// Officer, Admin). Each card displays an optional icon, the persona label,
// and a short description. The currently selected persona shows a check
// glyph in the top-right corner.
//
// Use this in the admin shell so operators can preview the UI from another
// role without re-authenticating — useful for support staff, training, and
// debugging permission-gated flows.
//
// Props:
// - currentPersona     : The id of the currently active persona.
// - availablePersonas  : The list of personas the user can switch to. Each
//                        entry has { id, label, description, icon? }.
// - onSwitch           : Callback fired with the selected persona id when
//                        the user picks a card. The popover closes
//                        automatically after the selection.

import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import CocoaPopover from "../cocoa/CocoaPopover";

export interface CocoaPersonaOption {
  id: string;
  label: string;
  description: string;
  icon?: ReactNode;
}

export interface CocoaPersonaSwitcherProps {
  currentPersona: string;
  availablePersonas: CocoaPersonaOption[];
  onSwitch: (personaId: string) => void;
}

const triggerStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  color: "var(--cocoa-label)",
  font: "var(--cocoa-text-body)",
  fontWeight: 500,
  cursor: "pointer",
  transition:
    "background var(--cocoa-duration-fast) var(--cocoa-ease-standard), border-color var(--cocoa-duration-fast) var(--cocoa-ease-standard)",
};

const triggerLabelStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontWeight: 400,
};

const triggerValueStyle: CSSProperties = {
  color: "var(--cocoa-label)",
  fontWeight: 600,
};

const chevronStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--cocoa-label-tertiary)",
};

const contentStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-2)",
  minWidth: 280,
  maxWidth: 360,
};

const headingStyle: CSSProperties = {
  margin: 0,
  padding: "0 0 var(--cocoa-space-1) 0",
  font: "var(--cocoa-text-subheadline)",
  color: "var(--cocoa-label-secondary)",
  fontWeight: 600,
  letterSpacing: "var(--cocoa-tracking-tight)",
};

const cardsListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-1)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const baseCardStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--cocoa-space-3)",
  width: "100%",
  textAlign: "left",
  padding: "var(--cocoa-space-3)",
  background: "transparent",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  cursor: "pointer",
  color: "var(--cocoa-label)",
  font: "var(--cocoa-text-body)",
  transition:
    "background var(--cocoa-duration-fast) var(--cocoa-ease-standard), border-color var(--cocoa-duration-fast) var(--cocoa-ease-standard)",
};

const selectedCardStyle: CSSProperties = {
  ...baseCardStyle,
  background: "var(--cocoa-accent-soft, rgba(0, 122, 255, 0.08))",
  borderColor: "var(--cocoa-accent)",
};

const iconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  flexShrink: 0,
  borderRadius: "var(--cocoa-radius-sm)",
  background: "var(--cocoa-background-content)",
  color: "var(--cocoa-label-secondary)",
};

const cardBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-1)",
  flex: 1,
  minWidth: 0,
};

const cardLabelStyle: CSSProperties = {
  margin: 0,
  font: "var(--cocoa-text-body)",
  color: "var(--cocoa-label)",
  fontWeight: 600,
  lineHeight: 1.3,
};

const cardDescriptionStyle: CSSProperties = {
  margin: 0,
  font: "var(--cocoa-text-subheadline)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1.4,
};

const checkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  flexShrink: 0,
  borderRadius: "50%",
  background: "var(--cocoa-accent)",
  color: "var(--cocoa-accent-contrast, #ffffff)",
  marginLeft: "var(--cocoa-space-2)",
};

function ChevronDownIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M3 4.5L6 7.5L9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M2.5 6.5L5 9L9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CocoaPersonaSwitcher({
  currentPersona,
  availablePersonas,
  onSwitch,
}: CocoaPersonaSwitcherProps) {
  const [open, setOpen] = useState<boolean>(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  const currentLabel = useMemo(() => {
    const match = availablePersonas.find(
      (persona) => persona.id === currentPersona,
    );
    return match !== undefined ? match.label : currentPersona;
  }, [availablePersonas, currentPersona]);

  const handleToggle = () => {
    setOpen((prev) => !prev);
  };

  const handleSelect = (personaId: string) => {
    onSwitch(personaId);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={handleToggle}
        style={triggerStyle}
      >
        <span style={triggerLabelStyle}>Vista actual:</span>
        <span style={triggerValueStyle}>{currentLabel}</span>
        <span style={chevronStyle}>
          <ChevronDownIcon />
        </span>
      </button>
      <CocoaPopover
        open={open}
        anchorEl={anchorRef.current}
        placement="bottom"
        onClose={() => setOpen(false)}
      >
        <div style={contentStyle} role="listbox" aria-label="Cambiar vista">
          <h4 style={headingStyle}>Cambiar vista</h4>
          <ul style={cardsListStyle}>
            {availablePersonas.map((persona) => {
              const isSelected = persona.id === currentPersona;
              return (
                <li key={persona.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(persona.id)}
                    style={isSelected ? selectedCardStyle : baseCardStyle}
                  >
                    {persona.icon !== undefined ? (
                      <span aria-hidden="true" style={iconStyle}>
                        {persona.icon}
                      </span>
                    ) : null}
                    <span style={cardBodyStyle}>
                      <span style={cardLabelStyle}>{persona.label}</span>
                      <span style={cardDescriptionStyle}>
                        {persona.description}
                      </span>
                    </span>
                    {isSelected ? (
                      <span aria-label="Seleccionado" style={checkStyle}>
                        <CheckIcon />
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </CocoaPopover>
    </>
  );
}

export default CocoaPersonaSwitcher;

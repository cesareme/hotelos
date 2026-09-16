// Finanzas · «Ámbito» (Tanda 6b · L7, design §5.3) — the ONE scope control of
// the money screens, painted in the actions row of the page header, plus the
// small companions the same screens repeat:
//
//   FinanceScopeSelector   CocoaSelect «Ámbito» over useFinanceScope(): hidden
//                          for a single hotel, disabled (sociedad only) on the
//                          forced screens, flat options «Sociedad · … (todo)» /
//                          «Centro · … (RA)» otherwise.
//   FinanceDeclaranteBadge «Declarante: <razón social> · <NIF>» of every AEAT
//                          model and VAT book (warning when the NIF is pending
//                          or the sociedad is not backfilled yet).
//   FinanceRegimeCallout   Warning callout when the sociedad is in the SII /
//                          gran empresa (347 · 390 not filed, VeriFactu n/a).
//   FinanceEntityNote      «Se lleva por sociedad» cue of the forced screens
//                          (Plan, Cierre, Balance…), painted only when the
//                          sociedad has several centres.
//
// Cocoa 22 (COCOA-22.md §3.8, §3.11): primitives from the barrel, no colour
// literals, layout-only inline styles. Copy in Spanish.

import type { FinanceScopeState, DeclaranteLike, RegimeLike } from "../../services/financeScope";
import { declaranteLabel, declaranteNeedsAttention, regimeNotice } from "../../services/financeScope";
import { CocoaBadge } from "../cocoa/CocoaBadge";
import { CocoaCallout } from "../cocoa/CocoaCallout";
import { CocoaSelect } from "../cocoa/CocoaSelect";

export const FINANCE_SCOPE_ARIA_LABEL = "Ámbito";
export const FORCED_SCOPE_TITLE = "Se lleva por sociedad: este dato es de toda la sociedad (un NIF), no de un centro.";

export interface FinanceScopeSelectorProps {
  scope: FinanceScopeState;
  size?: "small" | "regular";
  /** Accessible name; default «Ámbito». */
  "aria-label"?: string;
  /** Disable while the screen is busy (a change would refetch). */
  disabled?: boolean;
}

/** The «Ámbito» select of a money screen; renders nothing for a single-hotel sociedad. */
export function FinanceScopeSelector({ scope, size = "small", "aria-label": ariaLabel = FINANCE_SCOPE_ARIA_LABEL, disabled = false }: FinanceScopeSelectorProps) {
  if (!scope.visible || scope.options.length === 0) return null;
  return (
    <span className="cocoa-finance-scope" data-cocoa="finance-scope" data-forced={scope.forced ? "true" : undefined} title={scope.forced ? FORCED_SCOPE_TITLE : undefined} style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%" }}>
      <CocoaSelect size={size} aria-label={ariaLabel} value={scope.value} onChange={scope.setScope} options={scope.options} disabled={disabled || scope.forced || scope.loading} />
    </span>
  );
}

export interface FinanceDeclaranteBadgeProps {
  sociedad: DeclaranteLike | null | undefined;
  size?: "small" | "regular";
}

/** «Declarante: CELUISMA S.A. · A33615980» — the sociedad behind the NIF of a model or a VAT book. */
export function FinanceDeclaranteBadge({ sociedad, size = "regular" }: FinanceDeclaranteBadgeProps) {
  if (!sociedad) return null;
  const attention = declaranteNeedsAttention(sociedad);
  const title = sociedad.source === "organization_fallback" ? "Sociedad pendiente de dar de alta: la identidad se toma de la organización." : attention ? "El NIF de la sociedad está pendiente o no supera el dígito de control: complétalo en Configuración › Estructura societaria › Datos fiscales." : "Sujeto pasivo que presenta el modelo: la sociedad, nunca un centro.";
  return (
    <CocoaBadge tone={attention ? "warning" : "neutral"} variant="outline" size={size} uppercase={false} title={title}>
      {declaranteLabel(sociedad)}
    </CocoaBadge>
  );
}

export interface FinanceRegimeCalloutProps {
  regimen: RegimeLike | null | undefined;
  /** Extra sentence of the screen (e.g. the `presentacion.noSePresenta.motivo` of a model). */
  detail?: string | null;
}

/** Warning when the sociedad is in the SII / gran empresa (R8); nothing under the general regime. */
export function FinanceRegimeCallout({ regimen, detail }: FinanceRegimeCalloutProps) {
  const notice = regimeNotice(regimen);
  if (!notice && !detail) return null;
  return (
    <CocoaCallout tone="warning" title={regimen?.siiEnabled ? "Sociedad en SII" : "Régimen de gran empresa"}>
      {[notice, detail].filter(Boolean).join(" ")}
    </CocoaCallout>
  );
}

export interface FinanceEntityNoteProps {
  scope: FinanceScopeState;
  /** What is kept per sociedad («El plan de cuentas», «El balance», «El cierre de ejercicio»). */
  subject: string;
}

/** «<Subject> se lleva por sociedad» — only when the sociedad has several centres (otherwise it says nothing new). */
export function FinanceEntityNote({ scope, subject }: FinanceEntityNoteProps) {
  if (!scope.structure || scope.structure.mode === "single_hotel") return null;
  return (
    <CocoaCallout tone="info">
      {subject} se lleva por sociedad ({scope.entityName}): agrega los {scope.structure.centres.length} centros de trabajo bajo un solo NIF y no se filtra por centro.
    </CocoaCallout>
  );
}

export default FinanceScopeSelector;

// Estructura societaria · L6 — the ONE model behind the five routed tabs of
// Configuración › Estructura societaria (Datos fiscales · Centros · Series y
// VeriFactu · IVA y ejercicio · Reparto). Every tab page calls
// `useStructureModel(view)`: it loads GET /organizations/me/structure (the
// single point of truth, design §5.4), resolves the caller's permissions on
// the real grants (`canDo(useNavGate(), clave)`, never the demo union) and
// derives the mode copy (hotel individual · sociedad con varios centros) so
// the layout is identical from any tab. No JSX here (the split layout,
// sociedad card and actions live in StructureScreen.tsx).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavGate } from "../../navigation/useEnabledModules";
import { getOrganizationStructure, type OrganizationStructure, type StructureLegalEntity, type StructureProperty } from "../../services/structureApi";
import { canDo } from "../accounting/accounting-ui";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { STRUCTURE_VIEW_SCREEN_KEYS, STRUCTURE_VIEW_TITLES, structureErrorMessage, structureEyebrow, type StructureView } from "./structure-ui";

export type { StructureView } from "./structure-ui";
export { STRUCTURE_VIEW_SCREEN_KEYS } from "./structure-ui";

export type StructurePermissions = {
  /** organization.structure.manage: sociedad and centres (alta, ficha, datos fiscales). */
  manage: boolean;
  /** accounting.configure: régimen (SII, gran empresa, PGC, ejercicio), VAT settings, allocation key. */
  configureAccounting: boolean;
  /** billing.configure: series (read the sociedad-wide list, close / reopen). */
  billing: boolean;
  /** ai.high_risk.confirm: needed together with `manage` for the high-risk fields of the sociedad. */
  highRisk: boolean;
  isPlatformAdmin: boolean;
};

export type StructureModel = {
  view: StructureView;
  structure: OrganizationStructure | null;
  legalEntity: StructureLegalEntity | null;
  properties: StructureProperty[];
  loading: boolean;
  error: unknown;
  errorMessage: string | null;
  refresh: () => void;
  /** Replace the loaded structure without a round trip (after a PATCH that returns the sociedad). */
  patchLegalEntityLocally: (next: Partial<StructureLegalEntity>) => void;
  permissions: StructurePermissions;
  /** Hotel individual: one sociedad + one hotel (design §5.6: no «grupo», no «centro», no selector). */
  singleHotel: boolean;
  /** The caller only sees its assigned centres: no NIF, series, installations nor VAT settings. */
  redacted: boolean;
  /** Header of the CocoaPage (hosted: the container paints eyebrow and H1; standalone: these). */
  header: { eyebrow: string; title: string };
  /** Name → id of every centre (error messages name the sister centre of a clash). */
  propertyNames: Record<string, string>;
};

export function useStructureModel(view: StructureView): StructureModel {
  const gate = useNavGate();
  const [structure, setStructure] = useState<OrganizationStructure | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    getOrganizationStructure()
      .then((payload) => {
        if (!mounted) return;
        setStructure(payload);
      })
      .catch((err: unknown) => {
        if (mounted) setError(err);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const patchLegalEntityLocally = useCallback((next: Partial<StructureLegalEntity>) => {
    setStructure((current) => (current && current.legalEntity ? { ...current, legalEntity: { ...current.legalEntity, ...next } } : current));
  }, []);

  const permissions = useMemo<StructurePermissions>(
    () => ({
      manage: canDo(gate, "organization.structure.manage"),
      configureAccounting: canDo(gate, "accounting.configure"),
      billing: canDo(gate, "billing.configure"),
      highRisk: canDo(gate, "ai.high_risk.confirm"),
      isPlatformAdmin: gate.isPlatformAdmin
    }),
    [gate]
  );

  const legalEntity = structure?.legalEntity ?? null;
  const properties = useMemo(() => legalEntity?.properties ?? [], [legalEntity]);
  const propertyNames = useMemo(() => Object.fromEntries(properties.map((property) => [property.id, property.tradeName ?? property.name])), [properties]);
  const header = useMemo(() => {
    const tree = treeHeaderFor(STRUCTURE_VIEW_SCREEN_KEYS[view], { eyebrow: "Configuración · Estructura societaria", title: STRUCTURE_VIEW_TITLES[view] });
    return { eyebrow: structureEyebrow(legalEntity?.legalName ?? null), title: tree.title };
  }, [view, legalEntity?.legalName]);

  return {
    view,
    structure,
    legalEntity,
    properties,
    loading,
    error,
    errorMessage: error ? structureErrorMessage(error, "No se pudo cargar la estructura de la sociedad.") : null,
    refresh,
    patchLegalEntityLocally,
    permissions,
    singleHotel: structure?.mode === "single_hotel",
    redacted: structure?.scope === "assigned_properties",
    header,
    propertyNames
  };
}

/** Current calendar year (the default of every «año» field of the wizard). */
export function currentFiscalYear(now: Date = new Date()): number {
  return now.getFullYear();
}

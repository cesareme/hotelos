// Comparador de plantillas (Tanda 8a · L4, design §5.4): painted inside the
// «Comparar plantillas» drawer of UsersRolesScreen (its <CocoaPage> host), so
// it has no header of its own. Two template pickers over ROLE_PERMISSION_MAP
// and a CocoaTable with one row per module of the §4.3 dictionary
// (users-rbac.ts `compareTemplates`): what only the first holds, what both
// hold, what only the second holds. Below, «roles con permisos idénticos»
// (`identicalRoles`): the roles of the organisation whose key sets coincide,
// the quarterly review OPERA / Mews recommend. Cocoa 22: zero inline style.

import { useMemo, useState } from "react";
import { ROLE_PERMISSION_MAP, ROLE_TEMPLATE_LABELS_ES, type PermissionKey, type RoleKey } from "@hotelos/shared";
import { CocoaBadge, CocoaField, CocoaFormRow, CocoaSection, CocoaSelect, CocoaState, CocoaTable, type CocoaTableColumn } from "../../components/cocoa";
import { plural } from "../../lib/format";
import { OFFERABLE_TEMPLATES, compareTemplates, identicalRoles, levelLabel, rankOfTemplate, templateLabel, type ModuleComparison, type RoleLike } from "./users-rbac";
import { ROLE_TEMPLATE_LEVEL } from "@hotelos/shared";

export type RoleComparePaneProps = {
  /** Roles of the organisation with their keys (managed roles resolve to their template's keys); custom roles without keys are skipped. */
  roles: readonly (RoleLike & { templateKey: string | null })[];
  initialA?: RoleKey;
  initialB?: RoleKey;
};

const TEMPLATE_OPTIONS = OFFERABLE_TEMPLATES.map((key) => ({ value: key, label: `${ROLE_TEMPLATE_LABELS_ES[key]} · ${levelLabel(ROLE_TEMPLATE_LEVEL[key])}` }));

function keysCell(keys: readonly PermissionKey[]) {
  if (keys.length === 0) return <span className="cocoa-note">—</span>;
  return (
    <span className="cocoa-stack" data-gap="1">
      <strong>{plural(keys.length, "clave", "claves")}</strong>
      <span className="cocoa-note">{keys.join(", ")}</span>
    </span>
  );
}

export function RoleComparePane(props: RoleComparePaneProps) {
  const [a, setA] = useState<RoleKey>(props.initialA ?? "receptionist");
  const [b, setB] = useState<RoleKey>(props.initialB ?? "front_office_manager");
  const comparison = useMemo(() => compareTemplates(ROLE_PERMISSION_MAP[a], ROLE_PERMISSION_MAP[b]), [a, b]);
  const twins = useMemo(() => identicalRoles(props.roles.filter((role) => role.permissions.length > 0)), [props.roles]);
  const totals = useMemo(
    () => ({
      onlyA: comparison.reduce((sum, row) => sum + row.onlyA.length, 0),
      both: comparison.reduce((sum, row) => sum + row.both.length, 0),
      onlyB: comparison.reduce((sum, row) => sum + row.onlyB.length, 0)
    }),
    [comparison]
  );

  const columns: CocoaTableColumn<ModuleComparison>[] = [
    { key: "module", label: "Módulo", render: (row) => <strong>{row.label}</strong> },
    { key: "onlyA", label: `Solo ${ROLE_TEMPLATE_LABELS_ES[a]}`, render: (row) => keysCell(row.onlyA) },
    { key: "both", label: "Comunes", render: (row) => keysCell(row.both) },
    { key: "onlyB", label: `Solo ${ROLE_TEMPLATE_LABELS_ES[b]}`, render: (row) => keysCell(row.onlyB) }
  ];

  return (
    <div className="cocoa-stack" data-gap="4">
      <CocoaFormRow columns={2} role="group" aria-label="Plantillas a comparar">
        <CocoaField label="Plantilla A" help={`${ROLE_PERMISSION_MAP[a].length} claves · rango ${rankOfTemplate(a) ?? "—"}`}>
          <CocoaSelect value={a} onChange={(value) => setA(value as RoleKey)} options={TEMPLATE_OPTIONS} />
        </CocoaField>
        <CocoaField label="Plantilla B" help={`${ROLE_PERMISSION_MAP[b].length} claves · rango ${rankOfTemplate(b) ?? "—"}`}>
          <CocoaSelect value={b} onChange={(value) => setB(value as RoleKey)} options={TEMPLATE_OPTIONS} />
        </CocoaField>
      </CocoaFormRow>

      <div className="cocoa-cluster" role="status" aria-label="Resumen de la comparación">
        <CocoaBadge tone="accent" uppercase={false}>
          {plural(totals.onlyA, "clave solo en A", "claves solo en A")}
        </CocoaBadge>
        <CocoaBadge tone="neutral" uppercase={false}>
          {plural(totals.both, "clave común", "claves comunes")}
        </CocoaBadge>
        <CocoaBadge tone="info" uppercase={false}>
          {plural(totals.onlyB, "clave solo en B", "claves solo en B")}
        </CocoaBadge>
      </div>

      <CocoaSection padding="none" scroll="x" aria-label="Claves por módulo" headingLevel={3}>
        {comparison.length === 0 ? (
          <CocoaState kind="empty" inline title="Ninguna clave en las dos plantillas." />
        ) : (
          <CocoaTable columns={columns} rows={comparison} rowKey="module" density="compact" caption="Claves por módulo del diccionario §4.3" aria-label="Claves por módulo" />
        )}
      </CocoaSection>

      <CocoaSection title="Roles con permisos idénticos" meta="revisión trimestral" headingLevel={3}>
        {twins.length === 0 ? (
          <CocoaState kind="empty" inline title="Ningún par de roles de la organización comparte exactamente las mismas claves." />
        ) : (
          <ul className="c22-section__list" aria-label="Roles con permisos idénticos">
            {twins.map((group) => (
              <li key={group.roles.map((role) => role.id).join("+")}>
                <span>{group.roles.map((role) => templateLabel(role.templateKey, role.name)).join(" = ")}</span>
                <CocoaBadge tone="warning" size="small" uppercase={false}>
                  {plural(group.permissionCount, "clave", "claves")}
                </CocoaBadge>
              </li>
            ))}
          </ul>
        )}
      </CocoaSection>
    </div>
  );
}

export default RoleComparePane;

# ComplianceCenter migration plan

Pantalla: `apps/admin-web/src/screens/compliance/ComplianceCenterScreen.tsx`
Origen: Aurora v2 (imports `../../components/States`, helpers de `complianceApi`, useApiData) con tipos `Kind = "ok" | "warn" | "error" | "info"` para semantica visual y estilos esperados `bo-*` / `cm-*` / inline.
Destino: Cocoa Design System (CocoaCard, CocoaBadge, CocoaTabs, CocoaPageHeader, CocoaTable, CocoaButton, CocoaInput, CocoaSelect, CocoaTextArea, CocoaFormField, CocoaGrid, StatTile, CocoaStack, CocoaIcon, tokens `--cocoa-*`).

Este plan cubre las primeras 200 lineas leidas (constantes, tipos, estado, helpers `openFicha`/`saveItem`/`addDocToControl`/`removeDoc`). Las lineas posteriores (render de tabs `matriz`/`documentos`/`tareas`/`alertas`/`asistente`/`ajustes`, tablas de tareas/documentos, drawer de ficha) tienen patrones equivalentes y se migran con las mismas reglas.

## Mapeo de componentes

| Linea actual | Patron Aurora detectado | Componente Cocoa equivalente |
|--|--|--|
| 26 | `import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States"` | `import { CocoaLoadingBlock, CocoaErrorState, CocoaEmptyState, CocoaSpinner } from '@hotelos/cocoa-ui'` |
| 30, 35-38, 47, 50 | Type `Kind = "ok" \| "warn" \| "error" \| "info"` + records `STATUS_KIND`/`RISK_KIND`/`SEVERITY_KIND`/`TASK_STATUS_KIND` | Type `CocoaTone = "success" \| "warning" \| "danger" \| "info"` + helper `kindToTone(k: Kind): CocoaTone` que retorna `'ok'→'success' \| 'warn'→'warning' \| 'error'→'danger' \| 'info'→'info'` |
| 31-34, 39, 44-49 | Records `STATUS_LABEL`/`RISK_LABEL`/`ALERT_KIND_LABEL`/`SEVERITY_LABEL`/`TASK_STATUS_LABEL` (i18n inline ES) | Mantener tal cual; son etiquetas de dominio (cumplimiento normativo ES) no estilos. No migran. |
| 41-43 | `EDITABLE_STATUS` array `{v,l}` para `<select>` | Pasa a `options` de `<CocoaSelect>` (mismo shape `value`/`label`) |
| 51-60 | `COMUNIDADES` + `HOTEL_TYPES` (datos para `<select>` del tab ajustes) | `options` de `<CocoaSelect>` (renombrar `v`→`value`, `l`→`label` si el componente lo exige) |
| 61-65 | `PROFILE_FEATURES` (checkboxes con `keyof ComplianceProfile`) | `<CocoaCheckboxGroup>` o `<CocoaToggle>` por feature dentro de `<CocoaFormField>` |
| 80 | `type Tab = "matriz" \| "documentos" \| "tareas" \| "alertas" \| "asistente" \| "ajustes"` | Mismo type; pasa a `value` de `<CocoaTabs>` |
| 91 | `useState<Tab>("matriz")` + render condicional manual | `<CocoaTabs value={tab} onChange={setTab} tabs={[...]} />` con `count` badges para alertas/tareas |
| 95-98 | Filtros `area`/`risk`/`status`/`query` controlados con `useState` | `<CocoaFilterBar>` con `<CocoaSelect>` x3 + `<CocoaSearchInput value={query} onChange={setQuery} />` |
| 100 | `useState<boolean>(false)` para `busy` | Misma logica; pasa a prop `loading` de `<CocoaButton>` durante mutaciones |
| 101 | `useState<string \| null>(null)` para `msg` (feedback de mutacion) | `<CocoaInlineAlert tone={msg.includes('No se pudo') ? 'danger' : 'success'}>{msg}</CocoaInlineAlert>` o `useCocoaToast()` |
| 102 | `useState<{status, responsibleName, expiryDate, notes}>` (draft de ficha) | Mismo state; los inputs pasan a `<CocoaInput>`/`<CocoaSelect>`/`<CocoaTextArea>` dentro de `<CocoaFormField label="..." />` |
| 105-107 | `fichaDocs`/`fichaDocsLoading`/`docForm` (subform de documentos) | Mismo state; UI dentro de `<CocoaDrawer>` o `<CocoaCard variant="inset">` con `<CocoaFormGrid>` |
| (no leido) ~210+ esperado `bo-page-head` + `bo-page-title` | `<CocoaPageHeader eyebrow="Compliance" title="Centro de cumplimiento" subtitle="..." actions={...} />` |
| (no leido) ~230+ esperado grid de KPIs (`data.kpis`: total/compliant/expired/expiringSoon/openTasks/pendingDocs) | `<CocoaGrid columns={{base:1, md:2, lg:6}}>` con 6 `<CocoaCard><StatTile/></CocoaCard>` |
| (no leido) ~280+ esperado tabla de controles (visible[]) | `<CocoaTable columns={[{key:'code'}, {key:'title'}, {key:'area'}, {key:'risk', render: r => <CocoaBadge tone={kindToTone(RISK_KIND[r])}>{RISK_LABEL[r]}</CocoaBadge>}, {key:'status', render: s => <CocoaBadge tone={kindToTone(STATUS_KIND[s])}>{STATUS_LABEL[s]}</CocoaBadge>}, {key:'expiry'}, {key:'actions'}]} rows={visible} onRowClick={openFicha} />` |
| (no leido) ficha drawer | `<CocoaDrawer open={!!openCode} onClose={() => setOpenCode(null)} title={control.title} size="lg">` con secciones `<CocoaSection title="Estado">`, `<CocoaSection title="Documentos">`, `<CocoaSection title="Subir documento">` |
| (no leido) tab tareas | `<CocoaTable>` + `<CocoaButton variant="primary" icon={<CocoaIcon name="plus" />}>Nueva tarea</CocoaButton>` |
| (no leido) tab alertas | Lista de `<CocoaAlertCard tone={kindToTone(SEVERITY_KIND[a.severity])} title={ALERT_KIND_LABEL[a.kind]} description={a.message} />` |
| (no leido) tab asistente | `<CocoaCard><CocoaText>{suggestion.body}</CocoaText></CocoaCard>` con `<CocoaSpinner />` mientras carga (assistantApi.loading) |
| (no leido) tab ajustes | `<CocoaForm>` con `<CocoaSelect>` comunidad + `<CocoaSelect>` tipoHotel + `<CocoaCheckboxGroup>` features + `<CocoaButton variant="primary">Guardar</CocoaButton>` |

## Cambios necesarios

1. **Imports** (linea 26): sustituir
   ```tsx
   import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
   ```
   por
   ```tsx
   import {
     CocoaCard, CocoaPageHeader, CocoaBadge, CocoaTabs, CocoaTable, CocoaButton,
     CocoaInput, CocoaSelect, CocoaTextArea, CocoaCheckbox, CocoaFormField, CocoaFormGrid,
     CocoaGrid, StatTile, CocoaStack, CocoaSearchInput, CocoaFilterBar, CocoaDrawer,
     CocoaSection, CocoaAlertCard, CocoaInlineAlert, CocoaText, CocoaHeading,
     CocoaLoadingBlock, CocoaErrorState, CocoaEmptyState, CocoaSpinner, useCocoaToast
   } from '@hotelos/cocoa-ui';
   import { CocoaIcon } from '@hotelos/cocoa-icons';
   ```

2. **Helper `kindToTone` (anadir tras linea 30)**: centraliza el mapeo Aurora→Cocoa:
   ```tsx
   type CocoaTone = 'success' | 'warning' | 'danger' | 'info';
   const KIND_TO_TONE: Record<Kind, CocoaTone> = {
     ok: 'success', warn: 'warning', error: 'danger', info: 'info'
   };
   const tone = (k: Kind) => KIND_TO_TONE[k];
   ```
   Asi todas las celdas `STATUS_KIND[c.status]` se convierten en `<CocoaBadge tone={tone(STATUS_KIND[c.status])}>{STATUS_LABEL[c.status]}</CocoaBadge>` sin tocar los records de dominio.

3. **Estados de carga/error/vacio**: cada uso de `<LoadingBlock />` pasa a `<CocoaLoadingBlock />`; `<ErrorState />` a `<CocoaErrorState onRetry={refresh} />`; `<EmptyState />` a `<CocoaEmptyState icon="shield-check" title="..." />`; `<Spinner />` a `<CocoaSpinner size="sm" />`. Mantener mismas semanticas (`loading`/`error`/`refresh` de `useApiData`).

4. **Tabs (linea 91 + render esperado)**: sustituir el `useState<Tab>` + switch manual por:
   ```tsx
   <CocoaTabs
     value={tab}
     onChange={setTab}
     tabs={[
       { value: 'matriz', label: 'Matriz' },
       { value: 'documentos', label: 'Documentos', count: allDocs.length },
       { value: 'tareas', label: 'Tareas', count: openTaskCount, tone: openTaskCount > 0 ? 'warning' : undefined },
       { value: 'alertas', label: 'Alertas', count: alertCount, tone: alertCount > 0 ? 'danger' : undefined },
       { value: 'asistente', label: 'Asistente', icon: 'sparkles' },
       { value: 'ajustes', label: 'Ajustes' }
     ]}
   />
   ```
   El badge de `alertCount`/`openTaskCount` (lineas 198-199) se renderiza dentro del tab, eliminando contadores sueltos.

5. **Filtros (lineas 95-98)**: agrupar en `<CocoaFilterBar>`:
   ```tsx
   <CocoaFilterBar>
     <CocoaSelect label="Area" value={area} onChange={setArea} options={[{value:'all', label:'Todas'}, ...areas.map(a => ({value:a.code, label:a.name}))]} />
     <CocoaSelect label="Riesgo" value={risk} onChange={setRisk} options={[{value:'all', label:'Todos'}, ...Object.entries(RISK_LABEL).map(([v,l]) => ({value:v, label:l}))]} />
     <CocoaSelect label="Estado" value={status} onChange={setStatus} options={[{value:'all', label:'Todos'}, ...Object.entries(STATUS_LABEL).map(([v,l]) => ({value:v, label:l}))]} />
     <CocoaSearchInput value={query} onChange={setQuery} placeholder="Buscar codigo/titulo/area" />
   </CocoaFilterBar>
   ```

6. **Feedback de mutaciones (`msg`, linea 101)**: encima del contenido del tab activo:
   ```tsx
   {msg && <CocoaInlineAlert tone={msg.toLowerCase().includes('no se pudo') ? 'danger' : 'success'} onDismiss={() => setMsg(null)}>{msg}</CocoaInlineAlert>}
   ```
   Alternativa preferible: `const toast = useCocoaToast()` y reemplazar `setMsg(ok)` por `toast.success(ok)` y `setMsg(err)` por `toast.error(err)` en `saveItem`/`addDocToControl`/`removeDoc` (lineas 146-196). Elimina el state `msg` y la limpieza manual.

7. **Ficha del control (drawer)**: cuando `openCode` no es null (linea 132-144) renderizar:
   ```tsx
   <CocoaDrawer open={!!openCode} onClose={() => setOpenCode(null)} title={openControl?.title} size="lg">
     <CocoaSection title="Estado">
       <CocoaFormGrid columns={2}>
         <CocoaFormField label="Estado"><CocoaSelect value={draft.status} onChange={v => setDraft({...draft, status:v})} options={EDITABLE_STATUS.map(o => ({value:o.v, label:o.l}))} /></CocoaFormField>
         <CocoaFormField label="Responsable"><CocoaInput value={draft.responsibleName} onChange={v => setDraft({...draft, responsibleName:v})} /></CocoaFormField>
         <CocoaFormField label="Vence"><CocoaInput type="date" value={draft.expiryDate} onChange={v => setDraft({...draft, expiryDate:v})} /></CocoaFormField>
         <CocoaFormField label="Notas" colSpan={2}><CocoaTextArea value={draft.notes} onChange={v => setDraft({...draft, notes:v})} rows={3} /></CocoaFormField>
       </CocoaFormGrid>
       <CocoaButton variant="primary" loading={busy} onClick={() => saveItem(openControl, draft, 'Guardado.')}>Guardar</CocoaButton>
     </CocoaSection>
     <CocoaSection title="Documentos">
       {fichaDocsLoading ? <CocoaSpinner /> : fichaDocs.length === 0
         ? <CocoaEmptyState icon="file" title="Sin documentos" />
         : <CocoaTable columns={[{key:'title'}, {key:'documentType'}, {key:'issueDate', render:fmtDate}, {key:'expiryDate', render:fmtDate}, {key:'fileSize', render:fmtSize}, {key:'actions', render:(_,d) => <CocoaButton size="sm" variant="ghost-danger" icon={<CocoaIcon name="trash" />} loading={busy} onClick={() => removeDoc(d.id, openCode)}>Eliminar</CocoaButton>}]} rows={fichaDocs} />}
     </CocoaSection>
     <CocoaSection title="Subir documento">
       <CocoaFormGrid columns={2}>
         <CocoaFormField label="Titulo" required><CocoaInput value={docForm.title} onChange={v => setDocForm({...docForm, title:v})} /></CocoaFormField>
         <CocoaFormField label="Tipo"><CocoaInput value={docForm.documentType} onChange={v => setDocForm({...docForm, documentType:v})} /></CocoaFormField>
         <CocoaFormField label="Emision"><CocoaInput type="date" value={docForm.issueDate} onChange={v => setDocForm({...docForm, issueDate:v})} /></CocoaFormField>
         <CocoaFormField label="Caducidad"><CocoaInput type="date" value={docForm.expiryDate} onChange={v => setDocForm({...docForm, expiryDate:v})} /></CocoaFormField>
       </CocoaFormGrid>
       <CocoaButton variant="primary" loading={busy} icon={<CocoaIcon name="upload" />} onClick={() => addDocToControl(openControl)}>Registrar</CocoaButton>
     </CocoaSection>
   </CocoaDrawer>
   ```

8. **Cabecera (zona no leida, ~linea 210+)**: sustituir bloque `bo-page-head`/title/subtitle por `<CocoaPageHeader eyebrow="Compliance" title="Centro de cumplimiento" subtitle="Riesgos, controles y documentos" actions={<CocoaButton variant="secondary" icon={<CocoaIcon name="refresh" />} onClick={refresh}>Actualizar</CocoaButton>} />`.

9. **KPIs (esperado tras header)**: `<CocoaGrid columns={{base:1, md:2, lg:6}} gap="md">` con `<StatTile label="Total" value={kpis.total} />`, `compliant` (tone success), `expiringSoon` (warning), `expired` (danger), `openTasks` (warning si >0), `pendingDocs`.

10. **Iconos emoji**: cualquier emoji literal pasa a `<CocoaIcon name="..." />`. Mapeos previsibles en este dominio: documento→`file`, alerta→`alert-triangle`, escudo/cumplimiento→`shield-check`, calendario/vence→`calendar`, asistente/IA→`sparkles`, tarea→`check-square`, comunidad/region→`map-pin`.

## Tokens a reemplazar

| Token Aurora | Token Cocoa |
|--|--|
| `var(--surface)` | `var(--cocoa-background-content)` |
| `var(--surface-alt)` | `var(--cocoa-background-base)` |
| `var(--ink)` | `var(--cocoa-label)` |
| `var(--ink-muted)` / `var(--muted)` | `var(--cocoa-label-secondary)` |
| `var(--border)` | `var(--cocoa-separator)` |
| `var(--accent)` | `var(--cocoa-tint-primary)` |
| `var(--success)` (kind `ok`) | `var(--cocoa-system-green)` |
| `var(--warning)` (kind `warn`) | `var(--cocoa-system-orange)` |
| `var(--danger)` (kind `error`) | `var(--cocoa-system-red)` |
| `var(--info)` | `var(--cocoa-system-blue)` |
| literales `padding/gap/margin` numericos | tokens `--cocoa-spacing-{xs,sm,md,lg,xl}` via props |
| literales `fontSize`/`fontWeight` | tipografia Cocoa via `CocoaText`/`CocoaHeading` |

Regla: tras la migracion, **cero `style={{...}}` inline** salvo grid templates dinamicos. Toda semantica visual de `Kind` pasa por `tone` de `CocoaBadge`/`CocoaAlertCard`/`StatTile`.

## Riesgo

**High**. Razones:
- Pantalla de cumplimiento normativo: el contenido textual (etiquetas de estados, riesgos, comunidades autonomas) es **regulatorio** y no puede alterarse al refactorizar. Mantener intacto cada record `*_LABEL`.
- Superficie grande: 6 tabs (`matriz`, `documentos`, `tareas`, `alertas`, `asistente`, `ajustes`), drawer de ficha con sub-form de documentos, CRUD completo (`updateComplianceItem`, `createComplianceDocument`, `deleteComplianceDocument`, `createComplianceTask`, `updateComplianceTask`, `deleteComplianceTask`, `updateComplianceProfile`).
- 4 hooks `useApiData` con polling distinto (60s, 0, lazy en tab asistente linea 94); preservar `pollIntervalMs` y la condicion `tab === "asistente"` para evitar llamadas LLM innecesarias.
- Filtros derivados (`useMemo` linea 117-123) y estado de ficha (`openCode`, `draft`, `docForm`) acoplados: cambiar a componentes controlados de Cocoa requiere mantener exactamente las mismas firmas de `onChange`.
- Mutaciones encadenan `refresh()` + `alertsApi.refresh()` + `docsApi.refresh()` (lineas 151, 176, 190): no perder ninguno o los contadores de tabs quedan stale.
- Sin tests visuales en el archivo y modulo critico de negocio → snapshot manual antes/despues obligatorio.

Mitigacion: migrar por tab en commits separados (matriz primero como demo del patron `CocoaTable`+`CocoaBadge`, luego documentos, tareas, alertas, asistente, ajustes). Conservar texto literal de cada label. Smoke test manual de cada CRUD post-migracion (crear/editar/borrar doc, tarea, item).

## Estimacion

- **Agents**: 3 agentes en paralelo tras una fase 0 secuencial.
  - **Fase 0 (secuencial, ~30 min)**: imports + helper `kindToTone` + estados de carga/error/vacio + `<CocoaPageHeader>` + KPIs + `<CocoaTabs>` + `<CocoaFilterBar>`. Deja la base lista. ~120 lineas.
  - **Agent A (paralelo)**: tab `matriz` (tabla de controles, ficha drawer, CRUD `updateComplianceItem` + documentos asociados). ~350 lineas. **El mas pesado**.
  - **Agent B (paralelo)**: tabs `documentos` + `tareas` (dos `CocoaTable` con CRUD: `createComplianceDocument`/`delete`, `createComplianceTask`/`update`/`delete`). ~250 lineas.
  - **Agent C (paralelo)**: tabs `alertas` + `asistente` + `ajustes` (lista de `CocoaAlertCard`, render lazy del asistente, formulario `updateComplianceProfile` con `COMUNIDADES`/`HOTEL_TYPES`/`PROFILE_FEATURES`). ~200 lineas.
- **Tiempo estimado**: Fase 0 30 min, Agent A 120 min, Agent B 90 min, Agent C 75 min, revision conjunta + ajuste tokens residuales + smoke test CRUD 40 min. Total **~3,5-4 h** wall-clock con paralelizacion (Fase 0 → A/B/C en paralelo → revision).
- **Bloqueantes potenciales**: que existan en `@hotelos/cocoa-ui` los componentes `CocoaTabs` (con `count`/`tone` por tab), `CocoaFilterBar`, `CocoaDrawer`, `CocoaSection`, `CocoaFormGrid`, `CocoaFormField`, `CocoaAlertCard`, `CocoaInlineAlert`, `CocoaSearchInput`, `useCocoaToast`. Si falta `CocoaDrawer` o `CocoaFormGrid`, la Fase 0 debe crearlos (suma ~45-60 min cada uno). Verificar antes de empezar.

Orden recomendado: Fase 0 obligatoria primero (deja imports, tabs y filtros listos); luego A/B/C en paralelo sobre la misma base; revision final consolidada con QA manual de cada CRUD.

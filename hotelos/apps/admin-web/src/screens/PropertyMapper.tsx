// Property mapper (Configuración › Puesta en marcha › Importar desde documentos).
// Cocoa 22 · ola 10 · lote 10-C (workspace archetype): documents on the left
// (dashed drop zone, staged files, «Mapear con IA»), the proposed map on the
// right (KPI strip, room types, proposed rooms table, apply through a
// CocoaDialog), and the live structure of the property below. The extraction
// and apply calls, the example CSV and the reading of text files are untouched.
import { useEffect, useRef, useState, type DragEvent } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import {
  extractPropertyMap,
  applyPropertyMap,
  type MapperFile,
  type PropertyMapProposal,
  type ProposedRoom,
  type ApplyResult
} from "../services/mapperApi";
import { fetchRooms, fetchRoomTypes, type AdminRoom, type AdminRoomType } from "../services/pmsCommerceApi";
import { EMPTY, plural } from "../lib/format";
import { ACTIONS, STATUS_LABELS } from "../content/actions";
import { treeHeaderFor } from "./tabs/tab-helpers";
import { DownloadIcon, UploadIcon, XmarkIcon } from "../components/cocoa-icons/ActionIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  formatFileSize,
  type CocoaTableColumn,
  type CocoaTone
} from "../components/cocoa";

const PROPERTY_ID = getActivePropertyId();
const TEXT_EXT = /\.(csv|tsv|txt|json|md|tab)$/i;

function isTextLike(file: File): boolean {
  return TEXT_EXT.test(file.name) || /(csv|text|json|plain|tab-separated)/i.test(file.type);
}

function readFile(file: File): Promise<MapperFile> {
  return new Promise((resolve) => {
    if (!isTextLike(file)) {
      resolve({ name: file.name, mimeType: file.type });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mimeType: file.type, text: String(reader.result ?? "") });
    reader.onerror = () => resolve({ name: file.name, mimeType: file.type });
    reader.readAsText(file);
  });
}

const SOURCE_LABEL: Record<PropertyMapProposal["source"], { label: string; tone: CocoaTone }> = {
  rules: { label: "Leído de tu fichero", tone: "success" },
  ai: { label: "Extracción por IA", tone: "ai" },
  none: { label: "No se detectó nada", tone: "warning" }
};

type StagedFile = { name: string; size: number; mf: MapperFile };

type CurrentRoomRow = { id: string; number: string; floor: string; typeName: string; status: string; sellable: boolean };

const EXAMPLE_CSV =
  "room,floor,building,zone,type,beds,features,sellable\n" +
  "101,1,Main,East Wing,Double,Queen x1,balcony;city_view,yes\n" +
  "102,1,Main,East Wing,Double,Twin x2,accessible,yes\n" +
  "201,2,Main,West Wing,Junior Suite,King x1,balcony;minibar,yes\n" +
  "P01,-1,Main,Parking,Parking space,,,no\n";

const CURRENT_ROOMS_LIMIT = 50;

const HEADER = treeHeaderFor("PropertyMapper", { eyebrow: "Configuración · Puesta en marcha", title: "Importar desde documentos" });

// Columns outside the component (§4.2 A5); `render` returns a ReactNode.
const PROPOSED_COLUMNS: CocoaTableColumn<ProposedRoom>[] = [
  { key: "number", label: "Habitación", fit: true, render: (room) => <strong>{room.number}</strong> },
  { key: "building", label: "Edificio", render: (room) => room.building || "Propiedad" },
  { key: "floor", label: "Planta", fit: true, render: (room) => (room.floor ? `Planta ${room.floor}` : "Sin asignar") },
  { key: "roomTypeName", label: "Tipo de habitación", render: (room) => room.roomTypeName ?? EMPTY, hideOnNarrow: true },
  { key: "zone", label: "Zona", render: (room) => room.zone ?? EMPTY, showFrom: "laptop" }
];

const CURRENT_COLUMNS: CocoaTableColumn<CurrentRoomRow>[] = [
  { key: "number", label: "Habitación", fit: true, render: (room) => <strong>{room.number}</strong> },
  { key: "floor", label: "Planta", fit: true },
  { key: "typeName", label: "Tipo de habitación" },
  {
    key: "status",
    label: "Estado",
    fit: true,
    hideOnNarrow: true,
    render: (room) => (
      <CocoaBadge tone="neutral" uppercase={false}>
        {room.status}
      </CocoaBadge>
    )
  },
  { key: "sellable", label: "Vendible", fit: true, render: (room) => (room.sellable ? STATUS_LABELS.yes : STATUS_LABELS.no) }
];

const proposedRoomKey = (room: ProposedRoom) => `${room.building ?? ""}·${room.floor ?? ""}·${room.number}`;

export function PropertyMapper() {
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [proposal, setProposal] = useState<PropertyMapProposal | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Live "current structure" snapshot.
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);

  function loadCurrent() {
    void fetchRooms(PROPERTY_ID).then(setRooms).catch(() => setRooms([]));
    void fetchRoomTypes(PROPERTY_ID).then(setRoomTypes).catch(() => setRoomTypes([]));
  }
  useEffect(loadCurrent, []);

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    const parsed = await Promise.all(incoming.map(async (f) => ({ name: f.name, size: f.size, mf: await readFile(f) })));
    setStaged((cur) => {
      const names = new Set(cur.map((s) => s.name));
      return [...cur, ...parsed.filter((p) => !names.has(p.name))];
    });
    setProposal(null);
    setResult(null);
    setConfirmApply(false);
    setStatus(null);
  }

  function removeFile(name: string) {
    setStaged((cur) => cur.filter((s) => s.name !== name));
  }
  function clearAll() {
    setStaged([]);
    setProposal(null);
    setResult(null);
    setStatus(null);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    void addFiles(event.dataTransfer.files);
  }

  function downloadExample() {
    const blob = new Blob([EXAMPLE_CSV], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "property-map-example.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleExtract() {
    if (staged.length === 0) {
      setStatus("Añade al menos un documento primero.");
      return;
    }
    setExtracting(true);
    setStatus(null);
    setProposal(null);
    setResult(null);
    setConfirmApply(false);
    try {
      const p = await extractPropertyMap(PROPERTY_ID, staged.map((s) => s.mf));
      setProposal(p);
      if (p.source === "none") setStatus(p.message ?? "No se detectó nada en los documentos.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "La extracción ha fallado.");
    } finally {
      setExtracting(false);
    }
  }

  // Confirmed from the CocoaDialog: one call, the dialog closes when it resolves.
  async function handleApply() {
    if (!proposal) return;
    setApplying(true);
    setStatus(null);
    try {
      const r = await applyPropertyMap(PROPERTY_ID, proposal);
      setResult(r);
      setConfirmApply(false);
      setStatus(`Listo — ${r.roomTypesCreated} tipos de habitación y ${r.roomsCreated} habitaciones creadas (${r.roomsSkipped} omitidas).`);
      loadCurrent();
    } catch (error) {
      setConfirmApply(false);
      setStatus(error instanceof Error ? error.message : "La aplicación ha fallado.");
    } finally {
      setApplying(false);
    }
  }

  const statusTone: CocoaTone = status?.startsWith("Listo") ? "success" : "warning";
  const proposalReady = proposal !== null && proposal.source !== "none";
  const currentRows: CurrentRoomRow[] = rooms.slice(0, CURRENT_ROOMS_LIMIT).map((room) => ({
    id: room.id,
    number: room.number,
    floor: room.floor || EMPTY,
    typeName: roomTypes.find((type) => type.id === room.roomTypeId)?.name ?? room.roomTypeId,
    status: room.status,
    sellable: room.sellable
  }));

  const documents = (
    <CocoaSection title="Documentos" meta={staged.length > 0 ? plural(staged.length, "documento", "documentos") : undefined} aria-label="Documentos a mapear">
      <div onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} data-drag-over={dragOver ? "true" : undefined}>
        <CocoaState
          kind="empty"
          dashed
          title={dragOver ? "Suelta los documentos para añadirlos" : "Arrastra documentos aquí o elígelos desde tu equipo"}
          message="Las listas de habitaciones y exportaciones (CSV, hoja de cálculo, texto) se leen al instante, sin IA. Los PDF e imágenes necesitan un proveedor de visión IA configurado."
          primaryAction={{ label: "Elegir documentos", onClick: () => inputRef.current?.click() }}
          secondaryAction={{ label: "Descargar CSV de ejemplo", onClick: downloadExample }}
        />
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          tabIndex={-1}
          aria-hidden="true"
          accept=".csv,.tsv,.txt,.json,.md,.pdf,image/*,text/*"
          onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ""; }}
        />
      </div>

      {staged.length ? (
        <ul className="c22-section__list" aria-label="Documentos añadidos">
          {staged.map((s) => (
            <li key={s.name}>
              <span>{s.name}</span>
              <span className="cocoa-note">{formatFileSize(s.size)}</span>
              <CocoaButton variant="plain" tone="neutral" size="small" aria-label={`Quitar ${s.name}`} icon={<XmarkIcon size={14} />} onClick={() => removeFile(s.name)} />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="cocoa-row" data-gap="2">
        <CocoaButton
          variant="filled"
          tone="accent"
          icon={<UploadIcon size={16} />}
          onClick={() => void handleExtract()}
          loading={extracting}
          disabled={extracting || staged.length === 0}
          title={staged.length === 0 ? "Añade un documento primero" : undefined}
        >
          {extracting ? "Mapeando…" : staged.length > 1 ? `Mapear ${staged.length} documentos con IA` : "Mapear con IA"}
        </CocoaButton>
        <CocoaButton variant="bordered" tone="neutral" icon={<DownloadIcon size={16} />} onClick={downloadExample}>
          Descargar CSV de ejemplo
        </CocoaButton>
        {staged.length ? (
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={clearAll}>
            Quitar todo
          </CocoaButton>
        ) : null}
      </div>

      {status ? (
        <CocoaCallout tone={statusTone} role="status">
          {status}
        </CocoaCallout>
      ) : null}
    </CocoaSection>
  );

  const proposalPanel = proposalReady && proposal ? (
    <CocoaSection title="Mapa de propiedad propuesto" meta={<CocoaBadge tone={SOURCE_LABEL[proposal.source].tone}>{SOURCE_LABEL[proposal.source].label}</CocoaBadge>}>
      <CocoaCallout tone="info" title="Revisa antes de aplicar">
        Las habitaciones existentes (por número) se omiten. No se crea nada hasta que confirmes.
      </CocoaCallout>

      <CocoaKpiStrip min={180} aria-label="Elementos detectados">
        <CocoaKpi label="Edificios" value={proposal.counts.buildings} size="compact" polarity="neutral" />
        <CocoaKpi label="Plantas" value={proposal.counts.floors} size="compact" polarity="neutral" />
        <CocoaKpi label="Zonas" value={proposal.counts.zones} size="compact" polarity="neutral" />
        <CocoaKpi label="Tipos de habitación" value={proposal.counts.roomTypes} size="compact" polarity="neutral" />
        <CocoaKpi label="Habitaciones" value={proposal.counts.rooms} size="compact" polarity="neutral" />
        <CocoaKpi label="Espacios" value={proposal.counts.spaces} size="compact" polarity="neutral" />
      </CocoaKpiStrip>

      {proposal.roomTypes.length ? (
        <div className="cocoa-cluster" aria-label="Tipos de habitación propuestos">
          <span className="cocoa-note">Tipos de habitación:</span>
          {proposal.roomTypes.map((t) => (
            <CocoaBadge key={t.name} tone="neutral" uppercase={false}>
              {t.name}
            </CocoaBadge>
          ))}
        </div>
      ) : null}

      {proposal.rooms.length === 0 ? (
        <CocoaState kind="empty" inline title="La propuesta no incluye habitaciones." />
      ) : (
        <CocoaTable columns={PROPOSED_COLUMNS} rows={proposal.rooms} rowKey={proposedRoomKey} virtualize caption="Habitaciones propuestas" aria-label="Habitaciones propuestas" />
      )}

      <div className="cocoa-row" data-gap="2">
        <CocoaButton variant="filled" tone="accent" onClick={() => setConfirmApply(true)} disabled={applying || proposal.rooms.length === 0} loading={applying}>
          Aplicar a la propiedad
        </CocoaButton>
      </div>

      {result ? (
        <CocoaCallout tone="success" title="Mapa aplicado" role="status">
          <div className="cocoa-stack" data-gap="2">
            <div className="cocoa-cluster">
              <CocoaBadge tone="success">{plural(result.roomTypesCreated, "tipo de habitación creado", "tipos de habitación creados")}</CocoaBadge>
              <CocoaBadge tone="success">{plural(result.roomsCreated, "habitación creada", "habitaciones creadas")}</CocoaBadge>
              {result.roomsSkipped ? <CocoaBadge tone="warning">{plural(result.roomsSkipped, "omitida", "omitidas")}</CocoaBadge> : null}
            </div>
            {result.notes.map((n) => (
              <span className="cocoa-note" key={n}>
                {n}
              </span>
            ))}
          </div>
        </CocoaCallout>
      ) : null}
    </CocoaSection>
  ) : proposal && proposal.source === "none" ? (
    <CocoaSection title="Mapa de propiedad propuesto" meta={<CocoaBadge tone={SOURCE_LABEL.none.tone}>{SOURCE_LABEL.none.label}</CocoaBadge>}>
      <CocoaState
        kind="empty"
        illustration="search"
        title="No se pudieron mapear estos documentos"
        message={proposal.message ?? "Sube una hoja de cálculo/CSV con la lista de habitaciones, o configura un proveedor de IA para PDF y ficheros no estructurados."}
      />
    </CocoaSection>
  ) : (
    <CocoaSection title="Mapa de propiedad propuesto">
      <CocoaState kind="empty" illustration="box" title="Aún no hay propuesta" message="Añade documentos y pulsa «Mapear con IA»: la estructura detectada aparece aquí para que la revises antes de aplicarla." />
    </CocoaSection>
  );

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle="Mapeador de propiedad asistido por IA. Mapea tu propiedad desde documentos: sube tu lista de habitaciones, planos o exportaciones (CSV, hoja de cálculo, texto, PDF) y el mapeador propone la estructura completa —edificios, plantas, zonas, tipos de habitación y habitaciones— para que la revises antes de crear nada."
      actions={<CocoaBadge tone="ai">Asistido por IA</CocoaBadge>}
      commands={[{ id: "property-mapper-extract", label: "Mapear documentos con IA", run: () => { void handleExtract(); } }]}
    >
      <CocoaGrid align="start" aria-label="Documentos y propuesta">
        <CocoaSpan cols={5} min={320}>{documents}</CocoaSpan>
        <CocoaSpan cols={7} min={480}>{proposalPanel}</CocoaSpan>
      </CocoaGrid>

      {/* Current structure (live) */}
      <CocoaSection
        title="Lo que hay mapeado ahora"
        meta={`${plural(roomTypes.length, "tipo de habitación", "tipos de habitación")} · ${plural(rooms.length, "habitación", "habitaciones")}`}
        padding={currentRows.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        footer={rooms.length > CURRENT_ROOMS_LIMIT ? <span>Mostrando las primeras {CURRENT_ROOMS_LIMIT} de {rooms.length}.</span> : undefined}
      >
        {currentRows.length === 0 ? (
          <CocoaState kind="empty" inline title="Aún no hay habitaciones mapeadas. Añade un documento en «Documentos» para empezar." />
        ) : (
          <CocoaTable columns={CURRENT_COLUMNS} rows={currentRows} rowKey="id" caption="Estructura actual de la propiedad" aria-label="Estructura actual de la propiedad" />
        )}
      </CocoaSection>

      <CocoaDialog
        open={confirmApply}
        onClose={() => setConfirmApply(false)}
        title="¿Aplicar el mapa a la propiedad?"
        description={
          proposal
            ? `Se crearán ${plural(proposal.counts.roomTypes, "tipo de habitación", "tipos de habitación")} y ${plural(proposal.counts.rooms, "habitación", "habitaciones")}. Las habitaciones que ya existen (por número) se omiten.`
            : undefined
        }
        confirmLabel="Confirmar y crear"
        cancelLabel={ACTIONS.cancel}
        onConfirm={handleApply}
        busy={applying}
      />
    </CocoaPage>
  );
}

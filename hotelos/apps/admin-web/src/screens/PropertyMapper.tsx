import { getActivePropertyId } from "../services/activeProperty";
import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  extractPropertyMap,
  applyPropertyMap,
  type MapperFile,
  type PropertyMapProposal,
  type ApplyResult
} from "../services/mapperApi";
import { fetchRooms, fetchRoomTypes, type AdminRoom, type AdminRoomType } from "../services/pmsCommerceApi";
import { Spinner, EmptyState } from "../components/States";

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

const SOURCE_LABEL: Record<PropertyMapProposal["source"], { label: string; cls: string }> = {
  rules: { label: "Leído de tu fichero", cls: "ok" },
  ai: { label: "Extracción por IA", cls: "ai" },
  none: { label: "No se detectó nada", cls: "warn" }
};

type StagedFile = { name: string; size: number; mf: MapperFile };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const EXAMPLE_CSV =
  "room,floor,building,zone,type,beds,features,sellable\n" +
  "101,1,Main,East Wing,Double,Queen x1,balcony;city_view,yes\n" +
  "102,1,Main,East Wing,Double,Twin x2,accessible,yes\n" +
  "201,2,Main,West Wing,Junior Suite,King x1,balcony;minibar,yes\n" +
  "P01,-1,Main,Parking,Parking space,,,no\n";

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

  async function handleApply() {
    if (!proposal) return;
    if (!confirmApply) {
      setConfirmApply(true);
      return;
    }
    setApplying(true);
    setStatus(null);
    try {
      const r = await applyPropertyMap(PROPERTY_ID, proposal);
      setResult(r);
      setConfirmApply(false);
      setStatus(`Listo — ${r.roomTypesCreated} tipos de habitación y ${r.roomsCreated} habitaciones creadas (${r.roomsSkipped} omitidas).`);
      loadCurrent();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "La aplicación ha fallado.");
    } finally {
      setApplying(false);
    }
  }

  // Group proposed rooms by building → floor for the preview tree.
  const tree = proposal
    ? (() => {
        const byBuilding = new Map<string, Map<string, typeof proposal.rooms>>();
        for (const r of proposal.rooms) {
          const b = r.building || "Propiedad";
          const f = r.floor ? `Planta ${r.floor}` : "Planta sin asignar";
          if (!byBuilding.has(b)) byBuilding.set(b, new Map());
          const floors = byBuilding.get(b)!;
          if (!floors.has(f)) floors.set(f, []);
          floors.get(f)!.push(r);
        }
        return Array.from(byBuilding.entries());
      })()
    : [];

  return (
    <>
      {/* Header */}
      <section className="bo-card">
        <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
          <div>
            <p className="bo-page-eyebrow">Back Office · Mapeador de propiedad</p>
            <h2 className="bo-page-title" style={{ fontSize: "var(--fs-2xl)" }}>Mapea tu propiedad desde documentos</h2>
          </div>
          <span className="bo-chip">Asistido por IA</span>
        </div>
        <p className="bo-page-subtitle" style={{ marginTop: 0 }}>
          Sube tu lista de habitaciones, planos o exportaciones de la propiedad (CSV / hoja de cálculo / texto / PDF). El mapeador los lee y
          propone la estructura completa —edificios, plantas, zonas, tipos de habitación y habitaciones— para que la revises antes de crear nada.
        </p>

        {/* Dropzone */}
        <div
          className={`bo-dropzone${dragOver ? " is-drag" : ""}`}
          role="button"
          tabIndex={0}
          style={{ marginTop: "var(--space-4)" }}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inputRef.current?.click(); } }}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <div className="bo-dropzone-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 15V4M12 4 8 8M12 4l4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </div>
          <span className="bo-dropzone-title">Arrastra documentos aquí, o haz clic para buscar</span>
          <span className="bo-dropzone-hint">
            Las listas de habitaciones y exportaciones (CSV, hoja de cálculo, texto) se leen al instante, sin IA. Los PDF e imágenes necesitan un proveedor de visión IA configurado.
          </span>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".csv,.tsv,.txt,.json,.md,.pdf,image/*,text/*"
            style={{ display: "none" }}
            onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ""; }}
          />
        </div>

        {/* Staged files */}
        {staged.length ? (
          <div className="bo-pill-row" style={{ marginTop: "var(--space-3)" }}>
            {staged.map((s) => (
              <span className="bo-file-chip" key={s.name}>
                <span className="bo-file-chip-name">{s.name}</span>
                <span className="bo-file-chip-size">{formatBytes(s.size)}</span>
                <button type="button" className="bo-file-chip-remove" aria-label={`Quitar ${s.name}`} onClick={() => removeFile(s.name)}>×</button>
              </span>
            ))}
            <button type="button" className="ghost" onClick={clearAll}>Quitar todo</button>
          </div>
        ) : null}

        {/* Actions */}
        <div className="bo-actions" style={{ marginTop: "var(--space-4)", alignItems: "center" }}>
          <button
            type="button"
            className="primary"
            onClick={handleExtract}
            disabled={extracting || staged.length === 0}
            title={staged.length === 0 ? "Añade un documento primero" : undefined}
          >
            {extracting ? <><Spinner size="sm" /> Mapeando…</> : staged.length > 1 ? `Mapear ${staged.length} documentos con IA` : "Mapear con IA"}
          </button>
          <button type="button" onClick={downloadExample}>Descargar CSV de ejemplo</button>
        </div>
        {status ? <p className={status.startsWith("Listo") ? "bo-status ok" : "bo-muted"} style={{ marginTop: "var(--space-3)", textTransform: "none", letterSpacing: 0, display: "inline-flex" }}>{status}</p> : null}
      </section>

      {/* Proposal preview */}
      {proposal && proposal.source !== "none" ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <div>
              <p className="bo-muted">Mapa de propiedad propuesto</p>
              <h3 style={{ margin: 0 }}>Revisa antes de aplicar</h3>
            </div>
            <span className={`bo-status ${SOURCE_LABEL[proposal.source].cls}`}>{SOURCE_LABEL[proposal.source].label}</span>
          </div>

          <div className="rev-kpi-grid" style={{ marginBottom: "var(--space-4)" }}>
            {([
              ["Edificios", proposal.counts.buildings],
              ["Plantas", proposal.counts.floors],
              ["Zonas", proposal.counts.zones],
              ["Tipos de habitación", proposal.counts.roomTypes],
              ["Habitaciones", proposal.counts.rooms],
              ["Espacios", proposal.counts.spaces]
            ] as const).map(([label, value]) => (
              <div className="rev-kpi" key={label}>
                <span className="rev-kpi-label">{label}</span>
                <span className="rev-kpi-value">{value}</span>
              </div>
            ))}
          </div>

          {proposal.roomTypes.length ? (
            <div className="bo-pill-row" style={{ marginBottom: "var(--space-4)" }}>
              <span className="bo-muted">Tipos de habitación:</span>
              {proposal.roomTypes.map((t) => <span className="bo-pill" key={t.name}>{t.name}</span>)}
            </div>
          ) : null}

          <div className="bo-table-wrap">
            <ul className="bo-list" style={{ gap: "var(--space-2)" }}>
              {tree.map(([building, floors]) => (
                <li key={building} style={{ display: "block" }}>
                  <strong>{building}</strong>
                  <ul className="bo-list" style={{ marginTop: 4, marginLeft: "var(--space-4)" }}>
                    {Array.from(floors.entries()).map(([floor, fr]) => (
                      <li key={floor} style={{ display: "block" }}>
                        <span className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>{floor}</span> — {fr.length} habitaciones
                        <div className="bo-pill-row" style={{ marginTop: 4, marginLeft: "var(--space-4)" }}>
                          {fr.slice(0, 24).map((r) => (
                            <span className="bo-pill" key={r.number} title={[r.roomTypeName, r.zone].filter(Boolean).join(" · ")}>{r.number}</span>
                          ))}
                          {fr.length > 24 ? <span className="bo-muted">+{fr.length - 24} más</span> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>

          <div className="bo-actions" style={{ marginTop: "var(--space-4)" }}>
            <button type="button" className={confirmApply ? "danger" : "primary"} onClick={handleApply} disabled={applying || proposal.rooms.length === 0}>
              {applying
                ? <><Spinner size="sm" /> Aplicando…</>
                : confirmApply
                  ? `Confirmar — crear ${proposal.counts.roomTypes} tipos + ${proposal.counts.rooms} habitaciones`
                  : "Aplicar a la propiedad"}
            </button>
            {confirmApply ? <button type="button" onClick={() => setConfirmApply(false)}>Cancelar</button> : null}
            <small className="bo-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
              Las habitaciones existentes (por número) se omiten. No se crea nada hasta que confirmes.
            </small>
          </div>

          {result ? (
            <div className="bo-stack" style={{ marginTop: "var(--space-3)" }}>
              <div className="bo-pill-row">
                <span className="bo-status ok">{result.roomTypesCreated} tipos de habitación creados</span>
                <span className="bo-status ok">{result.roomsCreated} habitaciones creadas</span>
                {result.roomsSkipped ? <span className="bo-status warn">{result.roomsSkipped} omitidas</span> : null}
              </div>
              {result.notes.map((n) => <small className="bo-muted" key={n} style={{ textTransform: "none", letterSpacing: 0 }}>{n}</small>)}
            </div>
          ) : null}
        </section>
      ) : null}

      {proposal && proposal.source === "none" ? (
        <section className="bo-card">
          <EmptyState
            title="No se pudieron mapear estos documentos"
            message={proposal.message ?? "Sube una hoja de cálculo/CSV con la lista de habitaciones, o configura un proveedor de IA para PDF y ficheros no estructurados."}
          />
        </section>
      ) : null}

      {/* Current structure (live) */}
      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Estructura actual</p>
            <h3 style={{ margin: 0 }}>Lo que hay mapeado ahora</h3>
          </div>
          <div className="bo-pill-row">
            <span className="bo-chip">{roomTypes.length} tipos de habitación</span>
            <span className="bo-chip">{rooms.length} habitaciones</span>
          </div>
        </div>
        {rooms.length === 0 ? (
          <p className="bo-muted">Aún no hay habitaciones mapeadas. Sube un documento arriba para empezar.</p>
        ) : (
          <div className="bo-table-wrap">
            <table>
              <thead><tr><th>Habitación</th><th>Planta</th><th>Tipo</th><th>Estado</th><th>Vendible</th></tr></thead>
              <tbody>
                {rooms.slice(0, 50).map((r) => {
                  const rt = roomTypes.find((t) => t.id === r.roomTypeId);
                  return (
                    <tr key={r.id}>
                      <td><strong>{r.number}</strong></td>
                      <td>{r.floor || "—"}</td>
                      <td>{rt?.name ?? r.roomTypeId}</td>
                      <td><span className="bo-chip">{r.status}</span></td>
                      <td>{r.sellable ? "Sí" : "No"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rooms.length > 50 ? <p className="bo-muted" style={{ marginTop: 8 }}>Mostrando las primeras 50 de {rooms.length}.</p> : null}
          </div>
        )}
      </section>
    </>
  );
}

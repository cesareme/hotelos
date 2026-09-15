// Guests list — Recepción › Huéspedes › Listado (/recepcion/huespedes).
//
// Cocoa 22 pilot of the «lista / tabla» archetype (docs/design/COCOA-22.md
// §4): CocoaPage → CocoaToolbar (content: search) → CocoaSection (padding
// none) → CocoaTable (a row opens the guest record) → footer with the count
// and «Cargar más» (cursor pagination; the API caps a page at 200). Below
// 600 px the table paints stacked label/value cards by itself.
//
// Hosted inside HuespedesTabs the container already paints the title, the
// subtitle and the «Nuevo huésped» action; standalone the page paints them.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { fetchGuests, type GuestProfile } from "../../services/guestsApi";
import { useTabHost } from "../tabs/TabHost";
import { urlForScreen } from "../../navigation/nav-tree";
import { newLabel } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";

// Rows per page (API caps at 200); "Cargar más" walks the cursor. With a
// search term the API answers a single merged page (nextCursor: null).
const PAGE_SIZE = 50;

// Ficha del huésped: /recepcion/huespedes/:id (tab of the Huéspedes container, Tanda 5).
function openGuest(id: string) {
  const url = urlForScreen("GuestDetail", { id });
  if (url) openTabPath(url);
}

// Secondary line under a cell value (nationality, phone): caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

const COLUMNS: CocoaTableColumn<GuestProfile>[] = [
  {
    key: "name",
    label: "Nombre",
    render: (g) => (
      <>
        <strong>
          {g.title ? `${g.title} ` : ""}
          {g.fullName || g.firstName}
        </strong>
        {g.nationality ? <span style={subStyle}>{g.nationality}</span> : null}
      </>
    )
  },
  {
    key: "document",
    label: "Documento",
    render: (g) => (g.documentType ? `${g.documentType} ${g.documentNumber ?? ""}` : (g.documentNumber ?? "—"))
  },
  {
    key: "contact",
    label: "Contacto",
    render: (g) => (
      <>
        {g.email ?? "—"}
        {g.phone || g.mobilePhone ? <span style={subStyle}>{g.mobilePhone ?? g.phone}</span> : null}
      </>
    )
  },
  { key: "company", label: "Empresa", render: (g) => g.company ?? "—" },
  {
    key: "vip",
    label: "VIP / Fidelización",
    render: (g) =>
      g.vipCode || g.loyaltyTier ? (
        <span className="cocoa-cluster">
          {g.vipCode ? <CocoaBadge tone="info">{g.vipCode}</CocoaBadge> : null}
          {g.loyaltyTier ? <CocoaBadge tone="neutral">{g.loyaltyTier}</CocoaBadge> : null}
        </span>
      ) : (
        "—"
      )
  }
];

export function GuestsListScreen() {
  const hosted = useTabHost() !== null;
  const [guests, setGuests] = useState<GuestProfile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ignore stale responses when the user keeps typing.
  const requestSeq = useRef(0);

  function load(term: string) {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    fetchGuests({ search: term, limit: PAGE_SIZE })
      .then((page) => {
        if (seq !== requestSeq.current) return;
        setGuests(page.items);
        setNextCursor(page.nextCursor);
        setTotal(page.total);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : "No se pudieron cargar los huéspedes");
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchGuests({ search, limit: PAGE_SIZE, cursor: nextCursor });
      setGuests((current) => {
        const seen = new Set(current.map((g) => g.id));
        return [...current, ...page.items.filter((g) => !seen.has(g.id))];
      });
      setNextCursor(page.nextCursor);
      setTotal(page.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar más huéspedes");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    load("");
  }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(search), 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const newGuestLabel = newLabel("m", "huésped");
  const ready = !loading && !error && guests.length > 0;

  const footer = ready ? (
    <>
      <span>
        {guests.length}
        {total !== null ? ` de ${total}` : ""} huéspedes
      </span>
      {nextCursor ? (
        <CocoaButton variant="bordered" tone="neutral" size="small" loading={loadingMore} onClick={() => void loadMore()}>
          Cargar más
        </CocoaButton>
      ) : null}
    </>
  ) : undefined;

  let body;
  if (loading) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Huéspedes" />;
  } else if (error) {
    body = <CocoaState kind="error" title="No se pudieron cargar los huéspedes" message={error} onRetry={() => load(search)} />;
  } else if (guests.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={search ? "search" : "box"}
        title={search ? "Sin resultados" : "Aún no hay huéspedes"}
        message={search ? "Ningún huésped coincide con la búsqueda. Prueba con otro término." : "Los perfiles se crean automáticamente al registrar reservas, o créalos manualmente."}
        primaryAction={{ label: newGuestLabel, onClick: () => openGuest("new") }}
      />
    );
  } else {
    body = <CocoaTable columns={COLUMNS} rows={guests} rowKey="id" onSelect={(g) => openGuest(g.id)} caption="Huéspedes" aria-label="Huéspedes" />;
  }

  return (
    <CocoaPage
      eyebrow="Recepción · Huéspedes"
      title="Huéspedes"
      subtitle={hosted ? undefined : "Directorio de perfiles de huésped de la organización. Busca por nombre, empresa, email o documento."}
      actions={
        hosted ? undefined : (
          <CocoaButton variant="filled" tone="accent" onClick={() => openGuest("new")}>
            {newGuestLabel}
          </CocoaButton>
        )
      }
      commands={[{ id: "guests-new", label: newGuestLabel, run: () => openGuest("new") }]}
    >
      <CocoaToolbar
        variant="content"
        aria-label="Búsqueda de huéspedes"
        leftSlot={
          <CocoaSearchInput
            id="guest-search"
            value={search}
            onChange={setSearch}
            placeholder="Nombre, empresa, email o nº de documento…"
            aria-label="Buscar huéspedes por nombre, empresa, email o documento"
          />
        }
      />
      <CocoaSection padding={ready ? "none" : "md"} footer={footer} style={{ overflow: "clip" }} aria-label="Listado de huéspedes">
        {body}
      </CocoaSection>
    </CocoaPage>
  );
}

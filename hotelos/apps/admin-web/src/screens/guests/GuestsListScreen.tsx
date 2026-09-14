import { useEffect, useRef, useState } from "react";
import { fetchGuests, type GuestProfile } from "../../services/guestsApi";
import { LoadingBlock, EmptyState, ErrorState, Spinner } from "../../components/States";

// Rows per page (API caps at 200); "Cargar más" walks the cursor. With a
// search term the API answers a single merged page (nextCursor: null).
const PAGE_SIZE = 50;

function openGuest(id: string) {
  window.history.pushState(null, "", `/backoffice/guests/${id}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function GuestsListScreen() {
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

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">CRM · Perfiles de huésped</p>
          <h2>Huéspedes</h2>
        </div>
        <button className="primary" type="button" onClick={() => openGuest("new")}>Nuevo huésped</button>
      </div>
      <p>Directorio de perfiles de huésped de la organización. Busca por nombre, empresa, email o documento.</p>

      <div className="rev-toolbar" style={{ marginBottom: "var(--space-4)" }}>
        <div className="rev-toolbar-group" style={{ flex: 1 }}>
          <label htmlFor="guest-search">Buscar</label>
          <input
            id="guest-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nombre, empresa, email o nº de documento…"
            type="search"
          />
        </div>
      </div>

      {loading ? (
        <LoadingBlock label="Cargando huéspedes…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(search)} />
      ) : guests.length === 0 ? (
        <EmptyState
          title={search ? "Sin resultados" : "Aún no hay huéspedes"}
          message={
            search
              ? "Ningún huésped coincide con la búsqueda. Prueba con otro término."
              : "Los perfiles se crean automáticamente al registrar reservas, o créalos manualmente."
          }
          actions={<button className="primary" type="button" onClick={() => openGuest("new")}>Nuevo huésped</button>}
        />
      ) : (
        <>
          <div className="bo-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Documento</th>
                  <th>Contacto</th>
                  <th>Empresa</th>
                  <th>VIP / Fidelización</th>
                </tr>
              </thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.id} style={{ cursor: "pointer" }} onClick={() => openGuest(g.id)}>
                    <td>
                      <strong>{g.title ? `${g.title} ` : ""}{g.fullName || g.firstName}</strong>
                      {g.nationality ? <span className="bo-muted" style={{ display: "block", fontWeight: 400 }}>{g.nationality}</span> : null}
                    </td>
                    <td>{g.documentType ? `${g.documentType} ${g.documentNumber ?? ""}` : (g.documentNumber ?? "—")}</td>
                    <td>
                      {g.email ?? "—"}
                      {g.phone || g.mobilePhone ? <span className="bo-muted" style={{ display: "block", fontWeight: 400 }}>{g.mobilePhone ?? g.phone}</span> : null}
                    </td>
                    <td>{g.company ?? "—"}</td>
                    <td>
                      {g.vipCode ? <span className="bo-status info" style={{ marginRight: 4 }}>{g.vipCode}</span> : null}
                      {g.loyaltyTier ? <span className="bo-chip">{g.loyaltyTier}</span> : null}
                      {!g.vipCode && !g.loyaltyTier ? "—" : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bo-row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: "var(--space-3)" }}>
            <span className="bo-muted">
              {guests.length}{total !== null ? ` de ${total}` : ""} huéspedes
            </span>
            {nextCursor ? (
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? <><Spinner size="sm" /> Cargando…</> : "Cargar más"}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

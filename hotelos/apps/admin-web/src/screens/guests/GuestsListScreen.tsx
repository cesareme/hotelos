import { useEffect, useRef, useState } from "react";
import { fetchGuests, type GuestProfile } from "../../services/guestsApi";
import { LoadingBlock, EmptyState, ErrorState } from "../../components/States";

function openGuest(id: string) {
  window.history.pushState(null, "", `/backoffice/guests/${id}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function GuestsListScreen() {
  const [guests, setGuests] = useState<GuestProfile[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  function load(term: string) {
    setLoading(true);
    setError(null);
    fetchGuests(term)
      .then(setGuests)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "No se pudieron cargar los huéspedes"))
      .finally(() => setLoading(false));
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
      )}
    </section>
  );
}

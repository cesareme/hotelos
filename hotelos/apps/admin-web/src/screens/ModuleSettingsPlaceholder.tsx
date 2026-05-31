import { useToast } from "../components/Toast";

function navigateTo(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

export type ModuleSettingsConfig = {
  moduleName: string;
  eyebrow?: string;
  summary?: string;
  dashboardScreen?: string;
  dashboardLabel?: string;
  setupScreen?: string;
  setupLabel?: string;
  relatedScreens?: Array<{ label: string; screen: string }>;
  status?: "ok" | "warn" | "error";
  statusLabel?: string;
};

export function ModuleSettingsPlaceholder(props: ModuleSettingsConfig) {
  const { showToast } = useToast();
  const eyebrow = props.eyebrow ?? "Próximamente · Q4 2026";
  const hasLinks = Boolean(props.dashboardScreen || props.setupScreen || props.relatedScreens?.length);

  function notifyWhenReady() {
    showToast("Apuntado. Te avisaremos al admin.", { variant: "info" });
  }

  return (
    <>
      <div
        className="bo-page-head"
        style={{ marginBottom: "var(--space-6)" }}
      >
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">{eyebrow}</div>
          <h1 className="bo-page-title">{props.moduleName}</h1>
          {props.summary ? (
            <p className="bo-page-subtitle">{props.summary}</p>
          ) : null}
        </div>
        {props.statusLabel ? (
          <div className="bo-page-head-actions">
            <span className={`bo-status ${props.status ?? "ok"}`}>{props.statusLabel}</span>
          </div>
        ) : null}
      </div>

      <section
        className="bo-card"
        style={{
          background: "var(--surface-1)",
          color: "var(--ink)",
          display: "grid",
          gap: "var(--space-5)",
          padding: "var(--space-8)",
          borderRadius: "var(--radius-lg)",
          textAlign: "center",
          alignItems: "center",
          justifyItems: "center"
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 96,
            height: 96,
            borderRadius: "var(--radius-full)",
            background: "var(--surface-2, var(--surface-1))",
            display: "grid",
            placeItems: "center",
            color: "var(--accent-strong)"
          }}
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
            <path d="M12 3v1" />
            <path d="M12 20v1" />
            <path d="M3 12h1" />
            <path d="M20 12h1" />
          </svg>
        </div>

        <div style={{ display: "grid", gap: "var(--space-2)", maxWidth: 520 }}>
          <h2 style={{ margin: 0, color: "var(--ink)" }}>Esta función está en camino</h2>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: "var(--space-2)",
              color: "var(--ink-muted, var(--ink))",
              textAlign: "left"
            }}
          >
            <li style={{ paddingLeft: "var(--space-4)", position: "relative" }}>
              <span style={{ position: "absolute", left: 0, color: "var(--accent-strong)" }}>·</span>
              Estamos puliendo los flujos de configuración para que se sientan nativos a Aurora.
            </li>
            <li style={{ paddingLeft: "var(--space-4)", position: "relative" }}>
              <span style={{ position: "absolute", left: 0, color: "var(--accent-strong)" }}>·</span>
              Integraremos esta sección con el tablero operativo correspondiente.
            </li>
            <li style={{ paddingLeft: "var(--space-4)", position: "relative" }}>
              <span style={{ position: "absolute", left: 0, color: "var(--accent-strong)" }}>·</span>
              Tu feedback temprano nos ayuda a priorizar — déjanos saber que te interesa.
            </li>
          </ul>
        </div>

        <div className="bo-actions" style={{ gap: "var(--space-2)", flexWrap: "wrap", justifyContent: "center" }}>
          <button type="button" className="primary" onClick={notifyWhenReady}>
            Notifícame cuando esté lista
          </button>
          {props.dashboardScreen ? (
            <button type="button" onClick={() => navigateTo(props.dashboardScreen!)}>
              {props.dashboardLabel ?? "Abrir tablero"}
            </button>
          ) : null}
          {props.setupScreen ? (
            <button type="button" className="ghost" onClick={() => navigateTo(props.setupScreen!)}>
              {props.setupLabel ?? "Abrir configuración"}
            </button>
          ) : null}
        </div>

        {props.relatedScreens?.length ? (
          <div
            className="bo-grid two"
            style={{ width: "100%", marginTop: "var(--space-4)", textAlign: "left" }}
          >
            {props.relatedScreens.map((rel) => (
              <article
                key={rel.screen + rel.label}
                className="bo-card"
                style={{ background: "var(--surface-1)", borderRadius: "var(--radius-md)" }}
              >
                <div className="bo-card-head">
                  <h3 style={{ fontSize: 14, color: "var(--ink)" }}>{rel.label}</h3>
                </div>
                <div className="bo-actions">
                  <button
                    type="button"
                    className="ghost"
                    style={{ color: "var(--accent-strong)" }}
                    onClick={() => navigateTo(rel.screen)}
                  >
                    Abrir →
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {!hasLinks ? (
          <p
            style={{
              fontSize: 12.5,
              color: "var(--ink-muted, var(--ink))",
              maxWidth: 520,
              margin: 0
            }}
          >
            La configuración general (activar módulos, integraciones, campos personalizados) se gestiona en «Back Office › Módulos e integraciones».
          </p>
        ) : null}
      </section>
    </>
  );
}

export function makeModulePlaceholder(config: ModuleSettingsConfig) {
  return function WiredModuleSettings() {
    return <ModuleSettingsPlaceholder {...config} />;
  };
}

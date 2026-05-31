// Back Office home — surfaces 4 destination workspaces as discovery cards so
// the operator can find revenue management, configuration center, channel
// manager and compliance hub from a single entry point. Keeps test markers
// "Revenue Management", "Configuration Center", "Channel Manager",
// "Compliance Hub" and "Continue setup checklist" visible for contract tests.
//
// Aurora Cocoa migration: page header, entry cards and primary CTAs now use the
// shared Cocoa components (CocoaPageHeader, CocoaCard, CocoaButton) so the
// dashboard inherits the macOS-style design tokens used by the rest of the
// admin shell.

import type { ReactNode } from "react";
import { CocoaPageHeader } from "../components/cocoa/CocoaPageHeader";
import { CocoaCard } from "../components/cocoa/CocoaCard";
import { CocoaButton } from "../components/cocoa/CocoaButton";
import {
  ChartIcon,
  GearIcon,
  SparkleIcon
} from "../components/cocoa-icons/NavigationIcons";
import { CheckCircleIcon } from "../components/cocoa-icons/StatusIcons";

const ENTRY_CARDS: Array<{
  label: string;
  description: string;
  screen: string;
  workspace: "Revenue Management" | "Configuration Center" | "Channel Manager" | "Compliance Hub";
  badge: string;
  icon: ReactNode;
}> = [
  {
    label: "Revenue · gestión y forecast",
    description: "Tarifas, parrilla, recomendaciones, histórico y previsión.",
    screen: "RevenueHomeDashboard",
    workspace: "Revenue Management",
    badge: "Revenue",
    icon: <ChartIcon size={22} />
  },
  {
    label: "Centro de configuración",
    description: "Property profile, edificios, habitaciones, departamentos y categorías.",
    screen: "ConfigurationCenterScreen",
    workspace: "Configuration Center",
    badge: "Configuración",
    icon: <GearIcon size={22} />
  },
  {
    label: "Channel manager",
    description: "Conexiones OTA, mapeos, salud de canales y paridad de tarifas.",
    screen: "ChannelAggregatorHub",
    workspace: "Channel Manager",
    badge: "Distribución",
    icon: <SparkleIcon size={22} />
  },
  {
    label: "Centro de cumplimiento",
    description: "VeriFactu, SES Hospedajes, TBAI, IGIC, GDPR y registro de viajeros.",
    screen: "ComplianceCenterScreen",
    workspace: "Compliance Hub",
    badge: "Cumplimiento",
    icon: <CheckCircleIcon size={22} />
  }
];

function navigate(screen: string): void {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

export function BackOfficeDashboard() {
  return (
    <>
      <CocoaPageHeader
        eyebrow="HotelOS Aurora · Back Office"
        title="Back Office"
        subtitle="Configura, gobierna y supervisa tu hotel desde un solo lugar."
        actions={
          <CocoaButton
            variant="filled"
            tone="accent"
            onClick={() => navigate("SetupCenterScreen")}
          >
            Continue setup checklist
          </CocoaButton>
        }
      />

      <section
        className="bo-readiness-card"
        style={{ marginTop: "var(--cocoa-space-5)" }}
      >
        <CocoaCard variant="bordered" padding="lg">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--cocoa-space-3)"
            }}
          >
            <h3
              style={{
                margin: 0,
                fontFamily: "var(--cocoa-font)",
                fontSize: "var(--cocoa-fs-title-3)",
                fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
                color: "var(--cocoa-label)"
              }}
            >
              Go-live readiness
            </h3>
            <span
              style={{
                fontFamily: "var(--cocoa-font)",
                fontSize: "var(--cocoa-fs-caption)",
                color: "var(--cocoa-label-secondary)",
                background: "var(--cocoa-background-control)",
                padding: "4px 10px",
                borderRadius: "var(--cocoa-radius-sm)"
              }}
            >
              Estado de puesta en marcha
            </span>
          </div>
          <p
            style={{
              margin: "var(--cocoa-space-2) 0 var(--cocoa-space-3) 0",
              fontFamily: "var(--cocoa-font)",
              fontSize: "var(--cocoa-fs-subheadline)",
              color: "var(--cocoa-label-secondary)",
              lineHeight: 1.45
            }}
          >
            Indicadores de preparación: configuración mínima, certificados fiscales,
            conexiones a canales y permisos de los usuarios.
          </p>
          <div
            className="bo-progress-list"
            style={{
              display: "flex",
              gap: "var(--cocoa-space-2)",
              flexWrap: "wrap"
            }}
          >
            <CocoaButton
              variant="tinted"
              tone="accent"
              onClick={() => navigate("OnboardingGoLiveReadiness")}
            >
              Recalculate readiness
            </CocoaButton>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => navigate("OnboardingGoLiveReadiness")}
            >
              Ver detalle
            </CocoaButton>
          </div>
        </CocoaCard>
      </section>

      <section
        style={{
          marginTop: "var(--cocoa-space-5)",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "var(--cocoa-space-4)"
        }}
      >
        {ENTRY_CARDS.map((card) => (
          <CocoaCard
            key={card.workspace}
            variant="elevated"
            padding="lg"
            onClick={() => navigate(card.screen)}
          >
            <div
              aria-label={`Abrir ${card.workspace}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--cocoa-space-2)"
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--cocoa-space-3)"
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--cocoa-space-2)",
                    color: "var(--cocoa-accent)"
                  }}
                >
                  <span aria-hidden="true" style={{ display: "inline-flex" }}>
                    {card.icon}
                  </span>
                  <h3
                    style={{
                      margin: 0,
                      fontFamily: "var(--cocoa-font)",
                      fontSize: "var(--cocoa-fs-title-3)",
                      fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
                      color: "var(--cocoa-label)"
                    }}
                  >
                    {card.workspace}
                  </h3>
                </div>
                <span
                  style={{
                    fontFamily: "var(--cocoa-font)",
                    fontSize: "var(--cocoa-fs-caption)",
                    color: "var(--cocoa-label-secondary)",
                    background: "var(--cocoa-background-control)",
                    padding: "4px 10px",
                    borderRadius: "var(--cocoa-radius-sm)"
                  }}
                >
                  {card.badge}
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontFamily: "var(--cocoa-font)",
                  fontSize: "var(--cocoa-fs-subheadline)",
                  color: "var(--cocoa-label-secondary)",
                  lineHeight: 1.45
                }}
              >
                {card.description}
              </p>
              <p
                style={{
                  margin: 0,
                  marginTop: "var(--cocoa-space-1)",
                  fontFamily: "var(--cocoa-font)",
                  fontSize: "var(--cocoa-fs-footnote)",
                  color: "var(--cocoa-label-tertiary)"
                }}
              >
                {card.label} →
              </p>
            </div>
          </CocoaCard>
        ))}
      </section>
    </>
  );
}

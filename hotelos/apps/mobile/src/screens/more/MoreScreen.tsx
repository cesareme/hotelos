import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ModuleCard, StatusChip } from "@hotelos/ui";
import { getModuleRouteItems } from "@hotelos/product";
import { DEFAULT_ENABLED_MODULES, DEFAULT_MOBILE_PERMISSIONS, getVisibleMobileRoutes } from "../../navigation/ModuleRoutes";
import { colors } from "../../theme/colors";
import { CommercialToolsSection } from "./CommercialToolsSection";

type RuntimeWithEnv = typeof globalThis & { process?: { env?: Record<string, string | undefined> } };

function getAdminWebUrl() {
  return (globalThis as RuntimeWithEnv).process?.env?.EXPO_PUBLIC_ADMIN_WEB_URL;
}

export function MoreScreen(props: { onNavigate?: (route: string) => void }) {
  const routes = getVisibleMobileRoutes().filter((item) => item.tab === "Mas");
  const adminItems = getModuleRouteItems("backoffice", "mobile");
  const onboardingItems = getModuleRouteItems("ai_onboarding_migration", "mobile");
  const adminUrl = getAdminWebUrl();
  const hasBackOfficeAccess = DEFAULT_MOBILE_PERMISSIONS.includes("backoffice.access");
  const suiteSections = [
    {
      title: "Finance & Compliance",
      items: [
        ["Payments", "Payment links, capture, refunds and failed payments.", "accounting"],
        ["Invoices", "Billing, invoice sequence and issued invoice review.", "accounting"],
        ["Accounting", "Journals, supplier bills and export tasks.", "accounting"],
        ["Spain Guest Register", "Parte de entrada and SES.HOSPEDAJES records.", "guestRegister"],
        ["Compliance Inbox", "Urgent compliance, tax, billing and guest register alerts.", "compliance"]
      ]
    },
    {
      title: "Guest Experience",
      items: [
        ["Guest Journey", "Booked to post-stay journey with blocked steps and next actions.", "GuestJourney"],
        ["Guest Portal", "Self-service check-in, folio, payment, upsells and requests.", "guestPortal"],
        ["Concierge", "Guest inbox and AI disclosed conversations.", "concierge"],
        ["Reputation", "Reviews, surveys and quality cases.", "reputation"]
      ]
    },
    {
      title: "Asset & Owner",
      items: [
        ["Owner Dashboard", "Cash, revenue, risk, maintenance and capex visibility.", "owner"],
        ["Asset Register", "Rooms, assets, QR codes and maintenance context.", "assets"],
        ["Energy", "Utility readings, anomalies and sustainability actions.", "energy"],
        ["Analytics", "Metrics, snapshots, anomalies and owner reporting.", "analytics"]
      ]
    },
    {
      title: "Platform",
      items: [
        ["Marketplace", "Modules and integrations as first-class product surfaces.", "MarketplaceHome"],
        ["Developer Platform", "API apps, webhooks and usage logs.", "developer"],
        ["AI Governance", "Policies, tool registry, prompt versions and review queue.", "aiGovernance"],
        ["Audit Log", "Append-only sensitive action history.", "ModuleVisibilityDebug"],
        ["Settings", "Device, profile, sync and app preferences.", "settings"]
      ]
    }
  ];

  function openBackOffice() {
    if (adminUrl) {
      void Linking.openURL(`${adminUrl}/backoffice`);
      return;
    }
    props.onNavigate?.("BackOfficePreview");
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.kicker}>Suite</Text>
        <Text style={styles.title}>Mas</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>Configuration & Admin</Text>
          <StatusChip label={hasBackOfficeAccess ? "admin" : "permission required"} tone={hasBackOfficeAccess ? "ai" : "warning"} />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open Back Office" onPress={openBackOffice} disabled={!hasBackOfficeAccess} style={[styles.backOfficeCard, !hasBackOfficeAccess && styles.disabledCard]}>
          <Text style={styles.cardTitle}>Back Office / Configuración</Text>
          <Text style={styles.cardBody}>Configurar propiedad, habitaciones, modulos, integraciones, compliance y usuarios.</Text>
          <View style={styles.chips}>
            <StatusChip label={adminUrl ? "opens admin-web" : "mobile fallback"} tone="ai" />
            <StatusChip label="backoffice.access" tone={hasBackOfficeAccess ? "success" : "warning"} />
          </View>
          {!hasBackOfficeAccess ? <Text style={styles.permissionText}>You do not have permission. Required permission: backoffice.access. Ask administrator.</Text> : null}
        </Pressable>
        {adminItems.slice(1).map((item) => (
          <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={`Open ${item.label}`} onPress={() => item.route && props.onNavigate?.(item.route)} style={styles.backOfficeCard}>
            <Text style={styles.cardTitle}>{item.label}</Text>
            <Text style={styles.cardBody}>{item.description}</Text>
            <View style={styles.chips}>
              <StatusChip label={item.permission} tone="info" />
              <StatusChip label={item.status ?? "ready"} tone={item.status === "needs_setup" ? "warning" : "success"} />
            </View>
          </Pressable>
        ))}
        {onboardingItems.slice(0, 1).map((item) => (
          <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={`Open ${item.label}`} onPress={() => item.route && props.onNavigate?.(item.route)} style={styles.backOfficeCard}>
            <Text style={styles.cardTitle}>{item.label}</Text>
            <Text style={styles.cardBody}>{item.description}</Text>
            <View style={styles.chips}>
              <StatusChip label={item.permission} tone="info" />
              <StatusChip label="dry-run required" tone="warning" />
            </View>
          </Pressable>
        ))}
        <Pressable accessibilityRole="button" accessibilityLabel="Open AI Settings" onPress={() => props.onNavigate?.("aiGovernance")} style={styles.backOfficeCard}>
          <Text style={styles.cardTitle}>AI Settings</Text>
          <Text style={styles.cardBody}>AI behavior, confirmations, disclosure, governance and tool policy.</Text>
          <View style={styles.chips}>
            <StatusChip label="ai.configure" tone="info" />
            <StatusChip label="visible" tone="success" />
          </View>
        </Pressable>
      </View>

      <CommercialToolsSection onNavigate={props.onNavigate} />

      {suiteSections.map((section) => (
        <View style={styles.section} key={section.title}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.items.map(([label, detail, route]) => (
            <Pressable key={label} accessibilityRole="button" accessibilityLabel={`Open ${label}`} onPress={() => props.onNavigate?.(route)} style={styles.backOfficeCard}>
              <Text style={styles.cardTitle}>{label}</Text>
              <Text style={styles.cardBody}>{detail}</Text>
            </Pressable>
          ))}
        </View>
      ))}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Enabled Suite Modules</Text>
        {routes.map((route) => (
          <Pressable key={route.route} accessibilityRole="button" accessibilityLabel={`Open ${route.label}`} onPress={() => props.onNavigate?.(route.route)} style={styles.moduleCard}>
            <ModuleCard name={route.label} category={route.moduleCode} enabled={DEFAULT_ENABLED_MODULES.includes(route.moduleCode)} dependencies={[]} />
          </Pressable>
        ))}
      </View>

      <View style={styles.debugCard}>
        <Text style={styles.cardTitle}>Dev Module Debug</Text>
        <Text style={styles.cardBody}>Current user: admin@hotelos.local - role: Local Super Admin - property: HotelOS Demo Hotel.</Text>
        <Text style={styles.cardBody}>Enabled modules include revenue_profit_engine, distribution_hub, ai_onboarding_migration, owner_mode, ai_governance and spain_guest_register_compliance.</Text>
        <Text style={styles.cardBody}>Admin web URL: {adminUrl ?? "not configured, using BackOfficePreview fallback"}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Open Module Visibility" onPress={() => props.onNavigate?.("ModuleVisibilityDebug")} style={styles.inlineButton}>
          <Text style={styles.inlineButtonText}>Module Visibility</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 12
  },
  kicker: {
    color: colors.muted,
    fontWeight: "800",
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: 0
  },
  section: {
    gap: 10
  },
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center"
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 0
  },
  backOfficeCard: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8
  },
  moduleCard: {
    borderRadius: 14
  },
  disabledCard: {
    opacity: 0.68
  },
  debugCard: {
    backgroundColor: "#eef2ff",
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    gap: 8
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: "900"
  },
  cardBody: {
    color: colors.muted,
    lineHeight: 20
  },
  permissionText: {
    color: colors.warning,
    fontWeight: "800",
    lineHeight: 20
  },
  inlineButton: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12
  },
  inlineButtonText: {
    color: "#ffffff",
    fontWeight: "900",
    letterSpacing: 0
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  }
});

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

type ConfigurationCard = {
  title: string;
  description: string;
  status: string;
  count: string;
  route?: string;
  addRoute?: string;
  permission: string;
  tone: "success" | "warning" | "info";
};

const cards: ConfigurationCard[] = [
  { title: "Property Profile", description: "Legal profile, tax identity, address, timezone, currency and business date rules.", status: "1 active property", count: "1 record", route: "PropertySetupPreview", addRoute: "PropertyProfileForm", permission: "property_profile.edit", tone: "success" },
  { title: "Buildings", description: "Buildings and outdoor areas of the hotel.", status: "2 buildings", count: "2 records", route: "PropertySetupPreview", permission: "property.configure", tone: "success" },
  { title: "Floors", description: "Floors and levels with housekeeping and maintenance areas.", status: "6 floors", count: "6 records", route: "PropertySetupPreview", permission: "property.configure", tone: "success" },
  { title: "Zones", description: "Guest rooms, public, BOH, technical, F&B, wellness, parking and events.", status: "9 zones", count: "9 records", route: "PropertySetupPreview", permission: "property.configure", tone: "success" },
  { title: "Rooms", description: "Inventory of bookable rooms mapped to type, floor, building and zone.", status: "48 rooms", count: "48 records", route: "PropertySetupPreview", addRoute: "RoomForm", permission: "rooms.manage", tone: "success" },
  { title: "Room Types", description: "Defaults, features, views, accessibility, sellable state and inventory.", status: "4 room types", count: "4 records", route: "PropertySetupPreview", addRoute: "RoomTypeForm", permission: "room_types.manage", tone: "success" },
  { title: "Room Features", description: "View, accessibility, amenities and connecting room features.", status: "ready", count: "12 options", route: "CategoryManagerPreview", addRoute: "CategoryOptionForm", permission: "categories.manage", tone: "success" },
  { title: "Bed Types", description: "Bed configurations available across room types.", status: "ready", count: "6 options", route: "CategoryManagerPreview", addRoute: "CategoryOptionForm", permission: "categories.manage", tone: "success" },
  { title: "Spaces & Resources", description: "Parking, meeting rooms, spa rooms, event spaces and hourly resources.", status: "needs setup", count: "0 records", route: "PropertySetupPreview", addRoute: "SpaceResourceForm", permission: "spaces.manage", tone: "warning" },
  { title: "Departments", description: "Teams, managers, users and operational ownership.", status: "5 departments", count: "5 records", route: "PropertySetupPreview", permission: "departments.manage", tone: "success" },
  { title: "Housekeeping Setup", description: "Rules, sections, inspection logic and SLA categories.", status: "ready", count: "8 options", route: "CategoryManagerPreview", permission: "operations_setup.manage", tone: "success" },
  { title: "Maintenance Setup", description: "Maintenance categories, SLA rules and asset taxonomy.", status: "ready", count: "10 options", route: "CategoryManagerPreview", permission: "operations_setup.manage", tone: "success" },
  { title: "Revenue Categories", description: "Market segments, source codes, rate categories and forecast drivers.", status: "ready", count: "14 options", route: "CategoryManagerPreview", permission: "revenue_setup.manage", tone: "success" },
  { title: "Distribution / Channel Categories", description: "Channel groups, OTA categories, parity scopes and channel mapping rules.", status: "ready", count: "9 options", route: "CategoryManagerPreview", permission: "categories.manage", tone: "success" },
  { title: "Guest Experience Categories", description: "Preferences, request types, message tags and journey states.", status: "ready", count: "11 options", route: "CategoryManagerPreview", permission: "categories.manage", tone: "success" },
  { title: "POS Categories", description: "POS outlets, categories, modifiers and tax codes.", status: "needs setup", count: "0 options", route: "CategoryManagerPreview", permission: "categories.manage", tone: "warning" },
  { title: "Asset Categories", description: "Asset families, depreciation classes and warranty types.", status: "ready", count: "7 options", route: "CategoryManagerPreview", permission: "categories.manage", tone: "success" },
  { title: "Compliance Setup", description: "Authority types, legal document types, submission modes and retention rules.", status: "ready", count: "6 options", route: "compliance", permission: "compliance_setup.manage", tone: "success" },
  { title: "Billing Setup", description: "Tax codes, payment categories, invoice sequences and cost centers.", status: "needs setup", count: "0 options", route: "accounting", permission: "configuration.manage", tone: "warning" },
  { title: "AI Setup", description: "AI category suggestions, previews, confirmation rules and audit events.", status: "review", count: "3 suggestions", route: "AISetupWizard", permission: "ai_category_setup.use", tone: "info" },
  { title: "Custom Fields", description: "Property-specific fields for rooms, guests, reservations and assets.", status: "ready", count: "12 fields", route: "CategoryManagerPreview", permission: "custom_fields.manage", tone: "success" }
];

export function ConfigurationCenterScreen(props: { onNavigate?: (route: string) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Back Office / Configuration</Text>
        <Text style={styles.title}>Configuration Center</Text>
        <Text style={styles.body}>
          Manage property profile, physical inventory, categories, custom fields and setup taxonomies. Every card opens its dedicated form. Critical fields require permissions and never overwrite existing data without confirmation.
        </Text>
        <View style={styles.chips}>
          <StatusChip label="configuration.read" tone="info" />
          <StatusChip label="audit logged" tone="success" />
        </View>
      </View>
      {cards.map((card) => (
        <View key={card.title} style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>{card.title}</Text>
            <StatusChip label={card.status} tone={card.tone} />
          </View>
          <Text style={styles.body}>{card.description}</Text>
          <View style={styles.cardFoot}>
            <Text style={styles.count}>{card.count}</Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Manage ${card.title}`}
                onPress={() => card.route && props.onNavigate?.(card.route)}
                style={styles.actionPill}
              >
                <Text style={styles.actionPillText}>Manage</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${card.title}`}
                onPress={() => card.addRoute && props.onNavigate?.(card.addRoute)}
                style={styles.actionPillPrimary}
              >
                <Text style={styles.actionPillPrimaryText}>Add</Text>
              </Pressable>
            </View>
          </View>
          <Text style={styles.permission}>Permission: {card.permission}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 12 },
  header: { gap: 8, marginBottom: 4 },
  kicker: { color: colors.muted, fontWeight: "900", fontSize: 12, letterSpacing: 0 },
  title: { color: colors.ink, fontSize: 30, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0, flex: 1 },
  cardFoot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  count: { color: colors.muted, fontSize: 12, fontWeight: "800", letterSpacing: 0 },
  actions: { flexDirection: "row", gap: 8 },
  actionPill: { borderColor: colors.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  actionPillText: { color: colors.ink, fontWeight: "900", letterSpacing: 0 },
  actionPillPrimary: { backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  actionPillPrimaryText: { color: "#ffffff", fontWeight: "900", letterSpacing: 0 },
  permission: { color: colors.muted, fontSize: 12, fontWeight: "700", letterSpacing: 0 }
});

import { ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../theme/colors";

export function UploadHotelDataScreen() {
  return (
    <OnboardingScaffold
      status="ready"
      title="Upload Hotel Data"
      body="Upload CSV/XLSX/PDF exports, room lists, floor plans, rate sheets, channel mapping files, future reservations and revenue history reports. Files are encrypted, classified and kept in temporary onboarding storage."
      cards={[
        ["Spreadsheet parser", "CSV/XLSX imports use structured parsers before AI schema mapping."],
        ["PDF extraction", "PDF reports use OCR/table extraction and then structured output review."],
        ["Privacy", "Raw card data, CVV and ID images are rejected by policy."]
      ]}
    />
  );
}

export function PropertyBlueprintPreviewScreen() {
  return (
    <OnboardingScaffold
      status="review"
      title="Property Blueprint Preview"
      body="AI suggests one building, four floors, 70 rooms, four room types, parking, meeting room, restaurant and rooftop inventory resources. No final creation happens without confirmation."
      cards={[
        ["Buildings and floors", "Main building, floors 1-4, east and west operating zones."],
        ["Rooms and resources", "Rooms 101-120, 201-220, 301-320 and suites 401-410 plus non-room resources."],
        ["Room Walk Setup", "Voice room-range parsing detected floor 2 east wing rooms 201-216 as Double Standard, 217-218 as Superior, 219 as storage and 220 as out of order."],
        ["Floor plan assist", "Floor-plan labels are assistive only: every room number, space and safety hint requires manual review before applying."]
      ]}
    />
  );
}

export function ReviewPendingMappingsScreen() {
  return (
    <OnboardingScaffold
      status="review"
      title="Migration Review"
      body="Low-risk mappings can be approved on mobile. Low-confidence, financial, compliance and reservation changes stay blocked until admin review and dry-run."
      cards={[
        ["Room 432", "Suggested target: inventory_resource Room 432, Double Standard, floor 4. Confidence 93%."],
        ["Revenue snapshot", "History & Forecast row detected for 2026-05-17. Totals validation pending."],
        ["Human review queue", "Pending, low-confidence, financial and compliance mappings must be approved, rejected or edited before apply."],
        ["PII masking", "Guest, document, phone, email, address and payment preview fields are masked unless onboarding.view_sensitive is granted."],
        ["Data quality gate", "Apply is blocked by SES.HOSPEDAJES setup and History & Forecast totals mismatch until reviewed."],
        ["Rules", "AI cannot apply migration, create live reservations or overwrite production data without approval."]
      ]}
    />
  );
}

export function GoLiveReadinessMobileScreen() {
  return (
    <OnboardingScaffold
      status="blocked"
      title="Go-Live Readiness"
      body="Readiness score: 78%. Go-live is blocked until SES.HOSPEDAJES settings and imported revenue report totals are reviewed."
      cards={[
        ["Blocking issue", "Missing SES.HOSPEDAJES configuration and authority routing."],
        ["Blocking issue", "History & Forecast totals mismatch review is still open."],
        ["Apply gate", "Completed dry-run, explicit confirmation, zero blocking issues and zero pending reviews are required."],
        ["Cutover", "T-7 staff review is in progress; T-1 freeze and go-live delta import are pending."],
        ["Delta import dry-run", "Final source PMS changes are previewed from a source watermark; folios and balances require manual conflict review."],
        ["Delta import", "Go-live day requires final source PMS delta import, arrival validation, balance validation, channel switch and first night audit."]
      ]}
    />
  );
}

function OnboardingScaffold(props: {
  title: string;
  body: string;
  status: "ready" | "review" | "blocked";
  cards: Array<[string, string]>;
}) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <StatusChip label={props.status} tone={props.status === "ready" ? "success" : props.status === "blocked" ? "error" : "warning"} />
        <Text style={styles.title}>{props.title}</Text>
        <Text style={styles.body}>{props.body}</Text>
      </View>
      {props.cards.map(([title, body]) => (
        <View key={title} style={styles.card}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.body}>{body}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 18, gap: 14 },
  header: { gap: 8 },
  title: { color: colors.ink, fontSize: 30, fontWeight: "900", letterSpacing: 0 },
  body: { color: colors.muted, lineHeight: 21, letterSpacing: 0 },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: 0 }
});

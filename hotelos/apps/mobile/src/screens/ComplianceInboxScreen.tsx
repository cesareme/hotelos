import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { AlertTriangle, FileWarning, ShieldCheck } from "lucide-react-native";
import { getComplianceSnapshot, type MobileComplianceIssue, type MobileGuestRegisterRecord, type MobileSesSubmission } from "../services/api";
import { colors } from "../theme/colors";

export function ComplianceInboxScreen() {
  const [issues, setIssues] = useState<MobileComplianceIssue[]>([]);
  const [records, setRecords] = useState<MobileGuestRegisterRecord[]>([]);
  const [submissions, setSubmissions] = useState<MobileSesSubmission[]>([]);

  useEffect(() => {
    void getComplianceSnapshot().then((snapshot) => {
      setIssues(snapshot.issues);
      setRecords(snapshot.records);
      setSubmissions(snapshot.submissions);
    });
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Compliance inbox</Text>
          <Text style={styles.title}>Review</Text>
        </View>
        <ShieldCheck color={colors.primary} size={28} />
      </View>

      <View style={styles.statusStrip}>
        {["Missing data", "Needs signature", "Ready to submit", "Due in < 4 hours", "Queued", "Accepted", "Rejected", "Manual upload needed"].map((label) => (
          <View key={label} style={styles.statusPill}>
            <Text style={styles.statusText}>{label}</Text>
          </View>
        ))}
      </View>

      {issues.map((issue) => (
        <View key={`${issue.recordId ?? issue.issue}-${issue.status}`} style={styles.issue}>
          {issue.status === "needs_human_review" || issue.status === "failed" || issue.status === "rejected" ? (
            <AlertTriangle color={colors.warning} size={22} />
          ) : (
            <FileWarning color={colors.primary} size={22} />
          )}
          <View style={styles.issueText}>
            <Text style={styles.issueStatus}>{issue.status}</Text>
            <Text style={styles.issueTitle}>{issue.issue}</Text>
            <Text style={styles.issueDetail}>Record {issue.recordId ?? "pending"} can be corrected, signed, queued, or retried.</Text>
          </View>
        </View>
      ))}

      <View style={styles.issue}>
        <FileWarning color={colors.primary} size={22} />
        <View style={styles.issueText}>
          <Text style={styles.issueStatus}>Guest register</Text>
          <Text style={styles.issueTitle}>{records.length} retained record(s)</Text>
          <Text style={styles.issueDetail}>Records keep retention dates and signature references without storing ID images.</Text>
        </View>
      </View>

      <View style={styles.issue}>
        <FileWarning color={colors.primary} size={22} />
        <View style={styles.issueText}>
          <Text style={styles.issueStatus}>SES.HOSPEDAJES</Text>
          <Text style={styles.issueTitle}>{submissions.length} submission(s)</Text>
          <Text style={styles.issueDetail}>Queued, sent, accepted, rejected, failed, corrected, annulled and daily batch/manual upload states are tracked.</Text>
        </View>
      </View>

      <View style={styles.issue}>
        <FileWarning color={colors.primary} size={22} />
        <View style={styles.issueText}>
          <Text style={styles.issueStatus}>Privacy</Text>
          <Text style={styles.issueTitle}>ID_IMAGE_DISCARDED</Text>
          <Text style={styles.issueDetail}>Temporary OCR is allowed, but raw DNI/passport/TIE images are discarded immediately and never stored by default.</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 18
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  kicker: {
    color: colors.muted,
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0
  },
  statusStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  statusPill: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surface
  },
  statusText: {
    color: colors.ink,
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0
  },
  issue: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 14
  },
  issueText: {
    flex: 1,
    gap: 4
  },
  issueStatus: {
    color: colors.muted,
    fontWeight: "800",
    fontSize: 12,
    letterSpacing: 0
  },
  issueTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0
  },
  issueDetail: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  }
});

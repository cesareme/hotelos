import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { BadgeEuro, Banknote, BookOpenCheck } from "lucide-react-native";
import { getAccountingSnapshot, type MobileAccountingSnapshot } from "../services/api";
import { colors } from "../theme/colors";

export function AccountingScreen() {
  const [snapshot, setSnapshot] = useState<MobileAccountingSnapshot | null>(null);

  useEffect(() => {
    void getAccountingSnapshot().then(setSnapshot);
  }, []);

  const data =
    snapshot ??
    ({
      accounts: [],
      supplierBills: [],
      journalEntries: []
    } as MobileAccountingSnapshot);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Accounting</Text>
          <Text style={styles.title}>Books</Text>
        </View>
        <BookOpenCheck color={colors.primary} size={28} />
      </View>

      <View style={styles.summary}>
        <BadgeEuro color={colors.primary} size={22} />
        <View style={styles.summaryText}>
          <Text style={styles.summaryTitle}>Month-end checklist</Text>
          <Text style={styles.summaryMeta}>
            {data.supplierBills.length} supplier bill draft(s), {data.journalEntries.length} journal draft(s), SII configurable by tax profile.
          </Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Supplier bills</Text>
      {data.supplierBills.map((bill) => (
        <View key={bill.id} style={styles.row}>
          <Text style={styles.rowTitle}>{bill.supplierName}</Text>
          <Text style={styles.rowMeta}>
            {bill.total} EUR - {bill.status} - account {bill.suggestedAccountCode ?? "pending"}
          </Text>
        </View>
      ))}

      <Text style={styles.sectionTitle}>Chart of accounts</Text>
      {data.accounts.slice(0, 5).map((account) => (
        <View key={account.code} style={styles.row}>
          <Text style={styles.rowTitle}>
            {account.code} {account.name}
          </Text>
          <Text style={styles.rowMeta}>{account.accountType}</Text>
        </View>
      ))}

      <View style={styles.summary}>
        <Banknote color={colors.primary} size={22} />
        <View style={styles.summaryText}>
          <Text style={styles.summaryTitle}>Bank reconciliation</Text>
          <Text style={styles.summaryMeta}>AI suggestions can match PSP deposits, but final postings require accountant approval.</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 14
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
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0
  },
  summary: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "#eef7f4",
    borderWidth: 1,
    borderColor: "#b7d8d1",
    borderRadius: 8,
    padding: 14
  },
  summaryText: {
    flex: 1,
    gap: 4
  },
  summaryTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0
  },
  summaryMeta: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  },
  row: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 12,
    paddingHorizontal: 2
  },
  rowTitle: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0
  },
  rowMeta: {
    color: colors.muted,
    marginTop: 4,
    lineHeight: 20,
    letterSpacing: 0
  }
});


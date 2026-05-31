import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../../theme/colors";

const COUNTRIES = ["Spain", "Portugal", "France", "Italy"];
const TIMEZONES = ["Europe/Madrid", "Europe/Lisbon", "Europe/Paris"];
const CURRENCIES = ["EUR", "GBP", "USD"];

export function PropertyProfileFormScreen(props: { onNavigate?: (route: string) => void }) {
  const [values, setValues] = useState({
    propertyName: "",
    legalName: "",
    taxId: "",
    address: "",
    country: "",
    city: "",
    timezone: "",
    currency: ""
  });

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  const issues: string[] = [];
  if (!values.propertyName.trim()) issues.push("Property name is required.");
  if (!values.legalName.trim()) issues.push("Legal name is required.");
  if (!values.taxId.trim()) issues.push("Tax ID is required.");
  if (!values.country) issues.push("Country is required.");
  if (!values.city.trim()) issues.push("City is required.");
  if (!values.timezone) issues.push("Timezone is required.");
  if (!values.currency) issues.push("Currency is required.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      console.log("[mobile/PropertyProfileForm] validation issues", issues);
      return;
    }
    console.log("[mobile/PropertyProfileForm] save", { ...values, addAnother });
    if (addAnother) {
      setValues({ propertyName: "", legalName: "", taxId: "", address: "", country: "", city: "", timezone: "", currency: "" });
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>Configuration / Property</Text>
        <Text style={styles.title}>Property profile</Text>
        <Text style={styles.body}>Legal profile, tax identity, address, timezone and currency.</Text>
        <View style={styles.chips}>
          <StatusChip label="property_profile.edit" tone="info" />
          <StatusChip label="audit logged" tone="success" />
        </View>

        <Section title="Validation summary">
          {issues.length === 0 ? (
            <Text style={styles.bodyMuted}>No blocking validation issues.</Text>
          ) : (
            issues.map((issue) => (
              <Text key={issue} style={styles.issue}>{issue}</Text>
            ))
          )}
        </Section>

        <Section title="Identity">
          <Field label="Property name" required>
            <TextInput style={styles.input} value={values.propertyName} onChangeText={(value) => patch("propertyName", value)} placeholder="Hotel Aurora" placeholderTextColor={colors.muted} />
          </Field>
          <Field label="Legal name" required>
            <TextInput style={styles.input} value={values.legalName} onChangeText={(value) => patch("legalName", value)} placeholder="Aurora Hospitality S.L." placeholderTextColor={colors.muted} />
          </Field>
          <Field label="Tax ID" required>
            <TextInput style={styles.input} value={values.taxId} onChangeText={(value) => patch("taxId", value)} placeholder="B12345678" placeholderTextColor={colors.muted} />
          </Field>
        </Section>

        <Section title="Address">
          <Field label="Address">
            <TextInput style={[styles.input, styles.textarea]} value={values.address} onChangeText={(value) => patch("address", value)} multiline placeholderTextColor={colors.muted} />
          </Field>
          <Field label="Country" required>
            <OptionRow options={COUNTRIES} value={values.country} onChange={(value) => patch("country", value)} />
          </Field>
          <Field label="City" required>
            <TextInput style={styles.input} value={values.city} onChangeText={(value) => patch("city", value)} placeholderTextColor={colors.muted} />
          </Field>
        </Section>

        <Section title="Locale">
          <Field label="Timezone" required>
            <OptionRow options={TIMEZONES} value={values.timezone} onChange={(value) => patch("timezone", value)} />
          </Field>
          <Field label="Currency" required>
            <OptionRow options={CURRENCIES} value={values.currency} onChange={(value) => patch("currency", value)} />
          </Field>
        </Section>

        <Section title="Audit trail">
          <Text style={styles.bodyMuted}>Last modified by system, on 2026-05-17, see audit log.</Text>
        </Section>
      </ScrollView>

      <View style={styles.actionBar}>
        <Pressable style={styles.primary} onPress={() => handleSave(false)}>
          <Text style={styles.primaryLabel}>Save</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={() => handleSave(true)}>
          <Text style={styles.secondaryLabel}>Save and add another</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={() => props.onNavigate?.("ConfigurationCenter")}>
          <Text style={styles.secondaryLabel}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.danger} onPress={() => console.log("[mobile/PropertyProfileForm] deactivate")}>
          <Text style={styles.dangerLabel}>Deactivate</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      <View style={styles.sectionBody}>{props.children}</View>
    </View>
  );
}

function Field(props: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>
        {props.label}
        {props.required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      {props.children}
    </View>
  );
}

function OptionRow(props: { options: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <View style={styles.optionRow}>
      {props.options.map((option) => {
        const active = option === props.value;
        return (
          <Pressable key={option} onPress={() => props.onChange(option)} style={[styles.option, active ? styles.optionActive : null]}>
            <Text style={[styles.optionLabel, active ? styles.optionLabelActive : null]}>{option}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 18, gap: 12, paddingBottom: 24 },
  kicker: { color: colors.muted, fontWeight: "900", fontSize: 12 },
  title: { color: colors.ink, fontSize: 26, fontWeight: "900" },
  body: { color: colors.muted, lineHeight: 21 },
  bodyMuted: { color: colors.muted, lineHeight: 20 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
  section: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
  sectionTitle: { color: colors.ink, fontWeight: "900", fontSize: 16 },
  sectionBody: { gap: 10 },
  field: { gap: 6 },
  fieldLabel: { color: colors.ink, fontWeight: "800", fontSize: 13 },
  required: { color: colors.danger, fontWeight: "900" },
  input: { borderColor: colors.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, color: colors.ink, backgroundColor: colors.background },
  textarea: { minHeight: 70, textAlignVertical: "top" },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  option: { borderColor: colors.line, borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.background },
  optionActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  optionLabel: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  optionLabelActive: { color: "#ffffff" },
  issue: { color: colors.warning, fontWeight: "700" },
  actionBar: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12, borderTopColor: colors.line, borderTopWidth: 1, backgroundColor: colors.surface },
  primary: { backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  primaryLabel: { color: "#ffffff", fontWeight: "900" },
  secondary: { borderColor: colors.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.background },
  secondaryLabel: { color: colors.ink, fontWeight: "800" },
  danger: { borderColor: colors.danger, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  dangerLabel: { color: colors.danger, fontWeight: "900" }
});

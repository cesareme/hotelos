import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusChip } from "@hotelos/ui";
import { colors } from "../../../theme/colors";

const RESOURCE_TYPES = ["parking", "meeting", "spa", "event", "equipment", "outlet", "other"];

export function SpaceResourceFormScreen(props: { onNavigate?: (route: string) => void }) {
  const [values, setValues] = useState({
    name: "",
    type: "",
    capacity: "",
    hourlyRate: "",
    dailyRate: "",
    location: "",
    active: true
  });

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  const issues: string[] = [];
  if (!values.name.trim()) issues.push("Name is required.");
  if (!values.type) issues.push("Resource type is required.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      console.log("[mobile/SpaceResourceForm] validation issues", issues);
      return;
    }
    console.log("[mobile/SpaceResourceForm] save", { ...values, addAnother });
    if (addAnother) {
      setValues({ name: "", type: "", capacity: "", hourlyRate: "", dailyRate: "", location: "", active: true });
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>Configuration / Spaces & resources</Text>
        <Text style={styles.title}>Space or resource</Text>
        <Text style={styles.body}>Parking, meeting rooms, spa rooms, event spaces, equipment and outlets.</Text>
        <View style={styles.chips}>
          <StatusChip label="spaces.manage" tone="info" />
          <StatusChip label="audit logged" tone="success" />
        </View>

        <Section title="Validation summary">
          {issues.length === 0 ? (
            <Text style={styles.bodyMuted}>No blocking validation issues.</Text>
          ) : (
            issues.map((issue) => <Text key={issue} style={styles.issue}>{issue}</Text>)
          )}
        </Section>

        <Section title="Identity">
          <Field label="Name" required>
            <TextInput style={styles.input} value={values.name} onChangeText={(value) => patch("name", value)} placeholder="Conference room A" placeholderTextColor={colors.muted} />
          </Field>
          <Field label="Type" required>
            <OptionRow options={RESOURCE_TYPES} value={values.type} onChange={(value) => patch("type", value)} />
          </Field>
          <Field label="Location">
            <TextInput style={styles.input} value={values.location} onChangeText={(value) => patch("location", value)} placeholder="Main / Ground floor" placeholderTextColor={colors.muted} />
          </Field>
        </Section>

        <Section title="Capacity and rates">
          <Field label="Capacity">
            <TextInput style={styles.input} value={values.capacity} onChangeText={(value) => patch("capacity", value)} keyboardType="number-pad" placeholderTextColor={colors.muted} />
          </Field>
          <Field label="Hourly rate">
            <TextInput style={styles.input} value={values.hourlyRate} onChangeText={(value) => patch("hourlyRate", value)} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.muted} />
          </Field>
          <Field label="Daily rate">
            <TextInput style={styles.input} value={values.dailyRate} onChangeText={(value) => patch("dailyRate", value)} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.muted} />
          </Field>
          <ToggleRow label="Active" value={values.active} onChange={(value) => patch("active", value)} />
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
        <Pressable style={styles.danger} onPress={() => console.log("[mobile/SpaceResourceForm] deactivate")}>
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

function ToggleRow(props: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Pressable onPress={() => props.onChange(!props.value)} style={styles.toggleRow}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <View style={[styles.toggle, props.value ? styles.toggleOn : null]}>
        <Text style={[styles.toggleLabel, props.value ? styles.toggleLabelOn : null]}>{props.value ? "On" : "Off"}</Text>
      </View>
    </Pressable>
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
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  option: { borderColor: colors.line, borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.background },
  optionActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  optionLabel: { color: colors.ink, fontWeight: "700", fontSize: 12 },
  optionLabelActive: { color: "#ffffff" },
  issue: { color: colors.warning, fontWeight: "700" },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  toggle: { borderColor: colors.line, borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 4 },
  toggleOn: { backgroundColor: colors.success, borderColor: colors.success },
  toggleLabel: { color: colors.ink, fontWeight: "800", fontSize: 12 },
  toggleLabelOn: { color: "#ffffff" },
  actionBar: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12, borderTopColor: colors.line, borderTopWidth: 1, backgroundColor: colors.surface },
  primary: { backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  primaryLabel: { color: "#ffffff", fontWeight: "900" },
  secondary: { borderColor: colors.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.background },
  secondaryLabel: { color: colors.ink, fontWeight: "800" },
  danger: { borderColor: colors.danger, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  dangerLabel: { color: colors.danger, fontWeight: "900" }
});

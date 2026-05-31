import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { hotelOSTokens } from "../tokens/index.js";

const tokens = hotelOSTokens;

export function GlobalSearchCommand(props: { placeholder?: string; onOpenPalette?: () => void }) {
  return (
    <View style={styles.wrap} accessibilityLabel="Global Search and Command">
      <TextInput
        accessibilityLabel="Search reservations, guests, rooms, modules, settings and reports"
        placeholder={props.placeholder ?? "Search or command..."}
        placeholderTextColor={tokens.color.text.muted}
        style={styles.input}
      />
      <Pressable accessibilityRole="button" accessibilityLabel="Open Command Palette" onPress={props.onOpenPalette} style={styles.shortcut}>
        <Text style={styles.shortcutText}>Cmd K</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: tokens.color.border.subtle,
    borderRadius: tokens.radius.xl,
    backgroundColor: tokens.color.surface.raised,
    paddingHorizontal: tokens.space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space.sm
  },
  input: {
    flex: 1,
    minHeight: 48,
    color: tokens.color.text.primary,
    fontSize: tokens.font.size.bodyLarge,
    letterSpacing: 0
  },
  shortcut: {
    minHeight: 36,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.color.surface.soft,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: tokens.space.sm
  },
  shortcutText: {
    color: tokens.color.brand.deepIndigo,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  }
});

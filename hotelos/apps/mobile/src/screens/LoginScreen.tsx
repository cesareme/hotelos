import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { LogIn, ShieldCheck } from "lucide-react-native";
import { IconButton } from "../components/IconButton";
import { loginDemo } from "../services/api";
import { colors } from "../theme/colors";

type LoginScreenProps = {
  onLogin: () => void;
};

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [email, setEmail] = useState("reception@example.com");
  const [password, setPassword] = useState("demo-password");
  const [status, setStatus] = useState("MFA required for sensitive roles");

  async function submit() {
    await loginDemo();
    setStatus("Signed in");
    onLogin();
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <ShieldCheck color={colors.primary} size={34} />
        <Text style={styles.title}>HotelOS</Text>
        <Text style={styles.subtitle}>Mobile operating system for hotel teams</Text>
      </View>
      <View style={styles.form}>
        <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" style={styles.input} />
        <TextInput value={password} onChangeText={setPassword} secureTextEntry style={styles.input} />
        <IconButton label="Sign in" icon={<LogIn color="#ffffff" size={20} />} onPress={submit} variant="primary" />
        <Pressable onPress={() => setStatus("Magic link requested")} style={styles.linkButton}>
          <Text style={styles.linkText}>Send magic link</Text>
        </Pressable>
        <Text style={styles.status}>{status}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 22,
    justifyContent: "center",
    gap: 26
  },
  header: {
    gap: 8
  },
  title: {
    color: colors.ink,
    fontSize: 38,
    fontWeight: "900",
    letterSpacing: 0
  },
  subtitle: {
    color: colors.muted,
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: 0
  },
  form: {
    gap: 12
  },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: 15,
    letterSpacing: 0
  },
  linkButton: {
    paddingVertical: 10,
    alignItems: "center"
  },
  linkText: {
    color: colors.primary,
    fontWeight: "800",
    letterSpacing: 0
  },
  status: {
    color: colors.muted,
    textAlign: "center",
    letterSpacing: 0
  }
});


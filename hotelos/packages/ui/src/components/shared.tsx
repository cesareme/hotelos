import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { hotelOSTokens } from "../tokens/index.js";

const tokens = hotelOSTokens;

export const suiteColors = {
  ink: tokens.color.text.primary,
  muted: tokens.color.text.muted,
  line: tokens.color.border.subtle,
  surface: tokens.color.surface.raised,
  warmGray: tokens.color.surface.canvas,
  primary: tokens.color.brand.deepIndigo,
  primaryDark: tokens.color.brand.nightBlue,
  ai: tokens.color.brand.violet,
  electric: tokens.color.brand.electricBlue,
  success: tokens.color.semantic.success,
  warning: tokens.color.semantic.warning,
  error: tokens.color.semantic.danger
};

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Density = "compact" | "comfortable" | "dense";
export type StatusTone = "neutral" | "success" | "warning" | "error" | "ai" | "info";

function toneColor(tone?: StatusTone | RiskLevel) {
  if (tone === "success" || tone === "low") return suiteColors.success;
  if (tone === "warning" || tone === "medium") return suiteColors.warning;
  if (tone === "error" || tone === "critical") return suiteColors.error;
  if (tone === "ai" || tone === "high") return suiteColors.ai;
  if (tone === "info") return suiteColors.electric;
  return suiteColors.primary;
}

export function HotelCard(props: {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  tone?: StatusTone;
  density?: Density;
  action?: ReactNode;
}) {
  return (
    <View style={[styles.card, props.density === "compact" && styles.cardCompact, props.tone === "ai" && styles.aiCard]}>
      {props.title ? (
        <View style={styles.row}>
          <View style={styles.titleStack}>
            <Text style={styles.title}>{props.title}</Text>
            {props.subtitle ? <Text style={styles.detail}>{props.subtitle}</Text> : null}
          </View>
          {props.action}
        </View>
      ) : null}
      {props.children}
    </View>
  );
}

export function MetricCard(props: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: StatusTone;
  loading?: boolean;
  accessibilityLabel?: string;
}) {
  if (props.loading) {
    return <SkeletonCard label={props.label} />;
  }
  const color = toneColor(props.tone);
  return (
    <View accessible accessibilityLabel={props.accessibilityLabel ?? `${props.label}: ${props.value}`} style={[styles.metricCard, { borderLeftColor: color }]}>
      <Text style={styles.meta}>{props.label}</Text>
      <Text style={styles.metric}>{props.value}</Text>
      {props.detail ? <Text style={styles.detail}>{props.detail}</Text> : null}
    </View>
  );
}

export function StatusChip(props: { label: string; tone?: StatusTone; compact?: boolean }) {
  const color = toneColor(props.tone);
  return (
    <View style={[styles.chip, props.compact && styles.chipCompact, { borderColor: color, backgroundColor: props.tone === "ai" ? tokens.color.status.ai : tokens.color.surface.raised }]}>
      <Text style={[styles.chipText, { color }]}>{props.label}</Text>
    </View>
  );
}

const RISK_TONE: Record<RiskLevel, StatusTone> = { low: "info", medium: "warning", high: "warning", critical: "error" };
export function RiskBadge(props: { riskLevel: RiskLevel }) {
  return <StatusChip label={`${props.riskLevel} risk`} tone={RISK_TONE[props.riskLevel]} />;
}

export function ConfidenceMeter(props: { value: number; label?: string }) {
  const normalized = Math.max(0, Math.min(100, props.value));
  return (
    <View accessible accessibilityLabel={`${props.label ?? "Confidence"} ${normalized}%`} style={styles.confidenceWrap}>
      <View style={styles.row}>
        <Text style={styles.meta}>{props.label ?? "Confidence"}</Text>
        <Text style={styles.confidenceText}>{normalized}%</Text>
      </View>
      <View style={styles.confidenceTrack}>
        <View style={[styles.confidenceFill, { width: `${normalized}%` }]} />
      </View>
    </View>
  );
}

export function RoomStatusBadge(props: { status: string; housekeepingStatus?: string; maintenanceStatus?: string }) {
  const blocked = props.status === "out_of_order" || props.status === "out_of_service" || props.maintenanceStatus === "blocked";
  const dirty = props.status === "dirty" || props.housekeepingStatus === "dirty";
  const inspected = props.status === "inspected" || props.housekeepingStatus === "inspected";
  const tone: StatusTone = blocked ? "error" : dirty ? "warning" : inspected ? "info" : "success";
  return <StatusChip label={`${props.status}${props.housekeepingStatus ? ` / ${props.housekeepingStatus}` : ""}`} tone={tone} compact />;
}

export function ReservationCard(props: { code: string; guestName: string; stay: string; status: string; balance?: string; nextAction?: string }) {
  return (
    <HotelCard>
      <View style={styles.row}>
        <View style={styles.titleStack}>
          <Text style={styles.title}>{props.guestName}</Text>
          <Text style={styles.detail}>{props.code} - {props.stay}</Text>
        </View>
        <StatusChip label={props.status} tone="ai" />
      </View>
      {props.balance ? <Text style={styles.detail}>{props.balance}</Text> : null}
      {props.nextAction ? <Text style={styles.nextAction}>{props.nextAction}</Text> : null}
    </HotelCard>
  );
}

export function RoomCard(props: { roomNumber: string; status: string; detail?: string; actions?: ReactNode; density?: Density }) {
  return (
    <HotelCard density={props.density}>
      <View style={styles.row}>
        <Text style={styles.roomNumber}>Room {props.roomNumber}</Text>
        <RoomStatusBadge status={props.status} />
      </View>
      {props.detail ? <Text style={styles.detail}>{props.detail}</Text> : null}
      {props.actions ? <View style={styles.actionRow}>{props.actions}</View> : null}
    </HotelCard>
  );
}

export function RoomOperationalCard(props: {
  roomNumber: string;
  roomType: string;
  occupancy: string;
  housekeeping: string;
  maintenance: string;
  guest?: string;
  nextArrival?: string;
  balance?: string;
  complianceState?: string;
  nextBestAction?: string;
}) {
  return (
    <HotelCard>
      <View style={styles.row}>
        <View>
          <Text style={styles.roomNumber}>{props.roomNumber}</Text>
          <Text style={styles.detail}>{props.roomType} - {props.occupancy}</Text>
        </View>
        <RoomStatusBadge status={props.housekeeping} maintenanceStatus={props.maintenance} />
      </View>
      <TimelineDataGrid
        items={[
          { label: "Guest", value: props.guest ?? props.nextArrival ?? "Available" },
          { label: "Maintenance", value: props.maintenance },
          { label: "Balance", value: props.balance ?? "0" },
          { label: "Register", value: props.complianceState ?? "ok" }
        ]}
      />
      {props.nextBestAction ? <Text style={styles.nextAction}>{props.nextBestAction}</Text> : null}
    </HotelCard>
  );
}

export function TaskCard(props: { title: string; status: string; priority?: string; detail?: string; due?: string }) {
  return (
    <HotelCard>
      <View style={styles.row}>
        <Text style={styles.title}>{props.title}</Text>
        <StatusChip label={props.priority ?? props.status} tone={props.priority === "urgent" ? "error" : "warning"} />
      </View>
      {props.detail ? <Text style={styles.detail}>{props.detail}</Text> : null}
      {props.due ? <Text style={styles.meta}>Due {props.due}</Text> : null}
    </HotelCard>
  );
}

export type ConfirmationCardProps = {
  title: string;
  summary: string;
  riskLevel: RiskLevel;
  warnings?: string[];
  requiredApprovals?: string[];
  actions: string[];
  primaryActionLabel: string;
  secondaryActionLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
};

export function ConfirmationCard(props: ConfirmationCardProps) {
  const color = toneColor(props.riskLevel);
  return (
    <HotelCard>
      <View style={[styles.confirmAccent, { backgroundColor: color }]} />
      <View style={styles.row}>
        <Text style={styles.title}>{props.title}</Text>
        <RiskBadge riskLevel={props.riskLevel} />
      </View>
      <Text style={styles.bodyText}>{props.summary}</Text>
      {props.warnings?.map((warning) => (
        <Text key={warning} style={styles.warningText}>{warning}</Text>
      ))}
      {props.requiredApprovals?.map((approval) => (
        <Text key={approval} style={styles.detail}>Approval: {approval}</Text>
      ))}
      {props.actions.map((action) => (
        <Text key={action} style={styles.detail}>- {action}</Text>
      ))}
      <View style={styles.actionRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={props.secondaryActionLabel ?? "Cancel"} onPress={props.onCancel} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>{props.secondaryActionLabel ?? "Cancel"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.primaryActionLabel}
          disabled={props.disabled}
          onPress={props.onConfirm}
          style={[styles.primaryButton, props.disabled && styles.disabled]}
        >
          <Text style={styles.primaryButtonText}>{props.primaryActionLabel}</Text>
        </Pressable>
      </View>
    </HotelCard>
  );
}

export function ConfirmationSheet(props: ConfirmationCardProps & { visible: boolean }) {
  if (!props.visible) return null;
  return (
    <View style={styles.sheet}>
      <ConfirmationCard {...props} />
    </View>
  );
}

export function ComplianceAlertCard(props: {
  title: string;
  status: string;
  detail: string;
  urgent?: boolean;
  deadline?: string;
  suggestedAction?: string;
}) {
  return (
    <HotelCard>
      <View style={styles.row}>
        <Text style={styles.title}>{props.title}</Text>
        <StatusChip label={props.status} tone={props.urgent ? "error" : "warning"} />
      </View>
      <Text style={styles.detail}>{props.detail}</Text>
      {props.deadline ? <Text style={styles.warningText}>Deadline: {props.deadline}</Text> : null}
      {props.suggestedAction ? <Text style={styles.nextAction}>{props.suggestedAction}</Text> : null}
    </HotelCard>
  );
}

export function AiCommandInput(props: { value: string; onChangeText: (value: string) => void; placeholder?: string }) {
  return <TextInput value={props.value} onChangeText={props.onChangeText} placeholder={props.placeholder} style={styles.input} multiline />;
}

export function CommandDock(props: {
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void;
  onVoice?: () => void;
  onCamera?: () => void;
  state?: string;
  confidence?: number;
  riskLevel?: RiskLevel;
}) {
  return (
    <View style={styles.commandDock}>
      <View style={styles.row}>
        <View>
          <Text style={styles.inverseMeta}>AI Command Dock</Text>
          <Text style={styles.inverseTitle}>{props.state ?? "Ready for command"}</Text>
        </View>
        {props.riskLevel ? <RiskBadge riskLevel={props.riskLevel} /> : null}
      </View>
      <TextInput
        accessibilityLabel="AI command input"
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder="Ask HotelOS what to do next"
        placeholderTextColor="#c7d2fe"
        style={styles.commandInput}
        multiline
      />
      {typeof props.confidence === "number" ? <ConfidenceMeter value={props.confidence} label="AI confidence" /> : null}
      <View style={styles.actionRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Start voice command" onPress={props.onVoice} style={styles.commandSecondary}>
          <Text style={styles.primaryButtonText}>Voice</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Open camera command" onPress={props.onCamera} style={styles.commandSecondary}>
          <Text style={styles.primaryButtonText}>Camera</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Send AI command" onPress={props.onSubmit} style={styles.commandPrimary}>
          <Text style={styles.primaryButtonText}>Preview</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function VoiceButton(props: { label: string; onPress: () => void; listening?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} style={[styles.aiButton, props.listening && styles.listening]}>
      <Text style={styles.primaryButtonText}>{props.label}</Text>
    </Pressable>
  );
}

export function CameraActionButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} style={styles.secondaryButton}>
      <Text style={styles.secondaryButtonText}>{props.label}</Text>
    </Pressable>
  );
}

export function TimelineDataGrid(props: { items: Array<{ label: string; value: string; tone?: StatusTone }> }) {
  return (
    <View style={styles.timelineGrid}>
      {props.items.map((item) => (
        <View key={`${item.label}-${item.value}`} style={styles.timelineCell}>
          <Text style={styles.meta}>{item.label}</Text>
          <Text style={styles.detail}>{item.value}</Text>
        </View>
      ))}
    </View>
  );
}

export function RateGridCell(props: { date: string; price: string; restriction?: string; selected?: boolean }) {
  return (
    <View style={[styles.rateCell, props.selected && styles.rateCellSelected]}>
      <Text style={styles.meta}>{props.date}</Text>
      <Text style={styles.title}>{props.price}</Text>
      {props.restriction ? <Text style={styles.detail}>{props.restriction}</Text> : null}
    </View>
  );
}

export function IntegrationCard(props: { name: string; category: string; status?: string; capabilities?: string[] }) {
  return (
    <HotelCard>
      <View style={styles.row}>
        <Text style={styles.title}>{props.name}</Text>
        <StatusChip label={props.status ?? "available"} tone={props.status === "connected" ? "success" : props.status === "error" ? "error" : "neutral"} />
      </View>
      <Text style={styles.detail}>{props.category}</Text>
      {props.capabilities?.length ? <Text style={styles.detail}>{props.capabilities.join(", ")}</Text> : null}
    </HotelCard>
  );
}

export function ModuleCard(props: { name: string; category: string; enabled: boolean; dependencies?: string[]; health?: string }) {
  return (
    <HotelCard>
      <View style={styles.row}>
        <Text style={styles.title}>{props.name}</Text>
        <StatusChip label={props.enabled ? props.health ?? "enabled" : "disabled"} tone={props.enabled ? "success" : "neutral"} />
      </View>
      <Text style={styles.detail}>{props.category}</Text>
      {props.dependencies?.length ? <Text style={styles.detail}>Depends on {props.dependencies.join(", ")}</Text> : null}
    </HotelCard>
  );
}

export function BottomSheet(props: { title: string; children: ReactNode }) {
  return (
    <View style={styles.bottomSheet}>
      <Text style={styles.title}>{props.title}</Text>
      {props.children}
    </View>
  );
}

export function ActionDrawer(props: { title: string; actions: Array<{ label: string; onPress: () => void; disabled?: boolean }> }) {
  return (
    <HotelCard title={props.title}>
      <View style={styles.actionRow}>
        {props.actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            disabled={action.disabled}
            onPress={action.onPress}
            style={[styles.secondaryButton, action.disabled && styles.disabled]}
          >
            <Text style={styles.secondaryButtonText}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
    </HotelCard>
  );
}

export function AuditTrailPanel(props: { events: Array<{ action: string; createdAt: string; actorType: string }> }) {
  return (
    <ScrollView style={styles.card}>
      <Text style={styles.title}>Audit trail</Text>
      {props.events.map((event) => (
        <Text key={`${event.action}-${event.createdAt}`} style={styles.detail}>{event.createdAt} - {event.actorType} - {event.action}</Text>
      ))}
    </ScrollView>
  );
}

export function SkeletonCard(props: { label?: string }) {
  return (
    <View accessibilityLabel={props.label ? `Loading ${props.label}` : "Loading"} style={styles.skeletonCard}>
      <View style={styles.skeletonLineShort} />
      <View style={styles.skeletonLine} />
      <View style={styles.skeletonLineTiny} />
    </View>
  );
}

export function EmptyState(props: { title: string; message: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <View style={styles.stateCard}>
      <Text style={styles.title}>{props.title}</Text>
      <Text style={styles.detail}>{props.message}</Text>
      {props.actionLabel && props.onAction ? (
        <Pressable accessibilityRole="button" accessibilityLabel={props.actionLabel} onPress={props.onAction} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>{props.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ErrorState(props: { title: string; message: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <View style={[styles.stateCard, styles.errorState]}>
      <Text style={styles.title}>{props.title}</Text>
      <Text style={styles.detail}>{props.message}</Text>
      {props.actionLabel && props.onAction ? (
        <Pressable accessibilityRole="button" accessibilityLabel={props.actionLabel} onPress={props.onAction} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>{props.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function PermissionDeniedCard(props: { requiredPermission?: string; currentRole?: string }) {
  const requiredPermission = props.requiredPermission ?? "unknown.permission";
  const currentRole = props.currentRole ?? "current role";

  return (
    <View style={[styles.stateCard, styles.permissionState]}>
      <Text style={styles.meta}>PermissionGate fallback</Text>
      <Text style={styles.title}>You do not have permission</Text>
      <Text style={styles.detail}>Required permission: {requiredPermission}</Text>
      <Text style={styles.detail}>Current role: {currentRole}</Text>
      <Text style={styles.nextAction}>Ask administrator</Text>
      <Text style={styles.debugReason}>Hidden because user lacks {requiredPermission}</Text>
    </View>
  );
}

export function ModuleDisabledCard(props: {
  moduleCode?: string;
  requiredDependencies?: string[];
  requiredPermissions?: string[];
  canEnable?: boolean;
  onEnable?: () => void;
}) {
  const moduleCode = props.moduleCode ?? "unknown_module";

  return (
    <View style={[styles.stateCard, styles.moduleState]}>
      <Text style={styles.meta}>ModuleGate fallback</Text>
      <Text style={styles.title}>Module disabled</Text>
      <Text style={styles.detail}>Module: {moduleCode}</Text>
      <Text style={styles.detail}>
        Configure dependencies: {props.requiredDependencies?.length ? props.requiredDependencies.join(", ") : "No dependency data available"}
      </Text>
      <Text style={styles.detail}>
        Required permissions: {props.requiredPermissions?.length ? props.requiredPermissions.join(", ") : "Module administrator"}
      </Text>
      <Text style={styles.nextAction}>Setup status: enable module or complete dependencies to show this tool.</Text>
      {props.canEnable && props.onEnable ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Enable module ${moduleCode}`} onPress={props.onEnable} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Enable module</Text>
        </Pressable>
      ) : null}
      <Text style={styles.debugReason}>Hidden because module {moduleCode} is disabled</Text>
    </View>
  );
}

export function PermissionGate(props: {
  allowed: boolean;
  fallback?: ReactNode;
  children: ReactNode;
  requiredPermission?: string;
  currentRole?: string;
}) {
  if (props.allowed) {
    return <>{props.children}</>;
  }

  return <>{props.fallback ?? <PermissionDeniedCard requiredPermission={props.requiredPermission} currentRole={props.currentRole} />}</>;
}

export function ModuleGate(props: {
  enabled: boolean;
  fallback?: ReactNode;
  children: ReactNode;
  moduleCode?: string;
  requiredDependencies?: string[];
  requiredPermissions?: string[];
  canEnable?: boolean;
  onEnable?: () => void;
}) {
  if (props.enabled) {
    return <>{props.children}</>;
  }

  return (
    <>
      {props.fallback ?? (
        <ModuleDisabledCard
          moduleCode={props.moduleCode}
          requiredDependencies={props.requiredDependencies}
          requiredPermissions={props.requiredPermissions}
          canEnable={props.canEnable}
          onEnable={props.onEnable}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "relative",
    backgroundColor: suiteColors.surface,
    borderColor: suiteColors.line,
    borderWidth: 1,
    borderRadius: tokens.radius.lg,
    padding: tokens.space.md,
    gap: tokens.space.sm,
    ...tokens.elevation.card
  },
  cardCompact: {
    padding: tokens.space.sm,
    gap: tokens.space.xs
  },
  aiCard: {
    borderColor: "#c4b5fd",
    backgroundColor: "#faf7ff"
  },
  metricCard: {
    backgroundColor: suiteColors.surface,
    borderColor: suiteColors.line,
    borderLeftWidth: 4,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderRadius: tokens.radius.lg,
    padding: tokens.space.md,
    gap: tokens.space.xs,
    minHeight: 98,
    ...tokens.elevation.card
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.space.sm
  },
  titleStack: {
    flex: 1,
    minWidth: 0,
    gap: 3
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.xs
  },
  meta: {
    color: suiteColors.muted,
    fontWeight: tokens.font.weight.black,
    fontSize: tokens.font.size.caption,
    letterSpacing: 0
  },
  metric: {
    color: suiteColors.ink,
    fontWeight: tokens.font.weight.black,
    fontSize: 28,
    letterSpacing: 0
  },
  title: {
    color: suiteColors.ink,
    fontWeight: tokens.font.weight.black,
    fontSize: tokens.font.size.bodyLarge,
    letterSpacing: 0
  },
  roomNumber: {
    color: suiteColors.ink,
    fontWeight: tokens.font.weight.black,
    fontSize: 24,
    letterSpacing: 0
  },
  bodyText: {
    color: suiteColors.ink,
    fontSize: tokens.font.size.bodyLarge,
    lineHeight: 24,
    letterSpacing: 0
  },
  detail: {
    color: suiteColors.muted,
    lineHeight: 20,
    letterSpacing: 0
  },
  nextAction: {
    color: suiteColors.primary,
    fontWeight: tokens.font.weight.black,
    lineHeight: 20,
    letterSpacing: 0
  },
  chip: {
    borderWidth: 1,
    borderRadius: tokens.radius.pill,
    paddingHorizontal: tokens.space.sm,
    paddingVertical: 6
  },
  chipCompact: {
    paddingHorizontal: 9,
    paddingVertical: 4
  },
  chipText: {
    fontSize: tokens.font.size.caption,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  confirmAccent: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 5,
    borderTopLeftRadius: tokens.radius.lg,
    borderBottomLeftRadius: tokens.radius.lg
  },
  warningText: {
    color: suiteColors.warning,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  permissionState: {
    borderColor: "#f59e0b",
    backgroundColor: "#fffbeb"
  },
  moduleState: {
    borderColor: "#93c5fd",
    backgroundColor: "#eff6ff"
  },
  debugReason: {
    color: suiteColors.muted,
    fontSize: tokens.font.size.caption,
    lineHeight: 18,
    letterSpacing: 0
  },
  input: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: suiteColors.line,
    borderRadius: tokens.radius.lg,
    padding: tokens.space.sm,
    color: suiteColors.ink,
    backgroundColor: suiteColors.surface
  },
  primaryButton: {
    minHeight: 44,
    backgroundColor: suiteColors.primary,
    borderRadius: tokens.radius.md,
    paddingHorizontal: tokens.space.md,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center"
  },
  aiButton: {
    minHeight: 52,
    backgroundColor: suiteColors.ai,
    borderRadius: tokens.radius.xl,
    paddingHorizontal: tokens.space.lg,
    paddingVertical: tokens.space.md,
    alignItems: "center",
    justifyContent: "center"
  },
  listening: {
    backgroundColor: suiteColors.electric
  },
  secondaryButton: {
    minHeight: 44,
    backgroundColor: suiteColors.warmGray,
    borderColor: suiteColors.line,
    borderWidth: 1,
    borderRadius: tokens.radius.md,
    paddingHorizontal: tokens.space.md,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center"
  },
  disabled: {
    opacity: tokens.opacity.disabled
  },
  primaryButtonText: {
    color: tokens.color.text.inverse,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  secondaryButtonText: {
    color: suiteColors.primary,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  commandDock: {
    backgroundColor: suiteColors.primaryDark,
    borderRadius: tokens.radius.xl,
    padding: tokens.space.lg,
    gap: tokens.space.md,
    ...tokens.elevation.command
  },
  commandInput: {
    minHeight: 74,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.24)",
    color: tokens.color.text.inverse,
    backgroundColor: "rgba(255,255,255,0.08)",
    padding: tokens.space.md,
    fontSize: tokens.font.size.body
  },
  commandSecondary: {
    minHeight: 44,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.28)",
    paddingHorizontal: tokens.space.md,
    justifyContent: "center"
  },
  commandPrimary: {
    minHeight: 44,
    borderRadius: tokens.radius.md,
    backgroundColor: suiteColors.electric,
    paddingHorizontal: tokens.space.md,
    justifyContent: "center"
  },
  inverseMeta: {
    color: "#c7d2fe",
    fontWeight: tokens.font.weight.black,
    fontSize: tokens.font.size.caption,
    letterSpacing: 0
  },
  inverseTitle: {
    color: tokens.color.text.inverse,
    fontWeight: tokens.font.weight.black,
    fontSize: tokens.font.size.title,
    letterSpacing: 0
  },
  confidenceWrap: {
    gap: 6
  },
  confidenceText: {
    color: suiteColors.primary,
    fontWeight: tokens.font.weight.black,
    letterSpacing: 0
  },
  confidenceTrack: {
    height: 8,
    borderRadius: tokens.radius.pill,
    backgroundColor: tokens.color.surface.soft,
    overflow: "hidden"
  },
  confidenceFill: {
    height: 8,
    borderRadius: tokens.radius.pill,
    backgroundColor: suiteColors.electric
  },
  timelineGrid: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: tokens.space.xs
  },
  timelineCell: {
    minWidth: 128,
    flex: 1,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: suiteColors.line,
    padding: tokens.space.sm,
    backgroundColor: tokens.color.surface.soft
  },
  rateCell: {
    minWidth: 104,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: suiteColors.line,
    padding: tokens.space.sm,
    backgroundColor: suiteColors.surface
  },
  rateCellSelected: {
    borderColor: suiteColors.electric,
    backgroundColor: tokens.color.status.inspected
  },
  bottomSheet: {
    borderTopLeftRadius: tokens.radius.xl,
    borderTopRightRadius: tokens.radius.xl,
    backgroundColor: suiteColors.surface,
    borderColor: suiteColors.line,
    borderWidth: 1,
    padding: tokens.space.lg,
    gap: tokens.space.sm,
    ...tokens.elevation.card
  },
  sheet: {
    zIndex: tokens.zIndex.sheet,
    borderRadius: tokens.radius.xl
  },
  skeletonCard: {
    minHeight: 96,
    borderRadius: tokens.radius.lg,
    backgroundColor: tokens.color.surface.soft,
    padding: tokens.space.md,
    gap: tokens.space.sm
  },
  skeletonLineShort: {
    width: "42%",
    height: 10,
    borderRadius: tokens.radius.pill,
    backgroundColor: "#d8e0eb"
  },
  skeletonLine: {
    width: "76%",
    height: 18,
    borderRadius: tokens.radius.pill,
    backgroundColor: "#d8e0eb"
  },
  skeletonLineTiny: {
    width: "58%",
    height: 10,
    borderRadius: tokens.radius.pill,
    backgroundColor: "#d8e0eb"
  },
  stateCard: {
    borderWidth: 1,
    borderColor: suiteColors.line,
    borderRadius: tokens.radius.lg,
    backgroundColor: suiteColors.surface,
    padding: tokens.space.lg,
    gap: tokens.space.sm
  },
  errorState: {
    borderColor: suiteColors.error,
    backgroundColor: "#fff7f5"
  }
});

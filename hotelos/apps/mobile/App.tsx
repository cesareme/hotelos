import { useState } from "react";
import { SafeAreaView, StatusBar, StyleSheet, Text, View } from "react-native";
import { AICommandCenterScreen } from "./src/screens/AICommandCenterScreen";
import { AccountingScreen } from "./src/screens/AccountingScreen";
import { AssetsScreen } from "./src/screens/AssetsScreen";
import { ComplianceInboxScreen } from "./src/screens/ComplianceInboxScreen";
import { ConciergeScreen } from "./src/screens/ConciergeScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { NotificationsScreen } from "./src/screens/NotificationsScreen";
import { OfflineSyncScreen } from "./src/screens/OfflineSyncScreen";
import { OwnerModeScreen } from "./src/screens/OwnerModeScreen";
import { PmsScreen } from "./src/screens/PmsScreen";
import { PropertySelectorScreen } from "./src/screens/PropertySelectorScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { HotelOSTabs } from "./src/navigation/HotelOSTabs";
import type { MobileRouteKey } from "./src/navigation/ModuleRoutes";
import { TodayDashboardScreen } from "./src/screens/today/TodayDashboardScreen";
import { MobilePlanningScreen } from "./src/screens/rooms/MobilePlanningScreen";
import { LiveTimelineScreen } from "./src/screens/timeline/LiveTimelineScreen";
import { TasksHomeScreen } from "./src/screens/tasks/TasksHomeScreen";
import { MoreScreen } from "./src/screens/more/MoreScreen";
import { BackOfficePreviewScreen } from "./src/screens/settings/BackOfficePreviewScreen";
import { ManualSetupPreviewScreen } from "./src/screens/backoffice/ManualSetupPreviewScreen";
import { PropertySetupPreviewScreen } from "./src/screens/backoffice/PropertySetupPreviewScreen";
import { CategoryManagerPreviewScreen } from "./src/screens/backoffice/CategoryManagerPreviewScreen";
import { ConfigurationCenterScreen } from "./src/screens/backoffice/ConfigurationCenterScreen";
import { PropertyProfileFormScreen } from "./src/screens/backoffice/forms/PropertyProfileFormScreen";
import { RoomTypeFormScreen } from "./src/screens/backoffice/forms/RoomTypeFormScreen";
import { RoomFormScreen } from "./src/screens/backoffice/forms/RoomFormScreen";
import { SpaceResourceFormScreen } from "./src/screens/backoffice/forms/SpaceResourceFormScreen";
import { CategoryOptionFormScreen } from "./src/screens/backoffice/forms/CategoryOptionFormScreen";
import { SetupCenterPreviewScreen } from "./src/screens/settings/SetupCenterPreviewScreen";
import { LocalDevLauncherScreen, SHOW_DEV_LAUNCHER } from "./src/screens/dev/LocalDevLauncherScreen";
import { ModuleVisibilityDebugScreen } from "./src/screens/dev/ModuleVisibilityDebugScreen";
import { GuestJourneyScreen } from "./src/screens/guestJourney/GuestJourneyScreen";
import { IntegrationMarketplaceHome } from "./src/screens/marketplace/IntegrationMarketplaceHome";
import { RevenueHomeScreen } from "./src/screens/revenue/RevenueHomeScreen";
import { RevenueDashboardScreen } from "./src/screens/revenue/RevenueDashboardScreen";
import { RevenueRecommendationsScreen } from "./src/screens/revenue/RevenueRecommendationsScreen";
import { RateGridScreen } from "./src/screens/revenue/RateGridScreen";
import { DemandCalendarScreen } from "./src/screens/revenue/DemandCalendarScreen";
import { ChannelSyncHealthScreen } from "./src/screens/revenue/ChannelSyncHealthScreen";
import { RateParityAlertsScreen } from "./src/screens/revenue/RateParityAlertsScreen";
import { ScenarioSimulatorScreen } from "./src/screens/revenue/ScenarioSimulatorScreen";
import { RevenueForecastGraphScreen } from "./src/screens/revenue/RevenueForecastGraphScreen";
import { RevenueVisualDashboardScreen } from "./src/screens/revenue/RevenueVisualDashboardScreen";
import { RevenueKPIDetailScreen } from "./src/screens/revenue/RevenueKPIDetailScreen";
import { RevenueReportTableScreen } from "./src/screens/revenue/RevenueReportTableScreen";
import { RevenueHistoryForecastScreen } from "./src/screens/revenue/RevenueHistoryForecastScreen";
import { ChannelManagerHomeScreen } from "./src/screens/channelManager/ChannelManagerHomeScreen";
import { AISetupWizardScreen } from "./src/screens/onboarding/AISetupWizardScreen";
import { OnboardingProjectScreen } from "./src/screens/onboarding/OnboardingProjectScreen";
import {
  GoLiveReadinessMobileScreen,
  PropertyBlueprintPreviewScreen,
  ReviewPendingMappingsScreen,
  UploadHotelDataScreen
} from "./src/screens/onboarding/OnboardingReviewScreens";
import { colors } from "./src/theme/colors";

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [screen, setScreen] = useState<MobileRouteKey>(SHOW_DEV_LAUNCHER ? "LocalDevLauncher" : "today");
  const handledScreens: MobileRouteKey[] = [
    "today",
    "timeline",
    "LiveTimeline",
    "rooms",
    "ai",
    "operations",
    "tasks",
    "more",
    "properties",
    "pms",
    "accounting",
    "assets",
    "concierge",
    "compliance",
    "notifications",
    "sync",
    "settings",
    "owner",
    "BackOfficePreview",
    "ManualSetupPreview",
    "SetupCenterPreview",
    "PropertySetupPreview",
    "CategoryManagerPreview",
    "ConfigurationCenter",
    "PropertyProfileForm",
    "RoomTypeForm",
    "RoomForm",
    "SpaceResourceForm",
    "CategoryOptionForm",
    "GuestJourney",
    "ModuleVisibilityDebug",
    "AISetupWizard",
    "OnboardingProject",
    "MigrationReview",
    "GoLiveReadiness",
    "UploadHotelData",
    "PropertyBlueprintPreview",
    "ReviewPendingMappings",
    "ModuleMarketplace",
    "IntegrationMarketplace",
    "MarketplaceHome",
    "revenue",
    "RevenueHome",
    "RevenueDashboard",
    "RevenueHistoryForecast",
    "RevenueVisualDashboard",
    "RevenueKPIDetail",
    "RevenueForecastGraph",
    "RevenueReportTable",
    "RevenueRecommendations",
    "RateGrid",
    "DemandCalendar",
    "ChannelManagerDashboard",
    "ChannelManagerHome",
    "ChannelSyncHealth",
    "RateParityAlerts",
    "ScenarioSimulator",
    "RevenueSettings"
  ];

  function navigate(route: string) {
    setScreen(route as MobileRouteKey);
  }

  if (!signedIn) {
    return <LoginScreen onLogin={() => setSignedIn(true)} />;
  }

  if (SHOW_DEV_LAUNCHER && screen === "LocalDevLauncher") {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <LocalDevLauncherScreen onNavigate={navigate} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.appBar}>
        <Text style={styles.brand}>HotelOS</Text>
        <Text style={styles.property}>Madrid Centro</Text>
      </View>
      <View style={styles.body}>
        {screen === "today" ? <TodayDashboardScreen onNavigate={navigate} /> : null}
        {screen === "timeline" || screen === "LiveTimeline" ? <LiveTimelineScreen /> : null}
        {screen === "rooms" ? <MobilePlanningScreen /> : null}
        {screen === "ai" ? <AICommandCenterScreen /> : null}
        {screen === "operations" || screen === "tasks" ? <TasksHomeScreen /> : null}
        {screen === "more" ? <MoreScreen onNavigate={navigate} /> : null}
        {screen === "properties" ? <PropertySelectorScreen /> : null}
        {screen === "pms" ? <PmsScreen /> : null}
        {screen === "accounting" ? <AccountingScreen /> : null}
        {screen === "assets" ? <AssetsScreen /> : null}
        {screen === "concierge" ? <ConciergeScreen /> : null}
        {screen === "compliance" ? <ComplianceInboxScreen /> : null}
        {screen === "notifications" ? <NotificationsScreen /> : null}
        {screen === "sync" ? <OfflineSyncScreen /> : null}
        {screen === "settings" ? <SettingsScreen /> : null}
        {screen === "owner" ? <OwnerModeScreen /> : null}
        {screen === "BackOfficePreview" ? <BackOfficePreviewScreen onNavigate={navigate} /> : null}
        {screen === "ManualSetupPreview" ? <ManualSetupPreviewScreen onNavigate={navigate} /> : null}
        {screen === "SetupCenterPreview" ? <SetupCenterPreviewScreen onNavigate={navigate} /> : null}
        {screen === "PropertySetupPreview" ? <PropertySetupPreviewScreen onNavigate={navigate} /> : null}
        {screen === "CategoryManagerPreview" ? <CategoryManagerPreviewScreen onNavigate={navigate} /> : null}
        {screen === "ConfigurationCenter" ? <ConfigurationCenterScreen onNavigate={navigate} /> : null}
        {screen === "PropertyProfileForm" ? <PropertyProfileFormScreen onNavigate={navigate} /> : null}
        {screen === "RoomTypeForm" ? <RoomTypeFormScreen onNavigate={navigate} /> : null}
        {screen === "RoomForm" ? <RoomFormScreen onNavigate={navigate} /> : null}
        {screen === "SpaceResourceForm" ? <SpaceResourceFormScreen onNavigate={navigate} /> : null}
        {screen === "CategoryOptionForm" ? <CategoryOptionFormScreen onNavigate={navigate} /> : null}
        {screen === "GuestJourney" ? <GuestJourneyScreen /> : null}
        {screen === "ModuleVisibilityDebug" ? <ModuleVisibilityDebugScreen /> : null}
        {screen === "AISetupWizard" ? <AISetupWizardScreen onNavigate={navigate} /> : null}
        {screen === "OnboardingProject" ? <OnboardingProjectScreen onNavigate={navigate} /> : null}
        {screen === "MigrationReview" || screen === "ReviewPendingMappings" ? <ReviewPendingMappingsScreen /> : null}
        {screen === "GoLiveReadiness" ? <GoLiveReadinessMobileScreen /> : null}
        {screen === "UploadHotelData" ? <UploadHotelDataScreen /> : null}
        {screen === "PropertyBlueprintPreview" ? <PropertyBlueprintPreviewScreen /> : null}
        {screen === "ModuleMarketplace" ? <BackOfficePreviewScreen onNavigate={navigate} /> : null}
        {screen === "IntegrationMarketplace" || screen === "MarketplaceHome" ? <IntegrationMarketplaceHome /> : null}
        {screen === "revenue" || screen === "RevenueHome" ? <RevenueHomeScreen onNavigate={navigate} /> : null}
        {screen === "RevenueDashboard" ? <RevenueDashboardScreen /> : null}
        {screen === "RevenueHistoryForecast" ? <RevenueHistoryForecastScreen /> : null}
        {screen === "RevenueVisualDashboard" ? <RevenueVisualDashboardScreen /> : null}
        {screen === "RevenueKPIDetail" ? <RevenueKPIDetailScreen /> : null}
        {screen === "RevenueForecastGraph" ? <RevenueForecastGraphScreen /> : null}
        {screen === "RevenueReportTable" ? <RevenueReportTableScreen /> : null}
        {screen === "RevenueRecommendations" ? <RevenueRecommendationsScreen /> : null}
        {screen === "RateGrid" ? <RateGridScreen /> : null}
        {screen === "DemandCalendar" ? <DemandCalendarScreen /> : null}
        {screen === "ChannelManagerDashboard" || screen === "ChannelManagerHome" ? <ChannelManagerHomeScreen onNavigate={navigate} /> : null}
        {screen === "ChannelSyncHealth" ? <ChannelSyncHealthScreen /> : null}
        {screen === "RateParityAlerts" ? <RateParityAlertsScreen /> : null}
        {screen === "ScenarioSimulator" ? <ScenarioSimulatorScreen /> : null}
        {screen === "RevenueSettings" ? <RevenueDashboardScreen /> : null}
        {!handledScreens.includes(screen) ? <ComingSoonMobileScreen route={screen} /> : null}
      </View>
      <HotelOSTabs current={screen} onSelect={setScreen} />
    </SafeAreaView>
  );
}

function ComingSoonMobileScreen(props: { route: string }) {
  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderKicker}>Coming soon / In progress</Text>
      <Text style={styles.placeholderTitle}>{props.route}</Text>
      <Text style={styles.placeholderBody}>Available now: demo data, module status and setup checklist. Next: live API connection, export and AI actions.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background
  },
  appBar: {
    minHeight: 56,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  brand: {
    color: colors.ink,
    fontWeight: "900",
    fontSize: 20,
    letterSpacing: 0
  },
  property: {
    color: colors.muted,
    fontWeight: "700",
    letterSpacing: 0
  },
  body: {
    flex: 1
  },
  placeholder: {
    margin: 18,
    padding: 18,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    gap: 8
  },
  placeholderKicker: {
    color: colors.muted,
    fontWeight: "900",
    letterSpacing: 0
  },
  placeholderTitle: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "900",
    letterSpacing: 0
  },
  placeholderBody: {
    color: colors.muted,
    lineHeight: 22,
    letterSpacing: 0
  }
});
